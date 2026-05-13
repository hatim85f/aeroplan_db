const jwt = require('jsonwebtoken');
const defaults = require('../config/default.json');

const getJwtSecret = () => {
  return process.env.JWT_SECRET || process.env.jwtSecret || defaults.jwtSecret;
};

const auth = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authorization header must be: Bearer <token>'
    });
  }

  try {
    req.user = jwt.verify(token, getJwtSecret());
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

module.exports = auth;
