const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const app = express();

const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const CLIENT_ID = process.env.GHL_CLIENT_ID;
const CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

app.get('/api/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('❌ Missing code in query params');
  }

  try {
    console.log('➡️ Received code:', code);

    // STEP 1 — Token exchange
    const tokenResponse = await axios.post(
      'https://services.leadconnectorhq.com/oauth/token',
      qs.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;

    console.log('✅ Tokens obtained:', { access_token, refresh_token });

    // STEP 2 — Fetch all locations using v1 endpoint
    const locationsResponse = await axios.get(
      'https://services.leadconnectorhq.com/v1/locations/',
      {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      }
    );

    const locations = locationsResponse.data.locations || [];

    console.log('✅ Locations fetched:', locations);

    // STEP 3 — Send everything to inbound webhook
    await axios.post(GHL_WEBHOOK_URL, {
      code,
      access_token,
      refresh_token,
      locations
    });

    res.send('✅ Authorization complete! Data sent to inbound webhook. You may close this window.');
  } catch (err) {
    if (err.response) {
      console.error('❌ ERROR STATUS:', err.response.status);
      console.error('❌ ERROR DATA:', err.response.data);
    } else {
      console.error('❌ ERROR MESSAGE:', err.message);
    }

    res.status(500).send('❌ Error during token exchange or webhook call. Check logs for details.');
  }
});

module.exports = app;
