const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/orders', requireAuth, requireRole('driver'), async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM orders
     WHERE (status='ready' AND driver_id IS NULL)
        OR (driver_id=$1 AND status IN ('picked_up'))
     ORDER BY created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

// ← جديد: رجّع حالة المندوب (is_online)
router.get('/status', requireAuth, requireRole('driver'), async (req, res) => {
  const { rows } = await query('SELECT is_online FROM users WHERE id=$1', [req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ is_online: rows[0].is_online });
});

router.put('/status', requireAuth, requireRole('driver'), async (req, res) => {
  const { is_online } = req.body || {};
  await query('UPDATE users SET is_online=$1 WHERE id=$2', [!!is_online, req.userId]);
  res.json({ ok: true, is_online: !!is_online });
});

router.put('/location', requireAuth, requireRole('driver'), async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'الإحداثيات مطلوبة' });
  }
  await query('UPDATE users SET driver_lat=$1, driver_lng=$2 WHERE id=$3', [lat, lng, req.userId]);
  res.json({ ok: true });
});

router.put('/orders/:id/accept', requireAuth, requireRole('driver'), async (req, res) => {
  const { rowCount } = await query(
    "UPDATE orders SET status='picked_up', driver_id=$1 WHERE id=$2 AND status='ready' AND driver_id IS NULL",
    [req.userId, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير متاح' });
  res.json({ ok: true });
});

router.put('/orders/:id/deliver', requireAuth, requireRole('driver'), async (req, res) => {
  const { rowCount } = await query(
    "UPDATE orders SET status='delivered' WHERE id=$1 AND driver_id=$2 AND status='picked_up'",
    [req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ ok: true });
});

module.exports = router;
