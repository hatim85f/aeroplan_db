const achievementService = require("../services/achievementService");
const forecastService = require("../services/forecastService");

const loadActor = async (req, res, next) => {
  try {
    req.currentUser = await forecastService.getCurrentUser(req.user.id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const getMyAchievement = async (req, res, next) => {
  try {
    const data = await achievementService.getMyAchievement({
      actor: req.currentUser,
      year: req.query.year,
      month: req.query.month,
      channelIds: req.query.channelIds,
    });

    return res.status(200).json({
      success: true,
      message: "Achievement fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getTeamAchievement = async (req, res, next) => {
  try {
    const data = await achievementService.getTeamAchievement({
      actor: req.currentUser,
      year: req.query.year,
      month: req.query.month,
      userId: req.query.userId,
      channelIds: req.query.channelIds,
    });

    return res.status(200).json({
      success: true,
      message: "Team achievement fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getMyAchievement,
  getTeamAchievement,
  loadActor,
};
