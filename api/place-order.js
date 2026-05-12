// api/place-order.js
// Places an order on Kite NFO (auto-trade execution)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'Method not allowed' }); }

  const {
    accessToken,
    tradingsymbol,
    transactionType,   // 'BUY' | 'SELL'
    quantity,          // must be multiple of 65
    orderType = 'MARKET',
    price,             // required for LIMIT orders
    triggerPrice,      // required for SL orders
    tag = 'nifty-analyst'
  } = req.body;

  if (!accessToken || !tradingsymbol || !transactionType || !quantity) {
    return res.status(400).json({ error: 'accessToken, tradingsymbol, transactionType, quantity required' });
  }

  const apiKey = process.env.KITE_API_KEY;
  const headers = {
    'Authorization':  `token ${apiKey}:${accessToken}`,
    'X-Kite-Version': '3',
    'Content-Type':   'application/x-www-form-urlencoded'
  };

  const params = {
    tradingsymbol,
    exchange:         'NFO',
    transaction_type: transactionType,
    order_type:       orderType,
    quantity:         String(quantity),
    product:          'NRML',
    validity:         'DAY',
    tag
  };

  if (price)        params.price        = String(price);
  if (triggerPrice) params.trigger_price = String(triggerPrice);

  try {
    const response = await fetch('https://api.kite.trade/orders/regular', {
      method: 'POST',
      headers,
      body: new URLSearchParams(params)
    });

    const data = await response.json();

    if (data.status === 'success') {
      return res.json({ orderId: data.data.order_id, status: 'placed', tradingsymbol, transactionType });
    } else {
      return res.status(400).json({ error: data.message || 'Order placement failed', data });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
