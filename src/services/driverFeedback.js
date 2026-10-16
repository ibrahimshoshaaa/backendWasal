const { query } = require('../db');
function rateDriver(table) {
  if (!['trips','hataali_orders'].includes(table)) throw new Error('Invalid rating resource');
  return async (req,res) => {
    const {rating,comment=''} = req.body || {};
    if (req.userRole !== 'customer') return res.status(403).json({error:'التقييم لصاحب الطلب فقط'});
    if (!Number.isInteger(rating) || rating<1 || rating>5 || typeof comment!=='string' || comment.length>1000) return res.status(400).json({error:'اختر تقييماً من 1 إلى 5 وتعليقاً لا يزيد عن 1000 حرف'});
    try {
      const {rows} = await query(`UPDATE ${table} SET driver_rating=$1,driver_rating_comment=$2
        WHERE id=$3 AND customer_id=$4 AND status='delivered' AND driver_id IS NOT NULL AND driver_rating IS NULL
        RETURNING id,driver_rating,driver_rating_comment`,[rating,comment.trim(),req.params.id,req.userId]);
      if (!rows.length) return res.status(409).json({error:'التقييم متاح بعد التسليم ولمرة واحدة لصاحب الطلب'});
      res.json(rows[0]);
    } catch (_) {res.status(500).json({error:'تعذر حفظ التقييم'});}
  };
}
module.exports={rateDriver};
