require("dotenv").config();

const mongoose = require("mongoose");

const defaults = require("../config/default.json");
const User = require("../models/User");

const ZAHRA_EMAIL = "zahra.hanafy@axantia.com";
const mongoURI = process.env.MONGO_URI || process.env.mongoURI || defaults.mongoURI;

async function main() {
  await mongoose.connect(mongoURI);

  const matches = await User.find({
    $or: [
      { email: /zahra/i },
      { fullName: /zahra/i },
      { userName: /zahra/i },
    ],
  })
    .select("_id email fullName userName")
    .lean();

  console.log("Zahra candidates:", JSON.stringify(matches, null, 2));

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Zahra user match, found ${matches.length}. Aborting.`);
  }

  const result = await User.updateOne(
    { _id: matches[0]._id },
    { $set: { email: ZAHRA_EMAIL } },
  );

  const updated = await User.findById(matches[0]._id)
    .select("_id email fullName userName")
    .lean();

  console.log(`matched ${result.matchedCount}, modified ${result.modifiedCount}`);
  console.log("Updated Zahra:", JSON.stringify(updated, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
