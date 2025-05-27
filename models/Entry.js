// models/Entry.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const entrySchema = new mongoose.Schema({
  entryId:   { type: String, default: uuidv4, unique: true },

  /* common */
  linkId:    { type: String, ref: 'Link', required: true },
  name:      { type: String, required: true, trim: true },
  upiId:     {
    type:     String,
    required: true,
    trim:     true,
    match:    /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/
  },
  type:      { type: Number, enum: [0, 1], required: true },   // 0=employee, 1=user
  status:    { type: Number, enum: [0, 1], default: null },     // null=pending

  /* employee only */
  employeeId:{ type: String, ref: 'Employee' },
  amount:    { type: Number },
  notes:     { type: String },

  /* user only */
  userId:     { type: String, ref: 'User' },
  noOfPersons:{ type: Number, min: 1 },
  worksUnder: { type: String, ref: 'Employee' },   // who created this entry
  linkAmount: { type: Number },
  totalAmount:{ type: Number },
  telegramLink:{ type: String },
  isUpdated: { type: Number, default: 0 }, // true if updated by user

  createdAt:  { type: Date, default: Date.now },

  // —— audit trail for updates ——
  history: [{
    field:     { type: String, required: true },            // e.g. 'amount'
    from:      { type: mongoose.Schema.Types.Mixed },       // old value
    to:        { type: mongoose.Schema.Types.Mixed },       // new value
    updatedAt: { type: Date, default: Date.now, required: true }
  }]
});

// ensure unique per-link + upi + type
entrySchema.index({ linkId: 1, upiId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('Entry', entrySchema);
