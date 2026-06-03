const Product = require("../models/Product");
const SalesChannel = require("../models/SalesChannel");

const CHANNEL_GROUP_RULES = [
  { keys: ["direct", "upp", "private"], names: ["direct", "upp", "private"], channelGroup: "private" },
  { keys: ["institution", "institutional"], names: ["institution", "institutional"], channelGroup: "institution" },
  { keys: ["government"], names: ["government"], channelGroup: "government" },
  { keys: ["tender"], names: ["tender"], channelGroup: "tender" },
];

const normalizeKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const inferChannelGroup = (channel) => {
  const key = normalizeKey(channel?.channelKey);
  const name = normalizeKey(channel?.channelName);
  const rule = CHANNEL_GROUP_RULES.find((candidate) => (
    candidate.keys.includes(key)
    || candidate.names.includes(name)
    || candidate.names.some((candidateName) => name.includes(candidateName))
  ));

  return rule?.channelGroup || channel?.channelGroup || "private";
};

const ensureSalesChannelGroups = async () => {
  const channels = await SalesChannel.find({}).select("_id channelName channelKey channelGroup");
  const channelGroupsById = new Map();
  const channelGroupsByKey = new Map();

  for (const channel of channels) {
    const channelGroup = inferChannelGroup(channel);

    if (channel.channelGroup !== channelGroup) {
      channel.channelGroup = channelGroup;
      await channel.save();
    }

    channelGroupsById.set(String(channel._id), channelGroup);
    channelGroupsByKey.set(normalizeKey(channel.channelKey), channelGroup);
  }

  const products = await Product.find({ "channelPricing.0": { $exists: true } });

  for (const product of products) {
    let changed = false;

    product.channelPricing = product.channelPricing.map((pricing) => {
      const channelGroup = channelGroupsById.get(String(pricing.channelId))
        || channelGroupsByKey.get(normalizeKey(pricing.channelKey))
        || inferChannelGroup(pricing);

      if (pricing.channelGroup !== channelGroup) {
        changed = true;
      }

      return {
        ...pricing.toObject(),
        channelGroup,
      };
    });

    if (changed) {
      await Product.updateOne(
        { _id: product._id },
        { $set: { channelPricing: product.channelPricing } },
      );
    }
  }
};

module.exports = ensureSalesChannelGroups;
