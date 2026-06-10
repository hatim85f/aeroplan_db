const mongoose = require("mongoose");

const { Schema } = mongoose;

const completionSchema = new Schema(
  {
    completedAt: { type: Date, default: Date.now },
    completedBy: { type: Schema.Types.ObjectId, ref: "User" },
    note: { type: String, trim: true },
  },
  { _id: true },
);

/** Per-user recurring progress for one period of a recurring task. */
const taskOccurrenceSchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, trim: true },
    periodType: { type: String, enum: ["daily", "weekly", "monthly"], required: true },
    year: { type: Number, index: true },
    month: { type: Number, index: true },
    weekStartDate: { type: Date },
    date: { type: Date },
    periodKey: { type: String, index: true }, // e.g. 2026-6, 2026-W23, 2026-06-15
    requiredTimes: { type: Number, default: 1 },
    completedTimes: { type: Number, default: 0 },
    completions: { type: [completionSchema], default: [] },
    status: { type: String, enum: ["pending", "partially_completed", "completed", "overdue"], default: "pending", index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    managerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    teamId: { type: Schema.Types.ObjectId, ref: "Team", index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

taskOccurrenceSchema.index({ taskId: 1, userId: 1, periodKey: 1 }, { unique: true });

module.exports = mongoose.model("TaskOccurrence", taskOccurrenceSchema);
