const forecastService = require("../services/forecastService");

const loadActor = async (req, res, next) => {
  try {
    req.currentUser = await forecastService.getCurrentUser(req.user.id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const getMyForecast = async (req, res, next) => {
  try {
    const data = await forecastService.getMyForecast({
      actor: req.currentUser,
      year: req.query.year,
      month: req.query.month,
    });

    return res.status(200).json({
      success: true,
      message: "Forecast fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getTeamForecasts = async (req, res, next) => {
  try {
    const data = await forecastService.summarizeTeamForecasts({
      actor: req.currentUser,
      year: req.query.year,
      month: req.query.month,
      userId: req.query.userId,
    });

    return res.status(200).json({
      success: true,
      message: "Team forecasts fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getForecastById = async (req, res, next) => {
  try {
    const data = await forecastService.getForecastById({
      actor: req.currentUser,
      forecastId: req.params.id,
    });

    return res.status(200).json({
      success: true,
      message: "Forecast fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const addAccountForecast = async (req, res, next) => {
  try {
    const data = await forecastService.addAccountForecast({
      actor: req.currentUser,
      forecastId: req.params.forecastId,
      productId: req.params.productId,
      channelId: req.params.channelId,
      body: req.body || {},
    });

    return res.status(201).json({
      success: true,
      message: "Account forecast added successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const updateAccountForecast = async (req, res, next) => {
  try {
    const data = await forecastService.updateAccountForecast({
      actor: req.currentUser,
      forecastId: req.params.forecastId,
      accountForecastId: req.params.accountForecastId,
      body: req.body || {},
    });

    return res.status(200).json({
      success: true,
      message: "Account forecast updated successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const deleteAccountForecast = async (req, res, next) => {
  try {
    const data = await forecastService.deleteAccountForecast({
      actor: req.currentUser,
      forecastId: req.params.forecastId,
      accountForecastId: req.params.accountForecastId,
    });

    return res.status(200).json({
      success: true,
      message: "Account forecast deleted successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const submitForecast = async (req, res, next) => {
  try {
    const data = await forecastService.submitForecast({
      actor: req.currentUser,
      forecastId: req.params.forecastId,
    });

    return res.status(200).json({
      success: true,
      message: "Forecast submitted successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const updateForecastStatus = async (req, res, next) => {
  try {
    const data = await forecastService.updateForecastStatus({
      actor: req.currentUser,
      forecastId: req.params.forecastId,
      forecastStatus: req.body?.forecastStatus || req.body?.status,
    });

    return res.status(200).json({
      success: true,
      message: "Forecast status updated successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const refreshForecast = async (req, res, next) => {
  try {
    const data = await forecastService.refreshForecast({
      actor: req.currentUser,
      year: req.body?.year,
      month: req.body?.month,
      userId: req.body?.userId,
    });

    return res.status(200).json({
      success: true,
      message: "Forecast refreshed successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  addAccountForecast,
  deleteAccountForecast,
  getForecastById,
  getMyForecast,
  getTeamForecasts,
  loadActor,
  refreshForecast,
  submitForecast,
  updateAccountForecast,
  updateForecastStatus,
};
