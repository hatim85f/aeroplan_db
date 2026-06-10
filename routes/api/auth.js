const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const defaults = require("../../config/default.json");
const User = require("../../models/User");
const Team = require("../../models/Team");
const { createAppId } = require("../../helpers/appId");
const { isManagerRole } = require("../../helpers/roles");
const { repairHierarchyPaths } = require("../../helpers/hierarchy");

const router = express.Router();
const CODE_EXPIRY_MINUTES = 15;

const getJwtSecret = () => {
  return process.env.JWT_SECRET || process.env.jwtSecret || defaults.jwtSecret;
};

const createBackendToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      authProvider: "password",
    },
    getJwtSecret(),
    { expiresIn: "7d" },
  );
};

const sanitizeUser = (user) => {
  const userObject = user.toObject ? user.toObject() : user;
  delete userObject.passwordHash;
  delete userObject.verificationCodeHash;
  delete userObject.verificationCodeExpiresAt;
  delete userObject.verificationCodeSentAt;
  delete userObject.passwordResetCodeHash;
  delete userObject.passwordResetCodeExpiresAt;
  delete userObject.passwordResetCodeSentAt;
  return userObject;
};

const normalizeEmail = (email) => String(email || "").toLowerCase().trim();

const generateSixDigitCode = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

const hashCode = (code) => {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
};

const createCodePayload = () => {
  const code = generateSixDigitCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  return {
    code,
    codeHash: hashCode(code),
    expiresAt,
    sentAt: new Date(),
  };
};

const isValidSixDigitCode = (code) => /^\d{6}$/.test(String(code || ""));

const codeMatches = (code, codeHash) => {
  if (!codeHash) {
    return false;
  }

  const submittedHash = hashCode(code);
  const submitted = Buffer.from(submittedHash, "hex");
  const expected = Buffer.from(codeHash, "hex");

  return (
    submitted.length === expected.length &&
    crypto.timingSafeEqual(submitted, expected)
  );
};

const addDevelopmentCode = (response, codeName, code) => {
  if (process.env.NODE_ENV !== "production" && code) {
    response[codeName] = code;
  }

  return response;
};

const buildHierarchy = async (managerId) => {
  if (!managerId) {
    return {
      managerId: undefined,
      path: [],
    };
  }

  const manager = await User.findById(managerId);

  if (!manager) {
    const error = new Error("Manager not found");
    error.statusCode = 400;
    throw error;
  }

  return {
    managerId: manager._id,
    path: [...(manager.path || []), manager._id],
  };
};

const buildHierarchyByAppId = async (managerAppId, currentUserId) => {
  const normalizedManagerAppId = String(managerAppId).trim().toUpperCase();
  const manager = await User.findOne({ appId: normalizedManagerAppId });

  if (!manager) {
    const error = new Error("Manager appId not found");
    error.statusCode = 400;
    throw error;
  }

  if (String(manager._id) === String(currentUserId)) {
    const error = new Error("You cannot assign yourself as manager");
    error.statusCode = 400;
    throw error;
  }

  if (!isManagerRole(manager.role)) {
    const error = new Error("The provided appId does not belong to a manager");
    error.statusCode = 400;
    throw error;
  }

  return {
    managerId: manager._id,
    path: [...(manager.path || []), manager._id],
  };
};

const findUserProfileById = (userId) => {
  return User.findById(userId)
    .populate("managerId", "fullName email appId role profilePicture position territory area")
    .populate("teamId", "teamName teamCode teamLogo description territory area lineId lineName");
};

const buildUserProfile = async (user) => {
  const profile = sanitizeUser(user);
  const manager = profile.managerId;

  profile.managerName = manager ? manager.fullName || manager.email || "" : null;
  profile.managerEmail = manager ? manager.email || null : null;
  profile.managerAppId = manager ? manager.appId || null : null;
  delete profile.managerId;

  if (isManagerRole(profile.role)) {
    delete profile.teamId;
    profile.teamName = null;
    profile.teamsCount = await Team.countDocuments({ managerId: profile._id });
  } else {
    const team = profile.teamId;
    profile.teamName = team ? team.teamName || "" : null;
    delete profile.teamId;
    profile.teamsCount = team ? 1 : 0;
  }

  return profile;
};

const createUniqueAppId = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const appId = createAppId();
    const existingUser = await User.exists({ appId });

    if (!existingUser) {
      return appId;
    }
  }

  throw new Error("Could not generate unique app ID");
};

const backendAuth = async (req, res, next) => {
  const authHeader = req.header("Authorization");
  const token =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authorization header must be: Bearer <backendToken>",
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.backendUser = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired backend token",
    });
  }
};

// Email/Password registration using email as the primary login identity.
router.post("/register", async (req, res, next) => {
  try {
    const { email, password, fullName, userName, phone, role, managerId } =
      req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "email and password are required",
      });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    const hierarchy = await buildHierarchy(managerId);
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const verification = createCodePayload();
    const user = await User.create({
      email: normalizedEmail,
      appId: await createUniqueAppId(),
      passwordHash,
      verificationCodeHash: verification.codeHash,
      verificationCodeExpiresAt: verification.expiresAt,
      verificationCodeSentAt: verification.sentAt,
      authProviders: ["password"],
      fullName,
      userName,
      phone,
      role: role || "representative",
      managerId: hierarchy.managerId,
      path: hierarchy.path,
      status: "pending",
      lastLoginAt: now,
      lastActivityAt: now,
      onlineStatus: "online",
    });

    return res.status(201).json(addDevelopmentCode({
      success: true,
      message: "User registered successfully. Verification code sent.",
      token: createBackendToken(user),
      tokenType: "Backend JWT",
      expiresIn: "7d",
      data: sanitizeUser(user),
    }, "verificationCode", verification.code));
  } catch (error) {
    return next(error);
  }
});

router.post("/verify-account", async (req, res, next) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: "email and code are required",
      });
    }

    if (!isValidSixDigitCode(code)) {
      return res.status(400).json({
        success: false,
        message: "code must be 6 digits",
      });
    }

    const user = await User.findOne({ email: normalizeEmail(email) }).select(
      "+verificationCodeHash +verificationCodeExpiresAt",
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid email or verification code",
      });
    }

    if (user.emailVerified) {
      return res.status(200).json({
        success: true,
        message: "Account already verified",
        token: createBackendToken(user),
        tokenType: "Backend JWT",
        expiresIn: "7d",
        data: sanitizeUser(user),
      });
    }

    if (
      !codeMatches(code, user.verificationCodeHash) ||
      !user.verificationCodeExpiresAt ||
      user.verificationCodeExpiresAt.getTime() < Date.now()
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification code",
      });
    }

    user.emailVerified = true;
    user.status = user.status === "pending" ? "active" : user.status;
    user.verificationCodeHash = undefined;
    user.verificationCodeExpiresAt = undefined;
    user.verificationCodeSentAt = undefined;
    user.lastActivityAt = new Date();
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Account verified successfully",
      token: createBackendToken(user),
      tokenType: "Backend JWT",
      expiresIn: "7d",
      data: sanitizeUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/resend-verification-code", async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "email is required",
      });
    }

    const user = await User.findOne({ email: normalizeEmail(email) }).select(
      "+verificationCodeHash +verificationCodeExpiresAt +verificationCodeSentAt",
    );

    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an unverified account exists, a verification code has been sent.",
      });
    }

    if (user.emailVerified) {
      return res.status(400).json({
        success: false,
        message: "Account already verified",
      });
    }

    const verification = createCodePayload();
    user.verificationCodeHash = verification.codeHash;
    user.verificationCodeExpiresAt = verification.expiresAt;
    user.verificationCodeSentAt = verification.sentAt;
    await user.save();

    return res.status(200).json(addDevelopmentCode({
      success: true,
      message: "Verification code sent successfully",
    }, "verificationCode", verification.code));
  } catch (error) {
    return next(error);
  }
});

router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "email is required",
      });
    }

    const user = await User.findOne({ email: normalizeEmail(email) }).select(
      "+passwordResetCodeHash +passwordResetCodeExpiresAt +passwordResetCodeSentAt",
    );

    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If the email exists, password reset instructions have been sent.",
      });
    }

    const reset = createCodePayload();
    user.passwordResetCodeHash = reset.codeHash;
    user.passwordResetCodeExpiresAt = reset.expiresAt;
    user.passwordResetCodeSentAt = reset.sentAt;
    await user.save();

    return res.status(200).json(addDevelopmentCode({
      success: true,
      message: "Password reset instructions sent successfully",
    }, "resetCode", reset.code));
  } catch (error) {
    return next(error);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const { email, code, password } = req.body;

    if (!email || !code || !password) {
      return res.status(400).json({
        success: false,
        message: "email, code and password are required",
      });
    }

    if (!isValidSixDigitCode(code)) {
      return res.status(400).json({
        success: false,
        message: "code must be 6 digits",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const user = await User.findOne({ email: normalizeEmail(email) }).select(
      "+passwordHash +passwordResetCodeHash +passwordResetCodeExpiresAt",
    );

    if (
      !user ||
      !codeMatches(code, user.passwordResetCodeHash) ||
      !user.passwordResetCodeExpiresAt ||
      user.passwordResetCodeExpiresAt.getTime() < Date.now()
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset code",
      });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.passwordResetCodeHash = undefined;
    user.passwordResetCodeExpiresAt = undefined;
    user.passwordResetCodeSentAt = undefined;
    if (!Array.isArray(user.authProviders)) {
      user.authProviders = [];
    }
    if (!user.authProviders.includes("password")) {
      user.authProviders.push("password");
    }
    user.lastActivityAt = new Date();
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successfully",
      token: createBackendToken(user),
      tokenType: "Backend JWT",
      expiresIn: "7d",
      data: sanitizeUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

// Email/Password login.
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "email and password are required",
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const user = await User.findOne({ email: normalizedEmail }).select(
      "+passwordHash",
    );

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    user.lastLoginAt = new Date();
    user.lastActivityAt = new Date();
    user.onlineStatus = "online";
    if (!user.appId) {
      user.appId = await createUniqueAppId();
    }
    if (!Array.isArray(user.authProviders)) {
      user.authProviders = [];
    }
    if (!user.authProviders.includes("password")) {
      user.authProviders.push("password");
    }
    await user.save();

    return res.status(200).json({
      success: true,
      message: "User logged in successfully",
      token: createBackendToken(user),
      tokenType: "Backend JWT",
      expiresIn: "7d",
      data: sanitizeUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", backendAuth, async (req, res, next) => {
  try {
    let user = await User.findByIdAndUpdate(
      req.backendUser.id,
      {
        $set: {
          lastActivityAt: new Date(),
          onlineStatus: "online",
        },
      },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found",
      });
    }

    if (!user.appId) {
      user.appId = await createUniqueAppId();
      await user.save();
    }

    user = await findUserProfileById(req.backendUser.id);

    return res.status(200).json({
      success: true,
      message: "User profile fetched successfully",
      data: await buildUserProfile(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/me/profile", backendAuth, async (req, res, next) => {
  try {
    const allowedFields = [
      "fullName",
      "userName",
      "profilePicture",
      "phone",
      "phoneE164",
      "designation",
      "position",
      "employeeCode",
      "joinDate",
      "lineId",
      "territory",
      "area",
      "settings",
    ];
    const update = allowedFields.reduce((fields, field) => {
      if (req.body[field] !== undefined) {
        fields[field] = req.body[field];
      }

      return fields;
    }, {});

    update.lastActivityAt = new Date();

    if (req.body.managerAppId !== undefined && req.body.managerAppId !== "") {
      const hierarchy = await buildHierarchyByAppId(
        req.body.managerAppId,
        req.backendUser.id,
      );
      update.managerId = hierarchy.managerId;
      update.path = hierarchy.path;
    }

    let user = await User.findByIdAndUpdate(
      req.backendUser.id,
      {
        $set: update,
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found",
      });
    }

    user = await findUserProfileById(req.backendUser.id);

    return res.status(200).json({
      success: true,
      message: "User profile updated successfully",
      data: await buildUserProfile(user),
    });
  } catch (error) {
    return next(error);
  }
});

// One-time admin maintenance: rebuild every user's `path` from the managerId
// chain so stale ancestor paths are corrected.
router.post("/users/repair-hierarchy", backendAuth, async (req, res, next) => {
  try {
    const currentUser = await User.findById(req.backendUser.id).select("_id role").lean();

    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: "User profile not found",
      });
    }

    if (currentUser.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can repair the hierarchy",
      });
    }

    const result = await repairHierarchyPaths();

    return res.status(200).json({
      success: true,
      message: "Hierarchy paths repaired",
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
