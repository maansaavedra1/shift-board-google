/**
 * SHIFT BOARD — Google Apps Script backend for Sprout HR attendance monitoring
 * -----------------------------------------------------------------------------
 * Pulls live data from Sprout's API and classifies each employee's status for a
 * given day (Late / Present but Late / On Time / Did Not Report / On Leave /
 * Rest Day).
 *
 * ===========================================================================
 * STEP 1 PORT (Sept 2026) — classification fixes + endpoint corrections,
 * brought over from the verified Node/Express version (src/sprout.js).
 *
 * WHAT CHANGED IN THIS FILE, AND WHY:
 *
 * 1. The `ScheduleAdjustments` / `ScheduleAdjustment/:id` endpoints DO NOT
 *    EXIST. Confirmed against production with three separate 404s. The real
 *    per-date override data lives inside each day's `Schedules` response.
 *    getScheduleAdjustments() is gone; see the cache section below.
 *
 * 2. The `Leaves/SearchCriteria` endpoint is BLOCKED on Sprout's own side —
 *    a token-issuer mismatch (`api.sprout.ph` doesn't trust tokens issued by
 *    `sproutauth.hrhub.ph` for this resource). Escalated to Sprout; not
 *    fixable from here. getApprovedLeaves() is gone. Leave now comes from the
 *    SAME `Schedules` response as the adjustments, at no extra API cost.
 *
 * 3. The "893 minutes late" bug. Adjustment times are full datetimes
 *    ("2026-09-10T21:00:00"); default weekly schedule times are bare "HH:MM".
 *    The old code fed both through manilaTimeOnDay(), silently producing
 *    Invalid Date for adjustments — so the adjustment never took effect and
 *    the employee was compared against their UNADJUSTED default shift. Fixed
 *    by getShiftBoundariesForDay(), which picks the parser by the value's
 *    actual source.
 *
 * 4. The graveyard/overnight shift bug. Logs were bucketed by the calendar
 *    day of their own timestamp, so a 9 PM → 9 AM shift had its checkout land
 *    on the NEXT day, disconnected from its shift — and then showed there as
 *    a bogus "checked out but never checked in". Fixed by buildLogsByBioId()
 *    + findShiftLogTimes(), which match logs against the shift's real time
 *    window instead.
 *
 * 5. Employment status filter — resigned/terminated employees are excluded
 *    everywhere (~750 -> ~359 at Firstmac).
 *
 * ALSO PORTED: the UI changes in index.html (clickable summary cards,
 * categories collapsed by default, leave date ranges, the leave-day login
 * anomaly in red, the summary-card alignment fix, Employee ID in the Excel
 * export, and the "Schedule adjustments synced" indicator). That file is now
 * the Node version's index.html with its login gate and server-side
 * credentials panel removed, and its data layer pointed at this Web App.
 *
 * ALSO PORTED (step 2): the login system — System ID + password, restricted
 * to an allowlist, admin-assisted reset, 30-minute idle logout. See Auth.gs,
 * which documents three deliberate differences from Node (localStorage token
 * instead of an httpOnly cookie, iterated SHA-256 instead of bcrypt, and
 * Script Properties instead of a JSON file). DASHBOARD_ACCESS_KEY is no
 * longer used and can be deleted from Script Properties.
 *
 * !! THIS PORT HAS NOT BEEN EXECUTED. The Node original was run and verified
 * !! against live production data; Apps Script cannot be executed from the
 * !! porting environment. Test this in a real Apps Script deployment before
 * !! trusting it with client data.
 * ===========================================================================
 *
 * SETUP (do this once):
 * 1. Project Settings (gear) > Script Properties, add:
 *      SPROUT_BASE              = https://clients.hrhub.ph  (production)
 *                                 or https://gateway-sb.sprout.ph (sandbox)
 *      SPROUT_CLIENT_ID         = (your Sprout API Client ID)
 *      SPROUT_CLIENT_SECRET     = (your Sprout API Client Secret)
 *      SPROUT_SUBSCRIPTION_KEY  = (your Sprout API subscription/API key)
 *      SPROUT_USER_ID           = (a valid Sprout systemId)
 *      ADMIN_ALLOWLIST          = comma-separated System IDs allowed to
 *                                 register (e.g. 2414,2767,2696)
 *    Never paste these values directly into this code file.
 *    (DASHBOARD_ACCESS_KEY is obsolete as of step 2 — delete it.)
 *
 * 2. Add Debug.gs and Auth.gs as separate files in this same project.
 *
 * 3. Run installScheduleCacheTrigger() ONCE from the editor. This creates the
 *    time-driven trigger that keeps the schedule-adjustment/leave cache warm.
 *    WITHOUT IT, EVERY EMPLOYEE WILL SHOW AS THOUGH THEY HAVE NO ADJUSTMENT
 *    AND NO LEAVE. See the cache section for why this has to be a background
 *    job rather than something the dashboard fetches inline.
 *
 * 4. Deploy > New deployment > "Web app". Paste the plain /exec URL into the
 *    dashboard HTML's setup box — no ?key= any more; the dashboard logs in
 *    for itself.
 */

// ---------- Cache tuning ----------
// The schedule/leave cache needs ONE Sprout call per employee (confirmed: no
// bulk option exists), and the 180-day window means most employees need 2
// pages. At ~359 employees that's ~718 UrlFetch calls per full cycle.
//
// APPS SCRIPT QUOTA MATH — this is the constraint that Node did not have.
// UrlFetchApp is capped per day (20,000 consumer / 100,000 Workspace). The
// Node version refreshes every 5 minutes; replicating that here would be
// 718 * 288 = ~207,000 calls/day, which blows through even the Workspace
// quota. With a 10-minute trigger and the chunking below, a full cycle takes
// ~30 minutes => ~48 cycles/day => ~34,500 calls/day, which fits comfortably.
//
// The tradeoff: cached data can be up to ~30 minutes old rather than ~5. If
// that's too stale, lower TRIGGER_INTERVAL_MINUTES and re-run
// installScheduleCacheTrigger() — but redo this arithmetic first.
var TRIGGER_INTERVAL_MINUTES = 10;
var CACHE_REFRESH_BUDGET_MS = 4 * 60 * 1000; // stop well short of the 6-min execution limit
// A dashboard refresh fires a fire-and-forget "nudge" (see doGet's nudge
// branch) to push the cache along sooner than the next trigger firing. That
// runs on a much shorter budget than the trigger itself — it's a top-up, not
// a full pass, and it shouldn't hold an execution open for minutes just
// because someone hit Refresh.
var CACHE_NUDGE_BUDGET_MS = 30 * 1000;
var CACHE_BATCH_SIZE = 5;                    // employees fetched in parallel per batch
var CACHE_BATCH_DELAY_MS = 1200;             // ~4 req/sec, under Sprout's observed ~10/sec
var CACHE_WINDOW_DAYS_PAST = 90;
var CACHE_WINDOW_DAYS_FUTURE = 90;
var ADJUSTMENT_SHEET_NAME = 'ScheduleAdjustmentCache';
var LEAVE_SHEET_NAME = 'LeaveCache';
var HOLIDAY_SHEET_NAME = 'HolidayCache';

var WEEKDAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// SPROUT_BASE comes from Script Properties, not hardcoded.
function getSproutBase() {
  var base = PropertiesService.getScriptProperties().getProperty('SPROUT_BASE');
  return base || 'https://gateway-sb.sprout.ph';
}

// Sandbox and production are more than a different domain — different API
// paths and a different auth request format entirely (confirmed against
// Sprout's own documentation, Sept 2026, after a live 404 on a real
// production deployment).
function isSandboxEnvironment() {
  return getSproutBase().indexOf('-sb.') !== -1;
}

// Sandbox paths carry a service-name prefix (empservice, timeattendance);
// production paths drop it entirely.
function buildApiUrl(sandboxServicePrefix, pathAndQuery) {
  var base = getSproutBase();
  return isSandboxEnvironment()
    ? base + '/' + sandboxServicePrefix + pathAndQuery
    : base + pathAndQuery;
}

// ---------- Retry helper for transient network/API blips ----------
// Up to 3 attempts with exponential backoff, only for likely-transient
// failures (network errors, 429, 5xx). Does not change what counts as
// success or failure.
function fetchWithRetry(url, options, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  var lastError = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) {
        lastError = new Error('Transient HTTP ' + code + ': ' + response.getContentText());
      } else {
        return response; // success, or a non-transient error (400/401) — return as-is
      }
    } catch (err) {
      lastError = err; // network-level failure (timeout, DNS, etc.)
    }
    if (attempt < maxAttempts) {
      Utilities.sleep(500 * Math.pow(2, attempt - 1));
    }
  }
  throw lastError;
}

// ---------- STEP 1: Get an access token ----------
function getAccessToken() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('sprout_token');
  if (cached) return cached;

  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('SPROUT_CLIENT_ID');
  var clientSecret = props.getProperty('SPROUT_CLIENT_SECRET');
  var subscriptionKey = props.getProperty('SPROUT_SUBSCRIPTION_KEY');

  var sandbox = isSandboxEnvironment();
  var tokenUrl = sandbox
    ? getSproutBase() + '/auth/connect/token'
    : getSproutBase() + '/api/v1/Auth/client/token';

  var requestOptions = sandbox
    ? {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        headers: {
          'Ocp-Apim-Subscription-Key': subscriptionKey,
          'Accept': 'application/json'
        },
        payload: {
          Client_Id: clientId,
          Client_Secret: clientSecret,
          grant_type: 'client_credentials'
        },
        muteHttpExceptions: true
      }
    : {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'Ocp-Apim-Subscription-Key': subscriptionKey,
          'Accept': 'application/json'
        },
        payload: JSON.stringify({
          ClientId: clientId,
          Secret: clientSecret
        }),
        muteHttpExceptions: true
      };

  var response = fetchWithRetry(tokenUrl, requestOptions);

  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Token request failed (' + code + '): ' + response.getContentText());
  }

  var data = JSON.parse(response.getContentText());
  // Response field names were never confirmed from a saved production
  // example (only the request format was documented) — check both the
  // sandbox's snake_case and a possible PascalCase production style.
  var accessToken = data.access_token || data.AccessToken;
  var expiresIn = data.expires_in || data.ExpiresIn || 3600;
  if (!accessToken) {
    throw new Error('Token request succeeded but no access token was found in the response. Response shape may differ from what this code expects — check the raw response: ' + response.getContentText());
  }
  cache.put('sprout_token', accessToken, expiresIn - 120);
  return accessToken;
}

function sproutHeaders() {
  var subscriptionKey = PropertiesService.getScriptProperties().getProperty('SPROUT_SUBSCRIPTION_KEY');
  return {
    'Authorization': 'Bearer ' + getAccessToken(),
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    'Accept': 'application/json'
  };
}

// ---------- Chunked CacheService helpers ----------
// CacheService caps a single value at 100KB. The employee roster at ~359
// people is comfortably past that, so the old single-key cache.put() was
// silently failing every time and the roster was being re-fetched (4 pages)
// on every single dashboard load. Splitting across keys makes the cache
// actually work at this scale.
function putChunkedCache_(cache, baseKey, str, ttlSeconds) {
  var CHUNK_SIZE = 90000;
  var chunkCount = Math.ceil(str.length / CHUNK_SIZE);
  if (chunkCount > 20) return false; // too big even chunked — skip caching rather than thrash
  var map = {};
  for (var i = 0; i < chunkCount; i++) {
    map[baseKey + '_' + i] = str.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
  }
  map[baseKey + '_count'] = String(chunkCount);
  try {
    cache.putAll(map, ttlSeconds);
    return true;
  } catch (e) {
    return false;
  }
}

function getChunkedCache_(cache, baseKey) {
  var countStr = cache.get(baseKey + '_count');
  if (!countStr) return null;
  var chunkCount = parseInt(countStr, 10);
  if (!chunkCount || chunkCount < 1) return null;
  var keys = [];
  for (var i = 0; i < chunkCount; i++) keys.push(baseKey + '_' + i);
  var parts = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < chunkCount; j++) {
    var part = parts[baseKey + '_' + j];
    if (part == null) return null; // a chunk expired — treat the whole thing as a miss
    out += part;
  }
  return out;
}

// ---------- STEP 2: Get all employees + their shift schedule ----------
function getEmployees(preloadedFirstResponse) {
  // Cache key is versioned (_v2) so a deployment of this port never serves a
  // roster cached by the PREVIOUS version, which had no employment filter —
  // that would show resigned/terminated staff for up to 5 minutes after
  // deploying, looking exactly like the filter had failed.
  var cache = CacheService.getScriptCache();
  var cached = getChunkedCache_(cache, 'sprout_employees_v2');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and re-fetch */ }
  }

  var allEmployees = [];
  var pageNumber = 1;
  var pageSize = 100;
  while (true) {
    var response;
    if (pageNumber === 1 && preloadedFirstResponse) {
      response = preloadedFirstResponse;
    } else {
      var url = buildApiUrl('empservice', '/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation'
        + '&RowsPerPage=' + pageSize + '&PageNumber=' + pageNumber);
      response = fetchWithRetry(url, { headers: sproutHeaders(), muteHttpExceptions: true });
    }
    if (response.getResponseCode() !== 200) {
      throw new Error('Employees request failed: ' + response.getContentText());
    }
    var data = JSON.parse(response.getContentText());
    var pageOfEmployees = data.data || [];
    allEmployees = allEmployees.concat(pageOfEmployees);

    if (pageOfEmployees.length < pageSize) break; // last page
    pageNumber++;
    if (pageNumber > 50) break; // safety valve
  }

  // Excludes resigned and terminated employees — confirmed against real
  // production data (via a one-time diagnostic check of the actual
  // employmentStatus values in use) that these are the only two of the
  // client's originally-requested categories (resigned, terminated, AWOL,
  // end of contract, OJT Ended) that actually exist as distinct statuses in
  // this account; the other three aren't used here at all. Deliberately
  // keeps everyone else, including probationary and maternity — those are
  // still active, working employees, not separated ones.
  var EXCLUDED_EMPLOYMENT_STATUSES = ['resigned', 'terminated'];
  var activeEmployees = allEmployees.filter(function (emp) {
    var status = ((emp.workInformation || {}).employmentStatus || '').toLowerCase();
    return EXCLUDED_EMPLOYMENT_STATUSES.indexOf(status) === -1;
  });

  putChunkedCache_(cache, 'sprout_employees_v2', JSON.stringify(activeEmployees), 300); // 5 minutes

  return activeEmployees;
}

// ---------- STEP 3: Get attendance logs ----------
function getAttendanceLogs(dateFromISO, dateToISO, preloadedFirstResponse) {
  var allLogs = [];
  var pageNumber = 1;
  var pageSize = 100;
  while (true) {
    var response;
    if (pageNumber === 1 && preloadedFirstResponse) {
      response = preloadedFirstResponse;
    } else {
      var url = buildApiUrl('timeattendance', '/api/v1/AttendanceLogs'
        + '?DateFrom=' + encodeURIComponent(dateFromISO)
        + '&DateTo=' + encodeURIComponent(dateToISO)
        + '&RowsPerPage=' + pageSize + '&PageNumber=' + pageNumber);
      response = fetchWithRetry(url, { headers: sproutHeaders(), muteHttpExceptions: true });
    }
    if (response.getResponseCode() !== 200) {
      throw new Error('AttendanceLogs request failed: ' + response.getContentText());
    }
    var data = JSON.parse(response.getContentText());
    var pageOfLogs = data.data || [];
    allLogs = allLogs.concat(pageOfLogs);

    if (pageOfLogs.length < pageSize) break; // last page
    pageNumber++;
    if (pageNumber > 100) break; // safety valve
  }
  return allLogs;
}

// =====================================================================
// SCHEDULE ADJUSTMENT + LEAVE CACHE
//
// The only real endpoint for schedule adjustments (confirmed directly
// against production, after the original "ScheduleAdjustments" resource
// turned out not to exist at all) requires one call PER EMPLOYEE:
//   GET /api/v1/Schedules?DateFrom=...&DateTo=...&EmployeeId=<id>
// At Firstmac's scale that is far too slow to run inline on a dashboard
// refresh, and far too close to Sprout's rate limit.
//
// That SAME response also carries a real, populated "leaves" array per day
// — confirmed against actual production data (dozens of real employees,
// real leave dates, including same-day entries), not just the documented
// schema. Since Leaves/SearchCriteria is blocked on Sprout's side, leave is
// now read from here too, at no extra API cost.
//
// APPS SCRIPT DIFFERENCE FROM NODE: the Node version keeps this in two
// in-memory Maps on a long-running process. Apps Script executions are
// stateless and time-limited, so there is nothing to keep a Map alive in.
// This uses a Google Sheet as the persistence layer instead:
//   - durable across executions (unlike CacheService, which expires)
//   - no 500KB ceiling (unlike PropertiesService, which this data would
//     blow past at ~359 employees x 180 days)
//   - and it doubles as something you can open and eyeball
//
// The refresh is RESUMABLE: each trigger firing processes as many
// employees as it can inside CACHE_REFRESH_BUDGET_MS, stores a cursor, and
// the next firing picks up where it left off. A full cycle therefore spans
// several firings — by design, since one firing cannot outlive the
// execution limit.
// =====================================================================

// Loaded once per execution and reused. Single-threaded within one
// execution, so a plain script-global is safe here.
var SCHEDULE_CACHE_SNAPSHOT = null;

function getCacheSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SCHEDULE_CACHE_SHEET_ID');
  var spreadsheet = null;

  if (sheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      spreadsheet = null; // deleted or stale ID — recreate below
    }
  }
  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create('Shift Board — Schedule & Leave Cache');
    props.setProperty('SCHEDULE_CACHE_SHEET_ID', spreadsheet.getId());
  }

  ensureCacheSheet_(spreadsheet, ADJUSTMENT_SHEET_NAME, ['employeeId', 'dayKey', 'isRestDay', 'shiftFrom', 'shiftTo']);
  ensureCacheSheet_(spreadsheet, LEAVE_SHEET_NAME, ['employeeId', 'dayKey', 'leavesJson']);
  ensureCacheSheet_(spreadsheet, HOLIDAY_SHEET_NAME, ['employeeId', 'dayKey', 'holidaysJson']);
  return spreadsheet;
}

function ensureCacheSheet_(spreadsheet, name, headerRow) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.appendRow(headerRow);
    sheet.setFrozenRows(1);
  }
  // Applied every time, not just at creation, so a sheet made before this
  // fix stops converting dayKey to a Date from the next write onward.
  sheet.getRange(1, 1, sheet.getMaxRows(), 2).setNumberFormat('@');
  return sheet;
}

// Google Sheets silently converts anything date-shaped into a real Date on
// write. A dayKey of "2026-09-10" comes back out of getValues() as a Date
// object, and String()-ing that gives "Thu Sep 10 2026 00:00:00 GMT+0800"
// — so every cache key silently stopped matching what the classifier looks
// up, and every employee looked as though they had no leave and no
// adjustment. Writes are now forced to plain text (see commitCacheRows_),
// and this normalises anything already stored the wrong way.
function normalizeDayKey_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Manila', 'yyyy-MM-dd');
  return String(value).substring(0, 10);
}

function loadScheduleCaches_() {
  var adjustments = {};
  var leaves = {};
  var holidays = {};
  try {
    var spreadsheet = getCacheSpreadsheet_();

    var adjSheet = spreadsheet.getSheetByName(ADJUSTMENT_SHEET_NAME);
    var adjLastRow = adjSheet.getLastRow();
    if (adjLastRow > 1) {
      var adjValues = adjSheet.getRange(2, 1, adjLastRow - 1, 5).getValues();
      adjValues.forEach(function (row) {
        if (!row[0] && row[0] !== 0) return;
        adjustments[String(row[0]) + '|' + normalizeDayKey_(row[1])] = {
          isRestDay: row[2] === true || String(row[2]).toLowerCase() === 'true',
          shiftFrom: row[3] || null,
          shiftTo: row[4] || null
        };
      });
    }

    var leaveSheet = spreadsheet.getSheetByName(LEAVE_SHEET_NAME);
    var leaveLastRow = leaveSheet.getLastRow();
    if (leaveLastRow > 1) {
      var leaveValues = leaveSheet.getRange(2, 1, leaveLastRow - 1, 3).getValues();
      leaveValues.forEach(function (row) {
        if (!row[0] && row[0] !== 0) return;
        try {
          leaves[String(row[0]) + '|' + normalizeDayKey_(row[1])] = JSON.parse(row[2]);
        } catch (e) {
          // A single unparseable row shouldn't take down the whole load.
        }
      });
    }
    var holidaySheet = spreadsheet.getSheetByName(HOLIDAY_SHEET_NAME);
    var holidayLastRow = holidaySheet.getLastRow();
    if (holidayLastRow > 1) {
      var holidayValues = holidaySheet.getRange(2, 1, holidayLastRow - 1, 3).getValues();
      holidayValues.forEach(function (row) {
        if (!row[0] && row[0] !== 0) return;
        try {
          holidays[String(row[0]) + '|' + normalizeDayKey_(row[1])] = JSON.parse(row[2]);
        } catch (e) { /* one bad row shouldn't take down the load */ }
      });
    }
  } catch (err) {
    // A cache read failure must not break the dashboard — it degrades to
    // "nobody has an adjustment, leave or holiday", which is the same state
    // as a cold cache, and logRun records why.
    Logger.log('WARNING: schedule/leave/holiday cache load failed: ' + err.message);
  }
  return { adjustments: adjustments, leaves: leaves, holidays: holidays };
}

function ensureCacheSnapshot_() {
  if (!SCHEDULE_CACHE_SNAPSHOT) SCHEDULE_CACHE_SNAPSHOT = loadScheduleCaches_();
  return SCHEDULE_CACHE_SNAPSHOT;
}

function getCachedAdjustment(employeeId, dayKey) {
  return ensureCacheSnapshot_().adjustments[String(employeeId) + '|' + dayKey] || null;
}

function getCachedLeave(employeeId, dayKey) {
  return ensureCacheSnapshot_().leaves[String(employeeId) + '|' + dayKey] || null;
}

function getCachedHoliday(employeeId, dayKey) {
  return ensureCacheSnapshot_().holidays[String(employeeId) + '|' + dayKey] || null;
}

// Sprout's holiday entries haven't been seen populated yet (the sandbox has
// none), so the name is read defensively across the plausible field names
// rather than assuming one. Worst case it reads "Holiday", which is still
// correct — just less specific.
function holidayLabel_(entries) {
  if (!entries || !entries.length) return 'Holiday';
  var names = entries.map(function (h) {
    return h.name || h.holidayName || h.description || h.type || h.holidayType || '';
  }).filter(Boolean);
  var unique = names.filter(function (n, i) { return names.indexOf(n) === i; });
  return unique.length ? unique.join(', ') : 'Holiday';
}

function getScheduleCacheStatus() {
  var props = PropertiesService.getScriptProperties();
  var total = parseInt(props.getProperty('SCHEDULE_CACHE_TOTAL') || '0', 10);
  var cursor = parseInt(props.getProperty('SCHEDULE_CACHE_CURSOR') || '0', 10);
  return {
    lastRefreshedAt: props.getProperty('SCHEDULE_CACHE_LAST_FULL_CYCLE') || null,
    isRefreshing: props.getProperty('SCHEDULE_CACHE_RUNNING') === 'true',
    lastError: props.getProperty('SCHEDULE_CACHE_LAST_ERROR') || null,
    employeesProcessed: cursor,
    employeesTotal: total
  };
}

// Fetches one employee's schedule (adjustment AND leave) for the whole cache
// window, paginating as needed. Returns null on any failure — the caller
// then leaves that employee's EXISTING cached rows untouched rather than
// wiping them. This is the fix for the second bug found in the Node version:
// previously a transient failure for one employee (more likely for anyone
// needing multiple pages) left them with zero cached data, not stale data,
// until a later cycle happened to succeed.
function fetchScheduleDataForEmployee_(employeeId, dateFromISO, dateToISO, firstPageResponse) {
  var pageSize = 100;
  var adjustmentRows = [];
  var leaveRows = [];
  var holidayRows = [];
  try {
    var pageNumber = 1;
    var headers = sproutHeaders();
    while (true) {
      var response;
      if (pageNumber === 1 && firstPageResponse) {
        response = firstPageResponse;
      } else {
        var url = buildApiUrl('timeattendance', '/api/v1/Schedules'
          + '?DateFrom=' + encodeURIComponent(dateFromISO)
          + '&DateTo=' + encodeURIComponent(dateToISO)
          + '&EmployeeId=' + encodeURIComponent(employeeId)
          + '&PageNumber=' + pageNumber
          + '&RowsPerPage=' + pageSize);
        response = fetchWithRetry(url, { headers: headers, muteHttpExceptions: true });
      }

      if (response.getResponseCode() !== 200) {
        // Logged explicitly, with employee ID and page number — the Node
        // version's equivalent failure used to be completely silent, which
        // made a real production issue impossible to find in the logs.
        Logger.log('Schedule/leave fetch failed for employee ' + employeeId
          + ', page ' + pageNumber + ': HTTP ' + response.getResponseCode());
        return null;
      }

      var data = JSON.parse(response.getContentText());
      var page = data.data || [];
      page.forEach(function (day) {
        if (!day.date) return;
        var dayKey = String(day.date).substring(0, 10);
        if (day.scheduleAdjustment) {
          adjustmentRows.push([
            String(employeeId),
            dayKey,
            !!day.scheduleAdjustment.isRestDay,
            day.scheduleAdjustment.shiftStart || '',
            day.scheduleAdjustment.shiftEnd || ''
          ]);
        }
        if (day.leaves && day.leaves.length > 0) {
          leaveRows.push([String(employeeId), dayKey, JSON.stringify(day.leaves)]);
        }
        // Same response, no extra API call. Previously discarded, which is
        // why every employee read as "Did Not Report" on a public holiday.
        if (day.holidays && day.holidays.length > 0) {
          holidayRows.push([String(employeeId), dayKey, JSON.stringify(day.holidays)]);
        }
      });

      if (page.length < pageSize) break;
      pageNumber++;
      if (pageNumber > 10) break; // sane upper bound for a ~180-day window
    }
    return { adjustmentRows: adjustmentRows, leaveRows: leaveRows, holidayRows: holidayRows };
  } catch (err) {
    Logger.log('Schedule/leave fetch failed for employee ' + employeeId + ': ' + err.message);
    return null;
  }
}

// Replaces the rows belonging to the employees just processed, and leaves
// everyone else's rows alone. Done as one read + one write rather than
// per-row deletes, which would be far too slow in Sheets.
function commitCacheRows_(sheet, processedIds, newRows, width) {
  var processedSet = {};
  processedIds.forEach(function (id) { processedSet[String(id)] = true; });

  var lastRow = sheet.getLastRow();
  var existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];
  var kept = existing.filter(function (row) {
    if (row[0] === '' || row[0] == null) return false; // drop blank rows while we're here
    return !processedSet[String(row[0])];
  });

  var all = kept.concat(newRows);
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  if (all.length > 0) {
    // Grow the sheet if this batch needs more rows than currently exist.
    var needed = all.length + 1;
    if (sheet.getMaxRows() < needed) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    var target = sheet.getRange(2, 1, all.length, width);
    // employeeId and dayKey are forced to plain text BEFORE writing.
    // Without this, Sheets turns "2026-09-10" into a Date and the cache
    // key stops matching on the way back out — see normalizeDayKey_.
    sheet.getRange(2, 1, all.length, 2).setNumberFormat('@');
    target.setValues(all);
  }
}

// THE TRIGGER TARGET. Processes as many employees as fit in the time budget,
// then stores a cursor so the next firing resumes from there.
function refreshScheduleCacheChunk(budgetMsOverride) {
  var budgetMs = budgetMsOverride || CACHE_REFRESH_BUDGET_MS;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // A trigger firing is already working through the roster. Nothing to do
    // — this is the normal outcome for a nudge that lands mid-cycle.
    Logger.log('Schedule cache refresh skipped — another run is already in progress.');
    return;
  }

  var startedAt = Date.now();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SCHEDULE_CACHE_RUNNING', 'true');

  try {
    var employees = getEmployees();
    // Sorted so the cursor means the same thing from one firing to the next
    // — API page order is not guaranteed stable, and an unstable order would
    // silently skip some employees every cycle while re-doing others.
    employees.sort(function (a, b) {
      var aId = (a.basicInformation || {}).systemId;
      var bId = (b.basicInformation || {}).systemId;
      return Number(aId) - Number(bId);
    });

    var total = employees.length;
    props.setProperty('SCHEDULE_CACHE_TOTAL', String(total));

    var cursor = parseInt(props.getProperty('SCHEDULE_CACHE_CURSOR') || '0', 10);
    if (!(cursor >= 0) || cursor >= total) cursor = 0;

    var now = new Date();
    var dateFromISO = formatDateKey(new Date(now.getTime() - CACHE_WINDOW_DAYS_PAST * 24 * 60 * 60 * 1000)) + 'T00:00:00';
    var dateToISO = formatDateKey(new Date(now.getTime() + CACHE_WINDOW_DAYS_FUTURE * 24 * 60 * 60 * 1000)) + 'T23:59:59';

    var processedIds = [];
    var allAdjustmentRows = [];
    var allLeaveRows = [];
    var allHolidayRows = [];

    while (cursor < total && (Date.now() - startedAt) < budgetMs) {
      var batch = employees.slice(cursor, cursor + CACHE_BATCH_SIZE);
      var headers = sproutHeaders();

      var batchIds = [];
      var requests = [];
      batch.forEach(function (emp) {
        var employeeId = (emp.basicInformation || {}).systemId;
        if (employeeId == null) return;
        batchIds.push(employeeId);
        requests.push({
          url: buildApiUrl('timeattendance', '/api/v1/Schedules'
            + '?DateFrom=' + encodeURIComponent(dateFromISO)
            + '&DateTo=' + encodeURIComponent(dateToISO)
            + '&EmployeeId=' + encodeURIComponent(employeeId)
            + '&PageNumber=1&RowsPerPage=100'),
          headers: headers,
          muteHttpExceptions: true
        });
      });

      // Page 1 for the whole batch goes out in parallel; anyone who needs
      // further pages continues individually inside
      // fetchScheduleDataForEmployee_.
      var firstPages = [];
      if (requests.length > 0) {
        try {
          firstPages = UrlFetchApp.fetchAll(requests);
        } catch (e) {
          firstPages = []; // fall back to fetching each from scratch
        }
      }

      for (var i = 0; i < batchIds.length; i++) {
        var result = fetchScheduleDataForEmployee_(
          batchIds[i], dateFromISO, dateToISO, firstPages[i] || null
        );
        if (result === null) continue; // failed — keep this employee's existing rows
        processedIds.push(batchIds[i]);
        allAdjustmentRows = allAdjustmentRows.concat(result.adjustmentRows);
        allLeaveRows = allLeaveRows.concat(result.leaveRows);
        allHolidayRows = allHolidayRows.concat(result.holidayRows);
      }

      cursor += batch.length;
      if (cursor < total && (Date.now() - startedAt) < budgetMs) {
        Utilities.sleep(CACHE_BATCH_DELAY_MS);
      }
    }

    if (processedIds.length > 0) {
      var spreadsheet = getCacheSpreadsheet_();
      commitCacheRows_(spreadsheet.getSheetByName(ADJUSTMENT_SHEET_NAME), processedIds, allAdjustmentRows, 5);
      commitCacheRows_(spreadsheet.getSheetByName(LEAVE_SHEET_NAME), processedIds, allLeaveRows, 3);
      commitCacheRows_(spreadsheet.getSheetByName(HOLIDAY_SHEET_NAME), processedIds, allHolidayRows, 3);
    }

    if (cursor >= total) {
      props.setProperty('SCHEDULE_CACHE_LAST_FULL_CYCLE', new Date().toISOString());
      props.setProperty('SCHEDULE_CACHE_CURSOR', '0');
    } else {
      props.setProperty('SCHEDULE_CACHE_CURSOR', String(cursor));
    }
    props.deleteProperty('SCHEDULE_CACHE_LAST_ERROR');
    logRun('CACHE', 'Processed ' + processedIds.length + ' employees this run; cursor now '
      + (cursor >= total ? 0 : cursor) + ' of ' + total);
  } catch (err) {
    props.setProperty('SCHEDULE_CACHE_LAST_ERROR', err.message);
    Logger.log('Schedule cache refresh failed: ' + err.message);
    logRun('CACHE_FAILURE', err.message);
  } finally {
    props.setProperty('SCHEDULE_CACHE_RUNNING', 'false');
    lock.releaseLock();
  }
}

// Run ONCE from the editor after deploying. Removes any existing trigger for
// this function first, so running it twice doesn't end up with two triggers
// racing each other.
function installScheduleCacheTrigger() {
  removeScheduleCacheTrigger();
  ScriptApp.newTrigger('refreshScheduleCacheChunk')
    .timeBased()
    .everyMinutes(TRIGGER_INTERVAL_MINUTES)
    .create();
  Logger.log('Schedule cache trigger installed — every ' + TRIGGER_INTERVAL_MINUTES + ' minutes.');
}

function removeScheduleCacheTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'refreshScheduleCacheChunk') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// Wipes the cache and restarts the cycle from employee 0. Useful after
// changing the window constants, or if the sheet is ever suspected of
// holding bad data.
function resetScheduleCache() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SCHEDULE_CACHE_CURSOR', '0');
  props.deleteProperty('SCHEDULE_CACHE_LAST_FULL_CYCLE');
  props.deleteProperty('SCHEDULE_CACHE_LAST_ERROR');
  var spreadsheet = getCacheSpreadsheet_();
  [ADJUSTMENT_SHEET_NAME, LEAVE_SHEET_NAME, HOLIDAY_SHEET_NAME].forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  });
  SCHEDULE_CACHE_SNAPSHOT = null;
  Logger.log('Schedule cache cleared. The next trigger firing will start a fresh cycle.');
}

// ---------- Date/time helpers ----------
// Sprout returns timestamps as naive local Philippine time strings, and
// shift start/end times as plain "HH:mm" with no date or timezone at all.
// The Apps Script runtime isn't guaranteed to be in the Philippines
// timezone — parsing these without being explicit caused a real, confirmed
// bug where displayed times were off by exactly 8 hours.
function parseManilaDateTime(naiveDateTimeStr) {
  if (!naiveDateTimeStr) return null;
  // Sprout's timestamps are Manila wall-clock time regardless of what suffix
  // (if any) they carry — a real, confirmed case showed a 'Z' suffix on a
  // value that was actually local Manila time, not true UTC. Trusting that
  // 'Z' reproduced the exact 8-hour bug this function exists to fix. So:
  // strip any timezone marker and always apply +08:00 explicitly.
  var stripped = String(naiveDateTimeStr).replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i, '');
  return new Date(stripped + '+08:00');
}

function manilaTimeOnDay(dayKey, hhmmStr) {
  // Sprout's weekly schedule fields (mondayFrom and friends) come back as a
  // full "HH:MM:SS" string — confirmed against real data, e.g. "09:00:00" —
  // not the bare "HH:MM" this assumed. Appending ":00" to a value that
  // already carries seconds built "...T09:00:00:00+08:00", which parses to
  // an Invalid Date.
  //
  // The isNaN guard in getShiftBoundariesForDay then nulled the field out,
  // so nothing crashed — it just quietly produced a boundary object with no
  // usable times, which left the log-matching window unbounded and let a
  // punch from any day in that employee's history be reported as today's.
  // Only add the seconds when they aren't already there.
  var hasSeconds = /^\d{1,2}:\d{2}:\d{2}$/.test(hhmmStr);
  return parseManilaDateTime(dayKey + 'T' + (hasSeconds ? hhmmStr : hhmmStr + ':00'));
}

// Derives day-of-week purely from the calendar date string rather than
// .getDay() on a Date, which is runtime-timezone-dependent. Noon UTC is
// unambiguously the same calendar day in every real-world timezone.
function weekdayForDayKey(dayKey) {
  return WEEKDAY_FIELDS[new Date(dayKey + 'T12:00:00Z').getUTCDay()];
}

// Explicit Asia/Manila calendar date regardless of the script's own runtime
// timezone — otherwise a late-night Manila log (e.g. 12:30 AM) could be
// bucketed into the wrong calendar day entirely.
function formatDateKey(date) {
  return Utilities.formatDate(date, 'Asia/Manila', 'yyyy-MM-dd');
}

// Shared "warn once per distinct value" store for cases where the same
// surprise would otherwise be logged hundreds of times in one run (an
// unrecognised holiday type is checked per employee per day). Script scope,
// which in Apps Script means the life of ONE execution — the right window,
// since each refresh run should report what it saw rather than inherit a
// suppression from a run that happened hours ago. Keys are prefixed by case
// so the different callers can't collide.
var warnedOnceKeys_ = {};
function warnOnce_(key, message) {
  if (warnedOnceKeys_[key]) return;
  warnedOnceKeys_[key] = true;
  Logger.log(message);
}

// ---------- Attendance log matching ----------
// Groups ALL logs by employee (bioId), sorted chronologically — replaces the
// old per-calendar-day bucketing. A single overnight shift's check-in and
// check-out land on two different calendar days (clock in 9 PM Thursday,
// clock out 9 AM Friday); bucketing by the log's own calendar day split one
// shift across two days, and let the tail-end checkout get misread as an
// unrelated "missing log-in" problem on the second day.
function buildLogsByBioId(allLogs) {
  var logsByBioId = {};
  var unknownModes = {};
  allLogs.forEach(function (log) {
    var bioId = log.bioEmpID;
    // A log with no bioEmpID would otherwise bucket under "undefined" — and
    // every employee who also lacks a biometricId would read that same
    // bucket, inheriting attendance that isn't theirs and sharing it with
    // each other. Dropped instead.
    if (bioId === null || bioId === undefined || bioId === '') return;
    var logTime = parseManilaDateTime(log.logTime);
    if (!logTime || isNaN(logTime.getTime())) return;
    var modeStr = String(log.inOutMode).toLowerCase();
    var isIn = modeStr === 'in' || modeStr === '0';
    var isOut = modeStr === 'out' || modeStr === '1';
    // An unrecognised mode is still skipped — break punches and the like
    // genuinely aren't shift boundaries — but it's now logged once per
    // distinct value. If Sprout or a device ever starts emitting something
    // else, whole departments would otherwise read as absent with nothing
    // anywhere to say why.
    if (!isIn && !isOut) {
      if (!unknownModes[modeStr]) {
        unknownModes[modeStr] = true;
        Logger.log('Unrecognised inOutMode in attendance logs: ' + JSON.stringify(log.inOutMode)
          + ' — these punches are being ignored. Expected in/out/0/1.');
      }
      return;
    }
    if (!logsByBioId[bioId]) logsByBioId[bioId] = [];
    logsByBioId[bioId].push({ time: logTime, isIn: isIn, isOut: isOut });
  });
  Object.keys(logsByBioId).forEach(function (bioId) {
    logsByBioId[bioId].sort(function (a, b) { return a.time - b.time; });
  });
  return logsByBioId;
}

// Computes an employee's shift start/end for an ARBITRARY day — needed to
// check yesterday's shift from today's perspective without re-deriving all
// of classifyEmployeeForDay. Returns null if that day is a rest day.
//
// THIS IS WHERE THE 893-MINUTES BUG IS FIXED: adjustment values arrive as
// full datetimes ("2026-09-10T21:00:00"), default weekly schedule values as
// bare "HH:MM". Each needs its own parser. Concatenating an already-full
// datetime as if it were "HH:MM" silently produced Invalid Date, so the
// adjustment branch never took effect and the employee was scored against
// their unadjusted default shift.
function getShiftBoundariesForDay(systemId, someDayKey, schedule) {
  var someWeekday = weekdayForDayKey(someDayKey);
  var adjustment = getCachedAdjustment(systemId, someDayKey);
  var isRest = adjustment ? !!adjustment.isRestDay : !!schedule[someWeekday + 'IsRestday'];
  if (isRest) return null;

  var fromStr = (adjustment && adjustment.shiftFrom) || schedule[someWeekday + 'From'];
  var toStr = (adjustment && adjustment.shiftTo) || schedule[someWeekday + 'To'];
  var fromIsAdjustment = !!(adjustment && adjustment.shiftFrom);
  var toIsAdjustment = !!(adjustment && adjustment.shiftTo);

  var start = fromStr ? (fromIsAdjustment ? parseManilaDateTime(fromStr) : manilaTimeOnDay(someDayKey, fromStr)) : null;
  var end = toStr ? (toIsAdjustment ? parseManilaDateTime(toStr) : manilaTimeOnDay(someDayKey, toStr)) : null;

  // Validated here at the source rather than trusting every caller to
  // check separately. Real, confirmed production case: Sprout sometimes
  // returns the literal text "REST DAY" in the time fields for a day
  // whose isRestDay is still false — a data inconsistency on their side.
  // Parsing that gives a truthy-but-invalid Date, which then throws
  // "Invalid time value" the moment anything calls toISOString on it.
  // Returning null means a non-null boundary is always genuinely usable.
  if (start && isNaN(start.getTime())) start = null;
  if (end && isNaN(end.getTime())) end = null;

  // A weekly schedule of e.g. 21:00 -> 06:00 is an OVERNIGHT shift: the end
  // time belongs to the next calendar day. Both times arrive as bare "HH:MM"
  // with no date, so without this the end lands before the start, the
  // log-matching window in findShiftLogTimes inverts, every punch is excluded,
  // and a permanent night-shift employee shows as "Did Not Report" despite
  // clocking in and out normally.
  //
  // This does NOT apply to schedule adjustments — those carry full datetimes
  // that already say which day the shift ends on, so they're left alone.
  //
  // NOTE: this is a DIVERGENCE from the Node version, which has the same bug.
  // The graveyard fix there was only ever confirmed against a night shift
  // that arrived as an adjustment. Worth porting this back to Azure.
  if (start && end && !fromIsAdjustment && !toIsAdjustment && end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  // If NEITHER boundary survived, return null rather than an object with two
  // null fields. The object is truthy, so the caller's `if (todayBoundaries
  // && !isRestDay)` guard passed and findShiftLogTimes ran with no window at
  // all — which makes it scan the employee's entire log list and report the
  // earliest In and latest Out from ANY day as today's times, marked On Time.
  //
  // The HH:MM:SS parsing bug fixed in manilaTimeOnDay was one way to land
  // here, and the one that actually bit. It isn't the only way: Sprout also
  // returns the literal text "REST DAY" in time fields on a day whose
  // isRestDay is false (confirmed in production), which the isNaN guard
  // above nulls out exactly the same way. Fixing the parse closes the
  // instance; this closes the class.
  //
  // DIVERGENCE from the Node version, which fixed the parsing but still
  // returns the two-null object — worth relaying.
  if (!start && !end) return null;

  return { start: start, end: end };
}

// Finds the real check-in/check-out for a specific shift by searching the
// employee's own chronological log list against the shift's time window —
// this is what lets an overnight shift's post-midnight checkout be
// recognized as belonging to the shift it started with.
//
// previousDayEnd (if the employee had a shift the day before that was itself
// overnight and ends today) excludes a checkout that actually belongs to
// THAT earlier shift, so it isn't double-counted here.
// Sprout's own configured attendance thresholds, taken from the client's
// Sprout settings rather than assumed — and they are genuinely asymmetric,
// and genuinely different per schedule type.
//
// The flat 4-hours-each-way window this replaced looked reasonable and was
// wrong: a real employee logging in 4h24m early fell outside it, so their
// login was discarded and they showed as "log-out with no matching log-in"
// while both punches sat in Sprout's data perfectly intact.
//
// "Normal Shift" is the only scheduleType string confirmed in real data so
// far. Anything else — including a real "Flexi Schedule Per Day" employee,
// or a value Sprout adds later — falls back to the WIDER window. That
// direction is deliberate: too wide risks pulling in a stray punch from an
// adjacent shift, too narrow silently discards a genuine one, which is the
// exact bug this exists to fix.
var ATTENDANCE_THRESHOLDS_MS = {
  'Normal Shift': { pre: 6 * 60 * 60 * 1000, post: 8 * 60 * 60 * 1000 },
  DEFAULT: { pre: 6 * 60 * 60 * 1000, post: 12 * 60 * 60 * 1000 }
};
function getAttendanceThresholds(scheduleTypeLabel) {
  return ATTENDANCE_THRESHOLDS_MS[scheduleTypeLabel] || ATTENDANCE_THRESHOLDS_MS.DEFAULT;
}

function findShiftLogTimes(employeeLogs, shiftStart, shiftEnd, previousDayEnd, preGraceMs, postGraceMs) {
  if (!employeeLogs || employeeLogs.length === 0) return { inTime: null, outTime: null };

  // Callers that predate the threshold arguments still get a usable window
  // rather than an undefined one, which would make every comparison NaN and
  // silently admit every punch in the fetch range.
  if (preGraceMs === undefined || preGraceMs === null) preGraceMs = ATTENDANCE_THRESHOLDS_MS.DEFAULT.pre;
  if (postGraceMs === undefined || postGraceMs === null) postGraceMs = ATTENDANCE_THRESHOLDS_MS.DEFAULT.post;

  var windowStart = shiftStart ? new Date(shiftStart.getTime() - preGraceMs) : null;
  var windowEnd = shiftEnd ? new Date(shiftEnd.getTime() + postGraceMs) : null;

  var inTime = null;
  var outTime = null;

  employeeLogs.forEach(function (log) {
    if (windowStart && log.time < windowStart) return;
    if (windowEnd && log.time > windowEnd) return;

    if (previousDayEnd && log.isOut) {
      var previousGraceEnd = new Date(previousDayEnd.getTime() + postGraceMs);
      if (log.time <= previousGraceEnd) return;
    }

    if (log.isIn && (!inTime || log.time < inTime)) inTime = log.time;
    if (log.isOut && (!outTime || log.time > outTime)) outTime = log.time;
  });

  return { inTime: inTime, outTime: outTime };
}

// Reconstructs an approximate leave date range around a given day, since the
// Schedules-based leave data is inherently per-day — it has no single
// request record with its own dateFrom/dateTo the way the old, now-blocked
// Leaves endpoint provided. Walks backward and forward, extending the range
// as long as either (a) the same employee has a leave entry of the same type
// that day, or (b) it's one of their scheduled rest days — tolerated as a
// gap, the same way a real multi-day leave request spans a weekend, without
// itself counting as a leave day. Capped at 14 days each direction.
function reconstructLeaveRange(employeeId, dayKey, leaveType, schedule) {
  // 14 days was too short to be honest: the walk doesn't degrade past the
  // cap, it reports a CONFIDENTLY WRONG range. A 40-day leave rendered as a
  // clean 29-day window indistinguishable from a precise one. Philippine
  // maternity leave is 105 days, and the employment filter deliberately
  // keeps maternity employees active, so this was guaranteed to happen.
  var MAX_WALK_DAYS = 120;

  function matchesType(entries) {
    return !!entries && entries.some(function (l) { return l.type === leaveType; });
  }
  function isScheduledRestDay(someDayKey) {
    var weekday = weekdayForDayKey(someDayKey);
    return !!schedule[weekday + 'IsRestday'];
  }
  function shiftDayKey(someDayKey, deltaDays) {
    var d = new Date(someDayKey + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + deltaDays);
    // formatDateKey converts to Asia/Manila, which is safe here: midnight
    // UTC is 8 AM the SAME calendar day in Manila, so the anchor doesn't
    // slip. Kept identical to the Node original rather than "simplified".
    return formatDateKey(d);
  }

  // hitStartCap/hitEndCap stay true only if the walk ran the full
  // distance without finding a real boundary — meaning the leave may
  // extend further than what's shown. Reported so a truncated range
  // isn't rendered as a clean, confident one.
  var startKey = dayKey;
  var hitStartCap = true;
  for (var i = 1; i <= MAX_WALK_DAYS; i++) {
    var backCandidate = shiftDayKey(dayKey, -i);
    if (matchesType(getCachedLeave(employeeId, backCandidate))) {
      startKey = backCandidate;
    } else if (isScheduledRestDay(backCandidate)) {
      continue; // tolerated gap — keep walking, but don't move startKey to a non-leave day
    } else {
      hitStartCap = false; // found a real end to the leave
      break;
    }
  }

  var endKey = dayKey;
  var hitEndCap = true;
  for (var j = 1; j <= MAX_WALK_DAYS; j++) {
    var fwdCandidate = shiftDayKey(dayKey, j);
    if (matchesType(getCachedLeave(employeeId, fwdCandidate))) {
      endKey = fwdCandidate;
    } else if (isScheduledRestDay(fwdCandidate)) {
      continue;
    } else {
      hitEndCap = false;
      break;
    }
  }

  return { startKey: startKey, endKey: endKey, hitStartCap: hitStartCap, hitEndCap: hitEndCap };
}

// ---------- Shared classification rules ----------
// Used by both single-day and multi-day report generation, so the two paths
// can never drift apart.
function classifyEmployeeForDay(emp, dayContext) {
  var basic = emp.basicInformation || {};
  var work = emp.workInformation || {};
  var schedule = emp.workSchedule || {};
  var name = (basic.firstName || '') + ' ' + (basic.lastName || '');
  var bioId = work.biometricId;
  var systemId = basic.systemId;
  // employeeId is a genuinely separate field from systemId (confirmed
  // against real production data — e.g. systemId: 1, employeeId: "1" as a
  // string) even though they can coincidentally match for some records.
  // Kept alongside systemId, not replacing it, since systemId is still
  // needed internally for matching leave/adjustment records — employeeId is
  // purely for display, per the client's request to show it on the Excel
  // export instead of systemId.
  var employeeId = basic.employeeId;

  var department = work.department || '—';
  var supervisor = work.reportsTo || '—';
  var contactInfo = { department: department, supervisor: supervisor, systemId: systemId, employeeId: employeeId };

  var adjustment = getCachedAdjustment(systemId, dayContext.dayKey);
  var isRestDay = adjustment
    ? !!adjustment.isRestDay
    : !!schedule[dayContext.weekday + 'IsRestday'];

  // Shift boundaries are computed up front — the in/out matching below needs
  // the shift's actual start/end window to search against, rather than just
  // whatever fell in today's calendar-day bucket. Yesterday's boundaries are
  // computed too, purely to check whether an overnight shift from yesterday
  // tails into today (see findShiftLogTimes for why that matters).
  var todayBoundaries = getShiftBoundariesForDay(systemId, dayContext.dayKey, schedule);
  var yesterdayKey = formatDateKey(new Date(new Date(dayContext.dayKey + 'T12:00:00Z').getTime() - 24 * 60 * 60 * 1000));
  var yesterdayBoundaries = getShiftBoundariesForDay(systemId, yesterdayKey, schedule);
  var yesterdayWasOvernightIntoToday = !!(yesterdayBoundaries && yesterdayBoundaries.end
    && formatDateKey(yesterdayBoundaries.end) === dayContext.dayKey);

  // No biometric ID means no way to match punches to this person — an empty
  // list, not a lookup of logsByBioId[undefined].
  var employeeLogs = (bioId && dayContext.logsByBioId && dayContext.logsByBioId[bioId]) || [];

  // Sprout configures its early-in / late-out tolerances per schedule type,
  // so the matching window depends on which type this employee is on.
  var thresholds = getAttendanceThresholds(work.scheduleType);

  var inTime = null;
  var outTime = null;
  if (todayBoundaries && !isRestDay) {
    var matched = findShiftLogTimes(
      employeeLogs,
      todayBoundaries.start,
      todayBoundaries.end,
      yesterdayWasOvernightIntoToday ? yesterdayBoundaries.end : null,
      thresholds.pre,
      thresholds.post
    );
    inTime = matched.inTime;
    outTime = matched.outTime;
  } else {
    // On a genuine rest day there's no shift window to search against — fall
    // back to a plain same-calendar-day match, so a rest-day worker's logs
    // still show if present.
    employeeLogs.forEach(function (log) {
      if (formatDateKey(log.time) !== dayContext.dayKey) return;
      if (log.isIn && (!inTime || log.time < inTime)) inTime = log.time;
      if (log.isOut && (!outTime || log.time > outTime)) outTime = log.time;
    });
  }

  // Log presence is computed BEFORE the Rest Day / On Leave early returns,
  // so those two categories still show the actual check-in/check-out time if
  // there is one — real scenarios include someone working part of a shift
  // before an emergency came up and they filed leave for the rest of the
  // day. That's genuine attendance data worth seeing, not just an anomaly
  // flag. Sent as ISO strings so the frontend can format them locally.
  var loginTime = inTime ? inTime.toISOString() : null;
  var logoutTime = outTime ? outTime.toISOString() : null;

  if (isRestDay) {
    return { status: 'restDay', entry: { name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime } };
  }

  // Checked after rest day, before leave. A public holiday means no shift
  // was expected, so these people are not late and have not failed to
  // report — which is exactly what the board said about all 359 of them
  // before this existed. Someone who DID work shows here with their times,
  // since holiday work is worth seeing rather than hiding.
  //
  // Ordered before leave deliberately: if someone filed leave on a day that
  // turned out to be a holiday, the holiday is the real reason they're off.
  // ONLY a non-working holiday excuses anyone. Sprout's real data also
  // contains "Mandatory Working Holiday" — premium pay, but people are
  // still expected to turn up. Treating every holiday entry alike (the
  // first version of this did) would excuse the entire workforce on a day
  // they were supposed to be working, which is a worse error than the one
  // holiday support was added to fix. A mandatory working holiday falls
  // through to normal classification, exactly as it should.
  var holidayEntries = getCachedHoliday(systemId, dayContext.dayKey);
  var nonWorkingHoliday = holidayEntries && holidayEntries.filter(function (h) {
    return h.type === 'Non-Working Holiday';
  })[0];
  // Matching the exact string is the right rule (see above), but it makes the
  // string itself a single point of failure. If Sprout ever returns a type
  // that is neither of the two known values — a new category, a spelling
  // change, different casing — holidays would silently stop being recognised
  // and the original mass-Did-Not-Report bug would return with nothing
  // anywhere to explain why. Warned once per distinct unrecognised value per
  // execution, the same de-duplication pattern used for inOutMode.
  if (holidayEntries) {
    holidayEntries.forEach(function (h) {
      if (h.type !== 'Non-Working Holiday' && h.type !== 'Mandatory Working Holiday') {
        warnOnce_('holiday-type:' + h.type,
          'Unrecognised holiday type ' + JSON.stringify(h.type) + ' — not excusing anyone. '
          + 'Expected "Non-Working Holiday" or "Mandatory Working Holiday".');
      }
    });
  }
  if (nonWorkingHoliday) {
    return {
      status: 'holiday',
      entry: {
        name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime,
        holidayName: nonWorkingHoliday.name || holidayLabel_(holidayEntries)
      }
    };
  }

  var leaveEntries = getCachedLeave(systemId, dayContext.dayKey);
  if (leaveEntries && leaveEntries.length > 0) {
    var types = leaveEntries.map(function (l) { return l.type; }).filter(Boolean);
    var uniqueTypes = types.filter(function (t, i) { return types.indexOf(t) === i; }).join(', ');
    var halfDayEntry = leaveEntries.filter(function (l) { return l.isWhole === false; })[0];
    // Sprout's own leave application already records WHICH half was filed,
    // so this is read directly rather than inferred from anything:
    // isFirstHalf true means the morning (the person is expected in that
    // afternoon), false means the afternoon (expected in that morning).
    // Stays null when the record doesn't say, so the UI falls back to a
    // plain "On leave" rather than guessing a half and being wrong.
    var halfDayPeriod = halfDayEntry
      ? (halfDayEntry.isFirstHalf ? 'AM' : 'PM')
      : null;
    // The primary leave type found for this specific day is what's used to
    // find the surrounding range — a mixed multi-type day (rare) can't
    // cleanly extend in both directions at once.
    var primaryType = leaveEntries[0] && leaveEntries[0].type;
    var range = primaryType ? reconstructLeaveRange(systemId, dayContext.dayKey, primaryType, schedule) : null;
    return {
      status: 'onLeave',
      entry: {
        name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime,
        leaveType: uniqueTypes || 'Leave',
        // The specific day this row is for — distinct from leaveFrom/leaveTo
        // below, which is the reconstructed RANGE and stays identical across
        // every day of a multi-day leave. The approval-date lookup needs the
        // one day, since it searches a window around it rather than the range.
        viewedDayKey: dayContext.dayKey,
        leaveIsHalfDay: !!halfDayEntry,
        leaveHalfDayPeriod: halfDayPeriod,
        leaveFrom: range ? range.startKey : dayContext.dayKey,
        leaveTo: range ? range.endKey : dayContext.dayKey,
        leaveFromIsApproximate: !!(range && range.hitStartCap),
        leaveToIsApproximate: !!(range && range.hitEndCap)
      }
    };
  }

  var shiftStartBoundary = todayBoundaries ? todayBoundaries.start : null;
  var shiftEndBoundary = todayBoundaries ? todayBoundaries.end : null;

  if (!inTime) {
    if (outTime) {
      return {
        status: 'presentButLate',
        entry: { name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime, lateMinutes: null, reason: 'missing log-in (has log-out)' }
      };
    }

    var shiftHasEnded = false;
    if (shiftEndBoundary) {
      shiftHasEnded = new Date() > shiftEndBoundary;
    }
    // Defensive fallback: even without valid shift-end data (a real case saw
    // someone stuck on "Late — shift still ongoing" for a day a week in the
    // past, because their schedule record was missing an end time), a
    // calendar day that isn't today can never still be "ongoing".
    if (dayContext.dayKey < formatDateKey(new Date())) {
      shiftHasEnded = true;
    }

    if (shiftHasEnded) {
      return { status: 'didNotReport', entry: { name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime, reason: 'no log-in or log-out, shift already ended' } };
    }
    // The scheduled hours ride along here specifically per client feedback:
    // someone looking at "Late — shift still ongoing" had no way to judge how
    // late is late, or when a graveyard shift is actually due to end, without
    // knowing that employee's own schedule.
    return {
      status: 'late',
      entry: {
        name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime,
        reason: 'no log-in yet, shift still ongoing',
        scheduledShiftStart: shiftStartBoundary ? shiftStartBoundary.toISOString() : null,
        scheduledShiftEnd: shiftEndBoundary ? shiftEndBoundary.toISOString() : null
      }
    };
  }

  if (!shiftStartBoundary) {
    return { status: 'onTime', entry: { name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime } };
  }

  var lateMinutes = Math.round((inTime - shiftStartBoundary) / 60000);
  if (lateMinutes > 0) {
    return { status: 'presentButLate', entry: { name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime, lateMinutes: lateMinutes } };
  }

  return { status: 'onTime', entry: { name: name, ...contactInfo, loginTime: loginTime, logoutTime: logoutTime } };
}

function newEmptyReport() {
  return { late: [], presentButLate: [], onLeave: [], onTime: [], restDay: [], didNotReport: [], holiday: [] };
}

// ---------- Single-day report ----------
function computeTodayReport() {
  var now = new Date();
  var todayKey = formatDateKey(now);
  var todayWeekday = weekdayForDayKey(todayKey);

  // Attendance logs are fetched one calendar day wider on each side than
  // strictly needed — an overnight shift's checkout can land on the next
  // calendar day (or, less commonly, a very early check-in could sit just
  // before midnight the day before). Without the wider fetch, the log that
  // actually belongs to today's shift might not even be in the dataset being
  // searched.
  var logsFromISO = formatDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000)) + 'T00:00:00';
  var logsToISO = formatDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000)) + 'T23:59:59';

  // Employees and Attendance Logs are independent, so fire both page-1
  // requests together. Leave and Schedule Adjustments are NOT fetched here
  // at all any more — they're read from the background cache inside
  // classifyEmployeeForDay.
  var preloadedEmployeesResponse = null;
  var preloadedAttendanceResponse = null;
  try {
    var headers = sproutHeaders();
    var employeesUrl = buildApiUrl('empservice', '/api/v1/Employees?Include=WorkSchedule&Include=WorkInformation&RowsPerPage=100&PageNumber=1');
    var attendanceUrl = buildApiUrl('timeattendance', '/api/v1/AttendanceLogs'
      + '?DateFrom=' + encodeURIComponent(logsFromISO)
      + '&DateTo=' + encodeURIComponent(logsToISO)
      + '&RowsPerPage=100&PageNumber=1');

    var batchResponses = UrlFetchApp.fetchAll([
      { url: employeesUrl, headers: headers, muteHttpExceptions: true },
      { url: attendanceUrl, headers: headers, muteHttpExceptions: true }
    ]);
    preloadedEmployeesResponse = batchResponses[0];
    preloadedAttendanceResponse = batchResponses[1];

    function isTransient(resp) {
      var code = resp.getResponseCode();
      return code === 429 || (code >= 500 && code < 600);
    }
    if (isTransient(preloadedEmployeesResponse)) {
      try { preloadedEmployeesResponse = fetchWithRetry(employeesUrl, { headers: headers, muteHttpExceptions: true }); } catch (e) { /* surfaces downstream */ }
    }
    if (isTransient(preloadedAttendanceResponse)) {
      try { preloadedAttendanceResponse = fetchWithRetry(attendanceUrl, { headers: headers, muteHttpExceptions: true }); } catch (e) { /* surfaces downstream */ }
    }
  } catch (e) {
    // If the parallel batch fails for any reason, fall through — the calls
    // below fetch everything sequentially instead.
  }

  var employees = getEmployees(preloadedEmployeesResponse);
  var logs = getAttendanceLogs(logsFromISO, logsToISO, preloadedAttendanceResponse);
  var logsByBioId = buildLogsByBioId(logs);

  var dayContext = {
    weekday: todayWeekday,
    dayDate: now,
    dayKey: todayKey,
    logsByBioId: logsByBioId
    // Schedule adjustments AND leave are read from the background cache
    // inside classifyEmployeeForDay — not fetched live here.
  };

  var report = newEmptyReport();
  employees.forEach(function (emp) {
    var result = classifyEmployeeForDay(emp, dayContext);
    report[result.status].push(result.entry);
  });

  report.scheduleAdjustmentCache = getScheduleCacheStatus();
  // Kept as always-false for backward compatibility with the current
  // index.html, which still renders a warning banner from these. Neither
  // endpoint is called live any more, so neither can fail at request time.
  // Remove these two lines when the UI is ported in step 3.
  report.leaveCheckFailed = false;
  report.scheduleAdjustmentCheckFailed = false;
  return report;
}

// ---------- Multi-day report (Last 2 / 5 / 7 days, and custom ranges) ----------
// Fetches each data source ONCE for the whole range, then applies the exact
// same classifyEmployeeForDay rules per day. Returns oldest to most recent.
function computeReportsBetweenDates(rangeStart, rangeEnd) {
  var dayDates = [];
  for (var d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
    dayDates.push(new Date(d));
  }

  // One calendar day wider on each side — same overnight-shift reasoning as
  // computeTodayReport.
  var logsFromISO = formatDateKey(new Date(rangeStart.getTime() - 24 * 60 * 60 * 1000)) + 'T00:00:00';
  var logsToISO = formatDateKey(new Date(rangeEnd.getTime() + 24 * 60 * 60 * 1000)) + 'T23:59:59';

  var employees = getEmployees();
  var logs = getAttendanceLogs(logsFromISO, logsToISO);
  var logsByBioId = buildLogsByBioId(logs);

  var cacheStatus = getScheduleCacheStatus();

  return dayDates.map(function (dayDate) {
    var dayKey = formatDateKey(dayDate);
    var weekday = weekdayForDayKey(dayKey);

    var dayContext = {
      weekday: weekday,
      dayDate: dayDate,
      dayKey: dayKey,
      logsByBioId: logsByBioId
    };

    var report = newEmptyReport();
    employees.forEach(function (emp) {
      var result = classifyEmployeeForDay(emp, dayContext);
      report[result.status].push(result.entry);
    });
    report.scheduleAdjustmentCache = cacheStatus;
    report.leaveCheckFailed = false;
    report.scheduleAdjustmentCheckFailed = false;

    return { dateKey: dayKey, report: report };
  });
}

function computeReportsForDateRange(numDays) {
  var now = new Date();
  var rangeStart = new Date(now.getTime() - (numDays - 1) * 24 * 60 * 60 * 1000);
  return computeReportsBetweenDates(rangeStart, now);
}

// Powers the calendar/custom-range picker — accepts explicit "YYYY-MM-DD"
// strings rather than a day count.
var MAX_CUSTOM_RANGE_DAYS = 62; // ~2 months — generous, but bounded so one
// bad request can't accidentally ask Sprout for years of logs at once.

function computeReportsForCustomRange(fromDateStr, toDateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toDateStr)) {
    throw new Error('Dates must be in YYYY-MM-DD format.');
  }
  var rangeStart = new Date(fromDateStr + 'T00:00:00');
  var rangeEnd = new Date(toDateStr + 'T00:00:00');
  if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
    throw new Error('One or both dates are invalid.');
  }
  if (rangeStart > rangeEnd) {
    throw new Error('Start date must be on or before the end date.');
  }
  var spanDays = Math.round((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000)) + 1;
  if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
    throw new Error('Date range is too wide (' + spanDays + ' days). Please pick a range of ' + MAX_CUSTOM_RANGE_DAYS + ' days or fewer.');
  }
  return computeReportsBetweenDates(rangeStart, rangeEnd);
}

// ---------- Leave approval date (on demand only) ----------
// Deliberately never called from the background refresh. It costs three live
// Sprout calls per lookup, so it runs only when an admin actually hovers the
// icon on one leave row — which keeps the daily quota arithmetic in the
// header comment intact.
//
// Three calls, and there is no shortcut: the Schedules response this app
// caches carries a leave's type and dates but not its ID, so the ID has to
// be found by search before the one record that holds dateApproved can be
// fetched.
//
// Two things here differ from every other call this project makes, both
// confirmed the hard way rather than assumed:
//   - the HOST. Production is api.sprout.ph, not the clients.hrhub.ph that
//     Employees, Schedules and AttendanceLogs all use.
//   - a UserId HEADER, which no other endpoint here has ever needed.
// Both are scoped to this function so they cannot disturb anything already
// working.
//
// NAMING DIVERGENCE from the Node version, deliberate: the trailing
// underscore is Apps Script's only privacy marker. Without it this would be
// callable by anyone who can load the page via google.script.run — an
// unauthenticated endpoint that makes three live Sprout calls per hit, which
// is precisely the amplification shape this project has already had to close
// twice. Web.gs calls it through apiLeaveApprovalDate, which checks the
// session first.
function leaveApiBase_() {
  return isSandboxEnvironment() ? 'https://gateway-sb.sprout.ph' : 'https://api.sprout.ph';
}

function leaveApiHeaders_() {
  var headers = sproutHeaders();
  headers.UserId = PropertiesService.getScriptProperties().getProperty('SPROUT_USER_ID') || '';
  return headers;
}

function getLeaveApprovalDate_(employeeId, dayKey) {
  if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) {
    throw new Error('An employee and a date (YYYY-MM-DD) are both required.');
  }
  var base = leaveApiBase_();
  var headers = leaveApiHeaders_();

  // Step 1 — register a search scoped to this employee and a few days either
  // side. No reason to search their whole history to find one leave's ID.
  var dayDate = new Date(dayKey + 'T00:00:00Z');
  var windowStart = formatDateKey(new Date(dayDate.getTime() - 3 * 24 * 60 * 60 * 1000));
  var windowEnd = formatDateKey(new Date(dayDate.getTime() + 3 * 24 * 60 * 60 * 1000));

  var createResponse = fetchWithRetry(base + '/timeattendance/api/v1/Leaves/SearchCriteria', {
    method: 'post',
    headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      EmployeeId: employeeId,
      DateFrom: windowStart + 'T00:00:00',
      DateTo: windowEnd + 'T23:59:59'
    }),
    muteHttpExceptions: true
  });
  if (createResponse.getResponseCode() !== 201) {
    throw new Error('Could not start leave search (HTTP ' + createResponse.getResponseCode() + ')');
  }
  var searchCriteriaId = JSON.parse(createResponse.getContentText()).searchCriteriaId;

  // Step 2 — read the results back.
  var listResponse = fetchWithRetry(base + '/timeattendance/api/v1/Leaves/SearchCriteria?SearchCriteriaId='
    + encodeURIComponent(searchCriteriaId), { headers: headers, muteHttpExceptions: true });
  if (listResponse.getResponseCode() !== 200) {
    throw new Error('Could not retrieve leave search results (HTTP ' + listResponse.getResponseCode() + ')');
  }
  var listData = JSON.parse(listResponse.getContentText());

  // The EmployeeId sent when creating the search does NOT actually restrict
  // what comes back — confirmed on production, where a search scoped to one
  // employee still returned 371 records belonging to dozens of people. So
  // the employee has to be re-checked here. Matching on the date range alone
  // meant whoever happened to come first in the list won, which showed up as
  // different employees displaying an identical approval timestamp that
  // belonged to neither of them. Compared as strings because Sprout returns
  // this as a number while callers may pass either.
  var match = (listData.data || []).filter(function (rec) {
    var from = rec.dateFrom ? String(rec.dateFrom).substring(0, 10) : null;
    var to = rec.dateTo ? String(rec.dateTo).substring(0, 10) : null;
    var sameEmployee = rec.employeeId !== null && rec.employeeId !== undefined
      && String(rec.employeeId) === String(employeeId);
    return sameEmployee && from && to && dayKey >= from && dayKey <= to;
  })[0];
  if (!match) throw new Error('No matching leave record found for this employee and date.');

  // Step 3 — the only call that carries dateApproved. Confirmed to be a real
  // field, distinct from dateFiled, not the same value relabelled. No
  // approver identity is exposed on this response.
  var detailResponse = fetchWithRetry(base + '/timeattendance/api/v1/Leave/' + encodeURIComponent(match.id),
    { headers: headers, muteHttpExceptions: true });
  if (detailResponse.getResponseCode() !== 200) {
    throw new Error('Could not retrieve leave detail (HTTP ' + detailResponse.getResponseCode() + ')');
  }
  var detail = JSON.parse(detailResponse.getContentText());
  return {
    dateApproved: detail.dateApproved || null,
    dateFiled: detail.dateFiled || null,
    leaveType: detail.leaveTypeName || null,
    statusId: detail.requestStatusId !== null && detail.requestStatusId !== undefined ? detail.requestStatusId : null
  };
}

// ---------- Google Chat reply (optional) ----------
function buildChatCard(report) {
  function line(list, formatter) {
    if (list.length === 0) return '_None_';
    return list.map(formatter).join('\n');
  }

  var text =
    '*Shift Board — Today*\n\n' +
    '*Late — no log-in yet, shift ongoing (' + report.late.length + ')*\n' +
    line(report.late, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*Present but Late (' + report.presentButLate.length + ')*\n' +
    line(report.presentButLate, function (e) { return '• ' + e.name + (e.lateMinutes != null ? ' (' + e.lateMinutes + ' min)' : ' (no log-in, has log-out)'); }) + '\n\n' +
    '*On Leave (' + report.onLeave.length + ')*\n' +
    line(report.onLeave, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*On Time (' + report.onTime.length + ')*\n' +
    line(report.onTime, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*Did Not Report — shift ended, never showed (' + report.didNotReport.length + ')*\n' +
    line(report.didNotReport, function (e) { return '• ' + e.name; }) + '\n\n' +
    '*Rest Day (' + report.restDay.length + ')*\n' +
    line(report.restDay, function (e) { return '• ' + e.name; });

  return { text: text };
}

function onMessage(event) {
  try {
    var report = computeTodayReport();
    return buildChatCard(report);
  } catch (err) {
    return { text: 'Something went wrong pulling today\'s attendance: ' + err.message };
  }
}

// ---------- OBSERVABILITY: log every run to a Google Sheet ----------
function logRun(status, message) {
  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty('LOG_SHEET_ID');
    var spreadsheet;

    if (sheetId) {
      try {
        spreadsheet = SpreadsheetApp.openById(sheetId);
      } catch (e) {
        spreadsheet = null; // sheet was deleted or ID is stale — recreate below
      }
    }

    if (!spreadsheet) {
      spreadsheet = SpreadsheetApp.create('Shift Board — Run Log');
      var newSheet = spreadsheet.getSheets()[0];
      newSheet.appendRow(['Timestamp', 'Status', 'Details']);
      props.setProperty('LOG_SHEET_ID', spreadsheet.getId());
    }

    var sheet = spreadsheet.getSheets()[0];
    sheet.appendRow([new Date(), status, message || '']);

    // Keep the log from growing forever — trim to the most recent 1000 rows.
    var lastRow = sheet.getLastRow();
    if (lastRow > 1001) {
      sheet.deleteRows(2, lastRow - 1001);
    }
  } catch (e) {
    // Logging must never break the actual report.
  }
}

// ---------- WEB ENDPOINT ----------
// Moved to Web.gs. The dashboard is now served BY this Apps Script project
// as an HtmlService page, the same way the Azure version's Express app
// serves its own index.html — so the page and the API share an origin and
// there is no cross-origin request at all.
//
// The previous JSON doGet/doPost pair lived here. They were removed because
// a cross-origin POST to Apps Script cannot carry a body: Apps Script answers
// with a redirect, and the browser re-issues a redirected POST as a GET,
// dropping the body. Login could never work that way.
