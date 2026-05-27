import { apiUrl } from '../api.js'
import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

// Omkar's OAuth callback — stores token under omkar_* localStorage keys.
// Completely isolated from Sandesh's kite_* keys.
export default function OmkarCallback() {
  const navigate  = useNavigate()
  const [status, setStatus] = useState('Exchanging token with Kite…')
  const [err, setErr]       = useState('')
  const calledRef = useRef(false)   // one-time guard — request_token is single-use

  useEffect(() => {
    if (calledRef.current) return
    calledRef.current = true

    const params       = new URLSearchParams(window.location.search)
    const requestToken = params.get('request_token')

    if (!requestToken) {
      setErr('No request_token in URL. Kite login may have been cancelled.')
      return
    }

    // Clear token from URL immediately so back/refresh can't replay it
    window.history.replaceState({}, '', '/omkar/callback')

    exchangeToken(requestToken)
  }, [])

  const exchangeToken = async (requestToken) => {
    try {
      // Calls Omkar's session endpoint — uses OMKAR_KITE_API_KEY + OMKAR_KITE_API_SECRET
      const res  = await fetch(apiUrl('/api/omkar-kite-session'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requestToken }),
      })
      const data = await res.json()

      if (data.accessToken) {
        // ── Omkar's isolated storage keys ────────────────────────────────
        // All keys prefixed with omkar_ — zero overlap with Sandesh's kite_* keys
        localStorage.setItem('omkar_access_token', data.accessToken)
        localStorage.setItem('omkar_user_name',    data.userName || 'Omkar')
        localStorage.setItem('omkar_user_id',      data.userId   || '')
        localStorage.setItem('omkar_api_key',      data.apiKey   || '')

        // Token expires at midnight IST
        const midnightIST = new Date()
        midnightIST.setUTCHours(18, 30, 0, 0)
        if (midnightIST < new Date()) midnightIST.setDate(midnightIST.getDate() + 1)
        localStorage.setItem('omkar_token_expiry', midnightIST.toISOString())

        setStatus(`✅ Logged in as ${data.userName || data.userId}. Redirecting…`)
        setTimeout(() => navigate('/omkar/dashboard'), 1200)
      } else {
        setErr(data.error || 'Token exchange failed')
      }
    } catch (e) {
      setErr(e.message)
    }
  }

  const S = {
    root: { minHeight:'100vh', background:'#07070F', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:20, padding:20 },
    card: { background:'#0D1A0D', border:'1px solid rgba(16,185,129,0.12)', borderRadius:12, padding:'32px 28px', maxWidth:380, width:'100%', textAlign:'center' },
    spin: { fontSize:40, animation:'spin 1s linear infinite' },
    status: { fontSize:16, color:'#E8E8F8', marginTop:16, fontWeight:600 },
    err:  { marginTop:16, fontSize:13, color:'#F87171', background:'rgba(239,68,68,0.08)', padding:'12px 16px', borderRadius:8, border:'1px solid rgba(239,68,68,0.2)' },
    back: { marginTop:16, padding:'10px 20px', borderRadius:8, border:'none', background:'#1A1A2E', color:'#6B7280', cursor:'pointer', fontSize:13 },
  }

  return (
    <div style={S.root}>
      <div style={S.card}>
        <div style={{fontSize:10,fontWeight:700,letterSpacing:'.1em',color:'#10B981',marginBottom:12,textTransform:'uppercase'}}>Omkar's Portal</div>
        {!err ? (
          <>
            <div style={S.spin}>⟳</div>
            <div style={S.status}>{status}</div>
          </>
        ) : (
          <>
            <div style={{fontSize:36}}>⚠️</div>
            <div style={{...S.status, color:'#F87171', marginTop:12}}>Login Failed</div>
            <div style={S.err}>{err}</div>
            <button style={S.back} onClick={() => navigate('/omkar')}>← Try Again</button>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
