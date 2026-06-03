require("dotenv").config();

const mongoose = require("mongoose");
const SalesSheetMapping = require("../models/SalesSheetMapping");
const SalesUploadBatch = require("../models/SalesUploadBatch");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
};

const buildMappingName = (batch) => {
  if (batch.mappingName) {
    return batch.mappingName;
  }

  if (batch.fileName) {
    return `${String(batch.fileName).trim().replace(/\.[^.]+$/, "")} mapping`;
  }

  return `Sales upload ${batch.month || ""}/${batch.year || ""} mapping`.trim();
};

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(mongoUri);

  const batches = await SalesUploadBatch.find({
    columnMapping: { $exists: true, $ne: null },
  }).sort({ uploadDate: 1, createdAt: 1 });

  const existingMappings = await SalesSheetMapping.find({ sourceType: "sales_upload", status: "active" });
  const mappingsBySignature = new Map(existingMappings.map((mapping) => [
    stableStringify(mapping.columnMapping || {}),
    mapping,
  ]));

  let createdMappings = 0;
  let reusedMappings = 0;
  let updatedBatches = 0;
  let latestMapping = null;

  for (const batch of batches) {
    const signature = stableStringify(batch.columnMapping || {});
    let mapping = mappingsBySignature.get(signature);

    if (!mapping) {
      mapping = await SalesSheetMapping.create({
        mappingName: buildMappingName(batch),
        description: `Created from upload batch ${batch._id}`,
        sourceType: "sales_upload",
        isDefault: false,
        status: "active",
        columnMapping: batch.columnMapping,
        requiredColumns: [],
        createdBy: batch.uploadedBy,
        updatedBy: batch.uploadedBy,
      });
      mappingsBySignature.set(signature, mapping);
      createdMappings += 1;
    } else {
      reusedMappings += 1;
    }

    latestMapping = mapping;

    if (String(batch.mappingId || "") !== String(mapping._id) || batch.mappingName !== mapping.mappingName) {
      batch.mappingId = mapping._id;
      batch.mappingName = mapping.mappingName;
      await batch.save();
      updatedBatches += 1;
    }
  }

  if (latestMapping) {
    await SalesSheetMapping.updateMany({ isDefault: true }, { $set: { isDefault: false } });
    latestMapping.isDefault = true;
    await latestMapping.save();
  }

  const activeMappings = await SalesSheetMapping.find({ sourceType: "sales_upload", status: "active" })
    .select("mappingName sourceType isDefault columnMapping")
    .sort({ isDefault: -1, updatedAt: -1 })
    .lean();

  console.log(JSON.stringify({
    scannedBatches: batches.length,
    createdMappings,
    reusedMappings,
    updatedBatches,
    defaultMapping: latestMapping && {
      id: latestMapping._id,
      mappingName: latestMapping.mappingName,
    },
    activeMappings: activeMappings.map((mapping) => ({
      id: mapping._id,
      mappingName: mapping.mappingName,
      isDefault: mapping.isDefault,
      columns: Object.keys(mapping.columnMapping || {}),
    })),
  }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
