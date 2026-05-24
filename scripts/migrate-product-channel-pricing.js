require("dotenv").config();

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Product = require("../models/Product");
const SalesChannel = require("../models/SalesChannel");

const LEGACY_CHANNELS = ["direct", "upp", "institutional"];

const hasLegacyValue = (price = {}, foc = {}) => {
  return [
    price.cifUsd,
    price.wholesaleAed,
    price.retailAed,
    foc.percentage,
  ].some((value) => Number(value || 0) > 0);
};

const toNumber = (value) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  return Number(value);
};

const run = async () => {
  const apply = process.argv.includes("--apply");

  await connectDB();

  const salesChannels = await SalesChannel.find({
    channelKey: { $in: LEGACY_CHANNELS },
    status: "active",
    isActive: true,
  }).lean();

  const channelByKey = salesChannels.reduce((channels, channel) => {
    channels[channel.channelKey] = channel;
    return channels;
  }, {});

  const missingChannels = LEGACY_CHANNELS.filter((channelKey) => !channelByKey[channelKey]);

  if (missingChannels.length > 0) {
    console.log(`Missing active SalesChannel documents for: ${missingChannels.join(", ")}`);
    console.log("Create those sales channels first, then rerun this script.");
    await mongoose.disconnect();
    return;
  }

  const products = await Product.find({
    $or: [
      { channelPricing: { $exists: false } },
      { channelPricing: { $size: 0 } },
    ],
  }).select("+prices +defaultFoc");

  let migratedCount = 0;
  let skippedCount = 0;

  for (const product of products) {
    const channelPricing = [];

    LEGACY_CHANNELS.forEach((channelKey) => {
      const price = product.prices?.[channelKey] || {};
      const foc = product.defaultFoc?.[channelKey] || {};

      if (!hasLegacyValue(price, foc)) {
        return;
      }

      const salesChannel = channelByKey[channelKey];

      channelPricing.push({
        channelId: salesChannel._id,
        channelName: salesChannel.channelName,
        channelKey: salesChannel.channelKey,
        isAvailable: true,
        cifUsd: toNumber(price.cifUsd),
        wholesaleAed: toNumber(price.wholesaleAed),
        retailAed: toNumber(price.retailAed),
        focEnabled: salesChannel.focEnabled,
        defaultFocPercentage: salesChannel.focEnabled ? toNumber(foc.percentage) : 0,
        focNotes: foc.notes,
      });
    });

    if (channelPricing.length === 0) {
      skippedCount += 1;
      continue;
    }

    migratedCount += 1;

    if (apply) {
      product.channelPricing = channelPricing;
      await product.save();
    }
  }

  console.log(`${apply ? "Migrated" : "Would migrate"} ${migratedCount} product(s).`);
  console.log(`Skipped ${skippedCount} product(s) with no legacy channel values.`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write channelPricing.");
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
