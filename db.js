require("dotenv").config();

const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is not set in .env");
}

const client = new MongoClient(uri);

let db;


async function connectDB() {
  if (db) return db;

  await client.connect();

  db = client.db(
    process.env.MONGODB_DB || "cadence"
  );

  // Create required indexes
  await db.collection("users").createIndex(
    { email: 1 },
    { unique: true }
  );

  await db.collection("tasks").createIndex(
    { user_id: 1, id: 1 },
    { unique: true }
  );

  await db.collection("sessions").createIndex(
    { user_id: 1, id: 1 },
    { unique: true }
  );

  await db.collection("settings").createIndex(
    { user_id: 1 },
    { unique: true }
  );

  console.log("MongoDB Atlas connected");

  return db;
}


function getDB() {
  if (!db) {
    throw new Error(
      "MongoDB is not connected. Call connectDB() first."
    );
  }

  return db;
}


module.exports = {
  connectDB,
  getDB
};
