const mongoose = require("mongoose");

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
    },
    routeName: {
      type: String,
      required: true,
      trim: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      default: {},
    },
    isOpened: {
      type: Boolean,
      default: false,
    },
    openedAt: Date,
    timeStamp: {
      type: Date,
      default: Date.now,
    },
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sentAt: Date,
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "partial"],
      default: "pending",
    },
    expoTickets: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    failedTokens: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

notificationSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("Notification", notificationSchema);
