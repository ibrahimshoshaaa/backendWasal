// ─── إرسال إيميلات (كود التحقق) عن طريق Gmail SMTP ─────────────────────────
// بنستخدم حساب Gmail عادي + App Password (مش باسورد الحساب نفسه). ده مجاني
// تمامًا، مفيهوش شرط دومين خاص، ومفيهوش تعقيد تحقق بالتليفون زي بعض الخدمات
// التانية.
//
// خطوات الإعداد (مرة واحدة بس):
//   1. فعّل "2-Step Verification" على حساب الـ Gmail بتاعك من
//      myaccount.google.com/security
//   2. اعمل App Password من myaccount.google.com/apppasswords (اختار Mail)
//   3. حط القيم دي في متغيرات البيئة (Railway → Variables):
//        GMAIL_USER=youraccount@gmail.com
//        GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx   (الـ 16 حرف بدون مسافات)
//        EMAIL_FROM=Wasal <youraccount@gmail.com>
//
// لو المتغيرات دي فاضية، السيرفر يشتغل عادي بس من غير إرسال إيميلات فعلي
// (زي نفس الباترن المتبع مع FIREBASE_SERVICE_ACCOUNT في config/firebase.js).
//
// ملحوظة: Gmail العادي بيسمح بحد أقصى تقريبًا 500 إيميل/يوم — أكتر من كافي
// لمرحلة إطلاق وصل الحالية. لو حجم الاستخدام كبر جدًا بعدين، وقتها ننقل
// لخدمة متخصصة (Brevo/Resend) بدومين خاص.

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
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,

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
    console.warn('[email] Gmail not configured — skipping send. Code was:', code);
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
