const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Area = require("../../models/Area");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { resolveOrgId } = require("../../helpers/tenancy");

const router = express.Router();

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
    return res.status(403).json({ success: false, message: "Only managers can manage areas" });
  }

  return next();
};

const normalizeAreaPayload = (body = {}) => {
  const payload = {};
  const fields = ["areaName", "areaCode", "teamId", "managerId", "description", "status", "isActive"];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  if (Array.isArray(body.userIds)) {
    payload.userIds = [...new Set(body.userIds.map((userId) => String(userId).trim()).filter(Boolean))];
  }

  if (payload.areaCode) {
    payload.areaCode = String(payload.areaCode).trim().toUpperCase();
  }

  if (payload.status !== undefined) {
    payload.status = String(payload.status).trim().toLowerCase();
    payload.isActive = payload.status === "active";
  } else if (payload.isActive !== undefined) {
    payload.isActive = normalizeBoolean(payload.isActive);
    payload.status = payload.isActive ? "active" : "inactive";
  }

  return payload;
};

const validateAreaPayload = (payload, { partial = false } = {}) => {
  if (!partial && !payload.areaName) {
    return "areaName is required";
  }

  if (payload.status && !["active", "inactive"].includes(payload.status)) {
    return "status must be active or inactive";
  }

  for (const field of ["teamId", "managerId"]) {
    if (payload[field] && !isValidObjectId(payload[field])) {
      return `${field} must be a valid MongoDB ObjectId`;
    }
  }

  if (payload.userIds && !payload.userIds.every((userId) => isValidObjectId(userId))) {
    return "userIds must be valid MongoDB ObjectIds";
  }

  return null;
};

router.post("/", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const payload = normalizeAreaPayload(req.body);
    const validationError = validateAreaPayload(payload);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const area = await Area.create({
      ...payload,
      status: payload.status || "active",
      isActive: payload.isActive !== undefined ? payload.isActive : true,
      organizationId: resolveOrgId(req.currentUser),
      createdBy: req.currentUser._id,
      updatedBy: req.currentUser._id,
    });

    return res.status(201).json({ success: true, message: "Area created successfully", data: area });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = { organizationId: resolveOrgId(req.currentUser) };

    if (!isManagerRole(req.currentUser.role)) {
      query.status = "active";
      query.isActive = true;
    } else if (req.query.status) {
      query.status = String(req.query.status).trim().toLowerCase();
    }

    if (req.query.teamId) {
      query.teamId = isValidObjectId(req.query.teamId) ? req.query.teamId : null;
    }

    if (req.query.managerId) {
      query.managerId = isValidObjectId(req.query.managerId) ? req.query.managerId : null;
    }

    if (req.query.search) {
      const search = String(req.query.search).trim();
      query.$or = [
        { areaName: { $regex: search, $options: "i" } },
        { areaCode: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const [areas, total] = await Promise.all([
      Area.find(query)
        .populate("teamId", "teamName teamCode")
        .populate("managerId", "fullName email role")
        .populate("userIds", "fullName email role")
        .sort({ areaName: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Area.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Areas fetched successfully",
      data: areas,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Area id must be a valid MongoDB ObjectId" });
    }

    const query = { _id: req.params.id };

    if (!isManagerRole(req.currentUser.role)) {
      query.status = "active";
      query.isActive = true;
    }

    const area = await Area.findOne(query)
      .populate("teamId", "teamName teamCode")
      .populate("managerId", "fullName email role")
      .populate("userIds", "fullName email role");

    if (!area) {
      return res.status(404).json({ success: false, message: "Area not found" });
    }

    return res.status(200).json({ success: true, message: "Area fetched successfully", data: area });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Area id must be a valid MongoDB ObjectId" });
    }

    const payload = normalizeAreaPayload(req.body);
    const validationError = validateAreaPayload(payload, { partial: true });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const area = await Area.findByIdAndUpdate(
      req.params.id,
      { $set: { ...payload, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!area) {
      return res.status(404).json({ success: false, message: "Area not found" });
    }

    return res.status(200).json({ success: true, message: "Area updated successfully", data: area });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Area id must be a valid MongoDB ObjectId" });
    }

    const status = String(req.body.status || "").trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active or inactive" });
    }

    const area = await Area.findByIdAndUpdate(
      req.params.id,
      { $set: { status, isActive: status === "active", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!area) {
      return res.status(404).json({ success: false, message: "Area not found" });
    }

    return res.status(200).json({ success: true, message: "Area status updated successfully", data: area });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Area id must be a valid MongoDB ObjectId" });
    }

    const area = await Area.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "inactive", isActive: false, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!area) {
      return res.status(404).json({ success: false, message: "Area not found" });
    }

    return res.status(200).json({ success: true, message: "Area deactivated successfully", data: area });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
