const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  res.json(rows);
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { name_ar, name_en, type, sort_order } = req.body || {};
  if (!name_ar) return res.status(400).json({ error: 'اسم الفئة مطلوب' });
  const { rows } = await query(
    `INSERT INTO categories (name_ar, name_en, type, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name_ar, name_en || null, type || 'main', sort_order || 0]
  );
  res.json(rows[0]);
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await query('DELETE FROM categories WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
