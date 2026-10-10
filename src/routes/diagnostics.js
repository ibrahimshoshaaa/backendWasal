const express=require('express');
const {query}=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const rateLimit=require('express-rate-limit');
const router=express.Router();const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
router.use(requireAuth);
router.post('/',rateLimit({windowMs:60000,max:10,standardHeaders:true,legacyHeaders:false}),wrap(async(req,res)=>{
  const {code,context}=req.body||{};
  if(typeof code!=='string'||!/^[A-Za-z0-9_.]{1,80}$/.test(code)||!['framework','async','network','gps'].includes(context))return res.status(400).json({error:'بيانات العطل غير صحيحة'});
  await query('INSERT INTO diagnostic_events(source,user_id,route,code) VALUES(\'client\',$1,$2,$3)',[req.userId,context,code]);res.json({ok:true});
}));
router.get('/',requireRole('admin'),wrap(async(req,res)=>{
  const {rows}=await query("SELECT id,request_id,source,route,code,created_at FROM diagnostic_events WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100");res.json(rows);
}));
router.put('/:id/resolve',requireRole('admin'),wrap(async(req,res)=>{
  const {rowCount}=await query('UPDATE diagnostic_events SET resolved_by=$1,resolved_at=now() WHERE id=$2 AND resolved_at IS NULL',[req.userId,req.params.id]);if(!rowCount)return res.status(409).json({error:'العطل اتقفل بالفعل أو غير موجود'});res.json({ok:true});
}));
module.exports=router;
