const connectDB = require("../config/db");
const User = require("../models/User");
const { sendExpoPushNotifications } = require("../helpers/expoPush");
const { CATEGORIES } = require("../helpers/notify");

const maskToken = (token = "") => {
  const text = String(token);
  if (text.length <= 24) return text;
  return `${text.slice(0, 22)}...${text.slice(-7)}`;
};

const getTokenEntries = (user) => {
  const seen = new Set();
  const entries = [];

  for (const source of ["notificationTokens", "pushTokens"]) {
    for (const item of user[source] || []) {
      const token = typeof item === "string" ? item : item.token;
      if (!token || seen.has(token)) continue;
      seen.add(token);
      entries.push({
        token,
        source,
        platform: item.platform || "unknown",
        deviceId: item.deviceId,
        lastUsedAt: item.lastUsedAt,
      });
    }
  }

  return entries;
};

const main = async () => {
  await connectDB();

  const category = process.env.CATEGORY || "tasks";
  const soundConfig = CATEGORIES[category];
  if (!soundConfig || soundConfig.sound === "default") {
    throw new Error(`CATEGORY must be one with a custom sound. Received: ${category}`);
  }

  const email = process.env.TEST_PUSH_EMAIL;
  const query = email
    ? { $or: [{ email: email.toLowerCase() }, { businessEmail: email.toLowerCase() }] }
    : {};
  const users = await User.find(query)
    .select("fullName email businessEmail role notificationTokens pushTokens")
    .lean();

  const candidates = users
    .flatMap((user) =>
      getTokenEntries(user).map((entry) => ({
        ...entry,
        userId: String(user._id),
        name: user.fullName || user.email || user.businessEmail || "User",
        email: user.email || user.businessEmail,
        role: user.role,
      })),
    )
    .filter((entry) => entry.platform === "ios")
    .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));

  if (!candidates.length) {
    console.log("No iOS Expo push tokens found.");
    process.exit(0);
  }

  console.log("iOS push targets:");
  candidates.slice(0, 10).forEach((entry, index) => {
    console.log(
      `${index + 1}. ${entry.name} <${entry.email || "no-email"}> ${entry.role || ""} ` +
        `${entry.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : "no-lastUsedAt"} ` +
        `${maskToken(entry.token)}`,
    );
  });

  if (process.env.SEND !== "1") {
    console.log("Dry run only. Set SEND=1 to send to the most recent listed iOS token.");
    process.exit(0);
  }

  const target = candidates[0];
  const result = await sendExpoPushNotifications({
    tokens: [target.token],
    title: "AeroPlan TestFlight sound test",
    subtitle: `Testing custom sound ${soundConfig.sound}`,
    routeName: "Notifications",
    sound: soundConfig.sound,
    channelId: soundConfig.channelId,
    payload: {
      category,
      test: true,
      source: "scripts/test-notification-sound.js",
    },
  });

  console.log(
    JSON.stringify(
      {
        sentTo: {
          name: target.name,
          email: target.email,
          role: target.role,
          platform: target.platform,
          token: maskToken(target.token),
        },
        payloadSound: soundConfig.sound,
        channelId: soundConfig.channelId,
        result,
      },
      null,
      2,
    ),
  );
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
