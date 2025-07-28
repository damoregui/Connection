const { MongoClient } = require("mongodb");
const axios = require("axios");
const qs = require("querystring");
const { decrypt, encrypt } = require("../lib/encrypt");

const mongoClient = new MongoClient(process.env.MONGODB_URI, { ssl: true });
let accountsCollection;

async function connectMongo() {
  if (!accountsCollection) {
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DBNAME);
    accountsCollection = db.collection("accounts");
  }
}

async function ensureValidAccessToken(locationId) {
  await connectMongo();

  const account = await accountsCollection.findOne({ locationId });

  if (!account) throw new Error("🔍 Location not found in MongoDB");

  const {
    accessTokenEncrypted,
    refreshTokenEncrypted,
    updatedAt,
    clientId,
    clientSecret,
  } = account;

  const accessToken = decrypt(accessTokenEncrypted);
  const refreshToken = decrypt(refreshTokenEncrypted);

  const now = new Date();
  const lastUpdated = new Date(updatedAt || 0);
  const hoursSinceUpdate = (now - lastUpdated) / (1000 * 60 * 60);

  // Si pasaron más de 22 horas, refrescamos
  if (hoursSinceUpdate >= 22) {
    try {
      const response = await axios.post(
        "https://services.leadconnectorhq.com/oauth/token",
        qs.stringify({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          user_type: "Company",
          redirect_uri: "https://leadshub360.com/",
        }),
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, refresh_token } = response.data;

      await accountsCollection.updateOne(
        { locationId },
        {
          $set: {
            accessTokenEncrypted: encrypt(access_token),
            refreshTokenEncrypted: encrypt(refresh_token),
            updatedAt: new Date(),
          },
        }
      );

      return access_token;
    } catch (err) {
      console.error("❌ Error refreshing token:", err.response?.data || err.message);
      throw new Error("Failed to refresh access token");
    }
  }

  // Si sigue vigente
  return accessToken;
}

module.exports = ensureValidAccessToken;
