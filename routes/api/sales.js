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
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const MATCH_STATUSES = ["unmatched", "partially_matched", "matched", "needs_review"];
const RECORD_STATUSES = ["active", "ignored", "duplicate", "error"];
const MAPPING_STATUSES = ["active", "inactive"];
const PRICE_MATCH_TOLERANCE = 0.03;

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

const parseDate = (value, fieldName = "date") => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const normalizedValue = String(value).trim();
  const isoDateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateOnlyMatch) {
    const [, year, month, day] = isoDateOnlyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
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
    uploadedCurrency: String(getMappedValue(row, "currency", columnMapping) || "").trim().toUpperCase(),
    channelName: getMappedValue(row, "channelName", columnMapping),
    channelKey: getMappedValue(row, "channelKey", columnMapping),
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

const detectSalesChannel = async (row, product) => {
  if (!product) {
    return {
      channel: null,
      pricing: null,
      method: "unknown",
      warning: "Channel cannot be detected without a matched product",
    };
  }

  if (row.channelKey || row.channelName) {
    const query = row.channelKey
      ? { channelKey: normalizeKey(row.channelKey) }
      : { channelName: { $regex: `^${escapeRegex(row.channelName)}$`, $options: "i" } };
    const channel = await SalesChannel.findOne({ ...query, status: "active", isActive: true }).lean();
    const pricing = findPricing(product, channel?._id);

    if (channel && pricing) {
      return { channel, pricing, method: "sheet_channel", warning: null };
    }

    if (channel && !pricing) {
      return {
        channel,
        pricing: null,
        method: "sheet_channel",
        warning: "Sheet channel matched, but product has no available pricing for that channel",
      };
    }
  }

  const uploadedUnitCif = row.quantity > 0 ? row.uploadedSalesValue / row.quantity : 0;

  if (uploadedUnitCif > 0) {
    const matches = (product.channelPricing || []).filter((pricing) => {
      if (pricing.isAvailable === false) {
        return false;
      }

      const unitCifUsd = Number(pricing.cifUsd) || 0;

      if (unitCifUsd <= 0) {
        return false;
      }

      return Math.abs(uploadedUnitCif - unitCifUsd) / unitCifUsd <= PRICE_MATCH_TOLERANCE;
    });

    if (matches.length === 1) {
      const channel = await SalesChannel.findById(matches[0].channelId).lean();
      return { channel, pricing: matches[0], method: "price_match", warning: null };
    }

    if (matches.length > 1) {
      return {
        channel: null,
        pricing: null,
        method: "price_match",
        warning: "Multiple sales channels matched by uploaded unit price",
      };
    }
  }

  return {
    channel: null,
    pricing: null,
    method: "unknown",
    warning: "Sales channel could not be detected from uploaded CIF unit value",
  };
};

const buildCalculatedValues = (quantity, pricing) => {
  if (!pricing) {
    return {};
  }

  const unitCifUsd = Number(pricing.cifUsd) || 0;
  const unitWholesaleAed = Number(pricing.wholesaleAed) || 0;
  const unitRetailAed = Number(pricing.retailAed) || 0;

  return {
    unitCifUsd,
    unitWholesaleAed,
    unitRetailAed,
    calculatedCifUsd: quantity * unitCifUsd,
    calculatedWholesaleAed: quantity * unitWholesaleAed,
    calculatedRetailAed: quantity * unitRetailAed,
    targetValueBasis: pricing.targetValueBasis,
    targetCurrency: pricing.targetCurrency,
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

    let mapping = null;

    if (req.body.mappingId) {
      if (!isValidObjectId(req.body.mappingId)) {
        return res.status(400).json({ success: false, message: "mappingId must be a valid MongoDB ObjectId" });
      }

      mapping = await SalesSheetMapping.findById(req.body.mappingId).lean();
    }

    const columnMapping = req.body.columnMapping || mapping?.columnMapping || {};
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
      notes: req.body.notes,
    });
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
          quantity: row.quantity,
          freeQuantity: row.freeQuantity,
          uploadedSalesValue: row.uploadedSalesValue,
          uploadedCurrency: row.uploadedCurrency,
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
      const orderItem = order.items.find((item) => String(item.productId) === String(record.productId));
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
          recordsCount: { $sum: 1 },
          matchedOrdersCount: { $sum: { $cond: [{ $ifNull: ["$matchedOrderId", false] }, 1, 0] } },
          unmatchedSalesRecordsCount: { $sum: { $cond: [{ $eq: ["$matchStatus", "unmatched"] }, 1, 0] } },
          needsReviewCount: { $sum: { $cond: [{ $eq: ["$matchStatus", "needs_review"] }, 1, 0] } },
        },
      },
    ]);

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
        recordsCount: summary?.recordsCount || 0,
        matchedOrdersCount: summary?.matchedOrdersCount || 0,
        unmatchedSalesRecordsCount: summary?.unmatchedSalesRecordsCount || 0,
        needsReviewCount: summary?.needsReviewCount || 0,
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
      SalesRecord.find(query).sort({ salesDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      SalesRecord.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales records fetched successfully",
      data: records,
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
      "quantity", "freeQuantity", "uploadedSalesValue", "uploadedCurrency", "matchStatus",
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
