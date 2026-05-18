#!/bin/bash
# scripts/check-all.sh — Nifty Analyst production quality gate
set -e

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
FAIL=0

ok()   { echo -e "${GREEN}  ✅ $1${NC}"; }
err()  { echo -e "${RED}  ❌ $1${NC}"; FAIL=$((FAIL+1)); }
hdr()  { echo -e "\n${YELLOW}[$1/6] $2...${NC}"; }

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   NIFTY ANALYST — PRODUCTION QUALITY GATE          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"

# 1. Syntax
hdr 1 "JavaScript syntax check"
node --check api/analyze.js && ok "api/analyze.js syntax valid" || { err "Syntax error"; exit 1; }

# 2. ESLint
hdr 2 "ESLint"
npx eslint api/ --quiet && ok "ESLint passed" || { err "ESLint failed"; exit 1; }

# 3. Prettier
hdr 3 "Prettier format check"
if npx prettier --check api/ --ignore-unknown 2>/dev/null; then
  ok "Code is formatted"
else
  echo -e "${YELLOW}  ⚠  Auto-fixing formatting...${NC}"
  npx prettier --write api/ --ignore-unknown 2>/dev/null
  ok "Auto-fixed (check git diff)"
fi

# 4. Smart routing logic
hdr 4 "Smart routing logic"
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const src = readFileSync('api/analyze.js', 'utf8');
const checks = [
  ['selectModel() routing function', src.includes('selectModel')],
  ['groq-free tier routing', src.includes('groq-free')],
  ['claude-opus-4-6 grey-zone', src.includes('claude-opus-4-6')],
  ['claude-sonnet-4-6 middle', src.includes('claude-sonnet-4-6')],
  ['callWithFallback() chain', src.includes('callWithFallback')],
  ['api.groq.com endpoint', src.includes('api.groq.com')],
  ['llama-3.3-70b-versatile model', src.includes('llama-3.3-70b-versatile')],
  ['80s market-open timeout', src.includes('80000')],
  ['Groq→Sonnet fallback log', src.includes('[fallback] Groq failed')],
  ['routingTier in response', src.includes('routingTier')],
  ['usedModel in response', src.includes('usedModel')],
  ['temperature:0.1 (deterministic)', src.includes('temperature: 0.1')],
];
let ok = true;
for (const [label, result] of checks) {
  if (result) { console.log(`    ✓ ${label}`); }
  else { console.error(`    ✗ MISSING: ${label}`); ok = false; }
}
if (!ok) process.exit(1);
EOF
ok "Routing logic verified"

# 5. Vercel config
hdr 5 "Vercel config"
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
const dur = v?.functions?.['api/analyze.js']?.maxDuration;
if (!dur || dur < 60) { console.error(`maxDuration must be >=60, got: ${dur}`); process.exit(1); }
console.log(`    ✓ maxDuration: ${dur}s`);
console.log(`    ✓ rewrites: ${v.rewrites?.length || 0} rule(s)`);
EOF
ok "vercel.json valid"

# 6. Test suite
hdr 6 "Test suite"
node tests/analyze.test.mjs && ok "All tests passed" || { err "Tests failed"; exit 1; }

# Summary
echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${BLUE}║${NC}  ${GREEN}✅ ALL CHECKS PASSED — SAFE TO PUSH${NC}            ${BLUE}║${NC}"
else
  echo -e "${BLUE}║${NC}  ${RED}❌ $FAIL CHECK(S) FAILED — DO NOT PUSH${NC}            ${BLUE}║${NC}"
fi
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""
exit $FAIL
