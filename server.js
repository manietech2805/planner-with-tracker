const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const db = require("./db");
const { router: authRouter } = require("./auth");
const apiRouter = require("./api");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(row => row.name);

  res.json({ ok: true, time: new Date().toISOString(), tables });
});

app.use("/api/auth", authRouter);
app.use("/api", apiRouter);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Catches any error so the server never shows its insides
app.use((err, req, res, next) => {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "That request wasn't valid JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "That request is too big" });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

app.listen(PORT, () => {
  console.log(`Cadence is running at http://localhost:${PORT}`);
});
