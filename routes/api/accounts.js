const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const SalesTeamMember = require("../../models/SalesTeamMember");

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

const normalizeSalesTeamIds = (body) => {
  if (body.salesTeamIds === undefined) {
    return undefined;
  }

  return Array.isArray(body.salesTeamIds)
    ? [...new Set(body.salesTeamIds)]
    : body.salesTeamIds;
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
  const simpleFields = [
    "accountName",
    "accountType",
    "keyContact",
    "contactPersonEmail",
    "phoneNumber",
    "area",
    "territory",
  ];

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

  const salesTeamIds = normalizeSalesTeamIds(body);
  if (salesTeamIds !== undefined) {
    update.salesTeamIds = salesTeamIds;
  }

  if (body.lastPlannedVisit !== undefined) {
    update.lastPlannedVisit = body.lastPlannedVisit || {};
  }

  if (update.accountName !== undefined) {
    update.accountNameKey = normalizeTextKey(update.accountName);
  }
  if (update.accountType !== undefined) {
    update.accountType = normalizeTextKey(update.accountType);
  }
  if (update.contactPersonEmail !== undefined) {
    update.contactPersonEmail = normalizeTextKey(update.contactPersonEmail);
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

const validateSalesTeamIdsShape = (salesTeamIds) => {
  if (salesTeamIds === undefined) {
    return true;
  }

  return Array.isArray(salesTeamIds) && salesTeamIds.every((salesTeamId) => isValidObjectId(salesTeamId));
};

const validateActiveSalesTeamIds = async (salesTeamIds) => {
  if (salesTeamIds === undefined) {
    return null;
  }

  if (!validateSalesTeamIdsShape(salesTeamIds)) {
    return "salesTeamIds must be an array of valid MongoDB ObjectIds";
  }

  if (salesTeamIds.length === 0) {
    return null;
  }

  const uniqueSalesTeamIds = getUniqueObjectIds(salesTeamIds);
  const members = await SalesTeamMember.find({
    _id: { $in: uniqueSalesTeamIds },
    status: "active",
    isActive: true,
  }).select("_id").lean();
  const foundMemberIds = new Set(members.map((member) => String(member._id)));
  const missingMemberId = uniqueSalesTeamIds.find((salesTeamId) => !foundMemberIds.has(salesTeamId));

  if (missingMemberId) {
    return `Active sales team member not found: ${missingMemberId}`;
  }

  return null;
};

const validateCreateAccountPayload = (payload) => {
  if (!payload.accountName) {
    return "accountName is required";
  }

  if (!payload.accountType) {
    return "accountType is required";
  }

  if (!validateAssignedRepIds(payload.assignedMedicalRepIds)) {
    return "assignedMedicalRepIds must be an array of valid MongoDB ObjectIds";
  }

  if (!validateSalesTeamIdsShape(payload.salesTeamIds)) {
    return "salesTeamIds must be an array of valid MongoDB ObjectIds";
  }

  return null;
};

const populateAccount = (query) => query
  .populate(
    "assignedMedicalRepIds",
    "fullName email phone appId role status territory area lineId",
  )
  .populate(
    "salesTeamIds",
    "fullName email phone position status isActive managerId",
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

const buildBatchDuplicateKeys = (payload) => {
  const keys = [];

  if (payload.googleMapsLinkKey) {
    keys.push(`googleMapsLink:${payload.googleMapsLinkKey}`);
  }
  if (payload.accountNameKey && payload.phoneNumberKey) {
    keys.push(`accountNamePhoneNumber:${payload.accountNameKey}:${payload.phoneNumberKey}`);
  }
  if (payload.accountNameKey && payload.addressKey) {
    keys.push(`accountNameAddress:${payload.accountNameKey}:${payload.addressKey}`);
  }

  return keys;
};

const formatImportFailure = ({ index, account, reason, duplicate }) => {
  const failure = {
    index,
    accountName: account?.accountName,
    reason,
  };

  if (duplicate) {
    failure.duplicateAccountId = duplicate.account ? duplicate.account._id : undefined;
    failure.matchedOn = duplicate.matchType;
  }

  return failure;
};

const getUniqueObjectIds = (ids) => [...new Set(ids.map((id) => String(id).trim()))];

const validateBulkAssignmentPayload = ({ accountIds, medicalRepId }) => {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return "accountIds must be a non-empty array";
  }

  if (accountIds.length > 200) {
    return "accountIds cannot contain more than 200 accounts";
  }

  if (!medicalRepId || !isValidObjectId(medicalRepId)) {
    return "medicalRepId must be a valid MongoDB ObjectId";
  }

  if (!accountIds.every((accountId) => isValidObjectId(accountId))) {
    return "Every accountId must be a valid MongoDB ObjectId";
  }

  return null;
};

const assignMedicalRepToAccounts = async ({ accountIds, medicalRepId }) => {
  const uniqueAccountIds = getUniqueObjectIds(accountIds);

  await Account.updateMany(
    { _id: { $in: uniqueAccountIds } },
    { $addToSet: { assignedMedicalRepIds: medicalRepId } },
    { runValidators: true },
  );

  const updatedAccounts = await populateAccount(
    Account.find({ _id: { $in: uniqueAccountIds } }).sort({ accountName: 1 }),
  );
  const updatedAccountIds = updatedAccounts.map((account) => String(account._id));
  const updatedAccountIdSet = new Set(updatedAccountIds);

  return {
    updatedAccounts,
    updatedAccountIds,
    failed: uniqueAccountIds
      .filter((accountId) => !updatedAccountIdSet.has(accountId))
      .map((accountId) => ({
        accountId,
        reason: "Account not found",
      })),
  };
};

const syncAccountSalesTeamLinks = async (accountId, salesTeamIds) => {
  if (salesTeamIds === undefined) {
    return;
  }

  const accountIdString = String(accountId);
  const uniqueSalesTeamIds = getUniqueObjectIds(salesTeamIds);

  await SalesTeamMember.updateMany(
    {
      accountIds: accountIdString,
      _id: { $nin: uniqueSalesTeamIds },
    },
    { $pull: { accountIds: accountIdString } },
  );

  if (uniqueSalesTeamIds.length > 0) {
    await SalesTeamMember.updateMany(
      { _id: { $in: uniqueSalesTeamIds } },
      { $addToSet: { accountIds: accountIdString } },
    );
  }
};

router.get("/", auth, async (req, res, next) => {
  try {
    const shouldPaginate = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = shouldPaginate ? (page - 1) * limit : 0;
    const query = {};

    if (req.query.search) {
      const search = String(req.query.search).trim();
      query.$or = [
        { accountName: { $regex: search, $options: "i" } },
        { keyContact: { $regex: search, $options: "i" } },
        { contactPersonEmail: { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
        { area: { $regex: search, $options: "i" } },
        { territory: { $regex: search, $options: "i" } },
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

    if (req.query.area) {
      query.area = { $regex: String(req.query.area).trim(), $options: "i" };
    }

    if (req.query.territory) {
      query.territory = { $regex: String(req.query.territory).trim(), $options: "i" };
    }

    const accountsQuery = Account.find(query)
      .collation({ locale: "en", strength: 2 })
      .sort({ accountName: 1 });

    if (shouldPaginate) {
      accountsQuery.skip(skip).limit(limit);
    }

    const [accounts, total] = await Promise.all([
      populateAccount(accountsQuery),
      Account.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Accounts fetched successfully",
      data: accounts,
      pagination: {
        page,
        limit: shouldPaginate ? limit : total,
        total,
        pages: shouldPaginate ? Math.ceil(total / limit) : 1,
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
      populateAccount(
        Account.find(query)
          .collation({ locale: "en", strength: 2 })
          .sort({ accountName: 1 })
          .skip(skip)
          .limit(limit),
      ),
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

router.patch("/assign-rep-bulk", auth, async (req, res, next) => {
  try {
    const medicalRepId = req.body.medicalRepId || req.user.id;
    const validationError = validateBulkAssignmentPayload({
      accountIds: req.body.accountIds,
      medicalRepId,
    });

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const result = await assignMedicalRepToAccounts({
      accountIds: req.body.accountIds,
      medicalRepId,
    });

    return res.status(200).json({
      success: true,
      message: "Medical rep assigned to accounts successfully",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/bulk", auth, async (req, res, next) => {
  try {
    const medicalRepId = req.body.update?.addAssignedMedicalRepId;
    const validationError = validateBulkAssignmentPayload({
      accountIds: req.body.accountIds,
      medicalRepId,
    });

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const result = await assignMedicalRepToAccounts({
      accountIds: req.body.accountIds,
      medicalRepId,
    });

    return res.status(200).json({
      success: true,
      message: "Bulk account update completed successfully",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/bulk", auth, async (req, res, next) => {
  try {
    const accountsInput = Array.isArray(req.body) ? req.body : req.body.accounts;

    if (!Array.isArray(accountsInput) || accountsInput.length === 0) {
      return res.status(400).json({
        success: false,
        message: "accounts must be a non-empty array",
      });
    }

    if (accountsInput.length > 500) {
      return res.status(400).json({
        success: false,
        message: "accounts cannot contain more than 500 rows",
      });
    }

    const created = [];
    const failed = [];
    const batchKeys = new Set();

    for (const [index, accountInput] of accountsInput.entries()) {
      const payload = normalizeAccountPayload(accountInput || {});
      const validationError = validateCreateAccountPayload(payload);

      if (validationError) {
        failed.push(formatImportFailure({
          index,
          account: accountInput,
          reason: validationError,
        }));
        continue;
      }

      const salesTeamValidationError = await validateActiveSalesTeamIds(payload.salesTeamIds);

      if (salesTeamValidationError) {
        failed.push(formatImportFailure({
          index,
          account: accountInput,
          reason: salesTeamValidationError,
        }));
        continue;
      }

      const duplicateKey = buildBatchDuplicateKeys(payload).find((key) => batchKeys.has(key));

      if (duplicateKey) {
        failed.push(formatImportFailure({
          index,
          account: accountInput,
          reason: "Duplicate row in upload",
          duplicate: { matchType: duplicateKey.split(":")[0] },
        }));
        continue;
      }

      const duplicateAccount = await findDuplicateAccount(payload);

      if (duplicateAccount) {
        failed.push(formatImportFailure({
          index,
          account: accountInput,
          reason: "Account already exists",
          duplicate: duplicateAccount,
        }));
        continue;
      }

      const account = await Account.create({
        ...payload,
        createdBy: req.user.id,
      });

      await syncAccountSalesTeamLinks(account._id, payload.salesTeamIds);

      created.push(account);
      buildBatchDuplicateKeys(payload).forEach((key) => batchKeys.add(key));
    }

    const createdAccountIds = created.map((account) => String(account._id));
    const createdAccounts = createdAccountIds.length > 0
      ? await populateAccount(Account.find({ _id: { $in: createdAccountIds } }).sort({ createdAt: -1 }))
      : [];

    return res.status(201).json({
      success: true,
      message: "Bulk accounts import completed",
      data: {
        total: accountsInput.length,
        createdCount: createdAccounts.length,
        failedCount: failed.length,
        createdAccountIds,
        createdAccounts,
        failed,
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
    const validationError = validateCreateAccountPayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const salesTeamValidationError = await validateActiveSalesTeamIds(payload.salesTeamIds);

    if (salesTeamValidationError) {
      return res.status(400).json({
        success: false,
        message: salesTeamValidationError,
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
    await syncAccountSalesTeamLinks(account._id, payload.salesTeamIds);
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

    const salesTeamValidationError = await validateActiveSalesTeamIds(update.salesTeamIds);

    if (salesTeamValidationError) {
      return res.status(400).json({
        success: false,
        message: salesTeamValidationError,
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

    await syncAccountSalesTeamLinks(req.params.id, update.salesTeamIds);

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

    if (!payload.accountType) {
      return res.status(400).json({
        success: false,
        message: "accountType is required",
      });
    }

    if (!validateAssignedRepIds(payload.assignedMedicalRepIds)) {
      return res.status(400).json({
        success: false,
        message: "assignedMedicalRepIds must be an array of valid MongoDB ObjectIds",
      });
    }

    const salesTeamValidationError = await validateActiveSalesTeamIds(payload.salesTeamIds);

    if (salesTeamValidationError) {
      return res.status(400).json({
        success: false,
        message: salesTeamValidationError,
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

    await syncAccountSalesTeamLinks(req.params.id, payload.salesTeamIds);

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
