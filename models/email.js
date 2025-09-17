// models/email.js
'use strict';

const mongoose = require('mongoose');

const EMAIL_RX  = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_ENUM = ['youtube', 'instagram', 'twitter', 'tiktok', 'facebook', 'other'];

const EmailContactSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    lowercase: true,
    trim: true,
    unique: true,
    validate: {
      validator: (v) => EMAIL_RX.test(v || ''),
      message: 'Invalid email address'
    }
  },
  handle: {
    type: String,
    required: [true, 'Handle is required'],
    lowercase: true,
    trim: true,
    unique: true,
    validate: {
      validator: (v) => HANDLE_RX.test(v || ''),
      message: 'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"'
    }
  },
  platform: {
    type: String,
    required: [true, 'Platform is required'],
    lowercase: true,
    trim: true,
    enum: {
      values: PLATFORM_ENUM,
      message: 'Platform must be one of: youtube, instagram, twitter, tiktok, facebook, other'
    }
  },
  // NEW: who collected this entry (links to your User.userId string)
  userId: {
    type: String,
    required: [true, 'userId is required'],
    index: true,
    ref: 'User'
  }
}, { timestamps: true });

// Helpful indexes (optional but good for scale)
EmailContactSchema.index({ createdAt: -1 });
EmailContactSchema.index({ platform: 1 });
EmailContactSchema.index({ userId: 1 });

module.exports = mongoose.models.EmailContact
  || mongoose.model('EmailContact', EmailContactSchema);
