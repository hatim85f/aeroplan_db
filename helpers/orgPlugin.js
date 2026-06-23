const mongoose = require("mongoose");

// Mongoose plugin that attaches the tenant key (organizationId) to a schema.
// Applied to every business collection so all data is linked to one hidden
// Organization and can be filtered for hard cross-tenant isolation.
module.exports = function organizationPlugin(schema) {
  schema.add({
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
  });
};
