const mongoose = require("mongoose");

// Single-tenant fallback: all pre-existing / real data lives under REAL_ORG.
// The screenshot demo company lives under DEMO_ORG so it sees only its own
// global catalogs (products, channels, lines). Any user without an explicit
// organizationId defaults to REAL_ORG, so the live app is never affected.
const REAL_ORG_ID = new mongoose.Types.ObjectId("000000000000000000000001");
const DEMO_ORG_ID = new mongoose.Types.ObjectId("000000000000000000000002");

const resolveOrgId = (user) => (user && user.organizationId) ? user.organizationId : REAL_ORG_ID;

module.exports = { REAL_ORG_ID, DEMO_ORG_ID, resolveOrgId };
