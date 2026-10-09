const express = require('express');
const { query, createNotification } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function notify(req, userId, payload) {
  createNotification(userId, payload).catch(() => {});
  req.app.locals.sendToUser?.(userId, { ...payload, notifType: payload.type, type: 'notification' });
}

router.get('/orders', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*,
              m.name AS merchant_name,
              m.address AS merchant_address,
              m.lat AS merchant_lat,
              m.lng AS merchant_lng,
              u.full_name AS customer_name,
              u.phone AS customer_phone,
              a.address_text AS delivery_address,
              a.lat AS delivery_lat,
              a.lng AS delivery_lng
       FROM orders o
       LEFT JOIN merchants m ON m.id = o.merchant_id
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE (
           -- طلبات جاهزة بدون مندوب: تظهر للمندوب لو المتجر مش مربوط، أو هو واحد من المناديب المربوطين بيه
           (o.status='ready' AND o.driver_id IS NULL AND (
             m.linked_driver_ids IS NULL OR m.linked_driver_ids = '[]'::jsonb
             OR m.linked_driver_ids @> to_jsonb($1::int)
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.linked_driver_ids,'[]'::jsonb)) t(d) WHERE t.d::int=$1)
           ))
          OR (o.driver_id=$1 AND o.status IN ('ready','picked_up'))
       )
       ORDER BY o.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الطلبات' });
  }
});

// سجل التوصيل — بيجمع طلبات المتاجر (orders) وطلبات هاتهالي (hataali_orders)
// اللي المندوب سلّمها، عشان النوعين يظهروا مع بعض بترتيب واحد حسب وقت التسليم.
router.get('/orders/history', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM (
         SELECT o.id, o.order_number, o.status, o.delivery_fee, o.delivered_at,
                m.name AS merchant_name,
                m.address AS merchant_address,
                m.lat AS merchant_lat,
                m.lng AS merchant_lng,
                u.full_name AS customer_name,
                u.phone AS customer_phone,
                a.address_text AS delivery_address,
                a.lat AS delivery_lat,
                a.lng AS delivery_lng,
                'store' AS order_type
         FROM orders o
         LEFT JOIN merchants m ON m.id = o.merchant_id
         LEFT JOIN users u ON u.id = o.customer_id
         LEFT JOIN addresses a ON a.id = o.address_id
         WHERE o.driver_id=$1 AND o.status='delivered'

         UNION ALL

         SELECT h.id, ('HT-' || h.id::text) AS order_number, h.status, h.delivery_fee, h.updated_at AS delivered_at,
                h.title AS merchant_name,
                h.source AS merchant_address,
                NULL::double precision AS merchant_lat,
                NULL::double precision AS merchant_lng,
                c.full_name AS customer_name,
                c.phone AS customer_phone,
                h.delivery_address AS delivery_address,
                h.lat AS delivery_lat,
                h.lng AS delivery_lng,
                'hataali' AS order_type
         FROM hataali_orders h
         LEFT JOIN users c ON c.id = h.customer_id
         WHERE h.driver_id=$1 AND h.status='delivered'
       ) combined
       ORDER BY delivered_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /driver/orders/history error:', err);
    res.status(500).json({ error: 'فشل تحميل سجل التوصيل' });
  }
});

router.get('/stats', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE (delivered_at AT TIME ZONE 'Africa/Cairo')::date = (now() AT TIME ZONE 'Africa/Cairo')::date) AS today_count,
         COALESCE(SUM(delivery_fee) FILTER (WHERE (delivered_at AT TIME ZONE 'Africa/Cairo')::date = (now() AT TIME ZONE 'Africa/Cairo')::date), 0) AS today_earnings,
         COUNT(*) FILTER (WHERE delivered_at >= now() - interval '7 days') AS week_count,
         COALESCE(SUM(delivery_fee) FILTER (WHERE delivered_at >= now() - interval '7 days'), 0) AS week_earnings,
         COUNT(*) AS total_count,
         COALESCE(SUM(delivery_fee), 0) AS total_earnings
       FROM (
         SELECT delivered_at, delivery_fee FROM orders WHERE driver_id=$1 AND status='delivered'
         UNION ALL
         SELECT updated_at AS delivered_at, delivery_fee FROM hataali_orders WHERE driver_id=$1 AND status='delivered'
         UNION ALL
         SELECT updated_at AS delivered_at, price AS delivery_fee FROM trips WHERE driver_id=$1 AND status='delivered'
       ) deliveries`,
      [req.userId]
    );
    const r = rows[0];
    res.json({
      today: { count: Number(r.today_count), earnings: Number(r.today_earnings) },
      week: { count: Number(r.week_count), earnings: Number(r.week_earnings) },
      total: { count: Number(r.total_count), earnings: Number(r.total_earnings) },
    });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الإحصائيات' });
  }
});

// ─── تقييم المندوب — ظاهر للمندوب نفسه عشان يعرف مستوى تعامله مع العملاء ────
router.get('/rating', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT COALESCE(AVG(driver_rating), 0) AS avg_rating, COUNT(driver_rating) AS rating_count
       FROM orders WHERE driver_id=$1 AND driver_rating IS NOT NULL`,
      [req.userId]
    );
    res.json({
      avg_rating: Number(rows[0].avg_rating),
      rating_count: Number(rows[0].rating_count),
    });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل التقييم' });
  }
});

// آخر التقييمات مع تعليقات العملاء — يساعد المندوب يعرف نقاط القوة/الضعف
router.get('/ratings', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, order_number, driver_rating, driver_rating_comment, delivered_at
       FROM orders WHERE driver_id=$1 AND driver_rating IS NOT NULL
       ORDER BY delivered_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل التقييمات' });
  }
});

router.get('/profile', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, full_name, email, phone, avatar_url, national_id, vehicle_type,
              driver_status, is_online
       FROM users WHERE id=$1`,
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل البيانات' });
  }
});

router.put('/profile', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const fields = ['full_name', 'phone', 'vehicle_type', 'avatar_url'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.userId);
    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id=$${params.length}
       RETURNING id, full_name, email, phone, avatar_url, national_id, vehicle_type, driver_status, is_online`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث البيانات' });
  }
});

router.get('/status', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query('SELECT is_online FROM users WHERE id=$1', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ is_online: rows[0].is_online });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الحالة' });
  }
});

router.put('/status', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { is_online } = req.body || {};
    await query('UPDATE users SET is_online=$1 WHERE id=$2', [!!is_online, req.userId]);
    res.json({ ok: true, is_online: !!is_online });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الحالة' });
  }
});

router.put('/location', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'الإحداثيات مطلوبة' });
    }
    const now = Date.now();
    const recordedAt = req.body.recorded_at == null ? new Date(now) : new Date(req.body.recorded_at);
    if (!Number.isFinite(recordedAt.getTime()) || recordedAt.getTime() > now + 60000 || recordedAt.getTime() < now - 86400000) {
      return res.status(400).json({error: 'وقت تحديث الموقع غير صحيح'});
    }
    const {rows: locations} = await query(
      `UPDATE users SET driver_lat=$1, driver_lng=$2, driver_location_updated_at=$4
       WHERE id=$3 AND (driver_location_updated_at IS NULL OR driver_location_updated_at <= $4)
       RETURNING driver_location_updated_at`, [lat, lng, req.userId, new Date(Math.min(recordedAt.getTime(), now))]);
    if (!locations.length) return res.json({ok: true, ignored: true});

    // Push live location to the customer of any active job — سواء كان
    // طلب من متجر (orders) أو طلب هاتهالي (hataali_orders).
    const sendToUser = req.app.locals.sendToUser;
    const { rows: jobs } = await query(
      `SELECT id, customer_id, 'store' AS service FROM orders WHERE driver_id=$1 AND status='picked_up'
       UNION ALL SELECT id, customer_id, 'hataali' AS service FROM hataali_orders WHERE driver_id=$1 AND status='picked_up'
       UNION ALL SELECT id, customer_id, 'trip' AS service FROM trips WHERE driver_id=$1 AND status IN ('accepted','picked_up')`,
      [req.userId]);
    for (const job of jobs) sendToUser?.(job.customer_id, {
      type: 'driver_location', lat, lng, updatedAt: locations[0].driver_location_updated_at, service: job.service, orderId: job.id, driverId: req.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الموقع' });
  }
});

router.put('/orders/:id/accept', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    // كود تحقق مكوّن من 4 أرقام يتولد وقت الاستلام ويتبعت للعميل، والمندوب
    // هيحتاجه يدخله وقت التسليم عشان يقفل الطلب.
    const otp = String(require('crypto').randomInt(1000, 10000));

    const { rowCount, rows } = await query(
      `UPDATE orders o SET status='picked_up', driver_id=$1, picked_up_at=now(), delivery_otp=$3
       FROM merchants m
       WHERE o.id=$2 AND o.status='ready'
         AND m.id = o.merchant_id
         AND (o.driver_id=$1 OR
              (o.driver_id IS NULL AND
               (m.linked_driver_ids IS NULL OR m.linked_driver_ids = '[]'::jsonb
                OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.linked_driver_ids,'[]'::jsonb)) t(d) WHERE t.d::int=$1))))
       RETURNING o.*`,
      [req.userId, req.params.id, otp]
    );
    if (!rowCount) return res.status(404).json({ error: 'الطلب غير متاح' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: 'المندوب في الطريق 🛵',
      body: `طلبك رقم ${order.order_number} مع المندوب وفي طريقه إليك. كود التسليم: ${otp}`,
      type: 'order_picked_up',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل استلام الطلب' });
  }
});

router.put('/orders/:id/deliver', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const otp = (req.body?.otp ?? '').toString().trim();
    if (!otp) return res.status(400).json({ error: 'أدخل كود التسليم اللي مع العميل' });

    const { rows: check } = await query(
      `SELECT delivery_otp FROM orders WHERE id=$1 AND driver_id=$2 AND status='picked_up'`,
      [req.params.id, req.userId]
    );
    if (!check.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (!check[0].delivery_otp || check[0].delivery_otp !== otp) {
      return res.status(400).json({ error: 'كود التسليم غير صحيح' });
    }

    const { rowCount, rows } = await query(
      `UPDATE orders SET status='delivered', delivered_at=now()
       WHERE id=$1 AND driver_id=$2 AND status='picked_up' RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: 'تم توصيل طلبك! 🎉',
      body: `تم توصيل طلبك رقم ${order.order_number}. بالهناء والشفاء!`,
      type: 'order_delivered',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تأكيد التوصيل' });
  }
});

// رسالة جاهزة من المندوب للعميل — بتتبعت كإشعار داخل التطبيق مش SMS حقيقي.
router.post('/orders/:id/message', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const text = (req.body?.text ?? '').toString().trim();
    if (!text) return res.status(400).json({ error: 'الرسالة فارغة' });
    if (text.length > 200) return res.status(400).json({ error: 'الرسالة طويلة جداً' });

    const { rows } = await query(
      `SELECT id, order_number, customer_id FROM orders WHERE id=$1 AND driver_id=$2`,
      [req.params.id, req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: `رسالة من المندوب — طلب ${order.order_number}`,
      body: text,
      type: 'driver_message',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل إرسال الرسالة' });
  }
});

module.exports = router;

