const express = require("express");
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const TeamInvitation = require("../../models/TeamInvitation");
const User = require("../../models/User");
const { createAndSendNotification } = require("../../helpers/notificationDispatcher");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

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

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const { appId, teamId, message, expiresAt } = req.body;

    if (!appId || !teamId) {
      return res.status(400).json({
        success: false,
        message: "appId and teamId are required",
      });
    }

    const team = await Team.findById(teamId);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    if (String(team.managerId) !== req.user.id && req.currentUser.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You can only invite members to your own teams",
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

    const existingInvitation = await TeamInvitation.findOne({
      toUserId: invitedUser._id,
      teamId: team._id,
      status: "pending",
    });

    if (existingInvitation) {
      return res.status(409).json({
        success: false,
        message: "A pending invitation already exists for this user and team",
      });
    }

    const invitation = await TeamInvitation.create({
      fromManagerId: req.user.id,
      toUserId: invitedUser._id,
      teamId: team._id,
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

    const invitations = await TeamInvitation.find(query)
      .populate("fromManagerId", "fullName email appId role")
      .populate("toUserId", "fullName email appId role")
      .populate("teamId", "teamName logo details managerId")
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

    const path = await buildHierarchy(invitation.fromManagerId);
    const currentUser = await User.findById(req.user.id);

    if (currentUser.teamId && String(currentUser.teamId) !== String(invitation.teamId)) {
      await Team.findByIdAndUpdate(currentUser.teamId, {
        $pull: {
          members: req.user.id,
        },
      });
    }

    currentUser.managerId = invitation.fromManagerId;
    currentUser.teamId = invitation.teamId;
    currentUser.path = path;
    currentUser.lastActivityAt = new Date();
    const user = await currentUser.save();

    await Team.findByIdAndUpdate(invitation.teamId, {
      $addToSet: {
        members: req.user.id,
      },
    });

    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    await invitation.save();

    return res.status(200).json({
      success: true,
      message: "Team invitation accepted successfully",
      data: {
        invitation,
        user,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/reject", auth, async (req, res, next) => {
  try {
    const invitation = await TeamInvitation.findOneAndUpdate(
      {
        _id: req.params.id,
        toUserId: req.user.id,
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          rejectedAt: new Date(),
        },
      },
      { new: true },
    );

    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: "Pending invitation not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Team invitation rejected successfully",
      data: invitation,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
