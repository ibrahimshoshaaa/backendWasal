const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Orders available to pick up (ready, unassigned) + this driver's own active orders.
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

router.put('/orders/:id/accept', requireAuth, requireRole('driver'), async (req, res) => {
  const { rowCount } = await query(
    "UPDATE orders SET driver_id=$1, status='picked_up' WHERE id=$2 AND status='ready' AND driver_id IS NULL",
    [req.userId, req.params.id]
  );
  if (!rowCount) return res.status(409).json({ error: 'الطلب اتاخد بالفعل من مندوب تاني' });
  res.json({ ok: true });
});

router.put('/orders/:id/deliver', requireAuth, requireRole('driver'), async (req, res) => {
  const { rowCount } = await query(
    "UPDATE orders SET status='delivered' WHERE id=$1 AND driver_id=$2",
    [req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ ok: true });
});

router.put('/status', requireAuth, requireRole('driver'), async (req, res) => {
  const { is_online } = req.body || {};
  await query('UPDATE users SET is_online=$1 WHERE id=$2', [!!is_online, req.userId]);
  res.json({ ok: true });
});

router.put('/location', requireAuth, requireRole('driver'), async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'الإحداثيات مطلوبة' });
  }
  await query('UPDATE users SET driver_lat=$1, driver_lng=$2 WHERE id=$3', [lat, lng, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
