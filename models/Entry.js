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
  status:    { type: Number, enum: [0, 1], default: null },    // null=pending

  /* employee only */
  employeeId:{ type: String, ref: 'Employee' },
  amount:    { type: Number },
  notes:     { type: String },

  /* user only */
  userId:      { type: String, ref: 'User' },
  worksUnder:  { type: String, ref: 'Employee' },
  linkAmount:  { type: Number },
  totalAmount: { type: Number },

  // still named screenshotId for compatibility (now it points to API verification doc)
  screenshotId: { type: String, ref: 'Screenshot' },

  isUpdated:  { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },

  history: [{
    field:     { type: String, required: true },
    from:      { type: mongoose.Schema.Types.Mixed },
    to:        { type: mongoose.Schema.Types.Mixed },
    updatedAt: { type: Date, default: Date.now, required: true }
  }]
});

entrySchema.index(
  { linkId: 1 },
  { unique: true, partialFilterExpression: { type: 0 } }
);

module.exports = mongoose.model('Entry', entrySchema);