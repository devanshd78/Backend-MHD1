const mongoose = require('mongoose');

const linkSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  createdBy: { type: String, ref: 'Admin' },
  createdAt: { type: Date, default: Date.now },
  target:    { type: Number, required: true },
  amount:    { type: Number, required: true },
  expireIn:  { type: Number, required: true }, // in hours
});


module.exports = mongoose.model('Link', linkSchema);
