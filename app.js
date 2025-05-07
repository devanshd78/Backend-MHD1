// app.js
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const employeeRoutes = require('./routes/employee');
const adminRoutes    = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
// CORS (allow credentials)
app.use(cors({
  origin:      process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.use('/employee', employeeRoutes);
app.use('/admin',    adminRoutes);

// ─── DB + SERVER START ───────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)  // no need for useNewUrlParser/useUnifiedTopology
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });
