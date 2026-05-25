const mongoose = require("mongoose");

const { Schema } = mongoose;

const focOverrideEntrySchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    overridePercentage: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

focOverrideEntrySchema.path("endDate").validate(function validateEndDate(value) {
  if (!value || !this.startDate) {
    return true;
  }

  return value >= this.startDate;
}, "endDate must be on or after startDate");

const accountFocOverrideSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      unique: true,
      index: true,
    },
    overrides: {
      type: [focOverrideEntrySchema],
      default: [],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

accountFocOverrideSchema.index({ accountId: 1, "overrides.productId": 1 });
accountFocOverrideSchema.index({ "overrides.startDate": 1, "overrides.endDate": 1 });

module.exports = mongoose.model("AccountFocOverride", accountFocOverrideSchema);
