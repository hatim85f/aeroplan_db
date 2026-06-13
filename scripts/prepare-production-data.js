require("dotenv").config();

const mongoose = require("mongoose");

const defaults = require("../config/default.json");

const ForecastMonth = require("../models/ForecastMonth");
const Order = require("../models/Order");
const PlanningAccount = require("../models/PlanningAccount");
const PlanningVisit = require("../models/PlanningVisit");
const SalesRecord = require("../models/SalesRecord");
const SalesUploadBatch = require("../models/SalesUploadBatch");
const StockAccount = require("../models/StockAccount");
const StockUpdate = require("../models/StockUpdate");
const Task = require("../models/Task");
const TaskActivity = require("../models/TaskActivity");
const TaskMessage = require("../models/TaskMessage");
const TaskOccurrence = require("../models/TaskOccurrence");
const User = require("../models/User");

const APPLY = process.argv.includes("--apply");
const ZAHRA_EMAIL = "zahra.hanafy@axantia.com";

const collectionsToClear = [
  ["ForecastMonth", ForecastMonth],
  ["Order", Order],
  ["SalesRecord", SalesRecord],
  ["SalesUploadBatch", SalesUploadBatch],
  ["TaskActivity", TaskActivity],
  ["TaskMessage", TaskMessage],
  ["TaskOccurrence", TaskOccurrence],
  ["Task", Task],
  ["StockUpdate", StockUpdate],
  ["StockAccount", StockAccount],
  ["PlanningVisit", PlanningVisit],
  ["PlanningAccount", PlanningAccount],
];

const mongoURI = process.env.MONGO_URI || process.env.mongoURI || defaults.mongoURI;

async function main() {
  await mongoose.connect(mongoURI);

  const dbName = mongoose.connection.db.databaseName;
  console.log(`Connected to database: ${dbName}`);
  console.log(APPLY ? "Mode: APPLY" : "Mode: DRY RUN");

  const counts = {};
  for (const [name, Model] of collectionsToClear) {
    counts[name] = await Model.countDocuments({});
  }

  const userCount = await User.countDocuments({});
  const zahraMatches = await User.find({
    $or: [
      { email: /zahra/i },
      { fullName: /zahra/i },
      { userName: /zahra/i },
    ],
  })
    .select("_id email fullName userName")
    .lean();

  console.log("Users kept:", userCount);
  console.log("Zahra candidates:", JSON.stringify(zahraMatches, null, 2));
  console.log("Documents selected for deletion:", JSON.stringify(counts, null, 2));

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to delete these documents and update Zahra email.");
    return;
  }

  if (zahraMatches.length !== 1) {
    throw new Error(`Expected exactly one Zahra user match, found ${zahraMatches.length}. Aborting.`);
  }

  const zahra = zahraMatches[0];
  await User.updateOne(
    { _id: zahra._id },
    {
      $set: {
        email: ZAHRA_EMAIL,
        "forecastSnapshot.currentMonthForecastValue": 0,
        "forecastSnapshot.currentMonthSalesValue": 0,
        "forecastSnapshot.forecastAchievementPercentage": 0,
        "forecastSnapshot.forecastDeviationValue": 0,
        "forecastSnapshot.forecastDeviationPercentage": 0,
        "forecastSnapshot.lastForecastUpdate": null,
        "performanceSnapshot.currentMonthSalesValue": 0,
        "performanceSnapshot.currentMonthAchievementPercentage": 0,
        "performanceSnapshot.ytdSalesValue": 0,
        "performanceSnapshot.ytdAchievementPercentage": 0,
        "performanceSnapshot.activeTasks": 0,
        "performanceSnapshot.pendingOrders": 0,
      },
    },
  );

  await User.updateMany(
    { _id: { $ne: zahra._id } },
    {
      $set: {
        "forecastSnapshot.currentMonthForecastValue": 0,
        "forecastSnapshot.currentMonthSalesValue": 0,
        "forecastSnapshot.forecastAchievementPercentage": 0,
        "forecastSnapshot.forecastDeviationValue": 0,
        "forecastSnapshot.forecastDeviationPercentage": 0,
        "forecastSnapshot.lastForecastUpdate": null,
        "performanceSnapshot.currentMonthSalesValue": 0,
        "performanceSnapshot.currentMonthAchievementPercentage": 0,
        "performanceSnapshot.ytdSalesValue": 0,
        "performanceSnapshot.ytdAchievementPercentage": 0,
        "performanceSnapshot.activeTasks": 0,
        "performanceSnapshot.pendingOrders": 0,
      },
    },
  );

  for (const [name, Model] of collectionsToClear) {
    const result = await Model.deleteMany({});
    console.log(`${name}: deleted ${result.deletedCount}`);
  }

  const updatedZahra = await User.findById(zahra._id).select("_id email fullName userName").lean();
  console.log("Updated Zahra:", JSON.stringify(updatedZahra, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
