const express = require('express');
const axios = require('axios');
const qs = require('querystring');

const app = express();

// Middleware para leer JSON en body
app.use(express.json());

// ⚠️ TEMPORARY STORAGE → En producción usar Redis u otro storage persistente
const TEMP_STORAGE = {
  code: null,
  locationId: null
};

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
    // No devolver texto visible al usuario
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
      // No devolver texto visible al usuario
      res.sendStatus(200);
    }
  } else {
    // Para otros tipos de webhook que no nos interesan
    res.sendStatus(200);
  }
});

// Función que realiza el token exchange y envía los datos al inbound webhook
async function processOAuthFlow(res) {
  try {
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

    // Enviar datos al inbound webhook
    await axios.post(process.env.GHL_WEBHOOK_URL, {
      locationId: TEMP_STORAGE.locationId,
      access_token,
      refresh_token
    });

    console.log('✅ Data sent to inbound webhook.');

    // Limpiar almacenamiento temporal
    TEMP_STORAGE.code = null;
    TEMP_STORAGE.locationId = null;

    // Redirigir al Thank You page
    res.redirect('https://app.gohighlevel.com/v2/preview/ScbPusBtq4O63sGgKeYr?notrack=true');

  } catch (err) {
    console.error('❌ ERROR:', err.response?.data || err.message);
    res
      .status(500)
      .send('An error occurred, please contact support.');
  }
}

module.exports = app;
