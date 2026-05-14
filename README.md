# Nifty Options Analyst

AI-powered Nifty 50 F&O analysis and execution app — live market data, 10-factor scoring, 10 capital-protection rules, auto-trade signals.

## Architecture

```
Browser (React)
    ↓
Vercel Serverless Functions (Node.js)
    ├── /api/kite-login    → Kite OAuth URL
    ├── /api/kite-session  → exchanges request_token for access_token
    ├── /api/analyze       → Yahoo/NSE data fetch + Anthropic claude-sonnet-4-6 analysis
    ├── /api/place-order   → Kite order execution
    └── /api/place-gtt     → GTT stop-loss placement
```

## Data Sources

| Data | Source | Fallback |
|------|--------|----------|
| Nifty spot / 5m candles | Yahoo Finance `^NSEI` | NSE allIndices |
| VIX, Bank Nifty | Yahoo Finance `^INDIAVIX`, `^NSEBANK` | NSE |
| Option chain (PCR, OI, walls) | NSE option-chain API | Yahoo Finance options |
| Global cues (S&P500, Crude, Gold, USD/INR) | Yahoo Finance | — |
| Margins, Positions, Orders | Kite API (free plan) | — |

> ℹ️ Kite Connect paid subscription (₹2,000/month) is **not required**. All market data uses free NSE/Yahoo sources. Kite is used only for order execution.

## One-Time Setup

### 1. Kite Developer Console
1. Go to https://kite.trade → Login → App Console
2. Set **Redirect URL**: `https://YOUR-APP.vercel.app/callback`
3. Save API Key and Secret

### 2. Deploy to Vercel
```bash
npm i -g vercel
git clone https://github.com/SandeshKale/nifty-analyst
cd nifty-analyst && npm install
vercel
vercel env add KITE_API_KEY
vercel env add KITE_API_SECRET
vercel env add ANTHROPIC_API_KEY
vercel --prod
```

## Usage
1. Login with Kite → authorise Zerodha
2. Tap **⚡ ANALYSE NOW** to run full analysis
3. Toggle **Auto Analysis** (5–30 min intervals, market hours only)
4. Toggle **Auto-Trade** for signal execution
5. **🛑 EMERGENCY STOP** halts everything

## 10 Capital-Protection Rules

| # | Rule | Trigger | Action |
|---|------|---------|--------|
| 1 | **Daily Loss Limit** | Loss ≥ ₹1,000 or ≥ 12% of capital | Block all new entries |
| 2 | **Max 2 Trades/Day** | 3rd trade attempt | Hard block with message |
| 3 | **Strike Selection (σ)** | Strike >1.5σ OTM from spot | Block trade, suggest ≤0.5σ |
| 4 | **Score Reversal Exit** | CE held + score ≤ 0; PE held + score ≥ 0 | Immediate auto-exit |
| 5 | **OI Flip-Flop Detector** | Call/Put wall shifts 2+ times | Warn user, neutralize F2 |
| 6 | **Anti-FOMO Re-Entry** | Exit then re-enter same direction | 30-min cooldown block |
| 7 | **Premium Delta Validation** | Spot moves >0.5% but premium <0.1% | IV Crush → force exit |
| 8 | **Afternoon Fade Detection** | After 12:30 IST + 150pt rally + bearish turn | Tighten SL, warn user |
| 9 | **Capital Preservation** | >20% drawdown → block entries; >30% → exit all | Hard stop with banner |
| 10 | **Conviction-Based Sizing** | STRONG ENTRY / ENTRY / STAY OUT verdict | 100% / 75% / 0% of lots |

## Auto-Trade Parameters
- Entry score: ≥ +8 (CE) or ≤ −8 (PE)
- Strong entry: ≥ ±12 → 100% lot size
- Normal entry: ±8–11 → 75% lot size
- Stop-loss: 50% of entry premium (GTT set automatically)
- Max trades: 2/day
- Cut-off: 1:45 PM IST
- IVP safety cap: high IV (>70) → 50% lots; normal IV → 75–100%

## 10-Factor Scorecard

| Factor | Range | What it measures |
|--------|-------|-----------------|
| F1 VIX | ±5 | Market fear (< 15 bullish, > 20 bearish) |
| F2 PCR/OI | ±5 | Put-Call ratio and OI positioning |
| F3 Intraday | ±5 | 5-min candles, VWAP, ORH/ORL, momentum |
| F4 Daily Trend | ±3 | EMA9/21, SMA20, trend direction |
| F5 Sectoral | ±3 | Bank Nifty, IT, Auto, FinServ alignment |
| F6 FII/DII | ±3 | Institutional flow proxy |
| F7 Breadth | ±3 | Advances/declines, volume confirmation |
| F8 Global | ±3 | S&P500, Crude, Gold, USD/INR |
| F9 IV/Greeks | ±3 | IV percentile, ATM premium, sigma |
| F10 Events | ±3 | Expiry risk, news, calendar |

Verdicts: STRONG ENTRY ≥ ±12 | ENTRY ±8–11 | STAY OUT −7 to +7

## Key Files
```
api/
  analyze.js      → data engine: Yahoo + NSE + Anthropic
  kite-login.js   → OAuth URL
  kite-session.js → token exchange
  place-order.js  → order execution
  place-gtt.js    → GTT stop-loss

src/pages/
  Dashboard.jsx   → main UI + all 10 protection rules
  Login.jsx       → market status + login screen
  Callback.jsx    → OAuth callback
```



## Development & Testing

This project includes a comprehensive test suite that runs automatically before every push:

```bash
npm run check   # Run all checks (lint + test)
npm run lint    # ESLint only
npm run test    # Test suite only
```

**Pre-push hook:** Every `git push` automatically runs the full test suite. If tests fail, the push is blocked.

See [TESTING.md](TESTING.md) for details.

## ⚠️ Important
- Rotate Kite API Secret after deployment
- Re-login daily (Kite tokens expire at midnight IST)
- Not SEBI-registered advice — educational use only
- 91% of retail F&O traders lost money in FY2024-25 (SEBI study)
