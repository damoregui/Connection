module.exports = async (req, res) => {
  console.log("➡️ HIT /api/ghl-webhook");
  const body = req.body;

  if (body?.type === "INSTALL" && body?.locationId) {
    const locationId = body.locationId;
    console.log("Received INSTALL webhook. LocationId:", locationId);
    return res.redirect(307, `/api/callback?locationId=${locationId}`);
  }

  console.log("Ignored webhook type:", body?.type);
  res.sendStatus(200);
};