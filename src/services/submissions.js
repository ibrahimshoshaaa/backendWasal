const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

// Called inside the same transaction as the order INSERT. The transaction
// lock serializes concurrent retries; a crash rolls back both records.
async function beginSubmission(client, req, service) {
  const key = req.get('Idempotency-Key');
  if (!key) return null; // Compatibility with existing app releases.
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw Object.assign(new Error('رقم محاولة الإرسال غير صحيح'), { status: 400 });
  }
  const hash = createHash('sha256').update(JSON.stringify(canonical(req.body || {}))).digest('hex');
  const lock = `${req.userId}:${service}:${key}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
  const { rows } = await client.query(
    'SELECT request_hash, response FROM order_submissions WHERE user_id=$1 AND service=$2 AND request_key=$3',
    [req.userId, service, key]);
  if (rows.length && rows[0].request_hash !== hash) {
    throw Object.assign(new Error('بيانات محاولة الإرسال اتغيرت؛ راجع طلباتك قبل إرسال طلب جديد'), { status: 409 });
  }
  return { key, hash, service, userId: req.userId, response: rows[0]?.response };
}

async function completeSubmission(client, submission, response) {
  if (!submission) return;
  await client.query(
    'INSERT INTO order_submissions(user_id,service,request_key,request_hash,response) VALUES($1,$2,$3,$4,$5)',
    [submission.userId, submission.service, submission.key, submission.hash, JSON.stringify(response)]);
}

module.exports = { beginSubmission, completeSubmission };
