// ─── Firebase Admin (FCM Push Notifications) ─────────────────────────────────
// بيشتغل بس لو المتغير FIREBASE_SERVICE_ACCOUNT موجود في البيئة —
// قيمته = محتوى ملف الـ Service Account JSON كله في سطر واحد (من Firebase Console).
// لو مش موجود، السيرفر يفضل شغال عادي من غير Push (الـ WebSocket شغال زي ما هو).

let admin = null;
let messaging = null;

try {
  admin = require('firebase-admin');
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(saJson)),
    });
    messaging = admin.messaging();
    console.log('[fcm] Firebase Admin initialized — push notifications ON');
  } else {
    console.log('[fcm] FIREBASE_SERVICE_ACCOUNT not set — push notifications OFF');
  }
} catch (e) {
  console.error('[fcm] init failed:', e.message);
}

// ابعت Push لمجموعة توكنات — ويرجع التوكنات الميتة عشان ننضفها من قاعدة البيانات
async function sendPushToTokens(tokens, { title, body, data }) {
  if (!messaging || !tokens || !tokens.length) return { removed: [] };
  const stringData = {};
  for (const [k, v] of Object.entries(data || {})) stringData[k] = String(v ?? '');
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      notification: { channelId: 'wasal_default', sound: 'default' },
    },
  });
  const removed = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        removed.push(tokens[i]);
      } else {
        console.error('[fcm] send error:', code, r.error && r.error.message);
      }
    }
  });
  return { removed, successCount: res.successCount };
}

module.exports = { sendPushToTokens, pushEnabled: () => !!messaging };
