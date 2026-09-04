const express = require('express');
const { query, createNotification } = require('../db');
const router = express.Router();

// ─── helpers ────────────────────────────────────────────────────────────────────
async function getPrice(type) {
  const key = type === 'wassalni' ? 'wassalni_price' : 'wassal_li_price';
  const { rows } = await query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
  return parseFloat(rows[0]?.value || '50');
}

// إشعار via WebSocket (لو المستخدم متصل دلوقتي) + DB + FCM push حقيقي
// (نفس نمط notify() في orders.js) — ده اللي كان ناقص هنا واستبدلناه بدل
// الـ INSERT المباشر اللي مكنش بيبعت push فعلي.
function notify(req, userId, { title, body, type }) {
  createNotification(userId, { title, body, type }).catch(() => {});
  req.app.locals.sendToUser?.(userId, { type: 'notification', title, body, notifType: type });
}

async function notifyAdmins(req, title, body, type) {
  const { rows: admins } = await query(`SELECT id FROM users WHERE role='admin'`);
  for (const a of admins) notify(req, a.id, { title, body, type });
}

// ─── Customer ───────────────────────────────────────────────────────────────────

// GET /api/trips/settings — سعر الخدمتين
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN ('wassalni_price','wassal_li_price')`
    );
    const out = {};
    rows.forEach(r => { out[r.key] = parseFloat(r.value); });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل الإعدادات' });
  }
});

// POST /api/trips — طلب جديد (wassalni أو wassal_li)
router.post('/', async (req, res) => {
  try {
    const {
      type, pickup_address, pickup_lat, pickup_lng,
      dropoff_address, dropoff_lat, dropoff_lng, notes, preferred_gender,
    } = req.body || {};

    if (!type || !['wassalni', 'wassal_li'].includes(type))
      return res.status(400).json({ error: 'نوع الخدمة غير صحيح' });
    if (!pickup_address || !dropoff_address)
      return res.status(400).json({ error: 'عنوان الانطلاق والوجهة مطلوبان' });
    const finalGender = ['male', 'female'].includes(preferred_gender) ? preferred_gender : null;

    const price = await getPrice(type);

    const { rows } = await query(
      `INSERT INTO trips
         (customer_id, type, pickup_address, pickup_lat, pickup_lng,
          dropoff_address, dropoff_lat, dropoff_lng, notes, price, preferred_gender)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.userId, type, pickup_address, pickup_lat || null, pickup_lng || null,
       dropoff_address, dropoff_lat || null, dropoff_lng || null,
       notes || null, price, finalGender]
    );

    const label = type === 'wassalni' ? 'وصّلني' : 'وصّل لي';
    const genderNote = finalGender ? (finalGender === 'male' ? ' (سائق)' : ' (سائقة)') : '';
    await notifyAdmins(
      req,
      `طلب ${label} جديد${genderNote}`,
      `من: ${pickup_address} — إلى: ${dropoff_address}`,
      'trip'
    );

    // إشعار للسائقين المتاحين (أونلاين فعليًا) — لو العميل حدد نوع مندوب معين
    // (ولد/بنت)، الإشعار يروح بس للمناديب من نفس النوع ده.
    const genderFilter = finalGender ? ` AND gender=$1` : '';
    const { rows: drivers } = await query(
      `SELECT id FROM users WHERE role='driver' AND is_online=true${genderFilter}`,
      finalGender ? [finalGender] : []
    );
    const sendToUser = req.app.locals.sendToUser;
    for (const d of drivers) {
      notify(req, d.id, {
        title: `طلب ${label} جديد${genderNote}`,
        body: `من: ${pickup_address} — إلى: ${dropoff_address}`,
        type: 'trip',
      });
      if (sendToUser) sendToUser(d.id, { type: 'new_trip', trip: rows[0] });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('POST /trips error:', err);
    res.status(500).json({ error: 'تعذر إرسال الطلب' });
  }
});

// GET /api/trips/my — طلبات العميل
router.get('/my', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, d.full_name AS driver_name, d.phone AS driver_phone,
              d.driver_lat, d.driver_lng
       FROM trips t
       LEFT JOIN users d ON d.id = t.driver_id
       WHERE t.customer_id = $1
       ORDER BY t.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل طلباتك' });
  }
});

// GET /api/trips/:id — تفاصيل طلب
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, d.full_name AS driver_name, d.phone AS driver_phone,
              d.driver_lat, d.driver_lng
       FROM trips t
       LEFT JOIN users d ON d.id = t.driver_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل الطلب' });
  }
});

// POST /api/trips/:id/cancel — إلغاء طلب (العميل، pending فقط)
router.post('/:id/cancel', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE trips SET status='cancelled', updated_at=now()
       WHERE id=$1 AND customer_id=$2 AND status='pending' RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(400).json({ error: 'لا يمكن إلغاء الطلب' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر الإلغاء' });
  }
});

// ─── Driver ─────────────────────────────────────────────────────────────────────

// GET /api/trips/driver/available — الطلبات المتاحة للمندوب
// (بيشوف بس الرحلات اللي preferred_gender فيها فاضي، أو مطابق لنوعه هو)
router.get('/driver/available', async (req, res) => {
  try {
    const { rows: meRows } = await query(`SELECT gender FROM users WHERE id=$1`, [req.userId]);
    const myGender = meRows[0]?.gender || null;
    const { rows } = await query(
      `SELECT t.*, c.full_name AS customer_name, c.phone AS customer_phone
       FROM trips t
       JOIN users c ON c.id = t.customer_id
       WHERE t.status='pending'
         AND (t.preferred_gender IS NULL OR t.preferred_gender = $1)
       ORDER BY t.created_at DESC`,
      [myGender]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل الطلبات' });
  }
});

// GET /api/trips/driver/my-trips — طلبات المندوب
router.get('/driver/my-trips', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, c.full_name AS customer_name, c.phone AS customer_phone
       FROM trips t
       JOIN users c ON c.id = t.customer_id
       WHERE t.driver_id = $1
       ORDER BY t.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل طلباتك' });
  }
});

// POST /api/trips/:id/accept — المندوب يقبل الطلب
router.post('/:id/accept', async (req, res) => {
  try {
    // تحقق إن نوع المندوب مطابق لاختيار العميل (لو العميل حدد نوع معين)
    const { rows: meRows } = await query(`SELECT gender FROM users WHERE id=$1`, [req.userId]);
    const myGender = meRows[0]?.gender || null;
    const { rows } = await query(
      `UPDATE trips SET driver_id=$1, status='accepted', updated_at=now()
       WHERE id=$2 AND status='pending'
         AND (preferred_gender IS NULL OR preferred_gender=$3)
       RETURNING *`,
      [req.userId, req.params.id, myGender]
    );
    if (!rows[0]) return res.status(400).json({ error: 'الطلب غير متاح أو مخصص لنوع مندوب مختلف' });

    const trip = rows[0];
    req.app.locals.sendToUser?.(trip.customer_id, { type: 'trip_accepted', trip });
    notify(req, trip.customer_id, { title: 'تم قبول طلبك', body: 'المندوب في الطريق إليك', type: 'trip' });
    res.json(trip);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر قبول الطلب' });
  }
});

// POST /api/trips/:id/pickup — المندوب وصل لنقطة الانطلاق
router.post('/:id/pickup', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE trips SET status='picked_up', updated_at=now()
       WHERE id=$1 AND driver_id=$2 AND status='accepted' RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(400).json({ error: 'لا يمكن تحديث الحالة' });

    req.app.locals.sendToUser?.(rows[0].customer_id, { type: 'trip_picked_up', trip: rows[0] });
    notify(req, rows[0].customer_id, {
      title: 'المندوب في الطريق',
      body: 'المندوب وصل لنقطة الانطلاق وبدأ الرحلة',
      type: 'trip',
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر التحديث' });
  }
});

// POST /api/trips/:id/deliver — المندوب أتم التوصيل
router.post('/:id/deliver', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE trips SET status='delivered', updated_at=now()
       WHERE id=$1 AND driver_id=$2 AND status='picked_up' RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(400).json({ error: 'لا يمكن إتمام الطلب' });

    req.app.locals.sendToUser?.(rows[0].customer_id, { type: 'trip_delivered', trip: rows[0] });
    notify(req, rows[0].customer_id, { title: 'تم التوصيل', body: 'وصل طلبك بنجاح', type: 'trip' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر إتمام الطلب' });
  }
});

// ─── Admin ──────────────────────────────────────────────────────────────────────

// GET /api/trips/admin/all — كل الطلبات
router.get('/admin/all', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*,
              c.full_name AS customer_name, c.phone AS customer_phone,
              d.full_name AS driver_name,   d.phone AS driver_phone
       FROM trips t
       JOIN users c ON c.id = t.customer_id
       LEFT JOIN users d ON d.id = t.driver_id
       ORDER BY t.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل الطلبات' });
  }
});

// PUT /api/trips/admin/settings — تعديل الأسعار
router.put('/admin/settings', async (req, res) => {
  try {
    const { wassalni_price, wassal_li_price } = req.body || {};
    if (wassalni_price !== undefined)
      await query(`UPDATE app_settings SET value=$1 WHERE key='wassalni_price'`, [wassalni_price]);
    if (wassal_li_price !== undefined)
      await query(`UPDATE app_settings SET value=$1 WHERE key='wassal_li_price'`, [wassal_li_price]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحديث الأسعار' });
  }
});

module.exports = router;
