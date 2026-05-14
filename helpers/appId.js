const createAppId = () => {
  const digits = Math.floor(100000 + Math.random() * 900000);
  return `AP-${digits}`;
};

module.exports = {
  createAppId,
};
