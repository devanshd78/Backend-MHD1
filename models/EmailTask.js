'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const MIN_FOLLOWERS = 1000;
const MAX_FOLLOWERS = 10_000_000;

const EmailTaskSchema = new Schema(
  {
    createdBy:         { type: String, required: true, index: true },
    targetUser:        { type: String, trim: true }, // must be String
    targetPerEmployee: { type: Number, required: true, min: 0 },
    platform:          { type: String, required: true, trim: true },
    amountPerPerson:   { type: Number, required: true, min: 0 },
    maxEmails:         { type: Number, required: true, min: 0 },
    expireIn:          { type: Number, required: true, min: 1 },

    // ✅ NEW: follower range
    minFollowers: {
      type: Number,
      default: MIN_FOLLOWERS,
      min: MIN_FOLLOWERS,
      max: MAX_FOLLOWERS,
    },
    maxFollowers: {
      type: Number,
      default: MAX_FOLLOWERS,
      min: MIN_FOLLOWERS,
      max: MAX_FOLLOWERS,
    },

    // ✅ NEW: multi-select tags (ANY means no restriction)
    countries: {
      type: [String],
      default: ['ANY'],
    },
    categories: {
      type: [String],
      default: ['ANY'],
    },
  },
  { timestamps: true }
);

// ✅ Ensure maxFollowers >= minFollowers
EmailTaskSchema.path('maxFollowers').validate(function (v) {
  const min = Number(this.minFollowers || MIN_FOLLOWERS);
  const max = Number(v || MAX_FOLLOWERS);
  return Number.isFinite(min) && Number.isFinite(max) && max >= min;
}, 'maxFollowers must be >= minFollowers');

if (mongoose.models.EmailTask) {
  try { mongoose.deleteModel('EmailTask'); } catch (_) { delete mongoose.connection.models['EmailTask']; }
}

module.exports = mongoose.model('EmailTask', EmailTaskSchema);