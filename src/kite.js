// src/kite.js — Browser-side Kite API client
//
// KEY INSIGHT: Kite's IP restriction applies to SERVER→Kite calls only.
// Browser→Kite calls use YOUR IP (home/office) which is always allowed.
// Moving all Kite calls here bypasses the server IP whitelist problem entirely.
//
// This module is imported by Dashboard.jsx and runs entirely in the browser.
// No server involvement for any Kite data fetch or order placement.

const KITE_BASE = 'https://api.kite.trade';

// ── Core fetch helper ────────────────────────────────────────────────────────
async function kiteFetch(path, apiKey, accessToken, opts = {}) {
  const headers = {
    'Authorization': `token ${apiKey}:${accessToken}`,
    'X-Kite-Version': '3',
    ...opts.headers,
  };
  const res = await fetch(`${KITE_BASE}${path}`, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Kite ${path} failed: HTTP ${res.status}`);
  return data;
}

// ── Account data ─────────────────────────────────────────────────────────────
export async function fetchMargins(apiKey, accessToken) {
  const d = await kiteFetch('/user/margins', apiKey, accessToken);
  return d.data;
}

export async function fetchPositions(apiKey, accessToken) {
  const d = await kiteFetch('/portfolio/positions', apiKey, accessToken);
  return d.data;
}

export async function fetchOrders(apiKey, accessToken) {
  const d = await kiteFetch('/orders', apiKey, accessToken);
  return d.data;
}

// ── Option chain via /quote ───────────────────────────────────────────────────
// Fetches real-time LTP + OI for all strikes ±10 around ATM.
// Returns structured OC data ready for prompt injection.
export async function fetchKiteOC(apiKey, accessToken, spot, expiryDateStr) {
  if (!spot || spot <= 0) return null;

  const atmStrike = Math.round(spot / 50) * 50;
  const strikes   = [];
  for (let i = -10; i <= 10; i++) strikes.push(atmStrike + i * 50);

  const months   = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const [ey, em, ed] = expiryDateStr.split('-').map(Number);
  const expStr   = `${String(ed).padStart(2,'0')}${months[em-1]}${String(ey).slice(2)}`;

  const instruments = [];
  for (const st of strikes) {
    instruments.push(`NFO:NIFTY${expStr}C${st}`);
    instruments.push(`NFO:NIFTY${expStr}P${st}`);
  }

  const params = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&');
  const data   = await kiteFetch(`/quote?${params}`, apiKey, accessToken);
  if (!data?.data || !Object.keys(data.data).length) return null;

  // Parse into OC structure
  const rows = {};
  for (const [key, q] of Object.entries(data.data)) {
    const m = key.match(/([CP])(\d+)$/);
    if (!m) continue;
    const side   = m[1] === 'C' ? 'ce' : 'pe';
    const strike = parseInt(m[2]);
    if (!rows[strike]) rows[strike] = { ce: null, pe: null };
    rows[strike][side] = {
      ltp:    q.last_price  || 0,
      oi:     q.oi          || 0,
      oiChg:  (q.oi || 0) - (q.oi_day_low || 0),
      volume: q.volume      || 0,
    };
  }

  if (!Object.keys(rows).length) return null;

  // Compute PCR, walls, max pain, ATM premiums
  let totCeOI = 0, totPeOI = 0, maxCeOI = 0, maxPeOI = 0;
  let callWall = atmStrike, putWall = atmStrike;
  const sortedStrikes = Object.keys(rows).map(Number).sort((a,b) => b - a);

  for (const st of sortedStrikes) {
    const { ce, pe } = rows[st];
    if (ce) { totCeOI += ce.oi; if (ce.oi > maxCeOI) { maxCeOI = ce.oi; callWall = st; } }
    if (pe) { totPeOI += pe.oi; if (pe.oi > maxPeOI) { maxPeOI = pe.oi; putWall  = st; } }
  }

  // Max pain
  let maxPain = atmStrike, minLoss = Infinity;
  for (const target of sortedStrikes) {
    let loss = 0;
    for (const st of sortedStrikes) {
      if (target < st && rows[st].ce) loss += rows[st].ce.oi * (st - target);
      if (target > st && rows[st].pe) loss += rows[st].pe.oi * (target - st);
    }
    if (loss < minLoss) { minLoss = loss; maxPain = target; }
  }

  const atmRow  = rows[atmStrike] || {};
  const atmCeP  = atmRow.ce?.ltp || 0;
  const atmPeP  = atmRow.pe?.ltp || 0;
  const pcr     = totCeOI > 0 ? (totPeOI / totCeOI).toFixed(3) : '0';

  // Build OC table string
  const fc = n => (n >= 0 ? '+' : '') + String(Math.round(n)).padStart(8);
  let ocTable = 'Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
  ocTable    += '-------|--------|------------|----------|--------|------------|----------\n';
  for (const st of sortedStrikes) {
    const { ce, pe } = rows[st];
    ocTable += `${String(st).padStart(6)} | ${String((ce?.ltp||0).toFixed(0)).padStart(6)} | ${String(ce?.oi||0).padStart(10)} | ${fc(ce?.oiChg||0)} | ${String((pe?.ltp||0).toFixed(0)).padStart(6)} | ${String(pe?.oi||0).padStart(10)} | ${fc(pe?.oiChg||0)}\n`;
  }

  console.log(`[kite-browser] OC ok — atmCeP=${atmCeP} atmPeP=${atmPeP} pcr=${pcr} strikes=${sortedStrikes.length}`);

  return { pcr, callWall, putWall, maxPain, atmCeP, atmPeP, totCeOI, totPeOI, ocTable, rows };
}

// ── Order placement ───────────────────────────────────────────────────────────
export async function placeOrder(apiKey, accessToken, {
  tradingsymbol, transactionType, quantity,
  orderType = 'MARKET', price, triggerPrice,
  tag = 'nifty-analyst'
}) {
  const params = {
    tradingsymbol,
    exchange:         'NFO',
    transaction_type: transactionType,
    order_type:       orderType,
    quantity:         String(quantity),
    product:          'NRML',
    validity:         'DAY',
    tag,
  };
  if (price)        params.price         = String(price);
  if (triggerPrice) params.trigger_price = String(triggerPrice);

  const data = await kiteFetch('/orders/regular', apiKey, accessToken, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(params),
  });
  return { orderId: data.data.order_id, status: 'placed', tradingsymbol, transactionType };
}

// ── GTT placement ─────────────────────────────────────────────────────────────
export async function placeGTT(apiKey, accessToken, {
  tradingsymbol, slTriggerPrice, currentPrice, quantity = 65
}) {
  const condition = JSON.stringify({
    exchange:       'NFO',
    tradingsymbol,
    trigger_values: [parseFloat(slTriggerPrice)],
    last_price:     parseFloat(currentPrice),
  });
  const orders = JSON.stringify([{
    exchange:         'NFO',
    tradingsymbol,
    transaction_type: 'SELL',
    quantity:         parseInt(quantity),
    order_type:       'MARKET',
    product:          'NRML',
  }]);

  const data = await kiteFetch('/gtt/triggers', apiKey, accessToken, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ type: 'single', condition, orders }),
  });
  return { gttId: data.data.trigger_id, tradingsymbol, slTriggerPrice, status: 'placed' };
}

// ── Fetch all Kite data in one parallel call ──────────────────────────────────
// Called by Dashboard before each analysis — results sent to server in request body
export async function fetchAllKiteData(apiKey, accessToken, spot, expiryDateStr) {
  const [marginsR, positionsR, ordersR, ocR] = await Promise.allSettled([
    fetchMargins(apiKey, accessToken),
    fetchPositions(apiKey, accessToken),
    fetchOrders(apiKey, accessToken),
    spot > 0 ? fetchKiteOC(apiKey, accessToken, spot, expiryDateStr) : Promise.resolve(null),
  ]);

  const ok = r => r.status === 'fulfilled' ? r.value : null;
  return {
    margins:   ok(marginsR),
    positions: ok(positionsR),
    orders:    ok(ordersR),
    oc:        ok(ocR),
  };
}
