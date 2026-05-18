const mongoose = require("mongoose");

const { Schema } = mongoose;
const { createAppId } = require("../helpers/appId");

const performanceSnapshotSchema = new Schema(
  {
    year: Number,
    ytdTargetValue: { type: Number, default: 0 },
    ytdSalesValue: { type: Number, default: 0 },
    ytdAchievementPercentage: { type: Number, default: 0 },
    currentMonth: Number,
    currentMonthTargetValue: { type: Number, default: 0 },
    currentMonthSalesValue: { type: Number, default: 0 },
    currentMonthAchievementPercentage: { type: Number, default: 0 },
    totalActiveAccounts: { type: Number, default: 0 },
    activeTasks: { type: Number, default: 0 },
    pendingOrders: { type: Number, default: 0 },
  },
  { _id: false },
);

const forecastSnapshotSchema = new Schema(
  {
    currentMonthForecastValue: { type: Number, default: 0 },
    currentMonthSalesValue: { type: Number, default: 0 },
    forecastAchievementPercentage: { type: Number, default: 0 },
    forecastDeviationValue: { type: Number, default: 0 },
    forecastDeviationPercentage: { type: Number, default: 0 },
    lastForecastUpdate: Date,
  },
  { _id: false },
);

const settingsSchema = new Schema(
  {
    language: { type: String, default: "en" },
    themePreference: {
      type: String,
      enum: ["system", "light", "dark"],
      default: "system",
    },
    notificationsEnabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const notificationTokenSchema = new Schema(
  {
    token: {
      type: String,
      required: true,
      trim: true,
    },
    platform: {
      type: String,
      enum: ["ios", "android", "web", "unknown"],
      default: "unknown",
    },
    deviceId: {
      type: String,
      trim: true,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
    },
    appId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      default: createAppId,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    verificationCodeHash: {
      type: String,
      select: false,
    },
    verificationCodeExpiresAt: {
      type: Date,
      select: false,
    },
    verificationCodeSentAt: {
      type: Date,
      select: false,
    },
    authProviders: [
      {
        type: String,
        enum: ["password"],
      },
    ],
    passwordHash: {
      type: String,
      select: false,
    },
    passwordResetCodeHash: {
      type: String,
      select: false,
    },
    passwordResetCodeExpiresAt: {
      type: Date,
      select: false,
    },
    passwordResetCodeSentAt: {
      type: Date,
      select: false,
    },

    userName: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    profilePicture: String,
    fullName: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    phoneE164: {
      type: String,
      trim: true,
    },
    designation: {
      type: String,
      trim: true,
    },
    position: {
      type: String,
      trim: true,
    },
    employeeCode: {
      type: String,
      trim: true,
    },
    joinDate: Date,
    teamId: {
      type: Schema.Types.ObjectId,
      ref: "Team",
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    path: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        index: true,
      },
    ],
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
    role: {
      type: String,
      enum: ["admin", "senior_manager", "manager", "representative"],
      default: "representative",
    },
    status: {
      type: String,
      enum: ["pending", "active", "suspended", "inactive"],
      default: "pending",
    },
    responsibleItems: [
      {
        type: Schema.Types.ObjectId,
        ref: "Item",
      },
    ],
    yearlyTargetValue: {
      type: Number,
      default: 0,
    },
    yearlyTargetUnits: {
      type: Number,
      default: 0,
    },
    targetYear: Number,
    performanceSnapshot: {
      type: performanceSnapshotSchema,
      default: () => ({}),
    },
    forecastSnapshot: {
      type: forecastSnapshotSchema,
      default: () => ({}),
    },
    settings: {
      type: settingsSchema,
      default: () => ({}),
    },
    lastLoginAt: Date,
    lastActivityAt: Date,
    onlineStatus: {
      type: String,
      enum: ["online", "offline", "away"],
      default: "offline",
    },
    notificationTokens: [notificationTokenSchema],
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
