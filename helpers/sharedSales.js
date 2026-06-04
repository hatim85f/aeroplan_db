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

const buildDateChannelProductFilter = (record) => [
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
];

const buildSharedRuleQueryForRecord = (record) => ({
  accountId: record.accountId,
  status: "active",
  isActive: true,
  $and: buildDateChannelProductFilter(record),
});

const buildUploaderAreaRuleQuery = (record) => ({
  areaId: record.uploaderAreaId,
  status: "active",
  isActive: true,
  $and: buildDateChannelProductFilter(record),
});

const buildShareEntry = (record, areaIdVal, areaNameVal, sharePercentage, ruleId) => {
  const ratio = sharePercentage / 100;
  const rawQty = Number(record.rawQuantity ?? record.quantity) || 0;
  const rawFreeQty = Number(record.rawFreeQuantity ?? record.freeQuantity) || 0;

  return {
    areaId: areaIdVal,
    areaName: areaNameVal,
    sharePercentage,
    sharedQuantity: rawQty * ratio,
    sharedFreeQuantity: rawFreeQty * ratio,
    sharedCalculatedCifUsd: rawQty * (Number(record.unitCifUsd) || 0) * ratio,
    sharedCalculatedWholesaleAed: rawQty * (Number(record.unitWholesaleAed) || 0) * ratio,
    sharedCalculatedRetailAed: rawQty * (Number(record.unitRetailAed) || 0) * ratio,
    ruleId,
  };
};

const calculateAreaShares = async (record) => {
  if (!record?.accountId || !record?.productId || !record?.channelId || !record?.salesDate) {
    return {
      areaShares: [],
      sharedSalesApplied: false,
    };
  }

  const [otherAreaRules, uploaderRule] = await Promise.all([
    SharedSalesRule.find(buildSharedRuleQueryForRecord(record))
      .populate("areaId", "areaName")
      .lean(),
    record.uploaderAreaId
      ? SharedSalesRule.findOne(buildUploaderAreaRuleQuery(record))
          .populate("areaId", "areaName")
          .lean()
      : Promise.resolve(null),
  ]);

  if (otherAreaRules.length === 0 && !uploaderRule) {
    return {
      areaShares: [],
      sharedSalesApplied: false,
      uploaderSharePercentage: null,
    };
  }

  const uploaderAreaIdStr = record.uploaderAreaId ? String(record.uploaderAreaId) : null;

  const filteredOtherRules = uploaderAreaIdStr
    ? otherAreaRules.filter((rule) => String(rule.areaId?._id || rule.areaId) !== uploaderAreaIdStr)
    : otherAreaRules;

  const areaShares = filteredOtherRules.map((rule) => buildShareEntry(
    record,
    rule.areaId?._id || rule.areaId,
    rule.areaId?.areaName,
    Number(rule.sharePercentage) || 0,
    rule._id,
  ));

  let uploaderSharePercentage = null;

  if (record.uploaderAreaId) {
    if (uploaderRule) {
      uploaderSharePercentage = Number(uploaderRule.sharePercentage) || 0;
      if (uploaderSharePercentage > 0) {
        areaShares.unshift(buildShareEntry(
          record,
          uploaderRule.areaId?._id || uploaderRule.areaId,
          uploaderRule.areaId?.areaName,
          uploaderSharePercentage,
          uploaderRule._id,
        ));
      }
    } else if (filteredOtherRules.length > 0) {
      const totalSharedPercentage = areaShares.reduce((sum, share) => sum + share.sharePercentage, 0);
      uploaderSharePercentage = Math.max(0, 100 - totalSharedPercentage);

      if (uploaderSharePercentage > 0) {
        const uploaderArea = await Area.findById(record.uploaderAreaId).select("areaName").lean();
        areaShares.unshift(buildShareEntry(
          record,
          record.uploaderAreaId,
          uploaderArea?.areaName,
          uploaderSharePercentage,
          null,
        ));
      }
    }
  }

  return {
    areaShares,
    sharedSalesApplied: areaShares.length > 0,
    uploaderSharePercentage,
  };
};

const applySharedSalesToRecord = async (record) => {
  const sharedSales = await calculateAreaShares(record);

  record.areaShares = sharedSales.areaShares;
  record.sharedSalesApplied = sharedSales.sharedSalesApplied;

  const rawQty = Number(record.rawQuantity ?? record.rawRow?.quantity ?? record.quantity) || 0;
  const rawFreeQty = Number(record.rawFreeQuantity ?? record.rawRow?.freeQuantity ?? record.freeQuantity) || 0;

  if (sharedSales.uploaderSharePercentage !== null) {
    const ratio = sharedSales.uploaderSharePercentage / 100;
    record.quantity = rawQty * ratio;
    record.freeQuantity = rawFreeQty * ratio;
  } else {
    record.quantity = rawQty;
    record.freeQuantity = rawFreeQty;
  }

  record.totalQuantityWithFoc = record.quantity + record.freeQuantity;

  if (record.unitCifUsd || record.unitWholesaleAed || record.unitRetailAed || record.targetUnitValue) {
    record.calculatedCifUsd = record.quantity * (Number(record.unitCifUsd) || 0);
    record.calculatedWholesaleAed = record.quantity * (Number(record.unitWholesaleAed) || 0);
    record.calculatedRetailAed = record.quantity * (Number(record.unitRetailAed) || 0);
    record.targetCalculatedValue = record.quantity * (Number(record.targetUnitValue) || 0);
  }

  return record;
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
