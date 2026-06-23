const mongoose = require("mongoose");

const { Schema } = mongoose;

const normalizeTextKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/\s+/g, " ");

const normalizePhoneKey = (value) => String(value || "").replace(/[^\d+]/g, "");

const normalizeGoogleMapsLinkKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/\/+$/, "");

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
      enum: ["clinic", "hospital", "pharmacy", "drugstore", "other"],
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
    salesTeamIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "SalesTeamMember",
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

accountSchema.pre("validate", function normalizeAccountKeys(next) {
  if (this.accountName) {
    this.accountNameKey = normalizeTextKey(this.accountName);
  }

  if (this.phoneNumber) {
    this.phoneNumberKey = normalizePhoneKey(this.phoneNumber) || undefined;
  }

  if (this.location?.googleMapsLink) {
    this.googleMapsLinkKey = normalizeGoogleMapsLinkKey(this.location.googleMapsLink) || undefined;
  }

  if (this.location?.address) {
    this.addressKey = normalizeTextKey(this.location.address) || undefined;
  }

  next();
});

accountSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("Account", accountSchema);
