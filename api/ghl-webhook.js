const axios = require("axios");
const { connectMongo } = require("../lib/mongo");

module.exports = async (req, res) => {
  console.log("➡️ HIT /api/ghl-webhook");
  const body = req.body;
  const { type, locationId } = body;

  if (type === "INSTALL" && locationId) {
    console.log("📥 Received INSTALL webhook. LocationId:", locationId);

    try {
      const db = await connectMongo();
      await db.collection("pendingInstalls").insertOne({
        locationId,
        receivedAt: new Date(),
      });

      return res.status(200).end();
    } catch (err) {
      console.error("❌ Error saving locationId to DB:", err.message);
      return res.status(500).end("Failed to store locationId");
    }
  }

  if (type === "UNINSTALL" && locationId) {
    console.log("📤 Received UNINSTALL webhook. Forwarding to external URL.");

    try {
      await axios.post(process.env.GHL_WEBHOOK_URL, {
        locationId,
        type,
      });

      return res.status(200).end();
    } catch (err) {
      console.error("❌ Failed to forward UNINSTALL webhook:", err?.response?.data || err.message);
      return res.status(500).end("Failed to forward UNINSTALL webhook");
    }
  }

  console.log("ℹ️ Ignored webhook type:", type);
  res.status(200).end();
};
