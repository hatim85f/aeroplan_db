const mongoose = require("mongoose");

const { Schema } = mongoose;

const teamSchema = new Schema(
  {
    teamName: {
      type: String,
      required: true,
      trim: true,
    },
    teamCode: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      uppercase: true,
    },
    teamLogo: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    lineId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    lineName: {
      type: String,
      trim: true,
    },
    territory: {
      type: String,
      trim: true,
    },
    area: {
      type: String,
      trim: true,
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "active",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    visibility: {
      type: String,
      enum: ["private", "organization"],
      default: "private",
    },
  },
  { timestamps: true }
);

teamSchema.virtual("logo").get(function getLogo() {
  return this.teamLogo;
});

teamSchema.virtual("details").get(function getDetails() {
  return this.description;
});

teamSchema.set("toJSON", { virtuals: true });
teamSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Team", teamSchema);
