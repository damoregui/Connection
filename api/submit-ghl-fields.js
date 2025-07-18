const { buffer } = require("micro");
const axios = require("axios");
const { connectMongo } = require("../lib/mongo");
const { decrypt } = require("../lib/encrypt");

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const rawBody = await buffer(req);
    const body = JSON.parse(rawBody.toString("utf8"));
    const { locationId, updates } = body;

    console.log("📥 Payload received:", JSON.stringify(body, null, 2));

    if (!locationId || !Array.isArray(updates)) {
      console.warn("⚠️ Missing locationId or updates");
      return res.status(400).json({ error: "Missing locationId or updates" });
    }

    const db = await connectMongo();
    const account = await db.collection("accounts").findOne({ locationId });

    if (!account) {
      console.warn("❌ Account not found for locationId:", locationId);
      return res.status(404).json({ error: "Account not found" });
    }

    const decryptedAccessToken = decrypt(account.accessTokenEncrypted);
    const fieldMappings = account.fieldMappings;
    const results = [];

    for (const { fieldName, value } of updates) {
      const fieldId = fieldMappings[fieldName];
      if (!fieldId) {
        console.warn(`⚠️ Field not mapped: ${fieldName}`);
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
        console.log(`✅ Updated field "${fieldName}" (${fieldId}) with value: ${value}`);
        results.push({ fieldName, success: true });
      } catch (err) {
        const reason = err?.response?.data || err.message;
        console.error(`❌ Failed to update "${fieldName}" (${fieldId}):`, reason);
        results.push({ fieldName, success: false, reason });
      }
    }

    console.log("📤 Update results:", JSON.stringify(results, null, 2));
    res.json({ ok: true, results });

  } catch (err) {
    console.error("❌ Server error in /api/submit-ghl-fields:", err.message);
    res.status(500).json({ error: "Server error" });
  }
};
