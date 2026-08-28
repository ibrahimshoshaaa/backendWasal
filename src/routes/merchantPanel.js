const express = require('express');
const { query, createNotification } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function myMerchantId(userId) {
  const { rows } = await query('SELECT id FROM merchants WHERE owner_user_id=$1 LIMIT 1', [userId]);
  return rows[0]?.id || null;
}

function notify(req, userId, payload) {
  createNotification(userId, payload).catch(() => {});
  req.app.locals.sendToUser?.(userId, { type: 'notification', ...payload });
}

// ─── GET /api/merchant/orders ─────────────────────────────────────────────────
router.get('/orders', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.json([]);
    const { rows } = await query(
      `SELECT o.*,
              u.full_name AS customer_name,
              u.phone AS customer_phone,
              a.address_text AS delivery_address
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.merchant_id=$1 AND o.status NOT IN ('delivered','cancelled')
       ORDER BY o.created_at DESC`,
      [merchantId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الطلبات' });
  }
});

// ─── GET /api/merchant/orders/history ─────────────────────────────────────────
router.get('/orders/history', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.json([]);
    const { rows } = await query(
      `SELECT o.*,
              u.full_name AS customer_name,
              u.phone AS customer_phone,
              a.address_text AS delivery_address
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.merchant_id=$1 AND o.status IN ('delivered','cancelled')
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [merchantId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل سجل الطلبات' });
  }
});

// ─── GET /api/merchant/stats ───────────────────────────────────────────────────
router.get('/stats', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.json({ today: { count: 0, revenue: 0 }, week: { count: 0, revenue: 0 }, total: { count: 0, revenue: 0 } });

    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today_count,
         COALESCE(SUM(subtotal) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS today_revenue,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS week_count,
         COALESCE(SUM(subtotal) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week_revenue,
         COUNT(*) AS total_count,
         COALESCE(SUM(subtotal), 0) AS total_revenue
       FROM orders
       WHERE merchant_id=$1 AND status='delivered'`,
      [merchantId]
    );
    const r = rows[0];
    res.json({
      today: { count: Number(r.today_count), revenue: Number(r.today_revenue) },
      week: { count: Number(r.week_count), revenue: Number(r.week_revenue) },
      total: { count: Number(r.total_count), revenue: Number(r.total_revenue) },
    });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الإحصائيات' });
  }
});

// ─── PUT /api/merchant/orders/:id/accept ──────────────────────────────────────
router.put('/orders/:id/accept', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    const { rows } = await query(
      `UPDATE orders SET status='accepted', accepted_at=now()
       WHERE id=$1 AND merchant_id=$2 AND status='pending' RETURNING *`,
      [req.params.id, merchantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود أو تم قبوله مسبقاً' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: 'تم قبول طلبك ✅',
      body: `المطعم قبل طلبك رقم ${order.order_number} وبدأ في التجهيز`,
      type: 'order_accepted',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل قبول الطلب' });
  }
});

// ─── PUT /api/merchant/orders/:id/reject ──────────────────────────────────────
router.put('/orders/:id/reject', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    const reason = req.body.reason || 'رفض المطعم الطلب';
    const { rows } = await query(
      `UPDATE orders SET status='cancelled', cancel_reason=$1, cancelled_at=now()
       WHERE id=$2 AND merchant_id=$3 AND status='pending' RETURNING *`,
      [reason, req.params.id, merchantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: 'تم رفض طلبك ❌',
      body: `عذراً، المطعم رفض طلبك رقم ${order.order_number}. السبب: ${reason}`,
      type: 'order_rejected',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل رفض الطلب' });
  }
});

// ─── PUT /api/merchant/orders/:id/ready ───────────────────────────────────────
router.put('/orders/:id/ready', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    const { rows } = await query(
      `UPDATE orders SET status='ready', ready_at=now()
       WHERE id=$1 AND merchant_id=$2 AND status='accepted' RETURNING *`,
      [req.params.id, merchantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = rows[0];
    // Notify customer
    notify(req, order.customer_id, {
      title: 'طلبك جاهز! 🎁',
      body: `طلبك رقم ${order.order_number} جاهز وفي انتظار المندوب`,
      type: 'order_ready',
      orderId: order.id,
    });
    // Notify all online drivers via broadcast (driver_id unknown yet)
    // Drivers will see it via polling or WS broadcast handled separately
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث حالة الطلب' });
  }
});

// ─── Store profile ─────────────────────────────────────────────────────────────
router.get('/profile', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM merchants WHERE owner_user_id=$1 LIMIT 1', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل بيانات المتجر' });
  }
});

router.put('/profile', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

    const fields = ['name', 'image_url', 'cover_image_url', 'address', 'phone', 'tags',
                    'is_open', 'hours_note', 'delivery_fee', 'delivery_time_minutes', 'min_order'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(f === 'tags' ? JSON.stringify(req.body[f]) : req.body[f]);
        updates.push(`${f}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(merchantId);
    const { rows } = await query(
      `UPDATE merchants SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث بيانات المتجر' });
  }
});

// ─── Products ──────────────────────────────────────────────────────────────────
router.get('/products', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.json([]);
    const { rows } = await query(
      'SELECT * FROM products WHERE merchant_id=$1 ORDER BY id DESC', [merchantId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل المنتجات' });
  }
});

router.post('/products', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
    const { name, price, image_url, description, category } = req.body || {};
    if (!name || price === undefined) return res.status(400).json({ error: 'اسم المنتج والسعر مطلوبين' });
    const { rows } = await query(
      `INSERT INTO products (merchant_id, name, price, image_url, description, category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [merchantId, name, price, image_url || null, description || null, category || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل إضافة المنتج' });
  }
});

router.put('/products/:id', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
    const fields = ['name', 'price', 'image_url', 'description', 'category', 'is_available'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.params.id, merchantId);
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

router.delete('/products/:id', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
    const { rowCount } = await query(
      'DELETE FROM products WHERE id=$1 AND merchant_id=$2', [req.params.id, merchantId]
    );
    if (!rowCount) return res.status(404).json({ error: 'المنتج غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف المنتج' });
  }
});

module.exports = router;
