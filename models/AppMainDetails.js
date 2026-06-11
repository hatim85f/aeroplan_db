const mongoose = require("mongoose");

const { Schema } = mongoose;

const colorsSchema = new Schema(
  {
    backgroundColor: { type: String, trim: true },
    surface: { type: String, trim: true },
    surfaceSoft: { type: String, trim: true },
    primary: { type: String, trim: true },
    primaryDark: { type: String, trim: true },
    primaryLight: { type: String, trim: true },
    secondary: { type: String, trim: true },
    success: { type: String, trim: true },
    warning: { type: String, trim: true },
    danger: { type: String, trim: true },
    textPrimary: { type: String, trim: true },
    textSecondary: { type: String, trim: true },
    textMuted: { type: String, trim: true },
    border: { type: String, trim: true },
    inputBackground: { type: String, trim: true },
    shadow: { type: String, trim: true },
    white: { type: String, trim: true },
    black: { type: String, trim: true },
  },
  { _id: false },
);

const linksSchema = new Schema(
  {
    privacyPolicyURL: { type: String, trim: true },
    termsURL: { type: String, trim: true },
    supportURL: { type: String, trim: true },
  },
  { _id: false },
);

// Full light + dark theme palettes. defaultMode is the theme a user gets before
// they pick one in Settings ("light", "dark", or "system").
const themeSchema = new Schema(
  {
    defaultMode: { type: String, enum: ["light", "dark", "system"], default: "light" },
    light: { type: colorsSchema, default: () => ({}) },
    dark: { type: colorsSchema, default: () => ({}) },
  },
  { _id: false },
);

const appMainDetailsSchema = new Schema(
  {
    key: {
      type: String,
      default: "main",
      unique: true,
      immutable: true,
      index: true,
    },
    appName: {
      type: String,
      default: "AeroPlan",
      trim: true,
    },
    appTagline: {
      type: String,
      default: "Medical field planning and team execution",
      trim: true,
    },
    websiteURL: {
      type: String,
      default: "https://aeroplan.app",
      trim: true,
    },
    logo: {
      type: String,
      trim: true,
    },
    appWhiteLogo: {
      type: String,
      trim: true,
    },
    favIcon: {
      type: String,
      trim: true,
    },
    favIconWeb: {
      type: String,
      trim: true,
    },
    appIcon: {
      type: String,
      trim: true,
    },
    splashImage: {
      type: String,
      trim: true,
    },
    colors: {
      type: colorsSchema,
      default: () => ({}),
    },
    theme: {
      type: themeSchema,
      default: () => ({}),
    },
    appVersion: {
      type: String,
      default: "1.0.0",
      trim: true,
    },
    buildNumber: {
      type: String,
      default: "1",
      trim: true,
    },
    copyright: {
      type: String,
      default: "© 2026 AeroPlan. All rights reserved.",
      trim: true,
    },
    minimumSupportedVersion: {
      type: String,
      default: "1.0.0",
      trim: true,
    },
    forceUpdateVersion: {
      type: String,
      default: "",
      trim: true,
    },
    maintenanceMode: {
      type: Boolean,
      default: false,
    },
    maintenanceMessage: {
      type: String,
      default: "",
      trim: true,
    },
    supportEmail: {
      type: String,
      default: "support@aeroplan.app",
      trim: true,
      lowercase: true,
    },
    links: {
      type: linksSchema,
      default: () => ({}),
    },
    featureFlags: {
      type: Map,
      of: Boolean,
      default: () => ({}),
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    collection: "appMainDetails",
    timestamps: true,
  },
);

module.exports = mongoose.model("AppMainDetails", appMainDetailsSchema);
