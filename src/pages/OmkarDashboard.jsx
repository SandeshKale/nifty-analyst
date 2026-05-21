// src/pages/OmkarDashboard.jsx
// Omkar's dashboard — thin wrapper that injects his Kite credentials
// into the shared Dashboard component via localStorage reads from omkar_* keys.
// His omkar_api_key is sent to analyze.js on every call so Kite uses his app.

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Dashboard from './Dashboard.jsx'

export default function OmkarDashboard() {
  const navigate = useNavigate()

  useEffect(() => {
    // Validate Omkar's session before rendering
    const token  = localStorage.getItem('omkar_access_token')
    const expiry = localStorage.getItem('omkar_token_expiry')
    if (!token || (expiry && new Date(expiry) < new Date())) {
      navigate('/omkar')
      return
    }

    // Bridge: copy omkar_* keys into the active kite_* session slot
    // so the shared Dashboard reads them transparently.
    // This is a session-scoped bridge — omkar_* keys remain the source of truth.
    const uid = localStorage.getItem('omkar_user_id') || 'omkar'
    localStorage.setItem(`kite_access_token_${uid}`, token)
    localStorage.setItem(`kite_user_name_${uid}`,    localStorage.getItem('omkar_user_name') || 'Omkar')
    localStorage.setItem(`kite_token_expiry_${uid}`,  expiry || '')
    localStorage.setItem(`kite_api_key_${uid}`,       localStorage.getItem('omkar_api_key') || '')

    // Register in known users + set as active
    const known = JSON.parse(localStorage.getItem('kite_known_users') || '[]')
    if (!known.includes(uid)) {
      known.push(uid)
      localStorage.setItem('kite_known_users', JSON.stringify(known))
    }
    const names = JSON.parse(localStorage.getItem('kite_user_names') || '{}')
    names[uid] = localStorage.getItem('omkar_user_name') || 'Omkar'
    localStorage.setItem('kite_user_names', JSON.stringify(names))
    localStorage.setItem('kite_active_user', uid)
  }, [navigate])

  return <Dashboard omkarMode={true} />
}
