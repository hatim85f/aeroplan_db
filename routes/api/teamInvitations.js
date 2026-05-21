const express = require("express");
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const TeamInvitation = require("../../models/TeamInvitation");
const User = require("../../models/User");
const Line = require("../../models/Line");
const { createAndSendNotification } = require("../../helpers/notificationDispatcher");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();
const normalizeLineId = (lineId) => String(lineId || "").trim().toUpperCase();

const getCurrentUser = async (req) => {
  return User.findById(req.user.id);
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
      message: "Only managers can invite team members",
    });
  }

  req.currentUser = user;
  return next();
};

const buildHierarchy = async (managerId) => {
  const manager = await User.findById(managerId);

  if (!manager) {
    const error = new Error("Manager not found");
    error.statusCode = 400;
    throw error;
  }

  return [...(manager.path || []), manager._id];
};

const populateInvitation = (query) => {
  return query
    .populate("fromManagerId", "fullName email appId role profilePicture")
    .populate("toUserId", "fullName email appId role status teamId lineId territory area designation position")
    .populate("teamId", "teamName teamCode teamLogo description lineId lineName territory area managerId");
};

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const { appId, teamId, lineId, message, expiresAt } = req.body;

    if (!appId || !teamId || !lineId) {
      return res.status(400).json({
        success: false,
        message: "appId, teamId and lineId are required",
      });
    }

    const team = await Team.findById(teamId);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    const normalizedLineId = normalizeLineId(lineId);

    if (normalizeLineId(team.lineId) !== normalizedLineId) {
      return res.status(400).json({
        success: false,
        message: "lineId does not match the selected team",
      });
    }

    const line = await Line.findOne({ lineId: normalizedLineId });

    if (!line) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
      });
    }

    if (String(team.managerId) !== req.user.id && req.currentUser.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You can only invite members to your own teams",
      });
    }

    if (!team.isActive || team.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "You can only invite members to an active team",
      });
    }

    const invitedUser = await User.findOne({ appId: String(appId).trim().toUpperCase() });

    if (!invitedUser) {
      return res.status(404).json({
        success: false,
        message: "No user found with this appId",
      });
    }

    if (String(invitedUser._id) === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot invite yourself",
      });
    }

    if (invitedUser.role !== "representative") {
      return res.status(400).json({
        success: false,
        message: "Only representatives can be invited to a team",
      });
    }

    if (invitedUser.teamId) {
      return res.status(409).json({
        success: false,
        message: "This representative already belongs to a team.",
      });
    }

    const isAlreadyMember = team.members.some((memberId) => {
      return String(memberId) === String(invitedUser._id);
    });

    if (isAlreadyMember) {
      return res.status(409).json({
        success: false,
        message: "This representative is already in this team",
      });
    }

    const existingInvitation = await TeamInvitation.findOne({
      toUserId: invitedUser._id,
      status: "pending",
    });

    if (existingInvitation) {
      return res.status(409).json({
        success: false,
        message: "A pending invitation already exists for this representative",
      });
    }

    const invitation = await TeamInvitation.create({
      fromManagerId: req.user.id,
      toUserId: invitedUser._id,
      teamId: team._id,
      lineId: normalizedLineId,
      lineName: team.lineName || line.lineName,
      message,
      expiresAt,
    });

    const notification = await createAndSendNotification({
      from: req.user.id,
      to: invitedUser._id,
      title: "Team Invitation",
      subtitle: `${req.currentUser.fullName || req.currentUser.email} invited you to ${team.teamName}`,
      routeName: "TeamInvitations",
      payload: {
        invitationId: String(invitation._id),
        teamId: String(team._id),
        lineId: normalizedLineId,
      },
      recipient: invitedUser,
    });

    return res.status(201).json({
      success: true,
      message: "Team invitation sent successfully",
      data: {
        invitation,
        notification,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, async (req, res, next) => {
  try {
    const { box = "received", status } = req.query;
    const query = box === "sent" ? { fromManagerId: req.user.id } : { toUserId: req.user.id };

    if (status) {
      query.status = status;
    }

    const invitations = await populateInvitation(TeamInvitation.find(query)).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Team invitations fetched successfully",
      data: invitations,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/accept", auth, async (req, res, next) => {
  try {
    const invitation = await TeamInvitation.findOne({
      _id: req.params.id,
      toUserId: req.user.id,
      status: "pending",
    });

    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: "Pending invitation not found",
      });
    }

    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      invitation.status = "cancelled";
      invitation.cancelledAt = new Date();
      await invitation.save();

      return res.status(400).json({
        success: false,
        message: "Invitation has expired",
      });
    }

    const currentUser = await User.findById(req.user.id);

    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (currentUser.teamId) {
      return res.status(409).json({
        success: false,
        message: "This representative already belongs to a team.",
      });
    }

    const team = await Team.findById(invitation.teamId);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    if (!team.isActive || team.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "This team is not active",
      });
    }

    const manager = await User.findById(invitation.fromManagerId);
    const path = await buildHierarchy(invitation.fromManagerId);
    const acceptedLineId = normalizeLineId(invitation.lineId || team.lineId);
    invitation.lineId = acceptedLineId;
    invitation.lineName = invitation.lineName || team.lineName;

    currentUser.managerId = invitation.fromManagerId;
    currentUser.teamId = invitation.teamId;
    currentUser.lineId = acceptedLineId;
    currentUser.territory = team.territory || currentUser.territory;
    currentUser.area = team.area || currentUser.area;
    currentUser.path = path;
    currentUser.lastActivityAt = new Date();
    const user = await currentUser.save();

    await Team.findByIdAndUpdate(invitation.teamId, {
      $addToSet: {
        members: req.user.id,
      },
    });
    await Line.findOneAndUpdate(
      { lineId: acceptedLineId },
      {
        $addToSet: {
          members: req.user.id,
        },
      },
    );

    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    await invitation.save();

    let notification = null;
    if (manager) {
      notification = await createAndSendNotification({
        from: req.user.id,
        to: manager._id,
        title: "Team Invitation Accepted",
        subtitle: `${currentUser.fullName || currentUser.email} accepted your invitation to ${team.teamName}`,
        routeName: "TeamDetails",
        payload: {
          invitationId: String(invitation._id),
          teamId: String(team._id),
          lineId: acceptedLineId,
          userId: String(currentUser._id),
        },
        recipient: manager,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Team invitation accepted successfully",
      data: {
        invitation,
        user,
        notification,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/reject", auth, async (req, res, next) => {
  try {
    const invitation = await TeamInvitation.findOne({
      _id: req.params.id,
      toUserId: req.user.id,
      status: "pending",
    });

    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: "Pending invitation not found",
      });
    }

    invitation.status = "rejected";
    invitation.rejectedAt = new Date();
    await invitation.save();

    const [currentUser, manager, team] = await Promise.all([
      User.findById(req.user.id),
      User.findById(invitation.fromManagerId),
      Team.findById(invitation.teamId),
    ]);
    let notification = null;

    if (manager && currentUser && team) {
      notification = await createAndSendNotification({
        from: req.user.id,
        to: manager._id,
        title: "Team Invitation Rejected",
        subtitle: `${currentUser.fullName || currentUser.email} rejected your invitation to ${team.teamName}`,
        routeName: "TeamDetails",
        payload: {
          invitationId: String(invitation._id),
          teamId: String(team._id),
          userId: String(currentUser._id),
        },
        recipient: manager,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Team invitation rejected successfully",
      data: {
        invitation,
        notification,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
