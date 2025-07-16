import { MongoClient } from "mongodb";
import fetch from "node-fetch";
import crypto from "crypto";
import qs from "querystring";

/* ======================
   Mongo Connection
====================== */

const mongoClient = new MongoClient(process.env.MONGODB_URI);

async function getMongoCollection() {
  if (!mongoClient.topology?.isConnected()) {
    console.log("[Mongo] Connecting to MongoDB...");
    await mongoClient.connect();
    console.log("[Mongo] MongoDB connected.");
  }
  const db = mongoClient.db(process.env.MONGODB_DBNAME || 'ghlApp');
  return db.collection('accounts');
}

/* ======================
   Encryption / Decryption
====================== */

const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || 'super-secret-password';
const SALT = 'my-salt';

function decrypt(encrypted) {
  const [ivHex, encryptedData] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encrypt(text) {
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/* ======================
   Captcha Verification
====================== */

async function verifyCaptcha(token) {
  if (!token) return false;
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${secret}&response=${token}`,
  });
  const data = await response.json();
  console.log(`[Captcha] Success: ${data.success}, Score: ${data.score ?? 'n/a'}`);
  return data.success === true;
}

/* ======================
   Refresh Token Logic
====================== */

async function refreshAccessToken(refreshToken) {
  console.log("[Token] Refreshing access token...");

  const res = await fetch(
    "https://services.leadconnectorhq.com/oauth/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: qs.stringify({
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        user_type: "Company",
        redirect_uri: "https://leadshub360.com/"
      })
    }
  );

  if (!res.ok) {
    const errorData = await res.json();
    console.error("[Token] ❌ Error refreshing token:", errorData);
    throw new Error("Failed to refresh access token");
  }

  const data = await res.json();

  console.log("[Token] ✅ Token refresh successful.");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token
  };
}

/* ======================
   Handler
====================== */

export default async function handler(req, res) {
  console.log("➡️ [API] submit-ghl-fields HIT.");

  if (req.method !== "POST") {
    console.log("[API] Method not allowed:", req.method);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { locationId, recaptchaToken, ...formFields } = req.body;

    console.log(`[API] LocationID: ${locationId}`);
    console.log(`[API] Fields received: ${Object.keys(formFields).join(", ")}`);

    if (!locationId) {
      console.warn("[API] Missing locationId in request.");
      return res.status(400).json({ error: "Missing locationId in request." });
    }

    const captchaOk = await verifyCaptcha(recaptchaToken);
    if (!captchaOk) {
      console.warn("[API] Captcha validation failed.");
      return res.status(400).json({ error: "Captcha verification failed" });
    }

    console.log("[API] ✅ Captcha passed.");

    const accountsCollection = await getMongoCollection();

    const account = await accountsCollection.findOne({ locationId });

    if (!account) {
      console.warn(`[API] No account found in Mongo for locationId: ${locationId}`);
      return res.status(404).json({ error: "Location ID not found in database." });
    }

    let accessToken = decrypt(account.accessTokenEncrypted);

    const tokenAgeMs = Date.now() - new Date(account.updatedAt).getTime();
    console.log(`[Token] Token age in minutes: ${(tokenAgeMs / 60000).toFixed(2)} minutes.`);

    if (tokenAgeMs > 24 * 60 * 60 * 1000) {
      console.log("[Token] Access token expired. Refreshing...");

      const decryptedRefreshToken = decrypt(account.refreshTokenEncrypted);
      const refreshed = await refreshAccessToken(decryptedRefreshToken);

      accessToken = refreshed.accessToken;

      // Save new tokens in Mongo
      const encryptedAccessToken = encrypt(refreshed.accessToken);
      const encryptedRefreshToken = encrypt(refreshed.refreshToken);

      await accountsCollection.updateOne(
        { locationId },
        {
          $set: {
            accessTokenEncrypted: encryptedAccessToken,
            refreshTokenEncrypted: encryptedRefreshToken,
            updatedAt: new Date()
          }
        }
      );

      console.log("[Token] ✅ New access token saved to Mongo.");
    } else {
      console.log("[Token] Access token still valid, using cached token.");
    }

    const fieldMappings = account.fieldMappings || {};
    console.log(`[API] Loaded ${Object.keys(fieldMappings).length} field mappings from Mongo.`);

    const payload = [];

    for (const [field, value] of Object.entries(formFields)) {
      if (value === undefined || value === null || value === "") {
        console.log(`[Mapping] Skipping empty field "${field}".`);
        continue;
      }

      const snakeKey = camelToSnake(field);
      const fieldKey = `{{ custom_values.${snakeKey} }}`;

      const customValueId = fieldMappings[fieldKey];
      if (customValueId) {
        payload.push({
          id: customValueId,
          value: value
        });
        console.log(`[Mapping] Field "${field}" → ${fieldKey} → ID ${customValueId}`);
      } else {
        console.log(`[Mapping] ⚠️ No mapping found for field "${field}" → ${fieldKey}`);
      }
    }

    if (payload.length === 0) {
      console.warn("[API] No mapped fields found to update.");
      return res.status(400).json({
        error: "No mapped fields found to update."
      });
    }

    console.log("[API] Payload ready for GHL PATCH:", JSON.stringify(payload, null, 2));

    const ghlUrl = `https://services.leadconnectorhq.com/v1/locations/${locationId}/customValues`;

    const ghlResponse = await fetch(ghlUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        Version: "2021-07-28"
      },
      body: JSON.stringify(payload)
    });

    const result = await ghlResponse.json();

    console.log("[API] GHL response status:", ghlResponse.status);
    console.log("[API] GHL response data:", result);

    if (!ghlResponse.ok) {
      console.error("[API] ❌ GHL PATCH failed.", result);
      return res.status(500).json({
        error: "Error updating custom values in GHL.",
        details: result
      });
    }

    console.log("[API] ✅ Custom values updated successfully in GHL.");

    return res.status(200).json({
      message: "Custom values updated successfully in GHL.",
      ghlResponse: result
    });

  } catch (e) {
    console.error("[API] ❌ Unexpected server error:", e);
    return res.status(500).json({
      error: "Unexpected server error.",
      details: e.toString(),
    });
  }
}

/* ======================
   Helper: camelCase → snake_case
====================== */

function camelToSnake(str) {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase();
}
