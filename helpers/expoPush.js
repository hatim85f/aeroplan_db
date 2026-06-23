const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const isExpoPushToken = (token) => {
  return (
    typeof token === "string" &&
    (token.startsWith("ExpoPushToken[") || token.startsWith("ExponentPushToken["))
  );
};

const sendExpoPushNotifications = async ({
  tokens, title, subtitle, routeName, payload = {}, sound, channelId,
}) => {
  const validTokens = [...new Set(tokens.filter(isExpoPushToken))];
  const invalidTokens = tokens.filter((token) => !isExpoPushToken(token));

  if (!validTokens.length) {
    return {
      tickets: [],
      failedTokens: invalidTokens,
      status: tokens.length ? "failed" : "pending",
    };
  }

  const messages = validTokens.map((token) => ({
    to: token,
    // iOS uses `sound` (a bundled file name, e.g. "tasks.wav").
    // Android uses the channel's configured sound, selected via `channelId`.
    sound: sound || "tasks.wav",
    ...(channelId ? { channelId } : {}),
    title,
    body: subtitle || "",
    data: {
      routeName,
      ...payload,
    },
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });

  const result = await response.json();

  if (!response.ok) {
    return {
      tickets: result,
      failedTokens: validTokens.concat(invalidTokens),
      status: "failed",
    };
  }

  const tickets = Array.isArray(result.data) ? result.data : [];
  const ticketFailedTokens = tickets
    .map((ticket, index) => (ticket.status === "error" ? validTokens[index] : null))
    .filter(Boolean);
  const failedTokens = invalidTokens.concat(ticketFailedTokens);

  return {
    tickets,
    failedTokens,
    status:
      failedTokens.length === 0 ? "sent" : failedTokens.length === tokens.length ? "failed" : "partial",
  };
};

module.exports = {
  isExpoPushToken,
  sendExpoPushNotifications,
};
