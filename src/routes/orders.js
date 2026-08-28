const express = require('express');
const { query, createNotification } = require('../db');
const { requireAuth } = require('../middleware/auth');

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
              u.driver_lat, u.driver_lng,
              u.full_name AS driver_name, u.phone AS driver_phone,
              m.name AS merchant_name, m.address AS merchant_address
       FROM orders o
       LEFT JOIN users u ON u.id = o.driver_id
       LEFT JOIN merchants m ON m.id = o.merchant_id
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

    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: 'فشل إلغاء الطلب' });
  }
});

// ─── POST /api/orders/:id/rate — العميل يقيّم الطلب ─────────────────────────
router.post('/:id/rate', requireAuth, async (req, res) => {
  try {
    const { rating, comment } = req.body || {};
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'التقييم لازم يكون من 1 لـ 5' });
    }

    const { rows } = await query(
      `UPDATE orders SET rating=$1, rating_comment=$2
       WHERE id=$3 AND customer_id=$4 AND status='delivered' RETURNING *`,
      [rating, comment || null, req.params.id, req.userId]
    );
    if (!rows.length) {
      return res.status(400).json({ error: 'لا يمكن تقييم هذا الطلب' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل حفظ التقييم' });
  }
});

module.exports = router;
