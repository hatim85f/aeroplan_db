const mongoose = require("mongoose");

const { Schema } = mongoose;

const userSnapshotSchema = new Schema(
  {
    fullName: {
      type: String,
      trim: true,
    },
    userName: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    appId: {
      type: String,
      trim: true,
    },
    lineId: {
      type: String,
      trim: true,
    },
    territory: {
      type: String,
      trim: true,
    },
    area: {
      type: String,
      trim: true,
    },
  },
  { _id: false },
);

const productSnapshotSchema = new Schema(
  {
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    productNickname: {
      type: String,
      trim: true,
    },
    lineId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    lineName: {
      type: String,
      trim: true,
    },
  },
  { _id: false },
);

const assignmentSchema = new Schema(
  {
    medicalRepId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    medicalRepSnapshot: {
      type: userSnapshotSchema,
      default: () => ({}),
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    productSnapshot: {
      type: productSnapshotSchema,
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
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
    assignedBy: {
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

assignmentSchema.index({
  medicalRepId: 1,
  productId: 1,
  status: 1,
  isActive: 1,
  startDate: 1,
  endDate: 1,
});
assignmentSchema.index({ "productSnapshot.lineId": 1, status: 1, isActive: 1 });

module.exports = mongoose.model("MedicalRepProductAssignment", assignmentSchema);
