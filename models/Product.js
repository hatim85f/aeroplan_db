const mongoose = require("mongoose");

const { Schema } = mongoose;

const channelPriceSchema = new Schema(
  {
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
  },
  { _id: false },
);

const channelFocSchema = new Schema(
  {
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    notes: {
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
      direct: {
        type: channelPriceSchema,
        default: () => ({}),
      },
      upp: {
        type: channelPriceSchema,
        default: () => ({}),
      },
      institutional: {
        type: channelPriceSchema,
        default: () => ({}),
      },
    },
    defaultFoc: {
      direct: {
        type: channelFocSchema,
        default: () => ({}),
      },
      upp: {
        type: channelFocSchema,
        default: () => ({}),
      },
      institutional: {
        type: channelFocSchema,
        default: () => ({}),
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
});

module.exports = mongoose.model("Product", productSchema);
