require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const employeeRoutes = require('./routes/employee');
const adminRoutes    = require('./routes/admin');
const userRoutes     = require('./routes/user');
const entryRoutes    = require('./routes/entry');
const emailRoutes    = require('./routes/emailRoutes');
const missingRoutes  = require('./routes/missingRoutes');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── CORS CONFIG ─────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// If env not set, fallback to defaults
if (!allowedOrigins.length) {
  allowedOrigins.push('https://mhd.sharemitra.com', 'https://collabglam.com', 'http://localhost:3000');
}

console.log('✅ Allowed origins:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g. Postman, mobile apps)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`❌ Not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));

// ─── BODY PARSERS ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.use('/employee', employeeRoutes);
app.use('/admin',    adminRoutes);
app.use('/user',     userRoutes);
app.use('/entry',    entryRoutes);
app.use('/email',    emailRoutes);
app.use('/missing',  missingRoutes);

// ─── DB + SERVER START ───────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () =>
      console.log(`🚀 Server listening on port ${PORT}`)
    );
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });
