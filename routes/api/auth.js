const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const defaults = require('../../config/default.json');
const firebaseAuth = require('../../middleware/firebaseAuth');
const User = require('../../models/User');

const router = express.Router();

const providerMap = {
  'google.com': 'google',
  password: 'password'
};

const getAuthProviders = (firebaseUser) => {
  const identities = firebaseUser.firebase && firebaseUser.firebase.identities;
  const identityProviders = identities ? Object.keys(identities) : [];
  const signInProvider = firebaseUser.firebase && firebaseUser.firebase.sign_in_provider;
  const providers = [...identityProviders, signInProvider]
    .map((provider) => providerMap[provider])
    .filter(Boolean);

  return [...new Set(providers)];
};

const buildFirebaseProfile = (firebaseUser) => {
  return {
    firebaseUid: firebaseUser.uid,
    email: firebaseUser.email,
    displayName: firebaseUser.name,
    profilePicture: firebaseUser.picture,
    emailVerified: Boolean(firebaseUser.email_verified),
    authProviders: getAuthProviders(firebaseUser)
  };
};

const getBusinessEmailUpdate = (businessEmail) => {
  if (!businessEmail) {
    return {};
  }

  return {
    businessEmail: String(businessEmail).toLowerCase().trim()
  };
};

const getJwtSecret = () => {
  return process.env.JWT_SECRET || process.env.jwtSecret || defaults.jwtSecret;
};

const createBackendToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      businessEmail: user.businessEmail,
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

// Postman test:
// 1. Login/signup in Firebase on the frontend.
// 2. Get the Firebase ID token from the frontend Firebase user.
// 3. Send Authorization: Bearer <firebaseIdToken>.
// 4. POST /api/auth/sync-user with businessEmail to create/update the MongoDB business profile.
router.post('/sync-user', firebaseAuth, async (req, res, next) => {
  try {
    const firebaseProfile = buildFirebaseProfile(req.firebaseUser);

    if (!firebaseProfile.email) {
      return res.status(400).json({
        success: false,
        message: 'Firebase user must have an email address'
      });
    }

    const now = new Date();
    const update = {
      ...firebaseProfile,
      ...getBusinessEmailUpdate(req.body.businessEmail),
      lastLoginAt: now,
      lastActivityAt: now,
      onlineStatus: 'online'
    };

    const user = await User.findOneAndUpdate(
      { firebaseUid: firebaseProfile.firebaseUid },
      {
        $set: update,
        $setOnInsert: {
          role: 'representative',
          status: 'pending'
        }
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    return res.status(200).json({
      success: true,
      message: 'User synced successfully',
      token: req.firebaseToken,
      tokenType: 'Firebase ID token',
      data: user
    });
  } catch (error) {
    return next(error);
  }
});

// Backend Email/Password registration.
// This is separate from Firebase and uses businessEmail as the primary login email.
router.post('/register', async (req, res, next) => {
  try {
    const { businessEmail, password, fullName, displayName, userName, phone } = req.body;

    if (!businessEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'businessEmail and password are required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters'
      });
    }

    const normalizedBusinessEmail = String(businessEmail).toLowerCase().trim();
    const existingUser = await User.findOne({ businessEmail: normalizedBusinessEmail });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Business email already exists'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const user = await User.create({
      businessEmail: normalizedBusinessEmail,
      email: normalizedBusinessEmail,
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

// Backend Email/Password login.
router.post('/login', async (req, res, next) => {
  try {
    const { businessEmail, password } = req.body;

    if (!businessEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'businessEmail and password are required'
      });
    }

    const normalizedBusinessEmail = String(businessEmail).toLowerCase().trim();
    const user = await User.findOne({ businessEmail: normalizedBusinessEmail }).select('+passwordHash');

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        success: false,
        message: 'Invalid business email or password'
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: 'Invalid business email or password'
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

router.get('/me-password', backendAuth, async (req, res, next) => {
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

// Postman test:
// Send Authorization: Bearer <firebaseIdToken> to return the synced MongoDB profile.
router.get('/me', firebaseAuth, async (req, res, next) => {
  try {
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.firebaseUser.uid },
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
        message: 'User profile not found. Call POST /api/auth/sync-user first.'
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
