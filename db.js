const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// The database file lives in a "data" folder (created automatically)
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "cadence.db"));

db.pragma("journal_mode = WAL");   // faster, safer writes
db.pragma("foreign_keys = ON");    // deleting a user also deletes their data

// Create the tables the first time the server starts
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT    NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    date        TEXT    NOT NULL DEFAULT '',
    est         INTEGER NOT NULL DEFAULT 30,
    done        INTEGER NOT NULL DEFAULT 0,
    focused_ms  INTEGER NOT NULL DEFAULT 0,
    sample      INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks (user_id, date);

  CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT    NOT NULL,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id        TEXT    NOT NULL DEFAULT '',
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER NOT NULL,
    focused_ms     INTEGER NOT NULL,
    paused_ms      INTEGER NOT NULL DEFAULT 0,
    planned_ms     INTEGER NOT NULL DEFAULT 0,
    completed      INTEGER NOT NULL DEFAULT 0,
    segs           TEXT    NOT NULL DEFAULT '[]',
    pauses         TEXT    NOT NULL DEFAULT '{}',
    sensors        TEXT    NOT NULL DEFAULT '{}',
    noise_avg      INTEGER,
    screen_active  INTEGER,
    presence       INTEGER,
    sample         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_start ON sessions (user_id, started_at);

  CREATE TABLE IF NOT EXISTS settings (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data        TEXT    NOT NULL DEFAULT '{}',
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;