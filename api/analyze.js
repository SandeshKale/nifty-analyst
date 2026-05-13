// api/analyze.js — Nifty Options Analyst v5
// Pre-fetches ALL data in Vercel (Kite + Yahoo Finance + NSE)
// NO web_search tool — saves ~8000 tokens per call, cuts cost 70%
// Auto-trade: ±8 threshold | LEAN → STAY OUT | 50% premium SL

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
  const istStr  = ist.toISOString().replace('T',' ').slice(0,19) + ' IST';
  const sgtStr  = new Date(now.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,19) + ' SGT';
  const todayDate = ist.toISOString().slice(0,10);
  const dayName   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getDay()];

  const istH    = ist.getHours(), istM = ist.getMinutes();
  const istMins = istH*60 + istM;
  const isPreMarket  = istMins < 9*60+15;
  const isPostMarket = istMins >= 15*60+30;
  const marketActive = !isPreMarket && !isPostMarket;

  const prevTradingDate = (() => {
    const d = new Date(ist); d.setDate(d.getDate()-1);
    while([0,6].includes(d.getDay())) d.setDate(d.getDate()-1);
    return d.toISOString().slice(0,10);
  })();
  const hist5mDate = isPreMarket ? prevTradingDate : todayDate;
  const hist5mFrom = `${hist5mDate} 09:15:00`;
  const hist5mTo   = isPreMarket
    ? `${hist5mDate} 15:30:00`
    : `${todayDate} ${String(istH).padStart(2,'0')}:${String(istM).padStart(2,'0')}:00`;
  const from30d = new Date(ist.getTime()-31*86400000).toISOString().slice(0,10);

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
    return {dateStr:exp.toISOString().slice(0,10),yy,m,dd,
      dte:Math.max(0,Math.ceil((exp-ist)/86400000)),
      isExpiry:d.getDay()===2&&da===0};
  }
  const kSym=(exp,st,t)=>`NIFTY${exp.yy}${exp.m}${exp.dd}${st}${t}`;
  const calcVWAP=c=>{if(!c?.length)return 0;let tv=0,v=0;for(const x of c){const tp=(x[2]+x[3]+x[4])/3;tv+=tp*x[5];v+=x[5];}return v?tv/v:0;};
  const calcSMA=(a,n)=>{if(!a?.length)return 0;const sl=a.slice(-n);return sl.reduce((x,y)=>x+y,0)/sl.length;};
  const calcEMA=(a,n)=>{if(!a||a.length<n)return a?.[a.length-1]||0;const k=2/(n+1);let e=a.slice(0,n).reduce((x,y)=>x+y,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;};

  // ── SECTION 1: KITE DATA ───────────────────────────────────────────────────
  let K = { error: null };
  try {
    const enc=encodeURIComponent;
    const [qR,ltpR,margR,posR,ordR,h5R,hdR] = await Promise.allSettled([
      fetch(`https://api.kite.trade/quote?i=${enc('NSE:NIFTY 50')}`,{headers:kH}),
      fetch(`https://api.kite.trade/ltp?i=${enc('NSE:INDIA VIX')}&i=${enc('NSE:NIFTY BANK')}&i=${enc('NSE:NIFTY IT')}&i=${enc('NSE:NIFTY AUTO')}&i=${enc('NSE:NIFTY FIN SERVICE')}&i=${enc('NSE:NIFTY MIDCAP 100')}`,{headers:kH}),
      fetch(`https://api.kite.trade/user/margins`,{headers:kH}),
      fetch(`https://api.kite.trade/portfolio/positions`,{headers:kH}),
      fetch(`https://api.kite.trade/orders`,{headers:kH}),
      fetch(`https://api.kite.trade/instruments/historical/256265/5minute?from=${enc(hist5mFrom)}&to=${enc(hist5mTo)}`,{headers:kH}),
      fetch(`https://api.kite.trade/instruments/historical/256265/day?from=${from30d}&to=${todayDate}`,{headers:kH}),
    ]);
    const pj=async r=>r.status==='fulfilled'?r.value.json().catch(()=>null):null;
    const [qJ,ltpJ,margJ,posJ,ordJ,h5J,hdJ]=await Promise.all([qR,ltpR,margR,posR,ordR,h5R,hdR].map(pj));

    const nQ=qJ?.data?.['NSE:NIFTY 50'];
    const spot=nQ?.last_price||0, prevCl=nQ?.ohlc?.close||spot;
    const liveF=margJ?.data?.equity?.available?.cash??margJ?.data?.equity?.net??0;
    const c5m=h5J?.data?.candles||[], cDay=hdJ?.data?.candles||[];
    const vwap=calcVWAP(c5m), cl30=cDay.map(c=>c[4]);
    const sma20=calcSMA(cl30,20), ema9=calcEMA(cl30,9), ema21=calcEMA(cl30,21);

    const expiry=getExpiry(0), expiryNx=getExpiry(1);
    const atm=Math.round(spot/50)*50;
    const orC=c5m.slice(0,3);
    const orh=orC.length?Math.max(...orC.map(c=>c[2])):0;
    const orl=orC.length?Math.min(...orC.map(c=>c[3])):0;
    const dayH=nQ?.ohlc?.high||0, dayL=nQ?.ohlc?.low||0, dayO=nQ?.ohlc?.open||0;
    const hIdx=c5m.findIndex(c=>c[2]===dayH), lIdx=c5m.findIndex(c=>c[3]===dayL);
    const htim=hIdx<=6?'FIRST 30MIN':hIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY';
    const ltim=lIdx<=6?'FIRST 30MIN':lIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY';
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

    // Option chain
    const ceS=[atm,atm+50,atm+100,atm+150,atm+200,atm+300,atm+500];
    const peS=[atm,atm-50,atm-100,atm-150,atm-200,atm-300,atm-500];
    const curSyms=[...ceS.map(s=>`NFO:${kSym(expiry,s,'CE')}`),...peS.map(s=>`NFO:${kSym(expiry,s,'PE')}`)];
    const nxSyms=[atm,atm+50,atm+100,atm-50,atm-100].flatMap(s=>[`NFO:${kSym(expiryNx,s,'CE')}`,`NFO:${kSym(expiryNx,s,'PE')}`]);
    const [ocRes,nxRes]=await Promise.all([
      fetch(`https://api.kite.trade/quote?${curSyms.map(s=>`i=${enc(s)}`).join('&')}`,{headers:kH}).catch(()=>null),
      fetch(`https://api.kite.trade/quote?${nxSyms.map(s=>`i=${enc(s)}`).join('&')}`,{headers:kH}).catch(()=>null),
    ]);
    const ocData=(ocRes?await ocRes.json().catch(()=>null):null)?.data||{};
    const nxData=(nxRes?await nxRes.json().catch(()=>null):null)?.data||{};

    let ocTable='Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
    ocTable    +='-------|--------|------------|----------|--------|------------|----------\n';
    let totCeOI=0,totPeOI=0,maxCeOI=0,maxPeOI=0,callWall=atm,putWall=atm;
    const allS=[...new Set([...ceS,...peS])].sort((a,b)=>b-a);
    for(const st of allS){
      const ce=ocData[`NFO:${kSym(expiry,st,'CE')}`], pe=ocData[`NFO:${kSym(expiry,st,'PE')}`];
      if(ce){totCeOI+=ce.oi||0;if((ce.oi||0)>maxCeOI){maxCeOI=ce.oi||0;callWall=st;}}
      if(pe){totPeOI+=pe.oi||0;if((pe.oi||0)>maxPeOI){maxPeOI=pe.oi||0;putWall=st;}}
      const ceC=ce?(ce.oi||0)-(ce.oi_day_low||ce.oi||0):0;
      const peC=pe?(pe.oi||0)-(pe.oi_day_low||pe.oi||0):0;
      const fc=n=>(n>=0?'+':'')+String(n).padStart(8);
      ocTable+=`${String(st).padStart(6)} | ${String((ce?.last_price||0).toFixed(0)).padStart(6)} | ${String(ce?.oi||0).padStart(10)} | ${fc(ceC)} | ${String((pe?.last_price||0).toFixed(0)).padStart(6)} | ${String(pe?.oi||0).padStart(10)} | ${fc(peC)}\n`;
    }

    // Calculate Max Pain from OC data
    let maxPain=atm, minMaxPainLoss=Infinity;
    for(const target of allS){
      let loss=0;
      for(const st of allS){
        const ce=ocData[`NFO:${kSym(expiry,st,'CE')}`], pe=ocData[`NFO:${kSym(expiry,st,'PE')}`];
        if(target<st) loss+=(ce?.oi||0)*(st-target);
        if(target>st) loss+=(pe?.oi||0)*(target-st);
      }
      if(loss<minMaxPainLoss){minMaxPainLoss=loss;maxPain=target;}
    }

    const pcr=totCeOI>0?(totPeOI/totCeOI).toFixed(3):'0';
    const atmCeP=ocData[`NFO:${kSym(expiry,atm,'CE')}`]?.last_price||0;
    const atmPeP=ocData[`NFO:${kSym(expiry,atm,'PE')}`]?.last_price||0;
    const nxAtmCeP=nxData[`NFO:${kSym(expiryNx,atm,'CE')}`]?.last_price||0;
    const nxAtmPeP=nxData[`NFO:${kSym(expiryNx,atm,'PE')}`]?.last_price||0;
    const maxAfford=liveF>0?(liveF/65).toFixed(2):'0';
    const openPos=(posJ?.data?.net||[]).filter(p=>p.quantity!==0);
    const posText=openPos.length?openPos.map(p=>`${p.tradingsymbol}: Qty ${p.quantity}, Avg ₹${(p.average_price||0).toFixed(2)}, LTP ₹${(p.last_price||0).toFixed(2)}, P&L ₹${(p.pnl||0).toFixed(2)}`).join('\n'):'None';
    const pendOrds=(ordJ?.data||[]).filter(o=>['OPEN','TRIGGER PENDING'].includes(o.status));
    const ordText=pendOrds.length?pendOrds.map(o=>`${o.tradingsymbol}: ${o.transaction_type} ${o.quantity}@${o.price}`).join('\n'):'None';
    const last20c=c5m.slice(-20).map(c=>`[${c[0].slice(11,16)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');
    const last15d=cDay.slice(-15).map(c=>`[${c[0].slice(0,10)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');
    const lastTT=qJ?.data?.['NSE:NIFTY 50']?.last_trade_time;
    const dataAgeMin=lastTT?Math.round((ist-new Date(lastTT))/60000):999;

    K={spot,chg:spot-prevCl,prevCl,dayH,dayL,dayO,volume:nQ?.volume||0,
      vix:ltpJ?.data?.['NSE:INDIA VIX']?.last_price,
      bn:ltpJ?.data?.['NSE:NIFTY BANK']?.last_price,
      niftyIT:ltpJ?.data?.['NSE:NIFTY IT']?.last_price,
      niftyAuto:ltpJ?.data?.['NSE:NIFTY AUTO']?.last_price,
      niftyFin:ltpJ?.data?.['NSE:NIFTY FIN SERVICE']?.last_price,
      niftyMid:ltpJ?.data?.['NSE:NIFTY MIDCAP 100']?.last_price,
      liveF,atm,expiry,expiryNx,
      vwap:vwap.toFixed(2),sma20:sma20.toFixed(2),ema9:ema9.toFixed(2),ema21:ema21.toFixed(2),
      orh:orh.toFixed(2),orl:orl.toFixed(2),htim,ltim,mom,instDesc,green10,
      r2:r2.toFixed(0),r1:r1.toFixed(0),s1:s1.toFixed(0),s2:s2.toFixed(0),pivot,
      pcr,callWall,putWall,maxPain,atmCeP,atmPeP,nxAtmCeP,nxAtmPeP,maxAfford,
      dataAgeMin,isFresh:dataAgeMin<5,isPreMarket,isPostMarket,hist5mDate,
      ocTable,posText,ordText,openPos,last20c,last15d};
  } catch(e){K.error=e.message;console.error('Kite error:',e.message);}

  // ── SECTION 2: YAHOO FINANCE (global cues — no Anthropic credits) ──────────
  let G = {};
  try {
    const yfFetch = async (sym) => {
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' }, signal: ctrl.signal }
        );
        const j = await r.json();
        const m = j?.chart?.result?.[0]?.meta;
        if (!m) return null;
        const prev = m.previousClose || m.chartPreviousClose || m.regularMarketPrice;
        const cur  = m.regularMarketPrice;
        return { price: cur, prev, chg: (cur-prev).toFixed(2), pct: (((cur-prev)/prev)*100).toFixed(2) };
      } catch { return null; }
    };

    const [sp500, dow, nas, crude, gold, usdInr, nikkei, hsi] = await Promise.all([
      yfFetch('^GSPC'), yfFetch('^DJI'), yfFetch('^IXIC'),
      yfFetch('CL=F'), yfFetch('GC=F'), yfFetch('INR=X'),
      yfFetch('^N225'), yfFetch('^HSI'),
    ]);
    G = { sp500, dow, nas, crude, gold, usdInr, nikkei, hsi };
  } catch(e) { console.error('Yahoo Finance error:', e.message); }

  // ── SECTION 3: NSE BREADTH (advance/decline) ───────────────────────────────
  let NSE = {};
  try {
    const r = await fetch('https://www.nseindia.com/api/allIndices', {
      headers: { 'User-Agent':'Mozilla/5.0','Accept':'application/json','Referer':'https://www.nseindia.com/' }
    });
    const j = await r.json();
    const nifty50 = j?.data?.find(d => d.index === 'NIFTY 50');
    NSE = {
      advances:  nifty50?.advances  || 'N/A',
      declines:  nifty50?.declines  || 'N/A',
      unchanged: nifty50?.unchanged || 'N/A',
    };
  } catch { NSE = { note: 'NSE breadth unavailable — estimate from sectoral data' }; }

  // ── SECTION 4: BUILD PROMPT ────────────────────────────────────────────────
  const vix = K.vix||0;
  const sigma1d = K.spot&&vix ? (K.spot*(vix/100)/Math.sqrt(252)).toFixed(0) : '—';
  const sigma1w = K.spot&&vix ? (K.spot*(vix/100)/Math.sqrt(52)).toFixed(0)  : '—';
  const atmAfford = K.liveF&&K.atmCeP ? Math.floor(K.liveF/(K.atmCeP*65))||0 : 0;

  const gLine = (label, d) => d ? `${label}: ${d.price?.toFixed(2)} (${d.pct>=0?'+':''}${d.pct}%)` : `${label}: N/A`;

  const prompt = `You are a seasoned Nifty 50 F&O analyst (15+ years). Run the nifty-options-analyst skill v5.
ALL market data is already fetched and provided below — NO web searches needed. Analyze what's given.

TIME: ${istStr} / ${sgtStr} | ${dayName} ${todayDate}
SESSION: ${isPreMarket?`PRE-MARKET (data from prev session: ${K.hist5mDate})`
         :isPostMarket?'POST-MARKET (today close data)':'LIVE MARKET (intraday)'}

═══ CONSTANTS ═══
Lot size: 65 | Expiry: TUESDAY | LIVE_FUNDS: ₹${(K.liveF||0).toFixed(0)}
Max affordable premium: ₹${K.maxAfford}/unit | Auto-trade threshold: ±8 | SL: 50% of entry premium

═══ KITE LIVE DATA ═══
NIFTY 50: ${K.spot} | Chg: ${K.chg>=0?'+':''}${K.chg?.toFixed(2)} from ${K.prevCl}
Day: O:${K.dayO} H:${K.dayH} L:${K.dayL} | Vol: ${K.volume}
VWAP: ${K.vwap} | 20-DMA: ${K.sma20} | 9-EMA: ${K.ema9} | 21-EMA: ${K.ema21}
9-EMA ${K.ema9>K.ema21?'ABOVE (bullish)':'BELOW (bearish)'} 21-EMA by ${Math.abs(K.ema9-K.ema21).toFixed(2)} pts
Opening Range: H=${K.orh} L=${K.orl} | Spot ${K.spot>K.orh?'ABOVE ORH ✅':K.spot<K.orl?'BELOW ORL 🔻':'INSIDE RANGE'}
Day H timing: ${K.htim} | Day L timing: ${K.ltim}
5-candle momentum: ${K.mom} | Institutional candles (>80pt): ${K.instDesc}
VIX: ${K.vix} | σ1d: ±${sigma1d}pts | σ1w: ±${sigma1w}pts
BN: ${K.bn} | IT: ${K.niftyIT} | AUTO: ${K.niftyAuto} | FIN: ${K.niftyFin} | MID: ${K.niftyMid}

EXPIRY: ${K.expiry?.dateStr} (DTE: ${K.expiry?.dte}${K.expiry?.isExpiry?' ⚠️ EXPIRY DAY':''})
NEXT EXPIRY: ${K.expiryNx?.dateStr} (DTE: ${K.expiryNx?.dte})
ATM: ${K.atm} | PCR (calculated): ${K.pcr}
MAX PAIN (calculated from OC): ${K.maxPain}
CALL WALL: ${K.callWall} | PUT WALL: ${K.putWall}
ATM CE: ₹${K.atmCeP} | ATM PE: ₹${K.atmPeP} | Cost/lot: ₹${(K.atmCeP*65).toFixed(0)} | Lots affordable: ${atmAfford}
Next-week ATM CE: ₹${K.nxAtmCeP} | PE: ₹${K.nxAtmPeP}

OPTION CHAIN (OI_CHG = change from day open):
${K.ocTable}
KEY LEVELS: R2:${K.r2} R1:${K.r1} Pivot:${K.pivot} S1:${K.s1} S2:${K.s2}
Spot vs 20-DMA: ${K.spot>K.sma20?'ABOVE (bullish)':'BELOW (bearish)'}
Green days last 10: ${K.green10}/10
DATA FRESHNESS: ${K.isFresh?'🟢 FRESH':'🟡 DELAYED'} (last trade ${K.dataAgeMin}min ago)

INTRADAY 5-MIN (last 20 candles, from ${K.hist5mDate}):
${K.last20c||'N/A'}
DAILY (last 15 days):
${K.last15d||'N/A'}

═══ GLOBAL CUES (Yahoo Finance — pre-fetched) ═══
${gLine('S&P 500', G.sp500)}
${gLine('Dow Jones', G.dow)}
${gLine('Nasdaq', G.nas)}
${gLine('Nikkei 225', G.nikkei)}
${gLine('Hang Seng', G.hsi)}
${gLine('WTI Crude', G.crude)}
${gLine('Gold', G.gold)}
${gLine('USD/INR', G.usdInr)}
GIFT Nifty proxy: Use S&P 500 and Nikkei to estimate GIFT Nifty gap direction.

═══ NSE BREADTH (pre-fetched) ═══
Advances: ${NSE.advances} | Declines: ${NSE.declines} | Unchanged: ${NSE.unchanged}
${NSE.note||''}

═══ POSITIONS ═══
Open positions: ${K.posText}
Pending orders: ${K.ordText}
${K.error?`\n⚠️ Kite partial error: ${K.error}`:''}

═══ ANALYSIS INSTRUCTIONS ═══
Score ALL 10 factors using ONLY the data above. No web searching needed.
For FII/DII flows (F6): infer from BN direction, IT sector (FII proxy), PCR trend, and global cues.
For block deals (not available): note as "N/A — inferred from price action".

F1 VIX: <12=+2,12-15=0,15-20=-1,20-25=-2,>25=-3. Trend adjustment ±1.
F2 PCR/OI: Total PCR ${K.pcr}. Max Pain ${K.maxPain} vs spot ${K.spot}. Call Wall ${K.callWall}, Put Wall ${K.putWall}. OI buildup from table.
F3 Intraday: VWAP, ORH/ORL, momentum, institutional candles, H/L timing. Cap ±3.
F4 Daily: 20-DMA, 9/21 EMA cross, green days ${K.green10}/10, S/R, last candle. Cap ±3.
F5 Sectoral: BN vs Nifty, IT (FII proxy), Midcap, top heavyweights. Cap ±3.
F6 FII/DII: Infer from BN direction, IT performance, PCR, global cues. State inference clearly.
F7 Breadth: Advances ${NSE.advances}, Declines ${NSE.declines}. ADR = adv/dec ratio.
F8 Global: S&P ${G.sp500?.pct||'N/A'}%, Nikkei ${G.nikkei?.pct||'N/A'}%, HSI ${G.hsi?.pct||'N/A'}%, Crude $${G.crude?.price?.toFixed(1)||'N/A'}.
F9 IV/Greeks: VIX ${K.vix}, DTE ${K.expiry?.dte}, lot affordability, σ vs strike.
F10 Events: Infer from global cues, news context, upcoming RBI/Fed meetings.

HARD OVERRIDES:
1. Expiry day AND -5 to +5 → STAY OUT
2. VIX > 22 → STAY OUT
3. Major event within 24hrs → STAY OUT
4. LIVE_FUNDS < ATM × 65 → STAY OUT (₹${(K.liveF||0).toFixed(0)} vs ₹${((K.atmCeP||0)*65).toFixed(0)})
5. FII L/S < 0.2 AND PCR < 0.6 → STRONG PE
6. Both institutions selling + ADR < 0.5 → STAY OUT

EXTREME MOMENTUM OVERRIDE: F3=±3 AND F4≥±2 AND score≥±5 → upgrade LEAN to ENTRY.

VERDICT TABLE (LEAN = STAY OUT):
+12 to +30 → STRONG ENTRY CE | +6 to +11 → ENTRY CE | +2 to +5 → STAY OUT (LEAN)
-1 to +1 → STAY OUT | -5 to -2 → STAY OUT (LEAN) | -11 to -6 → ENTRY PE | -30 to -12 → STRONG ENTRY PE

AUTO-TRADE: Score ≥+8 ENTRY/STRONG → "AUTO-TRADE: YES — BUY CE [symbol]"
            Score ≤-8 ENTRY/STRONG → "AUTO-TRADE: YES — BUY PE [symbol]"
            Else → "AUTO-TRADE: NO — [reason]"

IVP SIZING: IVP<20 → full lots | IVP 20-70 → 75% | IVP>70 → 50%
SL: 50% of entry premium. State: "STOP-LOSS: ₹[X×0.5] trigger | Loss/lot: ₹[X×0.5×65]"

OUTPUT FORMAT:
═══════════════════════════════════════════════════════════
NIFTY ANALYSIS — ${todayDate} ${istStr}
DATA: 🔗 Kite + Yahoo Finance (no web search)
───────────────────────────────────────────────────────────
SPOT: Rs [X] │ VIX: [X] │ Expiry: [date] ([X] DTE)
Funds: Rs [X] │ ATM CE: Rs [X] │ Lots: [X] affordable
PCR: [X] │ Max Pain: Rs [X] │ VWAP: Rs [X]
Global: S&P [X]% │ Crude $[X] │ USD/INR [X]
Breadth: [X] adv / [X] dec │ ADR: [X]
σ Daily: ±[X]pts │ σ Weekly: ±[X]pts
───────────────────────────────────────────────────────────
SCORECARD:
  F1  VIX:         [+/-X] │ F2  PCR/OI:    [+/-X]
  F3  Intraday:    [+/-X] │ F4  Daily:     [+/-X]
  F5  Sectoral:    [+/-X] │ F6  FII/DII:   [+/-X]
  F7  Breadth:     [+/-X] │ F8  Global:    [+/-X]
  F9  IV/Greeks:   [+/-X] │ F10 Events:   [+/-X]
                            TOTAL: [+/-XX] / 30
───────────────────────────────────────────────────────────
VERDICT: [VERDICT]
Confidence: [High/Moderate/Low]
MOMENTUM OVERRIDE: [YES — CE/PE | NO]
AUTO-TRADE: [YES — BUY CE/PE NIFTY... | NO — reason]
IVP: [XX]% → LOTS: [X] of [Y]
───────────────────────────────────────────────────────────
QUICK SETUP (scalp, +15–20 pts):
  Symbol:     NIFTY[...]
  Premium:    Rs [X] | Cost/lot: Rs [X]
  ENTRY:      Rs [X]–Rs [X]
  STOP-LOSS:  Rs [X×0.5] (50%) | Loss/lot: Rs [X]
  TARGET:     Rs [X] (+80%) | Nifty Rs [X] | Profit/lot: Rs [X]
SWING SETUP (positional, +100 pts):
  Symbol:     NIFTY[...] (next-week if DTE≤2)
  Premium:    Rs [X] | Cost/lot: Rs [X]
  ENTRY:      Rs [X]–Rs [X]
  STOP-LOSS:  Rs [X×0.5] (50%) | Loss/lot: Rs [X]
  TARGET 1:   Rs [X] (+80%) | Nifty Rs [X]
  TARGET 2:   Rs [X] (+150%) | Nifty Rs [X]
───────────────────────────────────────────────────────────
KEY LEVELS: R2:[X] R1:[X] Pivot:[X] S1:[X] S2:[X]
TOP 3 REASONS: 1.[...] 2.[...] 3.[...]
TOP 2 RISKS: 1.[...] 2.[...]
═══════════════════════════════════════════════════════════
PHASE 8 — POSITION CHECK: [HOLD/EXIT/None + reasoning]
PHASE 9 — NEXT 30 MIN WATCH: [what] | LEAN→ENTRY trigger: [exact level]
═══════════════════════════════════════════════════════════
⚠️ 91% of retail F&O traders lost money FY2024-25 (SEBI). Not SEBI-registered advice.`;

  // ── SECTION 5: ANTHROPIC API (pure analysis — no web search tool) ──────────
  let analysisText='', inputTokens=0, outputTokens=0;
  try {
    const aRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body: JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens:4096,
        // NO tools — all data pre-fetched above. Saves ~70% token cost.
        messages:[{role:'user',content:prompt}]
      })
    });
    const aData = await aRes.json();
    if (!aRes.ok) throw new Error(aData?.error?.message||`Anthropic HTTP ${aRes.status}`);
    inputTokens  = aData.usage?.input_tokens||0;
    outputTokens = aData.usage?.output_tokens||0;
    analysisText = (aData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if (!analysisText) throw new Error('Empty response from Anthropic');
  } catch(e){
    return res.status(500).json({ error:'Analysis failed: '+e.message, kiteData:{spot:K.spot,vix:K.vix} });
  }

  // ── SECTION 6: PARSE RESPONSE ──────────────────────────────────────────────
  const fi=re=>{const m=analysisText.match(re);return m?parseInt(m[1]):0;};
  const ft=re=>{const m=analysisText.match(re);return m?m[1].trim():null;};

  const score       = fi(/TOTAL:\s*([+-]?\d+)/i);
  const verdict     = ft(/VERDICT:\s*([^\n\r]+)/i)||'STAY OUT';
  const autoTrade   = ft(/AUTO-TRADE:\s*([^\n\r]+)/i)||'NO';
  const momOverride = ft(/MOMENTUM OVERRIDE:\s*([^\n\r]+)/i)||'NO';
  const ivpVal      = fi(/IVP:\s*(\d+)%/i);
  const lotsStr     = ft(/IVP:.*?→\s*LOTS:\s*([^\n\r]+)/i)||'';
  const quickSymM   = analysisText.match(/QUICK SETUP[\s\S]*?Symbol:\s+(NIFTY\S+)/i);
  const quickSymbol = quickSymM?quickSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const quickEntryM = analysisText.match(/QUICK SETUP[\s\S]*?ENTRY:\s*Rs\s*([\d.]+)[–\-]Rs\s*([\d.]+)/i);
  const quickEntryL = quickEntryM?parseFloat(quickEntryM[1]):null;
  const quickEntryH = quickEntryM?parseFloat(quickEntryM[2]):null;
  const quickSlM    = analysisText.match(/QUICK SETUP[\s\S]*?STOP-LOSS:\s*Rs\s*([\d.]+)/i);
  const quickSl     = quickSlM?parseFloat(quickSlM[1]):null;
  const swingSymM   = analysisText.match(/SWING SETUP[\s\S]*?Symbol:\s+(NIFTY\S+)/i);
  const swingSymbol = swingSymM?swingSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const swingEntryM = analysisText.match(/SWING SETUP[\s\S]*?ENTRY:\s*Rs\s*([\d.]+)[–\-]Rs\s*([\d.]+)/i);
  const swingEntryL = swingEntryM?parseFloat(swingEntryM[1]):null;
  const swingEntryH = swingEntryM?parseFloat(swingEntryM[2]):null;
  const swingSlM    = analysisText.match(/SWING SETUP[\s\S]*?STOP-LOSS:\s*Rs\s*([\d.]+)/i);
  const swingSl     = swingSlM?parseFloat(swingSlM[1]):null;
  const scores = {
    f1:fi(/F1\s+VIX[^|]*\[?([+-]?\d+)\]?/i),   f2:fi(/F2\s+PCR[^|]*\[?([+-]?\d+)\]?/i),
    f3:fi(/F3\s+Intraday[^|]*\[?([+-]?\d+)\]?/i),f4:fi(/F4\s+Daily[^|]*\[?([+-]?\d+)\]?/i),
    f5:fi(/F5\s+Sectoral[^|]*\[?([+-]?\d+)\]?/i),f6:fi(/F6\s+FII[^|]*\[?([+-]?\d+)\]?/i),
    f7:fi(/F7\s+Breadth[^|]*\[?([+-]?\d+)\]?/i), f8:fi(/F8\s+Global[^|]*\[?([+-]?\d+)\]?/i),
    f9:fi(/F9\s+IV[^|]*\[?([+-]?\d+)\]?/i),      f10:fi(/F10\s+Events[^|]*\[?([+-]?\d+)\]?/i),
  };

  return res.json({
    score,verdict,autoTrade,momOverride,ivpVal,lotsStr,
    quickSymbol,quickEntryL,quickEntryH,quickSl,
    swingSymbol,swingEntryL,swingEntryH,swingSl,
    tradeSymbol:quickSymbol||swingSymbol,
    entryLow:quickEntryL,entryHigh:quickEntryH,
    scores,analysis:analysisText,
    globalData:{
      sp500:G.sp500,crude:G.crude,gold:G.gold,usdInr:G.usdInr,
      nikkei:G.nikkei,hsi:G.hsi,dow:G.dow,nas:G.nas
    },
    marketData:{
      spot:K.spot,vix:K.vix,bn:K.bn,liveF:K.liveF,
      atm:K.atm,expiry:K.expiry?.dateStr,dte:K.expiry?.dte,
      isExpiry:K.expiry?.isExpiry,vwap:K.vwap,sma20:K.sma20,
      ema9:K.ema9,ema21:K.ema21,pcr:K.pcr,maxPain:K.maxPain,
      callWall:K.callWall,putWall:K.putWall,
      atmCeP:K.atmCeP,atmPeP:K.atmPeP,nxAtmCeP:K.nxAtmCeP,nxAtmPeP:K.nxAtmPeP,
      orh:K.orh,orl:K.orl,sigma1d,sigma1w,
      r2:K.r2,r1:K.r1,pivot:K.pivot,s1:K.s1,s2:K.s2,
      dataAgeMin:K.dataAgeMin,isFresh:K.isFresh,
      isPreMarket:K.isPreMarket,isPostMarket:K.isPostMarket,hist5mDate:K.hist5mDate,
      nseAdv:NSE.advances,nseDec:NSE.declines,
      openPositions:K.openPos,
    },
    usage:{inputTokens,outputTokens},
    timestamp:istStr,sgt:sgtStr,
  });
}
