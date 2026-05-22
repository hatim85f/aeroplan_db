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
    keyContact: {
      type: String,
      trim: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
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
  phoneNumber: "text",
  "location.address": "text",
});

module.exports = mongoose.model("Account", accountSchema);
