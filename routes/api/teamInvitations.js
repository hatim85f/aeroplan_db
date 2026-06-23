const express = require("express");
const auth = require("../../middleware/auth");
const TeamInvitation = require("../../models/TeamInvitation");
const User = require("../../models/User");
const Line = require("../../models/Line");
const { createAndSendNotification } = require("../../helpers/notificationDispatcher");
const { isManagerRole } = require("../../helpers/roles");
const { resolveOrgId } = require("../../helpers/tenancy");

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
      message: "Only managers can invite line members",
    });
  }

  req.currentUser = user;
  return next();
};

const populateInvitation = (query) => {
  return query
    .populate("fromManagerId", "fullName email appId role profilePicture")
    .populate("toUserId", "fullName email appId role status teamId lineId territory area designation position")
    .populate("teamId", "teamName teamCode teamLogo description lineId lineName lineIds lineNames territory area managerId");
};

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const { appId, lineId, message, expiresAt } = req.body;

    if (!appId || !lineId) {
      return res.status(400).json({
        success: false,
        message: "appId and lineId are required",
      });
    }

    const normalizedLineId = normalizeLineId(lineId);
    const line = await Line.findOne({ lineId: normalizedLineId });

    if (!line) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
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

    if (normalizeLineId(invitedUser.lineId) === normalizedLineId) {
      return res.status(409).json({
        success: false,
        message: "This representative already belongs to this line",
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
      organizationId: resolveOrgId(req.user),
      lineId: normalizedLineId,
      lineName: line.lineName,
      message,
      expiresAt,
    });

    const notification = await createAndSendNotification({
      from: req.user.id,
      to: invitedUser._id,
      title: "Line Invitation",
      subtitle: `${req.currentUser.fullName || req.currentUser.email} invited you to ${line.lineName}`,
      routeName: "TeamInvitations",
      payload: {
        invitationId: String(invitation._id),
        lineId: normalizedLineId,
      },
      recipient: invitedUser,
    });

    return res.status(201).json({
      success: true,
      message: "Line invitation sent successfully",
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

    const manager = await User.findById(invitation.fromManagerId);
    const acceptedLineId = normalizeLineId(invitation.lineId);
    const line = await Line.findOne({ lineId: acceptedLineId });

    if (!line) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
      });
    }

    invitation.lineId = acceptedLineId;
    invitation.lineName = invitation.lineName || line.lineName;

    currentUser.lineId = acceptedLineId;
    currentUser.lastActivityAt = new Date();
    // Inherit the inviting manager's organization (tenant boundary).
    if (manager) {
      currentUser.organizationId = resolveOrgId(manager);
    }
    const user = await currentUser.save();

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
        title: "Line Invitation Accepted",
        subtitle: `${currentUser.fullName || currentUser.email} accepted your invitation to ${line.lineName}`,
        routeName: "Lines",
        payload: {
          invitationId: String(invitation._id),
          lineId: acceptedLineId,
          userId: String(currentUser._id),
        },
        recipient: manager,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Line invitation accepted successfully",
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

    const [currentUser, manager, line] = await Promise.all([
      User.findById(req.user.id),
      User.findById(invitation.fromManagerId),
      Line.findOne({ lineId: normalizeLineId(invitation.lineId) }),
    ]);
    let notification = null;

    if (manager && currentUser) {
      notification = await createAndSendNotification({
        from: req.user.id,
        to: manager._id,
        title: "Line Invitation Rejected",
        subtitle: `${currentUser.fullName || currentUser.email} rejected your invitation to ${line?.lineName || invitation.lineName || invitation.lineId}`,
        routeName: "Lines",
        payload: {
          invitationId: String(invitation._id),
          lineId: invitation.lineId,
          userId: String(currentUser._id),
        },
        recipient: manager,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Line invitation rejected successfully",
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
