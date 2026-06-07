const express = require("express");

const auth = require("../../middleware/auth");
const achievementController = require("../../controllers/achievementController");

const router = express.Router();

router.get("/my", auth, achievementController.loadActor, achievementController.getMyAchievement);
router.get("/team", auth, achievementController.loadActor, achievementController.getTeamAchievement);

module.exports = router;
