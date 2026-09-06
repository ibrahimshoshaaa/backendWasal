// ─── إرسال إيميلات (كود التحقق) عن طريق SendGrid HTTP API ─────────────────────
// جربنا الأول SMTP (Gmail وBrevo) وفشلوا الاتنين بنفس السبب: Railway بيمنع
// اتصالات SMTP الخارجة (بورت 587/465) بشكل افتراضي لمنع السبام — المشكلة في
// المنصة نفسها مش في بيانات أي حساب. الحل: خدمة بتبعت عن طريق HTTP API عادي
// (بورت 443 زي أي طلب ويب)، ودي مش بتتحجب.
//
// خطوات الإعداد (مرة واحدة بس):
//   1. اعمل حساب مجاني على https://sendgrid.com (Free: 100 إيميل/يوم للأبد)
//   2. من Settings → Sender Authentication → Verify a Single Sender:
//      سجّل إيميلك (وحّط نفسه في SENDGRID_FROM_EMAIL تحت) ودوس على رابط
//      التأكيد اللي هيوصلك
//   3. من Settings → API Keys → Create API Key (صلاحية Mail Send تكفي)
//   4. حط القيم دي في متغيرات البيئة (Railway → Variables):
//        SENDGRID_API_KEY=SG.xxxxxxxx
//        SENDGRID_FROM_EMAIL=wasalapplication@gmail.com   (نفس الإيميل اللي فعّلته كـ Single Sender)
//        EMAIL_FROM=Wasal <wasalapplication@gmail.com>
//
// لو المتغيرات دي فاضية، السيرفر يشتغل عادي بس من غير إرسال إيميلات فعلي
// (زي نفس الباترن المتبع مع FIREBASE_SERVICE_ACCOUNT في config/firebase.js).

let sgMail;
try {
  sgMail = require('@sendgrid/mail');
} catch (_) {
  sgMail = null;
}

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!sgMail || !process.env.SENDGRID_API_KEY) return false;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  configured = true;
  return true;
}

// يولّد كود من 6 أرقام (مش بيبدأ بصفر عشان يبان طبيعي، مش شرط تقني).
function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// بيرجع { sent: boolean } — أبدًا مش بيرمي error عشان فشل الإيميل ميوقفش
// عملية التسجيل نفسها (نفس فلسفة sendPushToTokens الموجودة في db.js).
async function sendVerificationEmail(toEmail, code) {
  if (!ensureConfigured()) {
    console.warn('[email] SendGrid not configured — skipping send. Code was:', code);
    return { sent: false };
  }
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.GMAIL_USER;
  if (!fromEmail) {
    console.warn('[email] SENDGRID_FROM_EMAIL not set — skipping send. Code was:', code);
    return { sent: false };
  }
  try {
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'Wasal' },
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
    const detail = e?.response?.body?.errors?.[0]?.message || e.message;
    console.error('[email] send failed:', detail);
    return { sent: false };
  }
}

module.exports = { generateVerificationCode, sendVerificationEmail };
