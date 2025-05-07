// models/Admin.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const adminSchema = new mongoose.Schema({
  adminId: {
    type: String,
    default: uuidv4,      // auto-generate a UUID if you don’t pass one
    unique: true,
    index: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  // …any other fields…
});

module.exports = mongoose.model('Admin', adminSchema);
