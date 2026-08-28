const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

// Used by the WebSocket handshake (see server.js) to validate the token a
// client sends in its { type: 'auth', token } message. Returns the decoded
// payload ({ id, role }) or null if the token is missing/invalid/expired —
// callers should treat null the same as "not authenticated".
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'جلسة غير صالحة، سجّل الدخول تاني' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ error: 'غير مصرح لك بهذا الإجراء' });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth, requireRole, JWT_SECRET };
