const canAccessUser = (actor, targetUser) => {
  if (!actor || !targetUser) {
    return false;
  }

  if (actor.role === "admin") {
    return true;
  }

  const actorId = String(actor._id || actor.id);
  const targetId = String(targetUser._id || targetUser.id);

  if (actorId === targetId) {
    return true;
  }

  return (targetUser.path || []).some((managerId) => String(managerId) === actorId);
};

module.exports = {
  canAccessUser,
};
