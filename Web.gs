/**
 * WEB LAYER — serves the dashboard and the functions it calls
 * -----------------------------------------------------------------------------
 * This is the Apps Script equivalent of the Azure version's Express server:
 * one deployment serves BOTH the page and the data, so they share an origin
 * and no cross-origin request ever happens.
 *
 * Add this as a SEPARATE FILE in the Apps Script project:
 *   Left sidebar > Files > + > Script > name it "Web"
 * And the dashboard as an HTML file:
 *   Left sidebar > Files > + > HTML > name it "index" (no .html — Apps
 *   Script adds that itself) > paste in index.html
 *
 * ===========================================================================
 * WHY THIS REPLACED THE JSON API (Sept 2026)
 *
 * The dashboard was originally a standalone index.html that called this
 * project's /exec URL with fetch(). Three separate problems killed that, all
 * from the same root — a static page calling Apps Script across origins:
 *
 * 1. A page opened from disk has origin "null", which Apps Script rejects.
 *    Hosting it (Vercel) fixed that one.
 * 2. Apps Script answers a POST with a redirect, and browsers re-issue a
 *    redirected POST as a GET — silently dropping the body. Login credentials
 *    never arrived; the request landed in doGet instead and came back "Not
 *    logged in". Unfixable from the page's side.
 * 3. Moving the credentials into the query string WOULD survive the redirect,
 *    but would write users' passwords into Google's execution logs in plain
 *    text. Not acceptable.
 *
 * Serving the page from here removes all three at once. google.script.run
 * is a direct same-origin call — no redirect, no preflight, no lost body.
 * ===========================================================================
 *
 * Every function below returns a JSON STRING rather than an object.
 * google.script.run can only pass simple types back, and a Date inside a
 * nested report object gets mangled on the way. Stringifying server-side and
 * parsing client-side keeps the payload byte-identical to what the old JSON
 * endpoint produced, so the dashboard's rendering code needed no changes.
 */

// ---------- Serve the page ----------
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Shift Board — Live')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// One message for every registration refusal except a too-short password.
// See the register branch below for why they're deliberately indistinct.
var REGISTRATION_REFUSED_MESSAGE =
  'Registration failed. Check your System ID, or contact your administrator to be added to the admin list.';

function jsonReply_(payload) {
  return JSON.stringify(payload);
}

function notLoggedInReply_() {
  return jsonReply_({ ok: false, notLoggedIn: true, error: 'Not logged in.' });
}

// ---------- Auth, called from the page ----------
// One entry point mirroring the old doPost, so the dashboard's apiPost()
// helper kept the same shape: pass { action, ... }, get { ok, ... } back.
function apiAuth(payload) {
  payload = payload || {};
  var action = payload.action;

  try {
    if (action === 'login') {
      // Checked out here rather than inside verifyLogin so that function
      // stays pure and keeps comparing cleanly against the Node original in
      // the verification harness — the same reason verifyActiveSession layers
      // its extra checks on top of verifySessionToken instead of inside it.
      if (loginIsThrottled_(payload.systemId)) {
        logRun('LOGIN_THROTTLED', 'System ID ' + payload.systemId);
        return jsonReply_({ ok: false, error: 'Too many failed attempts. Please try again in a few minutes.' });
      }
      if (!verifyLogin(payload.systemId, payload.password)) {
        recordLoginFailure_(payload.systemId);
        // Deliberately does not distinguish "no such account" from "wrong
        // password" — that difference tells an attacker which System IDs
        // are registered.
        logRun('LOGIN_FAILED', 'System ID ' + payload.systemId);
        return jsonReply_({ ok: false, error: 'Incorrect System ID or password.' });
      }
      clearLoginFailures_(payload.systemId);
      logRun('LOGIN', 'System ID ' + payload.systemId);
      return jsonReply_({ ok: true, token: createSessionToken(String(payload.systemId).trim()) });
    }

    if (action === 'register') {
      // The cheap allowlist check runs FIRST. getEmployees() costs several
      // Sprout API calls, and this endpoint is reachable without a session —
      // so doing the expensive work before validating turns any loop over
      // this action into amplified traffic against Sprout's rate limit.
      var candidateId = String(payload.systemId || '').trim();
      if (getAllowlist().indexOf(candidateId) === -1) {
        logRun('REGISTER_REFUSED', 'System ID ' + candidateId + ' is not on the allowlist');
        return jsonReply_({ ok: false, error: REGISTRATION_REFUSED_MESSAGE });
      }
      // The already-registered case has to be caught HERE too, not left to
      // registerAccount. getEmployees() is evaluated as its argument, so it
      // runs first — meaning a loop against one known allowlisted ID still
      // fired several Sprout calls per attempt even though the attempt could
      // never succeed. Same refusal message as every other branch, so this
      // still tells an unauthenticated caller nothing about which IDs exist.
      if (accountExists(candidateId)) {
        logRun('REGISTER_REFUSED', 'System ID ' + candidateId + ' is already registered');
        return jsonReply_({ ok: false, error: REGISTRATION_REFUSED_MESSAGE });
      }

      try {
        registerAccount(payload.systemId, payload.password, getEmployees());
      } catch (registerErr) {
        // Password-length failures are the user's own input and safe to
        // report precisely. Everything else — not a real employee, already
        // registered — is collapsed into one message, because distinct
        // errors let an unauthenticated caller map which System IDs are
        // allowlisted and which have not registered yet. An allowlisted
        // but unregistered ID is a free account to whoever claims it first.
        if (registerErr.message.indexOf('8 characters') !== -1) throw registerErr;
        logRun('REGISTER_REFUSED', 'System ID ' + candidateId + ': ' + registerErr.message);
        return jsonReply_({ ok: false, error: REGISTRATION_REFUSED_MESSAGE });
      }

      logRun('REGISTER', 'System ID ' + payload.systemId);
      return jsonReply_({ ok: true, token: createSessionToken(candidateId) });
    }

    if (action === 'resetAccount') {
      var session = verifyActiveSession(payload.token);
      if (!session) return notLoggedInReply_();
      resetAccount(payload.systemId);
      logRun('ACCOUNT_RESET', 'System ID ' + payload.systemId + ' reset by ' + session.systemId);
      return jsonReply_({ ok: true });
    }

    if (action === 'logout') {
      // Tokens are stateless and self-expiring, so there's nothing to
      // invalidate server-side — the page drops its stored copy. To force
      // everyone out at once, delete the SESSION_SECRET property (or run
      // invalidateAllSessions() in Debug.gs).
      return jsonReply_({ ok: true });
    }

    return jsonReply_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonReply_({ ok: false, error: err.message });
  }
}

// ---------- Session check, called on page load ----------
function apiSession(payload) {
  try {
    var session = verifyActiveSession((payload || {}).token);
    return jsonReply_({ ok: true, loggedIn: !!session, systemId: session ? session.systemId : null });
  } catch (err) {
    // loadAccounts_ now throws on an unreadable account store rather than
    // silently reporting "no accounts" — so this path has to answer
    // cleanly instead of surfacing as a raw failure to the page.
    Logger.log('Session check failed: ' + err.message);
    return jsonReply_({ ok: false, notLoggedIn: true, error: 'Sign-in is temporarily unavailable. Please try again shortly.' });
  }
}

// ---------- The report ----------
// payload: { token, days, from, to }. Mirrors the old endpoint's query
// parameters exactly, including which takes precedence.
function apiReport(payload) {
  payload = payload || {};
  try {
    if (!verifyActiveSession(payload.token)) {
      logRun('UNAUTHORIZED', 'Report request without a valid session token.');
      return notLoggedInReply_();
    }
  } catch (err) {
    Logger.log('Session check failed: ' + err.message);
    return notLoggedInReply_();
  }

  try {
    function summarize(report) {
      return 'late=' + report.late.length +
        ', presentButLate=' + report.presentButLate.length +
        ', onLeave=' + report.onLeave.length +
        ', onTime=' + report.onTime.length +
        ', didNotReport=' + report.didNotReport.length +
        ', restDay=' + report.restDay.length +
        ', holiday=' + report.holiday.length;
    }

    // A custom range wins if both dates are given, same as before.
    if (payload.from && payload.to) {
      var customResults = computeReportsForCustomRange(payload.from, payload.to);
      logRun('SUCCESS', 'Custom range (' + payload.from + ' to ' + payload.to + '): '
        + customResults.map(function (d) { return d.dateKey + ': ' + summarize(d.report); }).join(' | '));
      return jsonReply_({ ok: true, reports: customResults, generatedAt: new Date().toISOString() });
    }

    // Clamped to the same bound the custom-range path enforces. Unbounded,
    // a mistyped or edited value (days=100000) would build 100,000 day
    // objects and run tens of millions of classifications — here that means
    // a blown execution limit and wasted Sprout quota rather than a useful
    // answer.
    var requestedDays = Math.min(parseInt(payload.days, 10) || 0, MAX_CUSTOM_RANGE_DAYS);
    if (requestedDays && requestedDays > 1) {
      var dayResults = computeReportsForDateRange(requestedDays);
      logRun('SUCCESS', 'Multi-day (' + requestedDays + ' days): '
        + dayResults.map(function (d) { return d.dateKey + ': ' + summarize(d.report); }).join(' | '));
      return jsonReply_({ ok: true, reports: dayResults, generatedAt: new Date().toISOString() });
    }

    var report = computeTodayReport();
    var cacheState = report.scheduleAdjustmentCache || {};
    logRun('SUCCESS', summarize(report)
      + ' | cache: ' + (cacheState.lastRefreshedAt || 'never completed a full cycle')
      + ' (' + cacheState.employeesProcessed + '/' + cacheState.employeesTotal + ')'
      + (cacheState.lastError ? ' | cache error: ' + cacheState.lastError : ''));
    return jsonReply_({ ok: true, report: report, generatedAt: new Date().toISOString() });
  } catch (err) {
    logRun('FAILURE', err.message);
    return jsonReply_({ ok: false, error: err.message });
  }
}

// ---------- Cache nudge ----------
// Fired alongside a dashboard refresh to push the cache along sooner than the
// next trigger firing. Short budget, and returns immediately if a trigger
// firing already holds the lock. The page doesn't wait on it.
function apiNudge(payload) {
  try {
    if (!verifyActiveSession((payload || {}).token)) return notLoggedInReply_();
  } catch (err) {
    return notLoggedInReply_();
  }
  refreshScheduleCacheChunk(CACHE_NUDGE_BUDGET_MS);
  return jsonReply_({ ok: true, nudged: true, cache: getScheduleCacheStatus() });
}

// ---------- Leave approval date (on demand) ----------
// payload: { token, employeeId, date }. Called only when an admin hovers the
// icon on a leave row — three live Sprout calls per lookup, so it is
// deliberately never part of the report or the background refresh.
//
// Session-checked like every other data endpoint. That check is the whole
// reason this wrapper exists: the underlying getLeaveApprovalDate_ carries a
// trailing underscore so it is NOT reachable directly from the page.
function apiLeaveApprovalDate(payload) {
  payload = payload || {};
  try {
    if (!verifyActiveSession(payload.token)) return notLoggedInReply_();
  } catch (err) {
    return notLoggedInReply_();
  }
  try {
    return jsonReply_({ ok: true, ...getLeaveApprovalDate_(payload.employeeId, payload.date) });
  } catch (err) {
    // Detail goes to the execution log; the page gets a generic message.
    // These errors echo Sprout's own response shape, which has no business
    // reaching a browser.
    Logger.log('Leave approval date lookup failed: ' + err.message);
    logRun('LEAVE_APPROVAL_LOOKUP_FAILED', 'Employee ' + payload.employeeId + ' on ' + payload.date);
    return jsonReply_({ ok: false, error: 'Could not retrieve the approval date right now.' });
  }
}
