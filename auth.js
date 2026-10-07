const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const { getDB } = require("./db");

const router = express.Router();

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const file = path.join(__dirname, "data", "secret.txt");

  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8").trim();
  }

  const secret = crypto.randomBytes(48).toString("hex");

  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, secret, {
    mode: 0o600
  });

  return secret;
}

const SECRET = loadSecret();

const COOKIE = "cadence_token";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DUMMY_HASH = bcrypt.hashSync(
  "not-a-real-password",
  12
);


function cleanEmail(value) {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}


function validPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 72
  );
}


function setLoginCookie(res, userId, version) {
  const token = jwt.sign(
    {
      uid: userId,
      v: version
    },
    SECRET,
    {
      expiresIn: "30d"
    }
  );

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_MS
  });
}


/* =========================
   AUTH MIDDLEWARE
========================= */

async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];

  if (!token) {
    return res.status(401).json({
      error: "Please log in"
    });
  }

  try {
    const payload = jwt.verify(token, SECRET);

    const db = getDB();

    // Convert JWT user ID string into MongoDB ObjectId
    const userId = ObjectId.createFromHexString(
      payload.uid
    );

    const user = await db.collection("users").findOne(
      {
        _id: userId
      },
      {
        projection: {
          _id: 1,
          email: 1,
          token_version: 1
        }
      }
    );

    if (!user) {
      throw new Error("User no longer exists");
    }

    if (
      (payload.v || 0) !==
      (user.token_version || 0)
    ) {
      throw new Error("Password was changed");
    }

    req.user = {
      id: user._id.toString(),
      email: user.email
    };

    next();

  } catch (e) {
    res.clearCookie(COOKIE);

    return res.status(401).json({
      error: "Please log in again"
    });
  }
}


/* =========================
   REGISTER
========================= */

router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const emailClean = cleanEmail(email);

    if (!emailClean) {
      return res.status(400).json({
        error: "Please enter a valid email"
      });
    }

    if (!validPassword(password)) {
      return res.status(400).json({
        error: "Password must be 8 to 72 characters"
      });
    }

    const db = getDB();

    const users = db.collection("users");

    const exists = await users.findOne({
      email: emailClean
    });

    if (exists) {
      return res.status(409).json({
        error: "That email is already registered"
      });
    }

    const hash = await bcrypt.hash(
      password,
      12
    );

    const user = {
      email: emailClean,
      password_hash: hash,
      token_version: 0,
      created_at: new Date()
    };

    try {
      const result = await users.insertOne(user);

      const id = result.insertedId.toString();

      setLoginCookie(
        res,
        id,
        0
      );

      return res.status(201).json({
        user: {
          id,
          email: emailClean
        }
      });

    } catch (e) {
      if (e.code === 11000) {
        return res.status(409).json({
          error: "That email is already registered"
        });
      }

      throw e;
    }

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Something went wrong"
    });
  }
});


/* =========================
   LOGIN
========================= */

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const emailClean = cleanEmail(email);

    const db = getDB();

    const user = emailClean
      ? await db.collection("users").findOne({
          email: emailClean
        })
      : null;

    const ok = await bcrypt.compare(
      typeof password === "string"
        ? password
        : "",
      user
        ? user.password_hash
        : DUMMY_HASH
    );

    if (!user || !ok) {
      return res.status(401).json({
        error: "Wrong email or password"
      });
    }

    const id = user._id.toString();

    const version =
      user.token_version || 0;

    setLoginCookie(
      res,
      id,
      version
    );

    return res.json({
      user: {
        id,
        email: user.email
      }
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Something went wrong"
    });
  }
});


/* =========================
   LOGOUT
========================= */

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE);

  res.json({
    ok: true
  });
});


/* =========================
   CURRENT USER
========================= */

router.get("/me", requireAuth, (req, res) => {
  res.json({
    user: req.user
  });
});


/* =========================
   CHANGE PASSWORD
========================= */

router.post(
  "/password",
  requireAuth,
  async (req, res) => {
    try {
      const {
        current,
        newPassword
      } = req.body || {};

      if (!validPassword(newPassword)) {
        return res.status(400).json({
          error:
            "New password must be 8 to 72 characters"
        });
      }

      const db = getDB();

      const users =
        db.collection("users");

      const userId =
        ObjectId.createFromHexString(
          req.user.id
        );

      const row =
        await users.findOne({
          _id: userId
        });

      if (!row) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      const ok =
        await bcrypt.compare(
          typeof current === "string"
            ? current
            : "",
          row.password_hash
        );

      if (!ok) {
        return res.status(403).json({
          error:
            "Your current password is wrong"
        });
      }

      const hash =
        await bcrypt.hash(
          newPassword,
          12
        );

      const version =
        (row.token_version || 0) + 1;

      await users.updateOne(
        {
          _id: row._id
        },
        {
          $set: {
            password_hash: hash,
            token_version: version
          }
        }
      );

      setLoginCookie(
        res,
        row._id.toString(),
        version
      );

      return res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      return res.status(500).json({
        error: "Something went wrong"
      });
    }
  }
);


/* =========================
   DELETE ACCOUNT
========================= */

router.delete(
  "/account",
  requireAuth,
  async (req, res) => {
    try {
      const { password } =
        req.body || {};

      const userId =
        ObjectId.createFromHexString(
          req.user.id
        );

      const db = getDB();

      const user =
        await db.collection("users")
          .findOne({
            _id: userId
          });

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      const ok =
        await bcrypt.compare(
          typeof password === "string"
            ? password
            : "",
          user.password_hash
        );

      if (!ok) {
        return res.status(403).json({
          error: "That password is wrong"
        });
      }

      // Delete user
      await db.collection("users")
        .deleteOne({
          _id: userId
        });

      // Delete user's tasks
      await db.collection("tasks")
        .deleteMany({
          user_id: userId
        });

      // Delete user's sessions
      await db.collection("sessions")
        .deleteMany({
          user_id: userId
        });

      // Delete user's settings
      await db.collection("settings")
        .deleteMany({
          user_id: userId
        });

      res.clearCookie(COOKIE);

      return res.json({
        ok: true
      });

    } catch (err) {
      console.error(err);

      return res.status(500).json({
        error: "Something went wrong"
      });
    }
  }
);


module.exports = {
  router,
  requireAuth
};
