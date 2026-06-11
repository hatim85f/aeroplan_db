const User = require("../models/User");
const { createAndSendNotification } = require("./notificationDispatcher");

/**
 * Notification sound categories. Each maps to:
 *  - sound:     the bundled iOS sound file name (must exist in the mobile app).
 *  - channelId: the Android notification channel (must be created on the device
 *               with the matching sound — see mobile registerNotificationChannels()).
 *
 * Keep these keys in sync with the mobile app's channel registration.
 */
// Domain-based notification sounds. Each domain's sound covers ALL events in
// that domain. Keep these keys + sound file names in sync with the mobile app's
// NOTIFICATION_CHANNELS map and the expo-notifications `sounds` list in app.json.
// Events without a domain sound use "general" (the system default tone).
const CATEGORIES = {
  tasks: { sound: "tasks.wav", channelId: "tasks" },
  planning: { sound: "plans.wav", channelId: "planning" },
  forecast: { sound: "forecast.wav", channelId: "forecast" },
  orders: { sound: "orders.wav", channelId: "orders" },
  sales: { sound: "sales.wav", channelId: "sales" },
  stocks: { sound: "stocks.wav", channelId: "stocks" },
  general: { sound: "default", channelId: "general" },
};

const resolveCategory = (category) => CATEGORIES[category] || CATEGORIES.general;

/**
 * Send a notification to one or more users. Saves a Notification record per
 * recipient and pushes to ALL of each recipient's registered devices.
 *
 * Recipients equal to `from` (the actor) are skipped so users never notify
 * themselves. This is fire-and-forget friendly: callers can `.catch(() => {})`.
 *
 * @returns {Promise<Array>} created notifications
 */
const notifyUsers = async ({
  from,
  recipientIds = [],
  title,
  subtitle,
  routeName,
  payload = {},
  category = "info",
}) => {
  if (!title || !routeName) return [];

  const fromId = from ? String(from) : "";
  const ids = [...new Set((recipientIds || []).map((id) => String(id)).filter(Boolean))]
    .filter((id) => id !== fromId);
  if (!ids.length) return [];

  const { sound, channelId } = resolveCategory(category);
  const recipients = await User.find({ _id: { $in: ids } }).select("_id notificationTokens pushTokens").lean();

  const results = await Promise.allSettled(
    recipients.map((recipient) => createAndSendNotification({
      from: from || recipient._id,
      to: recipient._id,
      title,
      subtitle,
      routeName,
      payload: { ...payload, category },
      recipient,
      sound,
      channelId,
    })),
  );

  return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
};

module.exports = { notifyUsers, CATEGORIES };
