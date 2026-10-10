const {randomUUID}=require('node:crypto');
const {context}=require('./requestContext');
function middleware(req,res,next) {
  req.requestId=randomUUID();res.set('X-Request-ID',req.requestId);
  let route='unknown';
  const json=res.json.bind(res);
  res.json=value=>{
    route=req.route?`${req.baseUrl}${req.route.path}`:'unknown';
    if(res.statusCode>=500&&value&&typeof value==='object'&&!Array.isArray(value))value={...value,request_id:req.requestId};
    return json(value);
  };
  res.on('finish',()=>{
    if(res.statusCode<500||route.includes('diagnostics'))return;
    const code=req.errorCode || `HTTP_${res.statusCode}`;
    console.error(JSON.stringify({level:'error',request_id:req.requestId,route,code,time:new Date().toISOString()}));
    const {pool}=require('../db');
    pool.query('INSERT INTO diagnostic_events(request_id,source,user_id,route,code) VALUES($1,\'server\',$2,$3,$4)',[req.requestId,req.userId||null,route.slice(0,160),code]).catch(()=>{});
  });
  context.run(req,next);
}
module.exports={middleware};
