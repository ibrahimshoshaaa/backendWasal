function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
async function resolveOptions(dbQuery, productId, selections = [], basePrice = 0) {
  if (!Array.isArray(selections)) invalid('اختيارات المنتج غير صحيحة');
  const { rows: groups } = await dbQuery('SELECT * FROM option_groups WHERE product_id=$1', [productId]);
  const { rows: choices } = await dbQuery(
    `SELECT c.*, g.name AS group_name FROM option_choices c JOIN option_groups g ON g.id=c.group_id WHERE g.product_id=$1`, [productId]);
  const selected = new Map();
  for (const selection of selections) {
    const groupId = Number(selection.group_id);
    if (!Number.isInteger(groupId) || selected.has(groupId) || !groups.some(g => g.id === groupId) || !Array.isArray(selection.choice_ids)) invalid('مجموعة اختيارات غير صحيحة');
    const ids = selection.choice_ids.map(Number);
    if (ids.some(id => !Number.isInteger(id)) || new Set(ids).size !== ids.length) invalid('اختيارات مكررة أو غير صحيحة');
    selected.set(groupId, ids);
  }
  const resolved = [];
  for (const group of groups) {
    const ids = selected.get(group.id) || [];
    const minimum = Math.max(Number(group.min_select), group.is_required ? 1 : 0);
    if (ids.length < minimum || ids.length > Number(group.max_select)) invalid(`راجع اختيارات ${group.name}`);
    for (const id of ids) {
      const choice = choices.find(c => c.id === id && c.group_id === group.id && c.is_available);
      if (!choice || !Number.isFinite(Number(choice.extra_price)) || Number(choice.extra_price) < 0) invalid('أحد اختيارات المنتج لم يعد متاحاً');
      if (group.pricing_mode === 'absolute' && (choice.total_price == null || !Number.isFinite(Number(choice.total_price)) || Number(choice.total_price) < 0)) invalid('سعر الحجم غير صحيح');
      resolved.push({ ...(group.pricing_mode === 'absolute' ? {total_price: Number(choice.total_price)} : {}), choice_id: choice.id, name: choice.name, group_id: group.id, group_name: group.name, extra_price: group.pricing_mode === 'absolute' ? 0 : Number(choice.extra_price) });
    }
  }
  const sizes = resolved.filter(c => c.total_price != null);
  if (sizes.length > 1) invalid('اختر حجماً واحداً فقط');
  const extra = resolved.reduce((sum, c) => sum + c.extra_price, 0)
    + (sizes.length ? sizes[0].total_price - Number(basePrice) : 0);
  return { resolved, extra, hash: resolved.map(c => c.choice_id).sort((a, b) => a - b).join('-') };
}
function storedSelections(options) {
  const groups = new Map();
  for (const option of options || []) {
    if (!groups.has(option.group_id)) groups.set(option.group_id, []);
    groups.get(option.group_id).push(option.choice_id);
  }
  return Array.from(groups, ([group_id, choice_ids]) => ({ group_id, choice_ids }));
}
module.exports = { resolveOptions, storedSelections };

