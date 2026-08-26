const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC, id DESC',
    [req.userId]
  );
  res.json(rows);
});

router.post('/', requireAuth, async (req, res) => {
  const { label, address_text, phone, is_default, lat, lng } = req.body || {};
  if (!label || !address_text) return res.status(400).json({ error: 'بيانات العنوان ناقصة' });

  try {
    if (is_default) {
      await query('UPDATE addresses SET is_default=false WHERE user_id=$1', [req.userId]);
    }
    const { rows } = await query(
      `INSERT INTO addresses (user_id, label, address_text, phone, lat, lng, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.userId, label, address_text, phone || null, lat ?? null, lng ?? null, !!is_default]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل حفظ العنوان' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
