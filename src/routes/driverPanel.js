const express = require('express');
const { query, createNotification } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function notify(req, userId, payload) {
  createNotification(userId, payload).catch(() => {});
  req.app.locals.sendToUser?.(userId, { type: 'notification', ...payload });
}

router.get('/orders', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*,
              m.name AS merchant_name,
              m.address AS merchant_address,
              u.full_name AS customer_name,
              u.phone AS customer_phone,
              a.address_text AS delivery_address
       FROM orders o
       LEFT JOIN merchants m ON m.id = o.merchant_id
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE (o.status='ready' AND o.driver_id IS NULL)
          OR (o.driver_id=$1 AND o.status='picked_up')
       ORDER BY o.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الطلبات' });
  }
});

router.get('/status', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rows } = await query('SELECT is_online FROM users WHERE id=$1', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ is_online: rows[0].is_online });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل الحالة' });
  }
});

router.put('/status', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { is_online } = req.body || {};
    await query('UPDATE users SET is_online=$1 WHERE id=$2', [!!is_online, req.userId]);
    res.json({ ok: true, is_online: !!is_online });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الحالة' });
  }
});

router.put('/location', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'الإحداثيات مطلوبة' });
    }
    await query('UPDATE users SET driver_lat=$1, driver_lng=$2 WHERE id=$3', [lat, lng, req.userId]);

    // Push live location to customer of active order
    const { rows } = await query(
      `SELECT customer_id FROM orders WHERE driver_id=$1 AND status='picked_up' LIMIT 1`,
      [req.userId]
    );
    if (rows.length) {
      req.app.locals.sendToUser?.(rows[0].customer_id, {
        type: 'driver_location',
        lat, lng,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث الموقع' });
  }
});

router.put('/orders/:id/accept', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rowCount, rows } = await query(
      `UPDATE orders SET status='picked_up', driver_id=$1, picked_up_at=now()
       WHERE id=$2 AND status='ready' AND driver_id IS NULL RETURNING *`,
      [req.userId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'الطلب غير متاح' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: 'المندوب في الطريق 🛵',
      body: `طلبك رقم ${order.order_number} مع المندوب وفي طريقه إليك`,
      type: 'order_picked_up',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل استلام الطلب' });
  }
});

router.put('/orders/:id/deliver', requireAuth, requireRole('driver'), async (req, res) => {
  try {
    const { rowCount, rows } = await query(
      `UPDATE orders SET status='delivered', delivered_at=now()
       WHERE id=$1 AND driver_id=$2 AND status='picked_up' RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });

    const order = rows[0];
    notify(req, order.customer_id, {
      title: 'تم توصيل طلبك! 🎉',
      body: `تم توصيل طلبك رقم ${order.order_number}. بالهناء والشفاء!`,
      type: 'order_delivered',
      orderId: order.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'فشل تأكيد التوصيل' });
  }
});

module.exports = router;
