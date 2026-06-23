const mongoose = require("mongoose");

const { Schema } = mongoose;

const salesDetectionRuleSchema = new Schema(
  {
    ruleName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
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
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    priority: {
      type: Number,
      default: 100,
      index: true,
    },
    soldToAccountNames: {
      type: [String],
      default: [],
    },
    accountNames: {
      type: [String],
      default: [],
    },
    shipToAccountNames: {
      type: [String],
      default: [],
    },
    productIds: [{
      type: Schema.Types.ObjectId,
      ref: "Product",
    }],
    productNicknames: {
      type: [String],
      default: [],
    },
    salesTypes: {
      type: [String],
      default: [],
    },
    channelTypes: {
      type: [String],
      default: [],
    },
    uploadedCurrency: {
      type: String,
      trim: true,
      uppercase: true,
    },
    channelId: {
      type: Schema.Types.ObjectId,
      ref: "SalesChannel",
      required: true,
      index: true,
    },
    channelKey: {
      type: String,
      trim: true,
      lowercase: true,
    },
    channelName: {
      type: String,
      trim: true,
    },
    accountMatchSource: {
      type: String,
      enum: ["shipToAccountName", "accountName", "auto"],
      default: "auto",
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
    notes: {
      type: String,
      trim: true,
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

salesDetectionRuleSchema.pre("validate", function normalizeBeforeValidate(next) {
  if (this.channelKey) {
    this.channelKey = String(this.channelKey).trim().toLowerCase();
  }

  if (this.uploadedCurrency) {
    this.uploadedCurrency = String(this.uploadedCurrency).trim().toUpperCase();
  }

  if (this.status === "active") {
    this.isActive = true;
  } else if (this.status === "inactive") {
    this.isActive = false;
  }

  next();
});

salesDetectionRuleSchema.index({
  ruleName: "text",
  description: "text",
  soldToAccountNames: "text",
  accountNames: "text",
  shipToAccountNames: "text",
  productNicknames: "text",
  channelName: "text",
  notes: "text",
});
salesDetectionRuleSchema.index({ status: 1, isActive: 1, priority: 1 });

salesDetectionRuleSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("SalesDetectionRule", salesDetectionRuleSchema);
