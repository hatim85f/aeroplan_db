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
    targetValueBasis: {
      type: String,
      enum: ['cifUsd', 'wholesaleAed', 'retailAed'],
      default: 'cifUsd'
    },
    targetCurrency: {
      type: String,
      enum: ['USD', 'AED'],
      default: 'USD'
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

itemSchema.plugin(require("../helpers/orgPlugin"));

module.exports = mongoose.model('Item', itemSchema);
