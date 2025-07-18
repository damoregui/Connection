const { connectMongo } = require("../lib/mongo");

module.exports = async (req, res) => {
  console.log("➡️ HIT /api/ghl-webhook");
  const body = req.body;

  if (body?.type === "INSTALL" && body?.locationId) {
    const locationId = body.locationId;
    console.log("📥 Received INSTALL webhook. LocationId:", locationId);

    try {
      const db = await connectMongo();
      await db.collection("pendingInstalls").insertOne({
        locationId,
        receivedAt: new Date(),
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Error saving locationId to DB:", err.message);
      return res.status(500).send("Failed to store locationId");
    }
  }

  console.log("ℹ️ Ignored webhook type:", body?.type);
  res.sendStatus(200);
};
