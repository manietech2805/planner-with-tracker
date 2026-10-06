const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");

const router = express.Router();

// ---------- Secret key used to sign login cookies ----------
// Created once and saved in data/secret.txt (that folder is never shared).
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const file = path.join(__dirname, "data", "secret.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();

  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const SECRET = loadSecret();
const COOKIE = "cadence_token";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // stay logged in for 30 days

// Used so a wrong email takes as long to reject as a wrong password
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

// ---------- Helpers ----------
function cleanEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 72;
}

function setLoginCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, SECRET, { expiresIn: "30d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,                                   // JavaScript on the page can't read it
    sameSite: "lax",                                  // not sent from other websites
    secure: process.env.NODE_ENV === "production",    // https only when online
    maxAge: MAX_AGE_MS
  });
}

// ---------- Middleware: use this on any route that needs a logged-in user ----------
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: "Please log in" });

  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(payload.uid);
    if (!user) throw new Error("User no longer exists");

    req.user = user;
    next();
  } catch (e) {
    res.clearCookie(COOKIE);
    res.status(401).json({ error: "Please log in again" });
  }
}

// ---------- Routes ----------
router.post("/register", async (req, res) => {
  const { email, password } = req.body || {};

  const emailClean = cleanEmail(email);
  if (!emailClean) return res.status(400).json({ error: "Please enter a valid email" });
  if (!validPassword(password)) {
    return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  }

  const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(emailClean);
  if (exists) return res.status(409).json({ error: "That email is already registered" });

  const hash = await bcrypt.hash(password, 12);

  try {
    const info = db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(emailClean, hash);

    setLoginCookie(res, info.lastInsertRowid);
    res.status(201).json({ user: { id: Number(info.lastInsertRowid), email: emailClean } });
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) {
      return res.status(409).json({ error: "That email is already registered" });
    }
    throw e;
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const emailClean = cleanEmail(email);

  const user = emailClean
    ? db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(emailClean)
    : null;

  const ok = await bcrypt.compare(
    typeof password === "string" ? password : "",
    user ? user.password_hash : DUMMY_HASH
  );

  if (!user || !ok) return res.status(401).json({ error: "Wrong email or password" });

  setLoginCookie(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
});

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = { router, requireAuth };
