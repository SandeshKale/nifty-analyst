// server.js — Express wrapper for local laptop / Hetzner deployment
// Converts Vercel serverless handlers into a standard HTTP server.
// Run: node server.js
// Env vars loaded from .env file via --env-file flag or dotenv.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// Import all API handlers
import analyzeHandler        from './api/analyze.js';
import kiteLoginHandler      from './api/kite-login.js';
import kiteSessionHandler    from './api/kite-session.js';
import omkarLoginHandler     from './api/omkar-kite-login.js';
import omkarSessionHandler   from './api/omkar-kite-session.js';
import placeOrderHandler     from './api/place-order.js';
import placeGttHandler       from './api/place-gtt.js';
import healthHandler         from './api/health.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Vercel-to-Express adapter ────────────────────────────────────────────────
// Vercel handlers use res.status(N).json() / res.end()
// Express res already has these — the adapter just passes req/res through.
function adapt(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[server] unhandled error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error: ' + err.message });
      }
    }
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.all('/api/analyze',            adapt(analyzeHandler));
app.all('/api/kite-login',         adapt(kiteLoginHandler));
app.all('/api/kite-session',       adapt(kiteSessionHandler));
app.all('/api/omkar-kite-login',   adapt(omkarLoginHandler));
app.all('/api/omkar-kite-session', adapt(omkarSessionHandler));
app.all('/api/place-order',        adapt(placeOrderHandler));
app.all('/api/place-gtt',          adapt(placeGttHandler));
app.all('/api/health',             adapt(healthHandler));

// Health check
app.get('/', (req, res) => res.json({
  status: 'ok',
  server: 'Nifty Analyst API',
  time: new Date().toISOString(),
  env: {
    kiteKey:    process.env.KITE_API_KEY     ? '✓ set' : '✗ missing',
    groqKey:    process.env.GROQ_API_KEY     ? '✓ set' : '✗ missing',
    anthropic:  process.env.ANTHROPIC_API_KEY? '✓ set' : '✗ missing',
    omkarKey:   process.env.OMKAR_KITE_API_KEY? '✓ set': '✗ not set',
  }
}));

app.listen(PORT, () => {
  console.log(`\n🚀 Nifty Analyst API running on http://localhost:${PORT}`);
  console.log(`   KITE_API_KEY:  ${process.env.KITE_API_KEY     ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`   GROQ_API_KEY:  ${process.env.GROQ_API_KEY     ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`   ANTHROPIC_KEY: ${process.env.ANTHROPIC_API_KEY? '✓ loaded' : '✗ MISSING'}`);
  console.log(`\n   Whitelist this IP in Kite: check https://api.ipify.org\n`);
});
