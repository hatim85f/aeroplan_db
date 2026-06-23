const mongoose = require("mongoose");

const Account = require("../models/Account");
const PlanningAccount = require("../models/PlanningAccount");
const PlanningVisit = require("../models/PlanningVisit");
const SalesRecord = require("../models/SalesRecord");
const TargetAssignment = require("../models/TargetAssignment");
const User = require("../models/User");
const { canAccessUser } = require("../helpers/hierarchyAccess");
const { isManagerRole } = require("../helpers/roles");
const { getDownlineRepIds } = require("../helpers/hierarchy");
const { notifyUsers } = require("../helpers/notify");
const { resolveOrgId } = require("../helpers/tenancy");

const makeError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const normalizeKey = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const getDisplayName = (user = {}) => user.fullName || user.userName || user.email || "User";

const startOfDay = (value) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};
const endOfDay = (value) => {
  const date = new Date(value);
  date.setUTCHours(23, 59, 59, 999);
  return date;
};
const weekStartOf = (value) => {
  const date = startOfDay(value);
  const day = date.getUTCDay(); // 0 Sun..6 Sat
  const diff = (day + 6) % 7; // make Monday the start
  date.setUTCDate(date.getUTCDate() - diff);
  return date;
};
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ── Scope resolution ───────────────────────────── */

const getAccessibleRepIds = async (actor) => {
  if (actor.role === "admin") return null; // all
  if (!isManagerRole(actor.role)) return [String(actor._id)];
  const downlineRepIds = await getDownlineRepIds(actor._id);
  const reps = await User.find({
    _id: { $in: downlineRepIds },
    isActive: { $ne: false },
    status: { $ne: "inactive" },
  }).select("_id").lean();
  return reps.map((rep) => String(rep._id));
};

// Resolve the rep a write targets: reps act on themselves; managers/admins
// may target a rep in their scope via body.userId.
const resolveTargetRep = async (actor, userId) => {
  if (!userId || String(userId) === String(actor._id)) {
    return { _id: actor._id, name: getDisplayName(actor), managerId: actor.managerId, teamId: actor.teamId };
  }
  if (!isManagerRole(actor.role)) {
    throw makeError("You can only plan for yourself", 403);
  }
  if (!isValidObjectId(userId)) throw makeError("userId must be a valid MongoDB ObjectId", 400);
  const rep = await User.findById(userId).select("_id fullName userName email role path managerId teamId").lean();
  if (!rep) throw makeError("Medical rep not found", 404);
  if (!canAccessUser(actor, rep)) throw makeError("You are not allowed to plan for this rep", 403);
  return { _id: rep._id, name: getDisplayName(rep), managerId: rep.managerId, teamId: rep.teamId };
};

// Fire-and-forget: notify the rep's upline managers when a visit plan is submitted.
const notifyPlanSubmitted = (repId, action = "submitted their visit plan", selfAction = "submitted your visit plan") => {
  (async () => {
    const me = await User.findById(repId).select("_id fullName userName email path managerId").lean();
    if (!me) return;
    const name = getDisplayName(me);
    const recipientIds = [...(me.path || []), me.managerId].filter(Boolean);
    await notifyUsers({
      from: me._id,
      recipientIds,
      title: `${name} ${action}`,
      selfTitle: `You ${selfAction}`,
      routeName: "PlanningToday",
      category: "planning",
    });
  })().catch(() => {});
};

/* ── Planning accounts ──────────────────────────── */

const listPlanningAccounts = async ({ actor, search, userId, status }) => {
  const query = { isActive: true, organizationId: resolveOrgId(actor) };

  if (userId) {
    const rep = await resolveTargetRep(actor, userId);
    query.userId = rep._id;
  } else if (!isManagerRole(actor.role)) {
    query.userId = actor._id;
  } else {
    const repIds = await getAccessibleRepIds(actor);
    if (repIds) query.userId = { $in: repIds };
  }

  if (status && ["active", "inactive"].includes(status)) query.status = status;
  if (search) query.accountName = { $regex: String(search).trim(), $options: "i" };

  const planningAccounts = await PlanningAccount.find(query).sort({ accountName: 1 }).limit(1000).lean();

  // Bulk visit counts per planning account.
  const ids = planningAccounts.map((entry) => entry._id);
  const counts = ids.length
    ? await PlanningVisit.aggregate([
      { $match: { planningAccountId: { $in: ids }, isActive: true } },
      { $group: { _id: "$planningAccountId", count: { $sum: 1 } } },
    ])
    : [];
  const countByAccount = new Map(counts.map((entry) => [String(entry._id), entry.count]));

  return planningAccounts.map((entry) => ({
    _id: entry._id,
    userId: entry.userId,
    userName: entry.userName,
    accountId: entry.accountId,
    accountName: entry.accountName,
    isCustomAccount: entry.isCustomAccount,
    accountType: entry.accountType,
    area: entry.area,
    territory: entry.territory,
    keyContact: entry.keyContact,
    phoneNumber: entry.phoneNumber,
    notes: entry.notes,
    lastPlannedVisit: entry.lastPlannedVisit || null,
    plannedVisitsCount: countByAccount.get(String(entry._id)) || 0,
    status: entry.status,
  }));
};

const createPlanningAccount = async ({ actor, body }) => {
  const rep = await resolveTargetRep(actor, body.userId);

  // Bulk add several main accounts at once.
  if (Array.isArray(body.accountIds) && body.accountIds.length) {
    const ids = body.accountIds.filter(isValidObjectId);
    const accounts = await Account.find({ _id: { $in: ids } })
      .select("_id accountName accountType area territory keyContact phoneNumber").lean();
    const existing = await PlanningAccount.find({ userId: rep._id, accountId: { $in: ids }, isActive: true })
      .select("accountId").lean();
    const existingSet = new Set(existing.map((entry) => String(entry.accountId)));

    const docs = accounts
      .filter((account) => !existingSet.has(String(account._id)))
      .map((account) => ({
        userId: rep._id,
        userName: rep.name,
        managerId: rep.managerId,
        teamId: rep.teamId,
        accountId: account._id,
        accountName: account.accountName,
        accountNameKey: normalizeKey(account.accountName),
        isCustomAccount: false,
        accountType: account.accountType || "other",
        area: account.area,
        territory: account.territory,
        keyContact: account.keyContact,
        phoneNumber: account.phoneNumber,
        createdBy: actor._id,
        updatedBy: actor._id,
      }));

    if (!docs.length) throw makeError("All selected accounts are already in the planning list", 409);
    const created = await PlanningAccount.insertMany(docs);
    return { createdCount: created.length, skippedCount: accounts.length - created.length, accounts: created };
  }

  if (body.accountId) {
    if (!isValidObjectId(body.accountId)) throw makeError("accountId must be a valid MongoDB ObjectId", 400);
    const account = await Account.findById(body.accountId)
      .select("_id accountName accountType area territory keyContact phoneNumber").lean();
    if (!account) throw makeError("Selected account not found", 404);

    const existing = await PlanningAccount.findOne({ userId: rep._id, accountId: account._id, isActive: true });
    if (existing) throw makeError("This account is already in the rep's planning list", 409);

    return PlanningAccount.create({
      userId: rep._id,
      organizationId: resolveOrgId(actor),
      userName: rep.name,
      managerId: rep.managerId,
      teamId: rep.teamId,
      accountId: account._id,
      accountName: account.accountName,
      accountNameKey: normalizeKey(account.accountName),
      isCustomAccount: false,
      accountType: account.accountType || "other",
      area: account.area,
      territory: account.territory,
      keyContact: account.keyContact,
      phoneNumber: account.phoneNumber,
      notes: body.notes,
      createdBy: actor._id,
      updatedBy: actor._id,
    });
  }

  const accountName = String(body.accountName || "").trim();
  if (!accountName) throw makeError("accountName is required for a custom planning account", 400);

  const nameKey = normalizeKey(accountName);
  const existing = await PlanningAccount.findOne({ userId: rep._id, accountNameKey: nameKey, isCustomAccount: true, isActive: true });
  if (existing) throw makeError("A custom planning account with this name already exists", 409);

  return PlanningAccount.create({
    userId: rep._id,
    organizationId: resolveOrgId(actor),
    userName: rep.name,
    managerId: rep.managerId,
    teamId: rep.teamId,
    accountName,
    accountNameKey: nameKey,
    isCustomAccount: true,
    accountType: body.accountType || "other",
    area: body.area,
    territory: body.territory,
    keyContact: body.keyContact,
    phoneNumber: body.phoneNumber,
    notes: body.notes,
    createdBy: actor._id,
    updatedBy: actor._id,
  });
};

const getScopedPlanningAccount = async (actor, id) => {
  if (!isValidObjectId(id)) throw makeError("Planning account id must be a valid MongoDB ObjectId", 400);
  const planningAccount = await PlanningAccount.findOne({ _id: id, isActive: true });
  if (!planningAccount) throw makeError("Planning account not found", 404);

  const repIds = await getAccessibleRepIds(actor);
  if (repIds && !repIds.includes(String(planningAccount.userId))) {
    throw makeError("You are not allowed to access this planning account", 403);
  }
  return planningAccount;
};

const updatePlanningAccount = async ({ actor, id, body }) => {
  const planningAccount = await getScopedPlanningAccount(actor, id);

  if (body.accountName !== undefined && planningAccount.isCustomAccount) {
    const name = String(body.accountName).trim();
    if (!name) throw makeError("accountName cannot be empty", 400);
    planningAccount.accountName = name;
    planningAccount.accountNameKey = normalizeKey(name);
  }
  ["accountType", "area", "territory", "keyContact", "phoneNumber", "notes"].forEach((field) => {
    if (body[field] !== undefined) planningAccount[field] = body[field];
  });
  if (body.status !== undefined && ["active", "inactive"].includes(body.status)) {
    planningAccount.status = body.status;
  }
  planningAccount.updatedBy = actor._id;
  await planningAccount.save();
  return planningAccount;
};

const deletePlanningAccount = async ({ actor, id }) => {
  const planningAccount = await getScopedPlanningAccount(actor, id);
  planningAccount.isActive = false;
  planningAccount.status = "inactive";
  planningAccount.updatedBy = actor._id;
  await planningAccount.save();
  return { deleted: true, planningAccountId: planningAccount._id };
};

const getAccountSource = async ({ actor, search, assignedOnly, userId }) => {
  const rep = userId ? await resolveTargetRep(actor, userId) : { _id: actor._id };
  const query = {};
  if (search) query.accountName = { $regex: String(search).trim(), $options: "i" };

  const wantAssignedOnly = assignedOnly === undefined ? !isManagerRole(actor.role) : assignedOnly === "true" || assignedOnly === true;
  if (wantAssignedOnly) {
    query.assignedMedicalRepIds = rep._id;
  }

  // Exclude accounts already added as planning accounts for this rep.
  const alreadyAdded = await PlanningAccount.find({ userId: rep._id, accountId: { $exists: true }, isActive: true })
    .select("accountId").lean();
  const addedIds = alreadyAdded.map((entry) => entry.accountId).filter(Boolean);
  if (addedIds.length) query._id = { $nin: addedIds };

  const accounts = await Account.find(query)
    .select("_id accountName accountType area territory keyContact phoneNumber")
    .sort({ accountName: 1 })
    .limit(500)
    .lean();

  return accounts.map((account) => ({
    accountId: account._id,
    accountName: account.accountName,
    accountType: account.accountType,
    area: account.area,
    territory: account.territory,
  }));
};

/* ── Calendar / visits ──────────────────────────── */

const serializeVisit = (visit) => ({
  visitId: visit._id,
  planningAccountId: visit.planningAccountId,
  accountId: visit.accountId,
  accountName: visit.accountName,
  visitDate: visit.visitDate,
  planStatus: visit.planStatus,
  notes: visit.notes || "",
});

const getMyCalendar = async ({ actor, userId, startDate, endDate }) => {
  const rep = userId ? await resolveTargetRep(actor, userId) : { _id: actor._id };
  if (!startDate || !endDate) throw makeError("startDate and endDate are required", 400);

  const visits = await PlanningVisit.find({
    userId: rep._id,
    isActive: true,
    planStatus: { $ne: "cancelled" },
    visitDate: { $gte: startOfDay(startDate), $lte: endOfDay(endDate) },
  }).sort({ visitDate: 1 }).lean();

  return { startDate, endDate, visits: visits.map(serializeVisit) };
};

const createVisits = async ({ actor, userId, visits }) => {
  if (!Array.isArray(visits) || !visits.length) throw makeError("visits array is required", 400);
  const rep = await resolveTargetRep(actor, userId);

  // Validate all planning accounts belong to the rep.
  const planningAccountIds = [...new Set(visits.map((v) => v.planningAccountId).filter(isValidObjectId))];
  const planningAccounts = await PlanningAccount.find({
    _id: { $in: planningAccountIds }, userId: rep._id, isActive: true,
  }).lean();
  const paById = new Map(planningAccounts.map((entry) => [String(entry._id), entry]));

  const created = [];
  for (const visit of visits) {
    if (!visit.planningAccountId || !isValidObjectId(visit.planningAccountId)) {
      throw makeError("planningAccountId is required for every visit", 400);
    }
    const pa = paById.get(String(visit.planningAccountId));
    if (!pa) throw makeError("Planning account not found for this rep", 404);
    if (!visit.visitDate) throw makeError("visitDate is required for every visit", 400);

    const visitDate = startOfDay(visit.visitDate);

    // Prevent exact duplicate active visit.
    const duplicate = await PlanningVisit.findOne({
      userId: rep._id,
      planningAccountId: pa._id,
      visitDate,
      isActive: true,
      planStatus: { $ne: "cancelled" },
    });
    if (duplicate) continue; // silently skip duplicates

    const doc = await PlanningVisit.create({
      userId: rep._id,
      organizationId: resolveOrgId(actor),
      userName: rep.name,
      managerId: rep.managerId,
      teamId: rep.teamId,
      planningAccountId: pa._id,
      accountId: pa.accountId,
      accountName: pa.accountName,
      visitDate,
      year: visitDate.getUTCFullYear(),
      month: visitDate.getUTCMonth() + 1,
      weekStartDate: weekStartOf(visitDate),
      planStatus: visit.submitted ? "submitted" : "draft",
      submittedAt: visit.submitted ? new Date() : undefined,
      notes: visit.notes,
      createdBy: actor._id,
      updatedBy: actor._id,
    });
    created.push(doc);
  }

  // Notify upline managers only when visits were actually submitted (not drafts).
  if (created.some((doc) => doc.planStatus === "submitted")) {
    notifyPlanSubmitted(rep._id, "submitted their visit plan");
  }

  return { createdCount: created.length, visits: created.map(serializeVisit) };
};

const getScopedVisit = async (actor, id) => {
  if (!isValidObjectId(id)) throw makeError("Visit id must be a valid MongoDB ObjectId", 400);
  const visit = await PlanningVisit.findOne({ _id: id, isActive: true });
  if (!visit) throw makeError("Visit not found", 404);
  const repIds = await getAccessibleRepIds(actor);
  if (repIds && !repIds.includes(String(visit.userId))) {
    throw makeError("You are not allowed to access this visit", 403);
  }
  // Reps may only edit their own visits.
  if (!isManagerRole(actor.role) && String(visit.userId) !== String(actor._id)) {
    throw makeError("You can only edit your own visits", 403);
  }
  return visit;
};

const updateVisit = async ({ actor, id, body }) => {
  const visit = await getScopedVisit(actor, id);
  if (body.visitDate) {
    const visitDate = startOfDay(body.visitDate);
    visit.visitDate = visitDate;
    visit.year = visitDate.getUTCFullYear();
    visit.month = visitDate.getUTCMonth() + 1;
    visit.weekStartDate = weekStartOf(visitDate);
  }
  if (body.notes !== undefined) visit.notes = body.notes;
  if (body.planStatus && ["draft", "submitted", "cancelled"].includes(body.planStatus)) {
    visit.planStatus = body.planStatus;
    if (body.planStatus === "submitted") visit.submittedAt = new Date();
  }
  visit.updatedBy = actor._id;
  await visit.save();
  return serializeVisit(visit);
};

const deleteVisit = async ({ actor, id }) => {
  const visit = await getScopedVisit(actor, id);
  visit.isActive = false;
  visit.planStatus = "cancelled";
  visit.updatedBy = actor._id;
  await visit.save();
  return { deleted: true, visitId: visit._id };
};

const submitPlan = async ({ actor, userId, startDate, endDate, year, month }) => {
  const rep = await resolveTargetRep(actor, userId);

  let rangeStart;
  let rangeEnd;
  if (year && month) {
    rangeStart = startOfDay(new Date(Date.UTC(Number(year), Number(month) - 1, 1)));
    rangeEnd = endOfDay(new Date(Date.UTC(Number(year), Number(month), 0)));
  } else if (startDate && endDate) {
    rangeStart = startOfDay(startDate);
    rangeEnd = endOfDay(endDate);
  } else {
    throw makeError("Provide year+month or startDate+endDate", 400);
  }

  const drafts = await PlanningVisit.find({
    userId: rep._id,
    isActive: true,
    planStatus: "draft",
    visitDate: { $gte: rangeStart, $lte: rangeEnd },
  });

  const now = new Date();
  let latestByAccount = new Map();

  for (const visit of drafts) {
    visit.planStatus = "submitted";
    visit.submittedAt = now;
    visit.updatedBy = actor._id;
    await visit.save();

    if (visit.accountId) {
      const key = String(visit.accountId);
      const current = latestByAccount.get(key);
      if (!current || new Date(visit.visitDate) > new Date(current)) {
        latestByAccount.set(key, visit.visitDate);
      }
    }
  }

  // Update linked Accounts: lastPlannedVisit + ensure rep in assignedMedicalRepIds.
  const planId = `PLAN-${rep._id}-${rangeStart.toISOString().slice(0, 10)}`;
  for (const [accountId, date] of latestByAccount.entries()) {
    await Account.updateOne(
      { _id: accountId },
      {
        $set: { lastPlannedVisit: { planId, date } },
        $addToSet: { assignedMedicalRepIds: rep._id },
      },
    );
  }

  if (drafts.length > 0) {
    notifyPlanSubmitted(rep._id, "submitted their visit plan");
  }

  return { submittedCount: drafts.length, accountsTouched: latestByAccount.size };
};

/* ── Manager dashboard ──────────────────────────── */

const getManagerDashboard = async ({ actor, date }) => {
  if (!isManagerRole(actor.role)) throw makeError("Only managers can view the planning dashboard", 403);

  const day = date ? startOfDay(date) : startOfDay(new Date());
  const repIds = await getAccessibleRepIds(actor);

  // Only active reps appear in the team plan.
  const repQuery = { role: "representative", isActive: { $ne: false }, status: { $ne: "inactive" } };
  if (repIds) repQuery._id = { $in: repIds };
  const reps = await User.find(repQuery).select("_id fullName userName email").sort({ fullName: 1 }).lean();

  const visitQuery = {
    isActive: true,
    planStatus: { $ne: "cancelled" },
    visitDate: { $gte: startOfDay(day), $lte: endOfDay(day) },
  };
  if (repIds) visitQuery.userId = { $in: repIds };
  const visits = await PlanningVisit.find(visitQuery).sort({ visitDate: 1 }).lean();

  const visitsByRep = new Map();
  visits.forEach((visit) => {
    const key = String(visit.userId);
    const list = visitsByRep.get(key) || [];
    list.push(serializeVisit(visit));
    visitsByRep.set(key, list);
  });

  const repRows = reps.map((rep) => {
    const repVisits = visitsByRep.get(String(rep._id)) || [];
    return {
      userId: rep._id,
      userName: getDisplayName(rep),
      visitsCount: repVisits.length,
      visits: repVisits,
    };
  });

  const repsWithVisits = repRows.filter((rep) => rep.visitsCount > 0).length;

  return {
    date: day.toISOString().slice(0, 10),
    summaryCards: {
      totalReps: repRows.length,
      repsWithVisits,
      repsWithoutVisits: repRows.length - repsWithVisits,
      totalVisits: visits.length,
    },
    reps: repRows.sort((left, right) => right.visitsCount - left.visitsCount),
  };
};

const getTeamDay = async ({ actor, date }) => {
  const data = await getManagerDashboard({ actor, date });
  return {
    date: data.date,
    reps: data.reps.filter((rep) => rep.visitsCount > 0),
    totalVisits: data.summaryCards.totalVisits,
  };
};

const getTeamWeek = async ({ actor, userId, weekStartDate }) => {
  if (!isManagerRole(actor.role)) throw makeError("Only managers can view a rep's weekly plan", 403);
  const rep = await resolveTargetRep(actor, userId);

  const weekStart = weekStartOf(weekStartDate || new Date());
  const weekEnd = endOfDay(new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000));

  const visits = await PlanningVisit.find({
    userId: rep._id,
    isActive: true,
    planStatus: { $ne: "cancelled" },
    visitDate: { $gte: weekStart, $lte: weekEnd },
  }).sort({ visitDate: 1 }).lean();

  const days = Array.from({ length: 7 }, (_, index) => {
    const dayDate = new Date(weekStart.getTime() + index * 24 * 60 * 60 * 1000);
    const iso = dayDate.toISOString().slice(0, 10);
    return {
      date: iso,
      dayName: DAY_NAMES[dayDate.getUTCDay()],
      visits: visits.filter((visit) => visit.visitDate.toISOString().slice(0, 10) === iso).map(serializeVisit),
    };
  });

  return { userId: rep._id, userName: rep.name, weekStartDate: weekStart.toISOString().slice(0, 10), days };
};

/* ── Reports ────────────────────────────────────── */

const VALUE_BASIS_FIELDS = { cifUsd: "calculatedCifUsd", wholesaleAed: "calculatedWholesaleAed", retailAed: "calculatedRetailAed" };
const salesRecordValue = (record, basis = "cifUsd") => {
  const field = VALUE_BASIS_FIELDS[basis] || VALUE_BASIS_FIELDS.cifUsd;
  return Number(record[field]) || Number(record.uploadedSalesValue) || 0;
};

const getAccountsReport = async ({ actor, dateFrom, dateTo, userId, accountId, productId }) => {
  const repIds = await getAccessibleRepIds(actor);
  const from = startOfDay(dateFrom || new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)));
  const to = endOfDay(dateTo || new Date());

  const visitQuery = { isActive: true, visitDate: { $gte: from, $lte: to } };
  if (userId) {
    const rep = await resolveTargetRep(actor, userId);
    visitQuery.userId = rep._id;
  } else if (repIds) {
    visitQuery.userId = { $in: repIds };
  }
  if (accountId && isValidObjectId(accountId)) visitQuery.accountId = accountId;

  const visits = await PlanningVisit.find(visitQuery).lean();

  // Group per (rep + planningAccount).
  const groups = new Map();
  visits.forEach((visit) => {
    const key = `${String(visit.userId)}:${String(visit.planningAccountId)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        planningAccountId: visit.planningAccountId,
        accountId: visit.accountId || null,
        accountName: visit.accountName,
        userId: visit.userId,
        userName: visit.userName,
        plannedVisitsCount: 0,
        submittedVisitsCount: 0,
        cancelledVisitsCount: 0,
        lastPlannedVisit: null,
      };
      groups.set(key, group);
    }
    if (visit.planStatus === "cancelled") group.cancelledVisitsCount += 1;
    else {
      group.plannedVisitsCount += 1;
      if (visit.planStatus === "submitted") group.submittedVisitsCount += 1;
    }
    if (!group.lastPlannedVisit || new Date(visit.visitDate) > new Date(group.lastPlannedVisit)) {
      group.lastPlannedVisit = visit.visitDate;
    }
  });

  const groupList = [...groups.values()];

  // Bulk: assigned products per rep (active targets in period year(s)).
  const repIdSet = [...new Set(groupList.map((group) => String(group.userId)))];
  const assignments = repIdSet.length
    ? await TargetAssignment.find({ userId: { $in: repIdSet }, status: "active", isActive: true })
      .select("userId productId productName productNickname targetValueBasis targetCurrency").lean()
    : [];
  // rep -> Map(productId -> assignment meta)
  const assignedByRep = new Map();
  assignments.forEach((a) => {
    const key = String(a.userId);
    const map = assignedByRep.get(key) || new Map();
    map.set(String(a.productId), a);
    assignedByRep.set(key, map);
  });

  // Bulk: sales for linked accounts in the period.
  const linkedAccountIds = [...new Set(groupList.map((group) => group.accountId).filter(Boolean).map(String))];
  const salesRecords = linkedAccountIds.length
    ? await SalesRecord.find({
      accountId: { $in: linkedAccountIds },
      status: "active",
      isActive: true,
      salesDate: { $gte: from, $lte: to },
      ...(productId && isValidObjectId(productId) ? { productId } : {}),
    }).select("accountId productId productName productNickname quantity uploadedSalesValue calculatedCifUsd calculatedWholesaleAed calculatedRetailAed").lean()
    : [];

  const salesByAccount = new Map();
  salesRecords.forEach((record) => {
    const key = String(record.accountId);
    const list = salesByAccount.get(key) || [];
    list.push(record);
    salesByAccount.set(key, list);
  });

  const accounts = groupList.map((group) => {
    const assignedProducts = assignedByRep.get(String(group.userId)) || new Map();
    const records = group.accountId ? (salesByAccount.get(String(group.accountId)) || []) : [];

    const productTotals = new Map();
    let salesUnits = 0;
    let salesValue = 0;
    let basis = "cifUsd";
    let currency = "USD";

    records.forEach((record) => {
      const meta = assignedProducts.get(String(record.productId));
      if (!meta) return; // only the rep's assigned products
      basis = meta.targetValueBasis || basis;
      currency = meta.targetCurrency || currency;
      const units = Number(record.quantity) || 0;
      const value = salesRecordValue(record, meta.targetValueBasis || "cifUsd");
      salesUnits += units;
      salesValue += value;
      const pKey = String(record.productId);
      const entry = productTotals.get(pKey) || {
        productId: record.productId,
        productName: meta.productName || record.productName,
        productNickname: meta.productNickname || record.productNickname,
        salesUnits: 0,
        salesValue: 0,
      };
      entry.salesUnits += units;
      entry.salesValue += value;
      productTotals.set(pKey, entry);
    });

    return {
      accountId: group.accountId,
      planningAccountId: group.planningAccountId,
      accountName: group.accountName,
      userId: group.userId,
      userName: group.userName,
      plannedVisitsCount: group.plannedVisitsCount,
      submittedVisitsCount: group.submittedVisitsCount,
      cancelledVisitsCount: group.cancelledVisitsCount,
      lastPlannedVisit: group.lastPlannedVisit,
      assignedProductsSalesUnits: round2(salesUnits),
      assignedProductsSalesValue: round2(salesValue),
      currency,
      targetValueBasis: basis,
      needsReview: !group.accountId, // custom planning accounts can't be value-matched
      products: [...productTotals.values()].map((entry) => ({
        ...entry,
        salesUnits: round2(entry.salesUnits),
        salesValue: round2(entry.salesValue),
      })),
    };
  }).sort((left, right) => right.assignedProductsSalesValue - left.assignedProductsSalesValue);

  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
    summaryCards: {
      totalAccountsPlanned: accounts.length,
      totalPlannedVisits: accounts.reduce((sum, a) => sum + a.plannedVisitsCount, 0),
      totalSubmittedVisits: accounts.reduce((sum, a) => sum + a.submittedVisitsCount, 0),
      totalBusinessValue: round2(accounts.reduce((sum, a) => sum + a.assignedProductsSalesValue, 0)),
      totalBusinessUnits: round2(accounts.reduce((sum, a) => sum + a.assignedProductsSalesUnits, 0)),
    },
    accounts,
  };
};

const getRepsReport = async ({ actor, dateFrom, dateTo }) => {
  if (!isManagerRole(actor.role)) throw makeError("Only managers can view the rep report", 403);
  const report = await getAccountsReport({ actor, dateFrom, dateTo });

  const byRep = new Map();
  report.accounts.forEach((account) => {
    const key = String(account.userId);
    let rep = byRep.get(key);
    if (!rep) {
      rep = {
        userId: account.userId,
        userName: account.userName,
        plannedVisits: 0,
        submittedVisits: 0,
        uniqueAccounts: 0,
        salesUnits: 0,
        salesValue: 0,
      };
      byRep.set(key, rep);
    }
    rep.plannedVisits += account.plannedVisitsCount;
    rep.submittedVisits += account.submittedVisitsCount;
    rep.uniqueAccounts += 1;
    rep.salesUnits += account.assignedProductsSalesUnits;
    rep.salesValue += account.assignedProductsSalesValue;
  });

  return {
    dateFrom: report.dateFrom,
    dateTo: report.dateTo,
    reps: [...byRep.values()]
      .map((rep) => ({ ...rep, salesUnits: round2(rep.salesUnits), salesValue: round2(rep.salesValue) }))
      .sort((left, right) => right.salesValue - left.salesValue),
  };
};

module.exports = {
  createPlanningAccount,
  createVisits,
  deletePlanningAccount,
  deleteVisit,
  getAccountSource,
  getAccountsReport,
  getManagerDashboard,
  getMyCalendar,
  getRepsReport,
  getTeamDay,
  getTeamWeek,
  listPlanningAccounts,
  submitPlan,
  updatePlanningAccount,
  updateVisit,
};
