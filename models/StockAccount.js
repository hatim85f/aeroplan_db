const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * Main stock/purchasing account (e.g. "Burjeel Drugstore"). Multiple
 * sales-sheet accounts can be linked under it; their uploaded sales feed
 * the stock's "Added from Sales" figure.
 */
const stockAccountSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      index: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    isCustomAccount: {
      type: Boolean,
      default: false,
    },
    linkedAccountIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Account",
        index: true,
      },
    ],
    linkedAccountNames: [
      {
        type: String,
        trim: true,
      },
    ],
    teamId: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      index: true,
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

stockAccountSchema.index({ accountName: "text" });

module.exports = mongoose.model("StockAccount", stockAccountSchema);
