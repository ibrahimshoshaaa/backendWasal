const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const { category_id } = req.query;
  let sql = "SELECT * FROM merchants WHERE status='approved'";
  const params = [];
  if (category_id) {
    params.push(category_id);
    sql += ` AND category_id=$${params.length}`;
  }
  sql += ' ORDER BY id DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM merchants WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'المتجر غير موجود' });
  res.json(rows[0]);
});

// Used by both the merchant onboarding flow and the admin panel to
// update a merchant's own details or its approval status.
router.put('/:id', requireAuth, requireRole('admin', 'merchant'), async (req, res) => {
  const fields = ['name', 'category_id', 'image_url', 'address', 'phone', 'status'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f}=$${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE merchants SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'المتجر غير موجود' });
  res.json(rows[0]);
});

module.exports = router;
