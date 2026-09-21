/**
 * Verifies Auth.gs against the Node original (src/auth-store.js).
 *
 * The headline test is cross-compatibility: a session token minted by the
 * Apps Script implementation must validate under Node's verifySessionToken
 * with the same secret, and vice versa. If those two agree, the signing
 * scheme really was ported rather than reinvented.
 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const shim = require('./gas-shim.js');

const SHARED_SECRET = 'test-secret-for-verification-only-0123456789';

// --- Node side ---
process.env.SESSION_SECRET = SHARED_SECRET;
process.env.ADMIN_ALLOWLIST = '2414,2767,2696';
const nodeAuth = require('./node-auth-store.js');

// --- Apps Script side ---
const sandbox = Object.assign({}, shim, {
  console, Date, Math, JSON, Intl, RegExp, String, Number, Object, Array,
  isNaN, parseInt, parseFloat, Promise
});
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync('/home/claude/gas/shift-board-google-workspace/Auth.gs', 'utf8'),
  sandbox, { filename: 'Auth.gs' }
);

// Seed the Apps Script property store to match Node's env config.
const props = sandbox.PropertiesService.getScriptProperties();
props.setProperty('SESSION_SECRET', SHARED_SECRET);
props.setProperty('ADMIN_ALLOWLIST', '2414,2767,2696');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (err) { fail++; console.log('  FAIL  ' + name + '\n        ' + err.message); }
}

console.log('\n=== Auth.gs vs Node auth-store.js ===\n');

console.log('--- Session token cross-compatibility (the important one) ---');
check('a token minted by Apps Script validates under Node', () => {
  const token = sandbox.createSessionToken('2414');
  const session = nodeAuth.verifySessionToken(token);
  assert.ok(session, 'Node rejected an Apps Script token');
  assert.strictEqual(session.systemId, '2414');
});
check('a token minted by Node validates under Apps Script', () => {
  const token = nodeAuth.createSessionToken('2767');
  const session = sandbox.verifySessionToken(token);
  assert.ok(session, 'Apps Script rejected a Node token');
  assert.strictEqual(session.systemId, '2767');
});
check('both produce a byte-identical token for the same input', () => {
  const fixedNow = 1789000000000;
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    assert.strictEqual(sandbox.createSessionToken('2696'), nodeAuth.createSessionToken('2696'));
  } finally { Date.now = realNow; }
});

console.log('\n--- Tamper resistance ---');
check('a flipped signature is rejected', () => {
  const token = sandbox.createSessionToken('2414');
  const parts = token.split('.');
  parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'a' ? 'b' : 'a');
  assert.strictEqual(sandbox.verifySessionToken(parts.join('.')), null);
});
check('changing the systemId invalidates the token', () => {
  const token = sandbox.createSessionToken('2414');
  const parts = token.split('.');
  parts[0] = '9999';
  assert.strictEqual(sandbox.verifySessionToken(parts.join('.')), null);
});
check('extending the expiry invalidates the token', () => {
  const token = sandbox.createSessionToken('2414');
  const parts = token.split('.');
  parts[1] = String(Number(parts[1]) + 86400000);
  assert.strictEqual(sandbox.verifySessionToken(parts.join('.')), null);
});
check('an expired token is rejected', () => {
  const expired = '2414.' + (Date.now() - 1000) + '.';
  const sig = sandbox.verifySessionToken(expired + 'x');
  assert.strictEqual(sig, null);
  // and a correctly-signed but past-dated one:
  const realNow = Date.now;
  Date.now = () => 1000;
  let old;
  try { old = sandbox.createSessionToken('2414'); } finally { Date.now = realNow; }
  assert.strictEqual(sandbox.verifySessionToken(old), null);
});
check('malformed tokens are rejected without throwing', () => {
  ['', null, undefined, 'abc', 'a.b', 'a.b.c.d', '...'].forEach((t) => {
    assert.strictEqual(sandbox.verifySessionToken(t), null, 'accepted: ' + JSON.stringify(t));
  });
});

console.log('\n--- Registration rules (same as Node) ---');
const employees = [
  { basicInformation: { systemId: 2414 } },
  { basicInformation: { systemId: 2767 } },
  { basicInformation: { systemId: 3000 } }
];
function expectThrow(fn, fragment) {
  try { fn(); } catch (err) {
    assert.ok(err.message.toLowerCase().includes(fragment.toLowerCase()),
      'wrong error: ' + err.message);
    return;
  }
  throw new Error('expected a throw');
}
check('rejects a System ID not on the allowlist', () => {
  expectThrow(() => sandbox.registerAccount('3000', 'longenough1', employees), 'not on the approved admin list');
});
check('rejects an allowlisted ID that is not a real employee', () => {
  expectThrow(() => sandbox.registerAccount('2696', 'longenough1', employees), 'does not match a current Sprout employee');
});
check('rejects a password under 8 characters', () => {
  expectThrow(() => sandbox.registerAccount('2414', 'short', employees), 'at least 8 characters');
});
check('accepts a valid registration', () => {
  sandbox.registerAccount('2414', 'correct horse battery', employees);
  assert.ok(sandbox.accountExists('2414'));
});
check('rejects a duplicate registration', () => {
  expectThrow(() => sandbox.registerAccount('2414', 'another password', employees), 'already exists');
});

console.log('\n--- Login ---');
check('correct password succeeds', () => {
  assert.strictEqual(sandbox.verifyLogin('2414', 'correct horse battery'), true);
});
check('wrong password fails', () => {
  assert.strictEqual(sandbox.verifyLogin('2414', 'correct horse batteru'), false);
});
check('unknown account fails without throwing', () => {
  assert.strictEqual(sandbox.verifyLogin('9999', 'anything'), false);
});
check('empty password fails', () => {
  assert.strictEqual(sandbox.verifyLogin('2414', ''), false);
});
check('the password is never stored in plain text', () => {
  const raw = props.getProperty('ADMIN_ACCOUNTS');
  assert.ok(!raw.includes('correct horse battery'), 'plaintext password found in storage!');
  const stored = JSON.parse(raw)['2414'];
  assert.ok(stored.salt && stored.salt.length >= 32, 'salt missing or short');
  assert.ok(stored.passwordHash && stored.passwordHash.length === 64, 'hash is not a 32-byte hex digest');
});
check('two accounts with the same password get different hashes (salting works)', () => {
  sandbox.registerAccount('2767', 'correct horse battery', employees);
  const accounts = JSON.parse(props.getProperty('ADMIN_ACCOUNTS'));
  assert.notStrictEqual(accounts['2414'].passwordHash, accounts['2767'].passwordHash);
  assert.notStrictEqual(accounts['2414'].salt, accounts['2767'].salt);
});

console.log('\n--- Admin-assisted reset ---');
check('reset removes the account so it can register again', () => {
  sandbox.resetAccount('2414');
  assert.strictEqual(sandbox.accountExists('2414'), false);
  assert.strictEqual(sandbox.verifyLogin('2414', 'correct horse battery'), false);
  sandbox.registerAccount('2414', 'a brand new password', employees);
  assert.strictEqual(sandbox.verifyLogin('2414', 'a brand new password'), true);
});
check('resetting an unknown account throws', () => {
  expectThrow(() => sandbox.resetAccount('9999'), 'No account exists');
});

console.log('\n--- Raising the iteration count does not lock anyone out ---');
check('an account registered at the old count still logs in', () => {
  // Simulates bumping PASSWORD_HASH_ITERATIONS after people have registered.
  const accounts = JSON.parse(props.getProperty('ADMIN_ACCOUNTS'));
  assert.strictEqual(accounts['2414'].iterations, 10000, 'iteration count not recorded on the account');
  sandbox.PASSWORD_HASH_ITERATIONS = 20000;
  assert.strictEqual(sandbox.verifyLogin('2414', 'a brand new password'), true);
  sandbox.PASSWORD_HASH_ITERATIONS = 10000;
});

console.log('\n--- sessionFromRequest (doGet param and doPost body) ---');
check('reads the token from a query parameter', () => {
  const token = sandbox.createSessionToken('2414');
  assert.strictEqual(sandbox.sessionFromRequest({ parameter: { token: token } }).systemId, '2414');
});
check('reads the token from a JSON post body', () => {
  const token = sandbox.createSessionToken('2767');
  assert.strictEqual(
    sandbox.sessionFromRequest({ parameter: {}, postData: { contents: JSON.stringify({ token: token }) } }).systemId,
    '2767');
});
check('returns null with no token, and on unparseable bodies', () => {
  assert.strictEqual(sandbox.sessionFromRequest({ parameter: {} }), null);
  assert.strictEqual(sandbox.sessionFromRequest({ parameter: {}, postData: { contents: 'not json' } }), null);
  assert.strictEqual(sandbox.sessionFromRequest(undefined), null);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
