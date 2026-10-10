const money = value => {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value)) || Number(value)>10000000) throw Object.assign(new Error('المبلغ لازم يكون موجب أو صفر وبحد أقصى منزلتين عشريتين'),{status:400});
  return Number(value);
};
function collection(body, service) {
  const cash = body?.cash_collected == null ? null : money(body.cash_collected);
  const cost = service==='hataali' && body?.purchase_cost != null ? money(body.purchase_cost) : null;
  if (service==='hataali' && cash!==null && cost===null) throw Object.assign(new Error('تكلفة الشراء الفعلية مطلوبة؛ اكتب صفر لو مفيش شراء'),{status:400});
  const merchantPaid = service==='store' && body?.merchant_paid != null ? money(body.merchant_paid) : null;
  if(service==='store'&&cash!==null&&merchantPaid===null)throw Object.assign(new Error('المبلغ المدفوع للمتجر مطلوب؛ اكتب صفر لو لم تدفع له'),{status:400});
  return {cash,cost,merchantPaid};
}
const confirmed = "cash_collected IS NOT NULL AND (service<>'hataali' OR purchase_cost IS NOT NULL) AND (service<>'store' OR merchant_paid IS NOT NULL)";
async function balance(client, driverId) {
  const {rows} = await client.query(`SELECT
    COALESCE(SUM(cash_collected-driver_net-COALESCE(purchase_cost,0)-COALESCE(merchant_paid,0)) FILTER(WHERE ${confirmed}),0)
      - COALESCE((SELECT SUM(CASE WHEN direction='driver_to_platform' THEN amount ELSE -amount END) FROM driver_settlements WHERE driver_id=$1),0) AS balance,
    COUNT(*) FILTER(WHERE NOT (${confirmed}))::int AS unconfirmed FROM delivery_ledger WHERE driver_id=$1`,[driverId]);
  return {balance:Number(rows[0].balance),unconfirmed:rows[0].unconfirmed};
}
async function statement(client, driverId, from, to) {
  const summary=await client.query(`SELECT COUNT(*)::int AS count,
    COALESCE(SUM(delivery_fee),0) AS delivery_fees,COALESCE(SUM(commission),0) AS commission,
    COALESCE(SUM(driver_net),0) AS driver_net, COALESCE(SUM(merchant_due),0) AS merchant_due,
    COALESCE(SUM(purchase_cost),0) AS purchase_cost,COALESCE(SUM(cash_collected),0) AS cash_collected,
    COUNT(*) FILTER(WHERE NOT (${confirmed}))::int AS unconfirmed
    FROM delivery_ledger WHERE driver_id=$1 AND delivered_at >= ($2::date::timestamp AT TIME ZONE 'Africa/Cairo')
    AND delivered_at < (($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')`,[driverId,from,to]);
  const entries=await client.query(`SELECT * FROM delivery_ledger WHERE driver_id=$1
    AND delivered_at >= ($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND delivered_at < (($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')
    ORDER BY delivered_at DESC,id DESC LIMIT 200`,[driverId,from,to]);
  const settlements=await client.query(`SELECT s.*,u.full_name AS actor_name FROM driver_settlements s JOIN users u ON u.id=s.actor_id
    WHERE s.driver_id=$1 AND s.created_at >= ($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND s.created_at < (($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo')
    ORDER BY s.created_at DESC LIMIT 200`,[driverId,from,to]);
  return {from,to,summary:summary.rows[0],entries:entries.rows,settlements:settlements.rows,account:await balance(client,driverId),limit:200};
}
function dates(req) {
  const cairo=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const from=req.query.from || new Date(Date.parse(cairo+'T00:00:00Z')-29*86400000).toISOString().slice(0,10), to=req.query.to || cairo;
  for(const value of [from,to]) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value) throw Object.assign(new Error('الفترة غير صحيحة'),{status:400});
  }
  if(from>to||Date.parse(to)-Date.parse(from)>366*86400000)throw Object.assign(new Error('اختار فترة لا تزيد عن سنة'),{status:400});
  return {from,to};
}
module.exports={money,collection,balance,statement,dates};
