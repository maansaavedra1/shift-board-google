/**
 * Holiday handling and the half-day marker. No Node counterpart — the Azure
 * version doesn't read holidays at all, which is the point.
 */
const assert = require('assert');
const { gas, setCache } = require('./load-gas.js');

function sched(rest) {
  const s = {};
  ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].forEach((d) => {
    s[`${d}From`] = '08:00'; s[`${d}To`] = '17:00';
    s[`${d}IsRestday`] = rest ? (d === 'saturday' || d === 'sunday') : false;
  });
  return s;
}
const emp = (id, rest) => ({
  basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
  workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'Sup' },
  workSchedule: sched(rest)
});
const log = (bio, t, m) => ({ bioEmpID: bio, logTime: t, inOutMode: m });

function run(e, logs, dayKey, { adj = {}, lv = {}, hol = {} } = {}) {
  setCache(adj, lv, hol);
  return gas.classifyEmployeeForDay(e, {
    weekday: gas.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: gas.buildLogsByBioId(logs)
  });
}

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

console.log('\n=== Holidays ===');
const HOL = { '100|2026-08-21': [{ name: 'Ninoy Aquino Day', type: 'Non-Working Holiday' }] };

check('a holiday is no longer Did Not Report', () => {
  const r = run(emp(100), [], '2026-08-21', { hol: HOL });
  assert.strictEqual(r.status, 'holiday');
  assert.strictEqual(r.entry.holidayName, 'Ninoy Aquino Day');
});
check('before the fix this same case was didNotReport', () => {
  const r = run(emp(100), [], '2026-08-21');   // identical, no holiday cached
  assert.strictEqual(r.status, 'didNotReport');
});
check('someone who worked the holiday keeps their times', () => {
  const logs = [log('B100', '2026-08-21T09:00:00', 'In'), log('B100', '2026-08-21T15:00:00', 'Out')];
  const r = run(emp(100), logs, '2026-08-21', { hol: HOL });
  assert.strictEqual(r.status, 'holiday');
  assert.ok(r.entry.loginTime && r.entry.logoutTime);
});
check('a holiday falling on a rest day stays Rest Day', () => {
  const hol = { '101|2026-09-05': [{ name: 'Some Holiday', type: 'Non-Working Holiday' }] };
  assert.strictEqual(run(emp(101, true), [], '2026-09-05', { hol }).status, 'restDay');
});
check('a holiday beats a leave filed for the same day', () => {
  const hol = { '102|2026-08-21': [{ name: 'Ninoy Aquino Day', type: 'Non-Working Holiday' }] };
  const lv = { '102|2026-08-21': [{ type: 'Vacation', isWhole: true }] };
  assert.strictEqual(run(emp(102), [], '2026-08-21', { hol, lv }).status, 'holiday');
});
check('an unnamed non-working holiday still classifies, labelled "Holiday"', () => {
  const hol = { '103|2026-08-21': [{ type: 'Non-Working Holiday' }] };
  const r = run(emp(103), [], '2026-08-21', { hol });
  assert.strictEqual(r.status, 'holiday');
  assert.strictEqual(r.entry.holidayName, 'Non-Working Holiday'); // falls back to the type, which is more useful than a generic label
});
check('a MANDATORY WORKING holiday does NOT excuse anyone', () => {
  // The bug this replaced: treating every holiday entry alike excused the
  // whole workforce on a day they were expected to work.
  const hol = { '104|2026-08-21': [{ name: 'Araw ng Kagitingan', type: 'Mandatory Working Holiday' }] };
  const r = run(emp(104), [], '2026-08-21', { hol });
  assert.notStrictEqual(r.status, 'holiday', 'a working holiday must not excuse anyone');
  assert.strictEqual(r.status, 'didNotReport');
});
check('a working holiday still marks someone late if they are', () => {
  const hol = { '108|2026-08-21': [{ name: 'Working Holiday', type: 'Mandatory Working Holiday' }] };
  const r = run(emp(108), [log('B108', '2026-08-21T08:20:00', 'In')], '2026-08-21', { hol });
  assert.strictEqual(r.status, 'presentButLate');
  assert.strictEqual(r.entry.lateMinutes, 20);
});
check('a non-working holiday alongside a working one still excuses', () => {
  const hol = { '109|2026-08-21': [
    { name: 'Working One', type: 'Mandatory Working Holiday' },
    { name: 'Real Holiday', type: 'Non-Working Holiday' }
  ] };
  const r = run(emp(109), [], '2026-08-21', { hol });
  assert.strictEqual(r.status, 'holiday');
  assert.strictEqual(r.entry.holidayName, 'Real Holiday');
});
check('an ordinary day is untouched', () => {
  const r = run(emp(105), [log('B105', '2026-09-03T07:55:00', 'In')], '2026-09-03');
  assert.strictEqual(r.status, 'onTime');
});

console.log('\n=== Half-day leave ===');
check('leaveIsHalfDay is set on a half-day', () => {
  const lv = { '106|2026-09-03': [{ type: 'Sick', isWhole: false }] };
  assert.strictEqual(run(emp(106), [], '2026-09-03', { lv }).entry.leaveIsHalfDay, true);
});
check('and false on a whole day', () => {
  const lv = { '107|2026-09-03': [{ type: 'Sick', isWhole: true }] };
  assert.strictEqual(run(emp(107), [], '2026-09-03', { lv }).entry.leaveIsHalfDay, false);
});

console.log('\n=== Invalid time values in schedule fields ===');
check('literal "REST DAY" text in a time field does not crash', () => {
  const s2 = sched(false);
  s2.thursdayFrom = 'REST DAY';
  s2.thursdayTo = 'REST DAY';
  const e = emp(110);
  e.workSchedule = s2;
  const r = run(e, [log('B110', '2026-09-03T08:00:00', 'In')], '2026-09-03');
  assert.ok(r.status, 'should classify without throwing');
  JSON.stringify(r); // would throw on an Invalid Date reaching toISOString
});

console.log('\n=== Leave truncation markers ===');
check('a leave with a real boundary is not marked approximate', () => {
  const lv = { '111|2026-09-03': [{ type: 'Vacation', isWhole: true }] };
  const r = run(emp(111), [], '2026-09-03', { lv });
  assert.strictEqual(r.entry.leaveFromIsApproximate, false);
  assert.strictEqual(r.entry.leaveToIsApproximate, false);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
