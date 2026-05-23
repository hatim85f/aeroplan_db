const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Line = require("../../models/Line");
const Product = require("../../models/Product");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const CHANNEL_KEYS = ["direct", "upp", "institutional"];

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeLineId = (lineId) => String(lineId || "").trim().toUpperCase();

const normalizeProductNicknameKey = (productNickname) => String(productNickname || "")
  .trim()
  .toLowerCase();

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
      message: "Only managers can manage products",
    });
  }

  req.currentUser = user;
  return next();
};

const resolveLine = async (lineId, lineName) => {
  const normalizedLineId = normalizeLineId(lineId);

  if (!normalizedLineId) {
    const error = new Error("lineId is required");
    error.statusCode = 400;
    throw error;
  }

  const line = await Line.findOne({ lineId: normalizedLineId });

  if (!line) {
    const error = new Error("Line not found");
    error.statusCode = 400;
    throw error;
  }

  return {
    lineId: line.lineId,
    lineName: line.lineName || lineName || line.lineId,
  };
};

const normalizeNumber = (value) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  return Number(value);
};

const normalizeBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const normalizeChannelPrices = (prices = {}) => {
  return CHANNEL_KEYS.reduce((normalizedPrices, channel) => {
    if (prices[channel] === undefined) {
      return normalizedPrices;
    }

    normalizedPrices[channel] = {
      cifUsd: normalizeNumber(prices[channel]?.cifUsd),
      wholesaleAed: normalizeNumber(prices[channel]?.wholesaleAed),
      retailAed: normalizeNumber(prices[channel]?.retailAed),
    };

    return normalizedPrices;
  }, {});
};

const normalizeDefaultFoc = (defaultFoc = {}) => {
  return CHANNEL_KEYS.reduce((normalizedFoc, channel) => {
    if (defaultFoc[channel] === undefined) {
      return normalizedFoc;
    }

    normalizedFoc[channel] = {
      percentage: normalizeNumber(defaultFoc[channel]?.percentage),
      notes: defaultFoc[channel]?.notes,
    };

    return normalizedFoc;
  }, {});
};

const buildDefaultChannelPrices = () => CHANNEL_KEYS.reduce((prices, channel) => {
  prices[channel] = {
    cifUsd: 0,
    wholesaleAed: 0,
    retailAed: 0,
  };

  return prices;
}, {});

const buildDefaultChannelFoc = () => CHANNEL_KEYS.reduce((defaultFoc, channel) => {
  defaultFoc[channel] = {
    percentage: 0,
    notes: undefined,
  };

  return defaultFoc;
}, {});

const validateChannelKeys = (value, fieldName) => {
  if (value === undefined) {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${fieldName} must be an object`;
  }

  const invalidChannel = Object.keys(value).find((channel) => !CHANNEL_KEYS.includes(channel));

  if (invalidChannel) {
    return `${fieldName} channel keys must be direct, upp, or institutional`;
  }

  return null;
};

const normalizeProductPayload = async (body, { partial = false } = {}) => {
  const payload = {};
  const simpleFields = [
    "productName",
    "productNickname",
    "description",
    "imageUrl",
    "status",
    "isActive",
    "organizationId",
  ];

  simpleFields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  if (payload.productNickname !== undefined) {
    payload.productNicknameKey = normalizeProductNicknameKey(payload.productNickname);
  }

  if (body.lineId !== undefined || (!partial && body.lineId)) {
    const line = await resolveLine(body.lineId, body.lineName);
    payload.lineId = line.lineId;
    payload.lineName = line.lineName;
  } else if (body.lineName !== undefined) {
    payload.lineName = body.lineName;
  }

  if (body.prices !== undefined) {
    payload.prices = normalizeChannelPrices(body.prices);
  } else if (!partial) {
    payload.prices = buildDefaultChannelPrices();
  }

  if (body.defaultFoc !== undefined) {
    payload.defaultFoc = normalizeDefaultFoc(body.defaultFoc);
  } else if (!partial) {
    payload.defaultFoc = buildDefaultChannelFoc();
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

const validateProductPayload = (payload, { partial = false } = {}) => {
  if (!partial && !payload.productName) {
    return "productName is required";
  }

  if (!partial && !payload.productNickname) {
    return "productNickname is required";
  }

  if (!partial && !payload.lineId) {
    return "lineId is required";
  }

  if (payload.productNickname !== undefined && !String(payload.productNickname).trim()) {
    return "productNickname cannot be empty";
  }

  if (payload.status !== undefined && !["active", "inactive"].includes(payload.status)) {
    return "status must be active or inactive";
  }

  const channelValidationError = validateChannelNumbers(payload);

  if (channelValidationError) {
    return channelValidationError;
  }

  return null;
};

const validateChannelNumbers = (payload) => {
  const priceFields = ["cifUsd", "wholesaleAed", "retailAed"];

  for (const [channel, channelPrices] of Object.entries(payload.prices || {})) {
    for (const field of priceFields) {
      const value = channelPrices[field];

      if (!Number.isFinite(value) || value < 0) {
        return `prices.${channel}.${field} must be a number greater than or equal to 0`;
      }
    }
  }

  for (const [channel, channelFoc] of Object.entries(payload.defaultFoc || {})) {
    const percentage = channelFoc.percentage;

    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      return `defaultFoc.${channel}.percentage must be between 0 and 100`;
    }
  }

  return null;
};

const validateProductRequestBody = (body) => {
  return validateChannelKeys(body.prices, "prices")
    || validateChannelKeys(body.defaultFoc, "defaultFoc");
};

const buildProductUpdate = (payload) => {
  const update = {};

  Object.entries(payload).forEach(([field, value]) => {
    if (field === "prices" || field === "defaultFoc") {
      Object.entries(value || {}).forEach(([channel, channelValue]) => {
        Object.entries(channelValue || {}).forEach(([channelField, channelFieldValue]) => {
          update[`${field}.${channel}.${channelField}`] = channelFieldValue;
        });
      });
      return;
    }

    update[field] = value;
  });

  return update;
};

const buildProductQuery = (user, queryParams) => {
  const query = {};

  if (!isManagerRole(user.role)) {
    query.status = "active";
    query.isActive = true;
  } else if (queryParams.status) {
    query.status = String(queryParams.status).trim().toLowerCase();
  }

  if (queryParams.isActive !== undefined && isManagerRole(user.role)) {
    query.isActive = queryParams.isActive === "true";
  }

  if (queryParams.lineId) {
    query.lineId = normalizeLineId(queryParams.lineId);
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { productName: { $regex: search, $options: "i" } },
      { productNickname: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { lineName: { $regex: search, $options: "i" } },
      { lineId: { $regex: search, $options: "i" } },
    ];
  }

  if (queryParams.channel) {
    const channel = String(queryParams.channel).trim().toLowerCase();

    if (CHANNEL_KEYS.includes(channel) && queryParams.channelAvailable === "true") {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { [`prices.${channel}.cifUsd`]: { $gt: 0 } },
            { [`prices.${channel}.wholesaleAed`]: { $gt: 0 } },
            { [`prices.${channel}.retailAed`]: { $gt: 0 } },
            { [`defaultFoc.${channel}.percentage`]: { $gt: 0 } },
          ],
        },
      ];
    }
  }

  return query;
};

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const requestValidationError = validateProductRequestBody(req.body);

    if (requestValidationError) {
      return res.status(400).json({
        success: false,
        message: requestValidationError,
      });
    }

    const payload = await normalizeProductPayload(req.body);
    const validationError = validateProductPayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const existingProduct = await Product.findOne({
      productNicknameKey: payload.productNicknameKey,
    }).select("+productNicknameKey");

    if (existingProduct) {
      return res.status(409).json({
        success: false,
        message: "Product nickname already exists",
      });
    }

    const product = await Product.create({
      ...payload,
      createdBy: req.user.id,
    });

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      data: product,
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
    const query = buildProductQuery(user, req.query);

    const [products, total] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Product.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      data: products,
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
        message: "Product id must be a valid MongoDB ObjectId",
      });
    }

    const user = await getCurrentUser(req);
    const query = { _id: req.params.id };

    if (!isManagerRole(user?.role)) {
      query.status = "active";
      query.isActive = true;
    }

    const product = await Product.findOne(query);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product fetched successfully",
      data: product,
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
        message: "Product id must be a valid MongoDB ObjectId",
      });
    }

    const requestValidationError = validateProductRequestBody(req.body);

    if (requestValidationError) {
      return res.status(400).json({
        success: false,
        message: requestValidationError,
      });
    }

    const payload = await normalizeProductPayload(req.body, { partial: true });
    const validationError = validateProductPayload(payload, { partial: true });

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update product",
      });
    }

    if (payload.productNicknameKey) {
      const existingProduct = await Product.findOne({
        productNicknameKey: payload.productNicknameKey,
        _id: { $ne: req.params.id },
      }).select("+productNicknameKey");

      if (existingProduct) {
        return res.status(409).json({
          success: false,
          message: "Product nickname already exists",
        });
      }
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: buildProductUpdate(payload) },
      { new: true, runValidators: true },
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product updated successfully",
      data: product,
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
        message: "Product id must be a valid MongoDB ObjectId",
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

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status,
          isActive: status === "active",
        },
      },
      { new: true, runValidators: true },
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product status updated successfully",
      data: product,
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
        message: "Product id must be a valid MongoDB ObjectId",
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "inactive",
          isActive: false,
        },
      },
      { new: true, runValidators: true },
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product deactivated successfully",
      data: product,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
