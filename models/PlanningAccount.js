const mongoose = require("mongoose");

const { Schema } = mongoose;

const accountTypes = ["clinic", "hospital", "pharmacy", "drugstore", "other"];

/**
 * An account a medical rep wants to plan visits for. May link to a real
 * Account document or be a custom planning-only entry.
 */
const planningAccountSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, trim: true },
    managerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    teamId: { type: Schema.Types.ObjectId, ref: "Team", index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", index: true },
    accountName: { type: String, required: true, trim: true, index: true },
    accountNameKey: { type: String, trim: true, index: true },
    isCustomAccount: { type: Boolean, default: false },
    accountType: { type: String, enum: accountTypes, default: "other" },
    area: { type: String, trim: true },
    territory: { type: String, trim: true },
    keyContact: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    notes: { type: String, trim: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

planningAccountSchema.index({ accountName: "text" });

module.exports = mongoose.model("PlanningAccount", planningAccountSchema);
