const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const MedicalRepProductAssignment = require("../../models/MedicalRepProductAssignment");
const Product = require("../../models/Product");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { canAccessUser } = require("../../helpers/hierarchyAccess");

const router = express.Router();

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
  }).select("_id").lean();

  return scopedUsers.map((scopedUser) => String(scopedUser._id));
};

const ensureCanAccessRep = async (actor, medicalRepId) => {
  const rep = await User.findById(medicalRepId).select(
    "_id fullName userName email appId role status lineId territory area path",
  );

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

const assertNoOverlappingAssignment = async ({
  medicalRepId,
  productId,
  startDate,
  endDate,
  excludeId,
}) => {
  const query = {
    medicalRepId,
    productId,
    status: "active",
    isActive: true,
    startDate: { $lte: endDate || new Date("9999-12-31T00:00:00.000Z") },
    $or: [
      { endDate: null },
      { endDate: { $exists: false } },
      { endDate: { $gte: startDate } },
    ],
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existingAssignment = await MedicalRepProductAssignment.findOne(query).select("_id").lean();

  if (existingAssignment) {
    const error = new Error("This medical rep already has an active assignment for this product in the selected date range");
    error.statusCode = 409;
    throw error;
  }
};

const populateAssignment = (query) => query
  .populate("medicalRepId", "fullName userName email appId role status lineId territory area path")
  .populate("productId", "productName productNickname lineId lineName status isActive")
  .populate("assignedBy", "fullName email appId role")
  .populate("updatedBy", "fullName email appId role");

const buildListQuery = async (user, queryParams) => {
  const query = {};
  const accessibleRepIds = await getAccessibleRepIds(user);

  if (accessibleRepIds) {
    query.medicalRepId = { $in: accessibleRepIds };
  }

  if (queryParams.medicalRepId) {
    if (!isValidObjectId(queryParams.medicalRepId)) {
      const error = new Error("medicalRepId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    }

    if (accessibleRepIds && !accessibleRepIds.includes(String(queryParams.medicalRepId))) {
      query.medicalRepId = null;
    } else {
      query.medicalRepId = queryParams.medicalRepId;
    }
  }

  if (queryParams.productId) {
    if (!isValidObjectId(queryParams.productId)) {
      const error = new Error("productId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    }

    query.productId = queryParams.productId;
  }

  if (queryParams.lineId) {
    query["productSnapshot.lineId"] = String(queryParams.lineId).trim().toUpperCase();
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

  if (queryParams.isActive !== undefined) {
    query.isActive = normalizeBoolean(queryParams.isActive);
  }

  if (queryParams.activeOn) {
    const activeOn = parseDate(queryParams.activeOn, "activeOn");
    query.status = "active";
    query.isActive = true;
    query.startDate = { $lte: activeOn };
    query.$or = [
      { endDate: null },
      { endDate: { $exists: false } },
      { endDate: { $gte: activeOn } },
    ];
  }

  return query;
};

router.get("/", auth, loadActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const skip = (page - 1) * limit;
    const query = await buildListQuery(req.currentUser, req.query);

    const [assignments, total] = await Promise.all([
      populateAssignment(
        MedicalRepProductAssignment.find(query)
          .sort({ startDate: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit),
      ),
      MedicalRepProductAssignment.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignments fetched successfully",
      data: assignments,
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

router.get("/medical-reps/:medicalRepId", auth, loadActor, async (req, res, next) => {
  try {
    req.query.medicalRepId = req.params.medicalRepId;
    const query = await buildListQuery(req.currentUser, req.query);
    const assignments = await populateAssignment(
      MedicalRepProductAssignment.find(query).sort({ startDate: -1, createdAt: -1 }),
    );

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
    if (!isValidObjectId(req.params.medicalRepId)) {
      return res.status(400).json({
        success: false,
        message: "medicalRepId must be a valid MongoDB ObjectId",
      });
    }

    const rep = await ensureCanAccessRep(req.currentUser, req.params.medicalRepId);
    const endDate = parseDate(req.body.endDate, "endDate") || new Date();

    const closeQuery = {
      medicalRepId: rep._id,
      status: "active",
      isActive: true,
      startDate: { $lte: endDate },
      $or: [
        { endDate: null },
        { endDate: { $exists: false } },
        { endDate: { $gte: endDate } },
      ],
    };

    if (req.body.productId !== undefined) {
      if (!isValidObjectId(req.body.productId)) {
        return res.status(400).json({
          success: false,
          message: "productId must be a valid MongoDB ObjectId",
        });
      }

      closeQuery.productId = req.body.productId;
    }

    const result = await MedicalRepProductAssignment.updateMany(
      closeQuery,
      {
        $set: {
          endDate,
          updatedBy: req.currentUser._id,
        },
      },
    );

    const assignments = await populateAssignment(
      MedicalRepProductAssignment.find({
        medicalRepId: rep._id,
        updatedBy: req.currentUser._id,
        endDate,
      }).sort({ updatedAt: -1 }),
    );

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignments closed successfully",
      data: {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        assignments,
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
        message: "Assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await populateAssignment(MedicalRepProductAssignment.findById(req.params.id));

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Medical rep product assignment not found",
      });
    }

    if (!await canAccessUser(req.currentUser, assignment.medicalRepId)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to view this assignment",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignment fetched successfully",
      data: assignment,
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

    for (const productId of productIds) {
      await assertNoOverlappingAssignment({
        medicalRepId: rep._id,
        productId,
        startDate,
        endDate,
      });
    }

    const assignmentsToCreate = productIds.map((productId) => {
      const product = productsById.get(productId);

      return {
      medicalRepId: rep._id,
      medicalRepSnapshot: buildRepSnapshot(rep),
      productId: product._id,
      productSnapshot: buildProductSnapshot(product),
      startDate,
      endDate,
      status: "active",
      isActive: true,
      notes: req.body.notes,
      assignedBy: req.currentUser._id,
      updatedBy: req.currentUser._id,
      };
    });

    const assignments = await MedicalRepProductAssignment.insertMany(assignmentsToCreate);
    const populatedAssignments = await populateAssignment(
      MedicalRepProductAssignment.find({ _id: { $in: assignments.map((assignment) => assignment._id) } })
        .sort({ createdAt: -1 }),
    );

    return res.status(201).json({
      success: true,
      message: "Medical rep product assignments created successfully",
      data: {
        assignments: populatedAssignments,
        createdCount: populatedAssignments.length,
      },
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
        message: "Assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await MedicalRepProductAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Medical rep product assignment not found",
      });
    }

    await ensureCanAccessRep(req.currentUser, assignment.medicalRepId);

    const update = {};

    if (req.body.startDate !== undefined) {
      update.startDate = parseDate(req.body.startDate, "startDate");
    }

    if (req.body.endDate !== undefined) {
      update.endDate = parseDate(req.body.endDate, "endDate");
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
      await assertNoOverlappingAssignment({
        medicalRepId: assignment.medicalRepId,
        productId: assignment.productId,
        startDate: nextStartDate,
        endDate: nextEndDate,
        excludeId: assignment._id,
      });
    }

    Object.assign(assignment, update, {
      updatedBy: req.currentUser._id,
    });
    await assignment.save();

    const populatedAssignment = await populateAssignment(MedicalRepProductAssignment.findById(assignment._id));

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignment updated successfully",
      data: populatedAssignment,
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
        message: "Assignment id must be a valid MongoDB ObjectId",
      });
    }

    const assignment = await MedicalRepProductAssignment.findById(req.params.id);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Medical rep product assignment not found",
      });
    }

    await ensureCanAccessRep(req.currentUser, assignment.medicalRepId);

    assignment.status = "inactive";
    assignment.isActive = false;
    assignment.endDate = assignment.endDate || new Date();
    assignment.updatedBy = req.currentUser._id;
    await assignment.save();

    const populatedAssignment = await populateAssignment(MedicalRepProductAssignment.findById(assignment._id));

    return res.status(200).json({
      success: true,
      message: "Medical rep product assignment deactivated successfully",
      data: populatedAssignment,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
