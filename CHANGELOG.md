# Changelog

All notable changes to Nifty Options Analyst are documented here.

---

## [1.5.0] — 2026-05-13 — 10 Capital-Protection Rules

### Added
- **Rule 1 — Daily Loss Limit**: Hard block at ₹1,000 loss or 12% of starting capital. No override possible. Starting capital captured on first analysis each session.
- **Rule 2 — Max 2 Trades/Day**: Already present; documented and retained. 3rd trade attempt returns a hard block message.
- **Rule 3 — Strike Selection (σ-based)**: Validates selected strike against σ = spot × VIX/100 ÷ √252 before execution. Strikes >1.5σ OTM are blocked; ≤0.5σ preferred.
- **Rule 4 — Score Reversal Exit**: Auto-exit on direction flip — CE position exits immediately if score ≤ 0; PE position exits if score ≥ 0.
- **Rule 5 — OI Flip-Flop Detector**: Tracks call wall and put wall across last 10 analyses. If either shifts 2+ times, displays warning banner and instructs AI to treat F2 as neutral.
- **Rule 6 — Anti-FOMO Re-Entry Block**: Records exit direction and timestamp. Blocks re-entry in same direction (CE or PE) for 30 minutes after any exit. Countdown shown in UI.
- **Rule 7 — Premium Delta Validation (IV Crush)**: Saves entry spot and premium as snapshot. On each subsequent analysis, if spot moved >0.5% but premium moved <0.1%, triggers forced exit with "IV Crush" label.
- **Rule 8 — Afternoon Fade Detection**: After 12:30 PM IST, if day high is 150+ pts above day open and score turns bearish, shows fade warning and tightens SL.
- **Rule 9 — Capital Preservation Mode**: >20% drawdown → blocks new entries with amber banner. >30% drawdown → hard stop, force-exits all open positions, shows red banner.
- **Rule 10 — Conviction-Based Sizing**: Replaces flat IVP-only sizing. STRONG ENTRY (≥±12) → 100% affordable lots; ENTRY (±8–11) → 75%; STAY OUT → 0%. IVP safety cap still applied on top.
- **Capital P&L Tracker**: Shows starting capital, today's P&L (₹ and %), and a loss-limit progress bar in the Auto-Trade section.

### Changed
- `executeTrade`: Now runs Rules 1, 3, 6, 9 as pre-flight checks before any order is placed.
- `handleAutoTrade`: Now runs Rules 4, 7, 8 exit checks before the standard score-flip exit.
- Trade log entries now include conviction tag (e.g. `QUICK BUY CE ✅ [STRONG 100%]`).
- Manual "Log Manual Exit" button now also records exit direction for Rule 6 cooldown.

---

## [1.4.0] — 2026-05-13 — Score Parsing & Option Chain

### Fixed
- **Scorecard all zeros**: AI response was not parsed correctly. Prompt now requests machine-readable `SCORES:{...}` JSON block. Fallback regex retained.
- **NSE cookie pre-fetch**: Option chain API requires session cookie. Added 3s homepage pre-fetch before parallel data requests.
- **Yahoo Finance options fallback**: When NSE option chain is blocked from Vercel IPs, falls back to Yahoo Finance `/v7/finance/options/^NSEI` for ATM premiums, PCR, call/put walls.

---

## [1.3.0] — 2026-05-13 — Parallel Fetches & Timeout Budget

### Fixed
- **Vercel 60s timeout**: `max_tokens` reduced from 4096 → 1500 (Anthropic output ~25s). 50s AbortController on Anthropic call.
- **All 18 data fetches now parallel** (Promise.allSettled) — total data phase ~6s.
- **Top-level try-catch**: `analyze.js` always returns JSON even on fatal crash.
- Removed blocking NSE cookie-retry (was adding 22s+ per call).

---

## [1.2.0] — 2026-05-13 — NSE + Yahoo Data Sources (No Kite Subscription)

### Changed
- **Market data source switched from Kite to NSE + Yahoo Finance**. Kite Connect paid subscription (₹2,000/month) no longer required for analysis.
- Kite API now used only for: margins, positions, orders (all available on free plan).
- NSE `allIndices` → spot, VIX, Bank Nifty, sectors, breadth.
- NSE `option-chain-indices` → PCR, OI, max pain, ATM premiums, IVP.
- Yahoo Finance `^NSEI` → 5m intraday candles (VWAP, ORH/ORL, momentum) + 60d daily (EMA9/21, SMA20).
- Yahoo Finance → global cues (S&P500, Dow, Nasdaq, Crude, Gold, USD/INR, Nikkei, HSI).

### Root Cause
Kite free plan returns HTTP 403 "Insufficient permission" for quote/historical endpoints.

---

## [1.1.0] — 2026-05-13 — Market Status & Timestamp Fixes

### Fixed
- **Market shows closed in SGT browser**: `new Date(Date.now()+5.5*3600000).getHours()` adds IST offset to UTC then `.getHours()` interprets in SGT (+8h), giving wrong hour. Fixed to `toLocaleString('en-US',{timeZone:'Asia/Kolkata'})` in Dashboard, Login, and analyze.js.
- **"Updated Invalid Date"**: Timestamp format changed to ISO 8601 with offset (`+05:30`) — Safari-parseable.
- **Yahoo Finance timeout**: Added 6s AbortController on all Yahoo fetches (previously hung until Vercel wall → "Load failed" on Safari).
- **Model string**: Reverted `claude-sonnet-4-20250514` → `claude-sonnet-4-6` (correct external API string; the former is only valid inside Claude.ai's sandbox).

---

## [1.0.0] — 2026-05-12 — Initial Release

### Added
- React + Vite frontend deployed to Vercel
- Kite Connect OAuth login (token stored in localStorage)
- `/api/analyze`: Kite market data + Anthropic claude-sonnet-4-6 10-factor analysis
- 10-factor scorecard (F1–F10): VIX, PCR/OI, Intraday, Daily, Sectoral, FII, Breadth, Global, IV, Events
- Dual verdict: Quick Setup (+15–20 pts scalp) + Swing Setup (+100 pts positional)
- Auto-analysis (5–30 min intervals, market-hours-gated)
- Auto-trade (score ≥±8 trigger, 50% premium SL, GTT auto-set, max 2/day, 1:45 IST cut-off)
- IVP-based lot sizing
- Emergency stop
- API cost tracker
- Trade log
