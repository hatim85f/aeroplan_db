const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");

const router = express.Router();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeTextKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/\s+/g, " ");

const normalizePhoneKey = (value) => String(value || "").replace(/[^\d+]/g, "");

const normalizeGoogleMapsLinkKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/\/+$/, "");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const exactTextRegex = (value) => new RegExp(`^${escapeRegex(String(value || "").trim())}$`, "i");

const exactMapLinkRegex = (value) => new RegExp(
  `^${escapeRegex(String(value || "").trim().replace(/\/+$/, ""))}/?$`,
  "i",
);

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

  if (update.accountName !== undefined) {
    update.accountNameKey = normalizeTextKey(update.accountName);
  }
  if (update.phoneNumber !== undefined) {
    const phoneNumberKey = normalizePhoneKey(update.phoneNumber);
    update.phoneNumberKey = phoneNumberKey || undefined;
  }
  if (update.location?.googleMapsLink !== undefined) {
    const googleMapsLinkKey = normalizeGoogleMapsLinkKey(update.location.googleMapsLink);
    update.googleMapsLinkKey = googleMapsLinkKey || undefined;
  }
  if (update.location?.address !== undefined) {
    const addressKey = normalizeTextKey(update.location.address);
    update.addressKey = addressKey || undefined;
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

const buildDuplicateAccountQuery = (payload) => {
  const checks = [];

  if (payload.googleMapsLinkKey) {
    checks.push({
      query: {
        $or: [
          { googleMapsLinkKey: payload.googleMapsLinkKey },
          { "location.googleMapsLink": exactMapLinkRegex(payload.location?.googleMapsLink || payload.googleMapsLinkKey) },
        ],
      },
      matchType: "googleMapsLink",
    });
  }

  if (payload.accountNameKey && payload.phoneNumberKey) {
    checks.push({
      query: {
        $or: [
          {
            accountNameKey: payload.accountNameKey,
            phoneNumberKey: payload.phoneNumberKey,
          },
          {
            accountName: exactTextRegex(payload.accountName || payload.accountNameKey),
            phoneNumber: exactTextRegex(payload.phoneNumber || payload.phoneNumberKey),
          },
        ],
      },
      matchType: "accountNamePhoneNumber",
    });
  }

  if (payload.accountNameKey && payload.addressKey) {
    checks.push({
      query: {
        $or: [
          {
            accountNameKey: payload.accountNameKey,
            addressKey: payload.addressKey,
          },
          {
            accountName: exactTextRegex(payload.accountName || payload.accountNameKey),
            "location.address": exactTextRegex(payload.location?.address || payload.addressKey),
          },
        ],
      },
      matchType: "accountNameAddress",
    });
  }

  return checks;
};

const findDuplicateAccount = async (payload, excludeAccountId) => {
  const checks = buildDuplicateAccountQuery(payload);

  for (const check of checks) {
    let query = check.query;

    if (excludeAccountId) {
      query = {
        $and: [
          { _id: { $ne: excludeAccountId } },
          query,
        ],
      };
    }

    const account = await Account.findOne(query).select("+googleMapsLinkKey +accountNameKey +phoneNumberKey +addressKey");

    if (account) {
      return { account, matchType: check.matchType };
    }
  }

  return null;
};

const rejectDuplicateAccount = (res, duplicate) => res.status(409).json({
  success: false,
  message: "Account already exists",
  data: {
    duplicateAccountId: duplicate.account._id,
    matchedOn: duplicate.matchType,
  },
});

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

    const duplicateAccount = await findDuplicateAccount(payload);

    if (duplicateAccount) {
      return rejectDuplicateAccount(res, duplicateAccount);
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

    const existingAccount = await Account.findById(req.params.id)
      .select("+googleMapsLinkKey +accountNameKey +phoneNumberKey +addressKey");

    if (!existingAccount) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const mergedAccount = {
      accountNameKey: update.accountNameKey !== undefined ? update.accountNameKey : existingAccount.accountNameKey,
      phoneNumberKey: update.phoneNumberKey !== undefined ? update.phoneNumberKey : existingAccount.phoneNumberKey,
      googleMapsLinkKey: update.googleMapsLinkKey !== undefined ? update.googleMapsLinkKey : existingAccount.googleMapsLinkKey,
      addressKey: update.addressKey !== undefined ? update.addressKey : existingAccount.addressKey,
    };
    const duplicateAccount = await findDuplicateAccount(mergedAccount, req.params.id);

    if (duplicateAccount) {
      return rejectDuplicateAccount(res, duplicateAccount);
    }

    const account = await populateAccount(Account.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true },
    ));

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

    const duplicateAccount = await findDuplicateAccount(payload, req.params.id);

    if (duplicateAccount) {
      return rejectDuplicateAccount(res, duplicateAccount);
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
