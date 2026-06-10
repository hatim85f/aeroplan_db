const forecastService = require("../services/forecastService");
const taskService = require("../services/taskService");

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

  listMyTasks: wrap((req) => taskService.listMyTasks({ actor: req.currentUser, ...req.query }), "My tasks fetched successfully"),
  listTeamTasks: wrap((req) => taskService.listTeamTasks({ actor: req.currentUser, ...req.query }), "Team tasks fetched successfully"),
  createTask: wrap((req) => taskService.createTask({ actor: req.currentUser, body: req.body || {} }), "Task created", 201),
  getDashboard: wrap((req) => taskService.getDashboard({ actor: req.currentUser, id: req.params.id, year: req.query.year, month: req.query.month }), "Task dashboard fetched successfully"),
  updateTask: wrap((req) => taskService.updateTask({ actor: req.currentUser, id: req.params.id, body: req.body || {} }), "Task updated"),
  deleteTask: wrap((req) => taskService.deleteTask({ actor: req.currentUser, id: req.params.id }), "Task archived"),

  addAssignees: wrap((req) => taskService.addAssignees({ actor: req.currentUser, id: req.params.id, userIds: req.body?.userIds }), "Assignee added"),
  removeAssignee: wrap((req) => taskService.removeAssignee({ actor: req.currentUser, id: req.params.id, userId: req.params.userId }), "Assignee removed"),

  completeStep: wrap((req) => taskService.setStepCompletion({ actor: req.currentUser, id: req.params.id, stepId: req.params.stepId, completed: true, note: req.body?.note }), "Step completed"),
  uncompleteStep: wrap((req) => taskService.setStepCompletion({ actor: req.currentUser, id: req.params.id, stepId: req.params.stepId, completed: false }), "Step unchecked"),

  addRecurringCompletion: wrap((req) => taskService.addRecurringCompletion({ actor: req.currentUser, id: req.params.id, date: req.body?.date, note: req.body?.note }), "Completion added", 201),
  getMyRecurring: wrap((req) => taskService.getMyRecurring({ actor: req.currentUser, id: req.params.id, year: req.query.year, month: req.query.month }), "Recurring progress fetched successfully"),
  getTeamRecurring: wrap((req) => taskService.getTeamRecurring({ actor: req.currentUser, id: req.params.id, year: req.query.year, month: req.query.month }), "Team recurring progress fetched successfully"),

  listMessages: wrap((req) => taskService.listMessages({ actor: req.currentUser, id: req.params.id, limit: req.query.limit, before: req.query.before }), "Messages fetched successfully"),
  sendMessage: wrap((req) => taskService.sendMessage({ actor: req.currentUser, id: req.params.id, body: req.body || {} }), "Message sent", 201),
  deleteMessage: wrap((req) => taskService.deleteMessage({ actor: req.currentUser, id: req.params.id, messageId: req.params.messageId }), "Message deleted"),

  getMyDashboard: wrap((req) => taskService.getMyDashboard({ actor: req.currentUser }), "My task dashboard fetched successfully"),
  getTeamDashboard: wrap((req) => taskService.getTeamDashboard({ actor: req.currentUser }), "Team task dashboard fetched successfully"),
  getProgressReport: wrap((req) => taskService.getProgressReport({ actor: req.currentUser, ...req.query }), "Task report fetched successfully"),

  assignableUsers: wrap(async (req) => {
    const users = await taskService.getTeamRepUsers(req.currentUser);
    return users.map((u) => ({ userId: u._id, userName: u.fullName || u.userName || u.email, profileImage: u.profilePicture, role: u.role }));
  }, "Assignable users fetched successfully"),
};
