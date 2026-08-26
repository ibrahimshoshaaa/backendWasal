const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const DELIVERY_FEE = 15;

async function buildCartResponse(userId) {
  const { rows } = await query(
    `SELECT ci.product_id, ci.quantity, p.name, p.price, p.image_url, p.merchant_id
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = $1
     ORDER BY ci.id ASC`,
    [userId]
  );

  const items = rows.map((r) => ({
    product_id: r.product_id,
    name: r.name,
    price: Number(r.price),
    quantity: r.quantity,
    image_url: r.image_url,
  }));

  const total = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const merchantId = rows.length ? rows[0].merchant_id : null;
  const deliveryFee = items.length ? DELIVERY_FEE : 0;

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

router.post('/', requireAuth, async (req, res) => {
  const { product_id, quantity } = req.body || {};
  if (!product_id || !quantity) return res.status(400).json({ error: 'بيانات ناقصة' });

  try {
    const { rows: productRows } = await query('SELECT * FROM products WHERE id=$1', [product_id]);
    if (!productRows.length) return res.status(404).json({ error: 'المنتج غير موجود' });
    const product = productRows[0];

    // Cart holds items from a single merchant at a time — switching
    // merchants replaces the cart, matching the app's single-checkout flow.
    const { rows: existingCart } = await query(
      `SELECT DISTINCT p.merchant_id FROM cart_items ci
       JOIN products p ON p.id = ci.product_id WHERE ci.user_id=$1`,
      [req.userId]
    );
    if (existingCart.length && existingCart[0].merchant_id !== product.merchant_id) {
      await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
    }

    await query(
      `INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = cart_items.quantity + $3`,
      [req.userId, product_id, quantity]
    );

    res.json(await buildCartResponse(req.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشلت إضافة المنتج للسلة' });
  }
});

router.put('/item/:productId', requireAuth, async (req, res) => {
  const { quantity } = req.body || {};
  if (quantity === undefined) return res.status(400).json({ error: 'الكمية مطلوبة' });

  if (quantity <= 0) {
    await query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [
      req.userId,
      req.params.productId,
    ]);
  } else {
    await query('UPDATE cart_items SET quantity=$1 WHERE user_id=$2 AND product_id=$3', [
      quantity,
      req.userId,
      req.params.productId,
    ]);
  }
  res.json(await buildCartResponse(req.userId));
});

router.delete('/', requireAuth, async (req, res) => {
  await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
  res.json({ ok: true });
});

module.exports = router;
