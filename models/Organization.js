const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    organizationName: {
      type: String,
      required: true,
      trim: true
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
