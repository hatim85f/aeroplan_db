const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * User-submitted feedback and problem reports, surfaced to app admins.
 * type: "problem" (Report a Problem) or "feedback" (Send Feedback).
 */
const feedbackSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, trim: true },
    userEmail: { type: String, trim: true },
    userRole: { type: String, trim: true },
    type: { type: String, enum: ["problem", "feedback"], default: "feedback", index: true },
    message: { type: String, required: true, trim: true },
    appVersion: { type: String, trim: true },
    buildNumber: { type: String, trim: true },
    platform: { type: String, trim: true },
    status: { type: String, enum: ["new", "in_review", "resolved", "dismissed"], default: "new", index: true },
    adminNotes: { type: String, trim: true },
    handledBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

feedbackSchema.index({ createdAt: -1 });

feedbackSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("Feedback", feedbackSchema);
