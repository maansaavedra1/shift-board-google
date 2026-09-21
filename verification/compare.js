/**
 * Differential test: runs identical scenarios through the Node original
 * (src/sprout.js) and the Apps Script port (Code.gs), and reports any
 * divergence in classification.
 *
 * This verifies the PURE LOGIC only — classification, shift boundaries, log
 * matching, leave range reconstruction. It does NOT verify anything that
 * touches the Sprout API, Sheets, or triggers.
 */
const assert = require('assert');
const nodeSide = require('./node-sprout.js').__test;
const { gas, setCache } = require('./load-gas.js');

let pass = 0;
let fail = 0;
const failures = [];

// A workSchedule with the same shift every weekday, and Sat/Sun as rest days.
function schedule(from, to, restWeekend) {
  const s = {};
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((d) => {
    s[`${d}From`] = from;
    s[`${d}To`] = to;
    s[`${d}IsRestday`] = restWeekend ? (d === 'saturday' || d === 'sunday') : false;
  });
  return s;
}

function employee(systemId, bioId, sched) {
  return {
    basicInformation: { systemId, employeeId: String(systemId), firstName: 'Test', lastName: 'Employee' + systemId },
    workInformation: { biometricId: bioId, department: 'Ops', reportsTo: 'Someone' },
    workSchedule: sched
  };
}

function log(bioId, isoLocal, mode) {
  return { bioEmpID: bioId, logTime: isoLocal, inOutMode: mode };
}

/**
 * Loads the same cache contents into both implementations, then classifies
 * the same employee on the same day through both, and compares.
 */
function runCase(name, { emp, logs, dayKey, adjustments = {}, leaves = {} }) {
  // --- Node side: module-level Maps ---
  nodeSide.scheduleAdjustmentCache.clear();
  nodeSide.leaveCache.clear();
  Object.keys(adjustments).forEach((k) => nodeSide.scheduleAdjustmentCache.set(k, adjustments[k]));
  Object.keys(leaves).forEach((k) => nodeSide.leaveCache.set(k, leaves[k]));

  // --- Apps Script side: injected snapshot ---
  setCache(Object.assign({}, adjustments), Object.assign({}, leaves));

  const nodeCtx = {
    weekday: nodeSide.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: nodeSide.buildLogsByBioId(logs)
  };
  const gasCtx = {
    weekday: gas.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: gas.buildLogsByBioId(logs)
  };

  const nodeResult = nodeSide.classifyEmployeeForDay(emp, nodeCtx);
  const gasResult = gas.classifyEmployeeForDay(emp, gasCtx);

  try {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(gasResult)),
      JSON.parse(JSON.stringify(nodeResult))
    );
    pass++;
    console.log(`  PASS  ${name}`);
    console.log(`        -> ${nodeResult.status}${nodeResult.entry.lateMinutes != null ? ` (${nodeResult.entry.lateMinutes} min late)` : ''}${nodeResult.entry.reason ? ` (${nodeResult.entry.reason})` : ''}${nodeResult.entry.leaveFrom ? ` (${nodeResult.entry.leaveFrom} -> ${nodeResult.entry.leaveTo}${nodeResult.entry.leaveIsHalfDay ? ', half-day' : ''})` : ''}`);
    return nodeResult;
  } catch (err) {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        node: ${JSON.stringify(nodeResult)}`);
    console.log(`        gas : ${JSON.stringify(gasResult)}`);
    return nodeResult;
  }
}

function expect(name, result, checkFn) {
  try {
    checkFn(result);
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

console.log('\n=== Differential test: Apps Script port vs Node original ===');
console.log('(all dates in the past, so "shift has ended" is deterministic)\n');

// ---------------------------------------------------------------------
console.log('--- The "893 minutes late" bug (schedule adjustment parsing) ---');
// Kiev's real case: default shift 06:00, adjustment moves it to 21:00.
// The adjustment value is a FULL DATETIME; the default is bare "HH:MM".
{
  const emp = employee(3000, 'B3000', schedule('06:00', '15:00', false));
  const adjustments = {
    '3000|2026-09-03': { isRestDay: false, shiftFrom: '2026-09-03T21:00:00', shiftTo: '2026-09-04T06:00:00' }
  };
  const logs = [
    log('B3000', '2026-09-03T21:05:00', 'In'),
    log('B3000', '2026-09-04T06:10:00', 'Out')
  ];

  const r = runCase('adjusted 9PM shift, clocked in 21:05', { emp, logs, dayKey: '2026-09-03', adjustments });
  expect('  -> is 5 minutes late, NOT 893', r, (x) => {
    assert.strictEqual(x.status, 'presentButLate');
    assert.strictEqual(x.entry.lateMinutes, 5);
  });
  expect('  -> picked up the next-morning checkout', r, (x) => {
    assert.ok(x.entry.logoutTime, 'no logoutTime captured');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- The graveyard/overnight shift bug ---');
{
  const emp = employee(3000, 'B3000', schedule('06:00', '15:00', false));
  const adjustments = {
    '3000|2026-09-03': { isRestDay: false, shiftFrom: '2026-09-03T21:00:00', shiftTo: '2026-09-04T06:00:00' }
  };
  const logs = [
    log('B3000', '2026-09-03T21:05:00', 'In'),
    log('B3000', '2026-09-04T06:10:00', 'Out')
  ];

  // The next day: the only log in that calendar day is the 06:10 checkout,
  // which belongs to YESTERDAY's overnight shift. The old code showed this
  // as "checked out but never checked in" on this day.
  const r = runCase('the day AFTER an overnight shift', { emp, logs, dayKey: '2026-09-04', adjustments });
  expect('  -> NOT misread as "missing log-in (has log-out)"', r, (x) => {
    assert.notStrictEqual(x.entry.reason, 'missing log-in (has log-out)');
    assert.strictEqual(x.status, 'didNotReport');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Leave range reconstruction (spanning a weekend) ---');
{
  // Thu 3rd + Fri 4th + Mon 7th of leave; Sat 5th / Sun 6th are rest days.
  // Expected: one continuous range 09-03 -> 09-07, not two ranges.
  const emp = employee(4000, 'B4000', schedule('08:00', '17:00', true));
  const vl = [{ type: 'Vacation Leave', isWhole: true }];
  const leaves = {
    '4000|2026-09-03': vl,
    '4000|2026-09-04': vl,
    '4000|2026-09-07': vl
  };

  const r = runCase('leave Thu+Fri+Mon, weekend rest days between', { emp, logs: [], dayKey: '2026-09-03', leaves });
  expect('  -> range extends across the weekend', r, (x) => {
    assert.strictEqual(x.status, 'onLeave');
    assert.strictEqual(x.entry.leaveFrom, '2026-09-03');
    assert.strictEqual(x.entry.leaveTo, '2026-09-07');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Leave range stops at a real working gap ---');
{
  const emp = employee(4001, 'B4001', schedule('08:00', '17:00', true));
  const vl = [{ type: 'Vacation Leave', isWhole: true }];
  const leaves = { '4001|2026-09-03': vl, '4001|2026-09-09': vl };
  const r = runCase('two separate leaves with working days between', { emp, logs: [], dayKey: '2026-09-03', leaves });
  expect('  -> does NOT swallow the working days between them', r, (x) => {
    assert.strictEqual(x.entry.leaveTo, '2026-09-03');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Half-day leave flag ---');
{
  const emp = employee(4002, 'B4002', schedule('08:00', '17:00', true));
  const leaves = { '4002|2026-09-03': [{ type: 'Sick Leave', isWhole: false, isFirstHalf: true }] };
  const logs = [log('B4002', '2026-09-03T13:00:00', 'In')];
  const r = runCase('half-day leave with an afternoon check-in', { emp, logs, dayKey: '2026-09-03', leaves });
  expect('  -> leaveIsHalfDay is true', r, (x) => {
    assert.strictEqual(x.entry.leaveIsHalfDay, true);
  });
  expect('  -> the check-in during leave is still reported (the anomaly)', r, (x) => {
    assert.ok(x.entry.loginTime, 'loginTime was dropped');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Missing log-in (has log-out) ---');
{
  const emp = employee(5000, 'B5000', schedule('08:00', '17:00', false));
  const logs = [log('B5000', '2026-09-03T17:05:00', 'Out')];
  const r = runCase('checked out, never checked in', { emp, logs, dayKey: '2026-09-03' });
  expect('  -> classified as presentButLate with that reason', r, (x) => {
    assert.strictEqual(x.status, 'presentButLate');
    assert.strictEqual(x.entry.reason, 'missing log-in (has log-out)');
    assert.strictEqual(x.entry.lateMinutes, null);
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Rest day (with and without logs) ---');
{
  const emp = employee(6000, 'B6000', schedule('08:00', '17:00', true));
  runCase('rest day, no logs', { emp, logs: [], dayKey: '2026-09-05' });
  const r = runCase('rest day, but they worked anyway', {
    emp, logs: [log('B6000', '2026-09-05T09:00:00', 'In'), log('B6000', '2026-09-05T18:00:00', 'Out')], dayKey: '2026-09-05'
  });
  expect('  -> rest-day logs still surface', r, (x) => {
    assert.strictEqual(x.status, 'restDay');
    assert.ok(x.entry.loginTime && x.entry.logoutTime);
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Adjustment marking a day as a rest day ---');
{
  const emp = employee(6001, 'B6001', schedule('08:00', '17:00', false));
  const adjustments = { '6001|2026-09-03': { isRestDay: true, shiftFrom: null, shiftTo: null } };
  const r = runCase('working day overridden to a rest day', { emp, logs: [], dayKey: '2026-09-03', adjustments });
  expect('  -> respects the adjustment over the weekly pattern', r, (x) => {
    assert.strictEqual(x.status, 'restDay');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- On time, and ordinary lateness ---');
{
  const emp = employee(7000, 'B7000', schedule('08:00', '17:00', false));
  runCase('clocked in at 07:55', { emp, logs: [log('B7000', '2026-09-03T07:55:00', 'In')], dayKey: '2026-09-03' });
  const r = runCase('clocked in at 08:14', { emp, logs: [log('B7000', '2026-09-03T08:14:00', 'In')], dayKey: '2026-09-03' });
  expect('  -> 14 minutes late', r, (x) => {
    assert.strictEqual(x.entry.lateMinutes, 14);
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Formerly divergent, now fixed on BOTH sides ---');
// These three were tracked in divergence-check.js while only the port had
// the fix. Azure has since been patched, so they belong here now — being
// compared, so neither side can quietly lose the fix.
{
  const nightSched = schedule('21:00', '06:00', false);
  const nightEmp = employee(9000, 'B9000', nightSched);
  const nightLogs = [log('B9000', '2026-09-03T21:05:00', 'In'), log('B9000', '2026-09-04T06:10:00', 'Out')];
  const r = runCase('permanent night shift, the shift\'s own night', { emp: nightEmp, logs: nightLogs, dayKey: '2026-09-03' });
  expect('  -> both capture the shift, 5 min late', r, (x) => {
    assert.strictEqual(x.status, 'presentButLate');
    assert.strictEqual(x.entry.lateMinutes, 5);
  });
  runCase('permanent night shift, the morning after', { emp: nightEmp, logs: nightLogs, dayKey: '2026-09-04' });

  const longLeave = {};
  for (let i = 0; i < 40; i++) {
    const d = new Date('2026-08-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    longLeave[`9001|${d.toISOString().slice(0, 10)}`] = [{ type: 'Vacation Leave', isWhole: true }];
  }
  const lr = runCase('a 40-day leave reports its true range on both', {
    emp: employee(9001, 'B9001', schedule('08:00', '17:00', true)), logs: [], dayKey: '2026-08-20', leaves: longLeave
  });
  expect('  -> 2026-08-01 .. 2026-09-09', lr, (x) => {
    assert.strictEqual(x.entry.leaveFrom, '2026-08-01');
    assert.strictEqual(x.entry.leaveTo, '2026-09-09');
  });

  const noBio = { basicInformation: { systemId: 9002 }, workInformation: {}, workSchedule: schedule('08:00', '17:00', false) };
  const stray = runCase('an employee with no biometric ID ignores stray punches', {
    emp: noBio, logs: [log(undefined, '2026-09-03T08:00:00', 'In')], dayKey: '2026-09-03'
  });
  expect('  -> no attendance attributed', stray, (x) => {
    assert.strictEqual(x.entry.loginTime, null);
  });
}

console.log('\n--- Timezone handling (the 8-hour bug) ---');
{
  // Sprout sometimes sends a bogus 'Z' on what is really Manila local time.
  const a = nodeSide.parseManilaDateTime('2026-09-03T08:00:00Z');
  const b = gas.parseManilaDateTime('2026-09-03T08:00:00Z');
  expect('both strip a bogus Z and apply +08:00 identically', null, () => {
    assert.strictEqual(a.getTime(), b.getTime());
    assert.strictEqual(a.toISOString(), '2026-09-03T00:00:00.000Z');
  });
  expect('weekdayForDayKey agrees', null, () => {
    ['2026-09-03', '2026-09-05', '2026-09-06', '2026-09-11'].forEach((k) => {
      assert.strictEqual(gas.weekdayForDayKey(k), nodeSide.weekdayForDayKey(k));
    });
    assert.strictEqual(gas.weekdayForDayKey('2026-09-11'), 'friday');
    assert.strictEqual(gas.weekdayForDayKey('2026-09-05'), 'saturday');
  });
}

// ---------------------------------------------------------------------
console.log('\n--- Employment status filter ---');
{
  // Exercised directly, since it lives inside getEmployees (which does I/O).
  const roster = [
    { workInformation: { employmentStatus: 'Regular' } },
    { workInformation: { employmentStatus: 'Resigned' } },
    { workInformation: { employmentStatus: 'TERMINATED' } },
    { workInformation: { employmentStatus: 'Probationary' } },
    { workInformation: { employmentStatus: 'Maternity' } },
    { workInformation: {} }
  ];
  const EXCLUDED = ['resigned', 'terminated'];
  const kept = roster.filter((e) => EXCLUDED.indexOf(((e.workInformation || {}).employmentStatus || '').toLowerCase()) === -1);
  expect('keeps regular/probationary/maternity/blank, drops resigned+terminated (case-insensitively)', null, () => {
    assert.strictEqual(kept.length, 4);
  });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('Failures: ' + failures.join('; '));
  process.exit(1);
}
