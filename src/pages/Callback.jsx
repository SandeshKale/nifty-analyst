import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Callback() {
  const navigate   = useNavigate()
  const [status, setStatus] = useState('Exchanging token with Kite…')
  const [err, setErr]       = useState('')
  // Guard: request_token is one-time-use — must call exchangeToken exactly once
  // React 18 Strict Mode double-invokes effects in dev; the ref prevents the second call
  const calledRef = useRef(false)

  useEffect(() => {
    if (calledRef.current) return   // already called — skip
    calledRef.current = true

    const params       = new URLSearchParams(window.location.search)
    const requestToken = params.get('request_token')

    if (!requestToken) {
      setErr('No request_token in URL. Kite login may have been cancelled.')
      return
    }

    // Immediately clear the token from the URL so browser back/reload can't replay it
    // This prevents "Token is invalid or has expired" on any URL revisit
    window.history.replaceState({}, '', '/callback')

    exchangeToken(requestToken)
  }, [])

  const exchangeToken = async (requestToken) => {
    try {
      const res  = await fetch('/api/kite-session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requestToken }),
      })
      const data = await res.json()

      if (data.accessToken) {
        const uid = data.userId || 'default'
        // ── Per-user namespaced storage (supports multiple Zerodha accounts) ──
        // Each user's data is stored under their Zerodha user_id key.
        // This prevents cross-contamination even if two users share one browser.
        localStorage.setItem(`kite_access_token_${uid}`, data.accessToken)
        localStorage.setItem(`kite_user_name_${uid}`,    data.userName || uid)
        // Token expires at midnight IST
        const midnightIST = new Date()
        midnightIST.setUTCHours(18, 30, 0, 0) // 18:30 UTC = midnight IST
        if (midnightIST < new Date()) midnightIST.setDate(midnightIST.getDate() + 1)
        localStorage.setItem(`kite_token_expiry_${uid}`, midnightIST.toISOString())

        // Register this user in the known-users list
        const known = JSON.parse(localStorage.getItem('kite_known_users') || '[]')
        if (!known.includes(uid)) {
          known.push(uid)
          localStorage.setItem('kite_known_users', JSON.stringify(known))
        }
        // Also store display name separately for the account switcher
        const names = JSON.parse(localStorage.getItem('kite_user_names') || '{}')
        names[uid] = data.userName || uid
        localStorage.setItem('kite_user_names', JSON.stringify(names))

        // Set as active user
        localStorage.setItem('kite_active_user', uid)

        setStatus(`✅ Logged in as ${data.userName || uid}. Redirecting…`)
        setTimeout(() => navigate('/'), 1200)
      } else {
        setErr(data.error || 'Token exchange failed')
      }
    } catch (e) {
      setErr(e.message)
    }
  }

  const S = {
    root: {
      minHeight: '100vh', background: '#07070F',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 20, padding: 20,
    },
    card: {
      background: '#0D0D1C', border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12, padding: '32px 28px', maxWidth: 380, width: '100%',
      textAlign: 'center',
    },
    spin: { fontSize: 40, animation: 'spin 1s linear infinite' },
    status: { fontSize: 16, color: '#E8E8F8', marginTop: 16, fontWeight: 600 },
    err: {
      marginTop: 16, fontSize: 13, color: '#F87171',
      background: 'rgba(239,68,68,0.08)', padding: '12px 16px',
      borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)',
    },
    back: {
      marginTop: 16, padding: '10px 20px', borderRadius: 8, border: 'none',
      background: '#1A1A2E', color: '#6B7280', cursor: 'pointer', fontSize: 13,
    },
  }

  return (
    <div style={S.root}>
      <div style={S.card}>
        {!err ? (
          <>
            <div style={S.spin}>⟳</div>
            <div style={S.status}>{status}</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 36 }}>⚠️</div>
            <div style={{ ...S.status, color: '#F87171', marginTop: 12 }}>Login Failed</div>
            <div style={S.err}>{err}</div>
            <button style={S.back} onClick={() => navigate('/login')}>← Try Again</button>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
