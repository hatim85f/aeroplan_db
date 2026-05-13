const User = require("../models/User");

const dropIndexIfExists = async (model, indexName) => {
  const indexes = await model.collection.indexes();
  const hasIndex = indexes.some((index) => index.name === indexName);

  if (hasIndex) {
    await model.collection.dropIndex(indexName);
    console.log(`Dropped obsolete index: ${indexName}`);
  }
};

const cleanupObsoleteIndexes = async () => {
  await dropIndexIfExists(User, "firebaseUid_1");
  await dropIndexIfExists(User, "businessEmail_1");
};

module.exports = cleanupObsoleteIndexes;
