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

### GET /api/app-main-details

Returns public app metadata for branding, app checks, links, and feature flags. The backend creates the default document in the `appMainDetails` collection if it does not exist yet.

Success:

```json
{
  "success": true,
  "message": "App main details fetched successfully",
  "data": {
    "appName": "AeroPlan",
    "appTagline": "Medical field planning and team execution",
    "websiteURL": "https://aeroplan.app",
    "logo": "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779485968/icon_opc5om.png",
    "appWhiteLogo": "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779485925/logo_white_gmtwl5.png",
    "favIcon": "https://res.cloudinary.com/dt3u7d1tv/image/upload/v1779485967/favicon_bmj72h.png",
    "colors": {
      "backgroundColor": "#F7F9FC",
      "surface": "#ffffff",
      "surfaceSoft": "#f3f7ff",
      "primary": "#0f6fff",
      "primaryDark": "#0757d7",
      "primaryLight": "#dbeaff",
      "secondary": "#6b46ff",
      "success": "#18c287",
      "warning": "#f6a900",
      "danger": "#ef4444",
      "textPrimary": "#07122f",
      "textSecondary": "#536179",
      "textMuted": "#8b97aa",
      "border": "#dfe7f3",
      "inputBackground": "#ffffff",
      "shadow": "#b2b6",
      "white": "#ffffff",
      "black": "#000000"
    },
    "appVersion": "1.0.0",
    "minimumSupportedVersion": "1.0.0",
    "forceUpdateVersion": "",
    "maintenanceMode": false,
    "maintenanceMessage": "",
    "supportEmail": "support@aeroplan.app",
    "links": {
      "privacyPolicyURL": "https://aeroplan.app/privacy",
      "termsURL": "https://aeroplan.app/terms",
      "supportURL": "https://aeroplan.app/support"
    },
    "featureFlags": {
      "accountSelection": true,
      "accountDuplicateChecks": true
    },
    "lastUpdated": "2026-05-23T00:00:00.000Z"
  }
}
```

### POST /api/app-main-details

Admin-only endpoint for future dashboard edits. Creates or updates the main app metadata document. The same edit behavior is also available as `PUT /api/app-main-details` and `PATCH /api/app-main-details`.

Headers:

```http
Authorization: Bearer <admin-token>
Content-Type: application/json
```

Body can include any editable app metadata fields, for example:

```json
{
  "websiteURL": "https://aeroplan.app",
  "maintenanceMode": false,
  "appVersion": "1.0.1"
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
  "accountType": "hospital",
  "keyContact": "Dr. Ahmed Hassan",
  "contactPersonEmail": "ahmed.hassan@example.com",
  "phoneNumber": "+971500000000",
  "area": "Dubai Marina",
  "territory": "Dubai",
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
GET /api/accounts?territory=Dubai&area=Dubai Marina
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
      "contactPersonEmail": "ahmed.hassan@example.com",
      "phoneNumber": "+971500000000",
      "area": "Dubai Marina",
      "territory": "Dubai",
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

### POST /api/accounts/bulk

Creates many accounts from an array, such as rows parsed from an Excel file on the frontend. The backend validates each row, applies duplicate checks, creates valid accounts, and returns a summary instead of requiring the frontend to call `POST /api/accounts` once per row.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Preferred body:

```json
{
  "accounts": [
    {
      "accountName": "City Hospital",
      "accountType": "hospital",
      "keyContact": "Dr. Ahmed Hassan",
      "contactPersonEmail": "ahmed.hassan@example.com",
      "phoneNumber": "+971500000000",
      "area": "Dubai Marina",
      "territory": "Dubai",
      "location": {
        "address": "Dubai Healthcare City, Dubai",
        "googleMapsLink": "https://maps.app.goo.gl/example"
      }
    }
  ]
}
```

A raw array is also accepted:

```json
[
  {
    "accountName": "City Hospital",
    "accountType": "hospital"
  }
]
```

Success:

```json
{
  "success": true,
  "message": "Bulk accounts import completed",
  "data": {
    "total": 10,
    "createdCount": 8,
    "failedCount": 2,
    "createdAccountIds": ["account-id-1"],
    "createdAccounts": [],
    "failed": [
      {
        "index": 3,
        "accountName": "Duplicate Hospital",
        "reason": "Account already exists",
        "duplicateAccountId": "existing-account-id",
        "matchedOn": "googleMapsLink"
      }
    ]
  }
}
```

Maximum rows per request: `500`.

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

### PATCH /api/accounts/assign-rep-bulk

Assigns one medical rep to many accounts. Uses `$addToSet`, so the rep id is not duplicated if already assigned.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "accountIds": ["account-id-1", "account-id-2"],
  "medicalRepId": "rep-user-id"
}
```

`medicalRepId` can be omitted to assign the logged-in user.

Success:

```json
{
  "success": true,
  "message": "Medical rep assigned to accounts successfully",
  "data": {
    "updatedAccountIds": ["account-id-1", "account-id-2"],
    "failed": [],
    "updatedAccounts": []
  }
}
```

### PATCH /api/accounts/bulk

Generic bulk wrapper for the same assignment behavior.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "accountIds": ["account-id-1", "account-id-2"],
  "update": {
    "addAssignedMedicalRepId": "rep-user-id"
  }
}
```

### PATCH /api/accounts/:id/unselect-for-visit

Removes the logged-in user from `assignedMedicalRepIds`.

Headers:

```http
Authorization: Bearer <token>
```

### PUT /api/accounts/:id

Updates an account with the full editable payload. `accountName` and `accountType` are required. `accountType` must be one of `clinic`, `hospital`, `pharmacy`, or `other`.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

### POST /api/products

Creates a product. Products belong to a line and use `productNickname` instead of product code.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Manager/admin only.

Body:

```json
{
  "productName": "Aerocef 1g",
  "productNickname": "AEROCEF-1G",
  "description": "Injectable antibiotic",
  "lineId": "ANTI-INFECTIVE",
  "imageUrl": "https://example.com/product.png",
  "status": "active",
  "isActive": true,
  "prices": {
    "direct": {
      "cifUsd": 10,
      "wholesaleAed": 45,
      "retailAed": 60
    },
    "upp": {
      "cifUsd": 11,
      "wholesaleAed": 48,
      "retailAed": 64
    },
    "institutional": {
      "cifUsd": 9,
      "wholesaleAed": 40,
      "retailAed": 55
    }
  },
  "defaultFoc": {
    "direct": {
      "percentage": 5,
      "notes": "Default direct FOC"
    },
    "upp": {
      "percentage": 3,
      "notes": "Default UPP FOC"
    },
    "institutional": {
      "percentage": 10,
      "notes": "Default institutional FOC"
    }
  }
}
```

Required fields:

```text
productName
productNickname
lineId
```

Channel keys must be exactly:

```text
direct
upp
institutional
```

Prices default to `0`. FOC `percentage` must be a number greater than or equal to `0`.

### GET /api/products

Lists products with pagination and filters. Managers/admins can list active and inactive products. Representatives only receive active products.

Headers:

```http
Authorization: Bearer <token>
```

Query examples:

```text
GET /api/products
GET /api/products?page=1&limit=20
GET /api/products?search=aerocef
GET /api/products?status=active
GET /api/products?lineId=ANTI-INFECTIVE
GET /api/products?channel=direct&channelAvailable=true
```

Success:

```json
{
  "success": true,
  "message": "Products fetched successfully",
  "data": [
    {
      "_id": "product-id",
      "productName": "Aerocef 1g",
      "productNickname": "AEROCEF-1G",
      "lineId": "ANTI-INFECTIVE",
      "lineName": "Anti Infective",
      "status": "active",
      "isActive": true,
      "prices": {
        "direct": {
          "cifUsd": 10,
          "wholesaleAed": 45,
          "retailAed": 60
        },
        "upp": {
          "cifUsd": 11,
          "wholesaleAed": 48,
          "retailAed": 64
        },
        "institutional": {
          "cifUsd": 9,
          "wholesaleAed": 40,
          "retailAed": 55
        }
      },
      "defaultFoc": {
        "direct": {
          "percentage": 5,
          "notes": "Default direct FOC"
        },
        "upp": {
          "percentage": 3,
          "notes": "Default UPP FOC"
        },
        "institutional": {
          "percentage": 10,
          "notes": "Default institutional FOC"
        }
      },
      "createdAt": "2026-05-24T00:00:00.000Z",
      "updatedAt": "2026-05-24T00:00:00.000Z"
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

### GET /api/products/:id

Returns one product. Representatives can only fetch active products.

Headers:

```http
Authorization: Bearer <token>
```

### POST /api/products/bulk

Creates many products from an array, such as rows parsed from Excel on the frontend. `imageUrl` is optional. The backend validates each row, checks `productNickname` uniqueness, creates valid products, and returns created/failed summary.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Manager/admin only.

Preferred body:

```json
{
  "products": [
    {
      "productName": "Aerocef 1g",
      "productNickname": "AEROCEF-1G",
      "description": "Injectable antibiotic",
      "lineId": "ANTI-INFECTIVE",
      "imageUrl": "https://example.com/product.png",
      "prices": {
        "direct": {
          "cifUsd": 10,
          "wholesaleAed": 45,
          "retailAed": 60
        },
        "upp": {
          "cifUsd": 11,
          "wholesaleAed": 48,
          "retailAed": 64
        },
        "institutional": {
          "cifUsd": 9,
          "wholesaleAed": 40,
          "retailAed": 55
        }
      },
      "defaultFoc": {
        "direct": {
          "percentage": 5,
          "notes": "Default direct FOC"
        },
        "upp": {
          "percentage": 3,
          "notes": "Default UPP FOC"
        },
        "institutional": {
          "percentage": 10,
          "notes": "Default institutional FOC"
        }
      }
    }
  ]
}
```

A raw array is also accepted:

```json
[
  {
    "productName": "Aerocef 1g",
    "productNickname": "AEROCEF-1G",
    "lineId": "ANTI-INFECTIVE"
  }
]
```

Success:

```json
{
  "success": true,
  "message": "Bulk products import completed",
  "data": {
    "total": 10,
    "createdCount": 8,
    "failedCount": 2,
    "createdProductIds": ["product-id-1"],
    "createdProducts": [],
    "failed": [
      {
        "index": 3,
        "productName": "Aerocef 1g",
        "productNickname": "AEROCEF-1G",
        "reason": "Product nickname already exists",
        "duplicateProductId": "existing-product-id"
      }
    ]
  }
}
```

Maximum rows per request: `500`.

### PATCH /api/products/:id

Updates product details. Manager/admin only. Partial nested price and FOC updates are supported without replacing other channels.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Example:

```json
{
  "productName": "Aerocef 1g Vial",
  "prices": {
    "direct": {
      "retailAed": 62
    }
  },
  "defaultFoc": {
    "direct": {
      "percentage": 6,
      "notes": "Updated direct FOC"
    }
  }
}
```

### PATCH /api/products/:id/status

Activates or deactivates a product. Manager/admin only.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "status": "inactive"
}
```

or:

```json
{
  "isActive": false
}
```

### DELETE /api/products/:id

Soft deletes a product by setting `status: inactive` and `isActive: false`. Manager/admin only.

Headers:

```http
Authorization: Bearer <token>
```

### POST /api/foc-overrides

Creates account-level FOC override entries. One account can have many entries, each linked to a product with its own override percentage and optional notes. The validity dates apply to the whole account override set.

Headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "accountId": "account-id",
  "startDate": "2026-06-01T00:00:00.000Z",
  "endDate": "2026-06-30T23:59:59.999Z",
  "overrides": [
    {
      "productId": "product-id-1",
      "overridePercentage": 12.5,
      "notes": "Ramadan campaign override"
    },
    {
      "productId": "product-id-2",
      "overridePercentage": 8
    }
  ]
}
```

`entries` can be used instead of `overrides`. Date aliases `validFrom`/`validTo`, `fromDate`/`toDate`, and `validityStartDate`/`validityEndDate` are accepted for frontend compatibility, but `startDate` and `endDate` are preferred. `POST /api/foc-overrides` creates or replaces the full override set for the account. To append entries when the account id is already in the URL, use `POST /api/foc-overrides/:accountId/entries`. If the account does not already have an override document, this append endpoint also requires validity dates.

### GET /api/foc-overrides

Lists FOC override documents with pagination. Optional filters: `accountId` and `productId`.

### GET /api/foc-overrides/:accountId

Returns all FOC override entries for one account.

### PATCH /api/foc-overrides/:accountId

Replaces the full validity window and override entry array for one account. The request body uses the same `startDate`, `endDate`, and `overrides` or `entries` array shape as create.

### PATCH /api/foc-overrides/:accountId/entries/:entryId

Updates one override entry. Any of `productId`, `overridePercentage`, or `notes` can be sent.

### DELETE /api/foc-overrides/:accountId

Deletes all FOC overrides for one account.

### DELETE /api/foc-overrides/:accountId/entries/:entryId

Deletes one override entry from the account.

### POST /api/sales-team

Creates a sales team member. Sales team members are company salespeople used for account assignment and future order email CC; they are not required to be AeroPlan app users.

Headers:

```http
Authorization: Bearer <manager-or-admin-token>
Content-Type: application/json
```

Manager/admin only.

Body:

```json
{
  "fullName": "Ahmed Sales",
  "phone": "+971500000000",
  "email": "ahmed.sales@example.com",
  "position": "Salesman",
  "accountIds": ["account-id-1", "account-id-2"],
  "managerId": "sales-manager-id",
  "notes": "Handles Abu Dhabi private accounts",
  "status": "active",
  "isActive": true
}
```

KAM / manager body:

```json
{
  "fullName": "Yehya KAM",
  "phone": "+971500000001",
  "email": "yehya.kam@example.com",
  "position": "KAM",
  "teamManaged": ["salesman-id-1", "salesman-id-2"],
  "status": "active",
  "isActive": true
}
```

### GET /api/sales-team

Lists sales team members with pagination.

Query examples:

```text
GET /api/sales-team
GET /api/sales-team?page=1&limit=20
GET /api/sales-team?search=ahmed
GET /api/sales-team?status=active
GET /api/sales-team?isActive=true
GET /api/sales-team?position=KAM
GET /api/sales-team?accountId=account-id
GET /api/sales-team?managerId=sales-manager-id
```

Representatives only receive active sales team members. Managers/admins can filter active and inactive records.

### GET /api/sales-team/:id

Returns one sales team member. Representatives can only fetch active sales team members.

### GET /api/sales-team/account/:accountId

Returns active sales team members assigned to one account. This is intended for future order creation and email CC selection.

### PATCH /api/sales-team/:id

Updates a sales team member. Manager/admin only. Accepts any editable fields from the create body.

### PATCH /api/sales-team/:id/status

Activates or deactivates a sales team member. Manager/admin only.

Body:

```json
{
  "status": "inactive"
}
```

or:

```json
{
  "isActive": false
}
```

### DELETE /api/sales-team/:id

Soft deletes a sales team member by setting `status: inactive` and `isActive: false`. Manager/admin only.

### Account Sales Team Linking

Accounts now optionally accept assigned sales team members:

```json
{
  "salesTeamIds": ["sales-team-member-id-1", "sales-team-member-id-2"]
}
```

This field is supported by account create, partial update, full update, and bulk import. When provided, every id must be an active sales team member. Account responses populate `salesTeamIds` with `fullName`, `email`, `phone`, `position`, `status`, `isActive`, and `managerId`. The backend also syncs the account id into each selected `SalesTeamMember.accountIds`, so sales team member profiles and `GET /api/sales-team/account/:accountId` reflect assignments made from account forms. Editing `accountIds` on a sales team member also syncs back to each account's `salesTeamIds`.

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
