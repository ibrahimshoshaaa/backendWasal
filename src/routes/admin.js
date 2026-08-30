const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// ─── Users (read-only overview) ────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { rows } = await query(
    'SELECT id, full_name, email, phone, role, avatar_url, created_at FROM users ORDER BY id DESC'
  );
  res.json(rows);
});

// ─── Merchants ──────────────────────────────────────────────────────────────────
router.get('/merchants', async (req, res) => {
  const { rows } = await query(
    `SELECT m.*,
            u.email AS owner_email,
            u.phone AS owner_phone,
            c.name_ar AS category_name
     FROM merchants m
     LEFT JOIN users u ON u.id = m.owner_user_id
     LEFT JOIN categories c ON c.id = m.category_id
     ORDER BY m.id DESC`
  );
  res.json(rows);
});

// Admin creates a merchant account directly (owner user + store), skipping
// the normal registration review — the store is approved immediately.
router.post('/merchants', async (req, res) => {
  const {
    owner_name, email, password, phone,
    store_name, store_address, category_id,
    delivery_fee, delivery_time_minutes, min_order,
    lat, lng,
  } = req.body || {};

  if (!owner_name || !email || !password || !store_name) {
    return res.status(400).json({ error: 'اسم المالك والإيميل وكلمة المرور واسم المتجر مطلوبين' });
  }

  try {
    const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) return res.status(400).json({ error: 'الإيميل ده مستخدم قبل كده' });

    const hash = await bcrypt.hash(password, 10);
    const { rows: userRows } = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role)
       VALUES ($1,$2,$3,$4,'merchant') RETURNING *`,
      [owner_name, email, hash, phone || null]
    );
    const owner = userRows[0];

    const { rows: merchantRows } = await query(
      `INSERT INTO merchants
        (owner_user_id, name, address, phone, category_id, status,
         delivery_fee, delivery_time_minutes, min_order, lat, lng)
       VALUES ($1,$2,$3,$4,$5,'approved',$6,$7,$8,$9,$10) RETURNING *`,
      [
        owner.id, store_name, store_address || null, phone || null, category_id || null,
        delivery_fee || 20, delivery_time_minutes || 30, min_order || 0,
        lat || null, lng || null,
      ]
    );

    res.json(merchantRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل إنشاء المتجر' });
  }
});

// ─── Merchant menu management (admin can edit any store's products) ───────────
// ملحوظة: رفع الصور بيتم من نفس /api/upload (Cloudinary) زي أي مكان تاني في
// المشروع؛ هنا بس بنحفظ الرابط اللي راجع منه في المنتج.
router.get('/merchants/:id/products', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM products WHERE merchant_id=$1 ORDER BY id DESC', [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل المنتجات' });
  }
});

router.post('/merchants/:id/products', async (req, res) => {
  try {
    const { name, price, image_url, description, category } = req.body || {};
    if (!name || price === undefined) return res.status(400).json({ error: 'اسم المنتج والسعر مطلوبين' });
    const { rows } = await query(
      `INSERT INTO products (merchant_id, name, price, image_url, description, category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, price, image_url || null, description || null, category || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل إضافة المنتج' });
  }
});

router.put('/merchants/:id/products/:productId', async (req, res) => {
  try {
    const fields = ['name', 'price', 'image_url', 'description', 'category', 'is_available'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.params.productId, req.params.id);
    const { rows } = await query(
      `UPDATE products SET ${updates.join(', ')}
       WHERE id=$${params.length - 1} AND merchant_id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'المنتج غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث المنتج' });
  }
});

router.delete('/merchants/:id/products/:productId', async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM products WHERE id=$1 AND merchant_id=$2', [req.params.productId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'المنتج غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف المنتج' });
  }
});

// ─── Drivers ────────────────────────────────────────────────────────────────────
router.get('/drivers', async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.is_online, u.driver_status, u.driver_lat, u.driver_lng,
            u.national_id, u.vehicle_type, u.id_front_url, u.id_back_url, u.selfie_url,
            COALESCE(r.avg_rating, 0) AS avg_rating, COALESCE(r.rating_count, 0) AS rating_count
     FROM users u
     LEFT JOIN (
       SELECT driver_id, AVG(driver_rating) AS avg_rating, COUNT(driver_rating) AS rating_count
       FROM orders WHERE driver_rating IS NOT NULL GROUP BY driver_id
     ) r ON r.driver_id = u.id
     WHERE u.role='driver' ORDER BY u.id DESC`
  );
  res.json(rows);
});

// Admin creates a driver account directly — active immediately, no KYC
// documents required since the admin is vouching for them.
router.post('/drivers', async (req, res) => {
  const { full_name, email, password, phone, vehicle_type, national_id } = req.body || {};
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'الاسم والإيميل وكلمة المرور مطلوبين' });
  }

  try {
    const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) return res.status(400).json({ error: 'الإيميل ده مستخدم قبل كده' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role, vehicle_type, national_id, driver_status)
       VALUES ($1,$2,$3,$4,'driver',$5,$6,'active') RETURNING *`,
      [full_name, email, hash, phone || null, vehicle_type || null, national_id || null]
    );
    const { password_hash, ...safe } = rows[0];
    res.json(safe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل إنشاء حساب المندوب' });
  }
});

router.put('/drivers/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'الحالة مطلوبة' });
  const { rowCount } = await query(
    "UPDATE users SET driver_status=$1 WHERE id=$2 AND role='driver'",
    [status, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'المندوب غير موجود' });
  res.json({ ok: true });
});

// ─── Orders ─────────────────────────────────────────────────────────────────────
router.get('/orders', async (req, res) => {
  const { rows } = await query(
    `SELECT o.*,
            c.full_name AS customer_name,
            c.phone AS customer_phone,
            m.name AS merchant_name,
            m.phone AS merchant_phone,
            m.address AS merchant_address,
            m.lat AS merchant_lat,
            m.lng AS merchant_lng,
            a.address_text AS delivery_address,
            a.lat AS delivery_lat,
            a.lng AS delivery_lng,
            d.full_name AS driver_name,
            d.phone AS driver_phone
     FROM orders o
     LEFT JOIN users c ON c.id = o.customer_id
     LEFT JOIN merchants m ON m.id = o.merchant_id
     LEFT JOIN addresses a ON a.id = o.address_id
     LEFT JOIN users d ON d.id = o.driver_id
     ORDER BY o.created_at DESC`
  );
  res.json(rows);
});

router.put('/orders/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'الحالة مطلوبة' });
  const { rowCount } = await query('UPDATE orders SET status=$1 WHERE id=$2', [
    status,
    req.params.id,
  ]);
  if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ ok: true });
});

// ─── نظام مكافحة الطلبات الوهمية ─────────────────────────────────────────────
router.get('/fraud/flags', async (req, res) => {
  try {
    const resolved = req.query.resolved === 'true';
    const { rows } = await query(
      `SELECT f.*, u.full_name AS entity_name, u.phone AS entity_phone, u.email AS entity_email
       FROM fraud_flags f
       LEFT JOIN users u ON u.id = f.entity_id AND f.entity_type IN ('customer','driver')
       WHERE f.resolved=$1
       ORDER BY f.created_at DESC
       LIMIT 200`,
      [resolved]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل التنبيهات' });
  }
});

router.put('/fraud/flags/:id/resolve', async (req, res) => {
  try {
    const { rowCount } = await query(
      'UPDATE fraud_flags SET resolved=true, resolved_at=now() WHERE id=$1',
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'التنبيه غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث التنبيه' });
  }
});

// POST /api/admin/fraud/scan — فحص استباقي شامل (مثلاً معدل الإلغاء) لكل العملاء
router.post('/fraud/scan', async (req, res) => {
  try {
    const { checkCancelRate } = require('../services/fraud');
    const { rows: customers } = await query("SELECT id FROM users WHERE role='customer'");
    for (const c of customers) {
      await checkCancelRate(c.id).catch(() => {});
    }
    res.json({ ok: true, scanned: customers.length });
  } catch (err) {
    res.status(500).json({ error: 'فشل تشغيل الفحص' });
  }
});

// ─── إدارة الإضافات والاختيارات (الأدمن ممكن يعدّل منتجات أي متجر) ─────────────
router.get('/merchants/:id/products/:productId/options', async (req, res) => {
  try {
    const { rows: groups } = await query(
      'SELECT * FROM option_groups WHERE product_id=$1 ORDER BY sort_order, id',
      [req.params.productId]
    );
    const groupIds = groups.map((g) => g.id);
    let choices = [];
    if (groupIds.length) {
      const { rows } = await query(
        'SELECT * FROM option_choices WHERE group_id = ANY($1) ORDER BY sort_order, id',
        [groupIds]
      );
      choices = rows;
    }
    res.json(groups.map((g) => ({ ...g, choices: choices.filter((c) => c.group_id === g.id) })));
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الإضافات' });
  }
});

router.post('/merchants/:id/products/:productId/options', async (req, res) => {
  try {
    const { name, is_required, min_select, max_select, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'اسم المجموعة مطلوب' });
    const { rows } = await query(
      `INSERT INTO option_groups (product_id, name, is_required, min_select, max_select, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.productId, name, !!is_required, min_select ?? 0, max_select ?? 1, sort_order ?? 0]
    );
    res.json({ ...rows[0], choices: [] });
  } catch (err) {
    res.status(500).json({ error: 'فشل إضافة المجموعة' });
  }
});

router.put('/option-groups/:groupId', async (req, res) => {
  try {
    const fields = ['name', 'is_required', 'min_select', 'max_select', 'sort_order'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        updates.push(`${f}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.params.groupId);
    const { rows } = await query(
      `UPDATE option_groups SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'المجموعة غير موجودة' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث المجموعة' });
  }
});

router.delete('/option-groups/:groupId', async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM option_groups WHERE id=$1', [req.params.groupId]);
    if (!rowCount) return res.status(404).json({ error: 'المجموعة غير موجودة' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف المجموعة' });
  }
});

router.post('/option-groups/:groupId/choices', async (req, res) => {
  try {
    const { name, extra_price, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'اسم الاختيار مطلوب' });
    const { rows } = await query(
      `INSERT INTO option_choices (group_id, name, extra_price, sort_order)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.groupId, name, extra_price || 0, sort_order || 0]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل إضافة الاختيار' });
  }
});

router.put('/option-choices/:choiceId', async (req, res) => {
  try {
    const fields = ['name', 'extra_price', 'is_available', 'sort_order'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        updates.push(`${f}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.params.choiceId);
    const { rows } = await query(
      `UPDATE option_choices SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'الاختيار غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الاختيار' });
  }
});

router.delete('/option-choices/:choiceId', async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM option_choices WHERE id=$1', [req.params.choiceId]);
    if (!rowCount) return res.status(404).json({ error: 'الاختيار غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف الاختيار' });
  }
});

// ─── نظام الإعلانات داخل التطبيق ─────────────────────────────────────────────
router.get('/ads', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ads ORDER BY sort_order ASC, id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'تعذر تحميل الإعلانات' });
  }
});

router.post('/ads', async (req, res) => {
  try {
    const {
      title, image_url, link_type, link_target_id, link_url,
      region, start_at, end_at, is_active, sort_order, slide_duration,
    } = req.body || {};
    if (!title || !image_url) {
      return res.status(400).json({ error: 'العنوان والصورة مطلوبين' });
    }
    const { rows } = await query(
      `INSERT INTO ads (title, image_url, link_type, link_target_id, link_url,
                         region, start_at, end_at, is_active, sort_order, slide_duration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        title, image_url, link_type || 'none', link_target_id || null, link_url || null,
        region || null, start_at || null, end_at || null,
        is_active === undefined ? true : is_active, sort_order || 0,
        slide_duration || 5,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل إنشاء الإعلان' });
  }
});

router.put('/ads/:id', async (req, res) => {
  try {
    const fields = ['title', 'image_url', 'link_type', 'link_target_id', 'link_url',
                    'region', 'start_at', 'end_at', 'is_active', 'sort_order', 'slide_duration'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        updates.push(`${f}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE ads SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'الإعلان غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الإعلان' });
  }
});

router.delete('/ads/:id', async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM ads WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'الإعلان غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف الإعلان' });
  }
});

module.exports = router;
