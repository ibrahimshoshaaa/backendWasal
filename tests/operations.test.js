const test=require('node:test');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');const {query,pool}=require('../src/db');const {signToken}=require('../src/middleware/auth');
const api='http://127.0.0.1:32180/api';
async function request(path,method='GET',token,body,key) {
  const res=await fetch(api+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
  return {status:res.status,body:await res.json(),headers:res.headers};
}
test('operations, immutable accounting, settlements, support and diagnostics',async t=>{
  const server=spawn(process.execPath,['src/server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,PORT:'32180'},stdio:'pipe'});
  let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
  let original=[];
  try {
    let ready=false;for(let i=0;i<150;i++){try{ready=(await request('/health')).status===200;}catch(_){}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,output);
    original=(await query("SELECT key,value FROM app_settings WHERE key IN ('commission_percent','late_minutes')")).rows;
    const user=async role=>(await query("INSERT INTO users(full_name,email,password_hash,role,email_verified,driver_status,is_online,gender) VALUES($1,$2,'test',$1,true,'active',true,'male') RETURNING *",[role,randomUUID()+'@example.test'])).rows[0];
    const customer=await user('customer'),other=await user('customer'),driver=await user('driver'),replacement=await user('driver'),admin=await user('admin');
    const ct=signToken(customer),ot=signToken(other),dt=signToken(driver),rt=signToken(replacement),at=signToken(admin);
    const merchant=(await query("INSERT INTO merchants(name,status) VALUES('Operations shop','approved') RETURNING id")).rows[0];
    let store,trip,errand;
    await t.test('settings validate atomically and commission is snapshotted per new job',async()=>{
      assert.equal((await request('/admin/settings','PUT',at,{commission_percent:'101',late_minutes:'5'})).status,400);
      assert.equal((await request('/admin/settings','PUT',at,{commission_percent:'10',late_minutes:'5'})).status,200);
      store=(await query("INSERT INTO orders(customer_id,merchant_id,driver_id,items_json,status,subtotal,delivery_fee,total,delivery_otp) VALUES($1,$2,$3,'[]','picked_up',100,10,110,'1234') RETURNING *",[customer.id,merchant.id,driver.id])).rows[0];
      assert.equal(Number(store.commission_percent),10);
      await request('/admin/settings','PUT',at,{commission_percent:'20'});
      assert.equal(Number((await query('SELECT commission_percent FROM orders WHERE id=$1',[store.id])).rows[0].commission_percent),10);
      trip=(await query("INSERT INTO trips(customer_id,driver_id,type,pickup_address,dropoff_address,status,price) VALUES($1,$2,'wassalni','A','B','picked_up',50) RETURNING *",[customer.id,driver.id])).rows[0];
      errand=(await query("INSERT INTO hataali_orders(customer_id,driver_id,title,status,delivery_fee,approx_price,delivery_otp) VALUES($1,$2,'Ledger errand','picked_up',35,999,'1234') RETURNING *",[customer.id,driver.id])).rows[0];
    });
    await t.test('cash and supplier payments produce the correct signed balance without counting estimated prices',async()=>{
      assert.equal((await request(`/driver/orders/${store.id}/deliver`,'PUT',dt,{otp:'1234',cash_collected:110,merchant_paid:101})).status,400);
      assert.equal((await request(`/driver/orders/${store.id}/deliver`,'PUT',dt,{otp:'1234',cash_collected:110,merchant_paid:100})).status,200);
      assert.equal((await request(`/trips/${trip.id}/deliver`,'POST',dt,{cash_collected:50})).status,200);
      assert.equal((await request(`/hataali/${errand.id}/deliver`,'POST',dt,{otp:'1234',cash_collected:135})).status,400);
      assert.equal((await request(`/hataali/${errand.id}/deliver`,'POST',dt,{otp:'1234',cash_collected:135,purchase_cost:100})).status,200);
      const result=await request('/operations/driver/statement','GET',dt);assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(result.body.account.balance,18);assert.equal(Number(result.body.summary.driver_net),77);assert.equal(Number(result.body.summary.commission),18);
      const e=result.body.entries.find(e=>e.service==='hataali'&&e.job_id===errand.id);assert.equal(Number(e.order_value),135);assert.equal(Number(e.purchase_cost),100);
      assert.equal(result.body.account.unconfirmed,0);
      const history=await request(`/operations/admin/jobs/store/${store.id}/history`,'GET',at);assert.ok(history.body.some(e=>e.event==='status'&&e.actor_id===driver.id&&e.actor_role==='driver'));
      assert.notEqual((await request(`/admin/orders/${store.id}/status`,'PUT',at,{status:'ready'})).status,200);
      assert.equal((await request('/operations/admin/drivers/'+driver.id+'/statement','GET',ct)).status,403);
      assert.equal((await request('/operations/driver/statement?from=2026-02-30','GET',dt)).status,400);
    });
    await t.test('settlements are serialized, single-use and reject stale balances or excess amounts',async()=>{
      const path=`/operations/admin/drivers/${driver.id}/settlements`,body={direction:'driver_to_platform',amount:10,reason:'Cash received',expected_balance:18};
      const results=await Promise.all([request(path,'POST',at,body,'settlement-test-123456789'),request(path,'POST',at,body,'settlement-test-123456789')]);
      assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(results[0].body.id,results[1].body.id);
      assert.equal((await request(path,'POST',at,{...body,expected_balance:18},'settlement-stale-12345678')).status,409);
      assert.equal((await request(path,'POST',at,{...body,amount:9,expected_balance:8},'settlement-excess-1234567')).status,400);
      assert.equal((await request(path,'POST',at,{...body,amount:8,expected_balance:8},'settlement-final-12345678')).status,200);
      assert.equal((await request('/operations/driver/statement','GET',dt)).body.account.balance,0);
    });
    await t.test('older unconfirmed collections block settlements until an audited admin confirmation',async()=>{
      const legacy=(await query("INSERT INTO orders(customer_id,merchant_id,driver_id,items_json,status,subtotal,total,delivery_fee) VALUES($1,$2,$3,'[]','delivered',100,110,10) RETURNING id",[customer.id,merchant.id,replacement.id])).rows[0];
      const statement=(await request(`/operations/admin/drivers/${replacement.id}/statement`,'GET',at)).body;assert.equal(statement.account.unconfirmed,1);
      assert.equal((await request(`/operations/admin/drivers/${replacement.id}/settlements`,'POST',at,{direction:'driver_to_platform',amount:2,expected_balance:0,reason:'Legacy cash'},'legacy-settlement-1234567')).status,409);
      const entry=statement.entries.find(e=>e.job_id===legacy.id&&e.service==='store');
      const path=`/operations/admin/drivers/${replacement.id}/ledger/${entry.id}/confirm`;
      const body={cash_collected:110,merchant_paid:100,reason:'Verified collection'};
      assert.equal((await request(path,'PUT',at,body)).status,200);assert.equal((await request(path,'PUT',at,body)).status,409);
      assert.equal((await request(`/operations/admin/drivers/${replacement.id}/statement`,'GET',at)).body.account.balance,2);
    });
    await t.test('reassignment is compare-and-swap and is respected by all driver acceptance routes',async()=>{
      for(const [service,table,status,fields,values] of [['trip','trips','pending',"type,pickup_address,dropoff_address","'wassalni','A','B'"],['hataali','hataali_orders','approved','title',"'Assigned errand'"],['store','orders','ready','merchant_id,items_json',`${merchant.id},'[]'`]]) {
        const job=(await query(`INSERT INTO ${table}(customer_id,status,${fields}) VALUES($1,$2,${values}) RETURNING *`,[customer.id,status])).rows[0];
        const path=`/operations/admin/jobs/${service}/${job.id}/driver`;const body={driver_id:driver.id,expected_driver_id:null,expected_status:status,reason:'Assign ready job'};
        assert.equal((await request(path,'PUT',at,body)).status,200);assert.equal((await request(path,'PUT',at,body)).status,409);
        assert.equal((await request(path,'PUT',at,{...body,driver_id:replacement.id,expected_driver_id:driver.id,reason:'Replace assigned driver'})).status,200);
        const accept=service==='store'?`/driver/orders/${job.id}/accept`:`/${service==='trip'?'trips':'hataali'}/${job.id}/accept`;const method=service==='store'?'PUT':'POST';
        assert.notEqual((await request(accept,method,dt)).status,200);assert.equal((await request(accept,method,rt)).status,200);
        const history=(await request(`/operations/admin/jobs/${service}/${job.id}/history`,'GET',at)).body;assert.ok(history.some(e=>e.actor_id===admin.id&&e.reason==='Replace assigned driver'));
      }
      const active=await request(`/operations/admin/jobs/store/${store.id}/driver`,'PUT',at,{driver_id:replacement.id,expected_driver_id:driver.id,expected_status:'delivered',reason:'Cannot reassign'});assert.equal(active.status,409);
    });
    await t.test('late and unassigned filters use service-specific IDs',async()=>{
      const job=(await query("INSERT INTO trips(customer_id,type,pickup_address,dropoff_address,created_at,updated_at) VALUES($1,'wassalni','Late','B',now()-interval '1 hour',now()-interval '1 hour') RETURNING id",[customer.id])).rows[0];
      const list=await request('/operations/admin/jobs?service=trip&attention=late','GET',at);assert.ok(list.body.jobs.some(j=>j.id===job.id&&j.late&&j.unassigned));
      assert.equal((await request('/operations/admin/jobs','GET',dt)).status,403);
    });
    await t.test('support reports enforce ownership, deduplicate open reports and can be resolved',async()=>{
      const path=`/operations/jobs/store/${store.id}/support`;const body={category:'payment',message:'Review the payment'};
      assert.equal((await request(path,'POST',ot,body)).status,404);const a=await request(path,'POST',ct,body),b=await request(path,'POST',ct,body);assert.equal(a.body.id,b.body.id);
      assert.ok((await request('/operations/admin/support','GET',at)).body.some(r=>r.id===a.body.id));
      assert.equal((await request(`/operations/admin/support/${a.body.id}/resolve`,'PUT',at,{})).status,200);
    });
    await t.test('diagnostics retain references and categories, never raw client errors or tokens',async()=>{
      assert.equal((await request('/diagnostics','POST',ct,{code:'SocketException',context:'network',message:'PRIVATE_DO_NOT_STORE'})).status,200);
      const error=await request('/admin/orders/not-a-number','GET',at);assert.equal(error.status,500);assert.equal(error.body.request_id,error.headers.get('x-request-id'));
      await new Promise(r=>setTimeout(r,100));const reports=await request('/diagnostics','GET',at);assert.equal(reports.status,200);assert.ok(reports.body.some(r=>r.request_id===error.body.request_id));assert.equal(JSON.stringify(reports.body).includes('PRIVATE_DO_NOT_STORE'),false);
      assert.equal((await request('/diagnostics','GET',dt)).status,403);assert.equal((await request('/diagnostics','POST',ct,{code:'secret with spaces',context:'network'})).status,400);
    });
  }finally{for(const s of original)await query('UPDATE app_settings SET value=$1 WHERE key=$2',[s.value,s.key]);server.kill();await pool.end();}
});
