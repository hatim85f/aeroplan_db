const mongoose = require("mongoose");
const Area = require("../models/Area");
const SalesRecord = require("../models/SalesRecord");
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

const findUserArea = async (userId) => {
  if (!userId || !isValidObjectId(userId)) {
    return null;
  }

  const objectId = toObjectId(userId);

  return Area.findOne({
    $or: [
      { managerId: objectId },
      { userIds: objectId },
    ],
    status: "active",
    isActive: true,
  }).select("_id areaName").lean();
};

const ensureRecordArea = async (record) => {
  if (record.areaId) {
    return false;
  }

  const area = await findUserArea(record.createdBy || record.updatedBy);

  if (!area) {
    return false;
  }

  record.areaId = area._id;
  record.areaName = area.areaName;

  return true;
};

const getBaseQuantity = (record) => Number(record.rawQuantity ?? record.rawRow?.quantity ?? record.quantity) || 0;

const getBaseFreeQuantity = (record) => Number(record.rawFreeQuantity ?? record.rawRow?.freeQuantity ?? record.freeQuantity) || 0;

const getBaseUploadedSalesValue = (record) => (
  Number(record.rawUploadedSalesValue ?? record.rawRow?.salesValue ?? record.uploadedSalesValue) || 0
);

const ensureRawSalesValues = (record) => {
  if (record.rawQuantity === undefined || record.rawQuantity === null) {
    record.rawQuantity = Number(record.quantity) || 0;
  }

  if (record.rawFreeQuantity === undefined || record.rawFreeQuantity === null) {
    record.rawFreeQuantity = Number(record.freeQuantity) || 0;
  }

  if (record.rawUploadedSalesValue === undefined || record.rawUploadedSalesValue === null) {
    record.rawUploadedSalesValue = Number(record.uploadedSalesValue) || 0;
  }
};

const buildShareEntry = (record, rule) => {
  const sharePercentage = Number(rule.sharePercentage) || 0;
  const ratio = sharePercentage / 100;
  const quantity = getBaseQuantity(record);

  return {
    areaId: rule.areaId?._id || rule.areaId,
    areaName: rule.areaId?.areaName,
    sharePercentage,
    sharedQuantity: quantity * ratio,
    sharedFreeQuantity: getBaseFreeQuantity(record) * ratio,
    sharedCalculatedCifUsd: quantity * (Number(record.unitCifUsd) || 0) * ratio,
    sharedCalculatedWholesaleAed: quantity * (Number(record.unitWholesaleAed) || 0) * ratio,
    sharedCalculatedRetailAed: quantity * (Number(record.unitRetailAed) || 0) * ratio,
    ruleId: rule._id,
  };
};

const calculateAreaShares = async (record) => {
  if (!record?.accountId || !record?.productId || !record?.channelId || !record?.salesDate) {
    return {
      areaShares: [],
      sharedSalesApplied: false,
    };
  }

  ensureRawSalesValues(record);

  const rules = await SharedSalesRule.find(buildSharedRuleQueryForRecord(record))
    .populate("areaId", "areaName")
    .lean();

  if (rules.length === 0) {
    return {
      areaShares: [],
      sharedSalesApplied: false,
    };
  }

  const areaShares = rules.map((rule) => buildShareEntry(record, rule));

  return {
    areaShares,
    sharedSalesApplied: true,
  };
};

const applyRecordAreaShare = (record) => {
  if (!record.areaId || !Array.isArray(record.areaShares) || record.areaShares.length === 0) {
    return false;
  }

  const matchingShare = record.areaShares.find((areaShare) => (
    String(areaShare.areaId) === String(record.areaId)
  ));

  if (!matchingShare) {
    return false;
  }

  const ratio = (Number(matchingShare.sharePercentage) || 0) / 100;
  const quantity = Number(matchingShare.sharedQuantity) || 0;
  const freeQuantity = Number(matchingShare.sharedFreeQuantity) || 0;

  record.quantity = quantity;
  record.freeQuantity = freeQuantity;
  record.totalQuantityWithFoc = quantity + freeQuantity;
  record.uploadedSalesValue = getBaseUploadedSalesValue(record) * ratio;
  record.calculatedCifUsd = Number(matchingShare.sharedCalculatedCifUsd) || 0;
  record.calculatedWholesaleAed = Number(matchingShare.sharedCalculatedWholesaleAed) || 0;
  record.calculatedRetailAed = Number(matchingShare.sharedCalculatedRetailAed) || 0;
  record.targetCalculatedValue = quantity * (Number(record.targetUnitValue) || 0);
  record.calculatedValueSnapshots = {
    cifUsd: {
      value: record.calculatedCifUsd,
      currency: "USD",
    },
    wholesaleAed: {
      value: record.calculatedWholesaleAed,
      currency: "AED",
    },
    retailAed: {
      value: record.calculatedRetailAed,
      currency: "AED",
    },
  };

  return true;
};

const applySharedSalesToRecord = async (record, options = {}) => {
  ensureRawSalesValues(record);
  const areaFilled = await ensureRecordArea(record);
  const sharedSales = await calculateAreaShares(record);

  record.areaShares = sharedSales.areaShares;
  record.sharedSalesApplied = sharedSales.sharedSalesApplied;

  const recordShareApplied = options.applyRecordShare
    ? applyRecordAreaShare(record)
    : false;

  return {
    record,
    areaFilled,
    recordShareApplied,
    sharedSalesApplied: sharedSales.sharedSalesApplied,
  };
};

const buildSalesRecordRecalculationQuery = (input = {}) => {
  const query = {};

  if (Array.isArray(input.salesRecordIds) && input.salesRecordIds.length > 0) {
    query._id = { $in: input.salesRecordIds.map(toObjectId).filter(Boolean) };
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

  if (input.activeOnly) {
    query.status = "active";
    query.isActive = true;
  }

  return query;
};

const recalculateSharedSales = async (input = {}) => {
  const query = buildSalesRecordRecalculationQuery(input);

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
  let areaFilledCount = 0;
  let recordShareAppliedCount = 0;
  let sharedSalesAppliedCount = 0;

  for (const record of records) {
    try {
      const result = await applySharedSalesToRecord(record, {
        applyRecordShare: Boolean(input.applyRecordShare),
      });

      if (result.areaFilled) {
        areaFilledCount += 1;
      }

      if (result.recordShareApplied) {
        recordShareAppliedCount += 1;
      }

      if (result.sharedSalesApplied) {
        sharedSalesAppliedCount += 1;
      }

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
    areaFilledCount,
    recordShareAppliedCount,
    sharedSalesAppliedCount,
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
