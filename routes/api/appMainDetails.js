const express = require("express");
const auth = require("../../middleware/auth");
const AppMainDetails = require("../../models/AppMainDetails");
const User = require("../../models/User");

const router = express.Router();

const DEFAULT_APP_MAIN_DETAILS = {
  key: "main",
  appName: "AeroPlan",
  appTagline: "Medical field planning and team execution",
  websiteURL: "https://aeroplan.app",
  logo: "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779485968/icon_opc5om.png",
  appWhiteLogo: "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779485925/logo_white_gmtwl5.png",
  favIcon: "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779485967/favicon_bmj72h.png",
  colors: {
    backgroundColor: "#F7F9FC",
    surface: "#ffffff",
    surfaceSoft: "#f3f7ff",
    primary: "#0f6fff",
    primaryDark: "#0757d7",
    primaryLight: "#dbeaff",
    secondary: "#6b46ff",
    success: "#18c287",
    warning: "#f6a900",
    danger: "#ef4444",
    textPrimary: "#07122f",
    textSecondary: "#536179",
    textMuted: "#8b97aa",
    border: "#dfe7f3",
    inputBackground: "#ffffff",
    shadow: "#b2b6",
    white: "#ffffff",
    black: "#000000",
  },
  theme: {
    defaultMode: "light",
    light: {
      backgroundColor: "#F6F4FB",
      surface: "#FFFFFF",
      surfaceSoft: "#EFEAFB",
      primary: "#6D5DFC",
      primaryDark: "#5546E0",
      primaryLight: "#EDEAFF",
      secondary: "#18A77E",
      success: "#18A77E",
      warning: "#E2873B",
      danger: "#E24B4A",
      textPrimary: "#2A2342",
      textSecondary: "#6B6385",
      textMuted: "#9A93AE",
      border: "#ECE8F6",
      inputBackground: "#FFFFFF",
      shadow: "#0B2B66",
      white: "#FFFFFF",
      black: "#000000",
    },
    dark: {
      backgroundColor: "#0E1626",
      surface: "#16223A",
      surfaceSoft: "#101C30",
      primary: "#5DCAA5",
      primaryDark: "#2C9C7C",
      primaryLight: "#1B2C48",
      secondary: "#F0997B",
      success: "#5DCAA5",
      warning: "#F0B98B",
      danger: "#F2557A",
      textPrimary: "#EAF1FA",
      textSecondary: "#8395AE",
      textMuted: "#5E7088",
      border: "#243450",
      inputBackground: "#16223A",
      shadow: "#000000",
      white: "#16223A",
      black: "#EAF1FA",
    },
  },
  appVersion: "1.0.0",
  buildNumber: "1",
  copyright: "© 2026 AeroPlan. All rights reserved.",
  minimumSupportedVersion: "1.0.0",
  forceUpdateVersion: "",
  maintenanceMode: false,
  maintenanceMessage: "",
  supportEmail: "support@aeroplan.app",
  links: {
    privacyPolicyURL: "https://aeroplan.app/privacy",
    termsURL: "https://aeroplan.app/terms",
    supportURL: "https://aeroplan.app/support",
  },
  featureFlags: {
    accountSelection: true,
    accountDuplicateChecks: true,
  },
};

const getOrCreateMainDetails = async () => {
  const details = await AppMainDetails.findOneAndUpdate(
    { key: "main" },
    { $setOnInsert: DEFAULT_APP_MAIN_DETAILS },
    { new: true, upsert: true, runValidators: true },
  );

  return details;
};

const requireAdmin = async (req, res, next) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  if (user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Only admins can update app main details",
    });
  }

  req.currentUser = user;
  return next();
};

const buildUpdatePayload = (body, userId) => {
  const allowedFields = [
    "appName",
    "appTagline",
    "websiteURL",
    "logo",
    "appWhiteLogo",
    "favIcon",
    "favIconWeb",
    "appIcon",
    "splashImage",
    "colors",
    "theme",
    "appVersion",
    "buildNumber",
    "copyright",
    "minimumSupportedVersion",
    "forceUpdateVersion",
    "maintenanceMode",
    "maintenanceMessage",
    "supportEmail",
    "links",
    "featureFlags",
  ];
  const update = {};

  allowedFields.forEach((field) => {
    if (body[field] !== undefined) {
      update[field] = body[field];
    }
  });

  update.lastUpdated = new Date();
  update.updatedBy = userId;

  return update;
};

router.get("/", async (req, res, next) => {
  try {
    const details = await getOrCreateMainDetails();

    return res.status(200).json({
      success: true,
      message: "App main details fetched successfully",
      data: details,
    });
  } catch (error) {
    return next(error);
  }
});

const upsertMainDetails = async (req, res, next) => {
  try {
    const update = buildUpdatePayload(req.body, req.user.id);
    const details = await AppMainDetails.findOneAndUpdate(
      { key: "main" },
      {
        $setOnInsert: DEFAULT_APP_MAIN_DETAILS,
        $set: update,
      },
      { new: true, upsert: true, runValidators: true },
    );

    return res.status(200).json({
      success: true,
      message: "App main details updated successfully",
      data: details,
    });
  } catch (error) {
    return next(error);
  }
};

router.post("/", auth, requireAdmin, upsertMainDetails);
router.put("/", auth, requireAdmin, upsertMainDetails);
router.patch("/", auth, requireAdmin, upsertMainDetails);

module.exports = router;
