export default function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 🔥 Intento usar crypto
    const crypto = require("crypto");
    const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET;
    const SALT = process.env.ENCRYPT_SALT;

    if (!ENCRYPT_SECRET || !SALT) {
      return res.status(500).json({
        error: "Missing ENCRYPT_SECRET or ENCRYPT_SALT",
      });
    }

    const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
    res.status(200).json({
      message: "Crypto works!",
      key: key.toString("hex").substring(0, 20),
    });

  } catch (err) {
    console.error("[TEST] ❌ Crypto error:", err?.message || err);
    res.status(500).json({
      error: err?.message || err,
    });
  }
}
