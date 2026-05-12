// api/kite-login.js
// Generates the Kite OAuth login URL

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'KITE_API_KEY not configured' });
  }

  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
  res.json({ loginUrl });
}
