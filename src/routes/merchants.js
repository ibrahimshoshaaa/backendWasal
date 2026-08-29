const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('GET /merchants error:', err);
    res.status(500).json({ error: 'تعذر تحميل المتاجر' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM merchants WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'المتجر غير موجود' });

    const { rows: products } = await query(
      'SELECT * FROM products WHERE merchant_id=$1 AND is_available=true ORDER BY category NULLS LAST, id DESC',
      [req.params.id]
    );
    const { rows: ratingRows } = await query(
      `SELECT COALESCE(AVG(rating), 0) AS avg_rating, COUNT(rating) AS rating_count
       FROM orders WHERE merchant_id=$1 AND rating IS NOT NULL`,
      [req.params.id]
    );
    res.json({
      ...rows[0],
      products,
      avg_rating: Number(ratingRows[0].avg_rating),
      rating_count: Number(ratingRows[0].rating_count),
    });
  } catch (err) {
    console.error('GET /merchants/:id error:', err);
    res.status(500).json({ error: 'تعذر تحميل بيانات المتجر' });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const fields = ['name', 'category_id', 'image_url', 'cover_image_url', 'address', 'phone',
                    'status', 'tags', 'is_open', 'hours_note', 'delivery_fee',
                    'delivery_time_minutes', 'min_order', 'lat', 'lng'];
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
  } catch (err) {
    console.error('PUT /merchants/:id error:', err);
    res.status(500).json({ error: 'تعذر تحديث المتجر' });
  }
});

module.exports = router;
