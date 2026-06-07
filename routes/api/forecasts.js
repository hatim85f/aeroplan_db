const express = require("express");

const auth = require("../../middleware/auth");
const forecastController = require("../../controllers/forecastController");

const router = express.Router();

router.get("/my", auth, forecastController.loadActor, forecastController.getMyForecast);
router.get("/team", auth, forecastController.loadActor, forecastController.getTeamForecasts);
router.post("/refresh", auth, forecastController.loadActor, forecastController.refreshForecast);
router.get("/:id", auth, forecastController.loadActor, forecastController.getForecastById);
router.post(
  "/:forecastId/items/:productId/channels/:channelId/accounts",
  auth,
  forecastController.loadActor,
  forecastController.addAccountForecast,
);
router.patch(
  "/:forecastId/account-forecasts/:accountForecastId",
  auth,
  forecastController.loadActor,
  forecastController.updateAccountForecast,
);
router.delete(
  "/:forecastId/account-forecasts/:accountForecastId",
  auth,
  forecastController.loadActor,
  forecastController.deleteAccountForecast,
);
router.post("/:forecastId/submit", auth, forecastController.loadActor, forecastController.submitForecast);
router.patch("/:forecastId/status", auth, forecastController.loadActor, forecastController.updateForecastStatus);

module.exports = router;
