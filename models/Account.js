const mongoose = require("mongoose");

const { Schema } = mongoose;

const locationSchema = new Schema(
  {
    address: {
      type: String,
      trim: true,
    },
    googleMapsLink: {
      type: String,
      trim: true,
    },
    coordinates: {
      latitude: Number,
      longitude: Number,
    },
  },
  { _id: false },
);

const lastPlannedVisitSchema = new Schema(
  {
    planId: {
      type: String,
      trim: true,
    },
    date: Date,
  },
  { _id: false },
);

const accountSchema = new Schema(
  {
    accountName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    accountType: {
      type: String,
      enum: ["clinic", "hospital", "pharmacy", "other"],
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    keyContact: {
      type: String,
      trim: true,
    },
    contactPersonEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
    },
    area: {
      type: String,
      trim: true,
      index: true,
    },
    territory: {
      type: String,
      trim: true,
      index: true,
    },
    accountNameKey: {
      type: String,
      trim: true,
      index: true,
      select: false,
    },
    phoneNumberKey: {
      type: String,
      trim: true,
      index: true,
      select: false,
    },
    googleMapsLinkKey: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
      select: false,
    },
    addressKey: {
      type: String,
      trim: true,
      index: true,
      select: false,
    },
    location: {
      type: locationSchema,
      default: () => ({}),
    },
    assignedMedicalRepIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        index: true,
      },
    ],
    lastPlannedVisit: {
      type: lastPlannedVisitSchema,
      default: () => ({}),
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

accountSchema.index({
  accountName: "text",
  keyContact: "text",
  contactPersonEmail: "text",
  phoneNumber: "text",
  area: "text",
  territory: "text",
  "location.address": "text",
});
accountSchema.index({ accountNameKey: 1, phoneNumberKey: 1 }, { sparse: true });
accountSchema.index({ accountNameKey: 1, addressKey: 1 }, { sparse: true });

module.exports = mongoose.model("Account", accountSchema);
