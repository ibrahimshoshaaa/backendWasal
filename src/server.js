require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initSchema } = require('./db');
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
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

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

// Fallback error handler (e.g. multer file-type rejection).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'حدث خطأ غير متوقع' });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Wasal backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
