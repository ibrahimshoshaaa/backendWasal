const express = require('express');
const { pool, query, createNotification } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkCancelRate, checkNewOrderSignals } = require('../services/fraud');
const { isMerchantOpenNow } = require('../services/merchantHours');
const { resolveOptions, storedSelections } = require('../services/options');

const { beginSubmission, completeSubmission } = require('../services/submissions');

const router = express.Router();

// ─── Helper: notify via WebSocket + DB ────────────────────────────────────────
function notify(req, userId, payload) {
  createNotification(userId, payload).catch(() => {});
  req.app.locals.sendToUser?.(userId, { ...payload, notifType: payload.type, type: 'notification' });
}

// ─── POST /api/orders — العميل يطلب ───────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { merchant_id, address_id, payment_method, notes } = req.body || {};
  if (!Number.isInteger(Number(merchant_id)) || !Number.isInteger(Number(address_id))) {
    return res.status(400).json({ error: 'المتجر وعنوان التوصيل مطلوبان' });
  }

  const fail = (status, message) => {
    const error = new Error(message);
    error.status = status;
    throw error;
  };
  let client;
  let order;
  let merchantOwnerId;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [req.userId]);
    const submission = await beginSubmission(client, req, 'store');
    if (submission?.response) {
      await client.query('COMMIT');
      return res.json(submission.response);
    }

    const { rows: addresses } = await client.query(
      'SELECT id FROM addresses WHERE id=$1 AND user_id=$2',
      [address_id, req.userId]
    );
    if (!addresses.length) fail(400, 'عنوان التوصيل غير موجود في حسابك');

    const { rows: merchants } = await client.query(
      'SELECT * FROM merchants WHERE id=$1', [merchant_id]
    );
    if (!merchants.length) fail(404, 'المتجر غير موجود');
    const merchant = merchants[0];
    if (!isMerchantOpenNow(merchant).open) fail(400, 'المتجر مغلق حالياً، برجاء المحاولة لاحقاً');

    // Lock this customer's cart through checkout so it cannot change while
    // the order is being priced and cleared. Never use client-supplied totals.
    const { rows: cartLines } = await client.query(
      `SELECT ci.id, ci.product_id, ci.quantity, ci.selected_options, ci.unit_extra,
              p.name, p.price, p.image_url, p.merchant_id, p.is_available
       FROM cart_items ci JOIN products p ON p.id=ci.product_id
       WHERE ci.user_id=$1 ORDER BY ci.id FOR UPDATE OF ci`,
      [req.userId]
    );
    if (!cartLines.length) fail(400, 'السلة فارغة');
    if (cartLines.some(line => Number(line.merchant_id) !== Number(merchant_id))) {
      fail(400, 'منتجات السلة لا تخص هذا المتجر');
    }
    if (cartLines.some(line => !line.is_available || !Number.isInteger(line.quantity) || line.quantity <= 0)) {
      fail(400, 'أحد منتجات السلة غير متاح أو كميته غير صحيحة');
    }

    const items = [];
    for (const line of cartLines) {
      const options = await resolveOptions(client.query.bind(client), line.product_id, storedSelections(line.selected_options));
      const price = Number(line.price);
      const extra = options.extra;
      if (!Number.isFinite(price) || !Number.isFinite(extra) || price < 0 || extra < 0) {
        fail(400, 'سعر أحد المنتجات غير صحيح');
      }
      const unitPrice = price + extra;
      items.push({
        id: line.id,
        product_id: line.product_id,
        name: line.name,
        price,
        unit_extra: extra,
        unit_price: unitPrice,
        selected_options: options.resolved,
        quantity: line.quantity,
        image_url: line.image_url,
        line_total: unitPrice * line.quantity,
      });
    }
    const subtotalCents = items.reduce((sum, item) =>
      sum + Math.round(item.unit_price * 100) * item.quantity, 0);
    const feeCents = Math.round(Number(merchant.delivery_fee) * 100);
    if (!Number.isFinite(feeCents) || feeCents < 0) fail(400, 'رسوم التوصيل غير صحيحة');
    const subtotal = subtotalCents / 100;
    const deliveryFee = feeCents / 100;
    const total = (subtotalCents + feeCents) / 100;
    if (subtotal < Number(merchant.min_order || 0)) fail(400, 'لم تصل السلة للحد الأدنى للطلب');

    const { rows: seqRow } = await client.query("SELECT NEXTVAL('orders_id_seq') AS next_id");
    const nextId = seqRow[0].next_id;
    const orderNumber = 'WS-' + String(nextId).padStart(5, '0');
    const { rows } = await client.query(
      `INSERT INTO orders
        (id, order_number, customer_id, merchant_id, address_id, items_json,
         subtotal, delivery_fee, total, payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [nextId, orderNumber, req.userId, merchant_id, address_id,
       JSON.stringify(items), subtotal, deliveryFee, total,
       payment_method || 'cash', notes || null]
    );
    order = rows[0];
    merchantOwnerId = merchant.owner_user_id;
    await client.query('DELETE FROM cart_items WHERE user_id=$1 AND id=ANY($2)',
      [req.userId, cartLines.map(line => line.id)]);
    await completeSubmission(client, submission, order);
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'فشل إنشاء الطلب' });
  } finally {
    client?.release();
  }

  notify(req, merchantOwnerId, {
    title: 'طلب جديد! 🛍️',
    body: `طلب جديد رقم ${order.order_number}`,
    type: 'new_order',
    orderId: order.id,
  });
  checkNewOrderSignals(order).catch((e) => console.error('[fraud] check failed:', e.message));
  res.json(order);
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
              u.driver_lng, u.driver_location_updated_at
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
              o.delivery_otp,
              u.driver_lat, u.driver_lng, u.driver_location_updated_at,
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
       WHERE id=$2 AND customer_id=$3 AND status IN ('pending','accepted') RETURNING *`,
      [reason, order.id, req.userId]
    );

    if (!updated.length) return res.status(409).json({ error: 'تم تغيير حالة الطلب، لا يمكن إلغاؤه' });

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

