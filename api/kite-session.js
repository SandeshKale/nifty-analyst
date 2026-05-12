// api/kite-session.js
// Exchanges Kite request_token for access_token (server-side, keeps API secret secure)

import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed' }); }

  const { requestToken } = req.body;
  if (!requestToken) {
    return res.status(400).json({ error: 'requestToken required' });
  }

  const apiKey    = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  // Kite checksum: SHA256(api_key + request_token + api_secret)
  const checksum = crypto
    .createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');

  try {
    const response = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: {
        'X-Kite-Version': '3',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        api_key:       apiKey,
        request_token: requestToken,
        checksum:      checksum
      })
    });

    const data = await response.json();

    if (data.status === 'success') {
      return res.json({
        accessToken: data.data.access_token,
        userId:      data.data.user_id,
        userName:    data.data.user_name,
        expiresAt:   data.data.token_expiry
      });
    } else {
      return res.status(400).json({ error: data.message || 'Token exchange failed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
