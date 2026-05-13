const express = require('express');
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
