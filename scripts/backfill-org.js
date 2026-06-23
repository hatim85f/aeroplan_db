/**
 * One-time backfill: tag ALL existing global-catalog data + users with the
 * REAL organization id, so the live app keeps seeing its real catalogs once
 * organizationId scoping is enabled. Safe/idempotent — only sets where missing.
 *
 * Run BEFORE re-seeding the demo (the demo seed tags its own data DEMO_ORG).
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { REAL_ORG_ID } = require("../helpers/tenancy");

const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const MONGO_URI = env.split("\n").find((l) => l.startsWith("MONGO_URI")).split("=").slice(1).join("=").trim();

const Product = require("../models/Product");
const SalesChannel = require("../models/SalesChannel");
const Line = require("../models/Line");
const User = require("../models/User");

(async () => {
  await mongoose.connect(MONGO_URI);
  const miss = { organizationId: { $exists: false } };
  const r = {};
  r.products = (await Product.updateMany(miss, { $set: { organizationId: REAL_ORG_ID } })).modifiedCount;
  r.channels = (await SalesChannel.updateMany(miss, { $set: { organizationId: REAL_ORG_ID } })).modifiedCount;
  r.lines = (await Line.updateMany(miss, { $set: { organizationId: REAL_ORG_ID } })).modifiedCount;
  r.users = (await User.updateMany(miss, { $set: { organizationId: REAL_ORG_ID } })).modifiedCount;
  console.log("Backfilled REAL_ORG on:", JSON.stringify(r));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
