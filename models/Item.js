const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    itemName: {
      type: String,
      required: true,
      trim: true
    },
    itemCode: {
      type: String,
      trim: true
    },
    lineId: {
      type: String,
      trim: true
    },
    defaultChannel: {
      type: String,
      trim: true
    },
    CIF: {
      type: Number,
      default: 0
    },
    UPP: {
      type: Number,
      default: 0
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Item', itemSchema);
