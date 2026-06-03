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

const buildDuplicateKey = (record) => [
  normalizeText(record.invoiceNumber),
  record.salesDate ? new Date(record.salesDate).toISOString().slice(0, 10) : "",
  Number(record.month || 0),
  Number(record.year || 0),
  normalizeId(record.accountId),
  normalizeText(record.accountName),
  normalizeText(record.shipToAccountName),
  normalizeId(record.productId),
  normalizeText(record.productNickname || record.productName),
  normalizeId(record.channelId),
  Number(record.quantity || 0),
  Number(record.freeQuantity || 0),
  Number(record.uploadedSalesValue || 0),
  String(record.uploadedCurrency || "").trim().toUpperCase(),
].join("|");

const getRecordScore = (record) => {
  let score = 0;

  if (record.matchStatus === "matched") score += 50;
  if (record.matchStatus === "partially_matched") score += 30;
  if (record.productMatched) score += 10;
  if (record.accountMatched) score += 10;
  if (record.channelMatched) score += 10;
  if (record.matchedOrderId) score += 10;
  if (Array.isArray(record.matchedTargetAssignmentIds) && record.matchedTargetAssignmentIds.length > 0) score += 5;

  return score;
};

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
    .select("_id salesUploadBatchId invoiceNumber salesDate month year accountId accountName shipToAccountName productId productName productNickname channelId quantity freeQuantity uploadedSalesValue uploadedCurrency matchStatus productMatched accountMatched channelMatched matchedOrderId matchedTargetAssignmentIds matchNotes createdAt")
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
      const scoreDifference = getRecordScore(right) - getRecordScore(left);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return new Date(left.createdAt || 0) - new Date(right.createdAt || 0);
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
                "Duplicate detected after upload cleanup",
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
  cleanupDuplicateSalesRecords,
};
