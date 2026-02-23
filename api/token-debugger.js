const { connectMongo } = require("../lib/mongo");
const { decrypt } = require("../lib/encrypt");

function renderPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Token Debugger</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        max-width: 720px;
        margin: 40px auto;
        padding: 0 16px;
        color: #1f2937;
      }
      h1 {
        margin-bottom: 8px;
      }
      .muted {
        color: #6b7280;
        margin-bottom: 24px;
      }
      form {
        display: flex;
        gap: 8px;
        margin-bottom: 20px;
      }
      input {
        flex: 1;
        padding: 10px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
      }
      button {
        border: 0;
        border-radius: 8px;
        background: #2563eb;
        color: white;
        padding: 10px 14px;
        cursor: pointer;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-all;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 12px;
      }
      .error {
        color: #b91c1c;
      }
    </style>
  </head>
  <body>
    <h1>GHL Token Debugger</h1>
    <p class="muted">Ingresa el <strong>locationId</strong> para ver access/refresh token desencriptados.</p>

    <form id="tokenForm">
      <input id="locationId" placeholder="Ej: abc123" required />
      <button type="submit">Obtener tokens</button>
    </form>

    <div id="message" class="error"></div>
    <pre id="result">Esperando búsqueda...</pre>

    <script>
      const form = document.getElementById("tokenForm");
      const message = document.getElementById("message");
      const result = document.getElementById("result");

      form.addEventListener("submit", async event => {
        event.preventDefault();
        message.textContent = "";
        result.textContent = "Cargando...";

        const locationId = document.getElementById("locationId").value.trim();

        try {
          const response = await fetch("/api/token-debugger", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ locationId }),
          });

          const data = await response.json();
          if (!response.ok) {
            message.textContent = data.error || "Error desconocido";
            result.textContent = "Sin resultados";
            return;
          }

          result.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          message.textContent = "No se pudo completar la solicitud";
          result.textContent = "Sin resultados";
        }
      });
    </script>
  </body>
</html>`;
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderPage());
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const locationId = payload?.locationId?.trim();

    if (!locationId) {
      return res.status(400).json({ error: "locationId is required" });
    }

    const db = await connectMongo();
    const account = await db.collection("accounts").findOne({ locationId });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted) {
      return res.status(404).json({ error: "Encrypted tokens not found" });
    }

    const accessToken = decrypt(account.accessTokenEncrypted);
    const refreshToken = decrypt(account.refreshTokenEncrypted);

    return res.status(200).json({
      locationId,
      accessToken,
      refreshToken,
      updatedAt: account.updatedAt || null,
    });
  } catch (err) {
    console.error("❌ Error in /api/token-debugger:", err.message);
    return res.status(500).json({ error: "Failed to retrieve tokens" });
  }
};
