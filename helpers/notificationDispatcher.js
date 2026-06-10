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

  const tokens = (recipient.notificationTokens || []).map((item) => item.token);
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
