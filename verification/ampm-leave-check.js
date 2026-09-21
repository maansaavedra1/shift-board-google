/**
 * AM/PM half-day leave — ports Azure's 17 Sep change to the Apps Script side.
 *
 * Runs BOTH implementations on the same inputs and asserts they agree, so this
 * is a differential test, not a restatement of the port. Sprout's own
 * `isFirstHalf` on the leave application is the source: true = morning filed
 * (expected in that afternoon), false = afternoon filed.
 */
const assert = require('assert');
const nodeSide = require('./node-sprout.js').__test;
const { gas, setCache } = require('./load-gas.js');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

function sched() {
  const s = {};
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .forEach((d) => { s[`${d}From`] = '08:00'; s[`${d}To`] = '17:00'; s[`${d}IsRestday`] = false; });
  return s;
}
const emp = (id) => ({
  basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
  workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'Sup' },
  workSchedule: sched()
});

function both(id, dayKey, leaveEntries, logs) {
  const lv = {}; lv[`${id}|${dayKey}`] = leaveEntries;
  nodeSide.scheduleAdjustmentCache.clear();
  nodeSide.leaveCache.clear();
  if (nodeSide.holidayCache) nodeSide.holidayCache.clear();
  Object.keys(lv).forEach((k) => nodeSide.leaveCache.set(k, lv[k]));
  setCache({}, lv, {});
  const ctx = (impl) => ({
    weekday: impl.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: impl.buildLogsByBioId(logs || [])
  });
  return {
    node: nodeSide.classifyEmployeeForDay(emp(id), ctx(nodeSide)),
    gas: gas.classifyEmployeeForDay(emp(id), ctx(gas))
  };
}
const agree = (r, field) => {
  assert.strictEqual(r.gas.entry[field], r.node.entry[field],
    `${field}: port=${JSON.stringify(r.gas.entry[field])} azure=${JSON.stringify(r.node.entry[field])}`);
};

console.log('\n=== AM/PM half-day leave: Apps Script port vs Azure (17 Sep) ===\n');

check('morning half-day (isFirstHalf true) reads AM on both sides', () => {
  const r = both(1, '2026-09-15', [{ type: 'Vacation', paid: 1, isWhole: false, isFirstHalf: true }]);
  assert.strictEqual(r.gas.entry.leaveHalfDayPeriod, 'AM');
  agree(r, 'leaveHalfDayPeriod');
  agree(r, 'leaveIsHalfDay');
  assert.strictEqual(r.gas.status, 'onLeave');
  assert.strictEqual(r.node.status, 'onLeave');
});

check('afternoon half-day (isFirstHalf false) reads PM on both sides', () => {
  const r = both(2, '2026-09-15', [{ type: 'Sick', paid: 1, isWhole: false, isFirstHalf: false }]);
  assert.strictEqual(r.gas.entry.leaveHalfDayPeriod, 'PM');
  agree(r, 'leaveHalfDayPeriod');
});

check('a WHOLE-day leave gets no period at all — not defaulted to PM', () => {
  // isFirstHalf is absent on a whole-day record. If the period were read
  // before checking isWhole, `undefined ? 'AM' : 'PM'` would label every
  // full-day leave "PM" — wrong, and wrong in a way nobody would question.
  const r = both(3, '2026-09-15', [{ type: 'Vacation', paid: 1, isWhole: true }]);
  assert.strictEqual(r.gas.entry.leaveHalfDayPeriod, null);
  assert.strictEqual(r.gas.entry.leaveIsHalfDay, false);
  agree(r, 'leaveHalfDayPeriod');
  agree(r, 'leaveIsHalfDay');
});

check('half-day with isFirstHalf MISSING falls back to PM on both sides', () => {
  // Documents actual shared behaviour rather than asserting it is right:
  // both sides treat a missing isFirstHalf as "not the first half". See the
  // note printed at the end.
  const r = both(4, '2026-09-15', [{ type: 'Vacation', paid: 1, isWhole: false }]);
  agree(r, 'leaveHalfDayPeriod');
  assert.strictEqual(r.gas.entry.leaveIsHalfDay, true);
});

check('with two leave records, both sides pick the same one', () => {
  const r = both(5, '2026-09-15', [
    { type: 'Vacation', paid: 1, isWhole: true },
    { type: 'Sick', paid: 1, isWhole: false, isFirstHalf: true }
  ]);
  assert.strictEqual(r.gas.entry.leaveHalfDayPeriod, 'AM',
    'the half-day record must be found even when it is not first in the list');
  agree(r, 'leaveHalfDayPeriod');
});

check('the period survives alongside a log — the case the flag exists for', () => {
  // Someone on a morning half-day who worked the afternoon: legitimate, and
  // the reason the marker matters at all.
  const logs = [{ bioEmpID: 'B6', logTime: '2026-09-15T13:00:00', inOutMode: 'In' },
                { bioEmpID: 'B6', logTime: '2026-09-15T17:05:00', inOutMode: 'Out' }];
  const r = both(6, '2026-09-15', [{ type: 'Vacation', paid: 1, isWhole: false, isFirstHalf: true }], logs);
  assert.strictEqual(r.gas.entry.leaveHalfDayPeriod, 'AM');
  assert.ok(r.gas.entry.loginTime, 'the afternoon log must still come through');
  agree(r, 'leaveHalfDayPeriod');
  agree(r, 'loginTime');
});

check('leave type and date range are unchanged by this addition', () => {
  const r = both(7, '2026-09-15', [{ type: 'Vacation', paid: 1, isWhole: false, isFirstHalf: true }]);
  agree(r, 'leaveType');
  agree(r, 'leaveFrom');
  agree(r, 'leaveTo');
});

// ---- the label the dashboard actually renders ----
console.log('\n  --- rendered label (the port\'s detailFor rule) ---');
function label(e) {
  const prefix = (e.leaveIsHalfDay && e.leaveHalfDayPeriod) ? ('On ' + e.leaveHalfDayPeriod + ' leave') : 'On leave';
  let s = prefix + ' (15 Sep)';
  if (e.leaveIsHalfDay && !e.leaveHalfDayPeriod) s += ' · half-day';
  return s;
}
check('AM half-day renders "On AM leave (15 Sep)"', () => {
  assert.strictEqual(label({ leaveIsHalfDay: true, leaveHalfDayPeriod: 'AM' }), 'On AM leave (15 Sep)');
});
check('PM half-day renders "On PM leave (15 Sep)"', () => {
  assert.strictEqual(label({ leaveIsHalfDay: true, leaveHalfDayPeriod: 'PM' }), 'On PM leave (15 Sep)');
});
check('whole-day renders plain "On leave (15 Sep)" with no half-day marker', () => {
  assert.strictEqual(label({ leaveIsHalfDay: false, leaveHalfDayPeriod: null }), 'On leave (15 Sep)');
});
check('half-day with no known period keeps the generic marker', () => {
  // The one intentional difference from Azure, whose label would read a bare
  // "On leave" here and lose the half-day signal entirely.
  assert.strictEqual(label({ leaveIsHalfDay: true, leaveHalfDayPeriod: null }),
    'On leave (15 Sep) · half-day');
});
check('the AM/PM prefix does not also emit the redundant suffix', () => {
  assert.ok(label({ leaveIsHalfDay: true, leaveHalfDayPeriod: 'AM' }).indexOf('half-day') === -1,
    '"On AM leave (15 Sep) · half-day" would be saying it twice');
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log('\nNote: both sides map a MISSING isFirstHalf on a half-day record to "PM",');
console.log('because `isFirstHalf ? AM : PM` cannot tell absent from false. Harmless if');
console.log('Sprout always sets the field on half-day applications; worth one check');
console.log('against a real half-day record before trusting the label.');
if (fail) process.exit(1);
