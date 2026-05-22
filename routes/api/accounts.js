const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");

const router = express.Router();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeAssignedRepIds = (body) => {
  if (body.assignedMedicalRepIds !== undefined) {
    return Array.isArray(body.assignedMedicalRepIds)
      ? [...new Set(body.assignedMedicalRepIds)]
      : body.assignedMedicalRepIds;
  }

  const singleRepId = body.assignedMedicalRepId || body.userId;

  if (singleRepId !== undefined) {
    return [singleRepId];
  }

  return undefined;
};

const normalizeLocation = (body) => {
  if (body.location === undefined && body.googleMapsLink === undefined) {
    return undefined;
  }

  const location = body.location && typeof body.location === "object"
    ? { ...body.location }
    : {};

  if (body.googleMapsLink !== undefined) {
    location.googleMapsLink = body.googleMapsLink;
  }

  return location;
};

const normalizeAccountPayload = (body) => {
  const update = {};
  const simpleFields = ["accountName", "keyContact", "phoneNumber"];

  simpleFields.forEach((field) => {
    if (body[field] !== undefined) {
      update[field] = body[field];
    }
  });

  const location = normalizeLocation(body);
  if (location !== undefined) {
    update.location = location || {};
  }

  const assignedMedicalRepIds = normalizeAssignedRepIds(body);
  if (assignedMedicalRepIds !== undefined) {
    update.assignedMedicalRepIds = assignedMedicalRepIds;
  }

  if (body.lastPlannedVisit !== undefined) {
    update.lastPlannedVisit = body.lastPlannedVisit || {};
  }

  return update;
};

const validateAssignedRepIds = (repIds) => {
  if (repIds === undefined) {
    return true;
  }

  return Array.isArray(repIds) && repIds.every((repId) => isValidObjectId(repId));
};

const populateAccount = (query) => query.populate(
  "assignedMedicalRepIds",
  "fullName email phone appId role status territory area lineId",
);

router.get("/", auth, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = {};

    if (req.query.search) {
      const search = String(req.query.search).trim();
      query.$or = [
        { accountName: { $regex: search, $options: "i" } },
        { keyContact: { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
        { "location.address": { $regex: search, $options: "i" } },
        { "location.googleMapsLink": { $regex: search, $options: "i" } },
      ];
    }

    if (req.query.repId) {
      if (!isValidObjectId(req.query.repId)) {
        return res.status(400).json({
          success: false,
          message: "repId must be a valid MongoDB ObjectId",
        });
      }
      query.assignedMedicalRepIds = req.query.repId;
    }

    const [accounts, total] = await Promise.all([
      populateAccount(Account.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit)),
      Account.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Accounts fetched successfully",
      data: accounts,
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

router.get("/my-visits", auth, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = { assignedMedicalRepIds: req.user.id };

    const [accounts, total] = await Promise.all([
      populateAccount(Account.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit)),
      Account.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Selected visit accounts fetched successfully",
      data: accounts,
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

router.get("/:id", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Account id must be a valid MongoDB ObjectId",
      });
    }

    const account = await populateAccount(Account.findById(req.params.id));

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account fetched successfully",
      data: account,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/select-for-visit", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Account id must be a valid MongoDB ObjectId",
      });
    }

    const account = await populateAccount(Account.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { assignedMedicalRepIds: req.user.id } },
      { new: true, runValidators: true },
    ));

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account selected for visit successfully",
      data: account,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/unselect-for-visit", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Account id must be a valid MongoDB ObjectId",
      });
    }

    const account = await populateAccount(Account.findByIdAndUpdate(
      req.params.id,
      { $pull: { assignedMedicalRepIds: req.user.id } },
      { new: true, runValidators: true },
    ));

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account removed from selected visits successfully",
      data: account,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", auth, async (req, res, next) => {
  try {
    const payload = normalizeAccountPayload(req.body);

    if (!payload.accountName) {
      return res.status(400).json({
        success: false,
        message: "accountName is required",
      });
    }

    if (!validateAssignedRepIds(payload.assignedMedicalRepIds)) {
      return res.status(400).json({
        success: false,
        message: "assignedMedicalRepIds must be an array of valid MongoDB ObjectIds",
      });
    }

    const account = await Account.create({
      ...payload,
      createdBy: req.user.id,
    });
    const populatedAccount = await populateAccount(Account.findById(account._id));

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      data: populatedAccount,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Account id must be a valid MongoDB ObjectId",
      });
    }

    const update = normalizeAccountPayload(req.body);

    if (!validateAssignedRepIds(update.assignedMedicalRepIds)) {
      return res.status(400).json({
        success: false,
        message: "assignedMedicalRepIds must be an array of valid MongoDB ObjectIds",
      });
    }

    const account = await populateAccount(Account.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true },
    ));

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account updated successfully",
      data: account,
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/:id", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Account id must be a valid MongoDB ObjectId",
      });
    }

    const payload = normalizeAccountPayload(req.body);

    if (!payload.accountName) {
      return res.status(400).json({
        success: false,
        message: "accountName is required",
      });
    }

    if (!validateAssignedRepIds(payload.assignedMedicalRepIds)) {
      return res.status(400).json({
        success: false,
        message: "assignedMedicalRepIds must be an array of valid MongoDB ObjectIds",
      });
    }

    const account = await populateAccount(Account.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true },
    ));

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account updated successfully",
      data: account,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
