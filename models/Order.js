const mongoose = require("mongoose");

const { Schema } = mongoose;

const salesTeamSnapshotSchema = new Schema(
  {
    salesTeamMemberId: {
      type: Schema.Types.ObjectId,
      ref: "SalesTeamMember",
    },
    fullName: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    position: {
      type: String,
      trim: true,
    },
  },
  { _id: false },
);

const orderItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    productNickname: {
      type: String,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    focPercentage: {
      type: Number,
      default: 0,
      min: 0,
    },
    focQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    focSource: {
      type: String,
      enum: ["manual", "override", "default", "none"],
      default: "none",
    },
    focOverrideId: {
      type: Schema.Types.ObjectId,
      ref: "AccountFocOverride",
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
    totalCifUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWholesaleAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalRetailAed: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: true },
);

const orderSchema = new Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      index: true,
    },
    account: {
      accountId: {
        type: Schema.Types.ObjectId,
        ref: "Account",
        required: true,
        index: true,
      },
      accountName: {
        type: String,
        required: true,
        trim: true,
      },
      accountCode: {
        type: String,
        trim: true,
      },
    },
    medicalRepId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    medicalRepName: {
      type: String,
      required: true,
      trim: true,
    },
    salesTeamIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "SalesTeamMember",
        index: true,
      },
    ],
    salesTeamSnapshot: {
      type: [salesTeamSnapshotSchema],
      default: [],
    },
    ccSalesTeam: {
      type: Boolean,
      default: true,
    },
    ccManagerOrKam: {
      type: Boolean,
      default: false,
    },
    orderDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    status: {
      type: String,
      enum: ["created", "matched_in_sales"],
      default: "created",
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
    channelId: {
      type: Schema.Types.ObjectId,
      ref: "SalesChannel",
      required: true,
      index: true,
    },
    channelName: {
      type: String,
      required: true,
      trim: true,
    },
    channelKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    items: {
      type: [orderItemSchema],
      default: [],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: "Order must contain at least one item",
      },
    },
    totalQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalFocQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCifUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWholesaleAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalRetailAed: {
      type: Number,
      default: 0,
      min: 0,
    },
    invoiceNumber: {
      type: String,
      trim: true,
      index: true,
    },
    matchedSalesRecordId: {
      type: Schema.Types.ObjectId,
      ref: "SalesRecord",
    },
    salesSheetMatchedAt: Date,
    salesSheetReference: {
      type: String,
      trim: true,
    },
    emailGeneratedAt: Date,
    emailSentAt: Date,
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

orderSchema.index({
  orderNumber: "text",
  "account.accountName": "text",
  medicalRepName: "text",
  channelName: "text",
  "items.productName": "text",
  "items.productNickname": "text",
  notes: "text",
});
orderSchema.index({ medicalRepId: 1, orderDate: -1 });
orderSchema.index({ "account.accountId": 1, orderDate: -1 });
orderSchema.index({ status: 1, isActive: 1, orderDate: -1 });

orderSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("Order", orderSchema);
