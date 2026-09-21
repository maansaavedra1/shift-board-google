/**
 * DEBUG / INSPECTION HELPERS
 * ---------------------------------------------------
 * These are development-time tools, not part of the actual report logic.
 * They call the same getEmployees()/getAttendanceLogs() functions defined
 * in Code.gs (Apps Script shares one global scope across all files in a
 * project, so this works without any imports).
 *
 * Add this as a SEPARATE FILE in your Apps Script project:
 *   Left sidebar > Files > + (next to "Files") > Script
 *   Name it "Debug", paste this content in, save.
 *
 * Before handing this project to a client, consider deleting this file
 * entirely (or at least not mentioning these functions to them) — they're
 * for your own troubleshooting, not part of the delivered product.
 */

// ---------- HELPER: (obsolete) the shared access key ----------
// DASHBOARD_ACCESS_KEY was replaced by per-person login in step 2 of the
// port — a shared secret pasted into a URL was exactly what the login
// system exists to get rid of. Kept only to point at what replaced it.
// Use inspectAccounts() below instead.
function checkAccessKeySetup() {
  var stale = PropertiesService.getScriptProperties().getProperty('DASHBOARD_ACCESS_KEY');
  Logger.log('DASHBOARD_ACCESS_KEY is no longer used — the dashboard authenticates with System ID + password now.');
  if (stale) {
    Logger.log('There is still a value saved in Script Properties. It does nothing; delete the property to tidy up.');
  }
  inspectAccounts();
}

// ---------- HELPER: inspect real attendance log structure from the live API ----------
// Confirms whether inOutMode comes back as text ("In"/"Out") or numbers (0/1),
// and shows a few real sample rows. Checks the last 30 days so it doesn't
// depend on guessing which exact date has data in this sandbox.
function inspectAttendanceLogStructure() {
  var now = new Date();
  var thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  var dateFromISO = Utilities.formatDate(thirtyDaysAgo, 'Asia/Manila', "yyyy-MM-dd'T'00:00:00");
  var dateToISO = Utilities.formatDate(now, 'Asia/Manila', "yyyy-MM-dd'T'23:59:59");
  var logs = getAttendanceLogs(dateFromISO, dateToISO);
  if (logs.length === 0) {
    Logger.log('No attendance logs found in the last 30 days. This sandbox may not have any test data yet — add some biologs in Sprout HR, then re-run this.');
    return;
  }
  Logger.log('Found ' + logs.length + ' log(s) in the last 30 days. Showing up to 5:');
  logs.slice(0, 5).forEach(function (log) {
    Logger.log(JSON.stringify(log, null, 2));
  });
}

// ---------- HELPER: inspect one employee's full data shape ----------
// Run this, then check the log to find the exact field names for
// department and supervisor before wiring them into the real report.
function inspectEmployeeStructure() {
  var employees = getEmployees();
  if (employees.length === 0) {
    Logger.log('No employees found.');
    return;
  }
  Logger.log('Full structure of first employee record:');
  Logger.log(JSON.stringify(employees[0], null, 2));
}

// ---------- HELPER: clear the schedule/leave cache ----------
// Schedule adjustments and leave are BOTH cached again as of the Sept 2026
// port — not for speed, but because the only real endpoint needs one call
// per employee, which is far too slow to run inline on a dashboard refresh.
// See the cache section in Code.gs. This just forwards to the real function.
function clearScheduleAdjustmentsCache() {
  resetScheduleCache();
}

// ---------- HELPER: where is the cache sheet, and how fresh is it? ----------
function inspectScheduleCache() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SCHEDULE_CACHE_SHEET_ID');
  var status = getScheduleCacheStatus();

  Logger.log('Cache sheet: ' + (sheetId
    ? 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit'
    : 'not created yet — run refreshScheduleCacheChunk() once'));
  Logger.log('Last completed full cycle: ' + (status.lastRefreshedAt || 'NEVER — the cache has not finished a full pass yet'));
  Logger.log('Progress through current cycle: ' + status.employeesProcessed + ' / ' + status.employeesTotal);
  Logger.log('Currently running: ' + status.isRefreshing);
  Logger.log('Last error: ' + (status.lastError || 'none'));

  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'refreshScheduleCacheChunk';
  });
  Logger.log('Refresh triggers installed: ' + triggers.length
    + (triggers.length === 0 ? '  <-- RUN installScheduleCacheTrigger() OR NOTHING WILL EVER CACHE' : ''));
}

// ---------- HELPER: run one cache chunk right now ----------
// Run this from the editor the first time, both to grant permissions and to
// start filling the cache without waiting for the trigger. A full cycle at
// ~359 employees takes several runs — see the cache section in Code.gs.
function runOneCacheChunkNow() {
  refreshScheduleCacheChunk();
  inspectScheduleCache();
}

// ---------- HELPER: check one employee's computed shift boundaries ----------
// This is the direct test for the "893 minutes late" bug. For an employee
// with a schedule adjustment on the given day, `start` and `end` must be
// REAL dates — if either prints as "Invalid Date", the adjustment value is
// being parsed with the wrong parser again.
function inspectShiftBoundaries() {
  var searchText = 'cuenca';        // <-- the employee to check
  var dayKey = formatDateKey(new Date()); // <-- or hardcode 'YYYY-MM-DD'

  var employees = getEmployees();
  var matches = employees.filter(function (emp) {
    var basic = emp.basicInformation || {};
    var fullName = (basic.firstName || '') + ' ' + (basic.lastName || '');
    return fullName.toLowerCase().indexOf(searchText.toLowerCase()) !== -1;
  });
  if (matches.length === 0) {
    Logger.log('No employee found matching "' + searchText + '".');
    return;
  }

  matches.forEach(function (emp) {
    var basic = emp.basicInformation || {};
    var systemId = basic.systemId;
    var schedule = emp.workSchedule || {};
    var adjustment = getCachedAdjustment(systemId, dayKey);
    var boundaries = getShiftBoundariesForDay(systemId, dayKey, schedule);

    Logger.log('--- ' + (basic.firstName || '') + ' ' + (basic.lastName || '') + ' (systemId ' + systemId + ') on ' + dayKey + ' ---');
    Logger.log('Cached adjustment: ' + (adjustment ? JSON.stringify(adjustment) : 'none (falling back to the default weekly schedule)'));
    Logger.log('Weekday: ' + weekdayForDayKey(dayKey));
    if (!boundaries) {
      Logger.log('Result: REST DAY — no shift boundaries for this day.');
      return;
    }
    Logger.log('Shift start: ' + boundaries.start + (boundaries.start && isNaN(boundaries.start.getTime()) ? '   <-- INVALID DATE, the 893-minute bug is back' : ''));
    Logger.log('Shift end:   ' + boundaries.end + (boundaries.end && isNaN(boundaries.end.getTime()) ? '   <-- INVALID DATE, the 893-minute bug is back' : ''));
  });
}

// ---------- HELPER: check which bucket a specific employee landed in ----------
function checkEmployeeStatus() {
  var searchText = 'admin'; // <-- change this to check someone else
  var report = computeTodayReport();
  var statuses = ['late', 'presentButLate', 'onTime', 'didNotReport', 'onLeave', 'restDay'];
  var found = false;
  statuses.forEach(function (status) {
    (report[status] || []).forEach(function (e) {
      if (e.name.toLowerCase().indexOf(searchText.toLowerCase()) !== -1) {
        Logger.log('FOUND: ' + e.name + ' is in bucket: ' + status);
        Logger.log(JSON.stringify(e, null, 2));
        found = true;
      }
    });
  });
  if (!found) Logger.log('No one matching "' + searchText + '" found in any bucket.');
}

// ---------- HELPER: inspect leave data from the cache ----------
// NOTE: leave no longer comes from Leaves/SearchCriteria — that endpoint is
// blocked on Sprout's side (token-issuer mismatch, escalated to them). It
// now comes from the per-employee Schedules response, via the cache. So this
// reads the cache rather than calling an endpoint. If it prints nothing,
// check inspectScheduleCache() first — an empty cache looks identical to
// "nobody is on leave".
function inspectLeaveStructure() {
  var dayKey = formatDateKey(new Date()); // <-- or hardcode 'YYYY-MM-DD'
  var snapshot = ensureCacheSnapshot_();
  var found = 0;

  Object.keys(snapshot.leaves).forEach(function (key) {
    if (key.split('|')[1] !== dayKey) return;
    if (found >= 5) return;
    found++;
    Logger.log('employeeId ' + key.split('|')[0] + ' on ' + dayKey + ': '
      + JSON.stringify(snapshot.leaves[key], null, 2));
  });

  if (found === 0) {
    Logger.log('No cached leave for ' + dayKey + '. Either genuinely nobody is on leave, '
      + 'or the cache has not been populated yet — run inspectScheduleCache() to tell which.');
  } else {
    Logger.log('Showed ' + found + ' of the cached leave record(s) for ' + dayKey + '.');
  }
}

// ---------- HELPER: find any employee by name, and show their systemId ----------
// Change the search text below to whatever name you're checking.
function findEmployeeByName() {
  var searchText = 'batara'; // <-- change this to search for someone else
  var employees = getEmployees();
  var matches = employees.filter(function (emp) {
    var basic = emp.basicInformation || {};
    var fullName = (basic.firstName || '') + ' ' + (basic.lastName || '');
    return fullName.toLowerCase().indexOf(searchText.toLowerCase()) !== -1;
  });
  if (matches.length === 0) {
    Logger.log('No employee found matching "' + searchText + '".');
    return;
  }
  matches.forEach(function (emp) {
    var basic = emp.basicInformation || {};
    Logger.log('MATCH: ' + (basic.firstName || '') + ' ' + (basic.lastName || '') + ' -> systemId: ' + basic.systemId);
  });
}

// ---------- HELPER: find your own employee record ----------
// Run this function (pick it from the dropdown), then check the log.
// Edit the name below if "Saavedra" isn't showing your record.
function findMyEmployeeId() {
  var employees = getEmployees();
  var matches = employees.filter(function (emp) {
    var basic = emp.basicInformation || {};
    var fullName = (basic.firstName || '') + ' ' + (basic.lastName || '');
    return fullName.toLowerCase().indexOf('saavedra') !== -1;
  });
  if (matches.length === 0) {
    Logger.log('No employee found matching "saavedra". Here are the first 5 names found instead:');
    employees.slice(0, 5).forEach(function (emp) {
      var basic = emp.basicInformation || {};
      Logger.log((basic.firstName || '') + ' ' + (basic.lastName || '') + ' -> systemId: ' + basic.systemId);
    });
    return;
  }
  matches.forEach(function (emp) {
    var basic = emp.basicInformation || {};
    Logger.log('MATCH: ' + (basic.firstName || '') + ' ' + (basic.lastName || '') + ' -> systemId: ' + basic.systemId);
  });
}

// ---------- HELPER: inspect a raw Schedules response for one employee ----------
// This is the endpoint that replaced BOTH the nonexistent ScheduleAdjustments
// resource and the blocked Leaves/SearchCriteria one. Use this to confirm the
// real field names on a live account: each day carries scheduleAdjustment
// (shiftStart/shiftEnd/isRestDay — note shiftStart/shiftEnd are FULL
// DATETIMES, not "HH:MM") and leaves (type/isWhole/...).
function inspectRawSchedulesResponse() {
  var searchText = 'saavedra'; // <-- whose schedule to pull

  var employees = getEmployees();
  var match = employees.filter(function (emp) {
    var basic = emp.basicInformation || {};
    return ((basic.firstName || '') + ' ' + (basic.lastName || '')).toLowerCase().indexOf(searchText.toLowerCase()) !== -1;
  })[0];
  if (!match) {
    Logger.log('No employee found matching "' + searchText + '".');
    return;
  }
  var employeeId = (match.basicInformation || {}).systemId;

  var now = new Date();
  var dateFromISO = formatDateKey(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)) + 'T00:00:00';
  var dateToISO = formatDateKey(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)) + 'T23:59:59';

  var url = buildApiUrl('timeattendance', '/api/v1/Schedules'
    + '?DateFrom=' + encodeURIComponent(dateFromISO)
    + '&DateTo=' + encodeURIComponent(dateToISO)
    + '&EmployeeId=' + encodeURIComponent(employeeId)
    + '&PageNumber=1&RowsPerPage=100');

  var response = fetchWithRetry(url, { headers: sproutHeaders(), muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    Logger.log('Schedules request failed (' + response.getResponseCode() + '): ' + response.getContentText());
    return;
  }

  var page = (JSON.parse(response.getContentText()).data) || [];
  Logger.log('employeeId ' + employeeId + ' — ' + page.length + ' day record(s) returned.');

  var interesting = page.filter(function (day) {
    return day.scheduleAdjustment || (day.leaves && day.leaves.length > 0);
  });
  if (interesting.length === 0) {
    Logger.log('No day in this window has an adjustment or a leave. Showing the first plain day for its shape instead:');
    if (page.length > 0) Logger.log(JSON.stringify(page[0], null, 2));
    return;
  }
  Logger.log('Days with an adjustment or leave (' + interesting.length + ' total, showing up to 5):');
  interesting.slice(0, 5).forEach(function (day) {
    Logger.log(JSON.stringify(day, null, 2));
  });
}

// ---------- HELPER: view the run log sheet directly ----------
// Prints the URL of the observability log Sheet (created automatically the
// first time the dashboard runs) so you don't have to hunt for it in Drive.
function getLogSheetUrl() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('LOG_SHEET_ID');
  if (!sheetId) {
    Logger.log('No log sheet has been created yet — it gets created automatically the first time the dashboard is used.');
    return;
  }
  Logger.log('Log sheet: https://docs.google.com/spreadsheets/d/' + sheetId + '/edit');
}

// ---------- HELPER: manually trigger Sheet creation + authorization ----------
// Run THIS function directly from the editor first (not via the dashboard).
// Google only shows the "allow this script to create Sheets?" permission
// popup when you run something from the editor — Web App requests never
// show that popup, they just fail silently if permission isn't granted yet.
// This forces that prompt to appear once, so the dashboard's calls work
// afterward.
function testLogging() {
  logRun('TEST', 'Manual authorization test run from the editor.');
  Logger.log('If you did not see a permissions popup, logging should now be working.');
  getLogSheetUrl();
}

// ---------- HELPER: how slow is password hashing on this account? ----------
// Apps Script has no bcrypt, so Auth.gs uses an iterated HMAC-SHA256 loop
// instead (see the header of Auth.gs for why that's weaker and what
// mitigates it). More iterations is strictly better security, bounded only
// by how long you'll accept a login taking. Google's own execution speed
// varies by account and load, so measure rather than guess: run this, then
// set PASSWORD_HASH_ITERATIONS in Auth.gs to whatever lands around 1–2
// seconds. Logins do this once; nothing else does.
function timePasswordHash() {
  var salt = randomSalt_();
  [2000, 5000, 10000, 20000].forEach(function (iterations) {
    var startedAt = Date.now();
    hashPassword_('a representative password', salt, iterations);
    var elapsed = Date.now() - startedAt;
    Logger.log(iterations + ' iterations: ' + elapsed + ' ms'
      + (elapsed > 4000 ? '   <-- too slow for a login' : '')
      + (elapsed >= 1000 && elapsed <= 2500 ? '   <-- good target' : ''));
  });
  Logger.log('Currently configured: PASSWORD_HASH_ITERATIONS = ' + PASSWORD_HASH_ITERATIONS);
  Logger.log('Raising it later is safe — each account stores the count it was created with, so nobody gets locked out.');
}

// ---------- HELPER: who has registered? ----------
// Shows the admin allowlist and which of those System IDs have actually
// created an account. Never prints hashes or salts.
function inspectAccounts() {
  var allowlist = getAllowlist();
  Logger.log('ADMIN_ALLOWLIST: ' + (allowlist.length ? allowlist.join(', ') : '(empty — nobody can register)'));
  var accounts = loadAccounts_();
  var ids = Object.keys(accounts);
  if (!ids.length) {
    Logger.log('No accounts registered yet. The first allowlisted person to hit the dashboard registers themselves.');
    return;
  }
  ids.forEach(function (id) {
    Logger.log('  ' + id + ' — registered ' + accounts[id].registeredAt
      + ' (' + (accounts[id].iterations || '?') + ' iterations)'
      + (allowlist.indexOf(id) === -1 ? '   <-- no longer on the allowlist' : ''));
  });
}

// ---------- HELPER: force everyone to sign in again ----------
// Session tokens are stateless, so there's no session list to clear —
// rotating the signing secret is what invalidates every outstanding token
// at once. Use this if a token is ever believed to have leaked.
function invalidateAllSessions() {
  PropertiesService.getScriptProperties().deleteProperty('SESSION_SECRET');
  getSessionSecret_(); // regenerate immediately so the next login works
  Logger.log('All sessions invalidated. Everyone will need to sign in again.');
}

// ---------- HELPER: does the cache actually round-trip? ----------
// Writes nothing — reads the cache back exactly the way classifyEmployeeForDay
// does, for one employee on one day, and shows the raw sheet value next to
// the normalised key. This is the check that would have caught the Sheets
// date-coercion bug immediately: a dayKey stored as a real Date reads back as
// "Thu Sep 10 2026 00:00:00 GMT+0800" and matches nothing.
function inspectCacheRoundTrip() {
  var employeeId = '1';            // <-- whose cache to check
  var dayKey = '2026-09-10';       // <-- which day

  var spreadsheet = getCacheSpreadsheet_();
  [ADJUSTMENT_SHEET_NAME, LEAVE_SHEET_NAME].forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    var lastRow = sheet.getLastRow();
    Logger.log('--- ' + name + ' (' + Math.max(0, lastRow - 1) + ' rows) ---');
    if (lastRow < 2) { Logger.log('  empty'); return; }

    var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    var shown = 0;
    values.forEach(function (row) {
      if (String(row[0]) !== String(employeeId)) return;
      if (shown >= 8) return;
      shown++;
      Logger.log('  raw dayKey: ' + JSON.stringify(row[1])
        + '  | type: ' + (row[1] instanceof Date ? 'Date  <-- coerced by Sheets' : typeof row[1])
        + '  | normalised: ' + normalizeDayKey_(row[1]));
    });
    if (shown === 0) Logger.log('  no rows for employeeId ' + employeeId);
  });

  Logger.log('--- what the classifier sees for ' + employeeId + ' on ' + dayKey + ' ---');
  Logger.log('getCachedLeave      -> ' + JSON.stringify(getCachedLeave(employeeId, dayKey)));
  Logger.log('getCachedAdjustment -> ' + JSON.stringify(getCachedAdjustment(employeeId, dayKey)));
}
