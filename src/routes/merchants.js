const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const { category_id } = req.query;
  let sql = `
    SELECT m.*, c.name_ar AS category_name
    FROM merchants m
    LEFT JOIN categories c ON c.id = m.category_id
    WHERE m.status='approved'
  `;
  const params = [];
  if (category_id) {
    params.push(category_id);
    sql += ` AND m.category_id=$${params.length}`;
  }
  sql += ' ORDER BY m.id DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM merchants WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'المتجر غير موجود' });

  const { rows: products } = await query(
    'SELECT * FROM products WHERE merchant_id=$1 AND is_available=true ORDER BY category NULLS LAST, id DESC',
    [req.params.id]
  );
  res.json({ ...rows[0], products });
});

// Admin-only: update any merchant's details or approval status.
// (Merchants update their own profile via PUT /api/merchant/profile, which
// cannot touch `status` and is scoped to their own row.)
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const fields = ['name', 'category_id', 'image_url', 'address', 'phone', 'status', 'tags'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(f === 'tags' ? JSON.stringify(req.body[f]) : req.body[f]);
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
