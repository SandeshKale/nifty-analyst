// src/api.js — Central API base URL
// 
// HOW IT WORKS:
// - In production (Vercel): VITE_API_BASE is not set → uses '' → calls /api/... on same domain
// - Local laptop server:    set VITE_API_BASE=http://localhost:3000 in .env.local
// - Hetzner VPS:            set VITE_API_BASE=http://YOUR_HETZNER_IP:3000 in Vercel env vars
//
// To use local server:
//   1. Create src/../.env.local with: VITE_API_BASE=http://localhost:3000
//   2. Run: npm run dev (frontend) + npm run server (backend)
//   3. The frontend will call your laptop's Express server for all API calls

export const API_BASE = import.meta.env.VITE_API_BASE || '';

export function apiUrl(path) {
  // path should start with /api/...
  return `${API_BASE}${path}`;
}
