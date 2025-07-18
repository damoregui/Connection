const { MongoClient } = require("mongodb");

let cachedClient = null;
let cachedDb = null;

async function connectMongo() {
  if (cachedDb) return cachedDb;

  const client = await MongoClient.connect(process.env.MONGODB_URI, {
    ssl: true,
    serverSelectionTimeoutMS: 15000,
  });

  const db = client.db(process.env.MONGODB_DBNAME || "ghlApp");

  cachedClient = client;
  cachedDb = db;

  return db;
}

module.exports = { connectMongo };