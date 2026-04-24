const mongoose = require("mongoose");

const LikeLinkSchema = new mongoose.Schema(
  {
    title: String,
    videoUrl: { type: String, required: true, trim: true }, // required for redirect
    createdBy: String,
    target: Number,
    amount: Number,
    expireIn: Number,
    requireLike: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LikeLink", LikeLinkSchema);