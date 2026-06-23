const mongoose = require("mongoose");

const { Schema } = mongoose;

const getUniqueObjectIdStrings = (values = []) => [
  ...new Set(values.map((value) => String(value))),
];

const salesTeamMemberSchema = new Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true,
    },
    position: {
      type: String,
      trim: true,
      index: true,
    },
    accountIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Account",
        index: true,
      },
    ],
    managerId: {
      type: Schema.Types.ObjectId,
      ref: "SalesTeamMember",
      default: null,
      index: true,
    },
    teamManaged: [
      {
        type: Schema.Types.ObjectId,
        ref: "SalesTeamMember",
        index: true,
      },
    ],
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
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
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

salesTeamMemberSchema.index({
  fullName: "text",
  phone: "text",
  email: "text",
  position: "text",
  notes: "text",
});

salesTeamMemberSchema.pre("validate", function normalizeAndValidate(next) {
  if (Array.isArray(this.accountIds)) {
    this.accountIds = getUniqueObjectIdStrings(this.accountIds);
  }

  if (Array.isArray(this.teamManaged)) {
    this.teamManaged = getUniqueObjectIdStrings(this.teamManaged);
  }

  if (this.status !== undefined) {
    this.status = String(this.status).trim().toLowerCase();
    this.isActive = this.status === "active";
  } else if (this.isActive !== undefined) {
    this.isActive = Boolean(this.isActive);
    this.status = this.isActive ? "active" : "inactive";
  }

  const memberId = this._id ? String(this._id) : null;

  if (memberId && this.managerId && String(this.managerId) === memberId) {
    this.invalidate("managerId", "Sales team member cannot be their own manager");
  }

  if (memberId && Array.isArray(this.teamManaged) && this.teamManaged.some((id) => String(id) === memberId)) {
    this.invalidate("teamManaged", "Sales team member cannot manage themselves");
  }

  next();
});

salesTeamMemberSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model("SalesTeamMember", salesTeamMemberSchema);
