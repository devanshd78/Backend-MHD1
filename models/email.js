// models/email.js
'use strict';

const mongoose = require('mongoose');

const EMAIL_RX  = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_ENUM = ['youtube', 'instagram', 'twitter', 'tiktok', 'facebook', 'other'];

// --- YouTube subdocument (NEW) ---
const YouTubeSchema = new mongoose.Schema({
  channelId: { type: String, index: true },
  title: { type: String },
  handle: { type: String },               // normalized @handle
  urlByHandle: { type: String },
  urlById: { type: String },
  description: { type: String },
  country: { type: String },
  subscriberCount: { type: Number, min: 0 },
  videoCount: { type: Number, min: 0 },
  viewCount: { type: Number, min: 0 },
  topicCategories: [{ type: String }],
  topicCategoryLabels: [{ type: String }],
  fetchedAt: { type: Date }
}, { _id: false });

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
      message: 'Handle must start with \"@\" and contain letters, numbers, \".\", \"_\" or \"-\"'
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

  // who collected this entry (links to your User.userId string)
  userId: {
    type: String,
    required: [true, 'userId is required'],
    index: true,
    ref: 'User'
  },

  // NEW: link this contact to the EmailTask it came from
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmailTask',
    index: true,
    default: null
  },

  // --- cached YouTube channel data (optional) ---
  youtube: { type: YouTubeSchema, default: undefined }

}, { timestamps: true });

// Helpful indexes (optional but good for scale)
EmailContactSchema.index({ createdAt: -1 });
EmailContactSchema.index({ platform: 1 });
EmailContactSchema.index({ userId: 1 });
EmailContactSchema.index({ taskId: 1 });
EmailContactSchema.index({ taskId: 1, userId: 1 });
EmailContactSchema.index({ 'youtube.channelId': 1 });

module.exports = mongoose.models.EmailContact
  || mongoose.model('EmailContact', EmailContactSchema);
