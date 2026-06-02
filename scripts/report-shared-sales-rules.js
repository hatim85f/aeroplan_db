require("dotenv").config();

const mongoose = require("mongoose");
const SharedSalesRule = require("../models/SharedSalesRule");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(mongoUri);

  const [total, active, activeStatusOnly, inactive, inactiveStatusOnly] = await Promise.all([
    SharedSalesRule.countDocuments({}),
    SharedSalesRule.countDocuments({ status: "active", isActive: true }),
    SharedSalesRule.countDocuments({ status: "active" }),
    SharedSalesRule.countDocuments({ status: "inactive", isActive: false }),
    SharedSalesRule.countDocuments({ status: "inactive" }),
  ]);

  const latest = await SharedSalesRule.find({})
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(10)
    .select("_id status isActive createdAt updatedAt accountId productId channelId areaId")
    .lean();

  console.log(JSON.stringify({
    total,
    active,
    activeStatusOnly,
    inactive,
    inactiveStatusOnly,
    latest,
  }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
