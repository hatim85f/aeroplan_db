/**
 * Migration: create the hidden Organization records and tag ALL existing
 * business documents with their organizationId.
 *   - Demo data (owned by the demo users, already flagged DEMO on their User
 *     docs) -> DEMO org.
 *   - Everything else (the real current business data) -> MAIN org.
 *
 * Additive only: sets organizationId where missing; never deletes/overwrites
 * existing org values. Safe to run before the query-scoping deploy — the live
 * code ignores the field until phase 2 ships.
 *
 * Run: node scripts/migrate-org.js
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { REAL_ORG_ID, DEMO_ORG_ID } = require("../helpers/tenancy");

const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const MONGO_URI = env.split("\n").find((l) => l.startsWith("MONGO_URI")).split("=").slice(1).join("=").trim();

const Organization = require("../models/Organization");
const User = require("../models/User");

// Every business collection (everything except Organization + AppMainDetails).
const COLLECTIONS = [
  "User", "Account", "AccountFocOverride", "AccountRepAssignment", "Area", "Feedback",
  "ForecastMonth", "Item", "Line", "Notification", "Order", "PlanningAccount",
  "PlanningVisit", "Product", "SalesChannel", "SalesDetectionRule", "SalesRecord",
  "SalesSheetMapping", "SalesTeamMember", "SalesUploadBatch", "SharedSalesRule",
  "StockAccount", "StockUpdate", "TargetAssignment", "TargetPhasing", "Task",
  "TaskActivity", "TaskMessage", "TaskOccurrence", "Team", "TeamInvitation",
];

// Any of these fields pointing at a demo user marks a document as demo-owned.
const OWNER_FIELDS = ["createdBy", "userId", "uploadedBy", "managerId", "updatedBy",
  "assignedMedicalRepIds", "to", "from", "fromManagerId", "toUserId"];

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log("Connected:", mongoose.connection.db.databaseName);

  // 1. Create the hidden org records (fixed ids matched by helpers/tenancy.js).
  await Organization.updateOne(
    { _id: REAL_ORG_ID },
    { $setOnInsert: { name: "Main", slug: "main", status: "active", isHidden: true } },
    { upsert: true },
  );
  await Organization.updateOne(
    { _id: DEMO_ORG_ID },
    { $setOnInsert: { name: "Demo (screenshots)", slug: "demo", status: "active", isHidden: true } },
    { upsert: true },
  );
  console.log("Organizations ready: Main + Demo");

  // 2. Demo users were flagged DEMO by the seed.
  const demoUserIds = (await User.find({ organizationId: DEMO_ORG_ID }).select("_id").lean()).map((u) => u._id);
  console.log("Demo users:", demoUserIds.length);
  const demoOr = OWNER_FIELDS.map((f) => ({ [f]: { $in: demoUserIds } }));

  // 3. Tag each collection: demo-owned -> DEMO, the rest of the untagged -> MAIN.
  for (const name of COLLECTIONS) {
    const Model = require("../models/" + name);
    let demo = 0;
    if (demoUserIds.length) {
      demo = (await Model.updateMany(
        { organizationId: { $exists: false }, $or: demoOr },
        { $set: { organizationId: DEMO_ORG_ID } },
      )).modifiedCount;
    }
    const main = (await Model.updateMany(
      { organizationId: { $exists: false } },
      { $set: { organizationId: REAL_ORG_ID } },
    )).modifiedCount;
    if (demo || main) console.log(`${name}: main=${main} demo=${demo}`);
  }

  console.log("Migration complete.");
  await mongoose.disconnect();
})().catch((e) => { console.error("MIGRATE ERROR:", e); process.exit(1); });
