const express = require('express');
const { query, pool } = require('../db');
const { resolveOptions } = require('../services/options');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
for (const method of ['get', 'post', 'put', 'delete']) {
  const register = router[method].bind(router);
  router[method] = (path, ...handlers) => register(path, ...handlers.map(handler =>
    (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next)));
}
// Fallback فقط لو المتجر مالوش delivery_fee متسجل لأي سبب — القيمة الحقيقية
// بتتجاب من جدول merchants لكل تاجر على حدة.
const DEFAULT_DELIVERY_FEE = 15;

async function buildCartResponse(userId) {
  const { rows } = await query(
    `SELECT ci.id, ci.product_id, ci.quantity, ci.selected_options, ci.unit_extra,
            p.name, p.price, p.image_url, p.merchant_id
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = $1
     ORDER BY ci.id ASC`,
    [userId]
  );

  const items = rows.map((r) => {
    const unitPrice = Number(r.price) + Number(r.unit_extra || 0);
    return {
      id: r.id,
      product_id: r.product_id,
      name: r.name,
      price: Number(r.price),
      unit_extra: Number(r.unit_extra || 0),
      unit_price: unitPrice,
      selected_options: r.selected_options || [],
      quantity: r.quantity,
      image_url: r.image_url,
      line_total: unitPrice * r.quantity,
    };
  });

  const total = items.reduce((sum, it) => sum + it.line_total, 0);
  const merchantId = rows.length ? rows[0].merchant_id : null;

  let deliveryFee = 0;
  if (items.length && merchantId) {
    const { rows: merchantRows } = await query(
      'SELECT delivery_fee FROM merchants WHERE id=$1',
      [merchantId]
    );
    deliveryFee = merchantRows.length
      ? Number(merchantRows[0].delivery_fee)
      : DEFAULT_DELIVERY_FEE;
  }

  return {
    merchant_id: merchantId,
    items,
    total,
    delivery_fee: deliveryFee,
    grand_total: total + deliveryFee,
  };
}

router.get('/', requireAuth, async (req, res) => {
  res.json(await buildCartResponse(req.userId));
});

// POST /api/cart
// body: { product_id, quantity, selected_options?: [{ group_id, choice_ids: [id, ...] }] }
// كل تركيبة إضافات مختلفة بتتخزن كسطر منفصل في السلة (options_hash مميز)،
// عشان مثلاً "بيتزا وسط" و"بيتزا كبيرة" ما يتلخبطوش في نفس السطر.
router.post('/', requireAuth, async (req, res) => {
  const { product_id, quantity, selected_options = [] } = req.body || {};
  if (!Number.isInteger(Number(product_id)) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return res.status(400).json({ error: 'المنتج والكمية غير صحيحين' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [req.userId]);
    const { rows } = await client.query('SELECT * FROM products WHERE id=$1', [product_id]);
    const product = rows[0];
    if (!product || !product.is_available) throw Object.assign(new Error('المنتج غير متاح'), { status: 400 });
    const options = await resolveOptions(client.query.bind(client), product.id, selected_options);
    const { rows: existing } = await client.query(
      `SELECT DISTINCT p.merchant_id FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=$1`, [req.userId]);
    if (existing.some(line => line.merchant_id !== product.merchant_id)) await client.query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
    const result = await client.query(
      `INSERT INTO cart_items (user_id, product_id, quantity, selected_options, options_hash, unit_extra)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, product_id, options_hash) DO UPDATE
       SET quantity=cart_items.quantity+$3, selected_options=$4, unit_extra=$6
       WHERE cart_items.quantity+$3 <= 99 RETURNING id`,
      [req.userId, product.id, quantity, JSON.stringify(options.resolved), options.hash, options.extra]);
    if (!result.rowCount) throw Object.assign(new Error('الحد الأقصى للكمية 99'), { status: 400 });
    await client.query('COMMIT');
    res.json(await buildCartResponse(req.userId));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.status ? err.message : 'فشلت إضافة المنتج للسلة' });
  } finally { client.release(); }
});

// PUT /api/cart/item/:productId — تحديث الكمية لسطر بدون إضافات (توافق مع النسخ القديمة)
router.put('/item/:productId', requireAuth, async (req, res) => {
  const { quantity } = req.body || {};
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) return res.status(400).json({ error: 'الكمية لازم تكون من 0 إلى 99' });

  if (quantity <= 0) {
    await query("DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2 AND options_hash=''", [
      req.userId,
      req.params.productId,
    ]);
  } else {
    await query(
      "UPDATE cart_items SET quantity=$1 WHERE user_id=$2 AND product_id=$3 AND options_hash=''",
      [quantity, req.userId, req.params.productId]
    );
  }
  res.json(await buildCartResponse(req.userId));
});

// PUT /api/cart/line/:id — تحديث الكمية لسطر معين (بما فيه أسطر بإضافات مختارة)
router.put('/line/:id', requireAuth, async (req, res) => {
  const { quantity } = req.body || {};
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) return res.status(400).json({ error: 'الكمية لازم تكون من 0 إلى 99' });

  if (quantity <= 0) {
    await query('DELETE FROM cart_items WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  } else {
    await query('UPDATE cart_items SET quantity=$1 WHERE id=$2 AND user_id=$3', [
      quantity,
      req.params.id,
      req.userId,
    ]);
  }
  res.json(await buildCartResponse(req.userId));
});

// DELETE /api/cart/line/:id — حذف سطر معين من السلة
router.delete('/line/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM cart_items WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json(await buildCartResponse(req.userId));
});

router.delete('/', requireAuth, async (req, res) => {
  await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
  res.json({ ok: true });
});

module.exports = router;

