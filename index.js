require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

// ⚠️ TEMPORARY STORAGE → en producción usar algo mejor (Redis, etc.)
const TEMP_STORAGE = {
  code: null,
  locationId: null
};

/* =========================
   MongoDB Setup
========================= */

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let accountsCollection;

async function connectMongo() {
  await mongoClient.connect();
  const db = mongoClient.db(process.env.MONGODB_DBNAME || 'ghlApp');
  accountsCollection = db.collection('accounts');
  console.log('✅ MongoDB connected.');
}
connectMongo().catch(console.error);

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

// CALLBACK → Recibe el code desde el redirect URI
app.get('/api/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('An error occurred, please contact support.');
  }

  console.log('➡️ Received code:', code);

  TEMP_STORAGE.code = code;

  if (TEMP_STORAGE.locationId) {
    await processOAuthFlow(res);
  } else {
    res.sendStatus(200);
  }
});

// WEBHOOK → Recibe el locationId desde el webhook de instalación
app.post('/api/ghl-webhook', async (req, res) => {
  const body = req.body;

  if (body.type === 'INSTALL') {
    const locationId = body.locationId;
    console.log('➡️ Webhook received. LocationId:', locationId);

    TEMP_STORAGE.locationId = locationId;

    if (TEMP_STORAGE.code) {
      await processOAuthFlow(res);
    } else {
      res.sendStatus(200);
    }
  } else {
    res.sendStatus(200);
  }
});

/* =========================
   OAuth + MongoDB Logic
========================= */

async function processOAuthFlow(res) {
  try {
    // 1. Token exchange
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

    console.log('✅ Tokens obtained:', {
      access_token,
      refresh_token
    });

    // 2. Fetch custom fields from GHL
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

    // build mapping { fieldName: fieldId }
    const fieldMappings = {};
    fieldsData.customFields.forEach(field => {
      fieldMappings[field.name] = field.id;
    });

    console.log('✅ Custom fields fetched:', fieldMappings);

    // 3. Save everything into MongoDB
    const encryptedAccessToken = encrypt(access_token);
    const encryptedRefreshToken = encrypt(refresh_token);

    await accountsCollection.updateOne(
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

    console.log('✅ Account stored in MongoDB.');

    // OPTIONAL → Notify your inbound webhook if needed
    await axios.post(process.env.GHL_WEBHOOK_URL, {
      locationId: TEMP_STORAGE.locationId,
      access_token,
      refresh_token
    });

    console.log('✅ Data sent to inbound webhook.');

    TEMP_STORAGE.code = null;
    TEMP_STORAGE.locationId = null;

    res.redirect('https://app.gohighlevel.com/v2/preview/ScbPusBtq4O63sGgKeYr?notrack=true');
  } catch (err) {
    console.error('❌ ERROR:', err.response?.data || err.message);
    res
      .status(500)
      .send('An error occurred, please contact support.');
  }
}

module.exports = app;
