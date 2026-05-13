const admin = require('firebase-admin');

const formatPrivateKey = (privateKey) => {
  return privateKey ? privateKey.replace(/\\n/g, '\n') : undefined;
};

const hasServiceAccountEnv = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
);

if (!admin.apps.length) {
  if (hasServiceAccountEnv) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: formatPrivateKey(process.env.FIREBASE_PRIVATE_KEY)
      })
    });
  } else if (process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID
    });
  } else {
    admin.initializeApp();
  }
}

module.exports = admin;
