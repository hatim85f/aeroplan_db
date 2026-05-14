const mongoose = require('mongoose');

const { Schema } = mongoose;

const teamSchema = new Schema(
  {
    teamName: {
      type: String,
      required: true,
      trim: true
    },
    logo: {
      type: String,
      trim: true
    },
    details: {
      type: String,
      trim: true
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User'
      }
    ],
    lineId: {
      type: String,
      trim: true
    },
    territory: {
      type: String,
      trim: true
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Team', teamSchema);
