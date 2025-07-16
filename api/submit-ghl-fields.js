export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({
    message: "Function works!",
    envVars: {
      MONGODB_URI: process.env.MONGODB_URI || "missing",
      ENCRYPT_SECRET: process.env.ENCRYPT_SECRET || "missing",
    },
    time: new Date(),
  });
}