const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * Time-bounded responsibility of a medical rep for an account.
 * Used by attribution logic (e.g. Achievement) to credit sales to the rep
 * who was responsible for the account on the sales date.
 *
 * endDate = null means the assignment is still ongoing.
 */
const accountRepAssignmentSchema = new Schema(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true,
    },
    accountName: {
      type: String,
      trim: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userName: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      default: null,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

accountRepAssignmentSchema.index({ accountId: 1, userId: 1, startDate: 1 });

module.exports = mongoose.model("AccountRepAssignment", accountRepAssignmentSchema);
