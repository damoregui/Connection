require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

/* =========================
   TEMPORARY STORAGE
========================= */

const TEMP_STORAGE = {
  code: null,
  locationId: null
};

/* =========================
   MongoDB Setup
========================= */

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  ssl: true,
  serverSelectionTimeoutMS: 5000
});

let accountsCollection;

async function connectMongo() {
  try {
    await mongoClient.connect();
    console.log('✅ MongoDB connected.');

    const db = mongoClient.db(process.env.MONGODB_DBNAME || 'ghlApp');
    accountsCollection = db.collection('accounts');
    console.log('✅ accountsCollection ready.');
  } catch (err) {
    console.error('❌ ERROR connecting to MongoDB:', err?.message, err?.stack);
    process.exit(1);
  }
}

/* =========================
   Crypto Utils
========================= */

const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || 'super-secret-password';
const SALT = 'my-salt';

function encrypt(text) {
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
  const [ivHex, encryptedData] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.scryptSync(ENCRYPT_SECRET, SALT, 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/* =========================
   Routes
========================= */

// CALLBACK → recibe el code
app.get('/api/callback', async (req, res) => {
  console.log('➡️ HIT /api/callback');
  console.log('Query params:', req.query);

  const { code } = req.query;

  TEMP_STORAGE.code = code;

  console.log('TEMP_STORAGE now:', TEMP_STORAGE);

  if (TEMP_STORAGE.code && TEMP_STORAGE.locationId) {
    await processOAuthFlow(res);
  } else {
    res.sendStatus(200);
  }
});

// WEBHOOK → recibe locationId
app.post('/api/ghl-webhook', async (req, res) => {
  console.log('➡️ HIT /api/ghl-webhook');
  console.log('Webhook body:', req.body);

  const body = req.body;

  if (body.type === 'INSTALL') {
    const locationId = body.locationId;
    console.log('➡️ Webhook INSTALL. LocationId:', locationId);

    TEMP_STORAGE.locationId = locationId;
    console.log('TEMP_STORAGE now:', TEMP_STORAGE);

    if (TEMP_STORAGE.code) {
      await processOAuthFlow(res);
    } else {
      res.sendStatus(200);
    }
  } else {
    console.log('ℹ️ Webhook ignored. Type:', body.type);
    res.sendStatus(200);
  }
});

/* =========================
   OAuth + MongoDB Logic
========================= */

async function processOAuthFlow(res) {
  console.log('➡️ Entrando en processOAuthFlow');
  console.log('TEMP_STORAGE antes de token exchange:', TEMP_STORAGE);

  try {
    console.log('➡️ Haciendo token exchange...');
    const tokenResponse = await axios.post(
      'https://services.leadconnectorhq.com/oauth/token',
      qs.stringify({
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: TEMP_STORAGE.code,
        redirect_uri: process.env.REDIRECT_URI
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;

    console.log('✅ Token exchange OK.');
    console.log('Tokens received:', {
      access_token: access_token?.substring(0, 10) + '...',
      refresh_token: refresh_token?.substring(0, 10) + '...'
    });

    // Fetch custom fields
    console.log('➡️ Fetching custom fields...');
    const fieldsResponse = await axios.get(
      `https://services.leadconnectorhq.com/locations/${TEMP_STORAGE.locationId}/customFields`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Version: '2021-07-28'
        }
      }
    );

    const fieldsData = fieldsResponse.data;

    console.log('✅ Fields fetched:', fieldsData?.customFields?.length || 0);

    const fieldMappings = {};
    fieldsData?.customFields?.forEach(field => {
      fieldMappings[field.name] = field.id;
    });

    console.log('➡️ Field mappings:', fieldMappings);

    // Save to MongoDB
    console.log('➡️ Guardando en MongoDB...');
    const encryptedAccessToken = encrypt(access_token);
    const encryptedRefreshToken = encrypt(refresh_token);

    if (!accountsCollection) {
      console.error('❌ accountsCollection está undefined.');
      return res.status(500).send('MongoDB connection not initialized.');
    }

    const updateResult = await accountsCollection.updateOne(
      { locationId: TEMP_STORAGE.locationId },
      {
        $set: {
          locationId: TEMP_STORAGE.locationId,
          accessTokenEncrypted: encryptedAccessToken,
          refreshTokenEncrypted: encryptedRefreshToken,
          fieldMappings,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    console.log('✅ MongoDB update result:', updateResult);

    // Opcional → notificar webhook interno
    console.log('➡️ Enviando datos a GHL_WEBHOOK_URL...');
    await axios.post(process.env.GHL_WEBHOOK_URL, {
      locationId: TEMP_STORAGE.locationId,
      access_token,
      refresh_token
    });
    console.log('✅ Data enviada a inbound webhook.');

    TEMP_STORAGE.code = null;
    TEMP_STORAGE.locationId = null;

    res.redirect('https://app.gohighlevel.com/v2/preview/ScbPusBtq4O63sGgKeYr?notrack=true');

  } catch (err) {
    console.error('❌ ERROR en processOAuthFlow:', err?.response?.data || err.message, err.stack);
    res.status(500).send('An error occurred, please contact support.');
  }
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
