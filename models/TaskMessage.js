const mongoose = require("mongoose");

const { Schema } = mongoose;

const taskMessageSchema = new Schema(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    senderName: { type: String, trim: true },
    senderRole: { type: String, trim: true },
    senderProfileImage: { type: String, trim: true },
    messageType: { type: String, enum: ["text", "voice"], default: "text" },
    text: { type: String, trim: true },
    voiceNoteUrl: { type: String, trim: true },
    voiceNoteDuration: { type: Number },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

taskMessageSchema.index({ taskId: 1, createdAt: 1 });

module.exports = mongoose.model("TaskMessage", taskMessageSchema);
