import { MongoClient } from "mongodb";
import crypto from "crypto";
import axios from "axios";
import qs from "querystring";

export default async function handler(req, res) {
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

    // Mongo connect
    const mongoClient = new MongoClient(process.env.MONGODB_URI, {
      ssl: true,
      serverSelectionTimeoutMS: 15000,
    });
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DBNAME || "ghlApp");
    const accountsCollection = db.collection("accounts");

    console.log("✅ Mongo connected");

    const data = req.body;
    console.log("➡️ BODY:", data);

    const locationId = data.locationId;
    if (!locationId) {
      return res.status(400).json({ error: "Missing locationId." });
    }

    const account = await accountsCollection.findOne({ locationId });
    console.log("✅ Account:", account);

    if (!account) {
      return res.status(404).json({ error: "Location not found in DB." });
    }

    const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET;
    const SALT = process.env.ENCRYPT_SALT;

    if (!ENCRYPT_SECRET || !SALT) {
      return res.status(500).json({ error: "Missing ENCRYPT_SECRET or ENCRYPT_SALT" });
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

    let accessToken, refreshToken;

    try {
      accessToken = decrypt(account.accessTokenEncrypted);
      refreshToken = decrypt(account.refreshTokenEncrypted);
    } catch (e) {
      console.error("❌ Decrypt error:", e?.message || e);
      return res.status(500).json({ error: "Decrypt error", details: e?.message || e });
    }

    console.log("✅ AccessToken:", accessToken?.substring(0,10), "...");
    console.log("✅ RefreshToken:", refreshToken?.substring(0,10), "...");

    const now = new Date();
    const updatedAt = new Date(account.updatedAt);
    const hoursPassed = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);

    if (hoursPassed > 24) {
      console.log("🔄 Refreshing token...");

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
      console.log("✅ New access token:", accessToken?.substring(0,10), "...");

      await accountsCollection.updateOne(
        { locationId },
        {
          $set: {
            accessTokenEncrypted: encrypt(accessToken),
            refreshTokenEncrypted: encrypt(tokenResponse.data.refresh_token),
            updatedAt: new Date(),
          },
        }
      );
    }

    const mappedFields = {};
    for (const [fieldName, value] of Object.entries(data)) {
      if (!value || value.trim() === "") continue;

      const fieldKey = `{{ custom_values.${camelToSnake(fieldName)} }}`;
      console.log(`[MAP CHECK] ${fieldName} → ${fieldKey}`);

      if (account.fieldMappings?.[fieldKey]) {
        mappedFields[account.fieldMappings[fieldKey]] = value;
        console.log(`[MAP OK] ${fieldName} → ${account.fieldMappings[fieldKey]}`);
      } else {
        console.log(`[SKIP] No mapping for ${fieldName}`);
      }
    }

    if (Object.keys(mappedFields).length === 0) {
      return res.status(400).json({
        error: "No mapped fields found to update.",
      });
    }

    const patchPayload = {
      customValues: Object.entries(mappedFields).map(
        ([id, value]) => ({
          id,
          value,
        })
      ),
    };

    console.log("[PATCH PAYLOAD]:", patchPayload);

    const patchResponse = await axios.patch(
      `https://services.leadconnectorhq.com/locations/${locationId}/customValues`,
      patchPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
        },
      }
    );

    console.log("✅ PATCH RESPONSE:", patchResponse.data);

    return res.status(200).json({
      message: "All good!",
      patchResponse: patchResponse.data,
    });

  } catch (err) {
    console.error("[API] ❌ Caught error:", err?.message || err);
    return res.status(500).json({ error: err?.message || err });
  }
}

function camelToSnake(str) {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase();
}

function encrypt(text) {
  const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET;
  const SALT = process.env.ENCRYPT_SALT;
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}
