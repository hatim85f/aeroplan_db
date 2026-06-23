const express = require("express");
const auth = require("../../middleware/auth");
const Feedback = require("../../models/Feedback");
const User = require("../../models/User");
const { resolveOrgId } = require("../../helpers/tenancy");

const router = express.Router();

// Submit a problem report or feedback (any authenticated user).
router.post("/", auth, async (req, res, next) => {
  try {
    const { type, message, appVersion, buildNumber, platform } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "message is required" });
    }
    const cleanType = type === "problem" ? "problem" : "feedback";
    const user = await User.findById(req.user.id).select("_id fullName email role").lean();

    const feedback = await Feedback.create({
      userId: req.user.id,
      organizationId: resolveOrgId(req.user),
      userName: user?.fullName,
      userEmail: user?.email,
      userRole: user?.role,
      type: cleanType,
      message: String(message).trim(),
      appVersion,
      buildNumber,
      platform,
    });

    return res.status(201).json({
      success: true,
      message: cleanType === "problem" ? "Problem reported. Thank you!" : "Feedback sent. Thank you!",
      data: feedback,
    });
  } catch (error) {
    return next(error);
  }
});

// Admin: list all feedback / problem reports (filters: type, status).
router.get("/", auth, async (req, res, next) => {
  try {
    const me = await User.findById(req.user.id).select("role").lean();
    if (!me || me.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only admins can view feedback" });
    }
    const query = {};
    if (req.query.type) query.type = req.query.type;
    if (req.query.status) query.status = req.query.status;

    const items = await Feedback.find(query).sort({ createdAt: -1 }).limit(500).lean();
    return res.status(200).json({ success: true, message: "Feedback fetched successfully", data: items });
  } catch (error) {
    return next(error);
  }
});

// Admin: update a feedback item's status / notes.
router.patch("/:id", auth, async (req, res, next) => {
  try {
    const me = await User.findById(req.user.id).select("role").lean();
    if (!me || me.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only admins can update feedback" });
    }
    const update = { handledBy: req.user.id };
    if (["new", "in_review", "resolved", "dismissed"].includes(req.body.status)) {
      update.status = req.body.status;
    }
    if (req.body.adminNotes !== undefined) update.adminNotes = req.body.adminNotes;

    const feedback = await Feedback.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!feedback) return res.status(404).json({ success: false, message: "Feedback not found" });
    return res.status(200).json({ success: true, message: "Feedback updated", data: feedback });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
