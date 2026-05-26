const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const SalesChannel = require("../../models/SalesChannel");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const getCurrentUser = async (req) => User.findById(req.user.id);

const requireManager = async (req, res, next) => {
  const user = await getCurrentUser(req);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  if (!isManagerRole(user.role)) {
    return res.status(403).json({
      success: false,
      message: "Only managers can manage sales channels",
    });
  }

  req.currentUser = user;
  return next();
};

const normalizeSalesChannelPayload = (body, { partial = false } = {}) => {
  const payload = {};
  const fields = [
    "channelName",
    "channelKey",
    "description",
    "focEnabled",
    "allowRepOrders",
    "status",
    "isActive",
    "organizationId",
  ];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  if (payload.channelKey !== undefined) {
    payload.channelKey = SalesChannel.normalizeChannelKey(payload.channelKey);
  } else if (!partial && payload.channelName) {
    payload.channelKey = SalesChannel.normalizeChannelKey(payload.channelName);
  }

  if (payload.status !== undefined) {
    payload.status = String(payload.status).trim().toLowerCase();
    payload.isActive = payload.status === "active";
  } else if (payload.isActive !== undefined) {
    payload.isActive = normalizeBoolean(payload.isActive);
    payload.status = payload.isActive ? "active" : "inactive";
  }

  if (payload.focEnabled !== undefined) {
    payload.focEnabled = normalizeBoolean(payload.focEnabled);
  }

  if (payload.allowRepOrders !== undefined) {
    payload.allowRepOrders = normalizeBoolean(payload.allowRepOrders);
  }

  return payload;
};

const validateSalesChannelPayload = (payload, { partial = false } = {}) => {
  if (!partial && !payload.channelName) {
    return "channelName is required";
  }

  if (payload.channelName !== undefined && !String(payload.channelName).trim()) {
    return "channelName cannot be empty";
  }

  if (!partial && !payload.channelKey) {
    return "channelKey is required";
  }

  if (payload.channelKey !== undefined && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(payload.channelKey)) {
    return "channelKey must be lowercase and URL-safe";
  }

  if (payload.status !== undefined && !["active", "inactive"].includes(payload.status)) {
    return "status must be active or inactive";
  }

  if (payload.organizationId !== undefined && payload.organizationId && !isValidObjectId(payload.organizationId)) {
    return "organizationId must be a valid MongoDB ObjectId";
  }

  return null;
};

const buildSalesChannelQuery = (user, queryParams) => {
  const query = {};

  if (!isManagerRole(user.role)) {
    query.status = "active";
    query.isActive = true;
  } else if (queryParams.status) {
    query.status = String(queryParams.status).trim().toLowerCase();
  }

  if (queryParams.isActive !== undefined && isManagerRole(user.role)) {
    query.isActive = normalizeBoolean(queryParams.isActive);
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { channelName: { $regex: search, $options: "i" } },
      { channelKey: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};

const ensureUniqueChannelKey = async (payload, excludeId) => {
  if (!payload.channelKey) {
    return null;
  }

  const query = { channelKey: payload.channelKey };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return SalesChannel.findOne(query);
};

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const payload = normalizeSalesChannelPayload(req.body);
    const validationError = validateSalesChannelPayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const existingChannel = await ensureUniqueChannelKey(payload);

    if (existingChannel) {
      return res.status(409).json({
        success: false,
        message: "Sales channel key already exists",
      });
    }

    const salesChannel = await SalesChannel.create({
      ...payload,
      createdBy: req.user.id,
    });

    return res.status(201).json({
      success: true,
      message: "Sales channel created successfully",
      data: salesChannel,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = buildSalesChannelQuery(user, req.query);

    const [salesChannels, total] = await Promise.all([
      SalesChannel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      SalesChannel.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales channels fetched successfully",
      data: salesChannels,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales channel id must be a valid MongoDB ObjectId",
      });
    }

    const user = await getCurrentUser(req);
    const query = { _id: req.params.id };

    if (!isManagerRole(user?.role)) {
      query.status = "active";
      query.isActive = true;
    }

    const salesChannel = await SalesChannel.findOne(query);

    if (!salesChannel) {
      return res.status(404).json({
        success: false,
        message: "Sales channel not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Sales channel fetched successfully",
      data: salesChannel,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales channel id must be a valid MongoDB ObjectId",
      });
    }

    const payload = normalizeSalesChannelPayload(req.body, { partial: true });
    const validationError = validateSalesChannelPayload(payload, { partial: true });

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update sales channel",
      });
    }

    const existingChannel = await ensureUniqueChannelKey(payload, req.params.id);

    if (existingChannel) {
      return res.status(409).json({
        success: false,
        message: "Sales channel key already exists",
      });
    }

    const salesChannel = await SalesChannel.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true },
    );

    if (!salesChannel) {
      return res.status(404).json({
        success: false,
        message: "Sales channel not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Sales channel updated successfully",
      data: salesChannel,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales channel id must be a valid MongoDB ObjectId",
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

    const salesChannel = await SalesChannel.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status,
          isActive: status === "active",
        },
      },
      { new: true, runValidators: true },
    );

    if (!salesChannel) {
      return res.status(404).json({
        success: false,
        message: "Sales channel not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Sales channel status updated successfully",
      data: salesChannel,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales channel id must be a valid MongoDB ObjectId",
      });
    }

    const salesChannel = await SalesChannel.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "inactive",
          isActive: false,
        },
      },
      { new: true, runValidators: true },
    );

    if (!salesChannel) {
      return res.status(404).json({
        success: false,
        message: "Sales channel not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Sales channel deactivated successfully",
      data: salesChannel,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
