require("dotenv").config();
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: "https://app.gohighlevel.com",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

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

app.get("/favicon.ico", (req, res) => res.sendStatus(204));
app.get("/favicon.png", (req, res) => res.sendStatus(204));

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
