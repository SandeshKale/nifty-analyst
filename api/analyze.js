// api/analyze.js — Nifty Options Analyst v9
// Using Node.js runtime with Fluid Compute (up to 800s on Pro, 300s on Hobby)
// Data: Yahoo Finance (spot/candles/global) + NSE (option chain) + Kite (margins/orders)
// Fast: parallel fetches, 5s timeouts, no blocking cookie retries

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Single try-catch wraps EVERYTHING
  try {
    const body = req.body || {};
    const accessToken = body.accessToken;
    // kiteApiKey: optional override for users with their own Kite developer app
    // Sandesh: sends nothing → uses KITE_API_KEY env var on server
    // Omkar: sends his omkar_api_key → uses OMKAR_KITE_API_KEY env var on server
    const kiteApiKey  = body.kiteApiKey  || null;
    const useDeepSeek = body.useDeepSeek || false;
    
    if (!accessToken) {
      return res.status(400).json({ error: 'accessToken required' });
    }

    // Gate: only run during NSE market hours (9:15–15:30 IST, Mon–Fri)
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(), h = ist.getHours(), m = ist.getMinutes();
    const mins = h*60+m;
    const isWeekend = day===0||day===6;
    const inSession = !isWeekend && mins>=9*60+15 && mins<15*60+30;
    if (!inSession) {
      const reason = isWeekend ? 'Weekend — market closed'
        : mins < 9*60+15 ? `Pre-market — opens at 9:15 AM IST (${9*60+15-mins} min)`
        : 'Post-market — market closed at 3:30 PM IST';
      return res.status(403).json({ error: `Analysis blocked: ${reason}. Run only during 9:15-15:30 IST Mon-Fri.` });
    }

    return await runAnalysis(req, res, accessToken, useDeepSeek, kiteApiKey);
  } catch(fatal) {
    console.error('Fatal:', fatal.message);
    return res.status(500).json({ error: 'Analysis failed: ' + fatal.message });
  }
}

async function runAnalysis(req, res, accessToken, useDeepSeek, kiteApiKey) {

  // Use caller's API key if provided, else fall back to server env var
  const apiKey = kiteApiKey || process.env.KITE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No Kite API key configured' });

  // Declare at top so it's always in scope — set true later when OC data missing
  let ocDataMissing = false;
  const kH = { 'Authorization': `token ${apiKey}:${accessToken}`, 'X-Kite-Version': '3' };

  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const istStr  = ist.toISOString().slice(0,19) + '+05:30';
  const sgtStr  = new Date(now.getTime() + 8*3600000).toISOString().slice(0,19) + '+08:00';
  const todayDate = ist.toISOString().slice(0,10);
  const dayName   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getDay()];
  const istH = ist.getHours(), istM = ist.getMinutes();
  const istMins = istH*60 + istM;
  const isPreMarket  = istMins < 9*60+15;
  const isPostMarket = istMins >= 15*60+30;

  const prevTradingDate = (() => {
    const d = new Date(ist); d.setDate(d.getDate()-1);
    while([0,6].includes(d.getDay())) d.setDate(d.getDate()-1);
    return d.toISOString().slice(0,10);
  })();
  const hist5mDate = isPreMarket ? prevTradingDate : todayDate;  // eslint-disable-line no-unused-vars

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getExpiry(offsetW=0) {
    const d=new Date(ist); const day=d.getDay();
    let da=day<=2?(2-day):(9-day);
    if(day===2){const ac=d.getHours()>15||(d.getHours()===15&&d.getMinutes()>=30);da=ac?7:0;}
    da+=offsetW*7;
    const exp=new Date(d.getTime()+da*86400000);
    const yy=String(exp.getFullYear()).slice(2);
    const m=['1','2','3','4','5','6','7','8','9','A','B','C'][exp.getMonth()];
    const dd=String(exp.getDate()).padStart(2,'0');
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const nseStr=`${String(exp.getDate()).padStart(2,'0')}-${months[exp.getMonth()]}-${exp.getFullYear()}`;
    return {dateStr:exp.toISOString().slice(0,10),yy,m,dd,nseStr,
      dte:Math.max(0,Math.ceil((exp-ist)/86400000)),
      isExpiry:d.getDay()===2&&da===0};
  }
  const calcVWAP=c=>{if(!c?.length)return 0;let tv=0,v=0;for(const x of c){const tp=(x[2]+x[3]+x[4])/3;tv+=tp*x[5];v+=x[5];}return v?tv/v:0;};
  const calcSMA=(a,n)=>{if(!a?.length)return 0;const sl=a.slice(-n);return sl.reduce((s,y)=>s+y,0)/sl.length;};
  const calcEMA=(a,n)=>{if(!a||a.length<n)return a?.[a.length-1]||0;const k=2/(n+1);let e=a.slice(0,n).reduce((s,y)=>s+y,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;};

  // ── Fast fetch with timeout ───────────────────────────────────────────────
  async function tFetch(url, opts={}, ms=5000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(tid);
      return r;
    } catch(e) { clearTimeout(tid); throw e; }
  }

  // ── Yahoo Finance ─────────────────────────────────────────────────────────
  const yfH = { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124' };
  async function yfFetch(sym, interval='1d', range='2d') {
    try {
      const r = await tFetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
        {headers:yfH}, 6000
      );
      const j = await r.json().catch(()=>null);
      return j?.chart?.result?.[0] || null;
    } catch { return null; }
  }
  const toG = r => {
    if(!r?.meta) return null;
    const m=r.meta;
    const cur=m.regularMarketPrice;
    const prev=m.previousClose||m.chartPreviousClose||cur||0;
    if(!cur||!prev||isNaN(cur)||isNaN(prev)) return null;  // guard undefined/NaN
    const chg=cur-prev, pct=((chg/prev)*100);
    return {price:cur, prev, chg:isNaN(chg)?'0':chg.toFixed(2), pct:isNaN(pct)?'0':pct.toFixed(2)};
  };

  // ── NSE fetch (no cookie — relies on Yahoo fallback if blocked) ─────────────
  const nseH = {
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept':'application/json,text/plain,*/*',
    'Accept-Language':'en-US,en;q=0.9',
    'Referer':'https://www.nseindia.com/',
    'Origin':'https://www.nseindia.com',
  };
  async function nseGet(path) {
    try {
      const r = await tFetch(`https://www.nseindia.com${path}`, {headers:nseH}, 5000);
      if(r.ok) return r.json().catch(()=>null);
      return null;
    } catch { return null; }
  }

  // ── Yahoo Finance options fallback ───────────────────────────────────────
  async function yfOptions(sym, forceNextExpiry = false) {
    try {
      // On expiry day, fetch next week's options (not today's near-zero expiry)
      // Yahoo accepts ?date=UNIX_TIMESTAMP to select a specific expiry
      let url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}`;
      if (forceNextExpiry) {
        // Get all available expiry dates first, pick the second one (next week)
        const r0 = await tFetch(url, {headers:yfH}, 6000);
        const j0 = await r0.json().catch(()=>null);
        const dates = j0?.optionChain?.result?.[0]?.expirationDates || [];
        if (dates.length >= 2) {
          url += `?date=${dates[1]}`; // second expiry = next week
        }
      }
      const r = await tFetch(url, {headers:yfH}, 6000);
      const j = await r.json().catch(()=>null);
      return j?.optionChain?.result?.[0] || null;
    } catch { return null; }
  }

  // ── Kite option chain builder ────────────────────────────────────────────
  // Fetches real OC data via Kite /quote API — works from any IP globally.
  // Steps: instruments CSV → filter NIFTY weekly expiry → batch /quote → parse.
  // Returns same shape as NSE OC parser output.
  async function kiteOC(spotPrice, expiryObj) {
    try {
      if (!spotPrice || spotPrice <= 0) return null;

      // Build trading symbols for ±10 strikes around ATM (50-pt grid)
      const atmStrike = Math.round(spotPrice / 50) * 50;
      const strikes   = [];
      for (let i = -10; i <= 10; i++) strikes.push(atmStrike + i * 50);

      // Kite expiry format: DDMMMYY e.g. 26MAY25
      const exp = expiryObj;
      const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      // Parse expiry date from dateStr (YYYY-MM-DD)
      const [ey, em, ed] = exp.dateStr.split('-').map(Number);
      const kiteExpStr   = `${String(ed).padStart(2,'0')}${months[em-1]}${String(ey).slice(2)}`;
      // e.g. "26MAY25"

      // Build instrument keys: NFO:NIFTY26MAY25C23400 / NFO:NIFTY26MAY25P23400
      // Kite uses tradingsymbol format: NIFTY + DDMMMYY + CE/PE + strike (no decimals for index)
      const instruments = [];
      for (const st of strikes) {
        instruments.push(`NFO:NIFTY${kiteExpStr}C${st}`);
        instruments.push(`NFO:NIFTY${kiteExpStr}P${st}`);
      }

      // Kite /quote accepts up to 250 instruments as repeated ?i= params
      const params = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&');
      const r = await tFetch(
        `https://api.kite.trade/quote?${params}`,
        { headers: kH }, 8000
      );
      if (!r.ok) {
        console.warn('[kite-oc] quote failed HTTP', r.status);
        return null;
      }
      const j = await r.json().catch(() => null);
      if (!j?.data || !Object.keys(j.data).length) {
        console.warn('[kite-oc] empty quote response');
        return null;
      }

      // Parse into OC structure
      const rows = {};  // strike → { ce, pe }
      for (const [key, q] of Object.entries(j.data)) {
        // Key: "NFO:NIFTY26MAY25C23400"
        const isCall = key.includes('C' + String(strikes[0]).slice(0,1)) ||
                       /[CP]\d+$/.test(key) && key.slice(-key.match(/[CP]\d+$/)[0].length,-key.match(/\d+$/)[0].length) === 'C';
        // More reliable: check if key ends with CE or PE after stripping number
        const sideMatch = key.match(/([CP])(\d+)$/);
        if (!sideMatch) continue;
        const side   = sideMatch[1] === 'C' ? 'ce' : 'pe';
        const strike = parseInt(sideMatch[2]);
        if (!rows[strike]) rows[strike] = { ce: null, pe: null };
        rows[strike][side] = {
          ltp:       q.last_price       || 0,
          oi:        q.oi               || 0,
          prevOi:    q.oi_day_low       || 0,   // oi_day_low ≈ prev OI (opening OI)
          oiChg:     (q.oi || 0) - (q.oi_day_low || 0),
          iv:        0,   // Kite quote doesn't return IV — compute from Black-Scholes if needed
          volume:    q.volume           || 0,
        };
      }

      if (!Object.keys(rows).length) {
        console.warn('[kite-oc] no rows parsed');
        return null;
      }

      // Compute PCR, walls, max pain, ATM premiums
      let totCeOI = 0, totPeOI = 0;
      let maxCeOI = 0, maxPeOI = 0;
      let kCallWall = atmStrike, kPutWall = atmStrike;
      let kAtmCeP = 0, kAtmPeP = 0;

      const sortedStrikes = Object.keys(rows).map(Number).sort((a,b) => b-a);

      for (const st of sortedStrikes) {
        const { ce, pe } = rows[st];
        if (ce) { totCeOI += ce.oi; if (ce.oi > maxCeOI) { maxCeOI = ce.oi; kCallWall = st; } }
        if (pe) { totPeOI += pe.oi; if (pe.oi > maxPeOI) { maxPeOI = pe.oi; kPutWall  = st; } }
      }

      // Max pain
      let kMaxPain = atmStrike, minLoss = Infinity;
      for (const target of sortedStrikes) {
        let loss = 0;
        for (const st of sortedStrikes) {
          if (target < st && rows[st].ce) loss += rows[st].ce.oi * (st - target);
          if (target > st && rows[st].pe) loss += rows[st].pe.oi * (target - st);
        }
        if (loss < minLoss) { minLoss = loss; kMaxPain = target; }
      }

      // ATM premiums
      const atmRow = rows[atmStrike];
      kAtmCeP = atmRow?.ce?.ltp || 0;
      kAtmPeP = atmRow?.pe?.ltp || 0;
      const kPcr = totCeOI > 0 ? (totPeOI / totCeOI).toFixed(3) : '0';

      // Build OC table string
      let kOcTable = 'Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
      kOcTable    += '-------|--------|------------|----------|--------|------------|----------\n';
      const fc = n => (n>=0?'+':'')+String(Math.round(n)).padStart(8);
      for (const st of sortedStrikes) {
        const { ce, pe } = rows[st];
        kOcTable += `${String(st).padStart(6)} | ${String((ce?.ltp||0).toFixed(0)).padStart(6)} | ${String(ce?.oi||0).padStart(10)} | ${fc(ce?.oiChg||0)} | ${String((pe?.ltp||0).toFixed(0)).padStart(6)} | ${String(pe?.oi||0).padStart(10)} | ${fc(pe?.oiChg||0)}\n`;
      }

      console.log(`[kite-oc] ok — ${Object.keys(rows).length} strikes, atmCeP=${kAtmCeP}, atmPeP=${kAtmPeP}, pcr=${kPcr}`);

      return {
        pcr: kPcr, callWall: kCallWall, putWall: kPutWall, maxPain: kMaxPain,
        atmCeP: kAtmCeP, atmPeP: kAtmPeP,
        totCeOI, totPeOI, ocTable: kOcTable,
        ivpVal: 0,   // IV not in Kite quote — keep existing IVP calc
        src: 'Kite',
        rows,
      };
    } catch(e) {
      console.warn('[kite-oc] error:', e.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TWO-WAVE PARALLEL FETCH (Opp 3)
  // Wave 1 (~1s): Fast data — Kite, Yahoo spot/VIX/BN, globals
  // Wave 2 (~4-5s): Slow data — NSE option chain (started simultaneously,
  //   but we don't block on it until after wave-1 processing is done)
  // Net saving: ~3-4s vs single Promise.allSettled waiting for slowest source
  // ══════════════════════════════════════════════════════════════════════════
  const expiry = getExpiry(0), expiryNx = getExpiry(1);

  // Start BOTH waves immediately — they run in true parallel
  // Wave 2 promises are fired NOW, not after wave 1 resolves
  const ocPromise     = nseGet(`/api/option-chain-indices?symbol=NIFTY`);
  const idxPromise    = nseGet('/api/allIndices');
  // On expiry day, force Yahoo options to use next week's expiry
  const isExpiryDayEarly = ist.getDay() === 2 &&
    (ist.getHours() * 60 + ist.getMinutes()) < 15 * 60 + 30;
  const yfOptsPromise = yfOptions('^NSEI', isExpiryDayEarly);
  // Also start NSE FII/DII data (Opp 4 — live F6 data)
  const fiiPromise    = nseGet('/api/fiidiiTradeReact').catch(() => null);
  // Kite OC promise — fired early, awaited after spot is known (wave 2)
  // kiteOC needs spot price which comes from wave 1, so we build a deferred promise
  let kiteOCResolve;
  const kiteOCPromise = new Promise(resolve => { kiteOCResolve = resolve; });

  // Wave 1: fast sources — resolve in ~1-2s
  const [
    margR, posR, ordR,
    yIntra, yDaily,
    yBN, yVix,
    sp500R, dowR, nasR, crudeR, goldR, usdInrR, nikkeiR, hsiR,
  ] = await Promise.allSettled([
    tFetch('https://api.kite.trade/user/margins',{headers:kH},6000).then(r=>r.json()).catch(()=>null),
    tFetch('https://api.kite.trade/portfolio/positions',{headers:kH},6000).then(r=>r.json()).catch(()=>null),
    tFetch('https://api.kite.trade/orders',{headers:kH},6000).then(r=>r.json()).catch(()=>null),
    yfFetch('^NSEI','5m','1d'),
    yfFetch('^NSEI','1d','60d'),
    yfFetch('^NSEBANK','1d','2d'),
    yfFetch('^INDIAVIX','1d','2d'),
    yfFetch('^GSPC'), yfFetch('^DJI'), yfFetch('^IXIC'),
    yfFetch('BZ=F'),  yfFetch('GC=F'), yfFetch('INR=X'),  // BZ=F = Brent ICE (trades 24hr, live during IST)
    yfFetch('^N225'), yfFetch('^HSI'),
  ]);

  const gv = r => r.status==='fulfilled' ? r.value : null;

  // Wave 2: await the slow NSE sources (already running in background since line 1)
  // By now wave-1 processing + technicals have consumed ~10ms, so OC is nearly ready
  // Also fire Kite OC now that we have spot price from wave 1
  // On expiry day (today = Tuesday AND market open), use NEXT week's expiry
  // because same-day options have near-zero premiums — not tradeable.
  // The display expiry (used for scorecard) already handles this correctly.
  const isExpiryDay = ist.getDay() === 2 &&
    (ist.getHours() * 60 + ist.getMinutes()) < 15 * 60 + 30;
  const ocExpiryObj = isExpiryDay ? getExpiry(1) : getExpiry(0);
  console.log(`[kite-oc] using expiry: ${ocExpiryObj.dateStr} (isExpiryDay=${isExpiryDay})`);

  const kiteOCStarted = kiteOC(
    gv(yIntra)?.meta?.regularMarketPrice || gv(yDaily)?.meta?.regularMarketPrice || 0,
    ocExpiryObj
  );
  kiteOCResolve(kiteOCStarted);  // resolve the deferred promise

  const [ocJ, idxJ, yfOptsR, fiiJ, kiteOCR] = await Promise.allSettled([
    ocPromise, idxPromise, yfOptsPromise, fiiPromise, kiteOCPromise,
  ]);

  // ── Kite: margins, positions, orders ──────────────────────────────────────
  const margJ=gv(margR), posJ=gv(posR), ordJ=gv(ordR);
  const liveF=margJ?.data?.equity?.available?.cash??margJ?.data?.equity?.net??0;
  const openPos=(posJ?.data?.net||[]).filter(p=>p.quantity!==0);
  const posText=openPos.length?openPos.map(p=>`${p.tradingsymbol}: Qty ${p.quantity}, Avg ₹${(p.average_price||0).toFixed(2)}, LTP ₹${(p.last_price||0).toFixed(2)}, P&L ₹${(p.pnl||0).toFixed(2)}`).join('\n'):'None';
  const pendOrds=(ordJ?.data||[]).filter(o=>['OPEN','TRIGGER PENDING'].includes(o.status));
  const ordText=pendOrds.length?pendOrds.map(o=>`${o.tradingsymbol}: ${o.transaction_type} ${o.quantity}@${o.price}`).join('\n'):'None';

  // ── Yahoo Finance: Nifty spot + candles ───────────────────────────────────
  const yI=gv(yIntra), yD=gv(yDaily), yBNv=gv(yBN), yVixv=gv(yVix);

  // Build candle arrays from Yahoo Finance format
  function buildCandles(data) {
    if(!data?.timestamp) return [];
    const ts=data.timestamp, q=data.indicators?.quote?.[0]||{};
    const out=[];
    for(let i=0;i<ts.length;i++){
      const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i],v=q.volume?.[i];
      if(o!=null&&h!=null&&l!=null&&c!=null) out.push([new Date(ts[i]*1000).toISOString(),o,h,l,c,v||0]);
    }
    return out;
  }
  const c5m  = buildCandles(yI);
  const cDay = buildCandles(yD);

  // Spot from Yahoo ^NSEI meta
  let spot    = yI?.meta?.regularMarketPrice || yD?.meta?.regularMarketPrice || 0;
  let prevCl  = yI?.meta?.previousClose || yI?.meta?.chartPreviousClose || (cDay.length>=2?cDay[cDay.length-2]?.[4]:0) || spot;
  let dayH    = yI?.meta?.regularMarketDayHigh || (c5m.length?Math.max(...c5m.map(c=>c[2])):0);
  let dayL    = yI?.meta?.regularMarketDayLow  || (c5m.length?Math.min(...c5m.map(c=>c[3])):0);
  let dayO    = c5m[0]?.[1] || spot;
  let bn      = yBNv?.meta?.regularMarketPrice || 0;
  let vix     = yVixv?.meta?.regularMarketPrice || 0;

  // Try NSE allIndices for better data (it might work)
  const nseIdx = gv(idxJ);
  let advances='N/A', declines='N/A';
  let niftyIT=0,niftyAuto=0,niftyFin=0,niftyMid=0;
  let nseSrc='Yahoo';
  if(nseIdx?.data){
    nseSrc='NSE+Yahoo';
    const findIdx=name=>nseIdx.data.find(d=>d.index===name||d.indexSymbol===name)||null;
    const n50=findIdx('NIFTY 50')||findIdx('Nifty 50');
    const nvix=findIdx('INDIA VIX')||findIdx('India Vix');
    const bnk=findIdx('NIFTY BANK')||findIdx('Nifty Bank');
    const nit=findIdx('NIFTY IT')||findIdx('Nifty IT');
    const nau=findIdx('NIFTY AUTO')||findIdx('Nifty Auto');
    const nfi=findIdx('NIFTY FIN SERVICE')||findIdx('Nifty Fin Service');
    const nmi=findIdx('NIFTY MIDCAP 100')||findIdx('NIFTY MIDCAP100')||findIdx('Nifty Midcap 100');
    if(n50?.last) { spot=n50.last; prevCl=n50.previousClose||spot; dayH=n50.high||dayH; dayL=n50.low||dayL; dayO=n50.open||dayO; advances=n50.advances||'N/A'; declines=n50.declines||'N/A'; }
    if(nvix?.last) vix=nvix.last;
    if(bnk?.last)  bn=bnk.last;
    if(nit?.last)  niftyIT=nit.last;
    if(nau?.last)  niftyAuto=nau.last;
    if(nfi?.last)  niftyFin=nfi.last;
    if(nmi?.last)  niftyMid=nmi.last;
  }

  // ── F9: IVP from India VIX 30-day history ────────────────────────────────
  // VIX itself is a good IV proxy for Nifty — compute its percentile rank
  // over the last 30 trading days to get IVP without needing OC data.
  // yVixv contains 60d daily data for ^INDIAVIX already fetched in wave 1.
  let computedIVP = 0;
  try {
    const vixCandles = buildCandles(gv(yVix));  // 60d daily VIX candles
    if (vixCandles.length >= 10 && vix > 0) {
      const vix30 = vixCandles.slice(-30).map(c => c[4]);  // last 30 closes
      const below  = vix30.filter(v => v <= vix).length;
      computedIVP  = Math.round((below / vix30.length) * 100);
      console.log(`[ivp] computed IVP=${computedIVP}% from ${vix30.length} VIX days`);
    }
  } catch(ivpErr) {
    console.warn('[ivp] compute error:', ivpErr.message);
  }

  // ── Derived calculations ──────────────────────────────────────────────────
  const atm    = spot ? Math.round(spot/50)*50 : 0;
  const vwap   = calcVWAP(c5m);
  const cl30   = cDay.map(c=>c[4]);
  const sma20  = calcSMA(cl30,20), ema9=calcEMA(cl30,9), ema21=calcEMA(cl30,21);
  const orC    = c5m.slice(0,3);
  const orh    = orC.length?Math.max(...orC.map(c=>c[2])):dayH;
  const orl    = orC.length?Math.min(...orC.map(c=>c[3])):dayL;
  const hIdx   = c5m.findIndex(c=>c[2]===dayH), lIdx=c5m.findIndex(c=>c[3]===dayL);
  const htim   = c5m.length?hIdx<=6?'FIRST 30MIN':hIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY':'N/A';
  const ltim   = c5m.length?lIdx<=6?'FIRST 30MIN':lIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY':'N/A';
  const last5  = c5m.slice(-5);
  const mom    = last5.length>=3?(()=>{const hhs=last5.every((c,i)=>i===0||c[2]>=last5[i-1][2]);const lls=last5.every((c,i)=>i===0||c[3]<=last5[i-1][3]);return hhs?'BULLISH HH/HL':lls?'BEARISH LL/LH':'MIXED';})():'N/A';
  const instC  = c5m.filter(c=>(c[2]-c[3])>80);
  const instDesc=instC.length?`${instC.length} candle(s). Last: ${instC[instC.length-1][4]>instC[instC.length-1][1]?'BULLISH':'BEARISH'} @ ${instC[instC.length-1][0].slice(11,16)}`:'None';
  const green10= cDay.slice(-10).filter(c=>c[4]>=c[1]).length;
  const highs30= cDay.slice(-30).map(c=>c[2]), lows30=cDay.slice(-30).map(c=>c[3]);
  const r2     = highs30.length?Math.max(...highs30):0, s2=lows30.length?Math.min(...lows30):0;
  const highs10= cDay.slice(-10).map(c=>c[2]), lows10=cDay.slice(-10).map(c=>c[3]);
  const r1     = highs10.length?Math.max(...highs10):0, s1=lows10.length?Math.min(...lows10):0;
  const pvDay  = cDay[cDay.length-1];
  const pivot  = pvDay?((pvDay[2]+pvDay[3]+pvDay[4])/3).toFixed(2):'0';
  const maxAfford=liveF>0?((liveF/65)||0).toFixed(2):'0';
  const last20c= c5m.slice(-6).map(c=>`[${c[0].slice(11,16)} O:${c[1].toFixed(0)} H:${c[2].toFixed(0)} L:${c[3].toFixed(0)} C:${c[4].toFixed(0)}]`).join(' ');
  const last15d= cDay.slice(-5).map(c=>`[${c[0].slice(5,10)} O:${c[1].toFixed(0)} H:${c[2].toFixed(0)} L:${c[3].toFixed(0)} C:${c[4].toFixed(0)}]`).join(' ');

  // ── Option Chain — Priority: Kite → NSE → Yahoo ──────────────────────────
  // Kite /quote: real-time, no geo-block, uses user's own auth token
  // NSE: often blocked from Singapore/Vercel (geo-CDN restriction)
  // Yahoo: stale at open, limited strikes
  let pcr='0',callWall=atm,putWall=atm,maxPain=atm,atmCeP=0,atmPeP=0,nxAtmCeP=0,nxAtmPeP=0,ivpVal=0;
  let totCeOI=0,totPeOI=0;
  let ocTable='Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
  ocTable    +='-------|--------|------------|----------|--------|------------|----------\n';
  // OC source tracker — reuses nseSrc declared above
  // (nseSrc already set by NSE allIndices section)

  // ── Source 1: Kite /quote (primary — globally accessible, real-time) ─────
  const kiteOCData = gv(kiteOCR);   // result from kiteOC() called in wave 2
  if (kiteOCData && kiteOCData.atmCeP > 0 && atm > 0) {
    pcr      = kiteOCData.pcr;
    callWall = kiteOCData.callWall;
    putWall  = kiteOCData.putWall;
    maxPain  = kiteOCData.maxPain;
    atmCeP   = kiteOCData.atmCeP;
    atmPeP   = kiteOCData.atmPeP;
    totCeOI  = kiteOCData.totCeOI;
    totPeOI  = kiteOCData.totPeOI;
    ocTable  = kiteOCData.ocTable;
    ivpVal   = kiteOCData.ivpVal || ivpVal;
    nseSrc   = 'Kite';
    // Next expiry ATM premiums — Kite doesn't have these in this call, leave as 0
    nxAtmCeP = 0; nxAtmPeP = 0;
    console.log(`[oc] using Kite source — atmCeP=${atmCeP} atmPeP=${atmPeP}`);
  }

  // ── Source 2: NSE (fallback if Kite OC failed) ───────────────────────────
  const ocData = gv(ocJ);
  if (!kiteOCData?.atmCeP && ocData?.records?.data && atm > 0) {
    nseSrc = 'NSE';
    const tExp=expiry.nseStr, nxExp=expiryNx.nseStr;
    const ocRows=ocData.records.data.filter(r=>r.expiryDate===tExp);
    const nxOcRows=ocData.records.data.filter(r=>r.expiryDate===nxExp);
    if(!spot&&ocData.records.underlyingValue) spot=ocData.records.underlyingValue;
    const strikes=[...new Set(ocRows.map(r=>r.strikePrice))].sort((a,b)=>Math.abs(a-atm)-Math.abs(b-atm)).slice(0,12).sort((a,b)=>b-a);
    let maxCeOI=0,maxPeOI=0;
    for(const st of strikes){
      const row=ocRows.find(r=>r.strikePrice===st)||{};
      const ce=row.CE||{}, pe=row.PE||{};
      if(ce.openInterest){totCeOI+=ce.openInterest;if(ce.openInterest>maxCeOI){maxCeOI=ce.openInterest;callWall=st;}}
      if(pe.openInterest){totPeOI+=pe.openInterest;if(pe.openInterest>maxPeOI){maxPeOI=pe.openInterest;putWall=st;}}
      const fc=n=>(n>=0?'+':'')+String(Math.round(n)).padStart(8);
      ocTable+=`${String(st).padStart(6)} | ${String((ce.lastPrice||0).toFixed(0)).padStart(6)} | ${String(ce.openInterest||0).padStart(10)} | ${fc(ce.changeinOpenInterest||0)} | ${String((pe.lastPrice||0).toFixed(0)).padStart(6)} | ${String(pe.openInterest||0).padStart(10)} | ${fc(pe.changeinOpenInterest||0)}\n`;
    }
    const tc=ocData.filtered?.CE?.totOI||totCeOI, tp=ocData.filtered?.PE?.totOI||totPeOI;
    pcr=tc>0&&!isNaN(tp/tc)?(tp/tc).toFixed(3):'0';
    let minLoss=Infinity;
    for(const target of strikes){
      let loss=0;
      for(const row of ocRows){const st=row.strikePrice;if(target<st)loss+=(row.CE?.openInterest||0)*(st-target);if(target>st)loss+=(row.PE?.openInterest||0)*(target-st);}
      if(loss<minLoss){minLoss=loss;maxPain=target;}
    }
    const atmRow=ocRows.find(r=>r.strikePrice===atm)||{};
    atmCeP=atmRow.CE?.lastPrice||0; atmPeP=atmRow.PE?.lastPrice||0;
    ivpVal=Math.round(atmRow.CE?.impliedVolatility||atmRow.PE?.impliedVolatility||0);
    const nxAtmRow=nxOcRows.find(r=>r.strikePrice===atm)||{};
    nxAtmCeP=nxAtmRow.CE?.lastPrice||0; nxAtmPeP=nxAtmRow.PE?.lastPrice||0;
    console.log(`[oc] using NSE source — atmCeP=${atmCeP} atmPeP=${atmPeP}`);
  }

  // ── Source 3: Yahoo Finance options (last resort) ────────────────────────
  const yfOptsData=gv(yfOptsR);
  // ── Source 3: Yahoo Finance direct quote for NSE option symbols ─────────
  // When Kite is IP-blocked and NSE is geo-blocked, fetch ATM option price
  // directly from Yahoo Finance chart API using the NSE tradingsymbol.
  // Format: NIFTY02JUN24000CE.NS (Yahoo uses .NS suffix for NSE)
  if (!atmCeP && !atmPeP && atm > 0) {
    try {
      nseSrc = 'Yahoo-Direct';
      // Build ATM CE and PE symbols in Yahoo NSE format
      const months3 = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      const [oey, oem, oed] = ocExpiryObj.dateStr.split('-').map(Number);
      const expTag  = `${String(oed).padStart(2,'0')}${months3[oem-1]}${oey}`;
      // Yahoo NSE option format: NIFTY02JUN2024000CE.NS
      const ceSymYF = `NIFTY${expTag}${atm}CE.NS`;
      const peSymYF = `NIFTY${expTag}${atm}PE.NS`;

      const [ceQ, peQ] = await Promise.allSettled([
        tFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ceSymYF)}?interval=1m&range=1d`, {headers:yfH}, 5000)
          .then(r=>r.json()).catch(()=>null),
        tFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(peSymYF)}?interval=1m&range=1d`, {headers:yfH}, 5000)
          .then(r=>r.json()).catch(()=>null),
      ]);

      const ceData = ceQ.status==='fulfilled' ? ceQ.value?.chart?.result?.[0] : null;
      const peData = peQ.status==='fulfilled' ? peQ.value?.chart?.result?.[0] : null;

      const ceLTP = ceData?.meta?.regularMarketPrice || ceData?.meta?.previousClose || 0;
      const peLTP = peData?.meta?.regularMarketPrice || peData?.meta?.previousClose || 0;

      if (ceLTP > 0) atmCeP = ceLTP;
      if (peLTP > 0) atmPeP = peLTP;

      if (atmCeP > 0 || atmPeP > 0) {
        ocTable = `[Yahoo Direct Quote — ${ceSymYF}]\n`;
        ocTable += `ATM ${atm} CE: Rs${atmCeP.toFixed(1)} | PE: Rs${atmPeP.toFixed(1)}\n`;
        console.log(`[oc] Yahoo direct — ${ceSymYF} LTP=${atmCeP}, ${peSymYF} LTP=${atmPeP}`);
      } else {
        console.warn(`[oc] Yahoo direct — no price for ${ceSymYF}`);
        // Final fallback: Yahoo options chain
        const yfOptsData2 = gv(yfOptsR);
        if (yfOptsData2) {
          const calls = yfOptsData2.options?.[0]?.calls || [];
          const puts  = yfOptsData2.options?.[0]?.puts  || [];
          const atmCall = calls.reduce((b,c)=>Math.abs((c.strike||0)-atm)<Math.abs((b.strike||0)-atm)?c:b, calls[0]||{});
          const atmPut  = puts.reduce((b,p)=>Math.abs((p.strike||0)-atm)<Math.abs((b.strike||0)-atm)?p:b, puts[0]||{});
          if (atmCall.lastPrice) atmCeP = atmCall.lastPrice;
          if (atmPut.lastPrice)  atmPeP = atmPut.lastPrice;
          nseSrc = 'Yahoo-Chain';
          ocTable = `[Yahoo options chain — may be stale]\n`;
          ocTable += `ATM ${atm} CE: Rs${atmCeP?.toFixed(1)} | PE: Rs${atmPeP?.toFixed(1)}\n`;
          console.log(`[oc] Yahoo chain fallback — atmCeP=${atmCeP} atmPeP=${atmPeP}`);
        }
      }
    } catch(yfErr) {
      console.warn('[oc] Yahoo direct quote error:', yfErr.message);
    }
  }

  // ── OC data quality — warn, never block ──────────────────────────────────
  // NSE blocks option chain requests from non-India IPs (incl. Singapore/Vercel).
  // Yahoo options also frequently stale at open. Rather than returning 503 and
  // blocking the user, we flag it clearly in the prompt so the AI can still
  // score the 7 non-OC factors (F1/F3/F4/F5/F6/F7/F8/F11) and give a
  // directional read while explicitly marking F2/F9 as unavailable.
  const ocMissing = atmCeP === 0 && atmPeP === 0;
  if (ocMissing) {
    const earlyMins = istMins - (9*60+15);
    const ocNote = earlyMins < 15
      ? `⚠️ OC DATA PENDING (${earlyMins}min after open) — ATM premiums not yet available. Score F2/F9 as 0. Use other factors only.`
      : '⚠️ OC DATA UNAVAILABLE — NSE option chain blocked (Singapore→NSE CDN issue). Score F2/F9 as 0. Provide directional read from F1/F3/F4/F5/F7/F8/F11 only. Do NOT say STAY OUT solely because of missing OC.';
    console.warn('[oc-guard]', ocNote.slice(0,80));
    // Inject the warning into the OC table so the model sees it prominently
    ocTable = ocNote + '\n' + ocTable;
    // Even without OC, populate IVP from VIX history
    if (!ivpVal && computedIVP > 0) {
      ivpVal = computedIVP;
      console.log(`[ivp] OC missing — using VIX-based IVP=${ivpVal}%`);
    }
  } else {
    console.log(`[oc-guard] ok — atmCeP=${atmCeP} atmPeP=${atmPeP} pcr=${pcr} src=${nseSrc}`);
  // Use VIX-based IVP when OC-based IVP is 0 (Kite blocked or OC missing)
  if (!ivpVal && computedIVP > 0) {
    ivpVal = computedIVP;
    console.log(`[ivp] using VIX-based IVP=${ivpVal}% (OC IVP unavailable)`);
  }
  }

  // ── Critical: block fabricated entry prices when OC data missing ────────
  // When atmCeP=0 the model must NOT invent entry prices.
  // This instruction is injected into the prompt to prevent hallucination.
  const ocMissingInstruction = ocMissing
    ? `\nCRITICAL — OPTION PREMIUM DATA UNAVAILABLE:\nATM CE = Rs0 (no real data from any source). You MUST NOT invent or estimate an entry price.\nFor Entry/SL/Target: write "N/A — verify premium in Kite before entering"\nProvide directional verdict only (ENTRY CE/PE direction). No fabricated numbers.\n`
    : '';

  // ── FII/DII data (Opp 4 — live F6) ──────────────────────────────────────
  // NSE endpoint: /api/fiidiiTradeReact — returns today's FII equity buy/sell
  let fiiNetCr = null;  // null = not available (score F6=0), number = Rs Cr net
  let fiiText  = 'Live FII data unavailable — score F6 neutral';
  try {
    const fiiData = gv(fiiJ);
    if (fiiData?.data?.length) {
      // Find most recent equity row (FII row, not DII)
      const fiiRow = fiiData.data.find(r =>
        (r.category||'').toLowerCase().includes('fii') ||
        (r.category||'').toLowerCase().includes('foreign')
      );
      if (fiiRow) {
        const buy  = parseFloat(fiiRow.buyValue  || fiiRow.buy  || 0);
        const sell = parseFloat(fiiRow.sellValue || fiiRow.sell || 0);
        const net  = buy - sell;
        fiiNetCr   = (net / 1e7).toFixed(0);  // paise → Rs Cr
        fiiText    = `FII: Buy Rs${(buy/1e7).toFixed(0)}Cr, Sell Rs${(sell/1e7).toFixed(0)}Cr, Net Rs${fiiNetCr}Cr`;
        console.log(`[fii] net=${fiiNetCr}Cr`);
      }
    }
  } catch(fiiErr) {
    console.warn('[fii] parse error:', fiiErr.message);
  }

  // ── F10: Economic event calendar (pre-programmed) ────────────────────────
  // Known high-impact events — no API needed, just date math.
  // Returns event name if within ±1 day, null otherwise.
  function checkEconomicEvents(istDate) {
    const mm   = istDate.getMonth() + 1;  // 1-12
    const dd   = istDate.getDate();
    const dow  = istDate.getDay();        // 0=Sun, 2=Tue
    const yyyy = istDate.getFullYear();

    // Options expiry: every Tuesday (NSE weekly)
    if (dow === 2) return 'NSE Weekly Expiry';

    // Monthly expiry: last Thursday of month
    const lastThursday = (() => {
      const d = new Date(yyyy, mm, 0);  // last day of month
      while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
      return d.getDate();
    })();
    if (dow === 4 && dd === lastThursday) return 'NSE Monthly Expiry';
    if (dow === 3 && dd === lastThursday - 1) return 'Pre-Monthly Expiry';

    // RBI MPC dates 2026 (typically Feb, Apr, Jun, Aug, Oct, Dec)
    const rbiMPC2026 = [
      [2,5],[2,6],[2,7],   // Feb MPC
      [4,7],[4,8],[4,9],   // Apr MPC
      [6,4],[6,5],[6,6],   // Jun MPC
      [8,5],[8,6],[8,7],   // Aug MPC
      [10,6],[10,7],[10,8],// Oct MPC
      [12,3],[12,4],[12,5],// Dec MPC
    ];
    for (const [m, d] of rbiMPC2026) {
      if (mm === m && dd === d) return 'RBI MPC Meeting';
    }

    // US Fed FOMC dates 2026 (typically Jan, Mar, May, Jun, Jul, Sep, Nov, Dec)
    const fomc2026 = [
      [1,28],[1,29],   // Jan
      [3,18],[3,19],   // Mar
      [5,6],[5,7],     // May
      [6,17],[6,18],   // Jun
      [7,29],[7,30],   // Jul
      [9,16],[9,17],   // Sep
      [11,4],[11,5],   // Nov
      [12,9],[12,10],  // Dec
    ];
    for (const [m, d] of fomc2026) {
      if (mm === m && dd === d) return 'US Fed FOMC Meeting';
    }

    // India Union Budget (Feb 1)
    if (mm === 2 && dd === 1) return 'India Union Budget';

    // US CPI release (typically 2nd Wed of month — high impact for FII flows)
    const secWed = (() => {
      const d = new Date(yyyy, mm - 1, 1);
      let count = 0;
      while (count < 2) { if (d.getDay() === 3) count++; if (count < 2) d.setDate(d.getDate() + 1); }
      return d.getDate();
    })();
    if (dd === secWed) return 'US CPI Data Release';

    return null;  // no major event today
  }

  // ist is already declared at top of runAnalysis from line ~66
  const todayEvent = checkEconomicEvents(ist);
  const eventText  = todayEvent || 'none';
  console.log(`[events] today: ${eventText}`);

  // ── Global cues ───────────────────────────────────────────────────────────
  const G={
    sp500:toG(gv(sp500R)),dow:toG(gv(dowR)),nas:toG(gv(nasR)),
    crude:toG(gv(crudeR)),gold:toG(gv(goldR)),usdInr:toG(gv(usdInrR)),
    nikkei:toG(gv(nikkeiR)),hsi:toG(gv(hsiR)),
  };
  const gLine=(label,d)=>d?`${label}: ${d.price?.toFixed(2)} (${d.pct>=0?'+':''}${d.pct}%)`:`${label}: N/A`;

  // ── F11: Composite sentiment from existing signals ───────────────────────
  // No new API needed — computed from VIX trend, PCR, breadth, candle momentum
  let sentimentScore = 0;
  let sentimentText  = 'none — neutral';
  try {
    const vixCandles2 = buildCandles(gv(yVix));
    const vixPrev     = vixCandles2.length >= 2 ? vixCandles2[vixCandles2.length - 2]?.[4] : vix;
    const vixRising   = vix > vixPrev * 1.005;   // VIX up >0.5%
    const vixFalling  = vix < vixPrev * 0.995;   // VIX down >0.5%

    const advN = parseInt(advances) || 0;
    const decN = parseInt(declines) || 0;
    const breadthRatio = (advN + decN) > 10 ? advN / (advN + decN) : 0.5;

    const pcrN = parseFloat(pcr) || 0;
    const isBullishPCR = pcrN > 1.2;
    const isBearishPCR = pcrN > 0 && pcrN < 0.8;

    // Scoring (+1 bearish cues, -1 bullish cues for sentiment = fear/greed)
    if (vixRising)          sentimentScore -= 1;  // fear rising
    if (vixFalling)         sentimentScore += 1;  // fear falling
    if (breadthRatio < 0.4) sentimentScore -= 1;  // broad selling
    if (breadthRatio > 0.6) sentimentScore += 1;  // broad buying
    if (isBearishPCR)       sentimentScore -= 1;  // call heavy
    if (isBullishPCR)       sentimentScore += 1;  // put heavy
    if (green10 >= 7)       sentimentScore += 1;  // 7/10 bullish days
    if (green10 <= 3)       sentimentScore -= 1;  // 7/10 bearish days
    if (mom === 'BULLISH HH/HL') sentimentScore += 1;
    if (mom === 'BEARISH LL/LH') sentimentScore -= 1;

    // Summarise
    const fearCues  = [vixRising, breadthRatio<0.4, isBearishPCR, green10<=3, mom==='BEARISH LL/LH'].filter(Boolean).length;
    const greedCues = [vixFalling, breadthRatio>0.6, isBullishPCR, green10>=7, mom==='BULLISH HH/HL'].filter(Boolean).length;
    const vixTrend  = vixRising ? `VIX↑${vix.toFixed(2)}` : vixFalling ? `VIX↓${vix.toFixed(2)}` : `VIX~${vix.toFixed(2)}`;
    const bullishDays = `${green10}/10 bullish days`;

    if (fearCues >= 3)       sentimentText = `fear dominant — ${vixTrend}, breadth ${Math.round(breadthRatio*100)}%, ${bullishDays}`;
    else if (greedCues >= 3) sentimentText = `greed dominant — ${vixTrend}, breadth ${Math.round(breadthRatio*100)}%, ${bullishDays}`;
    else if (fearCues > greedCues) sentimentText = `mild fear — ${vixTrend}, ${bullishDays}`;
    else if (greedCues > fearCues) sentimentText = `mild greed — ${vixTrend}, ${bullishDays}`;
    else                     sentimentText = `neutral — ${vixTrend}, breadth ${Math.round(breadthRatio*100)}%, ${bullishDays}`;

    console.log(`[sentiment] score=${sentimentScore} text="${sentimentText}"`);
  } catch(sentErr) {
    console.warn('[sentiment] error:', sentErr.message);
  }

  // ── Data freshness ────────────────────────────────────────────────────────
  const isFresh = spot>0;
  const dataAgeMin = spot?0:999;

  // ── Build prompt ──────────────────────────────────────────────────────────
  // ── Build prompt (fully guarded) ──────────────────────────────────────────
  let dataBlock, prompt;
  try {
  const sigma1d=spot&&vix?(spot*(vix/100)/Math.sqrt(252)).toFixed(0):'—';
  const sigma1w=spot&&vix?(spot*(vix/100)/Math.sqrt(52)).toFixed(0):'—';
  const atmAfford=liveF&&atmCeP?Math.floor(liveF/(atmCeP*65))||0:0;
  const chg=spot-prevCl;

  dataBlock = !isFresh
    ? '⚠️ DATA FEED FAILURE — Nifty spot = 0. MANDATORY STAY OUT on all setups.'
    : `═══ MARKET DATA (${nseSrc}) ═══
NIFTY 50: ${spot} | Chg: ${chg>=0?'+':''}${isNaN(chg)?0:chg.toFixed(2)} from ${prevCl}
Day: O:${dayO.toFixed?dayO.toFixed(1):dayO} H:${dayH.toFixed?dayH.toFixed(1):dayH} L:${dayL.toFixed?dayL.toFixed(1):dayL}
VWAP: ${(vwap||0).toFixed(2)} | 20-DMA: ${(sma20||0).toFixed(2)} | 9-EMA: ${(ema9||0).toFixed(2)} | 21-EMA: ${(ema21||0).toFixed(2)}
9-EMA ${ema9>ema21?'ABOVE (bullish)':'BELOW (bearish)'} 21-EMA by ${(Math.abs((ema9||0)-(ema21||0))).toFixed(2)} pts
Opening Range: H=${parseFloat(orh).toFixed(1)} L=${parseFloat(orl).toFixed(1)} | Spot ${spot>orh?'ABOVE ORH':spot<orl?'BELOW ORL':'INSIDE RANGE'}
Day H timing: ${htim} | Day L timing: ${ltim}
Momentum (last 5 candles): ${mom}
Institutional candles (spread >80pts): ${instDesc}
Bullish days (last 10): ${green10}/10

═══ INDICES & SECTORS ═══
VIX: ${vix||'N/A'} | Bank Nifty: ${bn||'N/A'} | Nifty IT: ${niftyIT||'N/A'}
Nifty Auto: ${niftyAuto||'N/A'} | Nifty Fin: ${niftyFin||'N/A'} | Nifty Midcap: ${niftyMid||'N/A'}
Market Breadth: Advances ${advances} / Declines ${declines}

═══ OPTION CHAIN (Trading Expiry: ${ocExpiryObj.nseStr}, ${ocExpiryObj.dte} DTE${isExpiryDay?" — using next week (today is expiry day)":""}) ═══
ATM: ${atm} | PCR: ${pcr} | Call Wall: ${callWall} | Put Wall: ${putWall} | Max Pain: ${maxPain}
ATM CE: Rs${atmCeP} | ATM PE: Rs${atmPeP} | IVP: ${ivpVal}%${ivpVal===computedIVP&&!atmCeP?' (VIX-based)':''}
Next expiry (${expiryNx.nseStr}) ATM CE: Rs${nxAtmCeP} | PE: Rs${nxAtmPeP}
Sigma 1-day: ${sigma1d} pts | Sigma 1-week: ${sigma1w} pts
${ocTable}
═══ KEY LEVELS (30-day range) ═══
R2: ${r2.toFixed?r2.toFixed(0):r2} | R1: ${r1.toFixed?r1.toFixed(0):r1} | Pivot: ${pivot} | S1: ${s1.toFixed?s1.toFixed(0):s1} | S2: ${s2.toFixed?s2.toFixed(0):s2}

═══ LAST 20 INTRADAY CANDLES (5-min) ═══
${last20c||'No intraday data available'}

═══ LAST 15 DAILY CANDLES ═══
${last15d||'No daily data available'}`;

  prompt = `You are a seasoned Nifty 50 F&O analyst (15+ years). Run nifty-options-analyst skill v5.
All market data pre-fetched below. No web searches needed.

TIME: ${istStr} / ${sgtStr} | ${dayName} ${todayDate}
SESSION: ${isPreMarket?'PRE-MARKET':isPostMarket?'POST-MARKET':'LIVE MARKET (intraday)'}

CONSTANTS: Lot size=65 | Expiry=TUESDAY | LIVE_FUNDS=Rs${(liveF||0).toFixed(0)}
Max affordable premium: Rs${maxAfford}/unit | Max lots at ATM: ${atmAfford} | Auto-trade: +-8 | SL: 50% premium

${dataBlock}

GLOBAL CUES:
${gLine('S&P500',G.sp500)} | ${gLine('Dow',G.dow)} | ${gLine('Nasdaq',G.nas)}
${gLine('Nikkei',G.nikkei)} | ${gLine('Hang Seng',G.hsi)}
${gLine('Crude',G.crude)} | ${gLine('Gold',G.gold)} | ${gLine('USD/INR',G.usdInr)}

POSITIONS: ${posText}
PENDING ORDERS: ${ordText}
FII/DII: ${fiiText}
TODAY EVENT: ${eventText}
SENTIMENT: ${sentimentText} (sentimentScore: ${sentimentScore>0?'+':''}${sentimentScore})

${ocMissingInstruction}
MANDATORY STAY OUT if: VIX>22 | spot=0 | score between -7 and +7 (inclusive) | insufficient margin | no option premium data
MANDATORY ENTRY if: |total score| >= 12 AND VIX<22 AND spot>0 AND premium data available — do NOT output STAY OUT at this score level
LEAN ENTRY (model judgment) if: |total score| 8-11 — weigh all factors, DTE, and premium availability

SCORECARD — output EXACTLY this JSON block first (integers only, no spaces around colon):
SCORES:{"f1":0,"f2":0,"f3":0,"f4":0,"f5":0,"f6":0,"f7":0,"f8":0,"f9":0,"f10":0,"f11":0,"total":0}

Then ONE LINE per factor — score | raw number that drove it | one-phrase reason. Use this exact format:
F1  VIX:       [score]  [value +X%]           — [rising/falling, fear read]
F2  PCR/OI:    [score]  [PCR | Call±Cr vs Put±Cr] — [ceiling/floor interpretation]
F3  Intraday:  [score]  [spot level, key move] — [pattern: pullback/rejection/breakout]
F4  Trend:     [score]  [day change %]         — [continuation/reversal]
F5  Sector:    [score]  [BankNifty%, FinSvc%]  — [confirming/diverging]
F6  FII:       [score]  ${fiiNetCr!==null?`Net Rs${fiiNetCr}Cr`:"no live data"}  — [buying/selling intent]
F7  Breadth:   [score]  [advance:decline]      — [broad selling/buying/neutral]
F8  Global:    [score]  [S&P500%, Crude$]      — [tailwind/headwind]
F9  IV:        [score]  [IVP, ATM IV]          — [risk modifier note]
F10 Events:    [score]  ${eventText}       — [impact on market direction]
F11 Sentiment: [score]  ${sentimentText}  — [fear/greed confirmation]
TOTAL: XX / ±33

VERDICT FORMAT (include both — use EXACTLY this format, no markdown, no bold):
QUICK SETUP (+15-20 premium pts): VERDICT: [ENTRY CE/PE / STAY OUT] | Option: NIFTY26MAY24000CE | Entry: Rs74 | SL: Rs37 | Target: Rs94
SWING SETUP (+100 premium pts):   VERDICT: [ENTRY CE/PE / STAY OUT] | Option: NIFTY26MAY24000CE | Entry: Rs74 | SL: Rs37 | T1: Rs120 | T2: Rs160

RULES for symbol: no spaces, no markdown — e.g. NIFTY26MAY24000CE not NIFTY 26MAY 24000 CE
RULES for entry: single number only — e.g. Rs74 not Rs74-80 or Rs74–Rs80
AUTO-TRADE: [YES - CE/PE / NO]

91% of retail F&O traders lost money FY2024-25 (SEBI). Not SEBI-registered advice.`;

  } catch(promptErr) {
    console.error('Prompt build error:', promptErr.message);
    return res.status(500).json({error: 'Prompt build failed: ' + promptErr.message});
  }
  // ── Smart model routing ───────────────────────────────────────────────────
  // Market-open window (9:15–9:45 IST): busiest period — needs longer timeouts + retry
  const istMinsNow = ist.getHours()*60 + ist.getMinutes();
  const isMarketOpen = istMinsNow >= 9*60+15 && istMinsNow <= 9*60+45;
  const AI_TIMEOUT  = isMarketOpen ? 80000 : 55000; // 80s at open, 55s otherwise

  // Score-based model routing:
  //   |score| >= 12  → Groq Llama 3.3 70B (free, clean signal, no reasoning needed)
  //   |score| 8–11   → Claude Sonnet 4.6  (middle ground)
  //   |score| <= 7   → Claude Opus 4.6    (grey zone, deep reasoning required)
  // useDeepSeek toggle overrides routing (legacy UI support)
  function selectModel(compositeScore) {
    // ── ANTHROPIC TEMPORARILY DISABLED (credits exhausted) ──────────────────
    // All traffic routed to Groq free tier until credits are topped up.
    // Re-enable by removing the first two return lines below.
    // Original routing: |>=12|→Groq, |8-11|→Sonnet, |<=7|→Opus
    if (true) return { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'groq-free' };
    /* eslint-disable no-unreachable */
    if (useDeepSeek) return { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'groq-free' };
    const abs = Math.abs(compositeScore || 0);
    if (abs >= 12) return { provider: 'groq',      model: 'llama-3.3-70b-versatile', tier: 'groq-free'   };
    if (abs >= 8)  return { provider: 'anthropic',  model: 'claude-sonnet-4-6',       tier: 'sonnet'      };
    return             { provider: 'anthropic',  model: 'claude-opus-4-6',         tier: 'opus'        };
    /* eslint-enable no-unreachable */
  }

  // ── Opp 1: Rule-based pre-scorer for model routing ─────────────────────
  // The AI hasn't run yet so we can't know the final score.
  // Instead we estimate market regime from the raw data already computed.
  // Rules mirror the F1/F2/F3/F4/F7/F8 scoring logic:
  //   Each factor contributes ±2 → max |preScore| = 12
  //   |preScore| ≥ 12 → Groq, 8-11 → Sonnet, ≤7 → Opus
  // This means on a clearly bearish day (VIX spike + breadth collapse + breakdown)
  // we correctly route to Groq free from call one instead of defaulting to Opus.
  let preScore = 0;
  try {
    const chgPct = spot && prevCl ? ((spot - prevCl) / prevCl) * 100 : 0;
    // F1: VIX
    if      (vix > 20)  preScore -= 2;
    else if (vix > 17)  preScore -= 1;
    else if (vix < 14)  preScore += 2;
    else if (vix < 16)  preScore += 1;
    // F2: PCR (bearish < 0.8, bullish > 1.3)
    const pcrN = parseFloat(pcr) || 0;
    if      (pcrN < 0.7)  preScore -= 2;
    else if (pcrN < 0.85) preScore -= 1;
    else if (pcrN > 1.4)  preScore += 2;
    else if (pcrN > 1.2)  preScore += 1;
    // F3: Intraday price action
    if      (spot < prevCl * 0.995) preScore -= 2;  // -0.5% or worse
    else if (spot < prevCl * 0.999) preScore -= 1;
    else if (spot > prevCl * 1.005) preScore += 2;  // +0.5% or better
    else if (spot > prevCl * 1.001) preScore += 1;
    // F4: Day trend vs SMA20
    if      (spot < sma20 * 0.995) preScore -= 2;
    else if (spot < sma20)         preScore -= 1;
    else if (spot > sma20 * 1.005) preScore += 2;
    else if (spot > sma20)         preScore += 1;
    // F7: Breadth (advances vs declines)
    const advN = parseInt(advances) || 0, decN = parseInt(declines) || 0;
    if (advN + decN > 10) {
      const breadthRatio = advN / (advN + decN);
      if      (breadthRatio < 0.3)  preScore -= 2;
      else if (breadthRatio < 0.45) preScore -= 1;
      else if (breadthRatio > 0.7)  preScore += 2;
      else if (breadthRatio > 0.55) preScore += 1;
    }
    // F8: Global cues (S&P500 as proxy)
    if (G.sp500?.pct) {
      const sp = parseFloat(G.sp500.pct);
      if      (sp < -1.0) preScore -= 2;
      else if (sp < -0.3) preScore -= 1;
      else if (sp >  1.0) preScore += 2;
      else if (sp >  0.3) preScore += 1;
    }
    console.log(`[pre-score] vix=${vix} pcr=${pcrN} chg=${chgPct.toFixed(2)}% breadth=${advances}/${declines} sp500=${G.sp500?.pct}% → preScore=${preScore}`);
  } catch(preErr) {
    console.warn('[pre-score] failed:', preErr.message, '— defaulting to 0 (Opus)');
    preScore = 0;
  }

  const selectedModel = selectModel(preScore);
  console.log(`[routing] preScore=${preScore} abs=${Math.abs(preScore)} → ${selectedModel.tier} (${selectedModel.model})`);

  // ── Unified AI fetch (Groq uses OpenAI-compat, Anthropic uses native) ────
  async function callProvider(provider, model, retryNum=0) {
    const isGroq      = provider === 'groq';
    const isAnthropicP = provider === 'anthropic';

    const apiUrl = isGroq
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.anthropic.com/v1/messages';

    const apiKey = isGroq
      ? process.env.GROQ_API_KEY
      : process.env.ANTHROPIC_API_KEY;

    if (!apiKey) throw new Error(`Missing env var: ${isGroq ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'}`);

    const headers = isGroq
      ? { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

    const bodyObj = isGroq
      ? { model, max_tokens: 1800, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }
      : { model, max_tokens: 1800, messages: [{ role: 'user', content: prompt }] };

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), AI_TIMEOUT);
    try {
      const aRes = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: ctrl.signal });
      clearTimeout(tid);
      const raw  = await aRes.text();
      const data = JSON.parse(raw);
      if (!aRes.ok) throw new Error(data?.error?.message || `${provider} HTTP ${aRes.status}`);

      // Extract text from provider-specific response format
      let text = '', inp = 0, out = 0;
      if (isGroq || isAnthropicP && data.choices) {
        // OpenAI-compat format (Groq)
        text = data?.choices?.[0]?.message?.content || '';
        inp  = data?.usage?.prompt_tokens || 0;
        out  = data?.usage?.completion_tokens || 0;
      } else {
        // Anthropic native format
        text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        inp  = data.usage?.input_tokens || 0;
        out  = data.usage?.output_tokens || 0;
      }
      return { text, inp, out, provider, model };
    } catch(e) {
      clearTimeout(tid);
      const isAbortErr = e.name === 'AbortError' || e.message?.includes('abort');
      // Retry once on timeout during market-open window
      if (isAbortErr && retryNum === 0 && isMarketOpen) {
        console.warn(`[${provider}] timeout attempt 1 — retrying...`);
        return callProvider(provider, model, 1);
      }
      throw e;
    }
  }

  // ── Fallback chain: primary → Sonnet → Opus ──────────────────────────────
  async function callWithFallback() {
    const primary = selectedModel;

    try {
      const result = await callProvider(primary.provider, primary.model);
      if (!result.text) throw new Error(`${primary.tier} returned empty response`);
      return result;
    } catch(primaryErr) {
      console.warn(`[fallback] ${primary.tier} failed: ${primaryErr.message}`);

      // ── ANTHROPIC DISABLED — Groq-only fallback ─────────────────────────
      // Anthropic fallbacks disabled while credits are exhausted.
      // Re-enable by restoring the original fallback chain below.
      // If Groq fails, retry once with a short delay then throw.
      if (primary.provider === 'groq') {
        console.log('[fallback] Groq failed — retrying Groq once (Anthropic disabled)');
        await new Promise(r => setTimeout(r, 2000));  // 2s pause before retry
        try {
          const result = await callProvider('groq', 'llama-3.3-70b-versatile');
          if (!result.text) throw new Error('Groq retry also empty');
          return result;
        } catch(retryErr) {
          console.warn('[fallback] Groq retry failed:', retryErr.message);
        }
      }
      // Original Anthropic fallbacks (re-enable when credits topped up):
      // if (primary.provider === 'groq') {
      //   const result = await callProvider('anthropic', 'claude-sonnet-4-6');
      //   return result;
      // }
      // const finalModel = primary.model === 'claude-sonnet-4-6' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
      // const result = await callProvider('anthropic', finalModel);
      // return result;
      throw new Error('All fallbacks exhausted — no AI response');
    }
  }

  let analysisText = '', inputTokens = 0, outputTokens = 0, usedModel = selectedModel.model;
  try {
    const aiResult = await callWithFallback();
    analysisText = aiResult.text;
    inputTokens  = aiResult.inp;
    outputTokens = aiResult.out;
    usedModel    = aiResult.model;
    console.log(`[ai] used=${usedModel} in=${inputTokens} out=${outputTokens}`);
    if (!analysisText) throw new Error('Empty AI response — model returned no text');
  } catch(ae) {
    const isAbort = ae.name === 'AbortError' || ae.message?.toLowerCase().includes('abort');
    const timeoutSec = Math.round(AI_TIMEOUT / 1000);
    const msg = isAbort
      ? `Analysis timed out (${timeoutSec}s). Market too busy — try again in 1–2 min.`
      : ae.message;
    return res.status(500).json({ error: `model: ${msg}` });
  }

  // ── Parse response ────────────────────────────────────────────────────────
  const fi=re=>{const m=analysisText.match(re);return m?parseInt(m[1]):0;};
  const ft=re=>{const m=analysisText.match(re);return m?m[1].trim():null;};
  const score    = fi(/TOTAL:\s*([+-]?\d+)/i);
  const verdict  = ft(/\bVERDICT:\s*([^\n|]{3,40})/i);
  const autoTrade= ft(/AUTO.?TRADE.*?:\s*(YES[^\n]*|NO[^\n]*)/i);
  const quickSymM= analysisText.match(/QUICK SETUP[\s\S]*?Option:\s*([\*`]*)([A-Z0-9][A-Z0-9 ]{4,30}?)([\*`]*)(\s*\|)/i);
  const quickSymbol=quickSymM?(quickSymM[2]||quickSymM[1]).replace(/[^A-Z0-9]/g,''):null;
  const quickEntryM=analysisText.match(/QUICK SETUP[\s\S]*?Entry:\s*Rs([\d.]+)(?:[–\-]Rs?([\d.]+))?/i);
  const quickEntryL=quickEntryM?parseFloat(quickEntryM[1]):null;
  const quickEntryH=quickEntryM?parseFloat(quickEntryM[2]||quickEntryM[1]*1.02):null;
  const quickSlM=analysisText.match(/QUICK SETUP[\s\S]*?SL:\s*Rs([\d.]+)/i);
  const quickSl=quickSlM?parseFloat(quickSlM[1]):null;  // SL: use lower bound
  const quickTargetM=analysisText.match(/QUICK SETUP[\s\S]*?Target:\s*Rs([\d.]+)/i);
  const quickTarget=quickTargetM?parseFloat(quickTargetM[1]):null;
  const swingSymM=analysisText.match(/SWING SETUP[\s\S]*?Option:\s*([\*`]*)([A-Z0-9][A-Z0-9 ]{4,30}?)([\*`]*)(\s*\|)/i);
  const swingSymbol=swingSymM?(swingSymM[2]||swingSymM[1]).replace(/[^A-Z0-9]/g,''):null;
  const swingEntryM=analysisText.match(/SWING SETUP[\s\S]*?Entry:\s*Rs([\d.]+)(?:[–\-]Rs?([\d.]+))?/i);
  const swingEntryL=swingEntryM?parseFloat(swingEntryM[1]):null;
  const swingEntryH=swingEntryM?parseFloat(swingEntryM[2]||swingEntryM[1]*1.02):null;
  const swingSlM=analysisText.match(/SWING SETUP[\s\S]*?SL:\s*Rs([\d.]+)/i);
  const swingSl=swingSlM?parseFloat(swingSlM[1]):null;
  // Parse machine-readable SCORES JSON block
  let scores={f1:0,f2:0,f3:0,f4:0,f5:0,f6:0,f7:0,f8:0,f9:0,f10:0};
  try {
    const sm=analysisText.match(/SCORES:\s*(\{[^}]+\})/);
    if(sm) Object.assign(scores, JSON.parse(sm[1]));
  } catch {
    // fallback: scan for Fx label: ±N patterns
    const fp=(label,aliases)=>{
      for(const l of [label,...(aliases||[])]){
        const m=analysisText.match(new RegExp(l+'[^\\d-+]*([+-]?\\d+)','i'));  // eslint-disable-line no-useless-escape
        if(m) return parseInt(m[1]);
      }
      return 0;
    };
    scores={
      f1:fp('F1',['VIX Analysis']),f2:fp('F2',['PCR']),f3:fp('F3',['Intraday']),
      f4:fp('F4',['Daily Trend']),f5:fp('F5',['Sectoral']),f6:fp('F6',['FII']),
      f7:fp('F7',['Breadth']),f8:fp('F8',['Global']),f9:fp('F9',['IV']),f10:fp('F10',['Events']),
    };
  }
  const maxAffordLots=liveF&&atmCeP?Math.floor(liveF/(atmCeP*65))||0:0;
  const lotsStr=`${maxAffordLots} lot(s) at ATM (Rs${atmCeP}/unit x 65 = Rs${(atmCeP*65).toFixed(0)}/lot)`;

  return res.status(200).json({
    score,verdict,autoTrade,
    quickSymbol,quickEntryL,quickEntryH,quickSl,quickTarget,
    swingSymbol,swingEntryL,swingEntryH,swingSl,
    entryLow:quickEntryL,entryHigh:quickEntryH,
    scores,lotsStr,ivpVal,ocDataMissing,
    analysis:analysisText,
    promptPreview:prompt || null,   // full prompt — no truncation
    marketData:{
      spot,vix,bn,liveF,atm,
      expiry:expiry.dateStr,dte:expiry.dte,isExpiry:expiry.isExpiry,
      vwap:(vwap||0).toFixed(2),sma20:(sma20||0).toFixed(2),ema9:(ema9||0).toFixed(2),ema21:(ema21||0).toFixed(2),
      pcr,callWall,putWall,atmCeP,atmPeP,orh,orl,
      r2:r2.toFixed?r2.toFixed(0):r2,r1:r1.toFixed?r1.toFixed(0):r1,
      pivot,s1:s1.toFixed?s1.toFixed(0):s1,s2:s2.toFixed?s2.toFixed(0):s2,
      openPositions:openPos,dataAgeMin,isFresh,nseSrc,advances,declines,
    },
    globalData:G,
    usage:{inputTokens,outputTokens,usedModel,routingTier:selectedModel.tier,preScore},
    timestamp:istStr,sgt:sgtStr,
    kiteErr:null,kiteHttpStatus:200,
  });
}
