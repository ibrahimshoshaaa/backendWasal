const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'customer',
      avatar_url TEXT,
      is_online BOOLEAN NOT NULL DEFAULT false,
      driver_lat DOUBLE PRECISION,
      driver_lng DOUBLE PRECISION,
      driver_status TEXT DEFAULT 'pending',
      national_id TEXT,
      vehicle_type TEXT,
      id_front_url TEXT,
      id_back_url TEXT,
      selfie_url TEXT
    );
  `);

  // ── أعمدة public_id لصور المستخدمين — Migration آمنة (IF NOT EXISTS) ─────────
  // بنحفظ public_id جنب كل رابط عشان نقدر نحذف الصورة القديمة من Cloudinary
  // لما المستخدم يستبدلها. الأعمدة اختيارية (nullable) ومش بتكسر أي endpoint قديم.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_public_id TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS id_front_public_id TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS id_back_public_id TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS selfie_public_id TEXT`);

  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      type TEXT DEFAULT 'main',
      sort_order INT DEFAULT 0
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id SERIAL PRIMARY KEY,
      owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category_id INT REFERENCES categories(id),
      image_url TEXT,
      address TEXT,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      tags JSONB,
      is_open BOOLEAN NOT NULL DEFAULT true,
      hours_note TEXT,
      cover_image_url TEXT,
      delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 20,
      delivery_time_minutes INT NOT NULL DEFAULT 30,
      min_order NUMERIC(10,2) NOT NULL DEFAULT 0
    );
  `);

  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS tags JSONB`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT true`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS hours_note TEXT`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS cover_image_url TEXT`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 20`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS delivery_time_minutes INT NOT NULL DEFAULT 30`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS min_order NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // ── أعمدة public_id للمتاجر (logo + cover) ───────────────────────────────────
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS image_public_id TEXT`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS cover_image_public_id TEXT`);

  // ── موقع المتجر (lat/lng) — عشان المندوب يقدر يفتح نقطة الاستلام على الخريطة ─
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`);

  // ── أوقات العمل والإغلاق التلقائي ──────────────────────────────────────────
  // working_hours: {"sun":{"open":"10:00","close":"23:00"}, "mon": null (يوم إجازة), ...}
  // closed_dates: ["2026-01-25", ...] إجازات/مناسبات بتاريخ محدد
  // break_start/break_end: فترة راحة يومية "HH:mm" (اختياري)
  // temp_closed_until: إغلاق مؤقت (مثلاً عند ضغط الطلبات) لحد وقت معين
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS working_hours JSONB`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS closed_dates JSONB`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS break_start TEXT`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS break_end TEXT`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS temp_closed_until TIMESTAMPTZ`);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      merchant_id INT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL DEFAULT 0,
      image_url TEXT,
      description TEXT,
      category TEXT,
      is_available BOOLEAN NOT NULL DEFAULT true
    );
  `);

  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT`);

  // ── عمود public_id لصور المنتجات ─────────────────────────────────────────────
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_public_id TEXT`);

  // ── إدارة الإضافات والاختيارات (مجموعات خيارات لكل منتج) ───────────────────
  // مثال: "أحجام المشروبات" (اختيار إجباري، واحد بس) أو "الإضافات المدفوعة"
  // (اختيارية، ممكن أكتر من واحدة). min_select/max_select بيتحكموا في القيود دي.
  await query(`
    CREATE TABLE IF NOT EXISTS option_groups (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      is_required BOOLEAN NOT NULL DEFAULT false,
      min_select INT NOT NULL DEFAULT 0,
      max_select INT NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS option_choices (
      id SERIAL PRIMARY KEY,
      group_id INT NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      extra_price NUMERIC(10,2) NOT NULL DEFAULT 0,
      is_available BOOLEAN NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 0
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS addresses (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      address_text TEXT NOT NULL,
      phone TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      is_default BOOLEAN NOT NULL DEFAULT false
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INT NOT NULL DEFAULT 1,
      UNIQUE(user_id, product_id)
    );
  `);

  // ── دعم الإضافات المختارة داخل السلة ─────────────────────────────────────────
  // منتج واحد ممكن يتضاف للسلة أكتر من مرة بإضافات مختلفة (مثلاً بيتزا وسط
  // وبيتزا كبيرة)، فبنستخدم options_hash عشان نميّز بين الأسطر بدل الاعتماد
  // على product_id لوحده. الـ UNIQUE القديم(user_id, product_id) بيتم استبداله.
  await query(`ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS selected_options JSONB`);
  await query(`ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS options_hash TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS unit_extra NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_user_id_product_id_key`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_unique_line ON cart_items(user_id, product_id, options_hash)`);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_number TEXT UNIQUE,
      customer_id INT NOT NULL REFERENCES users(id),
      merchant_id INT NOT NULL REFERENCES merchants(id),
      address_id INT REFERENCES addresses(id),
      driver_id INT REFERENCES users(id),
      items_json JSONB NOT NULL,
      subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
      delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
      total NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      notes TEXT,
      cancel_reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      accepted_at TIMESTAMPTZ,
      ready_at TIMESTAMPTZ,
      picked_up_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      rating INT,
      rating_comment TEXT
    );
  `);

  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS rating INT`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS rating_comment TEXT`);

  // ── تقييم المندوب — منفصل تماماً عن تقييم المتجر (rating) ────────────────────
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_rating INT`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_rating_comment TEXT`);

  // Generate order_number for old rows that don't have one
  await query(`
    UPDATE orders SET order_number = 'WS-' || LPAD(id::TEXT, 5, '0')
    WHERE order_number IS NULL
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT,
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ── توكنات FCM لأجهزة المستخدمين — بيتسجّل توكن لكل موبايل بعد تسجيل الدخول ─
  await query(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      platform TEXT DEFAULT 'android',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ── سجل تسجيل الأجهزة (append-only) ─────────────────────────────────────────
  // device_tokens بيحتفظ بآخر مستخدم للتوكن بس (ON CONFLICT بيستبدل user_id)،
  // فمش كافي لاكتشاف "نفس الجهاز استخدم حسابات متعددة". السجل ده بيحتفظ
  // بتاريخ كل ربط (user_id, device_token) من غير ما يتمسح.
  await query(`
    CREATE TABLE IF NOT EXISTS device_registrations (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_device_reg_token ON device_registrations(device_token)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_device_reg_user ON device_registrations(user_id)`);

  // ── نظام مكافحة الطلبات الوهمية — تنبيهات مخزّنة يراجعها الأدمن ─────────────
  await query(`
    CREATE TABLE IF NOT EXISTS fraud_flags (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INT NOT NULL,
      flag_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      details JSONB,
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      resolved BOOLEAN NOT NULL DEFAULT false,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_entity ON fraud_flags(entity_type, entity_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_resolved ON fraud_flags(resolved)`);

  // ── نظام الإعلانات داخل التطبيق ──────────────────────────────────────────────
  // link_type: 'none' (بانر بدون رابط) | 'merchant' | 'category' | 'external'
  // link_target_id بيستخدم مع merchant/category، وlink_url بيستخدم مع external.
  // region: null = كل المناطق، أو نص المنطقة المستهدفة (زي اسم المدينة/الحي).
  await query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      image_url TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'none',
      link_target_id INT,
      link_url TEXT,
      region TEXT,
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 0,
      views INT NOT NULL DEFAULT 0,
      clicks INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(is_active)`);

  await seed();
}

async function seed() {
  const { rows: catCount } = await query('SELECT COUNT(*)::int AS n FROM categories');
  if (catCount[0].n === 0) {
    await query(
      `INSERT INTO categories (name_ar, name_en, type, sort_order) VALUES
       ('مطاعم', 'Restaurants', 'main', 1),
       ('سوبر ماركت', 'Supermarket', 'main', 2),
       ('صيدليات', 'Pharmacies', 'main', 3)`
    );
  }

  const { rows: adminCount } = await query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
  if (adminCount[0].n === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await query(
      `INSERT INTO users (full_name, email, password_hash, role, driver_status)
       VALUES ('Admin', 'admin@wasal.app', $1, 'admin', 'active')`,
      [hash]
    );
    console.log('Seeded default admin -> admin@wasal.app / admin123');
  }
}

// Helper: create notification for a user (DB + FCM push لكل أجهزته)
async function createNotification(userId, { title, body, type, orderId }) {
  await query(
    `INSERT INTO notifications (user_id, title, body, type, order_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body, type || null, orderId || null]
  );

  // Push عبر FCM — Best effort: أي فشل هنا مش بيوقف الإشعار الأساسي
  try {
    const { sendPushToTokens } = require('./config/firebase');
    const { rows } = await query(
      'SELECT token FROM device_tokens WHERE user_id=$1', [userId]
    );
    const tokens = rows.map((r) => r.token);
    if (tokens.length) {
      const r = await sendPushToTokens(tokens, {
        title,
        body,
        data: { type: type || '', orderId: orderId || '' },
      });
      // نظّف التوكنات الميتة (المستخدم مسح التطبيق مثلاً)
      if (r.removed && r.removed.length) {
        await query('DELETE FROM device_tokens WHERE token = ANY($1)', [r.removed]);
      }
    }
  } catch (e) {
    console.error('[fcm] push failed:', e.message);
  }
}

module.exports = { pool, query, initSchema, createNotification };
