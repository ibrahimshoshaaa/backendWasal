const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الإشعارات' });
  }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الإشعار' });
  }
});

// PUT /api/notifications/read-all
router.put('/read-all', requireAuth, async (req, res) => {
  try {
    await query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الإشعارات' });
  }
});

module.exports = router;
