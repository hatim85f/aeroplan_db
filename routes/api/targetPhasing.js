const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const TargetPhasing = require("../../models/TargetPhasing");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { resolveOrgId } = require("../../helpers/tenancy");

const router = express.Router();

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const normalizeLineId = (lineId) => String(lineId || "").trim().toUpperCase();

const getCurrentUser = async (req) => User.findById(req.user.id);

const loadActor = async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    req.currentUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

const requireManager = (req, res, next) => {
  if (!isManagerRole(req.currentUser.role)) {
    return res.status(403).json({
      success: false,
      message: "Only managers can manage target phasing",
    });
  }

  return next();
};

const normalizeYear = (value) => {
  const year = Number(value);

  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    const error = new Error("year must be a valid four digit year");
    error.statusCode = 400;
    throw error;
  }

  return year;
};

const normalizeObjectIdField = (value, fieldName) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (!isValidObjectId(value)) {
    const error = new Error(`${fieldName} must be a valid MongoDB ObjectId`);
    error.statusCode = 400;
    throw error;
  }

  return value;
};

const normalizeMonths = (months) => {
  if (!Array.isArray(months) || months.length === 0) {
    const error = new Error("months must be a non-empty array");
    error.statusCode = 400;
    throw error;
  }

  return months.map((entry, index) => {
    const month = Number(entry.month);
    const percentage = Number(entry.percentage);

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      const error = new Error(`months.${index}.month must be between 1 and 12`);
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isFinite(percentage) || percentage < 0) {
      const error = new Error(`months.${index}.percentage must be a number greater than or equal to 0`);
      error.statusCode = 400;
      throw error;
    }

    return {
      month,
      monthName: entry.monthName || MONTH_NAMES[month - 1],
      percentage,
    };
  });
};

const normalizePayload = (body = {}, { partial = false } = {}) => {
  const payload = {};

  if (body.name !== undefined) {
    payload.name = body.name;
  }

  if (body.year !== undefined) {
    payload.year = normalizeYear(body.year);
  } else if (!partial) {
    const error = new Error("year is required");
    error.statusCode = 400;
    throw error;
  }

  if (body.teamId !== undefined) {
    payload.teamId = normalizeObjectIdField(body.teamId, "teamId");
  }

  if (body.lineId !== undefined) {
    payload.lineId = normalizeLineId(body.lineId);
  }

  if (body.productId !== undefined) {
    payload.productId = normalizeObjectIdField(body.productId, "productId");
  }

  if (body.channelId !== undefined) {
    payload.channelId = normalizeObjectIdField(body.channelId, "channelId");
  }

  if (body.months !== undefined) {
    payload.months = normalizeMonths(body.months);
  }

  if (body.status !== undefined) {
    const status = String(body.status).trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
      const error = new Error("status must be active or inactive");
      error.statusCode = 400;
      throw error;
    }

    payload.status = status;
    payload.isActive = status === "active";
  } else if (body.isActive !== undefined) {
    payload.isActive = normalizeBoolean(body.isActive);
    payload.status = payload.isActive ? "active" : "inactive";
  }

  if (body.isDefault !== undefined) {
    payload.isDefault = normalizeBoolean(body.isDefault);
  }

  if (!partial && !payload.name) {
    const error = new Error("name is required");
    error.statusCode = 400;
    throw error;
  }

  if (!partial && !payload.months) {
    const error = new Error("months is required");
    error.statusCode = 400;
    throw error;
  }

  return payload;
};

const getDefaultScopeQuery = (phasing) => ({
  year: phasing.year,
  teamId: phasing.teamId || null,
  lineId: phasing.lineId || null,
  productId: phasing.productId || null,
  channelId: phasing.channelId || null,
  isDefault: true,
  isActive: true,
});

const clearCompetingDefault = async (phasing) => {
  if (!phasing.isDefault) {
    return;
  }

  const scopeQuery = getDefaultScopeQuery(phasing);

  await TargetPhasing.updateMany(
    {
      _id: { $ne: phasing._id },
      ...scopeQuery,
    },
    {
      $set: {
        isDefault: false,
      },
    },
  );
};

const buildQuery = (queryParams = {}) => {
  const query = {};

  if (queryParams.year !== undefined) {
    query.year = normalizeYear(queryParams.year);
  }

  if (queryParams.teamId !== undefined) {
    query.teamId = normalizeObjectIdField(queryParams.teamId, "teamId");
  }

  if (queryParams.lineId !== undefined) {
    query.lineId = normalizeLineId(queryParams.lineId);
  }

  if (queryParams.productId !== undefined) {
    query.productId = normalizeObjectIdField(queryParams.productId, "productId");
  }

  if (queryParams.channelId !== undefined) {
    query.channelId = normalizeObjectIdField(queryParams.channelId, "channelId");
  }

  if (queryParams.status !== undefined) {
    const status = String(queryParams.status).trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
      const error = new Error("status must be active or inactive");
      error.statusCode = 400;
      throw error;
    }

    query.status = status;
  }

  if (queryParams.isDefault !== undefined) {
    query.isDefault = normalizeBoolean(queryParams.isDefault);
  }

  return query;
};

const populatePhasing = (query) => query
  .populate("teamId", "teamName teamCode lineId lineName")
  .populate("productId", "productName productNickname lineId lineName")
  .populate("channelId", "channelName channelKey")
  .populate("createdBy", "fullName email appId role")
  .populate("updatedBy", "fullName email appId role");

router.post("/", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const payload = normalizePayload(req.body);
    const phasing = await TargetPhasing.create({
      ...payload,
      organizationId: resolveOrgId(req.currentUser),
      createdBy: req.currentUser._id,
      updatedBy: req.currentUser._id,
    });

    await clearCompetingDefault(phasing);

    const populatedPhasing = await populatePhasing(TargetPhasing.findById(phasing._id));

    return res.status(201).json({
      success: true,
      message: "Target phasing created successfully",
      data: populatedPhasing,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadActor, async (req, res, next) => {
  try {
    const query = { ...buildQuery(req.query), organizationId: resolveOrgId(req.currentUser) };
    const phasing = await populatePhasing(TargetPhasing.find(query).sort({ year: -1, createdAt: -1 }));

    return res.status(200).json({
      success: true,
      message: "Target phasing fetched successfully",
      data: phasing,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target phasing id must be a valid MongoDB ObjectId",
      });
    }

    const phasing = await populatePhasing(TargetPhasing.findById(req.params.id));

    if (!phasing) {
      return res.status(404).json({
        success: false,
        message: "Target phasing not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Target phasing fetched successfully",
      data: phasing,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target phasing id must be a valid MongoDB ObjectId",
      });
    }

    const payload = normalizePayload(req.body, { partial: true });

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update target phasing",
      });
    }

    const phasing = await TargetPhasing.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...payload,
          updatedBy: req.currentUser._id,
        },
      },
      { new: true, runValidators: true },
    );

    if (!phasing) {
      return res.status(404).json({
        success: false,
        message: "Target phasing not found",
      });
    }

    await clearCompetingDefault(phasing);

    const populatedPhasing = await populatePhasing(TargetPhasing.findById(phasing._id));

    return res.status(200).json({
      success: true,
      message: "Target phasing updated successfully",
      data: populatedPhasing,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target phasing id must be a valid MongoDB ObjectId",
      });
    }

    if (req.body.status === undefined && req.body.isActive === undefined) {
      return res.status(400).json({
        success: false,
        message: "status or isActive is required",
      });
    }

    const status = req.body.status !== undefined
      ? String(req.body.status).trim().toLowerCase()
      : normalizeBoolean(req.body.isActive)
        ? "active"
        : "inactive";

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive",
      });
    }

    const phasing = await TargetPhasing.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status,
          isActive: status === "active",
          updatedBy: req.currentUser._id,
        },
      },
      { new: true, runValidators: true },
    );

    if (!phasing) {
      return res.status(404).json({
        success: false,
        message: "Target phasing not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Target phasing status updated successfully",
      data: phasing,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target phasing id must be a valid MongoDB ObjectId",
      });
    }

    const phasing = await TargetPhasing.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "inactive",
          isActive: false,
          updatedBy: req.currentUser._id,
        },
      },
      { new: true, runValidators: true },
    );

    if (!phasing) {
      return res.status(404).json({
        success: false,
        message: "Target phasing not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Target phasing deactivated successfully",
      data: phasing,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
