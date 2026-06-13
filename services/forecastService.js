const mongoose = require("mongoose");

const Account = require("../models/Account");
const ForecastMonth = require("../models/ForecastMonth");
const SalesRecord = require("../models/SalesRecord");
const TargetAssignment = require("../models/TargetAssignment");
const TargetPhasing = require("../models/TargetPhasing");
const User = require("../models/User");
const { canAccessUser } = require("../helpers/hierarchyAccess");
const { isManagerRole } = require("../helpers/roles");
const { getDownlineRepIds } = require("../helpers/hierarchy");
const { notifyUsers } = require("../helpers/notify");

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const makeError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const validateObjectId = (value, fieldName) => {
  if (!value || !isValidObjectId(value)) {
    throw makeError(`${fieldName} must be a valid MongoDB ObjectId`, 400);
  }

  return value;
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

const normalizePeriod = ({ year, month } = {}) => {
  const now = new Date();

  return {
    year: normalizeYear(year || now.getUTCFullYear()),
    month: normalizeMonth(month || (now.getUTCMonth() + 1)),
  };
};

const normalizeNonNegativeNumber = (value, fieldName, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw makeError(`${fieldName} is required`, 400);
    }

    return 0;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw makeError(`${fieldName} must be a number greater than or equal to 0`, 400);
  }

  return number;
};

const monthBounds = (year, month) => ({
  monthStart: new Date(Date.UTC(year, month - 1, 1)),
  nextMonthStart: new Date(Date.UTC(year, month, 1)),
});

const addOneDay = (date) => {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate;
};

const monthOverlapsAssignment = (assignment, month) => {
  const { monthStart, nextMonthStart } = monthBounds(assignment.year, month);

  return monthStart < addOneDay(assignment.endDate) && nextMonthStart > assignment.startDate;
};

const getCurrentUser = async (userId) => {
  const user = await User.findById(userId);

  if (!user) {
    throw makeError("User not found", 404);
  }

  return user;
};

const getAccessibleRepIds = async (actor) => {
  if (actor.role === "admin") {
    return null;
  }

  const actorId = String(actor._id);

  if (!isManagerRole(actor.role)) {
    return [actorId];
  }

  const downlineRepIds = await getDownlineRepIds(actor._id);

  const reps = await User.find({
    _id: { $in: downlineRepIds },
    status: "active",
  }).select("_id").lean();

  return reps.map((rep) => String(rep._id));
};

const getActiveRepIds = async (repIds) => {
  const query = {
    role: "representative",
    status: "active",
  };

  if (Array.isArray(repIds)) {
    query._id = { $in: repIds };
  }

  const reps = await User.find(query).select("_id").lean();

  return reps.map((rep) => String(rep._id));
};

const loadRepForActor = async (actor, userId, { requireActive = false } = {}) => {
  validateObjectId(userId, "userId");

  const rep = await User.findById(userId).select("_id fullName userName email role status managerId teamId lineId path").lean();

  if (!rep) {
    throw makeError("Medical rep not found", 404);
  }

  if (rep.role !== "representative") {
    throw makeError("userId must belong to a representative user", 400);
  }

  if (requireActive && rep.status !== "active") {
    throw makeError("Medical rep is inactive", 404);
  }

  if (!canAccessUser(actor, rep)) {
    throw makeError("You are not allowed to access this medical rep forecast", 403);
  }

  return rep;
};

const ensureCanAccessForecast = async (actor, forecast) => {
  if (!forecast) {
    return false;
  }

  if (actor.role === "admin") {
    return true;
  }

  if (String(forecast.userId) === String(actor._id)) {
    return true;
  }

  if (!isManagerRole(actor.role)) {
    return false;
  }

  const rep = await User.findById(forecast.userId).select("_id path role").lean();

  return canAccessUser(actor, rep);
};

const assertCanMutateForecast = async (actor, forecast) => {
  if (!await ensureCanAccessForecast(actor, forecast)) {
    throw makeError("You are not allowed to update this forecast", 403);
  }

  if (forecast.forecastStatus === "closed" && !isManagerRole(actor.role)) {
    throw makeError("Closed forecasts can only be edited by a manager or admin", 403);
  }

  if (!isManagerRole(actor.role) && String(forecast.userId) !== String(actor._id)) {
    throw makeError("You can only edit your own forecast", 403);
  }
};

const idsMatch = (left, right) => String(left || "") === String(right || "");

const phasingMatchesScope = (phasing, scope) => Object.entries(scope).every(([key, value]) => {
  if (value === undefined || value === null || value === "") {
    return true;
  }

  return idsMatch(phasing[key], value);
});

const getDefaultPhasingScopes = (assignment) => [
  {
      teamId: assignment.teamId,
      lineId: assignment.lineId,
      productId: assignment.productId,
      channelId: assignment.channelId,
  },
  {
      lineId: assignment.lineId,
      productId: assignment.productId,
      channelId: assignment.channelId,
  },
  {
      teamId: assignment.teamId,
      lineId: assignment.lineId,
  },
  {
      lineId: assignment.lineId,
  },
  {},
];

const findDefaultPhasing = (assignment, defaultPhasings) => {
  for (const scope of getDefaultPhasingScopes(assignment)) {
    const phasing = defaultPhasings.find((entry) => phasingMatchesScope(entry, scope));

    if (phasing) {
      return phasing;
    }
  }

  return null;
};

const calculateMonthlyTarget = (assignment, month, defaultPhasings) => {
  const phasing = findDefaultPhasing(assignment, defaultPhasings);

  if (!phasing) {
    return {
      month,
      monthName: MONTH_NAMES[month - 1],
      targetUnits: 0,
      targetValue: 0,
      phasingId: null,
      phasingName: null,
    };
  }

  const overlappingMonths = (phasing.months || []).filter((entry) => monthOverlapsAssignment(assignment, entry.month));
  const periodPercentageTotal = overlappingMonths.reduce((sum, entry) => sum + (Number(entry.percentage) || 0), 0);
  const monthEntry = overlappingMonths.find((entry) => Number(entry.month) === month);
  const normalizedPercentage = monthEntry && periodPercentageTotal > 0
    ? ((Number(monthEntry.percentage) || 0) / periodPercentageTotal) * 100
    : 0;

  return {
    month,
    monthName: monthEntry?.monthName || MONTH_NAMES[month - 1],
    targetUnits: (Number(assignment.totalTargetUnits) || 0) * normalizedPercentage / 100,
    targetValue: (Number(assignment.totalTargetValue) || 0) * normalizedPercentage / 100,
    phasingId: phasing._id,
    phasingName: phasing.name,
  };
};

const getPreservedAccountForecasts = (existingForecast) => {
  const preserved = new Map();

  (existingForecast?.items || []).forEach((item) => {
    (item.channels || []).forEach((channel) => {
      const key = `${String(item.productId)}:${String(channel.channelId)}:${String(channel.targetAssignmentId)}`;
      preserved.set(key, (channel.accountForecasts || []).map((entry) => {
        const accountForecast = typeof entry.toObject === "function" ? entry.toObject() : { ...entry };
        return accountForecast;
      }));
    });
  });

  return preserved;
};

const recalculateForecastTotals = (forecast) => {
  forecast.totalMonthlyTargetUnits = 0;
  forecast.totalMonthlyTargetValue = 0;
  forecast.totalForecastUnits = 0;
  forecast.totalForecastValue = 0;

  (forecast.items || []).forEach((item) => {
    item.totalItemTargetUnits = 0;
    item.totalItemTargetValue = 0;
    item.totalItemForecastUnits = 0;
    item.totalItemForecastValue = 0;

    (item.channels || []).forEach((channel) => {
      channel.forecastUnits = round2((channel.accountForecasts || []).reduce((sum, entry) => sum + (Number(entry.forecastQuantity) || 0), 0));
      channel.forecastValue = round2((channel.accountForecasts || []).reduce((sum, entry) => sum + (Number(entry.forecastValue) || 0), 0));
      channel.targetUnits = round2(channel.targetUnits);
      channel.targetValue = round2(channel.targetValue);
      channel.targetUnitValue = round2(channel.targetUnitValue);
      channel.deficitUnits = round2(channel.targetUnits - channel.forecastUnits);
      channel.deficitValue = round2(channel.targetValue - channel.forecastValue);
      channel.coveragePercentage = channel.targetValue > 0
        ? round2((channel.forecastValue / channel.targetValue) * 100)
        : 0;

      item.totalItemTargetUnits += channel.targetUnits;
      item.totalItemTargetValue += channel.targetValue;
      item.totalItemForecastUnits += channel.forecastUnits;
      item.totalItemForecastValue += channel.forecastValue;
    });

    item.totalItemTargetUnits = round2(item.totalItemTargetUnits);
    item.totalItemTargetValue = round2(item.totalItemTargetValue);
    item.totalItemForecastUnits = round2(item.totalItemForecastUnits);
    item.totalItemForecastValue = round2(item.totalItemForecastValue);
    item.itemDeficitUnits = round2(item.totalItemTargetUnits - item.totalItemForecastUnits);
    item.itemDeficitValue = round2(item.totalItemTargetValue - item.totalItemForecastValue);
    item.itemCoveragePercentage = item.totalItemTargetValue > 0
      ? round2((item.totalItemForecastValue / item.totalItemTargetValue) * 100)
      : 0;

    forecast.totalMonthlyTargetUnits += item.totalItemTargetUnits;
    forecast.totalMonthlyTargetValue += item.totalItemTargetValue;
    forecast.totalForecastUnits += item.totalItemForecastUnits;
    forecast.totalForecastValue += item.totalItemForecastValue;
  });

  forecast.totalMonthlyTargetUnits = round2(forecast.totalMonthlyTargetUnits);
  forecast.totalMonthlyTargetValue = round2(forecast.totalMonthlyTargetValue);
  forecast.totalForecastUnits = round2(forecast.totalForecastUnits);
  forecast.totalForecastValue = round2(forecast.totalForecastValue);
  forecast.totalDeficitUnits = round2(forecast.totalMonthlyTargetUnits - forecast.totalForecastUnits);
  forecast.totalDeficitValue = round2(forecast.totalMonthlyTargetValue - forecast.totalForecastValue);
  forecast.totalCoveragePercentage = forecast.totalMonthlyTargetValue > 0
    ? round2((forecast.totalForecastValue / forecast.totalMonthlyTargetValue) * 100)
    : 0;

  return forecast;
};

const buildSummary = (forecast) => ({
  targetUnits: forecast.totalMonthlyTargetUnits || 0,
  targetValue: forecast.totalMonthlyTargetValue || 0,
  forecastUnits: forecast.totalForecastUnits || 0,
  forecastValue: forecast.totalForecastValue || 0,
  deficitUnits: forecast.totalDeficitUnits || 0,
  deficitValue: forecast.totalDeficitValue || 0,
  coveragePercentage: forecast.totalCoveragePercentage || 0,
  productsCount: (forecast.items || []).length,
  channelsCount: (forecast.items || []).reduce((sum, item) => sum + (item.channels || []).length, 0),
  accountForecastsCount: (forecast.items || []).reduce(
    (sum, item) => sum + (item.channels || []).reduce((channelSum, channel) => channelSum + (channel.accountForecasts || []).length, 0),
    0,
  ),
});

const serializeForecast = (forecast) => {
  const data = typeof forecast.toObject === "function" ? forecast.toObject() : { ...forecast };

  return {
    ...data,
    summaryCards: buildSummary(data),
  };
};

const buildForecastBase = async ({ actor, userId, year, month, existingForecast }) => {
  const rep = await loadRepForActor(actor, userId);
  const { monthStart, nextMonthStart } = monthBounds(year, month);
  const [assignments, defaultPhasings] = await Promise.all([
    TargetAssignment.find({
      userId: rep._id,
      year,
      status: "active",
      isActive: true,
      startDate: { $lt: nextMonthStart },
      endDate: { $gte: monthStart },
    }).sort({ productName: 1, channelName: 1 }).lean(),
    TargetPhasing.find({
      year,
      status: "active",
      isActive: true,
      isDefault: true,
    }).sort({ createdAt: -1 }).lean(),
  ]);
  const preservedAccountForecasts = getPreservedAccountForecasts(existingForecast);
  const itemsByProductId = new Map();

  for (const assignment of assignments) {
    const monthlyTarget = calculateMonthlyTarget(assignment, month, defaultPhasings);
    const productKey = String(assignment.productId);
    const channelKey = `${productKey}:${String(assignment.channelId)}:${String(assignment._id)}`;

    if (!itemsByProductId.has(productKey)) {
      itemsByProductId.set(productKey, {
        productId: assignment.productId,
        productName: assignment.productName,
        productNickname: assignment.productNickname,
        totalItemTargetUnits: 0,
        totalItemTargetValue: 0,
        totalItemForecastUnits: 0,
        totalItemForecastValue: 0,
        itemDeficitUnits: 0,
        itemDeficitValue: 0,
        itemCoveragePercentage: 0,
        channels: [],
      });
    }

    const targetUnits = round2(monthlyTarget.targetUnits);
    const targetValue = round2(monthlyTarget.targetValue);

    itemsByProductId.get(productKey).channels.push({
      targetAssignmentId: assignment._id,
      channelId: assignment.channelId,
      channelName: assignment.channelName,
      channelKey: assignment.channelKey,
      targetUnits,
      targetValue,
      targetUnitValue: targetUnits > 0 ? round2(targetValue / targetUnits) : 0,
      targetValueBasis: assignment.targetValueBasis,
      targetCurrency: assignment.targetCurrency,
      forecastUnits: 0,
      forecastValue: 0,
      deficitUnits: 0,
      deficitValue: 0,
      coveragePercentage: 0,
      accountForecasts: preservedAccountForecasts.get(channelKey) || [],
    });
  }

  const firstAssignment = assignments[0];

  return {
    userId: rep._id,
    userName: rep.fullName || rep.userName || rep.email,
    managerId: rep.managerId || firstAssignment?.managerId,
    teamId: rep.teamId || firstAssignment?.teamId,
    lineId: firstAssignment?.lineId || rep.lineId,
    lineName: firstAssignment?.lineName,
    year,
    month,
    items: Array.from(itemsByProductId.values()),
  };
};

const buildOrRefreshMonthlyForecast = async ({ actor, userId, year, month, preserveStatus = true }) => {
  const existingForecast = await ForecastMonth.findOne({
    userId,
    year,
    month,
    isActive: true,
  });
  const base = await buildForecastBase({
    actor,
    userId,
    year,
    month,
    existingForecast,
  });

  let forecast = existingForecast;

  if (!forecast) {
    forecast = new ForecastMonth({
      ...base,
      forecastStatus: "draft",
      status: "active",
      isActive: true,
      createdBy: actor._id,
      updatedBy: actor._id,
    });
  } else {
    Object.assign(forecast, {
      ...base,
      forecastStatus: preserveStatus ? forecast.forecastStatus : "draft",
      updatedBy: actor._id,
    });
  }

  recalculateForecastTotals(forecast);
  await forecast.save();

  return forecast;
};

const getMyForecast = async ({ actor, year, month }) => {
  if (actor.role !== "representative") {
    throw makeError("GET /api/forecasts/my is for medical reps. Managers and admins should use /api/forecasts/team.", 400);
  }

  const period = normalizePeriod({ year, month });
  const existingForecast = await ForecastMonth.findOne({
    userId: actor._id,
    year: period.year,
    month: period.month,
    isActive: true,
  });
  const forecast = existingForecast || await buildOrRefreshMonthlyForecast({
    actor,
    userId: actor._id,
    ...period,
  });

  return serializeForecast(forecast);
};

const getForecastById = async ({ actor, forecastId }) => {
  validateObjectId(forecastId, "forecastId");

  const forecast = await ForecastMonth.findOne({
    _id: forecastId,
    isActive: true,
  });

  if (!forecast) {
    throw makeError("Forecast not found", 404);
  }

  if (!await ensureCanAccessForecast(actor, forecast)) {
    throw makeError("You are not allowed to view this forecast", 403);
  }

  return serializeForecast(forecast);
};

const summarizeTeamForecasts = async ({ actor, year, month, userId }) => {
  if (!isManagerRole(actor.role)) {
    throw makeError("Only managers can view team forecasts", 403);
  }

  const period = normalizePeriod({ year, month });
  const accessibleRepIds = await getAccessibleRepIds(actor);
  let repIds;

  if (userId) {
    const rep = await loadRepForActor(actor, userId, { requireActive: true });
    repIds = [String(rep._id)];
  } else if (accessibleRepIds) {
    repIds = accessibleRepIds;
  } else {
    const { monthStart, nextMonthStart } = monthBounds(period.year, period.month);
    const assignments = await TargetAssignment.find({
      year: period.year,
      status: "active",
      isActive: true,
      startDate: { $lt: nextMonthStart },
      endDate: { $gte: monthStart },
    }).distinct("userId");
    repIds = await getActiveRepIds(assignments.map((id) => String(id)));
  }

  const existingForecasts = await ForecastMonth.find({
    userId: { $in: repIds },
    year: period.year,
    month: period.month,
    isActive: true,
  });
  const existingByRepId = new Map(existingForecasts.map((forecast) => [String(forecast.userId), forecast]));
  const forecasts = [];

  for (const repId of repIds) {
    const forecast = existingByRepId.get(String(repId)) || await buildOrRefreshMonthlyForecast({
      actor,
      userId: repId,
      ...period,
    });
    const data = serializeForecast(forecast);

    forecasts.push({
      forecastId: data._id,
      userId: data.userId,
      userName: data.userName,
      managerId: data.managerId,
      teamId: data.teamId,
      lineId: data.lineId,
      lineName: data.lineName,
      year: data.year,
      month: data.month,
      forecastStatus: data.forecastStatus,
      monthlyTargetValue: data.totalMonthlyTargetValue,
      monthlyTargetUnits: data.totalMonthlyTargetUnits,
      forecastValue: data.totalForecastValue,
      forecastUnits: data.totalForecastUnits,
      deficitValue: data.totalDeficitValue,
      deficitUnits: data.totalDeficitUnits,
      coveragePercentage: data.totalCoveragePercentage,
      itemsSummary: (data.items || []).map((item) => ({
        productId: item.productId,
        productName: item.productName,
        productNickname: item.productNickname,
        targetValue: item.totalItemTargetValue,
        targetUnits: item.totalItemTargetUnits,
        forecastValue: item.totalItemForecastValue,
        forecastUnits: item.totalItemForecastUnits,
        deficitValue: item.itemDeficitValue,
        deficitUnits: item.itemDeficitUnits,
        coveragePercentage: item.itemCoveragePercentage,
        channelsCount: (item.channels || []).length,
      })),
    });
  }

  return {
    year: period.year,
    month: period.month,
    repsCount: forecasts.length,
    totalMonthlyTargetValue: round2(forecasts.reduce((sum, forecast) => sum + forecast.monthlyTargetValue, 0)),
    totalForecastValue: round2(forecasts.reduce((sum, forecast) => sum + forecast.forecastValue, 0)),
    totalDeficitValue: round2(forecasts.reduce((sum, forecast) => sum + forecast.deficitValue, 0)),
    totalCoveragePercentage: forecasts.reduce((sum, forecast) => sum + forecast.monthlyTargetValue, 0) > 0
      ? round2((forecasts.reduce((sum, forecast) => sum + forecast.forecastValue, 0) / forecasts.reduce((sum, forecast) => sum + forecast.monthlyTargetValue, 0)) * 100)
      : 0,
    forecasts,
  };
};

const findForecastChannel = (forecast, productId, channelId) => {
  const item = (forecast.items || []).find((entry) => String(entry.productId) === String(productId));

  if (!item) {
    throw makeError("Forecast item not found for this product", 404);
  }

  const matchingChannels = (item.channels || []).filter((channel) => String(channel.channelId) === String(channelId));

  if (matchingChannels.length === 0) {
    throw makeError("Forecast channel not found for this product", 404);
  }

  if (matchingChannels.length > 1) {
    throw makeError("Multiple target assignments exist for this product/channel. Refresh or use a unique target assignment before adding forecasts.", 409);
  }

  return matchingChannels[0];
};

const calculateEntryAmounts = ({ inputType, forecastQuantity, forecastValue, targetUnitValue }) => {
  if (!["units", "value"].includes(inputType)) {
    throw makeError("inputType must be units or value", 400);
  }

  if (inputType === "units") {
    const quantity = normalizeNonNegativeNumber(forecastQuantity, "forecastQuantity", { required: true });
    return {
      forecastQuantity: round2(quantity),
      forecastValue: round2(quantity * (Number(targetUnitValue) || 0)),
    };
  }

  const value = normalizeNonNegativeNumber(forecastValue, "forecastValue", { required: true });

  return {
    forecastQuantity: targetUnitValue > 0 ? round2(value / targetUnitValue) : 0,
    forecastValue: round2(value),
  };
};

const validateAccountForForecast = async ({ accountId, forecastUserId }) => {
  validateObjectId(accountId, "accountId");

  const account = await Account.findById(accountId).select("_id accountName assignedMedicalRepIds").lean();

  if (!account) {
    throw makeError("Account not found", 404);
  }

  const assignedRepIds = (account.assignedMedicalRepIds || []).map((id) => String(id));

  if (assignedRepIds.length > 0 && !assignedRepIds.includes(String(forecastUserId))) {
    throw makeError("Account is not assigned to this medical rep", 403);
  }

  return account;
};

const addAccountForecast = async ({ actor, forecastId, productId, channelId, body }) => {
  validateObjectId(forecastId, "forecastId");
  validateObjectId(productId, "productId");
  validateObjectId(channelId, "channelId");

  const forecast = await ForecastMonth.findOne({ _id: forecastId, isActive: true });

  if (!forecast) {
    throw makeError("Forecast not found", 404);
  }

  await assertCanMutateForecast(actor, forecast);

  const channel = findForecastChannel(forecast, productId, channelId);
  const account = await validateAccountForForecast({
    accountId: body.accountId,
    forecastUserId: forecast.userId,
  });
  const amounts = calculateEntryAmounts({
    inputType: body.inputType,
    forecastQuantity: body.forecastQuantity,
    forecastValue: body.forecastValue,
    targetUnitValue: channel.targetUnitValue,
  });

  channel.accountForecasts.push({
    accountId: account._id,
    accountName: account.accountName,
    inputType: body.inputType,
    ...amounts,
    notes: body.notes,
    status: body.status || "planned",
    linkedOrderIds: [],
    linkedSalesRecordIds: [],
  });

  forecast.updatedBy = actor._id;
  recalculateForecastTotals(forecast);
  await forecast.save();

  return serializeForecast(forecast);
};

const findAccountForecast = (forecast, accountForecastId) => {
  validateObjectId(accountForecastId, "accountForecastId");

  for (const item of forecast.items || []) {
    for (const channel of item.channels || []) {
      const accountForecast = (channel.accountForecasts || []).id(accountForecastId);

      if (accountForecast) {
        return { item, channel, accountForecast };
      }
    }
  }

  throw makeError("Account forecast row not found", 404);
};

const updateAccountForecast = async ({ actor, forecastId, accountForecastId, body }) => {
  validateObjectId(forecastId, "forecastId");

  const forecast = await ForecastMonth.findOne({ _id: forecastId, isActive: true });

  if (!forecast) {
    throw makeError("Forecast not found", 404);
  }

  await assertCanMutateForecast(actor, forecast);

  const { channel, accountForecast } = findAccountForecast(forecast, accountForecastId);
  const inputType = body.inputType || accountForecast.inputType;

  if (body.accountId !== undefined) {
    const account = await validateAccountForForecast({
      accountId: body.accountId,
      forecastUserId: forecast.userId,
    });
    accountForecast.accountId = account._id;
    accountForecast.accountName = account.accountName;
  }

  if (body.inputType !== undefined || body.forecastQuantity !== undefined || body.forecastValue !== undefined) {
    const amounts = calculateEntryAmounts({
      inputType,
      forecastQuantity: body.forecastQuantity !== undefined ? body.forecastQuantity : accountForecast.forecastQuantity,
      forecastValue: body.forecastValue !== undefined ? body.forecastValue : accountForecast.forecastValue,
      targetUnitValue: channel.targetUnitValue,
    });
    accountForecast.inputType = inputType;
    accountForecast.forecastQuantity = amounts.forecastQuantity;
    accountForecast.forecastValue = amounts.forecastValue;
  }

  if (body.notes !== undefined) {
    accountForecast.notes = body.notes;
  }

  if (body.status !== undefined) {
    const status = String(body.status).trim().toLowerCase();

    if (!["planned", "ordered", "sold", "missed", "cancelled"].includes(status)) {
      throw makeError("status must be planned, ordered, sold, missed, or cancelled", 400);
    }

    accountForecast.status = status;
  }

  forecast.updatedBy = actor._id;
  recalculateForecastTotals(forecast);
  await forecast.save();

  return serializeForecast(forecast);
};

const deleteAccountForecast = async ({ actor, forecastId, accountForecastId }) => {
  validateObjectId(forecastId, "forecastId");

  const forecast = await ForecastMonth.findOne({ _id: forecastId, isActive: true });

  if (!forecast) {
    throw makeError("Forecast not found", 404);
  }

  await assertCanMutateForecast(actor, forecast);

  const { accountForecast } = findAccountForecast(forecast, accountForecastId);
  accountForecast.deleteOne();

  forecast.updatedBy = actor._id;
  recalculateForecastTotals(forecast);
  await forecast.save();

  return serializeForecast(forecast);
};

const submitForecast = async ({ actor, forecastId }) => {
  validateObjectId(forecastId, "forecastId");

  const forecast = await ForecastMonth.findOne({ _id: forecastId, isActive: true });

  if (!forecast) {
    throw makeError("Forecast not found", 404);
  }

  if (!await ensureCanAccessForecast(actor, forecast)) {
    throw makeError("You are not allowed to submit this forecast", 403);
  }

  if (!isManagerRole(actor.role) && String(forecast.userId) !== String(actor._id)) {
    throw makeError("You can only submit your own forecast", 403);
  }

  if (forecast.forecastStatus === "closed" && !isManagerRole(actor.role)) {
    throw makeError("Closed forecasts can only be changed by a manager or admin", 403);
  }

  forecast.forecastStatus = "submitted";
  forecast.updatedBy = actor._id;
  await forecast.save();

  // Fire-and-forget: notify the actor's upline managers that a forecast was submitted.
  (async () => {
    const me = await User.findById(actor._id).select("_id fullName userName email path managerId").lean();
    if (!me) return;
    const name = me.fullName || me.userName || me.email || "A rep";
    const recipientIds = [...(me.path || []), me.managerId].filter(Boolean);
    await notifyUsers({
      from: me._id,
      recipientIds,
      title: `${name} submitted a forecast`,
      selfTitle: "You submitted a forecast",
      subtitle: `${MONTH_NAMES[(forecast.month || 1) - 1] || ""} ${forecast.year || ""}`.trim(),
      routeName: "ForecastTeam",
      payload: { forecastId: String(forecast._id) },
      category: "forecast",
    });
  })().catch(() => {});

  return serializeForecast(forecast);
};

const updateForecastStatus = async ({ actor, forecastId, forecastStatus }) => {
  if (!isManagerRole(actor.role)) {
    throw makeError("Only managers can update forecast status", 403);
  }

  validateObjectId(forecastId, "forecastId");

  const normalizedStatus = String(forecastStatus || "").trim().toLowerCase();

  if (!["draft", "submitted", "reviewed", "closed"].includes(normalizedStatus)) {
    throw makeError("forecastStatus must be draft, submitted, reviewed, or closed", 400);
  }

  const forecast = await ForecastMonth.findOne({ _id: forecastId, isActive: true });

  if (!forecast) {
    throw makeError("Forecast not found", 404);
  }

  if (!await ensureCanAccessForecast(actor, forecast)) {
    throw makeError("You are not allowed to update this forecast status", 403);
  }

  forecast.forecastStatus = normalizedStatus;
  forecast.updatedBy = actor._id;
  await forecast.save();

  return serializeForecast(forecast);
};

const refreshForecast = async ({ actor, year, month, userId }) => {
  const period = normalizePeriod({ year, month });

  if (userId) {
    const forecast = await buildOrRefreshMonthlyForecast({
      actor,
      userId,
      ...period,
    });

    return serializeForecast(forecast);
  }

  if (!isManagerRole(actor.role)) {
    const forecast = await buildOrRefreshMonthlyForecast({
      actor,
      userId: actor._id,
      ...period,
    });

    return serializeForecast(forecast);
  }

  const accessibleRepIds = await getAccessibleRepIds(actor);
  let repIds = accessibleRepIds;

  if (!repIds) {
    const { monthStart, nextMonthStart } = monthBounds(period.year, period.month);
    const assignmentRepIds = await TargetAssignment.find({
      year: period.year,
      status: "active",
      isActive: true,
      startDate: { $lt: nextMonthStart },
      endDate: { $gte: monthStart },
    }).distinct("userId");
    repIds = await getActiveRepIds(assignmentRepIds.map((id) => String(id)));
  }

  const refreshed = [];

  for (const repId of repIds) {
    const forecast = await buildOrRefreshMonthlyForecast({
      actor,
      userId: repId,
      ...period,
    });
    const data = serializeForecast(forecast);

    refreshed.push({
      forecastId: data._id,
      userId: data.userId,
      userName: data.userName,
      totalMonthlyTargetValue: data.totalMonthlyTargetValue,
      totalMonthlyTargetUnits: data.totalMonthlyTargetUnits,
      itemsCount: (data.items || []).length,
    });
  }

  return {
    year: period.year,
    month: period.month,
    refreshedCount: refreshed.length,
    refreshed,
  };
};

/* ── Forecast vs Sales matching ───────────────────────────── */

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

// matched: within ±2% of forecast | over: above | under: partial | missed: no sales
const matchStatusFor = (forecastAmount, actualAmount) => {
  const forecast = Number(forecastAmount) || 0;
  const actual = Number(actualAmount) || 0;

  if (actual <= 0) return "missed";
  if (forecast <= 0) return "over";

  const ratio = actual / forecast;

  if (ratio > 1.02) return "over";
  if (ratio >= 0.98) return "matched";
  return "under";
};

const pushToMap = (map, key, record) => {
  const list = map.get(key);
  if (list) list.push(record);
  else map.set(key, [record]);
};

const computeForecastSalesMatching = async (forecast) => {
  const items = forecast.items || [];
  const productIds = items.map((item) => item.productId).filter(Boolean);

  const forecastAccountIds = new Set();
  items.forEach((item) => (item.channels || []).forEach((channel) =>
    (channel.accountForecasts || []).forEach((entry) => {
      if (entry.accountId) forecastAccountIds.add(String(entry.accountId));
    })));

  const repAccounts = await Account.find({ assignedMedicalRepIds: forecast.userId }).select("_id").lean();
  const scopeAccountIds = new Set(repAccounts.map((account) => String(account._id)));
  forecastAccountIds.forEach((id) => scopeAccountIds.add(id));

  const records = productIds.length && scopeAccountIds.size
    ? await SalesRecord.find({
      year: forecast.year,
      month: forecast.month,
      isActive: true,
      status: "active",
      productId: { $in: productIds },
      accountId: { $in: Array.from(scopeAccountIds) },
    }).select("productId accountId channelId quantity uploadedSalesValue calculatedCifUsd calculatedWholesaleAed calculatedRetailAed").lean()
    : [];

  const byProductChannel = new Map();
  const byProductChannelAccount = new Map();

  records.forEach((record) => {
    const pcKey = `${String(record.productId)}:${String(record.channelId)}`;
    pushToMap(byProductChannel, pcKey, record);
    pushToMap(byProductChannelAccount, `${pcKey}:${String(record.accountId)}`, record);
  });

  const products = [];
  const accounts = [];
  const totals = { forecastUnits: 0, forecastValue: 0, salesUnits: 0, salesValue: 0 };

  items.forEach((item) => {
    let itemSalesUnits = 0;
    let itemSalesValue = 0;

    (item.channels || []).forEach((channel) => {
      const basis = channel.targetValueBasis || "cifUsd";
      const pcKey = `${String(item.productId)}:${String(channel.channelId)}`;

      (byProductChannel.get(pcKey) || []).forEach((record) => {
        itemSalesUnits += Number(record.quantity) || 0;
        itemSalesValue += salesRecordValue(record, basis);
      });

      (channel.accountForecasts || []).forEach((entry) => {
        const rows = byProductChannelAccount.get(`${pcKey}:${String(entry.accountId)}`) || [];
        const salesQuantity = round2(rows.reduce((sum, record) => sum + (Number(record.quantity) || 0), 0));
        const salesValue = round2(rows.reduce((sum, record) => sum + salesRecordValue(record, basis), 0));
        const inputType = entry.inputType === "value" ? "value" : "units";
        const forecastAmount = inputType === "value" ? entry.forecastValue : entry.forecastQuantity;
        const actualAmount = inputType === "value" ? salesValue : salesQuantity;

        accounts.push({
          accountForecastId: entry._id,
          accountId: entry.accountId,
          accountName: entry.accountName,
          productId: item.productId,
          productName: item.productName,
          productNickname: item.productNickname,
          channelId: channel.channelId,
          channelName: channel.channelName,
          inputType,
          forecastQuantity: round2(entry.forecastQuantity),
          forecastValue: round2(entry.forecastValue),
          salesQuantity,
          salesValue,
          achievementPercentage: Number(forecastAmount) > 0 ? round2((actualAmount / forecastAmount) * 100) : 0,
          matchStatus: matchStatusFor(forecastAmount, actualAmount),
          notes: entry.notes,
        });
      });
    });

    const forecastUnits = round2(item.totalItemForecastUnits);
    const forecastValue = round2(item.totalItemForecastValue);
    itemSalesUnits = round2(itemSalesUnits);
    itemSalesValue = round2(itemSalesValue);

    products.push({
      productId: item.productId,
      productName: item.productName,
      productNickname: item.productNickname,
      targetUnits: round2(item.totalItemTargetUnits),
      targetValue: round2(item.totalItemTargetValue),
      forecastUnits,
      forecastValue,
      salesUnits: itemSalesUnits,
      salesValue: itemSalesValue,
      unitsAchievementPercentage: forecastUnits > 0 ? round2((itemSalesUnits / forecastUnits) * 100) : 0,
      valueAchievementPercentage: forecastValue > 0 ? round2((itemSalesValue / forecastValue) * 100) : 0,
      matchStatus: matchStatusFor(
        forecastValue > 0 ? forecastValue : forecastUnits,
        forecastValue > 0 ? itemSalesValue : itemSalesUnits,
      ),
    });

    totals.forecastUnits += forecastUnits;
    totals.forecastValue += forecastValue;
    totals.salesUnits += itemSalesUnits;
    totals.salesValue += itemSalesValue;
  });

  const accountStatusCounts = accounts.reduce(
    (counts, row) => {
      counts[row.matchStatus] = (counts[row.matchStatus] || 0) + 1;
      return counts;
    },
    { matched: 0, over: 0, under: 0, missed: 0 },
  );

  return {
    forecastId: forecast._id,
    userId: forecast.userId,
    userName: forecast.userName,
    year: forecast.year,
    month: forecast.month,
    forecastStatus: forecast.forecastStatus,
    summary: {
      forecastUnits: round2(totals.forecastUnits),
      forecastValue: round2(totals.forecastValue),
      salesUnits: round2(totals.salesUnits),
      salesValue: round2(totals.salesValue),
      unitsAchievementPercentage: totals.forecastUnits > 0 ? round2((totals.salesUnits / totals.forecastUnits) * 100) : 0,
      valueAchievementPercentage: totals.forecastValue > 0 ? round2((totals.salesValue / totals.forecastValue) * 100) : 0,
      accountStatusCounts,
    },
    products,
    accounts,
  };
};

const getForecastSalesMatching = async ({ actor, year, month, userId }) => {
  const period = normalizePeriod({ year, month });
  let repIds;

  if (!isManagerRole(actor.role)) {
    repIds = [String(actor._id)];
  } else if (userId) {
    const rep = await loadRepForActor(actor, userId);
    repIds = [String(rep._id)];
  } else {
    const accessible = await getAccessibleRepIds(actor);

    if (accessible) {
      repIds = accessible;
    } else {
      const all = await ForecastMonth.find({
        year: period.year,
        month: period.month,
        isActive: true,
      }).distinct("userId");
      repIds = all.map((id) => String(id));
    }
  }

  const forecasts = await ForecastMonth.find({
    userId: { $in: repIds },
    year: period.year,
    month: period.month,
    isActive: true,
  }).lean();

  const reps = [];

  for (const forecast of forecasts) {
    reps.push(await computeForecastSalesMatching(forecast));
  }

  const productMap = new Map();

  reps.forEach((rep) => rep.products.forEach((product) => {
    const key = String(product.productId);
    const entry = productMap.get(key) || {
      productId: product.productId,
      productName: product.productName,
      productNickname: product.productNickname,
      forecastUnits: 0,
      forecastValue: 0,
      salesUnits: 0,
      salesValue: 0,
    };
    entry.forecastUnits += product.forecastUnits;
    entry.forecastValue += product.forecastValue;
    entry.salesUnits += product.salesUnits;
    entry.salesValue += product.salesValue;
    productMap.set(key, entry);
  }));

  const products = Array.from(productMap.values())
    .map((product) => ({
      ...product,
      forecastUnits: round2(product.forecastUnits),
      forecastValue: round2(product.forecastValue),
      salesUnits: round2(product.salesUnits),
      salesValue: round2(product.salesValue),
      unitsAchievementPercentage: product.forecastUnits > 0 ? round2((product.salesUnits / product.forecastUnits) * 100) : 0,
      valueAchievementPercentage: product.forecastValue > 0 ? round2((product.salesValue / product.forecastValue) * 100) : 0,
      matchStatus: matchStatusFor(
        product.forecastValue > 0 ? product.forecastValue : product.forecastUnits,
        product.forecastValue > 0 ? product.salesValue : product.salesUnits,
      ),
    }))
    .sort((left, right) => right.forecastValue - left.forecastValue);

  const summary = reps.reduce(
    (acc, rep) => {
      acc.forecastUnits += rep.summary.forecastUnits;
      acc.forecastValue += rep.summary.forecastValue;
      acc.salesUnits += rep.summary.salesUnits;
      acc.salesValue += rep.summary.salesValue;
      acc.accountStatusCounts.matched += rep.summary.accountStatusCounts.matched;
      acc.accountStatusCounts.over += rep.summary.accountStatusCounts.over;
      acc.accountStatusCounts.under += rep.summary.accountStatusCounts.under;
      acc.accountStatusCounts.missed += rep.summary.accountStatusCounts.missed;
      return acc;
    },
    {
      forecastUnits: 0,
      forecastValue: 0,
      salesUnits: 0,
      salesValue: 0,
      accountStatusCounts: { matched: 0, over: 0, under: 0, missed: 0 },
    },
  );

  summary.forecastUnits = round2(summary.forecastUnits);
  summary.forecastValue = round2(summary.forecastValue);
  summary.salesUnits = round2(summary.salesUnits);
  summary.salesValue = round2(summary.salesValue);
  summary.unitsAchievementPercentage = summary.forecastUnits > 0 ? round2((summary.salesUnits / summary.forecastUnits) * 100) : 0;
  summary.valueAchievementPercentage = summary.forecastValue > 0 ? round2((summary.salesValue / summary.forecastValue) * 100) : 0;

  return {
    year: period.year,
    month: period.month,
    repsCount: reps.length,
    summary,
    products,
    reps,
  };
};

module.exports = {
  addAccountForecast,
  calculateMonthlyTarget,
  deleteAccountForecast,
  getCurrentUser,
  getForecastById,
  getForecastSalesMatching,
  getMyForecast,
  refreshForecast,
  serializeForecast,
  submitForecast,
  summarizeTeamForecasts,
  updateAccountForecast,
  updateForecastStatus,
};
