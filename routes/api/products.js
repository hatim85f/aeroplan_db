const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Line = require("../../models/Line");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { resolveOrgId } = require("../../helpers/tenancy");

const router = express.Router();

const TARGET_VALUE_BASES = ["cifUsd", "wholesaleAed", "retailAed"];
const TARGET_CURRENCIES = ["USD", "AED"];

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

const resolveLine = async (lineId, lineName, context = {}) => {
  const normalizedLineId = normalizeLineId(lineId);

  if (!normalizedLineId) {
    const error = new Error("lineId is required");
    error.statusCode = 400;
    throw error;
  }

  let line;

  if (context.lineCache?.has(normalizedLineId)) {
    line = context.lineCache.get(normalizedLineId);
  } else {
    line = await Line.findOne({ lineId: normalizedLineId });
    context.lineCache?.set(normalizedLineId, line);
  }

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

const normalizeTargetValueBasis = (value, defaultValue = "cifUsd") => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return String(value).trim();
};

const getDefaultTargetCurrency = (targetValueBasis) => (
  targetValueBasis === "cifUsd" ? "USD" : "AED"
);

const normalizeTargetCurrency = (value, defaultValue = "USD") => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return String(value).trim().toUpperCase();
};

const normalizeChannelPricing = async (channelPricing, { partial = false, context = {} } = {}) => {
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
    const channelKey = item?.channelKey;

    if ((!channelId || !isValidObjectId(channelId)) && !channelKey) {
      const error = new Error(`channelPricing.${index}.channelId must be a valid MongoDB ObjectId or channelKey is required`);
      error.statusCode = 400;
      throw error;
    }

    const salesChannelQuery = {
      status: "active",
      isActive: true,
    };

    let channelCache;
    let channelCacheKey;

    if (channelId && isValidObjectId(channelId)) {
      salesChannelQuery._id = channelId;
      channelCache = context.channelCacheById;
      channelCacheKey = String(channelId);
    } else {
      salesChannelQuery.channelKey = SalesChannel.normalizeChannelKey(channelKey);
      channelCache = context.channelCacheByKey;
      channelCacheKey = salesChannelQuery.channelKey;
    }

    let salesChannel;

    if (channelCache?.has(channelCacheKey)) {
      salesChannel = channelCache.get(channelCacheKey);
    } else {
      salesChannel = await SalesChannel.findOne(salesChannelQuery);
      channelCache?.set(channelCacheKey, salesChannel);
    }

    if (!salesChannel) {
      const error = new Error(`Active sales channel not found for channelPricing.${index}.${channelId ? "channelId" : "channelKey"}`);
      error.statusCode = 400;
      throw error;
    }

    const channelIdKey = String(salesChannel._id);

    if (channelIds.has(channelIdKey)) {
      const error = new Error("Duplicate sales channel is not allowed in channelPricing");
      error.statusCode = 400;
      throw error;
    }

    channelIds.add(channelIdKey);

    const defaultFocPercentage = salesChannel.focEnabled
      ? normalizeNumber(item.defaultFocPercentage)
      : 0;
    const targetValueBasis = normalizeTargetValueBasis(
      item.targetValueBasis,
      salesChannel.defaultTargetValueBasis || "cifUsd",
    );
    const targetCurrency = normalizeTargetCurrency(
      item.targetCurrency,
      item.targetValueBasis
        ? getDefaultTargetCurrency(targetValueBasis)
        : salesChannel.defaultTargetCurrency || getDefaultTargetCurrency(targetValueBasis),
    );

    normalized.push({
      channelId: salesChannel._id,
      channelName: salesChannel.channelName,
      channelKey: salesChannel.channelKey,
      channelGroup: salesChannel.channelGroup || "private",
      isAvailable: normalizeBoolean(item.isAvailable, true),
      cifUsd: normalizeNumber(item.cifUsd),
      wholesaleAed: normalizeNumber(item.wholesaleAed),
      retailAed: normalizeNumber(item.retailAed),
      focEnabled: salesChannel.focEnabled,
      defaultFocPercentage,
      focNotes: item.focNotes,
      targetValueBasis,
      targetCurrency,
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
    ) {
      return `channelPricing.${index}.defaultFocPercentage must be a number`;
    }

    if (!TARGET_VALUE_BASES.includes(item.targetValueBasis)) {
      return `channelPricing.${index}.targetValueBasis must be cifUsd, wholesaleAed, or retailAed`;
    }

    if (!TARGET_CURRENCIES.includes(item.targetCurrency)) {
      return `channelPricing.${index}.targetCurrency must be USD or AED`;
    }
  }

  return null;
};

const normalizeProductPayload = async (body, { partial = false, context = {} } = {}) => {
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
    const line = await resolveLine(body.lineId, body.lineName, context);
    payload.lineId = line.lineId;
    payload.lineName = line.lineName;
  } else if (body.lineName !== undefined) {
    payload.lineName = body.lineName;
  }

  if (body.channelPricing !== undefined || !partial) {
    payload.channelPricing = await normalizeChannelPricing(body.channelPricing, { partial, context });
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

const normalizeProductIds = (body = {}) => {
  const rawProductIds = [];

  if (body.productId !== undefined) {
    rawProductIds.push(body.productId);
  }

  if (Array.isArray(body.productIds)) {
    rawProductIds.push(...body.productIds);
  }

  if (Array.isArray(body.products)) {
    rawProductIds.push(...body.products.map((product) => (
      typeof product === "object" && product !== null ? product.productId || product._id : product
    )));
  }

  const productIds = [...new Set(rawProductIds.map((productId) => String(productId || "").trim()).filter(Boolean))];

  if (productIds.length === 0) {
    const error = new Error("productIds must contain at least one product id");
    error.statusCode = 400;
    throw error;
  }

  const invalidProductId = productIds.find((productId) => !isValidObjectId(productId));

  if (invalidProductId) {
    const error = new Error(`Invalid productId: ${invalidProductId}`);
    error.statusCode = 400;
    throw error;
  }

  return productIds;
};

const buildAssignedProductSnapshot = (product) => ({
  productName: product.productName,
  productNickname: product.productNickname,
  lineId: product.lineId,
  lineName: product.lineName,
});

const syncUserAssignedProductSnapshots = async (products = []) => {
  for (const product of products) {
    await User.updateMany(
      { "assignedProducts.productId": product._id },
      {
        $set: {
          "assignedProducts.$[assignment].productSnapshot": buildAssignedProductSnapshot(product),
        },
      },
      {
        arrayFilters: [
          { "assignment.productId": product._id },
        ],
      },
    );
  }
};

const getFirstDefined = (input, keys) => {
  for (const key of keys) {
    if (input?.[key] !== undefined) {
      return input[key];
    }
  }

  return undefined;
};

const normalizeBulkProductInput = (input = {}) => {
  const product = {
    ...input,
    productName: getFirstDefined(input, ["productName", "Product Name *", "Product Name"]),
    productNickname: getFirstDefined(input, ["productNickname", "Product Nickname"]),
    lineId: getFirstDefined(input, ["lineId", "Line ID *", "Line ID"]),
    description: getFirstDefined(input, ["description", "Description"]),
    imageUrl: getFirstDefined(input, ["imageUrl", "Image URL"]),
  };

  const channelKey = getFirstDefined(input, ["channelKey", "Channel Key *", "Channel Key"]);

  if (product.channelPricing === undefined && channelKey !== undefined) {
    product.channelPricing = [
      {
        channelKey,
        cifUsd: getFirstDefined(input, ["cifUsd", "CIF USD"]),
        wholesaleAed: getFirstDefined(input, ["wholesaleAed", "Wholesale AED"]),
        retailAed: getFirstDefined(input, ["retailAed", "Retail AED"]),
        defaultFocPercentage: getFirstDefined(input, ["defaultFocPercentage", "Default FOC %"]),
        focNotes: getFirstDefined(input, ["focNotes", "FOC Notes"]),
        targetValueBasis: getFirstDefined(input, ["targetValueBasis", "Target Value Basis"]),
        targetCurrency: getFirstDefined(input, ["targetCurrency", "Target Currency"]),
      },
    ];
  }

  return product;
};

const mergeBulkProductRows = (productsInput) => {
  const productsByNickname = new Map();

  for (const [index, input] of productsInput.entries()) {
    const product = normalizeBulkProductInput(input || {});
    const nicknameKey = normalizeProductNicknameKey(product.productNickname);
    const mergeKey = nicknameKey || `__row_${index}`;
    const existing = productsByNickname.get(mergeKey);

    if (!existing) {
      productsByNickname.set(mergeKey, {
        index,
        product: {
          ...product,
          channelPricing: Array.isArray(product.channelPricing)
            ? [...product.channelPricing]
            : product.channelPricing,
        },
      });
      continue;
    }

    if (Array.isArray(product.channelPricing)) {
      existing.product.channelPricing = [
        ...(Array.isArray(existing.product.channelPricing) ? existing.product.channelPricing : []),
        ...product.channelPricing,
      ];
    }
  }

  return Array.from(productsByNickname.values());
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

  query.organizationId = resolveOrgId(user);

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
      organizationId: resolveOrgId(req.currentUser),
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
      Product.find(query)
        .collation({ locale: "en", strength: 2 })
        .sort({ productName: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
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
    req.setTimeout(300000);
    res.setTimeout(300000);

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

    const productRows = mergeBulkProductRows(productsInput);
    const bulkContext = {
      lineCache: new Map(),
      channelCacheById: new Map(),
      channelCacheByKey: new Map(),
    };
    const created = [];
    const failed = [];
    const batchNicknameKeys = new Set();
    const validRows = [];

    for (const { index, product: productInput } of productRows) {
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
        payload = await normalizeProductPayload(productInput || {}, { context: bulkContext });
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

      batchNicknameKeys.add(payload.productNicknameKey);
      validRows.push({ index, productInput, payload });
    }

    const existingProducts = validRows.length > 0
      ? await Product.find({
        productNicknameKey: { $in: validRows.map((row) => row.payload.productNicknameKey) },
      }).select("+productNicknameKey").lean()
      : [];
    const existingProductsByNickname = new Map(
      existingProducts.map((product) => [product.productNicknameKey, product]),
    );
    const productsToCreate = [];

    for (const { index, productInput, payload } of validRows) {
      const existingProduct = existingProductsByNickname.get(payload.productNicknameKey);

      if (existingProduct) {
        failed.push(formatBulkProductFailure({
          index,
          product: productInput,
          reason: "Product nickname already exists",
          duplicateProductId: existingProduct._id,
        }));
        continue;
      }

      productsToCreate.push({
        ...payload,
        createdBy: req.user.id,
      });
    }

    if (productsToCreate.length > 0) {
      created.push(...await Product.insertMany(productsToCreate, { ordered: false }));
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

router.patch("/assign-line", auth, requireManager, async (req, res, next) => {
  try {
    const productIds = normalizeProductIds(req.body);
    const line = await resolveLine(req.body.lineId, req.body.lineName);
    const result = await Product.updateMany(
      { _id: { $in: productIds } },
      {
        $set: {
          lineId: line.lineId,
          lineName: line.lineName,
        },
      },
      { runValidators: true },
    );
    const products = await Product.find({ _id: { $in: productIds } }).sort({ productName: 1 });

    await syncUserAssignedProductSnapshots(products);

    const foundProductIds = new Set(products.map((product) => String(product._id)));
    const missingProductIds = productIds.filter((productId) => !foundProductIds.has(productId));

    return res.status(200).json({
      success: true,
      message: "Products assigned to line successfully",
      data: {
        line,
        products,
        requestedCount: productIds.length,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        missingProductIds,
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

    await syncUserAssignedProductSnapshots([product]);

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
