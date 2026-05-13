import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

// ── Constants ──────────────────────────────────────────────────────────────────
const AUTO_INTERVAL_MS = 10 * 60 * 1000
const COST_IN  = 3  / 1_000_000 * 90
const COST_OUT = 15 / 1_000_000 * 90
const LOT_SIZE = 65
const AUTO_TRADE_CE = 8
const AUTO_TRADE_PE = -8

const FACTORS = [
  {key:'f1',label:'VIX Analysis'},{key:'f2',label:'PCR & OI'},
  {key:'f3',label:'Intraday Action'},{key:'f4',label:'Daily Trend'},
  {key:'f5',label:'Sectoral Health'},{key:'f6',label:'FII / DII'},
  {key:'f7',label:'Market Breadth'},{key:'f8',label:'Global Cues'},
  {key:'f9',label:'IV & Greeks'},{key:'f10',label:'Event Risk'},
]

// ── Helpers ────────────────────────────────────────────────────────────────────
const scoreColor = s =>
  s>=10?'#10B981':s>=6?'#34D399':s>=2?'#86EFAC':
  s>=-1?'#F59E0B':s>=-5?'#F87171':s>=-9?'#EF4444':'#DC2626'

const verdictMeta = v => {
  if (!v) return {c:'#6366F1',bg:'rgba(99,102,241,0.08)',e:'⏳'}
  if (v.includes('STRONG ENTRY CE')) return {c:'#10B981',bg:'rgba(16,185,129,0.12)',e:'🚀'}
  if (v.includes('ENTRY CE'))        return {c:'#34D399',bg:'rgba(52,211,153,0.10)',e:'🟢'}
  if (v.includes('STRONG ENTRY PE')) return {c:'#EF4444',bg:'rgba(239,68,68,0.12)',e:'🔻'}
  if (v.includes('ENTRY PE'))        return {c:'#F87171',bg:'rgba(248,113,113,0.10)',e:'🔴'}
  return {c:'#F59E0B',bg:'rgba(245,158,11,0.08)',e:'⚠️'}
}

const isEntryVerdict = v => v && (v.includes('ENTRY CE') || v.includes('ENTRY PE'))
const isAutoTrigger  = s => s >= AUTO_TRADE_CE || s <= AUTO_TRADE_PE

const fI  = n => n!=null?Number(n).toLocaleString('en-IN'):'—'
const fR  = n => `₹${Number(n||0).toFixed(2)}`
const fT  = d => d?d.toLocaleTimeString('en-IN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—'
const fTs = s => { if(!s) return '—'; const d=new Date(s); return isNaN(d)?s.slice(11,16)||'—':d.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour12:false,hour:'2-digit',minute:'2-digit'}); }

function getIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
function isMarketOpen() {
  const ist = getIST()
  const day = ist.getDay()
  if (day===0||day===6) return false
  const mins = ist.getHours()*60+ist.getMinutes()
  return mins>=9*60+15 && mins<15*60+30
}
function isAutoTradeAllowed() {
  const ist = getIST()
  return ist.getHours()*60+ist.getMinutes() <= 13*60+45
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function ScoreGauge({score}) {
  const pct = Math.max(0,Math.min(100,((score+15)/30)*100))
  const c = scoreColor(score)
  return (
    <div style={{margin:'10px 0 4px'}}>
      <div style={{height:6,borderRadius:3,background:'linear-gradient(to right,#DC2626,#EF4444 20%,#F59E0B 50%,#34D399 80%,#10B981)',position:'relative'}}>
        <div style={{position:'absolute',left:`${pct}%`,top:'50%',transform:'translate(-50%,-50%)',
          width:18,height:18,borderRadius:'50%',background:c,border:'3px solid #07070F',
          boxShadow:`0 0 12px ${c}99`,transition:'left 0.9s cubic-bezier(.34,1.56,.64,1)'}}/>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:'#374151',fontFamily:'monospace'}}>
        {['-15','-10','-5','0','+5','+10','+15'].map(l=><span key={l}>{l}</span>)}
      </div>
    </div>
  )
}

function FactorBar({value}) {
  const c = value>0?'#10B981':value<0?'#EF4444':'#374151'
  return (
    <div style={{display:'flex',gap:2,alignItems:'center'}}>
      {[-3,-2,-1,0,1,2,3].map(b=>(
        <div key={b} style={{width:12,height:12,borderRadius:2,
          background:(value<0&&b>=value&&b<0)?c:(value>0&&b<=value&&b>0)?c:b===0?'#1E2030':'#111120',
          border:b===0?'1px solid #2D3048':'none',
          opacity:Math.abs(b)<=Math.abs(value)||b===0?1:0.3}}/>
      ))}
    </div>
  )
}

function Toggle({on,set,disabled,color='#10B981'}) {
  return (
    <button onClick={()=>!disabled&&set(!on)} style={{
      width:52,height:28,borderRadius:14,border:'none',padding:0,flexShrink:0,
      cursor:disabled?'not-allowed':'pointer',
      background:on&&!disabled?color:'#1E2030',
      position:'relative',transition:'background 0.3s',opacity:disabled?0.45:1}}>
      <div style={{position:'absolute',top:3,left:on&&!disabled?27:3,
        width:22,height:22,borderRadius:'50%',background:'#fff',
        transition:'left 0.3s',boxShadow:'0 1px 4px rgba(0,0,0,0.5)'}}/>
    </button>
  )
}

function StatCard({label,value,sub,color='#E8E8F8',small=false}) {
  return (
    <div style={{background:'#111120',borderRadius:8,padding:'9px 10px'}}>
      <div style={{fontSize:9,color:'#4B5563',textTransform:'uppercase',letterSpacing:'0.09em',fontWeight:700}}>{label}</div>
      <div style={{fontSize:small?13:17,fontWeight:700,fontFamily:'monospace',color,marginTop:3,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:10,fontFamily:'monospace',color:'#6B7280',marginTop:2}}>{sub}</div>}
    </div>
  )
}

function SetupCard({title,color,symbol,entryL,entryH,sl,target,target2,lots,liveF}) {
  if (!symbol) return null
  const premium = entryH||0
  const slPremium = sl || premium*0.5
  const lossPerLot = (slPremium*LOT_SIZE).toFixed(0)
  const profitPerLot = (premium*0.8*LOT_SIZE).toFixed(0)
  return (
    <div style={{background:`${color}0D`,border:`1px solid ${color}30`,borderRadius:10,padding:'12px 14px',marginTop:8}}>
      <div style={{fontSize:12,fontWeight:800,color,letterSpacing:'0.08em',marginBottom:8}}>{title}</div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:6}}>
        <span style={{background:`${color}20`,color,border:`1px solid ${color}45`,
          padding:'3px 10px',borderRadius:5,fontSize:13,fontWeight:800,fontFamily:'monospace'}}>{symbol}</span>
        <span style={{fontSize:11,color:'#6B7280'}}>Entry ₹{entryL?.toFixed(0)}–₹{entryH?.toFixed(0)}</span>
        {lots&&<span style={{fontSize:11,color:'#F59E0B'}}>Qty: {lots} lot{lots>1?'s':''}</span>}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:4,fontSize:11}}>
        <div style={{color:'#EF4444'}}>SL: ₹{slPremium.toFixed(0)} (50%) → loss ₹{lossPerLot}</div>
        <div style={{color:'#10B981'}}>T1: +80% → profit ₹{profitPerLot}</div>
        {target&&<div style={{color:'#6B7280'}}>Nifty T1: {fI(target)}</div>}
        {target2&&<div style={{color:'#34D399'}}>T2: +150% trail</div>}
      </div>
    </div>
  )
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate  = useNavigate()
  const [result,      setResult]      = useState(null)
  const [busy,        setBusy]        = useState(false)
  const [err,         setErr]         = useState(null)
  const [clock,       setClock]       = useState('')
  const [elapsed,     setElapsed]     = useState(0)
  const [errDetail,   setErrDetail]   = useState(null)
  const [autoOn,      setAutoOn]      = useState(false)
  const [atOn,        setAtOn]        = useState(false)
  const [stopped,     setStopped]     = useState(false)
  const [position,    setPosition]    = useState(null)
  const [tradeLog,    setTradeLog]    = useState([])
  const [inTok,       setInTok]       = useState(0)
  const [outTok,      setOutTok]      = useState(0)
  const [calls,       setCalls]       = useState(0)
  const [cd,          setCd]          = useState(600)
  const [pulse,       setPulse]       = useState(false)
  const [showFull,    setShowFull]    = useState(false)
  const [orderMsg,    setOrderMsg]    = useState(null)
  const [dailyTrades, setDailyTrades] = useState(0)
  const [tradeMode,   setTradeMode]   = useState('quick')
  const [pendingSignal,   setPendingSignal]   = useState(null)
  const [autoIntervalMin, setAutoIntervalMin] = useState(10)
  // Rule 1 & 9: Capital tracking
  const [startCapital,    setStartCapital]    = useState(null)
  // Rule 5: OI flip-flop
  const [oiHistory,       setOiHistory]       = useState([])
  const [oiFlipWarn,      setOiFlipWarn]      = useState(false)
  // Rule 6: Anti-FOMO cooldown
  const [lastExit,        setLastExit]        = useState(null)  // {dir,time}
  // Rule 7: Premium delta (IV crush)
  const [entrySnapshot,   setEntrySnapshot]   = useState(null)  // {spot,premium}
  // Rule 8: Afternoon fade
  const [afFade,          setAfFade]          = useState(false)
  // Rule 9: Capital preservation mode
  const [cpMode,          setCpMode]          = useState(false)
  const [cpHard,          setCpHard]          = useState(false)

  const atRef    = useRef(atOn)
  const posRef   = useRef(position)
  const intRef   = useRef(null)
  const cdRef    = useRef(null)
  const clockRef = useRef(null)
  const elRef    = useRef(null)
  useEffect(()=>{atRef.current=atOn},[atOn])
  useEffect(()=>{posRef.current=position},[position])

  // Live SGT clock
  useEffect(()=>{
    const tick = () => {
      const sgt = new Date(Date.now() + 8*3600000)
      setClock(sgt.toISOString().slice(11,19))
    }
    tick()
    clockRef.current = setInterval(tick, 1000)
    return () => clearInterval(clockRef.current)
  }, [])

  const accessToken = localStorage.getItem('kite_access_token')
  const userName    = localStorage.getItem('kite_user_name')||'Trader'
  const totalCost   = inTok*COST_IN + outTok*COST_OUT
  const cpc         = calls>0?totalCost/calls:0

  const logout = () => { localStorage.clear(); navigate('/login') }

  // ── Rule helpers ──────────────────────────────────────────────────────────

  // Rule 1 & 9: Check capital limits
  const checkCapital = (liveF, startCap) => {
    if (!startCap || !liveF) return { blocked: false }
    const loss = startCap - liveF
    const drawPct = loss / startCap
    if (drawPct >= 0.30) return { blocked: true, hard: true, reason: `🛑 Capital Preservation HARD STOP: ${(drawPct*100).toFixed(1)}% drawdown (>30%) — exiting all` }
    if (drawPct >= 0.20) return { blocked: true, hard: false, reason: `⛔ Capital Preservation: ${(drawPct*100).toFixed(1)}% drawdown (>20%) — entries blocked` }
    if (loss >= 1000)    return { blocked: true, hard: false, reason: `⛔ Daily loss limit: ₹${loss.toFixed(0)} ≥ ₹1,000 — entries blocked` }
    if (drawPct >= 0.12) return { blocked: true, hard: false, reason: `⛔ Daily loss limit: ${(drawPct*100).toFixed(1)}% ≥ 12% — entries blocked` }
    return { blocked: false }
  }

  // Rule 3: σ-based strike validation
  const validateStrike = (sym, spot, vix) => {
    if (!sym || !spot || !vix) return { ok: true }
    const sigma1d = spot * (vix / 100) / Math.sqrt(252)
    if (sigma1d <= 0) return { ok: true }
    const m = sym.match(/([0-9]{4,5})(CE|PE)$/)
    if (!m) return { ok: true }
    const strike = parseInt(m[1])
    const sigmas = Math.abs(strike - spot) / sigma1d
    if (sigmas > 1.5) return { ok: false, sigmas, reason: `Strike ${strike} is ${sigmas.toFixed(1)}σ OTM — blocked (>1.5σ). Use ≤0.5σ strike.` }
    return { ok: true, sigmas }
  }

  // Rule 6: Anti-FOMO cooldown (30 min)
  const checkFomoCooldown = (dir) => {
    if (!lastExit || lastExit.dir !== dir) return { blocked: false }
    const elapsed = Date.now() - lastExit.time
    const COOLDOWN = 30 * 60 * 1000
    if (elapsed < COOLDOWN) {
      const minsLeft = Math.ceil((COOLDOWN - elapsed) / 60000)
      return { blocked: true, reason: `🕐 Anti-FOMO: ${minsLeft}min cooldown after ${dir} exit` }
    }
    return { blocked: false }
  }

  // Rule 10: Conviction-based lot sizing
  const convictionLots = (verdict, score, maxLots) => {
    const v = (verdict || '').toUpperCase()
    if (v.includes('STRONG') || Math.abs(score) >= 12) return { lots: maxLots, tag: 'STRONG 100%' }
    if (v.includes('ENTRY')  || Math.abs(score) >= 8)  return { lots: Math.max(1, Math.floor(maxLots * 0.75)), tag: 'ENTRY 75%' }
    return { lots: 0, tag: 'STAY OUT 0%' }
  }

  // ── Execute a single trade ─────────────────────────────────────────────────
  const executeTrade = useCallback(async (r, mode='quick') => {
    if (!isAutoTradeAllowed()) { setOrderMsg('⏰ Blocked — after 1:45 PM IST'); return false }
    if (dailyTrades>=2)        { setOrderMsg('📊 Daily limit: 2 trades reached'); return false }

    const md   = r.marketData || {}

    // Rule 1 & 9: Capital preservation / daily loss limit
    const capCheck = checkCapital(md.liveF, startCapital)
    if (capCheck.blocked) { setOrderMsg(capCheck.reason); return false }

    // Rule 6: Anti-FOMO cooldown
    const tradeDir = r.score >= 0 ? 'CE' : 'PE'
    const fomoCheck = checkFomoCooldown(tradeDir)
    if (fomoCheck.blocked) { setOrderMsg(fomoCheck.reason); return false }

    // Rule 3: σ-based strike validation
    const sym  = mode==='swing' ? (r.swingSymbol||r.quickSymbol) : (r.quickSymbol||r.swingSymbol)
    const strikeCheck = validateStrike(sym, md.spot, md.vix)
    if (!strikeCheck.ok) { setOrderMsg(`⚠️ ${strikeCheck.reason}`); return false }

    const entH = mode==='swing' ? (r.swingEntryH||r.quickEntryH) : (r.quickEntryH||r.swingEntryH)

    if (!sym)  { setOrderMsg('⚠️ No symbol in analysis — cannot trade'); return false }
    if (!entH) { setOrderMsg('⚠️ No entry premium in analysis — cannot trade'); return false }

    // Fix 5: Funds check before order
    const cost = entH * LOT_SIZE
    if (md.liveF && md.liveF < cost) {
      setOrderMsg(`⚠️ Insufficient funds: ₹${md.liveF?.toFixed(0)} < ₹${cost.toFixed(0)} needed`)
      return false
    }

    // Rule 10: Conviction-based sizing (overlaid with IVP safety cap)
    const ivp    = r.ivpVal || 50
    const afford = md.liveF ? Math.floor(md.liveF / cost) : 1
    const ivpCap = ivp > 70 ? Math.max(1, Math.floor(afford * 0.5))
                 : ivp > 20 ? Math.max(1, Math.floor(afford * 0.75))
                 : afford
    const { lots: convLots, tag: convTag } = convictionLots(r.verdict, r.score, ivpCap)
    const lots   = Math.max(1, convLots)
    const qty    = Math.max(LOT_SIZE, lots * LOT_SIZE)

    try {
      const res  = await fetch('/api/place-order',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({accessToken,tradingsymbol:sym,transactionType:'BUY',quantity:qty})
      })
      const data = await res.json()
      if (!data.orderId) { setOrderMsg(`⚠️ Order failed: ${data.error||'Unknown'}`); return false }

      // Fix 4: Premium-based SL (50% of entry)
      const slPremium = parseFloat((entH*0.5).toFixed(2))
      const t = {type:r.score>=0?'CE':'PE',sym,entry:entH,sl:slPremium,
                 orderId:data.orderId,time:new Date(),score:r.score,mode,qty}
      setPosition(t)
      // Rule 7: Save entry snapshot for IV crush detection
      setEntrySnapshot({ spot: md.spot || 0, premium: entH, time: Date.now() })
      setTradeLog(l=>[{...t,action:`${mode.toUpperCase()} BUY ${t.type} ✅ [${convTag}]`},...l.slice(0,29)])
      setDailyTrades(p=>p+1)

      // GTT stop-loss (50% of premium)
      let gttMsg=''
      try {
        const gttRes = await fetch('/api/place-gtt',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({accessToken,tradingsymbol:sym,
            slTriggerPrice:slPremium,currentPrice:entH,quantity:qty})
        })
        const gttData = await gttRes.json()
        gttMsg = gttData.gttId
          ? ` | GTT SL ₹${slPremium} set ✅ (GID:${gttData.gttId})`
          : ` | GTT failed: ${gttData.error}`
      } catch(ge) { gttMsg=` | GTT err: ${ge.message}` }

      setOrderMsg(`✅ ${mode} BUY ${t.type} ${sym} qty:${qty} (OID:${data.orderId})${gttMsg}`)
      setPendingSignal(null)
      return true
    } catch(e) {
      setOrderMsg(`⚠️ Trade error: ${e.message}`)
      return false
    }
  }, [accessToken,dailyTrades])

  // ── Auto-trade logic (called after every analysis — manual OR auto) ────────
  const handleAutoTrade = useCallback(async (r) => {
    if (!atRef.current) return
    const score = r.score
    const cur   = posRef.current

    // Entry
    if (!cur && isAutoTrigger(score) && r.autoTrade?.toUpperCase().includes('YES')) {
      await executeTrade(r, tradeMode)
    }

    // Exit: check all exit rules
    if (cur) {
      // Rule 8: Afternoon Fade — tighten SL after 12:30 IST + 150pt rally
      const istNow = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
      const istMins = istNow.getHours()*60 + istNow.getMinutes()
      if (istMins >= 12*60+30 && r.marketData) {
        const rally = (r.marketData.dayH||0) - (r.marketData.dayO||0)
        if (rally >= 150 && score < 0) setAfFade(true)
        else setAfFade(false)
      }

      // Rule 7: IV Crush — spot moved but premium didn't
      if (entrySnapshot && r.marketData?.spot && r.marketData?.atmCeP) {
        const spotMove = Math.abs((r.marketData.spot - entrySnapshot.spot) / (entrySnapshot.spot||1))
        const premMove = Math.abs(((cur.type==='CE'?r.marketData.atmCeP:r.marketData.atmPeP) - entrySnapshot.premium) / (entrySnapshot.premium||1))
        if (spotMove > 0.005 && premMove < 0.01) {
          setOrderMsg('📉 IV Crush detected — premium not moving with spot. Exiting.')
          // Force exit below
          const ivCrushExit = true
          try {
            const res = await fetch('/api/place-order',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({accessToken,tradingsymbol:cur.sym,transactionType:'SELL',quantity:cur.qty||LOT_SIZE})})
            const data = await res.json()
            setTradeLog(l=>[{...cur,action:data.orderId?`IV CRUSH EXIT ✅ OID:${data.orderId}`:`IV CRUSH EXIT FAILED`,exitTime:new Date()},...l.slice(0,29)])
            setLastExit({dir:cur.type, time:Date.now()})
            setPosition(null); setEntrySnapshot(null)
            return
          } catch(e) { setOrderMsg(`⚠️ IV Crush exit error: ${e.message}`) }
        }
      }

      // Rule 4: Score Reversal Exit — CE exit if score ≤ 0, PE exit if score ≥ 0
      const flip = (cur.type==='CE'&&score<=0)||(cur.type==='PE'&&score>=0)
      if (flip) {
        try {
          const res  = await fetch('/api/place-order',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({accessToken,tradingsymbol:cur.sym,
              transactionType:'SELL',quantity:cur.qty||LOT_SIZE})
          })
          const data = await res.json()
          setTradeLog(l=>[{...cur,action:data.orderId?`AUTO EXIT ✅ OID:${data.orderId}`:`EXIT FAILED: ${data.error}`,exitTime:new Date()},...l.slice(0,29)])
          setLastExit({dir:cur.type, time:Date.now()})  // Rule 6: start FOMO cooldown
          setEntrySnapshot(null)
          setPosition(null)
          setOrderMsg(data.orderId?`✅ Auto-exited ${cur.type} ${cur.sym}`:`⚠️ Exit failed: ${data.error}`)
        } catch(e) { setOrderMsg(`⚠️ Exit error: ${e.message}`) }
      }
    }
  },[accessToken,executeTrade,tradeMode])

  // ── Core analysis (manual + auto) ─────────────────────────────────────────
  const analyse = useCallback(async () => {
    if (busy||stopped) return

    // Check token expiry before calling API
    const expiry = localStorage.getItem('kite_token_expiry')
    if (expiry && new Date() > new Date(expiry)) {
      setErr('Kite session expired — please logout and login again to get a fresh token.')
      setAutoOn(false); setAtOn(false)  // stop auto-retrying with expired token
      return
    }

    setBusy(true); setErr(null); setErrDetail(null); setPendingSignal(null)
    setPulse(true); setTimeout(()=>setPulse(false),700)
    // Fix 2: Start elapsed timer
    setElapsed(0)
    const elStart = Date.now()
    elRef.current = setInterval(()=>setElapsed(Math.floor((Date.now()-elStart)/1000)), 1000)

    try {
      const res  = await fetch('/api/analyze',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({accessToken})
      })
      // Guard: Vercel returns HTML on 504/502 — res.json() would throw
      const rawText = await res.text()
      let data
      try { data = JSON.parse(rawText) }
      catch {
        const hint = res.status===504||res.status===524 ? 'Analysis timed out (>60s). Try again or reduce data load.'
                   : res.status===502 ? 'Vercel gateway error. Try again in 30s.'
                   : `Server returned non-JSON (HTTP ${res.status}).`
        setAutoOn(false); setAtOn(false)
        throw new Error(hint)
      }
      if (!res.ok) {
        const detail = JSON.stringify(data, null, 2)
        setErrDetail(`HTTP ${res.status}\n${detail}`)
        throw new Error(data.error||`API error (${res.status})`)
      }
      // Detect Kite auth errors in successful HTTP responses
      if (data.error?.includes?.('pattern')||data.error?.includes?.('Invalid token')||data.error?.includes?.('expired')) {
        setErrDetail(JSON.stringify(data, null, 2))
        setAutoOn(false)   // stop hammering with bad token
        setAtOn(false)
        throw new Error('Kite session expired — please re-login')
      }

      setResult(data)
      // Rule 1: Set starting capital on first analysis
      if (!startCapital && data.marketData?.liveF > 0) setStartCapital(data.marketData.liveF)

      // Rule 5: OI Flip-Flop Detector
      if (data.marketData) {
        const oc = { callWall: data.marketData.callWall, putWall: data.marketData.putWall, pcr: data.marketData.pcr }
        setOiHistory(prev => {
          const hist = [...prev, oc].slice(-10)
          if (hist.length >= 3) {
            let cwFlips = 0, pwFlips = 0
            for (let i = 1; i < hist.length; i++) {
              if (hist[i].callWall !== hist[i-1].callWall && hist[i-1].callWall) cwFlips++
              if (hist[i].putWall  !== hist[i-1].putWall  && hist[i-1].putWall)  pwFlips++
            }
            setOiFlipWarn(cwFlips >= 2 || pwFlips >= 2)
          }
          return hist
        })
      }

      // Rule 9: Capital preservation mode check
      if (data.marketData?.liveF && startCapital) {
        const cap = checkCapital(data.marketData.liveF, startCapital)
        setCpMode(cap.blocked)
        setCpHard(cap.hard || false)
        // Hard stop: force exit if >30% drawdown
        if (cap.hard && posRef.current) {
          setOrderMsg(cap.reason)
          try {
            const cur = posRef.current
            const res = await fetch('/api/place-order',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({accessToken,tradingsymbol:cur.sym,transactionType:'SELL',quantity:cur.qty||LOT_SIZE})})
            const data2 = await res.json()
            if(data2.orderId) { setPosition(null); setEntrySnapshot(null) }
          } catch(e) {}
        }
      }

      setInTok(p=>p+(data.usage?.inputTokens||0))
      setOutTok(p=>p+(data.usage?.outputTokens||0))
      setCalls(p=>p+1)

      // Auto-trade: fires on BOTH manual and auto analysis if toggle is ON
      if (atRef.current) {
        await handleAutoTrade(data)
      } else if (isAutoTrigger(data.score) && isEntryVerdict(data.verdict)
                 && data.autoTrade?.toUpperCase().includes('YES')
                 && isAutoTradeAllowed() && !posRef.current) {
        // Auto-trade toggle is OFF but signal is strong — show manual execute prompt
        setPendingSignal(data)
      }
    } catch(e) {
      setErr(e.message)
      setErrDetail(e.stack || e.message)
    } finally {
      clearInterval(elRef.current)
      setBusy(false)
    }
  },[busy,stopped,accessToken,handleAutoTrade])

  // ── Auto-analysis loop (gated to market hours) ─────────────────────────────
  useEffect(()=>{
    const ms = autoIntervalMin * 60 * 1000
    if (autoOn&&!stopped) {
      if (isMarketOpen()) { analyse(); setCd(autoIntervalMin*60) } else setCd(0)
      cdRef.current  = setInterval(()=>{ if(isMarketOpen()) setCd(p=>p>1?p-1:autoIntervalMin*60) },1000)
      intRef.current = setInterval(()=>{ if(isMarketOpen()) { analyse(); setCd(autoIntervalMin*60) } },ms)
    } else {
      clearInterval(intRef.current); clearInterval(cdRef.current)
    }
    return ()=>{ clearInterval(intRef.current); clearInterval(cdRef.current) }
  },[autoOn,stopped,autoIntervalMin]) // eslint-disable-line

  const stop   = ()=>{ setStopped(true);setAutoOn(false);setAtOn(false);clearInterval(intRef.current);clearInterval(cdRef.current) }
  const resume = ()=>setStopped(false)

  // ── Derived ────────────────────────────────────────────────────────────────
  const score   = result?.score   ?? 0
  const verdict = result?.verdict ?? null
  const vm      = verdictMeta(verdict)
  const col     = scoreColor(score)
  const md      = result?.marketData ?? {}
  const sc      = result?.scores    ?? {}
  const mktOpen = isMarketOpen()

  const card = {background:'#0D0D1C',border:'1px solid rgba(255,255,255,0.07)',borderRadius:12,padding:'14px 16px',margin:'8px 12px'}
  const lbl  = {fontSize:10,color:'#4B5563',letterSpacing:'0.09em',textTransform:'uppercase',fontWeight:700}
  const mono = {fontFamily:"'Courier New',monospace"}
  const sec  = {fontSize:10,color:'#374151',letterSpacing:'0.12em',textTransform:'uppercase',fontWeight:700,paddingBottom:6}

  return (
    <div style={{minHeight:'100vh',background:'#07070F',color:'#E0E0F0',fontFamily:"'Segoe UI','SF Pro Display',sans-serif",paddingBottom:80,maxWidth:520,margin:'0 auto'}}>

      {/* HEADER */}
      <div style={{background:'linear-gradient(135deg,#0D0D1C,#070710)',borderBottom:'1px solid rgba(255,255,255,0.06)',padding:'12px 16px'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{display:'flex',alignItems:'baseline',gap:10}}>
              <div style={{fontSize:13,color:'#6366F1',fontWeight:800,letterSpacing:'0.14em'}}>NIFTY OPTIONS ANALYST</div>
              <div style={{fontSize:16,color:'#E8E8F8',fontFamily:'monospace',fontWeight:700,letterSpacing:'0.06em'}}>{clock}</div>
              <div style={{fontSize:10,color:'#374151'}}>SGT</div>
            </div>
            <div style={{fontSize:11,color:'#374151',marginTop:1}}>
              {mktOpen?'🟢 Market Open':'🔴 Market Closed'} · {userName}
              {md.isPreMarket&&<span style={{color:'#6366F1'}}> · Pre-market (prev session data)</span>}
              {md.isPostMarket&&<span style={{color:'#374151'}}> · Post-market</span>}
              {md.isFresh===false&&!md.isPreMarket&&!md.isPostMarket&&<span style={{color:'#F59E0B'}}> · ⚠️ Stale ({md.dataAgeMin}min)</span>}
              {(()=>{
                const exp=localStorage.getItem('kite_token_expiry');
                if(!exp) return null;
                const istDate=new Date(new Date(exp).getTime()+5.5*3600000);
                const hh=String(istDate.getUTCHours()).padStart(2,'0');
                const mm=String(istDate.getUTCMinutes()).padStart(2,'0');
                const isExpired=new Date()>new Date(exp);
                return <span style={{color:isExpired?'#EF4444':'#374151'}}>
                  {isExpired?' · ⚠️ Token EXPIRED — re-login':` · Token expires ${hh}:${mm} IST`}
                </span>;
              })()}
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{textAlign:'right'}}>
              <div style={{display:'flex',alignItems:'center',gap:5,justifyContent:'flex-end'}}>
                <div style={{width:7,height:7,borderRadius:'50%',
                  background:stopped?'#EF4444':busy?'#6366F1':autoOn?'#10B981':'#F59E0B',
                  boxShadow:`0 0 7px ${stopped?'#EF4444':busy?'#6366F1':autoOn?'#10B981':'#F59E0B'}`}}/>
                <span style={{fontSize:11,color:'#6B7280'}}>
                  {stopped?'STOPPED':busy?'THINKING':autoOn?'AUTO':'MANUAL'}
                </span>
              </div>
              <div style={{fontSize:10,color:'#374151',marginTop:1}}>{result?.sgt??'—'}</div>
            </div>
            <button onClick={logout} style={{fontSize:11,color:'#374151',background:'none',border:'1px solid rgba(255,255,255,0.06)',borderRadius:6,padding:'4px 8px',cursor:'pointer'}}>Logout</button>
          </div>
        </div>
      </div>

      {/* MARKET SNAPSHOT */}
      <div style={{...card,display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
        <StatCard label="NIFTY" value={md.spot?fI(Math.round(md.spot)):'——'}/>
        <StatCard label="BANK NIFTY" value={md.bn?fI(Math.round(md.bn)):'——'}/>
        <StatCard label="VIX" value={md.vix?.toFixed(2)??'——'} color={md.vix>20?'#EF4444':md.vix>15?'#F59E0B':'#10B981'}/>
        <StatCard label="FUNDS" value={md.liveF?`₹${(md.liveF/1000).toFixed(0)}K`:'——'} color="#F59E0B"/>
      </div>
      {result?.globalData&&<div style={{...card,display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
        {[
          {l:'S&P500',v:result.globalData.sp500?`${result.globalData.sp500.pct>=0?'+':''}${result.globalData.sp500.pct}%`:'—',c:parseFloat(result.globalData.sp500?.pct)>=0?'#10B981':'#EF4444'},
          {l:'CRUDE',v:result.globalData.crude?`$${parseFloat(result.globalData.crude.price).toFixed(1)}`:'—',c:parseFloat(result.globalData.crude?.price)>90?'#EF4444':'#10B981'},
          {l:'GOLD',v:result.globalData.gold?`$${Math.round(result.globalData.gold.price)}`:'—',c:'#F59E0B'},
          {l:'USD/INR',v:result.globalData.usdInr?`₹${parseFloat(result.globalData.usdInr.price).toFixed(2)}`:'—',c:'#9CA3AF'},
        ].map(({l,v,c})=>(
          <div key={l} style={{background:'#111120',borderRadius:7,padding:'7px 8px'}}>
            <div style={{fontSize:9,color:'#4B5563',textTransform:'uppercase',letterSpacing:'0.09em',fontWeight:700}}>{l}</div>
            <div style={{fontSize:13,fontWeight:700,...mono,color:c,marginTop:3}}>{v}</div>
          </div>
        ))}
      </div>}
      <div style={{...card,display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
        <StatCard label="PCR" value={md.pcr??'—'} color={parseFloat(md.pcr)<0.8?'#EF4444':'#10B981'} small/>
        <StatCard label="ATM" value={md.atm?fI(md.atm):'—'} small/>
        <StatCard label="EXPIRY" value={md.expiry?.slice(5)??'—'} sub={md.dte!=null?`${md.dte} DTE${md.isExpiry?' ⚠️ EXPIRY':''}`:''}
          color={md.isExpiry?'#EF4444':'#E8E8F8'} small/>
        <StatCard label="IVP" value={result?.ivpVal!=null?`${result.ivpVal}%`:'—'}
          color={result?.ivpVal>70?'#EF4444':result?.ivpVal<20?'#10B981':'#F59E0B'} small/>
      </div>

      {/* SCORE */}
      <div style={card}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
          <span style={lbl}>COMPOSITE SCORE</span>
          <span style={{fontSize:11,color:'#4B5563'}}>
            {result?`Updated ${fTs(result.timestamp)}`:'Awaiting analysis'}
          </span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:16,marginTop:8}}>
          <div style={{fontSize:48,fontWeight:900,...mono,minWidth:76,
            color:result?col:'#2D3048',textShadow:result?`0 0 24px ${col}55`:'none',
            transition:'color 0.5s',animation:pulse?'pop 0.5s ease-out':'none'}}>
            {result?(score>0?`+${score}`:score):'—'}
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:17,fontWeight:800,color:result?col:'#374151'}}>{verdict??'AWAITING ANALYSIS'}</div>
            {result?.momOverride?.includes('YES')&&(
              <div style={{fontSize:11,color:'#F59E0B',marginTop:2}}>⚡ Momentum override active</div>
            )}
            <ScoreGauge score={score}/>
          </div>
        </div>
        {result?.lotsStr&&<div style={{fontSize:11,color:'#9CA3AF',marginTop:4}}>
          📊 {result.lotsStr}
        </div>}
      </div>

      {/* VERDICT + DUAL SETUP */}
      {result&&verdict&&isEntryVerdict(verdict)&&(
        <div style={{...card,background:vm.bg,border:`1px solid ${vm.c}30`}}>
          <div style={{fontSize:18,fontWeight:800,color:vm.c}}>{vm.e} {verdict}</div>
          <div style={{fontSize:12,color:`${vm.c}CC`,marginTop:4}}>
            AUTO-TRADE: <span style={{fontWeight:700,color:result.autoTrade?.toUpperCase().includes('YES')?'#10B981':'#6B7280'}}>
              {result.autoTrade||'—'}
            </span>
          </div>

          {/* Trade mode selector */}
          <div style={{display:'flex',gap:6,marginTop:10}}>
            {['quick','swing'].map(m=>(
              <button key={m} onClick={()=>setTradeMode(m)} style={{
                padding:'5px 14px',borderRadius:6,border:`1px solid ${tradeMode===m?vm.c:'rgba(255,255,255,0.1)'}`,
                background:tradeMode===m?`${vm.c}20`:'transparent',
                color:tradeMode===m?vm.c:'#6B7280',fontSize:11,fontWeight:700,cursor:'pointer',
                textTransform:'uppercase',letterSpacing:'0.06em'}}>
                {m==='quick'?'⚡ Quick (+15-20 pts)':'🎯 Swing (+100 pts)'}
              </button>
            ))}
          </div>

          {tradeMode==='quick'&&<SetupCard
            title="⚡ QUICK SETUP — Scalp +15–20 pts"
            color={vm.c} symbol={result.quickSymbol}
            entryL={result.quickEntryL} entryH={result.quickEntryH}
            sl={result.quickSl} lots={result.ivpVal>70?'reduced':'full'} liveF={md.liveF}/>}
          {tradeMode==='swing'&&<SetupCard
            title="🎯 SWING SETUP — Positional +100 pts"
            color={vm.c} symbol={result.swingSymbol||result.quickSymbol}
            entryL={result.swingEntryL||result.quickEntryL} entryH={result.swingEntryH||result.quickEntryH}
            sl={result.swingSl||result.quickSl} lots={result.ivpVal>70?'reduced':'full'} liveF={md.liveF}/>}
        </div>
      )}

      {result&&verdict&&!isEntryVerdict(verdict)&&(
        <div style={{...card,background:'rgba(245,158,11,0.08)',border:'1px solid rgba(245,158,11,0.22)'}}>
          <div style={{fontSize:16,fontWeight:800,color:'#F59E0B'}}>⚠️ {verdict}</div>
          <div style={{fontSize:12,color:'#9CA3AF',marginTop:6}}>LEAN signals are STAY OUT — wait for ENTRY or STRONG ENTRY verdict</div>
        </div>
      )}

      {/* MANUAL EXECUTE PROMPT — shows when auto-trade OFF but signal fires */}
      {pendingSignal&&!atOn&&!position&&(
        <div style={{...card,background:'rgba(99,102,241,0.15)',border:'2px solid #6366F1'}}>
          <div style={{fontSize:15,fontWeight:800,color:'#A5B4FC'}}>🚨 STRONG SIGNAL — Execute?</div>
          <div style={{fontSize:12,color:'#C7D2FE',marginTop:4}}>
            Score {pendingSignal.score>0?'+':''}{pendingSignal.score} · {pendingSignal.verdict}
            <br/>{tradeMode==='quick'?pendingSignal.quickSymbol:pendingSignal.swingSymbol||pendingSignal.quickSymbol}
            {' '}@ ₹{(tradeMode==='quick'?pendingSignal.quickEntryH:pendingSignal.swingEntryH||pendingSignal.quickEntryH)?.toFixed(0)}
            <br/>SL: 50% of premium · GTT set automatically
          </div>
          <div style={{display:'flex',gap:8,marginTop:10}}>
            <button onClick={()=>executeTrade(pendingSignal,tradeMode)}
              style={{flex:1,padding:'10px',borderRadius:8,border:'none',background:'#6366F1',
                color:'#fff',fontWeight:700,fontSize:13,cursor:'pointer'}}>
              ⚡ EXECUTE {tradeMode.toUpperCase()} TRADE
            </button>
            <button onClick={()=>setPendingSignal(null)}
              style={{padding:'10px 14px',borderRadius:8,border:'1px solid rgba(255,255,255,0.1)',
                background:'transparent',color:'#6B7280',fontSize:12,cursor:'pointer'}}>
              Skip
            </button>
          </div>
        </div>
      )}

      {/* ERROR */}
      {/* Rule 5: OI Flip-Flop Warning */}
      {oiFlipWarn&&(
        <div style={{...card,background:'rgba(245,158,11,0.08)',border:'1px solid rgba(245,158,11,0.3)'}}>
          <div style={{color:'#F59E0B',fontWeight:700,fontSize:12}}>⚠️ OI FLIP-FLOP DETECTED</div>
          <div style={{color:'#9CA3AF',fontSize:11,marginTop:4}}>Call/Put walls shifted 2+ times — PCR/OI signal (F2) unreliable. Treat F2 as neutral.</div>
        </div>
      )}

      {/* Rule 8: Afternoon Fade Warning */}
      {afFade&&position&&(
        <div style={{...card,background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.3)'}}>
          <div style={{color:'#EF4444',fontWeight:700,fontSize:12}}>🌇 AFTERNOON FADE ACTIVE</div>
          <div style={{color:'#9CA3AF',fontSize:11,marginTop:4}}>After 12:30 IST + 150pt rally + bearish turn — SL tightened to 30% premium.</div>
        </div>
      )}

      {/* Rule 6: Anti-FOMO Cooldown */}
      {lastExit&&(()=>{const elapsed=Date.now()-lastExit.time;const left=Math.ceil((30*60*1000-elapsed)/60000);return left>0&&(
        <div style={{...card,background:'rgba(99,102,241,0.06)',border:'1px solid rgba(99,102,241,0.2)'}}>
          <div style={{color:'#A5B4FC',fontWeight:700,fontSize:12}}>🕐 ANTI-FOMO COOLDOWN: {left}min</div>
          <div style={{color:'#9CA3AF',fontSize:11,marginTop:4}}>No re-entry in {lastExit.dir} direction for {left} more minute{left!==1?'s':''}.</div>
        </div>
      )})()}

      {/* Rule 9: Capital Preservation */}
      {cpMode&&(
        <div style={{...card,background:cpHard?'rgba(239,68,68,0.12)':'rgba(245,158,11,0.08)',border:`1px solid ${cpHard?'rgba(239,68,68,0.4)':'rgba(245,158,11,0.3)'}`}}>
          <div style={{color:cpHard?'#EF4444':'#F59E0B',fontWeight:800,fontSize:13}}>
            {cpHard?'🛑 HARD STOP — CAPITAL PRESERVATION':'⛔ CAPITAL PRESERVATION MODE'}
          </div>
          <div style={{color:'#9CA3AF',fontSize:11,marginTop:4}}>
            {cpHard?'Drawdown >30% — all entries blocked + positions exited.':'Drawdown >20% — new entries blocked. Manage existing positions only.'}
          </div>
        </div>
      )}

      {result?.kiteErr&&(
            <div style={{background:'rgba(251,191,36,0.1)',border:'1px solid rgba(251,191,36,0.3)',borderRadius:8,padding:'10px 14px',marginBottom:12}}>
              <div style={{color:'#FBB724',fontWeight:700,fontSize:12}}>⚠️ Kite API error (HTTP {result.kiteHttpStatus}): {result.kiteErr}</div>
              <div style={{color:'#9CA3AF',fontSize:11,marginTop:4}}>Quote data unavailable. Check Kite Connect subscription or tap Logout → re-login.</div>
            </div>
          )}
      {err&&(
        <div style={{...card,background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.25)'}}>
          <div style={{fontSize:13,color:'#F87171',fontWeight:700,marginBottom:6}}>⚠ {err}</div>
          {(err.includes('401')||err.includes('expired')||err.includes('pattern')||err.includes('session')||err.includes('token'))&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:'#6B7280',marginBottom:8}}>Kite session expired. Tokens reset daily at midnight IST.</div>
              <button onClick={logout} style={{padding:'8px 16px',borderRadius:7,border:'none',background:'#6366F1',color:'#fff',fontWeight:700,fontSize:12,cursor:'pointer'}}>🔗 Re-login with Kite</button>
            </div>
          )}
          {errDetail&&(
            <div style={{marginTop:8,background:'#0A0A14',borderRadius:6,padding:10,border:'1px solid rgba(239,68,68,0.15)'}}>
              <div style={{fontSize:9,color:'#4B5563',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:6,fontWeight:700}}>
                Full Error Detail (send to Claude for debugging):
              </div>
              <pre style={{fontSize:10,color:'#F87171',whiteSpace:'pre-wrap',wordBreak:'break-all',margin:0,maxHeight:200,overflowY:'auto',fontFamily:'monospace',lineHeight:1.5}}>
                {errDetail}
              </pre>
              <button onClick={()=>navigator.clipboard?.writeText(errDetail).catch(()=>{})}
                style={{marginTop:8,padding:'5px 10px',borderRadius:5,border:'1px solid rgba(239,68,68,0.3)',background:'transparent',color:'#F87171',fontSize:10,cursor:'pointer'}}>
                📋 Copy error
              </button>
            </div>
          )}
        </div>
      )}

      {/* ORDER MESSAGE */}
      {orderMsg&&(
        <div style={{...card,padding:'10px 16px',background:'rgba(99,102,241,0.08)',border:'1px solid rgba(99,102,241,0.25)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span style={{fontSize:12,color:'#A5B4FC'}}>{orderMsg}</span>
          <button onClick={()=>setOrderMsg(null)} style={{fontSize:14,color:'#374151',background:'none',border:'none',cursor:'pointer'}}>✕</button>
        </div>
      )}

      {/* ANALYSE BUTTON */}
      <div style={{padding:'8px 12px'}}>
        <button onClick={()=>!stopped&&!busy&&analyse()} disabled={busy||stopped}
          style={{width:'100%',padding:16,borderRadius:10,border:'none',
            fontWeight:700,fontSize:16,letterSpacing:'0.05em',
            cursor:busy||stopped?'not-allowed':'pointer',
            background:busy||stopped?'#141424':'#6366F1',
            color:busy||stopped?'#374151':'#fff',transition:'all 0.2s',
            boxShadow:busy||stopped?'none':'0 0 20px rgba(99,102,241,0.4)'}}>
          {busy
            ? `⟳  ANALYSING… ${Math.floor(elapsed/60)>0?Math.floor(elapsed/60)+'m ':''}${elapsed%60}s elapsed`
            : stopped?'🛑 STOPPED':'⚡  ANALYSE NOW (Kite + AI)'}
        </button>
      </div>

      {/* AUTO ANALYSIS */}
      <div style={card}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontWeight:700,fontSize:14}}>Auto Analysis</div>
            <div style={{fontSize:11,color:'#4B5563'}}>Market hours only (9:15–3:30 IST)</div>
          </div>
          <Toggle on={autoOn&&!stopped} set={v=>setAutoOn(v)} disabled={stopped}/>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8,marginTop:10}}>
          <span style={{fontSize:11,color:'#4B5563',flexShrink:0}}>Interval:</span>
          {[5,10,15,20,30].map(m=>(
            <button key={m} onClick={()=>!stopped&&setAutoIntervalMin(m)}
              disabled={stopped}
              style={{padding:'4px 10px',borderRadius:6,border:`1px solid ${autoIntervalMin===m?'#6366F1':'rgba(255,255,255,0.08)'}`,
                background:autoIntervalMin===m?'rgba(99,102,241,0.2)':'transparent',
                color:autoIntervalMin===m?'#A5B4FC':'#4B5563',fontSize:11,fontWeight:700,
                cursor:stopped?'not-allowed':'pointer'}}>
              {m}m
            </button>
          ))}
        </div>
        {autoOn&&!stopped&&(
          <div style={{marginTop:10}}>
            {!mktOpen?(
              <div style={{fontSize:11,color:'#F59E0B',background:'rgba(245,158,11,0.08)',padding:'8px 12px',borderRadius:6,textAlign:'center'}}>
                ⏸ Market closed — auto-analysis paused. Resumes at 9:15 AM IST.
              </div>
            ):(
              <>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#4B5563',marginBottom:4}}>
                  <span>Next analysis in</span>
                  <span style={{color:'#F59E0B',...mono,fontWeight:700}}>
                    {cd>0?`${Math.floor(cd/60)}:${String(cd%60).padStart(2,'0')}`:'—'}
                  </span>
                </div>
                <div style={{height:3,background:'#1E2030',borderRadius:2}}>
                  <div style={{height:'100%',borderRadius:2,background:'linear-gradient(to right,#6366F1,#8B5CF6)',width:`${((600-cd)/600)*100}%`,transition:'width 1s linear'}}/>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* SCORECARD */}
      {result&&(
        <div style={card}>
          <div style={sec}>10-Factor Scorecard</div>
          {FACTORS.map(({key,label})=>{
            const v=sc[key]??0; const c=v>0?'#10B981':v<0?'#EF4444':'#374151'
            return (
              <div key={key} style={{display:'flex',alignItems:'center',padding:'5px 0',borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
                <div style={{flex:1,fontSize:12,color:'#9CA3AF'}}>{label}</div>
                <FactorBar value={v}/>
                <div style={{width:28,textAlign:'right',...mono,fontSize:12,color:c,marginLeft:6}}>{v>0?`+${v}`:v}</div>
              </div>
            )
          })}
          <div style={{display:'flex',justifyContent:'space-between',paddingTop:8,borderTop:'1px solid rgba(255,255,255,0.08)',marginTop:4}}>
            <span style={{fontSize:12,fontWeight:700,color:'#9CA3AF'}}>TOTAL</span>
            <span style={{...mono,fontWeight:900,fontSize:16,color:col}}>{score>0?`+${score}`:score} / ±30</span>
          </div>
        </div>
      )}

      {/* FULL ANALYSIS */}
      {result?.analysis&&(
        <div style={card}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={sec}>Full Analysis</div>
            <button onClick={()=>setShowFull(p=>!p)} style={{fontSize:11,color:'#6366F1',background:'none',border:'none',cursor:'pointer'}}>
              {showFull?'▲ Collapse':'▼ Expand'}
            </button>
          </div>
          {showFull&&<pre style={{fontSize:11,color:'#9CA3AF',whiteSpace:'pre-wrap',wordBreak:'break-word',lineHeight:1.6,marginTop:6,fontFamily:'monospace',maxHeight:600,overflowY:'auto'}}>{result.analysis}</pre>}
        </div>
      )}

      {/* AUTO-TRADE */}
      <div style={card}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div>
            <div style={{fontWeight:700,fontSize:14}}>Auto-Trade</div>
            <div style={{fontSize:11,color:'#4B5563'}}>
              ±{AUTO_TRADE_CE} threshold · 50% premium SL · IVP sizing · Max 2/day · Cut-off 1:45 IST
            </div>
          </div>
          <Toggle on={atOn&&!stopped} set={v=>setAtOn(v)} disabled={stopped} color="#EF4444"/>
        </div>

        {/* Trade mode toggle */}
        <div style={{display:'flex',gap:6,marginBottom:10}}>
          {['quick','swing'].map(m=>(
            <button key={m} onClick={()=>setTradeMode(m)} style={{
              flex:1,padding:'7px',borderRadius:7,border:`1px solid ${tradeMode===m?'#6366F1':'rgba(255,255,255,0.08)'}`,
              background:tradeMode===m?'rgba(99,102,241,0.15)':'transparent',
              color:tradeMode===m?'#A5B4FC':'#4B5563',fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {m==='quick'?'⚡ Quick (scalp)':'🎯 Swing (positional)'}
            </button>
          ))}
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          <StatCard label="Today Trades" value={String(dailyTrades)} color={dailyTrades>=2?'#EF4444':'#E8E8F8'} small/>
          <StatCard label="CE Trigger" value={`+${AUTO_TRADE_CE}`} color="#10B981" small/>
          <StatCard label="PE Trigger" value={String(AUTO_TRADE_PE)} color="#EF4444" small/>
        </div>
        {startCapital&&md.liveF&&(
          <div style={{marginTop:8,padding:'8px 10px',borderRadius:8,background:'#0A0A18',fontSize:11}}>
            <div style={{display:'flex',justifyContent:'space-between',color:'#6B7280'}}>
              <span>Starting capital</span><span style={{color:'#E8E8F8',fontFamily:'monospace'}}>₹{startCapital.toFixed(0)}</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',color:'#6B7280',marginTop:2}}>
              <span>P&L today</span>
              <span style={{color:(md.liveF-startCapital)>=0?'#10B981':'#EF4444',fontFamily:'monospace'}}>
                {(md.liveF-startCapital)>=0?'+':''}₹{(md.liveF-startCapital).toFixed(0)}
                {' '}({(((md.liveF-startCapital)/startCapital)*100).toFixed(1)}%)
              </span>
            </div>
            <div style={{marginTop:4,height:3,background:'#1E2030',borderRadius:2}}>
              <div style={{height:'100%',borderRadius:2,
                background:(md.liveF-startCapital)>=0?'#10B981':'#EF4444',
                width:`${Math.min(100,Math.abs(((md.liveF-startCapital)/startCapital)*100/12)*100)}%`}}/>
            </div>
            <div style={{fontSize:10,color:'#374151',marginTop:2}}>Daily loss limit: ₹1,000 or 12% of capital</div>
          </div>
        )}

        {atOn&&!stopped&&result&&!position&&isAutoTrigger(score)&&result.autoTrade?.toUpperCase().includes('YES')&&(
          <div style={{marginTop:12,padding:12,borderRadius:8,background:'rgba(99,102,241,0.14)',border:'1px solid #6366F180'}}>
            <div style={{fontWeight:800,color:'#A5B4FC',fontSize:14}}>🚨 AUTO-TRADE EXECUTING…</div>
            <div style={{fontSize:12,color:'#C7D2FE',marginTop:4}}>{result.autoTrade}</div>
          </div>
        )}

        {position&&(
          <div style={{marginTop:12,padding:12,borderRadius:8,
            background:position.type==='CE'?'rgba(16,185,129,0.08)':'rgba(239,68,68,0.08)',
            border:`1px solid ${position.type==='CE'?'#10B98135':'#EF444435'}`}}>
            <div style={{fontWeight:800,fontSize:14,color:position.type==='CE'?'#10B981':'#EF4444'}}>
              {position.mode?.toUpperCase()||'OPEN'} · {position.type} {position.sym}
            </div>
            <div style={{fontSize:11,color:'#6B7280',marginTop:4}}>
              Entry ₹{position.entry?.toFixed(2)} · SL ₹{position.sl?.toFixed(2)} (50%) · Qty {position.qty||LOT_SIZE} · OID {position.orderId}
            </div>
            <div style={{fontSize:11,color:'#374151',marginTop:2}}>
              Loss if SL hits: ₹{((position.entry-position.sl)*LOT_SIZE).toFixed(0)} total
            </div>
            <button onClick={()=>{setTradeLog(l=>[{...position,action:'EXIT (Manual) 🔄',exitTime:new Date()},...l.slice(0,29)]);setLastExit({dir:position.type,time:Date.now()});setEntrySnapshot(null);setPosition(null)}}
              style={{marginTop:8,padding:'6px 12px',borderRadius:6,border:'1px solid rgba(255,255,255,0.1)',background:'transparent',color:'#9CA3AF',fontSize:12,cursor:'pointer'}}>
              Log Manual Exit
            </button>
          </div>
        )}
      </div>

      {/* TRADE LOG */}
      {tradeLog.length>0&&(
        <div style={card}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={sec}>Trade Log</div>
            <button onClick={()=>setTradeLog([])} style={{fontSize:10,color:'#374151',background:'none',border:'none',cursor:'pointer'}}>CLEAR</button>
          </div>
          {tradeLog.map((t,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:'1px solid rgba(255,255,255,0.04)',fontSize:11,gap:4,flexWrap:'wrap'}}>
              <span style={{color:t.action?.includes('BUY')?'#10B981':'#F59E0B',fontWeight:700}}>{t.action}</span>
              <span style={{color:'#9CA3AF',...mono}}>{t.type} {t.sym}</span>
              <span style={{color:'#4B5563',...mono}}>{fT(t.exitTime||t.time)}</span>
            </div>
          ))}
        </div>
      )}

      {/* COST TRACKER */}
      <div style={card}>
        <div style={sec}>API Cost Tracker</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginTop:4}}>
          <StatCard label="Calls" value={String(calls)} small/>
          <StatCard label="Total" value={fR(totalCost)} small/>
          <StatCard label="Per Call" value={calls>0?fR(cpc):'—'} small/>
          <StatCard label="Tokens" value={`${((inTok+outTok)/1000).toFixed(1)}K`} small/>
        </div>
        {calls>0&&<div style={{marginTop:10,padding:'10px 12px',background:'#0A0A18',borderRadius:8,fontSize:11}}>
          <div style={{color:'#4B5563',marginBottom:6,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',fontSize:9}}>DAILY PROJECTION</div>
          <div style={{display:'flex',justifyContent:'space-between',color:'#6B7280'}}>
            <span>Manual (6/day)</span><span style={{...mono,color:'#F59E0B'}}>{fR(cpc*6)}/day</span>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',color:'#6B7280',marginTop:3}}>
            <span>Auto 10-min (39/day)</span><span style={{...mono,color:'#F59E0B'}}>{fR(cpc*39)}/day</span>
          </div>
        </div>}
      </div>

      {/* EMERGENCY STOP */}
      <div style={{padding:'4px 12px 28px'}}>
        {stopped
          ?<button onClick={resume} style={{width:'100%',padding:16,borderRadius:10,border:'none',background:'#10B981',color:'#fff',fontWeight:700,fontSize:14,cursor:'pointer',boxShadow:'0 0 18px rgba(16,185,129,0.3)'}}>✅ RESUME OPERATIONS</button>
          :<button onClick={stop} style={{width:'100%',padding:16,borderRadius:10,border:'none',background:'#EF4444',color:'#fff',fontWeight:700,fontSize:14,cursor:'pointer',boxShadow:'0 0 20px rgba(239,68,68,0.35)'}}>🛑 EMERGENCY STOP — HALT ALL</button>
        }
        <div style={{fontSize:11,color:'#374151',textAlign:'center',marginTop:6}}>Halts all analysis, auto-trade, and order placement immediately</div>
      </div>

      <style>{`@keyframes pop{0%{transform:scale(1)}50%{transform:scale(1.1)}100%{transform:scale(1)}}`}</style>
    </div>
  )
}
