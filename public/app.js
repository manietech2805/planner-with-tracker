// =====================================================
//  Cadence — cozy focus planner (saves to the server)
// =====================================================


// ---------- Small helper for this device's own preferences ----------
// (Tasks, sessions and settings now live on the server, not here.)
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }
};


// ---------- Data (loaded from the server after you log in) ----------
const DEFAULT_SETTINGS = {
  name: "",
  goalMin: 240,
  focusMin: 25,
  breakMin: 5,
  chime: true,
  tabLeave: "unlessScreen",   // "unlessScreen" | "pause" | "keep"
  palette: "lavender",
  deco: true,
  confetti: true
};

let tasks = [];
let sessions = [];
const settings = Object.assign({}, DEFAULT_SETTINGS);
let currentUser = null;

function replaceSettings(values) {
  Object.keys(settings).forEach(key => delete settings[key]);
  Object.assign(settings, DEFAULT_SETTINGS, values || {});
}


// ---------- Talking to the server ----------
async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin"
    });
  } catch (e) {
    const err = new Error("You appear to be offline");
    err.offline = true;
    throw err;
  }

  let data = null;
  try { data = await res.json(); } catch (e) {}

  if (!res.ok) {
    const err = new Error((data && data.error) || "Something went wrong");
    err.status = res.status;
    if (res.status === 401 && !url.startsWith("/api/auth/")) handleSessionExpired();
    throw err;
  }
  return data;
}

const api = {
  get: url => request("GET", url),
  post: (url, body) => request("POST", url, body === undefined ? {} : body),
  patch: (url, body) => request("PATCH", url, body),
  put: (url, body) => request("PUT", url, body),
  remove: url => request("DELETE", url)
};

// Something didn't save: tell the person, then pull the real data back from the server
function syncFailed(err) {
  if (err && err.status === 401) return;     // the login screen handles this
  toast(err && err.offline
    ? "You're offline, so that change wasn't saved."
    : "That change wasn't saved: " + (err && err.message ? err.message : "unknown error"));
  loadAll().catch(() => {});
}

// Focus sessions are precious, so they wait in a local queue until the server confirms them
function pendingKey() {
  return "pendingSessions_" + (currentUser ? currentUser.id : "none");
}

function queueSession(rec) {
  const list = store.get(pendingKey(), []);
  list.push(rec);
  store.set(pendingKey(), list);
  flushPending();
}

let flushing = false;

async function flushPending() {
  if (flushing || !currentUser) return;
  flushing = true;

  try {
    let list = store.get(pendingKey(), []);

    while (list.length) {
      try {
        await api.post("/api/sessions", list[0]);
      } catch (e) {
        // Offline, server trouble or logged out: keep it and try again later
        if (e.offline || e.status === 401 || (e.status && e.status >= 500)) break;
        // 409 means it was already saved. Anything else can't be saved, so we drop it.
        if (e.status === 400) toast("One session couldn't be saved: " + e.message);
      }
      list = list.slice(1);
      store.set(pendingKey(), list);
    }
  } finally {
    flushing = false;
  }
}

window.addEventListener("online", flushPending);

async function loadAll() {
  await flushPending();

  const data = await api.get("/api/data");
  tasks = data.tasks;
  sessions = data.sessions;
  replaceSettings(data.settings);

  applySettings();
  fillSettings();
  renderAll();
  renderFocus();
}


// ---------- Helpers ----------
const $ = id => document.getElementById(id);

function todayKey() {
  return new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD
}

function offsetKey(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dayKeyOf(ts) {
  return new Date(ts).toLocaleDateString("en-CA");
}

function formatDuration(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + "s";
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todaysSessions() {
  return sessions.filter(s => dayKeyOf(s.start) === todayKey());
}

function dateLabel(key) {
  if (!key) return "Someday";
  if (key === todayKey()) return "Today";
  if (key === offsetKey(1)) return "Tomorrow";
  if (key === offsetKey(-1)) return "Yesterday";
  return parseKey(key).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

const taskSort = (a, b) => (Number(a.done) - Number(b.done)) || String(a.title).localeCompare(String(b.title));

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function emptyEl(title, text, sticker) {
  const div = document.createElement("div");
  div.className = "empty";
  div.innerHTML = `<svg class="sticker" aria-hidden="true"><use href="#${sticker || "st-cloud"}"/></svg>
                   <p><strong>${title}</strong><br>${text}</p>`;
  return div;
}


// ---------- Page navigation ----------
const PAGES = ["dashboard", "planner", "focus", "analytics", "settings"];

function showPage() {
  const hash = location.hash.slice(1);
  const name = PAGES.includes(hash) ? hash : "dashboard";

  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === name);
  });
  document.querySelectorAll(".sidebar nav a").forEach(link => {
    link.classList.toggle("active", link.dataset.page === name);
  });
}

window.addEventListener("hashchange", () => {
  showPage();
  window.scrollTo(0, 0);
});


// ---------- Mochi's mood ----------
let currentMood = "";

function setMood(mood) {
  if (mood === currentMood) return;
  currentMood = mood;
  document.querySelectorAll(".mascot-face").forEach(use => use.setAttribute("href", "#face-" + mood));
}

function moodNow() {
  if (breakEnd) return "joy";
  if (focus) {
    if (focus.status === "focusing") return "focus";
    if (focus.status === "starting") return "happy";
    return "sleep";
  }
  return "happy";
}


// ---------- Sounds and confetti ----------
function beep() {
  if (!settings.chime) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.25 + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.55);
    });
  } catch (e) {}
}

function confetti() {
  if (!settings.confetti) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const colors = ["#ffc6dd", "#d6c7ff", "#bfeedd", "#fff0a8", "#bfe0ff", "#ffcdb2"];
  for (let i = 0; i < 38; i++) {
    const piece = document.createElement("i");
    piece.className = "confetti";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[i % colors.length];
    piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "3px";
    piece.style.animationDelay = Math.random() * 0.4 + "s";
    piece.style.setProperty("--dx", (Math.random() * 180 - 90) + "px");
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 3200);
  }
}


// ---------- Settings ----------
function saveSettings() {
  if (!currentUser) return;
  api.put("/api/settings", settings).catch(syncFailed);
}

function applySettings() {
  document.documentElement.dataset.palette = settings.palette;
  document.body.classList.toggle("no-deco", !settings.deco);

  document.querySelectorAll(".swatch").forEach(s => {
    s.setAttribute("aria-pressed", String(s.dataset.palette === settings.palette));
  });
}

function fillSettings() {
  $("set-name").value = settings.name;
  $("set-goal").value = settings.goalMin;
  $("set-focus").value = settings.focusMin;
  $("set-break").value = settings.breakMin;
  $("set-tab").value = settings.tabLeave;
  $("set-chime").checked = settings.chime;
  $("set-deco").checked = settings.deco;
  $("set-confetti").checked = settings.confetti;
  if (!focus) $("focus-min").value = settings.focusMin;
}

function bindSetting(id, key, kind) {
  const el = $(id);
  el.addEventListener("change", () => {
    let value;
    if (kind === "check") {
      value = el.checked;
    } else if (kind === "number") {
      value = Number(el.value);
      if (!Number.isFinite(value)) value = DEFAULT_SETTINGS[key];
      value = Math.min(Number(el.max), Math.max(Number(el.min), value));
      el.value = value;
    } else {
      value = el.value.trim();
    }

    settings[key] = value;
    saveSettings();
    applySettings();
    if (key === "focusMin" && !focus) $("focus-min").value = value;
    if (key === "tabLeave" && focus) { updateHidden(); applyStatus(Date.now()); }
    renderAll();
    toast("Saved");
  });
}

bindSetting("set-name", "name", "text");
bindSetting("set-goal", "goalMin", "number");
bindSetting("set-focus", "focusMin", "number");
bindSetting("set-break", "breakMin", "number");
bindSetting("set-tab", "tabLeave", "text");
bindSetting("set-chime", "chime", "check");
bindSetting("set-deco", "deco", "check");
bindSetting("set-confetti", "confetti", "check");

$("palette-picker").addEventListener("click", e => {
  const swatch = e.target.closest(".swatch");
  if (!swatch) return;
  settings.palette = swatch.dataset.palette;
  saveSettings();
  applySettings();
});


// ---------- Planner ----------
function taskRow(task, withActions) {
  const li = document.createElement("li");
  li.className = "task" + (task.done ? " done" : "");
  li.dataset.id = task.id;

  const focused = task.focusedMs ? `<span class="pill mint">${formatDuration(task.focusedMs)} focused</span>` : "";

  li.innerHTML = `
    <input type="checkbox" data-action="toggle" aria-label="Mark done" ${task.done ? "checked" : ""}>
    <div class="task-info">
      <span class="task-title"></span>
      <span class="task-meta"><span class="pill">${Number(task.est) || 30} min</span>${focused}</span>
    </div>
    ${withActions
      ? '<button class="mini-btn" data-action="edit">Edit</button><button class="mini-btn" data-action="delete">Delete</button>'
      : (task.done ? "" : '<button class="mini-btn" data-action="focus">Focus</button>')}
  `;

  li.querySelector(".task-title").textContent = task.title;
  return li;
}

function renderTasks() {
  const wrap = $("planner-list");
  wrap.innerHTML = "";

  if (tasks.length === 0) {
    wrap.appendChild(emptyEl("No tasks yet", "Add your first one above and Mochi will cheer you on!", "st-flower"));
    return;
  }

  const groups = {};
  tasks.forEach(t => {
    const key = t.date || "";
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const keys = Object.keys(groups).sort((a, b) => a === "" ? 1 : b === "" ? -1 : a.localeCompare(b));

  keys.forEach(key => {
    const section = document.createElement("section");
    section.className = "day-group";

    const heading = document.createElement("h3");
    heading.textContent = dateLabel(key);
    if (key === todayKey()) heading.classList.add("is-today");

    const ul = document.createElement("ul");
    ul.className = "task-list";
    groups[key].sort(taskSort).forEach(t => ul.appendChild(taskRow(t, true)));

    section.append(heading, ul);
    wrap.appendChild(section);
  });
}

$("task-form").addEventListener("submit", e => {
  e.preventDefault();

  const titleInput = $("task-title");
  const title = titleInput.value.trim();
  if (!title) return;

  const task = {
    id: newId(),
    title,
    date: $("task-date").value,
    est: Math.min(600, Math.max(5, Number($("task-est").value) || 30)),
    done: false,
    focusedMs: 0
  };

  tasks.push(task);
  titleInput.value = "";
  renderAll();
  toast("Task added");

  api.post("/api/tasks", task).catch(syncFailed);
});

// Shared by the planner list and today's list
function handleTaskClick(e) {
  const li = e.target.closest(".task");
  const action = e.target.dataset.action;
  if (!li || !action) return;

  const task = tasks.find(t => t.id === li.dataset.id);
  if (!task) return;

  if (action === "toggle") {
    task.done = e.target.checked;
    api.patch("/api/tasks/" + task.id, { done: task.done }).catch(syncFailed);
  } else if (action === "delete") {
    tasks = tasks.filter(t => t.id !== task.id);
    toast("Task deleted");
    api.remove("/api/tasks/" + task.id).catch(syncFailed);
  } else if (action === "edit") {
    openEdit(task.id);
    return;
  } else if (action === "focus") {
    $("focus-task").value = task.id;
    location.hash = "#focus";
    return;
  } else {
    return;
  }

  renderAll();
}

$("planner-list").addEventListener("click", handleTaskClick);
$("today-list").addEventListener("click", handleTaskClick);

// Edit window
let editingId = null;

function openEdit(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  editingId = id;
  $("edit-title").value = task.title;
  $("edit-date").value = task.date || "";
  $("edit-est").value = task.est;
  $("edit-dialog").showModal();
}

$("edit-form").addEventListener("submit", e => {
  e.preventDefault();
  const task = tasks.find(t => t.id === editingId);
  const title = $("edit-title").value.trim();

  if (task && title) {
    task.title = title;
    task.date = $("edit-date").value;
    task.est = Math.min(600, Math.max(5, Number($("edit-est").value) || 30));
    renderAll();
    toast("Task updated");

    api.patch("/api/tasks/" + task.id, { title: task.title, date: task.date, est: task.est }).catch(syncFailed);
  }
  $("edit-dialog").close();
});

$("edit-cancel").addEventListener("click", () => $("edit-dialog").close());


// ---------- Dashboard ----------
const STICKERS = ["st-star", "st-heart", "st-flower", "st-cloud", "st-moon", "st-sparkle"];
const RING_SMALL = 2 * Math.PI * 52;
const RING_BIG = 2 * Math.PI * 110;

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Hi night owl" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return settings.name ? `${part}, ${settings.name}!` : `${part}!`;
}

function renderDashboard() {
  $("greeting").textContent = greeting();
  $("today-date").textContent =
    new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const todays = tasks.filter(t => t.date === todayKey()).sort(taskSort);
  const list = $("today-list");
  list.innerHTML = "";

  if (todays.length === 0) {
    const li = document.createElement("li");
    li.appendChild(emptyEl("Nothing planned yet", "Add a task for today in the Planner.", "st-cloud"));
    list.appendChild(li);
  }
  todays.forEach(t => list.appendChild(taskRow(t, false)));

  renderProgress();
  renderSessionCard();
  renderStickerRow();
}

function cheerText(percent) {
  if (focus && focus.status === "focusing") return "Shh... Mochi is cheering quietly.";
  if (percent >= 100) return "Goal reached! You're amazing!";
  if (percent >= 50) return "More than halfway there!";
  if (percent > 0) return "Nice start. Keep going!";
  return "Ready when you are!";
}

// Today's progress: saved sessions plus the session that is running now
function renderProgress() {
  const todays = tasks.filter(t => t.date === todayKey());
  const doneCount = todays.filter(t => t.done).length;

  const savedMs = todaysSessions().reduce((sum, s) => sum + s.focusedMs, 0);
  const focusedMs = savedMs + (focus ? focus.focusedMs : 0);
  const goalMs = settings.goalMin * 60000;
  const percent = Math.min(100, Math.round(focusedMs / goalMs * 100));

  $("progress-focused").textContent = formatDuration(focusedMs);
  $("progress-goal").textContent = `of your ${formatDuration(goalMs)} goal`;
  $("progress-percent").textContent = percent + "%";
  $("progress-ring").style.strokeDashoffset = RING_SMALL * (1 - percent / 100);
  $("progress-tasks").textContent = `Tasks done: ${doneCount} of ${todays.length}`;
  $("progress-sessions").textContent =
    `Focus sessions today: ${todaysSessions().length + (focus && focus.focusedMs > 0 ? 1 : 0)}`;
  $("cheer").textContent = cheerText(percent);
}

function renderSessionCard() {
  let text = "No session running.";
  if (focus) text = `${statusText()}, ${formatClock(focus.targetMs - focus.focusedMs)} left`;
  else if (breakEnd) text = `Break time, ${formatClock(breakEnd - Date.now())} left`;
  $("session-status").textContent = text;
}

// One sticker for every focus block you finish today
function renderStickerRow() {
  const box = $("sticker-row");
  const count = todaysSessions().length;

  if (count === 0) {
    box.innerHTML = '<p class="muted small">Finish a focus block to earn your first sticker!</p>';
    return;
  }

  let html = "";
  for (let i = 0; i < Math.min(count, 18); i++) {
    html += `<svg class="sticker earned" style="--r:${(i % 5 - 2) * 7}deg" aria-hidden="true"><use href="#${STICKERS[i % STICKERS.length]}"/></svg>`;
  }
  box.innerHTML = html;
}


// ---------- Sensors (camera, screen, microphone) ----------
const sensors = {
  cam: null, screen: null, mic: null,
  audioCtx: null, analyser: null, buf: null,
  timers: [],
  prevCam: null, prevScreen: null,
  lastSeen: 0, seenStreak: 0,
  detector: null, method: "",
  level: 0
};

// A small hidden canvas used to compare video frames
const canvas = document.createElement("canvas");
canvas.width = 48;
canvas.height = 36;
const cctx = canvas.getContext("2d", { willReadFrequently: true });

// How much did the picture change since last time? (0 = nothing moved)
function frameDiff(video, key) {
  cctx.drawImage(video, 0, 0, 48, 36);
  const data = cctx.getImageData(0, 0, 48, 36).data;
  const gray = new Uint8Array(48 * 36);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  }
  const prev = sensors[key];
  sensors[key] = gray;
  if (!prev) return 0;

  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prev[i]);
  return sum / gray.length;
}

function sensorError(kind, e) {
  if (e && e.message === "unsupported") return `${kind} isn't supported in this browser.`;
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
    return kind === "Screen sharing"
      ? "Screen sharing wasn't started. Pick a screen or window when your browser asks."
      : `${kind} is blocked. Allow it in your browser's site settings.`;
  }
  if (e && e.name === "NotFoundError") return `No ${kind.toLowerCase()} was found on this device.`;
  return `${kind} couldn't start.`;
}

async function startSensors() {
  const problems = [];

  // Screen first: the picker needs a fresh click
  if ($("use-screen").checked) {
    try { await startScreen(); } catch (e) { problems.push(sensorError("Screen sharing", e)); }
  }
  if ($("use-camera").checked) {
    try { await startCamera(); } catch (e) { problems.push(sensorError("Camera", e)); }
  }
  if ($("use-mic").checked) {
    try { await startMic(); } catch (e) { problems.push(sensorError("Microphone", e)); }
  }

  $("sensor-message").textContent = problems.join(" ");
}

async function startScreen() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error("unsupported");

  sensors.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });

  // If you stop sharing from the browser's own bar
  sensors.screen.getVideoTracks()[0].addEventListener("ended", () => {
    stopScreen();
    if (focus) {
      updateHidden();
      applyStatus(Date.now());
      renderFocus();
    }
  });

  const video = $("screen-video");
  video.srcObject = sensors.screen;
  video.hidden = false;
  await video.play().catch(() => {});

  sensors.prevScreen = null;
  sensors.timers.push(setInterval(sampleScreen, 2000));
}

function stopScreen() {
  if (sensors.screen) sensors.screen.getTracks().forEach(t => t.stop());
  sensors.screen = null;
  $("screen-video").srcObject = null;
  $("screen-video").hidden = true;
}

function sampleScreen() {
  const video = $("screen-video");
  if (!focus || !sensors.screen || video.readyState < 2 || focus.status !== "focusing") return;

  focus.scrTotal++;
  if (frameDiff(video, "prevScreen") > 0.25) focus.scrAct++;
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("unsupported");

  sensors.cam = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: "user" },
    audio: false
  });

  const video = $("cam-video");
  video.srcObject = sensors.cam;
  video.hidden = false;
  await video.play().catch(() => {});

  // Use real face detection if the browser has it, otherwise detect movement
  sensors.detector = null;
  if ("FaceDetector" in window) {
    try { sensors.detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); } catch (e) {}
  }
  sensors.method = sensors.detector ? "face detection" : "motion detection";

  sensors.lastSeen = Date.now();
  sensors.seenStreak = 3;
  sensors.prevCam = null;
  sensors.timers.push(setInterval(sampleCamera, 1000));
}

function stopCamera() {
  if (sensors.cam) sensors.cam.getTracks().forEach(t => t.stop());
  sensors.cam = null;
  $("cam-video").srcObject = null;
  $("cam-video").hidden = true;
}

async function sampleCamera() {
  const video = $("cam-video");
  if (!focus || !sensors.cam || video.readyState < 2) return;

  let seen;
  if (sensors.detector) {
    try {
      seen = (await sensors.detector.detect(video)).length > 0;
    } catch (e) {
      sensors.detector = null;
      sensors.method = "motion detection";
      return;
    }
  } else {
    seen = frameDiff(video, "prevCam") > 1.2;
  }

  if (!focus || focus.status === "starting") return;

  const now = Date.now();
  if (seen) { sensors.lastSeen = now; sensors.seenStreak++; } else { sensors.seenStreak = 0; }

  const present = now - sensors.lastSeen < Number($("away-sec").value) * 1000;
  focus.presTotal++;
  if (present) focus.presOk++;

  if (!present && !focus.away) {
    focus.away = true;
    applyStatus(now);
    renderFocus();
  } else if (present && focus.away && sensors.seenStreak >= 2) {
    focus.away = false;
    applyStatus(now);
    renderFocus();
  }
}

async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("unsupported");

  sensors.mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  sensors.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = sensors.audioCtx.createMediaStreamSource(sensors.mic);
  sensors.analyser = sensors.audioCtx.createAnalyser();
  sensors.analyser.fftSize = 1024;
  source.connect(sensors.analyser);
  sensors.buf = new Uint8Array(sensors.analyser.fftSize);

  $("mic-wrap").hidden = false;
  sensors.timers.push(setInterval(sampleMic, 250));
}

function stopMic() {
  if (sensors.mic) sensors.mic.getTracks().forEach(t => t.stop());
  if (sensors.audioCtx) sensors.audioCtx.close().catch(() => {});
  sensors.mic = null;
  sensors.audioCtx = null;
  sensors.analyser = null;
  sensors.level = 0;
  $("mic-wrap").hidden = true;
}

function sampleMic() {
  if (!sensors.analyser) return;

  sensors.analyser.getByteTimeDomainData(sensors.buf);
  let sum = 0;
  for (let i = 0; i < sensors.buf.length; i++) {
    const x = (sensors.buf[i] - 128) / 128;
    sum += x * x;
  }
  const rms = Math.sqrt(sum / sensors.buf.length);
  const db = 20 * Math.log10(rms || 0.0001);
  sensors.level = Math.max(0, Math.min(100, Math.round((db + 60) / 60 * 100)));

  $("mic-bar").style.width = sensors.level + "%";
  $("mic-bar").classList.toggle("loud", sensors.level > 60);

  if (focus && focus.status === "focusing") {
    focus.noiseSum += sensors.level;
    focus.noiseN++;
  }
}

function stopSensors() {
  sensors.timers.forEach(clearInterval);
  sensors.timers = [];
  stopCamera();
  stopScreen();
  stopMic();
}

// Leaving the tab pauses the clock (depending on your setting)
function updateHidden() {
  if (!focus) return;
  const rule = settings.tabLeave;
  focus.hidden = document.hidden && (rule === "pause" || (rule === "unlessScreen" && !sensors.screen));
}

// Remember which sensors you picked (kept on this device only)
const savedPrefs = store.get("sensorPrefs", {});
const SENSOR_INPUTS = ["use-camera", "use-screen", "use-mic", "away-sec"];

function loadSensorPrefs() {
  SENSOR_INPUTS.forEach(id => {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!savedPrefs[id];
    else el.value = savedPrefs[id] || "30";
  });
}

SENSOR_INPUTS.forEach(id => {
  const el = $(id);
  el.addEventListener("change", () => {
    savedPrefs[id] = el.type === "checkbox" ? el.checked : el.value;
    store.set("sensorPrefs", savedPrefs);
  });
});


// ---------- Focus Room ----------
// "focus" is null when no session is running. While a session runs it holds:
//   focusedMs  time that counts
//   pausedMs   time that does not count
let focus = null;
let breakEnd = 0;     // when the current break ends (0 = no break)

function renderFocusTasks() {
  const select = $("focus-task");
  const previous = select.value;

  select.innerHTML = '<option value="">No task (open focus)</option>';

  tasks
    .filter(t => !t.done)
    .sort((a, b) => (a.date === todayKey() ? 0 : 1) - (b.date === todayKey() ? 0 : 1))
    .forEach(t => {
      const option = document.createElement("option");
      option.value = t.id;
      option.textContent = t.title + (t.date === todayKey() ? " (today)" : "");
      select.appendChild(option);
    });

  select.value = previous;
  if (select.selectedIndex === -1) select.selectedIndex = 0;
}

function statusText() {
  if (focus.status === "starting") return "Waiting for permission prompts...";
  if (focus.status === "focusing") return "Focusing";
  if (focus.manualPause) return focus.note || "Paused by you";
  if (focus.hidden) return "Paused: you left this tab";
  if (focus.away) return "Paused: no one at the desk";
  return "Paused";
}

// Decide whether the clock should be running, and record when focus starts/stops
function applyStatus(now) {
  if (focus.status === "starting") return;

  const next = (focus.manualPause || focus.hidden || focus.away) ? "paused" : "focusing";
  if (next === focus.status) return;

  if (focus.status === "focusing") {
    if (focus.segStart) {
      focus.segs.push([focus.segStart, now]);
      focus.segStart = null;
    }
    // Remember why it paused, for the analytics page
    if (focus.manualPause) focus.pauses[focus.note ? "sleep" : "manual"]++;
    else if (focus.hidden) focus.pauses.tab++;
    else focus.pauses.away++;
  }

  if (next === "focusing") focus.segStart = now;
  focus.status = next;
}

async function startFocus() {
  if (focus || breakEnd) return;

  const minutes = Math.min(600, Math.max(1, Number($("focus-min").value) || 25));
  const now = Date.now();

  const mine = focus = {
    taskId: $("focus-task").value,
    targetMs: minutes * 60000,
    focusedMs: 0,
    pausedMs: 0,
    manualPause: false,
    hidden: false,
    away: false,
    note: "",
    status: "starting",     // no time is counted until the permission prompts are done
    segs: [],               // the periods you were really focusing
    segStart: null,
    pauses: { manual: 0, tab: 0, away: 0, sleep: 0 },
    presOk: 0, presTotal: 0,
    noiseSum: 0, noiseN: 0,
    scrAct: 0, scrTotal: 0,
    startedAt: now,
    lastTick: now
  };

  $("focus-message").textContent = "";
  $("sensor-message").textContent = "";
  renderFocus();

  await startSensors();

  // You may have pressed End while the prompts were open
  if (focus !== mine) {
    stopSensors();
    return;
  }

  focus.startedAt = Date.now();
  focus.lastTick = Date.now();
  focus.status = "paused";      // applyStatus switches it to "focusing" if nothing blocks it
  updateHidden();
  applyStatus(Date.now());
  renderFocus();
}

function tick() {
  // Break countdown (never counted as focus)
  if (breakEnd) {
    const left = breakEnd - Date.now();
    if (left <= 0) endBreak(true);
    else {
      $("break-time").textContent = formatClock(left);
      renderSessionCard();
    }
  }

  if (!focus) return;

  const now = Date.now();
  const dt = now - focus.lastTick;
  focus.lastTick = now;

  if (focus.status === "starting") return;

  // A long gap while the tab is visible means the computer went to sleep
  if (dt > 15000 && !document.hidden) {
    if (focus.status === "focusing") {
      focus.manualPause = true;
      focus.note = "Paused: your device went to sleep";
      applyStatus(now - dt);
    }
    renderFocus();
    return;
  }

  if (focus.status === "focusing") focus.focusedMs += dt;
  else focus.pausedMs += dt;

  if (focus.focusedMs >= focus.targetMs) {
    finishFocus(true);
    return;
  }
  renderFocus();
}

function finishFocus(completed) {
  const now = Date.now();
  if (focus.segStart) focus.segs.push([focus.segStart, now]);

  const f = focus;
  focus = null;
  f.focusedMs = Math.min(f.focusedMs, f.targetMs);

  const used = { camera: !!sensors.cam, screen: !!sensors.screen, mic: !!sensors.mic };
  stopSensors();

  if (f.focusedMs >= 10000) {
    const rec = {
      id: newId(),
      taskId: f.taskId,
      start: f.startedAt,
      end: now,
      focusedMs: f.focusedMs,
      pausedMs: f.pausedMs,
      planned: f.targetMs,
      segs: f.segs,
      pauses: f.pauses,
      completed,
      sensors: used,
      noiseAvg: f.noiseN ? Math.round(f.noiseSum / f.noiseN) : null,
      screenActive: f.scrTotal ? Math.round(100 * f.scrAct / f.scrTotal) : null,
      presence: f.presTotal ? Math.round(100 * f.presOk / f.presTotal) : null
    };

    sessions.push(rec);

    // The server adds this to the task too; we do the same here so the screen updates at once
    const task = tasks.find(t => t.id === f.taskId);
    if (task) task.focusedMs = (task.focusedMs || 0) + f.focusedMs;

    queueSession(rec);

    $("focus-message").textContent =
      `${completed ? "Block complete" : "Session saved"}: ${formatDuration(f.focusedMs)} focused.`;
  } else {
    $("focus-message").textContent = "Under 10 seconds of focus, so nothing was saved.";
  }

  if (completed) {
    beep();
    confetti();
    if (settings.breakMin > 0) breakEnd = Date.now() + settings.breakMin * 60000;
  }

  renderAll();
  renderFocus();
}

function endBreak(fromTimer) {
  breakEnd = 0;
  if (fromTimer) {
    beep();
    toast("Break's over. Ready for the next block?");
  }
  renderFocus();
}

function renderFocus() {
  const onBreak = breakEnd > 0;

  $("focus-setup").hidden = !!focus || onBreak;
  $("focus-run").hidden = !focus;
  $("focus-break").hidden = !onBreak;

  setMood(moodNow());
  renderProgress();
  renderSessionCard();

  if (onBreak) $("break-time").textContent = formatClock(breakEnd - Date.now());

  if (!focus) {
    document.title = onBreak ? "Break time — Cadence" : "Cadence — cozy focus planner";
    return;
  }

  const task = tasks.find(t => t.id === focus.taskId);
  const left = focus.targetMs - focus.focusedMs;

  $("focus-task-name").textContent = task ? task.title : "Open focus";
  $("focus-time").textContent = formatClock(left);
  $("focus-state").textContent = statusText();
  $("ring-prog").style.strokeDashoffset = RING_BIG * (1 - Math.min(1, focus.focusedMs / focus.targetMs));
  $("focus-focused").textContent = formatDuration(focus.focusedMs);
  $("focus-paused").textContent = formatDuration(focus.pausedMs);
  $("focus-pause").textContent = focus.manualPause ? "Resume" : "Pause";
  $("focus-pause").disabled = focus.status === "starting";

  // One line summarising what the sensors see
  const parts = [];
  if (sensors.cam) parts.push(`Camera (${sensors.method}): ${focus.away ? "no one seen" : "present"}`);
  if (sensors.screen) parts.push(`Screen: sharing${focus.scrTotal ? ", " + Math.round(100 * focus.scrAct / focus.scrTotal) + "% active" : ""}`);
  if (sensors.mic) parts.push(`Room: ${sensors.level > 60 ? "noisy" : "quiet enough"}`);
  $("sensor-status").textContent = parts.join("  |  ");

  document.title = `${formatClock(left)} ${statusText()} — Cadence`;
}

// Buttons
$("focus-start").addEventListener("click", startFocus);

$("focus-pause").addEventListener("click", () => {
  if (!focus || focus.status === "starting") return;
  tick();                         // count everything up to this moment first
  if (!focus) return;
  focus.manualPause = !focus.manualPause;
  focus.note = "";
  applyStatus(Date.now());
  renderFocus();
});

$("focus-end").addEventListener("click", () => {
  if (!focus) return;
  tick();
  if (focus) finishFocus(false);
});

$("break-skip").addEventListener("click", () => endBreak(false));

document.querySelectorAll(".chips button").forEach(button => {
  button.addEventListener("click", () => {
    $("focus-min").value = button.dataset.min;
  });
});

// Leaving the tab pauses the clock (depending on your setting); coming back resumes it
document.addEventListener("visibilitychange", () => {
  if (!focus) return;
  tick();
  if (!focus) return;
  updateHidden();
  applyStatus(Date.now());
  renderFocus();
});

// Warn before closing the tab in the middle of a session
window.addEventListener("beforeunload", e => {
  if (focus) {
    e.preventDefault();
    e.returnValue = "";
  }
});

setInterval(tick, 250);


// ---------- Analytics ----------
let anaRange = 7;

// Share a focused period across the hours of the day it covers
function addHours(arr, a, b) {
  while (a < b) {
    const d = new Date(a);
    const next = new Date(d);
    next.setMinutes(0, 0, 0);
    next.setHours(d.getHours() + 1);
    const end = Math.min(b, next.getTime());
    arr[d.getHours()] += end - a;
    a = end;
  }
}

function chartSVG(days, totals, goalMs) {
  const W = 720, H = 230, pl = 40, pr = 8, pt = 12, pb = 28;
  const maxH = Math.max(1, Math.ceil(Math.max(goalMs, ...totals) * 1.1 / 3600000));
  const y = ms => pt + (H - pt - pb) * (1 - ms / (maxH * 3600000));
  const slot = (W - pl - pr) / days.length;
  const bw = Math.min(40, slot * 0.66);

  let grid = "", bars = "", labels = "";
  const step = Math.max(1, Math.ceil(maxH / 4));

  for (let h = 0; h <= maxH; h += step) {
    const yy = y(h * 3600000);
    grid += `<line class="gridline" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/>` +
            `<text class="axis" x="${pl - 8}" y="${yy + 4}" text-anchor="end">${h}h</text>`;
  }

  days.forEach((d, i) => {
    const x = pl + slot * i + (slot - bw) / 2;
    const isToday = d.toLocaleDateString("en-CA") === todayKey();
    const yy = y(totals[i]);

    if (totals[i] > 0) {
      bars += `<rect class="bar-fill${isToday ? " today" : ""}" x="${x}" y="${yy}" width="${bw}" ` +
              `height="${Math.max(3, H - pb - yy)}" rx="6"><title>${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}: ${formatDuration(totals[i])}</title></rect>`;
    }
    if (days.length <= 7 || i % 5 === 0 || isToday) {
      const label = days.length <= 7 ? d.toLocaleDateString([], { weekday: "short" }) : d.getDate();
      labels += `<text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${label}</text>`;
    }
  });

  const gy = y(goalMs);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Focused time per day compared with your daily goal">` +
         `${grid}${bars}<line class="goal-line" x1="${pl}" x2="${W - pr}" y1="${gy}" y2="${gy}"/>${labels}</svg>`;
}

function renderAnalytics() {
  const body = $("analytics-body");
  const goalMs = settings.goalMin * 60000;

  document.querySelectorAll(".range-chips button").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.range) === anaRange);
  });

  const hasSample = sessions.some(s => s.sample) || tasks.some(t => t.sample);

  if (sessions.length === 0) {
    body.innerHTML = `
      <div class="panel">
        <svg class="sticker" aria-hidden="true"><use href="#st-cloud"/></svg>
        <p>No focus sessions yet. Finish a block in the Focus Room and your numbers will show up here.</p>
        <p class="muted">Want to see how this page looks first?</p>
        <button data-act="add-sample">Add sample data</button>
      </div>`;
    return;
  }

  // The days in the chosen range, oldest first
  const days = [];
  for (let i = anaRange - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  const firstTs = days[0].getTime();
  const inRange = sessions.filter(s => s.start >= firstTs);

  const totals = days.map(d => {
    const key = d.toLocaleDateString("en-CA");
    let ms = sessions.filter(s => dayKeyOf(s.start) === key).reduce((a, s) => a + s.focusedMs, 0);
    if (focus && key === todayKey()) ms += focus.focusedMs;
    return ms;
  });

  const total = totals.reduce((a, b) => a + b, 0);
  const longest = inRange.reduce((m, s) => Math.max(m, s.focusedMs), 0);
  const quality = inRange.length
    ? Math.round(inRange.reduce((a, s) => a + s.focusedMs / Math.max(1, s.focusedMs + s.pausedMs), 0) / inRange.length * 100)
    : 0;
  const daysAtGoal = totals.filter(t => t >= goalMs).length;

  // Time by task
  const byTask = {};
  inRange.forEach(s => { byTask[s.taskId || ""] = (byTask[s.taskId || ""] || 0) + s.focusedMs; });
  const taskRows = Object.entries(byTask).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topMs = taskRows.length ? taskRows[0][1] : 1;
  const taskName = id => {
    if (!id) return "Open focus (no task)";
    const t = tasks.find(x => x.id === id);
    return t ? t.title : "Deleted task";
  };

  // Best hours
  const hours = new Array(24).fill(0);
  inRange.forEach(s => (s.segs || []).forEach(([a, b]) => addHours(hours, a, b)));
  const hMax = Math.max(...hours, 1);
  const bestHour = hours.indexOf(hMax);

  // Interruptions
  const pz = { manual: 0, tab: 0, away: 0, sleep: 0 };
  let pausedTotal = 0;
  inRange.forEach(s => {
    Object.keys(pz).forEach(k => { pz[k] += (s.pauses && s.pauses[k]) || 0; });
    pausedTotal += s.pausedMs;
  });

  const recent = [...sessions].sort((a, b) => b.start - a.start).slice(0, 8);

  body.innerHTML = `
    <dl class="stats">
      <div><dt>Focused in total</dt><dd>${formatDuration(total)}</dd></div>
      <div><dt>Daily average</dt><dd>${formatDuration(total / anaRange)}</dd></div>
      <div><dt>Sessions</dt><dd>${inRange.length}</dd></div>
      <div><dt>Longest session</dt><dd>${formatDuration(longest)}</dd></div>
      <div><dt>Focus quality</dt><dd>${quality}%</dd></div>
      <div><dt>Days at goal</dt><dd>${daysAtGoal} of ${anaRange}</dd></div>
    </dl>

    <div class="chart-box">
      <h3>Focused time per day</h3>
      ${chartSVG(days, totals, goalMs)}
      <p class="muted small">The dashed line is your ${formatDuration(goalMs)} daily goal.</p>
    </div>

    <div class="two-col">
      <div>
        <h3>Where the time went</h3>
        <div class="hbars">
          ${taskRows.map(([id, ms]) => `
            <div class="hbar-row">
              <span>${esc(taskName(id))}</span><strong>${formatDuration(ms)}</strong>
              <div class="hbar-track"><div style="width:${ms / topMs * 100}%"></div></div>
            </div>`).join("") || '<p class="muted">Nothing in this range.</p>'}
        </div>
      </div>

      <div>
        <h3>When you focus best</h3>
        <div class="hours">
          ${hours.map((v, h) => `<i style="opacity:${v ? 0.2 + 0.8 * v / hMax : 0.1}" title="${String(h).padStart(2, "0")}:00, ${formatDuration(v)}"></i>`).join("")}
        </div>
        <div class="hour-labels"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
        <p class="muted small">${hMax > 1 ? `Your strongest hour is ${String(bestHour).padStart(2, "0")}:00.` : ""}</p>
      </div>
    </div>

    <div class="two-col">
      <div>
        <h3>Interruptions</h3>
        <dl class="facts">
          <dt>Left the tab</dt><dd>${pz.tab}</dd>
          <dt>Away from the desk</dt><dd>${pz.away}</dd>
          <dt>Paused by you</dt><dd>${pz.manual}</dd>
          <dt>Device sleep</dt><dd>${pz.sleep}</dd>
          <dt>Paused time, not counted</dt><dd>${formatDuration(pausedTotal)}</dd>
        </dl>
      </div>
    </div>

    <h3>Recent sessions</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Task</th><th>Focused</th><th>Paused</th><th>Quality</th></tr></thead>
        <tbody>
          ${recent.map(s => `
            <tr>
              <td>${new Date(s.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
              <td>${esc(taskName(s.taskId))}</td>
              <td>${formatDuration(s.focusedMs)}</td>
              <td>${formatDuration(s.pausedMs)}</td>
              <td>${Math.round(s.focusedMs / Math.max(1, s.focusedMs + s.pausedMs) * 100)}%</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    ${hasSample ? '<p style="margin-top:18px"><button data-act="remove-sample">Remove sample data</button></p>' : ""}
  `;
}

document.querySelectorAll(".range-chips button").forEach(b => {
  b.addEventListener("click", () => {
    anaRange = Number(b.dataset.range);
    renderAnalytics();
  });
});

$("analytics-body").addEventListener("click", e => {
  if (e.target.dataset.act === "add-sample") addSample();
  if (e.target.dataset.act === "remove-sample") removeSample();
});


// ---------- Sample data ----------
// Two weeks of made-up tasks and sessions, so you can explore the charts
async function addSample() {
  const names = ["Draft proposal", "Review pull requests", "Study chapter 5", "Write weekly report", "Plan next sprint", "Read research paper"];
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const now = Date.now();

  const newTasks = [];
  const newSessions = [];

  for (let off = -13; off <= 0; off++) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + off);

    const dayTasks = [];
    for (let i = 0; i < 2; i++) {
      const t = {
        id: newId(),
        title: pick(names),
        date: day.toLocaleDateString("en-CA"),
        est: pick([25, 45, 60]),
        done: off < 0,
        focusedMs: 0,
        sample: true
      };
      newTasks.push(t);
      dayTasks.push(t);
    }

    let hour = 8 + Math.floor(Math.random() * 2);
    const count = off === 0 ? 1 : 2 + Math.floor(Math.random() * 3);

    for (let i = 0; i < count; i++) {
      const start = new Date(day);
      start.setHours(hour, pick([0, 15, 30]), 0, 0);

      const focusedMs = pick([20, 25, 35, 45]) * 60000;
      const pausedMs = Math.random() > 0.5 ? pick([1, 2, 4]) * 60000 : 0;
      const s0 = start.getTime();
      const end = s0 + focusedMs + pausedMs;
      if (end > now) break;

      const cut = Math.floor(focusedMs * 0.55);
      const segs = pausedMs ? [[s0, s0 + cut], [s0 + cut + pausedMs, end]] : [[s0, end]];
      const task = pick(dayTasks);
      task.focusedMs += focusedMs;

      newSessions.push({
        id: newId(),
        taskId: task.id,
        start: s0,
        end,
        focusedMs,
        pausedMs,
        planned: focusedMs,
        segs,
        pauses: { manual: pausedMs ? 1 : 0, tab: 0, away: 0, sleep: 0 },
        completed: true,
        sensors: {},
        sample: true
      });
      hour += 2 + Math.floor(Math.random() * 2);
    }
  }

  try {
    await api.post("/api/bulk", { tasks: newTasks, sessions: newSessions });
    tasks.push(...newTasks);
    sessions.push(...newSessions);
    renderAll();
    toast("Sample data added");
  } catch (err) {
    toast("Couldn't add sample data: " + err.message);
  }
}

async function removeSample() {
  try {
    await api.remove("/api/samples");
    tasks = tasks.filter(t => !t.sample);
    sessions = sessions.filter(s => !s.sample);
    renderAll();
    toast("Sample data removed");
  } catch (err) {
    toast("Couldn't remove sample data: " + err.message);
  }
}

$("data-sample").addEventListener("click", addSample);


// ---------- Backup, restore, erase ----------
$("data-export").addEventListener("click", () => {
  const data = {
    version: 2,
    exportedAt: new Date().toISOString(),
    tasks,
    sessions,
    settings
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cadence-backup-" + todayKey() + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  toast("Backup downloaded");
});

$("data-import").addEventListener("click", () => $("data-file").click());

$("data-file").addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.sessions)) throw new Error("not a backup");

      // The server checks everything and replaces your data in one step
      const result = await api.post("/api/data/import", {
        tasks: d.tasks,
        sessions: d.sessions,
        settings: d.settings || {}
      });

      tasks = result.tasks;
      sessions = result.sessions;
      replaceSettings(result.settings);

      applySettings();
      fillSettings();
      renderAll();
      toast("Backup imported");
    } catch (err) {
      toast(err instanceof SyntaxError || err.message === "not a backup"
        ? "That file doesn't look like a Cadence backup"
        : "Couldn't import: " + err.message);
    }
  };
  reader.readAsText(file);
});

let eraseArmed = false;

$("data-erase").addEventListener("click", async e => {
  const button = e.currentTarget;

  // Ask twice so nothing is erased by accident
  if (!eraseArmed) {
    eraseArmed = true;
    button.textContent = "Click again to erase everything";
    setTimeout(() => { eraseArmed = false; button.textContent = "Erase everything"; }, 4000);
    return;
  }

  eraseArmed = false;
  button.textContent = "Erase everything";

  if (focus) {
    toast("Finish your focus session first.");
    return;
  }

  try {
    await api.remove("/api/data");
  } catch (err) {
    toast("Couldn't erase: " + err.message);
    return;
  }

  breakEnd = 0;
  tasks = [];
  sessions = [];
  replaceSettings({});
  store.remove(pendingKey());

  applySettings();
  fillSettings();
  renderAll();
  renderFocus();
  toast("Everything was erased");
});


// ---------- Account: log in, create account, log out ----------
let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  $("tab-login").setAttribute("aria-pressed", String(mode === "login"));
  $("tab-register").setAttribute("aria-pressed", String(mode === "register"));
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("auth-hint").hidden = mode === "login";
  $("auth-error").textContent = "";
}

function showAuth(message) {
  currentUser = null;
  breakEnd = 0;
  tasks = [];
  sessions = [];
  replaceSettings({});
  applySettings();

  $("app").hidden = true;
  $("auth-screen").hidden = false;
  $("auth-error").textContent = message || "";
  $("auth-password").value = "";
  setMood("happy");
  document.title = "Cadence — cozy focus planner";
}

function handleSessionExpired() {
  if (!currentUser) return;
  if (focus) {
    toast("Your login expired. Your session will be saved when you log in again.");
    return;
  }
  showAuth("Your login expired. Please log in again.");
}

async function enterApp(user) {
  currentUser = user;
  $("account-email").textContent = user.email;
  $("side-email").textContent = user.email;

  try {
    await loadAll();
  } catch (err) {
    if (currentUser) toast(err.offline ? "Can't reach the server right now." : err.message);
  }
  if (!currentUser) return;      // we were sent back to the login screen

  $("auth-screen").hidden = true;
  $("app").hidden = false;
  showPage();
  renderAll();
  renderFocus();
}

async function logout() {
  if (focus) {
    toast("Finish or end your focus session first.");
    return;
  }
  try { await api.post("/api/auth/logout"); } catch (e) {}
  showAuth("");
}

$("tab-login").addEventListener("click", () => setAuthMode("login"));
$("tab-register").addEventListener("click", () => setAuthMode("register"));

$("auth-form").addEventListener("submit", async e => {
  e.preventDefault();

  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;

  $("auth-error").textContent = "";
  $("auth-submit").disabled = true;

  try {
    const url = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const result = await api.post(url, { email, password });
    $("auth-password").value = "";
    await enterApp(result.user);
  } catch (err) {
    $("auth-error").textContent = err.offline ? "Can't reach the server. Is it running?" : err.message;
  } finally {
    $("auth-submit").disabled = false;
  }
});

document.querySelectorAll(".js-logout").forEach(button => button.addEventListener("click", logout));


// ---------- Draw everything ----------
function renderAll() {
  renderTasks();
  renderDashboard();
  renderFocusTasks();
  renderAnalytics();
}


// ---------- Start ----------
(async function boot() {
  applySettings();
  loadSensorPrefs();
  $("task-date").value = todayKey();
  showPage();
  setAuthMode("login");

  try {
    const result = await api.get("/api/auth/me");
    await enterApp(result.user);
  } catch (err) {
    showAuth(err.offline ? "Can't reach the server. Is it running?" : "");
  }
})();