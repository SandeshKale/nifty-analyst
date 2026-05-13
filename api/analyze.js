// api/analyze.js — Nifty Options Analyst v7
// Data: Yahoo Finance (spot/candles/global) + NSE (option chain) + Kite (margins/orders)
// Fast: parallel fetches, 5s timeouts, no blocking cookie retries

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

  // Wrap everything in top-level try-catch — always return JSON
  try {
    return await runAnalysis(req, res, accessToken);
  } catch(fatal) {
    console.error('Fatal handler error:', fatal.message, fatal.stack?.slice(0,500));
    return res.status(500).json({ error: 'Analysis failed: ' + fatal.message });
  }
}

async function runAnalysis(req, res, accessToken) {
  const apiKey = process.env.KITE_API_KEY;
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
  const hist5mDate = isPreMarket ? prevTradingDate : todayDate;

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
    const m=r.meta, prev=m.previousClose||m.chartPreviousClose||m.regularMarketPrice, cur=m.regularMarketPrice;
    return {price:cur, prev, chg:(cur-prev).toFixed(2), pct:(((cur-prev)/prev)*100).toFixed(2)};
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
  async function yfOptions(sym) {
    try {
      const r = await tFetch(
        `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}`,
        {headers:yfH}, 6000
      );
      const j = await r.json().catch(()=>null);
      return j?.optionChain?.result?.[0] || null;
    } catch { return null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FETCH ALL DATA IN PARALLEL
  // ══════════════════════════════════════════════════════════════════════════
  const expiry = getExpiry(0), expiryNx = getExpiry(1);

  const [
    margR, posR, ordR,            // Kite: margins, positions, orders
    yIntra, yDaily,               // Yahoo: Nifty 5m intraday + 60d daily
    yBN, yVix,                    // Yahoo: Bank Nifty, India VIX fallback
    sp500R, dowR, nasR, crudeR, goldR, usdInrR, nikkeiR, hsiR, // Global
    idxJ, ocJ, yfOptsR,           // NSE: allIndices + option chain + Yahoo options fallback
  ] = await Promise.allSettled([
    tFetch('https://api.kite.trade/user/margins',{headers:kH},6000).then(r=>r.json()).catch(()=>null),
    tFetch('https://api.kite.trade/portfolio/positions',{headers:kH},6000).then(r=>r.json()).catch(()=>null),
    tFetch('https://api.kite.trade/orders',{headers:kH},6000).then(r=>r.json()).catch(()=>null),
    yfFetch('^NSEI','5m','1d'),
    yfFetch('^NSEI','1d','60d'),
    yfFetch('^NSEBANK','1d','2d'),
    yfFetch('^INDIAVIX','1d','2d'),
    yfFetch('^GSPC'), yfFetch('^DJI'), yfFetch('^IXIC'),
    yfFetch('CL=F'),  yfFetch('GC=F'), yfFetch('INR=X'),
    yfFetch('^N225'), yfFetch('^HSI'),
    nseGet('/api/allIndices'),
    nseGet(`/api/option-chain-indices?symbol=NIFTY`),
    yfOptions('^NSEI'),
  ]);

  const gv = r => r.status==='fulfilled' ? r.value : null;

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
  function buildCandles(res) {
    if(!res?.timestamp) return [];
    const ts=res.timestamp, q=res.indicators?.quote?.[0]||{};
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
    const fi=name=>nseIdx.data.find(d=>d.index===name||d.indexSymbol===name)||null;
    const n50=fi('NIFTY 50')||fi('Nifty 50');
    const nvix=fi('INDIA VIX')||fi('India Vix');
    const bnk=fi('NIFTY BANK')||fi('Nifty Bank');
    const nit=fi('NIFTY IT')||fi('Nifty IT');
    const nau=fi('NIFTY AUTO')||fi('Nifty Auto');
    const nfi=fi('NIFTY FIN SERVICE')||fi('Nifty Fin Service');
    const nmi=fi('NIFTY MIDCAP 100')||fi('NIFTY MIDCAP100')||fi('Nifty Midcap 100');
    if(n50?.last) { spot=n50.last; prevCl=n50.previousClose||spot; dayH=n50.high||dayH; dayL=n50.low||dayL; dayO=n50.open||dayO; advances=n50.advances||'N/A'; declines=n50.declines||'N/A'; }
    if(nvix?.last) vix=nvix.last;
    if(bnk?.last)  bn=bnk.last;
    if(nit?.last)  niftyIT=nit.last;
    if(nau?.last)  niftyAuto=nau.last;
    if(nfi?.last)  niftyFin=nfi.last;
    if(nmi?.last)  niftyMid=nmi.last;
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
  const pivot  = pvDay?((pvDay[2]+pvDay[3]+pvDay[4])/3).toFixed(2):0;
  const maxAfford=liveF>0?(liveF/65).toFixed(2):'0';
  const last20c= c5m.slice(-6).map(c=>`[${c[0].slice(11,16)} O:${c[1].toFixed(0)} H:${c[2].toFixed(0)} L:${c[3].toFixed(0)} C:${c[4].toFixed(0)}]`).join(' ');
  const last15d= cDay.slice(-5).map(c=>`[${c[0].slice(5,10)} O:${c[1].toFixed(0)} H:${c[2].toFixed(0)} L:${c[3].toFixed(0)} C:${c[4].toFixed(0)}]`).join(' ');

  // ── NSE Option Chain ──────────────────────────────────────────────────────
  let pcr='0',callWall=atm,putWall=atm,maxPain=atm,atmCeP=0,atmPeP=0,nxAtmCeP=0,nxAtmPeP=0,ivpVal=0;
  let totCeOI=0,totPeOI=0;
  let ocTable='Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
  ocTable    +='-------|--------|------------|----------|--------|------------|----------\n';
  const ocData=gv(ocJ);
  const yfOptsData=gv(yfOptsR);

  // Yahoo Finance options fallback — use when NSE option chain not available
  if(!ocData && yfOptsData && atm>0) {
    try {
      const calls=yfOptsData.options?.[0]?.calls||[];
      const puts=yfOptsData.options?.[0]?.puts||[];
      // Get ATM call and put
      const atmCall=calls.reduce((b,c)=>Math.abs((c.strike||0)-atm)<Math.abs((b.strike||0)-atm)?c:b,calls[0]||{});
      const atmPut=puts.reduce((b,p)=>Math.abs((p.strike||0)-atm)<Math.abs((b.strike||0)-atm)?p:b,puts[0]||{});
      if(atmCall.lastPrice) atmCeP=atmCall.lastPrice;
      if(atmPut.lastPrice)  atmPeP=atmPut.lastPrice;
      if(atmCall.impliedVolatility) ivpVal=Math.round(atmCall.impliedVolatility*100);
      // Basic PCR from OI
      const totCalls=calls.reduce((s,c)=>s+(c.openInterest||0),0);
      const totPuts=puts.reduce((s,p)=>s+(p.openInterest||0),0);
      if(totCalls>0) pcr=(totPuts/totCalls).toFixed(3);
      // Call/put walls
      const maxCallOI=calls.reduce((b,c)=>(c.openInterest||0)>(b.openInterest||0)?c:b,{});
      const maxPutOI=puts.reduce((b,p)=>(p.openInterest||0)>(b.openInterest||0)?p:b,{});
      if(maxCallOI.strike) callWall=maxCallOI.strike;
      if(maxPutOI.strike)  putWall=maxPutOI.strike;
      ocTable='[Yahoo Finance options — limited data]
';
      ocTable+=`ATM ${atm} CE: Rs${atmCeP.toFixed(1)} | PE: Rs${atmPeP.toFixed(1)} | PCR: ${pcr}
`;
      ocTable+=`Call Wall: ${callWall} | Put Wall: ${putWall}
`;
    } catch(e) { console.error('Yahoo options parse error:',e.message); }
  }

  if(ocData?.records?.data && atm>0){
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
    pcr=tc>0?(tp/tc).toFixed(3):'0';
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
  }

  // ── Global cues ───────────────────────────────────────────────────────────
  const G={
    sp500:toG(gv(sp500R)),dow:toG(gv(dowR)),nas:toG(gv(nasR)),
    crude:toG(gv(crudeR)),gold:toG(gv(goldR)),usdInr:toG(gv(usdInrR)),
    nikkei:toG(gv(nikkeiR)),hsi:toG(gv(hsiR)),
  };
  const gLine=(label,d)=>d?`${label}: ${d.price?.toFixed(2)} (${d.pct>=0?'+':''}${d.pct}%)`:`${label}: N/A`;

  // ── Data freshness ────────────────────────────────────────────────────────
  const isFresh = spot>0;
  const dataAgeMin = spot?0:999;

  // ── Build prompt ──────────────────────────────────────────────────────────
  const sigma1d=spot&&vix?(spot*(vix/100)/Math.sqrt(252)).toFixed(0):'—';
  const sigma1w=spot&&vix?(spot*(vix/100)/Math.sqrt(52)).toFixed(0):'—';
  const atmAfford=liveF&&atmCeP?Math.floor(liveF/(atmCeP*65))||0:0;
  const chg=spot-prevCl;

  const dataBlock = !isFresh
    ? '⚠️ DATA FEED FAILURE — Nifty spot = 0. MANDATORY STAY OUT on all setups.'
    : `═══ MARKET DATA (${nseSrc}) ═══
NIFTY 50: ${spot} | Chg: ${chg>=0?'+':''}${chg.toFixed(2)} from ${prevCl}
Day: O:${dayO.toFixed?dayO.toFixed(1):dayO} H:${dayH.toFixed?dayH.toFixed(1):dayH} L:${dayL.toFixed?dayL.toFixed(1):dayL}
VWAP: ${vwap.toFixed(2)} | 20-DMA: ${sma20.toFixed(2)} | 9-EMA: ${ema9.toFixed(2)} | 21-EMA: ${ema21.toFixed(2)}
9-EMA ${ema9>ema21?'ABOVE (bullish)':'BELOW (bearish)'} 21-EMA by ${Math.abs(ema9-ema21).toFixed(2)} pts
Opening Range: H=${parseFloat(orh).toFixed(1)} L=${parseFloat(orl).toFixed(1)} | Spot ${spot>orh?'ABOVE ORH':spot<orl?'BELOW ORL':'INSIDE RANGE'}
Day H timing: ${htim} | Day L timing: ${ltim}
Momentum (last 5 candles): ${mom}
Institutional candles (spread >80pts): ${instDesc}
Bullish days (last 10): ${green10}/10

═══ INDICES & SECTORS ═══
VIX: ${vix||'N/A'} | Bank Nifty: ${bn||'N/A'} | Nifty IT: ${niftyIT||'N/A'}
Nifty Auto: ${niftyAuto||'N/A'} | Nifty Fin: ${niftyFin||'N/A'} | Nifty Midcap: ${niftyMid||'N/A'}
Market Breadth: Advances ${advances} / Declines ${declines}

═══ OPTION CHAIN (NSE, Expiry ${expiry.nseStr}, ${expiry.dte} DTE) ═══
ATM: ${atm} | PCR: ${pcr} | Call Wall: ${callWall} | Put Wall: ${putWall} | Max Pain: ${maxPain}
ATM CE: Rs${atmCeP} | ATM PE: Rs${atmPeP} | IVP (ATM IV): ${ivpVal}%
Next expiry (${expiryNx.nseStr}) ATM CE: Rs${nxAtmCeP} | PE: Rs${nxAtmPeP}
Sigma 1-day: ${sigma1d} pts | Sigma 1-week: ${sigma1w} pts
${ocTable}
═══ KEY LEVELS (30-day range) ═══
R2: ${r2.toFixed?r2.toFixed(0):r2} | R1: ${r1.toFixed?r1.toFixed(0):r1} | Pivot: ${pivot} | S1: ${s1.toFixed?s1.toFixed(0):s1} | S2: ${s2.toFixed?s2.toFixed(0):s2}

═══ LAST 20 INTRADAY CANDLES (5-min) ═══
${last20c||'No intraday data available'}

═══ LAST 15 DAILY CANDLES ═══
${last15d||'No daily data available'}`;

  const prompt = `You are a seasoned Nifty 50 F&O analyst (15+ years). Run nifty-options-analyst skill v5.
All market data pre-fetched below. No web searches needed.

TIME: ${istStr} / ${sgtStr} | ${dayName} ${todayDate}
SESSION: ${isPreMarket?'PRE-MARKET':isPostMarket?'POST-MARKET':'LIVE MARKET (intraday)'}

CONSTANTS: Lot size=65 | Expiry=TUESDAY | LIVE_FUNDS=Rs${liveF.toFixed(0)}
Max affordable premium: Rs${maxAfford}/unit | Max lots at ATM: ${atmAfford} | Auto-trade: +-8 | SL: 50% premium

${dataBlock}

GLOBAL CUES:
${gLine('S&P500',G.sp500)} | ${gLine('Dow',G.dow)} | ${gLine('Nasdaq',G.nas)}
${gLine('Nikkei',G.nikkei)} | ${gLine('Hang Seng',G.hsi)}
${gLine('Crude',G.crude)} | ${gLine('Gold',G.gold)} | ${gLine('USD/INR',G.usdInr)}

POSITIONS: ${posText}
PENDING ORDERS: ${ordText}

REQUIRED (be concise - max 1500 tokens): ALL 10 factor scores, SCORECARD TOTAL, key levels, DUAL VERDICT boxes. Skip verbose prose.
MANDATORY STAY OUT if: VIX>22 | spot=0 | expiry day score -5 to +5 | insufficient margin

SCORECARD — output EXACTLY this block (integers only, no spaces around colon):
SCORES:{"f1":0,"f2":0,"f3":0,"f4":0,"f5":0,"f6":0,"f7":0,"f8":0,"f9":0,"f10":0,"total":0}

Then show human-readable breakdown: F1 VIX (+X): reason | F2 PCR (+X): reason ... etc
TOTAL: +XX / ±30

VERDICT FORMAT (include both):
QUICK SETUP (+15-20 premium pts): VERDICT: [ENTRY CE/PE / STAY OUT] | Option: [symbol] | Entry: Rs[X] | SL: Rs[X] | Target: Rs[X]
SWING SETUP (+100 premium pts):   VERDICT: [ENTRY CE/PE / STAY OUT] | Option: [symbol] | Entry: Rs[X] | SL: Rs[X] | T1: Rs[X] | T2: Rs[X]

AUTO-TRADE: [YES - CE/PE / NO]

91% of retail F&O traders lost money FY2024-25 (SEBI). Not SEBI-registered advice.`;

  // ── Anthropic API ─────────────────────────────────────────────────────────
  let analysisText='', inputTokens=0, outputTokens=0;
  try {
    const aCtrl=new AbortController(); const aTid=setTimeout(()=>aCtrl.abort(),40000);
    const aRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,messages:[{role:'user',content:prompt}]}),
      signal:aCtrl.signal,
    });
    clearTimeout(aTid);
    // Wrap aRes.json() — large streaming responses can be slow
    const aText = await Promise.race([
      aRes.text(),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('Anthropic response body timeout')),8000))
    ]);
    const aData = JSON.parse(aText);
    if(!aRes.ok) throw new Error(aData?.error?.message||`Anthropic HTTP ${aRes.status}`);
    inputTokens  = aData.usage?.input_tokens||0;
    outputTokens = aData.usage?.output_tokens||0;
    analysisText = (aData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if(!analysisText) throw new Error('Empty Anthropic response');
  } catch(ae) {
    const msg = ae.name==='AbortError'?'Analysis timed out (40s). Market too busy — try again.':ae.message;
    return res.status(500).json({error:`model: ${msg}`, kiteErr:null, kiteHttpStatus:0});
  }

  // ── Parse response ────────────────────────────────────────────────────────
  const fi=re=>{const m=analysisText.match(re);return m?parseInt(m[1]):0;};
  const ft=re=>{const m=analysisText.match(re);return m?m[1].trim():null;};
  const score    = fi(/TOTAL:\s*([+-]?\d+)/i);
  const verdict  = ft(/\bVERDICT:\s*([^\n|]{3,40})/i);
  const autoTrade= ft(/AUTO.?TRADE.*?:\s*(YES[^\n]*|NO[^\n]*)/i);
  const quickSymM= analysisText.match(/QUICK SETUP[\s\S]*?Option:\s*([A-Z0-9]+)/i);
  const quickSymbol=quickSymM?quickSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const quickEntryM=analysisText.match(/QUICK SETUP[\s\S]*?Entry:\s*Rs([\d.]+)/i);
  const quickEntryL=quickEntryM?parseFloat(quickEntryM[1]):null;
  const quickEntryH=quickEntryL?quickEntryL*1.02:null;
  const quickSlM=analysisText.match(/QUICK SETUP[\s\S]*?SL:\s*Rs([\d.]+)/i);
  const quickSl=quickSlM?parseFloat(quickSlM[1]):null;
  const swingSymM=analysisText.match(/SWING SETUP[\s\S]*?Option:\s*([A-Z0-9]+)/i);
  const swingSymbol=swingSymM?swingSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const swingEntryM=analysisText.match(/SWING SETUP[\s\S]*?Entry:\s*Rs([\d.]+)/i);
  const swingEntryL=swingEntryM?parseFloat(swingEntryM[1]):null;
  const swingEntryH=swingEntryL?swingEntryL*1.02:null;
  const swingSlM=analysisText.match(/SWING SETUP[\s\S]*?SL:\s*Rs([\d.]+)/i);
  const swingSl=swingSlM?parseFloat(swingSlM[1]):null;
  // Parse machine-readable SCORES JSON block
  let scores={f1:0,f2:0,f3:0,f4:0,f5:0,f6:0,f7:0,f8:0,f9:0,f10:0};
  try {
    const sm=analysisText.match(/SCORES:\s*(\{[^}]+\})/);
    if(sm) Object.assign(scores, JSON.parse(sm[1]));
  } catch(e) {
    // fallback: scan for Fx label: ±N patterns
    const fp=(label,aliases)=>{
      for(const l of [label,...(aliases||[])]){
        const m=analysisText.match(new RegExp(l+'[^\d-+]*([+-]?\d+)','i'));
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

  return res.json({
    score,verdict,autoTrade,
    quickSymbol,quickEntryL,quickEntryH,quickSl,
    swingSymbol,swingEntryL,swingEntryH,swingSl,
    entryLow:quickEntryL,entryHigh:quickEntryH,
    scores,lotsStr,ivpVal,
    analysis:analysisText,
    marketData:{
      spot,vix,bn,liveF,atm,
      expiry:expiry.dateStr,dte:expiry.dte,isExpiry:expiry.isExpiry,
      vwap:vwap.toFixed(2),sma20:sma20.toFixed(2),ema9:ema9.toFixed(2),ema21:ema21.toFixed(2),
      pcr,callWall,putWall,atmCeP,atmPeP,orh,orl,
      r2:r2.toFixed?r2.toFixed(0):r2,r1:r1.toFixed?r1.toFixed(0):r1,
      pivot,s1:s1.toFixed?s1.toFixed(0):s1,s2:s2.toFixed?s2.toFixed(0):s2,
      openPositions:openPos,dataAgeMin,isFresh,nseSrc,advances,declines,
    },
    globalData:G,
    usage:{inputTokens,outputTokens},
    timestamp:istStr,sgt:sgtStr,
    kiteErr:null,kiteHttpStatus:200,
  });
}
