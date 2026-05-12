import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

// ── Constants ──────────────────────────────────────────────────────────────────
const AUTO_INTERVAL_MS = 10 * 60 * 1000   // 10 minutes
const COST_IN  = 3  / 1_000_000 * 90      // ₹ per input token
const COST_OUT = 15 / 1_000_000 * 90      // ₹ per output token
const LOT_SIZE = 65
const AUTO_TRADE_CE  = 10
const AUTO_TRADE_PE  = -10
const STOP_LOSS_RS   = 2000
const FACTORS = [
  { key:'f1',  label:'VIX Analysis'    },
  { key:'f2',  label:'PCR & OI'        },
  { key:'f3',  label:'Intraday Action' },
  { key:'f4',  label:'Daily Trend'     },
  { key:'f5',  label:'Sectoral Health' },
  { key:'f6',  label:'FII / DII'       },
  { key:'f7',  label:'Market Breadth'  },
  { key:'f8',  label:'Global Cues'     },
  { key:'f9',  label:'IV & Greeks'     },
  { key:'f10', label:'Event Risk'      },
]

// ── Helpers ────────────────────────────────────────────────────────────────────
const scoreColor = s =>
  s >= 10 ? '#10B981' : s >= 6 ? '#34D399' : s >= 2 ? '#86EFAC' :
  s >= -1 ? '#F59E0B' : s >= -5 ? '#F87171' : s >= -9 ? '#EF4444' : '#DC2626'

const verdictMeta = v => {
  if (!v) return { c:'#6366F1', bg:'rgba(99,102,241,0.08)', e:'⏳' }
  if (v.includes('STRONG ENTRY CE')) return { c:'#10B981', bg:'rgba(16,185,129,0.12)', e:'🚀' }
  if (v.includes('ENTRY CE'))         return { c:'#34D399', bg:'rgba(52,211,153,0.10)', e:'🟢' }
  if (v.includes('LEAN CE'))          return { c:'#86EFAC', bg:'rgba(134,239,172,0.08)', e:'📈' }
  if (v.includes('STRONG ENTRY PE')) return { c:'#EF4444', bg:'rgba(239,68,68,0.12)', e:'🔻' }
  if (v.includes('ENTRY PE'))         return { c:'#F87171', bg:'rgba(248,113,113,0.10)', e:'🔴' }
  if (v.includes('LEAN PE'))          return { c:'#FCA5A5', bg:'rgba(252,165,165,0.08)', e:'📉' }
  return { c:'#F59E0B', bg:'rgba(245,158,11,0.08)', e:'⚠️' }
}

const fI  = n => n != null ? Number(n).toLocaleString('en-IN') : '—'
const fR  = n => `₹${Number(n || 0).toFixed(2)}`
const fT  = d => d ? d.toLocaleTimeString('en-IN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'
const fTs = s => s ? new Date(s).toLocaleTimeString('en-IN',{hour12:false,hour:'2-digit',minute:'2-digit'}) : '—'

// Check if market is open (9:15–15:30 IST Mon–Fri)
function isMarketOpen() {
  const now = new Date()
  const ist = new Date(now.getTime() + 5.5 * 3600000)
  const day = ist.getDay()
  if (day === 0 || day === 6) return false
  const h = ist.getHours(), m = ist.getMinutes()
  const mins = h * 60 + m
  return mins >= 9*60+15 && mins < 15*60+30
}

function isAutoTradeAllowed() {
  const now = new Date()
  const ist = new Date(now.getTime() + 5.5 * 3600000)
  const h = ist.getHours(), m = ist.getMinutes()
  return h * 60 + m <= 13 * 60 + 45  // before 1:45 PM IST
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function ScoreGauge({ score }) {
  const pct = Math.max(0, Math.min(100, ((score + 15) / 30) * 100))
  const c   = scoreColor(score)
  return (
    <div style={{ margin:'10px 0 4px' }}>
      <div style={{ height:6, borderRadius:3, background:'linear-gradient(to right,#DC2626,#EF4444 20%,#F59E0B 50%,#34D399 80%,#10B981)', position:'relative' }}>
        <div style={{
          position:'absolute', left:`${pct}%`, top:'50%', transform:'translate(-50%,-50%)',
          width:18, height:18, borderRadius:'50%', background:c, border:'3px solid #07070F',
          boxShadow:`0 0 12px ${c}99`, transition:'left 0.9s cubic-bezier(.34,1.56,.64,1)'
        }} />
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontSize:10, color:'#374151', fontFamily:'monospace' }}>
        {['-15','-10','-5','0','+5','+10','+15'].map(l => <span key={l}>{l}</span>)}
      </div>
    </div>
  )
}

function FactorBar({ value }) {
  const c = value > 0 ? '#10B981' : value < 0 ? '#EF4444' : '#374151'
  return (
    <div style={{ display:'flex', gap:2, alignItems:'center' }}>
      {[-3,-2,-1,0,1,2,3].map(b => (
        <div key={b} style={{
          width:12, height:12, borderRadius:2,
          background:
            (value < 0 && b >= value && b < 0) ? c :
            (value > 0 && b <= value && b > 0) ? c :
            b === 0 ? '#1E2030' : '#111120',
          border: b === 0 ? '1px solid #2D3048' : 'none',
          opacity: Math.abs(b) <= Math.abs(value) || b === 0 ? 1 : 0.3,
        }} />
      ))}
    </div>
  )
}

function Toggle({ on, set, disabled, color='#10B981' }) {
  return (
    <button onClick={() => !disabled && set(!on)} style={{
      width:52, height:28, borderRadius:14, border:'none', padding:0, flexShrink:0,
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: on && !disabled ? color : '#1E2030',
      position:'relative', transition:'background 0.3s', opacity: disabled ? 0.45 : 1
    }}>
      <div style={{
        position:'absolute', top:3, left: on && !disabled ? 27 : 3,
        width:22, height:22, borderRadius:'50%',
        background:'#fff', transition:'left 0.3s', boxShadow:'0 1px 4px rgba(0,0,0,0.5)'
      }} />
    </button>
  )
}

function StatCard({ label, value, sub, color='#E8E8F8', small=false }) {
  return (
    <div style={{ background:'#111120', borderRadius:8, padding:'9px 10px' }}>
      <div style={{ fontSize:9, color:'#4B5563', textTransform:'uppercase', letterSpacing:'0.09em', fontWeight:700 }}>{label}</div>
      <div style={{ fontSize:small?13:17, fontWeight:700, fontFamily:'monospace', color, marginTop:3, lineHeight:1 }}>{value}</div>
      {sub && <div style={{ fontSize:10, fontFamily:'monospace', color:'#6B7280', marginTop:2 }}>{sub}</div>}
    </div>
  )
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate()
  const [result,    setResult]    = useState(null)
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState(null)
  const [autoOn,    setAutoOn]    = useState(false)
  const [atOn,      setAtOn]      = useState(false)
  const [stopped,   setStopped]   = useState(false)
  const [position,  setPosition]  = useState(null)
  const [tradeLog,  setTradeLog]  = useState([])
  const [inTok,     setInTok]     = useState(0)
  const [outTok,    setOutTok]    = useState(0)
  const [calls,     setCalls]     = useState(0)
  const [cd,        setCd]        = useState(600)          // countdown seconds
  const [pulse,     setPulse]     = useState(false)
  const [showFull,  setShowFull]  = useState(false)
  const [orderMsg,  setOrderMsg]  = useState(null)
  const [dailyTrades, setDailyTrades] = useState(0)

  const atRef  = useRef(atOn)
  const posRef = useRef(position)
  const intRef = useRef(null)
  const cdRef  = useRef(null)
  useEffect(() => { atRef.current  = atOn },     [atOn])
  useEffect(() => { posRef.current = position }, [position])

  const accessToken = localStorage.getItem('kite_access_token')
  const userName    = localStorage.getItem('kite_user_name') || 'Trader'

  const totalCost  = inTok * COST_IN + outTok * COST_OUT
  const cpc        = calls > 0 ? totalCost / calls : 0
  const dailyCostM = cpc * 6 * 6   // ~6 analyses/hr × 6.5 hr session ≈ 39/day

  // ── Logout ─────────────────────────────────────────────────────────────────
  const logout = () => {
    localStorage.clear()
    navigate('/login')
  }

  // ── Auto-execute trade ──────────────────────────────────────────────────────
  const executeAutoTrade = useCallback(async (r) => {
    if (!atRef.current) return
    if (!isAutoTradeAllowed()) { setOrderMsg('⏰ Auto-trade blocked — after 1:45 PM IST'); return }
    if (dailyTrades >= 2) { setOrderMsg('📊 Daily limit: 2 auto-trades reached'); return }
    const score   = r.score
    const cur     = posRef.current
    const autoStr = r.autoTrade || ''

    // Entry signal
    if (!cur && autoStr.toUpperCase().includes('YES')) {
      const type   = score >= AUTO_TRADE_CE ? 'CE' : 'PE'
      const sym    = r.tradeSymbol
      if (!sym) { setOrderMsg('⚠️ No symbol for auto-trade'); return }

      try {
        const res = await fetch('/api/place-order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken,
            tradingsymbol:   sym,
            transactionType: 'BUY',
            quantity:        LOT_SIZE,
          })
        })
        const data = await res.json()
        if (data.orderId) {
          const entry = r.entryHigh || 0
          const sl    = entry - (STOP_LOSS_RS / LOT_SIZE)
          const t     = { type, sym, entry, sl, orderId: data.orderId, time: new Date(), score }
          setPosition(t)
          setTradeLog(l => [{ ...t, action:`AUTO BUY ${type} ✅` }, ...l.slice(0,29)])
          setDailyTrades(p => p + 1)
          setOrderMsg(`✅ Auto-bought ${type} ${sym} @ market (OID: ${data.orderId})`)
        } else {
          setOrderMsg(`⚠️ Order failed: ${data.error || 'Unknown'}`)
        }
      } catch (e) {
        setOrderMsg(`⚠️ Trade error: ${e.message}`)
      }
    }

    // Exit signal (score flipped direction)
    if (cur) {
      const exitCE = cur.type === 'CE' && score <= 0
      const exitPE = cur.type === 'PE' && score >= 0
      if (exitCE || exitPE) {
        try {
          const res = await fetch('/api/place-order', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessToken,
              tradingsymbol:   cur.sym,
              transactionType: 'SELL',
              quantity:        LOT_SIZE,
            })
          })
          const data = await res.json()
          const action = data.orderId ? `AUTO EXIT ✅ OID:${data.orderId}` : `EXIT FAILED: ${data.error}`
          setTradeLog(l => [{ ...cur, action, exitTime: new Date() }, ...l.slice(0,29)])
          setPosition(null)
          setOrderMsg(data.orderId ? `✅ Auto-exited ${cur.type} ${cur.sym}` : `⚠️ Exit failed: ${data.error}`)
        } catch (e) {
          setOrderMsg(`⚠️ Exit error: ${e.message}`)
        }
      }
    }
  }, [accessToken, dailyTrades])

  // ── Core analysis ────────────────────────────────────────────────────────────
  const analyse = useCallback(async () => {
    if (busy || stopped) return
    setBusy(true)
    setErr(null)
    setPulse(true)
    setTimeout(() => setPulse(false), 700)

    try {
      const res  = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken })
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || `API error (${res.status})`)
      }

      setResult(data)
      setInTok(p => p + (data.usage?.inputTokens  || 0))
      setOutTok(p => p + (data.usage?.outputTokens || 0))
      setCalls(p => p + 1)

      if (atRef.current) {
        await executeAutoTrade(data)
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }, [busy, stopped, accessToken, executeAutoTrade])

  // ── Auto-analysis loop ───────────────────────────────────────────────────────
  useEffect(() => {
    if (autoOn && !stopped) {
      analyse()
      setCd(AUTO_INTERVAL_MS / 1000)
      cdRef.current  = setInterval(() => setCd(p => p > 1 ? p - 1 : AUTO_INTERVAL_MS / 1000), 1000)
      intRef.current = setInterval(() => { analyse(); setCd(AUTO_INTERVAL_MS / 1000) }, AUTO_INTERVAL_MS)
    } else {
      clearInterval(intRef.current)
      clearInterval(cdRef.current)
    }
    return () => { clearInterval(intRef.current); clearInterval(cdRef.current) }
  }, [autoOn, stopped]) // eslint-disable-line

  const stop   = () => { setStopped(true); setAutoOn(false); setAtOn(false); clearInterval(intRef.current); clearInterval(cdRef.current) }
  const resume = () => setStopped(false)

  // ── Derived ──────────────────────────────────────────────────────────────────
  const score  = result?.score   ?? 0
  const verdict = result?.verdict ?? null
  const vm     = verdictMeta(verdict)
  const col    = scoreColor(score)
  const md     = result?.marketData ?? {}
  const sc     = result?.scores    ?? {}
  const mktOpen = isMarketOpen()

  // ── Styles ───────────────────────────────────────────────────────────────────
  const card  = { background:'#0D0D1C', border:'1px solid rgba(255,255,255,0.07)', borderRadius:12, padding:'14px 16px', margin:'8px 12px' }
  const lbl   = { fontSize:10, color:'#4B5563', letterSpacing:'0.09em', textTransform:'uppercase', fontWeight:700 }
  const mono  = { fontFamily:"'Courier New',monospace" }
  const sec   = { fontSize:10, color:'#374151', letterSpacing:'0.12em', textTransform:'uppercase', fontWeight:700, paddingBottom:6 }

  return (
    <div style={{ minHeight:'100vh', background:'#07070F', color:'#E0E0F0', fontFamily:"'Segoe UI','SF Pro Display',sans-serif", paddingBottom:80, maxWidth:520, margin:'0 auto' }}>

      {/* ── HEADER ── */}
      <div style={{ background:'linear-gradient(135deg,#0D0D1C,#070710)', borderBottom:'1px solid rgba(255,255,255,0.06)', padding:'12px 16px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <div style={{ fontSize:13, color:'#6366F1', fontWeight:800, letterSpacing:'0.14em' }}>NIFTY OPTIONS ANALYST</div>
            <div style={{ fontSize:11, color:'#374151', marginTop:1 }}>
              {mktOpen ? '🟢 Market Open' : '🔴 Market Closed'} · {userName}
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ textAlign:'right' }}>
              <div style={{ display:'flex', alignItems:'center', gap:5, justifyContent:'flex-end' }}>
                <div style={{ width:7, height:7, borderRadius:'50%',
                  background: stopped?'#EF4444': busy?'#6366F1': autoOn?'#10B981':'#F59E0B',
                  boxShadow:`0 0 7px ${stopped?'#EF4444':busy?'#6366F1':autoOn?'#10B981':'#F59E0B'}` }} />
                <span style={{ fontSize:11, color:'#6B7280' }}>
                  {stopped?'STOPPED':busy?'THINKING':autoOn?'AUTO':'MANUAL'}
                </span>
              </div>
              <div style={{ fontSize:10, color:'#374151', marginTop:1 }}>{result?.sgt ?? '—'}</div>
            </div>
            <button onClick={logout} style={{ fontSize:11, color:'#374151', background:'none', border:'1px solid rgba(255,255,255,0.06)', borderRadius:6, padding:'4px 8px', cursor:'pointer' }}>
              Logout
            </button>
          </div>
        </div>
      </div>

      {/* ── MARKET SNAPSHOT ── */}
      <div style={{ ...card, display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:8 }}>
        <StatCard label="NIFTY" value={md.spot ? fI(Math.round(md.spot)) : '——'} />
        <StatCard label="BANK NIFTY" value={md.bn ? fI(Math.round(md.bn)) : '——'} color={md.bn ? '#E8E8F8' : '#2D3048'} />
        <StatCard label="VIX" value={md.vix?.toFixed(2) ?? '——'} color={md.vix > 20 ? '#EF4444' : md.vix > 15 ? '#F59E0B' : '#10B981'} />
        <StatCard label="FUNDS" value={md.liveF ? `₹${(md.liveF/1000).toFixed(0)}K` : '——'} color="#F59E0B" />
      </div>

      <div style={{ ...card, display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:8 }}>
        <StatCard label="PCR" value={md.pcr ?? '—'} color={parseFloat(md.pcr) < 0.8 ? '#EF4444' : '#10B981'} small />
        <StatCard label="ATM" value={md.atm ? fI(md.atm) : '—'} small />
        <StatCard label="EXPIRY" value={md.expiry?.slice(5) ?? '—'} sub={md.dte != null ? `${md.dte} DTE` : ''} small />
        <StatCard label="VWAP" value={md.vwap ? fI(Math.round(md.vwap)) : '—'} small />
      </div>

      {/* ── SCORE ── */}
      <div style={card}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
          <span style={lbl}>COMPOSITE SCORE (10-FACTOR)</span>
          <span style={{ fontSize:11, color:'#4B5563' }}>
            {result?.marketData ? `Updated ${fTs(result.timestamp)}` : 'Awaiting analysis'}
          </span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16, marginTop:8 }}>
          <div style={{
            fontSize:48, fontWeight:900, ...mono, minWidth:76,
            color: result ? col : '#2D3048',
            textShadow: result ? `0 0 24px ${col}55` : 'none',
            transition:'color 0.5s',
            animation: pulse ? 'pop 0.5s ease-out' : 'none'
          }}>
            {result ? (score > 0 ? `+${score}` : score) : '—'}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:17, fontWeight:800, color: result ? col : '#374151' }}>
              {verdict ?? 'AWAITING ANALYSIS'}
            </div>
            <ScoreGauge score={score} />
          </div>
        </div>
      </div>

      {/* ── VERDICT CARD ── */}
      {result && verdict && (
        <div style={{ ...card, background:vm.bg, border:`1px solid ${vm.c}30` }}>
          <div style={{ fontSize:18, fontWeight:800, color:vm.c }}>{vm.e} {verdict}</div>
          {result.tradeSymbol && (
            <div style={{ marginTop:10 }}>
              <span style={{ background:`${vm.c}20`, color:vm.c, border:`1px solid ${vm.c}45`, padding:'4px 12px', borderRadius:5, fontSize:13, fontWeight:800, ...mono }}>
                {result.tradeSymbol}
              </span>
              {result.entryLow && result.entryHigh && (
                <span style={{ fontSize:12, color:'#6B7280', marginLeft:8 }}>
                  Entry: ₹{result.entryLow.toFixed(0)}–₹{result.entryHigh.toFixed(0)}
                </span>
              )}
            </div>
          )}
          <div style={{ marginTop:8, fontSize:12, color:`${vm.c}CC` }}>
            AUTO-TRADE: <span style={{ fontWeight:700, color: result.autoTrade?.toUpperCase().includes('YES') ? '#10B981' : '#6B7280' }}>
              {result.autoTrade || '—'}
            </span>
          </div>
        </div>
      )}

      {/* ── ERROR ── */}
      {err && (
        <div style={{ ...card, background:'rgba(239,68,68,0.07)', border:'1px solid rgba(239,68,68,0.25)' }}>
          <div style={{ fontSize:13, color:'#F87171', fontWeight:600 }}>⚠ {err}</div>
          {err.includes('401') && (
            <div style={{ fontSize:11, color:'#6B7280', marginTop:6 }}>
              Kite session expired.{' '}
              <span onClick={logout} style={{ color:'#6366F1', cursor:'pointer' }}>Re-login →</span>
            </div>
          )}
        </div>
      )}

      {/* ── ORDER MESSAGE ── */}
      {orderMsg && (
        <div style={{ ...card, padding:'10px 16px', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.25)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:12, color:'#A5B4FC' }}>{orderMsg}</span>
          <button onClick={() => setOrderMsg(null)} style={{ fontSize:14, color:'#374151', background:'none', border:'none', cursor:'pointer' }}>✕</button>
        </div>
      )}

      {/* ── ANALYSE BUTTON ── */}
      <div style={{ padding:'8px 12px' }}>
        <button
          onClick={() => !stopped && !busy && analyse()}
          disabled={busy || stopped}
          style={{
            width:'100%', padding:16, borderRadius:10, border:'none',
            fontWeight:700, fontSize:16, letterSpacing:'0.05em',
            cursor: busy||stopped ? 'not-allowed' : 'pointer',
            background: busy||stopped ? '#141424' : '#6366F1',
            color: busy||stopped ? '#374151' : '#fff',
            transition:'all 0.2s',
            boxShadow: busy||stopped ? 'none' : '0 0 20px rgba(99,102,241,0.4)',
          }}
        >
          {busy ? '⟳  ANALYSING — fetching Kite + web data…' : stopped ? '🛑 STOPPED — Resume first' : '⚡  ANALYSE NOW (Kite + AI)'}
        </button>
      </div>

      {/* ── AUTO ANALYSIS ── */}
      <div style={card}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14 }}>Auto Analysis</div>
            <div style={{ fontSize:11, color:'#4B5563' }}>Every 10 minutes · Full Kite + web search</div>
          </div>
          <Toggle on={autoOn && !stopped} set={v => setAutoOn(v)} disabled={stopped} />
        </div>
        {autoOn && !stopped && (
          <div style={{ marginTop:10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#4B5563', marginBottom:4 }}>
              <span>Next analysis in</span>
              <span style={{ color:'#F59E0B', ...mono, fontWeight:700 }}>
                {Math.floor(cd/60)}:{String(cd%60).padStart(2,'0')}
              </span>
            </div>
            <div style={{ height:3, background:'#1E2030', borderRadius:2 }}>
              <div style={{ height:'100%', borderRadius:2, background:'linear-gradient(to right,#6366F1,#8B5CF6)', width:`${((600-cd)/600)*100}%`, transition:'width 1s linear' }} />
            </div>
          </div>
        )}
      </div>

      {/* ── SCORECARD ── */}
      {result && (
        <div style={card}>
          <div style={sec}>10-Factor Scorecard</div>
          {FACTORS.map(({ key, label }) => {
            const v = sc[key] ?? 0
            const c = v > 0 ? '#10B981' : v < 0 ? '#EF4444' : '#374151'
            return (
              <div key={key} style={{ display:'flex', alignItems:'center', padding:'5px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ flex:1, fontSize:12, color:'#9CA3AF' }}>{label}</div>
                <FactorBar value={v} />
                <div style={{ width:28, textAlign:'right', ...mono, fontSize:12, color:c, marginLeft:6 }}>
                  {v > 0 ? `+${v}` : v}
                </div>
              </div>
            )
          })}
          <div style={{ display:'flex', justifyContent:'space-between', paddingTop:8, borderTop:'1px solid rgba(255,255,255,0.08)', marginTop:4 }}>
            <span style={{ fontSize:12, fontWeight:700, color:'#9CA3AF' }}>TOTAL</span>
            <span style={{ ...mono, fontWeight:900, fontSize:16, color:col }}>{score > 0 ? `+${score}` : score} / ±30</span>
          </div>
        </div>
      )}

      {/* ── FULL ANALYSIS ── */}
      {result?.analysis && (
        <div style={card}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={sec}>Full Analysis</div>
            <button onClick={() => setShowFull(p => !p)} style={{ fontSize:11, color:'#6366F1', background:'none', border:'none', cursor:'pointer' }}>
              {showFull ? '▲ Collapse' : '▼ Expand'}
            </button>
          </div>
          {showFull && (
            <pre style={{ fontSize:11, color:'#9CA3AF', whiteSpace:'pre-wrap', wordBreak:'break-word', lineHeight:1.6, marginTop:6, fontFamily:'monospace', maxHeight:600, overflowY:'auto' }}>
              {result.analysis}
            </pre>
          )}
        </div>
      )}

      {/* ── AUTO-TRADE ── */}
      <div style={card}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14 }}>Auto-Trade</div>
            <div style={{ fontSize:11, color:'#4B5563' }}>
              Entry ≥+{AUTO_TRADE_CE} or ≤{AUTO_TRADE_PE} · Stop ₹{STOP_LOSS_RS}/trade · Max 2/day · Cut-off 1:45 PM IST
            </div>
          </div>
          <Toggle on={atOn && !stopped} set={v => setAtOn(v)} disabled={stopped} color="#EF4444" />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
          <StatCard label="Today Trades" value={String(dailyTrades)} color={dailyTrades >= 2 ? '#EF4444' : '#E8E8F8'} small />
          <StatCard label="CE Threshold" value={`+${AUTO_TRADE_CE}`} color="#10B981" small />
          <StatCard label="PE Threshold" value={String(AUTO_TRADE_PE)} color="#EF4444" small />
        </div>
        {atOn && !stopped && result && !position && result.autoTrade?.toUpperCase().includes('YES') && (
          <div style={{ marginTop:12, padding:12, borderRadius:8, background:'rgba(99,102,241,0.14)', border:'1px solid #6366F180' }}>
            <div style={{ fontWeight:800, color:'#A5B4FC', fontSize:14 }}>🚨 AUTO-TRADE SIGNAL FIRED</div>
            <div style={{ fontSize:12, color:'#C7D2FE', marginTop:4 }}>{result.autoTrade}</div>
          </div>
        )}
        {position && (
          <div style={{ marginTop:12, padding:12, borderRadius:8, background: position.type==='CE'?'rgba(16,185,129,0.08)':'rgba(239,68,68,0.08)', border:`1px solid ${position.type==='CE'?'#10B98135':'#EF444435'}` }}>
            <div style={{ fontWeight:800, fontSize:14, color: position.type==='CE'?'#10B981':'#EF4444' }}>
              {position.type} {position.sym}
            </div>
            <div style={{ fontSize:11, color:'#6B7280', marginTop:4 }}>
              Entry ₹{position.entry?.toFixed(2)} · SL ₹{position.sl?.toFixed(2)} · OID: {position.orderId}
            </div>
            <button onClick={() => { setTradeLog(l => [{ ...position, action:'EXIT (Manual) 🔄', exitTime:new Date() }, ...l.slice(0,29)]); setPosition(null) }}
              style={{ marginTop:8, padding:'6px 12px', borderRadius:6, border:'1px solid rgba(255,255,255,0.1)', background:'transparent', color:'#9CA3AF', fontSize:12, cursor:'pointer' }}>
              Log Manual Exit
            </button>
          </div>
        )}
      </div>

      {/* ── TRADE LOG ── */}
      {tradeLog.length > 0 && (
        <div style={card}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={sec}>Trade Log</div>
            <button onClick={() => setTradeLog([])} style={{ fontSize:10, color:'#374151', background:'none', border:'none', cursor:'pointer' }}>CLEAR</button>
          </div>
          {tradeLog.map((t, i) => (
            <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid rgba(255,255,255,0.04)', fontSize:11, gap:4, flexWrap:'wrap' }}>
              <span style={{ color:t.action?.includes('BUY')?'#10B981':'#F59E0B', fontWeight:700 }}>{t.action}</span>
              <span style={{ color:'#9CA3AF', ...mono }}>{t.type} {t.sym}</span>
              <span style={{ color:'#4B5563', ...mono }}>{fT(t.exitTime||t.time)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── COST TRACKER ── */}
      <div style={card}>
        <div style={sec}>API Cost Tracker</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, marginTop:4 }}>
          <StatCard label="Calls" value={String(calls)} small />
          <StatCard label="Total" value={fR(totalCost)} small />
          <StatCard label="Per Call" value={calls > 0 ? fR(cpc) : '—'} small />
          <StatCard label="Tokens" value={`${((inTok+outTok)/1000).toFixed(1)}K`} small />
        </div>
        {calls > 0 && (
          <div style={{ marginTop:10, padding:'10px 12px', background:'#0A0A18', borderRadius:8, fontSize:11 }}>
            <div style={{ color:'#4B5563', marginBottom:6, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', fontSize:9 }}>DAILY PROJECTION</div>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#6B7280' }}>
              <span>Manual (6 analyses/day)</span>
              <span style={{ ...mono, color:'#F59E0B' }}>{fR(cpc*6)}/day</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#6B7280', marginTop:3 }}>
              <span>Auto 10-min (39/day)</span>
              <span style={{ ...mono, color:'#F59E0B' }}>{fR(dailyCostM)}/day</span>
            </div>
          </div>
        )}
      </div>

      {/* ── EMERGENCY STOP ── */}
      <div style={{ padding:'4px 12px 28px' }}>
        {stopped ? (
          <button onClick={resume} style={{ width:'100%', padding:16, borderRadius:10, border:'none', background:'#10B981', color:'#fff', fontWeight:700, fontSize:14, cursor:'pointer', boxShadow:'0 0 18px rgba(16,185,129,0.3)' }}>
            ✅ RESUME OPERATIONS
          </button>
        ) : (
          <button onClick={stop} style={{ width:'100%', padding:16, borderRadius:10, border:'none', background:'#EF4444', color:'#fff', fontWeight:700, fontSize:14, cursor:'pointer', boxShadow:'0 0 20px rgba(239,68,68,0.35)' }}>
            🛑 EMERGENCY STOP — HALT ALL
          </button>
        )}
        <div style={{ fontSize:11, color:'#374151', textAlign:'center', marginTop:6, lineHeight:1.5 }}>
          Halts all analysis, auto-trade signals, and order placement immediately
        </div>
      </div>

      <style>{`
        @keyframes pop { 0%{transform:scale(1)} 50%{transform:scale(1.1)} 100%{transform:scale(1)} }
      `}</style>
    </div>
  )
}
