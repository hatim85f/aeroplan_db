# AeroPlan Backend

Firebase handles signup and login. MongoDB stores the business user profile, business email, role, team structure, assigned items, snapshots, and app data.

No raw password is stored in MongoDB. JWT is not used for backend authentication. Google and Email/Password login both happen through Firebase Authentication, and both flows provide a Firebase ID token. The Firebase email is stored as the auth identity email; the app should use `businessEmail` for business workflows.

## Local Setup

```powershell
npm install
npm run server
```

## Environment Variables

Create `.env` locally or configure these on Render, Railway, or Heroku:

```env
PORT=5000
MONGO_URI=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

For `FIREBASE_PRIVATE_KEY`, keep escaped newlines as `\n` when storing it as one environment variable.

## Firebase Token Flow

1. User logs in or signs up on the frontend using Firebase Google or Email/Password.
2. Frontend gets the Firebase ID token from the logged-in Firebase user.
3. Frontend sends the token to this backend:

```http
Authorization: Bearer <firebaseIdToken>
```

4. Call `POST /api/auth/sync-user` with `businessEmail` to create/update the MongoDB profile.
5. Call `GET /api/auth/me` to fetch the MongoDB profile.

The backend verifies the Firebase ID token and returns the synced MongoDB user profile. `sync-user` also echoes the verified Firebase ID token as `token` so API clients can keep a consistent token response shape; it is not a backend JWT.

## Postman Setup

Set an environment variable named `firebaseIdToken`, then add this header:

```http
Authorization: Bearer {{firebaseIdToken}}
Content-Type: application/json
```

## Endpoints

### GET /api/health

Checks whether the API is running.

Success:

```json
{
  "success": true,
  "message": "AeroPlan API running"
}
```

### POST /api/auth/sync-user

Protected by Firebase ID token. Creates or updates the MongoDB business user profile.

Headers:

```http
Authorization: Bearer <firebaseIdToken>
Content-Type: application/json
```

Body:

```json
{
  "businessEmail": "rep@company.com"
}
```

Success:

```json
{
  "success": true,
  "message": "User synced successfully",
  "token": "firebase-id-token",
  "tokenType": "Firebase ID token",
  "data": {
    "_id": "mongo-user-id",
    "firebaseUid": "firebase-uid",
    "email": "google-or-firebase-auth-email@example.com",
    "businessEmail": "rep@company.com",
    "emailVerified": true,
    "authProviders": ["google"],
    "role": "representative",
    "status": "pending",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:00:00.000Z"
  }
}
```

### GET /api/auth/me

Protected by Firebase ID token. Returns the synced MongoDB business user profile and updates `lastActivityAt`.

Headers:

```http
Authorization: Bearer <firebaseIdToken>
```

Success:

```json
{
  "success": true,
  "message": "User profile fetched successfully",
  "data": {
    "_id": "mongo-user-id",
    "firebaseUid": "firebase-uid",
    "email": "google-or-firebase-auth-email@example.com",
    "businessEmail": "rep@company.com",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:00:00.000Z"
  }
}
```

Error examples:

```json
{
  "success": false,
  "message": "Authorization header must be: Bearer <firebaseIdToken>"
}
```

```json
{
  "success": false,
  "message": "Invalid or expired Firebase ID token"
}
```

## Production Deployment

This backend is deployable on Render, Railway, and Heroku.

Use:

```text
npm start
```

Set production environment variables in the platform dashboard. Do not commit `.env` files.
