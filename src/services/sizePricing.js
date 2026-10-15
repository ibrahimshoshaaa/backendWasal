const { pool } = require('../db');
function validateChoicePrice(body, mode) {
  const value = mode === 'absolute' ? body.total_price : (body.extra_price ?? 0);
  return value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 99999999.99
    ? 'أدخل سعراً صحيحاً لا يقل عن صفر' : null;
}
async function createSizeGroup(productId, body) {
  const sizes = body.choices;
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 30 || sizes.some(s => !s.name?.trim() || validateChoicePrice(s, 'absolute'))) {
    throw Object.assign(new Error('أدخل اسم وسعر كل حجم (حتى 30 حجماً)'), {status:400});
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[group]} = await client.query(`INSERT INTO option_groups(product_id,name,is_required,min_select,max_select,pricing_mode)
      VALUES($1,$2,true,1,1,'absolute') RETURNING *`, [productId, body.name?.trim() || 'الحجم']);
    const choices = [];
    for (const [index,size] of sizes.entries()) {
      const {rows:[choice]} = await client.query(`INSERT INTO option_choices(group_id,name,extra_price,total_price,sort_order)
        VALUES($1,$2,0,$3,$4) RETURNING *`, [group.id,size.name.trim(),size.total_price,index]);
      choices.push(choice);
    }
    await client.query('COMMIT');
    return {...group,choices};
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally {client.release();}
}
module.exports = {createSizeGroup, validateChoicePrice};
