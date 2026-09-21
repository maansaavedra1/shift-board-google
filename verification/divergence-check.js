/**
 * DIVERGENCE TESTS
 *
 * compare.js asserts the Apps Script port and the Azure/Node original behave
 * IDENTICALLY. Where they deliberately don't, compare.js is blind — it has no
 * case covering it, so it keeps passing regardless. "32 passed" therefore
 * never means "in sync" on its own.
 *
 * This file covers what still differs on purpose.
 *
 * A failure here means a gap CLOSED. That is not automatically a bug — check
 * which side moved:
 *   - both converged (good: move the case into compare.js so it stays locked)
 *   - one lost its behaviour (bad: a real regression)
 * Either way a human has to look, which is the point.
 *
 * ---------------------------------------------------------------------------
 * GRADUATED TO compare.js — 11 Sep 2026
 *
 * These three were tracked here while only the port had the fix. Azure has
 * since been patched, this file failed on all three, and they were moved into
 * compare.js where both sides are now compared:
 *
 *   - permanent night shifts (21:00->06:00 on the weekly schedule)
 *   - long leave ranges beyond the reconstruction walk cap
 *   - logs with no biometric ID being attributed to the wrong people
 *
 * That is the mechanism working as designed.
 * ---------------------------------------------------------------------------
 */
const assert = require('assert');
const nodeSide = require('./node-sprout.js').__test;
const { gas, setCache } = require('./load-gas.js');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

function sched(from, to) {
  const s = {};
  ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].forEach((d) => {
    s[`${d}From`] = from; s[`${d}To`] = to; s[`${d}IsRestday`] = false;
  });
  return s;
}
const emp = (id) => ({
  basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
  workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'Sup' },
  workSchedule: sched('08:00', '17:00')
});
const log = (bio, t, m) => ({ bioEmpID: bio, logTime: t, inOutMode: m });

function both(e, logs, dayKey, { adj = {}, lv = {}, hol = {} } = {}) {
  nodeSide.scheduleAdjustmentCache.clear();
  nodeSide.leaveCache.clear();
  if (nodeSide.holidayCache) nodeSide.holidayCache.clear();
  Object.keys(adj).forEach((k) => nodeSide.scheduleAdjustmentCache.set(k, adj[k]));
  Object.keys(lv).forEach((k) => nodeSide.leaveCache.set(k, lv[k]));
  if (nodeSide.holidayCache) Object.keys(hol).forEach((k) => nodeSide.holidayCache.set(k, hol[k]));
  setCache(adj, lv, hol);
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

console.log('\n=== Intentional divergences: Apps Script port vs Azure/Node ===\n');

console.log('--- Holidays: same rule, different bucket ---');
console.log('    Both now excuse ONLY a "Non-Working Holiday" — a Mandatory Working');
console.log('    Holiday means premium pay but people are still expected in, and');
console.log('    excusing those would be worse than the bug holidays were added to fix.');
console.log('    They differ only in where the person lands: Azure reuses the existing');
console.log('    Rest Day bucket with the holiday name attached; the port gives');
console.log('    holidays their own seventh category so the count is visible.\n');
{
  const HOL = { '2|2026-08-21': [{ name: 'Ninoy Aquino Day', type: 'Non-Working Holiday' }] };

  check('the port uses its own holiday bucket', () => {
    assert.strictEqual(both(emp(2), [], '2026-08-21', { hol: HOL }).gas.status, 'holiday');
  });
  check('Azure reuses restDay for the same case', () => {
    const { node: n } = both(emp(2), [], '2026-08-21', { hol: HOL });
    assert.strictEqual(n.status, 'restDay',
      'Azure changed its holiday bucket — if it now matches the port, move this into compare.js');
  });
  check('both carry the holiday name through', () => {
    const { node: n, gas: g } = both(emp(2), [], '2026-08-21', { hol: HOL });
    assert.strictEqual(n.entry.holidayName, 'Ninoy Aquino Day');
    assert.strictEqual(g.entry.holidayName, 'Ninoy Aquino Day');
  });
  check('AGREED: a Mandatory Working Holiday excuses nobody, on either side', () => {
    const working = { '3|2026-08-21': [{ name: 'Araw ng Kagitingan', type: 'Mandatory Working Holiday' }] };
    const { node: n, gas: g } = both(emp(3), [], '2026-08-21', { hol: working });
    assert.strictEqual(n.status, 'didNotReport');
    assert.strictEqual(g.status, 'didNotReport');
  });
  check('AGREED: a working holiday still marks a late arrival late, on either side', () => {
    const working = { '4|2026-08-21': [{ name: 'Working', type: 'Mandatory Working Holiday' }] };
    const logs = [log('B4', '2026-08-21T08:20:00', 'In')];
    const { node: n, gas: g } = both(emp(4), logs, '2026-08-21', { hol: working });
    assert.strictEqual(n.status, 'presentButLate');
    assert.strictEqual(g.status, 'presentButLate');
    assert.strictEqual(n.entry.lateMinutes, 20);
    assert.strictEqual(g.entry.lateMinutes, 20);
  });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log('A failure means a gap closed. Check which side moved before treating it as a break.');
if (fail) process.exit(1);
