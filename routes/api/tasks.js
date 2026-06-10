const express = require("express");

const auth = require("../../middleware/auth");
const tasks = require("../../controllers/taskController");

const router = express.Router();

// Lists + dashboards (specific routes before "/:id")
router.get("/my", auth, tasks.loadActor, tasks.listMyTasks);
router.get("/team", auth, tasks.loadActor, tasks.listTeamTasks);
router.get("/assignable-users", auth, tasks.loadActor, tasks.assignableUsers);
router.get("/dashboard/my", auth, tasks.loadActor, tasks.getMyDashboard);
router.get("/dashboard/team", auth, tasks.loadActor, tasks.getTeamDashboard);
router.get("/reports/progress", auth, tasks.loadActor, tasks.getProgressReport);

router.post("/", auth, tasks.loadActor, tasks.createTask);

// Single task
router.get("/:id/dashboard", auth, tasks.loadActor, tasks.getDashboard);
router.get("/:id/recurring/my", auth, tasks.loadActor, tasks.getMyRecurring);
router.get("/:id/recurring/team", auth, tasks.loadActor, tasks.getTeamRecurring);
router.get("/:id/messages", auth, tasks.loadActor, tasks.listMessages);
router.post("/:id/messages", auth, tasks.loadActor, tasks.sendMessage);
router.delete("/:id/messages/:messageId", auth, tasks.loadActor, tasks.deleteMessage);
router.post("/:id/assignees", auth, tasks.loadActor, tasks.addAssignees);
router.delete("/:id/assignees/:userId", auth, tasks.loadActor, tasks.removeAssignee);
router.post("/:id/steps/:stepId/complete", auth, tasks.loadActor, tasks.completeStep);
router.post("/:id/steps/:stepId/uncomplete", auth, tasks.loadActor, tasks.uncompleteStep);
router.post("/:id/recurring/complete", auth, tasks.loadActor, tasks.addRecurringCompletion);
router.patch("/:id", auth, tasks.loadActor, tasks.updateTask);
router.delete("/:id", auth, tasks.loadActor, tasks.deleteTask);

module.exports = router;
