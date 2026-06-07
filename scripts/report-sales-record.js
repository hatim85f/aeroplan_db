require("dotenv").config();

const mongoose = require("mongoose");
const SalesRecord = require("../models/SalesRecord");
const Product = require("../models/Product");
const SalesChannel = require("../models/SalesChannel");

const mongoUri = process.env.MONGO_URI || process.env.mongoURI;
const recordId = process.argv[2];

const run = async () => {
  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  if (!recordId || !mongoose.Types.ObjectId.isValid(recordId)) {
    throw new Error("Usage: node scripts/report-sales-record.js <salesRecordId>");
  }

  await mongoose.connect(mongoUri);

  const record = await SalesRecord.findById(recordId).lean();

  if (!record) {
    console.log(JSON.stringify({ found: false, recordId }, null, 2));
    await mongoose.disconnect();
    return;
  }

  const [product, channel] = await Promise.all([
    record.productId ? Product.findById(record.productId).lean() : null,
    record.channelId ? SalesChannel.findById(record.channelId).lean() : null,
  ]);

  console.log(JSON.stringify({
    found: true,
    record: {
      _id: record._id,
      entrySource: record.entrySource,
      rowNumber: record.rowNumber,
      invoiceNumber: record.invoiceNumber,
      salesDate: record.salesDate,
      invoiceDate: record.invoiceDate,
      accountName: record.accountName,
      shipToAccountName: record.shipToAccountName,
      productId: record.productId,
      productName: record.productName,
      productNickname: record.productNickname,
      productMatched: record.productMatched,
      channelId: record.channelId,
      channelName: record.channelName,
      channelKey: record.channelKey,
      channelMatched: record.channelMatched,
      channelDetectionMethod: record.channelDetectionMethod,
      salesType: record.salesType,
      quantity: record.quantity,
      freeQuantity: record.freeQuantity,
      uploadedSalesValue: record.uploadedSalesValue,
      uploadedCurrency: record.uploadedCurrency,
      uploadedUnitValue: record.uploadedUnitValue,
      detectedPriceBasis: record.detectedPriceBasis,
      detectedPriceCurrency: record.detectedPriceCurrency,
      unitCifUsd: record.unitCifUsd,
      calculatedCifUsd: record.calculatedCifUsd,
      unitWholesaleAed: record.unitWholesaleAed,
      calculatedWholesaleAed: record.calculatedWholesaleAed,
      unitRetailAed: record.unitRetailAed,
      calculatedRetailAed: record.calculatedRetailAed,
      targetValueBasis: record.targetValueBasis,
      targetCurrency: record.targetCurrency,
      targetUnitValue: record.targetUnitValue,
      targetCalculatedValue: record.targetCalculatedValue,
      matchStatus: record.matchStatus,
      matchConfidence: record.matchConfidence,
      matchNotes: record.matchNotes,
      rawRow: record.rawRow,
    },
    product: product && {
      _id: product._id,
      productName: product.productName,
      productNickname: product.productNickname,
      channelPricing: product.channelPricing,
    },
    channel,
  }, null, 2));

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
