const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ─── Customer ─────────────────────────────────────────────────────────────────

// POST /api/hataali — العميل يرسل طلب جديد
router.post('/', async (req, res) => {
  const { title, description, approx_price, source, delivery_address, phone } = req.body || {};
  if (!title) return res.status(400).json({ error: 'اسم الطلب مطلوب' });

  // جلب رسوم التوصيل من الإعدادات
  const { rows: feeRows } = await query(`SELECT value FROM app_settings WHERE key='hataali_fee'`);
  const fee = parseFloat(feeRows[0]?.value || '35');

  const { rows } = await query(
    `INSERT INTO hataali_orders
       (customer_id, title, description, approx_price, source, delivery_fee, delivery_address, phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.userId, title, description || null, approx_price || null,
     source || null, fee, delivery_address || null, phone || null]
  );

  // إشعار للأدمن
  const { rows: admins } = await query(`SELECT id FROM users WHERE role='admin'`);
  const sendToUser = req.app.locals.sendToUser;
  for (const a of admins) {
    sendToUser(a.id, { type: 'notification', message: `طلب هاتهالي جديد: ${title}` });
    await query(
      `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,'hataali')`,
      [a.id, 'طلب هاتهالي جديد', `${'عميل'} طلب: ${title}`]
    );
  }

  res.json(rows[0]);
});

// GET /api/hataali/my — طلبات العميل
router.get('/my', async (req, res) => {
  const { rows } = await query(
    `SELECT h.*, d.full_name AS driver_name, d.phone AS driver_phone
     FROM hataali_orders h
     LEFT JOIN users d ON d.id = h.driver_id
     WHERE h.customer_id = $1
     ORDER BY h.created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

// ─── Driver ───────────────────────────────────────────────────────────────────

// GET /api/hataali/available — الطلبات المتاحة للمناديب (وافق عليها الأدمن)
router.get('/available', async (req, res) => {
  if (req.userRole !== 'driver') return res.status(403).json({ error: 'للمناديب فقط' });
  const { rows } = await query(
    `SELECT h.*, u.full_name AS customer_name
     FROM hataali_orders h
     JOIN users u ON u.id = h.customer_id
     WHERE h.status = 'approved' AND h.driver_id IS NULL
     ORDER BY h.created_at ASC`
  );
  res.json(rows);
});

// POST /api/hataali/:id/accept — المندوب يقبل الطلب
router.post('/:id/accept', async (req, res) => {
  if (req.userRole !== 'driver') return res.status(403).json({ error: 'للمناديب فقط' });

  const { rows } = await query(
    `UPDATE hataali_orders
     SET driver_id=$1, status='picked_up', updated_at=now()
     WHERE id=$2 AND status='approved' AND driver_id IS NULL
     RETURNING *`,
    [req.userId, req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: 'الطلب غير متاح أو تم أخذه من مندوب آخر' });

  // إشعار للعميل
  const order = rows[0];
  const sendToUser = req.app.locals.sendToUser;
  sendToUser(order.customer_id, { type: 'notification', message: 'المندوب في الطريق لجلب طلبك!' });
  await query(
    `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,'hataali')`,
    [order.customer_id, 'طلب هاتهالي', 'المندوب قبل طلبك وفي الطريق!']
  );

  res.json(rows[0]);
});

// POST /api/hataali/:id/deliver — المندوب يسلّم الطلب
router.post('/:id/deliver', async (req, res) => {
  if (req.userRole !== 'driver') return res.status(403).json({ error: 'للمناديب فقط' });

  const { rows } = await query(
    `UPDATE hataali_orders
     SET status='delivered', updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status='picked_up'
     RETURNING *`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'الطلب مش موجود' });

  const order = rows[0];
  const sendToUser = req.app.locals.sendToUser;
  sendToUser(order.customer_id, { type: 'notification', message: 'تم توصيل طلبك!' });
  await query(
    `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,'hataali')`,
    [order.customer_id, 'تم التوصيل', 'تم توصيل طلب هاتهالي بنجاح']
  );

  res.json(rows[0]);
});

// ─── Admin ────────────────────────────────────────────────────────────────────

// GET /api/hataali/admin/all — كل الطلبات للأدمن
router.get('/admin/all', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'للأدمن فقط' });
  const { rows } = await query(
    `SELECT h.*,
            c.full_name AS customer_name, c.phone AS customer_phone,
            d.full_name AS driver_name,   d.phone AS driver_phone
     FROM hataali_orders h
     JOIN  users c ON c.id = h.customer_id
     LEFT JOIN users d ON d.id = h.driver_id
     ORDER BY h.created_at DESC`
  );
  res.json(rows);
});

// PUT /api/hataali/admin/:id — الأدمن يوافق أو يرفض أو يعدّل
router.put('/admin/:id', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'للأدمن فقط' });
  const { status, delivery_fee, admin_note } = req.body || {};
  const allowed = ['approved', 'rejected'];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  const updates = []; const params = [];
  if (status)       { params.push(status);       updates.push(`status=$${params.length}`); }
  if (delivery_fee) { params.push(delivery_fee);  updates.push(`delivery_fee=$${params.length}`); }
  if (admin_note !== undefined) { params.push(admin_note); updates.push(`admin_note=$${params.length}`); }
  updates.push(`updated_at=now()`);
  params.push(req.params.id);

  const { rows } = await query(
    `UPDATE hataali_orders SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

  const order = rows[0];
  const sendToUser = req.app.locals.sendToUser;

  if (status === 'approved') {
    sendToUser(order.customer_id, { type: 'notification', message: 'تمت الموافقة على طلب هاتهالي!' });
    await query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,$2,$3,'hataali')`,
      [order.customer_id, 'تمت الموافقة', `تمت الموافقة على طلبك "${order.title}" — رسوم التوصيل: ${order.delivery_fee} جنيه`]);
  } else if (status === 'rejected') {
    sendToUser(order.customer_id, { type: 'notification', message: 'تم رفض طلب هاتهالي' });
    await query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,$2,$3,'hataali')`,
      [order.customer_id, 'تم رفض الطلب', admin_note || 'تم رفض طلب هاتهالي']);
  }

  res.json(rows[0]);
});

// GET /api/hataali/settings — رسوم التوصيل الافتراضية
router.get('/settings', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'للأدمن فقط' });
  const { rows } = await query(`SELECT value FROM app_settings WHERE key='hataali_fee'`);
  res.json({ hataali_fee: parseFloat(rows[0]?.value || '35') });
});

// PUT /api/hataali/settings — الأدمن يعدّل رسوم التوصيل
router.put('/settings', async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'للأدمن فقط' });
  const { hataali_fee } = req.body || {};
  if (!hataali_fee || isNaN(hataali_fee)) return res.status(400).json({ error: 'رسوم غير صحيحة' });
  await query(`INSERT INTO app_settings (key,value) VALUES ('hataali_fee',$1)
               ON CONFLICT (key) DO UPDATE SET value=$1`, [String(hataali_fee)]);
  res.json({ hataali_fee: parseFloat(hataali_fee) });
});

module.exports = router;
