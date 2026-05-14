#!/bin/bash
# scripts/check-all.sh — Run all quality checks before commit/push

set -e  # Exit on first error

echo "╔════════════════════════════════════════════╗"
echo "║   NIFTY ANALYST — PRE-PUSH CHECKS          ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# 1. ESLint
echo "📝 [1/3] Running ESLint..."
npx eslint api/ --quiet || {
  echo "❌ ESLint failed. Fix errors above."
  exit 1
}
echo "✅ ESLint passed"
echo ""

# 2. Node syntax check
echo "🔍 [2/3] Checking JavaScript syntax..."
node --check api/analyze.js || {
  echo "❌ Syntax error in analyze.js"
  exit 1
}
echo "✅ Syntax valid"
echo ""

# 3. Run test suite
echo "🧪 [3/3] Running test suite..."
node tests/analyze.test.mjs || {
  echo "❌ Tests failed. Fix issues above."
  exit 1
}
echo ""

echo "╔════════════════════════════════════════════╗"
echo "║   ✅ ALL CHECKS PASSED — SAFE TO PUSH      ║"
echo "╚════════════════════════════════════════════╝"
