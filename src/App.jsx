import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login          from './pages/Login.jsx'
import Callback       from './pages/Callback.jsx'
import Dashboard      from './pages/Dashboard.jsx'
import OmkarLogin     from './pages/OmkarLogin.jsx'
import OmkarCallback  from './pages/OmkarCallback.jsx'
import OmkarDashboard from './pages/OmkarDashboard.jsx'

// ── Multi-user auth helpers ───────────────────────────────────────────────
// All user data is namespaced by Zerodha userId (e.g. AB1234).
// activeUser() returns the currently selected user's id.
// activeToken() returns their access token (or null if expired/missing).
export function activeUser() {
  return localStorage.getItem('kite_active_user') || null
}
export function activeToken() {
  const uid = activeUser()
  if (!uid) return null
  const token  = localStorage.getItem(`kite_access_token_${uid}`)
  const expiry = localStorage.getItem(`kite_token_expiry_${uid}`)
  if (!token) return null
  if (expiry && new Date(expiry) < new Date()) {
    // Token expired — clear it but keep the user registered
    localStorage.removeItem(`kite_access_token_${uid}`)
    return null
  }
  return token
}
export function knownUsers() {
  const ids   = JSON.parse(localStorage.getItem('kite_known_users') || '[]')
  const names = JSON.parse(localStorage.getItem('kite_user_names')  || '{}')
  return ids.map(uid => ({
    uid,
    name:  names[uid] || uid,
    token: localStorage.getItem(`kite_access_token_${uid}`) || null,
    expiry: localStorage.getItem(`kite_token_expiry_${uid}`) || null,
  }))
}
export function switchUser(uid) {
  localStorage.setItem('kite_active_user', uid)
  window.location.href = '/'   // full reload to reset all state
}
export function logoutUser(uid) {
  localStorage.removeItem(`kite_access_token_${uid}`)
  localStorage.removeItem(`kite_token_expiry_${uid}`)
  // If this was the active user, switch to another or go to login
  if (activeUser() === uid) {
    const remaining = knownUsers().filter(u => u.uid !== uid && u.token)
    if (remaining.length) {
      localStorage.setItem('kite_active_user', remaining[0].uid)
      window.location.href = '/'
    } else {
      localStorage.removeItem('kite_active_user')
      window.location.href = '/login'
    }
  }
}

function RequireAuth({ children }) {
  const token = activeToken()
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Sandesh's routes */}
        <Route path="/login"    element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/"         element={<RequireAuth><Dashboard /></RequireAuth>} />

        {/* Omkar's routes — completely separate Kite app + credentials */}
        <Route path="/omkar"             element={<OmkarLogin />} />
        <Route path="/omkar/callback"    element={<OmkarCallback />} />
        <Route path="/omkar/dashboard"   element={<OmkarDashboard />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
