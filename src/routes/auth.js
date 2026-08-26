const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

function publicUser(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    avatar_url: row.avatar_url,
  };
}

router.post('/register', async (req, res) => {
  const { full_name, email, password, phone, role } = req.body || {};
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'الاسم والإيميل وكلمة المرور مطلوبين' });
  }
  const allowedRoles = ['customer', 'merchant', 'driver'];
  const finalRole = allowedRoles.includes(role) ? role : 'customer';

  try {
    const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) return res.status(400).json({ error: 'الإيميل ده مستخدم قبل كده' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, phone, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [full_name, email, hash, phone || null, finalRole]
    );
    const user = rows[0];
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'الإيميل وكلمة المرور مطلوبين' });

  try {
    const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
});

module.exports = { router, publicUser };
