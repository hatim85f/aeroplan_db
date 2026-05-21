const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const defaults = require("../config/default.json");
const User = require("../models/User");

const mongoURI = process.env.MONGO_URI || process.env.mongoURI || defaults.mongoURI;

const createAppId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "AP-";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

mongoose.connect(mongoURI)
  .then(async () => {
    const existing = await User.findOne({ email: "mahmoud.hemaly@axantia.com" });
    if (existing) {
      console.log("ALREADY_EXISTS", existing._id.toString(), existing.appId);
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

    console.log("CREATED", user._id.toString(), user.appId, user.email);
    await mongoose.disconnect();
  })
  .catch((err) => {
    console.error("ERROR", err.message);
    process.exit(1);
  });
