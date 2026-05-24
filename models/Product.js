const mongoose = require("mongoose");

const { Schema } = mongoose;

const channelPricingSchema = new Schema(
  {
    channelId: {
      type: Schema.Types.ObjectId,
      ref: "SalesChannel",
      required: true,
    },
    channelName: {
      type: String,
      trim: true,
    },
    channelKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },
    cifUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    wholesaleAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    retailAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    focEnabled: {
      type: Boolean,
      default: false,
    },
    defaultFocPercentage: {
      type: Number,
      default: 0,
    },
    focNotes: {
      type: String,
      trim: true,
    },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    productName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    productNickname: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    productNicknameKey: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      select: false,
    },
    description: {
      type: String,
      trim: true,
    },
    lineId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    lineName: {
      type: String,
      trim: true,
    },
    imageUrl: {
      type: String,
      trim: true,
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
    prices: {
      type: Schema.Types.Mixed,
      select: false,
    },
    defaultFoc: {
      type: Schema.Types.Mixed,
      select: false,
    },
    channelPricing: {
      type: [channelPricingSchema],
      default: [],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: "At least one channelPricing item is required",
      },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
  },
  { timestamps: true },
);

productSchema.index({
  productName: "text",
  productNickname: "text",
  description: "text",
  lineId: "text",
  lineName: "text",
  "channelPricing.channelName": "text",
  "channelPricing.channelKey": "text",
});
productSchema.index({ "channelPricing.channelId": 1 });
productSchema.index({ "channelPricing.channelKey": 1 });
productSchema.index({ lineId: 1, status: 1, isActive: 1 });

module.exports = mongoose.model("Product", productSchema);
