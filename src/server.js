require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { initSchema } = require('./db');
const { verifyToken, requireAuth } = require('./middleware/auth');
const { router: authRoutes } = require('./routes/auth');
const categoriesRoutes = require('./routes/categories');
const merchantsRoutes = require('./routes/merchants');
const productsRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const ordersRoutes = require('./routes/orders');
const addressesRoutes = require('./routes/addresses');
const merchantPanelRoutes = require('./routes/merchantPanel');
const driverPanelRoutes = require('./routes/driverPanel');
const adminRoutes = require('./routes/admin');
const uploadRoutes = require('./routes/upload');
const usersRoutes = require('./routes/users');
const notificationsRoutes = require('./routes/notifications');
const deviceTokensRoutes = require('./routes/deviceTokens');
const adsRoutes = require('./routes/ads');
const hataaliRoutes = require('./routes/hataali');
const tripsRoutes   = require('./routes/trips');

const app = express();
// Railway بيحط السيرفر ورا proxy، فلازم trust proxy عشان express-rate-limit
// (وأي حاجة تانية بتعتمد على req.ip) تقرأ الـ IP الحقيقي بتاع المستخدم مش IP الـ proxy.
app.set('trust proxy', 1);
app.use(cors());
app.use(require('./services/diagnostics').middleware);
app.use(express.json());
function staffSafe(value) {
  if (Array.isArray(value)) return value.map(staffSafe);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'delivery_otp').map(([key, v]) => [key, staffSafe(v)]));
}
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = value => json(['driver', 'merchant'].includes(req.userRole) ? staffSafe(value) : value);
  next();
});

// ملاحظة: تم حذف app.use('/uploads', express.static(...))
// كل الصور الجديدة بترفع لـ Cloudinary وبتترجع بروابط secure_url كاملة،
// فمافيش داعي لتقديم أي حاجة static من قرص السيرفر.
// الصور القديمة اللي روابطها كانت /uploads/... مش هترجع من هنا — لو لسه
// موجودة في قاعدة البيانات هتظهر مكسورة (نفس الوضع الحالي بعد أول Redeploy).

app.get('/api/health', (req, res) => res.json({ ok: true }));

const deliveryLimiter = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات كود كتير، حاول لاحقاً' } });
app.use(['/api/driver/orders/:id/deliver', '/api/hataali/:id/deliver', '/api/trips/:id/pickup'], requireAuth, deliveryLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/merchants', merchantsRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/addresses', addressesRoutes);
app.use('/api/merchant', merchantPanelRoutes);
app.use('/api/driver', driverPanelRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/operations',require('./routes/operations'));
app.use('/api/diagnostics',require('./routes/diagnostics'));
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/devices', deviceTokensRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/hataali', requireAuth, hataaliRoutes);
app.use('/api/trips',   requireAuth, tripsRoutes);

app.use((err, req, res, next) => {
  req.errorCode = /^[A-Za-z0-9_]{1,40}$/.test(err.code||'') ? err.code : err.name || 'Error';
  const status = err.status || (err.code==='23514' ? 409 : 500);
  res.status(status).json({ error: err.status ? err.message : err.code==='23514' ? 'حالة الطلب لا تسمح بالتغيير' : 'حدث خطأ غير متوقع' });
});

// ─── WebSocket server ──────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Map: userId (string) -> Set of ws connections
const clients = new Map();

function registerClient(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
}

function removeClient(userId, ws) {
  clients.get(userId)?.delete(ws);
}

// Send JSON event to a specific user (all their open connections)
function sendToUser(userId, event) {
  const conns = clients.get(String(userId));
  if (!conns) return;
  const msg = JSON.stringify(event);
  for (const ws of conns) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  // Client authenticates by sending: { type: 'auth', token: '...' }
  let userId = null;
  let expiryTimer;
  const authTimer = setTimeout(() => { if (!userId) ws.close(1008, 'Authentication required'); }, 10000);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        const payload = await verifyToken(msg.token);
        if (!payload) { ws.close(); return; }
        if (userId) removeClient(userId, ws);
        userId = String(payload.id);
        registerClient(userId, ws);
        clearTimeout(authTimer);
        clearInterval(expiryTimer);
        // Recheck long-lived sockets as well as HTTP requests.
        expiryTimer = setInterval(async () => {
          try { if (!await verifyToken(msg.token)) ws.close(1008, 'Session revoked'); } catch (_) { ws.close(1011); }
        }, 60000);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      }
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    clearInterval(expiryTimer);
    if (userId) removeClient(userId, ws);
  });
});

// Attach sendToUser globally so routes can use it
app.locals.sendToUser = sendToUser;
app.locals.disconnectUser = userId => {
  for (const ws of clients.get(String(userId)) || []) ws.close(1008, 'Session revoked');
  clients.delete(String(userId));
};

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    server.listen(PORT, () => console.log(`Wasal backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

