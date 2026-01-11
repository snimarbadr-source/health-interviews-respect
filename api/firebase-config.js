export default function handler(req, res) {
  const cfg = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || undefined
  };

  // Basic validation (helps catch missing env vars)
  const missing = Object.entries(cfg)
    .filter(([k, v]) => (k !== 'measurementId') && (!v || String(v).trim() === ''))
    .map(([k]) => k);

  if (missing.length) {
    return res.status(500).json({
      error: "Missing Firebase config env vars on Vercel",
      missing
    });
  }

  // Note: This config is not a secret for Firebase Web SDK.
  // Keeping it in env vars prevents it from living in GitHub.
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(cfg);
}
