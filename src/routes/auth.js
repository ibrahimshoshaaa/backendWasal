// ─── Auth routes (register / login) ───────────────────────────────────────────
// التسجيل بيدعم multipart/form-data عشان يحمل صور logo المتجر أو صور بطاقة
// السائق + السيلفي في نفس الطلب. الصور دي بترفع مباشرة لـ Cloudinary بدل
// ما تتخزن على قرص السيرفر (اللي بيتمسح مع أي Redeploy على Railway).
//
// شكل الاستجابة والحقول والـ endpoints نفسها بالظبط — Flutter والموقع ما يتأثروش.

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { signToken } = require('../middleware/auth');
const { upload, multerErrorHandler } = require('../middleware/uploader');
const { uploadBuffer } = require('../config/cloudinary');
const { generateVerificationCode, sendVerificationEmail } = require('../services/email');

const router = express.Router();

// ─── مدة صلاحية الكود، ومدة الانتظار الإجبارية قبل السماح بكود جديد ───────────
const CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 دقيقة
const RESEND_COOLDOWN_MS = 5 * 60 * 1000; // 5 دقايق

// email_verify_expires بيتحط دايمًا = وقت الإرسال + 15 دقيقة، فنقدر نرجع نحسب
// "وقت الإرسال" منها، ونحسب منه هل الـ 5 دقايق عدت ولا لأ.
function cooldownRemainingSeconds(user) {
  if (!user.email_verify_expires) return 0;
  const sentAt = new Date(user.email_verify_expires).getTime() - CODE_EXPIRY_MS;
  const elapsed = Date.now() - sentAt;
  if (elapsed >= RESEND_COOLDOWN_MS) return 0;
  return Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
}

// ─── Rate limiting للتحقق من الإيميل — يمنع تجربة أكواد عشوائية أو spam إعادة إرسال ─
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كتير، حاول تاني بعد شوية' },
});

const resendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 دقايق
  max: 3,                   // 3 طلبات إعادة إرسال بس كل 5 دقايق لكل IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'استنى شوية قبل ما تطلب كود تاني' },
});

// ─── Rate limiting — يمنع محاولات brute-force على الدخول وspam التسجيل ────────
// بيحسب المحاولات لكل IP. لازم `app.set('trust proxy', 1)` يكون متحطوط في
// server.js عشان يقرأ الـ IP الحقيقي للمستخدم (Railway بيحط السيرفر ورا proxy).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 10,                   // 10 محاولات بس لكل IP في الـ 15 دقيقة
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات دخول كتير، حاول تاني بعد شوية' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // ساعة
  max: 20,                   // 20 تسجيل حساب جديد بالساعة لكل IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات تسجيل كتير، حاول تاني بعد شوية' },
});

// نفس الحقول القديمة بالظبط.
const registerUpload = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'id_front', maxCount: 1 },
  { name: 'id_back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]);

function publicUser(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    avatar_url: row.avatar_url,
    gender: row.gender || null,
    email_verified: !!row.email_verified,
  };
}

// Helper: يرفع ملف واحد لـ Cloudinary لو موجود، ويرجع { url, public_id } أو null.
// بيرمي error بس لو Cloudinary فشل — عشان الـ handler يمسكه ويرجع 500 نظيف.
async function uploadOrNull(file, folder) {
  if (!file || !file.buffer) return null;
  const r = await uploadBuffer(file.buffer, { folder });
  return { url: r.url, public_id: r.public_id };
}

router.post('/register', registerLimiter, registerUpload, async (req, res) => {
  const { full_name, email, password, phone, role, gender } = req.body || {};
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'الاسم والإيميل وكلمة المرور مطلوبين' });
  }
  const allowedRoles = ['customer', 'merchant', 'driver'];
  const finalRole = allowedRoles.includes(role) ? role : 'customer';
  const finalGender = ['male', 'female'].includes(gender) ? gender : null;
  // العميل والمندوب لازم يحددوا النوع (عشان فيتشر اختيار جنس السائق في وصّلني/وصّل لي)
  if ((finalRole === 'customer' || finalRole === 'driver') && !finalGender) {
    return res.status(400).json({ error: 'الرجاء تحديد النوع (ذكر أو أنثى)' });
  }

  const files = req.files || {};
  const logoFile = files.logo?.[0] || null;
  const idFrontFile = files.id_front?.[0] || null;
  const idBackFile = files.id_back?.[0] || null;
  const selfieFile = files.selfie?.[0] || null;

  if (finalRole === 'driver' && (!idFrontFile || !idBackFile || !selfieFile)) {
    return res.status(400).json({ error: 'الرجاء إرفاق صورتي البطاقة والصورة الشخصية' });
  }

  try {
    const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) return res.status(400).json({ error: 'الإيميل ده مستخدم قبل كده' });

    // نرفع كل الصور بالتوازي على Cloudinary قبل أي INSERT — لو حاجة فشلت،
    // ما بنعملش user ناقص الصور.
    let logoUp, idFrontUp, idBackUp, selfieUp;
    try {
      [logoUp, idFrontUp, idBackUp, selfieUp] = await Promise.all([
        uploadOrNull(logoFile, 'wasal/merchants/logos'),
        uploadOrNull(idFrontFile, 'wasal/users/documents'),
        uploadOrNull(idBackFile, 'wasal/users/documents'),
        uploadOrNull(selfieFile, 'wasal/users/documents'),
      ]);
    } catch (upErr) {
      console.error('[auth/register] Cloudinary upload failed:', upErr.message);
      return res.status(500).json({ error: 'فشل رفع الصور، حاول تاني' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (
         full_name, email, password_hash, phone, role, gender,
         national_id, vehicle_type,
         id_front_url, id_front_public_id,
         id_back_url, id_back_public_id,
         selfie_url, selfie_public_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        full_name,
        email,
        hash,
        phone || null,
        finalRole,
        finalGender,
        req.body.national_id || null,
        req.body.vehicle_type || null,
        idFrontUp?.url || null,
        idFrontUp?.public_id || null,
        idBackUp?.url || null,
        idBackUp?.public_id || null,
        selfieUp?.url || null,
        selfieUp?.public_id || null,
      ]
    );
    const user = rows[0];

    if (finalRole === 'merchant') {
      let tags = [];
      if (req.body.categories) {
        try {
          tags = JSON.parse(req.body.categories);
        } catch {
          tags = [req.body.categories];
        }
      }
      await query(
        `INSERT INTO merchants (owner_user_id, name, image_url, image_public_id, address, phone, tags, category_id, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          user.id,
          req.body.store_name || full_name,
          logoUp?.url || null,
          logoUp?.public_id || null,
          req.body.store_address || null,
          phone || null,
          JSON.stringify(tags),
          req.body.category_id ? parseInt(req.body.category_id, 10) : null,
          req.body.latitude ? parseFloat(req.body.latitude) : null,
          req.body.longitude ? parseFloat(req.body.longitude) : null,
        ]
      );
    }

    // ── إرسال كود تحقق الإيميل — Best effort: لو فشل الإرسال، التسجيل ما بيتأثرش ──
    // اليوزر بيقدر يستخدم حسابه عادي حتى لو مش متحقق؛ التحقق فيتشر إضافي دلوقتي.
    try {
      const code = generateVerificationCode();
      await query(
        `UPDATE users SET email_verify_code=$1, email_verify_expires=now() + interval '15 minutes' WHERE id=$2`,
        [code, user.id]
      );
      sendVerificationEmail(user.email, code).catch(() => {});
    } catch (e) {
      console.error('[auth/register] failed to queue verification email:', e.message);
    }

    res.json({ needsVerification: true, email: user.email, cooldownRemaining: Math.ceil(RESEND_COOLDOWN_MS / 1000) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

// ─── تأكيد كود التحقق — دي اللحظة اللي فعليًا بيتاح فيها الدخول (token) ────────
router.post('/verify-email', verifyLimiter, async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'الإيميل والكود مطلوبين' });

  try {
    const { rows } = await query(
      `SELECT * FROM users WHERE email=$1`,
      [email]
    );
    let user = rows[0];
    if (!user) return res.status(404).json({ error: 'الحساب مش موجود' });

    if (!user.email_verified) {
      if (!user.email_verify_code || user.email_verify_code !== String(code).trim()) {
        return res.status(400).json({ error: 'الكود غير صحيح' });
      }
      if (!user.email_verify_expires || new Date(user.email_verify_expires) < new Date()) {
        return res.status(400).json({ error: 'الكود منتهي الصلاحية، اطلب كود جديد' });
      }
      const { rows: updated } = await query(
        `UPDATE users SET email_verified=true, email_verify_code=NULL, email_verify_expires=NULL WHERE id=$1 RETURNING *`,
        [user.id]
      );
      user = updated[0];
    }

    // نفس شروط الموافقة الموجودة أصلاً في /login — التحقق من الإيميل لوحده
    // مش كافي لدخول تاجر/مندوب لسه تحت مراجعة الإدارة.
    if (user.role === 'driver' && user.driver_status !== 'active') {
      const msg =
        user.driver_status === 'suspended'
          ? 'تم رفض حسابك أو إيقافه. تواصل مع الإدارة.'
          : 'تم تفعيل بريدك الإلكتروني. حسابك لسه تحت المراجعة من الإدارة، هيتفعل قريباً.';
      return res.json({ ok: true, verified: true, pendingApproval: true, error: msg });
    }
    if (user.role === 'merchant') {
      const { rows: merchantRows } = await query(
        'SELECT status FROM merchants WHERE owner_user_id=$1 LIMIT 1',
        [user.id]
      );
      const merchantStatus = merchantRows[0]?.status;
      if (merchantStatus && merchantStatus !== 'approved') {
        const msg =
          merchantStatus === 'suspended'
            ? 'تم إيقاف حساب متجرك. تواصل مع الإدارة.'
            : 'تم تفعيل بريدك الإلكتروني. حساب متجرك لسه تحت المراجعة من الإدارة، هيتفعل قريباً.';
        return res.json({ ok: true, verified: true, pendingApproval: true, error: msg });
      }
    }

    res.json({ ok: true, verified: true, token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

// ─── إعادة إرسال كود التحقق ──────────────────────────────────────────────────
router.post('/resend-verification', resendLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'الإيميل مطلوب' });

  try {
    const { rows } = await query(
      `SELECT id, email, email_verified, email_verify_expires FROM users WHERE email=$1`,
      [email]
    );
    const user = rows[0];
    // نفس الرد سواء الحساب موجود أو لأ — عشان محدش يستخدم الـ endpoint ده
    // لمعرفة إيه الإيميلات المسجلة عندنا (user enumeration).
    if (!user || user.email_verified) return res.json({ ok: true });

    const remaining = cooldownRemainingSeconds(user);
    if (remaining > 0) {
      return res.status(429).json({
        error: `استنى ${Math.ceil(remaining / 60)} دقيقة قبل ما تطلب كود تاني`,
        cooldownRemaining: remaining,
      });
    }

    const code = generateVerificationCode();
    await query(
      `UPDATE users SET email_verify_code=$1, email_verify_expires=now() + interval '15 minutes' WHERE id=$2`,
      [code, user.id]
    );
    sendVerificationEmail(user.email, code).catch(() => {});
    res.json({ ok: true, cooldownRemaining: Math.ceil(RESEND_COOLDOWN_MS / 1000) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'الإيميل وكلمة المرور مطلوبين' });

  try {
    const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    if (!user.email_verified) {
      const remaining = cooldownRemainingSeconds(user);
      if (remaining > 0) {
        return res.status(403).json({
          error: 'الرجاء تفعيل بريدك الإلكتروني الأول',
          needsVerification: true,
          email: user.email,
          cooldownRemaining: remaining,
        });
      }
      // معدّاش 5 دقايق على آخر كود — نبعت كود جديد
      try {
        const code = generateVerificationCode();
        await query(
          `UPDATE users SET email_verify_code=$1, email_verify_expires=now() + interval '15 minutes' WHERE id=$2`,
          [code, user.id]
        );
        sendVerificationEmail(user.email, code).catch(() => {});
      } catch (_) {}
      return res.status(403).json({
        error: 'الرجاء تفعيل بريدك الإلكتروني الأول',
        needsVerification: true,
        email: user.email,
        cooldownRemaining: Math.ceil(RESEND_COOLDOWN_MS / 1000),
      });
    }

    if (user.role === 'driver' && user.driver_status !== 'active') {
      const msg =
        user.driver_status === 'suspended'
          ? 'تم رفض حسابك أو إيقافه. تواصل مع الإدارة.'
          : 'حسابك لسه تحت المراجعة من الإدارة، هيتفعل قريباً.';
      return res.status(403).json({ error: msg });
    }

    if (user.role === 'merchant') {
      const { rows: merchantRows } = await query(
        'SELECT status FROM merchants WHERE owner_user_id=$1 LIMIT 1',
        [user.id]
      );
      const merchantStatus = merchantRows[0]?.status;
      if (merchantStatus && merchantStatus !== 'approved') {
        const msg =
          merchantStatus === 'suspended'
            ? 'تم إيقاف حساب متجرك. تواصل مع الإدارة.'
            : 'حساب متجرك لسه تحت المراجعة من الإدارة، هيتفعل قريباً.';
        return res.status(403).json({ error: msg });
      }
    }

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

// أخطاء multer (حجم الملف / نوع الملف) بترجع رسائل واضحة بالعربي.
router.use(multerErrorHandler);

module.exports = { router, publicUser };
