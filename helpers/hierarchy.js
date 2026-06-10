const mongoose = require("mongoose");
const User = require("../models/User");

// All descendant user ids (any role) UNDER actorId, INCLUDING actorId itself.
// Walks managerId links level by level (self-healing; ignores possibly-stale path).
const getDownlineUserIds = async (actorId) => {
  const rootId = String(actorId);
  const result = new Set([rootId]);
  let frontier = [new mongoose.Types.ObjectId(rootId)];
  while (frontier.length) {
    const children = await User.find({ managerId: { $in: frontier } }).select("_id").lean();
    const next = [];
    for (const c of children) {
      const id = String(c._id);
      if (!result.has(id)) { result.add(id); next.push(c._id); }
    }
    frontier = next;
  }
  return [...result];
};

// Same, but only representative-role users in the sub-tree (NOT including non-reps).
const getDownlineRepIds = async (actorId) => {
  const ids = await getDownlineUserIds(actorId);
  const reps = await User.find({ _id: { $in: ids }, role: "representative" }).select("_id").lean();
  return reps.map((r) => String(r._id));
};

// One-time repair: rebuild every user's `path` from the managerId chain.
const repairHierarchyPaths = async () => {
  const users = await User.find({}).select("_id managerId").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const pathFor = (id, seen = new Set()) => {
    const u = byId.get(String(id));
    if (!u || !u.managerId || seen.has(String(id))) return [];
    seen.add(String(id));
    const parentId = String(u.managerId);
    return [...pathFor(parentId, seen), u.managerId];
  };
  let updated = 0;
  for (const u of users) {
    const newPath = pathFor(String(u._id));
    await User.updateOne({ _id: u._id }, { $set: { path: newPath } });
    updated += 1;
  }
  return { updated };
};

module.exports = { getDownlineUserIds, getDownlineRepIds, repairHierarchyPaths };
