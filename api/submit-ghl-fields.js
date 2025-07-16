import { MongoClient } from "mongodb";

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    const mongoClient = new MongoClient(process.env.MONGODB_URI, {
      ssl: true,
      serverSelectionTimeoutMS: 15000,
    });

    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DBNAME || "ghlApp");
    const collections = await db.listCollections().toArray();

    return res.status(200).json({
      message: "Mongo connected OK!",
      collections: collections.map(c => c.name),
    });
  } catch (err) {
    console.error("[TEST] ❌ Mongo error:", err?.message || err);
    res.status(500).json({
      error: err?.message || err,
    });
  }
}
