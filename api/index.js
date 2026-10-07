const app = require("../server");
const { connectDB } = require("../db");

module.exports = async (req, res) => {
  try {
    await connectDB();
    return app(req, res);
  } catch (err) {
    console.error("Database connection failed:", err);

    res.statusCode = 500;
    res.end("Database connection failed");
  }
};
