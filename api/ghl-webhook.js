const axios = require("axios");
const { connectMongo } = require("../lib/mongo");

module.exports = async (req, res) => {
  console.log("➡️ HIT /api/ghl-webhook");
  const body = req.body;
  const { type, locationId } = body;

  if (!locationId || !type) {
    console.log("❌ Missing locationId or type");
    return res.status(400).end("Missing data");
  }

  const db = await connectMongo();

  try {
    if (type === "INSTALL") {
      console.log("📥 Received INSTALL webhook. LocationId:", locationId);

      // 1. Save to pendingInstalls
      await db.collection("pendingInstalls").insertOne({
        locationId,
        receivedAt: new Date(),
      });

      // 2. Add to customMenuInstalls
      await db.collection("customMenuInstalls").updateOne(
        { locationId },
        { $set: { locationId, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    if (type === "UNINSTALL") {
      console.log("📤 Received UNINSTALL webhook. LocationId:", locationId);

      // 1. Remove from customMenuInstalls
      await db.collection("customMenuInstalls").deleteOne({ locationId });
    }

    // 3. Rebuild updated list
    const all = await db
      .collection("customMenuInstalls")
      .find({})
      .project({ locationId: 1 })
      .toArray();

    const locationIds = all.map(doc => doc.locationId);

    // 4. POST array to inbound webhook
    await axios.post(process.env.GHL_WEBHOOK_URL, {
      locations: locationIds,
    });

    return res.status(200).end();
  } catch (err) {
    console.error(`❌ ${type} error:`, err?.response?.data || err.message);
    return res.status(500).end(`Failed during ${type}`);
  }
};
