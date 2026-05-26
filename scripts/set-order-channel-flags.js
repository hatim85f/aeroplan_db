require("dotenv").config();

const connectDB = require("../config/db");
const SalesChannel = require("../models/SalesChannel");

const ORDER_CHANNEL_DEFAULTS = [
  {
    keys: ["direct"],
    allowRepOrders: true,
    focEnabled: true,
  },
  {
    keys: ["upp"],
    allowRepOrders: false,
    focEnabled: false,
  },
  {
    keys: ["institution", "institutional"],
    allowRepOrders: false,
    focEnabled: false,
  },
];

const run = async () => {
  await connectDB();

  const results = [];

  for (const item of ORDER_CHANNEL_DEFAULTS) {
    const updated = await SalesChannel.updateMany(
      { channelKey: { $in: item.keys } },
      {
        $set: {
          allowRepOrders: item.allowRepOrders,
          focEnabled: item.focEnabled,
        },
      },
      { runValidators: true },
    );

    results.push({
      channelKeys: item.keys,
      allowRepOrders: item.allowRepOrders,
      focEnabled: item.focEnabled,
      matchedCount: updated.matchedCount,
      modifiedCount: updated.modifiedCount,
    });
  }

  const channels = await SalesChannel.find({})
    .select("channelName channelKey allowRepOrders focEnabled status isActive")
    .sort({ channelName: 1 })
    .lean();

  console.log(JSON.stringify({ results, channels }, null, 2));
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
