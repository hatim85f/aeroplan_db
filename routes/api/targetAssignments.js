const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const TargetAssignment = require("../../models/TargetAssignment");
const TargetPhasing = require("../../models/TargetPhasing");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { canAccessUser } = require("../../helpers/hierarchyAccess");

const router = express.Router();

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FAR_FUTURE = new Date("9999-12-31T00:00:00.000Z");

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
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

const addOneDay = (date) => {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate;
};

const normalizeYear = (value) => {
  const year = Number(value);

  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    const error = new Error("year must be a valid four digit year");
    error.statusCode = 400;
    throw error;
  }

  return year;
};

const normalizeNumber = (value, fieldName) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`${fieldName} must be a number greater than or equal to 0`);
    error.statusCode = 400;
    throw error;
  }

  return number;
};

const validateObjectId = (value, fieldName) => {
  if (!value || !isValidObjectId(value)) {
    const error = new Error(`${fieldName} must be a valid MongoDB ObjectId`);
    error.statusCode = 400;
    throw error;
  }

  return value;
};

const validateDateRange = (startDate, endDate) => {
  if (!startDate) {
    const error = new Error("startDate is required");
    error.statusCode = 400;
    throw error;
  }

  if (!endDate) {
    const error = new Error("endDate is required");
    error.statusCode = 400;
    throw error;
  }

  if (endDate < startDate) {
    const error = new Error("endDate must be greater than or equal to startDate");
    error.statusCode = 400;
    throw error;
  }
};

const getDefaultTargetCurrency = (targetValueBasis) => (
  targetValueBasis === "cifUsd" ? "USD" : "AED"
);

const getMedicalRepTargetStatus = (rep) => (
  rep?.status === "active" ? "active" : "inactive"
);

const getCurrentUser = async (req) => User.findById(req.user.id);

const loadActor = async (req, res, next) => {
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
      message: "Only managers can manage target assignments",
    });
  }

  return next();
};

const getAccessibleRepIds = async (user) => {
  if (user.role === "admin") {
    return null;
  }

  const userId = String(user._id);

  if (!isManagerRole(user.role)) {
    return [userId];
  }

  const scopedUsers = await User.find({
    $or: [
      { _id: user._id },
      { path: user._id },
    ],
    role: "representative",
  }).select("_id").lean();

  return scopedUsers.map((scopedUser) => String(scopedUser._id));
};

const loadRepresentative = async (actor, userId) => {
  const user = await User.findById(userId).select(
    "_id fullName userName email role status managerId teamId lineId path",
  );

  if (!user) {
    const error = new Error("Medical rep not found");
    error.statusCode = 404;
    throw error;
  }

  if (user.role !== "representative") {
    const error = new Error("userId must belong to a representative user");
    error.statusCode = 400;
    throw error;
  }

  if (!canAccessUser(actor, user)) {
    const error = new Error("You are not allowed to manage this medical rep");
    error.statusCode = 403;
    throw error;
  }

  return user;
};

const findChannelPricing = (product, channelId) => (product.channelPricing || []).find(
  (pricing) => String(pricing.channelId) === String(channelId),
);

const buildAssignmentPayload = async ({ actor, body, existingAssignment }) => {
  const userId = body.userId !== undefined
    ? validateObjectId(body.userId, "userId")
    : existingAssignment?.userId;
  const productId = body.productId !== undefined
    ? validateObjectId(body.productId, "productId")
    : existingAssignment?.productId;
  const channelId = body.channelId !== undefined
    ? validateObjectId(body.channelId, "channelId")
    : existingAssignment?.channelId;
  const startDate = body.startDate !== undefined
    ? parseDate(body.startDate, "startDate")
    : existingAssignment?.startDate;
  const endDate = body.endDate !== undefined
    ? parseDate(body.endDate, "endDate")
    : existingAssignment?.endDate;
  const year = body.year !== undefined
    ? normalizeYear(body.year)
    : existingAssignment?.year;

  if (!userId) {
    validateObjectId(userId, "userId");
  }

  if (!productId) {
    validateObjectId(productId, "productId");
  }

  if (!channelId) {
    validateObjectId(channelId, "channelId");
  }

  if (!year) {
    normalizeYear(year);
  }

  validateDateRange(startDate, endDate);

  const [rep, product, channel] = await Promise.all([
    loadRepresentative(actor, userId),
    Product.findById(productId).lean(),
    SalesChannel.findById(channelId).lean(),
  ]);

  if (!product) {
    const error = new Error("Product not found");
    error.statusCode = 404;
    throw error;
  }

  if (!channel) {
    const error = new Error("Sales channel not found");
    error.statusCode = 404;
    throw error;
  }

  const channelPricing = findChannelPricing(product, channel._id);

  if (!channelPricing) {
    const error = new Error("Product does not have pricing for the selected sales channel");
    error.statusCode = 400;
    throw error;
  }

  const targetValueBasis = channelPricing.targetValueBasis || "cifUsd";
  const targetCurrency = channelPricing.targetCurrency || getDefaultTargetCurrency(targetValueBasis);
  const payload = {
    userId: rep._id,
    userName: rep.fullName || rep.userName || rep.email,
    medicalRepStatus: getMedicalRepTargetStatus(rep),
    medicalRepIsActive: rep.status === "active",
    managerId: rep.managerId,
    teamId: rep.teamId,
    lineId: product.lineId,
    lineName: product.lineName,
    productId: product._id,
    productName: product.productName,
    productNickname: product.productNickname,
    channelId: channel._id,
    channelName: channel.channelName,
    channelKey: channel.channelKey,
    year,
    startDate,
    endDate,
    targetValueBasis,
    targetCurrency,
  };

  if (body.totalTargetUnits !== undefined || !existingAssignment) {
    payload.totalTargetUnits = normalizeNumber(body.totalTargetUnits, "totalTargetUnits");
  }

  if (body.totalTargetValue !== undefined || !existingAssignment) {
    payload.totalTargetValue = normalizeNumber(body.totalTargetValue, "totalTargetValue");
  }

  if (body.notes !== undefined) {
    payload.notes = body.notes;
  }

  return payload;
};

const assertNoOverlap = async ({ payload, excludeId }) => {
  const query = {
    userId: payload.userId,
    productId: payload.productId,
    channelId: payload.channelId,
    status: "active",
    isActive: true,
    startDate: { $lte: payload.endDate },
    endDate: { $gte: payload.startDate },
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existingAssignment = await TargetAssignment.findOne(query).select("_id").lean();

  if (existingAssignment) {
    const error = new Error("An active target assignment already exists for this rep, product, channel, and date range");
    error.statusCode = 409;
    throw error;
  }
};

const populateAssignment = (query) => query
  .populate("userId", "fullName userName email appId role status teamId managerId lineId")
  .populate("managerId", "fullName email appId role")
  .populate("teamId", "teamName teamCode lineId lineName")
  .populate("productId", "productName productNickname lineId lineName")
  .populate("channelId", "channelName channelKey")
  .populate("createdBy", "fullName email appId role")
  .populate("updatedBy", "fullName email appId role");

const serializeTargetAssignment = (assignment) => {
  const data = typeof assignment.toObject === "function" ? assignment.toObject() : { ...assignment };
  const currentRepStatus = getMedicalRepTargetStatus(data.userId);
  const storedRepStatus = data.medicalRepStatus || "active";
  const medicalRepStatus = data.userId?.status ? currentRepStatus : storedRepStatus;

  return {
    ...data,
    medicalRepStatus,
    medicalRepIsActive: medicalRepStatus === "active",
  };
};

const serializeTargetAssignments = (assignments) => assignments.map(serializeTargetAssignment);

const buildAssignmentQuery = async (user, queryParams = {}) => {
  const query = {};
  const accessibleRepIds = await getAccessibleRepIds(user);

  if (accessibleRepIds) {
    query.userId = { $in: accessibleRepIds };
  }

  if (queryParams.userId) {
    validateObjectId(queryParams.userId, "userId");

    if (accessibleRepIds && !accessibleRepIds.includes(String(queryParams.userId))) {
      query.userId = null;
    } else {
      query.userId = queryParams.userId;
    }
  }

  if (queryParams.managerId) {
    validateObjectId(queryParams.managerId, "managerId");
    query.managerId = queryParams.managerId;
  }

  if (queryParams.teamId) {
    validateObjectId(queryParams.teamId, "teamId");
    query.teamId = queryParams.teamId;
  }

  if (queryParams.productId) {
    validateObjectId(queryParams.productId, "productId");
    query.productId = queryParams.productId;
  }

  if (queryParams.channelId) {
    validateObjectId(queryParams.channelId, "channelId");
    query.channelId = queryParams.channelId;
  }

  if (queryParams.lineId) {
    query.lineId = String(queryParams.lineId).trim().toUpperCase();
  }

  if (queryParams.year) {
    query.year = normalizeYear(queryParams.year);
  }

  if (queryParams.status) {
    const status = String(queryParams.status).trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
      const error = new Error("status must be active or inactive");
      error.statusCode = 400;
      throw error;
    }

    query.status = status;
  }

  if (queryParams.dateFrom || queryParams.dateTo) {
    const dateFrom = queryParams.dateFrom ? parseDate(queryParams.dateFrom, "dateFrom") : new Date(0);
    const dateTo = queryParams.dateTo ? parseDate(queryParams.dateTo, "dateTo") : FAR_FUTURE;

    query.startDate = { $lte: dateTo };
    query.endDate = { $gte: dateFrom };
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { userName: { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
      { productNickname: { $regex: search, $options: "i" } },
      { channelName: { $regex: search, $options: "i" } },
      { notes: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};

const ensureCanAccessAssignment = async (actor, assignment) => {
  if (!assignment) {
    return false;
  }

  const repId = assignment.userId?._id || assignment.userId;

  if (actor.role === "admin") {
    return true;
  }

  if (String(repId) === String(actor._id)) {
    return true;
  }

  if (!isManagerRole(actor.role)) {
    return false;
  }

  const rep = assignment.userId?.path !== undefined
    ? assignment.userId
    : await User.findById(repId).select("_id path role");

  return canAccessUser(actor, rep);
};

const createAssignment = async ({ actor, body }) => {
  const payload = await buildAssignmentPayload({ actor, body });
  await assertNoOverlap({ payload });

  return TargetAssignment.create({
    ...payload,
    status: "active",
    isActive: true,
    createdBy: actor._id,
    updatedBy: actor._id,
  });
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
    const phasing = await TargetPhasing.findOne(query).sort({ createdAt: -1 });

    if (phasing) {
      return phasing;
    }
  }

  return null;
};

const monthOverlapsAssignment = (assignment, month) => {
  const monthStart = new Date(Date.UTC(assignment.year, month - 1, 1));
  const nextMonthStart = new Date(Date.UTC(assignment.year, month, 1));

  return monthStart < addOneDay(assignment.endDate) && nextMonthStart > assignment.startDate;
};

const buildMonthlyBreakdown = (assignment, phasing) => {
  const months = (phasing.months || [])
    .filter((entry) => monthOverlapsAssignment(assignment, entry.month))
    .sort((left, right) => left.month - right.month)
    .map((entry) => ({
      month: entry.month,
      monthName: entry.monthName || MONTH_NAMES[entry.month - 1],
      percentage: entry.percentage,
      targetUnits: (assignment.totalTargetUnits * entry.percentage) / 100,
      targetValue: (assignment.totalTargetValue * entry.percentage) / 100,
    }));

  return {
    targetAssignmentId: assignment._id,
    medicalRepStatus: assignment.medicalRepStatus || "active",
    medicalRepIsActive: (assignment.medicalRepStatus || "active") === "active",
    phasingId: phasing._id,
    phasingName: phasing.name,
    period: {
      startDate: assignment.startDate,
      endDate: assignment.endDate,
    },
    totalTargetUnits: assignment.totalTargetUnits,
    totalTargetValue: assignment.totalTargetValue,
    currency: assignment.targetCurrency,
    targetValueBasis: assignment.targetValueBasis,
    months,
  };
};

const addToGroup = (groups, key, label, assignment) => {
  if (!key) {
    return;
  }

  if (!groups[key]) {
    groups[key] = {
      id: key,
      name: label,
      totalTargetUnits: 0,
      totalTargetValue: 0,
      assignmentsCount: 0,
    };
  }

  groups[key].totalTargetUnits += assignment.totalTargetUnits || 0;
  groups[key].totalTargetValue += assignment.totalTargetValue || 0;
  groups[key].assignmentsCount += 1;
};

const getUtcYearBounds = (yearValue) => {
  const year = normalizeYear(yearValue);

  return {
    year,
    yearStart: new Date(Date.UTC(year, 0, 1)),
    yearEnd: new Date(Date.UTC(year, 11, 31)),
    nextYearStart: new Date(Date.UTC(year + 1, 0, 1)),
  };
};

const maxDate = (left, right) => (left > right ? left : right);
const minDate = (left, right) => (left < right ? left : right);

const assignmentOverlapsYear = (assignment, yearStart, nextYearStart) => {
  const assignmentEnd = assignment.endDate || FAR_FUTURE;

  return assignment.status === "active"
    && assignment.isActive
    && assignment.startDate < nextYearStart
    && assignmentEnd >= yearStart;
};

const normalizeChannelTargets = (body = {}) => {
  const source = body.channelTargets || body.targets || body.channels;

  if (!Array.isArray(source) || source.length === 0) {
    const error = new Error("channelTargets must be a non-empty array");
    error.statusCode = 400;
    throw error;
  }

  return source.map((target, index) => {
    const channelId = target.channelId || target.salesChannelId;

    return {
      channelId: validateObjectId(channelId, `channelTargets.${index}.channelId`),
      totalTargetUnits: normalizeNumber(
        target.totalTargetUnits ?? target.targetUnits ?? target.units,
        `channelTargets.${index}.units`,
      ),
      notes: target.notes,
    };
  });
};

const normalizeAccountabilityPercentage = (value) => {
  if (value === undefined || value === null || value === "") {
    return 100;
  }

  const percentage = Number(value);

  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return 100;
  }

  return percentage;
};

const buildDerivedTargetPayload = ({ actor, rep, product, channelPricing, channel, assignment, year, yearStart, yearEnd, units, notes }) => {
  const startDate = maxDate(assignment.startDate, yearStart);
  const endDate = minDate(assignment.endDate || yearEnd, yearEnd);
  const accountabilityPercentage = normalizeAccountabilityPercentage(assignment.accountabilityPercentage);
  const assignedUnits = (units * accountabilityPercentage) / 100;
  const targetValueBasis = channelPricing.targetValueBasis || "cifUsd";
  const targetCurrency = channelPricing.targetCurrency || getDefaultTargetCurrency(targetValueBasis);
  const unitValue = Number(channelPricing[targetValueBasis]) || 0;

  return {
    userId: rep._id,
    userName: rep.fullName || rep.userName || rep.email,
    medicalRepStatus: getMedicalRepTargetStatus(rep),
    medicalRepIsActive: rep.status === "active",
    managerId: rep.managerId,
    teamId: rep.teamId,
    lineId: product.lineId,
    lineName: product.lineName,
    productId: product._id,
    productName: product.productName,
    productNickname: product.productNickname,
    channelId: channel._id,
    channelName: channel.channelName,
    channelKey: channel.channelKey,
    year,
    startDate,
    endDate,
    accountabilityPercentage,
    totalTargetUnits: assignedUnits,
    totalTargetValue: assignedUnits * unitValue,
    targetValueBasis,
    targetCurrency,
    notes,
    updatedBy: actor._id,
  };
};

const upsertDerivedTarget = async (payload, actor) => {
  const existing = await TargetAssignment.findOne({
    userId: payload.userId,
    productId: payload.productId,
    channelId: payload.channelId,
    year: payload.year,
    startDate: payload.startDate,
    endDate: payload.endDate,
  });

  if (existing) {
    Object.assign(existing, payload, {
      status: "active",
      isActive: true,
    });
    await existing.save();

    return { assignment: existing, action: "updated" };
  }

  await assertNoOverlap({ payload });

  const assignment = await TargetAssignment.create({
    ...payload,
    status: "active",
    isActive: true,
    createdBy: actor._id,
    updatedBy: actor._id,
  });

  return { assignment, action: "created" };
};

const isProductAssignmentTargetPayload = (body = {}) => (
  !body.userId
    && (Array.isArray(body.channelTargets) || Array.isArray(body.channels))
    && (body.productId || body.itemId)
);

const createTargetsFromProductAssignments = async (req, res, next) => {
  try {
    const productId = validateObjectId(req.body.productId || req.body.itemId, "productId");
    const { year, yearStart, yearEnd, nextYearStart } = getUtcYearBounds(req.body.year);
    const channelTargets = normalizeChannelTargets(req.body);

    const [product, channels, reps] = await Promise.all([
      Product.findOne({
        _id: productId,
        status: "active",
        isActive: true,
      }).lean(),
      SalesChannel.find({
        _id: { $in: channelTargets.map((target) => target.channelId) },
        status: "active",
        isActive: true,
      }).lean(),
      User.find({
        role: "representative",
        "assignedProducts.productId": productId,
      }),
    ]);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Active product not found",
      });
    }

    const accessibleRepIds = await getAccessibleRepIds(req.currentUser);
    const channelsById = new Map(channels.map((channel) => [String(channel._id), channel]));
    const pricingByChannelId = new Map((product.channelPricing || []).map((pricing) => [String(pricing.channelId), pricing]));
    const createdIds = [];
    const updatedIds = [];
    const failed = [];

    for (const rep of reps) {
      if (accessibleRepIds && !accessibleRepIds.includes(String(rep._id))) {
        continue;
      }

      const matchingAssignments = (rep.assignedProducts || []).filter((assignment) => (
        String(assignment.productId) === productId
          && assignmentOverlapsYear(assignment, yearStart, nextYearStart)
      ));

      for (const productAssignment of matchingAssignments) {
        for (const channelTarget of channelTargets) {
          try {
            const channel = channelsById.get(String(channelTarget.channelId));
            const channelPricing = pricingByChannelId.get(String(channelTarget.channelId));

            if (!channel) {
              throw new Error(`Active sales channel not found: ${channelTarget.channelId}`);
            }

            if (!channelPricing || channelPricing.isAvailable === false) {
              throw new Error(`Product does not have active pricing for channel: ${channelTarget.channelId}`);
            }

            const payload = buildDerivedTargetPayload({
              actor: req.currentUser,
              rep,
              product,
              channelPricing,
              channel,
              assignment: productAssignment,
              year,
              yearStart,
              yearEnd,
              units: channelTarget.totalTargetUnits,
              notes: channelTarget.notes ?? req.body.notes,
            });
            const result = await upsertDerivedTarget(payload, req.currentUser);

            if (result.action === "created") {
              createdIds.push(result.assignment._id);
            } else {
              updatedIds.push(result.assignment._id);
            }
          } catch (error) {
            failed.push({
              medicalRepId: rep._id,
              productAssignmentId: productAssignment._id,
              channelId: channelTarget.channelId,
              reason: error.message || "Could not save derived target",
            });
          }
        }
      }
    }

    const savedIds = [...createdIds, ...updatedIds];
    const assignments = savedIds.length
      ? await populateAssignment(TargetAssignment.find({ _id: { $in: savedIds } }).sort({ userName: 1, channelName: 1 }))
      : [];

    return res.status(201).json({
      success: failed.length === 0,
      message: "Product target assignments processed successfully",
      data: {
        productId,
        year,
        createdCount: createdIds.length,
        updatedCount: updatedIds.length,
        failedCount: failed.length,
        assignments: serializeTargetAssignments(assignments),
        failed,
      },
    });
  } catch (error) {
    return next(error);
  }
};

router.post("/", auth, loadActor, requireManager, async (req, res, next) => {
  if (isProductAssignmentTargetPayload(req.body)) {
    return createTargetsFromProductAssignments(req, res, next);
  }

  try {
    const assignment = await createAssignment({
      actor: req.currentUser,
      body: req.body,
    });
    const populatedAssignment = await populateAssignment(TargetAssignment.findById(assignment._id));

    return res.status(201).json({
      success: true,
      message: "Target assignment created successfully",
      data: serializeTargetAssignment(populatedAssignment),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/from-product-assignments", auth, loadActor, requireManager, createTargetsFromProductAssignments);

router.post("/bulk", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const targets = Array.isArray(req.body) ? req.body : req.body.targets;

    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        success: false,
        message: "targets must be a non-empty array",
      });
    }

    const created = [];
    const failed = [];

    for (const [index, targetInput] of targets.entries()) {
      try {
        const assignment = await createAssignment({
          actor: req.currentUser,
          body: targetInput || {},
        });

        created.push(assignment);
      } catch (error) {
        failed.push({
          index,
          target: targetInput,
          reason: error.message || "Invalid target assignment",
        });
      }
    }

    const createdIds = created.map((assignment) => assignment._id);
    const createdAssignments = createdIds.length
      ? await populateAssignment(TargetAssignment.find({ _id: { $in: createdIds } }).sort({ createdAt: -1 }))
      : [];

    return res.status(201).json({
      success: true,
      message: "Bulk target assignment import completed",
      data: {
        total: targets.length,
        createdCount: createdAssignments.length,
        failedCount: failed.length,
        created: serializeTargetAssignments(createdAssignments),
        failed,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/overview", auth, loadActor, async (req, res, next) => {
  try {
    const query = await buildAssignmentQuery(req.currentUser, req.query);

    const assignments = await TargetAssignment.find(query).lean();
    const targetByRep = {};
    const targetByProduct = {};
    const targetByChannel = {};
    const overview = {
      totalTargetUnits: 0,
      totalTargetValue: 0,
      activeAssignmentsCount: 0,
      inactiveAssignmentsCount: 0,
    };

    assignments.forEach((assignment) => {
      overview.totalTargetUnits += assignment.totalTargetUnits || 0;
      overview.totalTargetValue += assignment.totalTargetValue || 0;

      if (assignment.status === "active" && assignment.isActive !== false) {
        overview.activeAssignmentsCount += 1;
      } else {
        overview.inactiveAssignmentsCount += 1;
      }

      addToGroup(targetByRep, String(assignment.userId), assignment.userName, assignment);
      addToGroup(targetByProduct, String(assignment.productId), assignment.productName, assignment);
      addToGroup(targetByChannel, String(assignment.channelId), assignment.channelName, assignment);
    });

    return res.status(200).json({
      success: true,
      message: "Target assignment overview fetched successfully",
      data: {
        ...overview,
        targetByRep: Object.values(targetByRep),
        targetByProduct: Object.values(targetByProduct),
        targetByChannel: Object.values(targetByChannel),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/monthly-breakdown", auth, loadActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await TargetAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Target assignment not found",
      });
    }

    if (!await ensureCanAccessAssignment(req.currentUser, assignment)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to view this target assignment",
      });
    }

    let phasing;

    if (req.query.phasingId) {
      validateObjectId(req.query.phasingId, "phasingId");
      phasing = await TargetPhasing.findOne({
        _id: req.query.phasingId,
        status: "active",
        isActive: true,
      });
    } else {
      phasing = await findDefaultPhasing(assignment);
    }

    if (!phasing) {
      return res.status(404).json({
        success: false,
        message: "Target phasing not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Monthly target breakdown calculated successfully",
      data: buildMonthlyBreakdown(assignment, phasing),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = await buildAssignmentQuery(req.currentUser, req.query);

    const [assignments, total] = await Promise.all([
      populateAssignment(
        TargetAssignment.find(query)
          .sort({ startDate: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit),
      ),
      TargetAssignment.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Target assignments fetched successfully",
      data: serializeTargetAssignments(assignments),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await populateAssignment(TargetAssignment.findById(req.params.id));

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Target assignment not found",
      });
    }

    if (!await ensureCanAccessAssignment(req.currentUser, assignment)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to view this target assignment",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Target assignment fetched successfully",
      data: serializeTargetAssignment(assignment),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await TargetAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Target assignment not found",
      });
    }

    if (!await ensureCanAccessAssignment(req.currentUser, assignment)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this target assignment",
      });
    }

    const payload = await buildAssignmentPayload({
      actor: req.currentUser,
      body: req.body,
      existingAssignment: assignment,
    });

    if (req.body.status !== undefined) {
      const status = String(req.body.status).trim().toLowerCase();

      if (!["active", "inactive"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "status must be active or inactive",
        });
      }

      payload.status = status;
      payload.isActive = status === "active";
    } else if (req.body.isActive !== undefined) {
      payload.isActive = normalizeBoolean(req.body.isActive);
      payload.status = payload.isActive ? "active" : "inactive";
    }

    if ((payload.status || assignment.status) === "active" && (payload.isActive ?? assignment.isActive)) {
      await assertNoOverlap({
        payload,
        excludeId: assignment._id,
      });
    }

    Object.assign(assignment, payload, {
      updatedBy: req.currentUser._id,
    });
    await assignment.save();

    const populatedAssignment = await populateAssignment(TargetAssignment.findById(assignment._id));

    return res.status(200).json({
      success: true,
      message: "Target assignment updated successfully",
      data: serializeTargetAssignment(populatedAssignment),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target assignment id must be a valid MongoDB ObjectId",
      });
    }

    if (req.body.status === undefined && req.body.isActive === undefined) {
      return res.status(400).json({
        success: false,
        message: "status or isActive is required",
      });
    }

    const status = req.body.status !== undefined
      ? String(req.body.status).trim().toLowerCase()
      : normalizeBoolean(req.body.isActive)
        ? "active"
        : "inactive";

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive",
      });
    }

    const assignment = await TargetAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Target assignment not found",
      });
    }

    if (!await ensureCanAccessAssignment(req.currentUser, assignment)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this target assignment",
      });
    }

    assignment.status = status;
    assignment.isActive = status === "active";
    assignment.updatedBy = req.currentUser._id;
    await assignment.save();

    const populatedAssignment = await populateAssignment(TargetAssignment.findById(assignment._id));

    return res.status(200).json({
      success: true,
      message: "Target assignment status updated successfully",
      data: serializeTargetAssignment(populatedAssignment),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Target assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await TargetAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Target assignment not found",
      });
    }

    if (!await ensureCanAccessAssignment(req.currentUser, assignment)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this target assignment",
      });
    }

    assignment.status = "inactive";
    assignment.isActive = false;
    assignment.updatedBy = req.currentUser._id;
    await assignment.save();

    const populatedAssignment = await populateAssignment(TargetAssignment.findById(assignment._id));

    return res.status(200).json({
      success: true,
      message: "Target assignment deactivated successfully",
      data: serializeTargetAssignment(populatedAssignment),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
