const mongoose = require('mongoose');
const defaults = require('./default.json');

const connectDB = async () => {
  const mongoURI = process.env.MONGO_URI || defaults.mongoURI;

  try {
    await mongoose.connect(mongoURI);
    console.log('MongoDB connected');
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
