const express = require("express");
const { ObjectId } = require("mongodb");
const { getDB } = require("./db");
const { requireAuth } = require("./auth");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = message => {
  throw new HttpError(400, message);
};

const router = express.Router();

router.use(requireAuth);

// =====================================================
// Limits and validation
// =====================================================

const MAX_TASKS = 5000;
const MAX_SESSIONS = 20000;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);
const MAX_MS = 24 * 3600 * 1000;

function checkId(v, label) {
  if (typeof v !== "string" || !ID_RE.test(v)) {
    fail(`Invalid ${label}`);
  }

  return v;
}

function checkDate(v) {
  if (v === undefined || v === null || v === "") {
    return "";
  }

  if (typeof v !== "string" || !DATE_RE.test(v)) {
    fail("Invalid date");
  }

  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));

  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    fail("Invalid date");
  }

  return v;
}

function checkTitle(v) {
  if (typeof v !== "string") {
    fail("Title must be text");
  }

  const title = v.trim();

  if (!title || title.length > 120) {
    fail("Title must be 1 to 120 characters");
  }

  return title;
}

function checkInt(v, min, max, label) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${label} must be a number`);
  }

  const n = Math.round(v);

  if (n < min || n > max) {
    fail(`${label} must be between ${min} and ${max}`);
  }

  return n;
}

function checkPercent(v, label) {
  return v === null || v === undefined
    ? null
    : checkInt(v, 0, 100, label);
}

// =====================================================
// Tasks
// =====================================================

function taskFromBody(b, { trusted = false } = {}) {
  if (!b || typeof b !== "object") {
    fail("Invalid task");
  }

  return {
    id: checkId(b.id, "task id"),
    title: checkTitle(b.title),
    date: checkDate(b.date),
    est:
      b.est === undefined
        ? 30
        : checkInt(b.est, 5, 600, "Estimate"),
    done: b.done === true,

    focusedMs:
      trusted && b.focusedMs !== undefined
        ? checkInt(b.focusedMs, 0, 1e10, "Focused time")
        : 0,

    sample: trusted && b.sample === true
  };
}

function taskPatch(b) {
  if (!b || typeof b !== "object") {
    fail("Invalid task");
  }

  const patch = {};

  if ("title" in b) {
    patch.title = checkTitle(b.title);
  }

  if ("date" in b) {
    patch.date = checkDate(b.date);
  }

  if ("est" in b) {
    patch.est = checkInt(b.est, 5, 600, "Estimate");
  }

  if ("done" in b) {
    if (typeof b.done !== "boolean") {
      fail("done must be true or false");
    }

    patch.done = b.done;
  }

  return patch;
}

// =====================================================
// Sessions
// =====================================================

function sessionFromBody(b) {
  if (!b || typeof b !== "object") {
    fail("Invalid session");
  }

  const start = checkInt(b.start, MIN_TS, MAX_TS, "Start time");
  const end = checkInt(b.end, MIN_TS, MAX_TS, "End time");

  if (end < start) {
    fail("A session can't end before it starts");
  }

  const focusedMs = checkInt(
    b.focusedMs,
    0,
    MAX_MS,
    "Focused time"
  );

  const pausedMs =
    b.pausedMs === undefined
      ? 0
      : checkInt(b.pausedMs, 0, MAX_MS, "Paused time");

  const planned =
    b.planned === undefined
      ? 0
      : checkInt(b.planned, 0, MAX_MS, "Planned time");

  if (focusedMs > end - start + 5000) {
    fail("Focused time can't be longer than the session");
  }

  const segs = [];

  if (b.segs !== undefined) {
    if (!Array.isArray(b.segs) || b.segs.length > 500) {
      fail("Invalid focus periods");
    }

    for (const pair of b.segs) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        fail("Invalid focus period");
      }

      const a = checkInt(
        pair[0],
        MIN_TS,
        MAX_TS,
        "Period start"
      );

      const z = checkInt(
        pair[1],
        MIN_TS,
        MAX_TS,
        "Period end"
      );

      if (z < a) {
        fail("Invalid focus period");
      }

      segs.push([a, z]);
    }
  }

  const pauses = {
    manual: 0,
    tab: 0,
    away: 0,
    sleep: 0
  };

  if (b.pauses && typeof b.pauses === "object") {
    for (const key of Object.keys(pauses)) {
      if (key in b.pauses) {
        pauses[key] = checkInt(
          b.pauses[key],
          0,
          10000,
          "Pause count"
        );
      }
    }
  }

  const sensors = {
    camera: false,
    screen: false,
    mic: false
  };

  if (b.sensors && typeof b.sensors === "object") {
    for (const key of Object.keys(sensors)) {
      sensors[key] = b.sensors[key] === true;
    }
  }

  return {
    id: checkId(b.id, "session id"),
    taskId: b.taskId ? checkId(b.taskId, "task id") : "",
    start,
    end,
    focusedMs,
    pausedMs,
    planned,
    completed: b.completed === true,
    segs,
    pauses,
    sensors,
    noiseAvg: checkPercent(b.noiseAvg, "Noise level"),
    screenActive: checkPercent(
      b.screenActive,
      "Screen activity"
    ),
    presence: checkPercent(
      b.presence,
      "Presence"
    ),
    sample: b.sample === true
  };
}

// =====================================================
// Settings
// =====================================================

const num = (min, max) => v => {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return undefined;
  }

  const n = Math.round(v);

  return n >= min && n <= max ? n : undefined;
};

const bool = v =>
  typeof v === "boolean" ? v : undefined;

const oneOf = list => v =>
  list.includes(v) ? v : undefined;

const text = max => v =>
  typeof v === "string" && v.trim().length <= max
    ? v.trim()
    : undefined;

const SETTING_RULES = {
  name: text(24),
  goalMin: num(15, 960),
  focusMin: num(1, 240),
  breakMin: num(0, 60),
  chime: bool,
  tabLeave: oneOf([
    "unlessScreen",
    "pause",
    "keep"
  ]),
  palette: oneOf([
    "lavender",
    "peach",
    "mint",
    "sky",
    "pink"
  ]),
  deco: bool,
  confetti: bool
};

function cleanSettings(body) {
  if (!body || typeof body !== "object") {
    fail("Invalid settings");
  }

  const out = {};

  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!(key in body)) {
      continue;
    }

    const value = rule(body[key]);

    if (value === undefined) {
      fail(`Invalid setting: ${key}`);
    }

    out[key] = value;
  }

  return out;
}

// =====================================================
// MongoDB helpers
// =====================================================

function userObjectId(uid) {
  try {
    return ObjectId.createFromHexString(uid);
  } catch {
    throw new HttpError(401, "Invalid user");
  }
}

function taskDocument(uid, t) {
  return {
    user_id: userObjectId(uid),
    id: t.id,
    title: t.title,
    date: t.date,
    est: t.est,
    done: t.done,
    focused_ms: t.focusedMs,
    sample: t.sample,
    updated_at: new Date()
  };
}

function sessionDocument(uid, s) {
  return {
    user_id: userObjectId(uid),
    id: s.id,
    task_id: s.taskId,
    started_at: s.start,
    ended_at: s.end,
    focused_ms: s.focusedMs,
    paused_ms: s.pausedMs,
    planned_ms: s.planned,
    completed: s.completed,
    segs: s.segs,
    pauses: s.pauses,
    sensors: s.sensors,
    noise_avg: s.noiseAvg,
    screen_active: s.screenActive,
    presence: s.presence,
    sample: s.sample
  };
}

// MongoDB documents -> website format

function toTask(r) {
  if (!r) return null;

  return {
    id: r.id,
    title: r.title,
    date: r.date,
    est: r.est,
    done: !!r.done,
    focusedMs: r.focused_ms,
    ...(r.sample ? { sample: true } : {})
  };
}

function toSession(r) {
  if (!r) return null;

  return {
    id: r.id,
    taskId: r.task_id,
    start: r.started_at,
    end: r.ended_at,
    focusedMs: r.focused_ms,
    pausedMs: r.paused_ms,
    planned: r.planned_ms,
    completed: !!r.completed,
    segs: r.segs || [],
    pauses: r.pauses || {},
    sensors: r.sensors || {},
    noiseAvg: r.noise_avg,
    screenActive: r.screen_active,
    presence: r.presence,
    ...(r.sample ? { sample: true } : {})
  };
}

async function readAll(uid) {
  const database = getDB();
  const userId = userObjectId(uid);

  const [tasks, sessions, settings] = await Promise.all([
    database
      .collection("tasks")
      .find({ user_id: userId })
      .sort({ date: 1, _id: 1 })
      .toArray(),

    database
      .collection("sessions")
      .find({ user_id: userId })
      .sort({ started_at: 1 })
      .toArray(),

    database
      .collection("settings")
      .findOne({ user_id: userId })
  ]);

  return {
    tasks: tasks.map(toTask),
    sessions: sessions.map(toSession),
    settings: settings ? settings.data || {} : {}
  };
}

function readBulk(body) {
  if (!body || typeof body !== "object") {
    fail("Invalid data");
  }

  const rawTasks =
    body.tasks === undefined ? [] : body.tasks;

  const rawSessions =
    body.sessions === undefined ? [] : body.sessions;

  if (
    !Array.isArray(rawTasks) ||
    rawTasks.length > MAX_TASKS
  ) {
    fail("Too many tasks");
  }

  if (
    !Array.isArray(rawSessions) ||
    rawSessions.length > MAX_SESSIONS
  ) {
    fail("Too many sessions");
  }

  return {
    tasks: rawTasks.map(t =>
      taskFromBody(t, { trusted: true })
    ),
    sessions: rawSessions.map(sessionFromBody)
  };
}

async function checkStorageLimits(uid) {
  const database = getDB();
  const userId = userObjectId(uid);

  const [taskCount, sessionCount] = await Promise.all([
    database.collection("tasks").countDocuments({
      user_id: userId
    }),

    database.collection("sessions").countDocuments({
      user_id: userId
    })
  ]);

  if (
    taskCount > MAX_TASKS ||
    sessionCount > MAX_SESSIONS
  ) {
    fail("Storage limit reached");
  }
}

// =====================================================
// Routes
// =====================================================

// Everything for logged-in user
router.get("/data", async (req, res) => {
  res.json(await readAll(req.user.id));
});

// =====================================================
// Tasks
// =====================================================

router.post("/tasks", async (req, res) => {
  const uid = req.user.id;
  const database = getDB();
  const userId = userObjectId(uid);

  const t = taskFromBody(req.body);

  const count = await database
    .collection("tasks")
    .countDocuments({ user_id: userId });

  if (count >= MAX_TASKS) {
    fail("Task limit reached");
  }

  const existing = await database
    .collection("tasks")
    .findOne({
      user_id: userId,
      id: t.id
    });

  if (existing) {
    throw new HttpError(
      409,
      "That task already exists"
    );
  }

  const document = taskDocument(uid, t);

  await database.collection("tasks").insertOne(document);

  res.status(201).json({
    task: toTask(document)
  });
});

router.patch("/tasks/:id", async (req, res) => {
  const uid = req.user.id;
  const database = getDB();
  const userId = userObjectId(uid);

  const id = checkId(
    req.params.id,
    "task id"
  );

  const row = await database
    .collection("tasks")
    .findOne({
      user_id: userId,
      id
    });

  if (!row) {
    throw new HttpError(
      404,
      "Task not found"
    );
  }

  const next = {
    ...toTask(row),
    ...taskPatch(req.body)
  };

  await database
    .collection("tasks")
    .updateOne(
      {
        user_id: userId,
        id
      },
      {
        $set: {
          title: next.title,
          date: next.date,
          est: next.est,
          done: next.done,
          updated_at: new Date()
        }
      }
    );

  const updated = await database
    .collection("tasks")
    .findOne({
      user_id: userId,
      id
    });

  res.json({
    task: toTask(updated)
  });
});

router.delete("/tasks/:id", async (req, res) => {
  const database = getDB();
  const userId = userObjectId(req.user.id);

  await database
    .collection("tasks")
    .deleteOne({
      user_id: userId,
      id: checkId(
        req.params.id,
        "task id"
      )
    });

  res.json({ ok: true });
});

// =====================================================
// Sessions
// =====================================================

router.post("/sessions", async (req, res) => {
  const uid = req.user.id;
  const database = getDB();
  const userId = userObjectId(uid);

  const s = sessionFromBody(req.body);

  const count = await database
    .collection("sessions")
    .countDocuments({
      user_id: userId
    });

  if (count >= MAX_SESSIONS) {
    fail("Session limit reached");
  }

  const existing = await database
    .collection("sessions")
    .findOne({
      user_id: userId,
      id: s.id
    });

  if (existing) {
    throw new HttpError(
      409,
      "That session was already saved"
    );
  }

  const sessionDocumentValue =
    sessionDocument(uid, s);

  await database
    .collection("sessions")
    .insertOne(sessionDocumentValue);

  // The server adds focused time to the task.
  if (s.taskId) {
    await database
      .collection("tasks")
      .updateOne(
        {
          user_id: userId,
          id: s.taskId
        },
        {
          $inc: {
            focused_ms: s.focusedMs
          },
          $set: {
            updated_at: new Date()
          }
        }
      );
  }

  const taskRow = s.taskId
    ? await database
        .collection("tasks")
        .findOne({
          user_id: userId,
          id: s.taskId
        })
    : null;

  const savedSession = await database
    .collection("sessions")
    .findOne({
      user_id: userId,
      id: s.id
    });

  res.status(201).json({
    session: toSession(savedSession),
    task: taskRow ? toTask(taskRow) : null
  });
});

router.delete("/sessions/:id", async (req, res) => {
  const database = getDB();
  const userId = userObjectId(req.user.id);

  await database
    .collection("sessions")
    .deleteOne({
      user_id: userId,
      id: checkId(
        req.params.id,
        "session id"
      )
    });

  res.json({ ok: true });
});

// =====================================================
// Settings
// =====================================================

router.put("/settings", async (req, res) => {
  const database = getDB();
  const userId = userObjectId(req.user.id);

  const patch = cleanSettings(req.body);

  const row = await database
    .collection("settings")
    .findOne({
      user_id: userId
    });

  const merged = {
    ...(row ? row.data || {} : {}),
    ...patch
  };

  await database
    .collection("settings")
    .updateOne(
      {
        user_id: userId
      },
      {
        $set: {
          data: merged,
          updated_at: new Date()
        }
      },
      {
        upsert: true
      }
    );

  res.json({
    settings: merged
  });
});

// =====================================================
// Bulk
// =====================================================

router.post("/bulk", async (req, res) => {
  const uid = req.user.id;
  const database = getDB();
  const userId = userObjectId(uid);

  const { tasks, sessions } =
    readBulk(req.body);

  const taskCollection =
    database.collection("tasks");

  const sessionCollection =
    database.collection("sessions");

  for (const t of tasks) {
    await taskCollection.updateOne(
      {
        user_id: userId,
        id: t.id
      },
      {
        $set: taskDocument(uid, t)
      },
      {
        upsert: true
      }
    );
  }

  for (const s of sessions) {
    await sessionCollection.updateOne(
      {
        user_id: userId,
        id: s.id
      },
      {
        $set: sessionDocument(uid, s)
      },
      {
        upsert: true
      }
    );
  }

  await checkStorageLimits(uid);

  res.status(201).json({
    tasks: tasks.length,
    sessions: sessions.length
  });
});

// =====================================================
// Import backup
// =====================================================

router.post("/data/import", async (req, res) => {
  const uid = req.user.id;
  const database = getDB();
  const userId = userObjectId(uid);

  const { tasks, sessions } =
    readBulk(req.body);

  const settings =
    req.body.settings === undefined
      ? {}
      : cleanSettings(req.body.settings);

  // Clear current data first.
  await Promise.all([
    database.collection("tasks").deleteMany({
      user_id: userId
    }),

    database.collection("sessions").deleteMany({
      user_id: userId
    })
  ]);

  // Insert imported tasks.
  if (tasks.length > 0) {
    await database
      .collection("tasks")
      .insertMany(
        tasks.map(t => taskDocument(uid, t))
      );
  }

  // Insert imported sessions.
  if (sessions.length > 0) {
    await database
      .collection("sessions")
      .insertMany(
        sessions.map(s =>
          sessionDocument(uid, s)
        )
      );
  }

  await database
    .collection("settings")
    .updateOne(
      {
        user_id: userId
      },
      {
        $set: {
          data: settings,
          updated_at: new Date()
        }
      },
      {
        upsert: true
      }
    );

  return res.json(await readAll(uid));
});

// =====================================================
// Delete sample data
// =====================================================

router.delete("/samples", async (req, res) => {
  const database = getDB();
  const userId = userObjectId(req.user.id);

  await Promise.all([
    database.collection("tasks").deleteMany({
      user_id: userId,
      sample: true
    }),

    database.collection("sessions").deleteMany({
      user_id: userId,
      sample: true
    })
  ]);

  res.json({ ok: true });
});

// =====================================================
// Erase everything for this user
// =====================================================

router.delete("/data", async (req, res) => {
  const database = getDB();
  const userId = userObjectId(req.user.id);

  await Promise.all([
    database.collection("tasks").deleteMany({
      user_id: userId
    }),

    database.collection("sessions").deleteMany({
      user_id: userId
    }),

    database.collection("settings").deleteMany({
      user_id: userId
    })
  ]);

  res.json({ ok: true });
});

module.exports = router;








