const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Line = require("../../models/Line");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

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

const normalizeBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const normalizeChannelPricing = async (channelPricing, { partial = false } = {}) => {
  if (channelPricing === undefined) {
    if (partial) {
      return undefined;
    }

    const error = new Error("channelPricing must contain at least one item");
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(channelPricing) || channelPricing.length === 0) {
    const error = new Error("channelPricing must contain at least one item");
    error.statusCode = 400;
    throw error;
  }

  const normalized = [];
  const channelIds = new Set();

  for (const [index, item] of channelPricing.entries()) {
    const channelId = item?.channelId;

    if (!channelId || !isValidObjectId(channelId)) {
      const error = new Error(`channelPricing.${index}.channelId must be a valid MongoDB ObjectId`);
      error.statusCode = 400;
      throw error;
    }

    const channelIdKey = String(channelId);

    if (channelIds.has(channelIdKey)) {
      const error = new Error("Duplicate channelId is not allowed in channelPricing");
      error.statusCode = 400;
      throw error;
    }

    channelIds.add(channelIdKey);

    const salesChannel = await SalesChannel.findOne({
      _id: channelId,
      status: "active",
      isActive: true,
    });

    if (!salesChannel) {
      const error = new Error(`Active sales channel not found for channelPricing.${index}.channelId`);
      error.statusCode = 400;
      throw error;
    }

    const defaultFocPercentage = salesChannel.focEnabled
      ? normalizeNumber(item.defaultFocPercentage)
      : 0;

    normalized.push({
      channelId: salesChannel._id,
      channelName: salesChannel.channelName,
      channelKey: salesChannel.channelKey,
      isAvailable: normalizeBoolean(item.isAvailable, true),
      cifUsd: normalizeNumber(item.cifUsd),
      wholesaleAed: normalizeNumber(item.wholesaleAed),
      retailAed: normalizeNumber(item.retailAed),
      focEnabled: salesChannel.focEnabled,
      defaultFocPercentage,
      focNotes: item.focNotes,
    });
  }

  return normalized;
};

const validateChannelPricingNumbers = (channelPricing = []) => {
  const priceFields = ["cifUsd", "wholesaleAed", "retailAed"];

  for (const [index, item] of channelPricing.entries()) {
    for (const field of priceFields) {
      const value = item[field];

      if (!Number.isFinite(value) || value < 0) {
        return `channelPricing.${index}.${field} must be a number greater than or equal to 0`;
      }
    }

    if (
      !Number.isFinite(item.defaultFocPercentage)
      || item.defaultFocPercentage < 0
      || item.defaultFocPercentage > 100
    ) {
      return `channelPricing.${index}.defaultFocPercentage must be a number between 0 and 100`;
    }
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

  if (body.channelPricing !== undefined || !partial) {
    payload.channelPricing = await normalizeChannelPricing(body.channelPricing, { partial });
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

  if (!partial && (!Array.isArray(payload.channelPricing) || payload.channelPricing.length === 0)) {
    return "channelPricing must contain at least one item";
  }

  if (payload.productNickname !== undefined && !String(payload.productNickname).trim()) {
    return "productNickname cannot be empty";
  }

  if (payload.status !== undefined && !["active", "inactive"].includes(payload.status)) {
    return "status must be active or inactive";
  }

  if (payload.organizationId !== undefined && payload.organizationId && !isValidObjectId(payload.organizationId)) {
    return "organizationId must be a valid MongoDB ObjectId";
  }

  const channelPricingValidationError = validateChannelPricingNumbers(payload.channelPricing);

  if (channelPricingValidationError) {
    return channelPricingValidationError;
  }

  return null;
};

const validateProductRequestBody = (body) => {
  if (body.prices !== undefined || body.defaultFoc !== undefined) {
    return "Use channelPricing instead of legacy prices/defaultFoc fields";
  }

  return null;
};

const formatBulkProductFailure = ({ index, product, reason, duplicateProductId }) => {
  const failure = {
    index,
    productName: product?.productName,
    productNickname: product?.productNickname,
    reason,
  };

  if (duplicateProductId) {
    failure.duplicateProductId = duplicateProductId;
  }

  return failure;
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
    query.isActive = normalizeBoolean(queryParams.isActive);
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
      { "channelPricing.channelName": { $regex: search, $options: "i" } },
      { "channelPricing.channelKey": { $regex: search, $options: "i" } },
    ];
  }

  const channelMatch = {};

  if (queryParams.channelId) {
    if (!isValidObjectId(queryParams.channelId)) {
      query._id = null;
    } else {
      channelMatch.channelId = new mongoose.Types.ObjectId(queryParams.channelId);
    }
  }

  if (queryParams.channelKey) {
    channelMatch.channelKey = String(queryParams.channelKey).trim().toLowerCase();
  }

  if (queryParams.channelAvailable === "true" || !isManagerRole(user.role)) {
    channelMatch.isAvailable = true;
  }

  if (Object.keys(channelMatch).length > 0) {
    query.channelPricing = { $elemMatch: channelMatch };
  }

  return query;
};

const filterRepresentativeProduct = (product, user) => {
  if (isManagerRole(user.role)) {
    return product;
  }

  return {
    ...product,
    channelPricing: (product.channelPricing || []).filter((item) => item.isAvailable),
  };
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
      Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      data: products.map((product) => filterRepresentativeProduct(product, user)),
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

router.post("/bulk", auth, requireManager, async (req, res, next) => {
  try {
    const productsInput = Array.isArray(req.body) ? req.body : req.body.products;

    if (!Array.isArray(productsInput) || productsInput.length === 0) {
      return res.status(400).json({
        success: false,
        message: "products must be a non-empty array",
      });
    }

    if (productsInput.length > 500) {
      return res.status(400).json({
        success: false,
        message: "products cannot contain more than 500 rows",
      });
    }

    const created = [];
    const failed = [];
    const batchNicknameKeys = new Set();

    for (const [index, productInput] of productsInput.entries()) {
      const requestValidationError = validateProductRequestBody(productInput || {});

      if (requestValidationError) {
        failed.push(formatBulkProductFailure({
          index,
          product: productInput,
          reason: requestValidationError,
        }));
        continue;
      }

      let payload;

      try {
        payload = await normalizeProductPayload(productInput || {});
      } catch (error) {
        failed.push(formatBulkProductFailure({
          index,
          product: productInput,
          reason: error.message || "Invalid product row",
        }));
        continue;
      }

      const validationError = validateProductPayload(payload);

      if (validationError) {
        failed.push(formatBulkProductFailure({
          index,
          product: productInput,
          reason: validationError,
        }));
        continue;
      }

      if (batchNicknameKeys.has(payload.productNicknameKey)) {
        failed.push(formatBulkProductFailure({
          index,
          product: productInput,
          reason: "Duplicate productNickname in upload",
        }));
        continue;
      }

      const existingProduct = await Product.findOne({
        productNicknameKey: payload.productNicknameKey,
      }).select("+productNicknameKey");

      if (existingProduct) {
        failed.push(formatBulkProductFailure({
          index,
          product: productInput,
          reason: "Product nickname already exists",
          duplicateProductId: existingProduct._id,
        }));
        continue;
      }

      const product = await Product.create({
        ...payload,
        createdBy: req.user.id,
      });

      created.push(product);
      batchNicknameKeys.add(payload.productNicknameKey);
    }

    const createdProductIds = created.map((product) => String(product._id));
    const createdProducts = createdProductIds.length > 0
      ? await Product.find({ _id: { $in: createdProductIds } }).sort({ createdAt: -1 })
      : [];

    return res.status(201).json({
      success: true,
      message: "Bulk products import completed",
      data: {
        total: productsInput.length,
        createdCount: createdProducts.length,
        failedCount: failed.length,
        createdProductIds,
        createdProducts,
        failed,
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
      query.channelPricing = { $elemMatch: { isAvailable: true } };
    }

    const product = await Product.findOne(query).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product fetched successfully",
      data: filterRepresentativeProduct(product, user),
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
      { $set: payload },
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
