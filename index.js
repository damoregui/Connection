require("dotenv").config();
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

/* =========================
   TEMPORARY STORAGE
========================= */

const TEMP_STORAGE = {
  code: null,
  locationId: null,
};

/* =========================
   MongoDB Setup
========================= */

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  ssl: true,
  serverSelectionTimeoutMS: 15000,
});

let accountsCollection;

async function connectMongo() {
  try {
    await mongoClient.connect();
    console.log("✅ MongoDB connected.");

    const db = mongoClient.db(process.env.MONGODB_DBNAME || "ghlApp");
    accountsCollection = db.collection("accounts");
    console.log("✅ accountsCollection ready.");
  } catch (err) {
    console.error("❌ ERROR connecting to MongoDB:", err?.message, err?.stack);
    process.exit(1);
  }
}

/* =========================
   Crypto Utils
========================= */

const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET;
if (!ENCRYPT_SECRET) {
  throw new Error("ENCRYPT_SECRET is not defined in environment variables!");
}
const SALT = process.env.ENCRYPT_SALT;
if (!SALT) {
  throw new Error("ENCRYPT_SALT is not defined in environment variables!");
}

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

/* =========================
   ROUTES
========================= */

// CALLBACK → receive code
app.get("/api/callback", async (req, res) => {
  console.log("➡️ HIT /api/callback");
  console.log("Query params:", req.query);

  const { code } = req.query;

  TEMP_STORAGE.code = code;

  console.log("TEMP_STORAGE now:", TEMP_STORAGE);

  if (TEMP_STORAGE.code && TEMP_STORAGE.locationId) {
    await processOAuthFlow(res);
  } else {
    res.sendStatus(200);
  }
});

// WEBHOOK → receives locationId
app.post("/api/ghl-webhook", async (req, res) => {
  console.log("➡️ HIT /api/ghl-webhook");
  console.log("Webhook body:", req.body);

  const body = req.body;

  if (body.type === "INSTALL") {
    const locationId = body.locationId;
    console.log("➡️ Webhook INSTALL. LocationId:", locationId);

    TEMP_STORAGE.locationId = locationId;
    console.log("TEMP_STORAGE now:", TEMP_STORAGE);

    if (TEMP_STORAGE.code) {
      await processOAuthFlow(res);
    } else {
      res.sendStatus(200);
    }
  } else {
    console.log("ℹ️ Webhook ignored. Type:", body.type);
    res.sendStatus(200);
  }
});

/* =========================
   NEW ROUTE → submit-ghl-fields
========================= */

app.post("/api/submit-ghl-fields", async (req, res) => {
  console.log("➡️ HIT /api/submit-ghl-fields");

  try {
    const data = req.body;
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

    // Check if token needs refresh
    const now = new Date();
    const updatedAt = new Date(account.updatedAt);
    const hoursPassed =
      (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);

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

    res.json({
      message: "Custom values updated successfully in GHL.",
      response: patchResponse.data,
    });
  } catch (err) {
    console.error("[API] ❌ Error processing request:", err?.response?.data || err.message);
    res.status(500).json({
      error: err?.response?.data || err.message,
    });
  }
});

/* =========================
   Process OAuth Flow
========================= */

async function processOAuthFlow(res) {
  console.log("➡️ Entering processOAuthFlow");
  console.log("TEMP_STORAGE before token exchange:", TEMP_STORAGE);

  try {
    console.log("➡️ Doing token exchange...");
    const tokenResponse = await axios.post(
      "https://services.leadconnectorhq.com/oauth/token",
      qs.stringify({
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: TEMP_STORAGE.code,
        redirect_uri: process.env.REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;

    console.log("✅ Token exchange OK.");
    console.log("Tokens received:", {
      access_token: access_token?.substring(0, 10) + "...",
      refresh_token: refresh_token?.substring(0, 10) + "...",
    });

    console.log("➡️ Fetching custom values...");
    const fieldsResponse = await axios.get(
      `https://services.leadconnectorhq.com/locations/${TEMP_STORAGE.locationId}/customValues`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Version: "2021-07-28",
        },
      }
    );

    const fieldsData = fieldsResponse.data;
    console.log("✅ Custom values fetched:", fieldsData?.customValues?.length || 0);

    const fieldMappings = {};
    fieldsData?.customValues?.forEach((field) => {
      fieldMappings[field.fieldKey] = field.id;
    });

    console.log("➡️ Custom value mappings:", fieldMappings);

    const encryptedAccessToken = encrypt(access_token);
    const encryptedRefreshToken = encrypt(refresh_token);

    const updateResult = await accountsCollection.updateOne(
      { locationId: TEMP_STORAGE.locationId },
      {
        $set: {
          locationId: TEMP_STORAGE.locationId,
          accessTokenEncrypted: encryptedAccessToken,
          refreshTokenEncrypted: encryptedRefreshToken,
          fieldMappings,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log("✅ MongoDB update result:", updateResult);

    await axios.post(process.env.GHL_WEBHOOK_URL, {
      locationId: TEMP_STORAGE.locationId,
      access_token,
      refresh_token,
    });
    console.log("✅ Data sent to inbound webhook.");

    TEMP_STORAGE.code = null;
    TEMP_STORAGE.locationId = null;

    res.redirect("https://app.gohighlevel.com/v2/preview/ScbPusBtq4O63sGgKeYr?notrack=true");
  } catch (err) {
    console.error("❌ ERROR en processOAuthFlow:", err?.response?.data || err.message, err?.stack);
    res.status(500).send("An error occurred, please contact support.");
  }
}

/* =========================
   Utils
========================= */

function camelToSnake(str) {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase();
}

/* =========================
   Start Server
========================= */

connectMongo().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});

module.exports = app;
