const mongoose = require("mongoose");

const { Schema } = mongoose;

const salesSheetMappingSchema = new Schema(
  {
    mappingName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    sourceType: {
      type: String,
      trim: true,
      index: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    columnMapping: {
      type: Schema.Types.Mixed,
      required: true,
    },
    requiredColumns: {
      type: [String],
      default: [],
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

salesSheetMappingSchema.index({
  mappingName: "text",
  description: "text",
  sourceType: "text",
});
salesSheetMappingSchema.index({ status: 1, isDefault: 1 });

module.exports = mongoose.model("SalesSheetMapping", salesSheetMappingSchema);
