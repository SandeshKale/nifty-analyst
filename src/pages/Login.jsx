import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const navigate  = useNavigate()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // Already logged in? Skip to dashboard
  useEffect(() => {
    if (localStorage.getItem('kite_access_token')) navigate('/')
  }, [])

  const handleLogin = async () => {
    setLoading(true)
    setErr('')
    try {
      const res  = await fetch('/api/kite-login')
      const data = await res.json()
      if (data.loginUrl) {
        window.location.href = data.loginUrl
      } else {
        setErr(data.error || 'Failed to get login URL')
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  const S = {
    root: {
      minHeight: '100vh', background: '#07070F', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
    },
    card: {
      background: '#0D0D1C', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 16, padding: '40px 32px', maxWidth: 400, width: '100%',
      textAlign: 'center',
    },
    logo: { fontSize: 40, marginBottom: 16 },
    title: {
      fontSize: 22, fontWeight: 800, color: '#E8E8F8',
      letterSpacing: '0.05em', marginBottom: 6,
    },
    sub: { fontSize: 13, color: '#4B5563', marginBottom: 32, lineHeight: 1.6 },
    btn: {
      width: '100%', padding: '16px', borderRadius: 10, border: 'none',
      background: loading ? '#1A1A2E' : '#6366F1', color: loading ? '#374151' : '#fff',
      fontWeight: 700, fontSize: 16, cursor: loading ? 'not-allowed' : 'pointer',
      transition: 'all 0.2s', boxShadow: loading ? 'none' : '0 0 24px rgba(99,102,241,0.4)',
    },
    err: {
      marginTop: 16, fontSize: 12, color: '#F87171',
      background: 'rgba(239,68,68,0.08)', padding: '10px 14px',
      borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)',
    },
    features: {
      marginTop: 32, display: 'flex', flexDirection: 'column', gap: 10,
      textAlign: 'left',
    },
    feat: { display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, color: '#6B7280' },
    featIcon: { fontSize: 16, flexShrink: 0, marginTop: 1 },
    warning: {
      marginTop: 24, fontSize: 11, color: '#374151',
      borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 16,
    },
  }

  return (
    <div style={S.root}>
      <div style={S.card}>
        <div style={S.logo}>📊</div>
        <div style={S.title}>NIFTY OPTIONS ANALYST</div>
        <div style={S.sub}>
          AI-powered F&O analysis using live Kite data,<br />
          web intelligence, and 10-factor skill scoring.
        </div>

        <button style={S.btn} onClick={handleLogin} disabled={loading}>
          {loading ? '⟳ Connecting…' : '🔗 Login with Kite (Zerodha)'}
        </button>

        {err && <div style={S.err}>⚠ {err}</div>}

        <div style={S.features}>
          {[
            ['⚡', 'Live Kite data — prices, option chain, positions, margins'],
            ['🔍', '10-factor scorecard with web research (FII, global, breadth)'],
            ['🔄', 'Auto-analysis every 10 minutes during market hours'],
            ['🤖', 'Auto-trade at score ±10 — CE/PE entry with ₹2,000 stop'],
          ].map(([icon, text]) => (
            <div style={S.feat} key={text}>
              <span style={S.featIcon}>{icon}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>

        <div style={S.warning}>
          ⚠ Not SEBI-registered advice. 91% of retail F&O traders lost money in FY2024-25.
          Trade only what you can afford to lose entirely.
        </div>
      </div>
    </div>
  )
}
