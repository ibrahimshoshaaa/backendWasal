// ─── إرسال إيميلات (كود التحقق) — SendGrid أساسي + Mailjet احتياطي ─────────────
// جربنا الأول SMTP (Gmail وBrevo) وفشلوا الاتنين بنفس السبب: Railway بيمنع
// اتصالات SMTP الخارجة (بورت 587/465) لمنع السبام. الحل: خدمات بتبعت عن طريق
// HTTP API عادي (بورت 443)، ودي مش بتتحجب.
//
// ليه في خدمتين مش واحدة؟ كل خدمة عندها حد يومي مجاني منفصل (SendGrid: 100/يوم،
// Mailjet: 200/يوم). لو SendGrid وصل لحده اليومي، الكود يحوّل تلقائيًا يبعت
// بـ Mailjet بدل ما يوقف الإرسال خالص. ده قانوني ومش مخالف لشروط أي خدمة —
// عكس عمل حسابات مكررة على نفس الخدمة عشان تلف على الحد بتاعها.
//
// خطوات الإعداد:
//   SendGrid (أساسي):
//     1. sendgrid.com → Free (100 إيميل/يوم للأبد)
//     2. Settings → Sender Authentication → Verify a Single Sender
//     3. Settings → API Keys → Create API Key (صلاحية Mail Send)
//        SENDGRID_API_KEY=SG.xxxxxxxx
//        SENDGRID_FROM_EMAIL=wasalapplication@gmail.com
//
//   Mailjet (احتياطي):
//     1. mailjet.com → Free (200 إيميل/يوم)
//     2. Senders & Domains → Add a sender address → فعّله من الإيميل
//     3. Account Settings → REST API → API Key Management
//        MAILJET_API_KEY=xxxxxxxx
//        MAILJET_SECRET_KEY=xxxxxxxx
//        MAILJET_FROM_EMAIL=<نفس الإيميل اللي فعّلته في Mailjet>
//
// أي خدمة ناقصة متغيراتها، الكود ببساطة يتخطاها وينتقل للتانية (أو يتخطى
// الإرسال كله لو الاتنين مش متظبطين، من غير ما يوقف عملية التسجيل).

let sgMail;
try {
  sgMail = require('@sendgrid/mail');
} catch (_) {
  sgMail = null;
}
const https = require('https');

let sgConfigured = false;
function ensureSendGrid() {
  if (sgConfigured) return true;
  if (!sgMail || !process.env.SENDGRID_API_KEY) return false;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  sgConfigured = true;
  return true;
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function buildHtml(code) {
  return `
    <div dir="rtl" style="font-family: Cairo, Arial, sans-serif; text-align:center; padding:24px">
      <h2 style="color:#00C853">مرحبًا بك في وصل 👋</h2>
      <p>كود تفعيل بريدك الإلكتروني هو:</p>
      <div style="font-size:32px; font-weight:900; letter-spacing:6px; color:#212121; margin:16px 0">${code}</div>
      <p style="color:#757575; font-size:13px">الكود صالح لمدة 15 دقيقة. لو مطلبتش الكود ده، تجاهل الرسالة.</p>
    </div>
  `;
}

// نسخة نصية عادية (Plain Text) بجانب الـ HTML — رسائل فيها الاتنين مع بعض
// بتقلل مؤشرات السبام فيلترز، وده معيار أساسي في أي إيميل تحقق احترافي.
function buildText(code) {
  return `مرحبًا بك في وصل\n\nكود تفعيل بريدك الإلكتروني هو: ${code}\n\nالكود صالح لمدة 15 دقيقة. لو مطلبتش الكود ده، تجاهل الرسالة.`;
}

async function trySendGrid(toEmail, code) {
  if (!ensureSendGrid()) return false;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) return false;
  try {
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'Wasal' },
      subject: 'كود تفعيل حسابك في وصل',
      text: buildText(code),
      html: buildHtml(code),
    });
    return true;
  } catch (e) {
    const detail = e?.response?.body?.errors?.[0]?.message || e.message;
    console.error('[email] SendGrid failed, will try fallback:', detail);
    return false;
  }
}

// Mailjet Send API v3.1 — بعت عن طريق https المدمجة عشان منضيفش SDK زيادة.
function tryMailjet(toEmail, code) {
  return new Promise((resolve) => {
    const apiKey = process.env.MAILJET_API_KEY;
    const secretKey = process.env.MAILJET_SECRET_KEY;
    const fromEmail = process.env.MAILJET_FROM_EMAIL;
    if (!apiKey || !secretKey || !fromEmail) return resolve(false);

    const payload = JSON.stringify({
      Messages: [
        {
          From: { Email: fromEmail, Name: 'Wasal' },
          To: [{ Email: toEmail }],
          Subject: 'كود تفعيل حسابك في وصل',
          TextPart: buildText(code),
          HTMLPart: buildHtml(code),
        },
      ],
    });

    const req = https.request(
      {
        hostname: 'api.mailjet.com',
        path: '/v3.1/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64'),
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else {
            console.error('[email] Mailjet failed:', res.statusCode, body);
            resolve(false);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.error('[email] Mailjet request error:', e.message);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

// بيرجع { sent: boolean } — أبدًا مش بيرمي error عشان فشل الإيميل ميوقفش
// عملية التسجيل نفسها.
async function sendVerificationEmail(toEmail, code) {
  if (await trySendGrid(toEmail, code)) {
    console.log('[email] sent via SendGrid ✔');
    return { sent: true, via: 'sendgrid' };
  }
  if (await tryMailjet(toEmail, code)) {
    console.log('[email] sent via Mailjet ✔ (SendGrid fallback triggered)');
    return { sent: true, via: 'mailjet' };
  }
  console.warn('[email] both providers failed or unconfigured — skipping send. Code was:', code);
  return { sent: false };
}

module.exports = { generateVerificationCode, sendVerificationEmail };
