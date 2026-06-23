const mongoose = require("mongoose");

const { Schema } = mongoose;

/** One planned account on one date for one rep. */
const planningVisitSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, trim: true },
    managerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    teamId: { type: Schema.Types.ObjectId, ref: "Team", index: true },
    planningAccountId: { type: Schema.Types.ObjectId, ref: "PlanningAccount", required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", index: true },
    accountName: { type: String, trim: true },
    visitDate: { type: Date, required: true, index: true },
    year: { type: Number, index: true },
    month: { type: Number, index: true },
    weekStartDate: { type: Date, index: true },
    planStatus: { type: String, enum: ["draft", "submitted", "cancelled"], default: "draft", index: true },
    submittedAt: { type: Date },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

planningVisitSchema.index({ userId: 1, visitDate: 1 });
planningVisitSchema.index({ managerId: 1, visitDate: 1 });
planningVisitSchema.index({ teamId: 1, visitDate: 1 });
planningVisitSchema.index({ year: 1, month: 1 });

planningVisitSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("PlanningVisit", planningVisitSchema);
