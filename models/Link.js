const mongoose = require('mongoose');

const LinkSchema = new mongoose.Schema({
  title: String,
  createdBy: String,
  target: Number,
  amount: Number,
  expireIn: Number,

  // ✅ NEW: verification rules (0..2 only)
  minComments: { type: Number, default: 2, min: 0, max: 2 },
  minReplies:  { type: Number, default: 2, min: 0, max: 2 },
  requireLike: { type: Boolean, default: false },
}, { timestamps: true });

// Disallow both = 0
LinkSchema.pre('save', function(next) {
  const c = Number(this.minComments || 0);
  const r = Number(this.minReplies || 0);
  if (c === 0 && r === 0) {
    return next(new Error('minComments and minReplies cannot both be 0'));
  }
  next();
});

module.exports = mongoose.model('Link', LinkSchema);
