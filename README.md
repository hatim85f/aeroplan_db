# AeroPlan Backend

MongoDB stores the business user profile, business email, role, team structure, assigned items, snapshots, and app data.

Authentication is handled by the backend with `businessEmail` and `password`. Raw passwords are never stored in MongoDB; only `passwordHash` is stored and hidden from API responses.

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

Email/Password registration using business email.

Body:

```json
{
  "businessEmail": "rep@company.com",
  "password": "StrongPass123",
  "fullName": "Sales Rep",
  "phone": "+971500000000"
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
    "businessEmail": "rep@company.com",
    "authProviders": ["password"],
    "role": "representative",
    "status": "pending",
    "createdAt": "2026-05-13T00:00:00.000Z",
    "updatedAt": "2026-05-13T00:00:00.000Z"
  }
}
```

### POST /api/auth/login

Email/Password login using business email.

Body:

```json
{
  "businessEmail": "rep@company.com",
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
    "businessEmail": "rep@company.com",
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
  "message": "businessEmail and password are required"
}
```

```json
{
  "success": false,
  "message": "Invalid business email or password"
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
