const { buffer } = require("micro");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { connectMongo } = require("../lib/mongo");
const ensureValidAccessToken = require("../auth/ensureValidAccessToken");

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function snakeToFieldName(str) {
  return str
    .split("_")
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

async function sendFormEmail({ locationId, updates }) {
  const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.NOTIFY_EMAIL,
      pass: process.env.NOTIFY_EMAIL_PASS
    }
  });

  const recipients = [
    "guido.damore@hotmail.com"
  ];

  const formattedFields = updates
    .map(({ fieldName, value }) => `<strong>${fieldName}:</strong> ${value}`)
    .join("<br>");

  const mailOptions = {
    from: `"Formulario GHL" <${process.env.NOTIFY_EMAIL}>`,
    to: recipients.join(","),
    subject: `📝 Nuevo envío de formulario - Location ID: ${locationId}`,
    html: `
      <p>Se recibió un nuevo envío con los siguientes datos:</p>
      <p><strong>Location ID:</strong> ${locationId}</p>
      <hr>
      ${formattedFields}
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Email enviado correctamente");
  } catch (error) {
    console.error("❌ Error al enviar el email:", error);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rawBody = await buffer(req);
    const { locationId, updates } = JSON.parse(rawBody.toString("utf8"));

    if (!locationId || !Array.isArray(updates)) {
      return res.status(400).json({ error: "Missing locationId or updates" });
    }

    const db = await connectMongo();
    const account = await db.collection("accounts").findOne({ locationId });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    // 🔔 Enviar backup por email antes de procesar
    await sendFormEmail({ locationId, updates });

    // ✅ Obtener token válido y actualizado
    const accessToken = await ensureValidAccessToken(locationId);
    const fieldMappings = account.fieldMappings;

    const results = [];

    for (const { fieldName, value } of updates) {
      const snake = camelToSnake(fieldName);
      const fieldKey = `{{ custom_values.${snake} }}`;
      const customValueId = fieldMappings[fieldKey];

      if (!customValueId) {
        console.warn(`⚠️ Not mapped: ${fieldName} → ${fieldKey}`);
        results.push({ fieldName, success: false, reason: "Field not mapped" });
        continue;
      }

      const payload = {
        name: snakeToFieldName(snake),
        value,
      };

      const url = `https://services.leadconnectorhq.com/locations/${locationId}/customValues/${customValueId}`;
      console.log(`➡️ PUT ${payload.name} (${customValueId}) =`, value);

      try {
        await axios.put(url, payload, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: "2021-07-28",
            "Content-Type": "application/json",
          },
        });
        results.push({ fieldName, success: true });
      } catch (err) {
        console.error(`❌ Failed updating ${fieldName}:`, err?.response?.data || err.message);
        results.push({ fieldName, success: false, reason: err?.response?.data || err.message });
      }
    }

    const failed = results.filter(r => !r.success);
    if (failed.length === 0) {
      return res.status(200).json({ success: true });
    } else {
      const failedFields = failed.map(f => f.fieldName);
      return res.status(207).json({
        success: false,
        failedFields
      });
    }
  } catch (err) {
    console.error("❌ General error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
