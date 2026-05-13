const jwt = require('jsonwebtoken');
const defaults = require('../config/default.json');

const auth = async (req, res, next) => {
  const header = req.header('Authorization');
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'No token, authorization denied' });
  }

  try {
    const jwtSecret = process.env.JWT_SECRET || process.env.jwtSecret || defaults.jwtSecret;
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token is not valid' });
  }
};

module.exports = auth;
