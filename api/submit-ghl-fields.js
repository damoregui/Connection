const { buffer } = require("micro");
const axios = require("axios");
const { connectMongo } = require("../lib/mongo");
const { decrypt } = require("../lib/encrypt");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await buffer(req);
  const body = JSON.parse(rawBody.toString("utf8"));
  const { locationId, updates } = body;

  if (!locationId || !Array.isArray(updates)) {
    return res.status(400).json({ error: "Missing locationId or updates" });
  }

  try {
    const db = await connectMongo();
    const account = await db.collection("accounts").findOne({ locationId });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const decryptedAccessToken = decrypt(account.accessTokenEncrypted);
    const fieldMappings = account.fieldMappings;
    const results = [];

    for (const { fieldName, value } of updates) {
      const fieldId = fieldMappings[fieldName];
      if (!fieldId) {
        results.push({ fieldName, success: false, reason: "Field not mapped" });
        continue;
      }

      try {
        await axios.put(
          `https://services.leadconnectorhq.com/customValues/${fieldId}`,
          { value },
          {
            headers: {
              Authorization: `Bearer ${decryptedAccessToken}`,
              Version: "2021-07-28",
              "Content-Type": "application/json",
            },
          }
        );
        results.push({ fieldName, success: true });
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
