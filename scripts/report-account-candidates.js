require("dotenv").config();

const mongoose = require("mongoose");
const Account = require("../models/Account");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;
const input = process.argv.slice(2).join(" ");

const normalizeText = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const tokens = (value) => normalizeText(value).split(" ").filter(Boolean);

const levenshtein = (a, b) => {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);

  for (let index = 1; index <= b.length; index += 1) {
    rows[0][index] = index;
  }

  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      rows[row][col] = Math.min(
        rows[row - 1][col] + 1,
        rows[row][col - 1] + 1,
        rows[row - 1][col - 1] + (a[row - 1] === b[col - 1] ? 0 : 1),
      );
    }
  }

  return rows[a.length][b.length];
};

const scoreCandidate = (needle, candidate) => {
  const normalizedNeedle = normalizeText(needle);
  const normalizedCandidate = normalizeText(candidate.accountName);
  const needleTokens = tokens(needle);
  const candidateTokens = tokens(candidate.accountName);
  const commonTokens = needleTokens.filter((token) => candidateTokens.includes(token));
  const tokenScore = needleTokens.length > 0 ? commonTokens.length / needleTokens.length : 0;
  const containsScore = normalizedCandidate.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedCandidate) ? 1 : 0;
  const distance = levenshtein(normalizedNeedle, normalizedCandidate);
  const maxLength = Math.max(normalizedNeedle.length, normalizedCandidate.length, 1);
  const editScore = 1 - (distance / maxLength);

  return Math.max(tokenScore, containsScore, editScore);
};

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  if (!input) {
    throw new Error("Usage: node scripts/report-account-candidates.js <account name>");
  }

  await mongoose.connect(mongoUri);

  const search = normalizeText(input);
  const searchRegex = search.split(" ").filter(Boolean).map((part) => `(?=.*${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`).join("");
  const regexCandidates = await Account.find({
    accountName: { $regex: searchRegex || search, $options: "i" },
  }).select("_id accountName accountExternalCode status isActive").limit(25).lean();

  const allAccounts = await Account.find({})
    .select("_id accountName accountExternalCode status isActive")
    .lean();
  const fuzzyCandidates = allAccounts
    .map((account) => ({ ...account, score: scoreCandidate(input, account) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 15);

  console.log(JSON.stringify({
    input,
    normalizedInput: search,
    regexCandidates,
    fuzzyCandidates,
  }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
