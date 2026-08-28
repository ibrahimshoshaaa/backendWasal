// ─── Multer uploader (memory storage) ────────────────────────────────────────
// بنستخدم memoryStorage عمداً عشان الملف ما يتخزنش على قرص Railway (اللي بيتمسح
// كل Redeploy) — بيتقرأ في الذاكرة كـ Buffer، وبيتبعت مباشرة لـ Cloudinary.
//
// الحدود ونوع الملف موحدة في مكان واحد، عشان أي endpoint جديد يستخدم نفس القواعد.

const multer = require('multer');

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB — نفس الحد اللي كان قبل التعديل

// امتدادات وMime types مسموحة (نفس اللي كانت + التوافق مع القديم).
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/bmp',
]);
const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i;

function fileFilter(req, file, cb) {
  const okMime = file.mimetype && (file.mimetype.startsWith('image/') || ALLOWED_MIME.has(file.mimetype));
  const okExt = ALLOWED_EXT.test(file.originalname || '');
  if (!okMime && !okExt) {
    return cb(new Error('الملف لازم يكون صورة (jpg, png, webp, gif, heic, bmp)'));
  }
  cb(null, true);
}

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

// Error handler خاص بـ multer — بنستخدمه بعد أي route فيها رفع صور.
// بيحول أخطاء multer (زي حجم الملف أكبر من الحد) لرسائل عربية واضحة،
// بدل ما ترجع Stack trace للـ Flutter/الموقع.
function multerErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'حجم الصورة لازم يكون أقل من 8 ميجابايت' });
    }
    return res.status(400).json({ error: err.message || 'فشل رفع الصورة' });
  }
  if (err && /صورة|image/i.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
}

module.exports = {
  upload,
  multerErrorHandler,
  MAX_FILE_SIZE,
};
