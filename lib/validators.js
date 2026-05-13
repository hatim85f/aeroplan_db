const isEmail = (value) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).toLowerCase());
};

const requiredFields = (body, fields) => {
  return fields.filter((field) => !body[field]);
};

module.exports = {
  isEmail,
  requiredFields
};
