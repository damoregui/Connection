const { MongoClient } = require("mongodb");
const crypto = require("crypto");
const axios = require("axios");
const qs = require("querystring");

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  ssl: true,
  serverSelectionTimeoutMS: 15000,
});

let accountsCollection;

async function connectMongo() {
  if (!accountsCollection) {
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DBNAME || "ghlApp");
    accountsCollection = db.collection("accounts");
  }
}

const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET;
const SALT = process.env.ENCRYPT_SALT;

function encrypt(text) {
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(encrypted) {
  const [ivHex, encryptedData] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encryptedData, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function camelToFieldName(camelCase) {
  return camelCase
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase());
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  await connectMongo();

  try {
    const data = req.body;
    console.log("➡️ HIT /api/submit-ghl-fields");
    console.log("[API] Received payload:", data);

    const locationId = data.locationId;
    if (!locationId) {
      return res.status(400).json({ error: "Missing locationId." });
    }

    const account = await accountsCollection.findOne({ locationId });
    if (!account) {
      return res.status(404).json({ error: "Location not found in DB." });
    }

    let accessToken = decrypt(account.accessTokenEncrypted);
    const refreshToken = decrypt(account.refreshTokenEncrypted);

    const now = new Date();
    const updatedAt = new Date(account.updatedAt);
    const hoursPassed = (now - updatedAt) / (1000 * 60 * 60);

    if (hoursPassed > 24) {
      const tokenResponse = await axios.post(
        "https://services.leadconnectorhq.com/oauth/token",
        qs.stringify({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          user_type: "Company",
          redirect_uri: process.env.REDIRECT_URI,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
        }
      );

      accessToken = tokenResponse.data.access_token;
      const newRefreshToken = tokenResponse.data.refresh_token;

      await accountsCollection.updateOne(
        { locationId },
        {
          $set: {
            accessTokenEncrypted: encrypt(accessToken),
            refreshTokenEncrypted: encrypt(newRefreshToken),
            updatedAt: new Date(),
          },
        }
      );
    }

    for (const [fieldKey, customValueId] of Object.entries(account.fieldMappings)) {
      const camelName = fieldKey
        .replace("{{ custom_values.", "")
        .replace(" }}", "");

      const value = data[camelName];
      if (!value) continue;

      const payload = {
        name: camelToFieldName(camelName),
        value,
      };

      const url = `https://services.leadconnectorhq.com/locations/${locationId}/customValues/${customValueId}`;
      console.log(`[PUT] Updating ${payload.name} (${customValueId}) with value: ${value}`);

      await axios.put(url, payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
        },
      });
    }

    res.status(200).json({ message: "✅ All custom values updated successfully." });
  } catch (err) {
    console.error("[API] ❌ Error:", err?.response?.data || err.message);
    res.status(500).json({
      error: err?.response?.data || err.message,
    });
  }
};
