'use strict';

const mongoose = require('mongoose');

const EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

// Keep this aligned with controller normalizePlatform()
const PLATFORM_ENUM = ['youtube', 'instagram', 'twitter', 'tiktok', 'facebook', 'other'];

// ------------------------------------------------------
// YouTube subdocument (cached enrichment)
// ------------------------------------------------------
const YouTubeSchema = new mongoose.Schema(
  {
    channelId: { type: String, index: true },
    title: { type: String, default: null },
    handle: { type: String, default: null }, // normalized @handle
    urlByHandle: { type: String, default: null },
    urlById: { type: String, default: null },
    description: { type: String, default: null },

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
      index: true,
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
      index: true,
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
        message: `Platform must be one of: ${PLATFORM_ENUM.join(', ')}`,
      },
      index: true,
    },

    // who collected this entry (links to User.userId string)
    userId: {
      type: String,
      required: [true, 'userId is required'],
      trim: true,
      index: true,
      ref: 'User',
    },

    // task source
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailTask',
      index: true,
      default: null,
    },

    // --------------------------------------------------
    // Task validation + meta
    // --------------------------------------------------
    followerCount: {
      type: Number,
      min: 0,
      default: null,
      index: true,
    },

    // ISO2 recommended
    country: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
      index: true,
    },

    categories: {
      type: [String],
      default: [],
    },

    isValid: {
      type: Boolean,
      default: true,
      index: true,
    },

    invalidReason: {
      type: String,
      default: null,
    },

    invalidDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    validatedAt: {
      type: Date,
      default: null,
    },

    youtube: {
      type: YouTubeSchema,
      default: undefined,
    },
  },
  { timestamps: true }
);

// ------------------------------------------------------
// Helpful indexes
// ------------------------------------------------------
EmailContactSchema.index({ createdAt: -1 });
EmailContactSchema.index({ platform: 1, createdAt: -1 });
EmailContactSchema.index({ userId: 1, createdAt: -1 });
EmailContactSchema.index({ taskId: 1, createdAt: -1 });
EmailContactSchema.index({ isValid: 1, createdAt: -1 });
EmailContactSchema.index({ country: 1, isValid: 1, createdAt: -1 });
EmailContactSchema.index({ followerCount: 1, isValid: 1, createdAt: -1 });
EmailContactSchema.index({ 'youtube.channelId': 1 });

module.exports =
  mongoose.models.EmailContact || mongoose.model('EmailContact', EmailContactSchema);