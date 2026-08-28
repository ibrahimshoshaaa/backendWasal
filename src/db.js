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

// Helper: create notification for a user
async function createNotification(userId, { title, body, type, orderId }) {
  await query(
    `INSERT INTO notifications (user_id, title, body, type, order_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body, type || null, orderId || null]
  );
}

module.exports = { pool, query, initSchema, createNotification };
