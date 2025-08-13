// models/Screenshot.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const fileSchema = new mongoose.Schema({
  role:    { type: String, enum: ['like','comment1','comment2','reply1','reply2'], required: true },
  phash:   { type: String, required: true },   // hex
  sha256:  { type: String, required: true },
  size:    { type: Number },
  mime:    { type: String }
}, { _id: false });

const screenshotSchema = new mongoose.Schema({
  screenshotId: { type: String, default: uuidv4, unique: true },
  userId:       { type: String, ref: 'User', required: true },
  linkId:       { type: String, ref: 'Link', required: true },

  // verifier outcome + raw payload for audit
  verified:     { type: Boolean, required: true },
  analysis:     { type: mongoose.Schema.Types.Mixed },

  // dedupe helpers
  phashes:      [{ type: String, required: true }], // 5 items
  bundleSig:    { type: String, required: true },   // sorted join of phashes

  files:        { type: [fileSchema], required: true },

  createdAt:    { type: Date, default: Date.now }
});

// prevent exact same 5-image bundle re-upload by same user
screenshotSchema.index({ userId: 1, bundleSig: 1 }, { unique: true });

module.exports = mongoose.model('Screenshot', screenshotSchema);