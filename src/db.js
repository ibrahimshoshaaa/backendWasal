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
      role TEXT NOT NULL DEFAULT 'customer', -- customer | merchant | driver | admin
      avatar_url TEXT,
      is_online BOOLEAN NOT NULL DEFAULT false,
      driver_lat DOUBLE PRECISION,
      driver_lng DOUBLE PRECISION,
      driver_status TEXT DEFAULT 'pending', -- pending | active | suspended (admin-managed)
      national_id TEXT,
      vehicle_type TEXT,
      id_front_url TEXT,
      id_back_url TEXT,
      selfie_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Older databases created before these columns existed.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_type TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS id_front_url TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS id_back_url TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS selfie_url TEXT`);

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
      owner_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      category_id INT REFERENCES categories(id) ON DELETE SET NULL,
      image_url TEXT,
      address TEXT,
      phone TEXT,
      tags JSONB,
      tags JSONB,
      is_open BOOLEAN NOT NULL DEFAULT true,
      delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 20,
      delivery_time_minutes INT NOT NULL DEFAULT 30,
      min_order NUMERIC(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | suspended
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

   await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS tags JSONB`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT true`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 20`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS delivery_time_minutes INT NOT NULL DEFAULT 30`);
  await query(`ALTER TABLE merchants ADD COLUMN IF NOT EXISTS min_order NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // The admin app used to send 'active'/'inactive' instead of the real
  // 'approved'/'suspended' status values — fix any rows saved with those.
  await query(`UPDATE merchants SET status='approved' WHERE status='active'`);
  await query(`UPDATE merchants SET status='suspended' WHERE status='inactive'`);
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
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      status TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|ready|picked_up|delivered|cancelled
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
    console.log('Seeded default admin -> admin@wasal.app / admin123 (change this password!)');
  }
}

module.exports = { pool, query, initSchema };
