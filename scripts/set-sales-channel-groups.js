require("dotenv").config();

const mongoose = require("mongoose");
const SalesChannel = require("../models/SalesChannel");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;

const GROUP_UPDATES = [
  { keys: ["direct", "upp", "private"], channelGroup: "private" },
  { keys: ["institution", "institutional"], channelGroup: "institution" },
  { keys: ["government"], channelGroup: "government" },
  { keys: ["tender"], channelGroup: "tender" },
];

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(mongoUri);

  const results = [];

  for (const update of GROUP_UPDATES) {
    const result = await SalesChannel.updateMany(
      { channelKey: { $in: update.keys } },
      { $set: { channelGroup: update.channelGroup } },
      { runValidators: true },
    );

    results.push({
      channelKeys: update.keys,
      channelGroup: update.channelGroup,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    });
  }

  const defaultResult = await SalesChannel.updateMany(
    { channelGroup: { $exists: false } },
    { $set: { channelGroup: "private" } },
    { runValidators: true },
  );

  const channels = await SalesChannel.find({})
    .select("channelName channelKey channelGroup status isActive")
    .sort({ channelName: 1 })
    .lean();

  console.log(JSON.stringify({ results, defaultResult, channels }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
