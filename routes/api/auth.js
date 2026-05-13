const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const defaults = require('../../config/default.json');
const User = require('../../models/User');

const router = express.Router();

const getJwtSecret = () => {
  return process.env.JWT_SECRET || process.env.jwtSecret || defaults.jwtSecret;
};

const createBackendToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      authProvider: 'password'
    },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
};

const sanitizeUser = (user) => {
  const userObject = user.toObject ? user.toObject() : user;
  delete userObject.passwordHash;
  return userObject;
};

const backendAuth = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authorization header must be: Bearer <backendToken>'
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.backendUser = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired backend token'
    });
  }
};

// Email/Password registration using email as the primary login identity.
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, fullName, displayName, userName, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'email and password are required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters'
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Email already exists'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      authProviders: ['password'],
      fullName,
      displayName: displayName || fullName,
      userName,
      phone,
      role: 'representative',
      status: 'pending',
      lastLoginAt: now,
      lastActivityAt: now,
      onlineStatus: 'online'
    });

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token: createBackendToken(user),
      tokenType: 'Backend JWT',
      expiresIn: '7d',
      data: sanitizeUser(user)
    });
  } catch (error) {
    return next(error);
  }
});

// Email/Password login.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'email and password are required'
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    user.lastLoginAt = new Date();
    user.lastActivityAt = new Date();
    user.onlineStatus = 'online';
    if (!user.authProviders.includes('password')) {
      user.authProviders.push('password');
    }
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'User logged in successfully',
      token: createBackendToken(user),
      tokenType: 'Backend JWT',
      expiresIn: '7d',
      data: sanitizeUser(user)
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', backendAuth, async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.backendUser.id,
      {
        $set: {
          lastActivityAt: new Date(),
          onlineStatus: 'online'
        }
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User profile not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'User profile fetched successfully',
      data: user
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
