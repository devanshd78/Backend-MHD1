// models/Link.js
const mongoose = require('mongoose');
const linkSchema = new mongoose.Schema({
  title:     { type: String, default: 'Entry Form' },
  createdBy: { type: String, ref: 'Admin' },
  createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Link', linkSchema);
