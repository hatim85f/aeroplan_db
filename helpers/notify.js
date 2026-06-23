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
// Events without a domain sound use the tasks sound so production/TestFlight
// payloads still send a bundled filename rather than "default".
const CATEGORIES = {
  tasks: { sound: "tasks.wav", channelId: "tasks" },
  planning: { sound: "plans.wav", channelId: "planning" },
  forecast: { sound: "forecast.wav", channelId: "forecast" },
  orders: { sound: "orders.wav", channelId: "orders" },
  sales: { sound: "sales.wav", channelId: "sales" },
  stocks: { sound: "stocks.wav", channelId: "stocks" },
  general: { sound: "tasks.wav", channelId: "tasks" },
};

const resolveCategory = (category) => CATEGORIES[category] || CATEGORIES.general;

/**
 * Send a notification to one or more users. Saves a Notification record per
 * recipient and pushes to ALL of each recipient's registered devices.
 *
 * By default the actor (`from`) is ALSO notified on their own device so they get
 * a follow-up copy of the event they triggered (e.g. a rep who creates an order
 * sees the same notification their manager receives). Pass `includeSelf: false`
 * to suppress the self copy (e.g. system-generated alerts). When self is
 * included, the actor can receive a tailored message via `selfTitle` /
 * `selfSubtitle`; otherwise the same title/subtitle is used.
 *
 * This is fire-and-forget friendly: callers can `.catch(() => {})`.
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
  includeSelf = true,
  selfTitle,
  selfSubtitle,
}) => {
  if (!title || !routeName) return [];

  const fromId = from ? String(from) : "";
  // Other recipients (everyone except the actor).
  const otherIds = [...new Set((recipientIds || []).map((id) => String(id)).filter(Boolean))]
    .filter((id) => id !== fromId);
  // The actor themselves, when self-notify is enabled and we know who they are.
  const selfIds = includeSelf && fromId ? [fromId] : [];
  const ids = [...new Set([...otherIds, ...selfIds])];
  if (!ids.length) return [];

  const { sound, channelId } = resolveCategory(category);
  const recipients = await User.find({ _id: { $in: ids } }).select("_id notificationTokens pushTokens").lean();

  const results = await Promise.allSettled(
    recipients.map((recipient) => {
      const isSelf = fromId && String(recipient._id) === fromId;
      return createAndSendNotification({
        from: from || recipient._id,
        to: recipient._id,
        title: isSelf && selfTitle ? selfTitle : title,
        subtitle: isSelf && selfSubtitle ? selfSubtitle : subtitle,
        routeName,
        payload: { ...payload, category, self: !!isSelf },
        recipient,
        sound,
        channelId,
      });
    }),
  );

  return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
};

module.exports = { notifyUsers, CATEGORIES };
