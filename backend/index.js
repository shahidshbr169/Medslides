require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration - uses FRONTEND_URL from .env
const allowedOrigins = [
  process.env.FRONTEND_URL || 'https://medslides.in',
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
  /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/
];
app.use(cors({
  origin: allowedOrigins
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// API Routes
app.use('/api/products', require('./routes/products'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/download', require('./routes/download'));
app.use('/api/admin', require('./routes/admin'));

// Health check route
app.get('/', (req, res) => {
  res.json({ status: "ok", service: "MedSlides API" });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
