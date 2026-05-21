const express = require("express");
const auth = require("../../middleware/auth");
const Line = require("../../models/Line");
const Team = require("../../models/Team");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const normalizeLineId = (lineId) => String(lineId || "").trim().toUpperCase();

const createLineIdFromName = (lineName) => {
  const slug = String(lineName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return slug || `LINE-${Date.now()}`;
};

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
      message: "Only managers can manage lines",
    });
  }

  req.currentUser = user;
  return next();
};

const buildLineStats = async ({ managerId, isActive }) => {
  const teamMatch = {};
  const userMatch = {};

  if (managerId) {
    teamMatch.managerId = managerId;
    userMatch.managerId = managerId;
  }
  if (isActive !== undefined) {
    teamMatch.isActive = isActive;
  }

  const [teamStats, memberStats] = await Promise.all([
    Team.aggregate([
      { $match: teamMatch },
      {
        $project: {
          members: 1,
          effectiveLineIds: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$lineIds", []] } }, 0] },
              "$lineIds",
              ["$lineId"],
            ],
          },
        },
      },
      { $unwind: "$effectiveLineIds" },
      {
        $group: {
          _id: "$effectiveLineIds",
          numberOfTeams: { $sum: 1 },
        },
      },
    ]),
    User.aggregate([
      { $match: { ...userMatch, lineId: { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: "$lineId",
          numberOfMembers: { $sum: 1 },
        },
      },
    ]),
  ]);

  const statsByLineId = {};

  teamStats.forEach((item) => {
    const lineId = normalizeLineId(item._id);
    statsByLineId[lineId] = {
      numberOfTeams: item.numberOfTeams,
      numberOfMembers: 0,
    };
  });

  memberStats.forEach((item) => {
    const lineId = normalizeLineId(item._id);
    statsByLineId[lineId] = {
      numberOfTeams: statsByLineId[lineId]?.numberOfTeams || 0,
      numberOfMembers: item.numberOfMembers,
    };
  });

  return statsByLineId;
};

const formatLineWithStats = (line, statsByLineId) => {
  const lineObject = line.toObject ? line.toObject() : line;
  const stats = statsByLineId[normalizeLineId(lineObject.lineId)] || {
    numberOfTeams: 0,
    numberOfMembers: 0,
  };

  return {
    ...lineObject,
    numberOfTeams: stats.numberOfTeams,
    numberOfMembers: stats.numberOfMembers,
  };
};

router.get("/", auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    const query = {};

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (req.query.isActive !== undefined) {
      query.isActive = req.query.isActive === "true";
    }

    const lines = await Line.find(query).sort({ lineName: 1 });
    const statsByLineId = await buildLineStats({
      managerId: isManagerRole(user.role) && user.role !== "admin" ? user._id : undefined,
      isActive: req.query.teamIsActive !== undefined ? req.query.teamIsActive === "true" : undefined,
    });

    return res.status(200).json({
      success: true,
      message: "Lines fetched successfully",
      data: lines.map((line) => formatLineWithStats(line, statsByLineId)),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/summary", auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const query = {};

    if (req.query.isActive !== undefined) {
      query.isActive = req.query.isActive === "true";
    }

    const lines = await Line.find(query).sort({ lineName: 1 });
    const statsByLineId = await buildLineStats({
      managerId: isManagerRole(user.role) && user.role !== "admin" ? user._id : undefined,
      isActive: req.query.teamIsActive !== undefined ? req.query.teamIsActive === "true" : undefined,
    });

    return res.status(200).json({
      success: true,
      message: "Line summary fetched successfully",
      data: lines.map((line) => {
        const lineObject = line.toObject();
        const stats = statsByLineId[normalizeLineId(lineObject.lineId)] || {
          numberOfTeams: 0,
          numberOfMembers: 0,
        };

        return {
          lineId: lineObject.lineId,
          lineName: lineObject.lineName,
          lineLogo: lineObject.lineLogo,
          numberOfTeams: stats.numberOfTeams,
          numberOfMembers: stats.numberOfMembers,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const { lineName, lineId, lineLogo, logo, description, organizationId } = req.body;

    if (!lineName) {
      return res.status(400).json({
        success: false,
        message: "lineName is required",
      });
    }

    const normalizedLineId = normalizeLineId(lineId || createLineIdFromName(lineName));
    const existingLine = await Line.findOne({ lineId: normalizedLineId });

    if (existingLine) {
      return res.status(409).json({
        success: false,
        message: "Line already exists",
      });
    }

    const line = await Line.create({
      lineId: normalizedLineId,
      lineName,
      lineLogo: lineLogo || logo,
      description,
      organizationId,
      createdBy: req.user.id,
    });

    return res.status(201).json({
      success: true,
      message: "Line created successfully",
      data: line,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:lineId", auth, requireManager, async (req, res, next) => {
  try {
    const line = await Line.findOne({ lineId: normalizeLineId(req.params.lineId) });

    if (!line) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
      });
    }

    const allowedFields = ["lineName", "description", "isActive"];
    const update = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    if (req.body.lineLogo !== undefined) {
      update.lineLogo = req.body.lineLogo;
    }
    if (req.body.logo !== undefined) {
      update.lineLogo = req.body.logo;
    }

    const updatedLine = await Line.findByIdAndUpdate(
      line._id,
      { $set: update },
      { new: true, runValidators: true },
    );

    return res.status(200).json({
      success: true,
      message: "Line updated successfully",
      data: updatedLine,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:lineId", auth, requireManager, async (req, res, next) => {
  try {
    const normalizedLineId = normalizeLineId(req.params.lineId);
    const line = await Line.findOne({ lineId: normalizedLineId });

    if (!line) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
      });
    }

    const [memberCount, teamCount] = await Promise.all([
      User.countDocuments({ lineId: normalizedLineId }),
      Team.countDocuments({
        $or: [{ lineIds: normalizedLineId }, { lineId: normalizedLineId }],
      }),
    ]);

    if (memberCount > 0 || teamCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete a line that has active members or teams",
        data: { memberCount, teamCount },
      });
    }

    await Line.findByIdAndDelete(line._id);

    return res.status(200).json({
      success: true,
      message: "Line deleted successfully",
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:lineId/members/:userId", auth, requireManager, async (req, res, next) => {
  try {
    const normalizedLineId = normalizeLineId(req.params.lineId);
    const line = await Line.findOne({ lineId: normalizedLineId });

    if (!line) {
      return res.status(404).json({
        success: false,
        message: "Line not found",
      });
    }

    const user = await User.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const isMember = line.members.some((id) => String(id) === String(user._id));

    if (!isMember) {
      return res.status(404).json({
        success: false,
        message: "User is not a member of this line",
      });
    }

    const userUpdate = { lineId: null, lastActivityAt: new Date() };

    if (user.teamId) {
      const team = await Team.findById(user.teamId);
      const teamLineIds = Array.isArray(team?.lineIds) && team.lineIds.length > 0
        ? team.lineIds
        : [team?.lineId];

      if (teamLineIds.map(normalizeLineId).includes(normalizedLineId)) {
        userUpdate.teamId = null;
      }
    }

    await Promise.all([
      Line.findByIdAndUpdate(line._id, { $pull: { members: user._id } }),
      User.findByIdAndUpdate(user._id, { $set: userUpdate }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Member removed from line successfully",
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
