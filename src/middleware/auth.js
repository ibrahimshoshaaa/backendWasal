const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per file
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('الملف لازم يكون صورة'));
    }
    cb(null, true);
  },
});

// Registration accepts multipart/form-data so it can carry the store logo
// or the driver's ID/selfie photos in the same request as the form fields.
const registerUpload = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'id_front', maxCount: 1 },
  { name: 'id_back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]);

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

function fileUrl(req, file) {
  if (!file) return null;
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${file.filename}`;
}

router.post('/register', registerUpload, async (req, res) => {
  const { full_name, email, password, phone, role } = req.body || {};
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'الاسم والإيميل وكلمة المرور مطلوبين' });
  }
  const allowedRoles = ['customer', 'merchant', 'driver'];
  const finalRole = allowedRoles.includes(role) ? role : 'customer';

  const files = req.files || {};
  const logoFile = files.logo?.[0] || null;
  const idFrontFile = files.id_front?.[0] || null;
  const idBackFile = files.id_back?.[0] || null;
  const selfieFile = files.selfie?.[0] || null;

  if (finalRole === 'driver' && (!idFrontFile || !idBackFile || !selfieFile)) {
    return res.status(400).json({ error: 'الرجاء إرفاق صورتي البطاقة والصورة الشخصية' });
  }

  try {
    const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) return res.status(400).json({ error: 'الإيميل ده مستخدم قبل كده' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (
         full_name, email, password_hash, phone, role,
         national_id, vehicle_type, id_front_url, id_back_url, selfie_url
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        full_name,
        email,
        hash,
        phone || null,
        finalRole,
        req.body.national_id || null,
        req.body.vehicle_type || null,
        fileUrl(req, idFrontFile),
        fileUrl(req, idBackFile),
        fileUrl(req, selfieFile),
      ]
    );
    const user = rows[0];

    if (finalRole === 'merchant') {
      let tags = [];
      if (req.body.categories) {
        try {
          tags = JSON.parse(req.body.categories);
        } catch {
          tags = [req.body.categories];
        }
      }
      await query(
        `INSERT INTO merchants (owner_user_id, name, image_url, address, phone, tags)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          user.id,
          req.body.store_name || full_name,
          fileUrl(req, logoFile),
          req.body.store_address || null,
          phone || null,
          JSON.stringify(tags),
        ]
      );
    }

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
