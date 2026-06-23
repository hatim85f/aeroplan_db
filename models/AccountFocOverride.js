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
  },
  { timestamps: true },
);

const accountFocOverrideSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      unique: true,
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      required: true,
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

accountFocOverrideSchema.path("endDate").validate(function validateEndDate(value) {
  if (!value || !this.startDate) {
    return true;
  }

  return value >= this.startDate;
}, "endDate must be on or after startDate");

accountFocOverrideSchema.index({ accountId: 1, "overrides.productId": 1 });
accountFocOverrideSchema.index({ startDate: 1, endDate: 1 });

accountFocOverrideSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("AccountFocOverride", accountFocOverrideSchema);
