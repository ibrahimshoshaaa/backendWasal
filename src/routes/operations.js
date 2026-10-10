const express=require('express');
const {query,pool,createNotification}=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {setAuditContext}=require('../services/requestContext');
const finance=require('../services/finance');
const router=express.Router();
const tables={store:'orders',trip:'trips',hataali:'hataali_orders'};
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function resource(req) {
  const table=tables[req.params.service],id=Number(req.params.id);
  if(!table||!Number.isSafeInteger(id)||id<1)fail(400,'الطلب غير صحيح');
  return {table,id,service:req.params.service};
}
router.use(requireAuth);
router.get('/public-settings',wrap(async(req,res)=>{
  const {rows}=await query("SELECT value FROM app_settings WHERE key='support_phone'");res.json({support_phone:rows[0]?.value||''});
}));
router.post('/jobs/:service/:id/support',requireRole('customer'),wrap(async(req,res)=>{
  const {table,id,service}=resource(req);const {category,message}=req.body||{};
  if(!['delay','driver','payment','other'].includes(category)||typeof message!=='string'||message.trim().length<3||message.length>1000)fail(400,'اختار نوع المشكلة واكتب تفاصيل من 3 إلى 1000 حرف');
  const {rows:jobs}=await query(`SELECT id FROM ${table} WHERE id=$1 AND customer_id=$2`,[id,req.userId]);if(!jobs.length)fail(404,'الطلب غير موجود');
  const {rows}=await query(`INSERT INTO support_requests(user_id,service,job_id,category,message) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,service,job_id) WHERE status='open' DO UPDATE SET category=EXCLUDED.category,message=EXCLUDED.message RETURNING *`,[req.userId,service,id,category,message.trim()]);
  res.json(rows[0]);
}));
router.get('/driver/statement',requireRole('driver'),wrap(async(req,res)=>{const {from,to}=finance.dates(req);res.json(await finance.statement(pool,req.userId,from,to));}));
router.use('/admin',requireRole('admin'));
router.get('/admin/jobs',wrap(async(req,res)=>{
  const service=req.query.service||'all',attention=req.query.attention||'all';
  if(!['all',...Object.keys(tables)].includes(service)||!['all','late','unassigned'].includes(attention))fail(400,'فلتر غير صحيح');
  const {rows}=await query(`WITH jobs AS (
    SELECT 'store'::text AS service,o.id,o.order_number AS title,o.status,o.driver_id,o.customer_id,o.created_at,
      COALESCE(o.picked_up_at,o.ready_at,o.accepted_at,o.created_at) AS stage_at,a.address_text AS address FROM orders o LEFT JOIN addresses a ON a.id=o.address_id
    UNION ALL SELECT 'trip',id,CASE WHEN type='wassalni' THEN 'وصّلني' ELSE 'وصّل لي' END,status,driver_id,customer_id,created_at,updated_at,dropoff_address FROM trips
    UNION ALL SELECT 'hataali',id,title,status,driver_id,customer_id,created_at,updated_at,delivery_address FROM hataali_orders
  ), enriched AS (SELECT j.*,c.full_name AS customer_name,c.phone AS customer_phone,d.full_name AS driver_name,
    FLOOR(EXTRACT(EPOCH FROM NOW()-COALESCE((SELECT MAX(created_at) FROM job_events e WHERE e.service=j.service AND e.job_id=j.id AND e.event='status'),stage_at))/60)::int AS stage_minutes,
    driver_id IS NULL AND status IN ('ready','approved','pending') AS unassigned
    FROM jobs j JOIN users c ON c.id=j.customer_id LEFT JOIN users d ON d.id=j.driver_id WHERE j.status NOT IN ('delivered','cancelled','rejected'))
    SELECT *,stage_minutes >= COALESCE((SELECT value::int FROM app_settings WHERE key='late_minutes'),30) AS late
    FROM enriched WHERE ($1='all' OR service=$1) AND ($2='all' OR ($2='unassigned' AND unassigned) OR ($2='late' AND stage_minutes >= COALESCE((SELECT value::int FROM app_settings WHERE key='late_minutes'),30)))
    ORDER BY stage_minutes DESC,id LIMIT 100`,[service,attention]);res.json({jobs:rows,limit:100});
}));
router.get('/admin/jobs/:service/:id/history',wrap(async(req,res)=>{
  const {table,id,service}=resource(req);if(!(await query(`SELECT id FROM ${table} WHERE id=$1`,[id])).rows.length)fail(404,'الطلب غير موجود');
  const {rows}=await query(`SELECT e.*,u.full_name AS actor_name FROM job_events e LEFT JOIN users u ON u.id=e.actor_id WHERE service=$1 AND job_id=$2 ORDER BY e.created_at,id`,[service,id]);res.json(rows);
}));
router.put('/admin/jobs/:service/:id/driver',wrap(async(req,res)=>{
  const {table,id,service}=resource(req);const {driver_id,expected_driver_id,expected_status,reason}=req.body||{};
  if(!Object.hasOwn(req.body,'expected_driver_id')||typeof expected_status!=='string'||typeof reason!=='string'||reason.trim().length<3||reason.length>500)fail(400,'الحالة الحالية وسبب إعادة الإسناد مطلوبان');
  if(driver_id!==null&&(!Number.isSafeInteger(driver_id)||driver_id<1))fail(400,'اختار مندوب صحيح');
  let client;let job;let oldDriver;
  try {
    client=await pool.connect();await client.query('BEGIN');await setAuditContext(client,req);
    const found=await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);job=found.rows[0];if(!job)fail(404,'الطلب غير موجود');
    if(job.status!==expected_status||job.driver_id!==expected_driver_id)fail(409,'الطلب اتغير؛ حدّث القائمة قبل إعادة الإسناد');
    const allowed=service==='store'?['ready']:service==='trip'?['pending','accepted']:['approved'];
    if(!allowed.includes(job.status))fail(409,'إعادة الإسناد متاحة قبل الاستلام أو بدء الرحلة فقط');
    if(driver_id===job.driver_id)fail(400,'المندوب ده معيّن بالفعل');
    if(driver_id!==null) {
      const {rows}=await client.query("SELECT id,gender FROM users WHERE id=$1 AND role='driver' AND driver_status='active' FOR SHARE",[driver_id]);
      if(!rows.length)fail(400,'المندوب غير مفعل');
      if(service==='trip'&&job.preferred_gender&&rows[0].gender!==job.preferred_gender)fail(400,'نوع المندوب لا يطابق اختيار العميل');
    }
    oldDriver=job.driver_id;
    const extras=service==='trip'?",status='pending',updated_at=now(),delivery_otp=NULL":service==='hataali'?',updated_at=now()':'';
    job=(await client.query(`UPDATE ${table} SET driver_id=$1${extras} WHERE id=$2 RETURNING *`,[driver_id,id])).rows[0];await client.query('COMMIT');
  } catch(e) {if(client)await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client?.release();}
  for(const userId of [oldDriver,driver_id,job.customer_id].filter(Boolean)) {
    const title=userId===oldDriver?'تم تغيير إسناد الطلب':userId===driver_id?'تم إسناد طلب إليك':'تم تحديث مندوب طلبك';
    createNotification(userId,{title,body:`طلب #${id}`,type:'assignment',service,resourceId:id,orderId:service==='store'?id:undefined}).catch(()=>{});
    req.app.locals.sendToUser?.(userId,{type:'notification',notifType:'assignment',title,service,orderId:id});
  }
  res.json({ok:true,job});
}));
router.get('/admin/support',wrap(async(req,res)=>{
  const {rows}=await query(`SELECT s.*,u.full_name AS customer_name,u.phone AS customer_phone FROM support_requests s JOIN users u ON u.id=s.user_id WHERE s.status='open' ORDER BY s.created_at LIMIT 100`);res.json(rows);
}));
router.put('/admin/support/:id/resolve',wrap(async(req,res)=>{
  const {rows}=await query("UPDATE support_requests SET status='resolved',resolved_by=$1,resolved_at=now() WHERE id=$2 AND status='open' RETURNING *",[req.userId,req.params.id]);if(!rows.length)fail(409,'البلاغ اتغير أو اتقفل بالفعل');res.json({ok:true});
}));
router.get('/admin/drivers/:id/statement',wrap(async(req,res)=>{
  const id=Number(req.params.id);if(!(await query("SELECT id FROM users WHERE id=$1 AND role='driver'",[id])).rows.length)fail(404,'المندوب غير موجود');const {from,to}=finance.dates(req);res.json(await finance.statement(pool,id,from,to));
}));
router.put('/admin/drivers/:id/ledger/:entry/confirm',wrap(async(req,res)=>{
  const reason=req.body?.reason;if(typeof reason!=='string'||reason.trim().length<3)fail(400,'سبب التأكيد مطلوب');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');await setAuditContext(client,req);await client.query('SELECT pg_advisory_xact_lock(78452,$1)',[req.params.id]);
    const {rows}=await client.query('SELECT * FROM delivery_ledger WHERE id=$1 AND driver_id=$2 FOR UPDATE',[req.params.entry,req.params.id]);const entry=rows[0];if(!entry)fail(404,'القيد غير موجود');
    if(entry.cash_collected!==null&&((entry.service!=='hataali'||entry.purchase_cost!==null)&&(entry.service!=='store'||entry.merchant_paid!==null)))fail(409,'القيد مؤكد بالفعل');
    const {cash,cost,merchantPaid}=finance.collection(req.body,entry.service);if(cash===null)fail(400,'التحصيل الفعلي مطلوب');
    if(entry.service==='store'&&merchantPaid>Number(entry.merchant_due))fail(400,'المدفوع للمتجر أكبر من قيمة المنتجات');
    await client.query('UPDATE delivery_ledger SET cash_collected=$1,purchase_cost=$2,merchant_paid=$4,merchant_due=merchant_due-COALESCE($4,0) WHERE id=$3',[cash,cost,entry.id,merchantPaid]);
    await client.query(`INSERT INTO job_events(service,job_id,actor_id,actor_role,event,reason,details) VALUES($1,$2,$3,'admin','collection_confirmed',$4,$5)`,[entry.service,entry.job_id,req.userId,reason.trim().slice(0,500),JSON.stringify({cash_collected:cash,purchase_cost:cost,merchant_paid:merchantPaid})]);
    await client.query('COMMIT');res.json({ok:true});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}));
router.post('/admin/drivers/:id/settlements',wrap(async(req,res)=>{
  const {direction,reason,expected_balance}=req.body||{};const amount=finance.money(req.body?.amount),key=req.get('Idempotency-Key');
  if(amount<=0||!['driver_to_platform','platform_to_driver'].includes(direction)||typeof reason!=='string'||reason.trim().length<3||reason.length>500||!key||!/^[A-Za-z0-9_-]{16,128}$/.test(key)||!Number.isFinite(Number(expected_balance)))fail(400,'بيانات التسوية أو رقم المحاولة غير صحيح');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(78452,$1)',[req.params.id]);
    const existing=(await client.query('SELECT * FROM driver_settlements WHERE driver_id=$1 AND request_key=$2',[req.params.id,key])).rows[0];
    if(existing){if(existing.actor_id!==req.userId||existing.direction!==direction||Number(existing.amount)!==amount||existing.reason!==reason.trim())fail(409,'محاولة التسوية اتغيرت');await client.query('COMMIT');return res.json(existing);}
    const account=await finance.balance(client,req.params.id);
    if(account.unconfirmed)fail(409,'أكد التحصيل الفعلي للطلبات غير المؤكدة قبل التسوية');
    const rounded=n=>Math.round(n*100);if(rounded(account.balance)!==rounded(Number(expected_balance)))fail(409,'الرصيد اتغير؛ حدّث كشف الحساب');
    if((direction==='driver_to_platform'&&account.balance<=0)||(direction==='platform_to_driver'&&account.balance>=0)||rounded(amount)>rounded(Math.abs(account.balance)))fail(400,'المبلغ أو اتجاه التسوية لا يطابق الرصيد');
    const {rows}=await client.query('INSERT INTO driver_settlements(driver_id,actor_id,direction,amount,reason,request_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.params.id,req.userId,direction,amount,reason.trim(),key]);await client.query('COMMIT');res.json(rows[0]);
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}));
module.exports=router;
