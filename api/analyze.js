// api/analyze.js — Nifty Options Analyst v6
// Market data: NSE India API + Yahoo Finance (FREE, no Kite subscription needed)
// Kite used only for: margins, positions, orders, trade execution
// NO web_search tool — all data pre-fetched in Vercel

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

  const apiKey = process.env.KITE_API_KEY;
  const kH = { 'Authorization': `token ${apiKey}:${accessToken}`, 'X-Kite-Version': '3' };

  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const istStr  = ist.toISOString().slice(0,19) + '+05:30';
  const sgtStr  = new Date(now.getTime() + 8*3600000).toISOString().slice(0,19) + '+08:00';
  const todayDate = ist.toISOString().slice(0,10);
  const dayName   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getDay()];

  const istH  = ist.getHours(), istM = ist.getMinutes();
  const istMins = istH*60 + istM;
  const isPreMarket  = istMins < 9*60+15;
  const isPostMarket = istMins >= 15*60+30;

  const prevTradingDate = (() => {
    const d = new Date(ist); d.setDate(d.getDate()-1);
    while([0,6].includes(d.getDay())) d.setDate(d.getDate()-1);
    return d.toISOString().slice(0,10);
  })();
  const hist5mDate = isPreMarket ? prevTradingDate : todayDate;
  const from30d = new Date(ist.getTime()-45*86400000).toISOString().slice(0,10);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getExpiry(offsetW=0) {
    const d=new Date(ist); const day=d.getDay();
    let da=day<=2?(2-day):(9-day);
    if(day===2){const ac=d.getHours()>15||(d.getHours()===15&&d.getMinutes()>=30);da=ac?7:0;}
    da+=offsetW*7;
    const exp=new Date(d.getTime()+da*86400000);
    const yy=String(exp.getFullYear()).slice(2);
    const m=['1','2','3','4','5','6','7','8','9','A','B','C'][exp.getMonth()];
    const dd=String(exp.getDate()).padStart(2,'0');
    // NSE expiry date string format: "19-May-2026"
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const nseStr=`${String(exp.getDate()).padStart(2,'0')}-${months[exp.getMonth()]}-${exp.getFullYear()}`;
    return {dateStr:exp.toISOString().slice(0,10),yy,m,dd,nseStr,
      dte:Math.max(0,Math.ceil((exp-ist)/86400000)),
      isExpiry:d.getDay()===2&&da===0};
  }
  const calcVWAP=c=>{if(!c?.length)return 0;let tv=0,v=0;for(const x of c){const tp=(x[2]+x[3]+x[4])/3;tv+=tp*x[5];v+=x[5];}return v?tv/v:0;};
  const calcSMA=(a,n)=>{if(!a?.length)return 0;const sl=a.slice(-n);return sl.reduce((x,y)=>x+y,0)/sl.length;};
  const calcEMA=(a,n)=>{if(!a||a.length<n)return a?.[a.length-1]||0;const k=2/(n+1);let e=a.slice(0,n).reduce((x,y)=>x+y,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;};

  // ── NSE Fetch (with cookie fallback) ───────────────────────────────────────
  const nseBaseH = {
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':'application/json,text/plain,*/*',
    'Accept-Language':'en-US,en;q=0.9',
    'Referer':'https://www.nseindia.com/',
    'Origin':'https://www.nseindia.com',
    'Sec-Fetch-Dest':'empty','Sec-Fetch-Mode':'cors','Sec-Fetch-Site':'same-origin',
  };
  let nseCookies='';
  async function nseGet(path, timeoutMs=8000) {
    const ctrl=new AbortController();
    const tid=setTimeout(()=>ctrl.abort(),timeoutMs);
    try {
      const r=await fetch(`https://www.nseindia.com${path}`,{headers:{...nseBaseH,Cookie:nseCookies||undefined},signal:ctrl.signal});
      clearTimeout(tid);
      if(r.ok) return r.json().catch(()=>null);
      // If blocked, fetch homepage first to get cookies
      if(!nseCookies){
        const hc=new AbortController(); setTimeout(()=>hc.abort(),6000);
        const hr=await fetch('https://www.nseindia.com',{headers:{...nseBaseH,Accept:'text/html'},signal:hc.signal});
        nseCookies=(hr.headers.get('set-cookie')||'').split(/,(?=\s*\w+=)/).map(c=>c.split(';')[0].trim()).filter(Boolean).join('; ');
        const ctrl2=new AbortController(); const tid2=setTimeout(()=>ctrl2.abort(),8000);
        const r2=await fetch(`https://www.nseindia.com${path}`,{headers:{...nseBaseH,Cookie:nseCookies},signal:ctrl2.signal});
        clearTimeout(tid2);
        return r2.ok?r2.json().catch(()=>null):null;
      }
      return null;
    } catch { clearTimeout(tid); return null; }
  }

  // ── Yahoo Finance Fetch ────────────────────────────────────────────────────
  const yfH={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124'};
  async function yfFetch(sym, interval='1d', range='2d') {
    const ctrl=new AbortController(); const tid=setTimeout(()=>ctrl.abort(),6000);
    try {
      const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,{headers:yfH,signal:ctrl.signal});
      clearTimeout(tid);
      const j=await r.json().catch(()=>null);
      return j?.chart?.result?.[0]||null;
    } catch { clearTimeout(tid); return null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1: KITE — margins, positions, orders ONLY (no quote/historical)
  // ══════════════════════════════════════════════════════════════════════════
  let liveF=0, openPos=[], posText='None', ordText='None';
  try {
    const [margR,posR,ordR]=await Promise.allSettled([
      fetch('https://api.kite.trade/user/margins',{headers:kH}),
      fetch('https://api.kite.trade/portfolio/positions',{headers:kH}),
      fetch('https://api.kite.trade/orders',{headers:kH}),
    ]);
    const pj=async r=>r.status==='fulfilled'?r.value.json().catch(()=>null):null;
    const [margJ,posJ,ordJ]=await Promise.all([margR,posR,ordR].map(pj));
    liveF=margJ?.data?.equity?.available?.cash??margJ?.data?.equity?.net??0;
    openPos=(posJ?.data?.net||[]).filter(p=>p.quantity!==0);
    posText=openPos.length?openPos.map(p=>`${p.tradingsymbol}: Qty ${p.quantity}, Avg ₹${(p.average_price||0).toFixed(2)}, LTP ₹${(p.last_price||0).toFixed(2)}, P&L ₹${(p.pnl||0).toFixed(2)}`).join('\n'):'None';
    const pendOrds=(ordJ?.data||[]).filter(o=>['OPEN','TRIGGER PENDING'].includes(o.status));
    ordText=pendOrds.length?pendOrds.map(o=>`${o.tradingsymbol}: ${o.transaction_type} ${o.quantity}@${o.price}`).join('\n'):'None';
  } catch(e){console.error('Kite error:',e.message);}

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2: NSE DATA — spot, indices, VIX, option chain
  // ══════════════════════════════════════════════════════════════════════════
  let spot=0,vix=0,bn=0,niftyIT=0,niftyAuto=0,niftyFin=0,niftyMid=0;
  let dayH=0,dayL=0,dayO=0,prevCl=0,volume=0;
  let advances='N/A',declines='N/A';
  let nseSrc='NSE';

  // 2A: allIndices
  const idxJ = await nseGet('/api/allIndices');
  if(idxJ?.data){
    const fi=(name)=>idxJ.data.find(d=>d.index===name||d.indexSymbol===name);
    const n50=fi('NIFTY 50')||fi('Nifty 50');
    const nvix=fi('INDIA VIX')||fi('India Vix');
    const bnk=fi('NIFTY BANK')||fi('Nifty Bank');
    const nit=fi('NIFTY IT')||fi('Nifty IT');
    const nau=fi('NIFTY AUTO')||fi('Nifty Auto');
    const nfi=fi('NIFTY FIN SERVICE')||fi('Nifty Fin Service');
    const nmi=fi('NIFTY MIDCAP 100')||fi('Nifty Midcap 100')||fi('NIFTY MIDCAP100');
    spot=n50?.last||n50?.indexValue||0;
    prevCl=n50?.previousClose||spot;
    dayH=n50?.high||spot; dayL=n50?.low||spot; dayO=n50?.open||spot;
    volume=n50?.turnover||0;
    advances=n50?.advances||'N/A'; declines=n50?.declines||'N/A';
    vix=nvix?.last||nvix?.indexValue||0;
    bn=bnk?.last||bnk?.indexValue||0;
    niftyIT=nit?.last||nit?.indexValue||0;
    niftyAuto=nau?.last||nau?.indexValue||0;
    niftyFin=nfi?.last||nfi?.indexValue||0;
    niftyMid=nmi?.last||nmi?.indexValue||0;
  }

  // If NSE allIndices failed, fall back to Yahoo Finance for spot
  if(!spot){
    nseSrc='Yahoo';
    const yN=await yfFetch('^NSEI','1d','2d');
    if(yN){
      spot=yN.meta?.regularMarketPrice||0;
      prevCl=yN.meta?.previousClose||yN.meta?.chartPreviousClose||spot;
      dayH=yN.meta?.regularMarketDayHigh||spot;
      dayL=yN.meta?.regularMarketDayLow||spot;
      dayO=yN.meta?.regularMarketOpen||spot;
    }
    const yVix=await yfFetch('^INDIAVIX','1d','2d');
    if(yVix) vix=yVix.meta?.regularMarketPrice||0;
    const yBN=await yfFetch('^NSEBANK','1d','2d');
    if(yBN) bn=yBN.meta?.regularMarketPrice||0;
  }

  // 2B: NSE Option Chain
  const expiry=getExpiry(0), expiryNx=getExpiry(1);
  const atm=spot?Math.round(spot/50)*50:0;
  let ocTable='Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
  ocTable    +='-------|--------|------------|----------|--------|------------|----------\n';
  let totCeOI=0,totPeOI=0,maxCeOI=0,maxPeOI=0,callWall=atm,putWall=atm;
  let pcr='0',maxPain=atm,atmCeP=0,atmPeP=0,nxAtmCeP=0,nxAtmPeP=0;
  let ivpVal=0;

  const ocJ=await nseGet('/api/option-chain-indices?symbol=NIFTY');
  if(ocJ?.records?.data && atm>0){
    // Use spot from option chain if we didn't get it above
    if(!spot&&ocJ.records.underlyingValue) {
      spot=ocJ.records.underlyingValue;
      prevCl=spot;
    }
    // Filter to nearest expiry
    const targetExpDate=expiry.nseStr;
    const ocRows=ocJ.records.data.filter(r=>r.expiryDate===targetExpDate);
    const nxOcRows=ocJ.records.data.filter(r=>r.expiryDate===expiryNx.nseStr);

    // Strikes: ATM ±5 strikes
    const strikesSet=new Set(ocRows.map(r=>r.strikePrice));
    const nearStrikes=[...strikesSet].sort((a,b)=>Math.abs(a-atm)-Math.abs(b-atm)).slice(0,12).sort((a,b)=>b-a);

    for(const st of nearStrikes){
      const row=ocRows.find(r=>r.strikePrice===st)||{};
      const ce=row.CE||{}, pe=row.PE||{};
      if(ce.openInterest){totCeOI+=ce.openInterest;if(ce.openInterest>maxCeOI){maxCeOI=ce.openInterest;callWall=st;}}
      if(pe.openInterest){totPeOI+=pe.openInterest;if(pe.openInterest>maxPeOI){maxPeOI=pe.openInterest;putWall=st;}}
      const fc=n=>(n>=0?'+':'')+String(Math.round(n)).padStart(8);
      ocTable+=`${String(st).padStart(6)} | ${String((ce.lastPrice||0).toFixed(0)).padStart(6)} | ${String(ce.openInterest||0).padStart(10)} | ${fc(ce.changeinOpenInterest||0)} | ${String((pe.lastPrice||0).toFixed(0)).padStart(6)} | ${String(pe.openInterest||0).padStart(10)} | ${fc(pe.changeinOpenInterest||0)}\n`;
    }

    // Total PCR
    const totCe=ocJ.filtered?.CE?.totOI||totCeOI;
    const totPe=ocJ.filtered?.PE?.totOI||totPeOI;
    pcr=totCe>0?(totPe/totCe).toFixed(3):'0';

    // Max Pain
    let minLoss=Infinity;
    for(const target of nearStrikes){
      let loss=0;
      for(const row of ocRows){
        const st=row.strikePrice;
        if(target<st) loss+=(row.CE?.openInterest||0)*(st-target);
        if(target>st) loss+=(row.PE?.openInterest||0)*(target-st);
      }
      if(loss<minLoss){minLoss=loss;maxPain=target;}
    }

    // ATM premiums
    const atmRow=ocRows.find(r=>r.strikePrice===atm)||{};
    atmCeP=atmRow.CE?.lastPrice||0;
    atmPeP=atmRow.PE?.lastPrice||0;

    // IVP from ATM CE IV (simplified: use ATM CE IV as proxy)
    ivpVal=Math.round(atmRow.CE?.impliedVolatility||atmRow.PE?.impliedVolatility||0);

    // Next expiry ATM premiums
    const nxAtmRow=nxOcRows.find(r=>r.strikePrice===atm)||{};
    nxAtmCeP=nxAtmRow.CE?.lastPrice||0;
    nxAtmPeP=nxAtmRow.PE?.lastPrice||0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3: YAHOO FINANCE — intraday 5m + daily 45d historical + global
  // ══════════════════════════════════════════════════════════════════════════
  // 3A: Nifty 50 intraday 5-min candles (for VWAP, ORH/ORL, momentum)
  let c5m=[];
  const yIntra=await yfFetch('^NSEI','5m','1d');
  if(yIntra?.timestamp){
    const ts=yIntra.timestamp, q=yIntra.indicators.quote[0];
    for(let i=0;i<ts.length;i++){
      const o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i],v=q.volume[i];
      if(o&&h&&l&&c) c5m.push([new Date(ts[i]*1000).toISOString(),o,h,l,c,v||0]);
    }
  }

  // 3B: Nifty 50 daily 45-day historical (for EMA9/21, SMA20, S-R)
  let cDay=[];
  const yDaily=await yfFetch('^NSEI','1d','60d');
  if(yDaily?.timestamp){
    const ts=yDaily.timestamp, q=yDaily.indicators.quote[0];
    for(let i=0;i<ts.length;i++){
      const o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i],v=q.volume[i];
      if(o&&h&&l&&c) cDay.push([new Date(ts[i]*1000).toISOString(),o,h,l,c,v||0]);
    }
  }

  // 3C: Global indices
  const [sp500,dow,nas,crude,gold,usdInr,nikkei,hsi]=await Promise.all([
    yfFetch('^GSPC'),yfFetch('^DJI'),yfFetch('^IXIC'),
    yfFetch('CL=F'),yfFetch('GC=F'),yfFetch('INR=X'),
    yfFetch('^N225'),yfFetch('^HSI'),
  ]);
  const toG=r=>{if(!r?.meta)return null;const m=r.meta;const prev=m.previousClose||m.chartPreviousClose||m.regularMarketPrice;const cur=m.regularMarketPrice;return{price:cur,prev,chg:(cur-prev).toFixed(2),pct:(((cur-prev)/prev)*100).toFixed(2)};};
  const G={sp500:toG(sp500),dow:toG(dow),nas:toG(nas),crude:toG(crude),gold:toG(gold),usdInr:toG(usdInr),nikkei:toG(nikkei),hsi:toG(hsi)};

  // ── Derived calculations ────────────────────────────────────────────────────
  const vwap=calcVWAP(c5m);
  const cl30=cDay.map(c=>c[4]);
  const sma20=calcSMA(cl30,20), ema9=calcEMA(cl30,9), ema21=calcEMA(cl30,21);

  // If we got intraday data but no dayH/L from NSE, derive from candles
  if(c5m.length&&(!dayH||!dayL)){
    dayH=Math.max(...c5m.map(c=>c[2]));
    dayL=Math.min(...c5m.map(c=>c[3]));
    dayO=c5m[0]?.[1]||dayO;
  }
  // If daily data has today's close price, use for prevCl
  if(cDay.length>=2&&!prevCl) prevCl=cDay[cDay.length-2]?.[4]||0;

  const orC=c5m.slice(0,3);
  const orh=orC.length?Math.max(...orC.map(c=>c[2])):dayH;
  const orl=orC.length?Math.min(...orC.map(c=>c[3])):dayL;
  const hIdx=c5m.findIndex(c=>c[2]===dayH), lIdx=c5m.findIndex(c=>c[3]===dayL);
  const htim=c5m.length?hIdx<=6?'FIRST 30MIN':hIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY':'N/A';
  const ltim=c5m.length?lIdx<=6?'FIRST 30MIN':lIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY':'N/A';
  const last5=c5m.slice(-5);
  const mom=last5.length>=3?(()=>{const hhs=last5.every((c,i)=>i===0||c[2]>=last5[i-1][2]);const lls=last5.every((c,i)=>i===0||c[3]<=last5[i-1][3]);return hhs?'BULLISH HH/HL':lls?'BEARISH LL/LH':'MIXED';})():'N/A';
  const instC=c5m.filter(c=>(c[2]-c[3])>80);
  const instDesc=instC.length?`${instC.length} candle(s). Last: ${instC[instC.length-1][4]>instC[instC.length-1][1]?'BULLISH':'BEARISH'} @ ${instC[instC.length-1][0].slice(11,16)}`:'None';
  const green10=cDay.slice(-10).filter(c=>c[4]>=c[1]).length;
  const highs30=cDay.slice(-30).map(c=>c[2]), lows30=cDay.slice(-30).map(c=>c[3]);
  const r2=highs30.length?Math.max(...highs30):0, s2=lows30.length?Math.min(...lows30):0;
  const highs10=cDay.slice(-10).map(c=>c[2]), lows10=cDay.slice(-10).map(c=>c[3]);
  const r1=highs10.length?Math.max(...highs10):0, s1=lows10.length?Math.min(...lows10):0;
  const pvDay=cDay[cDay.length-1];
  const pivot=pvDay?((pvDay[2]+pvDay[3]+pvDay[4])/3).toFixed(2):0;

  const maxAfford=liveF>0?(liveF/65).toFixed(2):'0';
  const dataAgeMin=spot?0:999;
  const isFresh=spot>0;

  const last20c=c5m.slice(-20).map(c=>`[${c[0].slice(11,16)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');
  const last15d=cDay.slice(-15).map(c=>`[${c[0].slice(0,10)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');

  // Pack into K for backward compat with prompt template
  const K={
    spot,chg:spot-prevCl,prevCl,dayH,dayL,dayO,volume,
    vix,bn,niftyIT,niftyAuto,niftyFin,niftyMid,liveF,
    atm,expiry,expiryNx,vwap:vwap.toFixed(2),
    sma20:sma20.toFixed(2),ema9:ema9.toFixed(2),ema21:ema21.toFixed(2),
    orh:orh.toFixed(2),orl:orl.toFixed(2),htim,ltim,mom,instDesc,green10,
    r2:r2.toFixed(0),r1:r1.toFixed(0),s1:s1.toFixed(0),s2:s2.toFixed(0),pivot,
    pcr,callWall,putWall,maxPain,atmCeP,atmPeP,nxAtmCeP,nxAtmPeP,maxAfford,
    dataAgeMin,isFresh,isPreMarket,isPostMarket,hist5mDate,
    ocTable,posText,ordText,openPos,last20c,last15d,nseSrc,
    advances,declines,kiteErr:null,kiteHttpStatus:200,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4: BUILD PROMPT
  // ══════════════════════════════════════════════════════════════════════════
  const sigma1d=K.spot&&vix?(K.spot*(vix/100)/Math.sqrt(252)).toFixed(0):'—';
  const sigma1w=K.spot&&vix?(K.spot*(vix/100)/Math.sqrt(52)).toFixed(0):'—';
  const atmAfford=liveF&&atmCeP?Math.floor(liveF/(atmCeP*65))||0:0;
  const gLine=(label,d)=>d?`${label}: ${d.price?.toFixed(2)} (${d.pct>=0?'+':''}${d.pct}%)`:`${label}: N/A`;

  const prompt=`You are a seasoned Nifty 50 F&O analyst (15+ years). Run the nifty-options-analyst skill v5.
ALL market data is already fetched and provided below — NO web searches needed. Analyze what's given.

TIME: ${istStr} / ${sgtStr} | ${dayName} ${todayDate}
SESSION: ${isPreMarket?`PRE-MARKET (data from prev session: ${K.hist5mDate})`:isPostMarket?'POST-MARKET (today close data)':'LIVE MARKET (intraday)'}
DATA SOURCES: Spot+Indices=${nseSrc} | Option Chain=NSE | Candles=Yahoo Finance | Global=Yahoo Finance

═══ CONSTANTS ═══
Lot size: 65 | Expiry: TUESDAY | LIVE_FUNDS: ₹${liveF.toFixed(0)}
Max affordable premium: ₹${maxAfford}/unit | Max lots at ATM: ${atmAfford} | Auto-trade: ±8 | SL: 50% premium

${!K.isFresh?`⚠️ DATA FEED FAILURE — Nifty spot not available. Apply MANDATORY STAY OUT — all verdicts = STAY OUT.`:`
═══ MARKET DATA (${nseSrc}) ═══
NIFTY 50: ${spot} | Chg: ${K.chg>=0?'+':''}${K.chg?.toFixed(2)} from ${prevCl}
Day: O:${dayO} H:${dayH} L:${dayL} | Vol: ${volume}
VWAP: ${K.vwap} | 20-DMA: ${K.sma20} | 9-EMA: ${K.ema9} | 21-EMA: ${K.ema21}
9-EMA ${K.ema9>K.ema21?'ABOVE (bullish)':'BELOW (bearish)'} 21-EMA by ${Math.abs(K.ema9-K.ema21).toFixed(2)} pts
Opening Range: H=${K.orh} L=${K.orl} | Spot ${spot>orh?'ABOVE ORH ✅':spot<orl?'BELOW ORL 🔻':'INSIDE RANGE'}
Day H timing: ${K.htim} | Day L timing: ${K.ltim}
Momentum (last 5 candles): ${K.mom}
Institutional candles (spread >80pts): ${K.instDesc}
Bullish days (last 10): ${green10}/10

═══ INDICES & SECTORS ═══
VIX: ${vix||'N/A'} | Bank Nifty: ${bn||'N/A'} | Nifty IT: ${niftyIT||'N/A'}
Nifty Auto: ${niftyAuto||'N/A'} | Nifty Fin: ${niftyFin||'N/A'} | Nifty Midcap: ${niftyMid||'N/A'}
Market Breadth: Advances ${advances} / Declines ${declines}

═══ OPTION CHAIN (NSE, Expiry ${expiry.nseStr}, ${expiry.dte} DTE) ═══
ATM: ${atm} | PCR: ${pcr} | Call Wall: ${callWall} | Put Wall: ${putWall} | Max Pain: ${maxPain}
ATM CE: ₹${atmCeP} | ATM PE: ₹${atmPeP} | IVP (ATM IV): ${ivpVal}%
Next expiry (${expiryNx.nseStr}) ATM CE: ₹${nxAtmCeP} | PE: ₹${nxAtmPeP}
σ (1-day): ${sigma1d} pts | σ (1-week): ${sigma1w} pts
${K.ocTable}

═══ KEY LEVELS (30-day range) ═══
R2 (30d high): ${K.r2} | R1 (10d high): ${K.r1} | Pivot: ${K.pivot} | S1: ${K.s1} | S2: ${K.s2}

═══ LAST 20 INTRADAY CANDLES (5-min, Yahoo Finance) ═══
${K.last20c||'No intraday data'}

═══ LAST 15 DAILY CANDLES ═══
${K.last15d||'No daily data'}
`}

═══ GLOBAL CUES (Yahoo Finance) ═══
${gLine('S&P500',G.sp500)} | ${gLine('Dow',G.dow)} | ${gLine('Nasdaq',G.nas)}
${gLine('Nikkei',G.nikkei)} | ${gLine('Hang Seng',G.hsi)}
${gLine('Crude',G.crude)} | ${gLine('Gold',G.gold)} | ${gLine('USD/INR',G.usdInr)}

═══ POSITIONS & ORDERS ═══
Open Positions: ${posText}
Pending Orders: ${ordText}

═══ FULL ANALYSIS REQUIRED ═══
Run ALL phases of the nifty-options-analyst skill v5:
1. Score ALL 10 factors (F1-F10/F11) with numeric scores
2. Build complete SCORECARD with TOTAL
3. Apply skill rules: STAY OUT if score -5 to +5; MANDATORY STAY OUT if data failure
4. Produce PHASE 7 output block with KEY LEVELS
5. Give DUAL VERDICT: ⚡ Quick Setup (+15-20 pts) + 🎯 Swing Setup (+100 pts)

MANDATORY STAY OUT conditions:
- VIX > 22
- Data feed failure (spot = 0)
- Expiry day with score -5 to +5
- Insufficient margin for 1 lot

SCORECARD FORMAT (copy exactly):
F1 VIX: [+/-X] | F2 PCR/OI/Skew: [+/-X]
F3 Intraday: [+/-X] | F4 Daily Trend: [+/-X]
F5 Sectoral: [+/-X] | F6 FII/DII: [+/-X]
F7 Breadth/Vol/A/D: [+/-X] | F8 Global: [+/-X]
F9 IV/Greeks/Sensi: [+/-X] | F10 Events: [+/-X]
TOTAL: [+/-XX] / 33

⚠️ 91% of retail F&O traders lost money FY2024-25 (SEBI). Not SEBI-registered advice.`;

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5: ANTHROPIC API
  // ══════════════════════════════════════════════════════════════════════════
  let analysisText='', inputTokens=0, outputTokens=0;
  try {
    const aRes=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:4096,messages:[{role:'user',content:prompt}]})
    });
    const aData=await aRes.json();
    if(!aRes.ok) throw new Error(aData?.error?.message||`Anthropic HTTP ${aRes.status}`);
    inputTokens=aData.usage?.input_tokens||0;
    outputTokens=aData.usage?.output_tokens||0;
    analysisText=(aData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if(!analysisText) throw new Error('Empty response from Anthropic');
  } catch(e){
    return res.status(500).json({error:'Analysis failed: '+e.message,kiteData:{spot,vix}});
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6: PARSE RESPONSE
  // ══════════════════════════════════════════════════════════════════════════
  const fi=re=>{const m=analysisText.match(re);return m?parseInt(m[1]):0;};
  const ft=re=>{const m=analysisText.match(re);return m?m[1].trim():null;};

  const score=fi(/TOTAL:\s*([+-]?\d+)/i);
  const verdict=ft(/\bVERDICT:\s*([^\n|]{3,40})/i);
  const autoTrade=ft(/AUTO.?TRADE.*?:\s*(YES[^\n]*|NO[^\n]*)/i);

  const quickSymM=analysisText.match(/QUICK SETUP[\s\S]*?Option:\s*([A-Z0-9]+)/i);
  const quickSymbol=quickSymM?quickSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const quickEntryM=analysisText.match(/QUICK SETUP[\s\S]*?Entry:\s*₹([\d.]+)/i);
  const quickEntryL=quickEntryM?parseFloat(quickEntryM[1]):null;
  const quickEntryH=quickEntryL?(quickEntryL*1.02):null;
  const quickSlM=analysisText.match(/QUICK SETUP[\s\S]*?SL:\s*₹([\d.]+)/i);
  const quickSl=quickSlM?parseFloat(quickSlM[1]):null;

  const swingSymM=analysisText.match(/SWING SETUP[\s\S]*?Option:\s*([A-Z0-9]+)/i);
  const swingSymbol=swingSymM?swingSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const swingEntryM=analysisText.match(/SWING SETUP[\s\S]*?Entry:\s*₹([\d.]+)/i);
  const swingEntryL=swingEntryM?parseFloat(swingEntryM[1]):null;
  const swingEntryH=swingEntryL?(swingEntryL*1.02):null;
  const swingSlM=analysisText.match(/SWING SETUP[\s\S]*?SL:\s*₹([\d.]+)/i);
  const swingSl=swingSlM?parseFloat(swingSlM[1]):null;

  const scores={
    f1:fi(/F1\s+VIX[^|]*\[?([+-]?\d+)\]?/i),
    f2:fi(/F2\s+PCR[^|]*\[?([+-]?\d+)\]?/i),
    f3:fi(/F3\s+Intraday[^|]*\[?([+-]?\d+)\]?/i),
    f4:fi(/F4\s+Daily[^|]*\[?([+-]?\d+)\]?/i),
    f5:fi(/F5\s+Sectoral[^|]*\[?([+-]?\d+)\]?/i),
    f6:fi(/F6\s+FII[^|]*\[?([+-]?\d+)\]?/i),
    f7:fi(/F7\s+Breadth[^|]*\[?([+-]?\d+)\]?/i),
    f8:fi(/F8\s+Global[^|]*\[?([+-]?\d+)\]?/i),
    f9:fi(/F9\s+IV[^|]*\[?([+-]?\d+)\]?/i),
    f10:fi(/F10\s+Events[^|]*\[?([+-]?\d+)\]?/i),
  };

  const maxAffordLots=liveF&&atmCeP?Math.floor(liveF/(atmCeP*65))||0:0;
  const lotsStr=`${maxAffordLots} lot(s) at ATM (₹${atmCeP}/unit × 65 = ₹${(atmCeP*65).toFixed(0)}/lot)`;

  return res.json({
    score,verdict,autoTrade,
    quickSymbol,quickEntryL,quickEntryH,quickSl,
    swingSymbol,swingEntryL,swingEntryH,swingSl,
    entryLow:quickEntryL,entryHigh:quickEntryH,
    scores,lotsStr,ivpVal,
    analysis:analysisText,
    marketData:{
      spot,vix,bn:K.bn,liveF,
      atm,expiry:expiry.dateStr,dte:expiry.dte,
      isExpiry:expiry.isExpiry,vwap:K.vwap,sma20:K.sma20,
      ema9:K.ema9,ema21:K.ema21,pcr,
      callWall,putWall,atmCeP,atmPeP,
      orh:K.orh,orl:K.orl,
      r2:K.r2,r1:K.r1,pivot:K.pivot,s1:K.s1,s2:K.s2,
      openPositions:openPos,
      dataAgeMin,isFresh,nseSrc,
      advances,declines,
    },
    globalData:G,
    usage:{inputTokens,outputTokens},
    timestamp:istStr,sgt:sgtStr,
    kiteErr:null,kiteHttpStatus:200,
  });
}
