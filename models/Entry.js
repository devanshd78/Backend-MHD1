const mongoose = require('mongoose');

const entrySchema = new mongoose.Schema({
  linkId: { type: String, ref: 'Link', required: true },
  employeeId: { type: String, ref: 'Employee', required: true },
  name: { type: String, required: true, trim: true },
  upiId: {
    type: String,
    required: true,
    trim: true,
    match: /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/
  },
  notes: { type: String, trim: true },
  amount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

entrySchema.index({ linkId: 1, upiId: 1 }, { unique: true });

module.exports = mongoose.model('Entry', entrySchema);
