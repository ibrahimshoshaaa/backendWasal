const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  const { merchant_id, address_id, items, subtotal, delivery_fee, total, payment_method, notes } =
    req.body || {};
  if (!merchant_id || !items || !items.length) {
    return res.status(400).json({ error: 'بيانات الطلب ناقصة' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO orders
        (customer_id, merchant_id, address_id, items_json, subtotal, delivery_fee, total, payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.userId,
        merchant_id,
        address_id || null,
        JSON.stringify(items),
        subtotal || 0,
        delivery_fee || 0,
        total || 0,
        payment_method || 'cash',
        notes || null,
      ]
    );
    await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل إنشاء الطلب' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',
    [req.userId]
  );
  res.json(rows);
});

router.get('/:id/track', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.status, o.customer_id, u.driver_lat, u.driver_lng
     FROM orders o
     LEFT JOIN users u ON u.id = o.driver_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
  const order = rows[0];
  if (order.customer_id !== req.userId && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'غير مصرح لك بمتابعة هذا الطلب' });
  }
  res.json({
    status: order.status,
    driver_lat: order.driver_lat,
    driver_lng: order.driver_lng,
  });
});

module.exports = router;
