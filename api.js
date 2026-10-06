const express = require("express");
const db = require("./db");
const { requireAuth } = require("./auth");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = message => { throw new HttpError(400, message); };

const router = express.Router();
router.use(requireAuth);   // every route below needs a logged-in user


// =====================================================
//  Limits and validation
// =====================================================
const MAX_TASKS = 5000;
const MAX_SESSIONS = 20000;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);
const MAX_MS = 24 * 3600 * 1000;

function checkId(v, label) {
  if (typeof v !== "string" || !ID_RE.test(v)) fail(`Invalid ${label}`);
  return v;
}

function checkTitle(v) {
  if (typeof v !== "string") fail("Title must be text");
  const title = v.trim();
  if (!title || title.length > 120) fail("Title must be 1 to 120 characters");
  return title;
}

function checkDate(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || !DATE_RE.test(v)) fail("Invalid date");

  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) fail("Invalid date");
  return v;
}

function checkInt(v, min, max, label) {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${label} must be a number`);
  const n = Math.round(v);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max}`);
  return n;
}

function checkPercent(v, label) {
  return v === null || v === undefined ? null : checkInt(v, 0, 100, label);
}

// ----- Tasks -----
function taskFromBody(b, { trusted = false } = {}) {
  if (!b || typeof b !== "object") fail("Invalid task");
  return {
    id: checkId(b.id, "task id"),
    title: checkTitle(b.title),
    date: checkDate(b.date),
    est: b.est === undefined ? 30 : checkInt(b.est, 5, 600, "Estimate"),
    done: b.done === true,
    // Only imports and bulk loads may set focused time directly
    focusedMs: trusted && b.focusedMs !== undefined ? checkInt(b.focusedMs, 0, 1e10, "Focused time") : 0,
    sample: trusted && b.sample === true
  };
}

function taskPatch(b) {
  if (!b || typeof b !== "object") fail("Invalid task");
  const patch = {};
  if ("title" in b) patch.title = checkTitle(b.title);
  if ("date" in b) patch.date = checkDate(b.date);
  if ("est" in b) patch.est = checkInt(b.est, 5, 600, "Estimate");
  if ("done" in b) {
    if (typeof b.done !== "boolean") fail("done must be true or false");
    patch.done = b.done;
  }
  return patch;
}

// ----- Sessions -----
function sessionFromBody(b) {
  if (!b || typeof b !== "object") fail("Invalid session");

  const start = checkInt(b.start, MIN_TS, MAX_TS, "Start time");
  const end = checkInt(b.end, MIN_TS, MAX_TS, "End time");
  if (end < start) fail("A session can't end before it starts");

  const focusedMs = checkInt(b.focusedMs, 0, MAX_MS, "Focused time");
  const pausedMs = b.pausedMs === undefined ? 0 : checkInt(b.pausedMs, 0, MAX_MS, "Paused time");
  const planned = b.planned === undefined ? 0 : checkInt(b.planned, 0, MAX_MS, "Planned time");

  // Focused time can never be longer than the session itself
  if (focusedMs > end - start + 5000) fail("Focused time can't be longer than the session");

  const segs = [];
  if (b.segs !== undefined) {
    if (!Array.isArray(b.segs) || b.segs.length > 500) fail("Invalid focus periods");
    for (const pair of b.segs) {
      if (!Array.isArray(pair) || pair.length !== 2) fail("Invalid focus period");
      const a = checkInt(pair[0], MIN_TS, MAX_TS, "Period start");
      const z = checkInt(pair[1], MIN_TS, MAX_TS, "Period end");
      if (z < a) fail("Invalid focus period");
      segs.push([a, z]);
    }
  }

  const pauses = { manual: 0, tab: 0, away: 0, sleep: 0 };
  if (b.pauses && typeof b.pauses === "object") {
    for (const key of Object.keys(pauses)) {
      if (key in b.pauses) pauses[key] = checkInt(b.pauses[key], 0, 10000, "Pause count");
    }
  }

  const sensors = { camera: false, screen: false, mic: false };
  if (b.sensors && typeof b.sensors === "object") {
    for (const key of Object.keys(sensors)) sensors[key] = b.sensors[key] === true;
  }

  return {
    id: checkId(b.id, "session id"),
    taskId: b.taskId ? checkId(b.taskId, "task id") : "",
    start, end, focusedMs, pausedMs, planned,
    completed: b.completed === true,
    segs, pauses, sensors,
    noiseAvg: checkPercent(b.noiseAvg, "Noise level"),
    screenActive: checkPercent(b.screenActive, "Screen activity"),
    presence: checkPercent(b.presence, "Presence"),
    sample: b.sample === true
  };
}

// ----- Settings -----
const num = (min, max) => v => {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  return n >= min && n <= max ? n : undefined;
};
const bool = v => (typeof v === "boolean" ? v : undefined);
const oneOf = list => v => (list.includes(v) ? v : undefined);
const text = max => v => (typeof v === "string" && v.trim().length <= max ? v.trim() : undefined);

const SETTING_RULES = {
  name: text(24),
  goalMin: num(15, 960),
  focusMin: num(1, 240),
  breakMin: num(0, 60),
  chime: bool,
  tabLeave: oneOf(["unlessScreen", "pause", "keep"]),
  palette: oneOf(["lavender", "peach", "mint", "sky", "pink"]),
  deco: bool,
  confetti: bool
};

function cleanSettings(body) {
  if (!body || typeof body !== "object") fail("Invalid settings");
  const out = {};
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!(key in body)) continue;
    const value = rule(body[key]);
    if (value === undefined) fail(`Invalid setting: ${key}`);
    out[key] = value;
  }
  return out;
}


// =====================================================
//  Database statements
// =====================================================
const TASK_COLS = "id, user_id, title, date, est, done, focused_ms, sample";
const SESSION_COLS =
  "id, user_id, task_id, started_at, ended_at, focused_ms, paused_ms, planned_ms, completed, " +
  "segs, pauses, sensors, noise_avg, screen_active, presence, sample";

const q = {
  allTasks:     db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY date, rowid"),
  getTask:      db.prepare("SELECT * FROM tasks WHERE user_id = ? AND id = ?"),
  countTasks:   db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?"),
  insertTask:   db.prepare(`INSERT INTO tasks (${TASK_COLS}) VALUES (?,?,?,?,?,?,?,?)`),
  upsertTask:   db.prepare(`INSERT OR REPLACE INTO tasks (${TASK_COLS}) VALUES (?,?,?,?,?,?,?,?)`),
  updateTask:   db.prepare("UPDATE tasks SET title = ?, date = ?, est = ?, done = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?"),
  deleteTask:   db.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?"),
  addFocus:     db.prepare("UPDATE tasks SET focused_ms = focused_ms + ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?"),

  allSessions:  db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at"),
  getSession:   db.prepare("SELECT * FROM sessions WHERE user_id = ? AND id = ?"),
  countSessions:db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?"),
  insertSession:db.prepare(`INSERT INTO sessions (${SESSION_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  upsertSession:db.prepare(`INSERT OR REPLACE INTO sessions (${SESSION_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  deleteSession:db.prepare("DELETE FROM sessions WHERE user_id = ? AND id = ?"),

  getSettings:  db.prepare("SELECT data FROM settings WHERE user_id = ?"),
  saveSettings: db.prepare(
    "INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')"
  ),

  clearTasks:    db.prepare("DELETE FROM tasks WHERE user_id = ?"),
  clearSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  clearSettings: db.prepare("DELETE FROM settings WHERE user_id = ?"),
  clearSampleTasks:    db.prepare("DELETE FROM tasks WHERE user_id = ? AND sample = 1"),
  clearSampleSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND sample = 1")
};

const taskParams = (uid, t) =>
  [t.id, uid, t.title, t.date, t.est, t.done ? 1 : 0, t.focusedMs, t.sample ? 1 : 0];

const sessionParams = (uid, s) => [
  s.id, uid, s.taskId, s.start, s.end, s.focusedMs, s.pausedMs, s.planned, s.completed ? 1 : 0,
  JSON.stringify(s.segs), JSON.stringify(s.pauses), JSON.stringify(s.sensors),
  s.noiseAvg, s.screenActive, s.presence, s.sample ? 1 : 0
];

function parseJson(textValue, fallback) {
  try { return JSON.parse(textValue); } catch (e) { return fallback; }
}

// Database rows -> the shape the website already uses
const toTask = r => ({
  id: r.id, title: r.title, date: r.date, est: r.est, done: !!r.done, focusedMs: r.focused_ms,
  ...(r.sample ? { sample: true } : {})
});

const toSession = r => ({
  id: r.id, taskId: r.task_id, start: r.started_at, end: r.ended_at,
  focusedMs: r.focused_ms, pausedMs: r.paused_ms, planned: r.planned_ms,
  completed: !!r.completed,
  segs: parseJson(r.segs, []), pauses: parseJson(r.pauses, {}), sensors: parseJson(r.sensors, {}),
  noiseAvg: r.noise_avg, screenActive: r.screen_active, presence: r.presence,
  ...(r.sample ? { sample: true } : {})
});

function readAll(uid) {
  const row = q.getSettings.get(uid);
  return {
    tasks: q.allTasks.all(uid).map(toTask),
    sessions: q.allSessions.all(uid).map(toSession),
    settings: row ? parseJson(row.data, {}) : {}
  };
}

function readBulk(body) {
  if (!body || typeof body !== "object") fail("Invalid data");

  const rawTasks = body.tasks === undefined ? [] : body.tasks;
  const rawSessions = body.sessions === undefined ? [] : body.sessions;

  if (!Array.isArray(rawTasks) || rawTasks.length > MAX_TASKS) fail("Too many tasks");
  if (!Array.isArray(rawSessions) || rawSessions.length > MAX_SESSIONS) fail("Too many sessions");

  return {
    tasks: rawTasks.map(t => taskFromBody(t, { trusted: true })),
    sessions: rawSessions.map(sessionFromBody)
  };
}

const checkStorageLimits = uid => {
  if (q.countTasks.get(uid).n > MAX_TASKS || q.countSessions.get(uid).n > MAX_SESSIONS) {
    fail("Storage limit reached");
  }
};

const isDuplicate = e => String(e && e.code).startsWith("SQLITE_CONSTRAINT");


// =====================================================
//  Routes
// =====================================================

// Everything for the logged-in user, in one request
router.get("/data", (req, res) => {
  res.json(readAll(req.user.id));
});

// ----- Tasks -----
router.post("/tasks", (req, res) => {
  const uid = req.user.id;
  const t = taskFromBody(req.body);

  if (q.countTasks.get(uid).n >= MAX_TASKS) fail("Task limit reached");

  try {
    q.insertTask.run(...taskParams(uid, t));
  } catch (e) {
    if (isDuplicate(e)) throw new HttpError(409, "That task already exists");
    throw e;
  }
  res.status(201).json({ task: toTask(q.getTask.get(uid, t.id)) });
});

router.patch("/tasks/:id", (req, res) => {
  const uid = req.user.id;
  const id = checkId(req.params.id, "task id");

  const row = q.getTask.get(uid, id);
  if (!row) throw new HttpError(404, "Task not found");

  const next = { ...toTask(row), ...taskPatch(req.body) };
  q.updateTask.run(next.title, next.date, next.est, next.done ? 1 : 0, uid, id);

  res.json({ task: toTask(q.getTask.get(uid, id)) });
});

router.delete("/tasks/:id", (req, res) => {
  q.deleteTask.run(req.user.id, checkId(req.params.id, "task id"));
  res.json({ ok: true });
});

// ----- Sessions -----
const createSession = db.transaction((uid, s) => {
  q.insertSession.run(...sessionParams(uid, s));
  if (s.taskId) q.addFocus.run(s.focusedMs, uid, s.taskId);   // the server adds the focused time
});

router.post("/sessions", (req, res) => {
  const uid = req.user.id;
  const s = sessionFromBody(req.body);

  if (q.countSessions.get(uid).n >= MAX_SESSIONS) fail("Session limit reached");

  try {
    createSession(uid, s);
  } catch (e) {
    if (isDuplicate(e)) throw new HttpError(409, "That session was already saved");
    throw e;
  }

  const taskRow = s.taskId ? q.getTask.get(uid, s.taskId) : null;
  res.status(201).json({
    session: toSession(q.getSession.get(uid, s.id)),
    task: taskRow ? toTask(taskRow) : null
  });
});

router.delete("/sessions/:id", (req, res) => {
  q.deleteSession.run(req.user.id, checkId(req.params.id, "session id"));
  res.json({ ok: true });
});

// ----- Settings -----
router.put("/settings", (req, res) => {
  const uid = req.user.id;
  const patch = cleanSettings(req.body);

  const row = q.getSettings.get(uid);
  const merged = { ...(row ? parseJson(row.data, {}) : {}), ...patch };

  q.saveSettings.run(uid, JSON.stringify(merged));
  res.json({ settings: merged });
});

// ----- Bulk: sample data and moving old local data into your account -----
router.post("/bulk", (req, res) => {
  const uid = req.user.id;
  const { tasks, sessions } = readBulk(req.body);

  db.transaction(() => {
    tasks.forEach(t => q.upsertTask.run(...taskParams(uid, t)));
    sessions.forEach(s => q.upsertSession.run(...sessionParams(uid, s)));
    checkStorageLimits(uid);
  })();

  res.status(201).json({ tasks: tasks.length, sessions: sessions.length });
});

// Replace everything with a backup file
router.post("/data/import", (req, res) => {
  const uid = req.user.id;
  const { tasks, sessions } = readBulk(req.body);
  const settings = req.body.settings === undefined ? {} : cleanSettings(req.body.settings);

  db.transaction(() => {
    q.clearTasks.run(uid);
    q.clearSessions.run(uid);
    tasks.forEach(t => q.upsertTask.run(...taskParams(uid, t)));
    sessions.forEach(s => q.upsertSession.run(...sessionParams(uid, s)));
    q.saveSettings.run(uid, JSON.stringify(settings));
  })();

  res.json(readAll(uid));
});

router.delete("/samples", (req, res) => {
  const uid = req.user.id;
  db.transaction(() => {
    q.clearSampleTasks.run(uid);
    q.clearSampleSessions.run(uid);
  })();
  res.json({ ok: true });
});

// Erase everything for this user
router.delete("/data", (req, res) => {
  const uid = req.user.id;
  db.transaction(() => {
    q.clearTasks.run(uid);
    q.clearSessions.run(uid);
    q.clearSettings.run(uid);
  })();
  res.json({ ok: true });
});

module.exports = router;