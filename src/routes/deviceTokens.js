// ─── Device tokens (FCM) ──────────────────────────────────────────────────────
// الأبلكيشن بيسجّل توكن الجهاز هنا بعد تسجيل الدخول، والباك إند بيبعت عليه Push
// لما يحصل إشعار جديد (createNotification في db.js).

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/devices/token — تسجيل/تحديث توكن الجهاز للمستخدم الحالي
router.post('/token', requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'التوكن مطلوب' });
  }
  try {
    await query(
      `INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
      [req.userId, token, platform || 'android']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل تسجيل الجهاز' });
  }
});

// DELETE /api/devices/token — إلغاء تسجيل الجهاز (مثلاً عند تسجيل الخروج)
router.delete('/token', requireAuth, async (req, res) => {
  const { token } = req.body || {};
  try {
    await query('DELETE FROM device_tokens WHERE token=$1 AND user_id=$2', [
      token,
      req.userId,
    ]);
  } catch (err) {
    console.error(err);
  }
  res.json({ ok: true });
});

module.exports = router;
