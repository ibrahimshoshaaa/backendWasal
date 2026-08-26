const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function myMerchantId(userId) {
  const { rows } = await query('SELECT id FROM merchants WHERE owner_user_id=$1 LIMIT 1', [userId]);
  return rows.length ? rows[0].id : null;
}

router.get('/orders', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  if (!merchantId) return res.json([]);
  const { rows } = await query(
    'SELECT * FROM orders WHERE merchant_id=$1 ORDER BY created_at DESC',
    [merchantId]
  );
  res.json(rows);
});

router.put('/orders/:id/accept', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  const { rowCount } = await query(
    "UPDATE orders SET status='accepted' WHERE id=$1 AND merchant_id=$2",
    [req.params.id, merchantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ ok: true });
});

router.put('/orders/:id/ready', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  const { rowCount } = await query(
    "UPDATE orders SET status='ready' WHERE id=$1 AND merchant_id=$2",
    [req.params.id, merchantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ ok: true });
});

module.exports = router;
