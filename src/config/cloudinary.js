// ─── Cloudinary central config ────────────────────────────────────────────────
// كل الصور في المشروع بترفع من هنا. مافيش أي API Key أو Secret مكتوب في الكود.
// القيم بتيجي من Environment Variables على Railway:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// لو أي متغير ناقص، السيرفر لسه بيقوم شغال بس رفع الصور هيرجع رسالة خطأ واضحة
// بدل ما ينهار (defensive by design — الطلبات الأخرى ما تتأثرش).

const cloudinary = require('cloudinary').v2;

const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

const isConfigured = Boolean(
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
);

if (isConfigured) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  // لاحظ: مش بنطبع الأسرار، بس تحذير إن الإعداد ناقص.
  console.warn(
    '[cloudinary] المتغيرات CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET ناقصة. رفع الصور هيفشل لحد ما تتظبط في Railway.'
  );
}

// رفع Buffer (جاي من multer.memoryStorage) لـ Cloudinary باستخدام upload_stream.
// بيرجع { secure_url, public_id } — بنحفظهم في PostgreSQL.
function uploadBuffer(buffer, { folder = 'wasal/misc', filename } = {}) {
  return new Promise((resolve, reject) => {
    if (!isConfigured) {
      return reject(new Error('Cloudinary غير مهيأ. تأكد من متغيرات البيئة.'));
    }
    if (!buffer || !buffer.length) {
      return reject(new Error('الملف فارغ'));
    }

    const options = {
      folder,
      resource_type: 'image',
      // اتركنا Cloudinary يولّد public_id عشوائي عشان نتفادى تصادم الأسماء.
      overwrite: false,
      // لو عايزين نحافظ على اسم الملف الأصلي كمرجع بس:
      ...(filename ? { public_id: undefined, use_filename: false } : {}),
    };

    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      if (!result) return reject(new Error('فشل رفع الصورة'));
      resolve({
        url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
      });
    });

    stream.end(buffer);
  });
}

// حذف صورة من Cloudinary — safe: بيرجع false لو الـ public_id فاضي أو الحذف فشل،
// عمداً مش بيرمي exception عشان الحذف ما يكسرش أي endpoint (مثلاً تعديل بروفايل).
async function destroyByPublicId(publicId) {
  if (!publicId || !isConfigured) return false;
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true,
    });
    return result?.result === 'ok' || result?.result === 'not found';
  } catch (err) {
    console.error('[cloudinary] destroy failed for', publicId, err.message);
    return false;
  }
}

// استخراج public_id من رابط Cloudinary — للصور القديمة اللي لسه ما اتحفظش
// لها public_id في عمود منفصل. بيدعم الصيغ:
//   https://res.cloudinary.com/<cloud>/image/upload/v1699999999/wasal/users/abc.jpg
//   https://res.cloudinary.com/<cloud>/image/upload/wasal/users/abc.jpg
// لو الرابط مش على Cloudinary أصلاً (مثلاً رابط /uploads قديم) بيرجع null
// عشان ما نحاولش نحذف حاجة مش بتاعتنا.
function extractPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.includes('res.cloudinary.com')) return null;

  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    let tail = parts[1];
    // شيل رقم النسخة v123456789/ لو موجود
    tail = tail.replace(/^v\d+\//, '');
    // شيل الامتداد
    const withoutExt = tail.replace(/\.[a-zA-Z0-9]+$/, '');
    return withoutExt || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  cloudinary,
  uploadBuffer,
  destroyByPublicId,
  extractPublicIdFromUrl,
  isConfigured,
};
