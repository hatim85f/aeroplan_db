require("dotenv").config();

const mongoose = require("mongoose");
const SalesRecord = require("../models/SalesRecord");
const SalesUploadBatch = require("../models/SalesUploadBatch");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(mongoUri);

  const uploadedRecords = await SalesRecord.find({ entrySource: "upload" })
    .select("salesUploadBatchId")
    .lean();
  const batchIds = [
    ...new Set(uploadedRecords.map((record) => String(record.salesUploadBatchId || "")).filter(Boolean)),
  ];

  const salesDeleteResult = await SalesRecord.deleteMany({ entrySource: "upload" });
  const batchDeleteResult = batchIds.length > 0
    ? await SalesUploadBatch.deleteMany({ _id: { $in: batchIds } })
    : { deletedCount: 0 };

  console.log(JSON.stringify({
    success: true,
    deletedSalesRecords: salesDeleteResult.deletedCount || 0,
    deletedUploadBatches: batchDeleteResult.deletedCount || 0,
    batchIds,
  }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
