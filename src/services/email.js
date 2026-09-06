// ─── إرسال إيميلات (كود التحقق) عن طريق Brevo SMTP ─────────────────────────
// Brevo (اسمها القديم Sendinblue) عندها Free Tier بيوصل لـ 300 إيميل يوميًا،
// ومفيش داعي لدومين خاص أو DNS — بس تعمل حساب مجاني وتاخد بيانات SMTP.
//
// خطوات الإعداد (مرة واحدة بس):
//   1. اعمل حساب مجاني على https://www.brevo.com
//   2. من SMTP & API → SMTP اخد: login (إيميلك) + SMTP key (كلمة سر مولّدة)
//   3. حط القيم دي في متغيرات البيئة (Railway → Variables):
//        BREVO_SMTP_USER=... (الإيميل بتاع حساب Brevo)
//        BREVO_SMTP_PASS=... (SMTP key من الداشبورد، مش باسورد الحساب)
//        EMAIL_FROM=Wasal <no-reply@yourdomain.com>  (أو أي إيميل، حتى Gmail)
//
// لو المتغيرات دي فاضية، السيرفر يشتغل عادي بس من غير إرسال إيميلات فعلي
// (زي نفس الباترن المتبع مع FIREBASE_SERVICE_ACCOUNT في config/firebase.js).

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  nodemailer = null;
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!nodemailer) return null;
  if (!process.env.BREVO_SMTP_USER || !process.env.BREVO_SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.BREVO_SMTP_USER,
      pass: process.env.BREVO_SMTP_PASS,
    },
  });
  return transporter;
}

// يولّد كود من 6 أرقام (مش بيبدأ بصفر عشان يبان طبيعي، مش شرط تقني).
function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// بيرجع { sent: boolean } — أبدًا مش بيرمي error عشان فشل الإيميل ميوقفش
// عملية التسجيل نفسها (نفس فلسفة sendPushToTokens الموجودة في db.js).
async function sendVerificationEmail(toEmail, code) {
  const t = getTransporter();
  if (!t) {
    console.warn('[email] BREVO not configured — skipping send. Code was:', code);
    return { sent: false };
  }
  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM || 'Wasal <no-reply@wasal.app>',
      to: toEmail,
      subject: 'كود تفعيل حسابك في وصل',
      html: `
        <div dir="rtl" style="font-family: Cairo, Arial, sans-serif; text-align:center; padding:24px">
          <h2 style="color:#00C853">مرحبًا بك في وصل 👋</h2>
          <p>كود تفعيل بريدك الإلكتروني هو:</p>
          <div style="font-size:32px; font-weight:900; letter-spacing:6px; color:#212121; margin:16px 0">${code}</div>
          <p style="color:#757575; font-size:13px">الكود صالح لمدة 15 دقيقة. لو مطلبتش الكود ده، تجاهل الرسالة.</p>
        </div>
      `,
    });
    return { sent: true };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { sent: false };
  }
}

module.exports = { generateVerificationCode, sendVerificationEmail };
