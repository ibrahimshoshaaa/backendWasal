// ─── Device tokens (FCM) ──────────────────────────────────────────────────────
// الأبلكيشن بيسجّل توكن الجهاز هنا بعد تسجيل الدخول، والباك إند بيبعت عليه Push
// لما يحصل إشعار جديد (createNotification في db.js).

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/devices/token — تسجيل/تحديث توكن الجهاز للمستخدم الحالي
router.post('/token', requireAuth, async (req, res) => {
  const { token, platform, session_filtered } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'التوكن مطلوب' });
  }
  try {
    await query(
      `INSERT INTO device_tokens (user_id, token, platform, session_filtered)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, session_filtered = EXCLUDED.session_filtered`,
      [req.userId, token, platform || 'android', session_filtered === true]
    );

    // سجل تاريخي (append-only) — عشان نظام مكافحة الطلبات الوهمية يقدر يكتشف
    // نفس الجهاز بيستخدم حسابات متعددة، حتى بعد ما device_tokens يستبدل المالك.
    const { rows: already } = await query(
      'SELECT 1 FROM device_registrations WHERE user_id=$1 AND device_token=$2 LIMIT 1',
      [req.userId, token]
    );
    if (!already.length) {
      await query('INSERT INTO device_registrations (user_id, device_token) VALUES ($1,$2)', [
        req.userId,
        token,
      ]);
    }

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

// Detach this installation and stop new job reception when a driver signs out.
router.post('/logout', requireAuth, async (req,res) => {
  try {
    if (req.userRole === 'driver') await query('UPDATE users SET is_online=false WHERE id=$1',[req.userId]);
    if (typeof req.body?.token === 'string') await query('DELETE FROM device_tokens WHERE user_id=$1 AND token=$2',[req.userId,req.body.token]);
    res.json({ok:true});
  } catch (_) { res.status(500).json({error:'تعذر فصل إشعارات الجهاز'}); }
});
module.exports = router;

