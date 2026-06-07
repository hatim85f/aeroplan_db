const mongoose = require("mongoose");

const Account = require("../models/Account");
const AccountRepAssignment = require("../models/AccountRepAssignment");
const SalesRecord = require("../models/SalesRecord");
const TargetAssignment = require("../models/TargetAssignment");
const TargetPhasing = require("../models/TargetPhasing");
const User = require("../models/User");
const { canAccessUser } = require("../helpers/hierarchyAccess");
const { isManagerRole } = require("../helpers/roles");
const { calculateMonthlyTarget } = require("./forecastService");

const makeError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const normalizeYear = (value) => {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw makeError("year must be a valid four digit year", 400);
  }
  return year;
};

const normalizeMonth = (value) => {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw makeError("month must be a number between 1 and 12", 400);
  }
  return month;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

// Achievement % convention: target 0 + sales 0 → 0; target 0 + sales > 0 → 100.
const achievementPercentage = (target, sales) => {
  const targetNumber = Number(target) || 0;
  const salesNumber = Number(sales) || 0;
  if (targetNumber > 0) return round2((salesNumber / targetNumber) * 100);
  return salesNumber > 0 ? 100 : 0;
};

const assignmentOverlapsMonth = (assignment, year, month) => {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const nextMonthStart = new Date(Date.UTC(year, month, 1));
  const endExclusive = new Date(assignment.endDate);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return monthStart < endExclusive && nextMonthStart > new Date(assignment.startDate);
};

const VALUE_BASIS_FIELDS = {
  cifUsd: "calculatedCifUsd",
  wholesaleAed: "calculatedWholesaleAed",
  retailAed: "calculatedRetailAed",
};

const salesRecordValue = (record, basis = "cifUsd") => {
  const field = VALUE_BASIS_FIELDS[basis] || VALUE_BASIS_FIELDS.cifUsd;
  const calculated = Number(record[field]) || 0;
  return calculated || Number(record.uploadedSalesValue) || 0;
};

const emptyBucket = () => ({
  monthlyTargetUnits: 0,
  monthlyTargetValue: 0,
  monthlySalesUnits: 0,
  monthlySalesValue: 0,
  ytdTargetUnits: 0,
  ytdTargetValue: 0,
  ytdSalesUnits: 0,
  ytdSalesValue: 0,
});

const finalizeBucket = (bucket) => ({
  monthlyTargetUnits: round2(bucket.monthlyTargetUnits),
  monthlySalesUnits: round2(bucket.monthlySalesUnits),
  monthlyUnitsAchievementPercentage: achievementPercentage(bucket.monthlyTargetUnits, bucket.monthlySalesUnits),
  monthlyGapUnits: round2(bucket.monthlyTargetUnits - bucket.monthlySalesUnits),
  monthlyTargetValue: round2(bucket.monthlyTargetValue),
  monthlySalesValue: round2(bucket.monthlySalesValue),
  monthlyAchievementPercentage: achievementPercentage(bucket.monthlyTargetValue, bucket.monthlySalesValue),
  monthlyGapValue: round2(bucket.monthlyTargetValue - bucket.monthlySalesValue),
  ytdTargetUnits: round2(bucket.ytdTargetUnits),
  ytdSalesUnits: round2(bucket.ytdSalesUnits),
  ytdUnitsAchievementPercentage: achievementPercentage(bucket.ytdTargetUnits, bucket.ytdSalesUnits),
  ytdGapUnits: round2(bucket.ytdTargetUnits - bucket.ytdSalesUnits),
  ytdTargetValue: round2(bucket.ytdTargetValue),
  ytdSalesValue: round2(bucket.ytdSalesValue),
  ytdAchievementPercentage: achievementPercentage(bucket.ytdTargetValue, bucket.ytdSalesValue),
  ytdGapValue: round2(bucket.ytdTargetValue - bucket.ytdSalesValue),
});

const getRepDisplayName = (user = {}) =>
  user.fullName || user.userName || user.email || "Representative";

const resolveRepIds = async (actor, userId) => {
  if (userId) {
    if (!isValidObjectId(userId)) {
      throw makeError("userId must be a valid MongoDB ObjectId", 400);
    }

    const rep = await User.findById(userId).select("_id role path managerId").lean();

    if (!rep) throw makeError("Medical rep not found", 404);
    if (rep.role !== "representative") throw makeError("userId must belong to a representative user", 400);
    if (!canAccessUser(actor, rep)) throw makeError("You are not allowed to access this medical rep", 403);

    return [String(rep._id)];
  }

  if (!isManagerRole(actor.role)) {
    return [String(actor._id)];
  }

  if (actor.role === "admin") {
    const ids = await TargetAssignment.distinct("userId", { status: "active", isActive: true });
    return ids.map((id) => String(id));
  }

  const reps = await User.find({
    $or: [{ _id: actor._id }, { path: actor._id }],
    role: "representative",
  }).select("_id").lean();

  return reps.map((rep) => String(rep._id));
};

/**
 * Achievement = actual uploaded sales vs phased target. Forecast and orders
 * are intentionally NOT part of this calculation.
 *
 * Everything is bulk-loaded (assignments, phasings, accounts, sales) and
 * aggregated in memory so the endpoint stays well under the Heroku timeout.
 */
const computeAchievement = async ({ repIds, year, month, scope }) => {
  const [assignments, defaultPhasings, repUsers, accounts, datedAssignments] = await Promise.all([
    TargetAssignment.find({
      userId: { $in: repIds },
      year,
      status: "active",
      isActive: true,
    }).lean(),
    TargetPhasing.find({
      year,
      status: "active",
      isActive: true,
      isDefault: true,
    }).sort({ createdAt: -1 }).lean(),
    User.find({ _id: { $in: repIds } }).select("_id fullName userName email").lean(),
    Account.find({ assignedMedicalRepIds: { $in: repIds } }).select("_id assignedMedicalRepIds").lean(),
    AccountRepAssignment.find({ userId: { $in: repIds }, isActive: true })
      .select("accountId userId startDate endDate").lean(),
  ]);

  const repSet = new Set(repIds);
  const repNames = new Map(repUsers.map((user) => [String(user._id), getRepDisplayName(user)]));

  // accountId -> reps in scope statically assigned (legacy fallback).
  const accountReps = new Map();
  accounts.forEach((account) => {
    accountReps.set(
      String(account._id),
      (account.assignedMedicalRepIds || []).map(String).filter((id) => repSet.has(id)),
    );
  });

  // accountId -> dated coverage entries for scope reps.
  const datedByAccount = new Map();
  datedAssignments.forEach((entry) => {
    const key = String(entry.accountId);
    const list = datedByAccount.get(key);
    if (list) list.push(entry);
    else datedByAccount.set(key, [entry]);
  });

  // Rep credit for one sales record, in priority order:
  // 1. manual repAttributions on the record (percentage shares)
  // 2. dated AccountRepAssignment covering the record's salesDate (full credit)
  // 3. legacy Account.assignedMedicalRepIds (full credit)
  const resolveRepShares = (record) => {
    const manual = (record.repAttributions || []).filter((entry) => repSet.has(String(entry.userId)));
    if (manual.length) {
      return manual.map((entry) => ({ repId: String(entry.userId), share: (Number(entry.percentage) || 0) / 100 }));
    }

    const salesTime = record.salesDate ? new Date(record.salesDate).getTime() : 0;
    const dated = (datedByAccount.get(String(record.accountId)) || []).filter((entry) => (
      new Date(entry.startDate).getTime() <= salesTime
      && (!entry.endDate || new Date(entry.endDate).getTime() >= salesTime)
    ));
    if (dated.length) {
      return [...new Set(dated.map((entry) => String(entry.userId)))].map((repId) => ({ repId, share: 1 }));
    }

    return (accountReps.get(String(record.accountId)) || []).map((repId) => ({ repId, share: 1 }));
  };

  // ── Aggregation nodes ──
  const channelNodes = new Map(); // productId:channelId
  const repNodes = new Map(); // repId
  const totals = emptyBucket();

  const getChannelNode = (assignment) => {
    const key = `${String(assignment.productId)}:${String(assignment.channelId)}`;
    let node = channelNodes.get(key);
    if (!node) {
      node = {
        productId: assignment.productId,
        productName: assignment.productName,
        productNickname: assignment.productNickname,
        channelId: assignment.channelId,
        channelName: assignment.channelName,
        channelKey: assignment.channelKey,
        targetValueBasis: assignment.targetValueBasis || "cifUsd",
        targetCurrency: assignment.targetCurrency || (assignment.targetValueBasis === "cifUsd" ? "USD" : "AED"),
        ...emptyBucket(),
      };
      channelNodes.set(key, node);
    }
    return node;
  };

  const getRepNode = (repId) => {
    const key = String(repId);
    let node = repNodes.get(key);
    if (!node) {
      node = { userId: key, userName: repNames.get(key) || "Representative", ...emptyBucket() };
      repNodes.set(key, node);
    }
    return node;
  };

  // ── Targets: phased monthly targets for Jan..selected month ──
  for (const assignment of assignments) {
    const channelNode = getChannelNode(assignment);
    const repNode = getRepNode(assignment.userId);

    for (let m = 1; m <= month; m += 1) {
      if (!assignmentOverlapsMonth(assignment, year, m)) continue;

      const monthly = calculateMonthlyTarget(assignment, m, defaultPhasings);
      const targetUnits = Number(monthly.targetUnits) || 0;
      const targetValue = Number(monthly.targetValue) || 0;

      channelNode.ytdTargetUnits += targetUnits;
      channelNode.ytdTargetValue += targetValue;
      repNode.ytdTargetUnits += targetUnits;
      repNode.ytdTargetValue += targetValue;
      totals.ytdTargetUnits += targetUnits;
      totals.ytdTargetValue += targetValue;

      if (m === month) {
        channelNode.monthlyTargetUnits += targetUnits;
        channelNode.monthlyTargetValue += targetValue;
        repNode.monthlyTargetUnits += targetUnits;
        repNode.monthlyTargetValue += targetValue;
        totals.monthlyTargetUnits += targetUnits;
        totals.monthlyTargetValue += targetValue;
      }
    }
  }

  // ── Actual sales: Jan..selected month, targeted product+channel combos only ──
  const productIds = [...new Set(assignments.map((assignment) => String(assignment.productId)))];

  // Single-rep scope only counts sales attributable to that rep (manual
  // attribution, dated coverage, or legacy account assignment). Team-wide
  // scope counts every sale on the targeted product+channel combos so sales
  // from unassigned accounts still appear in the team totals.
  const singleRepScope = repIds.length === 1;
  const salesQuery = {
    year,
    month: { $lte: month },
    status: "active",
    isActive: true,
    productId: { $in: productIds },
  };

  if (singleRepScope) {
    const repAccountIds = new Set(accounts.map((account) => String(account._id)));
    datedAssignments.forEach((entry) => repAccountIds.add(String(entry.accountId)));

    salesQuery.$or = [
      { accountId: { $in: [...repAccountIds] } },
      { "repAttributions.userId": repIds[0] },
    ];
  }

  const records = productIds.length
    ? await SalesRecord.find(salesQuery)
      .select("productId channelId accountId month salesDate quantity uploadedSalesValue calculatedCifUsd calculatedWholesaleAed calculatedRetailAed repAttributions")
      .lean()
    : [];

  for (const record of records) {
    const node = channelNodes.get(`${String(record.productId)}:${String(record.channelId)}`);
    if (!node) continue; // sales outside any targeted product+channel are not part of achievement

    const units = Number(record.quantity) || 0;
    const value = salesRecordValue(record, node.targetValueBasis);
    const isSelectedMonth = Number(record.month) === month;
    const repShares = resolveRepShares(record);

    // Team scope: totals count the full record. Single-rep scope: totals
    // reflect only that rep's share (e.g. a 40% manual attribution).
    const totalsShare = singleRepScope
      ? repShares.filter((entry) => entry.repId === repIds[0]).reduce((sum, entry) => sum + entry.share, 0)
      : 1;

    if (totalsShare > 0) {
      node.ytdSalesUnits += units * totalsShare;
      node.ytdSalesValue += value * totalsShare;
      totals.ytdSalesUnits += units * totalsShare;
      totals.ytdSalesValue += value * totalsShare;

      if (isSelectedMonth) {
        node.monthlySalesUnits += units * totalsShare;
        node.monthlySalesValue += value * totalsShare;
        totals.monthlySalesUnits += units * totalsShare;
        totals.monthlySalesValue += value * totalsShare;
      }
    }

    // Rep rows: credit each rep with their share.
    repShares.forEach(({ repId, share }) => {
      if (share <= 0) return;
      const repNode = getRepNode(repId);
      repNode.ytdSalesUnits += units * share;
      repNode.ytdSalesValue += value * share;
      if (isSelectedMonth) {
        repNode.monthlySalesUnits += units * share;
        repNode.monthlySalesValue += value * share;
      }
    });
  }

  // ── Shape response ──
  const productsById = new Map();

  channelNodes.forEach((node) => {
    const key = String(node.productId);
    let product = productsById.get(key);
    if (!product) {
      product = {
        productId: node.productId,
        productName: node.productName,
        productNickname: node.productNickname,
        bucket: emptyBucket(),
        channels: [],
      };
      productsById.set(key, product);
    }

    Object.keys(product.bucket).forEach((field) => {
      product.bucket[field] += node[field];
    });

    product.channels.push({
      channelId: node.channelId,
      channelName: node.channelName,
      channelKey: node.channelKey,
      targetValueBasis: node.targetValueBasis,
      targetCurrency: node.targetCurrency,
      ...finalizeBucket(node),
    });
  });

  const products = [...productsById.values()]
    .map((product) => ({
      productId: product.productId,
      productName: product.productName,
      productNickname: product.productNickname,
      ...finalizeBucket(product.bucket),
      channels: product.channels.sort((left, right) => String(left.channelName).localeCompare(String(right.channelName))),
    }))
    .sort((left, right) => String(left.productNickname || left.productName || "")
      .localeCompare(String(right.productNickname || right.productName || ""), undefined, { sensitivity: "base" }));

  const reps = [...repNodes.values()]
    .map((node) => ({
      userId: node.userId,
      userName: node.userName,
      ...finalizeBucket(node),
    }))
    // Hide reps with neither target nor sales in the whole YTD window.
    .filter((rep) => rep.ytdTargetValue > 0 || rep.ytdSalesValue > 0 || rep.ytdTargetUnits > 0 || rep.ytdSalesUnits > 0)
    .sort((left, right) => right.ytdAchievementPercentage - left.ytdAchievementPercentage);

  // Sales counted in team totals that no rep was credited with (no manual
  // attribution, no dated coverage, no static account assignment). Helps
  // explain reps showing 0% — the coverage history simply isn't entered yet.
  const repSalesValue = reps.reduce((sum, rep) => sum + rep.ytdSalesValue, 0);
  const repMonthlySalesValue = reps.reduce((sum, rep) => sum + rep.monthlySalesValue, 0);
  const unattributed = {
    ytdSalesValue: Math.max(round2(round2(totals.ytdSalesValue) - round2(repSalesValue)), 0),
    monthlySalesValue: Math.max(round2(round2(totals.monthlySalesValue) - round2(repMonthlySalesValue)), 0),
  };

  return {
    year,
    month,
    scope,
    repsCount: reps.length,
    summaryCards: finalizeBucket(totals),
    unattributed,
    products,
    reps,
  };
};

const getMyAchievement = async ({ actor, year, month }) => {
  if (actor.role !== "representative") {
    throw makeError("GET /api/achievements/my is for medical reps. Managers and admins should use /api/achievements/team.", 400);
  }

  return computeAchievement({
    repIds: [String(actor._id)],
    year: normalizeYear(year),
    month: normalizeMonth(month),
    scope: "my",
  });
};

const getTeamAchievement = async ({ actor, year, month, userId }) => {
  if (!isManagerRole(actor.role)) {
    throw makeError("Only managers can view team achievement", 403);
  }

  const repIds = await resolveRepIds(actor, userId);

  return computeAchievement({
    repIds,
    year: normalizeYear(year),
    month: normalizeMonth(month),
    scope: "team",
  });
};

module.exports = {
  getMyAchievement,
  getTeamAchievement,
};
