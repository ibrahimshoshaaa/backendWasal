const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ─── helpers ────────────────────────────────────────────────────────────────────
async function getPrice(type) {
  const key = type === 'wassalni' ? 'wassalni_price' : 'wassal_li_price';
  const { rows } = await query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
  return parseFloat(rows[0]?.value || '50');
}

async function notifyAdmins(app, title, body, type) {
  const { rows: admins } = await query(`SELECT id FROM users WHERE role='admin'`);
  const sendToUser = app.locals.sendToUser;
  for (const a of admins) {
    if (sendToUser) sendToUser(a.id, { type: 'notification', message: title });
    await query(
      `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,$4)`,
      [a.id, title, body, type]
    );
  }
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
      dropoff_address, dropoff_lat, dropoff_lng, notes,
    } = req.body || {};

    if (!type || !['wassalni', 'wassal_li'].includes(type))
      return res.status(400).json({ error: 'نوع الخدمة غير صحيح' });
    if (!pickup_address || !dropoff_address)
      return res.status(400).json({ error: 'عنوان الانطلاق والوجهة مطلوبان' });

    const price = await getPrice(type);

    const { rows } = await query(
      `INSERT INTO trips
         (customer_id, type, pickup_address, pickup_lat, pickup_lng,
          dropoff_address, dropoff_lat, dropoff_lng, notes, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.userId, type, pickup_address, pickup_lat || null, pickup_lng || null,
       dropoff_address, dropoff_lat || null, dropoff_lng || null,
       notes || null, price]
    );

    const label = type === 'wassalni' ? 'وصّلني' : 'وصّل لي';
    await notifyAdmins(
      req.app,
      `طلب ${label} جديد`,
      `من: ${pickup_address} — إلى: ${dropoff_address}`,
      'trip'
    );

    // إشعار للسائقين المتاحين
    const { rows: drivers } = await query(
      `SELECT id FROM users WHERE role='driver' AND driver_status='active'`
    );
    const sendToUser = req.app.locals.sendToUser;
    for (const d of drivers) {
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
router.get('/driver/available', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, c.full_name AS customer_name, c.phone AS customer_phone
       FROM trips t
       JOIN users c ON c.id = t.customer_id
       WHERE t.status='pending'
       ORDER BY t.created_at DESC`
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
    const { rows } = await query(
      `UPDATE trips SET driver_id=$1, status='accepted', updated_at=now()
       WHERE id=$2 AND status='pending' RETURNING *`,
      [req.userId, req.params.id]
    );
    if (!rows[0]) return res.status(400).json({ error: 'الطلب غير متاح' });

    const trip = rows[0];
    const sendToUser = req.app.locals.sendToUser;
    if (sendToUser) sendToUser(trip.customer_id, { type: 'trip_accepted', trip });
    await query(
      `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,'trip')`,
      [trip.customer_id, 'تم قبول طلبك', 'المندوب في الطريق إليك']
    );
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

    const sendToUser = req.app.locals.sendToUser;
    if (sendToUser) sendToUser(rows[0].customer_id, { type: 'trip_picked_up', trip: rows[0] });
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

    const sendToUser = req.app.locals.sendToUser;
    if (sendToUser) sendToUser(rows[0].customer_id, { type: 'trip_delivered', trip: rows[0] });
    await query(
      `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,'trip')`,
      [rows[0].customer_id, 'تم التوصيل', 'وصل طلبك بنجاح']
    );
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
