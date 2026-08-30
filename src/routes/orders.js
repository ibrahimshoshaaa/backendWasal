const express = require('express');
const { query, createNotification } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkCancelRate, checkNewOrderSignals } = require('../services/fraud');
const { isMerchantOpenNow } = require('../services/merchantHours');

const router = express.Router();

// ─── Helper: notify via WebSocket + DB ────────────────────────────────────────
function notify(req, userId, payload) {
  createNotification(userId, payload).catch(() => {});
  req.app.locals.sendToUser?.(userId, { type: 'notification', ...payload });
}

// ─── POST /api/orders — العميل يطلب ───────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { merchant_id, address_id, items, subtotal, delivery_fee, total, payment_method, notes } =
    req.body || {};
  if (!merchant_id || !items || !items.length) {
    return res.status(400).json({ error: 'بيانات الطلب ناقصة' });
  }

  try {
    // تحقق أن المتجر مفتوح فعلياً (يدوياً + حسب جدول أوقات العمل) قبل قبول الطلب
    const { rows: merchantCheck } = await query('SELECT * FROM merchants WHERE id=$1', [merchant_id]);
    if (!merchantCheck.length) return res.status(404).json({ error: 'المتجر غير موجود' });
    const openStatus = isMerchantOpenNow(merchantCheck[0]);
    if (!openStatus.open) {
      return res.status(400).json({ error: 'المتجر مغلق حالياً، برجاء المحاولة لاحقاً' });
    }

    // Generate order_number: WS-XXXXX
    const { rows: seqRow } = await query(`SELECT NEXTVAL('orders_id_seq') AS next_id`);
    const nextId = seqRow[0].next_id;
    const orderNumber = 'WS-' + String(nextId).padStart(5, '0');

    const { rows } = await query(
      `INSERT INTO orders
        (id, order_number, customer_id, merchant_id, address_id, items_json,
         subtotal, delivery_fee, total, payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        nextId, orderNumber, req.userId, merchant_id,
        address_id || null, JSON.stringify(items),
        subtotal || 0, delivery_fee || 0, total || 0,
        payment_method || 'cash', notes || null,
      ]
    );
    await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);

    const order = rows[0];

    // Notify merchant via WS + DB
    const { rows: merchantRows } = await query(
      'SELECT owner_user_id FROM merchants WHERE id=$1', [merchant_id]
    );
    if (merchantRows.length) {
      notify(req, merchantRows[0].owner_user_id, {
        title: 'طلب جديد! 🛍️',
        body: `طلب جديد رقم ${orderNumber}`,
        type: 'new_order',
        orderId: order.id,
      });
    }

    checkNewOrderSignals(order).catch((e) => console.error('[fraud] check failed:', e.message));

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل إنشاء الطلب' });
  }
});

// ─── GET /api/orders — طلبات العميل ──────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*,
              m.name AS merchant_name,
              m.image_url AS merchant_image,
              a.address_text AS delivery_address,
              u.full_name AS driver_name,
              u.phone AS driver_phone
       FROM orders o
       LEFT JOIN merchants m ON m.id = o.merchant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       LEFT JOIN users u ON u.id = o.driver_id
       WHERE o.customer_id=$1
       ORDER BY o.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الطلبات' });
  }
});

// ─── GET /api/orders/:id — تفاصيل طلب واحد ───────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*,
              m.name AS merchant_name,
              m.address AS merchant_address,
              m.image_url AS merchant_image,
              a.address_text AS delivery_address,
              a.lat AS delivery_lat,
              a.lng AS delivery_lng,
              u.full_name AS driver_name,
              u.phone AS driver_phone,
              u.driver_lat,
              u.driver_lng
       FROM orders o
       LEFT JOIN merchants m ON m.id = o.merchant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       LEFT JOIN users u ON u.id = o.driver_id
       WHERE o.id=$1 AND o.customer_id=$2`,
      [req.params.id, req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الطلب' });
  }
});

// ─── GET /api/orders/:id/track — تتبع الطلب ──────────────────────────────────
router.get('/:id/track', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.id, o.status, o.order_number, o.customer_id,
              o.accepted_at, o.ready_at, o.picked_up_at, o.delivered_at,
              o.rating, o.driver_rating, o.driver_id, o.total, o.payment_method,
              u.driver_lat, u.driver_lng,
              u.full_name AS driver_name, u.phone AS driver_phone,
              m.name AS merchant_name, m.address AS merchant_address,
              m.lat AS merchant_lat, m.lng AS merchant_lng,
              a.lat AS delivery_lat, a.lng AS delivery_lng, a.address_text AS delivery_address
       FROM orders o
       LEFT JOIN users u ON u.id = o.driver_id
       LEFT JOIN merchants m ON m.id = o.merchant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    const order = rows[0];
    if (order.customer_id !== req.userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'غير مصرح' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل بيانات التتبع' });
  }
});

// ─── POST /api/orders/:id/cancel — العميل يلغي الطلب ─────────────────────────
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM orders WHERE id=$1 AND customer_id=$2',
      [req.params.id, req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = rows[0];
    // Can only cancel if pending or accepted
    if (!['pending', 'accepted'].includes(order.status)) {
      return res.status(400).json({ error: 'لا يمكن إلغاء الطلب بعد تجهيزه' });
    }

    const reason = req.body.reason || 'ألغى العميل الطلب';
    const { rows: updated } = await query(
      `UPDATE orders SET status='cancelled', cancel_reason=$1, cancelled_at=now()
       WHERE id=$2 RETURNING *`,
      [reason, order.id]
    );

    // Notify merchant
    const { rows: merchantRows } = await query(
      'SELECT owner_user_id FROM merchants WHERE id=$1', [order.merchant_id]
    );
    if (merchantRows.length) {
      notify(req, merchantRows[0].owner_user_id, {
        title: 'تم إلغاء طلب ❌',
        body: `الطلب رقم ${order.order_number} تم إلغاؤه من العميل`,
        type: 'order_cancelled',
        orderId: order.id,
      });
    }

    checkCancelRate(order.customer_id).catch((e) => console.error('[fraud] check failed:', e.message));

    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل إلغاء الطلب' });
  }
});

// ─── POST /api/orders/:id/rate — العميل يقيّم الطلب ─────────────────────────
// بيدعم تقييم المتجر (rating/comment) وتقييم المندوب (driver_rating/driver_comment)
// في نفس الطلب أو منفصلين — كل واحد فيهم بيتحفظ مرة واحدة بس ومستقل عن التاني.
router.post('/:id/rate', requireAuth, async (req, res) => {
  try {
    const { rating, comment, driver_rating, driver_comment } = req.body || {};

    if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'التقييم لازم يكون من 1 لـ 5' });
    }
    if (driver_rating !== undefined && driver_rating !== null && (driver_rating < 1 || driver_rating > 5)) {
      return res.status(400).json({ error: 'تقييم المندوب لازم يكون من 1 لـ 5' });
    }
    if (!rating && !driver_rating) {
      return res.status(400).json({ error: 'التقييم مطلوب' });
    }

    const { rows: existingRows } = await query(
      'SELECT rating, driver_rating, status, driver_id FROM orders WHERE id=$1 AND customer_id=$2',
      [req.params.id, req.userId]
    );
    if (!existingRows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    const existing = existingRows[0];
    if (existing.status !== 'delivered') {
      return res.status(400).json({ error: 'لا يمكن تقييم هذا الطلب' });
    }

    const updates = [];
    const params = [];
    if (rating && existing.rating === null) {
      params.push(rating);
      updates.push(`rating=$${params.length}`);
      params.push(comment || null);
      updates.push(`rating_comment=$${params.length}`);
    }
    if (driver_rating && existing.driver_rating === null && existing.driver_id) {
      params.push(driver_rating);
      updates.push(`driver_rating=$${params.length}`);
      params.push(driver_comment || null);
      updates.push(`driver_rating_comment=$${params.length}`);
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'تم تقييم هذا الطلب من قبل' });
    }

    params.push(req.params.id);
    await query(`UPDATE orders SET ${updates.join(', ')} WHERE id=$${params.length}`, params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حفظ التقييم' });
  }
});

module.exports = router;
