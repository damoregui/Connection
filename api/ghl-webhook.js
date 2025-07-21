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

  // 🟢 INSTALL LOGIC
  if (type === "INSTALL") {
    console.log("📥 Received INSTALL webhook. LocationId:", locationId);

    try {
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

      // 3. Rebuild full list of locationIds
      const all = await db
        .collection("customMenuInstalls")
        .find({})
        .project({ locationId: 1 })
        .toArray();

      const locationIds = all.map(doc => doc.locationId);

      // 4. PUT to GHL custom menu
      await axios.put(
        "https://services.leadconnectorhq.com/custom-menus/62e589c1-c456-47e1-a9a7-cb8900014311",
        {
          title: "Custom Menu",
          url: "https://custom-menus.com/",
          icon: { name: "yin-yang", fontFamily: "fab" },
          showOnCompany: true,
          showOnLocation: true,
          showToAllLocations: false,
          openMode: "iframe",
          userRole: "all",
          allowCamera: false,
          allowMicrophone: false,
          locations: locationIds,
        },
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
            "Content-Type": "application/json",
            Version: "2021-07-28",
          },
        }
      );

      return res.status(200).end();
    } catch (err) {
      console.error("❌ INSTALL error:", err?.response?.data || err.message);
      return res.status(500).end("Failed during INSTALL");
    }
  }

  // 🔴 UNINSTALL LOGIC
  if (type === "UNINSTALL") {
    console.log("📤 Received UNINSTALL webhook. LocationId:", locationId);

    try {
      // 1. Forward webhook to external endpoint
      await axios.post(process.env.GHL_WEBHOOK_URL, { locationId, type });

      // 2. Remove from customMenuInstalls
      await db.collection("customMenuInstalls").deleteOne({ locationId });

      // 3. Rebuild updated list
      const all = await db
        .collection("customMenuInstalls")
        .find({})
        .project({ locationId: 1 })
        .toArray();

      const locationIds = all.map(doc => doc.locationId);

      // 4. PUT updated list to GHL
      await axios.put(
        "https://services.leadconnectorhq.com/custom-menus/62e589c1-c456-47e1-a9a7-cb8900014311",
        {
          title: "Custom Menu",
          url: "https://custom-menus.com/",
          icon: { name: "yin-yang", fontFamily: "fab" },
          showOnCompany: true,
          showOnLocation: true,
          showToAllLocations: false,
          openMode: "iframe",
          userRole: "all",
          allowCamera: false,
          allowMicrophone: false,
          locations: locationIds,
        },
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
            "Content-Type": "application/json",
            Version: "2021-07-28",
          },
        }
      );

      return res.status(200).end();
    } catch (err) {
      console.error("❌ UNINSTALL error:", err?.response?.data || err.message);
      return res.status(500).end("Failed during UNINSTALL");
    }
  }

  // 🔵 Fallback
  console.log("ℹ️ Ignored webhook type:", type);
  res.status(200).end();
};
