const mongoose = require("mongoose");

const { Schema } = mongoose;

const areaSchema = new Schema(
  {
    areaName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    areaCode: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      uppercase: true,
      index: true,
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
    userIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        index: true,
      },
    ],
    description: {
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

areaSchema.pre("validate", function syncAreaStatus(next) {
  if (this.areaCode) {
    this.areaCode = String(this.areaCode).trim().toUpperCase();
  }

  if (this.isModified("status") && this.status) {
    this.isActive = this.status === "active";
  } else if (this.isModified("isActive")) {
    this.status = this.isActive ? "active" : "inactive";
  }

  next();
});

areaSchema.index({ areaName: "text", areaCode: "text", description: "text" });

areaSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("Area", areaSchema);
