// models/Entry.js
const mongoose = require('mongoose');

const entrySchema = new mongoose.Schema({
  linkId:     { type: String, ref: 'Link', required: true },
  employeeId: { type: String, ref: 'Employee', required: true },
  name:       { type: String, required: true },
  upiId:      { type: String, required: true },
  amount:     { type: Number, required: true },
  createdAt:  { type: Date,   default: Date.now }
});

// ← enforce uniqueness of (linkId, upiId) pairs:
entrySchema.index({ linkId: 1, upiId: 1 }, { unique: true });

module.exports = mongoose.model('Entry', entrySchema);
