import { MongoClient } from "mongodb";
import crypto from "crypto";
import axios from "axios";
import qs from "querystring";

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

function camelToSnake(str) {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase();
}

export default async function handler(req, res) {
  // ✅ CORS HEADERS
  res.setHeader("Access-Control-Allow-Origin", "https://app.gohighlevel.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    // ✅ devolver HEADERS también en OPTIONS:
    return res
      .writeHead(200, {
        "Access-Control-Allow-Origin": "https://app.gohighlevel.com",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      })
      .end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  await connectMongo();

  try {
    const data = req.body;
    console.log("➡️ HIT /api/submit-ghl-fields");
    console.log("[API] Received payload:", data);

    const locationId = data.locationId;
    if (!locationId) {
      console.log("[API] ❌ Missing locationId in payload.");
      return res.status(400).json({ error: "Missing locationId." });
    }

    const account = await accountsCollection.findOne({ locationId });

    if (!account) {
      console.log("[API] ❌ No account found for locationId:", locationId);
      return res.status(404).json({ error: "Location not found in DB." });
    }

    let accessToken = decrypt(account.accessTokenEncrypted);
    const refreshToken = decrypt(account.refreshTokenEncrypted);

    const now = new Date();
    const updatedAt = new Date(account.updatedAt);
    const hoursPassed = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);

    if (hoursPassed > 24) {
      console.log("[Token] Access token expired. Refreshing...");

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

      console.log("[Token] ✅ Token refreshed.");

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

      console.log("[Token] ✅ Mongo updated with new tokens.");
    }

    const mappedFields = {};
    for (const [fieldName, value] of Object.entries(data)) {
      if (!value || value.trim() === "") continue;

      const fieldKey = `{{ custom_values.${camelToSnake(fieldName)} }}`;

      if (account.fieldMappings[fieldKey]) {
        const customValueId = account.fieldMappings[fieldKey];
        mappedFields[customValueId] = value;
        console.log(`[MAP] ${fieldName} → ${customValueId}`);
      } else {
        console.log(`[SKIP] Field ${fieldName} not mapped in Mongo.`);
      }
    }

    if (Object.keys(mappedFields).length === 0) {
      console.log("[API] No mapped fields found to update.");
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

    console.log("[PATCH] Sending payload to GHL:", patchPayload);

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

    console.log("[API] ✅ Custom Values updated in GHL.");

    res.status(200).json({
      message: "Custom values updated successfully in GHL.",
      response: patchResponse.data,
    });
  } catch (err) {
    console.error("[API] ❌ Error processing request:", err?.response?.data || err.message);
    res.status(500).json({
      error: err?.response?.data || err.message,
    });
  }
}
