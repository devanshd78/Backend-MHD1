const mongoose = require('mongoose');

const linkSchema = new mongoose.Schema({
  title:     { type: String, default: 'Entry Form' },
  createdBy: { type: String, ref: 'Admin' },
  createdAt: { type: Date, default: Date.now },
  target:    { type: Number, required: true }, // New field
  amount:    { type: Number, required: true }  // New field
});

module.exports = mongoose.model('Link', linkSchema);
