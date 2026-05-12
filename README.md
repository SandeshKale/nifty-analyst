# Nifty Options Analyst

AI-powered standalone Nifty 50 F&O analysis app. Live Kite data + 10-factor skill + auto-trade signals.

## Architecture

```
Browser (React)
    ↓
Vercel Serverless Functions (Node.js)
    ├── /api/kite-login    → generates Kite OAuth URL
    ├── /api/kite-session  → exchanges request_token for access_token
    ├── /api/analyze       → fetches all Kite data + calls Anthropic API (claude-sonnet-4-6)
    └── /api/place-order   → executes trades via Kite REST API
```

## One-Time Setup

### 1. Kite Developer Console
1. Go to https://kite.trade → Login → App Console
2. Open your app → set **Redirect URL** to:
   - Production: `https://YOUR-APP-NAME.vercel.app/callback`
   - Local dev:  `http://localhost:5173/callback`
3. Save the API Key and Secret

### 2. Deploy to Vercel (free)
```bash
# Install Vercel CLI
npm i -g vercel

# Clone and deploy
git clone https://github.com/SandeshKale/nifty-analyst
cd nifty-analyst
npm install
vercel

# Set env variables in Vercel dashboard or via CLI:
vercel env add KITE_API_KEY
vercel env add KITE_API_SECRET
vercel env add ANTHROPIC_API_KEY

# Deploy to production
vercel --prod
```

### 3. GitHub + Vercel Auto-Deploy (recommended)
1. Push code to https://github.com/SandeshKale/nifty-analyst
2. Go to vercel.com → New Project → Import from GitHub
3. Add environment variables in Vercel dashboard
4. Deploy — Vercel auto-deploys on every push

## Local Development
```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev            # runs on http://localhost:5173
```
For local API functions: install `vercel` CLI and run `vercel dev` instead.

## Usage
1. Open the app URL
2. Click **Login with Kite** → authorise with Zerodha
3. Click **⚡ ANALYSE NOW** to run full analysis
4. Toggle **Auto Analysis** for 10-minute intervals
5. Toggle **Auto-Trade** to enable signal execution (score ≥+10 → BUY CE, ≤-10 → BUY PE)
6. **🛑 EMERGENCY STOP** halts everything immediately

## Auto-Trade Rules
- Entry: Score ≥ +10 (CE) or ≤ -10 (PE)
- Stop-loss: ₹2,000 per trade
- Max: 2 trades per day
- Cut-off: No new trades after 1:45 PM IST
- Size: 1 lot (65 units) — always

## Key Files
```
api/
  analyze.js      → main engine: Kite data + Anthropic analysis
  kite-login.js   → OAuth URL generation
  kite-session.js → token exchange (keeps API secret server-side)
  place-order.js  → Kite order placement

src/
  App.jsx              → router
  pages/Login.jsx      → login screen
  pages/Callback.jsx   → OAuth callback handler
  pages/Dashboard.jsx  → main trading dashboard
```

## ⚠️ Important
- Rotate Kite API Secret and Anthropic API key after first deployment
- This is for educational purposes — not SEBI-registered advice
- 91% of retail F&O traders lost money in FY2024-25 (SEBI study)
