const mongoose = require("mongoose");

const { Schema } = mongoose;

const uploadRowIssueSchema = new Schema(
  {
    rowNumber: {
      type: Number,
      min: 0,
    },
    message: {
      type: String,
      trim: true,
    },
    quantity: {
      type: Number,
    },
    freeQuantity: {
      type: Number,
    },
    rawRow: {
      type: Schema.Types.Mixed,
    },
  },
  { _id: false },
);

const salesUploadBatchSchema = new Schema(
  {
    fileName: {
      type: String,
      trim: true,
      index: true,
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    uploadDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    mappingId: {
      type: Schema.Types.ObjectId,
      ref: "SalesSheetMapping",
      index: true,
    },
    mappingName: {
      type: String,
      trim: true,
    },
    uploadSessionId: {
      type: String,
      trim: true,
      index: true,
    },
    chunkIndex: {
      type: Number,
      min: 0,
    },
    totalChunks: {
      type: Number,
      min: 1,
    },
    isFirstChunk: {
      type: Boolean,
      default: false,
    },
    isLastChunk: {
      type: Boolean,
      default: false,
    },
    overrideApplied: {
      type: Boolean,
      default: false,
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
    totalRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    successfulRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    failedRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    duplicateRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    unmatchedRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    matchedRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["processing", "completed", "completed_with_errors", "failed"],
      default: "processing",
      index: true,
    },
    columnMapping: {
      type: Schema.Types.Mixed,
    },
    errors: {
      type: [uploadRowIssueSchema],
      default: [],
    },
    warnings: {
      type: [uploadRowIssueSchema],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true, suppressReservedKeysWarning: true },
);

salesUploadBatchSchema.index({ year: 1, month: 1, status: 1 });
salesUploadBatchSchema.index({ uploadedBy: 1, uploadDate: -1 });
salesUploadBatchSchema.index({ uploadSessionId: 1, year: 1, month: 1 });
salesUploadBatchSchema.index({ fileName: "text", mappingName: "text", notes: "text" });

module.exports = mongoose.model("SalesUploadBatch", salesUploadBatchSchema);
