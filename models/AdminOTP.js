// models/AdminOTP.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const AdminOTPSchema = new Schema({
  // store a reference to the Admin document
  admin: {
    type: Schema.Types.ObjectId,
    ref: 'Admin',
    required: true,
    index: true,
  },

  // what flow this OTP belongs to
  type: {
    type: String,
    enum: ['email-change-old', 'email-change-new', 'password-reset'],
    required: true,
  },

  otp: {
    type: String,
    required: true,
  },

  // optional metadata (e.g. { newEmail })
  payload: {
    type: Schema.Types.Mixed,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },

  expiresAt: {
    type: Date,
    required: true,
  },
});

// TTL index: document will be removed once expiresAt is in the past
AdminOTPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AdminOTP', AdminOTPSchema);
