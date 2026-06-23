const mongoose = require("mongoose");

const { Schema } = mongoose;

const taskActivitySchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String, trim: true },
    action: { type: String, required: true },
    message: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

taskActivitySchema.index({ taskId: 1, createdAt: -1 });

taskActivitySchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("TaskActivity", taskActivitySchema);
