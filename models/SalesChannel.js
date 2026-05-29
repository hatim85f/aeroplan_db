const mongoose = require("mongoose");

const { Schema } = mongoose;

const normalizeChannelKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const salesChannelSchema = new Schema(
  {
    channelName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    channelKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    focEnabled: {
      type: Boolean,
      default: false,
    },
    allowRepOrders: {
      type: Boolean,
      default: false,
      index: true,
    },
    defaultTargetValueBasis: {
      type: String,
      enum: ["cifUsd", "wholesaleAed", "retailAed"],
      default: "cifUsd",
    },
    defaultTargetCurrency: {
      type: String,
      enum: ["USD", "AED"],
      default: "USD",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
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

salesChannelSchema.pre("validate", function normalizeBeforeValidate(next) {
  if (!this.channelKey && this.channelName) {
    this.channelKey = normalizeChannelKey(this.channelName);
  } else if (this.channelKey) {
    this.channelKey = normalizeChannelKey(this.channelKey);
  }

  const statusWasProvided = this.isModified("status") && this.status;
  const isActiveWasProvided = this.isModified("isActive");

  if (this.status) {
    this.status = String(this.status).trim().toLowerCase();
  }

  if (statusWasProvided && this.status === "active") {
    this.isActive = true;
  } else if (statusWasProvided && this.status === "inactive") {
    this.isActive = false;
  } else if (isActiveWasProvided) {
    this.status = this.isActive ? "active" : "inactive";
  } else if (this.status === "active") {
    this.isActive = true;
  } else if (this.status === "inactive") {
    this.isActive = false;
  }

  next();
});

salesChannelSchema.path("channelKey").validate(function validateChannelKey(value) {
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
}, "channelKey must be lowercase and URL-safe");

salesChannelSchema.index({
  channelName: "text",
  channelKey: "text",
  description: "text",
});

salesChannelSchema.statics.normalizeChannelKey = normalizeChannelKey;

module.exports = mongoose.model("SalesChannel", salesChannelSchema);
