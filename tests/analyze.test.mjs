// tests/analyze.test.mjs
import { readFileSync, writeFileSync } from 'fs';
import { strict as assert } from 'assert';

// Color output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`${GREEN}✓${RESET} ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`${RED}✗${RESET} ${name}`);
    console.log(`  ${RED}${err.message}${RESET}`);
    if (err.stack) {
      console.log(`  ${err.stack.split('\n').slice(1, 3).join('\n')}`);
    }
    testsFailed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`${GREEN}✓${RESET} ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`${RED}✗${RESET} ${name}`);
    console.log(`  ${RED}${err.message}${RESET}`);
    if (err.stack) {
      console.log(`  ${err.stack.split('\n').slice(1, 3).join('\n')}`);
    }
    testsFailed++;
  }
}

console.log('\n=== STATIC ANALYSIS ===\n');

// Test 1: File loads without syntax errors
test('analyze.js has valid JavaScript syntax', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  // Write to temp file and try to parse
  writeFileSync('/tmp/test-syntax.mjs', src.replace('export default', 'export'));
  // If this throws, syntax is broken
  import('/tmp/test-syntax.mjs');
});

// Test 2: No duplicate catch blocks
test('No duplicate catch blocks on same try', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  const lines = src.split('\n');
  
  let inTry = false;
  let catchCount = 0;
  let braceDepth = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Track brace depth
    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;
    
    if (line.startsWith('try') && line.includes('{')) {
      inTry = true;
      catchCount = 0;
    }
    
    if (inTry && line.startsWith('} catch')) {
      catchCount++;
      if (catchCount > 1) {
        throw new Error(`Duplicate catch block at line ${i + 1}: ${line}`);
      }
    }
    
    // Reset when try-catch completes
    if (inTry && braceDepth === 0 && catchCount > 0) {
      inTry = false;
    }
  }
});

// Test 3: No literal newlines in single-quoted strings
test('No literal newlines in single-quoted strings', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  const lines = src.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for single quote starting a string but no closing quote on same line
    const singleQuotes = line.match(/'/g) || [];
    if (singleQuotes.length === 1) {
      // Could be multiline — check if next line closes it
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.trim().startsWith("';") || nextLine.trim().startsWith("'")) {
          throw new Error(`Literal newline in single-quoted string at line ${i + 1}: ${line.slice(0, 60)}`);
        }
      }
    }
  }
});

// Test 4: Node.js Runtime (no Edge config)
test('Uses Node.js runtime (no Edge config)', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  assert.ok(!src.includes("runtime: 'edge'"), 'Should NOT have Edge Runtime config - using Node.js runtime');
});

// Test 5: Correct model ID format (supports both Claude and DeepSeek)
test('Uses correct Anthropic or DeepSeek model ID', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  
  // Should have either claude-sonnet-4-6 or deepseek-v4-flash
  const hasClaudeModel = src.includes('claude-sonnet-4-6') || src.includes('claude-opus-4-6') || src.includes('claude-haiku-4-5');
  const hasDeepSeekModel = src.includes('deepseek-v4-flash') || src.includes('deepseek-v4-pro');
  
  assert.ok(hasClaudeModel || hasDeepSeekModel, 'No valid model specified (should have claude-sonnet-4-6 or deepseek-v4-flash)');
});

// Test 6: Uses Node.js runtime API (res.status().json()), not Edge Runtime
test('Uses Node.js runtime API (res.status().json())', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  
  // Should have res.status().json() pattern (Node.js runtime)
  const nodePattern = /res\.status\(\d+\)\.json\(/;
  assert.ok(nodePattern.test(src), 'Missing Node.js pattern res.status().json()');
  
  // Should NOT have "new Response" (Edge Runtime)
  assert.ok(!src.includes('new Response('), 'Should NOT use Edge Runtime new Response() — using Node.js runtime');
});

// Test 7: No const shadowing in critical sections
test('No const shadowing of outer let variables', () => {
  const src = readFileSync('api/analyze.js', 'utf8');
  
  // Find "let dataBlock, prompt" declaration
  const outerDecl = src.match(/let\s+(dataBlock|prompt)/);
  if (!outerDecl) return; // Not using this pattern
  
  // Check there's no "const dataBlock =" or "const prompt =" later
  const lines = src.split('\n');
  let foundOuter = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('let dataBlock') || line.includes('let prompt')) {
      foundOuter = true;
      continue;
    }
    
    if (foundOuter) {
      if (line.match(/^\s+const\s+(dataBlock|prompt)\s*=/)) {
        throw new Error(`Line ${i + 1}: const shadows outer let: ${line.trim()}`);
      }
    }
  }
});

console.log('\n=== RUNTIME TESTS (Simulated Edge) ===\n');

// Load the handler
let src = readFileSync('api/analyze.js', 'utf8');
src = src.replace('export const config', '// config')
         .replace('export default async function handler', 'globalThis.testHandler = async function handler');
writeFileSync('/tmp/test-handler-final.mjs', src);
await import('/tmp/test-handler-final.mjs');
const handler = globalThis.testHandler;

// Helper to create Node.js-style mock req/res objects
function createNodeMocks(method, body = null) {
  const req = {
    method,
    body,
    headers: body ? { 'content-type': 'application/json' } : {}
  };
  
  let statusCode = 200;
  let responseBody = null;
  let headers = {};
  
  const res = {
    setHeader: (key, value) => { headers[key] = value; },
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      responseBody = data;
      return { statusCode, body: responseBody, headers };
    },
    end: () => {
      return { statusCode, body: '', headers };
    }
  };
  
  return { req, res, getResponse: () => ({ statusCode, body: responseBody, headers }) };
}

// Test 8: OPTIONS request returns 200
await asyncTest('OPTIONS request returns 200', async () => {
  const { req, res, getResponse } = createNodeMocks('OPTIONS');
  await handler(req, res);
  const response = getResponse();
  assert.strictEqual(response.statusCode, 200, `Expected 200, got ${response.statusCode}`);
});

// Test 9: POST without token returns 400 + JSON
await asyncTest('POST without accessToken returns 400 + JSON error', async () => {
  const { req, res, getResponse } = createNodeMocks('POST', {});
  await handler(req, res);
  const response = getResponse();
  assert.strictEqual(response.statusCode, 400, `Expected 400, got ${response.statusCode}`);
  
  assert.ok(response.body, 'Missing response body');
  assert.ok(response.body.error, 'Missing error field');
  assert.ok(response.body.error.includes('accessToken'), 'Error should mention accessToken');
});

// Test 10: Full pipeline returns valid JSON (will fail auth but shouldn't crash)
await asyncTest('Full pipeline returns valid JSON (even with fake token)', async () => {
  const { req, res, getResponse } = createNodeMocks('POST', { accessToken: 'fake_token_test' });
  
  const start = Date.now();
  await handler(req, res);
  const elapsed = Date.now() - start;
  const response = getResponse();
  
  // Should complete in reasonable time (no infinite loops)
  assert.ok(elapsed < 30000, `Took ${elapsed}ms — should be <30s`);
  
  // Should return JSON
  assert.ok(response.body, 'Missing response body');
  
  // Should have error (no real API key) or success structure
  assert.ok(response.body.error || response.body.score !== undefined, 'Response should have error or score field');
  
  console.log(`  ${YELLOW}→${RESET} Completed in ${(elapsed / 1000).toFixed(1)}s`);
  if (response.body.error) {
    console.log(`  ${YELLOW}→${RESET} Error (expected): ${response.body.error.slice(0, 80)}`);
  }
});

// Test 11: GET returns 405
await asyncTest('GET request returns 405 Method Not Allowed', async () => {
  const { req, res, getResponse } = createNodeMocks('GET');
  await handler(req, res);
  const response = getResponse();
  assert.strictEqual(response.statusCode, 405, `Expected 405, got ${response.statusCode}`);
});

console.log(`\n=== RESULTS ===`);
console.log(`${GREEN}Passed: ${testsPassed}${RESET}`);
console.log(`${RED}Failed: ${testsFailed}${RESET}`);

process.exit(testsFailed > 0 ? 1 : 0);
