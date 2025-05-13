const mongoose = require('mongoose');

const balanceHistorySchema = new mongoose.Schema({
  employeeId: { type: String, required: true },
  amount: { type: Number, required: true },
  addedBy: { type: String, required: true }, // adminId
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('BalanceHistory', balanceHistorySchema);
