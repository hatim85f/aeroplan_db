const forecastService = require("../services/forecastService");
const stockService = require("../services/stockService");

const loadActor = async (req, res, next) => {
  try {
    req.currentUser = await forecastService.getCurrentUser(req.user.id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const ok = (res, message, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });

const listStockAccounts = async (req, res, next) => {
  try {
    const data = await stockService.listStockAccounts({
      actor: req.currentUser,
      search: req.query.search,
      status: req.query.status,
    });
    return ok(res, "Stock accounts fetched successfully", data);
  } catch (error) {
    return next(error);
  }
};

const createStockAccount = async (req, res, next) => {
  try {
    const data = await stockService.createStockAccount({ actor: req.currentUser, body: req.body || {} });
    return ok(res, "Stock account created", data, 201);
  } catch (error) {
    return next(error);
  }
};

const deleteStockAccount = async (req, res, next) => {
  try {
    const data = await stockService.deleteStockAccount({
      actor: req.currentUser,
      stockAccountId: req.params.id,
    });
    return ok(res, "Stock account deleted", data);
  } catch (error) {
    return next(error);
  }
};

const getStockAccountDetails = async (req, res, next) => {
  try {
    const data = await stockService.getStockAccountDetails({
      actor: req.currentUser,
      stockAccountId: req.params.id,
    });
    return ok(res, "Stock account fetched successfully", data);
  } catch (error) {
    return next(error);
  }
};

const updateStockAccount = async (req, res, next) => {
  try {
    const data = await stockService.updateStockAccount({
      actor: req.currentUser,
      stockAccountId: req.params.id,
      body: req.body || {},
    });
    return ok(res, "Stock account updated", data);
  } catch (error) {
    return next(error);
  }
};

const addLinkedAccounts = async (req, res, next) => {
  try {
    const data = await stockService.addLinkedAccounts({
      actor: req.currentUser,
      stockAccountId: req.params.id,
      linkedAccountIds: req.body?.linkedAccountIds,
    });
    return ok(res, "Linked accounts updated", data);
  } catch (error) {
    return next(error);
  }
};

const removeLinkedAccount = async (req, res, next) => {
  try {
    const data = await stockService.removeLinkedAccount({
      actor: req.currentUser,
      stockAccountId: req.params.id,
      accountId: req.params.accountId,
    });
    return ok(res, "Linked account removed", data);
  } catch (error) {
    return next(error);
  }
};

const getLatestStock = async (req, res, next) => {
  try {
    const data = await stockService.getLatestStock({
      actor: req.currentUser,
      stockAccountId: req.params.id,
    });
    return ok(res, "Latest stock fetched successfully", data);
  } catch (error) {
    return next(error);
  }
};

const createStockUpdate = async (req, res, next) => {
  try {
    const data = await stockService.createStockUpdate({
      actor: req.currentUser,
      stockAccountId: req.params.id,
      items: req.body?.items,
    });
    return ok(res, "Stock updated successfully", data, 201);
  } catch (error) {
    return next(error);
  }
};

const getHistory = async (req, res, next) => {
  try {
    const data = await stockService.getHistory({
      actor: req.currentUser,
      stockAccountId: req.params.id,
      productId: req.query.productId,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    return ok(res, "Stock history fetched successfully", data);
  } catch (error) {
    return next(error);
  }
};

const getProductHistory = async (req, res, next) => {
  try {
    const data = await stockService.getHistory({
      actor: req.currentUser,
      stockAccountId: req.params.id,
      productId: req.params.productId,
    });
    return ok(res, "Product stock history fetched successfully", data);
  } catch (error) {
    return next(error);
  }
};

const recalculateSalesInflow = async (req, res, next) => {
  try {
    const data = await stockService.recalculateSalesInflow({
      actor: req.currentUser,
      stockAccountId: req.params.id,
    });
    return ok(res, "Sales inflow recalculated", data);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  addLinkedAccounts,
  createStockAccount,
  createStockUpdate,
  deleteStockAccount,
  getHistory,
  getLatestStock,
  getProductHistory,
  getStockAccountDetails,
  listStockAccounts,
  loadActor,
  recalculateSalesInflow,
  removeLinkedAccount,
  updateStockAccount,
};
