/**
 * Verifies the hardening added to the Apps Script port on 11 Sep, by
 * EXECUTING it:
 *
 *   1. the login throttle (Auth.gs) — the port's answer to the Node side's
 *      per-IP rate limiter, which Apps Script cannot reproduce because a
 *      google.script.run call exposes no caller IP
 *   2. the unrecognised-holiday-type warning (Code.gs) — matching the
 *      warning Azure adopted, including its once-per-distinct-value
 *      de-duplication
 *
 * Both are loaded from the real source files, not restated here.
 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const shim = require('./gas-shim.js');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

// ============================================================ login throttle
console.log('\n=== Login throttle (Auth.gs) ===\n');
{
  const sandbox = Object.assign({}, shim, {
    console, Date, Math, JSON, Intl, RegExp, String, Number, Object, Array,
    isNaN, parseInt, parseFloat, Promise
  });
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync('/home/claude/gas/shift-board-google-workspace/Auth.gs', 'utf8'),
    sandbox, { filename: 'Auth.gs' }
  );

  const {
    loginIsThrottled_, recordLoginFailure_, clearLoginFailures_,
    loginThrottleKey_, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES
  } = sandbox;
  const store = sandbox.CacheService.__store;
  const wipe = () => Object.keys(store).forEach((k) => delete store[k]);

  check('a fresh System ID is not throttled', () => {
    wipe();
    assert.strictEqual(loginIsThrottled_('2414'), false);
  });

  check('allows up to the limit, throttles past it', () => {
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      assert.strictEqual(loginIsThrottled_('2414'), false,
        `attempt ${i + 1} should still be allowed`);
      recordLoginFailure_('2414');
    }
    assert.strictEqual(loginIsThrottled_('2414'), true,
      'should be throttled once the limit is reached');
  });

  check('the limit is generous enough that a person mistyping never hits it', () => {
    assert.ok(LOGIN_MAX_ATTEMPTS >= 8,
      'a threshold this low would lock out real admins on a bad morning');
  });

  check('a different System ID is counted separately', () => {
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 5; i++) recordLoginFailure_('2414');
    assert.strictEqual(loginIsThrottled_('2414'), true);
    assert.strictEqual(loginIsThrottled_('2767'), false,
      'one admin being attacked must not lock out the others');
  });

  check('a successful login clears the counter', () => {
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 2; i++) recordLoginFailure_('2414');
    assert.strictEqual(loginIsThrottled_('2414'), true);
    clearLoginFailures_('2414');
    assert.strictEqual(loginIsThrottled_('2414'), false);
  });

  check('the window rolls over once it expires', () => {
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 2; i++) recordLoginFailure_('2414');
    assert.strictEqual(loginIsThrottled_('2414'), true);
    // Age the stored window past its expiry.
    const key = loginThrottleKey_('2414');
    const entry = JSON.parse(store[key]);
    entry.t = Date.now() - (LOGIN_WINDOW_MINUTES * 60 * 1000) - 1000;
    store[key] = JSON.stringify(entry);
    assert.strictEqual(loginIsThrottled_('2414'), false,
      'an expired window must let someone back in');
  });

  check('recording after expiry starts a fresh count, not a resumed one', () => {
    // If the recorder kept the old count across an expired window, one
    // attempt after the rollover would re-throttle immediately — the
    // window would effectively never reset.
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 2; i++) recordLoginFailure_('2414');
    const key = loginThrottleKey_('2414');
    const aged = JSON.parse(store[key]);
    aged.t = Date.now() - (LOGIN_WINDOW_MINUTES * 60 * 1000) - 1000;
    store[key] = JSON.stringify(aged);
    recordLoginFailure_('2414');
    assert.strictEqual(JSON.parse(store[key]).c, 1, 'count should have restarted at 1');
    assert.strictEqual(loginIsThrottled_('2414'), false);
  });

  check('the recorder and the checker agree on the expiry rule', () => {
    // If they disagreed, an entry could be treated as live by one and dead
    // by the other — either a permanent lockout or a throttle that never
    // engages. Sits just INSIDE the window.
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordLoginFailure_('2414');
    const key = loginThrottleKey_('2414');
    const entry = JSON.parse(store[key]);
    entry.t = Date.now() - (LOGIN_WINDOW_MINUTES * 60 * 1000) + 1000;
    store[key] = JSON.stringify(entry);
    assert.strictEqual(loginIsThrottled_('2414'), true, 'checker treated a live window as expired');
    recordLoginFailure_('2414');
    assert.strictEqual(JSON.parse(store[key]).c, LOGIN_MAX_ATTEMPTS + 1,
      'recorder reset a window the checker still considers live');
  });

  check('a corrupted cache entry fails OPEN, not into a lockout', () => {
    wipe();
    store[loginThrottleKey_('2414')] = 'not json at all';
    assert.strictEqual(loginIsThrottled_('2414'), false,
      'unparseable state must never lock a real admin out');
    recordLoginFailure_('2414');
    assert.strictEqual(JSON.parse(store[loginThrottleKey_('2414')]).c, 1,
      'the recorder should start a clean window over corrupt state');
  });

  check('an evicted entry degrades to no-throttle, never to a lockout', () => {
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 5; i++) recordLoginFailure_('2414');
    assert.strictEqual(loginIsThrottled_('2414'), true);
    delete store[loginThrottleKey_('2414')];          // cache eviction
    assert.strictEqual(loginIsThrottled_('2414'), false);
  });

  check('System IDs are trimmed so whitespace cannot bypass the counter', () => {
    wipe();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordLoginFailure_('2414');
    assert.strictEqual(loginIsThrottled_(' 2414 '), true,
      'padding the ID must not hand out a fresh allowance');
  });
}

// ================================================ unrecognised holiday type
console.log('\n=== Unrecognised holiday type warning (Code.gs) ===\n');
{
  const logged = [];
  const loggerShim = Object.assign({}, shim, { Logger: { log: (m) => logged.push(m) } });
  const sandbox = Object.assign({}, loggerShim, {
    console, Date, Math, JSON, Intl, RegExp, String, Number, Object, Array,
    isNaN, parseInt, parseFloat
  });
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync('/home/claude/gas/shift-board-google-workspace/Code.gs', 'utf8'),
    sandbox, { filename: 'Code.gs' }
  );

  const sched = () => {
    const s = {};
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .forEach((d) => { s[`${d}From`] = '08:00'; s[`${d}To`] = '17:00'; s[`${d}IsRestday`] = false; });
    return s;
  };
  const emp = (id) => ({
    basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
    workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'Sup' },
    workSchedule: sched()
  });

  function classify(type, dayKey, logs) {
    sandbox.SCHEDULE_CACHE_SNAPSHOT = {
      adjustments: {}, leaves: {},
      holidays: { [`5|${dayKey}`]: [{ name: 'X', type }] }
    };
    return sandbox.classifyEmployeeForDay(emp(5), {
      weekday: sandbox.weekdayForDayKey(dayKey),
      dayDate: new Date(`${dayKey}T12:00:00Z`),
      dayKey,
      logsByBioId: sandbox.buildLogsByBioId(logs || [])
    });
  }
  const holidayWarnings = () => logged.filter((m) => m.indexOf('Unrecognised holiday type') !== -1);
  // warnedOnceKeys_ is script-scope, i.e. it lives for one Apps Script
  // execution. Each check below is a separate notional execution, so it is
  // reset here — and the fact that it CAN be reset is itself the proof that
  // the suppression is per-run rather than permanent.
  const freshRun = () => { sandbox.warnedOnceKeys_ = {}; logged.length = 0; };

  check('a missing hyphen is warned about, and excuses nobody', () => {
    freshRun();
    const r = classify('Non Working Holiday', '2026-08-21');
    assert.strictEqual(holidayWarnings().length, 1);
    assert.ok(holidayWarnings()[0].indexOf('"Non Working Holiday"') !== -1,
      'the warning must name the offending value');
    assert.strictEqual(r.status, 'didNotReport',
      'an unrecognised type must NOT excuse anyone — that is the safe direction');
  });

  check('the same bad value is warned about once, not once per employee-day', () => {
    freshRun();
    for (let d = 21; d <= 28; d++) classify('Non Working Holiday', `2026-08-${d}`);
    assert.strictEqual(holidayWarnings().length, 1,
      'eight classifications should produce one warning, not eight');
  });

  check('a second, different bad value gets its own warning', () => {
    freshRun();
    classify('non-working holiday', '2026-08-21');       // wrong casing
    classify('Special Non-Working Day', '2026-08-22');   // plausible new category
    assert.strictEqual(holidayWarnings().length, 2);
  });

  check('neither known type produces a warning', () => {
    freshRun();
    const off = classify('Non-Working Holiday', '2026-08-21');
    const on = classify('Mandatory Working Holiday', '2026-08-22');
    assert.strictEqual(holidayWarnings().length, 0, 'no false positives on the real values');
    assert.strictEqual(off.status, 'holiday', 'a non-working holiday still excuses');
    assert.strictEqual(on.status, 'didNotReport', 'a working holiday still excuses nobody');
  });

  check('warning or not, a working holiday still marks a late arrival late', () => {
    freshRun();
    const r = classify('Mandatory Working Holiday', '2026-08-21',
      [{ bioEmpID: 'B5', logTime: '2026-08-21T08:20:00', inOutMode: 'In' }]);
    assert.strictEqual(r.status, 'presentButLate');
    assert.strictEqual(r.entry.lateMinutes, 20);
  });

  check('the suppression is per-run: a new execution warns about the same value again', () => {
    freshRun();
    classify('Non Working Holiday', '2026-08-21');
    assert.strictEqual(holidayWarnings().length, 1);
    classify('Non Working Holiday', '2026-08-22');
    assert.strictEqual(holidayWarnings().length, 1, 'still suppressed within the run');
    freshRun();                                   // next scheduled refresh
    classify('Non Working Holiday', '2026-08-23');
    assert.strictEqual(holidayWarnings().length, 1,
      'a later run must report the problem again rather than inherit the silence');
  });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
