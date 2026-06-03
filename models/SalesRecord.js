const mongoose = require("mongoose");

const { Schema } = mongoose;

const areaShareSchema = new Schema(
  {
    areaId: {
      type: Schema.Types.ObjectId,
      ref: "Area",
      index: true,
    },
    areaName: {
      type: String,
      trim: true,
    },
    sharePercentage: {
      type: Number,
      min: 0,
      max: 100,
    },
    sharedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    sharedFreeQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    sharedCalculatedCifUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    sharedCalculatedWholesaleAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    sharedCalculatedRetailAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    ruleId: {
      type: Schema.Types.ObjectId,
      ref: "SharedSalesRule",
    },
  },
  { _id: false },
);

const salesRecordSchema = new Schema(
  {
    salesUploadBatchId: {
      type: Schema.Types.ObjectId,
      ref: "SalesUploadBatch",
      required: true,
      index: true,
    },
    entrySource: {
      type: String,
      enum: ["upload", "manual"],
      default: "upload",
      index: true,
    },
    invoiceNumber: {
      type: String,
      trim: true,
      index: true,
    },
    externalSalesReference: {
      type: String,
      trim: true,
      index: true,
    },
    rowNumber: {
      type: Number,
      min: 0,
    },
    salesDate: {
      type: Date,
      required: true,
      index: true,
    },
    invoiceDate: {
      type: Date,
      index: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      index: true,
    },
    year: {
      type: Number,
      required: true,
      min: 2000,
      max: 2100,
      index: true,
    },
    uploadDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      index: true,
    },
    accountName: {
      type: String,
      trim: true,
      index: true,
    },
    shipToAccountName: {
      type: String,
      trim: true,
      index: true,
    },
    accountExternalCode: {
      type: String,
      trim: true,
      index: true,
    },
    accountMatched: {
      type: Boolean,
      default: false,
      index: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      index: true,
    },
    productName: {
      type: String,
      trim: true,
      index: true,
    },
    productNickname: {
      type: String,
      trim: true,
      index: true,
    },
    productExternalCode: {
      type: String,
      trim: true,
      index: true,
    },
    productMatched: {
      type: Boolean,
      default: false,
      index: true,
    },
    channelId: {
      type: Schema.Types.ObjectId,
      ref: "SalesChannel",
      index: true,
    },
    channelName: {
      type: String,
      trim: true,
      index: true,
    },
    channelKey: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    channelMatched: {
      type: Boolean,
      default: false,
      index: true,
    },
    channelDetectionMethod: {
      type: String,
      enum: ["sheet_channel", "account_mapping", "price_match", "sales_type_price_match", "manual", "unknown"],
      default: "unknown",
      index: true,
    },
    salesType: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    salesTypeNormalized: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    freeQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalQuantityWithFoc: {
      type: Number,
      default: 0,
      min: 0,
    },
    uploadedSalesValue: {
      type: Number,
      default: 0,
    },
    uploadedCurrency: {
      type: String,
      trim: true,
      uppercase: true,
    },
    uploadedUnitValue: {
      type: Number,
      default: 0,
    },
    detectedPriceBasis: {
      type: String,
      enum: ["cifUsd", "wholesaleAed", "retailAed"],
    },
    detectedPriceCurrency: {
      type: String,
      enum: ["USD", "AED"],
    },
    calculatedCifUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    calculatedWholesaleAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    calculatedRetailAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    unitCifUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    unitWholesaleAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    unitRetailAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    unitPriceSnapshots: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    calculatedValueSnapshots: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    targetValueBasis: {
      type: String,
      enum: ["cifUsd", "wholesaleAed", "retailAed"],
    },
    targetCurrency: {
      type: String,
      enum: ["USD", "AED"],
    },
    targetUnitValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetCalculatedValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    matchedOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
    matchedTargetAssignmentIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "TargetAssignment",
        index: true,
      },
    ],
    matchedForecastIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Forecast",
        index: true,
      },
    ],
    matchStatus: {
      type: String,
      enum: ["unmatched", "partially_matched", "matched", "needs_review"],
      default: "unmatched",
      index: true,
    },
    matchConfidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    matchNotes: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "ignored", "duplicate", "error"],
      default: "active",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    rawRow: {
      type: Schema.Types.Mixed,
    },
    areaShares: {
      type: [areaShareSchema],
      default: [],
    },
    sharedSalesApplied: {
      type: Boolean,
      default: false,
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
  },
  { timestamps: true },
);

salesRecordSchema.pre("validate", function calculateTotalQuantity(next) {
  const quantity = Number(this.quantity || 0);
  const freeQuantity = Number(this.freeQuantity || 0);
  this.totalQuantityWithFoc = quantity + freeQuantity;
  next();
});

salesRecordSchema.index({ year: 1, month: 1, salesDate: -1 });
salesRecordSchema.index({ accountId: 1, productId: 1, channelId: 1, salesDate: -1 });
salesRecordSchema.index({ salesUploadBatchId: 1, rowNumber: 1 });
salesRecordSchema.index({ matchStatus: 1, status: 1, isActive: 1 });
salesRecordSchema.index({ uploadedCurrency: 1, detectedPriceBasis: 1, detectedPriceCurrency: 1 });
salesRecordSchema.index({
  invoiceNumber: "text",
  externalSalesReference: "text",
  accountName: "text",
  shipToAccountName: "text",
  accountExternalCode: "text",
  productName: "text",
  productNickname: "text",
  productExternalCode: "text",
  channelName: "text",
  channelKey: "text",
  matchNotes: "text",
});

module.exports = mongoose.model("SalesRecord", salesRecordSchema);
