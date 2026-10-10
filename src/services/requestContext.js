const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
async function setAuditContext(client, req = context.getStore()) {
  if (!req?.userId) return;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  await client.query("SELECT set_config('wasal.actor_id',$1,true),set_config('wasal.reason',$2,true)", [String(req.userId), reason]);
}
module.exports = { context, setAuditContext };
