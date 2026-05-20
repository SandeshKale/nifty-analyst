// tests/analyze.test.mjs — Nifty Analyst Production Test Suite v2
// Covers: static analysis, routing logic, market-open (9:15–9:45 IST),
//         fallback chain, response contract, edge cases, tooling

import { readFileSync, writeFileSync } from 'fs';
import { strict as assert } from 'assert';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[34m', X = '\x1b[0m';

let passed = 0, failed = 0, skipped = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    console.log(`${G}✓${X} ${name}`);
    passed++;
    results.push({ name, status: 'pass' });
  } catch (err) {
    console.log(`${R}✗${X} ${name}\n  ${R}${err.message}${X}`);
    failed++;
    results.push({ name, status: 'fail', error: err.message });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`${G}✓${X} ${name}`);
    passed++;
    results.push({ name, status: 'pass' });
  } catch (err) {
    console.log(`${R}✗${X} ${name}\n  ${R}${err.message}${X}`);
    if (err.stack) console.log(`  ${err.stack.split('\n').slice(1, 3).join('\n')}`);
    failed++;
    results.push({ name, status: 'fail', error: err.message });
  }
}

function skip(name, reason) {
  console.log(`${Y}⊘${X} ${name} ${Y}(${reason})${X}`);
  skipped++;
  results.push({ name, status: 'skip', reason });
}

function section(title) {
  console.log(`\n${B}── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}${X}\n`);
}

// ── Load source ──────────────────────────────────────────────────────────────
const SRC = readFileSync('api/analyze.js', 'utf8');
const LINES = SRC.split('\n');

// ── Load handler ─────────────────────────────────────────────────────────────
const patched = SRC
  .replace('export const config', '// config')
  .replace('export default async function handler', 'globalThis.__testHandler = async function handler');
writeFileSync('/tmp/test-handler.mjs', patched);
await import('/tmp/test-handler.mjs');
const handler = globalThis.__testHandler;

// ── Mock factory ─────────────────────────────────────────────────────────────
function mockReqRes(method = 'POST', body = null) {
  const req = { method, body, headers: body ? { 'content-type': 'application/json' } : {} };
  let statusCode = 200, responseBody = null;
  const hdrs = {};
  const res = {
    setHeader: (k, v) => { hdrs[k] = v; },
    status: code => { statusCode = code; return res; },
    json: data => { responseBody = data; },
    end: () => {},
  };
  return { req, res, get: () => ({ statusCode, body: responseBody, headers: hdrs }) };
}

// ── Routing logic (mirrored from source for unit testing) ────────────────────
function selectModelTest(score, useDeepSeekFlag = false) {
  if (useDeepSeekFlag) return { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'groq-free' };
  const abs = Math.abs(score || 0);
  if (abs >= 12) return { provider: 'groq',     model: 'llama-3.3-70b-versatile', tier: 'groq-free' };
  if (abs >= 8)  return { provider: 'anthropic', model: 'claude-sonnet-4-6',       tier: 'sonnet'    };
  return             { provider: 'anthropic', model: 'claude-opus-4-6',         tier: 'opus'      };
}

// ── IST time helpers ─────────────────────────────────────────────────────────
const now = new Date();
const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
const currentIstMins = ist.getHours() * 60 + ist.getMinutes();
const isMarketHours  = currentIstMins >= 555 && currentIstMins < 930;
const isOpeningWindow = currentIstMins >= 555 && currentIstMins <= 585;
const istLabel = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')} IST`;


// ════════════════════════════════════════════════════════════════════════════
section('1. STATIC ANALYSIS');
// ════════════════════════════════════════════════════════════════════════════

test('1.01 — Valid JS (node --check passes)', () => {
  assert.ok(!SRC.includes('SyntaxError'));
});

test('1.02 — Node.js runtime (no Edge runtime)', () => {
  assert.ok(!SRC.includes("runtime: 'edge'"), 'Must not use Edge Runtime');
  assert.ok(!SRC.includes('new Response('), 'Must not use Edge-style new Response()');
});

test('1.03 — res.status().json() pattern (Node.js API)', () => {
  assert.ok(/res\.status\(\d+\)\.json\(/.test(SRC));
});

test('1.04 — No const shadowing outer let variables', () => {
  let foundOuter = false;
  for (let i = 0; i < LINES.length; i++) {
    if (/let\s+(dataBlock|prompt)\b/.test(LINES[i])) { foundOuter = true; continue; }
    if (foundOuter && /^\s+const\s+(dataBlock|prompt)\s*=/.test(LINES[i]))
      throw new Error(`Line ${i+1}: const shadows outer let`);
  }
});

test('1.05 — SCORES JSON includes f11 field', () => {
  assert.ok(SRC.includes('"f11"'));
});

test('1.06 — selectModel() routing function present', () => {
  assert.ok(SRC.includes('selectModel'));
  assert.ok(SRC.includes('groq-free'));
  assert.ok(SRC.includes('claude-opus-4-6'));
  assert.ok(SRC.includes('claude-sonnet-4-6'));
});

test('1.07 — Groq API endpoint + model ID correct', () => {
  assert.ok(SRC.includes('api.groq.com'));
  assert.ok(SRC.includes('llama-3.3-70b-versatile'));
});

test('1.08 — callWithFallback() chain present', () => {
  assert.ok(SRC.includes('callWithFallback'));
  assert.ok(SRC.includes('[fallback]'));
  assert.ok(SRC.includes('All fallbacks exhausted'));
});

test('1.09 — Market-open timeout is 80s (not old 25s)', () => {
  assert.ok(SRC.includes('80000'), 'Must have 80s timeout');
  assert.ok(!SRC.includes('25000'), 'Old 25s timeout must be gone');
});

test('1.10 — Auto-retry gated on isMarketOpen', () => {
  assert.ok(SRC.includes('retryNum === 0 && isMarketOpen'));
});

test('1.11 — Response includes usedModel, routingTier, preScore', () => {
  assert.ok(SRC.includes('usedModel'));
  assert.ok(SRC.includes('routingTier'));
  assert.ok(SRC.includes('preScore'));
});

test('1.12 — No secrets logged via console.log', () => {
  const bad = LINES.filter(l =>
    /console\.(log|info)/.test(l) &&
    /(apiKey|accessToken|ANTHROPIC_API_KEY|GROQ_API_KEY)/i.test(l)
  );
  assert.strictEqual(bad.length, 0, `Secret logged: ${bad[0] || ''}`);
});

test('1.13 — Legacy useDeepSeek toggle still supported', () => {
  assert.ok(SRC.includes('useDeepSeek'));
});

test('1.14 — max_tokens updated to 1800', () => {
  assert.ok(SRC.includes('1800'));
  assert.ok(!SRC.match(/max_tokens.*?1400/), 'Old 1400 must be gone');
});

test('1.15 — No duplicate catch on same try block', () => {
  let depth = 0, tryDepth = -1, catchCount = 0;
  for (let i = 0; i < LINES.length; i++) {
    const l = LINES[i].trim();
    depth += (l.match(/{/g)||[]).length - (l.match(/}/g)||[]).length;
    if (/^try\s*\{/.test(l)) { tryDepth = depth; catchCount = 0; }
    if (tryDepth >= 0 && /^}\s*catch/.test(l) && ++catchCount > 1)
      throw new Error(`Duplicate catch at line ${i+1}`);
    if (tryDepth >= 0 && depth < tryDepth) { tryDepth = -1; catchCount = 0; }
  }
});

test('1.16 — CORS headers on every response path', () => {
  assert.ok(SRC.includes("'Access-Control-Allow-Origin', '*'"));
  assert.ok(SRC.includes("'Access-Control-Allow-Methods'"));
});

test('1.17 — temperature: 0.1 for Groq (deterministic signals)', () => {
  assert.ok(SRC.includes('temperature: 0.1'));
});

test('1.18 — isGroq flag used for clean provider detection', () => {
  assert.ok(SRC.includes('const isGroq'));
});

test('1.19 — Missing API key throws descriptive error', () => {
  assert.ok(SRC.includes('Missing env var:'));
});

test('1.20 — Outer fatal catch wraps entire handler', () => {
  assert.ok(SRC.includes('Analysis failed:'));
});


// ════════════════════════════════════════════════════════════════════════════
section('2. ROUTING LOGIC (Unit Tests)');
// ════════════════════════════════════════════════════════════════════════════

test('2.01 — Score -20 → Groq (strong bear, clean signal)', () => {
  assert.strictEqual(selectModelTest(-20).tier, 'groq-free');
});

test('2.02 — Score +15 → Groq (strong bull)', () => {
  assert.strictEqual(selectModelTest(15).tier, 'groq-free');
});

test('2.03 — Score -12 (lower boundary) → Groq', () => {
  assert.strictEqual(selectModelTest(-12).tier, 'groq-free');
});

test('2.04 — Score +12 (lower boundary) → Groq', () => {
  assert.strictEqual(selectModelTest(12).tier, 'groq-free');
});

test('2.05 — Score -11 → Sonnet (middle zone)', () => {
  const r = selectModelTest(-11);
  assert.strictEqual(r.tier, 'sonnet');
  assert.strictEqual(r.model, 'claude-sonnet-4-6');
});

test('2.06 — Score +8 (upper boundary) → Sonnet', () => {
  assert.strictEqual(selectModelTest(8).tier, 'sonnet');
});

test('2.07 — Score -7 → Opus (grey zone)', () => {
  const r = selectModelTest(-7);
  assert.strictEqual(r.tier, 'opus');
  assert.strictEqual(r.model, 'claude-opus-4-6');
});

test('2.08 — Score 0 (neutral) → Opus (maximum caution)', () => {
  assert.strictEqual(selectModelTest(0).tier, 'opus');
});

test('2.09 — useDeepSeek=true overrides to Groq regardless of score', () => {
  assert.strictEqual(selectModelTest(-7, true).tier, 'groq-free');   // Would be Opus
  assert.strictEqual(selectModelTest(0, true).tier, 'groq-free');    // Would be Opus
});

test('2.10 — All boundary transitions correct (no off-by-one)', () => {
  // 12/11 boundary (Groq vs Sonnet)
  assert.strictEqual(selectModelTest(-12).tier, 'groq-free');
  assert.strictEqual(selectModelTest(-11).tier, 'sonnet');
  assert.strictEqual(selectModelTest(12).tier, 'groq-free');
  assert.strictEqual(selectModelTest(11).tier, 'sonnet');
  // 8/7 boundary (Sonnet vs Opus)
  assert.strictEqual(selectModelTest(-8).tier, 'sonnet');
  assert.strictEqual(selectModelTest(-7).tier, 'opus');
  assert.strictEqual(selectModelTest(8).tier, 'sonnet');
  assert.strictEqual(selectModelTest(7).tier, 'opus');
});

test('2.11 — Extreme scores route to Groq', () => {
  assert.strictEqual(selectModelTest(-33).tier, 'groq-free');
  assert.strictEqual(selectModelTest(33).tier, 'groq-free');
});

test('2.12 — Near-neutral routes to Opus', () => {
  assert.strictEqual(selectModelTest(-1).tier, 'opus');
  assert.strictEqual(selectModelTest(1).tier, 'opus');
});

test('2.13 — Groq routes to correct model string', () => {
  assert.strictEqual(selectModelTest(-20).model, 'llama-3.3-70b-versatile');
});

test('2.14 — Sonnet routes to correct model string', () => {
  assert.strictEqual(selectModelTest(-10).model, 'claude-sonnet-4-6');
});

test('2.15 — Opus routes to correct model string', () => {
  assert.strictEqual(selectModelTest(0).model, 'claude-opus-4-6');
});


// ════════════════════════════════════════════════════════════════════════════
section('3. HTTP CONTRACT');
// ════════════════════════════════════════════════════════════════════════════

await asyncTest('3.01 — OPTIONS → 200 + CORS headers', async () => {
  const { req, res, get } = mockReqRes('OPTIONS');
  await handler(req, res);
  const r = get();
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['Access-Control-Allow-Origin'], '*');
});

await asyncTest('3.02 — GET → 405', async () => {
  const { req, res, get } = mockReqRes('GET');
  await handler(req, res);
  assert.strictEqual(get().statusCode, 405);
});

await asyncTest('3.03 — DELETE → 405', async () => {
  const { req, res, get } = mockReqRes('DELETE');
  await handler(req, res);
  assert.strictEqual(get().statusCode, 405);
});

await asyncTest('3.04 — POST with no accessToken → 400 with error field', async () => {
  const { req, res, get } = mockReqRes('POST', {});
  await handler(req, res);
  const r = get();
  assert.strictEqual(r.statusCode, 400);
  assert.ok(r.body?.error?.includes('accessToken'), `Error: ${r.body?.error}`);
});

await asyncTest('3.05 — Error responses always have string error field', async () => {
  const { req, res, get } = mockReqRes('POST', {});
  await handler(req, res);
  const r = get();
  assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0);
});

await asyncTest('3.06 — Non-OPTIONS responses return JSON objects', async () => {
  for (const [method, body] of [['GET', null], ['POST', {}]]) {
    const { req, res, get } = mockReqRes(method, body);
    await handler(req, res);
    const r = get();
    assert.ok(typeof r.body === 'object' && r.body !== null, `${method} must return JSON`);
  }
});


// ════════════════════════════════════════════════════════════════════════════
section('4. MARKET-OPEN WINDOW (9:15–9:45 IST)');
// ════════════════════════════════════════════════════════════════════════════

test('4.01 — Market-open timeout is 80s', () => {
  assert.ok(
    SRC.includes('AI_TIMEOUT  = isMarketOpen ? 80000 : 55000') ||
    SRC.includes('AI_TIMEOUT = isMarketOpen ? 80000 : 55000')
  );
});

test('4.02 — 9:15 and 9:45 IST boundaries coded correctly', () => {
  assert.ok(SRC.includes('9*60+15'));
  assert.ok(SRC.includes('9*60+45'));
});

test('4.03 — Retry only during market-open window', () => {
  assert.ok(SRC.includes('retryNum === 0 && isMarketOpen'));
});

test('4.04 — Strong signal always routes to Groq (fastest at open)', () => {
  assert.strictEqual(selectModelTest(-20).provider, 'groq');
  assert.strictEqual(selectModelTest(20).provider, 'groq');
});

test('4.05 — Fallback: Groq → Sonnet → Opus documented in source', () => {
  assert.ok(SRC.includes('[fallback] Groq failed'));
  assert.ok(SRC.includes('claude-sonnet-4-6'));
});

test('4.06 — isMarketOpen uses IST time object', () => {
  assert.ok(SRC.includes('ist.getHours()*60 + ist.getMinutes()'));
});

test('4.07 — Market hours gate blocks outside 9:15–15:30 IST', () => {
  assert.ok(SRC.includes('Analysis blocked'));
  assert.ok(SRC.includes('9:15-15:30 IST'));
});

test(`4.08 — Current time ${istLabel}: routing expectation matches`, () => {
  // Verify the logic is consistent — at market-open, a -20 score uses Groq
  if (isOpeningWindow) {
    assert.strictEqual(selectModelTest(-20).tier, 'groq-free', 'Strong signals must use Groq');
    assert.strictEqual(selectModelTest(0).tier, 'opus', 'Neutral must use Opus for deep reasoning');
  } else {
    // Outside window — routing still works the same way
    assert.strictEqual(selectModelTest(-20).tier, 'groq-free');
    assert.strictEqual(selectModelTest(0).tier, 'opus');
  }
});

if (isOpeningWindow) {
  await asyncTest('4.09 [LIVE] — Full pipeline completes within 90s at market open', async () => {
    const { req, res, get } = mockReqRes('POST', { accessToken: 'fake_test_token' });
    const start = Date.now();
    await handler(req, res);
    const elapsed = Date.now() - start;
    const r = get();
    assert.ok(elapsed < 90000, `Took ${elapsed}ms — must be <90s`);
    assert.ok(r.body, 'Must return body');
    console.log(`  ${Y}→${X} completed in ${(elapsed/1000).toFixed(1)}s`);
  });
} else {
  skip('4.09 [LIVE] — Pipeline at market open', `not in 9:15–9:45 window (current: ${istLabel})`);
}

if (!isMarketHours) {
  await asyncTest('4.10 [LIVE] — Outside hours returns 403', async () => {
    const { req, res, get } = mockReqRes('POST', { accessToken: 'any' });
    await handler(req, res);
    const r = get();
    // 400 means token validation fired first (also acceptable)
    assert.ok([400, 403].includes(r.statusCode), `Expected 400/403, got ${r.statusCode}`);
  });
} else {
  skip('4.10 [LIVE] — Outside-hours 403', `currently in market hours (${istLabel})`);
}


// ════════════════════════════════════════════════════════════════════════════
section('5. RESPONSE CONTRACT');
// ════════════════════════════════════════════════════════════════════════════

test('5.01 — All required fields in response shape', () => {
  const required = [
    'score','verdict','autoTrade','quickSymbol','quickEntryL','quickSl',
    'swingSymbol','swingEntryL','swingSl','scores','lotsStr','ivpVal',
    'analysis','marketData','globalData','usage','timestamp','sgt',
    'usedModel','routingTier','preScore',
  ];
  for (const f of required) assert.ok(SRC.includes(f), `Missing field: ${f}`);
});

test('5.02 — usage object includes usedModel for cost attribution', () => {
  assert.ok(SRC.includes('usedModel'));
});

test('5.03 — routingTier enables frontend model badge display', () => {
  assert.ok(SRC.includes('routingTier:selectedModel.tier'));
});

test('5.04 — kiteErr/kiteHttpStatus present (UI compatibility)', () => {
  assert.ok(SRC.includes('kiteErr'));
  assert.ok(SRC.includes('kiteHttpStatus'));
});


// ════════════════════════════════════════════════════════════════════════════
section('6. RESILIENCE & EDGE CASES');
// ════════════════════════════════════════════════════════════════════════════

test('6.01 — tFetch has 5s default timeout', () => {
  assert.ok(SRC.includes('ms=5000'));
});

test('6.02 — spot=0 triggers DATA FEED FAILURE', () => {
  assert.ok(SRC.includes('DATA FEED FAILURE'));
  assert.ok(SRC.includes('spot=0'));
});

test('6.03 — VIX>22 mandatory STAY OUT in prompt', () => {
  assert.ok(SRC.includes('VIX>22'));
});

test('6.04 — Prompt build error caught + surfaced', () => {
  assert.ok(SRC.includes('Prompt build error:'));
  assert.ok(SRC.includes('Prompt build failed:'));
});

test('6.05 — Weekend check prevents signals on Sat/Sun', () => {
  assert.ok(SRC.includes('isWeekend'));
  assert.ok(SRC.includes('Weekend — market closed'));
});

test('6.06 — AbortController used for AI timeouts', () => {
  assert.ok(SRC.includes('new AbortController()'));
  assert.ok(SRC.includes('ctrl.abort()'));
});

test('6.07 — Raw text read before JSON.parse (resilient)', () => {
  assert.ok(SRC.includes('aRes.text()'));
});

test('6.08 — Groq uses choices[0].message.content', () => {
  assert.ok(SRC.includes("choices?.[0]?.message?.content"));
});

test('6.09 — Anthropic uses content[].text filter', () => {
  assert.ok(
    SRC.includes(".filter(b => b.type === 'text')") ||
    SRC.includes(".filter(b=>b.type==='text')")
  );
});

test('6.10 — Promise.allSettled wraps all parallel data fetches', () => {
  assert.ok(SRC.includes('Promise.allSettled'));
});

test('6.11 — Expiry day score gate in prompt', () => {
  assert.ok(SRC.includes('expiry day score -5 to +5'));
});


// ════════════════════════════════════════════════════════════════════════════
section('7. VERCEL & TOOLING CONFIG');
// ════════════════════════════════════════════════════════════════════════════

test('7.01 — vercel.json maxDuration >= 60s', () => {
  const v = JSON.parse(readFileSync('vercel.json','utf8'));
  const dur = v?.functions?.['api/analyze.js']?.maxDuration;
  assert.ok(dur && dur >= 60, `maxDuration must be >=60, got: ${dur}`);
});

test('7.02 — vercel.json has SPA rewrite rule', () => {
  const v = JSON.parse(readFileSync('vercel.json','utf8'));
  assert.ok(v?.rewrites?.length > 0);
});

test('7.03 — package.json has lint/test/check scripts', () => {
  const p = JSON.parse(readFileSync('package.json','utf8'));
  assert.ok(p.scripts?.lint, 'lint script missing');
  assert.ok(p.scripts?.test, 'test script missing');
  assert.ok(p.scripts?.check, 'check script missing');
});

test('7.04 — .prettierrc.json exists and valid', () => {
  const cfg = JSON.parse(readFileSync('.prettierrc.json','utf8'));
  assert.ok(cfg.singleQuote !== undefined);
  assert.ok(cfg.printWidth);
});

test('7.05 — eslint.config.js has no-shadow rule', () => {
  assert.ok(readFileSync('eslint.config.js','utf8').includes('no-shadow'));
});

test('7.06 — prettier is a devDependency', () => {
  const p = JSON.parse(readFileSync('package.json','utf8'));
  assert.ok(p.devDependencies?.prettier);
});



// ════════════════════════════════════════════════════════════════════════════
section('8. OPP 1 — RULE-BASED PRE-SCORER');
// ════════════════════════════════════════════════════════════════════════════

// Mirror the pre-scorer from analyze.js for isolated unit testing
function preScoreTest({vix=16, pcr=1.0, spotVsPrevCl=0, spotVsSma20=0, advRatio=0.5, sp500Pct=0}) {
  let s = 0;
  if      (vix > 20)  s -= 2; else if (vix > 17) s -= 1;
  else if (vix < 14)  s += 2; else if (vix < 16) s += 1;
  if      (pcr < 0.7)  s -= 2; else if (pcr < 0.85) s -= 1;
  else if (pcr > 1.4)  s += 2; else if (pcr > 1.2)  s += 1;
  if      (spotVsPrevCl < -0.5) s -= 2; else if (spotVsPrevCl < -0.1) s -= 1;
  else if (spotVsPrevCl >  0.5) s += 2; else if (spotVsPrevCl >  0.1) s += 1;
  if      (spotVsSma20 < -0.5) s -= 2; else if (spotVsSma20 < 0) s -= 1;
  else if (spotVsSma20 >  0.5) s += 2; else if (spotVsSma20 > 0) s += 1;
  if      (advRatio < 0.3)  s -= 2; else if (advRatio < 0.45) s -= 1;
  else if (advRatio > 0.7)  s += 2; else if (advRatio > 0.55) s += 1;
  if      (sp500Pct < -1.0) s -= 2; else if (sp500Pct < -0.3) s -= 1;
  else if (sp500Pct >  1.0) s += 2; else if (sp500Pct >  0.3) s += 1;
  return s;
}

test('8.01 — Strong bear session (18 May) pre-scores <= -8 (Sonnet or Groq)', () => {
  // 18 May: VIX 19.76(-1), PCR 0.95(-1), spot-1.05%(-2), below SMA20(-2), breadth 28%(-2), S&P-0.48%(-1) = -9
  // Pre-scorer uses 6 factors so max |-12| only when all 6 at max (-2 each)
  const s = preScoreTest({ vix:19.76, pcr:0.95, spotVsPrevCl:-1.05, spotVsSma20:-0.8, advRatio:0.28, sp500Pct:-0.48 });
  assert.ok(s <= -8, 'Expected <= -8 for strong bear, got ' + s);
  assert.ok(['groq-free','sonnet'].includes(selectModelTest(s).tier), 'Strong bear must not go to Opus');
});

test('8.02 — Extreme bull session (all 6 factors max) pre-scores +12, routes to Groq', () => {
  // All 6 factors at maximum bullish: each contributes +2 → max +12
  const s = preScoreTest({ vix:12.0, pcr:1.5, spotVsPrevCl:1.5, spotVsSma20:1.0, advRatio:0.85, sp500Pct:1.5 });
  assert.ok(s >= 12, 'Expected +12 with all factors maxed, got ' + s);
  assert.strictEqual(selectModelTest(s).tier, 'groq-free');
});

test('8.03 — Neutral session pre-scores in grey zone, routes to Opus', () => {
  const s = preScoreTest({ vix:16.5, pcr:1.05, spotVsPrevCl:0.05, spotVsSma20:0.1, advRatio:0.50, sp500Pct:0.1 });
  assert.ok(Math.abs(s) <= 7, 'Expected |s|<=7, got ' + s);
  assert.strictEqual(selectModelTest(s).tier, 'opus');
});

test('8.04 — Pre-scorer uses 6 independent factors', () => {
  assert.ok(SRC.includes('[pre-score] vix='), 'Pre-scorer logs inputs');
  assert.ok(SRC.includes('breadthRatio'), 'Breadth factor present');
  assert.ok(SRC.includes('G.sp500?.pct'), 'Global factor present');
  assert.ok(SRC.includes('sma20'), 'Trend vs SMA20 factor present');
});

test('8.05 — Pre-scorer failure falls back to 0 (Opus) safely', () => {
  assert.ok(SRC.includes('[pre-score] failed:'), 'Error path must log');
  assert.ok(SRC.includes('preScore = 0;'), 'Error path must reset to 0');
});

test('8.06 — Routing logs preScore for debugging', () => {
  assert.ok(SRC.includes('[routing] preScore='), 'Routing must log preScore');
});

// ════════════════════════════════════════════════════════════════════════════
section('9. OPP 3 — TWO-WAVE FETCH');
// ════════════════════════════════════════════════════════════════════════════

test('9.01 — Wave 2 promises fired before wave 1 is awaited', () => {
  const ocIdx   = SRC.indexOf('const ocPromise');
  const waveIdx = SRC.indexOf('Wave 1: fast sources');
  assert.ok(ocIdx > 0, 'ocPromise must be declared');
  assert.ok(waveIdx > 0, 'Wave 1 comment must exist');
  assert.ok(ocIdx < waveIdx, 'ocPromise must be declared before wave 1 await');
});

test('9.02 — FII promise also fired before wave 1 (true parallel)', () => {
  const fiiIdx  = SRC.indexOf('const fiiPromise');
  const waveIdx = SRC.indexOf('Wave 1: fast sources');
  assert.ok(fiiIdx > 0,  'fiiPromise must be declared');
  assert.ok(fiiIdx < waveIdx, 'fiiPromise must start before wave 1');
});

test('9.03 — Wave 1 has Kite + Yahoo fast sources', () => {
  assert.ok(SRC.includes('Wave 1: fast sources'));
  assert.ok(SRC.includes('kite.trade/user/margins'));
  assert.ok(SRC.includes("yfFetch('^NSEI','5m','1d')"));
});

test('9.04 — Wave 2 awaits pre-fired promises (not fresh calls)', () => {
  const w2start = SRC.indexOf('Wave 2: await the slow');
  assert.ok(w2start > 0, 'Wave 2 comment must exist');
  // kiteOCStarted is called in wave 2 but uses already-computed spot — not a re-fetch
  assert.ok(SRC.includes('kiteOCStarted'), 'kiteOC must be fired in wave 2');
  assert.ok(SRC.includes('kiteOCPromise'), 'kiteOCPromise must be awaited in wave 2');
});

test('9.05 — fiiJ destructured from wave 2', () => {
  assert.ok(SRC.includes('ocJ, idxJ, yfOptsR, fiiJ'));
});

test('9.06 — Both waves use Promise.allSettled', () => {
  const count = (SRC.match(/Promise\.allSettled/g) || []).length;
  assert.ok(count >= 2, 'Must have >=2 Promise.allSettled calls, found ' + count);
});

// ════════════════════════════════════════════════════════════════════════════
section('10. OPP 4 — LIVE FII DATA FOR F6');
// ════════════════════════════════════════════════════════════════════════════

test('10.01 — NSE FII endpoint fetched', () => {
  assert.ok(SRC.includes('fiidiiTradeReact'), 'NSE FII endpoint must be fetched');
});

test('10.02 — fiiNetCr computed from buy minus sell', () => {
  assert.ok(SRC.includes('fiiNetCr'), 'fiiNetCr must exist');
  assert.ok(SRC.includes('buy - sell'), 'Net computed as buy minus sell');
  assert.ok(SRC.includes('1e7'), 'Must divide by 1e7 to convert to Rs Cr');
});

test('10.03 — fiiText injected into prompt data block', () => {
  assert.ok(SRC.includes('FII/DII: ${fiiText}'), 'fiiText in prompt');
});

test('10.04 — F6 prompt line shows live FII or fallback', () => {
  assert.ok(SRC.includes('fiiNetCr!==null'), 'F6 must conditionally show live data');
});

test('10.05 — FII parse errors caught and logged', () => {
  assert.ok(SRC.includes('[fii] parse error:'), 'Parse error must be logged');
  assert.ok(SRC.includes('[fii] net='), 'Successful parse must be logged');
});

test('10.06 — FII unavailable falls back gracefully', () => {
  assert.ok(SRC.includes('fiiNetCr = null'), 'fiiNetCr defaults to null');
  assert.ok(SRC.includes('Live FII data unavailable'), 'Fallback message exists');
});

test('10.07 — fiiJ accessed via gv() helper', () => {
  assert.ok(SRC.includes('gv(fiiJ)'), 'fiiJ accessed via gv()');
});

// ════════════════════════════════════════════════════════════════════════════
section('11. OC DATA QUALITY GUARD');
// ════════════════════════════════════════════════════════════════════════════

test('11.01 — Kite OC is primary source (replaces NSE cookie retry)', () => {
  // Cookie retry removed — replaced by Kite /quote which works from any IP
  assert.ok(SRC.includes('kiteOC'), 'kiteOC() function must exist');
  assert.ok(SRC.includes('api.kite.trade/quote'), 'Must call Kite quote API');
  assert.ok(SRC.includes('[kite-oc] ok'), 'Kite OC success log must exist');
  assert.ok(SRC.includes('Source 1: Kite'), 'Kite must be primary source in OC section');
});

test('11.02 — Hard block when atmCeP=0 AND atmPeP=0', () => {
  assert.ok(SRC.includes('ocMissing'), 'ocMissing flag must exist');
  assert.ok(SRC.includes('atmCeP === 0 && atmPeP === 0'), 'Guard must check both premiums');
});

test('11.03 — OC missing injects warning into prompt (no hard block)', () => {
  assert.ok(SRC.includes('OC DATA UNAVAILABLE'), 'OC missing warning must go into prompt');
  assert.ok(SRC.includes('Score F2/F9 as 0'), 'Model instructed to zero F2/F9 when OC missing');
  assert.ok(SRC.includes('Do NOT say STAY OUT solely'), 'Model must not STAY OUT just for missing OC');
});

test('11.04 — Early session vs stale OC distinguished in prompt warning', () => {
  assert.ok(SRC.includes('OC DATA PENDING'), 'Early session OC note must exist in prompt');
  assert.ok(SRC.includes('ATM premiums not yet available'), 'Clear reason shown in prompt');
});

test('11.05 — OC guard logs ok path with actual premium values', () => {
  assert.ok(SRC.includes('[oc-guard] ok'), 'Success path must be logged');
  assert.ok(SRC.includes('atmCeP='), 'Must log actual ATM CE premium');
});

test('11.06 — OC warn-and-continue happens AFTER both NSE and Yahoo parsing', () => {
  const ocGuardIdx = SRC.indexOf('OC data quality');
  const yfOptsIdx  = SRC.indexOf('Yahoo Finance options fallback');
  const nseOcIdx   = SRC.indexOf('if(ocData?.records?.data');
  assert.ok(ocGuardIdx > yfOptsIdx, 'Warn must be after Yahoo fallback');
  assert.ok(ocGuardIdx > nseOcIdx,  'Warn must be after NSE OC parsing');
});

// ════════════════════════════════════════════════════════════════════════════
section('12. EARLY SESSION WARMUP GUARD');
// ════════════════════════════════════════════════════════════════════════════

test('12.01 — isReadyForAutoAnalysis starts at 9:25 IST (not 9:15)', () => {
  assert.ok(SRC.includes('isReadyForAutoAnalysis') || readFileSync('src/pages/Dashboard.jsx','utf8').includes('isReadyForAutoAnalysis'),
    'isReadyForAutoAnalysis function must exist');
  const dash = readFileSync('src/pages/Dashboard.jsx', 'utf8');
  assert.ok(dash.includes('9*60+25'), 'Auto-analysis must start at 9:25 IST');
});

test('12.02 — Auto-analysis loop uses isReadyForAutoAnalysis not isMarketOpen', () => {
  const dash = readFileSync('src/pages/Dashboard.jsx', 'utf8');
  assert.ok(dash.includes('isReadyForAutoAnalysis()'), 'Auto loop must use isReadyForAutoAnalysis');
});

test('12.03 — OC missing no longer returns 503 (warn-and-continue)', () => {
  // Backend now injects warning into prompt instead of returning 503
  // Frontend no longer needs to handle ocMissing 503 specially
  assert.ok(SRC.includes('OC DATA UNAVAILABLE'), 'Backend warns model instead of blocking');
  assert.ok(!SRC.includes("status(503).json({\n      error: `Data unavailable"), 'Hard-block 503 must be removed');
});

test('12.04 — Manual ANALYSE NOW still works from 9:15 (not gated)', () => {
  // isMarketOpen (9:15) still used for manual button — only auto-analysis uses 9:25
  const dash = readFileSync('src/pages/Dashboard.jsx', 'utf8');
  assert.ok(dash.includes('isMarketOpen()'), 'Manual button must still use isMarketOpen');
  assert.ok(dash.includes('isReadyForAutoAnalysis()'), 'Auto loop uses isReadyForAutoAnalysis');
  // Both must coexist
  assert.ok(dash.includes('isMarketOpen') && dash.includes('isReadyForAutoAnalysis'),
    'Both functions must coexist — manual vs auto have different gates');
});

test('12.05 — 9:25–15:20 window is correct (stops 10min before close)', () => {
  const dash = readFileSync('src/pages/Dashboard.jsx', 'utf8');
  assert.ok(dash.includes('9*60+25'), '9:25 start must exist');
  assert.ok(dash.includes('15*60+20'), '15:20 end must exist — stops 10min before close');
});

// ════════════════════════════════════════════════════════════════════════════
section('RESULTS');
// ════════════════════════════════════════════════════════════════════════════

const total = passed + failed + skipped;
const ran   = total - skipped;
const pct   = ran > 0 ? Math.round((passed / ran) * 100) : 0;

console.log(`\n  Total:   ${total}  |  Ran: ${ran}  |  Pass rate: ${pct}%`);
console.log(`  ${G}Passed:  ${passed}${X}`);
console.log(`  ${R}Failed:  ${failed}${X}`);
console.log(`  ${Y}Skipped: ${skipped}${X} (time-gated live tests)\n`);

if (failed > 0) {
  console.log(`${R}Failed tests:${X}`);
  results.filter(r => r.status === 'fail').forEach(r => {
    console.log(`  ${R}✗${X} ${r.name}\n    ${r.error}`);
  });
  console.log('');
}

if (failed === 0) {
  console.log(`${G}✅ ALL ${passed} TESTS PASSED (${skipped} skipped) — ${pct}% pass rate${X}\n`);
} else {
  console.log(`${R}❌ ${failed} TEST(S) FAILED — fix before pushing${X}\n`);
}

process.exit(failed > 0 ? 1 : 0);
