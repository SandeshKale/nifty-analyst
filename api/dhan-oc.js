// api/dhan-oc.js
// Fetches NIFTY option chain from Dhan API — free, no IP restriction, global access
// Provides: PCR, call/put walls, max pain, ATM CE/PE premiums, OI per strike, IV
// Used as primary source for F2 (PCR/OI) and F9 (IVP)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { return res.status(405).json({ error: 'Method not allowed' }); }

  const clientId = process.env.DHAN_CLIENT_ID;
  const token    = process.env.DHAN_ACCESS_TOKEN;
  if (!clientId || !token) {
    return res.status(500).json({ error: 'DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN not configured' });
  }

  const { expiry, spot } = req.body;
  if (!expiry) return res.status(400).json({ error: 'expiry required (YYYY-MM-DD)' });

  const headers = {
    'access-token': token,
    'client-id':    clientId,
    'Content-Type': 'application/json',
  };

  try {
    const r = await fetch('https://api.dhan.co/v2/optionchain', {
      method: 'POST',
      headers,
      body: JSON.stringify({ UnderlyingScrip: 13, UnderlyingSeg: 'IDX_I', Expiry: expiry }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[dhan-oc] API error ${r.status}: ${errText.slice(0,120)}`);
      return res.status(r.status).json({ error: `Dhan API error: ${r.status}`, detail: errText.slice(0,200) });
    }

    const data = await r.json();
    if (data.status !== 'success' || !data.data) {
      return res.status(400).json({ error: 'Dhan OC returned no data', raw: data });
    }

    const ocRaw    = data.data;
    const atmStrike = spot ? Math.round(spot / 50) * 50 : null;
    let totCeOI = 0, totPeOI = 0, maxCeOI = 0, maxPeOI = 0;
    let callWall = atmStrike, putWall = atmStrike;
    let atmCeP = 0, atmPeP = 0, atmCeIV = 0, atmPeIV = 0;
    const rows = {};

    for (const [strikeStr, sides] of Object.entries(ocRaw)) {
      const strike = parseInt(strikeStr);
      const ce = sides.CE || sides.ce || {};
      const pe = sides.PE || sides.pe || {};
      const ceLTP  = parseFloat(ce.LTP  || ce.ltp  || 0);
      const peLTP  = parseFloat(pe.LTP  || pe.ltp  || 0);
      const ceOI   = parseInt(ce.OI     || ce.oi   || 0);
      const peOI   = parseInt(pe.OI     || pe.oi   || 0);
      const ceIV   = parseFloat(ce.ImpliedVolatility || ce.IV || ce.iv || 0);
      const peIV   = parseFloat(pe.ImpliedVolatility || pe.IV || pe.iv || 0);
      const ceOIChg = parseInt(ce.OIChange || ce.changeInOI || 0);
      const peOIChg = parseInt(pe.OIChange || pe.changeInOI || 0);
      rows[strike] = { ce: { ltp:ceLTP,oi:ceOI,oiChg:ceOIChg,iv:ceIV }, pe: { ltp:peLTP,oi:peOI,oiChg:peOIChg,iv:peIV } };
      totCeOI += ceOI; totPeOI += peOI;
      if (ceOI > maxCeOI) { maxCeOI = ceOI; callWall = strike; }
      if (peOI > maxPeOI) { maxPeOI = peOI; putWall  = strike; }
      if (atmStrike && strike === atmStrike) { atmCeP=ceLTP; atmPeP=peLTP; atmCeIV=ceIV; atmPeIV=peIV; }
    }

    const sortedStrikes = Object.keys(rows).map(Number).sort((a,b) => b-a);
    let maxPain = atmStrike || sortedStrikes[Math.floor(sortedStrikes.length/2)], minLoss = Infinity;
    for (const target of sortedStrikes) {
      let loss = 0;
      for (const st of sortedStrikes) {
        if (target < st) loss += rows[st].ce.oi * (st - target);
        if (target > st) loss += rows[st].pe.oi * (target - st);
      }
      if (loss < minLoss) { minLoss = loss; maxPain = target; }
    }

    const pcr = totCeOI > 0 ? (totPeOI/totCeOI).toFixed(3) : '0';
    const atmIV = atmCeIV || atmPeIV || 0;
    const fc = n => (n>=0?'+':'')+String(Math.round(n)).padStart(8);
    let ocTable = 'Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
    ocTable    += '-------|--------|------------|----------|--------|------------|----------\n';
    const displayStrikes = atmStrike ? sortedStrikes.filter(s=>Math.abs(s-atmStrike)<=500) : sortedStrikes.slice(0,20);
    for (const st of displayStrikes) {
      const {ce,pe} = rows[st];
      ocTable += `${String(st).padStart(6)} | ${String((ce?.ltp||0).toFixed(0)).padStart(6)} | ${String(ce?.oi||0).padStart(10)} | ${fc(ce?.oiChg||0)} | ${String((pe?.ltp||0).toFixed(0)).padStart(6)} | ${String(pe?.oi||0).padStart(10)} | ${fc(pe?.oiChg||0)}\n`;
    }

    console.log(`[dhan-oc] ok — strikes=${sortedStrikes.length} atmCeP=${atmCeP} atmPeP=${atmPeP} pcr=${pcr} callWall=${callWall} putWall=${putWall} atmIV=${atmIV}`);
    return res.json({ status:'success', pcr, callWall, putWall, maxPain, atmCeP, atmPeP, atmIV, totCeOI, totPeOI, ocTable, strikeCount:sortedStrikes.length, src:'Dhan' });

  } catch(err) {
    console.error('[dhan-oc] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
