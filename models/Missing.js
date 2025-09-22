// models/missing.js
'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
// Restrict exactly to these three as per your array
const PLATFORM_ENUM = ['youtube', 'instagram', 'tiktok'];

const MissingSchema = new mongoose.Schema({
  missingId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4,              // UUID v4
    index: true
  },
  handle: {
    type: String,
    required: [true, 'Handle is required'],
    trim: true,
    lowercase: true,
    set: (v) => {
      if (!v) return v;
      const t = String(v).trim().toLowerCase();
      return t.startsWith('@') ? t : `@${t}`;
    },
    validate: {
      validator: (v) => HANDLE_RX.test(v || ''),
      message: 'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"'
    }
  },
  platform: {
    type: String,
    required: [true, 'Platform is required'],
    trim: true,
    lowercase: true,
    enum: {
      values: PLATFORM_ENUM,
      message: 'Platform must be one of: youtube, instagram, tiktok'
    }
  },

  // NEW: Brand association
  brandId: {
    type: String,
    required: [true, 'brandId is required'],
    index: true,
    ref: 'Brand'
  },

  // Optional: for debugging/notes
  note: { type: String, trim: true }
}, { timestamps: true });

// Helpful indexes
MissingSchema.index({ createdAt: -1 });
MissingSchema.index({ handle: 1, platform: 1 });
MissingSchema.index({ brandId: 1 });

module.exports = mongoose.models.Missing || mongoose.model('Missing', MissingSchema);
