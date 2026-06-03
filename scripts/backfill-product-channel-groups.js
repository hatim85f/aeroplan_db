require("dotenv").config();

const mongoose = require("mongoose");
const Product = require("../models/Product");
const SalesChannel = require("../models/SalesChannel");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;

const normalizeKey = (value) => String(value || "").trim().toLowerCase();

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(mongoUri);

  const channels = await SalesChannel.find({})
    .select("_id channelKey channelGroup")
    .lean();

  const groupById = new Map(channels.map((channel) => [
    String(channel._id),
    channel.channelGroup || "private",
  ]));
  const groupByKey = new Map(channels.map((channel) => [
    normalizeKey(channel.channelKey),
    channel.channelGroup || "private",
  ]));

  const products = await Product.find({ "channelPricing.0": { $exists: true } });
  let updatedProducts = 0;
  let updatedPricingRows = 0;

  for (const product of products) {
    let changed = false;

    product.channelPricing = product.channelPricing.map((pricing) => {
      const channelGroup = groupById.get(String(pricing.channelId))
        || groupByKey.get(normalizeKey(pricing.channelKey))
        || pricing.channelGroup
        || "private";

      if (pricing.channelGroup !== channelGroup) {
        changed = true;
        updatedPricingRows += 1;
      }

      return {
        ...pricing.toObject(),
        channelGroup,
      };
    });

    if (changed) {
      await product.save();
      updatedProducts += 1;
    }
  }

  const cefix = await Product.findOne({ productNicknameKey: "cefix 60ml" })
    .select("productName productNickname channelPricing")
    .lean();

  console.log(JSON.stringify({
    scannedProducts: products.length,
    updatedProducts,
    updatedPricingRows,
    cefix: cefix && {
      productName: cefix.productName,
      productNickname: cefix.productNickname,
      channelPricing: cefix.channelPricing.map((pricing) => ({
        channelName: pricing.channelName,
        channelKey: pricing.channelKey,
        channelGroup: pricing.channelGroup,
        wholesaleAed: pricing.wholesaleAed,
      })),
    },
  }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
