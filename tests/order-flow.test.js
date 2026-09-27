const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { query, pool } = require('../src/db');
const { signToken } = require('../src/middleware/auth');

const port = 32178;
const api = `http://127.0.0.1:${port}/api`;
const unique = Date.now();

async function request(path, method = 'GET', token, body) {
  const response = await fetch(api + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function socketFor(user) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', token: signToken(user) }));
  await waitFor(() => messages.some(m => m.type === 'auth_ok'));
  return { ws, messages };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for event');
}

test('checkout pricing, address ownership, notifications, and manual assignment', async () => {
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: 'pipe',
  });
  const sockets = [];
  try {
    await waitFor(async () => {
      try { return (await request('/health')).status === 200; } catch { return false; }
    });
    const insertUser = async (role) => (await query(
      `INSERT INTO users(full_name,email,password_hash,role,driver_status,is_online)
       VALUES($1,$2,'test', $3,'active',true) RETURNING id,role`,
      [role, `${role}-${unique}-${Math.random()}@example.test`, role]
    )).rows[0];
    const customer = await insertUser('customer');
    const other = await insertUser('customer');
    const merchantUser = await insertUser('merchant');
    const driver = await insertUser('driver');
    const admin = await insertUser('admin');
    const { rows: [merchant] } = await query(
      `INSERT INTO merchants(owner_user_id,name,status,delivery_fee,min_order)
       VALUES($1,'Test Shop','approved',15,0) RETURNING id`, [merchantUser.id]
    );
    const { rows: [product] } = await query(
      `INSERT INTO products(merchant_id,name,price) VALUES($1,'Test Meal',30) RETURNING id`, [merchant.id]
    );
    const { rows: [address] } = await query(
      `INSERT INTO addresses(user_id,label,address_text) VALUES($1,'Home','Street') RETURNING id`, [customer.id]
    );
    const { rows: [foreignAddress] } = await query(
      `INSERT INTO addresses(user_id,label,address_text) VALUES($1,'Other','Street') RETURNING id`, [other.id]
    );
    await query('INSERT INTO cart_items(user_id,product_id,quantity,unit_extra) VALUES($1,$2,2,5)',
      [customer.id, product.id]);
    const merchantSocket = await socketFor(merchantUser); sockets.push(merchantSocket.ws);
    const driverSocket = await socketFor(driver); sockets.push(driverSocket.ws);
    const customerSocket = await socketFor(customer); sockets.push(customerSocket.ws);
    const customerToken = signToken(customer);
    const body = { merchant_id: merchant.id, address_id: foreignAddress.id,
      items: [{ product_id: product.id, quantity: 2, price: 0 }], subtotal: 0, delivery_fee: 0, total: 0 };

    const foreign = await request('/orders', 'POST', customerToken, body);
    assert.equal(foreign.status, 400);
    const wrongMerchant = await request('/orders', 'POST', customerToken,
      { ...body, address_id: address.id, merchant_id: merchant.id + 1 });
    assert.notEqual(wrongMerchant.status, 200);
    const created = await request('/orders', 'POST', customerToken,
      { ...body, address_id: address.id });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(Number(created.body.total), 85);
    assert.equal(Number(created.body.subtotal), 70);
    assert.equal(Number(created.body.delivery_fee), 15);
    await waitFor(() => merchantSocket.messages.some(m => m.orderId === created.body.id && m.type === 'notification'));
    const merchantToken = signToken(merchantUser);
    assert.equal((await request(`/merchant/orders/${created.body.id}/accept`, 'PUT', merchantToken)).status, 200);
    await query('UPDATE merchants SET linked_driver_ids=$1 WHERE id=$2',
      [JSON.stringify([driver.id]), merchant.id]);
    assert.equal((await request(`/merchant/orders/${created.body.id}/ready`, 'PUT', merchantToken)).status, 200);
    await waitFor(() => driverSocket.messages.some(m => m.orderId === created.body.id && m.notifType === 'new_available_order'));

    assert.equal((await request(`/admin/orders/${created.body.id}/driver`, 'PUT', signToken(admin),
      { driver_id: driver.id })).status, 200);
    const visible = await request('/driver/orders', 'GET', signToken(driver));
    assert.equal(visible.status, 200);
    assert.ok(visible.body.some(o => o.id === created.body.id && o.status === 'ready'));
    assert.equal((await request(`/driver/orders/${created.body.id}/accept`, 'PUT', signToken(driver))).status, 200);
    await waitFor(() => customerSocket.messages.some(m => m.orderId === created.body.id && m.notifType === 'order_picked_up'));
  } finally {
    sockets.forEach(ws => ws.close());
    server.kill();
    await pool.end();
  }
});
