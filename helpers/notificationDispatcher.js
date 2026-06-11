const Notification = require("../models/Notification");
const { sendExpoPushNotifications } = require("./expoPush");

const createAndSendNotification = async ({
  from,
  to,
  title,
  subtitle,
  routeName,
  payload = {},
  recipient,
  sound,
  channelId,
}) => {
  const notification = await Notification.create({
    title,
    subtitle,
    routeName,
    payload,
    from,
    to,
    timeStamp: new Date(),
  });

  const tokenEntries = [
    ...(recipient.notificationTokens || []),
    ...(recipient.pushTokens || []),
  ];
  const tokens = tokenEntries.map((item) => (typeof item === "string" ? item : item.token)).filter(Boolean);
  const pushResult = await sendExpoPushNotifications({
    tokens,
    title,
    subtitle,
    routeName,
    sound,
    channelId,
    payload: {
      notificationId: String(notification._id),
      ...payload,
    },
  });

  notification.status = pushResult.status;
  notification.sentAt = new Date();
  notification.expoTickets = pushResult.tickets;
  notification.failedTokens = pushResult.failedTokens;
  await notification.save();

  return notification;
};

module.exports = {
  createAndSendNotification,
};
