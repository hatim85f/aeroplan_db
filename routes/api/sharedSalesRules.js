const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Area = require("../../models/Area");
const Account = require("../../models/Account");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const SharedSalesRule = require("../../models/SharedSalesRule");
const User = require("../../models/User");
const { buildRuleRecalculationInput, recalculateSharedSales } = require("../../helpers/sharedSales");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const APPLY_CHANGE_MODES = ["future_only", "retrospective_from_date", "all_existing"];
const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const parseDate = (value, fieldName = "date") => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }

  return date;
};

const getCurrentUser = async (req) => User.findById(req.user.id);

const loadActor = async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    req.currentUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

const requireManager = (req, res, next) => {
  if (!isManagerRole(req.currentUser.role)) {
    return res.status(403).json({ success: false, message: "Only managers can manage shared sales rules" });
  }

  return next();
};

const normalizeRulePayload = (body = {}) => {
  const payload = {};
  const fields = [
    "areaId",
    "accountId",
    "productId",
    "channelId",
    "sharePercentage",
    "status",
    "isActive",
    "notes",
  ];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  if (body.startDate !== undefined) {
    payload.startDate = parseDate(body.startDate, "startDate");
  }

  if (body.endDate !== undefined) {
    payload.endDate = parseDate(body.endDate, "endDate");
  }

  if (payload.status !== undefined) {
    payload.status = String(payload.status).trim().toLowerCase();
    payload.isActive = payload.status === "active";
  }

  if (payload.productId === "") {
    payload.productId = undefined;
  }

  if (payload.channelId === "") {
    payload.channelId = undefined;
  }

  return payload;
};

const validateRulePayload = async (payload, { partial = false } = {}) => {
  if (!partial && !payload.areaId) {
    return "areaId is required";
  }

  if (!partial && !payload.accountId) {
    return "accountId is required";
  }

  if (!partial && payload.sharePercentage === undefined) {
    return "sharePercentage is required";
  }

  const objectIdFields = ["areaId", "accountId", "productId", "channelId"];

  for (const field of objectIdFields) {
    if (payload[field] !== undefined && payload[field] && !isValidObjectId(payload[field])) {
      return `${field} must be a valid MongoDB ObjectId`;
    }
  }

  if (payload.sharePercentage !== undefined) {
    const sharePercentage = Number(payload.sharePercentage);

    if (!Number.isFinite(sharePercentage) || sharePercentage < 0 || sharePercentage > 100) {
      return "sharePercentage must be a number between 0 and 100";
    }

    payload.sharePercentage = sharePercentage;
  }

  if (payload.status && !["active", "inactive"].includes(payload.status)) {
    return "status must be active or inactive";
  }

  if (payload.startDate && payload.endDate && payload.endDate < payload.startDate) {
    return "endDate must be after startDate";
  }

  const lookups = [
    ["areaId", Area, "Area"],
    ["accountId", Account, "Account"],
    ["productId", Product, "Product"],
    ["channelId", SalesChannel, "Sales channel"],
  ];

  for (const [field, Model, label] of lookups) {
    if (payload[field]) {
      const exists = await Model.exists({ _id: payload[field] });

      if (!exists) {
        return `${label} not found`;
      }
    }
  }

  return null;
};

const buildRuleQuery = (queryParams = {}) => {
  const query = {};

  ["areaId", "accountId", "productId", "channelId"].forEach((field) => {
    if (queryParams[field]) {
      query[field] = isValidObjectId(queryParams[field])
        ? new mongoose.Types.ObjectId(queryParams[field])
        : null;
    }
  });

  if (queryParams.status) {
    query.status = String(queryParams.status).trim().toLowerCase();
  }

  if (queryParams.dateFrom || queryParams.dateTo) {
    const dateFrom = parseDate(queryParams.dateFrom, "dateFrom");
    const dateTo = parseDate(queryParams.dateTo, "dateTo");
    query.$and = query.$and || [];

    if (dateFrom) {
      query.$and.push({
        $or: [
          { endDate: { $exists: false } },
          { endDate: null },
          { endDate: { $gte: dateFrom } },
        ],
      });
    }

    if (dateTo) {
      query.$and.push({
        $or: [
          { startDate: { $exists: false } },
          { startDate: null },
          { startDate: { $lte: dateTo } },
        ],
      });
    }
  }

  return query;
};

const populateRule = (query) => query
  .populate("areaId", "areaName areaCode")
  .populate("accountId", "accountName")
  .populate("productId", "productName productNickname")
  .populate("channelId", "channelName channelKey");

const normalizeApplyChangeMode = (body = {}) => {
  const applyChangeMode = String(body.applyChangeMode || "future_only").trim();

  if (!APPLY_CHANGE_MODES.includes(applyChangeMode)) {
    const error = new Error("applyChangeMode must be future_only, retrospective_from_date, or all_existing");
    error.statusCode = 400;
    throw error;
  }

  return {
    applyChangeMode,
    effectiveFromDate: parseDate(body.effectiveFromDate, "effectiveFromDate"),
  };
};

const maybeRecalculateForRule = async (rule, body, user) => {
  const applyOptions = normalizeApplyChangeMode(body);
  const recalculationInput = buildRuleRecalculationInput(rule, {
    ...applyOptions,
    updatedBy: user._id,
  });

  if (!recalculationInput) {
    return null;
  }

  return recalculateSharedSales(recalculationInput);
};

router.post("/", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const payload = normalizeRulePayload(req.body);
    const validationError = await validateRulePayload(payload);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const rule = await SharedSalesRule.create({
      ...payload,
      status: payload.status || "active",
      isActive: payload.isActive !== undefined ? payload.isActive : true,
      createdBy: req.currentUser._id,
      updatedBy: req.currentUser._id,
    });
    const recalculation = await maybeRecalculateForRule(rule, req.body, req.currentUser);

    return res.status(201).json({
      success: true,
      message: "Shared sales rule created successfully",
      data: { rule, recalculation },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = buildRuleQuery(req.query);

    if (!isManagerRole(req.currentUser.role)) {
      query.status = "active";
      query.isActive = true;
    }

    const [rules, total] = await Promise.all([
      populateRule(SharedSalesRule.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)),
      SharedSalesRule.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Shared sales rules fetched successfully",
      data: rules,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Shared sales rule id must be a valid MongoDB ObjectId" });
    }

    const query = { _id: req.params.id };

    if (!isManagerRole(req.currentUser.role)) {
      query.status = "active";
      query.isActive = true;
    }

    const rule = await populateRule(SharedSalesRule.findOne(query));

    if (!rule) {
      return res.status(404).json({ success: false, message: "Shared sales rule not found" });
    }

    return res.status(200).json({ success: true, message: "Shared sales rule fetched successfully", data: rule });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Shared sales rule id must be a valid MongoDB ObjectId" });
    }

    const payload = normalizeRulePayload(req.body);
    const validationError = await validateRulePayload(payload, { partial: true });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const rule = await SharedSalesRule.findByIdAndUpdate(
      req.params.id,
      { $set: { ...payload, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: "Shared sales rule not found" });
    }

    const recalculation = await maybeRecalculateForRule(rule, req.body, req.currentUser);

    return res.status(200).json({
      success: true,
      message: "Shared sales rule updated successfully",
      data: { rule, recalculation },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Shared sales rule id must be a valid MongoDB ObjectId" });
    }

    const status = String(req.body.status || "").trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active or inactive" });
    }

    const rule = await SharedSalesRule.findByIdAndUpdate(
      req.params.id,
      { $set: { status, isActive: status === "active", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: "Shared sales rule not found" });
    }

    const recalculation = await maybeRecalculateForRule(rule, req.body, req.currentUser);

    return res.status(200).json({
      success: true,
      message: "Shared sales rule status updated successfully",
      data: { rule, recalculation },
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Shared sales rule id must be a valid MongoDB ObjectId" });
    }

    const rule = await SharedSalesRule.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "inactive", isActive: false, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: "Shared sales rule not found" });
    }

    const recalculation = await maybeRecalculateForRule(rule, req.body, req.currentUser);

    return res.status(200).json({
      success: true,
      message: "Shared sales rule deactivated successfully",
      data: { rule, recalculation },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
