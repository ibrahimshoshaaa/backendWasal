require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { initSchema } = require('./db');
const { verifyToken } = require('./middleware/auth');
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

const app = express();
app.use(cors());
app.use(express.json());

// ملاحظة: تم حذف app.use('/uploads', express.static(...))
// كل الصور الجديدة بترفع لـ Cloudinary وبتترجع بروابط secure_url كاملة،
// فمافيش داعي لتقديم أي حاجة static من قرص السيرفر.
// الصور القديمة اللي روابطها كانت /uploads/... مش هترجع من هنا — لو لسه
// موجودة في قاعدة البيانات هتظهر مكسورة (نفس الوضع الحالي بعد أول Redeploy).

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/notifications', notificationsRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'حدث خطأ غير متوقع' });
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

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        const payload = verifyToken(msg.token);
        if (!payload) { ws.close(); return; }
        userId = String(payload.id);
        registerClient(userId, ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      }
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (userId) removeClient(userId, ws);
  });
});

// Attach sendToUser globally so routes can use it
app.locals.sendToUser = sendToUser;

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    server.listen(PORT, () => console.log(`Wasal backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
