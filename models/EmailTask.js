'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const MIN_FOLLOWERS = 1000;
const MAX_FOLLOWERS = 10_000_000;

const PLATFORM_ENUM = ['youtube', 'instagram', 'twitter', 'tiktok', 'facebook', 'other'];

const EmailTaskSchema = new Schema(
  {
    createdBy: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    targetUser: {
      type: String,
      trim: true,
      default: null,
    },

    targetPerEmployee: {
      type: Number,
      required: true,
      min: 0,
    },

    platform: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      enum: {
        values: PLATFORM_ENUM,
        message: `Platform must be one of: ${PLATFORM_ENUM.join(', ')}`,
      },
      index: true,
    },

    amountPerPerson: {
      type: Number,
      required: true,
      min: 0,
    },

    maxEmails: {
      type: Number,
      required: true,
      min: 1,
    },

    expireIn: {
      type: Number,
      required: true,
      min: 1,
    },

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

    // ANY means no restriction
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

EmailTaskSchema.path('maxFollowers').validate(function (v) {
  const min = Number(this.minFollowers || MIN_FOLLOWERS);
  const max = Number(v || MAX_FOLLOWERS);
  return Number.isFinite(min) && Number.isFinite(max) && max >= min;
}, 'maxFollowers must be >= minFollowers');

module.exports =
  mongoose.models.EmailTask || mongoose.model('EmailTask', EmailTaskSchema);