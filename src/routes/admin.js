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
    `SELECT id, full_name, email, phone, is_online, driver_status, driver_lat, driver_lng,
            national_id, vehicle_type, id_front_url, id_back_url, selfie_url
     FROM users WHERE role='driver' ORDER BY id DESC`
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

module.exports = router;
