// ─── POST /api/upload ─────────────────────────────────────────────────────────
// endpoint عام لرفع صورة واحدة. الاستجابة محافظة على نفس الشكل القديم
// { url: "..." } عشان Flutter والموقع ما يتأثروش، ومضيف public_id جنبه
// للأدوات اللي تحب تستخدمه (اختياري تماماً).
//
// قبل: كان بيخزن الصورة في مجلد uploads/ على قرص Railway (بتضيع كل Redeploy).
// بعد: بيتخزن في Cloudinary تحت folder wasal/misc، ورابط secure_url بيرجع للعميل.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { upload, multerErrorHandler } = require('../middleware/uploader');
const { uploadBuffer } = require('../config/cloudinary');

const router = express.Router();

router.post(
  '/',
  requireAuth,
  upload.single('image'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي صورة' });

      const result = await uploadBuffer(req.file.buffer, {
        folder: 'wasal/misc',
      });

      // نفس شكل الاستجابة القديم + public_id إضافي.
      res.json({
        url: result.url,
        public_id: result.public_id,
      });
    } catch (err) {
      console.error('[upload] Cloudinary error:', err.message);
      return res.status(500).json({ error: 'فشل رفع الصورة، حاول تاني' });
    }
  }
);

// أخطاء multer (حجم الملف / نوع الملف) بترجع رسائل واضحة بالعربي.
router.use(multerErrorHandler);

module.exports = router;
