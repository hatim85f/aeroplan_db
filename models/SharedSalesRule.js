const mongoose = require("mongoose");

const { Schema } = mongoose;

const sharedSalesRuleSchema = new Schema(
  {
    areaId: {
      type: Schema.Types.ObjectId,
      ref: "Area",
      required: true,
      index: true,
    },
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
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
    sharePercentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    startDate: {
      type: Date,
      index: true,
    },
    endDate: {
      type: Date,
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
      index: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

sharedSalesRuleSchema.pre("validate", function syncRuleStatus(next) {
  if (this.isModified("status") && this.status) {
    this.isActive = this.status === "active";
  } else if (this.isModified("isActive")) {
    this.status = this.isActive ? "active" : "inactive";
  }

  next();
});

sharedSalesRuleSchema.index({
  accountId: 1,
  productId: 1,
  channelId: 1,
  areaId: 1,
  status: 1,
  isActive: 1,
  startDate: 1,
  endDate: 1,
});
sharedSalesRuleSchema.index({ notes: "text" });

module.exports = mongoose.model("SharedSalesRule", sharedSalesRuleSchema);
