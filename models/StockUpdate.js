const mongoose = require("mongoose");

const { Schema } = mongoose;

const stockUpdateItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    productName: {
      type: String,
      trim: true,
    },
    productNickname: {
      type: String,
      trim: true,
    },
    currentStock: {
      type: Number,
      required: true,
      min: 0,
    },
    previousStock: {
      type: Number,
      default: 0,
    },
    addedFromSales: {
      type: Number,
      default: 0,
    },
    adjustmentQuantity: {
      type: Number,
      default: 0,
    },
    adjustmentNote: {
      type: String,
      trim: true,
    },
    expectedStock: {
      type: Number,
      default: 0,
    },
    movementQty: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { _id: true },
);

/**
 * One stock update = a snapshot entered by a user for one or more products.
 * History is preserved — never overwrite, always append.
 */
const stockUpdateSchema = new Schema(
  {
    stockAccountId: {
      type: Schema.Types.ObjectId,
      ref: "StockAccount",
      required: true,
      index: true,
    },
    stockAccountName: {
      type: String,
      trim: true,
    },
    updateDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    updatedByName: {
      type: String,
      trim: true,
    },
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
    items: {
      type: [stockUpdateItemSchema],
      default: [],
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

stockUpdateSchema.index({ stockAccountId: 1, updateDate: -1 });
stockUpdateSchema.index({ stockAccountId: 1, "items.productId": 1, updateDate: -1 });

module.exports = mongoose.model("StockUpdate", stockUpdateSchema);
