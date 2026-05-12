import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login    from './pages/Login.jsx'
import Callback from './pages/Callback.jsx'
import Dashboard from './pages/Dashboard.jsx'

function RequireAuth({ children }) {
  const token = localStorage.getItem('kite_access_token')
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"    element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/"         element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="*"         element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
