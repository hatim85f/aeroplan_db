const mongoose = require("mongoose");
const defaults = require("../config/default.json");

const mongoURI = process.env.MONGO_URI || process.env.mongoURI || defaults.mongoURI;
const User = require("../models/User");

(async () => {
  await mongoose.connect(mongoURI);

  const result = await User.findByIdAndUpdate(
    "6a0f725bfa0ad31bfd20f745",
    {
      $set: {
        profilePicture:
          "https://media.licdn.com/dms/image/v2/D4D03AQHJ4GCBfpMxwQ/profile-displayphoto-shrink_800_800/profile-displayphoto-shrink_800_800/0/1715229922480?e=1781136000&v=beta&t=c5HffSCC_3UI2ZYbRLqaO2yPiblM8cBNDgvcZ1OWlzI",
      },
    },
    { new: true },
  ).select("_id fullName email profilePicture");

  if (!result) {
    console.log("ERROR: User not found");
  } else {
    console.log("Updated:", JSON.stringify(result, null, 2));
  }

  await mongoose.disconnect();
})();
