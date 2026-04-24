const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const LikeLink = require("./likeLink");

const EmailSlotSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    googleSub: { type: String, required: true, trim: true },

    authAt: { type: Date, required: true },
    authExpiresAt: { type: Date, required: true },

    screenshotHash: { type: String, default: null },
    submittedAt: { type: Date, default: null },

    verified: { type: Boolean, default: false },
    verificationReason: { type: String, default: "" },
  },
  { _id: false }
);

const TaskSchema = new mongoose.Schema(
  {
    taskId: {
      type: String,
      unique: true,
      index: true,
      default: () => uuidv4(),
    },

    userId: { type: String, ref: "User", required: true },

    likeLinkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LikeLink",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      default: 0,
    },

    status: {
      type: Number,
      enum: [0, 1],
      default: null,
    },

    maxEmailsAllowed: { type: Number, default: 5 },
    authWindowSeconds: { type: Number, default: 300 },

    emailSlots: {
      type: [EmailSlotSchema],
      default: [],
    },
  },
  { timestamps: true }
);

TaskSchema.index({ userId: 1, likeLinkId: 1 }, { unique: true });

TaskSchema.pre("validate", async function (next) {
  try {
    if (!Array.isArray(this.emailSlots)) {
      this.emailSlots = [];
    }

    if (this.emailSlots.length > this.maxEmailsAllowed) {
      return next(new Error(`Only ${this.maxEmailsAllowed} different emails are allowed per task`));
    }

    const normalized = this.emailSlots.map((x) =>
      String(x.email || "").trim().toLowerCase()
    );

    if (new Set(normalized).size !== normalized.length) {
      return next(new Error("Duplicate email is not allowed in the same task"));
    }

    if (this.likeLinkId) {
      const likeLink = await LikeLink.findById(this.likeLinkId).select("amount").lean();
      if (!likeLink) {
        return next(new Error("Invalid likeLinkId"));
      }
      this.amount = Number(likeLink.amount || 0);
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model("LikeUploadTask", TaskSchema);