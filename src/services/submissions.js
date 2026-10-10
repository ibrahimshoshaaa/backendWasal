const { createHash } = require('node:crypto');
const { setAuditContext } = require('./requestContext');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'variant' }) || (a < b ? -1 : a > b ? 1 : 0)).map(k => [k, canonical(value[k])]));
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

async function prepareSubmission(client, req, service, lockCustomer = false) {
  await client.query('BEGIN');
  await setAuditContext(client, req);
  if (lockCustomer) await client.query('SELECT pg_advisory_xact_lock($1)', [req.userId]);
  return beginSubmission(client, req, service);
}

async function commitSubmission(client, submission, response) {
  await completeSubmission(client, submission, response);
  await client.query('COMMIT');
  client.release();
  return response;
}

async function respondSubmissionError(client, created, error, res, source, message) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  if (created) {
    console.error('Post-commit notification failed:', error);
    return res.json(created);
  }
  if (error.status) return res.status(error.status).json({ error: error.message });
  console.error(source, error);
  return res.status(500).json({ error: message });
}

module.exports = { prepareSubmission, commitSubmission, respondSubmissionError };
