const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const AccountFocOverride = require("../../models/AccountFocOverride");
const Order = require("../../models/Order");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const SalesTeamMember = require("../../models/SalesTeamMember");
const User = require("../../models/User");
const { isManagerRole } = require("../../helpers/roles");
const { canAccessUser } = require("../../helpers/hierarchyAccess");
const { resolveOrgId } = require("../../helpers/tenancy");
const { getDownlineUserIds } = require("../../helpers/hierarchy");
const { notifyUsers } = require("../../helpers/notify");

const router = express.Router();

const ORDER_STATUSES = ["created", "matched_in_sales"];

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const parseDate = (value, fieldName = "date") => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const normalizedValue = String(value).trim();
  const isoDateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateOnlyMatch) {
    const [, year, month, day] = isoDateOnlyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }

  return date;
};

const getCurrentUser = async (req) => User.findById(req.user.id);

const loadOrderActor = async (req, res, next) => {
  const user = await getCurrentUser(req);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  req.currentUser = user;
  return next();
};

const getAccessibleRepIds = async (user) => {
  if (user.role === "admin") {
    return null;
  }

  const userId = String(user._id);

  if (!isManagerRole(user.role)) {
    return [userId];
  }

  return getDownlineUserIds(user._id);
};

const ensureCanAccessOrder = async (user, order) => {
  if (!order) {
    return false;
  }

  if (user.role === "admin") {
    return true;
  }

  if (String(order.medicalRepId) === String(user._id)) {
    return true;
  }

  if (!isManagerRole(user.role)) {
    return false;
  }

  const medicalRep = await User.findById(order.medicalRepId).select("_id path role");
  return canAccessUser(user, medicalRep);
};

const requireManagerOrCreator = async (req, res, order) => {
  if (isManagerRole(req.currentUser.role)) {
    return true;
  }

  if (String(order.createdBy) === String(req.currentUser._id)) {
    return true;
  }

  return res.status(403).json({
    success: false,
    message: "Only managers, admins, or the creator can update this order",
  });
};

const getOrderNumber = async (orderDate) => {
  const year = orderDate.getUTCFullYear();
  const prefix = `ORD-${year}-`;
  const latestOrder = await Order.findOne({ orderNumber: { $regex: `^${prefix}` } })
    .sort({ orderNumber: -1 })
    .select("orderNumber")
    .lean();
  const latestNumber = latestOrder?.orderNumber
    ? parseInt(latestOrder.orderNumber.replace(prefix, ""), 10)
    : 0;

  return `${prefix}${String((latestNumber || 0) + 1).padStart(6, "0")}`;
};

const buildSalesTeamSnapshot = async (salesTeamIds = []) => {
  const uniqueSalesTeamIds = [...new Set((salesTeamIds || []).map((id) => String(id)))];

  if (uniqueSalesTeamIds.length === 0) {
    return {
      salesTeamIds: [],
      salesTeamSnapshot: [],
    };
  }

  const salesTeam = await SalesTeamMember.find({
    _id: { $in: uniqueSalesTeamIds },
  }).select("fullName email phone position").lean();

  return {
    salesTeamIds: salesTeam.map((member) => member._id),
    salesTeamSnapshot: salesTeam.map((member) => ({
      salesTeamMemberId: member._id,
      fullName: member.fullName,
      email: member.email,
      phone: member.phone,
      position: member.position,
    })),
  };
};

const findChannelPricing = (product, channelId) => (product.channelPricing || []).find(
  (pricing) => String(pricing.channelId) === String(channelId) && pricing.isAvailable,
);

const normalizeManualFocPercentage = (item, index) => {
  if (item.focPercentage === undefined || item.focPercentage === null || item.focPercentage === "") {
    return undefined;
  }

  const focPercentage = Number(item.focPercentage);

  if (!Number.isFinite(focPercentage) || focPercentage < 0) {
    const error = new Error(`items.${index}.focPercentage must be a number greater than or equal to 0`);
    error.statusCode = 400;
    throw error;
  }

  return focPercentage;
};

const getFocOverrideForItem = (override, productId, orderDate) => {
  if (!override) {
    return {
      validEntry: null,
      expiredEntry: null,
    };
  }

  const entry = (override.overrides || []).find(
    (overrideEntry) => String(overrideEntry.productId) === String(productId),
  );

  if (!entry) {
    return {
      validEntry: null,
      expiredEntry: null,
    };
  }

  const isValid = override.startDate <= orderDate && override.endDate >= orderDate;

  return {
    validEntry: isValid ? entry : null,
    expiredEntry: isValid ? null : entry,
  };
};

const buildOrderItems = async ({ rawItems, accountId, channelId, orderDate }) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const error = new Error("items must be a non-empty array");
    error.statusCode = 400;
    throw error;
  }

  const productIds = rawItems.map((item, index) => {
    if (!item.productId || !isValidObjectId(item.productId)) {
      const error = new Error(`items.${index}.productId must be a valid MongoDB ObjectId`);
      error.statusCode = 400;
      throw error;
    }

    return String(item.productId);
  });
  const uniqueProductIds = [...new Set(productIds)];
  const [products, accountOverride] = await Promise.all([
    Product.find({
      _id: { $in: uniqueProductIds },
      status: "active",
      isActive: true,
    }).lean(),
    AccountFocOverride.findOne({ accountId }).lean(),
  ]);
  const productsById = new Map(products.map((product) => [String(product._id), product]));
  const warnings = [];

  const items = rawItems.map((item, index) => {
    const quantity = Number(item.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      const error = new Error(`items.${index}.quantity must be a number greater than 0`);
      error.statusCode = 400;
      throw error;
    }

    const product = productsById.get(String(item.productId));

    if (!product) {
      const error = new Error(`Product not found or inactive: ${item.productId}`);
      error.statusCode = 400;
      throw error;
    }

    const channelPricing = findChannelPricing(product, channelId);

    if (!channelPricing) {
      const error = new Error(`${product.productName} is not available in the selected sales channel`);
      error.statusCode = 400;
      throw error;
    }

    const overrideResult = getFocOverrideForItem(accountOverride, product._id, orderDate);
    let focSource = "none";
    let focPercentage = 0;
    let focOverrideId;

    const manualFocPercentage = normalizeManualFocPercentage(item, index);

    if (manualFocPercentage !== undefined) {
      focSource = "manual";
      focPercentage = manualFocPercentage;
    } else if (overrideResult.validEntry) {
      focSource = "override";
      focPercentage = Number(overrideResult.validEntry.overridePercentage) || 0;
      focOverrideId = accountOverride._id;
    } else {
      const defaultFocPercentage = Number(channelPricing.defaultFocPercentage) || 0;
      focPercentage = defaultFocPercentage;
      focSource = defaultFocPercentage > 0 ? "default" : "none";

      if (overrideResult.expiredEntry) {
        warnings.push({
          type: "expired_foc_override",
          message: `This account has a special FOC for ${product.productName}, but it is outside the selected order date. Product default FOC was used.`,
        });
      }
    }

    const unitCifUsd = Number(channelPricing.cifUsd) || 0;
    const unitWholesaleAed = Number(channelPricing.wholesaleAed) || 0;
    const unitRetailAed = Number(channelPricing.retailAed) || 0;

    return {
      productId: product._id,
      productName: product.productName,
      productNickname: product.productNickname,
      quantity,
      focPercentage,
      focQuantity: (quantity * focPercentage) / 100,
      focSource,
      focOverrideId,
      unitCifUsd,
      unitWholesaleAed,
      unitRetailAed,
      totalCifUsd: quantity * unitCifUsd,
      totalWholesaleAed: quantity * unitWholesaleAed,
      totalRetailAed: quantity * unitRetailAed,
    };
  });

  return {
    items,
    warnings,
  };
};

const calculateTotals = (items) => items.reduce((totals, item) => ({
  totalQuantity: totals.totalQuantity + item.quantity,
  totalFocQuantity: totals.totalFocQuantity + item.focQuantity,
  totalCifUsd: totals.totalCifUsd + item.totalCifUsd,
  totalWholesaleAed: totals.totalWholesaleAed + item.totalWholesaleAed,
  totalRetailAed: totals.totalRetailAed + item.totalRetailAed,
}), {
  totalQuantity: 0,
  totalFocQuantity: 0,
  totalCifUsd: 0,
  totalWholesaleAed: 0,
  totalRetailAed: 0,
});

const buildOrderQuery = async (user, queryParams) => {
  const query = { isActive: true, organizationId: resolveOrgId(user) };
  const accessibleRepIds = await getAccessibleRepIds(user);

  if (accessibleRepIds) {
    query.medicalRepId = { $in: accessibleRepIds };
  }

  if (queryParams.medicalRepId) {
    if (!isValidObjectId(queryParams.medicalRepId)) {
      const error = new Error("medicalRepId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    }

    if (accessibleRepIds && !accessibleRepIds.includes(String(queryParams.medicalRepId))) {
      query.medicalRepId = null;
    } else {
      query.medicalRepId = queryParams.medicalRepId;
    }
  }

  if (queryParams.status) {
    const status = String(queryParams.status).trim().toLowerCase();

    if (!ORDER_STATUSES.includes(status)) {
      const error = new Error("status must be created or matched_in_sales");
      error.statusCode = 400;
      throw error;
    }

    query.status = status;
  }

  if (queryParams.accountId) {
    if (!isValidObjectId(queryParams.accountId)) {
      const error = new Error("accountId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    }

    query["account.accountId"] = queryParams.accountId;
  }

  if (queryParams.channelId) {
    if (!isValidObjectId(queryParams.channelId)) {
      const error = new Error("channelId must be a valid MongoDB ObjectId");
      error.statusCode = 400;
      throw error;
    }

    query.channelId = queryParams.channelId;
  }

  if (queryParams.dateFrom || queryParams.dateTo) {
    query.orderDate = {};

    if (queryParams.dateFrom) {
      query.orderDate.$gte = parseDate(queryParams.dateFrom, "dateFrom");
    }

    if (queryParams.dateTo) {
      query.orderDate.$lte = parseDate(queryParams.dateTo, "dateTo");
    }
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { orderNumber: { $regex: search, $options: "i" } },
      { "account.accountName": { $regex: search, $options: "i" } },
      { medicalRepName: { $regex: search, $options: "i" } },
      { channelName: { $regex: search, $options: "i" } },
      { "items.productName": { $regex: search, $options: "i" } },
      { "items.productNickname": { $regex: search, $options: "i" } },
      { notes: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};

const getOrderForAccess = async (orderId, res) => {
  if (!isValidObjectId(orderId)) {
    res.status(400).json({
      success: false,
      message: "Order id must be a valid MongoDB ObjectId",
    });
    return null;
  }

  const order = await Order.findOne({ _id: orderId, isActive: true });

  if (!order) {
    res.status(404).json({
      success: false,
      message: "Order not found",
    });
    return null;
  }

  return order;
};

router.get("/init-data", auth, loadOrderActor, async (req, res, next) => {
  try {
    if (!req.query.accountId || !isValidObjectId(req.query.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    const account = await Account.findById(req.query.accountId)
      .select("accountName accountType area territory salesTeamIds assignedMedicalRepIds")
      .lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const { salesTeamSnapshot } = await buildSalesTeamSnapshot(account.salesTeamIds);
    const availableOrderChannels = await SalesChannel.find({
      status: "active",
      isActive: true,
      allowRepOrders: true,
    }).select("channelName channelKey allowRepOrders focEnabled").sort({ channelName: 1 }).lean();

    return res.status(200).json({
      success: true,
      message: "Order init data fetched successfully",
      data: {
        account: {
          _id: account._id,
          accountName: account.accountName,
          accountType: account.accountType,
          area: account.area,
          territory: account.territory,
          salesTeamIds: account.salesTeamIds || [],
          assignedMedicalRepIds: account.assignedMedicalRepIds || [],
        },
        salesTeam: salesTeamSnapshot.map((member) => ({
          _id: member.salesTeamMemberId,
          fullName: member.fullName,
          email: member.email,
          phone: member.phone,
          position: member.position,
        })),
        availableOrderChannels,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", auth, loadOrderActor, async (req, res, next) => {
  try {
    if (!req.body.accountId || !isValidObjectId(req.body.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    if (!req.body.channelId || !isValidObjectId(req.body.channelId)) {
      return res.status(400).json({
        success: false,
        message: "channelId must be a valid MongoDB ObjectId",
      });
    }

    const orderDate = parseDate(req.body.orderDate, "orderDate") || new Date();
    const [account, channel] = await Promise.all([
      Account.findById(req.body.accountId).lean(),
      SalesChannel.findOne({
        _id: req.body.channelId,
        status: "active",
        isActive: true,
      }).lean(),
    ]);

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    if (!channel) {
      return res.status(404).json({
        success: false,
        message: "Sales channel not found",
      });
    }

    if (!channel.allowRepOrders) {
      return res.status(400).json({
        success: false,
        message: "Orders cannot be created for this sales channel.",
      });
    }

    const salesTeam = await buildSalesTeamSnapshot(account.salesTeamIds);
    const itemResult = await buildOrderItems({
      rawItems: req.body.items,
      accountId: account._id,
      channelId: channel._id,
      orderDate,
    });
    const totals = calculateTotals(itemResult.items);

    let order;
    let attempts = 0;

    while (!order && attempts < 3) {
      attempts += 1;

      try {
        order = await Order.create({
          organizationId: resolveOrgId(req.currentUser),
          orderNumber: await getOrderNumber(orderDate),
          account: {
            accountId: account._id,
            accountName: account.accountName,
            accountCode: account.accountCode || account.accountNameKey,
          },
          medicalRepId: req.currentUser._id,
          medicalRepName: req.currentUser.fullName || req.currentUser.userName || req.currentUser.email,
          ...salesTeam,
          ccSalesTeam: normalizeBoolean(req.body.ccSalesTeam, true),
          ccManagerOrKam: normalizeBoolean(req.body.ccManagerOrKam, false),
          orderDate,
          status: "created",
          notes: req.body.notes,
          channelId: channel._id,
          channelName: channel.channelName,
          channelKey: channel.channelKey,
          items: itemResult.items,
          ...totals,
          createdBy: req.currentUser._id,
          updatedBy: req.currentUser._id,
        });
      } catch (error) {
        if (error.code !== 11000 || attempts >= 3) {
          throw error;
        }
      }
    }

    if (order) {
      // Fire-and-forget: notify the creator's upline managers (plus the
      // on-behalf rep if distinct) that a new order was created.
      const actor = req.currentUser;
      const name = actor.fullName || actor.userName || actor.email || "Someone";
      const recipientIds = [...(actor.path || []), actor.managerId].filter(Boolean);

      if (order.medicalRepId && String(order.medicalRepId) !== String(actor._id)) {
        recipientIds.push(order.medicalRepId);
      }

      notifyUsers({
        from: actor._id,
        recipientIds,
        title: `New order by ${name}`,
        selfTitle: "Your order was created",
        subtitle: order.orderNumber
          ? `${order.orderNumber}`
          : undefined,
        routeName: "Orders",
        payload: { orderId: String(order._id) },
        category: "orders",
      }).catch(() => {});
    }

    return res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: {
        order,
        warnings: itemResult.warnings,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadOrderActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = await buildOrderQuery(req.currentUser, req.query);

    const [orders, total] = await Promise.all([
      Order.find(query).sort({ orderDate: -1, createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadOrderActor, async (req, res, next) => {
  try {
    const order = await getOrderForAccess(req.params.id, res);

    if (!order) {
      return undefined;
    }

    if (!await ensureCanAccessOrder(req.currentUser, order)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to view this order",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Order fetched successfully",
      data: order,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadOrderActor, async (req, res, next) => {
  try {
    const order = await getOrderForAccess(req.params.id, res);

    if (!order) {
      return undefined;
    }

    if (!await ensureCanAccessOrder(req.currentUser, order)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this order",
      });
    }

    const permissionResponse = await requireManagerOrCreator(req, res, order);

    if (permissionResponse !== true) {
      return permissionResponse;
    }

    if (order.status !== "created") {
      return res.status(400).json({
        success: false,
        message: "Only created orders can be updated",
      });
    }

    const update = {};
    let warnings = [];

    if (req.body.orderDate !== undefined) {
      update.orderDate = parseDate(req.body.orderDate, "orderDate");
      const itemResult = await buildOrderItems({
        rawItems: order.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          focPercentage: item.focSource === "manual" ? item.focPercentage : undefined,
        })),
        accountId: order.account.accountId,
        channelId: order.channelId,
        orderDate: update.orderDate,
      });

      update.items = itemResult.items;
      Object.assign(update, calculateTotals(itemResult.items));
      warnings = itemResult.warnings;
    }

    if (req.body.notes !== undefined) {
      update.notes = req.body.notes;
    }

    if (req.body.ccSalesTeam !== undefined) {
      update.ccSalesTeam = normalizeBoolean(req.body.ccSalesTeam);
    }

    if (req.body.ccManagerOrKam !== undefined) {
      update.ccManagerOrKam = normalizeBoolean(req.body.ccManagerOrKam);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one basic order field is required to update",
      });
    }

    update.updatedBy = req.currentUser._id;

    const updatedOrder = await Order.findByIdAndUpdate(
      order._id,
      { $set: update },
      { new: true, runValidators: true },
    );

    return res.status(200).json({
      success: true,
      message: "Order updated successfully",
      data: {
        order: updatedOrder,
        warnings,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadOrderActor, async (req, res, next) => {
  try {
    if (!isManagerRole(req.currentUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Only managers can update order status",
      });
    }

    const status = String(req.body.status || "").trim().toLowerCase();

    if (status !== "matched_in_sales") {
      return res.status(400).json({
        success: false,
        message: "Only matched_in_sales status is supported",
      });
    }

    const order = await getOrderForAccess(req.params.id, res);

    if (!order) {
      return undefined;
    }

    if (!await ensureCanAccessOrder(req.currentUser, order)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this order",
      });
    }

    order.status = status;
    order.salesSheetMatchedAt = req.body.salesSheetMatchedAt
      ? parseDate(req.body.salesSheetMatchedAt, "salesSheetMatchedAt")
      : new Date();
    order.salesSheetReference = req.body.salesSheetReference;
    order.matchedSalesRecordId = req.body.matchedSalesRecordId;
    order.updatedBy = req.currentUser._id;
    await order.save();

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: order,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/mark-email-sent", auth, loadOrderActor, async (req, res, next) => {
  try {
    const order = await getOrderForAccess(req.params.id, res);

    if (!order) {
      return undefined;
    }

    if (!await ensureCanAccessOrder(req.currentUser, order)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to update this order",
      });
    }

    const permissionResponse = await requireManagerOrCreator(req, res, order);

    if (permissionResponse !== true) {
      return permissionResponse;
    }

    order.emailSentAt = req.body.emailSentAt ? parseDate(req.body.emailSentAt, "emailSentAt") : new Date();
    order.updatedBy = req.currentUser._id;
    await order.save();

    return res.status(200).json({
      success: true,
      message: "Order email sent timestamp updated successfully",
      data: order,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadOrderActor, async (req, res, next) => {
  try {
    if (!isManagerRole(req.currentUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Only managers can delete orders",
      });
    }

    const order = await getOrderForAccess(req.params.id, res);

    if (!order) {
      return undefined;
    }

    if (!await ensureCanAccessOrder(req.currentUser, order)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this order",
      });
    }

    order.isActive = false;
    order.updatedBy = req.currentUser._id;
    await order.save();

    return res.status(200).json({
      success: true,
      message: "Order deleted successfully",
      data: order,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
