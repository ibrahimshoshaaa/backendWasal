const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
// Fallback فقط لو المتجر مالوش delivery_fee متسجل لأي سبب — القيمة الحقيقية
// بتتجاب من جدول merchants لكل تاجر على حدة.
const DEFAULT_DELIVERY_FEE = 15;

async function buildCartResponse(userId) {
  const { rows } = await query(
    `SELECT ci.id, ci.product_id, ci.quantity, ci.selected_options, ci.unit_extra,
            p.name, p.price, p.image_url, p.merchant_id
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = $1
     ORDER BY ci.id ASC`,
    [userId]
  );

  const items = rows.map((r) => {
    const unitPrice = Number(r.price) + Number(r.unit_extra || 0);
    return {
      id: r.id,
      product_id: r.product_id,
      name: r.name,
      price: Number(r.price),
      unit_extra: Number(r.unit_extra || 0),
      unit_price: unitPrice,
      selected_options: r.selected_options || [],
      quantity: r.quantity,
      image_url: r.image_url,
      line_total: unitPrice * r.quantity,
    };
  });

  const total = items.reduce((sum, it) => sum + it.line_total, 0);
  const merchantId = rows.length ? rows[0].merchant_id : null;

  let deliveryFee = 0;
  if (items.length && merchantId) {
    const { rows: merchantRows } = await query(
      'SELECT delivery_fee FROM merchants WHERE id=$1',
      [merchantId]
    );
    deliveryFee = merchantRows.length
      ? Number(merchantRows[0].delivery_fee)
      : DEFAULT_DELIVERY_FEE;
  }

  return {
    merchant_id: merchantId,
    items,
    total,
    delivery_fee: deliveryFee,
    grand_total: total + deliveryFee,
  };
}

router.get('/', requireAuth, async (req, res) => {
  res.json(await buildCartResponse(req.userId));
});

// POST /api/cart
// body: { product_id, quantity, selected_options?: [{ group_id, choice_ids: [id, ...] }] }
// كل تركيبة إضافات مختلفة بتتخزن كسطر منفصل في السلة (options_hash مميز)،
// عشان مثلاً "بيتزا وسط" و"بيتزا كبيرة" ما يتلخبطوش في نفس السطر.
router.post('/', requireAuth, async (req, res) => {
  const { product_id, quantity, selected_options } = req.body || {};
  if (!product_id || !quantity) return res.status(400).json({ error: 'بيانات ناقصة' });

  try {
    const { rows: productRows } = await query('SELECT * FROM products WHERE id=$1', [product_id]);
    if (!productRows.length) return res.status(404).json({ error: 'المنتج غير موجود' });
    const product = productRows[0];

    // Cart holds items from a single merchant at a time — switching
    // merchants replaces the cart, matching the app's single-checkout flow.
    const { rows: existingCart } = await query(
      `SELECT DISTINCT p.merchant_id FROM cart_items ci
       JOIN products p ON p.id = ci.product_id WHERE ci.user_id=$1`,
      [req.userId]
    );
    if (existingCart.length && existingCart[0].merchant_id !== product.merchant_id) {
      await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
    }

    // نتحقق من الاختيارات المرسلة إنها فعلاً تابعة لنفس المنتج، ونحسب السعر الإضافي
    let resolvedOptions = [];
    let unitExtra = 0;
    const choiceIds = Array.isArray(selected_options)
      ? selected_options.flatMap((o) => o.choice_ids || [])
      : [];
    if (choiceIds.length) {
      const { rows: choiceRows } = await query(
        `SELECT c.id, c.name, c.extra_price, c.group_id, g.name AS group_name
         FROM option_choices c JOIN option_groups g ON g.id=c.group_id
         WHERE c.id = ANY($1) AND g.product_id=$2 AND c.is_available=true`,
        [choiceIds, product_id]
      );
      resolvedOptions = choiceRows.map((r) => ({
        choice_id: r.id,
        name: r.name,
        group_id: r.group_id,
        group_name: r.group_name,
        extra_price: Number(r.extra_price),
      }));
      unitExtra = resolvedOptions.reduce((s, o) => s + o.extra_price, 0);
    }
    const optionsHash = resolvedOptions.length
      ? resolvedOptions.map((o) => o.choice_id).sort((a, b) => a - b).join('-')
      : '';

    await query(
      `INSERT INTO cart_items (user_id, product_id, quantity, selected_options, options_hash, unit_extra)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, product_id, options_hash)
       DO UPDATE SET quantity = cart_items.quantity + $3`,
      [req.userId, product_id, quantity, JSON.stringify(resolvedOptions), optionsHash, unitExtra]
    );

    res.json(await buildCartResponse(req.userId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشلت إضافة المنتج للسلة' });
  }
});

// PUT /api/cart/item/:productId — تحديث الكمية لسطر بدون إضافات (توافق مع النسخ القديمة)
router.put('/item/:productId', requireAuth, async (req, res) => {
  const { quantity } = req.body || {};
  if (quantity === undefined) return res.status(400).json({ error: 'الكمية مطلوبة' });

  if (quantity <= 0) {
    await query("DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2 AND options_hash=''", [
      req.userId,
      req.params.productId,
    ]);
  } else {
    await query(
      "UPDATE cart_items SET quantity=$1 WHERE user_id=$2 AND product_id=$3 AND options_hash=''",
      [quantity, req.userId, req.params.productId]
    );
  }
  res.json(await buildCartResponse(req.userId));
});

// PUT /api/cart/line/:id — تحديث الكمية لسطر معين (بما فيه أسطر بإضافات مختارة)
router.put('/line/:id', requireAuth, async (req, res) => {
  const { quantity } = req.body || {};
  if (quantity === undefined) return res.status(400).json({ error: 'الكمية مطلوبة' });

  if (quantity <= 0) {
    await query('DELETE FROM cart_items WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  } else {
    await query('UPDATE cart_items SET quantity=$1 WHERE id=$2 AND user_id=$3', [
      quantity,
      req.params.id,
      req.userId,
    ]);
  }
  res.json(await buildCartResponse(req.userId));
});

// DELETE /api/cart/line/:id — حذف سطر معين من السلة
router.delete('/line/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM cart_items WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json(await buildCartResponse(req.userId));
});

router.delete('/', requireAuth, async (req, res) => {
  await query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
  res.json({ ok: true });
});

module.exports = router;
