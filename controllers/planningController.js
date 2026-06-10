const forecastService = require("../services/forecastService");
const planningService = require("../services/planningService");

const loadActor = async (req, res, next) => {
  try {
    req.currentUser = await forecastService.getCurrentUser(req.user.id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const ok = (res, message, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });

const wrap = (fn, message, statusCode = 200) => async (req, res, next) => {
  try {
    const data = await fn(req);
    return ok(res, message, data, statusCode);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  loadActor,

  listPlanningAccounts: wrap((req) => planningService.listPlanningAccounts({
    actor: req.currentUser, search: req.query.search, userId: req.query.userId, status: req.query.status,
  }), "Planning accounts fetched successfully"),

  createPlanningAccount: wrap((req) => planningService.createPlanningAccount({
    actor: req.currentUser, body: req.body || {},
  }), "Planning account added", 201),

  updatePlanningAccount: wrap((req) => planningService.updatePlanningAccount({
    actor: req.currentUser, id: req.params.id, body: req.body || {},
  }), "Planning account updated"),

  deletePlanningAccount: wrap((req) => planningService.deletePlanningAccount({
    actor: req.currentUser, id: req.params.id,
  }), "Planning account removed"),

  getAccountSource: wrap((req) => planningService.getAccountSource({
    actor: req.currentUser, search: req.query.search, assignedOnly: req.query.assignedOnly, userId: req.query.userId,
  }), "Account source fetched successfully"),

  getMyCalendar: wrap((req) => planningService.getMyCalendar({
    actor: req.currentUser, userId: req.query.userId, startDate: req.query.startDate, endDate: req.query.endDate,
  }), "Calendar fetched successfully"),

  getTeamDay: wrap((req) => planningService.getTeamDay({
    actor: req.currentUser, date: req.query.date,
  }), "Team day plan fetched successfully"),

  getTeamWeek: wrap((req) => planningService.getTeamWeek({
    actor: req.currentUser, userId: req.query.userId, weekStartDate: req.query.weekStartDate,
  }), "Team week plan fetched successfully"),

  createVisits: wrap((req) => planningService.createVisits({
    actor: req.currentUser, userId: req.body?.userId, visits: req.body?.visits,
  }), "Visit planned", 201),

  updateVisit: wrap((req) => planningService.updateVisit({
    actor: req.currentUser, id: req.params.id, body: req.body || {},
  }), "Visit updated"),

  deleteVisit: wrap((req) => planningService.deleteVisit({
    actor: req.currentUser, id: req.params.id,
  }), "Visit removed"),

  submitPlan: wrap((req) => planningService.submitPlan({
    actor: req.currentUser,
    userId: req.body?.userId,
    startDate: req.body?.startDate,
    endDate: req.body?.endDate,
    year: req.body?.year,
    month: req.body?.month,
  }), "Plan submitted"),

  getManagerDashboard: wrap((req) => planningService.getManagerDashboard({
    actor: req.currentUser, date: req.query.date,
  }), "Planning dashboard fetched successfully"),

  getAccountsReport: wrap((req) => planningService.getAccountsReport({
    actor: req.currentUser,
    dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
    userId: req.query.userId, accountId: req.query.accountId, productId: req.query.productId,
  }), "Planning accounts report fetched successfully"),

  getRepsReport: wrap((req) => planningService.getRepsReport({
    actor: req.currentUser, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
  }), "Planning reps report fetched successfully"),
};
