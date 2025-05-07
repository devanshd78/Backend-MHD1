// models/Entry.js
const mongoose = require('mongoose');
const entrySchema = new mongoose.Schema({
  linkId:     { type: String, ref: 'Link' },
  employeeId: { type: String, ref: 'Employee' },
  name:       String,
  upiId:      String,
  amount:     Number,
  createdAt:  { type: Date, default: Date.now }
});
module.exports = mongoose.model('Entry', entrySchema);
