'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const EmailTaskSchema = new Schema(
  {
    createdBy:         { type: String, required: true, index: true },
    targetUser:        { type: String, trim: true }, // must be String
    targetPerEmployee: { type: Number, required: true, min: 0 },
    platform:          { type: String, required: true, trim: true },
    amountPerPerson:   { type: Number, required: true, min: 0 },
    maxEmails:         { type: Number, required: true, min: 0 },
    expireIn:          { type: Number, required: true, min: 1 },
  },
  { timestamps: true }
);

if (mongoose.models.EmailTask) {
  try {
    mongoose.deleteModel('EmailTask');
  } catch (_) {
    delete mongoose.connection.models['EmailTask'];
  }
}

module.exports = mongoose.model('EmailTask', EmailTaskSchema);
