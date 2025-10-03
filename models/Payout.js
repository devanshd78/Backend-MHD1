// models/Payout.js
'use strict';

const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, index: true }, // Employee.employeeId
  userId:     { type: String, required: true, index: true }, // User.userId
  taskId:     { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTask', required: true, index: true },
  amount:     { type: Number, required: true, min: 0 },
}, { timestamps: true });

// Ensure one payout per (employeeId, userId, taskId)
PayoutSchema.index({ employeeId: 1, userId: 1, taskId: 1 }, { unique: true });

module.exports = mongoose.models.Payout || mongoose.model('Payout', PayoutSchema);
