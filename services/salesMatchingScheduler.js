const User = require("../models/User");
const forecastService = require("./forecastService");
const salesRoutes = require("../routes/api/sales");
const { MANAGER_ROLES } = require("../helpers/roles");

const DEFAULT_TIME_ZONE = "Asia/Dubai";
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;

let schedulerTimer = null;
let lastRunKey = null;
let isRunning = false;

const getTimeParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return parts.reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
};

const getCurrentPeriod = (date = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
  const parts = getTimeParts(date, timeZone);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
  };
};

const getSchedulerActor = async () => User.findOne({
  role: { $in: MANAGER_ROLES },
  $or: [
    { status: "active" },
    { status: { $exists: false } },
  ],
  isActive: { $ne: false },
}).sort({ role: 1, createdAt: 1 });

const runDailySalesMatching = async ({
  date = new Date(),
  timeZone = process.env.SALES_MATCH_TIME_ZONE || DEFAULT_TIME_ZONE,
} = {}) => {
  if (isRunning) {
    return { skipped: true, reason: "Sales matching scheduler is already running" };
  }

  isRunning = true;

  try {
    const period = getCurrentPeriod(date, timeZone);
    const actor = await getSchedulerActor();

    if (!actor) {
      throw new Error("No active manager/admin user found for scheduled forecast refresh");
    }

    console.log(`[sales-matching-scheduler] Starting daily match for ${period.year}/${period.month}`);

    const orders = await salesRoutes.runSalesOrderMatchForPeriod({
      ...period,
      actorId: actor._id,
    });
    const targets = await salesRoutes.runSalesTargetMatchForPeriod({
      ...period,
      actorId: actor._id,
    });
    const forecasts = await forecastService.refreshForecast({
      actor,
      ...period,
    });

    const result = {
      ...period,
      orders,
      targets,
      forecasts: {
        refreshedCount: forecasts.refreshedCount ?? 1,
      },
    };

    console.log("[sales-matching-scheduler] Daily match completed", JSON.stringify({
      year: result.year,
      month: result.month,
      ordersMatched: orders.matchedCount,
      targetsMatched: targets.matchedCount,
      forecastsRefreshed: result.forecasts.refreshedCount,
    }));

    return result;
  } finally {
    isRunning = false;
  }
};

const startDailySalesMatchingScheduler = ({
  timeZone = process.env.SALES_MATCH_TIME_ZONE || DEFAULT_TIME_ZONE,
  hour = Number(process.env.SALES_MATCH_SCHEDULE_HOUR ?? 0),
  minute = Number(process.env.SALES_MATCH_SCHEDULE_MINUTE ?? 0),
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
} = {}) => {
  if (process.env.SALES_MATCH_SCHEDULER_ENABLED === "false") {
    console.log("[sales-matching-scheduler] Disabled by SALES_MATCH_SCHEDULER_ENABLED=false");
    return null;
  }

  if (schedulerTimer) return schedulerTimer;

  const tick = async () => {
    const now = new Date();
    const parts = getTimeParts(now, timeZone);
    const runKey = `${parts.year}-${parts.month}-${parts.day}`;

    if (Number(parts.hour) !== hour || Number(parts.minute) !== minute || lastRunKey === runKey) {
      return;
    }

    lastRunKey = runKey;

    try {
      await runDailySalesMatching({ date: now, timeZone });
    } catch (error) {
      console.error("[sales-matching-scheduler] Daily match failed", error);
    }
  };

  schedulerTimer = setInterval(tick, checkIntervalMs);

  if (typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }

  console.log(`[sales-matching-scheduler] Scheduled daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timeZone}`);
  tick();

  return schedulerTimer;
};

module.exports = {
  getCurrentPeriod,
  runDailySalesMatching,
  startDailySalesMatchingScheduler,
};
