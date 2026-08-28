const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/users', async (req, res) => {
  const { rows } = await query(
    'SELECT id, full_name, email, phone, role, avatar_url, created_at FROM users ORDER BY id DESC'
  );
  res.json(rows);
});

router.get('/merchants', async (req, res) => {
  const { rows } = await query('SELECT * FROM merchants ORDER BY id DESC');
  res.json(rows);
});

router.get('/drivers', async (req, res) => {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, is_online, driver_status, driver_lat, driver_lng,
            national_id, vehicle_type, id_front_url, id_back_url, selfie_url
     FROM users WHERE role='driver' ORDER BY id DESC`
  );
  res.json(rows);
});

router.put('/drivers/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'الحالة مطلوبة' });
  const { rowCount } = await query(
    "UPDATE users SET driver_status=$1 WHERE id=$2 AND role='driver'",
    [status, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'المندوب غير موجود' });
  res.json({ ok: true });
});

router.get('/orders', async (req, res) => {
  const { rows } = await query(
    `SELECT o.*,
            c.full_name AS customer_name,
            c.phone AS customer_phone,
            m.name AS merchant_name,
            m.phone AS merchant_phone,
            m.address AS merchant_address,
            a.address_text AS delivery_address,
            a.lat AS delivery_lat,
            a.lng AS delivery_lng,
            d.full_name AS driver_name,
            d.phone AS driver_phone
     FROM orders o
     LEFT JOIN users c ON c.id = o.customer_id
     LEFT JOIN merchants m ON m.id = o.merchant_id
     LEFT JOIN addresses a ON a.id = o.address_id
     LEFT JOIN users d ON d.id = o.driver_id
     ORDER BY o.created_at DESC`
  );
  res.json(rows);
});

router.put('/orders/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'الحالة مطلوبة' });
  const { rowCount } = await query('UPDATE orders SET status=$1 WHERE id=$2', [
    status,
    req.params.id,
  ]);
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ ok: true });
});

module.exports = router;
