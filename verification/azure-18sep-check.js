/**
 * Azure's 18 Sep changes, ported: the asymmetric attendance thresholds, and
 * the new fields the dashboard renders from (scheduled shift hours on a
 * still-ongoing Late, and the viewed day on a leave row).
 *
 * Runs BOTH implementations on identical inputs. The headline case is the one
 * that prompted the change: a real employee logged in 4h24m early, fell
 * outside the old flat 4-hour window, and their login was discarded — so they
 * showed as "log-out with no matching log-in" while both punches sat in
 * Sprout's data intact.
 */
const assert = require('assert');
const nodeSide = require('./node-sprout.js').__test;
const { gas, setCache } = require('./load-gas.js');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

const H = (n) => n * 60 * 60 * 1000;
// The port runs inside a vm context, so its objects carry that context's own
// Object prototype — deepStrictEqual fails on prototype identity even when
// every value matches. Compare the values, not the object identities.
const pair = (t) => [t.pre, t.post];

function sched(from, to) {
  const s = {};
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .forEach((d) => { s[`${d}From`] = from; s[`${d}To`] = to; s[`${d}IsRestday`] = false; });
  return s;
}
const emp = (id, scheduleType, from, to) => ({
  basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
  workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'Sup', scheduleType: scheduleType },
  workSchedule: sched(from || '08:00', to || '17:00')
});
const L = (bio, t, m) => ({ bioEmpID: bio, logTime: t, inOutMode: m });

function both(e, logs, dayKey) {
  nodeSide.scheduleAdjustmentCache.clear();
  nodeSide.leaveCache.clear();
  if (nodeSide.holidayCache) nodeSide.holidayCache.clear();
  setCache({}, {}, {});
  const ctx = (impl) => ({
    weekday: impl.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: impl.buildLogsByBioId(logs)
  });
  return {
    node: nodeSide.classifyEmployeeForDay(e, ctx(nodeSide)),
    gas: gas.classifyEmployeeForDay(e, ctx(gas))
  };
}
const same = (r, what) => {
  assert.strictEqual(r.gas.status, r.node.status,
    `${what}: port=${r.gas.status} azure=${r.node.status}`);
  assert.strictEqual(r.gas.entry.loginTime, r.node.entry.loginTime, `${what}: loginTime differs`);
  assert.strictEqual(r.gas.entry.logoutTime, r.node.entry.logoutTime, `${what}: logoutTime differs`);
};

console.log('\n=== Attendance thresholds: Apps Script port vs Azure (18 Sep) ===\n');

console.log('--- the table itself ---');
check('Normal Shift is 6h before / 8h after, on both sides', () => {
  const g = gas.getAttendanceThresholds('Normal Shift');
  const n = nodeSide.getAttendanceThresholds('Normal Shift');
  assert.deepStrictEqual(pair(g), [H(6), H(8)]);
  assert.deepStrictEqual(pair(g), pair(n));
});
check('an unknown schedule type falls back to the WIDER window, not the narrower', () => {
  const g = gas.getAttendanceThresholds('Flexi Schedule Per Day');
  assert.deepStrictEqual(pair(g), [H(6), H(12)]);
  assert.deepStrictEqual(pair(g), pair(nodeSide.getAttendanceThresholds('Flexi Schedule Per Day')));
  assert.ok(g.post > gas.getAttendanceThresholds('Normal Shift').post,
    'falling back to a NARROWER window would silently discard real punches — the bug this fixes');
});
check('a missing schedule type also gets the default', () => {
  [undefined, null, ''].forEach((v) => {
    assert.deepStrictEqual(pair(gas.getAttendanceThresholds(v)), [H(6), H(12)]);
    assert.deepStrictEqual(pair(gas.getAttendanceThresholds(v)), pair(nodeSide.getAttendanceThresholds(v)));
  });
});

console.log('\n--- the reported case: a 4h24m-early login ---');
check('4h24m early is MATCHED now, on both sides (was discarded under the flat 4h window)', () => {
  // Shift 08:00-17:00, clocked in 03:36 and out 17:05.
  const logs = [L('B1', '2026-09-16T03:36:00', 'In'), L('B1', '2026-09-16T17:05:00', 'Out')];
  const r = both(emp(1, 'Normal Shift'), logs, '2026-09-16');
  assert.ok(r.gas.entry.loginTime, 'the early login must be found');
  same(r, '4h24m early');
  assert.strictEqual(r.gas.status, 'onTime',
    'early is not late — the whole point is that this login exists');
});

check('under the OLD flat 4h rule this same login would have been lost', () => {
  // Proves the test above is actually exercising the change rather than
  // passing for an unrelated reason: re-run the matcher with the old window.
  const logs = [L('B1', '2026-09-16T03:36:00', 'In'), L('B1', '2026-09-16T17:05:00', 'Out')];
  const byBio = gas.buildLogsByBioId(logs);
  const b = gas.getShiftBoundariesForDay('1', '2026-09-16', sched('08:00', '17:00'));
  const oldWay = gas.findShiftLogTimes(byBio.B1, b.start, b.end, null, H(4), H(4));
  const newWay = gas.findShiftLogTimes(byBio.B1, b.start, b.end, null, H(6), H(8));
  assert.strictEqual(oldWay.inTime, null, 'old 4h window should have missed it');
  assert.ok(newWay.inTime, 'new 6h window should catch it');
});

console.log('\n--- boundaries of the new window ---');
check('exactly 6h early is still inside (Normal Shift)', () => {
  const logs = [L('B2', '2026-09-16T02:00:00', 'In'), L('B2', '2026-09-16T17:00:00', 'Out')];
  const r = both(emp(2, 'Normal Shift'), logs, '2026-09-16');
  assert.ok(r.gas.entry.loginTime, '02:00 is exactly 6h before 08:00 and must be admitted');
  same(r, '6h early exactly');
});
check('6h1m early is outside, and both sides agree it is outside', () => {
  const logs = [L('B3', '2026-09-16T01:59:00', 'In'), L('B3', '2026-09-16T17:00:00', 'Out')];
  const r = both(emp(3, 'Normal Shift'), logs, '2026-09-16');
  assert.strictEqual(r.gas.entry.loginTime, null);
  same(r, '6h1m early');
});
check('a Normal Shift log-out 9h after the shift ends is excluded; the default type keeps it', () => {
  // 8h vs 12h post — the one place the two types genuinely differ.
  const logs = [L('B4', '2026-09-16T08:00:00', 'In'), L('B4', '2026-09-17T02:00:00', 'Out')];
  const normal = both(emp(4, 'Normal Shift'), logs, '2026-09-16');
  assert.strictEqual(normal.gas.entry.logoutTime, null, '9h past a Normal Shift is out of window');
  same(normal, 'Normal Shift, 9h late out');

  const flexi = both(emp(4, 'Flexi Schedule Per Day'), logs, '2026-09-16');
  assert.ok(flexi.gas.entry.logoutTime, 'the wider default window should keep it');
  same(flexi, 'default type, 9h late out');
});

console.log('\n--- nothing else moved ---');
check('an ordinary on-time day is unchanged', () => {
  const logs = [L('B5', '2026-09-16T07:50:00', 'In'), L('B5', '2026-09-16T17:10:00', 'Out')];
  const r = both(emp(5, 'Normal Shift'), logs, '2026-09-16');
  assert.strictEqual(r.gas.status, 'onTime');
  same(r, 'ordinary on-time');
});
check('a late arrival is still late, with the same minute count', () => {
  const logs = [L('B6', '2026-09-16T08:30:00', 'In')];
  const r = both(emp(6, 'Normal Shift'), logs, '2026-09-16');
  assert.strictEqual(r.gas.status, 'presentButLate');
  assert.strictEqual(r.gas.entry.lateMinutes, 30);
  assert.strictEqual(r.gas.entry.lateMinutes, r.node.entry.lateMinutes);
});
check('a night shift still matches across midnight', () => {
  const e = emp(7, 'Normal Shift', '21:00', '06:00');
  const logs = [L('B7', '2026-09-16T20:55:00', 'In'), L('B7', '2026-09-17T06:05:00', 'Out')];
  const r = both(e, logs, '2026-09-16');
  assert.strictEqual(r.gas.status, 'onTime');
  same(r, 'night shift');
});

console.log('\n--- the defaulting guard in findShiftLogTimes ---');
check('called without threshold arguments, the window is still finite', () => {
  // Undefined grace values would make every comparison NaN, and a NaN
  // comparison is false — so every filter would pass and the matcher would
  // admit punches from the entire fetch range. Worse than the old bug.
  const logs = [L('B8', '2026-09-10T08:00:00', 'In')];   // six days before the shift
  const byBio = gas.buildLogsByBioId(logs);
  const b = gas.getShiftBoundariesForDay('8', '2026-09-16', sched('08:00', '17:00'));
  const r = gas.findShiftLogTimes(byBio.B8, b.start, b.end, null);
  assert.strictEqual(r.inTime, null, 'a punch six days early must not be admitted');
});

console.log('\n--- new entry fields ---');
check('a still-ongoing Late carries its scheduled shift hours, matching Azure', () => {
  // No logs, and a shift that has not ended yet, so this lands on the
  // "shift still ongoing" branch. Dated forward so it stays ongoing.
  const future = new Date(Date.now() + 2 * 86400000).toISOString().substring(0, 10);
  const r = both(emp(9, 'Normal Shift'), [], future);
  assert.strictEqual(r.gas.status, 'late');
  assert.ok(r.gas.entry.scheduledShiftStart, 'the scheduled start must be present');
  assert.ok(r.gas.entry.scheduledShiftEnd, 'the scheduled end must be present');
  assert.strictEqual(r.gas.entry.scheduledShiftStart, r.node.entry.scheduledShiftStart);
  assert.strictEqual(r.gas.entry.scheduledShiftEnd, r.node.entry.scheduledShiftEnd);
});

check('the hours are the real boundaries, not the raw schedule strings', () => {
  const future = new Date(Date.now() + 2 * 86400000).toISOString().substring(0, 10);
  const r = both(emp(10, 'Normal Shift', '21:00', '06:00'), [], future);
  const start = new Date(r.gas.entry.scheduledShiftStart);
  const end = new Date(r.gas.entry.scheduledShiftEnd);
  assert.ok(end > start, 'a night shift end must already be rolled to the next day here');
});

check('a leave row carries viewedDayKey — the specific day, not the range', () => {
  const lv = { '11|2026-09-16': [{ type: 'Vacation', paid: 1, isWhole: true }],
               '11|2026-09-17': [{ type: 'Vacation', paid: 1, isWhole: true }] };
  nodeSide.leaveCache.clear();
  Object.keys(lv).forEach((k) => nodeSide.leaveCache.set(k, lv[k]));
  setCache({}, lv, {});
  const ctx = (impl, dk) => ({
    weekday: impl.weekdayForDayKey(dk), dayDate: new Date(dk + 'T12:00:00Z'),
    dayKey: dk, logsByBioId: impl.buildLogsByBioId([])
  });
  const e = emp(11, 'Normal Shift');
  const day1 = { gas: gas.classifyEmployeeForDay(e, ctx(gas, '2026-09-16')),
                 node: nodeSide.classifyEmployeeForDay(e, ctx(nodeSide, '2026-09-16')) };
  const day2 = { gas: gas.classifyEmployeeForDay(e, ctx(gas, '2026-09-17')),
                 node: nodeSide.classifyEmployeeForDay(e, ctx(nodeSide, '2026-09-17')) };
  assert.strictEqual(day1.gas.entry.viewedDayKey, '2026-09-16');
  assert.strictEqual(day2.gas.entry.viewedDayKey, '2026-09-17');
  assert.strictEqual(day1.gas.entry.viewedDayKey, day1.node.entry.viewedDayKey);
  assert.strictEqual(day2.gas.entry.viewedDayKey, day2.node.entry.viewedDayKey);
  // The range is the same on both days — which is exactly why the lookup
  // needs viewedDayKey and can't just use leaveFrom.
  assert.strictEqual(day1.gas.entry.leaveFrom, day2.gas.entry.leaveFrom);
});

check('a non-leave row has no viewedDayKey, on either side', () => {
  const logs = [L('B12', '2026-09-16T07:50:00', 'In')];
  const r = both(emp(12, 'Normal Shift'), logs, '2026-09-16');
  assert.strictEqual(r.gas.entry.viewedDayKey, undefined);
  assert.strictEqual(r.node.entry.viewedDayKey, undefined);
});

check('a Did Not Report row gets NO shift hours — only an ongoing Late does', () => {
  const r = both(emp(13, 'Normal Shift'), [], '2026-09-16');
  assert.strictEqual(r.gas.status, 'didNotReport');
  assert.strictEqual(r.gas.entry.scheduledShiftStart, undefined);
  assert.strictEqual(r.node.entry.scheduledShiftStart, undefined);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
