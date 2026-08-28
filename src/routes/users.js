const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');
const { destroyByPublicId, extractPublicIdFromUrl } = require('../config/cloudinary');

const router = express.Router();

// PUT /api/users/me
// نفس التوقيع القديم: بيقبل full_name / phone / avatar_url في الـ body.
// الاختلاف الوحيد: لو avatar_url اتغيّر فعلاً، بنحاول نحذف الصورة القديمة
// من Cloudinary (فقط لو الرابط القديم على Cloudinary — الروابط القديمة اللي
// كانت على /uploads بتتساب لأنها مش موجودة على Cloudinary أصلاً).
router.put('/me', requireAuth, async (req, res) => {
  const fields = ['full_name', 'phone', 'avatar_url'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f}=$${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });

  // نجيب الصورة القديمة قبل التحديث عشان نقدر نحذفها من Cloudinary بعد كده.
  let oldAvatarUrl = null;
  let oldAvatarPublicId = null;
  if (req.body.avatar_url !== undefined) {
    const { rows: oldRows } = await query(
      'SELECT avatar_url, avatar_public_id FROM users WHERE id=$1',
      [req.userId]
    );
    if (oldRows.length) {
      oldAvatarUrl = oldRows[0].avatar_url;
      oldAvatarPublicId = oldRows[0].avatar_public_id;
    }
  }

  params.push(req.userId);
  const { rows } = await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });

  // Cleanup الصورة القديمة (best-effort — مش بيوقف الاستجابة لو فشل).
  if (
    req.body.avatar_url !== undefined &&
    oldAvatarUrl &&
    oldAvatarUrl !== req.body.avatar_url
  ) {
    const pid = oldAvatarPublicId || extractPublicIdFromUrl(oldAvatarUrl);
    if (pid) destroyByPublicId(pid).catch(() => {});
  }

  res.json({ user: publicUser(rows[0]) });
});

router.delete('/me', requireAuth, async (req, res) => {
  try {
    // نجيب public_ids الصور المرتبطة بالمستخدم قبل حذفه — عشان نقدر ننضّفهم
    // من Cloudinary بعد ما الحذف من الـ DB ينجح.
    const { rows: userRows } = await query(
      `SELECT avatar_public_id, avatar_url,
              id_front_public_id, id_front_url,
              id_back_public_id, id_back_url,
              selfie_public_id, selfie_url
       FROM users WHERE id=$1`,
      [req.userId]
    );

    await query('DELETE FROM users WHERE id=$1', [req.userId]);

    // نضّف صور المستخدم من Cloudinary (best-effort).
    if (userRows.length) {
      const u = userRows[0];
      const ids = [
        u.avatar_public_id || extractPublicIdFromUrl(u.avatar_url),
        u.id_front_public_id || extractPublicIdFromUrl(u.id_front_url),
        u.id_back_public_id || extractPublicIdFromUrl(u.id_back_url),
        u.selfie_public_id || extractPublicIdFromUrl(u.selfie_url),
      ].filter(Boolean);
      for (const pid of ids) {
        destroyByPublicId(pid).catch(() => {});
      }
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      // FK violation — the account has order history that must be kept.
      return res.status(400).json({
        error: 'لا يمكن حذف الحساب لوجود طلبات سابقة مرتبطة بيه. تواصل مع الدعم الفني لحذفه يدويًا.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

module.exports = router;
