const mongoose = require("mongoose");
const SalesRecord = require("../models/SalesRecord");
const SalesUploadBatch = require("../models/SalesUploadBatch");

const normalizeText = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const normalizeId = (value) => (value ? String(value) : "");

const normalizeKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const normalizeDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");

const normalizeNumber = (value) => String(Number(value || 0));

const normalizeMoney = (value) => String(Math.round(Number(value || 0) * 100) / 100);

const getAccountIdentity = (record) => normalizeText(record.shipToAccountName)
  || normalizeId(record.accountId)
  || normalizeText(record.accountName);

const getProductIdentity = (record) => normalizeId(record.productId)
  || normalizeText(record.productNickname || record.productName);

const getChannelIdentity = (record) => normalizeKey(record.channelKey)
  || normalizeId(record.channelId);

const buildDuplicateKey = (record) => {
  const baseParts = [
    Number(record.year || 0),
    Number(record.month || 0),
  ];

  if (normalizeText(record.invoiceNumber)) {
    return [
      "invoice",
      ...baseParts,
      normalizeText(record.invoiceNumber),
      getAccountIdentity(record),
      getProductIdentity(record),
      getChannelIdentity(record),
      normalizeNumber(record.quantity),
      normalizeNumber(record.freeQuantity),
    ].join("|");
  }

  return [
    "fallback",
    ...baseParts,
    normalizeDate(record.salesDate),
    normalizeText(record.accountName),
    normalizeText(record.shipToAccountName),
    normalizeText(record.productNickname || record.productName),
    normalizeKey(record.channelKey),
    normalizeNumber(record.quantity),
    normalizeNumber(record.freeQuantity),
    normalizeMoney(record.uploadedSalesValue),
  ].join("|");
};

const hasAllCoreMatches = (record) => Boolean(record.productMatched && record.accountMatched && record.channelMatched);

const buildCleanupQuery = async (input = {}) => {
  const query = {
    status: "active",
    isActive: true,
  };

  if (input.uploadSessionId) {
    const batches = await SalesUploadBatch.find({
      uploadSessionId: String(input.uploadSessionId).trim(),
    }).select("_id").lean();
    query.salesUploadBatchId = batches.length > 0
      ? { $in: batches.map((batch) => batch._id) }
      : null;
    return query;
  }

  if (input.batchId && mongoose.Types.ObjectId.isValid(input.batchId)) {
    query.salesUploadBatchId = new mongoose.Types.ObjectId(input.batchId);
    return query;
  }

  if (input.year !== undefined) {
    query.year = Number(input.year);
  }

  if (input.month !== undefined) {
    query.month = Number(input.month);
  }

  return query;
};

const cleanupDuplicateSalesRecords = async (input = {}) => {
  const query = await buildCleanupQuery(input);
  const records = await SalesRecord.find(query)
    .select("_id salesUploadBatchId invoiceNumber salesDate month year accountId accountName shipToAccountName productId productName productNickname channelId channelKey quantity freeQuantity uploadedSalesValue uploadedCurrency matchStatus productMatched accountMatched channelMatched matchedOrderId matchedTargetAssignmentIds matchNotes createdAt")
    .sort({ createdAt: 1, _id: 1 });
  const groups = new Map();

  for (const record of records) {
    const key = buildDuplicateKey(record);
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }

  const duplicateGroups = [...groups.values()].filter((group) => group.length > 1);
  const duplicateIds = [];
  const keptIds = [];

  for (const group of duplicateGroups) {
    const sorted = [...group].sort((left, right) => {
      if ((right.matchStatus === "matched") !== (left.matchStatus === "matched")) {
        return right.matchStatus === "matched" ? 1 : -1;
      }

      if (hasAllCoreMatches(right) !== hasAllCoreMatches(left)) {
        return hasAllCoreMatches(right) ? 1 : -1;
      }

      if (Boolean(right.matchedOrderId) !== Boolean(left.matchedOrderId)) {
        return right.matchedOrderId ? 1 : -1;
      }

      const createdDifference = new Date(left.createdAt || 0) - new Date(right.createdAt || 0);

      if (createdDifference !== 0) {
        return createdDifference;
      }

      return String(left._id).localeCompare(String(right._id));
    });
    const [kept, ...duplicates] = sorted;

    keptIds.push(kept._id);
    duplicateIds.push(...duplicates.map((record) => record._id));
  }

  if (duplicateIds.length > 0 && input.apply !== false) {
    await SalesRecord.updateMany(
      { _id: { $in: duplicateIds } },
      [
        {
          $set: {
            status: "duplicate",
            isActive: false,
            matchNotes: {
              $concat: [
                { $ifNull: ["$matchNotes", ""] },
                {
                  $cond: [
                    { $gt: [{ $strLenCP: { $ifNull: ["$matchNotes", ""] } }, 0] },
                    "; ",
                    "",
                  ],
                },
                "Duplicate deactivated by Refine Sales Data",
              ],
            },
            updatedAt: "$$NOW",
          },
        },
      ],
    );
  }

  return {
    checkedRecords: records.length,
    duplicateGroupsFound: duplicateGroups.length,
    duplicatesDeactivated: duplicateIds.length,
    keptRecords: keptIds.length,
    duplicateRecordIds: duplicateIds,
    keptRecordIds: keptIds,
  };
};

module.exports = {
  buildDuplicateKey,
  cleanupDuplicateSalesRecords,
};
