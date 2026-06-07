const express = require("express");
const mongoose = require("mongoose");

const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const AccountRepAssignment = require("../../models/AccountRepAssignment");
const User = require("../../models/User");
const forecastService = require("../../services/forecastService");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const loadActor = async (req, res, next) => {
  try {
    req.currentUser = await forecastService.getCurrentUser(req.user.id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const requireManager = (req, res, next) => {
  if (!isManagerRole(req.currentUser?.role)) {
    return res.status(403).json({ success: false, message: "Only managers can manage rep coverage" });
  }
  return next();
};

const parseDateValue = (value, fieldName, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      const error = new Error(`${fieldName} is required`);
      error.statusCode = 400;
      throw error;
    }
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date (YYYY-MM-DD)`);
    error.statusCode = 400;
    throw error;
  }

  return date;
};

// List assignments (filters: accountId, userId)
router.get("/", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const query = { isActive: true };

    if (req.query.accountId && isValidObjectId(req.query.accountId)) {
      query.accountId = req.query.accountId;
    }

    if (req.query.userId && isValidObjectId(req.query.userId)) {
      query.userId = req.query.userId;
    }

    const assignments = await AccountRepAssignment.find(query)
      .sort({ startDate: -1, accountName: 1 })
      .limit(1000)
      .lean();

    return res.status(200).json({
      success: true,
      message: "Rep coverage assignments fetched successfully",
      data: assignments,
    });
  } catch (error) {
    return next(error);
  }
});

// All representative users in the manager's scope, INCLUDING inactive ones —
// historical coverage must reference reps who have since left.
router.get("/reps", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const query = { role: "representative" };

    if (req.currentUser.role !== "admin") {
      query.$or = [{ _id: req.currentUser._id }, { path: req.currentUser._id }];
    }

    const reps = await User.find(query)
      .select("_id fullName userName email status isActive")
      .sort({ fullName: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Reps fetched successfully",
      data: reps,
    });
  } catch (error) {
    return next(error);
  }
});

// Bulk create: accountIds × userIds for a date range
router.post("/", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    const accountIds = Array.isArray(req.body.accountIds) ? req.body.accountIds.filter(isValidObjectId) : [];
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.filter(isValidObjectId) : [];

    if (!accountIds.length) {
      return res.status(400).json({ success: false, message: "accountIds must contain at least one valid account" });
    }

    if (!userIds.length) {
      return res.status(400).json({ success: false, message: "userIds must contain at least one valid medical rep" });
    }

    const startDate = parseDateValue(req.body.startDate, "startDate", { required: true });
    const endDate = parseDateValue(req.body.endDate, "endDate");

    if (endDate && endDate < startDate) {
      return res.status(400).json({ success: false, message: "endDate cannot be before startDate" });
    }

    const [accounts, users] = await Promise.all([
      Account.find({ _id: { $in: accountIds } }).select("_id accountName").lean(),
      User.find({ _id: { $in: userIds }, role: "representative" }).select("_id fullName userName email").lean(),
    ]);

    if (!users.length) {
      return res.status(400).json({ success: false, message: "userIds must belong to representative users" });
    }

    const docs = [];

    accounts.forEach((account) => {
      users.forEach((user) => {
        docs.push({
          accountId: account._id,
          accountName: account.accountName,
          userId: user._id,
          userName: user.fullName || user.userName || user.email,
          startDate,
          endDate,
          notes: req.body.notes,
          createdBy: req.currentUser._id,
          updatedBy: req.currentUser._id,
        });
      });
    });

    const created = await AccountRepAssignment.insertMany(docs);

    return res.status(201).json({
      success: true,
      message: `Created ${created.length} rep coverage assignment${created.length === 1 ? "" : "s"}`,
      data: created,
    });
  } catch (error) {
    return next(error);
  }
});

// Update dates/notes (e.g. close an open assignment)
router.patch("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "id must be a valid MongoDB ObjectId" });
    }

    const assignment = await AccountRepAssignment.findOne({ _id: req.params.id, isActive: true });

    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    if (req.body.startDate !== undefined) {
      assignment.startDate = parseDateValue(req.body.startDate, "startDate", { required: true });
    }

    if (req.body.endDate !== undefined) {
      assignment.endDate = parseDateValue(req.body.endDate, "endDate");
    }

    if (assignment.endDate && assignment.endDate < assignment.startDate) {
      return res.status(400).json({ success: false, message: "endDate cannot be before startDate" });
    }

    if (req.body.notes !== undefined) {
      assignment.notes = req.body.notes;
    }

    assignment.updatedBy = req.currentUser._id;
    await assignment.save();

    return res.status(200).json({
      success: true,
      message: "Assignment updated successfully",
      data: assignment,
    });
  } catch (error) {
    return next(error);
  }
});

// Soft delete
router.delete("/:id", auth, loadActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "id must be a valid MongoDB ObjectId" });
    }

    const assignment = await AccountRepAssignment.findOneAndUpdate(
      { _id: req.params.id, isActive: true },
      { isActive: false, updatedBy: req.currentUser._id },
      { new: true },
    );

    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Assignment removed successfully",
      data: assignment,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
