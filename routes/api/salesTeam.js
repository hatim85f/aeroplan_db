const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const SalesTeamMember = require("../../models/SalesTeamMember");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { resolveOrgId } = require("../../helpers/tenancy");

const router = express.Router();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const getCurrentUser = async (req) => User.findById(req.user.id);

const requireManager = async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!isManagerRole(user.role)) {
      return res.status(403).json({
        success: false,
        message: "Only managers can manage sales team members",
      });
    }

    req.currentUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

const normalizeBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const normalizeObjectIdArray = (value, fieldName) => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    const error = new Error(`${fieldName} must be an array of valid MongoDB ObjectIds`);
    error.statusCode = 400;
    throw error;
  }

  const normalized = [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];

  if (!normalized.every((id) => isValidObjectId(id))) {
    const error = new Error(`${fieldName} must contain only valid MongoDB ObjectIds`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
};

const normalizePayload = (body = {}, { partial = false } = {}) => {
  const payload = {};
  const simpleFields = ["fullName", "phone", "email", "position", "notes"];

  simpleFields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  if (!partial && !payload.fullName) {
    const error = new Error("fullName is required");
    error.statusCode = 400;
    throw error;
  }

  if (payload.email !== undefined) {
    const email = String(payload.email || "").trim().toLowerCase();
    payload.email = email || undefined;
  }

  if (body.accountIds !== undefined) {
    payload.accountIds = normalizeObjectIdArray(body.accountIds, "accountIds");
  }

  if (body.teamManaged !== undefined) {
    payload.teamManaged = normalizeObjectIdArray(body.teamManaged, "teamManaged");
  }

  if (body.managerId !== undefined) {
    if (body.managerId === null || body.managerId === "") {
      payload.managerId = null;
    } else if (!isValidObjectId(body.managerId)) {
      const error = new Error("managerId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    } else {
      payload.managerId = body.managerId;
    }
  }

  if (body.status !== undefined) {
    payload.status = String(body.status).trim().toLowerCase();
    payload.isActive = payload.status === "active";
  } else if (body.isActive !== undefined) {
    payload.isActive = normalizeBoolean(body.isActive);
    payload.status = payload.isActive ? "active" : "inactive";
  }

  if (payload.status !== undefined && !["active", "inactive"].includes(payload.status)) {
    const error = new Error("status must be active or inactive");
    error.statusCode = 400;
    throw error;
  }

  return payload;
};

const validateReferencedAccounts = async (accountIds = []) => {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return;
  }

  const accounts = await Account.find({ _id: { $in: accountIds } }).select("_id").lean();
  const existingAccountIds = new Set(accounts.map((account) => String(account._id)));
  const missingAccountId = accountIds.find((accountId) => !existingAccountIds.has(String(accountId)));

  if (missingAccountId) {
    const error = new Error(`Account not found: ${missingAccountId}`);
    error.statusCode = 400;
    throw error;
  }
};

const validateReferencedSalesMembers = async ({ managerId, teamManaged = [], memberId }) => {
  const ids = [];

  if (managerId) {
    ids.push(String(managerId));
  }

  if (Array.isArray(teamManaged)) {
    ids.push(...teamManaged.map((id) => String(id)));
  }

  if (memberId) {
    if (managerId && String(managerId) === String(memberId)) {
      const error = new Error("Sales team member cannot be their own manager");
      error.statusCode = 400;
      throw error;
    }

    if (teamManaged.some((id) => String(id) === String(memberId))) {
      const error = new Error("Sales team member cannot manage themselves");
      error.statusCode = 400;
      throw error;
    }
  }

  const uniqueIds = [...new Set(ids)];

  if (uniqueIds.length === 0) {
    return;
  }

  const members = await SalesTeamMember.find({ _id: { $in: uniqueIds } }).select("_id").lean();
  const existingMemberIds = new Set(members.map((member) => String(member._id)));
  const missingMemberId = uniqueIds.find((id) => !existingMemberIds.has(id));

  if (missingMemberId) {
    const error = new Error(`Sales team member not found: ${missingMemberId}`);
    error.statusCode = 400;
    throw error;
  }
};

const validateUniqueEmail = async (email, excludeId) => {
  if (!email) {
    return;
  }

  const query = { email };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existingMember = await SalesTeamMember.findOne(query).select("_id").lean();

  if (existingMember) {
    const error = new Error("Sales team member email already exists");
    error.statusCode = 409;
    throw error;
  }
};

const populateSalesTeamMember = (query) => query
  .populate("accountIds", "accountName accountType area territory")
  .populate("managerId", "fullName email phone position status isActive")
  .populate("teamManaged", "fullName email phone position status isActive");

const syncSalesTeamMemberAccountLinks = async (memberId, accountIds) => {
  if (accountIds === undefined) {
    return;
  }

  const memberIdString = String(memberId);

  await Account.updateMany(
    {
      salesTeamIds: memberIdString,
      _id: { $nin: accountIds },
    },
    { $pull: { salesTeamIds: memberIdString } },
  );

  if (accountIds.length > 0) {
    await Account.updateMany(
      { _id: { $in: accountIds } },
      { $addToSet: { salesTeamIds: memberIdString } },
    );
  }
};

const buildListQuery = (user, queryParams) => {
  const query = { organizationId: resolveOrgId(user) };

  if (!isManagerRole(user.role)) {
    query.status = "active";
    query.isActive = true;
  } else if (queryParams.status) {
    query.status = String(queryParams.status).trim().toLowerCase();
  }

  if (queryParams.isActive !== undefined && isManagerRole(user.role)) {
    query.isActive = normalizeBoolean(queryParams.isActive);
  }

  if (queryParams.position) {
    query.position = { $regex: String(queryParams.position).trim(), $options: "i" };
  }

  if (queryParams.accountId) {
    if (!isValidObjectId(queryParams.accountId)) {
      query._id = null;
    } else {
      query.accountIds = queryParams.accountId;
    }
  }

  if (queryParams.managerId) {
    if (!isValidObjectId(queryParams.managerId)) {
      query._id = null;
    } else {
      query.managerId = queryParams.managerId;
    }
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { position: { $regex: search, $options: "i" } },
      { notes: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const payload = normalizePayload(req.body);

    await validateReferencedAccounts(payload.accountIds);
    await validateReferencedSalesMembers(payload);
    await validateUniqueEmail(payload.email);

    const member = await SalesTeamMember.create({
      ...payload,
      organizationId: resolveOrgId(req.user),
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });

    await syncSalesTeamMemberAccountLinks(member._id, payload.accountIds);

    const populatedMember = await populateSalesTeamMember(SalesTeamMember.findById(member._id));

    return res.status(201).json({
      success: true,
      message: "Sales team member created successfully",
      data: populatedMember,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = buildListQuery(user, req.query);

    const [members, total] = await Promise.all([
      populateSalesTeamMember(
        SalesTeamMember.find(query)
          .collation({ locale: "en", strength: 2 })
          .sort({ fullName: 1 })
          .skip(skip)
          .limit(limit),
      ),
      SalesTeamMember.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales team members fetched successfully",
      data: members,
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

router.get("/account/:accountId", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    const members = await populateSalesTeamMember(
      SalesTeamMember.find({
        accountIds: req.params.accountId,
        status: "active",
        isActive: true,
      }).collation({ locale: "en", strength: 2 }).sort({ fullName: 1 }),
    );

    return res.status(200).json({
      success: true,
      message: "Account sales team members fetched successfully",
      data: members,
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
        message: "Sales team member id must be a valid MongoDB ObjectId",
      });
    }

    const user = await getCurrentUser(req);
    const query = { _id: req.params.id };

    if (!isManagerRole(user?.role)) {
      query.status = "active";
      query.isActive = true;
    }

    const member = await populateSalesTeamMember(SalesTeamMember.findOne(query));

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Sales team member not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Sales team member fetched successfully",
      data: member,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales team member id must be a valid MongoDB ObjectId",
      });
    }

    const payload = normalizePayload(req.body, { partial: true });

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update sales team member",
      });
    }

    const existingMember = await SalesTeamMember.findById(req.params.id).lean();

    if (!existingMember) {
      return res.status(404).json({
        success: false,
        message: "Sales team member not found",
      });
    }

    await validateReferencedAccounts(payload.accountIds);
    await validateReferencedSalesMembers({
      managerId: payload.managerId !== undefined ? payload.managerId : existingMember.managerId,
      teamManaged: payload.teamManaged !== undefined ? payload.teamManaged : existingMember.teamManaged,
      memberId: req.params.id,
    });
    await validateUniqueEmail(payload.email, req.params.id);

    const member = await populateSalesTeamMember(SalesTeamMember.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...payload,
          updatedBy: req.user.id,
        },
      },
      { new: true, runValidators: true },
    ));

    await syncSalesTeamMemberAccountLinks(req.params.id, payload.accountIds);

    return res.status(200).json({
      success: true,
      message: "Sales team member updated successfully",
      data: member,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales team member id must be a valid MongoDB ObjectId",
      });
    }

    if (req.body.status === undefined && req.body.isActive === undefined) {
      return res.status(400).json({
        success: false,
        message: "status or isActive is required",
      });
    }

    const requestedStatus = req.body.status !== undefined
      ? String(req.body.status).trim().toLowerCase()
      : undefined;

    if (requestedStatus !== undefined && !["active", "inactive"].includes(requestedStatus)) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive",
      });
    }

    const isActive = requestedStatus !== undefined
      ? requestedStatus === "active"
      : normalizeBoolean(req.body.isActive);
    const status = isActive ? "active" : "inactive";

    const member = await populateSalesTeamMember(SalesTeamMember.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status,
          isActive,
          updatedBy: req.user.id,
        },
      },
      { new: true, runValidators: true },
    ));

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Sales team member not found",
      });
    }

    if (!isActive) {
      await syncSalesTeamMemberAccountLinks(req.params.id, []);
    }

    return res.status(200).json({
      success: true,
      message: "Sales team member status updated successfully",
      data: member,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Sales team member id must be a valid MongoDB ObjectId",
      });
    }

    const member = await populateSalesTeamMember(SalesTeamMember.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "inactive",
          isActive: false,
          updatedBy: req.user.id,
        },
      },
      { new: true, runValidators: true },
    ));

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Sales team member not found",
      });
    }

    await syncSalesTeamMemberAccountLinks(req.params.id, []);

    return res.status(200).json({
      success: true,
      message: "Sales team member deactivated successfully",
      data: member,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
