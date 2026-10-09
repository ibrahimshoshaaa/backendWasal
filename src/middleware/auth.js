const jwt = require('jsonwebtoken');
const { query } = require('../db');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'dev-secret-change-me') throw new Error('Configure a private JWT_SECRET');
function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, version: user.token_version || 0 }, JWT_SECRET, { expiresIn: '30d' });
}
async function verifyToken(token) {
  if (!token) return null;
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch (_) { return null; }
  const { rows } = await query('SELECT id, role, driver_status, token_version, email_verified FROM users WHERE id=$1', [payload.id]);
  const user = rows[0];
  if (!user || user.role !== payload.role || (payload.version || 0) !== user.token_version || !user.email_verified) return null;
  if (user.role === 'driver' && user.driver_status !== 'active') return null;
  if (user.role === 'merchant') {
    const { rows: merchants } = await query('SELECT status FROM merchants WHERE owner_user_id=$1', [user.id]);
    if (!merchants.length || merchants.some(m => m.status !== 'approved')) return null;
  }
  return { ...payload, role: user.role };
}
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    const payload = await verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'جلسة غير صالحة أو حساب موقوف، سجّل الدخول تاني' });
    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  } catch (err) { next(err); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) return res.status(403).json({ error: 'غير مصرح لك بهذا الإجراء' });
    next();
  };
}
module.exports = { signToken, verifyToken, requireAuth, requireRole, JWT_SECRET };
