/**
 * AUTHENTICATION — System ID + password login for the Shift Board dashboard
 * -----------------------------------------------------------------------------
 * Ported from the Node version's src/auth-store.js. Same model: registration
 * is restricted to a dev-curated allowlist of System IDs, and each one is
 * double-checked against real Sprout employee data at registration time, so
 * nobody can register under a System ID that isn't actually an employee even
 * if it ended up on the allowlist by mistake.
 *
 * Add this as a SEPARATE FILE in the Apps Script project:
 *   Left sidebar > Files > + > Script > name it "Auth"
 *
 * SETUP — one Script Property is required:
 *   ADMIN_ALLOWLIST = comma-separated System IDs allowed to register
 *                     (e.g. 2414,2767,2696)
 * SESSION_SECRET is generated and saved automatically the first time it's
 * needed, so unlike the Node version there's nothing to set and sessions
 * survive restarts by default.
 *
 * ===========================================================================
 * THREE DELIBERATE DIFFERENCES FROM THE NODE VERSION — read before relying
 * on this, because two of them are genuinely weaker.
 *
 * 1. SESSIONS ARE localStorage TOKENS, NOT httpOnly COOKIES.
 *    Apps Script web apps are served inside a Google-controlled wrapper and
 *    cannot set an httpOnly cookie the way Express can. So login returns an
 *    HMAC-signed token which the dashboard keeps in localStorage and sends
 *    on each request. The token format and signing are otherwise IDENTICAL
 *    to Node's (`systemId.expiry.hmacSha256`).
 *    WEAKER BECAUSE: an httpOnly cookie is unreadable by JavaScript, so XSS
 *    on the page cannot steal it. A localStorage token can be read by any
 *    script running on that page. The dashboard is a static file that loads
 *    no third-party scripts except the XLSX library from cdnjs, so the
 *    exposure is small — but it is not zero, and it is more than Azure has.
 *
 * 2. PASSWORD HASHING IS ITERATED SHA-256, NOT BCRYPT.
 *    Apps Script has no npm, so bcryptjs isn't available. This uses a
 *    PBKDF2-style loop over Utilities.computeHmacSha256Signature with a
 *    random 32-byte per-account salt.
 *    WEAKER BECAUSE: bcrypt is deliberately memory-hard and GPU-hostile;
 *    iterated SHA-256 is not. An attacker who obtained the stored hashes
 *    could brute-force them far faster than they could bcrypt hashes.
 *    Mitigations: a 3-person allowlist, an 8-character minimum, and the
 *    hashes live in Script Properties, readable only by someone who already
 *    has edit access to this project (who could equally just read this code).
 *    Tune PASSWORD_HASH_ITERATIONS with timePasswordHash() in Debug.gs —
 *    higher is better, bounded by how long you'll accept a login taking.
 *
 * 3. ACCOUNTS LIVE IN SCRIPT PROPERTIES, NOT A JSON FILE ON DISK.
 *    Equivalent durability, and no Docker-volume caveat. At a handful of
 *    admins this is nowhere near the 9KB-per-property limit. If the admin
 *    list ever grows past ~50 people, move this to a Sheet like the
 *    schedule cache.
 * ===========================================================================
 */

var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, matching the Node version
var ACCOUNTS_PROPERTY = 'ADMIN_ACCOUNTS';
var SESSION_SECRET_PROPERTY = 'SESSION_SECRET';

// Raise this until a login takes about as long as you're willing to wait —
// run timePasswordHash() in Debug.gs to measure it on your own account
// rather than guessing. Every iteration is one HMAC-SHA256 call.
var PASSWORD_HASH_ITERATIONS = 10000;

// ---------- Session secret ----------
// The Node version falls back to a per-process random key when
// SESSION_SECRET isn't set, which logs everyone out on every restart. Here
// it can simply be generated once and persisted, so that failure mode
// doesn't exist. Rotating it (deleting the property) invalidates every
// outstanding session, which is the intended way to force everyone out.
function getSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty(SESSION_SECRET_PROPERTY);
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty(SESSION_SECRET_PROPERTY, secret);
    Logger.log('SESSION_SECRET was not set — generated and saved one. Existing sessions (if any) are now invalid.');
  }
  return secret;
}

function getAllowlist() {
  var raw = PropertiesService.getScriptProperties().getProperty('ADMIN_ALLOWLIST') || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
}

// ---------- Account storage ----------
function loadAccounts_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ACCOUNTS_PROPERTY);
  if (!raw) return {}; // genuinely no accounts yet — a normal, safe state
  // Deliberately NOT caught. A value that exists but won't parse is a
  // completely different situation from "no accounts yet", and callers
  // must be able to tell them apart. Silently returning {} for both meant
  // the next registration would save a store containing only that one
  // account — permanently destroying everyone else who was in the
  // unreadable value. Failing loudly is the safer outcome.
  return JSON.parse(raw);
}

function saveAccounts_(accounts) {
  PropertiesService.getScriptProperties().setProperty(ACCOUNTS_PROPERTY, JSON.stringify(accounts));
}

// ---------- Password hashing ----------
function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    // Apps Script signed bytes are -128..127; mask back to 0..255.
    var v = (bytes[i] + 256) % 256;
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

function randomSalt_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// PBKDF2-style: repeatedly HMAC the running digest with the salt as the key.
// Not bcrypt — see the header note on why, and what that costs.
function hashPassword_(password, salt, iterations) {
  var current = String(password);
  for (var i = 0; i < iterations; i++) {
    current = bytesToHex_(Utilities.computeHmacSha256Signature(current, salt));
  }
  return current;
}

// Constant-time string comparison — avoids leaking how much of a hash or
// signature matched via response timing. Same intent as Node's
// crypto.timingSafeEqual.
function constantTimeEquals_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------- Registration / login ----------
// Confirms a System ID corresponds to a real, currently-returned Sprout
// employee — not just a well-formed number. Takes the already-fetched
// employee list rather than fetching itself.
function isRealEmployee_(systemId, employees) {
  return employees.some(function (emp) {
    return String((emp.basicInformation || {}).systemId) === String(systemId);
  });
}

function registerAccount(systemId, password, employees) {
  systemId = String(systemId).trim();
  if (!systemId || !password) {
    throw new Error('System ID and password are both required.');
  }
  if (String(password).length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (getAllowlist().indexOf(systemId) === -1) {
    throw new Error('This System ID is not on the approved admin list. Contact your administrator to be added.');
  }
  if (!isRealEmployee_(systemId, employees)) {
    throw new Error('This System ID does not match a current Sprout employee record.');
  }

  var accounts = loadAccounts_();
  if (accounts[systemId]) {
    throw new Error('An account for this System ID already exists. Use the login screen instead.');
  }

  var salt = randomSalt_();
  accounts[systemId] = {
    salt: salt,
    iterations: PASSWORD_HASH_ITERATIONS,
    passwordHash: hashPassword_(password, salt, PASSWORD_HASH_ITERATIONS),
    registeredAt: new Date().toISOString()
  };
  saveAccounts_(accounts);
}

function verifyLogin(systemId, password) {
  systemId = String(systemId).trim();
  // The allowlist is rechecked on EVERY login, not just at registration.
  // Without this, removing someone from ADMIN_ALLOWLIST wouldn't revoke
  // anything — their stored account would keep working indefinitely, which
  // is the one security operation a small admin tool has to get right.
  if (getAllowlist().indexOf(systemId) === -1) return false;
  var account = loadAccounts_()[systemId];
  if (!account) return false;
  // Uses the iteration count stored ON THE ACCOUNT, not the current
  // constant — so raising PASSWORD_HASH_ITERATIONS later doesn't lock out
  // everyone who registered before the change.
  var iterations = account.iterations || PASSWORD_HASH_ITERATIONS;
  var candidate = hashPassword_(password || '', account.salt, iterations);
  return constantTimeEquals_(candidate, account.passwordHash);
}

// ---------- Login throttle ----------
// The Node version rate-limits /api/auth per IP. Apps Script can't do that:
// a google.script.run call arrives with no caller IP exposed to the script at
// all, so there is no per-client axis to count on. The only identifier a
// login attempt carries is the System ID being attempted, so that is what
// this counts.
//
// That difference matters and is worth stating plainly: throttling by System
// ID means someone who knows an admin's System ID can deliberately exhaust
// the window and keep that admin out until it rolls over. With a handful of
// admins that is a real nuisance, so the threshold is set well above anything
// a person mistyping their password would hit, and the window is short.
// A successful login clears the counter.
//
// Stronger fix available if it ever matters: redeploy the web app as
// "Anyone with a Google account" instead of "Anyone". Sign-in then happens at
// Google before a single line of this runs, and anonymous brute force stops
// being reachable in the first place. It costs everyone a Google login.
//
// Two known imprecisions, both accepted:
//   - concurrent attempts can race on the read-modify-write and let an extra
//     try or two through. LockService would close it, at the cost of a lock
//     round-trip on every login; not worth it for an off-by-two.
//   - the cache is best-effort storage. If an entry is evicted early the
//     counter resets. It degrades toward "no throttle", never toward locking
//     someone out wrongly, which is the right direction to fail in.
var LOGIN_MAX_ATTEMPTS = 10;
var LOGIN_WINDOW_MINUTES = 15;

function loginThrottleKey_(systemId) {
  return 'login-fail:' + String(systemId).trim();
}

// Returns true when this attempt should be refused without checking the
// password at all.
function loginIsThrottled_(systemId) {
  var raw = CacheService.getScriptCache().get(loginThrottleKey_(systemId));
  if (!raw) return false;
  var entry;
  try { entry = JSON.parse(raw); } catch (e) { return false; }
  var windowMs = LOGIN_WINDOW_MINUTES * 60 * 1000;
  if (Date.now() - entry.t > windowMs) return false;   // fixed window, same rule as the recorder
  return entry.c >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure_(systemId) {
  var cache = CacheService.getScriptCache();
  var key = loginThrottleKey_(systemId);
  var windowMs = LOGIN_WINDOW_MINUTES * 60 * 1000;
  var entry = { c: 0, t: Date.now() };
  var raw = cache.get(key);
  if (raw) {
    try {
      var prev = JSON.parse(raw);
      if (Date.now() - prev.t <= windowMs) entry = prev;   // still inside the window: keep counting
    } catch (e) { /* unparseable: start a fresh window */ }
  }
  entry.c += 1;
  // TTL matches the window so a quiet System ID disappears on its own —
  // the equivalent of the Node side's eviction sweep, handled by the cache.
  cache.put(key, JSON.stringify(entry), LOGIN_WINDOW_MINUTES * 60);
}

function clearLoginFailures_(systemId) {
  CacheService.getScriptCache().remove(loginThrottleKey_(systemId));
}

function accountExists(systemId) {
  return !!loadAccounts_()[String(systemId).trim()];
}

// Admin-assisted reset: any currently logged-in admin can clear another
// account's entry, letting that System ID register fresh with a new
// password. Deliberately not self-service — someone who forgot their
// password can't log in, so they couldn't trigger it themselves anyway.
// With a small, known set of admins, one of them vouching by already being
// logged in is the verification here.
function resetAccount(systemId) {
  systemId = String(systemId).trim();
  var accounts = loadAccounts_();
  if (!accounts[systemId]) {
    throw new Error('No account exists for this System ID.');
  }
  delete accounts[systemId];
  saveAccounts_(accounts);
}

// ---------- Session tokens ----------
// "<systemId>.<expiryMs>.<hmacSignature>" — identical in shape to the Node
// version's signed cookie. No server-side session store: the signature
// proves it wasn't tampered with, and the expiry is checked every request.
function createSessionToken(systemId) {
  var expiresAt = Date.now() + SESSION_TTL_MS;
  var payload = systemId + '.' + expiresAt;
  var signature = bytesToHex_(Utilities.computeHmacSha256Signature(payload, getSessionSecret_()));
  return payload + '.' + signature;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 3) return null;

  var systemId = parts[0];
  var expiresAtStr = parts[1];
  var signature = parts[2];

  var expected = bytesToHex_(Utilities.computeHmacSha256Signature(systemId + '.' + expiresAtStr, getSessionSecret_()));
  if (!constantTimeEquals_(signature, expected)) return null;

  var expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return null; // expired

  return { systemId: systemId };
}

// Validates a token AND confirms the holder is still entitled to use it.
// verifySessionToken alone only proves the token was signed by us and hasn't
// expired — it says nothing about whether the account still exists or is
// still on the allowlist. Sessions are stateless with a 12-hour TTL, so
// without this check an admin who was removed, or whose account was reset,
// keeps full access until their token happens to expire.
//
// Deliberately layered on top of verifySessionToken rather than folded into
// it: that function's job is the signing scheme, and it is verified against
// the Node implementation byte-for-byte. This is the authorisation on top.
function verifyActiveSession(token) {
  var session = verifySessionToken(token);
  if (!session) return null;
  if (getAllowlist().indexOf(session.systemId) === -1) return null;
  if (!accountExists(session.systemId)) return null;
  return session;
}

// The doGet/doPost equivalent of Node's requireSession middleware. Returns
// the session on success, or null — callers turn null into an ok:false
// response, since Apps Script can't return a real 401.
function sessionFromRequest(e) {
  var token = (e && e.parameter && e.parameter.token) || null;
  if (!token && e && e.postData && e.postData.contents) {
    try {
      token = JSON.parse(e.postData.contents).token || null;
    } catch (err) { /* not JSON — no token */ }
  }
  return verifySessionToken(token);
}
