const express = require('express');
const { query } = require('../db');

const router = express.Router();

// GET /api/ads?region=... — الإعلانات النشطة حالياً (ضمن المدة الزمنية والمنطقة)
router.get('/', async (req, res) => {
  try {
    const { region } = req.query;
    const { rows } = await query(
      `SELECT id, title, image_url, link_type, link_target_id, link_url
       FROM ads
       WHERE is_active = true
         AND (start_at IS NULL OR start_at <= now())
         AND (end_at IS NULL OR end_at >= now())
         AND (region IS NULL OR region = $1)
       ORDER BY sort_order ASC, id DESC`,
      [region || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /ads error:', err);
    res.status(500).json({ error: 'تعذر تحميل الإعلانات' });
  }
});

// POST /api/ads/:id/view — تسجيل مشاهدة (يُستدعى لحظة ظهور الإعلان للعميل)
router.post('/:id/view', async (req, res) => {
  try {
    await query('UPDATE ads SET views = views + 1 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تسجيل المشاهدة' });
  }
});

// POST /api/ads/:id/click — تسجيل ضغطة (يُستدعى لحظة ما العميل يدوس على الإعلان)
router.post('/:id/click', async (req, res) => {
  try {
    await query('UPDATE ads SET clicks = clicks + 1 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تسجيل الضغطة' });
  }
});

module.exports = router;
