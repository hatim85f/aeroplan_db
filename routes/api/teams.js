const express = require("express");
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const requireManager = async (req, res, next) => {
  const user = await User.findById(req.user.id);

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

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const { teamName, logo, details, lineId, territory } = req.body;

    if (!teamName) {
      return res.status(400).json({
        success: false,
        message: "teamName is required",
      });
    }

    const team = await Team.create({
      teamName,
      logo,
      details,
      lineId,
      territory,
      managerId: req.user.id,
      members: [],
    });

    return res.status(201).json({
      success: true,
      message: "Team created successfully",
      data: team,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/my-teams", auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const query = isManagerRole(user.role)
      ? { managerId: user._id }
      : { members: user._id };
    const teams = await Team.find(query).populate("managerId", "fullName email appId role");

    return res.status(200).json({
      success: true,
      message: "Teams fetched successfully",
      data: teams,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id)
      .populate("managerId", "fullName email appId role")
      .populate("members", "fullName email appId role status");

    if (!team) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    const canView =
      String(team.managerId._id || team.managerId) === req.user.id ||
      team.members.some((member) => String(member._id) === req.user.id);

    if (!canView) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this team",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Team fetched successfully",
      data: team,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
