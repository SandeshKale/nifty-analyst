import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [err, setErr]         = useState('')
  const [clock, setClock]     = useState('')
  const [mktStatus, setMktStatus] = useState('')

  useEffect(() => {
    if (localStorage.getItem('kite_access_token')) navigate('/')
    const tick = () => {
      const sgt = new Date(Date.now()+8*3600000)
      const ist = new Date(Date.now()+5.5*3600000)
      setClock(sgt.toISOString().slice(11,19)+' SGT')
      const day  = ist.getDay()
      const mins = ist.getHours()*60+ist.getMinutes()
      if (day===0||day===6) { setMktStatus('🔴 Weekend — Market Closed'); return }
      if (mins < 9*60+15)  { const open=9*60+15-mins; setMktStatus(`⏰ Market opens in ${Math.floor(open/60)}h ${open%60}m`); return }
      if (mins < 15*60+30) { const close=15*60+30-mins; setMktStatus(`🟢 Market OPEN — closes in ${Math.floor(close/60)}h ${close%60}m`); return }
      setMktStatus('🔴 Market Closed (opens 9:15 AM IST tomorrow)')
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  const handleLogin = async () => {
    setLoading(true); setErr('')
    try {
      const res  = await fetch('/api/kite-login')
      const data = await res.json()
      if (data.loginUrl) window.location.href = data.loginUrl
      else setErr(data.error||'Failed to get login URL')
    } catch(e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  const S = {
    root: { minHeight:'100vh', background:'#07070F', display:'flex', alignItems:'center', justifyContent:'center', padding:20 },
    card: { background:'#0D0D1C', border:'1px solid rgba(255,255,255,0.08)', borderRadius:16, padding:'40px 32px', maxWidth:400, width:'100%', textAlign:'center' },
    btn:  { width:'100%', padding:'16px', borderRadius:10, border:'none',
            background:loading?'#1A1A2E':'#6366F1', color:loading?'#374151':'#fff',
            fontWeight:700, fontSize:16, cursor:loading?'not-allowed':'pointer',
            transition:'all 0.2s', boxShadow:loading?'none':'0 0 24px rgba(99,102,241,0.4)' },
  }

  return (
    <div style={S.root}>
      <div style={S.card}>
        {/* Live clock + market status */}
        <div style={{marginBottom:20}}>
          <div style={{fontFamily:'monospace',fontSize:18,fontWeight:700,color:'#E8E8F8',letterSpacing:'0.06em'}}>{clock}</div>
          <div style={{fontSize:12,color:mktStatus.includes('OPEN')?'#10B981':mktStatus.includes('⏰')?'#F59E0B':'#EF4444',marginTop:4,fontWeight:600}}>{mktStatus}</div>
        </div>

        <div style={{fontSize:22,fontWeight:800,color:'#E8E8F8',letterSpacing:'0.05em',marginBottom:6}}>NIFTY OPTIONS ANALYST</div>
        <div style={{fontSize:13,color:'#4B5563',marginBottom:28,lineHeight:1.6}}>
          Personal F&O analysis — live Kite data, global cues,<br/>10-factor skill scoring, auto-trade execution.
        </div>

        <button style={S.btn} onClick={handleLogin} disabled={loading}>
          {loading?'⟳ Connecting…':'🔗 Login with Kite (Zerodha)'}
        </button>
        {err&&<div style={{marginTop:14,fontSize:12,color:'#F87171',background:'rgba(239,68,68,0.08)',padding:'10px 14px',borderRadius:8,border:'1px solid rgba(239,68,68,0.2)'}}>⚠ {err}</div>}

        <div style={{marginTop:28,display:'flex',flexDirection:'column',gap:10,textAlign:'left'}}>
          {[
            ['⚡','Live Kite data — prices, option chain, positions, margins'],
            ['🌐','Global cues pre-fetched from Yahoo Finance (S&P500, crude, USD/INR, Asian markets)'],
            ['🔍','10-factor scorecard — score -30 to +30 | ENTRY at ±6 | STRONG ENTRY at ±12'],
            ['🔄','Auto-analysis every 5–30 min (configurable) · Market hours only'],
            ['🤖','Auto-trade at score ±8 · SL = 50% of entry premium · GTT set automatically'],
            ['⚡+🎯','Dual setup — Quick (scalp +15-20 pts) or Swing (positional +100 pts)'],
          ].map(([icon,text])=>(
            <div key={text} style={{display:'flex',alignItems:'flex-start',gap:10,fontSize:12,color:'#6B7280'}}>
              <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{icon}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>

        <div style={{marginTop:20,padding:'10px 14px',background:'rgba(245,158,11,0.06)',borderRadius:8,border:'1px solid rgba(245,158,11,0.15)',fontSize:11,color:'#6B7280',textAlign:'left',lineHeight:1.6}}>
          ⚠ Kite session token expires at midnight IST daily — re-login each morning.<br/>
          Not SEBI-registered advice. 91% of retail F&O traders lost money FY2024-25.
        </div>
      </div>
    </div>
  )
}
