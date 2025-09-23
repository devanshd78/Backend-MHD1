// app.js
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const employeeRoutes = require('./routes/employee');
const adminRoutes    = require('./routes/admin');
const userRoutes     = require('./routes/user');
const entryRoutes    = require('./routes/entry');
const emailRoutes         = require('./routes/emailRoutes');
const missingRoutes       = require('./routes/missingRoutes');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || ['https://mhd.sharemitra.com','https://collabglam.com'],
  credentials: true,
}));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.use('/employee', employeeRoutes);
app.use('/admin',    adminRoutes);
app.use('/user',     userRoutes);
app.use('/entry',    entryRoutes);
app.use('/email',    emailRoutes);
app.use('/missing',      missingRoutes);  // missing routes under /api prefix

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