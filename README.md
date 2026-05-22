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

### POST /api/accounts

Creates an account. Protected by the backend JWT.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "accountName": "City Hospital",
  "keyContact": "Dr. Ahmed Hassan",
  "phoneNumber": "+971500000000",
  "location": {
    "address": "Dubai Healthcare City, Dubai",
    "googleMapsLink": "https://maps.app.goo.gl/example"
  },
  "userId": "rep-user-id",
  "lastPlannedVisit": {
    "planId": "visit-plan-id",
    "date": "2026-05-30T09:00:00.000Z"
  }
}
```

`assignedMedicalRepIds` is optional. Accounts can be created without any assigned medical rep so representatives can later select the accounts they plan to visit. For pre-assignment during create or update, the API accepts any of these shapes:

```json
{
  "userId": "rep-user-id"
}
```

```json
{
  "assignedMedicalRepId": "rep-user-id"
}
```

```json
{
  "assignedMedicalRepIds": ["rep-user-id-1", "rep-user-id-2"]
}
```

`location.googleMapsLink` is the preferred map field. Existing coordinate data is still stored if sent, but frontend account forms should use a Google Maps link instead of latitude and longitude inputs.

Duplicate account protection:

The API rejects duplicates with `409 Conflict`. It checks exact normalized `location.googleMapsLink` first, then falls back to `accountName + phoneNumber`, then `accountName + address`.

```json
{
  "success": false,
  "message": "Account already exists",
  "data": {
    "duplicateAccountId": "existing-account-id",
    "matchedOn": "googleMapsLink"
  }
}
```

Possible `matchedOn` values are `googleMapsLink`, `accountNamePhoneNumber`, and `accountNameAddress`.

### GET /api/accounts

Lists accounts with pagination. Protected by the backend JWT.

Query examples:

```text
GET /api/accounts
GET /api/accounts?page=1&limit=20
GET /api/accounts?search=hospital
GET /api/accounts?repId=rep-user-id
GET /api/accounts/my-visits
```

Success:

```json
{
  "success": true,
  "message": "Accounts fetched successfully",
  "data": [
    {
      "_id": "account-id",
      "accountName": "City Hospital",
      "keyContact": "Dr. Ahmed Hassan",
      "phoneNumber": "+971500000000",
      "location": {
        "address": "Dubai Healthcare City, Dubai",
        "googleMapsLink": "https://maps.app.goo.gl/example"
      },
      "assignedMedicalRepIds": [
        {
          "_id": "rep-user-id-1",
          "fullName": "Sales Rep",
          "email": "rep@example.com",
          "phone": "+971500000000",
          "appId": "AP-123456",
          "role": "representative",
          "status": "active"
        }
      ],
      "lastPlannedVisit": {
        "planId": "visit-plan-id",
        "date": "2026-05-30T09:00:00.000Z"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

### GET /api/accounts/:id

Returns one account by MongoDB id.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/accounts/:id

Partially updates an account. Send only changed fields.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

### PATCH /api/accounts/:id/select-for-visit

Adds the logged-in user to `assignedMedicalRepIds`, allowing a medical representative to select an account they plan to visit.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/accounts/:id/unselect-for-visit

Removes the logged-in user from `assignedMedicalRepIds`.

Headers:

```http
Authorization: Bearer <token>
```

### PUT /api/accounts/:id

Updates an account with the full editable payload. `accountName` is required.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
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

Creates a supervisor team for the logged-in manager. The manager becomes `managerId` and `createdBy`. Use `lineIds` from `/api/lines` to define which product lines this team can supervise. `lineId` can also be sent as an array for frontend compatibility. Legacy string `lineId` is still accepted for single-line teams. When lines are added to a team, the backend automatically adds eligible representatives whose `user.lineId` is in those lines to `team.members`, sets their `teamId`, `managerId`, and hierarchy `path`, and adds them to `line.members`. Representatives already assigned to another team are skipped.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "teamName": "Dubai Team A",
  "teamLogo": "https://example.com/logo.png",
  "description": "Dubai supervisor team",
  "lineId": ["CARDIO", "DIABETES"],
  "lineNames": ["Cardiology", "Diabetes"],
  "territory": "Dubai",
  "area": "Dubai Marina",
  "visibility": "private"
}
```

Preferred body also works:

```json
{
  "teamName": "Dubai Team A",
  "lineIds": ["CARDIO", "DIABETES"],
  "lineNames": ["Cardiology", "Diabetes"]
}
```

Legacy `logo` and `details` are still accepted and mapped to `teamLogo` and `description`.

Success responses include sync metadata:

```json
{
  "meta": {
    "autoAddedMembers": 12,
    "skippedAssignedMembers": 2
  }
}
```

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

Manager updates one of their own teams. Updating `lineIds` or array `lineId` also syncs eligible representatives under those lines into the team.

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

Manager sends a line invitation to a representative by `appId`. Send the representative's assigned `lineId`; no `teamId` is needed. The backend checks the appId exists, the line exists, the user is a representative, the rep is not already assigned to that line, and no pending invitation exists. If valid, it creates `TeamInvitation status=pending` with `lineId` and `lineName`, then sends a notification to the rep with `routeName: "TeamInvitations"`. Team membership is handled later when a manager creates or updates a team with matching `lineIds`.

Headers:

```http
Authorization: Bearer <token>
```

Body:

```json
{
  "appId": "AP-123456",
  "lineId": "CARDIO",
  "message": "Please join the Cardiology line"
}
```

Optional:

```json
{
  "expiresAt": "2026-06-01T00:00:00.000Z"
}
```

### GET /api/team-invitations

Returns line invitations for the logged-in user. Reps use the default received box; managers can use `box=sent`.

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

Accepts a pending line invitation. The backend sets `rep.lineId`, adds the rep to `line.members`, marks the invitation as accepted, and notifies the manager. It does not set `teamId`, `managerId`, or hierarchy `path`; those are wired later when a manager creates or updates a team with matching `lineIds`.

Headers:

```http
Authorization: Bearer <token>
```

### PATCH /api/team-invitations/:id/reject

Rejects a pending line invitation. The backend does not update `lineId` or team membership; it only sets invitation status to `rejected` and notifies the manager.

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
