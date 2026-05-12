// api/place-gtt.js
// Places a GTT (Good Till Triggered) stop-loss order on Kite
// Fires a SELL @ MARKET when premium drops to slTriggerPrice

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'Method not allowed' }); }

  const { accessToken, tradingsymbol, slTriggerPrice, currentPrice, quantity = 65 } = req.body;

  if (!accessToken || !tradingsymbol || !slTriggerPrice || !currentPrice) {
    return res.status(400).json({ error: 'accessToken, tradingsymbol, slTriggerPrice, currentPrice required' });
  }

  const apiKey = process.env.KITE_API_KEY;

  // GTT condition: triggers when LTP falls to (or below) slTriggerPrice
  const condition = JSON.stringify({
    exchange:       'NFO',
    tradingsymbol,
    trigger_values: [parseFloat(slTriggerPrice)],
    last_price:     parseFloat(currentPrice),
  });

  // GTT order: sell the position at market price when triggered
  const orders = JSON.stringify([{
    exchange:         'NFO',
    tradingsymbol,
    transaction_type: 'SELL',
    quantity:         parseInt(quantity),
    order_type:       'MARKET',
    product:          'NRML',
  }]);

  try {
    const response = await fetch('https://api.kite.trade/gtt/triggers', {
      method:  'POST',
      headers: {
        'Authorization':  `token ${apiKey}:${accessToken}`,
        'X-Kite-Version': '3',
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ type: 'single', condition, orders }),
    });

    const data = await response.json();

    if (data.status === 'success') {
      return res.json({
        gttId:        data.data.trigger_id,
        tradingsymbol,
        slTriggerPrice,
        status:       'placed',
      });
    } else {
      return res.status(400).json({ error: data.message || 'GTT placement failed', raw: data });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
