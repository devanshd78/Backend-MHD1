// models/email.js
'use strict';

const mongoose = require('mongoose');

const EMAIL_RX  = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_ENUM = ['youtube', 'instagram', 'tiktok'];

// ------------------------------------------------------
// YouTube subdocument (cached enrichment)
// ------------------------------------------------------
const YouTubeSchema = new mongoose.Schema(
  {
    channelId: { type: String, index: true },
    title: { type: String, default: null },
    handle: { type: String, default: null },               // normalized @handle
    urlByHandle: { type: String, default: null },
    urlById: { type: String, default: null },
    description: { type: String, default: null },

    // ISO2 (if available from API), but keep flexible
    country: { type: String, trim: true, uppercase: true, default: null },

    subscriberCount: { type: Number, min: 0, default: null },
    videoCount: { type: Number, min: 0, default: null },
    viewCount: { type: Number, min: 0, default: null },

    topicCategories: [{ type: String, trim: true }],
    topicCategoryLabels: [{ type: String, trim: true }],

    fetchedAt: { type: Date, default: null },
  },
  { _id: false }
);

// ------------------------------------------------------
// EmailContact schema
// ------------------------------------------------------
const EmailContactSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      unique: true,
      validate: {
        validator: (v) => EMAIL_RX.test(v || ''),
        message: 'Invalid email address',
      },
    },

    handle: {
      type: String,
      required: [true, 'Handle is required'],
      lowercase: true,
      trim: true,
      unique: true,
      validate: {
        validator: (v) => HANDLE_RX.test(v || ''),
        message: 'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"',
      },
    },

    platform: {
      type: String,
      required: [true, 'Platform is required'],
      lowercase: true,
      trim: true,
      enum: {
        values: PLATFORM_ENUM,
        message: 'Platform must be one of: youtube, instagram, tiktok',
      },
    },

    // who collected this entry (links to your User.userId string)
    userId: {
      type: String,
      required: [true, 'userId is required'],
      index: true,
      ref: 'User',
    },

    // link this contact to the EmailTask it came from
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailTask',
      index: true,
      default: null,
    },

    // --------------------------------------------------
    // Task validation + meta (so country mismatch is saved)
    // --------------------------------------------------
    followerCount: { type: Number, min: 0, default: null, index: true },

    // ISO2 (US/IN/AE) recommended
    country: { type: String, trim: true, uppercase: true, default: null, index: true },

    // normalized categories from meta service
    categories: [{ type: String, trim: true, lowercase: true }],

    // ✅ your requirement: mismatch => isValid false + save
    isValid: { type: Boolean, default: true, index: true },
    invalidReason: { type: String, default: null }, // e.g. COUNTRY_MISMATCH
    invalidDetails: { type: mongoose.Schema.Types.Mixed, default: null }, // { expected: ["US"], got: "IN" }
    validatedAt: { type: Date, default: null },

    // cached YouTube channel data (optional)
    youtube: { type: YouTubeSchema, default: undefined },
  },
  { timestamps: true }
);

// ------------------------------------------------------
// Helpful indexes
// ------------------------------------------------------
EmailContactSchema.index({ createdAt: -1 });
EmailContactSchema.index({ platform: 1 });
EmailContactSchema.index({ userId: 1 });
EmailContactSchema.index({ taskId: 1 });
EmailContactSchema.index({ 'youtube.channelId': 1 });

// Extra useful ones for mismatch tracking/filtering
EmailContactSchema.index({ isValid: 1, createdAt: -1 });
EmailContactSchema.index({ country: 1, isValid: 1, createdAt: -1 });

module.exports =
  mongoose.models.EmailContact || mongoose.model('EmailContact', EmailContactSchema);