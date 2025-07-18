const { buffer } = require("micro");
const axios = require("axios");
const { connectMongo } = require("../lib/mongo");
const { decrypt } = require("../lib/encrypt");

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function snakeToTitle(str) {
  return str
    .replace(/^custom_values\./, "") // remove prefix
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rawBody = await buffer(req);
    const body = JSON.parse(rawBody.toString("utf8"));
    const { locationId, updates } = body;

    if (!locationId || !Array.isArray(updates)) {
      return res.status(400).json({ error: "Missing locationId or updates" });
    }

    const db = await connectMongo();
    const account = await db.collection("accounts").findOne({ locationId });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const decryptedAccessToken = decrypt(account.accessTokenEncrypted);
    const fieldMappings = account.fieldMappings;
    const results = [];

    for (const { fieldName, value } of updates) {
      const snakeKey = `custom_values.${camelToSnake(fieldName)}`;
      const fieldId = fieldMappings[snakeKey];

      if (!fieldId) {
        results.push({ fieldName, success: false, reason: "Field not mapped", lookupKey: snakeKey });
        continue;
      }

      const readableName = snakeToTitle(snakeKey);

      try {
        await axios.put(
          `https://services.leadconnectorhq.com/customValues/${fieldId}`,
          { name: readableName, value },
          {
            headers: {
              Authorization: `Bearer ${decryptedAccessToken}`,
              Version: "2021-07-28",
              "Content-Type": "application/json",
            },
          }
        );
        results.push({ fieldName, success: true, nameSent: readableName });
      } catch (err) {
        results.push({
          fieldName,
          success: false,
          reason: err?.response?.data || err.message,
        });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error("❌ Error in /api/submit-ghl-fields:", err.message);
    res.status(500).json({ error: "Server error" });
  }
};
