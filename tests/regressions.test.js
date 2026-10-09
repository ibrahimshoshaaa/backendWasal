const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { createHmac } = require('node:crypto');
const { query, pool } = require('../src/db');
const { signToken } = require('../src/middleware/auth');
const { isMerchantOpenNow } = require('../src/services/merchantHours');
const api = 'http://127.0.0.1:32179/api';
async function request(path, method='GET', token, body) {
  const response = await fetch(api+path, { method,
    headers: { ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(body ? {'Content-Type':'application/json'} : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return {status:response.status, body:await response.json()};
}
test('overnight hours and overnight breaks', () => {
  const merchant = {is_open:true,working_hours:{thu:{open:'10:00',close:'02:00'}}};
  assert.equal(isMerchantOpenNow(merchant,new Date('2026-10-08T22:00:00Z')).open,true);
  assert.equal(isMerchantOpenNow(merchant,new Date('2026-10-08T23:00:00Z')).open,false);
  assert.equal(isMerchantOpenNow({...merchant,break_start:'23:00',break_end:'01:30'},new Date('2026-10-08T22:00:00Z')).reason,'break');
});
test('security, checkout pricing, OTP privacy and service accounting', async t => {
  const server = spawn(process.execPath,['src/server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,PORT:'32179'},stdio:'pipe'});
  let output=''; server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
  try {
    let ready=false;
    for(let i=0;i<150;i++){try{ready=(await request('/health')).status===200;}catch(_){}if(ready)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,output);
    const unique=`regression-${Date.now()}`;
    const user=async role=>(await query(`INSERT INTO users(full_name,email,password_hash,role,driver_status,is_online,email_verified)
      VALUES($1,$2,'test',$1,'active',true,true) RETURNING *`,[role,`${unique}-${role}@example.test`])).rows[0];
    const customer=await user('customer'), driver=await user('driver'), merchantUser=await user('merchant'), admin=await user('admin');
    const ct=signToken(customer),dt=signToken(driver),at=signToken(admin);
    const merchant=(await query("INSERT INTO merchants(owner_user_id,name,status,delivery_fee,min_order) VALUES($1,'Regression shop','approved',15,0) RETURNING id",[merchantUser.id])).rows[0];
    const product=(await query("INSERT INTO products(merchant_id,name,price) VALUES($1,'Meal',30) RETURNING id",[merchant.id])).rows[0];
    const address=(await query("INSERT INTO addresses(user_id,label,address_text) VALUES($1,'Home','Street') RETURNING id",[customer.id])).rows[0];
    const group=(await query("INSERT INTO option_groups(product_id,name,is_required,min_select,max_select) VALUES($1,'Size',true,1,1) RETURNING id",[product.id])).rows[0];
    const choice=(await query("INSERT INTO option_choices(group_id,name,extra_price) VALUES($1,'Large',5) RETURNING id",[group.id])).rows[0];
    await t.test('required options, duplicate choices, quantities and current checkout prices',async()=>{
      assert.equal((await request('/cart','POST',ct,{product_id:product.id,quantity:1})).status,400);
      assert.equal((await request('/cart','POST',ct,{product_id:product.id,quantity:-1})).status,400);
      assert.equal((await request('/cart','POST',ct,{product_id:product.id,quantity:1,selected_options:[{group_id:group.id,choice_ids:[choice.id,choice.id]}]})).status,400);
      assert.equal((await request('/cart','POST',ct,{product_id:product.id,quantity:2,selected_options:[{group_id:group.id,choice_ids:[choice.id]}]})).status,200);
      await query('UPDATE option_choices SET extra_price=10 WHERE id=$1',[choice.id]);
      const order=await request('/orders','POST',ct,{merchant_id:merchant.id,address_id:address.id});
      assert.equal(order.status,200,JSON.stringify(order.body));assert.equal(Number(order.body.total),95);
      await query("UPDATE orders SET status='ready' WHERE id=$1",[order.body.id]);
      assert.equal((await request(`/orders/${order.body.id}/cancel`,'POST',ct,{})).status,400);
      assert.equal((await request(`/driver/orders/${order.body.id}/accept`,'PUT',dt)).status,200);
      const visible=await request('/driver/orders','GET',dt);
      assert.ok(visible.body.every(o=>!Object.hasOwn(o,'delivery_otp')));
      assert.equal(typeof visible.body.find(o=>o.id===order.body.id).created_at,'string');
      const tracked=await request(`/orders/${order.body.id}/track`,'GET',ct);
      assert.match(tracked.body.delivery_otp,/^\d{4}$/);
      assert.equal((await request(`/driver/orders/${order.body.id}/deliver`,'PUT',dt,{otp:tracked.body.delivery_otp})).status,200);
    });
    await t.test('trip and errand acceptance responses do not disclose OTPs',async()=>{
      const trip=await request('/trips','POST',ct,{type:'wassalni',pickup_address:'A',dropoff_address:'B'});
      const accepted=await request(`/trips/${trip.body.id}/accept`,'POST',dt);
      assert.equal(accepted.status,200);assert.equal(Object.hasOwn(accepted.body,'delivery_otp'),false);
      const errand=(await query("INSERT INTO hataali_orders(customer_id,title,status) VALUES($1,'Errand','approved') RETURNING id",[customer.id])).rows[0];
      const result=await request(`/hataali/${errand.id}/accept`,'POST',dt);assert.equal(result.status,200);assert.equal(Object.hasOwn(result.body,'delivery_otp'),false);
    });
    await t.test('location updates reach every active job and identify the service',async()=>{
      const socket=new WebSocket('ws://127.0.0.1:32179/ws');
      const messages=[];socket.on('message',data=>messages.push(JSON.parse(data)));
      try {
        await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
        socket.send(JSON.stringify({type:'auth',token:ct}));
        for(let i=0;i<50 && !messages.some(m=>m.type==='auth_ok');i++)await new Promise(r=>setTimeout(r,20));
        assert.ok(messages.some(m=>m.type==='auth_ok'));
        const ids=[];
        for(let i=0;i<2;i++)ids.push((await query("INSERT INTO orders(customer_id,merchant_id,driver_id,items_json,status) VALUES($1,$2,$3,'[]','picked_up') RETURNING id",[customer.id,merchant.id,driver.id])).rows[0].id);
        assert.equal((await request('/driver/location','PUT',dt,{lat:30,lng:31})).status,200);
        for(let i=0;i<50 && messages.filter(m=>m.type==='driver_location').length<4;i++)await new Promise(r=>setTimeout(r,20));
        const events=messages.filter(m=>m.type==='driver_location');
        for(const id of ids)assert.ok(events.some(e=>e.service==='store'&&e.orderId===id));
        assert.ok(events.some(e=>e.service==='hataali'));
        assert.ok(events.some(e=>e.service==='trip'));
        assert.equal((await request('/driver/location','PUT',dt,{lat:300,lng:31})).status,400);
      } finally { socket.close(); }
    });
    await t.test('daily revenue is not multiplied and earnings include all three services',async()=>{
      const dated="now()-interval '10 days'";
      for(const amount of [100,200])await query(`INSERT INTO orders(customer_id,merchant_id,driver_id,items_json,status,total,delivery_fee,created_at,delivered_at)
        VALUES($1,$2,$3,'[]','delivered',$4,0,${dated},${dated})`,[customer.id,merchant.id,driver.id,amount]);
      for(const amount of [50,70,80])await query(`INSERT INTO trips(customer_id,driver_id,type,pickup_address,dropoff_address,status,price,created_at,updated_at)
        VALUES($1,$2,'wassalni','A','B','delivered',$3,${dated},${dated})`,[customer.id,driver.id,amount]);
      await query(`INSERT INTO hataali_orders(customer_id,driver_id,title,status,delivery_fee,created_at,updated_at)
        VALUES($1,$2,'Delivered errand','delivered',35,${dated},${dated})`,[customer.id,driver.id]);
      const day=(await query(`SELECT ((${dated}) AT TIME ZONE 'Africa/Cairo')::date::text AS day`)).rows[0].day;
      const report=await request('/admin/stats/revenue','GET',at);assert.equal(report.status,200,JSON.stringify(report.body));
      const row=report.body.find(r=>r.date.startsWith(day));assert.ok(row);
      assert.deepEqual([row.orders_revenue,row.trips_revenue,row.hataali_revenue].map(Number),[300,200,35]);
      const stats=await request('/driver/stats','GET',dt);assert.equal(stats.body.total.earnings,250);assert.equal(stats.body.total.count,7);
    });
    await t.test('suspension blocks an already issued token',async()=>{
      assert.equal((await request(`/admin/drivers/${driver.id}/status`,'PUT',at,{status:'suspended'})).status,200);
      assert.equal((await request('/driver/orders','GET',dt)).status,401);
      await query("UPDATE users SET driver_status='active' WHERE id=$1",[driver.id]);
    });
    await t.test('verified email cannot issue a session without login',async()=>{
      assert.equal((await request('/auth/verify-email','POST',undefined,{email:customer.email,code:'000000'})).status,400);
    });
    await t.test('reset code is single-use and revokes existing sessions',async()=>{
      const code='123456',hash=createHmac('sha256',process.env.JWT_SECRET).update(`reset:${customer.email}:${code}`).digest('hex');
      await query("UPDATE users SET reset_code_hash=$1,reset_code_expires=now()+interval '15 minutes',reset_code_attempts=0 WHERE id=$2",[hash,customer.id]);
      const body={email:customer.email,code:'654321',password:'new-password-123'};
      assert.equal((await request('/auth/reset-password','POST',undefined,body)).status,400);
      assert.equal((await request('/auth/reset-password','POST',undefined,{...body,code})).status,200);
      assert.equal((await request('/auth/me','GET',ct)).status,401);
      assert.equal((await request('/auth/reset-password','POST',undefined,{...body,code})).status,400);
      const login=await request('/auth/login','POST',undefined,{email:customer.email,password:body.password});assert.equal(login.status,200);
      assert.equal((await request('/auth/me','GET',login.body.token)).status,200);
    });
  } finally { server.kill(); await pool.end(); }
});
