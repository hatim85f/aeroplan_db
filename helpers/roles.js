const MANAGER_ROLES = ["admin", "senior_manager", "manager"];

const isManagerRole = (role) => {
  return MANAGER_ROLES.includes(role);
};

module.exports = {
  MANAGER_ROLES,
  isManagerRole,
};
