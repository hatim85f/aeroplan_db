const mongoose = require("mongoose");

const { Schema } = mongoose;

const accountForecastSchema = new Schema(
  {
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
    inputType: {
      type: String,
      enum: ["units", "value"],
      required: true,
    },
    forecastQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    forecastValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    notes: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["planned", "ordered", "sold", "missed", "cancelled"],
      default: "planned",
      index: true,
    },
    linkedOrderIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    linkedSalesRecordIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "SalesRecord",
      },
    ],
  },
  { timestamps: true },
);

const forecastChannelSchema = new Schema(
  {
    targetAssignmentId: {
      type: Schema.Types.ObjectId,
      ref: "TargetAssignment",
      required: true,
      index: true,
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
    },
    targetUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetUnitValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetValueBasis: {
      type: String,
      enum: ["cifUsd", "wholesaleAed", "retailAed"],
      default: "cifUsd",
    },
    targetCurrency: {
      type: String,
      enum: ["USD", "AED"],
      default: "USD",
    },
    forecastUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    forecastValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    deficitUnits: {
      type: Number,
      default: 0,
    },
    deficitValue: {
      type: Number,
      default: 0,
    },
    coveragePercentage: {
      type: Number,
      default: 0,
    },
    accountForecasts: {
      type: [accountForecastSchema],
      default: [],
    },
  },
  { _id: false },
);

const forecastItemSchema = new Schema(
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
    totalItemTargetUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalItemTargetValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalItemForecastUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalItemForecastValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    itemDeficitUnits: {
      type: Number,
      default: 0,
    },
    itemDeficitValue: {
      type: Number,
      default: 0,
    },
    itemCoveragePercentage: {
      type: Number,
      default: 0,
    },
    channels: {
      type: [forecastChannelSchema],
      default: [],
    },
  },
  { _id: false },
);

const forecastMonthSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    teamId: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      index: true,
    },
    lineId: {
      type: String,
      trim: true,
      uppercase: true,
      index: true,
    },
    lineName: {
      type: String,
      trim: true,
    },
    year: {
      type: Number,
      required: true,
      index: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      index: true,
    },
    totalMonthlyTargetUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalMonthlyTargetValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalForecastUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalForecastValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDeficitUnits: {
      type: Number,
      default: 0,
    },
    totalDeficitValue: {
      type: Number,
      default: 0,
    },
    totalCoveragePercentage: {
      type: Number,
      default: 0,
    },
    items: {
      type: [forecastItemSchema],
      default: [],
    },
    forecastStatus: {
      type: String,
      enum: ["draft", "submitted", "reviewed", "closed"],
      default: "draft",
      index: true,
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

forecastMonthSchema.index(
  {
    userId: 1,
    year: 1,
    month: 1,
    isActive: 1,
  },
  { unique: true },
);
forecastMonthSchema.index({
  managerId: 1,
  teamId: 1,
  year: 1,
  month: 1,
  isActive: 1,
});

module.exports = mongoose.model("ForecastMonth", forecastMonthSchema);
