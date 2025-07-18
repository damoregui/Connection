const axios = require("axios");
const qs = require("querystring");
const { connectMongo } = require("../lib/mongo");
const { encrypt } = require("../lib/encrypt");

module.exports = async (req, res) => {
  console.log("➡️ HIT /api/callback");
  const { code, locationId } = req.query;

  if (!code || !locationId) {
    return res.status(400).json({ error: "Missing code or locationId in query" });
  }

  try {
    const tokenResponse = await axios.post(
      "https://services.leadconnectorhq.com/oauth/token",
      qs.stringify({
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, refresh_token } = tokenResponse.data;
    const encryptedAccessToken = encrypt(access_token);
    const encryptedRefreshToken = encrypt(refresh_token);

    const fieldsResponse = await axios.get(
      `https://services.leadconnectorhq.com/locations/${locationId}/customValues`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Version: "2021-07-28",
        },
      }
    );

    const fieldMappings = {};
    fieldsResponse.data?.customValues?.forEach(field => {
      fieldMappings[field.fieldKey] = field.id;
    });

    const db = await connectMongo();
    await db.collection("accounts").updateOne(
      { locationId },
      {
        $set: {
          locationId,
          accessTokenEncrypted: encryptedAccessToken,
          refreshTokenEncrypted: encryptedRefreshToken,
          fieldMappings,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    await axios.post(process.env.GHL_WEBHOOK_URL, {
      locationId,
      access_token,
      refresh_token,
    });

    res.redirect("https://app.gohighlevel.com/v2/preview/ScbPusBtq4O63sGgKeYr?notrack=true");
  } catch (err) {
    console.error("❌ Error in /api/callback:", err?.response?.data || err.message);
    res.status(500).json({ error: "OAuth flow failed" });
  }
};
