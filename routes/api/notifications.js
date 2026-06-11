const express = require("express");
const auth = require("../../middleware/auth");
const Notification = require("../../models/Notification");
const User = require("../../models/User");
const { isExpoPushToken } = require("../../helpers/expoPush");
const { createAndSendNotification } = require("../../helpers/notificationDispatcher");

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

    const pushToken = {
      token,
      platform,
      deviceId,
      lastUsedAt: new Date(),
    };
    const pullMatches = [{ token }];

    if (deviceId) {
      pullMatches.push({ deviceId });
    }

    await User.updateOne(
      { _id: user._id },
      {
        $pull: {
          notificationTokens: { $or: pullMatches },
          pushTokens: { $or: pullMatches },
        },
      },
    );
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        $addToSet: {
          notificationTokens: pushToken,
          pushTokens: pushToken,
        },
      },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message: "Notification token registered successfully",
      data: {
        notificationTokens: updatedUser.notificationTokens,
        pushTokens: updatedUser.pushTokens,
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

    await User.updateOne(
      { _id: user._id },
      {
        $pull: {
          notificationTokens: token ? { token } : { deviceId },
          pushTokens: token ? { token } : { deviceId },
        },
      },
    );
    const updatedUser = await getCurrentUser(user._id);

    return res.status(200).json({
      success: true,
      message: "Notification token removed successfully",
      data: {
        notificationTokens: updatedUser.notificationTokens,
        pushTokens: updatedUser.pushTokens,
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
        return createAndSendNotification({
          from: req.user.id,
          to: recipient._id,
          title,
          subtitle,
          routeName,
          payload,
          recipient,
        });
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
