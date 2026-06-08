const express = require("express");

const auth = require("../../middleware/auth");
const stockController = require("../../controllers/stockController");

const router = express.Router();

router.get("/", auth, stockController.loadActor, stockController.listStockAccounts);
router.post("/", auth, stockController.loadActor, stockController.createStockAccount);
router.get("/:id", auth, stockController.loadActor, stockController.getStockAccountDetails);
router.patch("/:id", auth, stockController.loadActor, stockController.updateStockAccount);
router.post("/:id/linked-accounts", auth, stockController.loadActor, stockController.addLinkedAccounts);
router.delete("/:id/linked-accounts/:accountId", auth, stockController.loadActor, stockController.removeLinkedAccount);
router.get("/:id/latest", auth, stockController.loadActor, stockController.getLatestStock);
router.post("/:id/updates", auth, stockController.loadActor, stockController.createStockUpdate);
router.get("/:id/history", auth, stockController.loadActor, stockController.getHistory);
router.get("/:id/products/:productId/history", auth, stockController.loadActor, stockController.getProductHistory);
router.post("/:id/recalculate-sales-inflow", auth, stockController.loadActor, stockController.recalculateSalesInflow);

module.exports = router;
