const mongoose = require("mongoose");

const { Schema } = mongoose;

// Hidden tenant boundary. Every business document belongs to exactly one
// Organization. Not exposed in the app UI — it only isolates data so one
// company's records can never be seen by another company (or its admins).
const organizationSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    isHidden: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Organization", organizationSchema);
