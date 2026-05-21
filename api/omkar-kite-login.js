// api/omkar-kite-login.js
// Generates Kite OAuth login URL using Omkar's own Kite developer app credentials.
// Completely separate from Sandesh's KITE_API_KEY — no cross-contamination.

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = process.env.OMKAR_KITE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OMKAR_KITE_API_KEY not configured in Vercel env vars' });
  }

  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
  res.json({ loginUrl });
}
