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

      await db.collection("pendingInstalls").insertOne({
        locationId,
        receivedAt: new Date(),
      });

      await db.collection("customMenuInstalls").updateOne(
        { locationId },
        { $set: { locationId, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    if (type === "UNINSTALL") {
      console.log("📤 Received UNINSTALL webhook. LocationId:", locationId);

      await db.collection("customMenuInstalls").deleteOne({ locationId });
    }

    const all = await db
      .collection("customMenuInstalls")
      .find({})
      .project({ locationId: 1 })
      .toArray();

    const locationIds = all.map(doc => doc.locationId);
    console.log("📦 Sending updated locations to GHL:", locationIds);

    const response = await axios.put(
      "https://services.leadconnectorhq.com/custom-menus/42e1a24e-67a1-486f-9044-8125b2b97ef7",
      {
        title: "LH360 Configuration",
        url: "https://www.insuranceatyourfingertips.com/account-configuration-lh360?locationId={{location.id}}",
        icon: {
          name: "wrench",
          fontFamily: "fas",
        },
        showOnCompany: true,
        showOnLocation: true,
        showToAllLocations: false,
        openMode: "iframe",
        locations: locationIds,
        userRole: "all",
        allowCamera: false,
        allowMicrophone: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
      }
    );

    console.log("✅ GHL PUT response status:", response.status);
    console.log("✅ GHL PUT response data:", response.data);

    return res.status(200).end();
  } catch (err) {
    console.error("❌ Error during GHL PUT:");
    console.error("↳ status:", err?.response?.status);
    console.error("↳ data:", err?.response?.data);
    console.error("↳ headers:", err?.response?.headers);
    return res.status(500).end(`Failed during ${type}`);
  }
};
