const mongoose = require("mongoose");
const defaults = require("../config/default.json");
const User = require("../models/User");
const Line = require("../models/Line");
const Team = require("../models/Team");
const TeamInvitation = require("../models/TeamInvitation");

const mongoURI = process.env.MONGO_URI || process.env.mongoURI || defaults.mongoURI;
const normalizeLineId = (lineId) => String(lineId || "").trim().toUpperCase();
const USER_ID = "6a0f99f2fd5f69e40520e348";

mongoose.connect(mongoURI)
  .then(async () => {
    // 1. Find pending invitation
    const invitation = await TeamInvitation.findOne({
      toUserId: USER_ID,
      status: "pending",
    });

    if (!invitation) {
      console.log("NO_PENDING_INVITATION found for this user");
      await mongoose.disconnect();
      return;
    }

    console.log("Found invitation:", invitation._id.toString(), "lineId:", invitation.lineId);

    // 2. Check expiry
    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      invitation.status = "cancelled";
      invitation.cancelledAt = new Date();
      await invitation.save();
      console.log("EXPIRED — invitation cancelled");
      await mongoose.disconnect();
      return;
    }

    const acceptedLineId = normalizeLineId(invitation.lineId);
    const [currentUser, line] = await Promise.all([
      User.findById(USER_ID),
      Line.findOne({ lineId: acceptedLineId }),
    ]);

    if (!currentUser) { console.log("USER_NOT_FOUND"); await mongoose.disconnect(); return; }
    if (!line) { console.log("LINE_NOT_FOUND:", acceptedLineId); await mongoose.disconnect(); return; }

    // 3. Update user lineId
    currentUser.lineId = acceptedLineId;
    currentUser.lastActivityAt = new Date();
    await currentUser.save();
    console.log("User lineId set to:", acceptedLineId);

    // 4. Add user to line members
    await Line.findOneAndUpdate(
      { lineId: acceptedLineId },
      { $addToSet: { members: currentUser._id } },
    );
    console.log("User added to line members");

    // 5. Accept invitation
    invitation.lineId = acceptedLineId;
    invitation.lineName = invitation.lineName || line.lineName;
    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    await invitation.save();
    console.log("Invitation marked accepted");

    // 6. Sync user into any team on this line
    const teams = await Team.find({
      $or: [{ lineIds: acceptedLineId }, { lineId: acceptedLineId }],
      isActive: true,
    });

    console.log("Teams found on this line:", teams.length);

    for (const team of teams) {
      const managerId = team.managerId;
      const manager = await User.findById(managerId);
      const managerPath = manager ? [...(manager.path || []), manager._id] : [];

      await User.findByIdAndUpdate(currentUser._id, {
        $set: {
          teamId: team._id,
          managerId,
          path: managerPath,
          lastActivityAt: new Date(),
        },
      });

      await Team.findByIdAndUpdate(team._id, {
        $addToSet: { members: currentUser._id },
      });

      console.log("User assigned to team:", team.teamName, team._id.toString());
    }

    console.log("DONE — invitation accepted and user synced successfully");
    await mongoose.disconnect();
  })
  .catch((err) => {
    console.error("ERROR:", err.message);
    process.exit(1);
  });
