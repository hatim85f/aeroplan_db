const mongoose = require("mongoose");

const { Schema } = mongoose;

const teamInvitationSchema = new Schema(
  {
    fromManagerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    toUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    teamId: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    message: {
      type: String,
      trim: true,
    },
    expiresAt: Date,
    acceptedAt: Date,
    rejectedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.model("TeamInvitation", teamInvitationSchema);
