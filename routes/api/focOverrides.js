const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const AccountFocOverride = require("../../models/AccountFocOverride");
const Product = require("../../models/Product");
const { resolveOrgId } = require("../../helpers/tenancy");

const router = express.Router();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const START_DATE_KEYS = ["startDate", "validFrom", "fromDate", "validityStartDate"];
const END_DATE_KEYS = ["endDate", "validTo", "toDate", "validityEndDate"];

const getEntriesInput = (body) => {
  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body.overrides)) {
    return body.overrides;
  }

  if (Array.isArray(body.entries)) {
    return body.entries;
  }

  return undefined;
};

const getFirstDefined = (input = {}, keys = []) => {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
      return input[key];
    }
  }

  return undefined;
};

const parseDate = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalizedValue = String(value).trim();
  const isoDateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateOnlyMatch) {
    const [, year, month, day] = isoDateOnlyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const slashDateMatch = normalizedValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (slashDateMatch) {
    const [, first, second, year] = slashDateMatch;
    const firstNumber = Number(first);
    const secondNumber = Number(second);
    const day = firstNumber > 12 ? firstNumber : secondNumber;
    const month = firstNumber > 12 ? secondNumber : firstNumber;
    return new Date(Date.UTC(Number(year), month - 1, day));
  }

  const date = new Date(normalizedValue);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeValidity = (body = {}, { existing, required = true } = {}) => {
  const entries = getEntriesInput(body) || [];
  const fallbackEntry = entries.find((entry) => (
    getFirstDefined(entry, START_DATE_KEYS) !== undefined
    || getFirstDefined(entry, END_DATE_KEYS) !== undefined
  )) || {};
  const rawStartDate = getFirstDefined(body, START_DATE_KEYS) ?? getFirstDefined(fallbackEntry, START_DATE_KEYS);
  const rawEndDate = getFirstDefined(body, END_DATE_KEYS) ?? getFirstDefined(fallbackEntry, END_DATE_KEYS);
  const hasStartDate = rawStartDate !== undefined;
  const hasEndDate = rawEndDate !== undefined;
  const startDate = hasStartDate ? parseDate(rawStartDate) : existing?.startDate;
  const endDate = hasEndDate ? parseDate(rawEndDate) : existing?.endDate;

  if (required && !startDate) {
    const error = new Error("startDate must be a valid date");
    error.statusCode = 400;
    throw error;
  }

  if (required && !endDate) {
    const error = new Error("endDate must be a valid date");
    error.statusCode = 400;
    throw error;
  }

  if (hasStartDate && !startDate) {
    const error = new Error("startDate must be a valid date");
    error.statusCode = 400;
    throw error;
  }

  if (hasEndDate && !endDate) {
    const error = new Error("endDate must be a valid date");
    error.statusCode = 400;
    throw error;
  }

  if (startDate && endDate && endDate < startDate) {
    const error = new Error("endDate must be on or after startDate");
    error.statusCode = 400;
    throw error;
  }

  const validity = {};

  if (hasStartDate || required) {
    validity.startDate = startDate;
  }

  if (hasEndDate || required) {
    validity.endDate = endDate;
  }

  return validity;
};

const normalizeEntry = (entry = {}, index = 0) => {
  const productId = entry.productId;

  if (!productId || !isValidObjectId(productId)) {
    const error = new Error(`overrides.${index}.productId must be a valid MongoDB ObjectId`);
    error.statusCode = 400;
    throw error;
  }

  const overridePercentage = Number(entry.overridePercentage);

  if (!Number.isFinite(overridePercentage) || overridePercentage < 0) {
    const error = new Error(`overrides.${index}.overridePercentage must be a number greater than or equal to 0`);
    error.statusCode = 400;
    throw error;
  }

  return {
    productId,
    overridePercentage,
    notes: entry.notes,
  };
};

const normalizeEntries = (body) => {
  const entries = getEntriesInput(body);

  if (!Array.isArray(entries) || entries.length === 0) {
    const error = new Error("overrides must be a non-empty array");
    error.statusCode = 400;
    throw error;
  }

  if (entries.length > 500) {
    const error = new Error("overrides cannot contain more than 500 entries");
    error.statusCode = 400;
    throw error;
  }

  return entries.map((entry, index) => normalizeEntry(entry, index));
};

const validateAccountExists = async (accountId) => {
  if (!accountId || !isValidObjectId(accountId)) {
    const error = new Error("accountId must be a valid MongoDB ObjectId");
    error.statusCode = 400;
    throw error;
  }

  const account = await Account.findById(accountId).select("_id");

  if (!account) {
    const error = new Error("Account not found");
    error.statusCode = 404;
    throw error;
  }
};

const validateProductsExist = async (entries) => {
  const productIds = [...new Set(entries.map((entry) => String(entry.productId)))];
  const products = await Product.find({ _id: { $in: productIds } }).select("_id").lean();
  const existingProductIds = new Set(products.map((product) => String(product._id)));
  const missingProductId = productIds.find((productId) => !existingProductIds.has(productId));

  if (missingProductId) {
    const error = new Error(`Product not found: ${missingProductId}`);
    error.statusCode = 400;
    throw error;
  }
};

const populateOverride = (query) => query
  .populate("accountId", "accountName accountType area territory")
  .populate("overrides.productId", "productName productNickname lineId lineName status isActive");

router.get("/", auth, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const query = { organizationId: resolveOrgId(req.user) };

    if (req.query.accountId) {
      if (!isValidObjectId(req.query.accountId)) {
        return res.status(400).json({
          success: false,
          message: "accountId must be a valid MongoDB ObjectId",
        });
      }

      query.accountId = req.query.accountId;
    }

    if (req.query.productId) {
      if (!isValidObjectId(req.query.productId)) {
        return res.status(400).json({
          success: false,
          message: "productId must be a valid MongoDB ObjectId",
        });
      }

      query["overrides.productId"] = req.query.productId;
    }

    const [overrides, total] = await Promise.all([
      populateOverride(
        AccountFocOverride.find(query)
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit),
      ),
      AccountFocOverride.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "FOC overrides fetched successfully",
      data: overrides,
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

router.get("/:accountId", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    const override = await populateOverride(AccountFocOverride.findOne({ accountId: req.params.accountId }));

    if (!override) {
      return res.status(404).json({
        success: false,
        message: "FOC overrides not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "FOC overrides fetched successfully",
      data: override,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", auth, async (req, res, next) => {
  try {
    const accountId = req.body.accountId;
    const entries = normalizeEntries(req.body);
    const validity = normalizeValidity(req.body);

    await validateAccountExists(accountId);
    await validateProductsExist(entries);

    const override = await AccountFocOverride.findOneAndUpdate(
      { accountId },
      {
        $setOnInsert: {
          accountId,
          organizationId: resolveOrgId(req.user),
          createdBy: req.user.id,
        },
        $set: {
          ...validity,
          overrides: entries,
          updatedBy: req.user.id,
        },
      },
      {
        new: true,
        runValidators: true,
        upsert: true,
      },
    );
    const populatedOverride = await populateOverride(AccountFocOverride.findById(override._id));

    return res.status(201).json({
      success: true,
      message: "FOC overrides created successfully",
      data: populatedOverride,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:accountId/entries", auth, async (req, res, next) => {
  try {
    const entries = normalizeEntries(req.body);

    await validateAccountExists(req.params.accountId);
    await validateProductsExist(entries);

    const existing = await AccountFocOverride.findOne({ accountId: req.params.accountId });
    const validity = normalizeValidity(req.body, { existing, required: !existing });

    const override = await AccountFocOverride.findOneAndUpdate(
      { accountId: req.params.accountId },
      {
        $setOnInsert: {
          accountId: req.params.accountId,
          createdBy: req.user.id,
        },
        $set: {
          ...validity,
          updatedBy: req.user.id,
        },
        $push: {
          overrides: { $each: entries },
        },
      },
      {
        new: true,
        runValidators: true,
        upsert: true,
      },
    );
    const populatedOverride = await populateOverride(AccountFocOverride.findById(override._id));

    return res.status(201).json({
      success: true,
      message: "FOC override entries created successfully",
      data: populatedOverride,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:accountId", auth, async (req, res, next) => {
  try {
    const entries = normalizeEntries(req.body);
    const validity = normalizeValidity(req.body);

    await validateAccountExists(req.params.accountId);
    await validateProductsExist(entries);

    const override = await populateOverride(AccountFocOverride.findOneAndUpdate(
      { accountId: req.params.accountId },
      {
        $set: {
          ...validity,
          overrides: entries,
          updatedBy: req.user.id,
        },
        $setOnInsert: {
          accountId: req.params.accountId,
          createdBy: req.user.id,
        },
      },
      {
        new: true,
        runValidators: true,
        upsert: true,
      },
    ));

    return res.status(200).json({
      success: true,
      message: "FOC overrides updated successfully",
      data: override,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:accountId/entries/:entryId", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    if (!isValidObjectId(req.params.entryId)) {
      return res.status(400).json({
        success: false,
        message: "entryId must be a valid MongoDB ObjectId",
      });
    }

    const existing = await AccountFocOverride.findOne({ accountId: req.params.accountId });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "FOC overrides not found",
      });
    }

    const entry = existing.overrides.id(req.params.entryId);

    if (!entry) {
      return res.status(404).json({
        success: false,
        message: "FOC override entry not found",
      });
    }

    const normalizedEntry = normalizeEntry(
      {
        productId: req.body.productId !== undefined ? req.body.productId : entry.productId,
        overridePercentage: req.body.overridePercentage !== undefined
          ? req.body.overridePercentage
          : entry.overridePercentage,
        notes: req.body.notes !== undefined ? req.body.notes : entry.notes,
      },
      0,
    );

    await validateProductsExist([normalizedEntry]);

    entry.set(normalizedEntry);
    existing.updatedBy = req.user.id;
    await existing.save();

    const override = await populateOverride(AccountFocOverride.findById(existing._id));

    return res.status(200).json({
      success: true,
      message: "FOC override entry updated successfully",
      data: override,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:accountId", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    const override = await AccountFocOverride.findOneAndDelete({ accountId: req.params.accountId });

    if (!override) {
      return res.status(404).json({
        success: false,
        message: "FOC overrides not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "FOC overrides deleted successfully",
      data: override,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:accountId/entries/:entryId", auth, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.accountId)) {
      return res.status(400).json({
        success: false,
        message: "accountId must be a valid MongoDB ObjectId",
      });
    }

    if (!isValidObjectId(req.params.entryId)) {
      return res.status(400).json({
        success: false,
        message: "entryId must be a valid MongoDB ObjectId",
      });
    }

    const override = await AccountFocOverride.findOneAndUpdate(
      {
        accountId: req.params.accountId,
        "overrides._id": req.params.entryId,
      },
      {
        $pull: {
          overrides: { _id: req.params.entryId },
        },
        $set: {
          updatedBy: req.user.id,
        },
      },
      { new: true, runValidators: true },
    );

    if (!override) {
      return res.status(404).json({
        success: false,
        message: "FOC override entry not found",
      });
    }

    const populatedOverride = await populateOverride(AccountFocOverride.findById(override._id));

    return res.status(200).json({
      success: true,
      message: "FOC override entry deleted successfully",
      data: populatedOverride,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
