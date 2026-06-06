require("dotenv").config();

const mongoose = require("mongoose");
const Account = require("../models/Account");
const SalesRecord = require("../models/SalesRecord");

const normalizeText = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const getArg = (name) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};

const main = async () => {
  const accountName = getArg("accountName");
  const canonicalAccountId = getArg("canonicalAccountId");
  const apply = process.argv.includes("--apply");
  const fixAll = process.argv.includes("--all");

  if (!fixAll && !accountName) {
    throw new Error("Usage: node scripts/fix-sales-account-link.js --accountName=\"Name\" [--canonicalAccountId=<id>] [--apply] OR --all [--apply]");
  }

  if (canonicalAccountId && !mongoose.Types.ObjectId.isValid(canonicalAccountId)) {
    throw new Error("canonicalAccountId must be a valid MongoDB ObjectId");
  }

  await mongoose.connect(process.env.MONGO_URI || process.env.mongoURI);

  const allAccounts = await Account.find({}).lean();
  const sortAccounts = (accounts) => [...accounts].sort((left, right) => (
      getAccountMatchPriority(right) - getAccountMatchPriority(left)
      || new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0)
  ));
  const groupsByName = allAccounts.reduce((groups, account) => {
    const key = normalizeText(account.accountName);

    if (!key) {
      return groups;
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(account);
    return groups;
  }, new Map());
  const requestedGroups = fixAll
    ? [...groupsByName.entries()]
    : [[normalizeText(accountName), groupsByName.get(normalizeText(accountName)) || []]];
  const results = [];

  for (const [normalizedName, accounts] of requestedGroups) {
    const matchingAccounts = sortAccounts(accounts);
    const canonicalAccount = canonicalAccountId && !fixAll
      ? await Account.findById(canonicalAccountId).lean()
      : matchingAccounts[0];

    if (!canonicalAccount) {
      if (!fixAll) {
        throw new Error("Canonical account not found");
      }
      continue;
    }

    const names = [...new Set(matchingAccounts.map((account) => account.accountName).filter(Boolean))];
    const nameRegexes = names.map((name) => new RegExp(`^${escapeRegex(name.trim())}$`, "i"));
    const canonicalIdString = String(canonicalAccount._id);
    const baseNameQuery = {
      accountName: { $in: nameRegexes },
    };
    const query = {
      ...baseNameQuery,
      accountId: { $ne: canonicalAccount._id },
    };
    const beforeCount = await SalesRecord.countDocuments(query);
    const recordsByAccountId = await SalesRecord.aggregate([
      {
        $match: baseNameQuery,
      },
      {
        $group: {
          _id: "$accountId",
          count: { $sum: 1 },
          activeCount: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "active"] }, { $eq: ["$isActive", true] }] }, 1, 0] } },
        },
      },
    ]);
    const summary = {
      normalizedName,
      canonicalAccount: {
        _id: canonicalAccount._id,
        accountName: canonicalAccount.accountName,
        priority: getAccountMatchPriority(canonicalAccount),
      },
      matchingAccounts: matchingAccounts.map((account) => ({
        _id: account._id,
        accountName: account.accountName,
        priority: getAccountMatchPriority(account),
        keyContact: account.keyContact,
        area: account.area,
        territory: account.territory,
      })),
      salesRecordsByAccountId: recordsByAccountId.map((row) => ({
        accountId: row._id ? String(row._id) : null,
        count: row.count,
        activeCount: row.activeCount,
        isCanonical: row._id ? String(row._id) === canonicalIdString : false,
      })),
      recordsToUpdate: beforeCount,
    };

    if (apply && beforeCount > 0) {
      const result = await SalesRecord.updateMany(query, {
        $set: {
          accountId: canonicalAccount._id,
          accountName: canonicalAccount.accountName,
          accountMatched: true,
        },
      });

      summary.matchedCount = result.matchedCount;
      summary.modifiedCount = result.modifiedCount;
    }

    if (beforeCount > 0 || matchingAccounts.length > 1 || !fixAll) {
      results.push(summary);
    }
  }

  console.log(JSON.stringify({
    apply,
    mode: fixAll ? "all" : "single",
    scannedAccountNameGroups: requestedGroups.length,
    groupsNeedingAttention: results.length,
    totalRecordsToUpdate: results.reduce((total, result) => total + result.recordsToUpdate, 0),
    totalModified: results.reduce((total, result) => total + (result.modifiedCount || 0), 0),
    results,
  }, null, 2));

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
