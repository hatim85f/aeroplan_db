const express = require("express");

const auth = require("../../middleware/auth");
const planning = require("../../controllers/planningController");

const router = express.Router();

// Planning accounts
router.get("/accounts/source", auth, planning.loadActor, planning.getAccountSource);
router.get("/accounts", auth, planning.loadActor, planning.listPlanningAccounts);
router.post("/accounts", auth, planning.loadActor, planning.createPlanningAccount);
router.patch("/accounts/:id", auth, planning.loadActor, planning.updatePlanningAccount);
router.delete("/accounts/:id", auth, planning.loadActor, planning.deletePlanningAccount);

// Calendar / visits
router.get("/calendar/my", auth, planning.loadActor, planning.getMyCalendar);
router.get("/calendar/team", auth, planning.loadActor, planning.getTeamDay);
router.get("/calendar/team-week", auth, planning.loadActor, planning.getTeamWeek);
router.post("/visits", auth, planning.loadActor, planning.createVisits);
router.patch("/visits/:id", auth, planning.loadActor, planning.updateVisit);
router.delete("/visits/:id", auth, planning.loadActor, planning.deleteVisit);
router.post("/submit", auth, planning.loadActor, planning.submitPlan);

// Dashboard + reports
router.get("/dashboard/manager", auth, planning.loadActor, planning.getManagerDashboard);
router.get("/reports/accounts", auth, planning.loadActor, planning.getAccountsReport);
router.get("/reports/reps", auth, planning.loadActor, planning.getRepsReport);

module.exports = router;
