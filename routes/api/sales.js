const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const Order = require("../../models/Order");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const SalesRecord = require("../../models/SalesRecord");
const SalesSheetMapping = require("../../models/SalesSheetMapping");
const SalesUploadBatch = require("../../models/SalesUploadBatch");
const TargetAssignment = require("../../models/TargetAssignment");
const User = require("../../models/User");
const { applySharedSalesToRecord, recalculateSharedSales } = require("../../helpers/sharedSales");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const MATCH_STATUSES = ["unmatched", "partially_matched", "matched", "needs_review"];
const RECORD_STATUSES = ["active", "ignored", "duplicate", "error"];
const MAPPING_STATUSES = ["active", "inactive"];
const UPLOAD_MODES = ["override", "amend"];
const PRICE_MATCH_TOLERANCE = 0.03;
const PRICE_FIELDS = [
  { field: "cifUsd", currency: "USD" },
  { field: "wholesaleAed", currency: "AED" },
  { field: "retailAed", currency: "AED" },
];
const CHANNEL_TYPE_FIELD_KEYS = [
  "channelType",
  "marketType",
  "salesChannelType",
  "customerType",
  "privateInstitution",
  "privateOrInstitution",
  "salesType",
  "type",
  "sector",
];
const CHANNEL_TYPE_ALIASES = {
  private: {
    channelKeys: ["direct", "private", "upp"],
    priceFields: ["cifUsd"],
  },
  direct: {
    channelKeys: ["direct", "private", "upp"],
    priceFields: ["cifUsd"],
  },
  private_sales: {
    channelKeys: ["direct", "private", "upp"],
    priceFields: ["cifUsd"],
  },
  private_sale: {
    channelKeys: ["direct", "private", "upp"],
    priceFields: ["cifUsd"],
  },
  prv: {
    channelKeys: ["direct", "private", "upp"],
    priceFields: ["cifUsd"],
  },
  pvt: {
    channelKeys: ["direct", "private", "upp"],
    priceFields: ["cifUsd"],
  },
  institution: {
    channelKeys: ["institution", "institutional"],
  },
  institutional: {
    channelKeys: ["institution", "institutional"],
  },
  institute: {
    channelKeys: ["institution", "institutional"],
  },
  inst: {
    channelKeys: ["institution", "institutional"],
  },
  tender: {
    channelKeys: ["institution", "institutional"],
  },
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeText = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const normalizeKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const normalizeBoolean = (value, defaultValue) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const parseNumber = (value, defaultValue = 0) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : defaultValue;
};

const parseExcelSerialDate = (value) => {
  const serial = Number(value);

  if (!Number.isFinite(serial) || serial < 1 || serial > 100000) {
    return null;
  }

  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  const date = new Date(utcValue * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
};

const parseDate = (value, fieldName = "date") => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const normalizedValue = String(value).trim();
  const excelSerialDate = parseExcelSerialDate(normalizedValue);

  if (excelSerialDate) {
    return excelSerialDate;
  }

  const isoDateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateOnlyMatch) {
    const [, year, month, day] = isoDateOnlyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const slashDateMatch = normalizedValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);

  if (slashDateMatch) {
    const [, firstPart, secondPart, yearPart] = slashDateMatch;
    const year = Number(yearPart.length === 2 ? `20${yearPart}` : yearPart);
    const first = Number(firstPart);
    const second = Number(secondPart);
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;

    return new Date(Date.UTC(year, month - 1, day));
  }

  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }

  return date;
};

const getCurrentUser = async (req) => User.findById(req.user.id);

const loadSalesActor = async (req, res, next) => {
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
      message: "Only managers can manage sales data",
    });
  }

  return next();
};

const getAccessibleSalesQuery = async (user) => {
  if (user.role === "admin") {
    return {};
  }

  const scopedUsers = isManagerRole(user.role)
    ? await User.find({
      $or: [
        { _id: user._id },
        { path: user._id },
      ],
    }).select("_id").lean()
    : [{ _id: user._id }];
  const scopedUserIds = scopedUsers.map((scopedUser) => scopedUser._id);
  const accounts = await Account.find({
    assignedMedicalRepIds: { $in: scopedUserIds },
  }).select("_id").lean();

  if (accounts.length === 0) {
    return { _id: null };
  }

  return {
    accountId: { $in: accounts.map((account) => account._id) },
  };
};

const getScopedSalesRecord = async (recordId, user) => {
  if (!isValidObjectId(recordId)) {
    return null;
  }

  return SalesRecord.findOne({
    _id: recordId,
    ...await getAccessibleSalesQuery(user),
  });
};

const validateMonthYear = (month, year) => {
  const parsedMonth = Number(month);
  const parsedYear = Number(year);

  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return "month must be a number between 1 and 12";
  }

  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
    return "year must be a number between 2000 and 2100";
  }

  return null;
};

const getMappedValue = (row, key, columnMapping = {}) => {
  if (row?.[key] !== undefined) {
    return row[key];
  }

  const mappedColumn = columnMapping[key];
  return mappedColumn ? row?.[mappedColumn] : undefined;
};

const getFirstMappedValue = (row, keys = [], columnMapping = {}) => {
  for (const key of keys) {
    const value = getMappedValue(row, key, columnMapping);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
};

const normalizeUploadColumnMapping = (body = {}, mapping = null) => {
  const columnMapping = { ...(body.columnMapping || mapping?.columnMapping || {}) };
  const channelTypeColumn = body.channelTypeColumn
    || body.marketTypeColumn
    || body.salesChannelTypeColumn
    || body.customerTypeColumn
    || body.privateInstitutionColumn
    || body.privateOrInstitutionColumn
    || body.salesTypeColumn
    || body.typeColumn;

  if (channelTypeColumn && !columnMapping.channelType) {
    columnMapping.channelType = channelTypeColumn;
  }

  return columnMapping;
};

const normalizeSalesRow = (row = {}, columnMapping = {}, fallback = {}) => {
  const month = parseNumber(getMappedValue(row, "month", columnMapping), fallback.month);
  const year = parseNumber(getMappedValue(row, "year", columnMapping), fallback.year);
  const salesDate = parseDate(getMappedValue(row, "salesDate", columnMapping), "salesDate")
    || (month && year ? new Date(Date.UTC(year, month - 1, 1)) : null);

  return {
    invoiceNumber: getMappedValue(row, "invoiceNumber", columnMapping),
    externalSalesReference: getMappedValue(row, "externalSalesReference", columnMapping),
    salesDate,
    invoiceDate: parseDate(getMappedValue(row, "invoiceDate", columnMapping), "invoiceDate"),
    month,
    year,
    accountName: getMappedValue(row, "accountName", columnMapping),
    shipToAccountName: getMappedValue(row, "shipToAccountName", columnMapping),
    accountExternalCode: getMappedValue(row, "accountExternalCode", columnMapping),
    productName: getMappedValue(row, "productName", columnMapping),
    productNickname: getMappedValue(row, "productNickname", columnMapping),
    productExternalCode: getMappedValue(row, "productExternalCode", columnMapping),
    quantity: parseNumber(getMappedValue(row, "quantity", columnMapping), NaN),
    freeQuantity: parseNumber(getMappedValue(row, "freeQuantity", columnMapping), 0),
    uploadedSalesValue: parseNumber(getMappedValue(row, "salesValue", columnMapping), 0),
    uploadedCurrency: String(
      getMappedValue(row, "currency", columnMapping)
      || fallback.uploadedCurrency
      || fallback.currency
      || "",
    ).trim().toUpperCase(),
    channelName: getMappedValue(row, "channelName", columnMapping),
    channelKey: getMappedValue(row, "channelKey", columnMapping),
    channelType: getFirstMappedValue(row, CHANNEL_TYPE_FIELD_KEYS, columnMapping) || fallback.channelType,
  };
};

const validateSalesRow = (row) => {
  const missing = [];

  if (!row.salesDate && (!row.month || !row.year)) {
    missing.push("salesDate or month/year");
  }

  if (!row.productName && !row.productNickname) {
    missing.push("productName or productNickname");
  }

  if (!Number.isFinite(row.quantity) || row.quantity <= 0) {
    missing.push("quantity");
  }

  if (!row.accountName && !row.shipToAccountName) {
    missing.push("accountName or shipToAccountName");
  }

  return missing.length ? `Missing or invalid required fields: ${missing.join(", ")}` : null;
};

const matchProduct = async (row) => {
  const queries = [];

  if (row.productNickname) {
    queries.push({ productNickname: { $regex: `^${escapeRegex(row.productNickname)}$`, $options: "i" } });
  }

  if (row.productExternalCode) {
    queries.push({ productExternalCode: row.productExternalCode });
  }

  if (row.productName) {
    queries.push({ productName: { $regex: `^${escapeRegex(row.productName)}$`, $options: "i" } });
  }

  for (const query of queries) {
    const product = await Product.findOne({ ...query, status: "active", isActive: true }).lean();

    if (product) {
      return { product, warning: null };
    }
  }

  if (row.productName) {
    const normalizedName = normalizeText(row.productName);
    const candidates = await Product.find({ status: "active", isActive: true }).lean();
    const product = candidates.find((candidate) => normalizeText(candidate.productName) === normalizedName);

    if (product) {
      return { product, warning: null };
    }
  }

  return { product: null, warning: "Product could not be matched" };
};

const matchAccount = async (row) => {
  const inputs = [
    row.shipToAccountName,
    row.accountName,
  ].filter(Boolean);

  for (const input of inputs) {
    const matches = await Account.find({
      accountName: { $regex: `^${escapeRegex(input)}$`, $options: "i" },
    }).limit(2).lean();

    if (matches.length === 1) {
      return { account: matches[0], warning: null };
    }

    if (matches.length > 1) {
      return { account: null, warning: `Multiple accounts matched "${input}"` };
    }
  }

  const normalizedInputs = inputs.map(normalizeText).filter(Boolean);

  if (normalizedInputs.length > 0) {
    const candidates = await Account.find({}).lean();
    const matches = candidates.filter((account) => normalizedInputs.includes(normalizeText(account.accountName)));

    if (matches.length === 1) {
      return { account: matches[0], warning: null };
    }

    if (matches.length > 1) {
      return { account: null, warning: "Multiple accounts matched after normalization" };
    }
  }

  return { account: null, warning: "Account could not be matched" };
};

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findPricing = (product, channelId) => (product?.channelPricing || []).find(
  (pricing) => String(pricing.channelId) === String(channelId) && pricing.isAvailable !== false,
);

const getComparablePriceFields = (currency) => {
  const normalizedCurrency = String(currency || "").trim().toUpperCase();

  if (!normalizedCurrency) {
    return PRICE_FIELDS;
  }

  const fields = PRICE_FIELDS.filter((priceField) => priceField.currency === normalizedCurrency);
  return fields.length > 0 ? fields : PRICE_FIELDS;
};

const getChannelTypeHint = (value) => {
  const normalizedValue = normalizeKey(value);

  if (!normalizedValue) {
    return null;
  }

  const alias = CHANNEL_TYPE_ALIASES[normalizedValue]
    || (normalizedValue.includes("private") ? CHANNEL_TYPE_ALIASES.private : null)
    || (normalizedValue.includes("direct") ? CHANNEL_TYPE_ALIASES.direct : null)
    || (normalizedValue.includes("institution") ? CHANNEL_TYPE_ALIASES.institution : null)
    || (normalizedValue.includes("institute") ? CHANNEL_TYPE_ALIASES.institution : null);

  return {
    rawValue: value,
    normalizedValue,
    channelKeys: alias?.channelKeys || [normalizedValue],
    priceFields: alias?.priceFields,
  };
};

const pricingMatchesChannelHint = (pricing, hint) => {
  if (!hint) {
    return true;
  }

  const pricingKey = normalizeKey(pricing?.channelKey || pricing?.channelName);
  return hint.channelKeys.some((channelKey) => pricingKey === normalizeKey(channelKey));
};

const pricingMatchesUploadedCurrency = (pricing, currency) => {
  const normalizedCurrency = String(currency || "").trim().toUpperCase();

  if (!normalizedCurrency) {
    return true;
  }

  const targetCurrency = String(pricing?.targetCurrency || "").trim().toUpperCase();

  if (targetCurrency) {
    return targetCurrency === normalizedCurrency;
  }

  return true;
};

const priceValuesMatch = (uploadedUnitValue, unitValue) => {
  if (uploadedUnitValue <= 0 || unitValue <= 0) {
    return false;
  }

  const relativeDifference = Math.abs(uploadedUnitValue - unitValue) / unitValue;

  if (relativeDifference <= PRICE_MATCH_TOLERANCE) {
    return true;
  }

  const roundedUploaded = Number(uploadedUnitValue.toFixed(2));
  const roundedUnit = Number(unitValue.toFixed(2));

  if (roundedUploaded === roundedUnit) {
    return true;
  }

  return Math.abs(roundedUploaded - roundedUnit) <= 0.01;
};

const detectPriceFieldForPricing = (pricing, uploadedUnitValue, currency) => {
  if (!pricing || uploadedUnitValue <= 0) {
    return null;
  }

  return getComparablePriceFields(currency).find((priceField) => {
    const unitValue = Number(pricing[priceField.field]) || 0;

    if (unitValue <= 0) {
      return false;
    }

    return priceValuesMatch(uploadedUnitValue, unitValue);
  }) || null;
};

const detectSalesChannel = async (row, product) => {
  if (!product) {
    return {
      channel: null,
      pricing: null,
      method: "unknown",
      warning: "Channel cannot be detected without a matched product",
    };
  }

  const uploadedUnitValue = row.quantity > 0 ? row.uploadedSalesValue / row.quantity : 0;
  const channelTypeHint = getChannelTypeHint(row.channelType);

  if (row.channelKey || row.channelName) {
    const query = row.channelKey
      ? { channelKey: normalizeKey(row.channelKey) }
      : { channelName: { $regex: `^${escapeRegex(row.channelName)}$`, $options: "i" } };
    const channel = await SalesChannel.findOne({ ...query, status: "active", isActive: true }).lean();
    const pricing = findPricing(product, channel?._id);
    const detectedPriceField = detectPriceFieldForPricing(pricing, uploadedUnitValue, row.uploadedCurrency);

    if (channel && pricing) {
      return {
        channel,
        pricing,
        method: "sheet_channel",
        detectedPriceBasis: detectedPriceField?.field,
        detectedPriceCurrency: detectedPriceField?.currency,
        uploadedUnitValue,
        warning: null,
      };
    }

    if (channel && !pricing) {
      return {
        channel,
        pricing: null,
        method: "sheet_channel",
        uploadedUnitValue,
        warning: "Sheet channel matched, but product has no available pricing for that channel",
      };
    }
  }

  const comparablePriceFields = channelTypeHint?.priceFields
    ? PRICE_FIELDS.filter((priceField) => channelTypeHint.priceFields.includes(priceField.field))
    : getComparablePriceFields(row.uploadedCurrency);

  if (uploadedUnitValue > 0) {
    const matches = (product.channelPricing || []).map((pricing) => {
      if (pricing.isAvailable === false) {
        return null;
      }

      if (!pricingMatchesChannelHint(pricing, channelTypeHint)) {
        return null;
      }

      if (channelTypeHint?.priceFields?.includes("cifUsd") && !pricingMatchesUploadedCurrency(pricing, row.uploadedCurrency)) {
        return null;
      }

      const matchedField = comparablePriceFields.find((priceField) => {
        const unitValue = Number(pricing[priceField.field]) || 0;

        if (unitValue <= 0) {
          return false;
        }

        return priceValuesMatch(uploadedUnitValue, unitValue);
      });

      return matchedField ? { pricing, matchedField } : null;
    }).filter(Boolean);

    if (matches.length === 1) {
      const channel = await SalesChannel.findById(matches[0].pricing.channelId).lean();
      return {
        channel,
        pricing: matches[0].pricing,
        method: channelTypeHint ? "sheet_channel" : "price_match",
        detectedPriceBasis: matches[0].matchedField.field,
        detectedPriceCurrency: matches[0].matchedField.currency,
        uploadedUnitValue,
        warning: null,
      };
    }

    if (matches.length > 1) {
      return {
        channel: null,
        pricing: null,
        method: channelTypeHint ? "sheet_channel" : "price_match",
        uploadedUnitValue,
        warning: channelTypeHint
          ? `Multiple sales channels matched by ${row.channelType} and uploaded unit value`
          : "Multiple sales channels matched by uploaded unit value",
      };
    }
  }

  return {
    channel: null,
    pricing: null,
    method: "unknown",
    uploadedUnitValue,
    warning: channelTypeHint
      ? `Sales channel could not be detected from ${row.channelType}, uploaded unit value, and currency`
      : "Sales channel could not be detected from uploaded unit value and currency",
  };
};

const buildCalculatedValues = (quantity, pricing) => {
  if (!pricing) {
    return {};
  }

  const unitCifUsd = Number(pricing.cifUsd) || 0;
  const unitWholesaleAed = Number(pricing.wholesaleAed) || 0;
  const unitRetailAed = Number(pricing.retailAed) || 0;
  const targetValueBasis = pricing.targetValueBasis || "cifUsd";
  const targetCurrency = pricing.targetCurrency || (targetValueBasis === "cifUsd" ? "USD" : "AED");
  const targetUnitValue = Number(pricing[targetValueBasis]) || 0;
  const unitPriceSnapshots = PRICE_FIELDS.reduce((snapshots, priceField) => ({
    ...snapshots,
    [priceField.field]: {
      value: Number(pricing[priceField.field]) || 0,
      currency: priceField.currency,
    },
  }), {});
  const calculatedValueSnapshots = PRICE_FIELDS.reduce((snapshots, priceField) => ({
    ...snapshots,
    [priceField.field]: {
      value: quantity * (Number(pricing[priceField.field]) || 0),
      currency: priceField.currency,
    },
  }), {});

  return {
    unitCifUsd,
    unitWholesaleAed,
    unitRetailAed,
    calculatedCifUsd: quantity * unitCifUsd,
    calculatedWholesaleAed: quantity * unitWholesaleAed,
    calculatedRetailAed: quantity * unitRetailAed,
    unitPriceSnapshots,
    calculatedValueSnapshots,
    targetValueBasis,
    targetCurrency,
    targetUnitValue,
    targetCalculatedValue: quantity * targetUnitValue,
  };
};

const buildSalesQuery = async (queryParams, user) => {
  const query = {
    ...await getAccessibleSalesQuery(user),
  };

  if (queryParams.batchId) {
    query.salesUploadBatchId = isValidObjectId(queryParams.batchId)
      ? new mongoose.Types.ObjectId(queryParams.batchId)
      : null;
  }

  ["accountId", "productId", "channelId"].forEach((field) => {
    if (queryParams[field]) {
      const objectId = isValidObjectId(queryParams[field])
        ? new mongoose.Types.ObjectId(queryParams[field])
        : null;

      if (field === "accountId" && query.accountId?.$in) {
        query.accountId = objectId && query.accountId.$in.some((accountId) => String(accountId) === String(objectId))
          ? objectId
          : null;
      } else {
        query[field] = objectId;
      }
    }
  });

  ["year", "month"].forEach((field) => {
    if (queryParams[field]) {
      query[field] = Number(queryParams[field]);
    }
  });

  if (queryParams.matchStatus) {
    query.matchStatus = queryParams.matchStatus;
  }

  if (queryParams.status) {
    query.status = queryParams.status;
  }

  if (queryParams.entrySource) {
    query.entrySource = String(queryParams.entrySource).trim().toLowerCase();
  }

  if (queryParams.sharedSalesApplied !== undefined) {
    query.sharedSalesApplied = normalizeBoolean(queryParams.sharedSalesApplied, false);
  }

  if (queryParams.areaId) {
    query["areaShares.areaId"] = isValidObjectId(queryParams.areaId)
      ? new mongoose.Types.ObjectId(queryParams.areaId)
      : null;
  }

  ["accountMatched", "productMatched", "channelMatched"].forEach((field) => {
    if (queryParams[field] !== undefined) {
      query[field] = normalizeBoolean(queryParams[field], false);
    }
  });

  if (queryParams.invoiceNumber) {
    query.invoiceNumber = { $regex: String(queryParams.invoiceNumber).trim(), $options: "i" };
  }

  if (queryParams.dateFrom || queryParams.dateTo) {
    query.salesDate = {};

    if (queryParams.dateFrom) {
      query.salesDate.$gte = parseDate(queryParams.dateFrom, "dateFrom");
    }

    if (queryParams.dateTo) {
      query.salesDate.$lte = parseDate(queryParams.dateTo, "dateTo");
    }
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { invoiceNumber: { $regex: search, $options: "i" } },
      { accountName: { $regex: search, $options: "i" } },
      { shipToAccountName: { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
      { productNickname: { $regex: search, $options: "i" } },
      { channelName: { $regex: search, $options: "i" } },
      { channelKey: { $regex: search, $options: "i" } },
    ];
  }

  if (queryParams.lineId) {
    const products = await Product.find({ lineId: String(queryParams.lineId).trim().toUpperCase() })
      .select("_id")
      .lean();
    query.productId = { $in: products.map((product) => product._id) };
  }

  return query;
};

const normalizeMappingPayload = (body) => ({
  mappingName: body.mappingName,
  description: body.description,
  sourceType: body.sourceType,
  isDefault: normalizeBoolean(body.isDefault, false),
  status: body.status ? String(body.status).trim().toLowerCase() : undefined,
  columnMapping: body.columnMapping,
  requiredColumns: Array.isArray(body.requiredColumns) ? body.requiredColumns : [],
});

const validateMappingPayload = (payload, { partial = false } = {}) => {
  if (!partial && !payload.mappingName) {
    return "mappingName is required";
  }

  if (!partial && (!payload.columnMapping || typeof payload.columnMapping !== "object")) {
    return "columnMapping is required";
  }

  if (payload.status && !MAPPING_STATUSES.includes(payload.status)) {
    return "status must be active or inactive";
  }

  return null;
};

router.post("/upload", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const validationError = validateMonthYear(req.body.month, req.body.year);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (!Array.isArray(req.body.rows) || req.body.rows.length === 0) {
      return res.status(400).json({ success: false, message: "rows must be a non-empty array" });
    }

    const uploadMode = req.body.uploadMode
      ? String(req.body.uploadMode).trim().toLowerCase()
      : undefined;

    if (uploadMode && !UPLOAD_MODES.includes(uploadMode)) {
      return res.status(400).json({ success: false, message: "uploadMode must be override or amend" });
    }

    const existingActiveSalesCount = await SalesRecord.countDocuments({
      year: Number(req.body.year),
      month: Number(req.body.month),
      status: "active",
      isActive: true,
    });

    if (existingActiveSalesCount > 0 && !uploadMode) {
      const existingBatches = await SalesUploadBatch.find({
        year: Number(req.body.year),
        month: Number(req.body.month),
      }).sort({ uploadDate: -1 }).limit(10).lean();

      return res.status(409).json({
        success: false,
        requiresConfirmation: true,
        message: "Sales data already exists for this month/year. Choose override or amend.",
        existingBatches,
      });
    }

    let mapping = null;

    if (req.body.mappingId) {
      if (!isValidObjectId(req.body.mappingId)) {
        return res.status(400).json({ success: false, message: "mappingId must be a valid MongoDB ObjectId" });
      }

      mapping = await SalesSheetMapping.findById(req.body.mappingId).lean();
    }

    const columnMapping = normalizeUploadColumnMapping(req.body, mapping);
    const batch = await SalesUploadBatch.create({
      fileName: req.body.fileName,
      uploadedBy: req.currentUser._id,
      mappingId: mapping?._id,
      mappingName: mapping?.mappingName,
      month: Number(req.body.month),
      year: Number(req.body.year),
      totalRows: req.body.rows.length,
      status: "processing",
      columnMapping,
      notes: [req.body.notes, `Upload mode: ${uploadMode || "amend"}`].filter(Boolean).join(" | "),
    });

    if (uploadMode === "override") {
      await SalesRecord.updateMany(
        {
          year: Number(req.body.year),
          month: Number(req.body.month),
          status: "active",
          isActive: true,
        },
        {
          $set: {
            status: "ignored",
            isActive: false,
            updatedBy: req.currentUser._id,
          },
        },
      );
      await SalesUploadBatch.updateMany(
        {
          _id: { $ne: batch._id },
          year: Number(req.body.year),
          month: Number(req.body.month),
        },
        { $set: { notes: `Overridden by batch ${batch._id}` } },
      );
    }
    const createdRecords = [];
    const failed = [];
    const unmatched = [];
    const warnings = [];
    const seenKeys = new Set();
    let duplicateRows = 0;

    for (const [index, rawRow] of req.body.rows.entries()) {
      const rowNumber = Number(rawRow.rowNumber || index + 1);

      try {
        const row = normalizeSalesRow(rawRow, columnMapping, {
          month: Number(req.body.month),
          year: Number(req.body.year),
          uploadedCurrency: req.body.uploadedCurrency,
          currency: req.body.currency,
          channelType: req.body.channelType
            || req.body.marketType
            || req.body.salesType
            || req.body.privateInstitution
            || req.body.privateOrInstitution,
        });
        const rowValidationError = validateSalesRow(row);

        if (rowValidationError) {
          failed.push({ rowNumber, message: rowValidationError, rawRow });
          continue;
        }

        const duplicateKey = [
          row.invoiceNumber,
          row.salesDate?.toISOString(),
          normalizeText(row.accountName),
          normalizeText(row.shipToAccountName),
          normalizeText(row.productNickname || row.productName),
          row.quantity,
        ].join("|");
        const isDuplicate = seenKeys.has(duplicateKey);

        if (isDuplicate) {
          duplicateRows += 1;
        }

        seenKeys.add(duplicateKey);

        const productResult = await matchProduct(row);
        const accountResult = await matchAccount(row);
        const channelResult = await detectSalesChannel(row, productResult.product);
        const rowWarnings = [productResult.warning, accountResult.warning, channelResult.warning].filter(Boolean);
        const productMatched = Boolean(productResult.product);
        const accountMatched = Boolean(accountResult.account);
        const channelMatched = Boolean(channelResult.channel && channelResult.pricing);
        const matchStatus = productMatched && accountMatched && channelMatched
          ? "matched"
          : "needs_review";
        const calculatedValues = buildCalculatedValues(row.quantity, channelResult.pricing);

        rowWarnings.forEach((message) => warnings.push({ rowNumber, message, rawRow }));

        if (matchStatus === "needs_review") {
          unmatched.push({ rowNumber, message: rowWarnings.join("; ") || "Record needs review", rawRow });
        }

        const record = await SalesRecord.create({
          salesUploadBatchId: batch._id,
          entrySource: "upload",
          invoiceNumber: row.invoiceNumber,
          externalSalesReference: row.externalSalesReference,
          rowNumber,
          salesDate: row.salesDate,
          invoiceDate: row.invoiceDate,
          month: row.month || Number(req.body.month),
          year: row.year || Number(req.body.year),
          uploadDate: new Date(),
          accountId: accountResult.account?._id,
          accountName: row.accountName,
          shipToAccountName: row.shipToAccountName,
          accountExternalCode: row.accountExternalCode,
          accountMatched,
          productId: productResult.product?._id,
          productName: row.productName || productResult.product?.productName,
          productNickname: row.productNickname || productResult.product?.productNickname,
          productExternalCode: row.productExternalCode,
          productMatched,
          channelId: channelResult.channel?._id,
          channelName: channelResult.channel?.channelName || row.channelName,
          channelKey: channelResult.channel?.channelKey || normalizeKey(row.channelKey),
          channelMatched,
          channelDetectionMethod: channelResult.method,
          salesType: getChannelTypeHint(row.channelType)?.normalizedValue,
          quantity: row.quantity,
          freeQuantity: row.freeQuantity,
          uploadedSalesValue: row.uploadedSalesValue,
          uploadedCurrency: row.uploadedCurrency,
          uploadedUnitValue: channelResult.uploadedUnitValue ?? (row.quantity > 0 ? row.uploadedSalesValue / row.quantity : 0),
          detectedPriceBasis: channelResult.detectedPriceBasis,
          detectedPriceCurrency: channelResult.detectedPriceCurrency,
          ...calculatedValues,
          matchStatus,
          matchConfidence: matchStatus === "matched" ? 0.9 : 0,
          matchNotes: rowWarnings.join("; "),
          status: isDuplicate ? "duplicate" : "active",
          isActive: !isDuplicate,
          rawRow,
          createdBy: req.currentUser._id,
          updatedBy: req.currentUser._id,
        });

        await applySharedSalesToRecord(record);
        await record.save();

        createdRecords.push(record);
      } catch (error) {
        failed.push({ rowNumber, message: error.message || "Failed to import row", rawRow });
      }
    }

    batch.successfulRows = createdRecords.length;
    batch.failedRows = failed.length;
    batch.duplicateRows = duplicateRows;
    batch.unmatchedRows = unmatched.length;
    batch.matchedRows = createdRecords.filter((record) => record.matchStatus === "matched").length;
    batch.errors = failed;
    batch.warnings = warnings;
    batch.status = failed.length > 0 || unmatched.length > 0 || warnings.length > 0
      ? "completed_with_errors"
      : "completed";
    await batch.save();

    return res.status(201).json({
      success: true,
      message: "Sales upload processed",
      data: {
        batch,
        records: createdRecords,
        failedRows: failed,
        unmatchedRows: unmatched,
        warnings,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/manual", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const validationError = validateMonthYear(req.body.month, req.body.year);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (!req.body.accountId || !isValidObjectId(req.body.accountId)) {
      return res.status(400).json({ success: false, message: "accountId must be a valid MongoDB ObjectId" });
    }

    const salesDate = parseDate(req.body.salesDate, "salesDate");

    if (!salesDate) {
      return res.status(400).json({ success: false, message: "salesDate is required" });
    }

    const manualItems = Array.isArray(req.body.products)
      ? req.body.products
      : Array.isArray(req.body.items)
        ? req.body.items
        : [
          {
            productId: req.body.productId,
            channelId: req.body.channelId,
            quantity: req.body.quantity,
            freeQuantity: req.body.freeQuantity,
            uploadedSalesValue: req.body.uploadedSalesValue,
            uploadedCurrency: req.body.uploadedCurrency,
            invoiceNumber: req.body.invoiceNumber,
            externalSalesReference: req.body.externalSalesReference,
            productExternalCode: req.body.productExternalCode,
            notes: req.body.notes,
          },
        ];

    if (!Array.isArray(manualItems) || manualItems.length === 0) {
      return res.status(400).json({ success: false, message: "products must be a non-empty array" });
    }

    if (manualItems.length > 200) {
      return res.status(400).json({ success: false, message: "products cannot contain more than 200 items" });
    }

    const account = await Account.findById(req.body.accountId).lean();

    if (!account) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    const batch = await SalesUploadBatch.create({
      fileName: req.body.fileName || "Manual sales entry",
      uploadedBy: req.currentUser._id,
      month: Number(req.body.month),
      year: Number(req.body.year),
      totalRows: manualItems.length,
      status: "processing",
      notes: req.body.notes,
    });
    const records = [];
    const failedItems = [];

    for (const [index, item] of manualItems.entries()) {
      const rowNumber = index + 1;
      const itemChannelId = item.channelId || req.body.channelId;

      if (!item.productId || !isValidObjectId(item.productId)) {
        failedItems.push({ index, rowNumber, productId: item.productId, reason: "productId must be a valid MongoDB ObjectId" });
        continue;
      }

      if (!itemChannelId || !isValidObjectId(itemChannelId)) {
        failedItems.push({ index, rowNumber, productId: item.productId, reason: "channelId must be a valid MongoDB ObjectId" });
        continue;
      }

      const quantity = Number(item.quantity);
      const freeQuantity = Number(item.freeQuantity || 0);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        failedItems.push({ index, rowNumber, productId: item.productId, reason: "quantity must be a number greater than 0" });
        continue;
      }

      try {
        const [product, channel] = await Promise.all([
          Product.findOne({ _id: item.productId, status: "active", isActive: true }).lean(),
          SalesChannel.findOne({ _id: itemChannelId, status: "active", isActive: true }).lean(),
        ]);

        if (!product) {
          failedItems.push({ index, rowNumber, productId: item.productId, reason: "Product not found or inactive" });
          continue;
        }

        if (!channel) {
          failedItems.push({ index, rowNumber, productId: item.productId, channelId: itemChannelId, reason: "Sales channel not found or inactive" });
          continue;
        }

        const pricing = findPricing(product, channel._id);

        if (!pricing) {
          failedItems.push({
            index,
            rowNumber,
            productId: item.productId,
            channelId: itemChannelId,
            reason: "Product has no available pricing for the selected sales channel",
          });
          continue;
        }

        const uploadedSalesValue = parseNumber(item.uploadedSalesValue, 0);
        const uploadedCurrency = String(item.uploadedCurrency || req.body.uploadedCurrency || "").trim().toUpperCase();
        const uploadedUnitValue = quantity > 0 ? uploadedSalesValue / quantity : 0;
        const detectedPriceField = detectPriceFieldForPricing(pricing, uploadedUnitValue, uploadedCurrency);
        const calculatedValues = buildCalculatedValues(quantity, pricing);
        const record = await SalesRecord.create({
          salesUploadBatchId: batch._id,
          entrySource: "manual",
          invoiceNumber: item.invoiceNumber || req.body.invoiceNumber,
          externalSalesReference: item.externalSalesReference || req.body.externalSalesReference,
          rowNumber,
          salesDate,
          invoiceDate: parseDate(item.invoiceDate || req.body.invoiceDate, "invoiceDate"),
          month: Number(req.body.month),
          year: Number(req.body.year),
          uploadDate: new Date(),
          accountId: account._id,
          accountName: account.accountName,
          shipToAccountName: item.shipToAccountName || req.body.shipToAccountName,
          accountExternalCode: item.accountExternalCode || req.body.accountExternalCode,
          accountMatched: true,
          productId: product._id,
          productName: product.productName,
          productNickname: product.productNickname,
          productExternalCode: item.productExternalCode,
          productMatched: true,
          channelId: channel._id,
          channelName: channel.channelName,
          channelKey: channel.channelKey,
          channelMatched: true,
          channelDetectionMethod: "manual",
          quantity,
          freeQuantity,
          uploadedSalesValue,
          uploadedCurrency,
          uploadedUnitValue,
          detectedPriceBasis: detectedPriceField?.field,
          detectedPriceCurrency: detectedPriceField?.currency,
          ...calculatedValues,
          matchStatus: "matched",
          matchConfidence: 1,
          matchNotes: item.notes || req.body.notes,
          rawRow: {
            ...req.body,
            products: undefined,
            items: undefined,
            item,
          },
          createdBy: req.currentUser._id,
          updatedBy: req.currentUser._id,
        });

        await applySharedSalesToRecord(record);
        await record.save();
        records.push(record);
      } catch (error) {
        failedItems.push({
          index,
          rowNumber,
          productId: item.productId,
          reason: error.message || "Failed to create manual sales record",
        });
      }
    }

    batch.successfulRows = records.length;
    batch.failedRows = failedItems.length;
    batch.matchedRows = records.length;
    batch.errors = failedItems.map((failure) => ({
      rowNumber: failure.rowNumber,
      message: failure.reason,
      rawRow: manualItems[failure.index],
    }));
    batch.status = failedItems.length > 0
      ? records.length > 0 ? "completed_with_errors" : "failed"
      : "completed";
    await batch.save();

    return res.status(201).json({
      success: true,
      message: "Manual sales input processed",
      data: {
        batch,
        records,
        failedItems,
        summary: {
          total: manualItems.length,
          createdCount: records.length,
          failedCount: failedItems.length,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/recalculate-shared-sales", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const result = await recalculateSharedSales({
      ...req.body,
      updatedBy: req.currentUser._id,
    });

    return res.status(200).json({
      success: true,
      message: "Shared sales recalculation completed",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/match-orders", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    let records;

    if (req.body.salesRecordId) {
      const record = await getScopedSalesRecord(req.body.salesRecordId, req.currentUser);

      if (!record) {
        return res.status(404).json({ success: false, message: "Sales record not found" });
      }

      records = [record];
    } else {
      const query = {
      status: "active",
      isActive: true,
      accountId: { $exists: true },
      productId: { $exists: true },
      channelId: { $exists: true },
      ...await getAccessibleSalesQuery(req.currentUser),
      };

      records = await SalesRecord.find(query);
    }
    const matched = [];
    const needsReview = [];

    for (const record of records) {
      const dateFrom = new Date(record.salesDate);
      dateFrom.setUTCDate(dateFrom.getUTCDate() - 30);
      const dateTo = new Date(record.salesDate);
      dateTo.setUTCDate(dateTo.getUTCDate() + 30);

      const orderQuery = {
        isActive: true,
        "account.accountId": record.accountId,
        channelId: record.channelId,
        orderDate: { $gte: dateFrom, $lte: dateTo },
        "items.productId": record.productId,
      };

      if (record.invoiceNumber) {
        orderQuery.$or = [
          { invoiceNumber: record.invoiceNumber },
          { salesSheetReference: record.invoiceNumber },
          { invoiceNumber: { $exists: false } },
        ];
      }

      const orders = await Order.find(orderQuery).limit(2);

      if (orders.length !== 1) {
        record.matchStatus = orders.length > 1 ? "needs_review" : record.matchStatus;
        record.matchNotes = orders.length > 1
          ? "Multiple matching orders found"
          : record.matchNotes || "No matching order found";
        await record.save();
        needsReview.push({ salesRecordId: record._id, reason: record.matchNotes });
        continue;
      }

      const order = orders[0];
      const orderItem = order.items.find((orderItem) => String(orderItem.productId) === String(record.productId));
      const quantityConfidence = orderItem && Number(orderItem.quantity) === Number(record.quantity) ? 0.2 : 0;
      const invoiceConfidence = record.invoiceNumber && order.invoiceNumber === record.invoiceNumber ? 0.2 : 0;

      record.matchedOrderId = order._id;
      record.matchStatus = "matched";
      record.matchConfidence = Math.min(1, 0.7 + quantityConfidence + invoiceConfidence);
      record.matchNotes = "Matched to order";
      record.updatedBy = req.currentUser._id;
      await record.save();

      order.status = "matched_in_sales";
      order.salesSheetMatchedAt = new Date();
      order.salesSheetReference = record.invoiceNumber || String(record.salesUploadBatchId);
      order.matchedSalesRecordId = record._id;
      order.invoiceNumber = record.invoiceNumber || order.invoiceNumber;
      order.updatedBy = req.currentUser._id;
      await order.save();

      matched.push({ salesRecordId: record._id, orderId: order._id, matchConfidence: record.matchConfidence });
    }

    return res.status(200).json({
      success: true,
      message: "Sales to orders matching completed",
      data: {
        matchedCount: matched.length,
        needsReviewCount: needsReview.length,
        matched,
        needsReview,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/match-targets", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    let records;

    if (req.body.salesRecordId) {
      const record = await getScopedSalesRecord(req.body.salesRecordId, req.currentUser);

      if (!record) {
        return res.status(404).json({ success: false, message: "Sales record not found" });
      }

      records = [record];
    } else {
      const query = {
      status: "active",
      isActive: true,
      productId: { $exists: true },
      channelId: { $exists: true },
      ...await getAccessibleSalesQuery(req.currentUser),
      };

      records = await SalesRecord.find(query);
    }
    const matched = [];
    const needsReview = [];

    for (const record of records) {
      const assignments = await TargetAssignment.find({
        productId: record.productId,
        channelId: record.channelId,
        status: "active",
        isActive: true,
        startDate: { $lte: record.salesDate },
        endDate: { $gte: record.salesDate },
      }).select("_id").lean();

      record.matchedTargetAssignmentIds = assignments.map((assignment) => assignment._id);
      record.updatedBy = req.currentUser._id;

      if (assignments.length === 1) {
        record.matchStatus = record.matchedOrderId ? "matched" : "partially_matched";
        record.matchNotes = "Matched to one target assignment";
        matched.push({ salesRecordId: record._id, targetAssignmentIds: record.matchedTargetAssignmentIds });
      } else if (assignments.length > 1) {
        record.matchStatus = "needs_review";
        record.matchNotes = "Multiple target assignments matched";
        needsReview.push({ salesRecordId: record._id, reason: record.matchNotes, targetAssignmentIds: record.matchedTargetAssignmentIds });
      } else {
        record.matchNotes = record.matchNotes || "No target assignment matched";
        needsReview.push({ salesRecordId: record._id, reason: record.matchNotes });
      }

      await record.save();
    }

    return res.status(200).json({
      success: true,
      message: "Sales to targets matching completed",
      data: {
        matchedCount: matched.length,
        needsReviewCount: needsReview.length,
        matched,
        needsReview,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/overview", auth, loadSalesActor, async (req, res, next) => {
  try {
    const baseQuery = await buildSalesQuery(req.query, req.currentUser);
    baseQuery.status = baseQuery.status || "active";
    baseQuery.isActive = true;

    const [summary] = await SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: null,
          totalQuantity: { $sum: "$quantity" },
          totalFreeQuantity: { $sum: "$freeQuantity" },
          totalQuantityWithFoc: { $sum: "$totalQuantityWithFoc" },
          totalUploadedSalesValue: { $sum: "$uploadedSalesValue" },
          totalCalculatedCifUsd: { $sum: "$calculatedCifUsd" },
          totalCalculatedWholesaleAed: { $sum: "$calculatedWholesaleAed" },
          totalCalculatedRetailAed: { $sum: "$calculatedRetailAed" },
          totalTargetCalculatedValue: { $sum: "$targetCalculatedValue" },
          recordsCount: { $sum: 1 },
          matchedOrdersCount: { $sum: { $cond: [{ $ifNull: ["$matchedOrderId", false] }, 1, 0] } },
          unmatchedSalesRecordsCount: { $sum: { $cond: [{ $eq: ["$matchStatus", "unmatched"] }, 1, 0] } },
          needsReviewCount: { $sum: { $cond: [{ $eq: ["$matchStatus", "needs_review"] }, 1, 0] } },
        },
      },
    ]);
    const areaObjectId = req.query.areaId && isValidObjectId(req.query.areaId)
      ? new mongoose.Types.ObjectId(req.query.areaId)
      : null;
    const [areaSummary] = areaObjectId
      ? await SalesRecord.aggregate([
        { $match: baseQuery },
        { $unwind: "$areaShares" },
        { $match: { "areaShares.areaId": areaObjectId } },
        {
          $group: {
            _id: "$areaShares.areaId",
            areaName: { $first: "$areaShares.areaName" },
            totalSharedQuantity: { $sum: "$areaShares.sharedQuantity" },
            totalSharedFreeQuantity: { $sum: "$areaShares.sharedFreeQuantity" },
            totalSharedCalculatedCifUsd: { $sum: "$areaShares.sharedCalculatedCifUsd" },
            totalSharedCalculatedWholesaleAed: { $sum: "$areaShares.sharedCalculatedWholesaleAed" },
            totalSharedCalculatedRetailAed: { $sum: "$areaShares.sharedCalculatedRetailAed" },
          },
        },
      ])
      : [null];

    const groupBy = async (idField, nameField) => SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: `$${idField}`,
          name: { $first: `$${nameField}` },
          totalQuantity: { $sum: "$quantity" },
          totalCalculatedCifUsd: { $sum: "$calculatedCifUsd" },
          totalCalculatedWholesaleAed: { $sum: "$calculatedWholesaleAed" },
          totalCalculatedRetailAed: { $sum: "$calculatedRetailAed" },
          recordsCount: { $sum: 1 },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 50 },
    ]);

    const [salesByProduct, salesByAccount, salesByChannel] = await Promise.all([
      groupBy("productId", "productName"),
      groupBy("accountId", "accountName"),
      groupBy("channelId", "channelName"),
    ]);
    const uploadedSalesByCurrency = await SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: "$uploadedCurrency",
          totalUploadedSalesValue: { $sum: "$uploadedSalesValue" },
          recordsCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales overview fetched successfully",
      data: {
        totalQuantity: summary?.totalQuantity || 0,
        totalFreeQuantity: summary?.totalFreeQuantity || 0,
        totalQuantityWithFoc: summary?.totalQuantityWithFoc || 0,
        totalUploadedSalesValue: summary?.totalUploadedSalesValue || 0,
        totalCalculatedCifUsd: summary?.totalCalculatedCifUsd || 0,
        totalCalculatedWholesaleAed: summary?.totalCalculatedWholesaleAed || 0,
        totalCalculatedRetailAed: summary?.totalCalculatedRetailAed || 0,
        totalTargetCalculatedValue: summary?.totalTargetCalculatedValue || 0,
        recordsCount: summary?.recordsCount || 0,
        matchedOrdersCount: summary?.matchedOrdersCount || 0,
        unmatchedSalesRecordsCount: summary?.unmatchedSalesRecordsCount || 0,
        needsReviewCount: summary?.needsReviewCount || 0,
        totalSharedQuantity: areaSummary?.totalSharedQuantity || 0,
        totalSharedFreeQuantity: areaSummary?.totalSharedFreeQuantity || 0,
        totalSharedCalculatedCifUsd: areaSummary?.totalSharedCalculatedCifUsd || 0,
        totalSharedCalculatedWholesaleAed: areaSummary?.totalSharedCalculatedWholesaleAed || 0,
        totalSharedCalculatedRetailAed: areaSummary?.totalSharedCalculatedRetailAed || 0,
        areaShare: areaSummary || null,
        uploadedSalesByCurrency,
        salesByProduct,
        salesByAccount,
        salesByChannel,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/mappings", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const payload = normalizeMappingPayload(req.body);
    const validationError = validateMappingPayload(payload);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (payload.isDefault) {
      await SalesSheetMapping.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    }

    const mapping = await SalesSheetMapping.create({
      ...payload,
      status: payload.status || "active",
      createdBy: req.currentUser._id,
      updatedBy: req.currentUser._id,
    });

    return res.status(201).json({ success: true, message: "Sales sheet mapping created successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.get("/mappings", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = {};

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.search) {
      const search = String(req.query.search).trim();
      query.$or = [
        { mappingName: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { sourceType: { $regex: search, $options: "i" } },
      ];
    }

    const [mappings, total] = await Promise.all([
      SalesSheetMapping.find(query).sort({ isDefault: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      SalesSheetMapping.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales sheet mappings fetched successfully",
      data: mappings,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/mappings/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Mapping id must be a valid MongoDB ObjectId" });
    }

    const mapping = await SalesSheetMapping.findById(req.params.id);

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping fetched successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.patch("/mappings/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Mapping id must be a valid MongoDB ObjectId" });
    }

    const payload = normalizeMappingPayload(req.body);
    Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
    const validationError = validateMappingPayload(payload, { partial: true });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (payload.isDefault) {
      await SalesSheetMapping.updateMany({ _id: { $ne: req.params.id }, isDefault: true }, { $set: { isDefault: false } });
    }

    const mapping = await SalesSheetMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { ...payload, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping updated successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.patch("/mappings/:id/status", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const status = String(req.body.status || "").trim().toLowerCase();

    if (!MAPPING_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active or inactive" });
    }

    const mapping = await SalesSheetMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { status, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping status updated successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.delete("/mappings/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const mapping = await SalesSheetMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "inactive", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping deactivated successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.get("/batches", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = {};

    ["year", "month"].forEach((field) => {
      if (req.query[field]) {
        query[field] = Number(req.query[field]);
      }
    });

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.search) {
      query.fileName = { $regex: String(req.query.search).trim(), $options: "i" };
    }

    const [batches, total] = await Promise.all([
      SalesUploadBatch.find(query).sort({ uploadDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      SalesUploadBatch.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales upload batches fetched successfully",
      data: batches,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/batches/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Batch id must be a valid MongoDB ObjectId" });
    }

    const batch = await SalesUploadBatch.findById(req.params.id);

    if (!batch) {
      return res.status(404).json({ success: false, message: "Sales upload batch not found" });
    }

    return res.status(200).json({ success: true, message: "Sales upload batch fetched successfully", data: batch });
  } catch (error) {
    return next(error);
  }
});

router.get("/batches/:id/records", auth, loadSalesActor, async (req, res, next) => {
  try {
    req.query.batchId = req.params.id;
    const query = await buildSalesQuery(req.query, req.currentUser);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [records, total] = await Promise.all([
      SalesRecord.find(query).sort({ rowNumber: 1 }).skip((page - 1) * limit).limit(limit),
      SalesRecord.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales upload batch records fetched successfully",
      data: records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/batches/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const batch = await SalesUploadBatch.findById(req.params.id);

    if (!batch) {
      return res.status(404).json({ success: false, message: "Sales upload batch not found" });
    }

    batch.status = "failed";
    batch.notes = [batch.notes, "Batch deactivated"].filter(Boolean).join(" | ");
    await batch.save();

    if (normalizeBoolean(req.query.markRecordsIgnored ?? req.body.markRecordsIgnored, false)) {
      await SalesRecord.updateMany(
        { salesUploadBatchId: batch._id },
        { $set: { status: "ignored", isActive: false, updatedBy: req.currentUser._id } },
      );
    }

    return res.status(200).json({ success: true, message: "Sales upload batch deactivated successfully", data: batch });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = await buildSalesQuery(req.query, req.currentUser);
    const [records, total] = await Promise.all([
      SalesRecord.find(query).sort({ salesDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalesRecord.countDocuments(query),
    ]);
    const data = req.query.areaId && isValidObjectId(req.query.areaId)
      ? records.map((record) => ({
        ...record,
        matchingAreaShare: (record.areaShares || []).find((areaShare) => (
          String(areaShare.areaId) === String(req.query.areaId)
        )) || null,
      }))
      : records;

    return res.status(200).json({
      success: true,
      message: "Sales records fetched successfully",
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Sales record id must be a valid MongoDB ObjectId" });
    }

    const record = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    return res.status(200).json({ success: true, message: "Sales record fetched successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Sales record id must be a valid MongoDB ObjectId" });
    }

    const existingRecord = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!existingRecord) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    const allowedFields = [
      "invoiceNumber", "externalSalesReference", "salesDate", "invoiceDate", "month", "year",
      "accountId", "accountName", "shipToAccountName", "accountExternalCode", "accountMatched",
      "productId", "productName", "productNickname", "productExternalCode", "productMatched",
      "channelId", "channelName", "channelKey", "channelMatched", "channelDetectionMethod",
      "salesType",
      "quantity", "freeQuantity", "uploadedSalesValue", "uploadedCurrency", "uploadedUnitValue",
      "detectedPriceBasis", "detectedPriceCurrency", "matchStatus",
      "targetValueBasis", "targetCurrency", "targetUnitValue", "targetCalculatedValue",
      "matchConfidence", "matchNotes", "status", "isActive",
    ];
    const update = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    if (update.salesDate) {
      update.salesDate = parseDate(update.salesDate, "salesDate");
    }

    if (update.invoiceDate) {
      update.invoiceDate = parseDate(update.invoiceDate, "invoiceDate");
    }

    if (update.matchStatus && !MATCH_STATUSES.includes(update.matchStatus)) {
      return res.status(400).json({ success: false, message: "Invalid matchStatus" });
    }

    if (update.status && !RECORD_STATUSES.includes(update.status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    if (update.quantity !== undefined || update.freeQuantity !== undefined) {
      const quantity = update.quantity !== undefined ? Number(update.quantity) : Number(existingRecord.quantity || 0);
      const freeQuantity = update.freeQuantity !== undefined ? Number(update.freeQuantity) : Number(existingRecord.freeQuantity || 0);
      update.totalQuantityWithFoc = quantity + freeQuantity;
    }

    update.updatedBy = req.currentUser._id;

    const record = await SalesRecord.findByIdAndUpdate(
      existingRecord._id,
      { $set: update },
      { new: true, runValidators: true },
    );

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    await applySharedSalesToRecord(record);
    await record.save();

    return res.status(200).json({ success: true, message: "Sales record updated successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const status = String(req.body.status || "").trim().toLowerCase();

    if (!RECORD_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active, ignored, duplicate, or error" });
    }

    const existingRecord = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!existingRecord) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    const record = await SalesRecord.findByIdAndUpdate(
      existingRecord._id,
      { $set: { status, isActive: status === "active", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    return res.status(200).json({ success: true, message: "Sales record status updated successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const existingRecord = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!existingRecord) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    const record = await SalesRecord.findByIdAndUpdate(
      existingRecord._id,
      { $set: { status: "ignored", isActive: false, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    return res.status(200).json({ success: true, message: "Sales record ignored successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
