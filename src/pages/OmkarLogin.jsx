import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

// Omkar's login page — uses his own Kite developer app (OMKAR_KITE_API_KEY)
// Completely separate from Sandesh's login at /login
export default function OmkarLogin() {
  const navigate  = useNavigate()
  const [loading, setLoading]       = useState(false)
  const [err, setErr]               = useState('')
  const [clock, setClock]           = useState('')
  const [mktStatus, setMktStatus]   = useState('')
  const calledRef = useRef(false)

  useEffect(() => {
    // Auto-redirect if Omkar already has a valid token
    const token  = localStorage.getItem('omkar_access_token')
    const expiry = localStorage.getItem('omkar_token_expiry')
    const valid  = token && (!expiry || new Date(expiry) > new Date())
    if (valid && !calledRef.current) navigate('/omkar/dashboard')

    const tick = () => {
      const ist    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
      const sgtStr = new Date().toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour:'2-digit', minute:'2-digit', second:'2-digit' })
      setClock(sgtStr + ' SGT')
      const day  = ist.getDay()
      const mins = ist.getHours()*60+ist.getMinutes()
      if (day===0||day===6) { setMktStatus('🔴 Weekend — Market Closed'); return }
      if (mins < 9*60+15)  { const open=9*60+15-mins; setMktStatus(`⏰ Market opens in ${Math.floor(open/60)}h ${open%60}m`); return }
      if (mins < 15*60+30) { const close=15*60+30-mins; setMktStatus(`🟢 Market OPEN — closes in ${Math.floor(close/60)}h ${close%60}m`); return }
      setMktStatus('🔴 Market Closed')
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  const handleLogin = async () => {
    setLoading(true); setErr('')
    try {
      // Calls Omkar's login endpoint — uses OMKAR_KITE_API_KEY
      const res  = await fetch('/api/omkar-kite-login')
      const data = await res.json()
      if (data.loginUrl) window.location.href = data.loginUrl
      else setErr(data.error || 'Failed to get login URL')
    } catch(e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  const S = {
    root: { minHeight:'100vh', background:'#07070F', display:'flex', alignItems:'center', justifyContent:'center', padding:20 },
    card: { background:'#0D1A0D', border:'1px solid rgba(16,185,129,0.15)', borderRadius:16, padding:'40px 32px', maxWidth:400, width:'100%', textAlign:'center' },
    btn:  { width:'100%', padding:'16px', borderRadius:10, border:'none',
            background:loading?'#1A1A2E':'#059669', color:loading?'#374151':'#fff',
            fontWeight:700, fontSize:16, cursor:loading?'not-allowed':'pointer',
            transition:'all 0.2s', boxShadow:loading?'none':'0 0 24px rgba(16,185,129,0.35)' },
  }

  return (
    <div style={S.root}>
      <div style={S.card}>
        {/* Clock */}
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:'monospace',fontSize:18,fontWeight:700,color:'#E8E8F8',letterSpacing:'0.06em'}}>{clock}</div>
          <div style={{fontSize:12,color:mktStatus.includes('OPEN')?'#10B981':mktStatus.includes('⏰')?'#F59E0B':'#EF4444',marginTop:4,fontWeight:600}}>{mktStatus}</div>
        </div>

        {/* Title — green accent to distinguish from Sandesh's purple */}
        <div style={{fontSize:11,fontWeight:700,letterSpacing:'.1em',color:'#10B981',marginBottom:6,textTransform:'uppercase'}}>
          Omkar's Portal
        </div>
        <div style={{fontSize:22,fontWeight:800,color:'#E8E8F8',letterSpacing:'0.05em',marginBottom:6}}>
          NIFTY OPTIONS ANALYST
        </div>
        <div style={{fontSize:13,color:'#4B5563',marginBottom:28,lineHeight:1.6}}>
          Connect your Zerodha account to start analysis.
        </div>

        <button style={S.btn} onClick={handleLogin} disabled={loading}>
          {loading ? '⟳ Connecting…' : '🔗 Login with Kite (Zerodha)'}
        </button>

        {err && (
          <div style={{marginTop:14,fontSize:12,color:'#F87171',background:'rgba(239,68,68,0.08)',padding:'10px 14px',borderRadius:8,border:'1px solid rgba(239,68,68,0.2)'}}>
            ⚠ {err}
          </div>
        )}

        <div style={{marginTop:28,display:'flex',flexDirection:'column',gap:10,textAlign:'left'}}>
          {[
            ['⚡','Live Kite data — prices, option chain, positions, margins'],
            ['🌐','Global cues — S&P500, crude, USD/INR, Asian markets'],
            ['🔍','11-factor scorecard · Smart model routing (Groq → Sonnet → Opus)'],
            ['🔄','Auto-analysis 9:25–15:20 IST · 1–30 min intervals'],
            ['🤖','Auto-trade at ±8 score · 50% SL · GTT set automatically'],
          ].map(([icon,text]) => (
            <div key={text} style={{display:'flex',alignItems:'flex-start',gap:10,fontSize:12,color:'#6B7280'}}>
              <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{icon}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>

        <div style={{marginTop:20,padding:'10px 14px',background:'rgba(245,158,11,0.06)',borderRadius:8,border:'1px solid rgba(245,158,11,0.15)',fontSize:11,color:'#6B7280',textAlign:'left',lineHeight:1.6}}>
          ⚠ Kite session expires at midnight IST — re-login each morning.<br/>
          Not SEBI-registered advice.
        </div>

        <div style={{marginTop:16,fontSize:10,color:'#374151',textAlign:'center'}}>
          Sandesh's portal → <a href="/login" style={{color:'#6366F1',textDecoration:'none'}}>nifty-analyst.vercel.app/login</a>
        </div>
      </div>
    </div>
  )
}
