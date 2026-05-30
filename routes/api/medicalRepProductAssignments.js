const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Product = require("../../models/Product");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { canAccessUser } = require("../../helpers/hierarchyAccess");

const router = express.Router();

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
      message: "Only managers can manage medical rep product assignments",
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

const ensureCanAccessRep = async (actor, medicalRepId) => {
  const rep = await User.findById(medicalRepId);

  if (!rep) {
    const error = new Error("Medical rep not found");
    error.statusCode = 404;
    throw error;
  }

  if (rep.role !== "representative") {
    const error = new Error("medicalRepId must belong to a representative user");
    error.statusCode = 400;
    throw error;
  }

  if (!canAccessUser(actor, rep)) {
    const error = new Error("You are not allowed to manage this medical rep");
    error.statusCode = 403;
    throw error;
  }

  return rep;
};

const buildRepSnapshot = (rep) => ({
  fullName: rep.fullName,
  userName: rep.userName,
  email: rep.email,
  appId: rep.appId,
  lineId: rep.lineId,
  territory: rep.territory,
  area: rep.area,
});

const buildProductSnapshot = (product) => ({
  productName: product.productName,
  productNickname: product.productNickname,
  lineId: product.lineId,
  lineName: product.lineName,
});

const normalizeProductIds = (body = {}) => {
  const rawProductIds = [];

  if (body.productId !== undefined) {
    rawProductIds.push(body.productId);
  }

  if (Array.isArray(body.productIds)) {
    rawProductIds.push(...body.productIds);
  }

  if (Array.isArray(body.products)) {
    rawProductIds.push(...body.products.map((product) => (
      typeof product === "object" && product !== null ? product.productId || product._id : product
    )));
  }

  const productIds = [...new Set(rawProductIds.map((productId) => String(productId || "").trim()).filter(Boolean))];

  if (productIds.length === 0) {
    const error = new Error("productIds must contain at least one product id");
    error.statusCode = 400;
    throw error;
  }

  const invalidProductId = productIds.find((productId) => !isValidObjectId(productId));

  if (invalidProductId) {
    const error = new Error(`Invalid productId: ${invalidProductId}`);
    error.statusCode = 400;
    throw error;
  }

  return productIds;
};

const normalizeAccountabilityPercentage = (value, fieldName = "accountabilityPercentage") => {
  if (value === undefined || value === null || value === "") {
    return 100;
  }

  const percentage = Number(value);

  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    const error = new Error(`${fieldName} must be a number between 0 and 100`);
    error.statusCode = 400;
    throw error;
  }

  return percentage;
};

const getProductAccountabilityPercentage = (body = {}, productId) => {
  if (Array.isArray(body.products)) {
    const matchingProduct = body.products.find((product) => {
      const currentProductId = typeof product === "object" && product !== null
        ? product.productId || product._id
        : product;

      return String(currentProductId) === String(productId);
    });

    if (matchingProduct && typeof matchingProduct === "object") {
      return normalizeAccountabilityPercentage(
        matchingProduct.accountabilityPercentage ?? matchingProduct.percentage,
        `products.${productId}.accountabilityPercentage`,
      );
    }
  }

  return normalizeAccountabilityPercentage(
    body.accountabilityPercentage ?? body.percentage,
  );
};

const validateDateRange = (startDate, endDate) => {
  if (!startDate) {
    const error = new Error("startDate is required");
    error.statusCode = 400;
    throw error;
  }

  if (endDate && endDate < startDate) {
    const error = new Error("endDate must be greater than or equal to startDate");
    error.statusCode = 400;
    throw error;
  }
};

const getUtcYearRange = (yearValue) => {
  const year = Number(yearValue);

  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    const error = new Error("year must be a valid four digit year");
    error.statusCode = 400;
    throw error;
  }

  return {
    yearStart: new Date(Date.UTC(year, 0, 1)),
    nextYearStart: new Date(Date.UTC(year + 1, 0, 1)),
  };
};

const assignmentOverlapsRange = (assignment, rangeStart, rangeEnd) => {
  const assignmentStart = assignment.startDate || new Date(0);
  const assignmentEnd = assignment.endDate || FAR_FUTURE;

  return assignmentStart < rangeEnd && assignmentEnd >= rangeStart;
};

const assignmentMatchesFilters = (assignment, queryParams = {}) => {
  if (queryParams.productId && String(assignment.productId) !== String(queryParams.productId)) {
    return false;
  }

  if (queryParams.lineId) {
    const lineId = String(queryParams.lineId).trim().toUpperCase();

    if (String(assignment.productSnapshot?.lineId || "").toUpperCase() !== lineId) {
      return false;
    }
  }

  if (queryParams.status) {
    const status = String(queryParams.status).trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
      const error = new Error("status must be active or inactive");
      error.statusCode = 400;
      throw error;
    }

    if (assignment.status !== status) {
      return false;
    }
  }

  if (queryParams.isActive !== undefined && assignment.isActive !== normalizeBoolean(queryParams.isActive)) {
    return false;
  }

  if (queryParams.year) {
    const { yearStart, nextYearStart } = getUtcYearRange(queryParams.year);
    return assignmentOverlapsRange(assignment, yearStart, nextYearStart);
  }

  if (queryParams.activeOn) {
    const activeOn = parseDate(queryParams.activeOn, "activeOn");
    const nextDay = new Date(activeOn);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    return assignment.status === "active"
      && assignment.isActive
      && assignmentOverlapsRange(assignment, activeOn, nextDay);
  }

  return true;
};

const hasOverlappingAssignment = ({ rep, productId, startDate, endDate, excludeAssignmentId }) => {
  const rangeEnd = endDate || FAR_FUTURE;

  return (rep.assignedProducts || []).some((assignment) => {
    if (excludeAssignmentId && String(assignment._id) === String(excludeAssignmentId)) {
      return false;
    }

    return String(assignment.productId) === String(productId)
      && assignment.status === "active"
      && assignment.isActive
      && assignmentOverlapsRange(assignment, startDate, rangeEnd);
  });
};

const serializeAssignment = (rep, assignment) => ({
  _id: assignment._id,
  medicalRepId: {
    _id: rep._id,
    ...buildRepSnapshot(rep),
    role: rep.role,
    status: rep.status,
  },
  medicalRepSnapshot: buildRepSnapshot(rep),
  productId: {
    _id: assignment.productId,
    ...(assignment.productSnapshot || {}),
  },
  productSnapshot: assignment.productSnapshot || {},
  startDate: assignment.startDate,
  endDate: assignment.endDate,
  accountabilityPercentage: assignment.accountabilityPercentage ?? 100,
  status: assignment.status,
  isActive: assignment.isActive,
  notes: assignment.notes,
  assignedBy: assignment.assignedBy,
  updatedBy: assignment.updatedBy,
  assignedAt: assignment.assignedAt,
  createdAt: assignment.createdAt,
  updatedAt: assignment.updatedAt,
});

const getFilteredAssignmentsForRep = (rep, queryParams) => (rep.assignedProducts || [])
  .filter((assignment) => assignmentMatchesFilters(assignment, queryParams))
  .sort((left, right) => {
    const rightDate = right.startDate ? right.startDate.getTime() : 0;
    const leftDate = left.startDate ? left.startDate.getTime() : 0;

    return rightDate - leftDate;
  })
  .map((assignment) => serializeAssignment(rep, assignment));

const buildRepQuery = async (user, queryParams = {}) => {
  const query = {
    role: "representative",
    "assignedProducts.0": { $exists: true },
  };
  const accessibleRepIds = await getAccessibleRepIds(user);

  if (accessibleRepIds) {
    query._id = { $in: accessibleRepIds };
  }

  if (queryParams.medicalRepId) {
    if (!isValidObjectId(queryParams.medicalRepId)) {
      const error = new Error("medicalRepId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    }

    if (accessibleRepIds && !accessibleRepIds.includes(String(queryParams.medicalRepId))) {
      query._id = null;
    } else {
      query._id = queryParams.medicalRepId;
    }
  }

  return query;
};

const addProductsToManager = async (rep, productIds) => {
  const managerId = rep.managerId;

  if (!managerId || productIds.length === 0) {
    return;
  }

  await User.updateOne(
    { _id: managerId },
    { $addToSet: { assignedProductIds: { $each: productIds } } },
  );
};

const syncAssignedProductIds = (rep) => {
  rep.assignedProductIds = [
    ...new Set((rep.assignedProducts || []).map((assignment) => String(assignment.productId))),
  ];
};

router.get("/", auth, loadActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const skip = (page - 1) * limit;
    const repQuery = await buildRepQuery(req.currentUser, req.query);
    const reps = await User.find(repQuery).sort({ fullName: 1 });
    const allAssignments = reps.flatMap((rep) => getFilteredAssignmentsForRep(rep, req.query));
    const pagedAssignments = allAssignments.slice(skip, skip + limit);

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignments fetched successfully",
      data: pagedAssignments,
      pagination: {
        page,
        limit,
        total: allAssignments.length,
        pages: Math.ceil(allAssignments.length / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/medical-reps/:medicalRepId", auth, loadActor, async (req, res, next) => {
  try {
    const rep = await ensureCanAccessRep(req.currentUser, req.params.medicalRepId);
    const assignments = getFilteredAssignmentsForRep(rep, req.query);

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignments fetched successfully",
      data: assignments,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/medical-reps/:medicalRepId/close", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const rep = await ensureCanAccessRep(req.currentUser, req.params.medicalRepId);
    const endDate = parseDate(req.body.endDate, "endDate") || new Date();
    const updatedAssignments = [];

    (rep.assignedProducts || []).forEach((assignment) => {
      if (req.body.productId !== undefined && String(assignment.productId) !== String(req.body.productId)) {
        return;
      }

      if (
        assignment.status === "active"
        && assignment.isActive
        && assignmentOverlapsRange(assignment, new Date(0), new Date(endDate.getTime() + 1))
      ) {
        assignment.endDate = endDate;
        assignment.updatedBy = req.currentUser._id;
        updatedAssignments.push(assignment);
      }
    });

    await rep.save();

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignments closed successfully",
      data: {
        matchedCount: updatedAssignments.length,
        modifiedCount: updatedAssignments.length,
        assignments: updatedAssignments.map((assignment) => serializeAssignment(rep, assignment)),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadActor, async (req, res, next) => {
  try {
    const rep = await User.findOne({ "assignedProducts._id": req.params.id });

    if (!rep) {
      return res.status(404).json({
        success: false,
        message: "Medical rep product assignment not found",
      });
    }

    if (!canAccessUser(req.currentUser, rep)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to view this assignment",
      });
    }

    const assignment = rep.assignedProducts.id(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignment fetched successfully",
      data: serializeAssignment(rep, assignment),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!req.body.medicalRepId || !isValidObjectId(req.body.medicalRepId)) {
      return res.status(400).json({
        success: false,
        message: "medicalRepId must be a valid MongoDB ObjectId",
      });
    }

    const productIds = normalizeProductIds(req.body);
    const startDate = parseDate(req.body.startDate, "startDate");
    const endDate = parseDate(req.body.endDate, "endDate");
    validateDateRange(startDate, endDate);

    const [rep, products] = await Promise.all([
      ensureCanAccessRep(req.currentUser, req.body.medicalRepId),
      Product.find({
        _id: { $in: productIds },
        status: "active",
        isActive: true,
      }).lean(),
    ]);

    const productsById = new Map(products.map((product) => [String(product._id), product]));
    const missingProductId = productIds.find((productId) => !productsById.has(productId));

    if (missingProductId) {
      return res.status(404).json({
        success: false,
        message: `Active product not found: ${missingProductId}`,
      });
    }

    const createdAssignments = [];
    const skippedProductIds = [];

    productIds.forEach((productId) => {
      const product = productsById.get(productId);

      if (hasOverlappingAssignment({ rep, productId, startDate, endDate })) {
        skippedProductIds.push(productId);
        return;
      }

      rep.assignedProducts.push({
        productId: product._id,
        productSnapshot: buildProductSnapshot(product),
        startDate,
        endDate,
        accountabilityPercentage: getProductAccountabilityPercentage(req.body, productId),
        status: "active",
        isActive: true,
        notes: req.body.notes,
        assignedBy: req.currentUser._id,
        updatedBy: req.currentUser._id,
        assignedAt: new Date(),
      });
      createdAssignments.push(rep.assignedProducts[rep.assignedProducts.length - 1]);
    });

    syncAssignedProductIds(rep);
    await rep.save();
    await addProductsToManager(rep, productIds);

    return res.status(201).json({
      success: true,
      message: "Medical rep product assignments saved successfully",
      data: {
        assignments: createdAssignments.map((assignment) => serializeAssignment(rep, assignment)),
        createdCount: createdAssignments.length,
        skippedProductIds,
        skippedCount: skippedProductIds.length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const rep = await User.findOne({ "assignedProducts._id": req.params.id });

    if (!rep) {
      return res.status(404).json({
        success: false,
        message: "Medical rep product assignment not found",
      });
    }

    await ensureCanAccessRep(req.currentUser, rep._id);

    const assignment = rep.assignedProducts.id(req.params.id);
    const update = {};

    if (req.body.startDate !== undefined) {
      update.startDate = parseDate(req.body.startDate, "startDate");
    }

    if (req.body.endDate !== undefined) {
      update.endDate = parseDate(req.body.endDate, "endDate");
    }

    if (req.body.accountabilityPercentage !== undefined || req.body.percentage !== undefined) {
      update.accountabilityPercentage = normalizeAccountabilityPercentage(
        req.body.accountabilityPercentage ?? req.body.percentage,
      );
    }

    if (req.body.notes !== undefined) {
      update.notes = req.body.notes;
    }

    if (req.body.status !== undefined) {
      const status = String(req.body.status).trim().toLowerCase();

      if (!["active", "inactive"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "status must be active or inactive",
        });
      }

      update.status = status;
      update.isActive = status === "active";
    } else if (req.body.isActive !== undefined) {
      update.isActive = normalizeBoolean(req.body.isActive);
      update.status = update.isActive ? "active" : "inactive";
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update assignment",
      });
    }

    const nextStartDate = update.startDate || assignment.startDate;
    const nextEndDate = update.endDate !== undefined ? update.endDate : assignment.endDate;
    validateDateRange(nextStartDate, nextEndDate);

    if ((update.status || assignment.status) === "active" && (update.isActive ?? assignment.isActive)) {
      if (hasOverlappingAssignment({
        rep,
        productId: assignment.productId,
        startDate: nextStartDate,
        endDate: nextEndDate,
        excludeAssignmentId: assignment._id,
      })) {
        return res.status(409).json({
          success: false,
          message: "This medical rep already has an active assignment for this product in the selected date range",
        });
      }
    }

    Object.assign(assignment, update, {
      updatedBy: req.currentUser._id,
    });
    syncAssignedProductIds(rep);
    await rep.save();

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignment updated successfully",
      data: serializeAssignment(rep, assignment),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const rep = await User.findOne({ "assignedProducts._id": req.params.id });

    if (!rep) {
      return res.status(404).json({
        success: false,
        message: "Medical rep product assignment not found",
      });
    }

    await ensureCanAccessRep(req.currentUser, rep._id);

    const assignment = rep.assignedProducts.id(req.params.id);
    assignment.status = "inactive";
    assignment.isActive = false;
    assignment.endDate = assignment.endDate || new Date();
    assignment.updatedBy = req.currentUser._id;
    syncAssignedProductIds(rep);
    await rep.save();

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignment deactivated successfully",
      data: serializeAssignment(rep, assignment),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
