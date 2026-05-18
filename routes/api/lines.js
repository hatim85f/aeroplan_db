const express = require("express");
const auth = require("../../middleware/auth");
const Line = require("../../models/Line");
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

router.get("/", auth, async (req, res, next) => {
  try {
    const query = {};

    if (req.query.isActive !== undefined) {
      query.isActive = req.query.isActive === "true";
    }

    const lines = await Line.find(query).sort({ lineName: 1 });

    return res.status(200).json({
      success: true,
      message: "Lines fetched successfully",
      data: lines,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", auth, requireManager, async (req, res, next) => {
  try {
    const { lineName, lineId, description, organizationId } = req.body;

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

module.exports = router;
