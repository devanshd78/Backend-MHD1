const mongoose = require("mongoose");

const LikeLinkSchema = new mongoose.Schema(
  {
    title: String,
    videoUrl: { type: String, required: true, trim: true },
    createdBy: String,

    // This target will decide how many emails/users must complete the like task
    target: { type: Number, required: true, min: 1 },

    amount: Number,
    expireIn: Number,
    requireLike: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LikeLink", LikeLinkSchema);