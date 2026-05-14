const express = require("express");
const auth = require("../../middleware/auth");
const Notification = require("../../models/Notification");
const User = require("../../models/User");
const { isExpoPushToken, sendExpoPushNotifications } = require("../../helpers/expoPush");

const router = express.Router();

const normalizeRecipients = (to) => {
  if (!to) {
    return [];
  }

  return Array.isArray(to) ? to : [to];
};

const getCurrentUser = async (userId) => {
  return User.findById(userId);
};

router.post("/register-token", auth, async (req, res, next) => {
  try {
    const { token, platform = "unknown", deviceId } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "token is required",
      });
    }

    if (!isExpoPushToken(token)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Expo push token",
      });
    }

    const user = await getCurrentUser(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.notificationTokens = (user.notificationTokens || []).filter(
      (item) => item.token !== token && (!deviceId || item.deviceId !== deviceId),
    );
    user.notificationTokens.push({
      token,
      platform,
      deviceId,
      lastUsedAt: new Date(),
    });
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Notification token registered successfully",
      data: {
        notificationTokens: user.notificationTokens,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/remove-token", auth, async (req, res, next) => {
  try {
    const { token, deviceId } = req.body;

    if (!token && !deviceId) {
      return res.status(400).json({
        success: false,
        message: "token or deviceId is required",
      });
    }

    const user = await getCurrentUser(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.notificationTokens = (user.notificationTokens || []).filter((item) => {
      return token ? item.token !== token : item.deviceId !== deviceId;
    });
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Notification token removed successfully",
      data: {
        notificationTokens: user.notificationTokens,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", auth, async (req, res, next) => {
  try {
    const notifications = await Notification.find({ to: req.user.id })
      .populate("from", "fullName email role")
      .sort({ timeStamp: -1 });

    return res.status(200).json({
      success: true,
      message: "Notifications fetched successfully",
      data: notifications,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/open", auth, async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, to: req.user.id },
      {
        $set: {
          isOpened: true,
          openedAt: new Date(),
        },
      },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification marked as opened",
      data: notification,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/send", auth, async (req, res, next) => {
  try {
    const { title, subtitle, routeName, payload = {}, to } = req.body;
    const recipientIds = normalizeRecipients(to);

    if (!title || !routeName || !recipientIds.length) {
      return res.status(400).json({
        success: false,
        message: "title, routeName, and to are required",
      });
    }

    const recipients = await User.find({ _id: { $in: recipientIds } });
    const foundRecipientIds = recipients.map((recipient) => String(recipient._id));
    const missingRecipients = recipientIds.filter(
      (recipientId) => !foundRecipientIds.includes(String(recipientId)),
    );

    const notifications = await Promise.all(
      recipients.map(async (recipient) => {
        const notification = await Notification.create({
          title,
          subtitle,
          routeName,
          payload,
          from: req.user.id,
          to: recipient._id,
          timeStamp: new Date(),
        });
        const tokens = (recipient.notificationTokens || []).map((item) => item.token);
        const pushResult = await sendExpoPushNotifications({
          tokens,
          title,
          subtitle,
          routeName,
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
      }),
    );

    return res.status(201).json({
      success: true,
      message: "Notifications created and push handling completed",
      data: {
        notifications,
        missingRecipients,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
