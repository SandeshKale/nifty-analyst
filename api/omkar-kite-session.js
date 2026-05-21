// api/omkar-kite-session.js
// Exchanges Kite request_token → access_token using Omkar's Kite app credentials.
// Completely separate from Sandesh's kite-session.js — different API key + secret.

import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'Method not allowed' }); }

  const { requestToken } = req.body;
  if (!requestToken) {
    return res.status(400).json({ error: 'requestToken required' });
  }

  const apiKey    = process.env.OMKAR_KITE_API_KEY;
  const apiSecret = process.env.OMKAR_KITE_API_SECRET;

  if (!apiKey || !apiSecret) {
    return res.status(500).json({
      error: 'OMKAR_KITE_API_KEY or OMKAR_KITE_API_SECRET not configured in Vercel env vars'
    });
  }

  // Kite checksum: SHA256(api_key + request_token + api_secret)
  const checksum = crypto
    .createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');

  try {
    const response = await fetch('https://api.kite.trade/session/token', {
      method:  'POST',
      headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
    });

    const data = await response.json();

    if (data.status === 'success') {
      return res.json({
        accessToken: data.data.access_token,
        userId:      data.data.user_id,
        userName:    data.data.user_name,
        expiresAt:   data.data.token_expiry,
        apiKey,   // return apiKey so analyze.js can use it for Omkar's Kite calls
      });
    } else {
      return res.status(400).json({ error: data.message || 'Token exchange failed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
