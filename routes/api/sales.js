const express = require("express");
const mongoose = require("mongoose");
const auth = require("../../middleware/auth");
const Account = require("../../models/Account");
const Area = require("../../models/Area");
const Order = require("../../models/Order");
const Product = require("../../models/Product");
const SalesChannel = require("../../models/SalesChannel");
const SalesDetectionRule = require("../../models/SalesDetectionRule");
const SalesRecord = require("../../models/SalesRecord");
const SalesSheetMapping = require("../../models/SalesSheetMapping");
const SalesUploadBatch = require("../../models/SalesUploadBatch");
const TargetAssignment = require("../../models/TargetAssignment");
const User = require("../../models/User");
const { applySharedSalesToRecord, recalculateSharedSales, recalculateSharedSalesOptimized } = require("../../helpers/sharedSales");
const { buildDuplicateKey, cleanupDuplicateSalesRecords } = require("../../helpers/salesDuplicateCleanup");
const { isManagerRole } = require("../../helpers/roles");

const router = express.Router();

const MATCH_STATUSES = ["unmatched", "partially_matched", "matched", "needs_review"];
const RECORD_STATUSES = ["active", "ignored", "duplicate", "error"];
const MAPPING_STATUSES = ["active", "inactive"];
const DETECTION_RULE_STATUSES = ["active", "inactive"];
const ACCOUNT_MATCH_SOURCES = ["shipToAccountName", "accountName", "auto"];
const UPLOAD_MODES = ["override", "amend"];
const PRICE_MATCH_PERCENT_TOLERANCE = 0.15;
const PRICE_MATCH_ABSOLUTE_TOLERANCE = 0.75;
const PRICE_FIELDS = [
  { field: "cifUsd", currency: "USD" },
  { field: "wholesaleAed", currency: "AED" },
  { field: "retailAed", currency: "AED" },
];
const CHANNEL_TYPE_FIELD_KEYS = [
  "channelType",
  "marketType",
  "salesChannelType",
  "customerType",
  "privateInstitution",
  "privateOrInstitution",
  "salesType",
  "type",
  "sector",
];
const CHANNEL_TYPE_ALIASES = {
  private: {
    channelGroup: "private",
  },
  direct: {
    channelGroup: "private",
  },
  private_sales: {
    channelGroup: "private",
  },
  private_sale: {
    channelGroup: "private",
  },
  prv: {
    channelGroup: "private",
  },
  pvt: {
    channelGroup: "private",
  },
  institution: {
    channelGroup: "institution",
  },
  institutional: {
    channelGroup: "institution",
  },
  institute: {
    channelGroup: "institution",
  },
  inst: {
    channelGroup: "institution",
  },
  tender: {
    channelGroup: "tender",
  },
  government: {
    channelGroup: "government",
  },
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const normalizeText = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const getTextTokens = (value) => normalizeText(value).split(" ").filter(Boolean);

const inferAccountType = (accountName) => {
  const normalizedName = normalizeText(accountName);

  if (normalizedName.includes("hospital")) {
    return "hospital";
  }

  if (normalizedName.includes("pharmacy")) {
    return "pharmacy";
  }

  if (normalizedName.includes("drug")) {
    return "drugstore";
  }

  if (normalizedName.includes("clinic") || normalizedName.includes("medical center")) {
    return "clinic";
  }

  return "other";
};

const getAccountSimilarityScore = (input, accountName) => {
  const inputTokens = getTextTokens(input);
  const accountTokens = getTextTokens(accountName);

  if (inputTokens.length === 0 || accountTokens.length === 0) {
    return 0;
  }

  const commonTokens = inputTokens.filter((token) => accountTokens.includes(token));
  const tokenScore = commonTokens.length / inputTokens.length;
  const normalizedInput = normalizeText(input);
  const normalizedAccount = normalizeText(accountName);
  const containsScore = normalizedAccount.includes(normalizedInput) || normalizedInput.includes(normalizedAccount) ? 1 : 0;

  return Math.max(tokenScore, containsScore);
};

const isPlaceholderText = (value) => normalizeText(value).includes("placeholder");

const getAccountMatchPriority = (account) => {
  let priority = 0;

  if (account?.keyContact && !isPlaceholderText(account.keyContact)) priority += 4;
  if (account?.area && !isPlaceholderText(account.area)) priority += 3;
  if (account?.territory && !isPlaceholderText(account.territory)) priority += 3;
  if (account?.location?.address && !isPlaceholderText(account.location.address)) priority += 2;
  if (Array.isArray(account?.salesTeamIds) && account.salesTeamIds.length > 0) priority += 2;
  if (Array.isArray(account?.assignedMedicalRepIds) && account.assignedMedicalRepIds.length > 0) priority += 1;

  return priority;
};

const getBestAccountMatch = (matches = []) => {
  if (matches.length <= 1) {
    return matches[0] || null;
  }

  const sortedMatches = [...matches].sort((left, right) => (
    getAccountMatchPriority(right) - getAccountMatchPriority(left)
    || new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0)
  ));

  return sortedMatches[0];
};

const normalizeKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const normalizeBoolean = (value, defaultValue) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() === "true";
};

const parseNumber = (value, defaultValue = 0) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  // Tolerate formatted sheet values like "1,160" or " 75 " that would
  // otherwise become NaN and silently fall back to the default.
  const number = typeof value === "number" ? value : Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(number) ? number : defaultValue;
};

const parseExcelSerialDate = (value) => {
  const serial = Number(value);

  if (!Number.isFinite(serial) || serial < 1 || serial > 100000) {
    return null;
  }

  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  const date = new Date(utcValue * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
};

const parseDate = (value, fieldName = "date", options = {}) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const normalizedValue = String(value).trim();
  const excelSerialDate = parseExcelSerialDate(normalizedValue);

  if (excelSerialDate) {
    return excelSerialDate;
  }

  const isoDateOnlyMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateOnlyMatch) {
    const [, year, month, day] = isoDateOnlyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const slashDateMatch = normalizedValue.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);

  if (slashDateMatch) {
    const [, firstPart, secondPart, yearPart] = slashDateMatch;
    const year = Number(yearPart.length === 2 ? `20${yearPart}` : yearPart);
    const first = Number(firstPart);
    const second = Number(secondPart);
    const isAmbiguous = first <= 12 && second <= 12;
    const useDayFirst = first > 12 || (isAmbiguous && options.preferDayFirst);
    const day = useDayFirst ? first : second;
    const month = useDayFirst ? second : first;

    return new Date(Date.UTC(year, month - 1, day));
  }

  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }

  return date;
};

const getSalesRecordEffectiveDate = (record) => {
  if (!record?.salesDate) return null;

  const salesDate = new Date(record.salesDate);

  if (Number.isNaN(salesDate.getTime())) return null;

  const month = Number(record.month);
  const year = Number(record.year);

  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
    return salesDate;
  }

  const storedMonth = salesDate.getUTCMonth() + 1;
  const storedDay = salesDate.getUTCDate();

  // Existing UAE sales uploads may have parsed DD/MM/YYYY as MM/DD/YYYY.
  // If the uploaded month disagrees with salesDate but the stored day equals
  // the uploaded month, treat the stored month as the intended day.
  if (storedMonth !== month && storedDay === month && storedMonth >= 1 && storedMonth <= 31) {
    return new Date(Date.UTC(year, month - 1, storedMonth));
  }

  return salesDate;
};

const getCurrentUser = async (req) => User.findById(req.user.id);

const loadSalesActor = async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    req.currentUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

const requireManager = (req, res, next) => {
  if (!isManagerRole(req.currentUser.role)) {
    return res.status(403).json({
      success: false,
      message: "Only managers can manage sales data",
    });
  }

  return next();
};

const getScopedUserIds = async (user) => {
  if (user.role === "admin") {
    return null;
  }

  if (!isManagerRole(user.role)) {
    return [user._id];
  }

  const scopedUsers = await User.find({
    $or: [
      { _id: user._id },
      { path: user._id },
    ],
  }).select("_id").lean();

  return scopedUsers.map((scopedUser) => scopedUser._id);
};

const normalizeObjectIdList = (values = []) => values
  .map((value) => value?._id || value)
  .filter((value) => isValidObjectId(value))
  .map((value) => new mongoose.Types.ObjectId(value));

const getRepresentativeManagerIds = (user) => {
  const hierarchyIds = [
    ...(Array.isArray(user.path) ? user.path : []),
    user.managerId,
  ].filter(Boolean);
  const seen = new Set();

  return normalizeObjectIdList(hierarchyIds).filter((id) => {
    const key = String(id);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const getVisibleUploaderIds = async (user) => {
  if (user.role === "admin") {
    return null;
  }

  if (isManagerRole(user.role)) {
    return getScopedUserIds(user);
  }

  return getRepresentativeManagerIds(user);
};

const getDownlineUserIds = async (managerId) => {
  if (!isValidObjectId(managerId)) {
    return [];
  }

  const managerObjectId = new mongoose.Types.ObjectId(managerId);
  const users = await User.find({
    $or: [
      { _id: managerObjectId },
      { path: managerObjectId },
    ],
  }).select("_id").lean();

  return users.map((user) => user._id);
};

const filterUserIdsByVisibility = (candidateUserIds, visibleUserIds) => {
  if (visibleUserIds === null) {
    return candidateUserIds;
  }

  const visibleSet = new Set(visibleUserIds.map((id) => String(id)));
  return candidateUserIds.filter((id) => visibleSet.has(String(id)));
};

const getAssignedAccountIds = async (scopedUserIds) => {
  if (!Array.isArray(scopedUserIds) || scopedUserIds.length === 0) {
    return [];
  }

  const accounts = await Account.find({
    assignedMedicalRepIds: { $in: scopedUserIds },
  }).select("_id").lean();

  return accounts.map((account) => account._id);
};

const getAccessibleSalesBatchQuery = async (user) => {
  if (user.role === "admin") {
    return {};
  }

  if (!isManagerRole(user.role)) {
    return { _id: null };
  }

  const scopedUserIds = await getScopedUserIds(user);

  if (!Array.isArray(scopedUserIds) || scopedUserIds.length === 0) {
    return { _id: null };
  }

  return { uploadedBy: { $in: scopedUserIds } };
};

const getBatchIdsUploadedBy = async (uploaderIds) => {
  if (!Array.isArray(uploaderIds) || uploaderIds.length === 0) {
    return [];
  }

  const batches = await SalesUploadBatch.find({
    uploadedBy: { $in: uploaderIds },
  }).select("_id").lean();

  return batches.map((batch) => batch._id);
};

const getRequestedUploaderIds = async (queryParams = {}, user) => {
  const visibleUserIds = await getVisibleUploaderIds(user);

  if (queryParams.uploadedBy) {
    if (!isValidObjectId(queryParams.uploadedBy)) {
      return [];
    }

    return filterUserIdsByVisibility([new mongoose.Types.ObjectId(queryParams.uploadedBy)], visibleUserIds);
  }

  if (queryParams.managerId) {
    const downlineIds = await getDownlineUserIds(queryParams.managerId);
    return filterUserIdsByVisibility(downlineIds, visibleUserIds);
  }

  return null;
};

const getAccessibleSalesQuery = async (user) => {
  if (user.role === "admin") {
    return {};
  }

  const scopedUserIds = await getScopedUserIds(user);
  const assignedAccountIds = await getAssignedAccountIds(scopedUserIds);
  const visibleUploaderIds = await getVisibleUploaderIds(user);
  const visibleBatchIds = await getBatchIdsUploadedBy(visibleUploaderIds);
  const accessBranches = [];

  if (visibleBatchIds.length > 0) {
    accessBranches.push({ salesUploadBatchId: { $in: visibleBatchIds } });
  }

  if (assignedAccountIds.length > 0) {
    accessBranches.push({ accountId: { $in: assignedAccountIds } });
  }

  if (accessBranches.length === 0) {
    return { _id: null };
  }

  return accessBranches.length === 1 ? accessBranches[0] : { $or: accessBranches };
};

const getScopedSalesRecord = async (recordId, user) => {
  if (!isValidObjectId(recordId)) {
    return null;
  }

  return SalesRecord.findOne({
    _id: recordId,
    ...await getAccessibleSalesQuery(user),
  });
};

const validateMonthYear = (month, year) => {
  const parsedMonth = Number(month);
  const parsedYear = Number(year);

  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return "month must be a number between 1 and 12";
  }

  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
    return "year must be a number between 2000 and 2100";
  }

  return null;
};

const getMappedValue = (row, key, columnMapping = {}) => {
  if (row?.[key] !== undefined) {
    return row[key];
  }

  const mappedColumn = columnMapping[key];
  return mappedColumn ? row?.[mappedColumn] : undefined;
};

const getFirstMappedValue = (row, keys = [], columnMapping = {}) => {
  for (const key of keys) {
    const value = getMappedValue(row, key, columnMapping);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
};

const normalizeUploadColumnMapping = (body = {}, mapping = null) => {
  const columnMapping = { ...(body.columnMapping || mapping?.columnMapping || {}) };
  const channelTypeColumn = body.channelTypeColumn
    || body.marketTypeColumn
    || body.salesChannelTypeColumn
    || body.customerTypeColumn
    || body.privateInstitutionColumn
    || body.privateOrInstitutionColumn
    || body.salesTypeColumn
    || body.typeColumn;

  if (channelTypeColumn && !columnMapping.channelType) {
    columnMapping.channelType = channelTypeColumn;
  }

  return columnMapping;
};

const normalizeSalesRow = (row = {}, columnMapping = {}, fallback = {}) => {
  const month = parseNumber(getMappedValue(row, "month", columnMapping), fallback.month);
  const year = parseNumber(getMappedValue(row, "year", columnMapping), fallback.year);
  const salesDate = parseDate(getMappedValue(row, "salesDate", columnMapping), "salesDate", { preferDayFirst: true })
    || (month && year ? new Date(Date.UTC(year, month - 1, 1)) : null);

  return {
    invoiceNumber: getMappedValue(row, "invoiceNumber", columnMapping),
    externalSalesReference: getMappedValue(row, "externalSalesReference", columnMapping),
    salesDate,
    invoiceDate: parseDate(getMappedValue(row, "invoiceDate", columnMapping), "invoiceDate", { preferDayFirst: true }),
    month,
    year,
    accountName: getMappedValue(row, "accountName", columnMapping),
    shipToAccountName: getMappedValue(row, "shipToAccountName", columnMapping),
    accountExternalCode: getMappedValue(row, "accountExternalCode", columnMapping),
    productName: getMappedValue(row, "productName", columnMapping),
    productNickname: getMappedValue(row, "productNickname", columnMapping),
    productExternalCode: getMappedValue(row, "productExternalCode", columnMapping),
    quantity: parseNumber(getMappedValue(row, "quantity", columnMapping), NaN),
    freeQuantity: parseNumber(getMappedValue(row, "freeQuantity", columnMapping), 0),
    uploadedSalesValue: parseNumber(getMappedValue(row, "salesValue", columnMapping), 0),
    uploadedCurrency: String(
      getMappedValue(row, "currency", columnMapping)
      || fallback.uploadedCurrency
      || fallback.currency
      || "",
    ).trim().toUpperCase(),
    channelName: getMappedValue(row, "channelName", columnMapping),
    channelKey: getMappedValue(row, "channelKey", columnMapping),
    channelType: getFirstMappedValue(row, CHANNEL_TYPE_FIELD_KEYS, columnMapping) || fallback.channelType,
  };
};

const validateSalesRow = (row) => {
  const missing = [];
  const freeQuantity = Number(row.freeQuantity || 0);
  const hasInvalidQuantity = !Number.isFinite(row.quantity) || !Number.isFinite(freeQuantity);
  const hasZeroQuantities = row.quantity === 0 && freeQuantity === 0;

  if (!row.salesDate && (!row.month || !row.year)) {
    missing.push("salesDate or month/year");
  }

  if (!row.productName && !row.productNickname) {
    missing.push("productName or productNickname");
  }

  if (hasInvalidQuantity || hasZeroQuantities) {
    return {
      message: "Quantity and FOC quantity must be valid numbers. Quantity and FOC quantity cannot both be 0. Negative values are allowed for returns.",
      quantity: row.quantity,
      freeQuantity,
    };
  }

  if (!row.accountName && !row.shipToAccountName) {
    missing.push("accountName or shipToAccountName");
  }

  return missing.length ? { message: `Missing or invalid required fields: ${missing.join(", ")}` } : null;
};

const matchProduct = async (row, productCandidates = null) => {
  if (Array.isArray(productCandidates)) {
    const nickname = normalizeText(row.productNickname);
    const productName = normalizeText(row.productName);
    const externalCode = String(row.productExternalCode || "").trim();
    const product = productCandidates.find((candidate) => (
      (nickname && normalizeText(candidate.productNickname) === nickname)
      || (externalCode && String(candidate.productExternalCode || "").trim() === externalCode)
      || (productName && normalizeText(candidate.productName) === productName)
    ));

    return product
      ? { product, warning: null }
      : { product: null, warning: "Product could not be matched" };
  }

  const queries = [];

  if (row.productNickname) {
    queries.push({ productNickname: { $regex: `^${escapeRegex(row.productNickname)}$`, $options: "i" } });
  }

  if (row.productExternalCode) {
    queries.push({ productExternalCode: row.productExternalCode });
  }

  if (row.productName) {
    queries.push({ productName: { $regex: `^${escapeRegex(row.productName)}$`, $options: "i" } });
  }

  for (const query of queries) {
    const product = await Product.findOne({ ...query, status: "active", isActive: true }).lean();

    if (product) {
      return { product, warning: null };
    }
  }

  if (row.productName) {
    const normalizedName = normalizeText(row.productName);
    const candidates = await Product.find({ status: "active", isActive: true }).lean();
    const product = candidates.find((candidate) => normalizeText(candidate.productName) === normalizedName);

    if (product) {
      return { product, warning: null };
    }
  }

  return { product: null, warning: "Product could not be matched" };
};

const createPlaceholderAccount = async (row, user) => {
  const accountName = String(row.accountName || row.shipToAccountName || "").trim();

  if (!accountName) {
    return { account: null, warning: "Account could not be matched" };
  }

  const account = await Account.create({
    accountName,
    accountType: inferAccountType(accountName),
    keyContact: "Placeholder - please update",
    area: "Placeholder - please update",
    territory: "Placeholder - please update",
    location: {
      address: "Placeholder - please update",
    },
    createdBy: user?._id,
  });

  return {
    account: account.toObject(),
    warning: `Placeholder account created for "${accountName}". Please update account details.`,
  };
};

const matchAccount = async (row, user, accountCandidates = null) => {
  const inputs = [
    row.accountName,
    row.shipToAccountName,
  ].filter(Boolean);

  const candidates = Array.isArray(accountCandidates)
    ? accountCandidates
    : await Account.find({}).lean();

  for (const input of inputs) {
    const normalizedInput = normalizeText(input);
    const matches = candidates.filter((account) => normalizeText(account.accountName) === normalizedInput);
    const bestMatch = getBestAccountMatch(matches);

    if (bestMatch) {
      const warning = matches.length > 1
        ? `Multiple accounts matched "${input}", selected ${bestMatch.accountName}`
        : null;
      return { account: bestMatch, warning };
    }
  }

  const normalizedInputs = inputs.map(normalizeText).filter(Boolean);

  if (normalizedInputs.length > 0) {
    const matches = candidates.filter((account) => normalizedInputs.includes(normalizeText(account.accountName)));
    const bestMatch = getBestAccountMatch(matches);

    if (bestMatch) {
      const warning = matches.length > 1
        ? `Multiple accounts matched after normalization, selected ${bestMatch.accountName}`
        : null;
      return { account: bestMatch, warning };
    }
  }

  for (const input of inputs) {
    const nearMatches = candidates
      .map((account) => ({
        account,
        score: getAccountSimilarityScore(input, account.accountName),
      }))
      .filter((candidate) => candidate.score >= 0.8)
      .sort((left, right) => right.score - left.score);

    if (nearMatches.length === 1) {
      return {
        account: nearMatches[0].account,
        warning: `Account matched by near name: "${input}" -> "${nearMatches[0].account.accountName}"`,
      };
    }

    if (nearMatches.length > 1 && nearMatches[0].score > nearMatches[1].score) {
      return {
        account: nearMatches[0].account,
        warning: `Account matched by nearest name: "${input}" -> "${nearMatches[0].account.accountName}"`,
      };
    }
  }

  const placeholderResult = await createPlaceholderAccount(row, user);

  if (placeholderResult.account && Array.isArray(accountCandidates)) {
    accountCandidates.push(placeholderResult.account);
  }

  return placeholderResult;
};

const matchAccountBySource = async (row, user, accountCandidates, accountMatchSource = "auto") => {
  if (accountMatchSource === "shipToAccountName") {
    return matchAccount({ ...row, accountName: undefined }, user, accountCandidates);
  }

  if (accountMatchSource === "accountName") {
    return matchAccount({ ...row, shipToAccountName: undefined }, user, accountCandidates);
  }

  return matchAccount(row, user, accountCandidates);
};

const normalizeRuleTextList = (values = []) => values.map(normalizeText).filter(Boolean);

const normalizeRuleKeyList = (values = []) => values.map(normalizeKey).filter(Boolean);

const listMatchesText = (ruleValues = [], input) => {
  const normalizedInput = normalizeText(input);

  if (ruleValues.length === 0) {
    return true;
  }

  return Boolean(normalizedInput) && ruleValues.some((value) => normalizeText(value) === normalizedInput);
};

const listMatchesKey = (ruleValues = [], input) => {
  const normalizedInput = normalizeKey(input);

  if (ruleValues.length === 0) {
    return true;
  }

  return Boolean(normalizedInput) && ruleValues.some((value) => normalizeKey(value) === normalizedInput);
};

const getSalesDetectionRuleScopeQuery = (user) => {
  const scopeConditions = [
    {
      teamId: { $exists: false },
      managerId: { $exists: false },
      userId: { $exists: false },
    },
    {
      teamId: null,
      managerId: null,
      userId: null,
    },
    { userId: user._id },
  ];

  if (user.teamId) {
    scopeConditions.push({ teamId: user.teamId });
  }

  if (user.managerId) {
    scopeConditions.push({ managerId: user.managerId });
  }

  if (isManagerRole(user.role)) {
    scopeConditions.push({ managerId: user._id });
  }

  (user.path || []).forEach((managerId) => {
    scopeConditions.push({ managerId });
  });

  return {
    status: "active",
    isActive: true,
    $or: scopeConditions,
  };
};

const loadSalesDetectionRules = async (user) => SalesDetectionRule.find(getSalesDetectionRuleScopeQuery(user))
  .sort({ priority: 1, createdAt: 1 })
  .lean();

const ruleMatchesRow = (rule, row, product) => {
  if (!listMatchesText(rule.soldToAccountNames, row.accountName)) return false;
  if (!listMatchesText(rule.accountNames, row.accountName)) return false;
  if (!listMatchesText(rule.shipToAccountNames, row.shipToAccountName)) return false;
  if (!listMatchesKey(rule.salesTypes, row.channelType)) return false;
  if (!listMatchesKey(rule.channelTypes, row.channelType)) return false;

  if (rule.uploadedCurrency && String(rule.uploadedCurrency).trim().toUpperCase() !== String(row.uploadedCurrency || "").trim().toUpperCase()) {
    return false;
  }

  if (Array.isArray(rule.productIds) && rule.productIds.length > 0) {
    if (!product?._id || !rule.productIds.some((productId) => String(productId) === String(product._id))) {
      return false;
    }
  }

  if (!listMatchesText(rule.productNicknames, row.productNickname || row.productName || product?.productNickname || product?.productName)) {
    return false;
  }

  return true;
};

const detectSalesChannelByRule = async (row, product, rules = [], channelLookup = {}) => {
  if (!product || !Array.isArray(rules) || rules.length === 0) {
    return null;
  }

  const matchingRules = rules
    .filter((rule) => ruleMatchesRow(rule, row, product))
    .sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100));

  if (matchingRules.length === 0) {
    return null;
  }

  const highestPriority = Number(matchingRules[0].priority || 100);
  const topRules = matchingRules.filter((rule) => Number(rule.priority || 100) === highestPriority);
  const channelIds = [...new Set(topRules.map((rule) => String(rule.channelId)))];

  if (channelIds.length > 1) {
    return {
      channel: null,
      pricing: null,
      method: "special_rule",
      warning: `Multiple special sales detection rules matched with conflicting channels: ${topRules.map((rule) => rule.ruleName).join(", ")}`,
    };
  }

  const rule = topRules[0];
  const channel = channelLookup.byId?.get(String(rule.channelId))
    || await SalesChannel.findById(rule.channelId).lean();
  const pricing = findPricing(product, rule.channelId);

  return {
    channel,
    pricing,
    method: "special_rule",
    warning: pricing ? null : `Special sales detection rule "${rule.ruleName}" matched, but product has no pricing for ${rule.channelName || channel?.channelName || "that channel"}`,
    matchNote: `Detected by special rule: ${rule.ruleName}`,
    matchedRule: rule,
    accountMatchSource: rule.accountMatchSource || "auto",
  };
};

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findPricing = (product, channelId) => (product?.channelPricing || []).find(
  (pricing) => String(pricing.channelId) === String(channelId) && pricing.isAvailable !== false,
);

const getComparablePriceFields = (currency) => {
  const normalizedCurrency = String(currency || "").trim().toUpperCase();

  if (!normalizedCurrency) {
    return PRICE_FIELDS;
  }

  const fields = PRICE_FIELDS.filter((priceField) => priceField.currency === normalizedCurrency);
  return fields.length > 0 ? fields : PRICE_FIELDS;
};

const getChannelTypeHint = (value) => {
  const normalizedValue = normalizeKey(value);

  if (!normalizedValue) {
    return null;
  }

  const alias = CHANNEL_TYPE_ALIASES[normalizedValue]
    || (normalizedValue.includes("private") ? CHANNEL_TYPE_ALIASES.private : null)
    || (normalizedValue.includes("direct") ? CHANNEL_TYPE_ALIASES.direct : null)
    || (normalizedValue.includes("institution") ? CHANNEL_TYPE_ALIASES.institution : null)
    || (normalizedValue.includes("institute") ? CHANNEL_TYPE_ALIASES.institution : null);

  return {
    rawValue: value,
    normalizedValue,
    channelGroup: alias?.channelGroup || normalizedValue,
    priceFields: alias?.priceFields,
  };
};

const pricingMatchesChannelHint = (pricing, hint, channelLookup = {}) => {
  if (!hint) {
    return true;
  }

  const channel = channelLookup.byId?.get(String(pricing?.channelId));
  const channelGroup = normalizeKey(channel?.channelGroup || pricing?.channelGroup);

  if (channelGroup) {
    return channelGroup === normalizeKey(hint.channelGroup);
  }

  const pricingKey = normalizeKey(pricing?.channelKey || pricing?.channelName);

  if (hint.channelGroup === "private") {
    return ["direct", "private", "upp"].includes(pricingKey);
  }

  if (hint.channelGroup === "institution") {
    return ["institution", "institutional"].includes(pricingKey);
  }

  return pricingKey === normalizeKey(hint.channelGroup);
};

const pricingMatchesUploadedCurrency = (pricing, currency) => {
  const normalizedCurrency = String(currency || "").trim().toUpperCase();

  if (!normalizedCurrency) {
    return true;
  }

  const targetCurrency = String(pricing?.targetCurrency || "").trim().toUpperCase();

  if (targetCurrency) {
    return targetCurrency === normalizedCurrency;
  }

  return true;
};

const priceValuesMatch = (uploadedUnitValue, unitValue) => {
  if (uploadedUnitValue <= 0 || unitValue <= 0) {
    return false;
  }

  const relativeDifference = Math.abs(uploadedUnitValue - unitValue) / unitValue;

  if (relativeDifference <= PRICE_MATCH_PERCENT_TOLERANCE) {
    return true;
  }

  if (Math.abs(uploadedUnitValue - unitValue) <= PRICE_MATCH_ABSOLUTE_TOLERANCE) {
    return true;
  }

  const roundedUploaded = Number(uploadedUnitValue.toFixed(2));
  const roundedUnit = Number(unitValue.toFixed(2));

  if (roundedUploaded === roundedUnit) {
    return true;
  }

  return Math.abs(roundedUploaded - roundedUnit) <= 0.01;
};

const buildPricingCandidates = (product, channelLookup, hint) => (product?.channelPricing || [])
  .map((pricing) => {
    if (pricing.isAvailable === false || !pricingMatchesChannelHint(pricing, hint, channelLookup)) {
      return null;
    }

    const channel = channelLookup.byId?.get(String(pricing.channelId));

    return {
      pricing,
      channel,
      channelKey: normalizeKey(channel?.channelKey || pricing.channelKey || pricing.channelName),
      channelGroup: normalizeKey(channel?.channelGroup || pricing.channelGroup),
    };
  })
  .filter(Boolean);

const scorePricingCandidate = (candidate, comparablePriceFields, uploadedUnitValue) => {
  const scores = comparablePriceFields
    .map((priceField) => {
      const unitValue = Number(candidate.pricing[priceField.field]) || 0;

      if (unitValue <= 0 || uploadedUnitValue <= 0) {
        return null;
      }

      return {
        ...candidate,
        matchedField: priceField,
        unitValue,
        difference: Math.abs(uploadedUnitValue - unitValue),
        relativeDifference: Math.abs(uploadedUnitValue - unitValue) / unitValue,
        matchesTolerance: priceValuesMatch(uploadedUnitValue, unitValue),
      };
    })
    .filter(Boolean);

  return scores.sort((left, right) => left.difference - right.difference)[0] || null;
};

const isDirectChannel = (candidate) => {
  const key = normalizeKey(candidate?.channelKey);
  const name = normalizeKey(candidate?.channel?.channelName || candidate?.pricing?.channelName);

  return key === "direct" || name === "direct" || name.includes("direct");
};

const getFallbackChannelCandidate = (product, channelLookup, channelTypeHint) => {
  const candidates = buildPricingCandidates(product, channelLookup, channelTypeHint);

  if (candidates.length === 0) {
    return null;
  }

  if (channelTypeHint?.channelGroup === "private") {
    return candidates.find(isDirectChannel) || candidates[0];
  }

  return candidates[0];
};

const detectPriceFieldForPricing = (pricing, uploadedUnitValue, currency) => {
  if (!pricing || uploadedUnitValue <= 0) {
    return null;
  }

  return getComparablePriceFields(currency).find((priceField) => {
    const unitValue = Number(pricing[priceField.field]) || 0;

    if (unitValue <= 0) {
      return false;
    }

    return priceValuesMatch(uploadedUnitValue, unitValue);
  }) || null;
};

const detectSalesChannel = async (row, product, channelLookup = {}) => {
  if (!product) {
    return {
      channel: null,
      pricing: null,
      method: "unknown",
      warning: "Channel cannot be detected without a matched product",
    };
  }

  const uploadedUnitValue = row.quantity !== 0
    ? Math.abs(row.uploadedSalesValue / row.quantity)
    : 0;
  const channelTypeHint = getChannelTypeHint(row.channelType);

  if (row.channelKey || row.channelName) {
    const channel = row.channelKey
      ? channelLookup.byKey?.get(normalizeKey(row.channelKey))
      : channelLookup.byName?.get(normalizeText(row.channelName))
        || await SalesChannel.findOne({ channelName: { $regex: `^${escapeRegex(row.channelName)}$`, $options: "i" }, status: "active", isActive: true }).lean();
    const pricing = findPricing(product, channel?._id);
    const detectedPriceField = detectPriceFieldForPricing(pricing, uploadedUnitValue, row.uploadedCurrency);

    if (channel && pricing) {
      return {
        channel,
        pricing,
        method: "sheet_channel",
        detectedPriceBasis: detectedPriceField?.field,
        detectedPriceCurrency: detectedPriceField?.currency,
        uploadedUnitValue,
        warning: null,
      };
    }

    if (channel && !pricing) {
      return {
        channel,
        pricing: null,
        method: "sheet_channel",
        uploadedUnitValue,
        warning: "Sheet channel matched, but product has no available pricing for that channel",
      };
    }
  }

  const comparablePriceFields = channelTypeHint?.priceFields
    ? getComparablePriceFields(row.uploadedCurrency).filter((priceField) => channelTypeHint.priceFields.includes(priceField.field))
    : getComparablePriceFields(row.uploadedCurrency);

  if (uploadedUnitValue === 0 && Number(row.uploadedSalesValue || 0) === 0 && channelTypeHint) {
    const fallbackCandidate = getFallbackChannelCandidate(product, channelLookup, channelTypeHint);

    if (fallbackCandidate) {
      const channel = fallbackCandidate.channel
        || await SalesChannel.findById(fallbackCandidate.pricing.channelId).lean();

      return {
        channel,
        pricing: fallbackCandidate.pricing,
        method: "sales_type_price_match",
        uploadedUnitValue,
        warning: null,
        matchNote: `Detected by ${channelTypeHint.channelGroup} salesType fallback for zero-value row`,
      };
    }
  }

  if (uploadedUnitValue > 0) {
    const scoredCandidates = buildPricingCandidates(product, channelLookup, channelTypeHint)
      .map((candidate) => scorePricingCandidate(candidate, comparablePriceFields, uploadedUnitValue))
      .filter(Boolean)
      .sort((left, right) => left.difference - right.difference);
    const matches = scoredCandidates.filter((candidate) => candidate.matchesTolerance);

    if (channelTypeHint?.channelGroup === "private" && scoredCandidates.length > 0) {
      const directMatch = scoredCandidates.find(isDirectChannel);
      const nonDirectMatches = scoredCandidates.filter((candidate) => !isDirectChannel(candidate));
      const closestNonDirect = nonDirectMatches[0];
      const bestMatch = scoredCandidates[0];

      if (closestNonDirect && (!directMatch || closestNonDirect.difference + 0.05 < directMatch.difference)) {
        const channel = closestNonDirect.channel
          || await SalesChannel.findById(closestNonDirect.pricing.channelId).lean();

        return {
          channel,
          pricing: closestNonDirect.pricing,
          method: "sales_type_price_match",
          detectedPriceBasis: closestNonDirect.matchedField.field,
          detectedPriceCurrency: closestNonDirect.matchedField.currency,
          uploadedUnitValue,
          warning: null,
          matchNote: "Detected by private salesType and closest private channel price",
        };
      }

      if (directMatch && directMatch.matchesTolerance) {
        const channel = directMatch.channel
          || await SalesChannel.findById(directMatch.pricing.channelId).lean();

        return {
          channel,
          pricing: directMatch.pricing,
          method: "sales_type_price_match",
          detectedPriceBasis: directMatch.matchedField.field,
          detectedPriceCurrency: directMatch.matchedField.currency,
          uploadedUnitValue,
          warning: null,
          matchNote: "Detected by private salesType and closest private channel price",
        };
      }

      if (bestMatch.matchesTolerance) {
        const channel = bestMatch.channel
          || await SalesChannel.findById(bestMatch.pricing.channelId).lean();

        return {
          channel,
          pricing: bestMatch.pricing,
          method: "sales_type_price_match",
          detectedPriceBasis: bestMatch.matchedField.field,
          detectedPriceCurrency: bestMatch.matchedField.currency,
          uploadedUnitValue,
          warning: null,
          matchNote: "Detected by private salesType and closest private channel price",
        };
      }
    }

    if (matches.length === 1) {
      const channel = matches[0].channel
        || await SalesChannel.findById(matches[0].pricing.channelId).lean();
      return {
        channel,
        pricing: matches[0].pricing,
        method: channelTypeHint ? "sales_type_price_match" : "price_match",
        detectedPriceBasis: matches[0].matchedField.field,
        detectedPriceCurrency: matches[0].matchedField.currency,
        uploadedUnitValue,
        warning: null,
      };
    }

    if (matches.length > 1) {
      const sortedMatches = [...matches].sort((left, right) => left.difference - right.difference);
      const bestMatch = sortedMatches[0];
      const nextMatch = sortedMatches[1];

      if (bestMatch.difference + 0.05 < nextMatch.difference) {
        const channel = bestMatch.channel
          || await SalesChannel.findById(bestMatch.pricing.channelId).lean();

        return {
          channel,
          pricing: bestMatch.pricing,
          method: channelTypeHint ? "sales_type_price_match" : "price_match",
          detectedPriceBasis: bestMatch.matchedField.field,
          detectedPriceCurrency: bestMatch.matchedField.currency,
          uploadedUnitValue,
          warning: null,
        };
      }

      return {
        channel: null,
        pricing: null,
        method: channelTypeHint ? "sales_type_price_match" : "price_match",
        uploadedUnitValue,
        warning: channelTypeHint
          ? `Multiple sales channels matched by ${row.channelType} and uploaded unit value`
          : "Multiple sales channels matched by uploaded unit value",
      };
    }
  }

  return {
    channel: null,
    pricing: null,
    method: "unknown",
    uploadedUnitValue,
    warning: channelTypeHint
      ? `Sales channel could not be detected from ${row.channelType}, uploaded unit value, and currency`
      : "Sales channel could not be detected from uploaded unit value and currency",
  };
};

const buildCalculatedValues = (quantity, pricing) => {
  if (!pricing) {
    return {};
  }

  const unitCifUsd = Number(pricing.cifUsd) || 0;
  const unitWholesaleAed = Number(pricing.wholesaleAed) || 0;
  const unitRetailAed = Number(pricing.retailAed) || 0;
  const targetValueBasis = pricing.targetValueBasis || "cifUsd";
  const targetCurrency = pricing.targetCurrency || (targetValueBasis === "cifUsd" ? "USD" : "AED");
  const targetUnitValue = Number(pricing[targetValueBasis]) || 0;
  const unitPriceSnapshots = PRICE_FIELDS.reduce((snapshots, priceField) => ({
    ...snapshots,
    [priceField.field]: {
      value: Number(pricing[priceField.field]) || 0,
      currency: priceField.currency,
    },
  }), {});
  const calculatedValueSnapshots = PRICE_FIELDS.reduce((snapshots, priceField) => ({
    ...snapshots,
    [priceField.field]: {
      value: quantity * (Number(pricing[priceField.field]) || 0),
      currency: priceField.currency,
    },
  }), {});

  return {
    unitCifUsd,
    unitWholesaleAed,
    unitRetailAed,
    calculatedCifUsd: quantity * unitCifUsd,
    calculatedWholesaleAed: quantity * unitWholesaleAed,
    calculatedRetailAed: quantity * unitRetailAed,
    unitPriceSnapshots,
    calculatedValueSnapshots,
    targetValueBasis,
    targetCurrency,
    targetUnitValue,
    targetCalculatedValue: quantity * targetUnitValue,
  };
};

const buildSalesQuery = async (queryParams, user) => {
  const query = {
    ...await getAccessibleSalesQuery(user),
  };
  const requestedUploaderIds = await getRequestedUploaderIds(queryParams, user);

  if (requestedUploaderIds !== null) {
    const filteredBatchIds = await getBatchIdsUploadedBy(requestedUploaderIds);

    query.salesUploadBatchId = filteredBatchIds.length > 0
      ? { $in: filteredBatchIds }
      : null;
  }

  if (queryParams.batchId) {
    const batchObjectId = isValidObjectId(queryParams.batchId)
      ? new mongoose.Types.ObjectId(queryParams.batchId)
      : null;

    if (
      batchObjectId
      && query.salesUploadBatchId?.$in
      && !query.salesUploadBatchId.$in.some((id) => String(id) === String(batchObjectId))
    ) {
      query.salesUploadBatchId = null;
    } else {
      query.salesUploadBatchId = batchObjectId;
    }
  }

  ["accountId", "productId", "channelId"].forEach((field) => {
    if (queryParams[field]) {
      const objectId = isValidObjectId(queryParams[field])
        ? new mongoose.Types.ObjectId(queryParams[field])
        : null;

      if (field === "accountId" && query.accountId?.$in) {
        query.accountId = objectId && query.accountId.$in.some((accountId) => String(accountId) === String(objectId))
          ? objectId
          : null;
      } else {
        query[field] = objectId;
      }
    }
  });

  ["year", "month"].forEach((field) => {
    if (queryParams[field]) {
      query[field] = Number(queryParams[field]);
    }
  });

  if (queryParams.matchStatus) {
    query.matchStatus = queryParams.matchStatus;
  }

  if (queryParams.status) {
    query.status = queryParams.status;
  }

  if (queryParams.entrySource) {
    query.entrySource = String(queryParams.entrySource).trim().toLowerCase();
  }

  if (queryParams.sharedSalesApplied !== undefined) {
    query.sharedSalesApplied = normalizeBoolean(queryParams.sharedSalesApplied, false);
  }

  if (queryParams.areaId) {
    query["areaShares.areaId"] = isValidObjectId(queryParams.areaId)
      ? new mongoose.Types.ObjectId(queryParams.areaId)
      : null;
  }

  ["accountMatched", "productMatched", "channelMatched"].forEach((field) => {
    if (queryParams[field] !== undefined) {
      query[field] = normalizeBoolean(queryParams[field], false);
    }
  });

  if (queryParams.invoiceNumber) {
    query.invoiceNumber = { $regex: String(queryParams.invoiceNumber).trim(), $options: "i" };
  }

  if (queryParams.dateFrom || queryParams.dateTo) {
    query.salesDate = {};

    if (queryParams.dateFrom) {
      query.salesDate.$gte = parseDate(queryParams.dateFrom, "dateFrom");
    }

    if (queryParams.dateTo) {
      query.salesDate.$lte = parseDate(queryParams.dateTo, "dateTo");
    }
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    const searchConditions = [
      { invoiceNumber: { $regex: search, $options: "i" } },
      { accountName: { $regex: search, $options: "i" } },
      { shipToAccountName: { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
      { productNickname: { $regex: search, $options: "i" } },
      { channelName: { $regex: search, $options: "i" } },
      { channelKey: { $regex: search, $options: "i" } },
    ];

    if (query.$or) {
      query.$and = [
        ...(query.$and || []),
        { $or: query.$or },
        { $or: searchConditions },
      ];
      delete query.$or;
    } else {
      query.$or = searchConditions;
    }
  }

  if (queryParams.lineId) {
    const products = await Product.find({ lineId: String(queryParams.lineId).trim().toUpperCase() })
      .select("_id")
      .lean();
    query.productId = { $in: products.map((product) => product._id) };
  }

  return query;
};

const reprocessSalesRecord = async (record, context) => {
  const row = {
    invoiceNumber: record.invoiceNumber,
    externalSalesReference: record.externalSalesReference,
    salesDate: record.salesDate,
    invoiceDate: record.invoiceDate,
    month: record.month,
    year: record.year,
    accountName: record.accountName,
    shipToAccountName: record.shipToAccountName,
    accountExternalCode: record.accountExternalCode,
    productName: record.productName,
    productNickname: record.productNickname,
    productExternalCode: record.productExternalCode,
    quantity: Number(record.quantity || 0),
    freeQuantity: Number(record.freeQuantity || 0),
    uploadedSalesValue: Number(record.uploadedSalesValue || 0),
    uploadedCurrency: record.uploadedCurrency,
    channelName: record.channelName,
    channelKey: record.channelKey,
    channelType: record.salesType || record.salesTypeNormalized,
  };

  const productResult = await matchProduct(row, context.productCandidates);
  const specialChannelResult = await detectSalesChannelByRule(
    row,
    productResult.product,
    context.detectionRules,
    context.channelLookup,
  );
  const accountResult = await matchAccountBySource(
    row,
    context.user,
    context.accountCandidates,
    specialChannelResult?.accountMatchSource,
  );
  const channelResult = specialChannelResult
    || await detectSalesChannel(row, productResult.product, context.channelLookup);
  const rowWarnings = [productResult.warning, accountResult.warning, channelResult.warning].filter(Boolean);
  const rowMatchNotes = [channelResult.matchNote, ...rowWarnings].filter(Boolean);
  const productMatched = Boolean(productResult.product);
  const accountMatched = Boolean(accountResult.account);
  const channelMatched = Boolean(channelResult.channel && channelResult.pricing);
  const calculatedValues = buildCalculatedValues(row.quantity, channelResult.pricing);
  const salesTypeHint = getChannelTypeHint(row.channelType);

  record.accountId = accountResult.account?._id;
  record.accountMatched = accountMatched;
  record.productId = productResult.product?._id;
  record.productName = row.productName || productResult.product?.productName;
  record.productNickname = row.productNickname || productResult.product?.productNickname;
  record.productMatched = productMatched;
  record.channelId = channelResult.channel?._id;
  record.channelName = channelResult.channel?.channelName || row.channelName;
  record.channelKey = channelResult.channel?.channelKey || normalizeKey(row.channelKey);
  record.channelMatched = channelMatched;
  record.channelDetectionMethod = channelResult.method;
  record.salesType = salesTypeHint?.normalizedValue || record.salesType;
  record.salesTypeNormalized = salesTypeHint?.channelGroup || record.salesTypeNormalized;
  record.uploadedUnitValue = channelResult.uploadedUnitValue ?? (row.quantity !== 0 ? Math.abs(row.uploadedSalesValue / row.quantity) : 0);
  record.detectedPriceBasis = channelResult.detectedPriceBasis;
  record.detectedPriceCurrency = channelResult.detectedPriceCurrency;
  Object.assign(record, calculatedValues);
  record.matchStatus = productMatched && accountMatched && channelMatched ? "matched" : "needs_review";
  record.matchConfidence = record.matchStatus === "matched" ? 0.9 : 0;
  record.matchNotes = rowMatchNotes.join("; ");
  record.updatedBy = context.user._id;

  await applySharedSalesToRecord(record);
  await record.save();

  return {
    salesRecordId: record._id,
    matchStatus: record.matchStatus,
    channelMatched: record.channelMatched,
    channelName: record.channelName,
    channelKey: record.channelKey,
    channelDetectionMethod: record.channelDetectionMethod,
    matchNotes: record.matchNotes,
  };
};

const normalizeMappingPayload = (body) => ({
  mappingName: body.mappingName,
  description: body.description,
  sourceType: body.sourceType,
  isDefault: normalizeBoolean(body.isDefault, false),
  status: body.status ? String(body.status).trim().toLowerCase() : undefined,
  columnMapping: body.columnMapping,
  requiredColumns: Array.isArray(body.requiredColumns) ? body.requiredColumns : [],
});

const validateMappingPayload = (payload, { partial = false } = {}) => {
  if (!partial && !payload.mappingName) {
    return "mappingName is required";
  }

  if (!partial && (!payload.columnMapping || typeof payload.columnMapping !== "object")) {
    return "columnMapping is required";
  }

  if (payload.status && !MAPPING_STATUSES.includes(payload.status)) {
    return "status must be active or inactive";
  }

  return null;
};

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
};

const buildAutoMappingName = (body) => {
  if (body.mappingName) {
    return String(body.mappingName).trim();
  }

  if (body.fileName) {
    return `${String(body.fileName).trim().replace(/\.[^.]+$/, "")} mapping`;
  }

  return `Sales upload ${body.month || ""}/${body.year || ""} mapping`.trim();
};

const persistUploadColumnMapping = async (body, columnMapping, user, existingMapping = null) => {
  if (!columnMapping || typeof columnMapping !== "object" || Object.keys(columnMapping).length === 0) {
    return existingMapping;
  }

  if (existingMapping) {
    return existingMapping;
  }

  const sourceType = String(body.sourceType || body.mappingSourceType || "sales_upload").trim();
  const isDefault = normalizeBoolean(body.saveMappingAsDefault ?? body.isDefaultMapping ?? true, true);
  const mappingSignature = stableStringify(columnMapping);
  const existingMappings = await SalesSheetMapping.find({ sourceType, status: "active" });
  const matchingMapping = existingMappings.find((candidate) => (
    stableStringify(candidate.columnMapping || {}) === mappingSignature
  ));

  if (isDefault) {
    await SalesSheetMapping.updateMany({ isDefault: true }, { $set: { isDefault: false } });
  }

  if (matchingMapping) {
    matchingMapping.mappingName = matchingMapping.mappingName || buildAutoMappingName(body);
    matchingMapping.description = body.mappingDescription || matchingMapping.description;
    matchingMapping.sourceType = sourceType;
    matchingMapping.isDefault = isDefault;
    matchingMapping.status = "active";
    matchingMapping.requiredColumns = Array.isArray(body.requiredColumns)
      ? body.requiredColumns
      : matchingMapping.requiredColumns;
    matchingMapping.updatedBy = user._id;
    await matchingMapping.save();
    return matchingMapping;
  }

  return SalesSheetMapping.create({
    mappingName: buildAutoMappingName(body),
    description: body.mappingDescription || body.notes,
    sourceType,
    isDefault,
    status: "active",
    columnMapping,
    requiredColumns: Array.isArray(body.requiredColumns) ? body.requiredColumns : [],
    createdBy: user._id,
    updatedBy: user._id,
  });
};

const normalizeStringArray = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item || "").trim()).filter(Boolean);
};

const normalizeObjectIdArray = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const values = Array.isArray(value) ? value : [value];
  return values.filter((item) => isValidObjectId(item)).map((item) => new mongoose.Types.ObjectId(item));
};

const normalizeDetectionRulePayload = async (body = {}, user, { partial = false } = {}) => {
  const payload = {};

  ["ruleName", "description", "notes", "uploadedCurrency", "accountMatchSource", "status"].forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = String(body[field]).trim();
    }
  });

  ["teamId", "managerId", "userId"].forEach((field) => {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
      payload[field] = isValidObjectId(body[field]) ? new mongoose.Types.ObjectId(body[field]) : body[field];
    }
  });

  if (body.priority !== undefined) {
    payload.priority = Number(body.priority);
  }

  ["soldToAccountNames", "accountNames", "shipToAccountNames", "productNicknames", "salesTypes", "channelTypes"].forEach((field) => {
    const normalized = normalizeStringArray(body[field]);

    if (normalized !== undefined) {
      payload[field] = normalized;
    }
  });

  const productIds = normalizeObjectIdArray(body.productIds);

  if (productIds !== undefined) {
    payload.productIds = productIds;
  }

  let channel = null;

  if (body.channelId !== undefined || body.channelKey !== undefined) {
    if (body.channelId) {
      if (!isValidObjectId(body.channelId)) {
        throw new Error("channelId must be a valid MongoDB ObjectId");
      }

      channel = await SalesChannel.findOne({ _id: body.channelId, status: "active", isActive: true }).lean();
    } else if (body.channelKey) {
      channel = await SalesChannel.findOne({
        channelKey: normalizeKey(body.channelKey),
        status: "active",
        isActive: true,
      }).lean();
    }

    if (!channel) {
      throw new Error("Sales channel not found");
    }

    payload.channelId = channel._id;
    payload.channelKey = channel.channelKey;
    payload.channelName = channel.channelName;
  } else if (!partial) {
    throw new Error("channelId or channelKey is required");
  }

  if (!partial && !payload.ruleName) {
    throw new Error("ruleName is required");
  }

  if (payload.priority !== undefined && !Number.isFinite(payload.priority)) {
    throw new Error("priority must be a valid number");
  }

  if (payload.accountMatchSource !== undefined && !ACCOUNT_MATCH_SOURCES.includes(payload.accountMatchSource)) {
    throw new Error("accountMatchSource must be shipToAccountName, accountName, or auto");
  }

  if (payload.status !== undefined && !DETECTION_RULE_STATUSES.includes(payload.status)) {
    throw new Error("status must be active or inactive");
  }

  payload.updatedBy = user._id;

  if (!partial) {
    payload.createdBy = user._id;
    payload.status = payload.status || "active";
    payload.accountMatchSource = payload.accountMatchSource || "auto";
  }

  return payload;
};

const buildDetectionRuleQuery = (queryParams = {}) => {
  const query = {};

  ["teamId", "managerId", "userId", "channelId"].forEach((field) => {
    if (queryParams[field]) {
      query[field] = isValidObjectId(queryParams[field])
        ? new mongoose.Types.ObjectId(queryParams[field])
        : null;
    }
  });

  if (queryParams.status) {
    query.status = String(queryParams.status).trim().toLowerCase();
  }

  if (queryParams.search) {
    const search = String(queryParams.search).trim();
    query.$or = [
      { ruleName: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { soldToAccountNames: { $regex: search, $options: "i" } },
      { accountNames: { $regex: search, $options: "i" } },
      { shipToAccountNames: { $regex: search, $options: "i" } },
      { productNicknames: { $regex: search, $options: "i" } },
      { channelName: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};

router.post("/detection-rules", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const payload = await normalizeDetectionRulePayload(req.body, req.currentUser);
    const rule = await SalesDetectionRule.create(payload);

    return res.status(201).json({
      success: true,
      message: "Sales detection rule created successfully",
      data: rule,
    });
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    return next(error);
  }
});

router.get("/detection-rules", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const query = buildDetectionRuleQuery(req.query);
    const [rules, total] = await Promise.all([
      SalesDetectionRule.find(query)
        .populate("channelId", "channelName channelKey channelGroup")
        .populate("createdBy", "fullName email businessEmail role")
        .populate("updatedBy", "fullName email businessEmail role")
        .sort({ priority: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SalesDetectionRule.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales detection rules fetched successfully",
      data: rules,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/detection-rules/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Detection rule id must be a valid MongoDB ObjectId" });
    }

    const rule = await SalesDetectionRule.findById(req.params.id)
      .populate("channelId", "channelName channelKey channelGroup")
      .populate("createdBy", "fullName email businessEmail role")
      .populate("updatedBy", "fullName email businessEmail role");

    if (!rule) {
      return res.status(404).json({ success: false, message: "Sales detection rule not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Sales detection rule fetched successfully",
      data: rule,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/detection-rules/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Detection rule id must be a valid MongoDB ObjectId" });
    }

    const payload = await normalizeDetectionRulePayload(req.body, req.currentUser, { partial: true });
    const rule = await SalesDetectionRule.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true },
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: "Sales detection rule not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Sales detection rule updated successfully",
      data: rule,
    });
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    return next(error);
  }
});

router.patch("/detection-rules/:id/status", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const status = String(req.body.status || "").trim().toLowerCase();

    if (!DETECTION_RULE_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active or inactive" });
    }

    const rule = await SalesDetectionRule.findByIdAndUpdate(
      req.params.id,
      { $set: { status, isActive: status === "active", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: "Sales detection rule not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Sales detection rule status updated successfully",
      data: rule,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/detection-rules/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Detection rule id must be a valid MongoDB ObjectId" });
    }

    const rule = await SalesDetectionRule.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "inactive", isActive: false, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!rule) {
      return res.status(404).json({ success: false, message: "Sales detection rule not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Sales detection rule deactivated successfully",
      data: rule,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/upload", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const validationError = validateMonthYear(req.body.month, req.body.year);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (!Array.isArray(req.body.rows) || req.body.rows.length === 0) {
      return res.status(400).json({ success: false, message: "rows must be a non-empty array" });
    }

    const uploadMode = req.body.uploadMode
      ? String(req.body.uploadMode).trim().toLowerCase()
      : undefined;

    if (uploadMode && !UPLOAD_MODES.includes(uploadMode)) {
      return res.status(400).json({ success: false, message: "uploadMode must be override or amend" });
    }

    const existingActiveSalesCount = await SalesRecord.countDocuments({
      year: Number(req.body.year),
      month: Number(req.body.month),
      status: "active",
      isActive: true,
    });

    if (existingActiveSalesCount > 0 && !uploadMode) {
      const existingBatchesCount = await SalesUploadBatch.countDocuments({
        year: Number(req.body.year),
        month: Number(req.body.month),
      });

      return res.status(409).json({
        success: false,
        requiresConfirmation: true,
        message: "Sales data already exists for this month/year. Choose override or amend.",
        data: {
          year: Number(req.body.year),
          month: Number(req.body.month),
          existingActiveSalesCount,
          existingBatchesCount,
        },
      });
    }

    let mapping = null;

    if (req.body.mappingId) {
      if (!isValidObjectId(req.body.mappingId)) {
        return res.status(400).json({ success: false, message: "mappingId must be a valid MongoDB ObjectId" });
      }

      mapping = await SalesSheetMapping.findById(req.body.mappingId);

      if (!mapping) {
        return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
      }
    }

    const columnMapping = normalizeUploadColumnMapping(req.body, mapping);
    mapping = await persistUploadColumnMapping(req.body, columnMapping, req.currentUser, mapping);
    const uploadSessionId = req.body.uploadSessionId
      ? String(req.body.uploadSessionId).trim()
      : undefined;
    const chunkIndex = req.body.chunkIndex !== undefined ? Number(req.body.chunkIndex) : undefined;
    const totalChunks = req.body.totalChunks !== undefined ? Number(req.body.totalChunks) : undefined;
    const isFirstChunk = normalizeBoolean(req.body.isFirstChunk, chunkIndex === 0);
    const isLastChunk = normalizeBoolean(
      req.body.isLastChunk,
      Number.isInteger(chunkIndex) && Number.isInteger(totalChunks) ? chunkIndex === totalChunks - 1 : false,
    );
    const batch = await SalesUploadBatch.create({
      fileName: req.body.fileName,
      uploadedBy: req.currentUser._id,
      mappingId: mapping?._id,
      mappingName: mapping?.mappingName,
      uploadSessionId,
      chunkIndex: Number.isInteger(chunkIndex) ? chunkIndex : undefined,
      totalChunks: Number.isInteger(totalChunks) && totalChunks > 0 ? totalChunks : undefined,
      isFirstChunk,
      isLastChunk,
      month: Number(req.body.month),
      year: Number(req.body.year),
      totalRows: req.body.rows.length,
      status: "processing",
      columnMapping,
      notes: [
        req.body.notes,
        `Upload mode: ${uploadMode || "amend"}`,
        uploadSessionId ? `Upload session: ${uploadSessionId}` : null,
        Number.isInteger(chunkIndex) ? `Chunk: ${chunkIndex + 1}${Number.isInteger(totalChunks) ? `/${totalChunks}` : ""}` : null,
      ].filter(Boolean).join(" | "),
    });

    if (uploadMode === "override") {
      const sessionOverrideAlreadyApplied = uploadSessionId
        ? await SalesUploadBatch.exists({
          _id: { $ne: batch._id },
          uploadSessionId,
          year: Number(req.body.year),
          month: Number(req.body.month),
          overrideApplied: true,
        })
        : null;

      if (!sessionOverrideAlreadyApplied) {
        const cleanupQuery = {
          year: Number(req.body.year),
          month: Number(req.body.month),
          status: "active",
          isActive: true,
        };

        if (uploadSessionId) {
          const sessionBatches = await SalesUploadBatch.find({
            _id: { $ne: batch._id },
            uploadSessionId,
            year: Number(req.body.year),
            month: Number(req.body.month),
          }).select("_id").lean();

          if (sessionBatches.length > 0) {
            cleanupQuery.salesUploadBatchId = { $nin: sessionBatches.map((sessionBatch) => sessionBatch._id) };
          }
        }

        await SalesRecord.updateMany(
          cleanupQuery,
          {
            $set: {
              status: "ignored",
              isActive: false,
              updatedBy: req.currentUser._id,
            },
          },
        );
        await SalesUploadBatch.updateMany(
          {
            _id: { $ne: batch._id },
            year: Number(req.body.year),
            month: Number(req.body.month),
            ...(uploadSessionId ? { uploadSessionId: { $ne: uploadSessionId } } : {}),
          },
          { $set: { notes: `Overridden by batch ${batch._id}` } },
        );
        batch.overrideApplied = true;
      } else {
        batch.notes = [batch.notes, "Override cleanup skipped because this upload session already applied it"]
          .filter(Boolean)
          .join(" | ");
      }
    }
    const createdRecords = [];
    const failed = [];
    const unmatched = [];
    const warnings = [];
    const seenKeys = new Set();
    let duplicateRows = 0;
    const [accountCandidates, productCandidates, activeChannels, detectionRules, uploaderArea] = await Promise.all([
      Account.find({}).lean(),
      Product.find({ status: "active", isActive: true }).lean(),
      SalesChannel.find({ status: "active", isActive: true }).lean(),
      loadSalesDetectionRules(req.currentUser),
      Area.findOne({
        $or: [
          { managerId: req.currentUser._id },
          { userIds: req.currentUser._id },
        ],
        status: "active",
        isActive: true,
      }).select("_id areaName").lean(),
    ]);
    const channelLookup = {
      byId: new Map(activeChannels.map((channel) => [String(channel._id), channel])),
      byKey: new Map(activeChannels.map((channel) => [normalizeKey(channel.channelKey), channel])),
      byName: new Map(activeChannels.map((channel) => [normalizeText(channel.channelName), channel])),
    };

    for (const [index, rawRow] of req.body.rows.entries()) {
      const rowNumber = Number(rawRow.rowNumber || index + 1);

      try {
        const row = normalizeSalesRow(rawRow, columnMapping, {
          month: Number(req.body.month),
          year: Number(req.body.year),
          uploadedCurrency: req.body.uploadedCurrency,
          currency: req.body.currency,
          channelType: req.body.channelType
            || req.body.marketType
            || req.body.salesType
            || req.body.privateInstitution
            || req.body.privateOrInstitution,
        });
        const rowValidationError = validateSalesRow(row);

        if (rowValidationError) {
          failed.push({
            rowNumber,
            message: rowValidationError.message || rowValidationError,
            quantity: rowValidationError.quantity,
            freeQuantity: rowValidationError.freeQuantity,
            rawRow,
          });
          continue;
        }

        const productResult = await matchProduct(row, productCandidates);
        const specialChannelResult = await detectSalesChannelByRule(row, productResult.product, detectionRules, channelLookup);
        const accountResult = await matchAccountBySource(
          row,
          req.currentUser,
          accountCandidates,
          specialChannelResult?.accountMatchSource,
        );
        const channelResult = specialChannelResult
          || await detectSalesChannel(row, productResult.product, channelLookup);
        const rowWarnings = [productResult.warning, accountResult.warning, channelResult.warning].filter(Boolean);
        const rowMatchNotes = [channelResult.matchNote, ...rowWarnings].filter(Boolean);
        const productMatched = Boolean(productResult.product);
        const accountMatched = Boolean(accountResult.account);
        const channelMatched = Boolean(channelResult.channel && channelResult.pricing);
        const matchStatus = productMatched && accountMatched && channelMatched
          ? "matched"
          : "needs_review";
        const calculatedValues = buildCalculatedValues(row.quantity, channelResult.pricing);

        rowWarnings.forEach((message) => warnings.push({ rowNumber, message, rawRow }));

        if (matchStatus === "needs_review") {
          unmatched.push({ rowNumber, message: rowWarnings.join("; ") || "Record needs review", rawRow });
        }

        const duplicateKey = buildDuplicateKey({
          invoiceNumber: row.invoiceNumber,
          salesDate: row.salesDate,
          month: row.month || Number(req.body.month),
          year: row.year || Number(req.body.year),
          accountId: accountResult.account?._id,
          accountName: row.accountName,
          shipToAccountName: row.shipToAccountName,
          productId: productResult.product?._id,
          productName: row.productName || productResult.product?.productName,
          productNickname: row.productNickname || productResult.product?.productNickname,
          channelId: channelResult.channel?._id,
          channelKey: channelResult.channel?.channelKey || normalizeKey(row.channelKey),
          quantity: row.quantity,
          freeQuantity: row.freeQuantity,
          rawQuantity: row.quantity,
          rawFreeQuantity: row.freeQuantity,
          uploadedSalesValue: row.uploadedSalesValue,
          rawUploadedSalesValue: row.uploadedSalesValue,
          uploadedCurrency: row.uploadedCurrency,
        });
        const isDuplicate = seenKeys.has(duplicateKey);

        if (isDuplicate) {
          duplicateRows += 1;
        }

        seenKeys.add(duplicateKey);

        const record = new SalesRecord({
          salesUploadBatchId: batch._id,
          entrySource: "upload",
          invoiceNumber: row.invoiceNumber,
          externalSalesReference: row.externalSalesReference,
          rowNumber,
          salesDate: row.salesDate,
          invoiceDate: row.invoiceDate,
          month: row.month || Number(req.body.month),
          year: row.year || Number(req.body.year),
          uploadDate: new Date(),
          accountId: accountResult.account?._id,
          accountName: row.accountName,
          shipToAccountName: row.shipToAccountName,
          accountExternalCode: row.accountExternalCode,
          accountMatched,
          productId: productResult.product?._id,
          productName: row.productName || productResult.product?.productName,
          productNickname: row.productNickname || productResult.product?.productNickname,
          productExternalCode: row.productExternalCode,
          productMatched,
          channelId: channelResult.channel?._id,
          channelName: channelResult.channel?.channelName || row.channelName,
          channelKey: channelResult.channel?.channelKey || normalizeKey(row.channelKey),
          channelMatched,
          channelDetectionMethod: channelResult.method,
          salesType: getChannelTypeHint(row.channelType)?.normalizedValue,
          salesTypeNormalized: getChannelTypeHint(row.channelType)?.channelGroup,
          quantity: row.quantity,
          freeQuantity: row.freeQuantity,
          uploadedSalesValue: row.uploadedSalesValue,
          uploadedCurrency: row.uploadedCurrency,
          uploadedUnitValue: channelResult.uploadedUnitValue ?? (row.quantity !== 0 ? Math.abs(row.uploadedSalesValue / row.quantity) : 0),
          detectedPriceBasis: channelResult.detectedPriceBasis,
          detectedPriceCurrency: channelResult.detectedPriceCurrency,
          ...calculatedValues,
          matchStatus,
          matchConfidence: matchStatus === "matched" ? 0.9 : 0,
          matchNotes: rowMatchNotes.join("; "),
          status: isDuplicate ? "duplicate" : "active",
          isActive: !isDuplicate,
          rawRow,
          areaId: uploaderArea?._id,
          areaName: uploaderArea?.areaName,
          createdBy: req.currentUser._id,
          updatedBy: req.currentUser._id,
        });

        await applySharedSalesToRecord(record);
        await record.save();

        createdRecords.push(record);
      } catch (error) {
        failed.push({ rowNumber, message: error.message || "Failed to import row", rawRow });
      }
    }

    batch.successfulRows = createdRecords.length;
    batch.failedRows = failed.length;
    batch.duplicateRows = duplicateRows;
    batch.unmatchedRows = unmatched.length;
    batch.matchedRows = createdRecords.filter((record) => record.matchStatus === "matched").length;
    batch.errors = failed;
    batch.warnings = warnings;
    batch.status = failed.length > 0 || unmatched.length > 0 || warnings.length > 0
      ? "completed_with_errors"
      : "completed";
    await batch.save();
    await batch.populate("uploadedBy", "fullName email businessEmail role");

    const responsePayload = {
      success: true,
      message: "Sales upload processed",
      data: {
        batch,
        mapping,
        records: createdRecords,
        failedRows: failed,
        unmatchedRows: unmatched,
        warnings,
      },
    };

    res.status(201).json(responsePayload);

    setImmediate(() => {
      const actorId = req.currentUser._id;
      const createdRecordIds = createdRecords.map((record) => record._id);

      cleanupDuplicateSalesRecords({
        year: Number(req.body.year),
        month: Number(req.body.month),
      }).then((result) => {
        console.log("Sales duplicate cleanup completed:", {
          checkedRecords: result.checkedRecords,
          duplicateGroupsFound: result.duplicateGroupsFound,
          duplicatesDeactivated: result.duplicatesDeactivated,
          duplicatesRemoved: result.duplicatesRemoved,
          existingDuplicateRecordsFound: result.existingDuplicateRecordsFound,
          keptRecords: result.keptRecords,
        });
      }).catch((error) => {
        console.error("Background sales duplicate cleanup failed", error);
      }).then(async () => {
        // Auto-match the newly uploaded records to submitted orders so they
        // are marked "matched_in_sales" without a manual matching run.
        try {
          const freshRecords = await SalesRecord.find({
            _id: { $in: createdRecordIds },
            status: "active",
            isActive: true,
            accountId: { $exists: true },
            productId: { $exists: true },
            channelId: { $exists: true },
            matchedOrderId: { $exists: false },
          });

          if (freshRecords.length) {
            const { matched, needsReview } = await matchSalesRecordsToOrders(freshRecords, actorId);
            console.log("Auto order matching completed:", {
              candidates: freshRecords.length,
              matchedCount: matched.length,
              needsReviewCount: needsReview.length,
            });
          }
        } catch (error) {
          console.error("Background order auto-matching failed", error);
        }
      });
    });

    return undefined;
  } catch (error) {
    return next(error);
  }
});

router.post("/manual", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const validationError = validateMonthYear(req.body.month, req.body.year);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (!req.body.accountId || !isValidObjectId(req.body.accountId)) {
      return res.status(400).json({ success: false, message: "accountId must be a valid MongoDB ObjectId" });
    }

    const salesDate = parseDate(req.body.salesDate, "salesDate", { preferDayFirst: true });

    if (!salesDate) {
      return res.status(400).json({ success: false, message: "salesDate is required" });
    }

    const manualItems = Array.isArray(req.body.products)
      ? req.body.products
      : Array.isArray(req.body.items)
        ? req.body.items
        : [
          {
            productId: req.body.productId,
            channelId: req.body.channelId,
            quantity: req.body.quantity,
            freeQuantity: req.body.freeQuantity,
            uploadedSalesValue: req.body.uploadedSalesValue,
            uploadedCurrency: req.body.uploadedCurrency,
            invoiceNumber: req.body.invoiceNumber,
            externalSalesReference: req.body.externalSalesReference,
            productExternalCode: req.body.productExternalCode,
            notes: req.body.notes,
          },
        ];

    if (!Array.isArray(manualItems) || manualItems.length === 0) {
      return res.status(400).json({ success: false, message: "products must be a non-empty array" });
    }

    if (manualItems.length > 200) {
      return res.status(400).json({ success: false, message: "products cannot contain more than 200 items" });
    }

    const account = await Account.findById(req.body.accountId).lean();

    if (!account) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    const batch = await SalesUploadBatch.create({
      fileName: req.body.fileName || "Manual sales entry",
      uploadedBy: req.currentUser._id,
      month: Number(req.body.month),
      year: Number(req.body.year),
      totalRows: manualItems.length,
      status: "processing",
      notes: req.body.notes,
    });
    const records = [];
    const failedItems = [];
    const uploaderArea = await Area.findOne({
      $or: [
        { managerId: req.currentUser._id },
        { userIds: req.currentUser._id },
      ],
      status: "active",
      isActive: true,
    }).select("_id areaName").lean();

    for (const [index, item] of manualItems.entries()) {
      const rowNumber = index + 1;
      const itemChannelId = item.channelId || req.body.channelId;

      if (!item.productId || !isValidObjectId(item.productId)) {
        failedItems.push({ index, rowNumber, productId: item.productId, reason: "productId must be a valid MongoDB ObjectId" });
        continue;
      }

      if (!itemChannelId || !isValidObjectId(itemChannelId)) {
        failedItems.push({ index, rowNumber, productId: item.productId, reason: "channelId must be a valid MongoDB ObjectId" });
        continue;
      }

      const quantity = Number(item.quantity);
      const freeQuantity = Number(item.freeQuantity || 0);

      if (!Number.isFinite(quantity) || !Number.isFinite(freeQuantity) || (quantity === 0 && freeQuantity === 0)) {
        failedItems.push({
          index,
          rowNumber,
          productId: item.productId,
          quantity,
          freeQuantity,
          reason: "Quantity and FOC quantity must be valid numbers. Quantity and FOC quantity cannot both be 0. Negative values are allowed for returns.",
        });
        continue;
      }

      try {
        const [product, channel] = await Promise.all([
          Product.findOne({ _id: item.productId, status: "active", isActive: true }).lean(),
          SalesChannel.findOne({ _id: itemChannelId, status: "active", isActive: true }).lean(),
        ]);

        if (!product) {
          failedItems.push({ index, rowNumber, productId: item.productId, reason: "Product not found or inactive" });
          continue;
        }

        if (!channel) {
          failedItems.push({ index, rowNumber, productId: item.productId, channelId: itemChannelId, reason: "Sales channel not found or inactive" });
          continue;
        }

        const pricing = findPricing(product, channel._id);

        if (!pricing) {
          failedItems.push({
            index,
            rowNumber,
            productId: item.productId,
            channelId: itemChannelId,
            reason: "Product has no available pricing for the selected sales channel",
          });
          continue;
        }

        const uploadedSalesValue = parseNumber(item.uploadedSalesValue, 0);
        const uploadedCurrency = String(item.uploadedCurrency || req.body.uploadedCurrency || "").trim().toUpperCase();
        const uploadedUnitValue = quantity !== 0 ? Math.abs(uploadedSalesValue / quantity) : 0;
        const detectedPriceField = detectPriceFieldForPricing(pricing, uploadedUnitValue, uploadedCurrency);
        const calculatedValues = buildCalculatedValues(quantity, pricing);
        const record = await SalesRecord.create({
          salesUploadBatchId: batch._id,
          entrySource: "manual",
          invoiceNumber: item.invoiceNumber || req.body.invoiceNumber,
          externalSalesReference: item.externalSalesReference || req.body.externalSalesReference,
          rowNumber,
          salesDate,
          invoiceDate: parseDate(item.invoiceDate || req.body.invoiceDate, "invoiceDate", { preferDayFirst: true }),
          month: Number(req.body.month),
          year: Number(req.body.year),
          uploadDate: new Date(),
          accountId: account._id,
          accountName: account.accountName,
          shipToAccountName: item.shipToAccountName || req.body.shipToAccountName,
          accountExternalCode: item.accountExternalCode || req.body.accountExternalCode,
          accountMatched: true,
          productId: product._id,
          productName: product.productName,
          productNickname: product.productNickname,
          productExternalCode: item.productExternalCode,
          productMatched: true,
          channelId: channel._id,
          channelName: channel.channelName,
          channelKey: channel.channelKey,
          channelMatched: true,
          channelDetectionMethod: "manual",
          quantity,
          freeQuantity,
          rawQuantity: quantity,
          rawFreeQuantity: freeQuantity,
          uploadedSalesValue,
          rawUploadedSalesValue: uploadedSalesValue,
          uploadedCurrency,
          uploadedUnitValue,
          detectedPriceBasis: detectedPriceField?.field,
          detectedPriceCurrency: detectedPriceField?.currency,
          ...calculatedValues,
          matchStatus: "matched",
          matchConfidence: 1,
          matchNotes: item.notes || req.body.notes,
          rawRow: {
            ...req.body,
            products: undefined,
            items: undefined,
            item,
          },
          areaId: uploaderArea?._id,
          areaName: uploaderArea?.areaName,
          createdBy: req.currentUser._id,
          updatedBy: req.currentUser._id,
        });

        await applySharedSalesToRecord(record);
        await record.save();
        records.push(record);
      } catch (error) {
        failedItems.push({
          index,
          rowNumber,
          productId: item.productId,
          reason: error.message || "Failed to create manual sales record",
        });
      }
    }

    batch.successfulRows = records.length;
    batch.failedRows = failedItems.length;
    batch.matchedRows = records.length;
    batch.errors = failedItems.map((failure) => ({
      rowNumber: failure.rowNumber,
      message: failure.reason,
      rawRow: manualItems[failure.index],
    }));
    batch.status = failedItems.length > 0
      ? records.length > 0 ? "completed_with_errors" : "failed"
      : "completed";
    await batch.save();
    await batch.populate("uploadedBy", "fullName email businessEmail role");

    return res.status(201).json({
      success: true,
      message: "Manual sales input processed",
      data: {
        batch,
        records,
        failedItems,
        summary: {
          total: manualItems.length,
          createdCount: records.length,
          failedCount: failedItems.length,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/recalculate-shared-sales", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const result = await recalculateSharedSales({
      ...req.body,
      updatedBy: req.currentUser._id,
    });

    return res.status(200).json({
      success: true,
      message: "Shared sales recalculation completed",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_RESULT_SAMPLE_LIMIT = 50;

// In-memory match job tracker: matching runs in the background so the HTTP
// response returns instantly (Heroku kills any request that exceeds 30s).
const matchJobs = { orders: null, targets: null };

const startMatchJob = (type, runner) => {
  matchJobs[type] = {
    type,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    result: null,
    error: null,
  };

  setImmediate(async () => {
    try {
      const result = await runner();
      matchJobs[type] = { ...matchJobs[type], status: "done", finishedAt: new Date(), result };
    } catch (error) {
      console.error(`Match job "${type}" failed`, error);
      matchJobs[type] = { ...matchJobs[type], status: "failed", finishedAt: new Date(), error: error.message };
    }
  });
};

const buildOrderMatchQuery = ({ year, month, includeMatched = false, accessibleQuery = {} }) => ({
  status: "active",
  isActive: true,
  accountId: { $exists: true },
  productId: { $exists: true },
  channelId: { $exists: true },
  ...(includeMatched ? {} : { matchedOrderId: { $exists: false } }),
  ...accessibleQuery,
  year: Number(year),
  month: Number(month),
});

const buildTargetMatchQuery = ({ year, month, accessibleQuery = {} }) => ({
  status: "active",
  isActive: true,
  productId: { $exists: true },
  channelId: { $exists: true },
  ...accessibleQuery,
  year: Number(year),
  month: Number(month),
});

const getMatchingRecords = async (query, limit = 5000) => {
  const totalEligibleCount = await SalesRecord.countDocuments(query);
  const records = await SalesRecord.find(query)
    .sort({ year: -1, month: -1, createdAt: -1, _id: -1 })
    .limit(limit);

  return { totalEligibleCount, records };
};

const validateMatchPeriodOrThrow = (year, month) => {
  const validationError = validateMonthYear(month, year);

  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }
};

const matchSalesRecordsToOrders = async (records, actorId) => {
  const matched = [];
  const needsReview = [];
  const candidates = records.filter((record) => record.accountId && record.productId && record.channelId);

  if (!candidates.length) return { matched, needsReview };

  // Load candidate orders ONCE and match in memory — a per-record Order.find
  // loop exceeded the Heroku 30s router timeout on large datasets.
  const salesTimes = candidates
    .map((record) => {
      const effectiveDate = getSalesRecordEffectiveDate(record);
      return effectiveDate ? effectiveDate.getTime() : 0;
    })
    .filter(Boolean);
  const minDate = new Date(Math.min(...salesTimes) - 30 * DAY_MS);
  const maxDate = new Date(Math.max(...salesTimes) + 30 * DAY_MS);

  const orders = await Order.find({
    isActive: true,
    orderDate: { $gte: minDate, $lte: maxDate },
    "account.accountId": { $in: [...new Set(candidates.map((record) => String(record.accountId)))] },
  });

  const ordersByKey = new Map();
  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const key = `${String(order.account?.accountId)}:${String(order.channelId)}:${String(item.productId)}`;
      const list = ordersByKey.get(key);
      if (list) list.push(order);
      else ordersByKey.set(key, [order]);
    });
  });

  for (const record of candidates) {
    const recordQuantity = Number(record.quantity || 0);
    const recordFreeQuantity = Number(record.freeQuantity || 0);

    if (recordQuantity === 0 && recordFreeQuantity !== 0) {
      needsReview.push({
        salesRecordId: record._id,
        invoiceNumber: record.invoiceNumber,
        accountName: record.accountName,
        productName: record.productName,
        productNickname: record.productNickname,
        channelName: record.channelName,
        quantity: record.quantity,
        freeQuantity: record.freeQuantity,
        candidateOrdersCount: 0,
        reason: "FOC-only sales row is not used to match an order",
      });
      continue;
    }

    const effectiveDate = getSalesRecordEffectiveDate(record);
    const salesTime = effectiveDate ? effectiveDate.getTime() : 0;
    const key = `${String(record.accountId)}:${String(record.channelId)}:${String(record.productId)}`;
    const pool = (ordersByKey.get(key) || []).filter((order) => {
      const orderTime = order.orderDate ? new Date(order.orderDate).getTime() : 0;
      if (Math.abs(orderTime - salesTime) > 30 * DAY_MS) return false;
      const matchingItem = (order.items || []).find((entry) => String(entry.productId) === String(record.productId));
      if (!matchingItem || Number(matchingItem.quantity) !== recordQuantity) return false;
      if (record.invoiceNumber) {
        return order.invoiceNumber === record.invoiceNumber
          || order.salesSheetReference === record.invoiceNumber
          || !order.invoiceNumber;
      }
      return true;
    });

    if (pool.length !== 1) {
      // Only persist when something actually changed — saving every unmatched
      // record made full runs slow enough to hit the Heroku 30s timeout.
      if (pool.length > 1 && record.matchStatus !== "needs_review") {
        record.matchStatus = "needs_review";
        record.matchNotes = "Multiple matching orders found";
        record.updatedBy = actorId;
        await record.save();
      }
      needsReview.push({
        salesRecordId: record._id,
        invoiceNumber: record.invoiceNumber,
        accountName: record.accountName,
        productName: record.productName,
        productNickname: record.productNickname,
        channelName: record.channelName,
        quantity: record.quantity,
        freeQuantity: record.freeQuantity,
        candidateOrdersCount: pool.length,
        reason: pool.length > 1 ? "Multiple matching orders found" : "No matching order found",
      });
      continue;
    }

    const order = pool[0];
    const orderItem = order.items.find((entry) => String(entry.productId) === String(record.productId));
    const quantityConfidence = orderItem && Number(orderItem.quantity) === Number(record.quantity) ? 0.2 : 0;
    const invoiceConfidence = record.invoiceNumber && order.invoiceNumber === record.invoiceNumber ? 0.2 : 0;

    record.matchedOrderId = order._id;
    record.matchStatus = "matched";
    record.matchConfidence = Math.min(1, 0.7 + quantityConfidence + invoiceConfidence);
    record.matchNotes = "Matched to order";
    record.updatedBy = actorId;
    await record.save();

    order.status = "matched_in_sales";
    order.salesSheetMatchedAt = new Date();
    order.salesSheetReference = record.invoiceNumber || String(record.salesUploadBatchId);
    order.matchedSalesRecordId = record._id;
    order.invoiceNumber = record.invoiceNumber || order.invoiceNumber;
    order.updatedBy = actorId;
    await order.save();

    matched.push({
      salesRecordId: record._id,
      orderId: order._id,
      orderNumber: order.orderNumber,
      accountName: record.accountName,
      productName: record.productName,
      productNickname: record.productNickname,
      channelName: record.channelName,
      quantity: record.quantity,
      freeQuantity: record.freeQuantity,
      matchConfidence: record.matchConfidence,
    });
  }

  return { matched, needsReview };
};

const formatMatchResult = ({ records, totalEligibleCount, matched, needsReview }) => ({
  checkedCount: records.length,
  totalEligibleCount,
  limited: totalEligibleCount > records.length,
  matchedCount: matched.length,
  needsReviewCount: needsReview.length,
  matched: matched.slice(0, MATCH_RESULT_SAMPLE_LIMIT),
  needsReview: needsReview.slice(0, MATCH_RESULT_SAMPLE_LIMIT),
});

const runSalesOrderMatchForPeriod = async ({
  year,
  month,
  includeMatched = false,
  accessibleQuery = {},
  actorId,
  limit = 5000,
}) => {
  validateMatchPeriodOrThrow(year, month);

  const query = buildOrderMatchQuery({ year, month, includeMatched, accessibleQuery });
  const { totalEligibleCount, records } = await getMatchingRecords(query, limit);
  const { matched, needsReview } = await matchSalesRecordsToOrders(records, actorId);

  return formatMatchResult({ records, totalEligibleCount, matched, needsReview });
};

router.get("/match-jobs/:type", auth, loadSalesActor, requireManager, (req, res) => {
  const job = matchJobs[req.params.type] || null;

  return res.status(200).json({
    success: true,
    message: "Match job status",
    data: job || { status: "idle" },
  });
});

router.post("/match-orders", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    // Single-record matching stays synchronous (fast path used by the records screen).
    if (req.body.salesRecordId) {
      const record = await getScopedSalesRecord(req.body.salesRecordId, req.currentUser);

      if (!record) {
        return res.status(404).json({ success: false, message: "Sales record not found" });
      }

      const { matched, needsReview } = await matchSalesRecordsToOrders([record], req.currentUser._id);

      return res.status(200).json({
        success: true,
        message: "Sales to orders matching completed",
        data: { matchedCount: matched.length, needsReviewCount: needsReview.length, matched, needsReview },
      });
    }

    if (matchJobs.orders?.status === "running") {
      return res.status(409).json({ success: false, message: "Order matching is already running. Try again in a moment." });
    }

    const user = req.currentUser;
    const { year, month, includeMatched } = req.body || {};
    validateMatchPeriodOrThrow(year, month);

    startMatchJob("orders", async () => {
      const accessibleQuery = await getAccessibleSalesQuery(user);
      return runSalesOrderMatchForPeriod({
        year,
        month,
        includeMatched,
        accessibleQuery,
        actorId: user._id,
      });
    });

    return res.status(202).json({
      success: true,
      message: "Order matching started",
      data: { started: true },
    });
  } catch (error) {
    return next(error);
  }
});

const matchSalesRecordsToTargets = async (records, actorId) => {
  const matched = [];
  const needsReview = [];
  const accountIds = [...new Set(records.map((record) => String(record.accountId || "")).filter(Boolean))];
  const accounts = accountIds.length
    ? await Account.find({ _id: { $in: accountIds } }).select("_id assignedMedicalRepIds").lean()
    : [];
  const assignedRepIdsByAccount = new Map(accounts.map((account) => [
    String(account._id),
    (account.assignedMedicalRepIds || []).map((repId) => String(repId)),
  ]));

  // One query for all active assignments, then match in memory — the
  // previous per-record query loop exceeded the Heroku 30s timeout.
  const allAssignments = await TargetAssignment.find({
    status: "active",
    isActive: true,
  }).select("_id userId userName productId channelId startDate endDate").lean();
  const assignmentsByProductChannel = new Map();

  allAssignments.forEach((assignment) => {
    const key = `${String(assignment.productId)}:${String(assignment.channelId)}`;
    const list = assignmentsByProductChannel.get(key);
    if (list) list.push(assignment);
    else assignmentsByProductChannel.set(key, [assignment]);
  });

  const recordBulkOps = [];

  for (const record of records) {
    const key = `${String(record.productId)}:${String(record.channelId)}`;
    const effectiveDate = getSalesRecordEffectiveDate(record);
    const salesTime = effectiveDate ? effectiveDate.getTime() : 0;
    const accountRepIds = assignedRepIdsByAccount.get(String(record.accountId)) || [];
    const assignments = (assignmentsByProductChannel.get(key) || []).filter((assignment) => (
      new Date(assignment.startDate).getTime() <= salesTime
      && new Date(assignment.endDate).getTime() >= salesTime
      && (accountRepIds.length === 0 || accountRepIds.includes(String(assignment.userId)))
    ));

    const nextIds = assignments.map((assignment) => String(assignment._id)).sort();
    const prevIds = (record.matchedTargetAssignmentIds || []).map((id) => String(id)).sort();
    const idsChanged = nextIds.join(",") !== prevIds.join(",");

    let nextStatus = record.matchStatus;
    let nextNotes = record.matchNotes;

    if (assignments.length === 1) {
      nextStatus = record.matchedOrderId ? "matched" : "partially_matched";
      nextNotes = "Matched to one target assignment";
      matched.push({
        salesRecordId: record._id,
        invoiceNumber: record.invoiceNumber,
        accountName: record.accountName,
        productName: record.productName,
        productNickname: record.productNickname,
        channelName: record.channelName,
        targetAssignmentIds: nextIds,
        targetRepName: assignments[0].userName,
      });
    } else if (assignments.length > 1) {
      nextStatus = "needs_review";
      nextNotes = "Multiple target assignments matched";
      needsReview.push({
        salesRecordId: record._id,
        invoiceNumber: record.invoiceNumber,
        accountName: record.accountName,
        productName: record.productName,
        productNickname: record.productNickname,
        channelName: record.channelName,
        reason: nextNotes,
        targetAssignmentIds: nextIds,
      });
    } else {
      nextStatus = "needs_review";
      nextNotes = "No target assignment matched";
      needsReview.push({
        salesRecordId: record._id,
        invoiceNumber: record.invoiceNumber,
        accountName: record.accountName,
        productName: record.productName,
        productNickname: record.productNickname,
        channelName: record.channelName,
        reason: nextNotes,
      });
    }

    // Only persist actual changes to keep full runs fast.
    if (idsChanged || nextStatus !== record.matchStatus || nextNotes !== record.matchNotes) {
      recordBulkOps.push({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: {
              matchedTargetAssignmentIds: assignments.map((assignment) => assignment._id),
              matchStatus: nextStatus,
              matchNotes: nextNotes,
              updatedBy: actorId,
            },
          },
        },
      });
    }
  }

  if (recordBulkOps.length) {
    await SalesRecord.bulkWrite(recordBulkOps, { ordered: false });
  }

  return { matched, needsReview };
};

const runSalesTargetMatchForPeriod = async ({
  year,
  month,
  accessibleQuery = {},
  actorId,
  limit = 5000,
}) => {
  validateMatchPeriodOrThrow(year, month);

  const query = buildTargetMatchQuery({ year, month, accessibleQuery });
  const { totalEligibleCount, records } = await getMatchingRecords(query, limit);
  const { matched, needsReview } = await matchSalesRecordsToTargets(records, actorId);

  return formatMatchResult({ records, totalEligibleCount, matched, needsReview });
};

router.post("/match-targets", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    // Single-record matching stays synchronous (fast path).
    if (req.body.salesRecordId) {
      const record = await getScopedSalesRecord(req.body.salesRecordId, req.currentUser);

      if (!record) {
        return res.status(404).json({ success: false, message: "Sales record not found" });
      }

      const { matched, needsReview } = await matchSalesRecordsToTargets([record], req.currentUser._id);

      return res.status(200).json({
        success: true,
        message: "Sales to targets matching completed",
        data: { matchedCount: matched.length, needsReviewCount: needsReview.length, matched, needsReview },
      });
    }

    if (matchJobs.targets?.status === "running") {
      return res.status(409).json({ success: false, message: "Targets matching is already running. Try again in a moment." });
    }

    const user = req.currentUser;
    const { year, month } = req.body || {};
    validateMatchPeriodOrThrow(year, month);

    startMatchJob("targets", async () => {
      const accessibleQuery = await getAccessibleSalesQuery(user);
      return runSalesTargetMatchForPeriod({
        year,
        month,
        accessibleQuery,
        actorId: user._id,
      });
    });

    return res.status(202).json({
      success: true,
      message: "Targets matching started",
      data: { started: true },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/reprocess-channel-detection", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const baseQuery = await getAccessibleSalesQuery(req.currentUser);
    const query = { ...baseQuery };

    if (Array.isArray(req.body.salesRecordIds) && req.body.salesRecordIds.length > 0) {
      const invalidId = req.body.salesRecordIds.find((id) => !isValidObjectId(id));

      if (invalidId) {
        return res.status(400).json({ success: false, message: "salesRecordIds must contain valid MongoDB ObjectIds" });
      }

      query._id = { $in: req.body.salesRecordIds.map((id) => new mongoose.Types.ObjectId(id)) };
    } else if (req.body.batchId) {
      if (!isValidObjectId(req.body.batchId)) {
        return res.status(400).json({ success: false, message: "batchId must be a valid MongoDB ObjectId" });
      }

      query.salesUploadBatchId = new mongoose.Types.ObjectId(req.body.batchId);
    } else if (req.body.year && req.body.month) {
      const validationError = validateMonthYear(req.body.month, req.body.year);

      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      query.year = Number(req.body.year);
      query.month = Number(req.body.month);
      query.status = req.body.includeInactive ? { $in: RECORD_STATUSES } : "active";
      query.isActive = req.body.includeInactive ? { $in: [true, false] } : true;
    } else {
      return res.status(400).json({
        success: false,
        message: "Provide batchId, year/month, or salesRecordIds",
      });
    }

    const [accountCandidates, productCandidates, activeChannels, detectionRules, records] = await Promise.all([
      Account.find({}).lean(),
      Product.find({ status: "active", isActive: true }).lean(),
      SalesChannel.find({ status: "active", isActive: true }).lean(),
      loadSalesDetectionRules(req.currentUser),
      SalesRecord.find(query).limit(1000),
    ]);
    const channelLookup = {
      byId: new Map(activeChannels.map((channel) => [String(channel._id), channel])),
      byKey: new Map(activeChannels.map((channel) => [normalizeKey(channel.channelKey), channel])),
      byName: new Map(activeChannels.map((channel) => [normalizeText(channel.channelName), channel])),
    };
    const context = {
      user: req.currentUser,
      accountCandidates,
      productCandidates,
      channelLookup,
      detectionRules,
    };
    const results = [];

    for (const record of records) {
      results.push(await reprocessSalesRecord(record, context));
    }

    return res.status(200).json({
      success: true,
      message: "Sales channel detection reprocessed",
      data: {
        processedCount: results.length,
        results,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/cleanup-duplicates", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (req.body.batchId && !isValidObjectId(req.body.batchId)) {
      return res.status(400).json({ success: false, message: "batchId must be a valid MongoDB ObjectId" });
    }

    if ((req.body.month || req.body.year) && validateMonthYear(req.body.month, req.body.year)) {
      return res.status(400).json({ success: false, message: validateMonthYear(req.body.month, req.body.year) });
    }

    if (!req.body.batchId && !req.body.uploadSessionId && (!req.body.month || !req.body.year)) {
      return res.status(400).json({
        success: false,
        message: "Provide batchId, uploadSessionId, or year/month",
      });
    }

    const result = await cleanupDuplicateSalesRecords({
      batchId: req.body.batchId,
      uploadSessionId: req.body.uploadSessionId,
      year: req.body.year,
      month: req.body.month,
      apply: req.body.apply,
    });

    return res.status(200).json({
      success: true,
      message: "Duplicate cleanup completed",
      data: {
        checkedRecords: result.checkedRecords,
        duplicateGroupsFound: result.duplicateGroupsFound,
        duplicatesDeactivated: result.duplicatesDeactivated,
        duplicatesRemoved: result.duplicatesRemoved,
        existingDuplicateRecordsFound: result.existingDuplicateRecordsFound,
        keptRecords: result.keptRecords,
        duplicateRecordIds: result.duplicateRecordIds,
        keptRecordIds: result.keptRecordIds,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/apply-shared-sales", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if ((req.body.month || req.body.year) && validateMonthYear(req.body.month, req.body.year)) {
      return res.status(400).json({ success: false, message: validateMonthYear(req.body.month, req.body.year) });
    }

    const input = {
      salesRecordIds: Array.isArray(req.body.salesRecordIds) ? req.body.salesRecordIds : undefined,
      year: req.body.year,
      month: req.body.month,
      dateFrom: req.body.dateFrom,
      dateTo: req.body.dateTo,
      accountId: req.body.accountId,
      productId: req.body.productId,
      channelId: req.body.channelId,
      areaId: req.body.areaId,
      activeOnly: true,
      applyRecordShare: true,
      updatedBy: req.currentUser._id,
    };

    const result = await recalculateSharedSalesOptimized(input);

    return res.status(200).json({
      success: true,
      message: "Shared sales applied successfully",
      data: {
        matched: result.matchedCount,
        updated: result.updatedCount,
        areaIdsAdded: result.areaFilledCount,
        sharedSalesApplied: result.sharedSalesAppliedCount,
        recordQuantitiesUpdated: result.recordShareAppliedCount,
        warnings: result.warnings,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/overview", auth, loadSalesActor, async (req, res, next) => {
  try {
    const baseQuery = await buildSalesQuery(req.query, req.currentUser);
    baseQuery.status = baseQuery.status || "active";
    baseQuery.isActive = true;

    const [summary] = await SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: null,
          totalQuantity: { $sum: "$quantity" },
          totalFreeQuantity: { $sum: "$freeQuantity" },
          totalQuantityWithFoc: { $sum: "$totalQuantityWithFoc" },
          totalUploadedSalesValue: { $sum: "$uploadedSalesValue" },
          totalCalculatedCifUsd: { $sum: "$calculatedCifUsd" },
          totalCalculatedWholesaleAed: { $sum: "$calculatedWholesaleAed" },
          totalCalculatedRetailAed: { $sum: "$calculatedRetailAed" },
          totalTargetCalculatedValue: { $sum: "$targetCalculatedValue" },
          recordsCount: { $sum: 1 },
          matchedOrdersCount: { $sum: { $cond: [{ $ifNull: ["$matchedOrderId", false] }, 1, 0] } },
          unmatchedSalesRecordsCount: { $sum: { $cond: [{ $eq: ["$matchStatus", "unmatched"] }, 1, 0] } },
          needsReviewCount: { $sum: { $cond: [{ $eq: ["$matchStatus", "needs_review"] }, 1, 0] } },
        },
      },
    ]);
    const areaObjectId = req.query.areaId && isValidObjectId(req.query.areaId)
      ? new mongoose.Types.ObjectId(req.query.areaId)
      : null;
    const [areaSummary] = areaObjectId
      ? await SalesRecord.aggregate([
        { $match: baseQuery },
        { $unwind: "$areaShares" },
        { $match: { "areaShares.areaId": areaObjectId } },
        {
          $group: {
            _id: "$areaShares.areaId",
            areaName: { $first: "$areaShares.areaName" },
            totalSharedQuantity: { $sum: "$areaShares.sharedQuantity" },
            totalSharedFreeQuantity: { $sum: "$areaShares.sharedFreeQuantity" },
            totalSharedCalculatedCifUsd: { $sum: "$areaShares.sharedCalculatedCifUsd" },
            totalSharedCalculatedWholesaleAed: { $sum: "$areaShares.sharedCalculatedWholesaleAed" },
            totalSharedCalculatedRetailAed: { $sum: "$areaShares.sharedCalculatedRetailAed" },
          },
        },
      ])
      : [null];

    const groupBy = async (idField, nameField, extraGroupFields = {}) => SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: `$${idField}`,
          name: { $first: `$${nameField}` },
          ...extraGroupFields,
          totalQuantity: { $sum: "$quantity" },
          totalCalculatedCifUsd: { $sum: "$calculatedCifUsd" },
          totalCalculatedWholesaleAed: { $sum: "$calculatedWholesaleAed" },
          totalCalculatedRetailAed: { $sum: "$calculatedRetailAed" },
          totalTargetCalculatedValue: { $sum: "$targetCalculatedValue" },
          value: { $sum: "$targetCalculatedValue" },
          currencies: { $addToSet: "$targetCurrency" },
          recordsCount: { $sum: 1 },
        },
      },
      {
        $set: {
          currencies: {
            $filter: {
              input: "$currencies",
              as: "currency",
              cond: {
                $and: [
                  { $ne: ["$$currency", null] },
                  { $ne: ["$$currency", ""] },
                ],
              },
            },
          },
        },
      },
      {
        $set: {
          currency: {
            $cond: [
              { $eq: [{ $size: "$currencies" }, 1] },
              { $first: "$currencies" },
              "MIXED",
            ],
          },
        },
      },
      { $project: { currencies: 0 } },
      { $sort: { totalQuantity: -1 } },
      { $limit: 50 },
    ]);

    const salesByAccountPipeline = [
      { $match: baseQuery },
      {
        $group: {
          _id: "$accountId",
          name: { $first: "$accountName" },
          shipToAccountNames: { $addToSet: "$shipToAccountName" },
          totalQuantity: { $sum: "$quantity" },
          totalCalculatedCifUsd: { $sum: "$calculatedCifUsd" },
          totalCalculatedWholesaleAed: { $sum: "$calculatedWholesaleAed" },
          totalCalculatedRetailAed: { $sum: "$calculatedRetailAed" },
          totalTargetCalculatedValue: { $sum: "$targetCalculatedValue" },
          value: { $sum: "$targetCalculatedValue" },
          currencies: { $addToSet: "$targetCurrency" },
          recordsCount: { $sum: 1 },
        },
      },
      {
        $set: {
          shipToAccountNames: {
            $filter: {
              input: "$shipToAccountNames",
              as: "shipToName",
              cond: {
                $and: [
                  { $ne: ["$$shipToName", null] },
                  { $ne: ["$$shipToName", ""] },
                ],
              },
            },
          },
          currencies: {
            $filter: {
              input: "$currencies",
              as: "currency",
              cond: {
                $and: [
                  { $ne: ["$$currency", null] },
                  { $ne: ["$$currency", ""] },
                ],
              },
            },
          },
        },
      },
      {
        $set: {
          shipToAccountName: {
            $cond: [
              { $eq: [{ $size: "$shipToAccountNames" }, 1] },
              { $first: "$shipToAccountNames" },
              null,
            ],
          },
          currency: {
            $cond: [
              { $eq: [{ $size: "$currencies" }, 1] },
              { $first: "$currencies" },
              "MIXED",
            ],
          },
        },
      },
      { $project: { currencies: 0 } },
      { $sort: { value: -1 } },
      { $limit: 50 },
    ];

    const [salesByProduct, salesByAccount, salesByChannel] = await Promise.all([
      groupBy("productId", "productName"),
      SalesRecord.aggregate(salesByAccountPipeline),
      groupBy("channelId", "channelName"),
    ]);
    const uploadedSalesByCurrency = await SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: "$uploadedCurrency",
          totalUploadedSalesValue: { $sum: "$uploadedSalesValue" },
          recordsCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales overview fetched successfully",
      data: {
        totalQuantity: summary?.totalQuantity || 0,
        totalFreeQuantity: summary?.totalFreeQuantity || 0,
        totalQuantityWithFoc: summary?.totalQuantityWithFoc || 0,
        totalUploadedSalesValue: summary?.totalUploadedSalesValue || 0,
        totalCalculatedCifUsd: summary?.totalCalculatedCifUsd || 0,
        totalCalculatedWholesaleAed: summary?.totalCalculatedWholesaleAed || 0,
        totalCalculatedRetailAed: summary?.totalCalculatedRetailAed || 0,
        totalTargetCalculatedValue: summary?.totalTargetCalculatedValue || 0,
        recordsCount: summary?.recordsCount || 0,
        matchedOrdersCount: summary?.matchedOrdersCount || 0,
        unmatchedSalesRecordsCount: summary?.unmatchedSalesRecordsCount || 0,
        needsReviewCount: summary?.needsReviewCount || 0,
        totalSharedQuantity: areaSummary?.totalSharedQuantity || 0,
        totalSharedFreeQuantity: areaSummary?.totalSharedFreeQuantity || 0,
        totalSharedCalculatedCifUsd: areaSummary?.totalSharedCalculatedCifUsd || 0,
        totalSharedCalculatedWholesaleAed: areaSummary?.totalSharedCalculatedWholesaleAed || 0,
        totalSharedCalculatedRetailAed: areaSummary?.totalSharedCalculatedRetailAed || 0,
        areaShare: areaSummary || null,
        uploadedSalesByCurrency,
        salesByProduct,
        salesByAccount,
        salesByChannel,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/channel-breakdown", auth, loadSalesActor, async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: "year must be a number between 2000 and 2100" });
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "month must be a number between 1 and 12" });
    }

    if (!req.query.accountId || !isValidObjectId(req.query.accountId)) {
      return res.status(400).json({ success: false, message: "accountId must be a valid MongoDB ObjectId" });
    }

    const accountObjectId = new mongoose.Types.ObjectId(req.query.accountId);
    const baseQuery = {
      year,
      month,
      accountId: { $in: [accountObjectId, String(req.query.accountId)] },
      status: "active",
      isActive: true,
    };

    const data = await SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: {
            channelId: "$channelId",
            channelName: "$channelName",
            productId: "$productId",
            productName: "$productName",
          },
          totalRecords: { $sum: 1 },
          quantity: { $sum: "$quantity" },
          focQuantity: { $sum: "$freeQuantity" },
          totalCalculatedCifUsd: { $sum: "$calculatedCifUsd" },
          totalCalculatedWholesaleAed: { $sum: "$calculatedWholesaleAed" },
        },
      },
      {
        $project: {
          _id: 0,
          channelId: {
            $cond: [{ $ne: ["$_id.channelId", null] }, { $toString: "$_id.channelId" }, null],
          },
          channelName: { $ifNull: ["$_id.channelName", "Unknown"] },
          productId: {
            $cond: [{ $ne: ["$_id.productId", null] }, { $toString: "$_id.productId" }, null],
          },
          name: { $ifNull: ["$_id.productName", "Unknown"] },
          totalRecords: 1,
          quantity: 1,
          focQuantity: 1,
          totalCalculatedCifUsd: 1,
          totalCalculatedWholesaleAed: 1,
        },
      },
      { $sort: { channelName: 1, quantity: -1, name: 1 } },
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales channel breakdown fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/channel-items", auth, loadSalesActor, async (req, res, next) => {
  try {
    const baseQuery = await buildSalesQuery(req.query, req.currentUser);
    baseQuery.status = baseQuery.status || "active";
    baseQuery.isActive = true;
    const targetYear = Number(req.query.year);

    const data = await SalesRecord.aggregate([
      { $match: baseQuery },
      {
        $group: {
          _id: {
            channelId: "$channelId",
            channelName: "$channelName",
            productId: "$productId",
            productName: "$productName",
          },
          totalRecords: { $sum: 1 },
          qty: { $sum: "$quantity" },
          focQty: { $sum: "$freeQuantity" },
          cif: { $sum: "$calculatedCifUsd" },
          value: { $sum: "$calculatedWholesaleAed" },
        },
      },
      {
        $lookup: {
          from: "targetassignments",
          let: {
            productId: "$_id.productId",
            channelId: "$_id.channelId",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$productId"] },
                    { $eq: ["$channelId", "$$channelId"] },
                    ...(Number.isInteger(targetYear) ? [{ $eq: ["$year", targetYear] }] : []),
                    { $eq: ["$status", "active"] },
                    { $eq: ["$isActive", true] },
                  ],
                },
              },
            },
            { $sort: { updatedAt: -1, createdAt: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, targetValueBasis: 1 } },
          ],
          as: "targetAssignment",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      {
        $set: {
          assignmentTargetValueBasis: { $first: "$targetAssignment.targetValueBasis" },
          product: { $first: "$product" },
        },
      },
      {
        $set: {
          channelPricing: {
            $first: {
              $filter: {
                input: { $ifNull: ["$product.channelPricing", []] },
                as: "pricing",
                cond: { $eq: ["$$pricing.channelId", "$_id.channelId"] },
              },
            },
          },
        },
      },
      {
        $set: {
          targetValueBasis: {
            $ifNull: [
              "$assignmentTargetValueBasis",
              { $ifNull: ["$channelPricing.targetValueBasis", "cifUsd"] },
            ],
          },
        },
      },
      {
        $set: {
          target_CIF: {
            $switch: {
              branches: [
                { case: { $eq: ["$targetValueBasis", "wholesaleAed"] }, then: { $ifNull: ["$channelPricing.wholesaleAed", 0] } },
                { case: { $eq: ["$targetValueBasis", "retailAed"] }, then: { $ifNull: ["$channelPricing.retailAed", 0] } },
              ],
              default: { $ifNull: ["$channelPricing.cifUsd", 0] },
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          channelId: {
            $cond: [{ $ne: ["$_id.channelId", null] }, { $toString: "$_id.channelId" }, null],
          },
          channelName: { $ifNull: ["$_id.channelName", "Unknown"] },
          productId: {
            $cond: [{ $ne: ["$_id.productId", null] }, { $toString: "$_id.productId" }, null],
          },
          itemName: { $ifNull: ["$_id.productName", "Unknown"] },
          totalRecords: 1,
          cif: 1,
          target_CIF: 1,
          targetValueBasis: 1,
          qty: 1,
          focQty: 1,
          value: 1,
        },
      },
      { $sort: { channelName: 1, qty: -1, itemName: 1 } },
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales channel items fetched successfully",
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/mappings", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const payload = normalizeMappingPayload(req.body);
    const validationError = validateMappingPayload(payload);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (payload.isDefault) {
      await SalesSheetMapping.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    }

    const mapping = await SalesSheetMapping.create({
      ...payload,
      status: payload.status || "active",
      createdBy: req.currentUser._id,
      updatedBy: req.currentUser._id,
    });

    return res.status(201).json({ success: true, message: "Sales sheet mapping created successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.get("/mappings", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = {};

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.search) {
      const search = String(req.query.search).trim();
      query.$or = [
        { mappingName: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { sourceType: { $regex: search, $options: "i" } },
      ];
    }

    const [mappings, total] = await Promise.all([
      SalesSheetMapping.find(query).sort({ isDefault: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      SalesSheetMapping.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales sheet mappings fetched successfully",
      data: mappings,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/mappings/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Mapping id must be a valid MongoDB ObjectId" });
    }

    const mapping = await SalesSheetMapping.findById(req.params.id);

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping fetched successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.patch("/mappings/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Mapping id must be a valid MongoDB ObjectId" });
    }

    const payload = normalizeMappingPayload(req.body);
    Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
    const validationError = validateMappingPayload(payload, { partial: true });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (payload.isDefault) {
      await SalesSheetMapping.updateMany({ _id: { $ne: req.params.id }, isDefault: true }, { $set: { isDefault: false } });
    }

    const mapping = await SalesSheetMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { ...payload, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping updated successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.patch("/mappings/:id/status", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const status = String(req.body.status || "").trim().toLowerCase();

    if (!MAPPING_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active or inactive" });
    }

    const mapping = await SalesSheetMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { status, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping status updated successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.delete("/mappings/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const mapping = await SalesSheetMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "inactive", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return res.status(404).json({ success: false, message: "Sales sheet mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Sales sheet mapping deactivated successfully", data: mapping });
  } catch (error) {
    return next(error);
  }
});

router.get("/batches", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = await getAccessibleSalesBatchQuery(req.currentUser);

    ["year", "month"].forEach((field) => {
      if (req.query[field]) {
        query[field] = Number(req.query[field]);
      }
    });

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.search) {
      query.fileName = { $regex: String(req.query.search).trim(), $options: "i" };
    }

    const [batches, total] = await Promise.all([
      SalesUploadBatch.find(query)
        .populate("uploadedBy", "fullName email businessEmail role")
        .sort({ uploadDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SalesUploadBatch.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales upload batches fetched successfully",
      data: batches,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/batches/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Batch id must be a valid MongoDB ObjectId" });
    }

    const batch = await SalesUploadBatch.findOne({
      _id: req.params.id,
      ...await getAccessibleSalesBatchQuery(req.currentUser),
    })
      .populate("uploadedBy", "fullName email businessEmail role");

    if (!batch) {
      return res.status(404).json({ success: false, message: "Sales upload batch not found" });
    }

    return res.status(200).json({ success: true, message: "Sales upload batch fetched successfully", data: batch });
  } catch (error) {
    return next(error);
  }
});

router.get("/batches/:id/records", auth, loadSalesActor, async (req, res, next) => {
  try {
    req.query.batchId = req.params.id;
    const query = await buildSalesQuery(req.query, req.currentUser);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [records, total] = await Promise.all([
      SalesRecord.find(query).sort({ rowNumber: 1 }).skip((page - 1) * limit).limit(limit),
      SalesRecord.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Sales upload batch records fetched successfully",
      data: records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/batches/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const batch = await SalesUploadBatch.findOne({
      _id: req.params.id,
      ...await getAccessibleSalesBatchQuery(req.currentUser),
    });

    if (!batch) {
      return res.status(404).json({ success: false, message: "Sales upload batch not found" });
    }

    batch.status = "failed";
    batch.notes = [batch.notes, "Batch deactivated"].filter(Boolean).join(" | ");
    await batch.save();
    await batch.populate("uploadedBy", "fullName email businessEmail role");

    if (normalizeBoolean(req.query.markRecordsIgnored ?? req.body.markRecordsIgnored, false)) {
      await SalesRecord.updateMany(
        { salesUploadBatchId: batch._id },
        { $set: { status: "ignored", isActive: false, updatedBy: req.currentUser._id } },
      );
    }

    return res.status(200).json({ success: true, message: "Sales upload batch deactivated successfully", data: batch });
  } catch (error) {
    return next(error);
  }
});

router.delete("/month", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const month = req.body.month ?? req.query.month;
    const year = req.body.year ?? req.query.year;
    const validationError = validateMonthYear(month, year);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const normalizedMonth = Number(month);
    const normalizedYear = Number(year);
    const salesQuery = {
      ...await getAccessibleSalesQuery(req.currentUser),
      month: normalizedMonth,
      year: normalizedYear,
    };
    const batchIds = (await SalesRecord.distinct("salesUploadBatchId", salesQuery)).filter(Boolean);
    const deleteResult = await SalesRecord.deleteMany(salesQuery);
    const batchUpdateResult = batchIds.length > 0
      ? await SalesUploadBatch.updateMany(
        {
          ...await getAccessibleSalesBatchQuery(req.currentUser),
          _id: { $in: batchIds },
          month: normalizedMonth,
          year: normalizedYear,
        },
        {
          $set: { status: "failed" },
          $push: {
            warnings: {
              rowNumber: 0,
              message: `Sales records deleted for ${normalizedMonth}/${normalizedYear}`,
            },
          },
        },
      )
      : { modifiedCount: 0 };

    return res.status(200).json({
      success: true,
      message: "Sales records deleted for selected month",
      data: {
        month: normalizedMonth,
        year: normalizedYear,
        deletedSalesRecords: deleteResult.deletedCount || 0,
        deactivatedBatches: batchUpdateResult.modifiedCount || 0,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, loadSalesActor, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = await buildSalesQuery(req.query, req.currentUser);

    if (!req.query.status) {
      query.status = "active";
      query.isActive = true;
    }

    const [records, total] = await Promise.all([
      SalesRecord.find(query).sort({ salesDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalesRecord.countDocuments(query),
    ]);
    const data = req.query.areaId && isValidObjectId(req.query.areaId)
      ? records.map((record) => ({
        ...record,
        matchingAreaShare: (record.areaShares || []).find((areaShare) => (
          String(areaShare.areaId) === String(req.query.areaId)
        )) || null,
      }))
      : records;

    return res.status(200).json({
      success: true,
      message: "Sales records fetched successfully",
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", auth, loadSalesActor, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Sales record id must be a valid MongoDB ObjectId" });
    }

    const record = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    return res.status(200).json({ success: true, message: "Sales record fetched successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Sales record id must be a valid MongoDB ObjectId" });
    }

    const existingRecord = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!existingRecord) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    const allowedFields = [
      "invoiceNumber", "externalSalesReference", "salesDate", "invoiceDate", "month", "year",
      "accountId", "accountName", "shipToAccountName", "accountExternalCode", "accountMatched",
      "productId", "productName", "productNickname", "productExternalCode", "productMatched",
      "channelId", "channelName", "channelKey", "channelMatched", "channelDetectionMethod",
      "salesType",
      "quantity", "freeQuantity", "uploadedSalesValue", "uploadedCurrency", "uploadedUnitValue",
      "detectedPriceBasis", "detectedPriceCurrency", "matchStatus",
      "targetValueBasis", "targetCurrency", "targetUnitValue", "targetCalculatedValue",
      "matchConfidence", "matchNotes", "status", "isActive",
    ];
    const update = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    if (update.salesDate) {
      update.salesDate = parseDate(update.salesDate, "salesDate", { preferDayFirst: true });
    }

    if (update.invoiceDate) {
      update.invoiceDate = parseDate(update.invoiceDate, "invoiceDate", { preferDayFirst: true });
    }

    if (update.matchStatus && !MATCH_STATUSES.includes(update.matchStatus)) {
      return res.status(400).json({ success: false, message: "Invalid matchStatus" });
    }

    if (update.status && !RECORD_STATUSES.includes(update.status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    if (update.quantity !== undefined || update.freeQuantity !== undefined) {
      const quantity = update.quantity !== undefined ? Number(update.quantity) : Number(existingRecord.quantity || 0);
      const freeQuantity = update.freeQuantity !== undefined ? Number(update.freeQuantity) : Number(existingRecord.freeQuantity || 0);
      update.totalQuantityWithFoc = quantity + freeQuantity;
    }

    update.updatedBy = req.currentUser._id;

    const record = await SalesRecord.findByIdAndUpdate(
      existingRecord._id,
      { $set: update },
      { new: true, runValidators: true },
    );

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    await applySharedSalesToRecord(record);
    await record.save();

    return res.status(200).json({ success: true, message: "Sales record updated successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/status", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const status = String(req.body.status || "").trim().toLowerCase();

    if (!RECORD_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "status must be active, ignored, duplicate, or error" });
    }

    const existingRecord = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!existingRecord) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    const record = await SalesRecord.findByIdAndUpdate(
      existingRecord._id,
      { $set: { status, isActive: status === "active", updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    return res.status(200).json({ success: true, message: "Sales record status updated successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", auth, loadSalesActor, requireManager, async (req, res, next) => {
  try {
    const existingRecord = await getScopedSalesRecord(req.params.id, req.currentUser);

    if (!existingRecord) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    const record = await SalesRecord.findByIdAndUpdate(
      existingRecord._id,
      { $set: { status: "ignored", isActive: false, updatedBy: req.currentUser._id } },
      { new: true, runValidators: true },
    );

    if (!record) {
      return res.status(404).json({ success: false, message: "Sales record not found" });
    }

    return res.status(200).json({ success: true, message: "Sales record ignored successfully", data: record });
  } catch (error) {
    return next(error);
  }
});

router._test = {
  detectSalesChannel,
  detectSalesChannelByRule,
  getChannelTypeHint,
  normalizeSalesRow,
  validateSalesRow,
  priceValuesMatch,
};

router.runSalesOrderMatchForPeriod = runSalesOrderMatchForPeriod;
router.runSalesTargetMatchForPeriod = runSalesTargetMatchForPeriod;

module.exports = router;
