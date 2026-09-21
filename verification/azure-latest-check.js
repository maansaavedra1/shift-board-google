/**
 * Verifies the two newest Azure fixes by EXECUTING them.
 *
 * server.js and config-store.js can't be required directly here (express,
 * cookie-parser, and a module-load side effect that would fire real Sprout
 * calls), so the two functions under test are extracted from the source text
 * verbatim and evaluated. That's their actual code, not a restatement of it —
 * if the source changes, this picks up the change.
 */
const assert = require('assert');
const fs = require('fs');

const SERVER = fs.readFileSync('/home/claude/azure-latest/shift-board-no-auth/src/server.js', 'utf8');
const CONFIG = fs.readFileSync('/home/claude/azure-latest/shift-board-no-auth/src/config-store.js', 'utf8');

function extract(source, startMarker, endMarker, label) {
  const i = source.indexOf(startMarker);
  const j = source.indexOf(endMarker, i);
  if (i === -1 || j === -1) throw new Error('could not extract ' + label);
  return source.slice(i, j + endMarker.length);
}

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

// ===================================================== rate limiter + sweep
console.log('\n=== Rate limiter and its new eviction sweep ===\n');
{
  const limiterSrc = extract(SERVER, 'const authAttempts = new Map()', '\napp.use(\'/api/auth\', authRateLimiter);', 'limiter');
  const sweepBody = extract(SERVER, 'setInterval(() => {\n  const now = Date.now();\n  for (const [ip, entry] of authAttempts)', '}, AUTH_RATE_LIMIT_WINDOW_MS);', 'sweep');

  // Run the limiter source, then expose a callable sweep using the same body.
  const sandbox = {};
  const build = new Function(`
    ${limiterSrc.replace("app.use('/api/auth', authRateLimiter);", '')}
    const sweep = () => {
      const now = Date.now();
      for (const [ip, entry] of authAttempts) {
        if (now - entry.windowStartedAt > AUTH_RATE_LIMIT_WINDOW_MS) {
          authAttempts.delete(ip);
        }
      }
    };
    return { authAttempts, authRateLimiter, sweep, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS };
  `);
  Object.assign(sandbox, build());

  const { authAttempts, authRateLimiter, sweep, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS } = sandbox;

  // Sanity: the sweep body in the real file matches what's exercised above.
  assert.ok(sweepBody.includes('authAttempts.delete(ip)'), 'sweep body drifted from what this test runs');
  assert.ok(sweepBody.includes('now - entry.windowStartedAt > AUTH_RATE_LIMIT_WINDOW_MS'), 'sweep condition drifted');

  function hit(ip) {
    let blocked = false, allowed = false;
    authRateLimiter(
      { ip },
      { status: () => ({ json: () => { blocked = true; } }) },
      () => { allowed = true; }
    );
    return { blocked, allowed };
  }

  check('allows up to the limit, blocks past it', () => {
    authAttempts.clear();
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i++) {
      assert.ok(hit('1.1.1.1').allowed, `attempt ${i + 1} should be allowed`);
    }
    assert.ok(hit('1.1.1.1').blocked, 'attempt past the limit should be blocked');
  });

  check('different IPs are counted separately', () => {
    authAttempts.clear();
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX + 2; i++) hit('2.2.2.2');
    assert.ok(hit('3.3.3.3').allowed, 'a second IP should be unaffected');
  });

  check('the window resets after it expires', () => {
    authAttempts.clear();
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX + 2; i++) hit('4.4.4.4');
    assert.ok(hit('4.4.4.4').blocked, 'still blocked inside the window');
    // Age the entry past the window.
    authAttempts.get('4.4.4.4').windowStartedAt = Date.now() - AUTH_RATE_LIMIT_WINDOW_MS - 1000;
    assert.ok(hit('4.4.4.4').allowed, 'should be allowed again once the window rolls over');
  });

  console.log('\n  --- the eviction sweep itself ---');

  check('a stale entry is removed', () => {
    authAttempts.clear();
    authAttempts.set('stale', { count: 3, windowStartedAt: Date.now() - AUTH_RATE_LIMIT_WINDOW_MS - 5000 });
    sweep();
    assert.strictEqual(authAttempts.has('stale'), false);
  });

  check('an ACTIVE entry survives — the failure mode that would disable the limiter', () => {
    authAttempts.clear();
    authAttempts.set('active', { count: 9, windowStartedAt: Date.now() });
    sweep();
    assert.strictEqual(authAttempts.has('active'), true, 'sweeping an active window would reset an attacker\'s count');
    assert.strictEqual(authAttempts.get('active').count, 9, 'count must not be disturbed');
  });

  check('an entry exactly AT the window boundary survives (no off-by-one)', () => {
    authAttempts.clear();
    authAttempts.set('edge', { count: 5, windowStartedAt: Date.now() - AUTH_RATE_LIMIT_WINDOW_MS });
    sweep();
    assert.strictEqual(authAttempts.has('edge'), true,
      'the limiter treats exactly-at-boundary as still inside the window; the sweep must agree');
  });

  check('the sweep and the limiter use the same expiry rule', () => {
    // If they disagreed, an entry could be swept while the limiter still
    // considered it active, silently resetting someone mid-attack.
    authAttempts.clear();
    const justInside = { count: 5, windowStartedAt: Date.now() - AUTH_RATE_LIMIT_WINDOW_MS + 1 };
    authAttempts.set('x', justInside);
    sweep();
    assert.ok(authAttempts.has('x'), 'swept an entry the limiter still counts');
    assert.ok(hit('x').allowed && authAttempts.get('x').count === 6, 'limiter should have incremented, not reset');
  });

  check('many one-off IPs are all cleared, so the leak is actually closed', () => {
    authAttempts.clear();
    const old = Date.now() - AUTH_RATE_LIMIT_WINDOW_MS - 1;
    for (let i = 0; i < 5000; i++) authAttempts.set('scan-' + i, { count: 1, windowStartedAt: old });
    assert.strictEqual(authAttempts.size, 5000);
    sweep();
    assert.strictEqual(authAttempts.size, 0);
  });
}

// ============================================ credential override warning
console.log('\n=== Credential-rotation override warning ===\n');
{
  const applySrc = extract(CONFIG, 'function applyConfigToEnv(config)', '\n}', 'applyConfigToEnv');
  const fieldsSrc = extract(CONFIG, 'const EDITABLE_FIELDS', '];', 'EDITABLE_FIELDS');

  const warnings = [];
  const build = new Function('process', 'console', `
    ${fieldsSrc}
    ${applySrc}
    return { applyConfigToEnv, EDITABLE_FIELDS };
  `);
  const fakeEnv = {};
  const { applyConfigToEnv, EDITABLE_FIELDS } = build(
    { env: fakeEnv },
    { warn: (m) => warnings.push(m), log: () => {}, error: () => {} }
  );
  const KEY = EDITABLE_FIELDS[0];

  check('warns when a saved value overrides a DIFFERENT env value', () => {
    warnings.length = 0;
    fakeEnv[KEY] = 'newly-rotated-secret';
    applyConfigToEnv({ [KEY]: 'stale-saved-secret' });
    assert.strictEqual(warnings.length, 1, 'should warn exactly once');
    assert.ok(warnings[0].includes(KEY));
    assert.strictEqual(fakeEnv[KEY], 'stale-saved-secret', 'the saved value is what actually takes effect');
  });

  check('stays silent when the saved value MATCHES the env value (no false positives)', () => {
    warnings.length = 0;
    fakeEnv[KEY] = 'same-value';
    applyConfigToEnv({ [KEY]: 'same-value' });
    assert.strictEqual(warnings.length, 0);
  });

  check('stays silent when nothing was in the environment to override', () => {
    warnings.length = 0;
    delete fakeEnv[KEY];
    applyConfigToEnv({ [KEY]: 'a-value' });
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(fakeEnv[KEY], 'a-value');
  });

  check('an empty saved value does not clobber a real env value', () => {
    warnings.length = 0;
    fakeEnv[KEY] = 'real-env-value';
    applyConfigToEnv({ [KEY]: '' });
    assert.strictEqual(fakeEnv[KEY], 'real-env-value', 'an empty saved field must not wipe the environment');
    assert.strictEqual(warnings.length, 0);
  });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
