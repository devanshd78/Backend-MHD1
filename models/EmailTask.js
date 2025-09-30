// models/EmailTask.js
'use strict';

const mongoose = require('mongoose');

const EmailTaskSchema = new mongoose.Schema(
  {
    // who created it (adminId string, consistent with Link.createdBy usage)
    createdBy: { type: String, required: true, index: true },

    // payload
    targetUser:        { type: String },
    targetPerEmployee: { type: Number, required: true, min: 0 },
    platform:          { type: String, required: true, trim: true },
    amountPerPerson:   { type: Number, required: true, min: 0 },
    maxEmails:         { type: Number, required: true, min: 0 },

    // expiry in HOURS (no TTL auto-delete)
    expireIn:  { type: Number, required: true, min: 1 },
    expiresAt: { type: Date, index: true },  // ← NOTE: no "expires" option here

    // keep tasks and mark lifecycle via status
    status: {
      type: String,
      enum: ['active', 'expired', 'disabled'],
      default: 'active',
      index: true
    }
  },
  { timestamps: true }
);

// derive expiresAt = now + expireIn (hrs)
EmailTaskSchema.pre('save', function (next) {
  const hours = Number(this.expireIn || 0);
  if (hours > 0 && (this.isNew || this.isModified('expireIn'))) {
    this.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  }
  next();
});

// (optional) helper: mark expired if past expiresAt
EmailTaskSchema.methods.ensureExpiredStatus = function () {
  if (this.expiresAt && this.expiresAt.getTime() <= Date.now() && this.status !== 'expired') {
    this.status = 'expired';
  }
  return this;
};

module.exports =
  mongoose.models.EmailTask || mongoose.model('EmailTask', EmailTaskSchema);
