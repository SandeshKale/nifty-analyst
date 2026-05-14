# Testing & Quality Assurance

This project includes a comprehensive linter and test suite that automatically runs before every push to prevent broken code from being deployed.

## Quick Start

```bash
# Run all checks manually
npm run check

# Run just the linter
npm run lint

# Run just the tests
npm run test
```

## Pre-Push Hook

**Every `git push` automatically runs the full test suite.** If any test fails, the push is blocked.

To bypass (NOT RECOMMENDED):
```bash
git push --no-verify
```

## What Gets Tested

### 1. ESLint (Static Analysis)
- ✅ Valid JavaScript syntax
- ✅ No unused variables
- ✅ No variable shadowing
- ✅ Proper const/let usage
- ✅ No duplicate catch blocks

### 2. Custom Static Checks
- ✅ Edge Runtime config present
- ✅ Correct Anthropic model ID format (`claude-3-5-haiku-YYYYMMDD`)
- ✅ Uses Edge Response API (not Lambda `res.json`)
- ✅ No `const` shadowing outer `let` variables
- ✅ No literal newlines in single-quoted strings

### 3. Runtime Tests (Simulated Edge)
- ✅ OPTIONS request → 200
- ✅ POST without token → 400 + JSON error
- ✅ POST with fake token → valid JSON response (even on auth error)
- ✅ GET request → 405
- ✅ Full pipeline completes within 30s

## Adding New Tests

Edit `tests/analyze.test.mjs`:

```javascript
// Sync test
test('Description of what you're testing', () => {
  assert.ok(someCondition, 'Error message if it fails');
});

// Async test
await asyncTest('Async test description', async () => {
  const result = await someAsyncFunction();
  assert.strictEqual(result.status, 200);
});
```

## CI/CD Integration (Optional)

The test suite can run in GitHub Actions. Create `.github/workflows/test.yml`:

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with: { node-version: '20' }
      - run: npm install
      - run: npm run check
```

## Troubleshooting

**Pre-push hook not running?**
```bash
chmod +x .git/hooks/pre-push
```

**ESLint errors you can't fix?**
Add `// eslint-disable-line rule-name` to that line only if it's a false positive.

**Tests timing out?**
The default timeout is 30 seconds per test. If your tests need longer, edit `tests/analyze.test.mjs`.
