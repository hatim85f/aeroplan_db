const mongoose = require("mongoose");

const { Schema } = mongoose;

const assignedUserSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, trim: true },
    userRole: { type: String, trim: true },
    profileImage: { type: String, trim: true },
    status: { type: String, enum: ["active", "removed"], default: "active" },
    addedAt: { type: Date, default: Date.now },
    removedAt: { type: Date },
    addedBy: { type: Schema.Types.ObjectId, ref: "User" },
    removedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false },
);

const stepUserProgressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, trim: true },
    isCompleted: { type: Boolean, default: false },
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false },
);

const stepSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    order: { type: Number, default: 0 },
    userProgress: { type: [stepUserProgressSchema], default: [] },
    completedUsersCount: { type: Number, default: 0 },
    totalAssignedUsersCount: { type: Number, default: 0 },
    stepCompletionPercentage: { type: Number, default: 0 },
    isStepCompleted: { type: Boolean, default: false },
  },
  { _id: true },
);

const taskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true },
    taskType: { type: String, enum: ["checklist", "recurring"], required: true, index: true },
    assignedUsers: { type: [assignedUserSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
    createdByName: { type: String, trim: true },
    createdByRole: { type: String, trim: true },
    managerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    teamId: { type: Schema.Types.ObjectId, ref: "Team", index: true },
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium", index: true },
    startDate: { type: Date },
    dueDate: { type: Date, index: true },
    endDate: { type: Date },
    recurrence: {
      isRecurring: { type: Boolean, default: false },
      frequency: { type: String, enum: ["daily", "weekly", "monthly"] },
      requiredTimesPerPeriod: { type: Number, default: 1 },
      startDate: { type: Date },
      endDate: { type: Date },
    },
    steps: { type: [stepSchema], default: [] },
    overallProgressPercentage: { type: Number, default: 0 },
    taskStatus: { type: String, enum: ["active", "completed", "cancelled", "archived"], default: "active", index: true },
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelReason: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

taskSchema.index({ "assignedUsers.userId": 1, isActive: 1 });
taskSchema.index({ managerId: 1, taskStatus: 1 });
taskSchema.index({ teamId: 1, dueDate: 1 });

module.exports = mongoose.model("Task", taskSchema);
