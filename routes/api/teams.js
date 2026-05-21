const express = require("express");
const auth = require("../../middleware/auth");
const Line = require("../../models/Line");
const Team = require("../../models/Team");
const TeamInvitation = require("../../models/TeamInvitation");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const normalizeLineId = (lineId) => String(lineId || "").trim().toUpperCase();

const createTeamCode = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `TM-${Math.floor(100000 + Math.random() * 900000)}`;
    const existingTeam = await Team.exists({ teamCode: code });

    if (!existingTeam) {
      return code;
    }
  }

  throw new Error("Could not generate unique team code");
};

const getCurrentUser = async (req) => {
  return User.findById(req.user.id);
};

const buildManagerPath = async (managerId) => {
  const manager = await User.findById(managerId);

  if (!manager) {
    const error = new Error("Manager not found");
    error.statusCode = 400;
    throw error;
  }

  return [...(manager.path || []), manager._id];
};

const requireManager = async (req, res, next) => {
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
      message: "Only managers can perform this action",
    });
  }

  req.currentUser = user;
  return next();
};

const canManageTeam = (user, team) => {
  return user.role === "admin" || String(team.managerId?._id || team.managerId) === String(user._id);
};

const canViewTeam = (user, team) => {
  if (canManageTeam(user, team)) {
    return true;
  }

  return (team.members || []).some((member) => String(member._id || member) === String(user._id));
};

const findTeamForUser = async (teamId, user) => {
  const team = await Team.findById(teamId)
    .populate("managerId", "fullName email appId role profilePicture position territory area")
    .populate("createdBy", "fullName email appId role")
    .populate(
      "members",
      "fullName userName email phone appId role status teamId managerId lineId territory area designation position profilePicture yearlyTargetValue yearlyTargetUnits targetYear performanceSnapshot forecastSnapshot",
    );

  if (!team) {
    const error = new Error("Team not found");
    error.statusCode = 404;
    throw error;
  }

  if (!canViewTeam(user, team)) {
    const error = new Error("You do not have access to this team");
    error.statusCode = 403;
    throw error;
  }

  return team;
};

const resolveLine = async (lineId, lineName) => {
  const normalizedLineId = normalizeLineId(lineId);

  if (!normalizedLineId) {
    const error = new Error("lineId is required");
    error.statusCode = 400;
    throw error;
  }

  const line = await Line.findOne({ lineId: normalizedLineId });

  return {
    lineId: normalizedLineId,
    lineName: line?.lineName || lineName,
  };
};

const resolveLines = async ({ lineIds, lineNames, lineId, lineName }) => {
  const requestedLineIds = Array.isArray(lineIds) && lineIds.length > 0
    ? lineIds
    : Array.isArray(lineId)
      ? lineId
      : [lineId];
  const normalizedLineIds = [...new Set(requestedLineIds.map(normalizeLineId).filter(Boolean))];

  if (normalizedLineIds.length === 0) {
    const error = new Error("At least one lineId is required");
    error.statusCode = 400;
    throw error;
  }

  const lines = await Line.find({ lineId: { $in: normalizedLineIds } }).lean();
  const linesById = lines.reduce((map, line) => {
    map[line.lineId] = line;
    return map;
  }, {});
  const requestLineNames = Array.isArray(lineNames) ? lineNames : [];
  const resolvedLineNames = normalizedLineIds.map((resolvedLineId, index) => {
    return linesById[resolvedLineId]?.lineName || requestLineNames[index] || lineName || resolvedLineId;
  });

  return {
    primaryLineId: normalizedLineIds[0],
    primaryLineName: resolvedLineNames[0],
    lineIds: normalizedLineIds,
    lineNames: resolvedLineNames,
  };
};

const getEffectiveTeamLineIds = (team) => {
  const lineIds = Array.isArray(team.lineIds) && team.lineIds.length > 0 ? team.lineIds : [team.lineId];

  return [...new Set(lineIds.map(normalizeLineId).filter(Boolean))];
};

const syncTeamMembersFromLines = async (team) => {
  const lineIds = getEffectiveTeamLineIds(team);

  if (lineIds.length === 0) {
    return {
      team,
      autoAddedMembers: 0,
      skippedAssignedMembers: 0,
    };
  }

  const managerId = team.managerId?._id || team.managerId;
  const managerPath = await buildManagerPath(managerId);
  const eligibleUsers = await User.find({
    role: "representative",
    lineId: { $in: lineIds },
    $or: [
      { teamId: { $exists: false } },
      { teamId: null },
      { teamId: team._id },
    ],
  }).select("_id lineId");
  const userIds = eligibleUsers.map((user) => user._id);
  const assignedToOtherTeamCount = await User.countDocuments({
    role: "representative",
    lineId: { $in: lineIds },
    teamId: { $exists: true, $nin: [null, team._id] },
  });

  if (userIds.length === 0) {
    return {
      team,
      autoAddedMembers: 0,
      skippedAssignedMembers: assignedToOtherTeamCount,
    };
  }

  await User.updateMany(
    { _id: { $in: userIds } },
    {
      $set: {
        teamId: team._id,
        managerId,
        path: managerPath,
        lastActivityAt: new Date(),
      },
    },
  );

  await Team.findByIdAndUpdate(team._id, {
    $addToSet: {
      members: {
        $each: userIds,
      },
    },
  });

  const usersByLine = eligibleUsers.reduce((map, user) => {
    const normalizedLineId = normalizeLineId(user.lineId);
    map[normalizedLineId] = map[normalizedLineId] || [];
    map[normalizedLineId].push(user._id);
    return map;
  }, {});
  const lineBulkOps = Object.entries(usersByLine).map(([normalizedLineId, members]) => ({
    updateOne: {
      filter: { lineId: normalizedLineId },
      update: {
        $addToSet: {
          members: {
            $each: members,
          },
        },
      },
    },
  }));

  if (lineBulkOps.length > 0) {
    await Line.bulkWrite(lineBulkOps);
  }

  const syncedTeam = await Team.findById(team._id)
    .populate("managerId", "fullName email appId role")
    .populate("members", "fullName email appId role status lineId");

  return {
    team: syncedTeam,
    autoAddedMembers: userIds.length,
    skippedAssignedMembers: assignedToOtherTeamCount,
  };
};

const buildTeamQuery = (user, query) => {
  const teamQuery = isManagerRole(user.role)
    ? { managerId: user._id }
    : { members: user._id };

  if (query.lineId) {
    const normalizedLineId = normalizeLineId(query.lineId);
    teamQuery.$or = [
      { lineIds: normalizedLineId },
      { lineId: normalizedLineId },
    ];
  }
  if (query.territory) {
    teamQuery.territory = query.territory;
  }
  if (query.status) {
    teamQuery.status = query.status;
  }
  if (query.visibility) {
    teamQuery.visibility = query.visibility;
  }
  if (query.isActive !== undefined) {
    teamQuery.isActive = query.isActive === "true";
  }

  return teamQuery;
};

const buildTeamPermissions = (user, team) => {
  const canManage = canManageTeam(user, team);

  return {
    canView: canViewTeam(user, team),
    canManage,
    canInvite: canManage && isManagerRole(user.role) && team.isActive,
    canEdit: canManage,
    canArchive: canManage,
    canViewReports: canManage || String(user.teamId || "") === String(team._id),
    canViewTargets: canManage || String(user.teamId || "") === String(team._id),
  };
};

const getTeamLineName = (team, lineId) => {
  const normalizedLineId = normalizeLineId(lineId);
  const normalizedTeamLineIds = (team.lineIds || []).map(normalizeLineId);
  const lineIndex = normalizedTeamLineIds.indexOf(normalizedLineId);

  return team.lineNames?.[lineIndex] || team.lineName || normalizedLineId;
};

const formatTeamMember = (member, team) => {
  const memberObject = member.toObject ? member.toObject() : member;
  const memberLineId = memberObject.lineId || team.lineId;

  return {
    _id: memberObject._id,
    fullName: memberObject.fullName,
    userName: memberObject.userName,
    appId: memberObject.appId,
    email: memberObject.email,
    phone: memberObject.phone,
    role: memberObject.role,
    profilePicture: memberObject.profilePicture,
    territory: memberObject.territory || team.territory,
    area: memberObject.area || team.area,
    lineId: memberLineId,
    lineName: getTeamLineName(team, memberLineId),
    managerId: memberObject.managerId || team.managerId?._id || team.managerId,
    teamId: memberObject.teamId || team._id,
    status: memberObject.status,
  };
};

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const {
      teamName,
      teamCode,
      teamLogo,
      logo,
      description,
      details,
      lineId,
      lineName,
      lineIds,
      lineNames,
      territory,
      area,
      organizationId,
      status = "active",
      isActive = true,
      visibility = "private",
    } = req.body;

    if (!teamName) {
      return res.status(400).json({
        success: false,
        message: "teamName is required",
      });
    }

    const lines = await resolveLines({ lineIds, lineNames, lineId, lineName });
    const normalizedTeamCode = teamCode ? String(teamCode).trim().toUpperCase() : await createTeamCode();

    const createdTeam = await Team.create({
      teamName,
      teamCode: normalizedTeamCode,
      teamLogo: teamLogo || logo,
      description: description || details,
      lineId: lines.primaryLineId,
      lineName: lines.primaryLineName,
      lineIds: lines.lineIds,
      lineNames: lines.lineNames,
      territory,
      area,
      managerId: req.user.id,
      createdBy: req.user.id,
      organizationId,
      members: [],
      status,
      isActive,
      visibility,
    });
    const syncResult = await syncTeamMembersFromLines(createdTeam);

    return res.status(201).json({
      success: true,
      message: "Team created successfully",
      data: syncResult.team,
      meta: {
        autoAddedMembers: syncResult.autoAddedMembers,
        skippedAssignedMembers: syncResult.skippedAssignedMembers,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/my-teams", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const teams = await Team.find(buildTeamQuery(user, req.query))
      .populate("managerId", "fullName email appId role profilePicture")
      .populate("members", "fullName email appId role status")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Teams fetched successfully",
      data: teams,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/dashboard", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const teams = await Team.find(buildTeamQuery(user, req.query)).populate(
      "members",
      "fullName email appId role status yearlyTargetValue yearlyTargetUnits performanceSnapshot forecastSnapshot",
    );
    const memberIds = teams.flatMap((team) => team.members.map((member) => member._id));
    const pendingInvitations = await TeamInvitation.countDocuments({
      teamId: { $in: teams.map((team) => team._id) },
      status: "pending",
    });
    const targetValue = teams.reduce((sum, team) => {
      return sum + team.members.reduce((memberSum, member) => memberSum + (member.yearlyTargetValue || 0), 0);
    }, 0);

    return res.status(200).json({
      success: true,
      message: "Team dashboard fetched successfully",
      data: {
        filters: req.query,
        totals: {
          teams: teams.length,
          members: memberIds.length,
          pendingInvitations,
          targetValue,
        },
        teams,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    const team = await findTeamForUser(req.params.id, user);
    const pendingInvitations = await TeamInvitation.find({
      teamId: team._id,
      status: "pending",
    })
      .populate("toUserId", "fullName email appId role status teamId")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Team fetched successfully",
      data: {
        team,
        pendingInvitations,
        permissions: buildTeamPermissions(user, team),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, requireManager, async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    if (!canManageTeam(req.currentUser, team)) {
      return res.status(403).json({
        success: false,
        message: "You can only update your own teams",
      });
    }

    const allowedFields = [
      "teamName",
      "teamCode",
      "teamLogo",
      "description",
      "lineId",
      "lineName",
      "lineIds",
      "lineNames",
      "territory",
      "area",
      "organizationId",
      "status",
      "isActive",
      "visibility",
    ];
    const update = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    if (req.body.logo !== undefined) {
      update.teamLogo = req.body.logo;
    }
    if (req.body.details !== undefined) {
      update.description = req.body.details;
    }
    if (update.teamCode) {
      update.teamCode = String(update.teamCode).trim().toUpperCase();
    }
    if (update.lineIds !== undefined || update.lineId !== undefined) {
      const lines = await resolveLines({
        lineIds: update.lineIds,
        lineNames: update.lineNames,
        lineId: update.lineId || team.lineId,
        lineName: update.lineName || team.lineName,
      });
      update.lineId = lines.primaryLineId;
      update.lineName = lines.primaryLineName;
      update.lineIds = lines.lineIds;
      update.lineNames = lines.lineNames;
    }

    const updatedTeam = await Team.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true },
    )
      .populate("managerId", "fullName email appId role")
      .populate("members", "fullName email appId role status");
    const syncResult = await syncTeamMembersFromLines(updatedTeam);

    return res.status(200).json({
      success: true,
      message: "Team updated successfully",
      data: syncResult.team,
      meta: {
        autoAddedMembers: syncResult.autoAddedMembers,
        skippedAssignedMembers: syncResult.skippedAssignedMembers,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/members", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    const team = await findTeamForUser(req.params.id, user);
    const members = team.members.map((member) => formatTeamMember(member, team));

    return res.status(200).json({
      success: true,
      message: "Team members fetched successfully",
      members,
      data: members,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/invitations", auth, requireManager, async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    if (!canManageTeam(req.currentUser, team)) {
      return res.status(403).json({
        success: false,
        message: "You can only view invitations for your own teams",
      });
    }

    const query = { teamId: team._id };

    if (req.query.status) {
      query.status = req.query.status;
    }

    const invitations = await TeamInvitation.find(query)
      .populate("fromManagerId", "fullName email appId role")
      .populate("toUserId", "fullName email appId role status teamId")
      .populate("teamId", "teamName teamCode teamLogo description lineId lineName lineIds lineNames territory area")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Team invitations fetched successfully",
      data: invitations,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/hierarchy", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    const team = await findTeamForUser(req.params.id, user);
    const manager = await User.findById(team.managerId._id || team.managerId).populate(
      "managerId",
      "fullName email appId role",
    );

    return res.status(200).json({
      success: true,
      message: "Team hierarchy fetched successfully",
      data: {
        manager,
        members: team.members,
        hierarchyPath: [manager?._id, ...team.members.map((member) => member._id)].filter(Boolean),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/targets", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    const team = await findTeamForUser(req.params.id, user);

    return res.status(200).json({
      success: true,
      message: "Team targets fetched successfully",
      data: team.members.map((member) => ({
        userId: member._id,
        fullName: member.fullName,
        appId: member.appId,
        yearlyTargetValue: member.yearlyTargetValue || 0,
        yearlyTargetUnits: member.yearlyTargetUnits || 0,
        targetYear: member.targetYear,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/reports", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    const team = await findTeamForUser(req.params.id, user);

    return res.status(200).json({
      success: true,
      message: "Team reports fetched successfully",
      data: team.members.map((member) => ({
        userId: member._id,
        fullName: member.fullName,
        appId: member.appId,
        performanceSnapshot: member.performanceSnapshot,
        forecastSnapshot: member.forecastSnapshot,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/permissions", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    const team = await findTeamForUser(req.params.id, user);

    return res.status(200).json({
      success: true,
      message: "Team permissions fetched successfully",
      data: buildTeamPermissions(user, team),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
