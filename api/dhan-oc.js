// api/dhan-oc.js
// Dhan API option chain — free, globally accessible, no IP whitelist needed.
// Returns full OC data: LTP, OI, OI change, IV, Greeks for all strikes.
// Used as primary source for F2 (PCR/OI) and F9 (IVP/IV) in analyze.js.
//
// Endpoints used:
//   POST /v2/optionchain/expirylist — get available expiry dates
//   POST /v2/optionchain           — get full OC for a specific expiry
//
// Nifty 50 constants:
//   UnderlyingScrip: 13  (Nifty 50 security ID in Dhan)
//   UnderlyingSeg:   IDX_I

const DHAN_BASE = 'https://api.dhan.co/v2';

async function dhanFetch(path, clientId, accessToken, body, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${DHAN_BASE}${path}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'access-token': accessToken,
        'client-id':    clientId,
      },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Dhan ${path} HTTP ${res.status}: ${err.slice(0, 120)}`);
    }
    return await res.json();
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

// Fetch nearest weekly expiry date from Dhan
async function getDhanExpiries(clientId, accessToken) {
  const data = await dhanFetch('/optionchain/expirylist', clientId, accessToken, {
    UnderlyingScrip: 13,    // Nifty 50
    UnderlyingSeg:  'IDX_I',
  });
  // Returns array of date strings: ["2026-06-09", "2026-06-16", ...]
  return data?.data || [];
}

// Fetch full option chain for a specific expiry date
async function getDhanOC(clientId, accessToken, expiryDate) {
  const data = await dhanFetch('/optionchain', clientId, accessToken, {
    UnderlyingScrip: 13,
    UnderlyingSeg:  'IDX_I',
    Expiry:          expiryDate,   // "YYYY-MM-DD"
  });
  return data?.data || null;
}

// Main export: fetch and parse Dhan OC into the format analyze.js expects
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { expiryDate, spot } = req.body || {};

  const clientId    = process.env.DHAN_CLIENT_ID;
  const accessToken = process.env.DHAN_ACCESS_TOKEN;

  if (!clientId || !accessToken) {
    return res.status(500).json({ error: 'DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN not configured' });
  }

  try {
    // Step 1: Get expiry list if no date provided
    let targetExpiry = expiryDate;
    if (!targetExpiry) {
      const expiries = await getDhanExpiries(clientId, accessToken);
      if (!expiries.length) throw new Error('No expiries returned from Dhan');
      // Pick nearest weekly expiry (first in list)
      targetExpiry = expiries[0];
      console.log(`[dhan-oc] using nearest expiry: ${targetExpiry}`);
    }

    // Step 2: Fetch full option chain
    const ocData = await getDhanOC(clientId, accessToken, targetExpiry);
    if (!ocData?.oc) throw new Error('No OC data in Dhan response');

    const spotPrice = spot || ocData.last_price || 0;
    const atmStrike = spotPrice ? Math.round(spotPrice / 50) * 50 : 0;

    // Step 3: Parse into analyze.js format
    let totCeOI = 0, totPeOI = 0;
    let maxCeOI = 0, maxPeOI = 0;
    let callWall = atmStrike, putWall = atmStrike;
    let atmCeP = 0, atmPeP = 0, atmCeIV = 0, atmPeIV = 0;

    const rows = {};
    for (const [strikeStr, strikeData] of Object.entries(ocData.oc)) {
      const strike = Math.round(parseFloat(strikeStr));
      const ce = strikeData.ce || {};
      const pe = strikeData.pe || {};

      rows[strike] = {
        ce: {
          ltp:    ce.last_price      || 0,
          oi:     ce.oi              || 0,
          prevOi: ce.previous_oi     || 0,
          oiChg:  (ce.oi||0) - (ce.previous_oi||0),
          iv:     ce.implied_volatility || 0,
          delta:  ce.greeks?.delta   || 0,
          theta:  ce.greeks?.theta   || 0,
        },
        pe: {
          ltp:    pe.last_price      || 0,
          oi:     pe.oi              || 0,
          prevOi: pe.previous_oi     || 0,
          oiChg:  (pe.oi||0) - (pe.previous_oi||0),
          iv:     pe.implied_volatility || 0,
          delta:  pe.greeks?.delta   || 0,
          theta:  pe.greeks?.theta   || 0,
        },
      };

      // Accumulate OI totals
      const ceOI = ce.oi || 0;
      const peOI = pe.oi || 0;
      totCeOI += ceOI;
      totPeOI += peOI;

      // Track walls (highest OI strikes)
      if (ceOI > maxCeOI) { maxCeOI = ceOI; callWall = strike; }
      if (peOI > maxPeOI) { maxPeOI = peOI; putWall  = strike; }

      // ATM premiums
      if (strike === atmStrike) {
        atmCeP  = ce.last_price || 0;
        atmPeP  = pe.last_price || 0;
        atmCeIV = ce.implied_volatility || 0;
        atmPeIV = pe.implied_volatility || 0;
      }
    }

    // PCR
    const pcr = totCeOI > 0 ? (totPeOI / totCeOI).toFixed(3) : '0';

    // Max pain
    const sortedStrikes = Object.keys(rows).map(Number).sort((a,b) => b - a);
    let maxPain = atmStrike, minLoss = Infinity;
    for (const target of sortedStrikes) {
      let loss = 0;
      for (const st of sortedStrikes) {
        if (target < st) loss += (rows[st].ce.oi) * (st - target);
        if (target > st) loss += (rows[st].pe.oi) * (target - st);
      }
      if (loss < minLoss) { minLoss = loss; maxPain = target; }
    }

    // ATM IV (use CE IV, fall back to PE)
    const atmIV = atmCeIV || atmPeIV || 0;

    // Build OC table string (same format as NSE parser)
    const fc = n => (n >= 0 ? '+' : '') + String(Math.round(n)).padStart(8);
    let ocTable = 'Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
    ocTable    += '-------|--------|------------|----------|--------|------------|----------\n';

    // Show ±10 strikes around ATM
    const nearStrikes = sortedStrikes.filter(st => Math.abs(st - atmStrike) <= 500);
    for (const st of nearStrikes) {
      const { ce, pe } = rows[st];
      const marker = st === atmStrike ? ' ← ATM' : st === callWall ? ' ← CALL WALL' : st === putWall ? ' ← PUT WALL' : '';
      ocTable += `${String(st).padStart(6)} | ${String(ce.ltp.toFixed(0)).padStart(6)} | ${String(ce.oi).padStart(10)} | ${fc(ce.oiChg)} | ${String(pe.ltp.toFixed(0)).padStart(6)} | ${String(pe.oi).padStart(10)} | ${fc(pe.oiChg)}${marker}\n`;
    }

    console.log(`[dhan-oc] ok — expiry=${targetExpiry} spot=${spotPrice} atm=${atmStrike} atmCeP=${atmCeP} atmPeP=${atmPeP} pcr=${pcr} atmIV=${atmIV.toFixed(1)}%`);

    return res.json({
      status:    'success',
      expiry:    targetExpiry,
      spotPrice,
      atmStrike,
      atmCeP,
      atmPeP,
      atmIV,
      pcr,
      callWall,
      putWall,
      maxPain,
      totCeOI,
      totPeOI,
      ocTable,
      rows,       // full strike data for IVP computation
      src:        'Dhan',
    });

  } catch(err) {
    console.error('[dhan-oc] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
