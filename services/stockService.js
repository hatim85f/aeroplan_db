const mongoose = require("mongoose");

const Account = require("../models/Account");
const Product = require("../models/Product");
const SalesRecord = require("../models/SalesRecord");
const StockAccount = require("../models/StockAccount");
const StockUpdate = require("../models/StockUpdate");
const { isManagerRole } = require("../helpers/roles");

const makeError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const getDisplayName = (user = {}) =>
  user.fullName || user.userName || user.email || "User";

/**
 * Visibility scope:
 * - admin: everything
 * - manager: stock accounts under their management (managerId) or created by them
 * - rep: stock accounts under their manager's scope or created by them
 */
const buildScopeQuery = (actor) => {
  if (actor.role === "admin") return {};

  if (isManagerRole(actor.role)) {
    return { $or: [{ managerId: actor._id }, { createdBy: actor._id }] };
  }

  const branches = [{ createdBy: actor._id }];
  if (actor.managerId) branches.push({ managerId: actor.managerId });
  if (actor.teamId) branches.push({ teamId: actor.teamId });
  return { $or: branches };
};

const getScopedStockAccount = async (actor, stockAccountId) => {
  if (!isValidObjectId(stockAccountId)) {
    throw makeError("Stock account id must be a valid MongoDB ObjectId", 400);
  }

  const stockAccount = await StockAccount.findOne({
    _id: stockAccountId,
    isActive: true,
    ...buildScopeQuery(actor),
  });

  if (!stockAccount) {
    throw makeError("Stock account not found", 404);
  }

  return stockAccount;
};

/** All account ids whose sales feed this stock account. */
const getFeedingAccountIds = (stockAccount) => {
  const ids = new Set((stockAccount.linkedAccountIds || []).map(String));
  if (stockAccount.accountId) ids.add(String(stockAccount.accountId));
  return [...ids];
};

/** Latest stored item per product across this account's updates (bulk). */
const getLatestItemsByProduct = async (stockAccountId) => {
  const updates = await StockUpdate.find({
    stockAccountId,
    isActive: true,
    status: "active",
  })
    .sort({ updateDate: -1 })
    .select("updateDate updatedBy updatedByName items")
    .lean();

  const latest = new Map(); // productId -> { item, updateDate, updatedByName }

  updates.forEach((update) => {
    (update.items || []).forEach((item) => {
      const key = String(item.productId);
      if (!latest.has(key)) {
        latest.set(key, {
          item,
          updateDate: update.updateDate,
          updatedBy: update.updatedBy,
          updatedByName: update.updatedByName,
        });
      }
    });
  });

  return { latest, updates };
};

/**
 * Sales inflow (qty + FOC) per product from the linked accounts, counted
 * strictly AFTER each product's given date (exclusive) so repeated refreshes
 * never double-count. Returns Map(productId -> inflow).
 */
const getSalesInflowByProduct = async ({ feedingAccountIds, productIds, sinceByProduct, untilByProduct = new Map() }) => {
  if (!feedingAccountIds.length || !productIds.length) return new Map();

  // One bulk query covering the oldest "since" date; filtered per product below.
  const sinceDates = productIds
    .map((productId) => sinceByProduct.get(String(productId)))
    .filter(Boolean)
    .map((date) => new Date(date).getTime());
  const oldestSince = sinceDates.length ? new Date(Math.min(...sinceDates)) : null;

  const query = {
    accountId: { $in: feedingAccountIds },
    productId: { $in: productIds },
    status: "active",
    isActive: true,
  };

  if (oldestSince) query.salesDate = { $gt: oldestSince };

  const records = await SalesRecord.find(query)
    .select("productId salesDate quantity freeQuantity")
    .lean();

  const inflow = new Map();

  records.forEach((record) => {
    const key = String(record.productId);
    const since = sinceByProduct.get(key);
    if (!since) return; // no previous update for this product → inflow 0 (first entry stays simple)
    if (!record.salesDate || new Date(record.salesDate).getTime() <= new Date(since).getTime()) return;
    const until = untilByProduct.get(key);
    if (until && new Date(record.salesDate).getTime() > new Date(until).getTime()) return;
    const qty = (Number(record.quantity) || 0) + (Number(record.freeQuantity) || 0);
    inflow.set(key, (inflow.get(key) || 0) + qty);
  });

  return inflow;
};

const movementStatusOf = (latestItems) => {
  if (!latestItems.length) return "no_movement_yet";
  const hasNegative = latestItems.some((entry) => Number(entry.item.movementQty) < 0);
  const hasPositive = latestItems.some((entry) => Number(entry.item.movementQty) > 0);
  if (hasNegative && hasPositive) return "needs_review";
  if (hasNegative) return "negative";
  if (hasPositive) return "positive";
  return "stable";
};

/* ── Stock accounts CRUD ───────────────────────────── */

const listStockAccounts = async ({ actor, search, status }) => {
  const query = { isActive: true, ...buildScopeQuery(actor) };
  if (status && ["active", "inactive"].includes(status)) query.status = status;
  if (search) query.accountName = { $regex: String(search).trim(), $options: "i" };

  const stockAccounts = await StockAccount.find(query)
    .sort({ accountName: 1 })
    .limit(500)
    .lean();

  // Bulk: latest update per stock account.
  const ids = stockAccounts.map((entry) => entry._id);
  const updates = ids.length
    ? await StockUpdate.find({ stockAccountId: { $in: ids }, isActive: true, status: "active" })
      .sort({ updateDate: -1 })
      .select("stockAccountId updateDate updatedByName items")
      .lean()
    : [];

  const latestByAccount = new Map(); // stockAccountId -> { latestItems Map, lastUpdate }
  updates.forEach((update) => {
    const key = String(update.stockAccountId);
    let entry = latestByAccount.get(key);
    if (!entry) {
      entry = { lastUpdate: update, latestItems: new Map() };
      latestByAccount.set(key, entry);
    }
    (update.items || []).forEach((item) => {
      const productKey = String(item.productId);
      if (!entry.latestItems.has(productKey)) {
        entry.latestItems.set(productKey, { item });
      }
    });
  });

  return stockAccounts.map((stockAccount) => {
    const entry = latestByAccount.get(String(stockAccount._id));
    const latestItems = entry ? [...entry.latestItems.values()] : [];
    return {
      stockAccountId: stockAccount._id,
      accountName: stockAccount.accountName,
      isCustomAccount: stockAccount.isCustomAccount,
      status: stockAccount.status,
      linkedAccountsCount: (stockAccount.linkedAccountIds || []).length,
      linkedAccountNames: stockAccount.linkedAccountNames || [],
      itemsCount: latestItems.length,
      lastUpdatedAt: entry?.lastUpdate?.updateDate || null,
      lastUpdatedBy: entry?.lastUpdate?.updatedByName || null,
      movementStatus: movementStatusOf(latestItems),
    };
  });
};

const createStockAccount = async ({ actor, body }) => {
  const accountId = body.accountId && isValidObjectId(body.accountId) ? body.accountId : null;
  let accountName = String(body.accountName || "").trim();
  let isCustomAccount = Boolean(body.isCustomAccount);

  if (accountId) {
    const account = await Account.findById(accountId).select("_id accountName").lean();
    if (!account) throw makeError("Selected account not found", 404);
    accountName = accountName || account.accountName;
    isCustomAccount = false;
  }

  if (!accountName) {
    throw makeError("Select an existing account or enter a custom account name", 400);
  }

  const linkedAccountIds = Array.isArray(body.linkedAccountIds)
    ? body.linkedAccountIds.filter(isValidObjectId)
    : [];
  const linkedAccounts = linkedAccountIds.length
    ? await Account.find({ _id: { $in: linkedAccountIds } }).select("_id accountName").lean()
    : [];

  const stockAccount = await StockAccount.create({
    accountId,
    accountName,
    isCustomAccount: !accountId,
    linkedAccountIds: linkedAccounts.map((account) => account._id),
    linkedAccountNames: linkedAccounts.map((account) => account.accountName),
    teamId: actor.teamId || undefined,
    managerId: isManagerRole(actor.role) ? actor._id : (actor.managerId || actor._id),
    createdBy: actor._id,
    updatedBy: actor._id,
  });

  return stockAccount;
};

const updateStockAccount = async ({ actor, stockAccountId, body }) => {
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);

  if (body.accountName !== undefined) {
    const name = String(body.accountName).trim();
    if (!name) throw makeError("accountName cannot be empty", 400);
    stockAccount.accountName = name;
  }

  if (body.status !== undefined) {
    if (!["active", "inactive"].includes(body.status)) {
      throw makeError("status must be active or inactive", 400);
    }
    stockAccount.status = body.status;
  }

  if (body.linkedAccountIds !== undefined) {
    assertCanManageLinks(actor);
    const linkedAccountIds = Array.isArray(body.linkedAccountIds)
      ? body.linkedAccountIds.filter(isValidObjectId)
      : [];
    const linkedAccounts = await Account.find({ _id: { $in: linkedAccountIds } }).select("_id accountName").lean();
    stockAccount.linkedAccountIds = linkedAccounts.map((account) => account._id);
    stockAccount.linkedAccountNames = linkedAccounts.map((account) => account.accountName);
  }

  stockAccount.updatedBy = actor._id;
  await stockAccount.save();
  return stockAccount;
};

const assertCanManageLinks = (actor) => {
  if (!isManagerRole(actor.role)) {
    throw makeError("Only managers can manage linked accounts", 403);
  }
};

const addLinkedAccounts = async ({ actor, stockAccountId, linkedAccountIds }) => {
  assertCanManageLinks(actor);
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);

  const ids = Array.isArray(linkedAccountIds) ? linkedAccountIds.filter(isValidObjectId) : [];
  if (!ids.length) throw makeError("linkedAccountIds must contain at least one valid account", 400);

  const accounts = await Account.find({ _id: { $in: ids } }).select("_id accountName").lean();
  const existing = new Set((stockAccount.linkedAccountIds || []).map(String));

  accounts.forEach((account) => {
    if (existing.has(String(account._id))) return;
    stockAccount.linkedAccountIds.push(account._id);
    stockAccount.linkedAccountNames.push(account.accountName);
  });

  stockAccount.updatedBy = actor._id;
  await stockAccount.save();
  return stockAccount;
};

const removeLinkedAccount = async ({ actor, stockAccountId, accountId }) => {
  assertCanManageLinks(actor);
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);

  if (!isValidObjectId(accountId)) {
    throw makeError("accountId must be a valid MongoDB ObjectId", 400);
  }

  const index = (stockAccount.linkedAccountIds || []).findIndex((id) => String(id) === String(accountId));
  if (index === -1) throw makeError("Linked account not found on this stock account", 404);

  stockAccount.linkedAccountIds.splice(index, 1);
  stockAccount.linkedAccountNames.splice(index, 1);
  stockAccount.updatedBy = actor._id;
  await stockAccount.save();
  return stockAccount;
};

/* ── Latest / details / history ────────────────────── */

const buildLatestList = async (stockAccount) => {
  const { latest } = await getLatestItemsByProduct(stockAccount._id);

  return [...latest.values()]
    .map((entry) => ({
      productId: entry.item.productId,
      productName: entry.item.productName,
      productNickname: entry.item.productNickname,
      currentStock: round2(entry.item.currentStock),
      previousStock: round2(entry.item.previousStock),
      addedFromSales: round2(entry.item.addedFromSales),
      adjustmentQuantity: round2(entry.item.adjustmentQuantity),
      adjustmentNote: entry.item.adjustmentNote || "",
      expectedStock: round2(entry.item.expectedStock),
      movementQty: round2(entry.item.movementQty),
      notes: entry.item.notes || "",
      lastUpdatedAt: entry.updateDate,
      lastUpdatedBy: entry.updatedByName || "",
    }))
    .sort((left, right) => String(left.productNickname || left.productName || "")
      .localeCompare(String(right.productNickname || right.productName || ""), undefined, { sensitivity: "base" }));
};

const getStockAccountDetails = async ({ actor, stockAccountId }) => {
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);
  const latestList = await buildLatestList(stockAccount);

  const lastUpdate = await StockUpdate.findOne({
    stockAccountId: stockAccount._id,
    isActive: true,
    status: "active",
  }).sort({ updateDate: -1 }).select("updateDate updatedByName").lean();

  return {
    stockAccount: {
      stockAccountId: stockAccount._id,
      accountId: stockAccount.accountId,
      accountName: stockAccount.accountName,
      isCustomAccount: stockAccount.isCustomAccount,
      status: stockAccount.status,
      linkedAccounts: (stockAccount.linkedAccountIds || []).map((id, index) => ({
        accountId: id,
        accountName: stockAccount.linkedAccountNames?.[index] || "Account",
      })),
    },
    summary: {
      itemsCount: latestList.length,
      negativeMovementCount: latestList.filter((item) => item.movementQty < 0).length,
      addedFromSalesTotal: round2(latestList.reduce((sum, item) => sum + item.addedFromSales, 0)),
      lastUpdatedAt: lastUpdate?.updateDate || null,
      lastUpdatedBy: lastUpdate?.updatedByName || null,
      movementStatus: movementStatusOf(latestList.map((item) => ({ item }))),
    },
    latest: latestList,
  };
};

const getLatestStock = async ({ actor, stockAccountId }) => {
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);
  return buildLatestList(stockAccount);
};

const getHistory = async ({ actor, stockAccountId, productId, dateFrom, dateTo }) => {
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);

  const query = { stockAccountId: stockAccount._id, isActive: true, status: "active" };
  if (dateFrom) query.updateDate = { ...(query.updateDate || {}), $gte: new Date(dateFrom) };
  if (dateTo) query.updateDate = { ...(query.updateDate || {}), $lte: new Date(dateTo) };
  if (productId && isValidObjectId(productId)) query["items.productId"] = productId;

  const updates = await StockUpdate.find(query)
    .sort({ updateDate: -1 })
    .limit(200)
    .lean();

  return updates.map((update) => ({
    updateId: update._id,
    updateDate: update.updateDate,
    updatedBy: update.updatedBy,
    updatedByName: update.updatedByName,
    items: (update.items || [])
      .filter((item) => !productId || String(item.productId) === String(productId))
      .map((item) => ({
        productId: item.productId,
        productName: item.productName,
        productNickname: item.productNickname,
        currentStock: round2(item.currentStock),
        previousStock: round2(item.previousStock),
        addedFromSales: round2(item.addedFromSales),
        adjustmentQuantity: round2(item.adjustmentQuantity),
        adjustmentNote: item.adjustmentNote || "",
        expectedStock: round2(item.expectedStock),
        movementQty: round2(item.movementQty),
        notes: item.notes || "",
      })),
  }));
};

/* ── Create stock update (the core flow) ───────────── */

const createStockUpdate = async ({ actor, stockAccountId, items }) => {
  const stockAccount = await getScopedStockAccount(actor, stockAccountId);

  if (!Array.isArray(items) || !items.length) {
    throw makeError("items array is required", 400);
  }

  // Validate inputs + reject duplicate products in the same request.
  const seenProducts = new Set();
  for (const item of items) {
    if (!item.productId || !isValidObjectId(item.productId)) {
      throw makeError("productId is required for every item", 400);
    }
    if (seenProducts.has(String(item.productId))) {
      throw makeError("Product already added in this update", 400);
    }
    seenProducts.add(String(item.productId));

    const currentStock = Number(item.currentStock);
    if (item.currentStock === undefined || item.currentStock === null || item.currentStock === "" || !Number.isFinite(currentStock)) {
      throw makeError("Current stock is required for every item", 400);
    }
    if (currentStock < 0) {
      throw makeError("Current stock cannot be negative", 400);
    }

    const adjustment = Number(item.adjustmentQuantity || 0);
    if (!Number.isFinite(adjustment)) {
      throw makeError("Adjustment must be a valid number", 400);
    }
    if (adjustment !== 0 && !String(item.adjustmentNote || "").trim()) {
      throw makeError("Adjustment note is required when an adjustment is entered", 400);
    }
  }

  const productIds = items.map((item) => item.productId);

  // Bulk loads: products, latest items, sales inflow.
  const [products, { latest }] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).select("_id productName productNickname").lean(),
    getLatestItemsByProduct(stockAccount._id),
  ]);
  const productsById = new Map(products.map((product) => [String(product._id), product]));

  const sinceByProduct = new Map();
  productIds.forEach((productId) => {
    const previous = latest.get(String(productId));
    if (previous) sinceByProduct.set(String(productId), previous.updateDate);
  });

  const inflow = await getSalesInflowByProduct({
    feedingAccountIds: getFeedingAccountIds(stockAccount),
    productIds,
    sinceByProduct,
  });

  const updateItems = items.map((item) => {
    const key = String(item.productId);
    const product = productsById.get(key);
    if (!product) throw makeError("One of the selected products was not found", 404);

    const previousEntry = latest.get(key);
    const previousStock = previousEntry ? Number(previousEntry.item.currentStock) || 0 : 0;
    const addedFromSales = round2(inflow.get(key) || 0);
    const adjustmentQuantity = round2(Number(item.adjustmentQuantity) || 0);
    const currentStock = round2(Number(item.currentStock));
    const expectedStock = round2(previousStock + addedFromSales + adjustmentQuantity);

    return {
      productId: product._id,
      productName: product.productName,
      productNickname: product.productNickname,
      currentStock,
      previousStock: round2(previousStock),
      addedFromSales,
      adjustmentQuantity,
      adjustmentNote: String(item.adjustmentNote || "").trim(),
      expectedStock,
      movementQty: round2(currentStock - expectedStock),
      notes: String(item.notes || "").trim(),
    };
  });

  const stockUpdate = await StockUpdate.create({
    stockAccountId: stockAccount._id,
    stockAccountName: stockAccount.accountName,
    updateDate: new Date(),
    updatedBy: actor._id,
    updatedByName: getDisplayName(actor),
    teamId: stockAccount.teamId,
    managerId: stockAccount.managerId,
    items: updateItems,
  });

  return stockUpdate;
};

/* ── Manager-only: refresh sales inflow on the latest figures ── */

const recalculateSalesInflow = async ({ actor, stockAccountId }) => {
  if (!isManagerRole(actor.role)) {
    throw makeError("Only managers can recalculate sales inflow", 403);
  }

  const stockAccount = await getScopedStockAccount(actor, stockAccountId);
  const { latest, updates } = await getLatestItemsByProduct(stockAccount._id);

  if (!latest.size) return { recalculated: 0 };

  // For each product's LATEST item, recount inflow between the previous
  // update of that product and the latest one, then refresh expected/movement.
  const previousDateByProduct = new Map();
  latest.forEach((entry, productKey) => {
    const olderUpdate = updates.find((update) => (
      new Date(update.updateDate).getTime() < new Date(entry.updateDate).getTime()
      && (update.items || []).some((item) => String(item.productId) === productKey)
    ));
    if (olderUpdate) previousDateByProduct.set(productKey, olderUpdate.updateDate);
  });

  const untilByProduct = new Map();
  latest.forEach((entry, productKey) => untilByProduct.set(productKey, entry.updateDate));

  const inflow = await getSalesInflowByProduct({
    feedingAccountIds: getFeedingAccountIds(stockAccount),
    productIds: [...latest.keys()],
    sinceByProduct: previousDateByProduct,
    untilByProduct,
  });

  let recalculated = 0;

  for (const [productKey, entry] of latest.entries()) {
    if (!previousDateByProduct.has(productKey)) continue;

    const update = await StockUpdate.findOne({
      stockAccountId: stockAccount._id,
      updateDate: entry.updateDate,
      "items.productId": productKey,
      isActive: true,
    });
    if (!update) continue;

    const item = update.items.find((candidate) => String(candidate.productId) === productKey);
    if (!item) continue;

    const counted = inflow.get(productKey);
    // Cap at the latest update date — sales after the snapshot belong to the next update.
    const upTo = (counted || 0);
    const addedFromSales = round2(upTo);

    if (addedFromSales === item.addedFromSales) continue;

    item.addedFromSales = addedFromSales;
    item.expectedStock = round2(item.previousStock + addedFromSales + (item.adjustmentQuantity || 0));
    item.movementQty = round2(item.currentStock - item.expectedStock);
    update.updatedBy = actor._id;
    await update.save();
    recalculated += 1;
  }

  return { recalculated };
};

module.exports = {
  addLinkedAccounts,
  createStockAccount,
  createStockUpdate,
  getHistory,
  getLatestStock,
  getStockAccountDetails,
  listStockAccounts,
  recalculateSalesInflow,
  removeLinkedAccount,
  updateStockAccount,
};
