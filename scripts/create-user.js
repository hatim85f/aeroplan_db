const fs = require("fs");
const log = (msg) => fs.appendFileSync("scripts/create-user-result.json", JSON.stringify(msg) + "\n");

log({ step: "start" });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const defaults = require("../config/default.json");
const User = require("../models/User");

const mongoURI = process.env.MONGO_URI || process.env.mongoURI || defaults.mongoURI;
log({ step: "config_loaded", mongoURI: mongoURI ? "found" : "missing" });

const createAppId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "AP-";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

mongoose.connect(mongoURI)
  .then(async () => {
    log({ step: "connected" });

    const existing = await User.findOne({ email: "mahmoud.hemaly@axantia.com" });
    if (existing) {
      log({ status: "already_exists", _id: String(existing._id), appId: existing.appId });
      await mongoose.disconnect();
      return;
    }

    let appId;
    for (let i = 0; i < 5; i++) {
      const candidate = createAppId();
      const taken = await User.exists({ appId: candidate });
      if (!taken) { appId = candidate; break; }
    }

    const passwordHash = await bcrypt.hash("mahmoud@123$", 10);
    const now = new Date();

    const user = await User.create({
      email: "mahmoud.hemaly@axantia.com",
      appId,
      passwordHash,
      authProviders: ["password"],
      fullName: "Mahmoud Hemaly",
      userName: "mahmoud@cefix",
      phone: "+971508022365",
      profilePicture: "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779406733/588334436_25592184893738973_3355459253837969934_n_dov6mi.jpg",
      role: "representative",
      status: "active",
      emailVerified: true,
      lastLoginAt: now,
      lastActivityAt: now,
      onlineStatus: "offline",
    });

    log({ status: "created", _id: String(user._id), appId: user.appId, email: user.email });
    await mongoose.disconnect();
  })
  .catch((err) => {
    log({ status: "error", message: err.message });
    process.exit(1);
  });
