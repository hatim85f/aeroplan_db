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
// Currently one custom sound (tasks.wav) is bundled and used for all task
// notifications. Non-task categories use the system default until their own
// .wav files are added — then give each its own sound/channel here and in the
// mobile NOTIFICATION_CHANNELS map.
const CATEGORIES = {
  task_assigned: { sound: "tasks.wav", channelId: "tasks-new" },
  task_message: { sound: "tasks.wav", channelId: "messages" },
  task_reminder: { sound: "tasks.wav", channelId: "reminders" },
  task_urgent: { sound: "tasks.wav", channelId: "urgent" },
  update: { sound: "default", channelId: "updates" },
  info: { sound: "default", channelId: "general" },
};

const resolveCategory = (category) => CATEGORIES[category] || CATEGORIES.info;

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
