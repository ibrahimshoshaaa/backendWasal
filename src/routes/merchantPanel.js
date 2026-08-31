const express = require('express');
const { query, createNotification } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { destroyByPublicId, extractPublicIdFromUrl } = require('../config/cloudinary');
const { checkCancelRate } = require('../services/fraud');

const router = express.Router();

async function myMerchantId(userId) {
  const { rows } = await query('SELECT id FROM merchants WHERE owner_user_id=$1 LIMIT 1', [userId]);
  return rows[0]?.id || null;
}

function notify(req, userId, payload) {
  createNotification(userId, payload).catch(() => {});
  req.app.locals.sendToUser?.(userId, { type: 'notification', ...payload });
}

// Helper: safe-delete على Cloudinary. بيقبل public_id مباشرة أو رابط،
// وبيسكت أي خطأ (best-effort) عشان ما يكسرش الـ endpoint اللي بينده.
function safeDestroy(publicIdOrUrl, fallbackUrl) {
  const pid =
    publicIdOrUrl && !publicIdOrUrl.startsWith('http')
      ? publicIdOrUrl
      : extractPublicIdFromUrl(publicIdOrUrl || fallbackUrl);
  if (!pid) return;
  destroyByPublicId(pid).catch(() => {});
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

    checkCancelRate(order.customer_id).catch((e) => console.error('[fraud] check failed:', e.message));

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
    notify(req, order.customer_id, {
      title: 'طلبك جاهز! 🎁',
      body: `طلبك رقم ${order.order_number} جاهز وفي انتظار المندوب`,
      type: 'order_ready',
      orderId: order.id,
    });
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

// PUT /api/merchant/profile
// لو Flutter/الموقع بعت image_url أو cover_image_url جديد (بعد ما رفعه بـ POST /api/upload)،
// بنستبدل الرابط في DB وبنحذف الصورة القديمة من Cloudinary.
router.put('/profile', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

    // نجيب القيم القديمة عشان نعرف نحذف الصور القديمة من Cloudinary.
    let oldRow = null;
    if (req.body.image_url !== undefined || req.body.cover_image_url !== undefined) {
      const { rows: oldRows } = await query(
        `SELECT image_url, image_public_id, cover_image_url, cover_image_public_id
         FROM merchants WHERE id=$1`,
        [merchantId]
      );
      oldRow = oldRows[0] || null;
    }

    const fields = ['name', 'image_url', 'cover_image_url', 'address', 'phone', 'tags',
                    'is_open', 'hours_note', 'delivery_fee', 'delivery_time_minutes', 'min_order',
                    'lat', 'lng', 'working_hours', 'closed_dates', 'break_start', 'break_end',
                    'category_id'];
    const jsonFields = new Set(['tags', 'working_hours', 'closed_dates']);
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(jsonFields.has(f) ? JSON.stringify(req.body[f]) : req.body[f]);
        updates.push(`${f}=$${params.length}`);
      }
    }

    // لو الـ URL اتغيّر، نصفّر public_id القديم عشان ما يفضلش يشير لصورة اتحذفت.
    if (req.body.image_url !== undefined) {
      params.push(null);
      updates.push(`image_public_id=$${params.length}`);
    }
    if (req.body.cover_image_url !== undefined) {
      params.push(null);
      updates.push(`cover_image_public_id=$${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(merchantId);
    const { rows } = await query(
      `UPDATE merchants SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );

    // Cleanup الصور القديمة من Cloudinary (best-effort).
    if (oldRow) {
      if (
        req.body.image_url !== undefined &&
        oldRow.image_url &&
        oldRow.image_url !== req.body.image_url
      ) {
        safeDestroy(oldRow.image_public_id, oldRow.image_url);
      }
      if (
        req.body.cover_image_url !== undefined &&
        oldRow.cover_image_url &&
        oldRow.cover_image_url !== req.body.cover_image_url
      ) {
        safeDestroy(oldRow.cover_image_public_id, oldRow.cover_image_url);
      }
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث بيانات المتجر' });
  }
});

// ─── إغلاق مؤقت عند ضغط الطلبات ────────────────────────────────────────────────
// PUT /api/merchant/pause  body: { minutes }  — يوقف استقبال الطلبات مؤقتاً
router.put('/pause', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
    const minutes = Number(req.body?.minutes);
    if (!minutes || minutes <= 0) return res.status(400).json({ error: 'المدة مطلوبة' });
    const { rows } = await query(
      `UPDATE merchants SET temp_closed_until = now() + ($1 || ' minutes')::interval
       WHERE id=$2 RETURNING temp_closed_until`,
      [minutes, merchantId]
    );
    res.json({ ok: true, temp_closed_until: rows[0].temp_closed_until });
  } catch (err) {
    res.status(500).json({ error: 'فشل تفعيل الإغلاق المؤقت' });
  }
});

// PUT /api/merchant/resume — إلغاء الإغلاق المؤقت والعودة لاستقبال الطلبات
router.put('/resume', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });
    await query('UPDATE merchants SET temp_closed_until=NULL WHERE id=$1', [merchantId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل استئناف استقبال الطلبات' });
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

// PUT /api/merchant/products/:id
// نفس منطق تحديث المتجر: لو الـ image_url اتغيّر، بنحذف القديمة من Cloudinary.
router.put('/products/:id', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

    let oldRow = null;
    if (req.body.image_url !== undefined) {
      const { rows: oldRows } = await query(
        `SELECT image_url, image_public_id FROM products WHERE id=$1 AND merchant_id=$2`,
        [req.params.id, merchantId]
      );
      oldRow = oldRows[0] || null;
    }

    const fields = ['name', 'price', 'image_url', 'description', 'category', 'is_available'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f}=$${params.length}`); }
    }
    if (req.body.image_url !== undefined) {
      params.push(null);
      updates.push(`image_public_id=$${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'لا يوجد بيانات للتحديث' });
    params.push(req.params.id, merchantId);
    const { rows } = await query(
      `UPDATE products SET ${updates.join(', ')}
       WHERE id=$${params.length - 1} AND merchant_id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'المنتج غير موجود' });

    if (
      oldRow &&
      req.body.image_url !== undefined &&
      oldRow.image_url &&
      oldRow.image_url !== req.body.image_url
    ) {
      safeDestroy(oldRow.image_public_id, oldRow.image_url);
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث المنتج' });
  }
});

// DELETE /api/merchant/products/:id
// بنمسح المنتج ونمسح صورته من Cloudinary لو معروفة.
router.delete('/products/:id', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId) return res.status(404).json({ error: 'لا يوجد متجر مرتبط بحسابك' });

    // نجيب صورة المنتج قبل الحذف عشان نقدر ننضّفها من Cloudinary.
    const { rows: prodRows } = await query(
      `SELECT image_url, image_public_id FROM products WHERE id=$1 AND merchant_id=$2`,
      [req.params.id, merchantId]
    );

    const { rowCount } = await query(
      'DELETE FROM products WHERE id=$1 AND merchant_id=$2', [req.params.id, merchantId]
    );
    if (!rowCount) return res.status(404).json({ error: 'المنتج غير موجود' });

    if (prodRows.length) {
      safeDestroy(prodRows[0].image_public_id, prodRows[0].image_url);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف المنتج' });
  }
});

// ─── إدارة الإضافات والاختيارات لكل منتج ──────────────────────────────────────
async function assertOwnsProduct(merchantId, productId) {
  const { rows } = await query('SELECT id FROM products WHERE id=$1 AND merchant_id=$2', [
    productId,
    merchantId,
  ]);
  return rows.length > 0;
}

// GET /api/merchant/products/:id/options — مجموعات الخيارات + اختياراتها لمنتج معين
router.get('/products/:id/options', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId || !(await assertOwnsProduct(merchantId, req.params.id))) {
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }
    const { rows: groups } = await query(
      'SELECT * FROM option_groups WHERE product_id=$1 ORDER BY sort_order, id',
      [req.params.id]
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

// POST /api/merchant/products/:id/options — إضافة مجموعة خيارات جديدة (مثل "أحجام المشروبات")
router.post('/products/:id/options', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    if (!merchantId || !(await assertOwnsProduct(merchantId, req.params.id))) {
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }
    const { name, is_required, min_select, max_select, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'اسم المجموعة مطلوب' });
    const { rows } = await query(
      `INSERT INTO option_groups (product_id, name, is_required, min_select, max_select, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, !!is_required, min_select ?? 0, max_select ?? 1, sort_order ?? 0]
    );
    res.json({ ...rows[0], choices: [] });
  } catch (err) {
    res.status(500).json({ error: 'فشل إضافة مجموعة الخيارات' });
  }
});

// PUT /api/merchant/option-groups/:groupId
router.put('/option-groups/:groupId', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    const { rows: check } = await query(
      `SELECT g.id FROM option_groups g JOIN products p ON p.id=g.product_id
       WHERE g.id=$1 AND p.merchant_id=$2`,
      [req.params.groupId, merchantId]
    );
    if (!check.length) return res.status(404).json({ error: 'المجموعة غير موجودة' });

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
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث المجموعة' });
  }
});

// DELETE /api/merchant/option-groups/:groupId
router.delete('/option-groups/:groupId', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    const { rowCount } = await query(
      `DELETE FROM option_groups g USING products p
       WHERE g.id=$1 AND g.product_id=p.id AND p.merchant_id=$2`,
      [req.params.groupId, merchantId]
    );
    if (!rowCount) return res.status(404).json({ error: 'المجموعة غير موجودة' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حذف المجموعة' });
  }
});

// POST /api/merchant/option-groups/:groupId/choices — إضافة اختيار داخل مجموعة
router.post(
  '/option-groups/:groupId/choices',
  requireAuth,
  requireRole('merchant'),
  async (req, res) => {
    try {
      const merchantId = await myMerchantId(req.userId);
      const { rows: check } = await query(
        `SELECT g.id FROM option_groups g JOIN products p ON p.id=g.product_id
         WHERE g.id=$1 AND p.merchant_id=$2`,
        [req.params.groupId, merchantId]
      );
      if (!check.length) return res.status(404).json({ error: 'المجموعة غير موجودة' });

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
  }
);

// PUT /api/merchant/option-choices/:choiceId
router.put('/option-choices/:choiceId', requireAuth, requireRole('merchant'), async (req, res) => {
  try {
    const merchantId = await myMerchantId(req.userId);
    const { rows: check } = await query(
      `SELECT c.id FROM option_choices c
       JOIN option_groups g ON g.id=c.group_id
       JOIN products p ON p.id=g.product_id
       WHERE c.id=$1 AND p.merchant_id=$2`,
      [req.params.choiceId, merchantId]
    );
    if (!check.length) return res.status(404).json({ error: 'الاختيار غير موجود' });

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
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الاختيار' });
  }
});

// DELETE /api/merchant/option-choices/:choiceId
router.delete(
  '/option-choices/:choiceId',
  requireAuth,
  requireRole('merchant'),
  async (req, res) => {
    try {
      const merchantId = await myMerchantId(req.userId);
      const { rowCount } = await query(
        `DELETE FROM option_choices c USING option_groups g, products p
         WHERE c.id=$1 AND c.group_id=g.id AND g.product_id=p.id AND p.merchant_id=$2`,
        [req.params.choiceId, merchantId]
      );
      if (!rowCount) return res.status(404).json({ error: 'الاختيار غير موجود' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'فشل حذف الاختيار' });
    }
  }
);

module.exports = router;
