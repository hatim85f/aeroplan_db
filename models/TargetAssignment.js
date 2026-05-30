const mongoose = require("mongoose");

const { Schema } = mongoose;

const targetAssignmentSchema = new Schema(
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
    medicalRepStatus: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    medicalRepIsActive: {
      type: Boolean,
      default: true,
      index: true,
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
    year: {
      type: Number,
      required: true,
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
    accountabilityPercentage: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    totalTargetUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalTargetValue: {
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

targetAssignmentSchema.index({
  userId: 1,
  productId: 1,
  channelId: 1,
  status: 1,
  isActive: 1,
  startDate: 1,
  endDate: 1,
});
targetAssignmentSchema.index({
  userName: "text",
  productName: "text",
  productNickname: "text",
  channelName: "text",
  notes: "text",
});

module.exports = mongoose.model("TargetAssignment", targetAssignmentSchema);
