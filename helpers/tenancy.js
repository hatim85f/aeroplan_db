const mongoose = require("mongoose");

// Multi-tenant boundary. Every business document belongs to one hidden
// Organization. All pre-existing / real data lives under MAIN (REAL_ORG); the
// screenshot demo company lives under DEMO_ORG. Any user without an explicit
// organizationId defaults to MAIN, so legacy/in-flight data is never hidden.
const REAL_ORG_ID = new mongoose.Types.ObjectId("000000000000000000000001");
const DEMO_ORG_ID = new mongoose.Types.ObjectId("000000000000000000000002");

// The tenant id for the authenticated user (used to tag creates).
const resolveOrgId = (user) => (user && user.organizationId) ? user.organizationId : REAL_ORG_ID;

// Spread into a Mongoose query / aggregation $match to scope reads to the
// user's organization, e.g. Model.find({ ...tenantFilter(user), status: "active" }).
const tenantFilter = (user) => ({ organizationId: resolveOrgId(user) });

module.exports = { REAL_ORG_ID, DEMO_ORG_ID, resolveOrgId, tenantFilter };
