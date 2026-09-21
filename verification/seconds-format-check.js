/**
 * Azure's 22 Sep fix: Sprout's weekly schedule fields arrive as "HH:MM:SS",
 * not "HH:MM". Appending ":00" to those built an Invalid Date, which nulled
 * both boundaries — and the two-null object is truthy, so the log matcher
 * then ran with NO window and reported a punch from an unrelated day as
 * today's, marked On Time.
 *
 * The port takes Azure's parsing fix AND closes the wider hole: when neither
 * boundary survives, return null instead of an object with two null fields.
 */
const assert = require('assert');
const nodeSide = require('./node-sprout.js').__test;
const { gas, setCache } = require('./load-gas.js');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

function sched(from, to) {
  const s = {};
  ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
    .forEach((d) => { s[`${d}From`] = from; s[`${d}To`] = to; s[`${d}IsRestday`] = false; });
  return s;
}
const emp = (id, from, to) => ({
  basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
  workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'S', scheduleType: 'Normal Shift' },
  workSchedule: sched(from, to)
});
const L = (bio, t, m) => ({ bioEmpID: bio, logTime: t, inOutMode: m });
function both(e, logs, dayKey) {
  nodeSide.scheduleAdjustmentCache.clear(); nodeSide.leaveCache.clear();
  if (nodeSide.holidayCache) nodeSide.holidayCache.clear();
  setCache({}, {}, {});
  const ctx = (impl) => ({
    weekday: impl.weekdayForDayKey(dayKey), dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey, logsByBioId: impl.buildLogsByBioId(logs)
  });
  return { node: nodeSide.classifyEmployeeForDay(e, ctx(nodeSide)),
           gas: gas.classifyEmployeeForDay(e, ctx(gas)) };
}

console.log('\n=== "HH:MM:SS" schedule times (Azure 22 Sep) ===\n');

check('"09:00:00" parses to a real time on both sides', () => {
  const g = gas.manilaTimeOnDay('2026-09-21', '09:00:00');
  const n = nodeSide.manilaTimeOnDay('2026-09-21', '09:00:00');
  assert.ok(!isNaN(g.getTime()), 'the port still produced an Invalid Date');
  assert.strictEqual(g.toISOString(), n.toISOString());
});
check('bare "09:00" still parses, identically', () => {
  const g = gas.manilaTimeOnDay('2026-09-21', '09:00');
  const n = nodeSide.manilaTimeOnDay('2026-09-21', '09:00');
  assert.ok(!isNaN(g.getTime()));
  assert.strictEqual(g.toISOString(), n.toISOString());
});
check('both formats give the SAME instant — no silent hour shift', () => {
  assert.strictEqual(gas.manilaTimeOnDay('2026-09-21', '09:00').toISOString(),
                     gas.manilaTimeOnDay('2026-09-21', '09:00:00').toISOString());
});
check('KNOWN SHARED GAP: a single-digit hour ("9:00:00") still fails to parse', () => {
  // Not a port bug — both sides behave identically, so this documents the
  // limit rather than asserting a fix. The seconds check correctly sees
  // "9:00:00" as already having seconds, but "...T9:00:00+08:00" is not
  // valid ISO 8601, which needs a two-digit hour.
  //
  // Left alone deliberately: Sprout has only ever been seen sending a
  // zero-padded "09:00:00", so padding here would be an unevidenced
  // divergence from the Node version. The consequence differs by side,
  // though — on the port the both-null guard below turns it into a visible
  // "no usable schedule", while Azure still gets the unbounded window.
  assert.ok(isNaN(gas.manilaTimeOnDay('2026-09-21', '9:00:00').getTime()),
    'if this now parses, one side gained a fix the other lacks — check which');
  assert.ok(isNaN(nodeSide.manilaTimeOnDay('2026-09-21', '9:00:00').getTime()),
    'Azure padded the hour — port this across and move the case above');
});

console.log('\n--- the failure this prevents ---');
check('an HH:MM:SS schedule no longer borrows another day\'s punch', () => {
  // Logs only from six days earlier. Under the old parsing both boundaries
  // came back null, the window was unbounded, and this reported On Time
  // using the 15 Sep punch.
  const e = emp(1, '09:00:00', '18:00:00');
  const logs = [L('B1', '2026-09-15T08:55:00', 'In'), L('B1', '2026-09-15T18:05:00', 'Out')];
  const r = both(e, logs, '2026-09-21');
  assert.strictEqual(r.gas.entry.loginTime, null, 'a punch from 15 Sep must not become 21 Sep');
  assert.strictEqual(r.gas.entry.loginTime, r.node.entry.loginTime);
  assert.strictEqual(r.gas.status, r.node.status);
});
check('and the same employee IS matched on their own day', () => {
  const e = emp(2, '09:00:00', '18:00:00');
  const logs = [L('B2', '2026-09-21T08:55:00', 'In'), L('B2', '2026-09-21T18:05:00', 'Out')];
  const r = both(e, logs, '2026-09-21');
  assert.strictEqual(r.gas.status, 'onTime');
  assert.strictEqual(r.gas.entry.loginTime, r.node.entry.loginTime);
});
check('an overnight HH:MM:SS shift still rolls to the next day', () => {
  const e = emp(3, '21:00:00', '06:00:00');
  const logs = [L('B3', '2026-09-21T20:55:00', 'In'), L('B3', '2026-09-22T06:05:00', 'Out')];
  const r = both(e, logs, '2026-09-21');
  assert.strictEqual(r.gas.status, 'onTime');
  assert.strictEqual(r.gas.entry.logoutTime, r.node.entry.logoutTime);
});

console.log('\n--- the class, not just the instance (port-only) ---');
check('an unparseable time returns NULL boundaries, not a two-null object', () => {
  // "REST DAY" in a time field on a non-rest day — confirmed real, and the
  // other route to the same unbounded window. Azure still returns the
  // object here.
  const b = gas.getShiftBoundariesForDay('4', '2026-09-21', sched('REST DAY', 'REST DAY'));
  assert.strictEqual(b, null, 'a boundary object with two nulls is truthy and defeats the caller guard');
  const nb = nodeSide.getShiftBoundariesForDay('4', '2026-09-21', sched('REST DAY', 'REST DAY'));
  assert.ok(nb && nb.start === null && nb.end === null,
    'Azure still returns the two-null object — if this fails, they fixed it too, and this case can move into compare.js');
});
check('so an unparseable schedule no longer attributes another day\'s punch', () => {
  const e = emp(5, 'REST DAY', 'REST DAY');
  const logs = [L('B5', '2026-09-15T08:00:00', 'In'), L('B5', '2026-09-15T17:00:00', 'Out')];
  const r = both(e, logs, '2026-09-21');
  assert.strictEqual(r.gas.entry.loginTime, null, 'the port must not borrow the 15 Sep punch');
  assert.strictEqual(r.gas.entry.logoutTime, null);
  // No usable shift end means the day can't be declared over, so this lands
  // on "Late — shift still ongoing". Unhelpful, but honest: it says nothing
  // it cannot back up, rather than inventing an On Time from a stale punch.
  assert.strictEqual(r.gas.status, 'late');
  // Azure, without the both-null guard, still reports the stale punch.
  assert.ok(r.node.entry.loginTime, 'expected Azure to still show the stale punch here');
  assert.strictEqual(r.node.status, 'onTime',
    'and to call it On Time — the exact confidently-wrong output the guard removes');
});
check('one usable boundary is still returned — only BOTH-null collapses', () => {
  const b = gas.getShiftBoundariesForDay('6', '2026-09-21', sched('09:00:00', 'REST DAY'));
  assert.ok(b, 'a half-valid schedule must still produce a window');
  assert.ok(b.start && !b.end);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
