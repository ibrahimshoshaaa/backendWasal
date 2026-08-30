// ─── نظام مكافحة الطلبات الوهمية ─────────────────────────────────────────────
// مجموعة فحوصات "best-effort" بتتنفذ لحظة إنشاء/إلغاء الطلب، وبتسجّل تنبيه في
// fraud_flags لو لقت نمط مشبوه. الفحوصات دي مش بتمنع الطلب، بس بتنبّه الأدمن.
//
// ملحوظة: نظام "تكرار استخدام كوبون" مش متضمّن هنا لأن مفيش نظام كوبونات في
// المشروع أصلاً (لا جدول ولا endpoint). لو اتضاف كوبونات مستقبلاً، يُضاف فحص
// مشابه هنا بنفس الطريقة (raiseFlag('customer', id, 'coupon_abuse', ...)).

const { query } = require('../db');

const CANCEL_THRESHOLD = 5; // عدد الطلبات الملغاة خلال 30 يوم
const HIGH_VALUE_THRESHOLD = 1000; // جنيه — طلب "بقيمة مرتفعة"
const HIGH_VALUE_WINDOW_HOURS = 24;
const HIGH_VALUE_COUNT_THRESHOLD = 3; // 3 طلبات مرتفعة القيمة خلال 24 ساعة
const LOCATION_JUMP_KM = 100; // مسافة غير طبيعية بين طلبين متتاليين
const LOCATION_JUMP_WINDOW_HOURS = 2;

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// بيتجنّب تكرار نفس التنبيه لنفس الكيان خلال 24 ساعة (عشان القائمة متتكدسش).
async function raiseFlag(entityType, entityId, flagType, severity, details, orderId) {
  const { rows: existing } = await query(
    `SELECT id FROM fraud_flags
     WHERE entity_type=$1 AND entity_id=$2 AND flag_type=$3 AND resolved=false
       AND created_at > now() - interval '24 hours'`,
    [entityType, entityId, flagType]
  );
  if (existing.length) return;
  await query(
    `INSERT INTO fraud_flags (entity_type, entity_id, flag_type, severity, details, order_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entityType, entityId, flagType, severity, details ? JSON.stringify(details) : null, orderId || null]
  );
}

// يُستدعى بعد إلغاء أي طلب (من العميل أو رفض التاجر) — عدد كبير من الملغاة.
async function checkCancelRate(customerId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM orders
     WHERE customer_id=$1 AND status='cancelled' AND cancelled_at > now() - interval '30 days'`,
    [customerId]
  );
  if (rows[0].n >= CANCEL_THRESHOLD) {
    await raiseFlag('customer', customerId, 'high_cancel_rate', 'medium', {
      cancelled_last_30d: rows[0].n,
    });
  }
}

// يُستدعى بعد إنشاء طلب جديد — يفحص كل الأنماط المشبوهة المرتبطة بالعميل.
async function checkNewOrderSignals(order) {
  const customerId = order.customer_id;

  // 1) نفس رقم الهاتف مستخدم في حسابات عديدة
  const { rows: userRows } = await query('SELECT phone FROM users WHERE id=$1', [customerId]);
  const phone = userRows[0]?.phone;
  if (phone) {
    const { rows: dup } = await query('SELECT id FROM users WHERE phone=$1 AND id != $2', [
      phone,
      customerId,
    ]);
    if (dup.length) {
      await raiseFlag('customer', customerId, 'duplicate_phone', 'medium', {
        phone,
        other_user_ids: dup.map((r) => r.id),
      });
    }
  }

  // 2) إنشاء حسابات متعددة من نفس الجهاز
  const { rows: myTokens } = await query(
    'SELECT DISTINCT device_token FROM device_registrations WHERE user_id=$1',
    [customerId]
  );
  if (myTokens.length) {
    const tokens = myTokens.map((r) => r.device_token);
    const { rows: others } = await query(
      `SELECT DISTINCT user_id FROM device_registrations
       WHERE device_token = ANY($1) AND user_id != $2`,
      [tokens, customerId]
    );
    if (others.length) {
      await raiseFlag('customer', customerId, 'multi_account_device', 'high', {
        other_user_ids: others.map((r) => r.user_id),
      });
    }
  }

  // 3) طلبات كثيرة بقيمة مرتفعة خلال وقت قصير
  const { rows: highVal } = await query(
    `SELECT COUNT(*)::int AS n FROM orders
     WHERE customer_id=$1 AND total >= $2
       AND created_at > now() - interval '${HIGH_VALUE_WINDOW_HOURS} hours'`,
    [customerId, HIGH_VALUE_THRESHOLD]
  );
  if (highVal[0].n >= HIGH_VALUE_COUNT_THRESHOLD) {
    await raiseFlag('customer', customerId, 'high_value_burst', 'medium', {
      count: highVal[0].n,
      window_hours: HIGH_VALUE_WINDOW_HOURS,
      threshold: HIGH_VALUE_THRESHOLD,
    });
  }

  // 4) تغيير الموقع بشكل غير طبيعي بين طلبين متتاليين لنفس العميل
  if (order.address_id) {
    const { rows: addrRows } = await query('SELECT lat, lng FROM addresses WHERE id=$1', [
      order.address_id,
    ]);
    const cur = addrRows[0];
    if (cur && cur.lat != null && cur.lng != null) {
      const { rows: prevOrders } = await query(
        `SELECT a.lat, a.lng, o.created_at FROM orders o
         JOIN addresses a ON a.id = o.address_id
         WHERE o.customer_id=$1 AND o.id != $2 AND a.lat IS NOT NULL
         ORDER BY o.created_at DESC LIMIT 1`,
        [customerId, order.id]
      );
      if (prevOrders.length) {
        const prev = prevOrders[0];
        const hoursSince = (Date.now() - new Date(prev.created_at).getTime()) / 3600000;
        if (hoursSince <= LOCATION_JUMP_WINDOW_HOURS) {
          const dist = haversineKm(cur.lat, cur.lng, prev.lat, prev.lng);
          if (dist >= LOCATION_JUMP_KM) {
            await raiseFlag('customer', customerId, 'location_jump', 'medium', {
              distance_km: Math.round(dist),
              hours_since_prev_order: Number(hoursSince.toFixed(1)),
            });
          }
        }
      }
    }
  }
}

module.exports = { checkCancelRate, checkNewOrderSignals, raiseFlag, haversineKm };
