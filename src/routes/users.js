const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

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
  params.push(req.userId);

  const { rows } = await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ user: publicUser(rows[0]) });
});

router.delete('/me', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM users WHERE id=$1', [req.userId]);
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
