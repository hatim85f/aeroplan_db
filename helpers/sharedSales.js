const mongoose = require("mongoose");
const Area = require("../models/Area");
const SalesRecord = require("../models/SalesRecord");
const SalesUploadBatch = require("../models/SalesUploadBatch");
const SharedSalesRule = require("../models/SharedSalesRule");

const { ObjectId } = mongoose.Types;

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const toObjectId = (value) => (isValidObjectId(value) ? new ObjectId(value) : null);

const parseDate = (value) => {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildSharedRuleQueryForRecord = (record) => ({
  accountId: record.accountId,
  status: "active",
  isActive: true,
  $and: [
    {
      $or: [
        { productId: record.productId },
        { productId: { $exists: false } },
        { productId: null },
      ],
    },
    {
      $or: [
        { channelId: record.channelId },
        { channelId: { $exists: false } },
        { channelId: null },
      ],
    },
    {
      $or: [
        { startDate: { $exists: false } },
        { startDate: null },
        { startDate: { $lte: record.salesDate } },
      ],
    },
    {
      $or: [
        { endDate: { $exists: false } },
        { endDate: null },
        { endDate: { $gte: record.salesDate } },
      ],
    },
  ],
});

const calculateAreaShares = async (record) => {
  if (!record?.accountId || !record?.productId || !record?.channelId || !record?.salesDate) {
    return {
      areaShares: [],
      sharedSalesApplied: false,
    };
  }

  const rules = await SharedSalesRule.find(buildSharedRuleQueryForRecord(record))
    .populate("areaId", "areaName")
    .lean();

  if (rules.length === 0) {
    return {
      areaShares: [],
      sharedSalesApplied: false,
    };
  }

  const areaShares = rules.map((rule) => {
    const sharePercentage = Number(rule.sharePercentage) || 0;
    const ratio = sharePercentage / 100;

    return {
      areaId: rule.areaId?._id || rule.areaId,
      areaName: rule.areaId?.areaName,
      sharePercentage,
      sharedQuantity: (Number(record.quantity) || 0) * ratio,
      sharedFreeQuantity: (Number(record.freeQuantity) || 0) * ratio,
      sharedCalculatedCifUsd: (Number(record.calculatedCifUsd) || 0) * ratio,
      sharedCalculatedWholesaleAed: (Number(record.calculatedWholesaleAed) || 0) * ratio,
      sharedCalculatedRetailAed: (Number(record.calculatedRetailAed) || 0) * ratio,
      ruleId: rule._id,
    };
  });

  return {
    areaShares,
    sharedSalesApplied: true,
  };
};

const applySharedSalesToRecord = async (record) => {
  const sharedSales = await calculateAreaShares(record);

  record.areaShares = sharedSales.areaShares;
  record.sharedSalesApplied = sharedSales.sharedSalesApplied;

  return record;
};

const buildSalesRecordRecalculationQuery = (input = {}) => {
  const includeInactive = input.includeInactive === true;
  const query = includeInactive
    ? {}
    : {
      status: "active",
      isActive: true,
    };

  if (Array.isArray(input.salesRecordIds) && input.salesRecordIds.length > 0) {
    query._id = { $in: input.salesRecordIds.map(toObjectId).filter(Boolean) };
  }

  const batchId = input.batchId || input.salesUploadBatchId;

  if (batchId && isValidObjectId(batchId)) {
    query.salesUploadBatchId = toObjectId(batchId);
  }

  if (input.year !== undefined) {
    query.year = Number(input.year);
  }

  if (input.month !== undefined) {
    query.month = Number(input.month);
  }

  if (input.dateFrom || input.dateTo) {
    query.salesDate = {};
    const dateFrom = parseDate(input.dateFrom);
    const dateTo = parseDate(input.dateTo);

    if (dateFrom) {
      query.salesDate.$gte = dateFrom;
    }

    if (dateTo) {
      query.salesDate.$lte = dateTo;
    }
  }

  if (input.accountId && isValidObjectId(input.accountId)) {
    query.accountId = toObjectId(input.accountId);
  }

  if (input.productId && isValidObjectId(input.productId)) {
    query.productId = toObjectId(input.productId);
  }

  if (input.channelId && isValidObjectId(input.channelId)) {
    query.channelId = toObjectId(input.channelId);
  }

  return query;
};

const recalculateSharedSales = async (input = {}) => {
  const query = buildSalesRecordRecalculationQuery(input);

  if (input.uploadSessionId && !query.salesUploadBatchId) {
    const batches = await SalesUploadBatch.find({
      uploadSessionId: String(input.uploadSessionId).trim(),
    }).select("_id").lean();
    query.salesUploadBatchId = batches.length > 0
      ? { $in: batches.map((batch) => batch._id) }
      : null;
  }

  if (input.areaId && isValidObjectId(input.areaId) && !query.accountId) {
    const rules = await SharedSalesRule.find({
      areaId: toObjectId(input.areaId),
      status: "active",
      isActive: true,
    }).select("accountId").lean();
    const accountIds = [...new Set(rules.map((rule) => String(rule.accountId)))].map(toObjectId).filter(Boolean);
    query.accountId = accountIds.length > 0 ? { $in: accountIds } : null;
  }

  const records = await SalesRecord.find(query);
  const warnings = [];
  let updatedCount = 0;

  for (const record of records) {
    try {
      await applySharedSalesToRecord(record);
      record.updatedBy = input.updatedBy || record.updatedBy;
      await record.save();
      updatedCount += 1;
    } catch (error) {
      warnings.push({
        salesRecordId: record._id,
        message: error.message || "Failed to recalculate shared sales",
      });
    }
  }

  return {
    matchedCount: records.length,
    updatedCount,
    warnings,
  };
};

const buildRuleRecalculationInput = (rule, input = {}) => {
  const recalculationInput = {
    accountId: rule.accountId,
    productId: rule.productId,
    channelId: rule.channelId,
    updatedBy: input.updatedBy,
  };

  if (input.applyChangeMode === "retrospective_from_date") {
    recalculationInput.dateFrom = input.effectiveFromDate;
  }

  if (input.applyChangeMode === "future_only") {
    return null;
  }

  return recalculationInput;
};

module.exports = {
  Area,
  applySharedSalesToRecord,
  buildRuleRecalculationInput,
  buildSalesRecordRecalculationQuery,
  calculateAreaShares,
  recalculateSharedSales,
};
