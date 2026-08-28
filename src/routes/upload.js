const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

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
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const isImageMime = file.mimetype.startsWith('image/');
    const isImageExt = /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.originalname);
    if (!isImageMime && !isImageExt) {
      return cb(new Error('الملف لازم يكون صورة'));
    }
    cb(null, true);
  },
});

router.post('/', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي صورة' });
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/uploads/${req.file.filename}` });
});

module.exports = router;
