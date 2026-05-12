// api/analyze.js — Nifty Options Analyst (10-factor skill, -30 to +30)
// Kite REST API + Anthropic claude-sonnet-4-6 + web_search
// Auto-trade: score ≥+10 (CE) or ≤-10 (PE) | Stop: ₹2,000/trade

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
  const istStr = ist.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
  const sgtStr = new Date(now.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' SGT';
  const todayDate = ist.toISOString().slice(0, 10);
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getDay()];

  // ── Expiry calculator ──────────────────────────────────────────────────────
  function getExpiry() {
    const d = new Date(ist);
    const day = d.getDay();
    let daysAhead = day <= 2 ? (2 - day) : (9 - day);
    if (day === 2) {
      const afterClose = d.getHours() > 15 || (d.getHours() === 15 && d.getMinutes() >= 30);
      daysAhead = afterClose ? 7 : 0;
    }
    const exp = new Date(d.getTime() + daysAhead * 86400000);
    const yy = String(exp.getFullYear()).slice(2);
    const m  = ['1','2','3','4','5','6','7','8','9','A','B','C'][exp.getMonth()];
    const dd = String(exp.getDate()).padStart(2, '0');
    const dte = Math.max(0, Math.ceil((exp - ist) / 86400000));
    const isExpiry = day === 2 && !((d.getHours() > 15 || (d.getHours() === 15 && d.getMinutes() >= 30)));
    return { dateStr: exp.toISOString().slice(0, 10), yy, m, dd, dte, isExpiry };
  }

  function kSym(exp, strike, type) {
    return `NIFTY${exp.yy}${exp.m}${exp.dd}${strike}${type}`;
  }

  function calcVWAP(candles) {
    if (!candles?.length) return 0;
    let tv = 0, v = 0;
    for (const c of candles) { const tp = (c[2]+c[3]+c[4])/3; tv += tp*c[5]; v += c[5]; }
    return v ? tv/v : 0;
  }

  function calcSMA(arr, n) {
    if (!arr?.length) return 0;
    const sl = arr.slice(-n);
    return sl.reduce((a,b)=>a+b,0)/sl.length;
  }

  function calcEMA(arr, n) {
    if (!arr || arr.length < n) return arr?.[arr.length-1] || 0;
    const k = 2/(n+1);
    let ema = arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
    for (let i = n; i < arr.length; i++) ema = arr[i]*k + ema*(1-k);
    return ema;
  }

  // ── FETCH ALL KITE DATA ────────────────────────────────────────────────────
  let K = { error: null };
  try {
    const enc = encodeURIComponent;
    const from5m  = `${todayDate} 09:15:00`;
    const toNow   = `${todayDate} ${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}:00`;
    const from30d = new Date(ist.getTime() - 31*86400000).toISOString().slice(0,10);

    const [qR, ltpR, margR, posR, ordR, h5R, hdR] = await Promise.allSettled([
      fetch(`https://api.kite.trade/quote?i=${enc('NSE:NIFTY 50')}`, { headers: kH }),
      fetch(`https://api.kite.trade/ltp?i=${enc('NSE:INDIA VIX')}&i=${enc('NSE:NIFTY BANK')}&i=${enc('NSE:NIFTY IT')}&i=${enc('NSE:NIFTY AUTO')}&i=${enc('NSE:NIFTY FIN SERVICE')}&i=${enc('NSE:NIFTY MIDCAP 100')}`, { headers: kH }),
      fetch(`https://api.kite.trade/user/margins`, { headers: kH }),
      fetch(`https://api.kite.trade/portfolio/positions`, { headers: kH }),
      fetch(`https://api.kite.trade/orders`, { headers: kH }),
      fetch(`https://api.kite.trade/instruments/historical/256265/5minute?from=${enc(from5m)}&to=${enc(toNow)}`, { headers: kH }),
      fetch(`https://api.kite.trade/instruments/historical/256265/day?from=${from30d}&to=${todayDate}`, { headers: kH }),
    ]);

    const pj = async r => r.status==='fulfilled' ? r.value.json().catch(()=>null) : null;
    const [qJ, ltpJ, margJ, posJ, ordJ, h5J, hdJ] = await Promise.all([qR,ltpR,margR,posR,ordR,h5R,hdR].map(pj));

    const nQ = qJ?.data?.['NSE:NIFTY 50'];
    const spot   = nQ?.last_price || 0;
    const prevCl = nQ?.ohlc?.close || spot;
    const chg    = spot - prevCl;
    const liveF  = margJ?.data?.equity?.available?.cash ?? margJ?.data?.equity?.net ?? 0;

    const c5m  = h5J?.data?.candles || [];
    const cDay = hdJ?.data?.candles  || [];
    const vwap = calcVWAP(c5m);
    const cl30 = cDay.map(c=>c[4]);
    const sma20 = calcSMA(cl30, 20);
    const ema9  = calcEMA(cl30, 9);
    const ema21 = calcEMA(cl30, 21);

    const expiry = getExpiry();
    const atm    = Math.round(spot/50)*50;

    // Opening range from first 3 candles
    const orCandles = c5m.slice(0,3);
    const orh = orCandles.length ? Math.max(...orCandles.map(c=>c[2])) : 0;
    const orl = orCandles.length ? Math.min(...orCandles.map(c=>c[3])) : 0;

    // Day high/low timing
    const dayH = nQ?.ohlc?.high || 0;
    const dayL = nQ?.ohlc?.low  || 0;
    const dayO = nQ?.ohlc?.open || 0;
    const highIdx = c5m.findIndex(c=>c[2]===dayH);
    const lowIdx  = c5m.findIndex(c=>c[3]===dayL);
    const highTiming = highIdx <= 6 ? 'FIRST 30MIN' : highIdx >= c5m.length-6 ? 'LAST 30MIN' : 'MIDDAY';
    const lowTiming  = lowIdx  <= 6 ? 'FIRST 30MIN' : lowIdx  >= c5m.length-6 ? 'LAST 30MIN' : 'MIDDAY';

    // Last 5 candles for momentum
    const last5 = c5m.slice(-5);
    const momDesc = last5.length>=3 ? (() => {
      const hhs = last5.every((c,i) => i===0 || c[2] >= last5[i-1][2]);
      const lls = last5.every((c,i) => i===0 || c[3] <= last5[i-1][3]);
      return hhs ? 'BULLISH HH/HL momentum' : lls ? 'BEARISH LL/LH momentum' : 'MIXED/SIDEWAYS';
    })() : 'Insufficient candles';

    // Green/red days last 10
    const last10d = cDay.slice(-10);
    const greenDays = last10d.filter(c=>c[4]>=c[1]).length;

    // 30-day high/low
    const highs30 = cDay.slice(-30).map(c=>c[2]);
    const lows30  = cDay.slice(-30).map(c=>c[3]);
    const r2 = highs30.length ? Math.max(...highs30) : 0;
    const s2 = lows30.length  ? Math.min(...lows30)  : 0;
    // Swing high/low last 10
    const highs10 = cDay.slice(-10).map(c=>c[2]);
    const lows10  = cDay.slice(-10).map(c=>c[3]);
    const r1 = highs10.length ? Math.max(...highs10) : 0;
    const s1 = lows10.length  ? Math.min(...lows10)  : 0;
    const prevDay = cDay[cDay.length-1];
    const pivot = prevDay ? ((prevDay[2]+prevDay[3]+prevDay[4])/3).toFixed(2) : 0;

    // Institutional candles (>80pt range in 5min)
    const instCandles = c5m.filter(c=>(c[2]-c[3])>80);
    const lastInstDesc = instCandles.length
      ? `${instCandles.length} institutional candle(s) today. Last: ${instCandles[instCandles.length-1][4]>instCandles[instCandles.length-1][1]?'BULLISH':'BEARISH'} at ${instCandles[instCandles.length-1][0].slice(11,16)}`
      : 'No institutional candles (>80pt) today';

    // Option chain
    const ceStrikes = [atm,atm+50,atm+100,atm+150,atm+200,atm+300,atm+500];
    const peStrikes = [atm,atm-50,atm-100,atm-150,atm-200,atm-300,atm-500];
    const allOCSyms = [
      ...ceStrikes.map(s=>`NFO:${kSym(expiry,s,'CE')}`),
      ...peStrikes.map(s=>`NFO:${kSym(expiry,s,'PE')}`)
    ];
    const ocRes  = await fetch(`https://api.kite.trade/quote?${allOCSyms.map(s=>`i=${enc(s)}`).join('&')}`,{headers:kH}).catch(()=>null);
    const ocJ    = ocRes ? await ocRes.json().catch(()=>null) : null;
    const ocData = ocJ?.data || {};

    let ocTable = 'Strike | CE LTP | CE OI     | CE Vol | PE LTP | PE OI     | PE Vol\n';
    ocTable    += '-------|--------|-----------|--------|--------|-----------|-------\n';
    let totCeOI=0,totPeOI=0,maxCeOI=0,maxPeOI=0,callWall=atm,putWall=atm;
    const allSorted = [...new Set([...ceStrikes,...peStrikes])].sort((a,b)=>b-a);
    for (const st of allSorted) {
      const ce = ocData[`NFO:${kSym(expiry,st,'CE')}`];
      const pe = ocData[`NFO:${kSym(expiry,st,'PE')}`];
      if (ce) { totCeOI+=ce.oi||0; if((ce.oi||0)>maxCeOI){maxCeOI=ce.oi||0;callWall=st;} }
      if (pe) { totPeOI+=pe.oi||0; if((pe.oi||0)>maxPeOI){maxPeOI=pe.oi||0;putWall=st;} }
      ocTable += `${String(st).padStart(6)} | ${String((ce?.last_price||0).toFixed(0)).padStart(6)} | ${String(ce?.oi||0).padStart(9)} | ${String(ce?.volume||0).padStart(6)} | ${String((pe?.last_price||0).toFixed(0)).padStart(6)} | ${String(pe?.oi||0).padStart(9)} | ${String(pe?.volume||0).padStart(6)}\n`;
    }
    const pcr = totCeOI>0 ? (totPeOI/totCeOI).toFixed(3) : '0';
    const atmCeP = ocData[`NFO:${kSym(expiry,atm,'CE')}`]?.last_price || 0;
    const atmPeP = ocData[`NFO:${kSym(expiry,atm,'PE')}`]?.last_price || 0;
    const maxAffordPremium = liveF>0 ? (liveF/65).toFixed(2) : '0';

    // Positions & orders
    const openPos  = (posJ?.data?.net||[]).filter(p=>p.quantity!==0);
    const posText  = openPos.length
      ? openPos.map(p=>`${p.tradingsymbol}: Qty ${p.quantity}, Avg ₹${(p.average_price||0).toFixed(2)}, LTP ₹${(p.last_price||0).toFixed(2)}, P&L ₹${(p.pnl||0).toFixed(2)}`).join('\n')
      : 'None';
    const pendOrds = (ordJ?.data||[]).filter(o=>['OPEN','TRIGGER PENDING'].includes(o.status));
    const ordText  = pendOrds.length ? pendOrds.map(o=>`${o.tradingsymbol}: ${o.transaction_type} ${o.quantity}@${o.price}`).join('\n') : 'None';

    // Candle summary for prompt
    const last20c = c5m.slice(-20).map(c=>`[${c[0].slice(11,16)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');
    const last15d = cDay.slice(-15).map(c=>`[${c[0].slice(0,10)} O:${c[1].toFixed(1)} H:${c[2].toFixed(1)} L:${c[3].toFixed(1)} C:${c[4].toFixed(1)} V:${c[5]}]`).join('\n');

    K = {
      spot, chg, prevCl, dayH, dayL, dayO, volume: nQ?.volume||0,
      vix:      ltpJ?.data?.['NSE:INDIA VIX']?.last_price,
      bn:       ltpJ?.data?.['NSE:NIFTY BANK']?.last_price,
      niftyIT:  ltpJ?.data?.['NSE:NIFTY IT']?.last_price,
      niftyAuto:ltpJ?.data?.['NSE:NIFTY AUTO']?.last_price,
      niftyFin: ltpJ?.data?.['NSE:NIFTY FIN SERVICE']?.last_price,
      niftyMid: ltpJ?.data?.['NSE:NIFTY MIDCAP 100']?.last_price,
      liveF, atm, expiry, vwap:vwap.toFixed(2), sma20:sma20.toFixed(2),
      ema9:ema9.toFixed(2), ema21:ema21.toFixed(2),
      orh:orh.toFixed(2), orl:orl.toFixed(2),
      highTiming, lowTiming, momDesc, lastInstDesc,
      greenDays, r2:r2.toFixed(0), r1:r1.toFixed(0), s1:s1.toFixed(0), s2:s2.toFixed(0),
      pivot, pcr, callWall, putWall, atmCeP, atmPeP, maxAffordPremium,
      ocTable, posText, ordText, openPos, last20c, last15d,
    };
  } catch(e) {
    K.error = e.message;
    console.error('Kite error:', e.message);
  }

  // ── BUILD PROMPT ────────────────────────────────────────────────────────────
  const vix = K.vix || 0;
  const sigma1d = K.spot && vix ? (K.spot * (vix/100) / Math.sqrt(252)).toFixed(0) : '—';
  const sigma1w = K.spot && vix ? (K.spot * (vix/100) / Math.sqrt(52)).toFixed(0) : '—';

  const prompt = `You are a seasoned Nifty 50 F&O analyst (15+ years). Run the full nifty-options-analyst skill.

TIME: ${istStr} / ${sgtStr} | ${dayName} ${todayDate}

═══ CONSTANTS ═══
Lot size: 65 | Expiry day: TUESDAY | LIVE_FUNDS: ₹${(K.liveF||0).toFixed(0)}
Max affordable premium: ₹${K.maxAffordPremium}/unit (= funds ÷ 65)
Auto-trade threshold: ±10 | Per-trade stop-loss: ₹2,000 total = ₹30.77/unit

═══ KITE LIVE DATA ═══
NIFTY 50: ${K.spot} | Chg: ${K.chg>=0?'+':''}${K.chg?.toFixed(2)} from prev close ${K.prevCl}
Day: O:${K.dayO} H:${K.dayH} L:${K.dayL} | Volume: ${K.volume}
VWAP: ${K.vwap} | 20-DMA: ${K.sma20} | 9-EMA: ${K.ema9} | 21-EMA: ${K.ema21}
EMA Cross: 9-EMA ${K.ema9>K.ema21?'ABOVE (bullish)':'BELOW (bearish)'} 21-EMA by ${Math.abs(K.ema9-K.ema21).toFixed(2)} pts

Opening Range: H=${K.orh} L=${K.orl}
Current price vs ORH: ${K.spot>K.orh?'ABOVE ORH (bullish)':K.spot<K.orl?'BELOW ORL (bearish)':'INSIDE RANGE'}
Day High timing: ${K.highTiming} | Day Low timing: ${K.lowTiming}
Last 5-candle momentum: ${K.momDesc}
Institutional candles: ${K.lastInstDesc}

INDIA VIX: ${K.vix} | Expected 1σ: daily ±${sigma1d}pts, weekly ±${sigma1w}pts
BANK NIFTY: ${K.bn} | IT: ${K.niftyIT} | AUTO: ${K.niftyAuto} | FIN SVC: ${K.niftyFin} | MIDCAP: ${K.niftyMid}
BN vs Nifty: ${K.bn&&K.spot ? (((K.bn-K.spot)/K.spot)*100).toFixed(2)+'% relative' : '—'}

EXPIRY: ${K.expiry?.dateStr} (DTE: ${K.expiry?.dte} days) | EXPIRY DAY: ${K.expiry?.isExpiry?'YES — GAMMA RISK':'NO'}
ATM: ${K.atm} | PCR: ${K.pcr} | Call Wall: ${K.callWall} | Put Wall: ${K.putWall}
ATM CE premium: ₹${K.atmCeP} | ATM PE premium: ₹${K.atmPeP}
ATM CE cost/lot: ₹${(K.atmCeP*65).toFixed(0)} | Affordable ATM lots: ${K.liveF&&K.atmCeP?(Math.floor(K.liveF/(K.atmCeP*65))||0):0}

OPTION CHAIN:
${K.ocTable}

KEY LEVELS: R2=${K.r2} | R1=${K.r1} | Pivot=${K.pivot} | S1=${K.s1} | S2=${K.s2}
Spot vs 20-DMA: ${K.spot>K.sma20?'ABOVE (bullish)':'BELOW (bearish)'}
Green days (last 10): ${K.greenDays}/10

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
4C: "GIFT Nifty live today" AND "S&P 500 Nasdaq Dow yesterday ${todayDate}"
4D: "India market news today ${todayDate}" AND "RBI FOMC meeting upcoming 2026"
4E: "NSE block deals bulk deals heavyweights ${todayDate}"
4F: "NSE advance decline ratio breadth ${todayDate}"
4G: "Reliance HDFC Bank ICICI Infosys Bharti performance today"
4H: "Nifty PCR put call ratio max pain COI PCR niftytrader ${todayDate}"

PHASE 5 — Score ALL 10 factors (-3 to +3 each):

F1 VIX: Level scoring: <12=+2,12-15=0,15-20=-1,20-25=-2,>25=-3. PLUS trend: VIX falling+market rising=+1to+2, VIX rising+falling=-2to-3. Also state σ and compare to ATM distance.

F2 PCR/OI: (a) Total PCR: >1.5=+2,1.3-1.5=+1,1.0-1.3=0,0.7-1.0=-1,<0.7=-2. (b) COI PCR: >1.2=+2,0.8-1.2=0,<0.8=-2. (c) OI buildup patterns at top strikes. (d) Max Pain pull direction. Average all sub-factors for F2 total.

F3 Intraday: (a) VWAP: above=+1,below=-1,rejection from below=-1extra,bounce from above=+1extra. (b) ORH/ORL break with volume=±2,inside range=0,gap fade=-1. (c) Momentum last 2hrs: 3+HH/HL=+2,LL/LH=-2. (d) Institutional candles direction. (e) Day H/L timing: H in first 30min=-1,H in last 30min=+1. Cap F3 at ±3.

F4 Daily: (a) 20-DMA: above=+1,below=-1,fresh cross=±2. (b) 9-EMA vs 21-EMA cross: widening above=+2,widening below=-2. (c) Green days: 8-10=+2,5-7=+1,4-5=0,3-4=-1,0-2=-2. (d) Key S/R: spot near S1/S2 with bullish=CE,near R1/R2 with bearish=PE. (e) Last daily candle pattern. Cap F4 at ±3.

F5 Sectoral: (a) BN vs Nifty: BN+>0.5%+Nifty+=+2,BN-+Nifty-=-2. (b) IT as FII proxy: rising=+1,falling=-1. (c) Midcap outperforming=+1,underperforming=-1. (d) Top-5 heavyweights: ≥4 up=+2,≥3 down=-2,mixed=0. State explicitly if ≥3 of top 5 are red. Cap F5 at ±3.

F6 FII/DII: Combine 4A cash flows + 4B F&O L/S ratio. Both buying=+3,both selling=-3,FII buy+F&O long=+3,FII sell+F&O short=-2,FII sell>2kCr+L/S<0.3=-3.

F7 Breadth: ≥40adv+ADR>1.5=+3,30-39+ADR1.2-1.5=+2,20-29+ADR0.8-1.2=0,10-19+ADR0.5-0.8=-1,<10+ADR<0.5=-3. Note divergence alerts.

F8 Global: S&P>1%=+1,<-1%=-1,<-2%=-2. Asia broadly green=+1,red=-1. GIFT gap>100=±1. Crude>90=-1,<75=+1. DXY/yields. Cap ±3.

F9 IV/Greeks: (a) VIX env: <13=+2,13-18=+1,18-22=0,>22=-2,>25=-3. (b) Strike selection: state which strike is best given VIX env and funds. (c) Lot affordability: floor(${(K.liveF||0).toFixed(0)}/(premium×65))=X lots. (d) ATM distance vs σ: strike within 0.5σ=high prob,0.5-1σ=moderate,>1.5σ=avoid. (e) DTE theta: >5=ok,2-4=confirmed momentum needed,0-1=gamma extreme.

F10 Events: No event=+1,major event today=-3,in 1-2 days=-2,in 3-5 days=-1,positive surprise today=+2,geopolitical=-2.

HARD OVERRIDES (check each, force STAY OUT if triggered):
1. Expiry day AND score -5 to +5 → STAY OUT
2. VIX > 22 → STAY OUT buying
3. Major event within 24hrs → STAY OUT
4. LIVE_FUNDS < ATM_premium × 65 → STAY OUT (currently: ₹${(K.liveF||0).toFixed(0)} vs ₹${((K.atmCeP||0)*65).toFixed(0)})
5. FII L/S < 0.2 AND PCR < 0.6 → override STRONG PE
6. Both FII+DII selling + ADR < 0.5 → STAY OUT

VERDICT TABLE (-30 to +30):
+12 to +30 → STRONG ENTRY CE | +6 to +11 → ENTRY CE | +2 to +5 → LEAN CE
-1 to +1 → STAY OUT | -5 to -2 → LEAN PE | -11 to -6 → ENTRY PE | -30 to -12 → STRONG ENTRY PE

AUTO-TRADE:
Score ≥+10 AND no overrides → state: "AUTO-TRADE: YES — BUY CE [symbol] @ market"
Score ≤-10 AND no overrides → state: "AUTO-TRADE: YES — BUY PE [symbol] @ market"
All other cases → state: "AUTO-TRADE: NO — [reason]"
Stop: ₹2,000 total = ₹30.77/unit below entry premium.

═══ OUTPUT FORMAT (print exactly) ═══

═══════════════════════════════════════════════════════════
NIFTY ANALYSIS — ${todayDate} ${istStr}
DATA: 🔗 Kite REST API + Web Search
───────────────────────────────────────────────────────────
SPOT: Rs [X]  │  VIX: [X]  │  Expiry: [date] ([X] DTE)
Funds: Rs [X]  │  ATM CE: Rs [X]  │  Affordable lots: [X]
VWAP: Rs [X]  │  20-DMA: Rs [X]  │  PCR: [X]
1σ Daily: ±[X]pts  │  1σ Weekly: ±[X]pts
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
AUTO-TRADE: [YES — BUY CE/PE NIFTY... | NO — reason]
───────────────────────────────────────────────────────────
TRADE (if ENTRY or STRONG ENTRY):
  Symbol:      NIFTY[...]
  Strike:      [X] | Distance: [X]pts | [X]σ from spot
  Premium:     Rs [X] | Cost/lot: Rs [X]×65=Rs [X]
  Affordable:  [X] lot(s)
  ENTRY ZONE:  Rs [X]–Rs [X]
  STOP-LOSS:   Rs [X] premium (₹2,000/lot) │ Nifty Rs [X]
  TARGET 1:    Rs [X] (+80%) │ Nifty Rs [X] │ +[X]pts
  TARGET 2:    Rs [X] (+150%) │ Nifty Rs [X] │ +[X]pts
  VWAP:        Rs [X] │ Max Pain: Rs [X]
  Call Wall:   Rs [X] │ Put Wall: Rs [X] │ Breakeven: Rs [X]
KEY LEVELS:  R2:[X] │ R1:[X] │ Pivot:[X] │ S1:[X] │ S2:[X]
TOP 3 REASONS: 1.[...] 2.[...] 3.[...]
TOP 2 RISKS: 1.[...] 2.[...]
EXIT RULES:
  □ Premium -50% from entry → exit (hard stop)
  □ Nifty breaks key S/R with volume against you
  □ VIX spikes >3 pts suddenly
  □ Reliance/HDFC/ICICI move hard against you
  □ Exit all by 3:20 PM on expiry day
  □ Never average down on losing options
═══════════════════════════════════════════════════════════
PHASE 8 — POSITION CHECK: [HOLD/EXIT/None with P&L if applicable]
PHASE 9 — NEXT 30 MIN WATCH: [what to watch] | LEAN→ENTRY trigger: [exact trigger]
═══════════════════════════════════════════════════════════
⚠️ 91% of retail F&O traders lost money in FY2024-25 (SEBI study). Not SEBI-registered advice.`;

  // ── CALL ANTHROPIC ─────────────────────────────────────────────────────────
  let analysisText = '', inputTokens = 0, outputTokens = 0;
  try {
    const aRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const aData = await aRes.json();
    if (!aRes.ok) throw new Error(aData?.error?.message || `Anthropic HTTP ${aRes.status}`);
    inputTokens  = aData.usage?.input_tokens  || 0;
    outputTokens = aData.usage?.output_tokens || 0;
    analysisText = (aData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if (!analysisText) throw new Error('Empty analysis from Anthropic');
  } catch(e) {
    return res.status(500).json({ error: 'Analysis failed: ' + e.message });
  }

  // ── PARSE RESPONSE ─────────────────────────────────────────────────────────
  const f = (re) => { const m = analysisText.match(re); return m ? parseInt(m[1]) : 0; };
  const totalMatch  = analysisText.match(/TOTAL:\s*([+-]?\d+)/i);
  const score       = totalMatch ? parseInt(totalMatch[1]) : 0;
  const verdictM    = analysisText.match(/VERDICT:\s*([^\n\r]+)/i);
  const verdict     = verdictM ? verdictM[1].trim() : 'STAY OUT';
  const autoM       = analysisText.match(/AUTO-TRADE:\s*([^\n\r]+)/i);
  const autoTrade   = autoM ? autoM[1].trim() : 'NO';
  const symM        = analysisText.match(/Symbol:\s+(NIFTY\S+)/i);
  const tradeSymbol = symM ? symM[1].replace(/[^A-Z0-9]/g,'') : null;
  const entryM      = analysisText.match(/ENTRY ZONE:\s*Rs\s*([\d.]+)[–\-–]Rs\s*([\d.]+)/i);
  const entryLow    = entryM ? parseFloat(entryM[1]) : null;
  const entryHigh   = entryM ? parseFloat(entryM[2]) : null;
  const scores = {
    f1:  f(/F1\s+VIX[^|]*\[?([+-]?\d+)\]?/i),
    f2:  f(/F2\s+PCR[^|]*\[?([+-]?\d+)\]?/i),
    f3:  f(/F3\s+Intraday[^|]*\[?([+-]?\d+)\]?/i),
    f4:  f(/F4\s+Daily[^|]*\[?([+-]?\d+)\]?/i),
    f5:  f(/F5\s+Sectoral[^|]*\[?([+-]?\d+)\]?/i),
    f6:  f(/F6\s+FII[^|]*\[?([+-]?\d+)\]?/i),
    f7:  f(/F7\s+Breadth[^|]*\[?([+-]?\d+)\]?/i),
    f8:  f(/F8\s+Global[^|]*\[?([+-]?\d+)\]?/i),
    f9:  f(/F9\s+IV[^|]*\[?([+-]?\d+)\]?/i),
    f10: f(/F10\s+Events[^|]*\[?([+-]?\d+)\]?/i),
  };

  return res.json({
    score, verdict, autoTrade, tradeSymbol, entryLow, entryHigh, scores,
    analysis: analysisText,
    marketData: {
      spot: K.spot, vix: K.vix, bn: K.bn, liveF: K.liveF,
      atm: K.atm, expiry: K.expiry?.dateStr, dte: K.expiry?.dte,
      isExpiry: K.expiry?.isExpiry, vwap: K.vwap, sma20: K.sma20,
      ema9: K.ema9, ema21: K.ema21, pcr: K.pcr,
      callWall: K.callWall, putWall: K.putWall,
      atmCeP: K.atmCeP, atmPeP: K.atmPeP,
      orh: K.orh, orl: K.orl, sigma1d, sigma1w,
      r2: K.r2, r1: K.r1, pivot: K.pivot, s1: K.s1, s2: K.s2,
      openPositions: K.openPos,
    },
    usage: { inputTokens, outputTokens },
    timestamp: istStr, sgt: sgtStr,
  });
}
