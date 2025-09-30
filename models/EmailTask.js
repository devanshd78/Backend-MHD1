const mongoose = require('mongoose');

const EmailTaskSchema = new mongoose.Schema(
  {
    createdBy: { type: String, required: true, index: true },

    targetUser:        { type: String },
    targetPerEmployee: { type: Number, required: true, min: 0 },
    platform:          { type: String, required: true, trim: true },
    amountPerPerson:   { type: Number, required: true, min: 0 },
    maxEmails:         { type: Number, required: true, min: 0 },

    // expiry in HOURS (no TTL delete anymore)
    expireIn:  { type: Number, required: true, min: 1 },
    expiresAt: { type: Date, index: true }, // ← removed "expires: 0" (TTL)

    // NEW: keep tasks and mark as expired instead of deleting
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
  if (hours > 0) {
    this.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  }
  next();
});

module.exports = mongoose.model('EmailTask', EmailTaskSchema);
