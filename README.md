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
2. Verify the signup code with `POST /auth/verify-account` or `POST /api/auth/verify-account`.
3. Login with `POST /api/auth/login`.
4. Use the returned token as `Authorization: Bearer <token>`.
5. Call `GET /api/auth/me`.

The returned token is a backend JWT and expires in 7 days.

Auth routes are available under both `/api/auth` and `/auth`.

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

In non-production environments, registration responses include `verificationCode` so the mobile app can be tested before an email provider is connected. In production, only the hashed expiring code is stored.

`managerAppId` is optional. If provided, it must be the manager user's shareable `appId` such as `AP-123456`. The backend resolves it, updates `managerId`, and rebuilds the hierarchy `path`. The response returns populated `managerId` details.

### POST /auth/verify-account

Verifies the 6-digit code after signup. Also available at `POST /api/auth/verify-account`.

Body:

```json
{
  "email": "rep@company.com",
  "code": "123456"
}
```

Success:

```json
{
  "success": true,
  "message": "Account verified successfully",
  "token": "backend-jwt-token",
  "tokenType": "Backend JWT",
  "expiresIn": "7d",
  "data": {
    "_id": "mongo-user-id",
    "email": "rep@company.com",
    "emailVerified": true,
    "status": "active"
  }
}
```

### POST /auth/resend-verification-code

Resends the signup verification code. Also available at `POST /api/auth/resend-verification-code`.

Body:

```json
{
  "email": "rep@company.com"
}
```

Success:

```json
{
  "success": true,
  "message": "Verification code sent successfully"
}
```

In non-production environments, the response includes `verificationCode`.

### POST /auth/forgot-password

Generates a 6-digit password reset code for the account. Also available at `POST /api/auth/forgot-password`.

Body:

```json
{
  "email": "rep@company.com"
}
```

Success:

```json
{
  "success": true,
  "message": "Password reset instructions sent successfully"
}
```

If the email does not exist, the API still returns success with a generic message to avoid exposing registered email addresses. In non-production environments, the response includes `resetCode` when the user exists.

### POST /auth/reset-password

Resets the password inside the app using the 6-digit reset code. Also available at `POST /api/auth/reset-password`.

Body:

```json
{
  "email": "rep@company.com",
  "code": "123456",
  "password": "NewStrongPass123"
}
```

Success:

```json
{
  "success": true,
  "message": "Password reset successfully",
  "token": "backend-jwt-token",
  "tokenType": "Backend JWT",
  "expiresIn": "7d",
  "data": {
    "_id": "mongo-user-id",
    "email": "rep@company.com"
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

### PATCH /api/auth/me/profile

Updates the logged-in user's editable profile fields.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "fullName": "Sales Rep",
  "userName": "salesrep1",
  "profilePicture": "https://example.com/avatar.png",
  "phone": "+971500000000",
  "phoneE164": "+971500000000",
  "designation": "Medical Representative",
  "position": "Senior Medical Representative",
  "employeeCode": "EMP-001",
  "joinDate": "2026-05-15T00:00:00.000Z",
  "lineId": "cardio",
  "territory": "Dubai",
  "area": "Dubai Marina",
  "managerAppId": "AP-123456",
  "settings": {
    "language": "en",
    "themePreference": "system",
    "notificationsEnabled": true
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

Creates a team for the logged-in manager. The manager becomes `managerId` and `createdBy`. Use `lineId` from `/api/lines`; `lineName` is kept for display.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "teamName": "Dubai Team A",
  "teamLogo": "https://example.com/logo.png",
  "description": "Primary cardiology team",
  "lineId": "CARDIO",
  "lineName": "Cardiology",
  "territory": "Dubai",
  "area": "Dubai Marina",
  "visibility": "private"
}
```

Legacy `logo` and `details` are still accepted and mapped to `teamLogo` and `description`.

### GET /api/lines

Returns lines for the team creation dropdown. Each line also includes `numberOfTeams` and `numberOfMembers`.

Headers:

```http
Authorization: Bearer <token>
```

Query examples:

```text
GET /api/lines
GET /api/lines?isActive=true
GET /api/lines?teamIsActive=true
```

### GET /api/lines/summary

Returns the compact data needed for a lines page/card screen.

Headers:

```http
Authorization: Bearer <token>
```

Success:

```json
{
  "success": true,
  "message": "Line summary fetched successfully",
  "data": [
    {
      "lineId": "CARDIO",
      "lineName": "Cardiology",
      "lineLogo": "https://example.com/cardio.png",
      "numberOfTeams": 3,
      "numberOfMembers": 18
    }
  ]
}
```

For managers, counts are calculated from teams owned by the logged-in manager. Admins see counts across all teams.

### POST /api/lines

Manager creates a new line when it is not already in the dropdown.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "lineId": "CARDIO",
  "lineName": "Cardiology",
  "lineLogo": "https://example.com/cardio.png",
  "description": "Cardiology product line"
}
```

### GET /api/teams/my-teams

Returns teams owned by the logged-in manager, or teams where the logged-in representative is a member. Supports dashboard filters.

Headers:

```http
Authorization: Bearer <token>
```

Query examples:

```text
GET /api/teams/my-teams?lineId=CARDIO
GET /api/teams/my-teams?territory=Dubai&status=active
GET /api/teams/my-teams?visibility=private&isActive=true
```

### GET /api/teams/dashboard

Returns filtered team dashboard data and totals for owned/member teams.

Headers:

```http
Authorization: Bearer <token>
```

### GET /api/teams/:id

Returns one team if the logged-in user is the manager or a member. Includes pending invitations and permission flags.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/teams/:id

Manager updates one of their own teams.

Headers:

```http
Authorization: Bearer <token>
```

### GET /api/teams/:id/members

Returns accepted members only.

Success:

```json
{
  "success": true,
  "message": "Team members fetched successfully",
  "members": [
    {
      "_id": "rep-user-id",
      "fullName": "Ahmed Hassan",
      "userName": "ahmed.hassan",
      "appId": "AP-123456",
      "email": "ahmed@example.com",
      "phone": "+971...",
      "role": "representative",
      "profilePicture": "https://...",
      "territory": "Dubai",
      "area": "Dubai Marina",
      "lineId": "CARDIO",
      "lineName": "Cardiology",
      "managerId": "manager-id",
      "teamId": "team-id",
      "status": "active"
    }
  ],
  "data": [
    {
      "_id": "rep-user-id"
    }
  ]
}
```

### GET /api/teams/:id/invitations

Manager returns invitations for one owned team. Use `?status=pending` to filter.

### GET /api/teams/:id/hierarchy

Returns manager, members, and hierarchy path data.

### GET /api/teams/:id/targets

Returns member target fields for the team.

### GET /api/teams/:id/reports

Returns member performance and forecast snapshots for reports.

### GET /api/teams/:id/permissions

Returns UI permission flags such as `canManage`, `canInvite`, `canViewReports`, and `canViewTargets`.

### POST /api/team-invitations

Manager sends a team invitation to a representative by `appId`. The backend checks the appId exists, the user is a representative, the rep does not already belong to any team, the rep is not already in the team, no pending invitation exists, and the manager owns the team. If valid, it creates `TeamInvitation status=pending` and sends a notification to the rep with `routeName: "TeamInvitations"`.

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

Returns team invitations for the logged-in user. Reps use the default received box; managers can use `box=sent`.

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

Accepts a pending invitation. Only now does the backend set `rep.teamId`, `rep.managerId`, `rep.lineId`, rebuild `path`, add the rep to `team.members`, set invitation status to `accepted`, and notify the manager. If the rep already has a `teamId`, acceptance is blocked.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/team-invitations/:id/reject

Rejects a pending invitation. The backend does not update `teamId`, `managerId`, or `team.members`; it only sets invitation status to `rejected` and notifies the manager.

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
