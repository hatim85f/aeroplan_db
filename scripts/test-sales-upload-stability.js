const assert = require("assert");
const mongoose = require("mongoose");
const salesRouter = require("../routes/api/sales");

const { detectSalesChannel, validateSalesRow } = salesRouter._test;

const buildChannel = (channelName, channelKey, channelGroup) => ({
  _id: new mongoose.Types.ObjectId(),
  channelName,
  channelKey,
  channelGroup,
});

const buildLookup = (channels) => ({
  byId: new Map(channels.map((channel) => [String(channel._id), channel])),
  byKey: new Map(channels.map((channel) => [channel.channelKey, channel])),
  byName: new Map(channels.map((channel) => [channel.channelName.toLowerCase(), channel])),
});

const main = async () => {
  const direct = buildChannel("Direct", "direct", "private");
  const upp = buildChannel("UPP", "upp", "private");
  const institution = buildChannel("Institution", "institution", "institution");
  const channels = [direct, upp, institution];
  const channelLookup = buildLookup(channels);
  const product = {
    _id: new mongoose.Types.ObjectId(),
    productName: "CEFIX 100MG/5ML SUSP 60ML",
    productNickname: "CEFIX 60ML",
    channelPricing: [
      {
        channelId: direct._id,
        channelName: direct.channelName,
        channelKey: direct.channelKey,
        channelGroup: direct.channelGroup,
        isAvailable: true,
        wholesaleAed: 30.38,
      },
      {
        channelId: upp._id,
        channelName: upp.channelName,
        channelKey: upp.channelKey,
        channelGroup: upp.channelGroup,
        isAvailable: true,
        wholesaleAed: 6,
      },
      {
        channelId: institution._id,
        channelName: institution.channelName,
        channelKey: institution.channelKey,
        channelGroup: institution.channelGroup,
        isAvailable: true,
        wholesaleAed: 6,
      },
    ],
  };

  const privateUppResult = await detectSalesChannel({
    quantity: 1,
    uploadedSalesValue: 5.5,
    uploadedCurrency: "AED",
    channelType: "private",
  }, product, channelLookup);
  assert.strictEqual(privateUppResult.channel.channelKey, "upp");
  assert.strictEqual(privateUppResult.method, "sales_type_price_match");

  const privateDirectResult = await detectSalesChannel({
    quantity: 1,
    uploadedSalesValue: 30,
    uploadedCurrency: "AED",
    channelType: "private",
  }, product, channelLookup);
  assert.strictEqual(privateDirectResult.channel.channelKey, "direct");

  const institutionResult = await detectSalesChannel({
    quantity: 1,
    uploadedSalesValue: 5.5,
    uploadedCurrency: "AED",
    channelType: "institution",
  }, product, channelLookup);
  assert.strictEqual(institutionResult.channel.channelKey, "institution");

  const quantityError = validateSalesRow({
    salesDate: new Date(),
    productName: "CEFIX 100MG/5ML SUSP 60ML",
    accountName: "Test Account",
    quantity: 0,
    freeQuantity: 0,
  });
  assert.match(quantityError.message, /Quantity must be greater than 0/);
  assert.strictEqual(quantityError.quantity, 0);
  assert.strictEqual(quantityError.freeQuantity, 0);

  console.log(JSON.stringify({
    privateUpp: privateUppResult.channel.channelKey,
    privateDirect: privateDirectResult.channel.channelKey,
    institution: institutionResult.channel.channelKey,
    quantityError: quantityError.message,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
