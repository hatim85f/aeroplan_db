const mongoose = require("mongoose");

const Account = require("../models/Account");
const ForecastMonth = require("../models/ForecastMonth");
const TargetAssignment = require("../models/TargetAssignment");
const TargetPhasing = require("../models/TargetPhasing");
const User = require("../models/User");
const { canAccessUser } = require("../helpers/hierarchyAccess");
const { isManagerRole } = require("../helpers/roles");

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

  const reps = await User.find({
    $or: [
      { _id: actor._id },
      { path: actor._id },
    ],
    role: "representative",
  }).select("_id").lean();

  return reps.map((rep) => String(rep._id));
};

const loadRepForActor = async (actor, userId) => {
  validateObjectId(userId, "userId");

  const rep = await User.findById(userId).select("_id fullName userName email role status managerId teamId lineId path").lean();

  if (!rep) {
    throw makeError("Medical rep not found", 404);
  }

  if (rep.role !== "representative") {
    throw makeError("userId must belong to a representative user", 400);
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

const findDefaultPhasing = async (assignment) => {
  const base = {
    year: assignment.year,
    status: "active",
    isActive: true,
    isDefault: true,
  };

  const withScope = (scope = {}) => {
    const query = { ...base };

    Object.entries(scope).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        query[key] = value;
      }
    });

    return query;
  };

  const scopeQueries = [
    withScope({
      teamId: assignment.teamId,
      lineId: assignment.lineId,
      productId: assignment.productId,
      channelId: assignment.channelId,
    }),
    withScope({
      lineId: assignment.lineId,
      productId: assignment.productId,
      channelId: assignment.channelId,
    }),
    withScope({
      teamId: assignment.teamId,
      lineId: assignment.lineId,
    }),
    withScope({
      lineId: assignment.lineId,
    }),
    base,
  ];

  for (const query of scopeQueries) {
    const phasing = await TargetPhasing.findOne(query).sort({ createdAt: -1 }).lean();

    if (phasing) {
      return phasing;
    }
  }

  return null;
};

const calculateMonthlyTarget = async (assignment, month) => {
  const phasing = await findDefaultPhasing(assignment);

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
  const assignments = await TargetAssignment.find({
    userId: rep._id,
    year,
    status: "active",
    isActive: true,
    startDate: { $lt: nextMonthStart },
    endDate: { $gte: monthStart },
  }).sort({ productName: 1, channelName: 1 }).lean();
  const preservedAccountForecasts = getPreservedAccountForecasts(existingForecast);
  const itemsByProductId = new Map();

  for (const assignment of assignments) {
    const monthlyTarget = await calculateMonthlyTarget(assignment, month);
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
  const period = normalizePeriod({ year, month });
  const forecast = await buildOrRefreshMonthlyForecast({
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
    const rep = await loadRepForActor(actor, userId);
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
    repIds = assignments.map((id) => String(id));
  }

  const forecasts = [];

  for (const repId of repIds) {
    const forecast = await buildOrRefreshMonthlyForecast({
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
  const targetUserId = userId || actor._id;

  const forecast = await buildOrRefreshMonthlyForecast({
    actor,
    userId: targetUserId,
    ...period,
  });

  return serializeForecast(forecast);
};

module.exports = {
  addAccountForecast,
  deleteAccountForecast,
  getCurrentUser,
  getForecastById,
  getMyForecast,
  refreshForecast,
  serializeForecast,
  submitForecast,
  summarizeTeamForecasts,
  updateAccountForecast,
  updateForecastStatus,
};
