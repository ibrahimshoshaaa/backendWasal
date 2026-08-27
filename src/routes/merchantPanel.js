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

// ─── Store profile ────────────────────────────────────────────────────────────

router.get('/profile', requireAuth, requireRole('merchant'), async (req, res) => {
  const { rows } = await query('SELECT * FROM merchants WHERE owner_user_id=$1 LIMIT 1', [
    req.userId,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
  res.json(rows[0]);
});

router.put('/profile', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

  // A merchant can edit their own display details, but never their own
  // approval status — that stays admin-only (see PUT /api/merchants/:id).
  const fields = [
    'name', 'image_url', 'address', 'phone', 'tags',
    'is_open', 'delivery_fee', 'delivery_time_minutes', 'min_order',
  ];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(f === 'tags' ? JSON.stringify(req.body[f]) : req.body[f]);
      updates.push(`${f}=$${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
  params.push(merchantId);
  const { rows } = await query(
    `UPDATE merchants SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  res.json(rows[0]);
});

// ─── Products ─────────────────────────────────────────────────────────────────

router.get('/products', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  if (!merchantId) return res.json([]);
  const { rows } = await query(
    'SELECT * FROM products WHERE merchant_id=$1 ORDER BY id DESC',
    [merchantId]
  );
  res.json(rows);
});

router.post('/products', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

  const { name, price, image_url, description, category } = req.body || {};
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'اسم المنتج والسعر مطلوبين' });
  }
  const { rows } = await query(
    `INSERT INTO products (merchant_id, name, price, image_url, description, category)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [merchantId, name, price, image_url || null, description || null, category || null]
  );
  res.json(rows[0]);
});

router.put('/products/:id', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

  const fields = ['name', 'price', 'image_url', 'description', 'category', 'is_available'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f}=$${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
  params.push(req.params.id, merchantId);
  const { rows } = await query(
    `UPDATE products SET ${updates.join(', ')}
     WHERE id=$${params.length - 1} AND merchant_id=$${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'المنتج غير موجود' });
  res.json(rows[0]);
});

router.delete('/products/:id', requireAuth, requireRole('merchant'), async (req, res) => {
  const merchantId = await myMerchantId(req.userId);
  if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

  const { rowCount } = await query(
    'DELETE FROM products WHERE id=$1 AND merchant_id=$2',
    [req.params.id, merchantId]
  );
  if (!rowCount) return res.status(404).json({ error: 'المنتج غير موجود' });
  res.json({ ok: true });
});

module.exports = router;
