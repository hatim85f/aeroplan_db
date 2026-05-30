const mongoose = require("mongoose");

const { Schema } = mongoose;

const phasingMonthSchema = new Schema(
  {
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    monthName: {
      type: String,
      trim: true,
    },
    percentage: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false },
);

const targetPhasingSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    year: {
      type: Number,
      required: true,
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
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      index: true,
    },
    channelId: {
      type: Schema.Types.ObjectId,
      ref: "SalesChannel",
      index: true,
    },
    months: {
      type: [phasingMonthSchema],
      default: [],
      validate: {
        validator(value) {
          if (!Array.isArray(value) || value.length === 0) {
            return false;
          }

          const months = value.map((entry) => entry.month);
          const uniqueMonths = new Set(months);

          if (months.length !== uniqueMonths.size) {
            return false;
          }

          const totalPercentage = value.reduce((sum, entry) => sum + (Number(entry.percentage) || 0), 0);
          return Math.abs(totalPercentage - 100) < 0.0001;
        },
        message: "Phasing months must be unique and total percentage must equal 100",
      },
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
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

targetPhasingSchema.index({
  year: 1,
  teamId: 1,
  lineId: 1,
  productId: 1,
  channelId: 1,
  isDefault: 1,
  isActive: 1,
});
targetPhasingSchema.index({
  name: "text",
  lineId: "text",
});

module.exports = mongoose.model("TargetPhasing", targetPhasingSchema);
