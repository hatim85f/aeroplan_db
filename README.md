# AeroPlan Backend

MongoDB stores the user profile, email, manager hierarchy, team structure, assigned items, snapshots, and app data.

Authentication is handled by the backend with `email` and `password`. Raw passwords are never stored in MongoDB; only `passwordHash` is stored and hidden from API responses.

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
JWT_SECRET=
```

## Auth Flow

1. Register with `POST /api/auth/register`.
2. Login with `POST /api/auth/login`.
3. Use the returned token as `Authorization: Bearer <token>`.
4. Call `GET /api/auth/me`.

The returned token is a backend JWT and expires in 7 days.

Managers and senior managers are represented with:

```js
managerId
path
```

`managerId` is the direct manager. `path` stores all managers above the user, so a future senior manager can access everyone below them without redesigning the database.

Every user also gets a shareable `appId`, such as `AP-123456`. A representative can share this with a manager, and the manager can use it to send a team invitation.

## Postman Setup

Set an environment variable named `token`, then add this header for protected routes:

```http
Authorization: Bearer {{token}}
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

### POST /api/auth/register

Email/Password registration.

Body:

```json
{
  "email": "rep@company.com",
  "password": "StrongPass123",
  "fullName": "Sales Rep",
  "phone": "+971500000000",
  "role": "representative",
  "managerId": "manager-user-id"
}
```

Success:

```json
{
  "success": true,
  "message": "User registered successfully",
  "token": "backend-jwt-token",
  "tokenType": "Backend JWT",
  "expiresIn": "7d",
  "data": {
    "_id": "mongo-user-id",
    "email": "rep@company.com",
    "managerId": "manager-user-id",
    "path": ["senior-manager-id", "manager-user-id"],
    "authProviders": ["password"],
    "role": "representative",
    "status": "pending",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:00:00.000Z"
  }
}
```

### POST /api/auth/login

Email/Password login.

Body:

```json
{
  "email": "rep@company.com",
  "password": "StrongPass123"
}
```

Success:

```json
{
  "success": true,
  "message": "User logged in successfully",
  "token": "backend-jwt-token",
  "tokenType": "Backend JWT",
  "expiresIn": "7d",
  "data": {
    "_id": "mongo-user-id",
    "email": "rep@company.com",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:00:00.000Z"
  }
}
```

### GET /api/auth/me

Protected by the backend token returned from register/login.

Headers:

```http
Authorization: Bearer <token>
```

Success:

```json
{
  "success": true,
  "message": "User profile fetched successfully",
  "data": {
    "_id": "mongo-user-id",
    "email": "rep@company.com",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:00:00.000Z"
  }
}
```

### POST /api/notifications/register-token

Stores an Expo push token for the logged-in user. One user can have many device tokens.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "platform": "ios",
  "deviceId": "device-123"
}
```

### DELETE /api/notifications/remove-token

Removes one Expo push token or one device token registration.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
}
```

or:

```json
{
  "deviceId": "device-123"
}
```

### GET /api/notifications

Returns the logged-in user's notifications.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/notifications/:id/open

Marks a notification as opened for the logged-in user.

Headers:

```http
Authorization: Bearer <token>
```

### POST /api/notifications/send

Creates one notification document per recipient and sends Expo push notifications to every stored token for each recipient. The frontend only sends notification details and recipient id(s); the backend handles storage and push delivery.

Headers:

```http
Authorization: Bearer <token>
```

Body for one recipient:

```json
{
  "to": "recipientUserId",
  "title": "New Task",
  "subtitle": "You have a new task",
  "routeName": "TaskDetails",
  "payload": {
    "taskId": "task-id"
  }
}
```

### POST /api/teams

Creates a team for the logged-in manager.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "teamName": "Dubai Team A",
  "logo": "https://example.com/logo.png",
  "details": "Primary cardiology team",
  "lineId": "cardio",
  "territory": "Dubai"
}
```

### GET /api/teams/my-teams

Returns teams owned by the logged-in manager, or teams where the logged-in representative is a member.

Headers:

```http
Authorization: Bearer <token>
```

### GET /api/teams/:id

Returns one team if the logged-in user is the manager or a member.

Headers:

```http
Authorization: Bearer <token>
```

### POST /api/team-invitations

Manager sends a team invitation to a user by `appId`. The backend creates the invitation and sends a notification to the invited user with `routeName: "TeamInvitations"`.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "appId": "AP-123456",
  "teamId": "team-id",
  "message": "Please join Dubai Team A"
}
```

Optional:

```json
{
  "expiresAt": "2026-06-01T00:00:00.000Z"
}
```

### GET /api/team-invitations

Returns team invitations for the logged-in user.

Headers:

```http
Authorization: Bearer <token>
```

Query examples:

```text
GET /api/team-invitations
GET /api/team-invitations?status=pending
GET /api/team-invitations?box=sent
GET /api/team-invitations?box=sent&status=pending
```

### PATCH /api/team-invitations/:id/accept

Accepts a pending invitation. The backend links the user to the selected team, sets `managerId`, rebuilds `path`, and adds the user to the team members list.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/team-invitations/:id/reject

Rejects a pending invitation.

Headers:

```http
Authorization: Bearer <token>
```

Body for many recipients:

```json
{
  "to": ["recipientUserId1", "recipientUserId2"],
  "title": "Target Updated",
  "subtitle": "Your monthly target has been updated",
  "routeName": "Targets",
  "payload": {
    "targetYear": 2026
  }
}
```

Error examples:

```json
{
  "success": false,
  "message": "email and password are required"
}
```

```json
{
  "success": false,
  "message": "Invalid email or password"
}
```

```json
{
  "success": false,
  "message": "Invalid or expired backend token"
}
```

## Production Deployment

This backend is deployable on Render, Railway, and Heroku.

Use:

```text
npm start
```

Set production environment variables in the platform dashboard. Do not commit `.env` files.
