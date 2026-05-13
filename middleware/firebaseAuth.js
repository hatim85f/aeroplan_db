const admin = require('../config/firebaseAdmin');

const firebaseAuth = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authorization header must be: Bearer <firebaseIdToken>'
    });
  }

  try {
    req.firebaseToken = token;
    req.firebaseUser = await admin.auth().verifyIdToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired Firebase ID token',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

module.exports = firebaseAuth;
