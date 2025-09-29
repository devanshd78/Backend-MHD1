// models/EmailTask.js
const mongoose = require('mongoose');

const EmailTaskSchema = new mongoose.Schema(
  {
    // who created it (adminId string, consistent with Link.createdBy usage)
    createdBy: { type: String, required: true, index: true },

    // payload you requested
    targetUser:        { type: String},
    targetPerEmployee: { type: Number, required: true, min: 0 },
    platform:          { type: String, required: true, trim: true },
    amountPerPerson:   { type: Number, required: true, min: 0 },
    maxEmails:         { type: Number, required: true, min: 0 },

    // expiry in HOURS (like Link.expireIn)
    expireIn:  { type: Number, required: true, min: 1 },

    // optional: auto-delete after expiry (TTL). If you don't want auto-deletion,
    // remove `expiresAt` and the `expires` option.
    expiresAt: { type: Date, index: true, expires: 0 },
  },
  { timestamps: true }
);

// derive expiresAt = createdAt + expireIn (hrs)
EmailTaskSchema.pre('save', function (next) {
  // use Date.now() since createdAt is only set after initial save
  const hours = Number(this.expireIn || 0);
  if (hours > 0) {
    this.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  }
  next();
});

module.exports = mongoose.model('EmailTask', EmailTaskSchema);
