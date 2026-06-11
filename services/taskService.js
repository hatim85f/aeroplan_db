const mongoose = require("mongoose");

const Task = require("../models/Task");
const TaskActivity = require("../models/TaskActivity");
const TaskMessage = require("../models/TaskMessage");
const TaskOccurrence = require("../models/TaskOccurrence");
const User = require("../models/User");
const { canAccessUser } = require("../helpers/hierarchyAccess");
const { isManagerRole } = require("../helpers/roles");
const { getDownlineUserIds } = require("../helpers/hierarchy");
const { notifyUsers } = require("../helpers/notify");

// Fire-and-forget notification — never let a notification failure break a task operation.
const fireNotify = (opts) => { notifyUsers(opts).catch(() => {}); };

const makeError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const getDisplayName = (user = {}) => user.fullName || user.userName || user.email || "User";
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (value) => { const d = new Date(value); d.setUTCHours(0, 0, 0, 0); return d; };
const endOfDay = (value) => { const d = new Date(value); d.setUTCHours(23, 59, 59, 999); return d; };
const weekStartOf = (value) => {
  const d = startOfDay(value);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
};
const daysBetween = (a, b) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);

/* ── Scope ──────────────────────────────────────── */

const getAccessibleRepIds = async (actor) => {
  if (actor.role === "admin") return null;
  if (!isManagerRole(actor.role)) return [String(actor._id)];
  return getDownlineUserIds(actor._id);
};

const loadUsersInScope = async (actor, userIds) => {
  const ids = userIds.filter(isValidObjectId);
  const users = await User.find({ _id: { $in: ids } })
    .select("_id fullName userName email role profilePicture path managerId").lean();
  if (actor.role !== "admin") {
    for (const user of users) {
      if (String(user._id) === String(actor._id)) continue;
      if (!canAccessUser(actor, user)) throw makeError(`You cannot assign ${getDisplayName(user)} — outside your team`, 403);
    }
  }
  return users;
};

const getTeamRepUsers = async (actor) => {
  const repIds = await getAccessibleRepIds(actor);
  const query = { role: "representative", isActive: { $ne: false }, status: { $ne: "inactive" } };
  if (repIds) query._id = { $in: repIds };
  return User.find(query).select("_id fullName userName email role profilePicture").lean();
};

/* ── Progress recalculation ─────────────────────── */

const activeAssignees = (task) => (task.assignedUsers || []).filter((u) => u.status === "active");

const recalcChecklist = (task) => {
  const active = activeAssignees(task);
  const activeIds = new Set(active.map((u) => String(u.userId)));

  (task.steps || []).forEach((step) => {
    const relevant = (step.userProgress || []).filter((p) => activeIds.has(String(p.userId)));
    const completed = relevant.filter((p) => p.isCompleted).length;
    step.totalAssignedUsersCount = active.length;
    step.completedUsersCount = completed;
    step.stepCompletionPercentage = active.length ? round2((completed / active.length) * 100) : 0;
    step.isStepCompleted = active.length > 0 && completed === active.length;
  });

  const steps = task.steps || [];
  task.overallProgressPercentage = steps.length
    ? round2(steps.reduce((s, step) => s + step.stepCompletionPercentage, 0) / steps.length)
    : 0;

  if (task.taskStatus === "active" && steps.length && steps.every((s) => s.isStepCompleted)) {
    task.taskStatus = "completed";
    task.completedAt = new Date();
  } else if (task.taskStatus === "completed" && !(steps.length && steps.every((s) => s.isStepCompleted))) {
    task.taskStatus = "active";
    task.completedAt = undefined;
  }
};

const logActivity = (taskId, actor, action, message, metadata) =>
  TaskActivity.create({ taskId, actorId: actor._id, actorName: getDisplayName(actor), action, message, metadata });

/* ── Create ─────────────────────────────────────── */

const buildAssignedUser = (user, actorId) => ({
  userId: user._id,
  userName: getDisplayName(user),
  userRole: user.role,
  profileImage: user.profilePicture,
  status: "active",
  addedAt: new Date(),
  addedBy: actorId,
});

const createTask = async ({ actor, body }) => {
  if (!String(body.title || "").trim()) throw makeError("title is required", 400);
  if (!["checklist", "recurring"].includes(body.taskType)) throw makeError("taskType must be checklist or recurring", 400);

  const actorIsManager = isManagerRole(actor.role);

  // Reps can only create self-assigned tasks; their manager is auto-involved.
  let users = [];
  if (!actorIsManager) {
    users = await loadUsersInScope(actor, [String(actor._id)]);
    if (!users.length) users = [actor];
  } else if (body.assignToAllTeam) {
    users = await getTeamRepUsers(actor);
  } else {
    const ids = Array.isArray(body.assignedUserIds) ? body.assignedUserIds : [];
    if (!ids.length) throw makeError("assignedUserIds is required (or set assignToAllTeam)", 400);
    users = await loadUsersInScope(actor, ids);
  }
  if (!users.length) throw makeError("A task needs at least one assignee", 400);

  const assignedUsers = users.map((u) => buildAssignedUser(u, actor._id));

  // For a rep-created task, attach the rep's manager so they have oversight.
  const managerId = actorIsManager ? actor._id : (actor.managerId || actor.reportsTo || null);

  const task = new Task({
    title: String(body.title).trim(),
    description: body.description,
    taskType: body.taskType,
    assignedUsers,
    createdBy: actor._id,
    createdByName: getDisplayName(actor),
    createdByRole: actor.role,
    managerId,
    teamId: actor.teamId,
    priority: ["low", "medium", "high", "urgent"].includes(body.priority) ? body.priority : "medium",
    startDate: body.startDate ? startOfDay(body.startDate) : startOfDay(new Date()),
    dueDate: body.dueDate ? endOfDay(body.dueDate) : undefined,
    endDate: body.endDate ? endOfDay(body.endDate) : undefined,
  });

  if (body.taskType === "checklist") {
    const steps = Array.isArray(body.steps) ? body.steps.filter((s) => String(s.title || "").trim()) : [];
    if (!steps.length) throw makeError("A checklist task needs at least one step", 400);
    task.steps = steps.map((s, index) => ({
      title: String(s.title).trim(),
      description: s.description,
      order: s.order ?? index,
      userProgress: assignedUsers.map((u) => ({ userId: u.userId, userName: u.userName, isCompleted: false })),
    }));
    recalcChecklist(task);
  } else {
    const rec = body.recurrence || {};
    if (!["daily", "weekly", "monthly"].includes(rec.frequency)) throw makeError("recurrence.frequency must be daily, weekly, or monthly", 400);
    const required = Number(rec.requiredTimesPerPeriod);
    if (!Number.isFinite(required) || required < 1) throw makeError("recurrence.requiredTimesPerPeriod must be at least 1", 400);
    task.recurrence = {
      isRecurring: true,
      frequency: rec.frequency,
      requiredTimesPerPeriod: required,
      startDate: rec.startDate ? startOfDay(rec.startDate) : task.startDate,
      endDate: rec.endDate ? endOfDay(rec.endDate) : task.dueDate,
    };
  }

  await task.save();
  await logActivity(task._id, actor, "task_created", `Task created and assigned to ${assignedUsers.length} user(s)`);

  // Notify assignees they have a new task (urgent priority uses the attention sound).
  fireNotify({
    from: actor._id,
    recipientIds: assignedUsers.map((u) => u.userId),
    title: `New task: ${task.title}`,
    subtitle: `${getDisplayName(actor)} assigned you a ${task.priority} priority task`,
    routeName: "TaskDashboard",
    payload: { taskId: String(task._id) },
    category: "tasks",
  });

  const obj = task.toObject();
  return { ...obj, taskId: task._id };
};

/* ── Scoped fetch ───────────────────────────────── */

const getScopedTask = async (actor, id, { forView = true } = {}) => {
  if (!isValidObjectId(id)) throw makeError("Task id must be a valid MongoDB ObjectId", 400);
  const task = await Task.findOne({ _id: id, isActive: true });
  if (!task) throw makeError("Task not found", 404);

  if (actor.role === "admin") return task;

  const isAssignee = (task.assignedUsers || []).some((u) => String(u.userId) === String(actor._id) && (forView || u.status === "active"));
  const isManager = isManagerRole(actor.role) && (
    String(task.managerId) === String(actor._id) || String(task.createdBy) === String(actor._id)
  );
  // Manager can also access if any assignee is in their downline.
  let inScope = isManager;
  if (!inScope && isManagerRole(actor.role)) {
    const repIds = await getAccessibleRepIds(actor);
    inScope = repIds ? (task.assignedUsers || []).some((u) => repIds.includes(String(u.userId))) : true;
  }

  if (!isAssignee && !inScope) throw makeError("You are not allowed to access this task", 403);
  return task;
};

const canManageTask = (actor, task) =>
  actor.role === "admin" || (isManagerRole(actor.role) && (
    String(task.managerId) === String(actor._id) || String(task.createdBy) === String(actor._id)
  ));

/* ── Lists ──────────────────────────────────────── */

const serializeCard = (task, actorId, countsByTask, lastByTask) => {
  const active = activeAssignees(task);
  const myEntry = (task.assignedUsers || []).find((u) => String(u.userId) === String(actorId) && u.status === "active");
  const daysRemaining = task.dueDate ? daysBetween(new Date(), task.dueDate) : null;
  const commentsCount = countsByTask?.get(String(task._id)) || 0;
  const card = {
    taskId: task._id,
    title: task.title,
    description: task.description,
    taskType: task.taskType,
    priority: task.priority,
    taskStatus: task.taskStatus,
    startDate: task.startDate,
    dueDate: task.dueDate,
    daysRemaining,
    overdueDays: daysRemaining != null && daysRemaining < 0 ? Math.abs(daysRemaining) : 0,
    overallProgressPercentage: task.overallProgressPercentage,
    assignedUsersCount: active.length,
    commentsCount,
    totalComments: commentsCount,
    lastComment: lastByTask?.get(String(task._id)) || null,
    isRecurring: task.taskType === "recurring",
  };
  if (myEntry && task.taskType === "checklist") {
    const total = task.steps.length;
    const mine = task.steps.filter((s) => (s.userProgress || []).some((p) => String(p.userId) === String(actorId) && p.isCompleted)).length;
    card.myProgress = total ? round2((mine / total) * 100) : 0;
  }
  return card;
};

const attachCommentMeta = async (tasks) => {
  const ids = tasks.map((t) => t._id);
  if (!ids.length) return { counts: new Map(), last: new Map() };
  const [counts, lasts] = await Promise.all([
    TaskMessage.aggregate([
      { $match: { taskId: { $in: ids }, isDeleted: { $ne: true } } },
      { $group: { _id: "$taskId", count: { $sum: 1 } } },
    ]),
    TaskMessage.aggregate([
      { $match: { taskId: { $in: ids }, isDeleted: { $ne: true } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$taskId", senderName: { $first: "$senderName" }, text: { $first: "$text" }, messageType: { $first: "$messageType" }, createdAt: { $first: "$createdAt" } } },
    ]),
  ]);
  return {
    counts: new Map(counts.map((c) => [String(c._id), c.count])),
    last: new Map(lasts.map((l) => [String(l._id), { senderName: l.senderName, text: l.messageType === "voice" ? "🎤 Voice note" : l.text, createdAt: l.createdAt }])),
  };
};

const buildListQuery = (params) => {
  const query = { isActive: true };
  if (params.status) query.taskStatus = params.status;
  if (params.taskType) query.taskType = params.taskType;
  if (params.priority) query.priority = params.priority;
  if (params.search) query.title = { $regex: String(params.search).trim(), $options: "i" };
  if (params.dueFrom || params.dueTo) {
    query.dueDate = {};
    if (params.dueFrom) query.dueDate.$gte = startOfDay(params.dueFrom);
    if (params.dueTo) query.dueDate.$lte = endOfDay(params.dueTo);
  }
  return query;
};

const listMyTasks = async ({ actor, ...params }) => {
  const query = buildListQuery(params);
  query["assignedUsers"] = { $elemMatch: { userId: actor._id, status: "active" } };
  const tasks = await Task.find(query).sort({ dueDate: 1, createdAt: -1 }).limit(500).lean();
  const { counts, last } = await attachCommentMeta(tasks);
  return tasks.map((t) => serializeCard(t, actor._id, counts, last));
};

const listTeamTasks = async ({ actor, userId, ...params }) => {
  if (!isManagerRole(actor.role)) throw makeError("Only managers can view team tasks", 403);
  const query = buildListQuery(params);
  const repIds = await getAccessibleRepIds(actor);

  if (userId && isValidObjectId(userId)) {
    query["assignedUsers.userId"] = userId;
  } else if (repIds) {
    query.$or = [{ managerId: actor._id }, { createdBy: actor._id }, { "assignedUsers.userId": { $in: repIds } }];
  }

  const tasks = await Task.find(query).sort({ dueDate: 1, createdAt: -1 }).limit(500).lean();
  const { counts, last } = await attachCommentMeta(tasks);
  return tasks.map((t) => {
    const card = serializeCard(t, actor._id, counts, last);
    card.assignedUsers = activeAssignees(t).map((u) => ({ userId: u.userId, userName: u.userName, profileImage: u.profileImage }));
    card.createdByName = t.createdByName;
    return card;
  });
};

/* ── Dashboard ──────────────────────────────────── */

const periodKeyFor = (task, date = new Date()) => {
  const freq = task.recurrence?.frequency;
  if (freq === "daily") return { periodKey: startOfDay(date).toISOString().slice(0, 10), periodType: "daily", date: startOfDay(date) };
  if (freq === "weekly") { const ws = weekStartOf(date); return { periodKey: `${ws.getUTCFullYear()}-W${ws.toISOString().slice(0, 10)}`, periodType: "weekly", weekStartDate: ws }; }
  const d = new Date(date);
  return { periodKey: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`, periodType: "monthly", year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

const ensureOccurrence = async (task, userEntry, period) => {
  let occ = await TaskOccurrence.findOne({ taskId: task._id, userId: userEntry.userId, periodKey: period.periodKey });
  if (!occ) {
    occ = await TaskOccurrence.create({
      taskId: task._id,
      userId: userEntry.userId,
      userName: userEntry.userName,
      periodType: period.periodType,
      year: period.year,
      month: period.month,
      weekStartDate: period.weekStartDate,
      date: period.date,
      periodKey: period.periodKey,
      requiredTimes: task.recurrence.requiredTimesPerPeriod,
      completedTimes: 0,
      status: "pending",
      createdBy: task.createdBy,
      managerId: task.managerId,
      teamId: task.teamId,
    });
  }
  return occ;
};

const getDashboard = async ({ actor, id, year, month }) => {
  const task = await getScopedTask(actor, id);
  const manage = canManageTask(actor, task);
  const active = activeAssignees(task);

  // Recurring progress for the selected (or current) period.
  let recurringProgress = [];
  if (task.taskType === "recurring") {
    const refDate = year && month ? new Date(Date.UTC(Number(year), Number(month) - 1, 15)) : new Date();
    const period = periodKeyFor(task, refDate);
    const occs = await TaskOccurrence.find({ taskId: task._id, periodKey: period.periodKey }).lean();
    const occByUser = new Map(occs.map((o) => [String(o.userId), o]));
    recurringProgress = active.map((u) => {
      const occ = occByUser.get(String(u.userId));
      const completedTimes = occ?.completedTimes || 0;
      const required = task.recurrence.requiredTimesPerPeriod;
      return {
        userId: u.userId,
        userName: u.userName,
        profileImage: u.profileImage,
        requiredTimes: required,
        completedTimes,
        percentage: required ? round2((completedTimes / required) * 100) : 0,
        status: occ?.status || "pending",
        periodKey: period.periodKey,
      };
    });
  }

  const [messageCount, lastMessage, recentMessages, timeline] = await Promise.all([
    TaskMessage.countDocuments({ taskId: task._id, isDeleted: { $ne: true } }),
    TaskMessage.findOne({ taskId: task._id, isDeleted: { $ne: true } }).sort({ createdAt: -1 }).lean(),
    TaskMessage.find({ taskId: task._id, isDeleted: { $ne: true } }).sort({ createdAt: -1 }).limit(20).lean(),
    TaskActivity.find({ taskId: task._id }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);

  const numberOfDays = task.startDate && task.dueDate ? daysBetween(task.startDate, task.dueDate) : null;
  const daysRemaining = task.dueDate ? daysBetween(new Date(), task.dueDate) : null;
  const overdueDays = daysRemaining != null && daysRemaining < 0 ? Math.abs(daysRemaining) : 0;

  // Recurring overall progress = avg of active users' period progress.
  let overall = task.overallProgressPercentage;
  if (task.taskType === "recurring") {
    overall = recurringProgress.length ? round2(recurringProgress.reduce((s, r) => s + Math.min(r.percentage, 100), 0) / recurringProgress.length) : 0;
  }

  return {
    taskSummary: {
      taskId: task._id,
      title: task.title,
      description: task.description,
      taskType: task.taskType,
      createdByName: task.createdByName,
      priority: task.priority,
      taskStatus: task.taskStatus,
      startDate: task.startDate,
      dueDate: task.dueDate,
      endDate: task.endDate,
      numberOfDays,
      daysRemaining,
      overdueDays,
      overallProgressPercentage: overall,
      assignedUsersCount: active.length,
      completedUsersCount: task.taskType === "checklist"
        ? active.filter((u) => task.steps.length && task.steps.every((s) => (s.userProgress || []).some((p) => String(p.userId) === String(u.userId) && p.isCompleted))).length
        : recurringProgress.filter((r) => r.status === "completed").length,
      totalComments: messageCount,
      lastComment: lastMessage ? { senderName: lastMessage.senderName, text: lastMessage.messageType === "voice" ? "🎤 Voice note" : lastMessage.text, createdAt: lastMessage.createdAt } : null,
      recurrence: task.recurrence,
    },
    assignedUsers: (task.assignedUsers || []).map((u) => ({
      userId: u.userId, userName: u.userName, userRole: u.userRole, profileImage: u.profileImage, status: u.status, addedAt: u.addedAt, removedAt: u.removedAt,
    })),
    stepsProgress: (task.steps || []).map((s) => ({
      stepId: s._id,
      title: s.title,
      description: s.description,
      order: s.order,
      completedUsersCount: s.completedUsersCount,
      totalAssignedUsersCount: s.totalAssignedUsersCount,
      stepCompletionPercentage: s.stepCompletionPercentage,
      isStepCompleted: s.isStepCompleted,
      users: active.map((u) => ({
        userId: u.userId,
        userName: u.userName,
        profileImage: u.profileImage,
        isCompleted: (s.userProgress || []).some((p) => String(p.userId) === String(u.userId) && p.isCompleted),
      })),
    })),
    recurringProgress,
    commentsSummary: { total: messageCount },
    recentMessages: recentMessages.reverse().map(serializeMessage),
    timeline: timeline.map((a) => ({ action: a.action, message: a.message, actorName: a.actorName, createdAt: a.createdAt })),
    permissions: {
      canEdit: manage,
      canAddAssignees: manage,
      canRemoveAssignees: manage,
      canComment: true,
      canCompleteStep: !manage || active.some((u) => String(u.userId) === String(actor._id)),
      canCompleteRecurring: active.some((u) => String(u.userId) === String(actor._id)),
      canCancel: manage,
    },
  };
};

/* ── Update / delete ────────────────────────────── */

const updateTask = async ({ actor, id, body }) => {
  const task = await getScopedTask(actor, id);
  if (!canManageTask(actor, task)) throw makeError("Only the task manager or admin can edit this task", 403);

  if (body.title !== undefined) task.title = String(body.title).trim() || task.title;
  if (body.description !== undefined) task.description = body.description;
  if (body.priority !== undefined && ["low", "medium", "high", "urgent"].includes(body.priority)) {
    if (task.priority !== body.priority) await logActivity(task._id, actor, "priority_changed", `Priority changed to ${body.priority}`);
    task.priority = body.priority;
  }
  if (body.startDate !== undefined) task.startDate = startOfDay(body.startDate);
  if (body.dueDate !== undefined) {
    task.dueDate = endOfDay(body.dueDate);
    await logActivity(task._id, actor, "due_date_changed", `Due date changed`);
  }
  if (body.taskStatus !== undefined && ["active", "completed", "cancelled", "archived"].includes(body.taskStatus)) {
    task.taskStatus = body.taskStatus;
    if (body.taskStatus === "cancelled") { task.cancelledAt = new Date(); task.cancelledBy = actor._id; task.cancelReason = body.cancelReason; await logActivity(task._id, actor, "task_cancelled", "Task cancelled"); }
    if (body.taskStatus === "active") await logActivity(task._id, actor, "task_reopened", "Task reopened");
  }
  await task.save();
  return task;
};

const deleteTask = async ({ actor, id }) => {
  const task = await getScopedTask(actor, id);
  if (!canManageTask(actor, task)) throw makeError("Only the task manager or admin can archive this task", 403);
  const assigneeIds = activeAssignees(task).map((u) => u.userId);
  task.isActive = false;
  task.taskStatus = "archived";
  await task.save();

  fireNotify({
    from: actor._id,
    recipientIds: assigneeIds,
    title: `Task closed: ${task.title}`,
    subtitle: `${getDisplayName(actor)} archived this task`,
    routeName: "MyTasks",
    payload: { taskId: String(task._id) },
    category: "tasks",
  });
  return { archived: true, taskId: task._id };
};

/* ── Assignees ──────────────────────────────────── */

const addAssignees = async ({ actor, id, userIds }) => {
  const task = await getScopedTask(actor, id);
  if (!canManageTask(actor, task)) throw makeError("Only the task manager or admin can add assignees", 403);
  const ids = Array.isArray(userIds) ? userIds.filter(isValidObjectId) : [];
  if (!ids.length) throw makeError("userIds is required", 400);

  const users = await loadUsersInScope(actor, ids);
  const existingActive = new Set(activeAssignees(task).map((u) => String(u.userId)));
  let added = 0;
  const addedIds = [];

  for (const user of users) {
    if (existingActive.has(String(user._id))) continue;
    addedIds.push(user._id);
    const removed = (task.assignedUsers || []).find((u) => String(u.userId) === String(user._id) && u.status === "removed");
    if (removed) {
      removed.status = "active";
      removed.addedAt = new Date();
      removed.addedBy = actor._id;
      removed.removedAt = undefined;
      removed.removedBy = undefined;
    } else {
      task.assignedUsers.push(buildAssignedUser(user, actor._id));
    }
    // Checklist: ensure userProgress row in every step.
    if (task.taskType === "checklist") {
      task.steps.forEach((step) => {
        if (!(step.userProgress || []).some((p) => String(p.userId) === String(user._id))) {
          step.userProgress.push({ userId: user._id, userName: getDisplayName(user), isCompleted: false });
        }
      });
    }
    added += 1;
    await logActivity(task._id, actor, "assignee_added", `${getDisplayName(user)} added to the task`);
  }

  if (task.taskType === "checklist") recalcChecklist(task);
  await task.save();

  if (addedIds.length) {
    fireNotify({
      from: actor._id,
      recipientIds: addedIds,
      title: `Added to task: ${task.title}`,
      subtitle: `${getDisplayName(actor)} added you to this task`,
      routeName: "TaskDashboard",
      payload: { taskId: String(task._id) },
      category: "task_assigned",
    });
  }
  return { addedCount: added, task };
};

const removeAssignee = async ({ actor, id, userId }) => {
  const task = await getScopedTask(actor, id);
  if (!canManageTask(actor, task)) throw makeError("Only the task manager or admin can remove assignees", 403);
  if (!isValidObjectId(userId)) throw makeError("userId must be a valid MongoDB ObjectId", 400);

  const entry = (task.assignedUsers || []).find((u) => String(u.userId) === String(userId) && u.status === "active");
  if (!entry) throw makeError("Active assignee not found", 404);
  if (activeAssignees(task).length <= 1) throw makeError("A task cannot have zero active assignees", 400);

  entry.status = "removed";
  entry.removedAt = new Date();
  entry.removedBy = actor._id;
  if (task.taskType === "checklist") recalcChecklist(task);
  await task.save();
  await logActivity(task._id, actor, "assignee_removed", `${entry.userName} removed from the task`);

  fireNotify({
    from: actor._id,
    recipientIds: [userId],
    title: `Removed from task: ${task.title}`,
    subtitle: `${getDisplayName(actor)} removed you from this task`,
    routeName: "MyTasks",
    payload: { taskId: String(task._id) },
    category: "tasks",
  });
  return { removed: true, task };
};

/* ── Steps ──────────────────────────────────────── */

const setStepCompletion = async ({ actor, id, stepId, completed, note }) => {
  const task = await getScopedTask(actor, id);
  if (task.taskType !== "checklist") throw makeError("This is not a checklist task", 400);
  if (["completed", "cancelled", "archived"].includes(task.taskStatus) && completed === false) {
    // allow uncheck only if not cancelled/archived
    if (["cancelled", "archived"].includes(task.taskStatus)) throw makeError("Task is closed", 400);
  }
  const entry = activeAssignees(task).find((u) => String(u.userId) === String(actor._id));
  if (!entry) throw makeError("Only an active assignee can complete steps", 403);

  const step = (task.steps || []).id(stepId);
  if (!step) throw makeError("Step not found", 404);

  let progress = (step.userProgress || []).find((p) => String(p.userId) === String(actor._id));
  if (!progress) {
    step.userProgress.push({ userId: actor._id, userName: getDisplayName(actor), isCompleted: false });
    progress = step.userProgress[step.userProgress.length - 1];
  }
  progress.isCompleted = Boolean(completed);
  progress.completedAt = completed ? new Date() : undefined;
  progress.completedBy = completed ? actor._id : undefined;

  recalcChecklist(task);
  await task.save();
  await logActivity(task._id, actor, completed ? "step_completed" : "step_uncompleted", `${getDisplayName(actor)} ${completed ? "completed" : "unchecked"} step “${step.title}”`, { note });
  return { task, step };
};

/* ── Recurring ──────────────────────────────────── */

const addRecurringCompletion = async ({ actor, id, date, note }) => {
  const task = await getScopedTask(actor, id);
  if (task.taskType !== "recurring") throw makeError("This is not a recurring task", 400);
  const entry = activeAssignees(task).find((u) => String(u.userId) === String(actor._id));
  if (!entry) throw makeError("Only an active assignee can add a completion", 403);

  const refDate = date ? new Date(date) : new Date();
  const period = periodKeyFor(task, refDate);
  const occ = await ensureOccurrence(task, entry, period);

  occ.completions.push({ completedAt: refDate, completedBy: actor._id, note });
  occ.completedTimes = occ.completions.length;
  occ.status = occ.completedTimes >= occ.requiredTimes ? "completed" : "partially_completed";
  await occ.save();

  await logActivity(task._id, actor, "recurring_completion_added", `${getDisplayName(actor)} added a completion (${occ.completedTimes}/${occ.requiredTimes})`, { note });
  return { occurrence: occ };
};

const getMyRecurring = async ({ actor, id, year, month }) => {
  const task = await getScopedTask(actor, id);
  if (task.taskType !== "recurring") throw makeError("This is not a recurring task", 400);
  const entry = (task.assignedUsers || []).find((u) => String(u.userId) === String(actor._id));
  if (!entry) throw makeError("You are not assigned to this task", 403);
  const refDate = year && month ? new Date(Date.UTC(Number(year), Number(month) - 1, 15)) : new Date();
  const period = periodKeyFor(task, refDate);
  const occ = await ensureOccurrence(task, entry, period);
  return {
    periodKey: occ.periodKey,
    requiredTimes: occ.requiredTimes,
    completedTimes: occ.completedTimes,
    status: occ.status,
    completions: occ.completions,
    percentage: occ.requiredTimes ? round2((occ.completedTimes / occ.requiredTimes) * 100) : 0,
  };
};

const getTeamRecurring = async ({ actor, id, year, month }) => {
  const task = await getScopedTask(actor, id);
  if (!canManageTask(actor, task)) throw makeError("Only managers can view team recurring progress", 403);
  if (task.taskType !== "recurring") throw makeError("This is not a recurring task", 400);
  const refDate = year && month ? new Date(Date.UTC(Number(year), Number(month) - 1, 15)) : new Date();
  const period = periodKeyFor(task, refDate);
  const occs = await TaskOccurrence.find({ taskId: task._id, periodKey: period.periodKey }).lean();
  const occByUser = new Map(occs.map((o) => [String(o.userId), o]));
  return {
    periodKey: period.periodKey,
    users: activeAssignees(task).map((u) => {
      const occ = occByUser.get(String(u.userId));
      return {
        userId: u.userId, userName: u.userName, profileImage: u.profileImage,
        requiredTimes: task.recurrence.requiredTimesPerPeriod,
        completedTimes: occ?.completedTimes || 0,
        status: occ?.status || "pending",
      };
    }),
  };
};

/* ── Messages ───────────────────────────────────── */

const serializeMessage = (m) => ({
  messageId: m._id,
  senderId: m.senderId,
  senderName: m.senderName,
  senderRole: m.senderRole,
  senderProfileImage: m.senderProfileImage,
  messageType: m.messageType,
  text: m.text,
  voiceNoteUrl: m.voiceNoteUrl,
  voiceNoteDuration: m.voiceNoteDuration,
  createdAt: m.createdAt,
});

const listMessages = async ({ actor, id, limit, before }) => {
  await getScopedTask(actor, id);
  const query = { taskId: id, isDeleted: { $ne: true } };
  if (before) query.createdAt = { $lt: new Date(before) };
  const messages = await TaskMessage.find(query).sort({ createdAt: -1 }).limit(Number(limit) || 50).lean();
  return messages.reverse().map(serializeMessage);
};

const sendMessage = async ({ actor, id, body }) => {
  const task = await getScopedTask(actor, id);
  const type = body.messageType === "voice" ? "voice" : "text";
  if (type === "text" && !String(body.text || "").trim()) throw makeError("text is required", 400);
  if (type === "voice" && !String(body.voiceNoteUrl || "").trim()) throw makeError("voiceNoteUrl is required for a voice message", 400);

  const message = await TaskMessage.create({
    taskId: task._id,
    senderId: actor._id,
    senderName: getDisplayName(actor),
    senderRole: actor.role,
    senderProfileImage: actor.profilePicture,
    messageType: type,
    text: type === "text" ? String(body.text).trim() : undefined,
    voiceNoteUrl: type === "voice" ? body.voiceNoteUrl : undefined,
    voiceNoteDuration: type === "voice" ? body.voiceNoteDuration : undefined,
  });
  await logActivity(task._id, actor, type === "voice" ? "voice_note_added" : "comment_added", `${getDisplayName(actor)} ${type === "voice" ? "sent a voice note" : "commented"}`);

  // Notify the other participants (active assignees + the task manager), not the sender.
  const participantIds = [
    ...activeAssignees(task).map((u) => u.userId),
    ...(task.managerId ? [task.managerId] : []),
  ];
  fireNotify({
    from: actor._id,
    recipientIds: participantIds,
    title: `${getDisplayName(actor)} · ${task.title}`,
    subtitle: type === "voice" ? "🎤 Sent a voice note" : String(body.text).trim().slice(0, 120),
    routeName: "TaskDashboard",
    payload: { taskId: String(task._id), tab: "chat" },
    category: "task_message",
  });
  return serializeMessage(message);
};

const deleteMessage = async ({ actor, id, messageId }) => {
  await getScopedTask(actor, id);
  if (!isValidObjectId(messageId)) throw makeError("messageId must be a valid MongoDB ObjectId", 400);
  const message = await TaskMessage.findOne({ _id: messageId, taskId: id });
  if (!message || message.isDeleted) throw makeError("Message not found", 404);

  // Only the original sender (or an admin) can delete a message — deletes for everyone.
  const isSender = String(message.senderId) === String(actor._id);
  if (!isSender && actor.role !== "admin") throw makeError("You can only delete your own messages", 403);

  message.isDeleted = true;
  message.deletedAt = new Date();
  message.deletedBy = actor._id;
  await message.save();
  return { messageId: message._id, deleted: true };
};

/* ── Dashboards / reports ───────────────────────── */

const getMyDashboard = async ({ actor }) => {
  const tasks = await Task.find({
    isActive: true,
    assignedUsers: { $elemMatch: { userId: actor._id, status: "active" } },
  }).lean();

  const today = startOfDay(new Date());
  const monthStart = startOfDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));

  return {
    openTasks: tasks.filter((t) => t.taskStatus === "active").length,
    overdueTasks: tasks.filter((t) => t.taskStatus === "active" && t.dueDate && new Date(t.dueDate) < today).length,
    dueToday: tasks.filter((t) => t.taskStatus === "active" && t.dueDate && startOfDay(t.dueDate).getTime() === today.getTime()).length,
    completedThisMonth: tasks.filter((t) => t.taskStatus === "completed" && t.completedAt && new Date(t.completedAt) >= monthStart).length,
    recurringPending: tasks.filter((t) => t.taskType === "recurring" && t.taskStatus === "active").length,
    checklistTasks: tasks.filter((t) => t.taskType === "checklist" && t.taskStatus === "active").length,
  };
};

const getTeamDashboard = async ({ actor }) => {
  if (!isManagerRole(actor.role)) throw makeError("Only managers can view the team dashboard", 403);
  const repIds = await getAccessibleRepIds(actor);
  const query = { isActive: true };
  if (repIds) query.$or = [{ managerId: actor._id }, { createdBy: actor._id }, { "assignedUsers.userId": { $in: repIds } }];
  const tasks = await Task.find(query).lean();
  const today = startOfDay(new Date());

  const byStatus = { active: 0, completed: 0, cancelled: 0, archived: 0 };
  const byRep = new Map();
  tasks.forEach((t) => {
    byStatus[t.taskStatus] = (byStatus[t.taskStatus] || 0) + 1;
    activeAssignees(t).forEach((u) => {
      const entry = byRep.get(String(u.userId)) || { userId: u.userId, userName: u.userName, total: 0, active: 0, overdue: 0 };
      entry.total += 1;
      if (t.taskStatus === "active") entry.active += 1;
      if (t.taskStatus === "active" && t.dueDate && new Date(t.dueDate) < today) entry.overdue += 1;
      byRep.set(String(u.userId), entry);
    });
  });

  return {
    summaryCards: {
      totalTasks: tasks.length,
      activeTasks: byStatus.active,
      completedTasks: byStatus.completed,
      overdueTasks: tasks.filter((t) => t.taskStatus === "active" && t.dueDate && new Date(t.dueDate) < today).length,
      recurringPending: tasks.filter((t) => t.taskType === "recurring" && t.taskStatus === "active").length,
    },
    byStatus,
    byRep: [...byRep.values()].sort((a, b) => b.active - a.active),
  };
};

const getProgressReport = async ({ actor, dateFrom, dateTo, userId, taskType, status }) => {
  const repIds = await getAccessibleRepIds(actor);
  const query = { isActive: true };
  if (!isManagerRole(actor.role)) {
    query.assignedUsers = { $elemMatch: { userId: actor._id, status: "active" } };
  } else if (userId && isValidObjectId(userId)) {
    query["assignedUsers.userId"] = userId;
  } else if (repIds) {
    query.$or = [{ managerId: actor._id }, { createdBy: actor._id }, { "assignedUsers.userId": { $in: repIds } }];
  }
  if (taskType) query.taskType = taskType;
  if (status) query.taskStatus = status;
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = startOfDay(dateFrom);
    if (dateTo) query.createdAt.$lte = endOfDay(dateTo);
  }

  const tasks = await Task.find(query).sort({ createdAt: -1 }).limit(500).lean();
  const { counts } = await attachCommentMeta(tasks);
  const today = startOfDay(new Date());

  const rows = tasks.map((t) => ({
    taskId: t._id,
    title: t.title,
    taskType: t.taskType,
    priority: t.priority,
    assignedUsers: activeAssignees(t).map((u) => u.userName),
    assignedUsersCount: activeAssignees(t).length,
    overallProgressPercentage: t.overallProgressPercentage,
    taskStatus: t.taskStatus,
    dueDate: t.dueDate,
    completedAt: t.completedAt,
    overdueDays: t.taskStatus === "active" && t.dueDate && new Date(t.dueDate) < today ? Math.abs(daysBetween(new Date(), t.dueDate)) : 0,
    commentsCount: counts.get(String(t._id)) || 0,
  }));

  const completedTasks = rows.filter((r) => r.taskStatus === "completed").length;
  const activeTasks = rows.filter((r) => r.taskStatus === "active").length;
  const overdueTasks = rows.filter((r) => r.overdueDays > 0).length;
  const averageProgress = rows.length
    ? round2(rows.reduce((s, r) => s + (r.overallProgressPercentage || 0), 0) / rows.length)
    : 0;

  return {
    summary: {
      totalTasks: rows.length,
      activeTasks,
      completedTasks,
      overdueTasks,
      averageProgress,
    },
    tasks: rows,
  };
};

module.exports = {
  addAssignees,
  addRecurringCompletion,
  createTask,
  deleteMessage,
  deleteTask,
  getDashboard,
  getMyDashboard,
  getMyRecurring,
  getProgressReport,
  getTeamDashboard,
  getTeamRecurring,
  getTeamRepUsers,
  listMessages,
  listMyTasks,
  listTeamTasks,
  removeAssignee,
  sendMessage,
  setStepCompletion,
  updateTask,
};
