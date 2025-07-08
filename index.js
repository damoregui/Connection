const express = require('express');
const axios = require('axios');
const app = express();

const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL;
const CLIENT_ID = process.env.GHL_CLIENT_ID;
const CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

app.get('/api/callback', async (req, res) => {
  const { code, locationId } = req.query;

  if (!code || !locationId) {
    return res.status(400).send('Missing code or locationId');
  }

  try {
    const tokenResponse = await axios.post('https://services.leadconnectorhq.com/oauth/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });

    const { access_token, refresh_token } = tokenResponse.data;

    await axios.post(GHL_WEBHOOK_URL, {
      code,
      locationId,
      access_token,
      refresh_token
    });

    res.send('✅ Authorization complete. You may close this window.');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('❌ Something went wrong');
  }
});

module.exports = app;
