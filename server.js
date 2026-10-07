require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const { connectDB, getDB } = require("./db");
const { router: authRouter } = require("./auth");
const apiRouter = require("./api");

const app = express();

const PORT = process.env.PORT || 3000;


// Security
app.use(helmet());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);


// Middleware
app.use(express.json({
  limit: "1mb"
}));

app.use(cookieParser());


// Frontend
app.use(express.static("public"));


// Health check
app.get("/api/health", async (req, res) => {
  try {
    const database = getDB();

    await database.command({
      ping: 1
    });

    res.json({
      ok: true,
      time: new Date().toISOString(),
      database: "MongoDB"
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      error: "Database unavailable"
    });
  }
});


// Authentication
app.use("/api/auth", authRouter);


// Main API
app.use("/api", apiRouter);


// Start server
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Cadence is running at http://localhost:${PORT}`
      );
    });
  })
  .catch((err) => {
    console.error(
      "MongoDB connection failed:",
      err
    );

    process.exit(1);
  });