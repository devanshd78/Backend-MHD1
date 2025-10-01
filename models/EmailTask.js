// models/EmailTask.js
'use strict';

const mongoose = require('mongoose');

const EmailTaskSchema = new mongoose.Schema(
  {
    // who created it (adminId string, consistent with Link.createdBy usage)
    createdBy: { type: String, required: true, index: true },

    // payload
    targetUser:        { type: String },
    targetPerEmployee: { type: Number, required: true, min: 0 },
    platform:          { type: String, required: true, trim: true },
    amountPerPerson:   { type: Number, required: true, min: 0 },
    maxEmails:         { type: Number, required: true, min: 0 },
    expireIn: { type: Number, required: true, min: 1 },
  },
  {
    timestamps: true
  }
);

module.exports =
  mongoose.models.EmailTask || mongoose.model('EmailTask', EmailTaskSchema);
