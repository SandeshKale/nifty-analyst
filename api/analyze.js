// api/analyze.js — Nifty Options Analyst v4
// 10-factor skill (-30/+30) | Dual verdict (Quick/Swing) | IVP modifier | Premium SL
// Auto-trade: ±8 threshold | LEAN → STAY OUT | Extreme momentum override

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
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getDay()];

  // ── Expiry calculator ──────────────────────────────────────────────────────
  function getExpiry(offsetWeeks = 0) {
    const d = new Date(ist);
    const day = d.getDay();
    let daysAhead = day <= 2 ? (2 - day) : (9 - day);
    if (day === 2) {
      const afterClose = d.getHours() > 15 || (d.getHours() === 15 && d.getMinutes() >= 30);
      daysAhead = afterClose ? 7 : 0;
    }
    daysAhead += offsetWeeks * 7;
    const exp = new Date(d.getTime() + daysAhead * 86400000);
    const yy = String(exp.getFullYear()).slice(2);
    const m  = ['1','2','3','4','5','6','7','8','9','A','B','C'][exp.getMonth()];
    const dd = String(exp.getDate()).padStart(2,'0');
    const dte = Math.max(0, Math.ceil((exp - ist) / 86400000));
    const isExpiry = day === 2 && dte === 0;
    return { dateStr: exp.toISOString().slice(0,10), yy, m, dd, dte, isExpiry };
  }

  const kSym = (exp, strike, type) => `NIFTY${exp.yy}${exp.m}${exp.dd}${strike}${type}`;

  function calcVWAP(candles) {
    if (!candles?.length) return 0;
    let tv = 0, v = 0;
    for (const c of candles) { const tp=(c[2]+c[3]+c[4])/3; tv+=tp*c[5]; v+=c[5]; }
    return v ? tv/v : 0;
  }
  function calcSMA(arr, n) {
    if (!arr?.length) return 0;
    const sl = arr.slice(-n); return sl.reduce((a,b)=>a+b,0)/sl.length;
  }
  function calcEMA(arr, n) {
    if (!arr || arr.length < n) return arr?.[arr.length-1] || 0;
    const k = 2/(n+1);
    let ema = arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
    for (let i=n; i<arr.length; i++) ema = arr[i]*k + ema*(1-k);
    return ema;
  }

  // ── FETCH ALL KITE DATA ────────────────────────────────────────────────────
  let K = { error: null };
  try {
    const enc = encodeURIComponent;
    const from5m  = `${todayDate} 09:15:00`;
    const toNow   = `${todayDate} ${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}:00`;
    const from30d = new Date(ist.getTime() - 31*86400000).toISOString().slice(0,10);

    const [qR,ltpR,margR,posR,ordR,h5R,hdR] = await Promise.allSettled([
      fetch(`https://api.kite.trade/quote?i=${enc('NSE:NIFTY 50')}`,{headers:kH}),
      fetch(`https://api.kite.trade/ltp?i=${enc('NSE:INDIA VIX')}&i=${enc('NSE:NIFTY BANK')}&i=${enc('NSE:NIFTY IT')}&i=${enc('NSE:NIFTY AUTO')}&i=${enc('NSE:NIFTY FIN SERVICE')}&i=${enc('NSE:NIFTY MIDCAP 100')}`,{headers:kH}),
      fetch(`https://api.kite.trade/user/margins`,{headers:kH}),
      fetch(`https://api.kite.trade/portfolio/positions`,{headers:kH}),
      fetch(`https://api.kite.trade/orders`,{headers:kH}),
      fetch(`https://api.kite.trade/instruments/historical/256265/5minute?from=${enc(from5m)}&to=${enc(toNow)}`,{headers:kH}),
      fetch(`https://api.kite.trade/instruments/historical/256265/day?from=${from30d}&to=${todayDate}`,{headers:kH}),
    ]);

    const pj = async r => r.status==='fulfilled' ? r.value.json().catch(()=>null) : null;
    const [qJ,ltpJ,margJ,posJ,ordJ,h5J,hdJ] = await Promise.all([qR,ltpR,margR,posR,ordR,h5R,hdR].map(pj));

    const nQ   = qJ?.data?.['NSE:NIFTY 50'];
    const spot = nQ?.last_price || 0;
    const prevCl = nQ?.ohlc?.close || spot;
    const chg    = spot - prevCl;
    const liveF  = margJ?.data?.equity?.available?.cash ?? margJ?.data?.equity?.net ?? 0;

    const c5m  = h5J?.data?.candles || [];
    const cDay = hdJ?.data?.candles  || [];
    const vwap  = calcVWAP(c5m);
    const cl30  = cDay.map(c=>c[4]);
    const sma20 = calcSMA(cl30,20);
    const ema9  = calcEMA(cl30,9);
    const ema21 = calcEMA(cl30,21);

    const expiry   = getExpiry(0);
    const expiryNx = getExpiry(1);
    const atm = Math.round(spot/50)*50;

    // Opening range (first 3 five-min candles)
    const orC = c5m.slice(0,3);
    const orh = orC.length ? Math.max(...orC.map(c=>c[2])) : 0;
    const orl = orC.length ? Math.min(...orC.map(c=>c[3])) : 0;

    const dayH = nQ?.ohlc?.high || 0;
    const dayL = nQ?.ohlc?.low  || 0;
    const dayO = nQ?.ohlc?.open || 0;

    const highIdx = c5m.findIndex(c=>c[2]===dayH);
    const lowIdx  = c5m.findIndex(c=>c[3]===dayL);
    const htiming = highIdx<=6?'FIRST 30MIN':highIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY';
    const ltiming = lowIdx<=6?'FIRST 30MIN':lowIdx>=c5m.length-6?'LAST 30MIN':'MIDDAY';

    const last5 = c5m.slice(-5);
    const momDesc = last5.length>=3 ? (()=>{
      const hhs = last5.every((c,i)=>i===0||c[2]>=last5[i-1][2]);
      const lls = last5.every((c,i)=>i===0||c[3]<=last5[i-1][3]);
      return hhs?'BULLISH HH/HL':lls?'BEARISH LL/LH':'MIXED';
    })() : 'Insufficient data';

    // Institutional candles (>80pt range)
    const instC = c5m.filter(c=>(c[2]-c[3])>80);
    const instDesc = instC.length
      ? `${instC.length} candle(s). Last: ${instC[instC.length-1][4]>instC[instC.length-1][1]?'BULLISH':'BEARISH'} @ ${instC[instC.length-1][0].slice(11,16)}`
      : 'None today';

    const last10d    = cDay.slice(-10);
    const greenDays  = last10d.filter(c=>c[4]>=c[1]).length;
    const highs30    = cDay.slice(-30).map(c=>c[2]);
    const lows30     = cDay.slice(-30).map(c=>c[3]);
    const r2 = highs30.length?Math.max(...highs30):0;
    const s2 = lows30.length?Math.min(...lows30):0;
    const highs10 = cDay.slice(-10).map(c=>c[2]);
    const lows10  = cDay.slice(-10).map(c=>c[3]);
    const r1 = highs10.length?Math.max(...highs10):0;
    const s1 = lows10.length?Math.min(...lows10):0;
    const prevDay = cDay[cDay.length-1];
    const pivot = prevDay?((prevDay[2]+prevDay[3]+prevDay[4])/3).toFixed(2):0;

    // Option chain: current + next week
    const ceS = [atm,atm+50,atm+100,atm+150,atm+200,atm+300,atm+500];
    const peS = [atm,atm-50,atm-100,atm-150,atm-200,atm-300,atm-500];
    const curSyms = [...ceS.map(s=>`NFO:${kSym(expiry,s,'CE')}`), ...peS.map(s=>`NFO:${kSym(expiry,s,'PE')}`)];
    const nxSyms  = [atm,atm+50,atm+100,atm-50,atm-100].flatMap(s=>[`NFO:${kSym(expiryNx,s,'CE')}`,`NFO:${kSym(expiryNx,s,'PE')}`]);

    const [ocRes,nxRes] = await Promise.all([
      fetch(`https://api.kite.trade/quote?${curSyms.map(s=>`i=${enc(s)}`).join('&')}`,{headers:kH}).catch(()=>null),
      fetch(`https://api.kite.trade/quote?${nxSyms.map(s=>`i=${enc(s)}`).join('&')}`,{headers:kH}).catch(()=>null),
    ]);
    const ocData  = (ocRes?await ocRes.json().catch(()=>null):null)?.data||{};
    const nxData  = (nxRes?await nxRes.json().catch(()=>null):null)?.data||{};

    let ocTable = 'Strike | CE_LTP | CE_OI      | OI_CHG   | PE_LTP | PE_OI      | OI_CHG\n';
    ocTable    += '-------|--------|------------|----------|--------|------------|----------\n';
    let totCeOI=0,totPeOI=0,maxCeOI=0,maxPeOI=0,callWall=atm,putWall=atm;
    const allSorted = [...new Set([...ceS,...peS])].sort((a,b)=>b-a);
    for (const st of allSorted) {
      const ce = ocData[`NFO:${kSym(expiry,st,'CE')}`];
      const pe = ocData[`NFO:${kSym(expiry,st,'PE')}`];
      if (ce){totCeOI+=ce.oi||0; if((ce.oi||0)>maxCeOI){maxCeOI=ce.oi||0;callWall=st;}}
      if (pe){totPeOI+=pe.oi||0; if((pe.oi||0)>maxPeOI){maxPeOI=pe.oi||0;putWall=st;}}
      const ceChg = ce?(ce.oi||0)-(ce.oi_day_low||ce.oi||0):0;
      const peChg = pe?(pe.oi||0)-(pe.oi_day_low||pe.oi||0):0;
      const fc = n=>(n>=0?'+':'')+String(n).padStart(8);
      ocTable+=`${String(st).padStart(6)} | ${String((ce?.last_price||0).toFixed(0)).padStart(6)} | ${String(ce?.oi||0).padStart(10)} | ${fc(ceChg)} | ${String((pe?.last_price||0).toFixed(0)).padStart(6)} | ${String(pe?.oi||0).padStart(10)} | ${fc(peChg)}\n`;
    }
    const pcr = totCeOI>0?(totPeOI/totCeOI).toFixed(3):'0';
    const atmCeP  = ocData[`NFO:${kSym(expiry,atm,'CE')}`]?.last_price||0;
    const atmPeP  = ocData[`NFO:${kSym(expiry,atm,'PE')}`]?.last_price||0;
    const nxAtmCeP = nxData[`NFO:${kSym(expiryNx,atm,'CE')}`]?.last_price||0;
    const nxAtmPeP = nxData[`NFO:${kSym(expiryNx,atm,'PE')}`]?.last_price||0;
    const maxAfford = liveF>0?(liveF/65).toFixed(2):'0';

    // Data freshness
    const lastTradeTime = qJ?.data?.['NSE:NIFTY 50']?.last_trade_time;
    const dataAgeMin = lastTradeTime?Math.round((ist-new Date(lastTradeTime))/60000):999;

    // Positions & orders
    const openPos = (posJ?.data?.net||[]).filter(p=>p.quantity!==0);
    const posText = openPos.length
      ? openPos.map(p=>`${p.tradingsymbol}: Qty ${p.quantity}, Avg ₹${(p.average_price||0).toFixed(2)}, LTP ₹${(p.last_price||0).toFixed(2)}, P&L ₹${(p.pnl||0).toFixed(2)}`).join('\n')
      : 'None';
    const pendOrds = (ordJ?.data||[]).filter(o=>['OPEN','TRIGGER PENDING'].includes(o.status));
    const ordText  = pendOrds.length?pendOrds.map(o=>`${o.tradingsymbol}: ${o.transaction_type} ${o.quantity}@${o.price}`).join('\n'):'None';

    const last20c = c5m.slice(-20).map(c=>`[${c[0].slice(11,16)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');
    const last15d = cDay.slice(-15).map(c=>`[${c[0].slice(0,10)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');

    K = {
      spot,chg,prevCl,dayH,dayL,dayO,volume:nQ?.volume||0,
      vix:ltpJ?.data?.['NSE:INDIA VIX']?.last_price,
      bn:ltpJ?.data?.['NSE:NIFTY BANK']?.last_price,
      niftyIT:ltpJ?.data?.['NSE:NIFTY IT']?.last_price,
      niftyAuto:ltpJ?.data?.['NSE:NIFTY AUTO']?.last_price,
      niftyFin:ltpJ?.data?.['NSE:NIFTY FIN SERVICE']?.last_price,
      niftyMid:ltpJ?.data?.['NSE:NIFTY MIDCAP 100']?.last_price,
      liveF,atm,expiry,expiryNx,
      vwap:vwap.toFixed(2),sma20:sma20.toFixed(2),ema9:ema9.toFixed(2),ema21:ema21.toFixed(2),
      orh:orh.toFixed(2),orl:orl.toFixed(2),htiming,ltiming,momDesc,instDesc,
      greenDays,r2:r2.toFixed(0),r1:r1.toFixed(0),s1:s1.toFixed(0),s2:s2.toFixed(0),pivot,
      pcr,callWall,putWall,atmCeP,atmPeP,nxAtmCeP,nxAtmPeP,maxAfford,
      dataAgeMin,isFresh:dataAgeMin<5,
      ocTable,posText,ordText,openPos,last20c,last15d,
    };
  } catch(e) {
    K.error = e.message;
    console.error('Kite error:', e.message);
  }

  // ── BUILD PROMPT ────────────────────────────────────────────────────────────
  const vix = K.vix||0;
  const sigma1d = K.spot&&vix?(K.spot*(vix/100)/Math.sqrt(252)).toFixed(0):'—';
  const sigma1w = K.spot&&vix?(K.spot*(vix/100)/Math.sqrt(52)).toFixed(0):'—';
  const atmCeAfford = K.liveF&&K.atmCeP?Math.floor(K.liveF/(K.atmCeP*65))||0:0;

  const prompt = `You are a seasoned Nifty 50 F&O analyst (15+ years). Run the full nifty-options-analyst skill v4.

TIME: ${istStr} / ${sgtStr} | ${dayName} ${todayDate}

═══ CONSTANTS ═══
Lot size: 65 | Expiry day: TUESDAY | LIVE_FUNDS: ₹${(K.liveF||0).toFixed(0)}
Max affordable premium per unit: ₹${K.maxAfford} (funds ÷ 65)
Auto-trade threshold: ±8 (ENTRY zone only — LEAN is STAY OUT)
STOP-LOSS RULE: 50% of entry premium (not fixed ₹2,000)
Data freshness: ${K.isFresh?'🟢 FRESH':'🔴 STALE'} (Kite last trade: ${K.dataAgeMin}min ago)

═══ KITE LIVE DATA ═══
NIFTY 50: ${K.spot} | Chg: ${K.chg>=0?'+':''}${K.chg?.toFixed(2)} from prev close ${K.prevCl}
Day: O:${K.dayO} H:${K.dayH} L:${K.dayL} | Volume: ${K.volume}
VWAP: ${K.vwap} | 20-DMA: ${K.sma20} | 9-EMA: ${K.ema9} | 21-EMA: ${K.ema21}
EMA Cross: 9-EMA ${K.ema9>K.ema21?'ABOVE (bullish)':'BELOW (bearish)'} 21-EMA by ${Math.abs(K.ema9-K.ema21).toFixed(2)} pts

Opening Range: H=${K.orh} L=${K.orl} | vs ORH: ${K.spot>K.orh?'ABOVE (bullish)':K.spot<K.orl?'BELOW (bearish)':'INSIDE RANGE'}
Day H timing: ${K.htiming} | Day L timing: ${K.ltiming}
Last 5-candle momentum: ${K.momDesc}
Institutional candles (>80pt range): ${K.instDesc}

INDIA VIX: ${K.vix} | 1σ daily: ±${sigma1d}pts | 1σ weekly: ±${sigma1w}pts
BANK NIFTY: ${K.bn} | IT: ${K.niftyIT} | AUTO: ${K.niftyAuto} | FIN SVC: ${K.niftyFin} | MIDCAP: ${K.niftyMid}

EXPIRY: ${K.expiry?.dateStr} (DTE: ${K.expiry?.dte}) | EXPIRY DAY: ${K.expiry?.isExpiry?'YES — GAMMA RISK':'NO'}
NEXT EXPIRY: ${K.expiryNx?.dateStr} (DTE: ${K.expiryNx?.dte})
ATM: ${K.atm} | PCR: ${K.pcr} | Call Wall: ${K.callWall} | Put Wall: ${K.putWall}
ATM CE: ₹${K.atmCeP} | ATM PE: ₹${K.atmPeP} | Cost/lot CE: ₹${(K.atmCeP*65).toFixed(0)} | Affordable lots: ${atmCeAfford}
Next-week ATM CE: ₹${K.nxAtmCeP} | Next-week ATM PE: ₹${K.nxAtmPeP}

OPTION CHAIN (current week, OI_CHG = change from day open):
${K.ocTable}
KEY LEVELS: R2=${K.r2} | R1=${K.r1} | Pivot=${K.pivot} | S1=${K.s1} | S2=${K.s2}
Spot vs 20-DMA: ${K.spot>K.sma20?'ABOVE':'BELOW'} | Green days last 10: ${K.greenDays}/10

INTRADAY 5-MIN (last 20 candles):
${K.last20c||'N/A'}
DAILY (last 15 days):
${K.last15d||'N/A'}

OPEN POSITIONS: ${K.posText}
PENDING ORDERS: ${K.ordText}
${K.error?`\n⚠️ Kite Warning: ${K.error}`:''}

═══ RUN PHASES 4-9 ═══

PHASE 4 — Run ALL 8 web searches NOW:
4A: "FII DII provisional data NSE ${todayDate}"
4B: "FII participant wise OI index futures long short ratio ${todayDate}"
4C: "GIFT Nifty live today" AND "S&P 500 Nasdaq Dow ${todayDate}"
4D: "India market news today ${todayDate}" AND "RBI FOMC upcoming 2026"
4E: "NSE block deals bulk deals ${todayDate}"
4F: "NSE advance decline ratio breadth ${todayDate}"
4G: "Reliance HDFC Bank ICICI Infosys Bharti performance today"
4H: "Nifty PCR put call ratio max pain IVR IVP ${todayDate} niftytrader sensibull"

PHASE 5 — Score ALL 10 factors (-3 to +3 each):

F1 VIX: <12=+2,12-15=0,15-20=-1,20-25=-2,>25=-3. PLUS trend adjustment (VIX falling=+1,rising=-1).
F2 PCR/OI: (a)Total PCR score. (b)COI PCR from niftytrader. (c)OI buildup/unwinding at walls. (d)Max Pain pull.
F3 Intraday: (a)VWAP. (b)ORH/ORL break with volume=±2. (c)Momentum. (d)Inst candles. (e)H/L timing. Cap ±3.
F4 Daily: (a)20-DMA. (b)9/21 EMA cross. (c)Green days. (d)S/R. (e)Last daily candle pattern. Cap ±3.
F5 Sectoral: (a)BN vs Nifty. (b)IT as FII proxy. (c)Midcap vs Nifty. (d)Top-5 heavyweights. Cap ±3.
F6 FII/DII: Cash flows (4A) + F&O L/S ratio (4B). Both buying=+3, both selling=-3.
F7 Breadth: ADR and advance/decline counts. ≥40 adv+ADR>1.5=+3, <10+ADR<0.5=-3.
F8 Global: S&P, Asia, GIFT Nifty, crude, DXY. Cap ±3.
F9 IV/Greeks: VIX environment + IVR/IVP from 4H. State IVP explicitly.
  IVP: <20=+2 (cheap options, favour buyers), 20-50=+1, 50-70=0, 70-85=-1, >85=-2 (expensive, small size)
  Also: lot affordability, ATM distance vs sigma, DTE theta impact.
F10 Events: No event=+1, major today=-3, in 1-2 days=-2, positive surprise=+2, geopolitical=-2.

HARD OVERRIDES (force STAY OUT if any triggered):
1. Expiry day AND score -5 to +5 → STAY OUT
2. VIX > 22 → STAY OUT buying
3. Major event within 24hrs → STAY OUT
4. LIVE_FUNDS < ATM_premium × 65 → STAY OUT (check: ₹${(K.liveF||0).toFixed(0)} vs ₹${((K.atmCeP||0)*65).toFixed(0)})
5. FII L/S < 0.2 AND PCR < 0.6 → STRONG PE override
6. Both FII+DII selling + ADR < 0.5 → STAY OUT

EXTREME MOMENTUM OVERRIDE (allows LEAN→ENTRY upgrade):
If F3 = +3 (extreme bullish intraday) AND F4 ≥ +2 AND score ≥ +5 → upgrade to ENTRY CE
If F3 = -3 (extreme bearish intraday) AND F4 ≤ -2 AND score ≤ -5 → upgrade to ENTRY PE
State: "MOMENTUM OVERRIDE: YES — [CE/PE]" if triggered, else "MOMENTUM OVERRIDE: NO"

VERDICT TABLE (LEAN = STAY OUT — do NOT trade LEAN):
+12 to +30 → STRONG ENTRY CE
+6  to +11 → ENTRY CE
+2  to +5  → STAY OUT (LEAN CE — not tradeable)
-1  to +1  → STAY OUT
-5  to -2  → STAY OUT (LEAN PE — not tradeable)
-11 to -6  → ENTRY PE
-30 to -12 → STRONG ENTRY PE

AUTO-TRADE CHECK (threshold ±8):
Score ≥+8 AND verdict is ENTRY/STRONG ENTRY CE AND no overrides → "AUTO-TRADE: YES — BUY CE [symbol]"
Score ≤-8 AND verdict is ENTRY/STRONG ENTRY PE AND no overrides → "AUTO-TRADE: YES — BUY PE [symbol]"
Otherwise → "AUTO-TRADE: NO — [reason]"

IVP POSITION SIZING:
If IVP < 20: trade full affordable lots (options cheap)
If IVP 20-70: trade 75% of affordable lots
If IVP > 70: trade 50% of affordable lots (options expensive, reduce risk)
State: "IVP: XX% → LOTS: X of Y affordable"

STOP-LOSS CALCULATION (50% of entry premium):
Entry premium: ₹X → SL trigger: ₹X × 0.50 → Loss per lot: ₹(X×0.50×65)
State explicitly: "STOP-LOSS: ₹[X×0.5] premium trigger | Loss/lot: ₹[X×0.5×65]"

═══ OUTPUT FORMAT (print exactly) ═══

═══════════════════════════════════════════════════════════
NIFTY ANALYSIS — ${todayDate} ${istStr}
DATA: 🔗 Kite REST API + Web Search${K.isFresh?'':' ⚠️ STALE'}
───────────────────────────────────────────────────────────
SPOT: Rs [X] │ VIX: [X] │ Expiry: [date] ([X] DTE)
Funds: Rs [X] │ ATM CE: Rs [X] │ Affordable: [X] lots
IVP: [X]% │ VWAP: Rs [X] │ PCR: [X]
1σ Daily: ±[X]pts │ 1σ Weekly: ±[X]pts
───────────────────────────────────────────────────────────
SCORECARD:
  F1  VIX:         [+/-X] │ F2  PCR/OI:    [+/-X]
  F3  Intraday:    [+/-X] │ F4  Daily:     [+/-X]
  F5  Sectoral:    [+/-X] │ F6  FII/DII:   [+/-X]
  F7  Breadth:     [+/-X] │ F8  Global:    [+/-X]
  F9  IV/Greeks:   [+/-X] │ F10 Events:   [+/-X]
                            TOTAL: [+/-XX] / 30
───────────────────────────────────────────────────────────
VERDICT: [VERDICT — must be STRONG ENTRY CE/PE, ENTRY CE/PE, or STAY OUT only]
Confidence: [High/Moderate/Low]
MOMENTUM OVERRIDE: [YES — CE/PE | NO]
AUTO-TRADE: [YES — BUY CE/PE NIFTY... | NO — reason]
IVP: [XX]% → LOTS: [X] of [Y] affordable
───────────────────────────────────────────────────────────
QUICK SETUP (scalp, +15–20 Nifty pts):
  Symbol:     NIFTY[...] (ATM or 1 strike OTM)
  Premium:    Rs [X] | Cost/lot: Rs [X]
  ENTRY:      Rs [X]–Rs [X]
  STOP-LOSS:  Rs [X×0.5] premium (50%) | Nifty Rs [X] | Loss/lot: Rs [X]
  TARGET:     Rs [X] (+80%) | Nifty Rs [X] | +[X]pts | Profit/lot: Rs [X]
  TIME LIMIT: Exit within 45 min if no progress
SWING SETUP (positional, +100 Nifty pts):
  Symbol:     NIFTY[...] (use next-week expiry if DTE ≤ 2)
  Premium:    Rs [X] | Cost/lot: Rs [X]
  ENTRY:      Rs [X]–Rs [X]
  STOP-LOSS:  Rs [X×0.5] premium (50%) | Nifty Rs [X] | Loss/lot: Rs [X]
  TARGET 1:   Rs [X] (+80%) | Nifty Rs [X] | +[X]pts | Profit/lot: Rs [X]
  TARGET 2:   Rs [X] (+150%) | Nifty Rs [X] | +[X]pts | Profit/lot: Rs [X]
  TRAIL:      After T1 hit, trail SL to entry cost
───────────────────────────────────────────────────────────
KEY LEVELS: R2:[X] │ R1:[X] │ Pivot:[X] │ S1:[X] │ S2:[X]
CALL WALL: [X] │ PUT WALL: [X] │ MAX PAIN: [X]
TOP 3 REASONS: 1.[...] 2.[...] 3.[...]
TOP 2 RISKS: 1.[...] 2.[...]
EXIT RULES:
  □ Premium drops 50% → exit immediately (hard stop)
  □ Nifty breaks key S/R with volume against you
  □ VIX spikes >3 pts suddenly
  □ Spot moves your way but premium flat → IV crush → exit
  □ Exit all by 3:20 PM on expiry day
  □ Never average down on a losing option
═══════════════════════════════════════════════════════════
PHASE 8 — POSITION CHECK: [HOLD/EXIT/None — with P&L and reasoning]
PHASE 9 — NEXT 30 MIN WATCH: [what to watch] | LEAN→ENTRY trigger: [exact level]
═══════════════════════════════════════════════════════════
⚠️ 91% of retail F&O traders lost money FY2024-25 (SEBI). Not SEBI-registered advice.`;

  // ── CALL ANTHROPIC ─────────────────────────────────────────────────────────
  let analysisText='', inputTokens=0, outputTokens=0;
  try {
    const aRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body: JSON.stringify({
        model:'claude-sonnet-4-6', max_tokens:8000,
        tools:[{type:'web_search_20250305',name:'web_search'}],
        messages:[{role:'user',content:prompt}]
      })
    });
    const aData = await aRes.json();
    if (!aRes.ok) throw new Error(aData?.error?.message||`Anthropic HTTP ${aRes.status}`);
    inputTokens  = aData.usage?.input_tokens||0;
    outputTokens = aData.usage?.output_tokens||0;
    analysisText = (aData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if (!analysisText) throw new Error('Empty analysis from Anthropic');
  } catch(e) {
    return res.status(500).json({ error:'Analysis failed: '+e.message });
  }

  // ── PARSE RESPONSE ─────────────────────────────────────────────────────────
  const fi = re => { const m=analysisText.match(re); return m?parseInt(m[1]):0; };
  const fs = re => { const m=analysisText.match(re); return m?parseFloat(m[1]):null; };
  const ft = re => { const m=analysisText.match(re); return m?m[1].trim():null; };

  const score        = fi(/TOTAL:\s*([+-]?\d+)/i);
  const verdict      = ft(/VERDICT:\s*([^\n\r]+)/i) || 'STAY OUT';
  const autoTrade    = ft(/AUTO-TRADE:\s*([^\n\r]+)/i) || 'NO';
  const momOverride  = ft(/MOMENTUM OVERRIDE:\s*([^\n\r]+)/i) || 'NO';
  const ivpVal       = fi(/IVP:\s*(\d+)%/i);
  const lotsStr      = ft(/IVP:.*?→\s*LOTS:\s*([^\n\r]+)/i) || '';

  // Quick setup
  const quickSymM    = analysisText.match(/QUICK SETUP[\s\S]*?Symbol:\s+(NIFTY\S+)/i);
  const quickSymbol  = quickSymM?quickSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const quickEntryM  = analysisText.match(/QUICK SETUP[\s\S]*?ENTRY:\s*Rs\s*([\d.]+)[–\-]Rs\s*([\d.]+)/i);
  const quickEntryL  = quickEntryM?parseFloat(quickEntryM[1]):null;
  const quickEntryH  = quickEntryM?parseFloat(quickEntryM[2]):null;
  const quickSlM     = analysisText.match(/QUICK SETUP[\s\S]*?STOP-LOSS:\s*Rs\s*([\d.]+)/i);
  const quickSl      = quickSlM?parseFloat(quickSlM[1]):null;

  // Swing setup
  const swingSymM    = analysisText.match(/SWING SETUP[\s\S]*?Symbol:\s+(NIFTY\S+)/i);
  const swingSymbol  = swingSymM?swingSymM[1].replace(/[^A-Z0-9]/g,''):null;
  const swingEntryM  = analysisText.match(/SWING SETUP[\s\S]*?ENTRY:\s*Rs\s*([\d.]+)[–\-]Rs\s*([\d.]+)/i);
  const swingEntryL  = swingEntryM?parseFloat(swingEntryM[1]):null;
  const swingEntryH  = swingEntryM?parseFloat(swingEntryM[2]):null;
  const swingSlM     = analysisText.match(/SWING SETUP[\s\S]*?STOP-LOSS:\s*Rs\s*([\d.]+)/i);
  const swingSl      = swingSlM?parseFloat(swingSlM[1]):null;

  const scores = {
    f1: fi(/F1\s+VIX[^|]*\[?([+-]?\d+)\]?/i),
    f2: fi(/F2\s+PCR[^|]*\[?([+-]?\d+)\]?/i),
    f3: fi(/F3\s+Intraday[^|]*\[?([+-]?\d+)\]?/i),
    f4: fi(/F4\s+Daily[^|]*\[?([+-]?\d+)\]?/i),
    f5: fi(/F5\s+Sectoral[^|]*\[?([+-]?\d+)\]?/i),
    f6: fi(/F6\s+FII[^|]*\[?([+-]?\d+)\]?/i),
    f7: fi(/F7\s+Breadth[^|]*\[?([+-]?\d+)\]?/i),
    f8: fi(/F8\s+Global[^|]*\[?([+-]?\d+)\]?/i),
    f9: fi(/F9\s+IV[^|]*\[?([+-]?\d+)\]?/i),
    f10:fi(/F10\s+Events[^|]*\[?([+-]?\d+)\]?/i),
  };

  return res.json({
    score, verdict, autoTrade, momOverride, ivpVal, lotsStr,
    quickSymbol, quickEntryL, quickEntryH, quickSl,
    swingSymbol, swingEntryL, swingEntryH, swingSl,
    // legacy fields for backward compat
    tradeSymbol: quickSymbol||swingSymbol,
    entryLow: quickEntryL, entryHigh: quickEntryH,
    scores, analysis: analysisText,
    marketData:{
      spot:K.spot, vix:K.vix, bn:K.bn, liveF:K.liveF,
      atm:K.atm, expiry:K.expiry?.dateStr, dte:K.expiry?.dte,
      isExpiry:K.expiry?.isExpiry, vwap:K.vwap, sma20:K.sma20,
      ema9:K.ema9, ema21:K.ema21, pcr:K.pcr,
      callWall:K.callWall, putWall:K.putWall,
      atmCeP:K.atmCeP, atmPeP:K.atmPeP,
      nxAtmCeP:K.nxAtmCeP, nxAtmPeP:K.nxAtmPeP,
      orh:K.orh, orl:K.orl, sigma1d, sigma1w,
      r2:K.r2, r1:K.r1, pivot:K.pivot, s1:K.s1, s2:K.s2,
      dataAgeMin:K.dataAgeMin, isFresh:K.isFresh,
      openPositions:K.openPos,
    },
    usage:{inputTokens,outputTokens},
    timestamp:istStr, sgt:sgtStr,
  });
}
