/**
 * Seed an isolated DEMO company (manager + 3 reps) with fake accounts, planning,
 * sales, targets and tasks — for App Store / Play screenshots on real devices.
 * Idempotent: clears previously-seeded demo data (by the demo manager) first.
 * Uses ONLY fake names. Does not touch real company data.
 *
 * Run:  node scripts/seed-demo.js
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const MONGO_URI = env.split("\n").find((l) => l.startsWith("MONGO_URI")).split("=").slice(1).join("=").trim();

const User = require("../models/User");
const Team = require("../models/Team");
const Account = require("../models/Account");
const SalesChannel = require("../models/SalesChannel");
const Product = require("../models/Product");
const PlanningAccount = require("../models/PlanningAccount");
const PlanningVisit = require("../models/PlanningVisit");
const SalesUploadBatch = require("../models/SalesUploadBatch");
const SalesRecord = require("../models/SalesRecord");
const TargetAssignment = require("../models/TargetAssignment");
const TargetPhasing = require("../models/TargetPhasing");
const Task = require("../models/Task");
const ForecastMonth = require("../models/ForecastMonth");
const Line = require("../models/Line");
const { createAppId } = require("../helpers/appId");
const { DEMO_ORG_ID } = require("../helpers/tenancy");

const PASSWORD = "AeroDemo#2026";
const MANAGER_EMAIL = "demo.manager@aero-plan.me";
const REPS = [
  { email: "demo.rep1@aero-plan.me", fullName: "Sara Idris",  userName: "demo_sara" },
  { email: "demo.rep2@aero-plan.me", fullName: "Omar Najjar", userName: "demo_omar" },
  { email: "demo.rep3@aero-plan.me", fullName: "Lina Saeed",  userName: "demo_lina" },
];
const DEMO_EMAILS = [MANAGER_EMAIL, ...REPS.map((r) => r.email)];

const now = new Date();
const YEAR = now.getFullYear();
const MONTH = now.getMonth() + 1;
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0,0,0,0);
const weekDay = (offset) => { const d = new Date(monday); d.setDate(monday.getDate() + offset); return d; };
const monthName = (m) => ["January","February","March","April","May","June","July","August","September","October","November","December"][m-1];

async function makeUser({ email, fullName, userName, role, managerId, path: hpath, teamId }) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return User.create({
    email, appId: await createAppId(), passwordHash, emailVerified: true,
    authProviders: ["password"], fullName, userName,
    phone: "+9715" + Math.floor(10000000 + Math.random()*89999999),
    role, status: "active", managerId, path: hpath || [], teamId,
    organizationId: DEMO_ORG_ID,
    lastLoginAt: now, lastActivityAt: now, onlineStatus: "offline",
  });
}

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log("Connected:", mongoose.connection.db.databaseName);

  // ---- 1. Clean any prior demo run (isolated by demo emails / manager) ----
  const prior = await User.find({ email: { $in: DEMO_EMAILS } }).select("_id").lean();
  const priorIds = prior.map((u) => u._id);
  if (priorIds.length) {
    await Promise.all([
      Account.deleteMany({ createdBy: { $in: priorIds } }),
      SalesChannel.deleteMany({ createdBy: { $in: priorIds } }),
      Product.deleteMany({ createdBy: { $in: priorIds } }),
      PlanningAccount.deleteMany({ userId: { $in: priorIds } }),
      PlanningVisit.deleteMany({ userId: { $in: priorIds } }),
      SalesRecord.deleteMany({ createdBy: { $in: priorIds } }),
      SalesUploadBatch.deleteMany({ uploadedBy: { $in: priorIds } }),
      TargetAssignment.deleteMany({ userId: { $in: priorIds } }),
      TargetPhasing.deleteMany({ createdBy: { $in: priorIds } }),
      Task.deleteMany({ createdBy: { $in: priorIds } }),
      ForecastMonth.deleteMany({ userId: { $in: priorIds } }),
      Line.deleteMany({ createdBy: { $in: priorIds } }),
      Team.deleteMany({ managerId: { $in: priorIds } }),
      User.deleteMany({ _id: { $in: priorIds } }),
    ]);
    console.log("Cleared prior demo data for", priorIds.length, "users");
  }

  // ---- 2. Users + team ----
  const manager = await makeUser({ email: MANAGER_EMAIL, fullName: "Khalid Rahman", userName: "demo_khalid", role: "manager", path: [] });
  const reps = [];
  for (const r of REPS) reps.push(await makeUser({ ...r, role: "representative", managerId: manager._id, path: [manager._id] }));
  const team = await Team.create({
    teamName: "North Field Team", teamCode: "NFT-01", managerId: manager._id,
    createdBy: manager._id, members: reps.map((r) => r._id), status: "active",
    lineId: "GENMED", lineName: "General Medicine", territory: "North", area: "North Zone",
  });
  await User.updateMany({ _id: { $in: reps.map((r) => r._id) } }, { $set: { teamId: team._id } });
  await User.updateOne({ _id: manager._id }, { $set: { teamId: team._id } });

  // ---- 3. Line + channel + products (fake, tagged to the demo organization) ----
  await Line.create({
    lineId: "GENMED", lineName: "General Medicine", description: "Demo product line",
    organizationId: DEMO_ORG_ID, isActive: true, createdBy: manager._id,
  });
  const channel = await SalesChannel.create({
    channelName: "Private Retail", channelKey: "private", channelGroup: "private",
    defaultTargetValueBasis: "cifUsd", defaultTargetCurrency: "USD", status: "active", isActive: true,
    organizationId: DEMO_ORG_ID, createdBy: manager._id,
  });
  const PRODUCTS = [
    { productName: "Reliva 500mg Tablets", productNickname: "RLV500", cif: 6.0,  ws: 24, rt: 30 },
    { productName: "Calmax Oral Syrup 100ml", productNickname: "CMX100", cif: 4.5, ws: 18, rt: 23 },
    { productName: "Dermacool Cream 15g", productNickname: "DRC15", cif: 3.2,  ws: 13, rt: 17 },
    { productName: "Nutriza Capsules 30s", productNickname: "NTZ30", cif: 7.5,  ws: 30, rt: 38 },
  ];
  const products = [];
  for (const p of PRODUCTS) {
    products.push(await Product.create({
      productName: p.productName, productNickname: p.productNickname, lineId: "GENMED", lineName: "General Medicine",
      status: "active", isActive: true, organizationId: DEMO_ORG_ID, createdBy: manager._id,
      channelPricing: [{ channelId: channel._id, channelName: channel.channelName, channelKey: "private", channelGroup: "private",
        isAvailable: true, cifUsd: p.cif, wholesaleAed: p.ws, retailAed: p.rt, targetValueBasis: "cifUsd", targetCurrency: "USD" }],
    }));
  }

  // ---- 4. Accounts (fake) assigned to reps ----
  const ACCOUNTS = [
    ["Northbridge Specialty Hospital", "hospital"], ["Cityline Medical Center", "clinic"],
    ["Summit Care Clinic", "clinic"], ["Lakeside Pharmacy", "pharmacy"],
    ["Parkview General Hospital", "hospital"], ["Crescent Community Pharmacy", "pharmacy"],
  ];
  const accounts = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const rep = reps[i % reps.length];
    accounts.push(await Account.create({
      accountName: ACCOUNTS[i][0], accountType: ACCOUNTS[i][1], area: "North Zone", territory: "North",
      keyContact: "Procurement Office", assignedMedicalRepIds: [rep._id], createdBy: manager._id,
    }));
  }

  // ---- 5. Planning accounts + visits (current week) ----
  const statuses = ["submitted", "submitted", "draft", "submitted", "draft"];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const rep = reps[i % reps.length];
    const pa = await PlanningAccount.create({
      userId: rep._id, userName: rep.fullName, managerId: manager._id, teamId: team._id,
      accountId: acc._id, accountName: acc.accountName, accountType: acc.accountType,
      area: "North Zone", territory: "North", status: "active", isActive: true, createdBy: rep._id,
    });
    const visitDate = weekDay(2 + (i % 4)); // Wed..Sat
    await PlanningVisit.create({
      userId: rep._id, userName: rep.fullName, managerId: manager._id, teamId: team._id,
      planningAccountId: pa._id, accountId: acc._id, accountName: acc.accountName,
      visitDate, year: visitDate.getFullYear(), month: visitDate.getMonth() + 1, weekStartDate: monday,
      planStatus: statuses[i % statuses.length], submittedAt: statuses[i % statuses.length] === "submitted" ? now : undefined,
      status: "active", isActive: true, createdBy: rep._id,
    });
  }

  // ---- 6. Targets (per rep per product) + default phasing ----
  await TargetPhasing.create({
    name: `Default Phasing ${YEAR}`, year: YEAR, status: "active", isDefault: true, isActive: true, createdBy: manager._id,
    months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, monthName: monthName(i + 1), percentage: i === 11 ? 8.37 : 8.33 })),
  });
  for (const rep of reps) {
    for (const prod of products) {
      const cif = prod.channelPricing[0].cifUsd;
      const units = 1200 + Math.floor(Math.random() * 800);
      await TargetAssignment.create({
        userId: rep._id, userName: rep.fullName, managerId: manager._id, teamId: team._id,
        lineId: "GENMED", lineName: "General Medicine",
        productId: prod._id, productName: prod.productName, productNickname: prod.productNickname,
        channelId: channel._id, channelName: channel.channelName, channelKey: "private",
        year: YEAR, startDate: new Date(YEAR, 0, 1), endDate: new Date(YEAR, 11, 31),
        accountabilityPercentage: 100, totalTargetUnits: units, totalTargetValue: Math.round(units * cif),
        targetValueBasis: "cifUsd", targetCurrency: "USD", status: "active", isActive: true, createdBy: manager._id,
      });
    }
  }

  // ---- 7. Sales records (current month, ~70-85% of monthly target) ----
  const batch = await SalesUploadBatch.create({
    fileName: "demo-sales.xlsx", uploadedBy: manager._id, month: MONTH, year: YEAR, totalRows: 0, status: "completed",
  });
  let salesRows = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const rep = reps[i % reps.length];
    for (const prod of products) {
      const cif = prod.channelPricing[0].cifUsd;
      const ws = prod.channelPricing[0].wholesaleAed;
      const qty = 45 + Math.floor(Math.random() * 22);
      const salesDate = weekDay(1 + (i % 5));
      await SalesRecord.create({
        salesUploadBatchId: batch._id, entrySource: "upload", invoiceNumber: "INV-" + (1000 + salesRows),
        salesDate, month: MONTH, year: YEAR,
        accountId: acc._id, accountName: acc.accountName, accountMatched: true,
        productId: prod._id, productName: prod.productName, productNickname: prod.productNickname, productMatched: true,
        channelId: channel._id, channelName: channel.channelName, channelKey: "private", channelMatched: true,
        channelDetectionMethod: "sheet_channel",
        quantity: qty, freeQuantity: 0,
        uploadedSalesValue: Math.round(qty * ws), uploadedCurrency: "AED", uploadedUnitValue: ws,
        detectedPriceBasis: "cifUsd", detectedPriceCurrency: "USD",
        calculatedCifUsd: Math.round(qty * cif), calculatedWholesaleAed: Math.round(qty * ws), calculatedRetailAed: Math.round(qty * prod.channelPricing[0].retailAed),
        unitCifUsd: cif, unitWholesaleAed: ws, unitRetailAed: prod.channelPricing[0].retailAed,
        targetValueBasis: "cifUsd", targetCurrency: "USD",
        repAttributions: [{ userId: rep._id, userName: rep.fullName, percentage: 100 }],
        matchStatus: "matched", status: "active", isActive: true, createdBy: manager._id,
      });
      salesRows++;
    }
  }
  await SalesUploadBatch.updateOne({ _id: batch._id }, { $set: { totalRows: salesRows, successRows: salesRows } });

  // ---- 8. Forecast (current month) ----
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const rep = reps[i % reps.length];
    const prod = products[i % products.length];
    try {
      await ForecastMonth.create({
        userId: rep._id, accountId: acc._id, accountName: acc.accountName,
        productId: prod._id, productName: prod.productName, channelId: channel._id,
        year: YEAR, month: MONTH, inputType: "value", forecastValue: 4000 + Math.floor(Math.random()*4000),
        forecastQuantity: 0, status: "planned", createdBy: rep._id,
      });
    } catch (e) { /* forecast optional */ }
  }

  // ---- 9. Tasks ----
  const TASKS = ["Q2 coverage review", "Daily detailing log", "Submit weekly plan", "Follow up Northbridge order"];
  for (let i = 0; i < TASKS.length; i++) {
    const rep = reps[i % reps.length];
    try {
      await Task.create({
        title: TASKS[i], description: "Demo task for screenshots", taskType: "checklist",
        createdBy: manager._id,
        assignedUsers: [{ userId: rep._id, userName: rep.fullName, status: "active" }],
        priority: ["high", "medium", "low", "urgent"][i % 4],
        taskStatus: "active", dueDate: weekDay(3 + i), teamId: team._id, isActive: true,
      });
    } catch (e) { console.log("task skip:", e.message); }
  }

  console.log("\n===== DEMO SEED COMPLETE =====");
  console.log("Password (all):", PASSWORD);
  console.log("Manager:", MANAGER_EMAIL);
  REPS.forEach((r) => console.log("Rep:", r.email, "(" + r.fullName + ")"));
  console.log("Accounts:", accounts.length, "Products:", products.length, "Sales rows:", salesRows);
  await mongoose.disconnect();
})().catch((e) => { console.error("SEED ERROR:", e); process.exit(1); });
