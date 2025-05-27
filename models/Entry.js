// models/Entry.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const entrySchema = new mongoose.Schema({
  entryId: { type: String, default: uuidv4, unique: true },

  /* common */
  linkId: { type: String, ref: 'Link', required: true },
  name: { type: String, required: true, trim: true },
  upiId: {
    type: String, required: true, trim: true,
    match: /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/
  },
  type: { type: Number, enum: [0, 1], required: true },   // 0-emp, 1-user
  status: { type: Number, enum: [0, 1], default: null },    // null=pending

  /* employee only -------------------------------------------------- */
  employeeId: { type: String, ref: 'Employee' },
  amount: { type: Number },        // amount they’re claiming
  notes: { type: String },

  /* user only ------------------------------------------------------ */
  userId: { type: String, ref: 'User' },
  noOfPersons: { type: Number, min: 1 },
  worksUnder: { type: String, ref: 'User' }, // who created this entry
  linkAmount: { type: Number },      // snapshot of Link.amount
  totalAmount: { type: Number },      // noOfPersons * linkAmount
  telegramLink: { type: String },

  createdAt: { type: Date, default: Date.now }
});

entrySchema.index({ linkId: 1, upiId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('Entry', entrySchema);
