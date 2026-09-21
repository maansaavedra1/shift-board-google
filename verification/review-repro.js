/**
 * Reproduces the classification findings raised in the 11 Sep review by
 * EXECUTING the real Code.gs. Anything that does not reproduce here gets
 * dropped from the report.
 */
const fs = require('fs');
const vm = require('vm');
const shim = require('./gas-shim.js');

const logged = [];
const sandbox = Object.assign({}, shim, {
  Logger: { log: (m) => logged.push(m) },
  console, Date, Math, JSON, Intl, RegExp, String, Number, Object, Array,
  isNaN, parseInt, parseFloat
});
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('/home/claude/gas/shift-board-google-workspace/Code.gs', 'utf8'),
  sandbox, { filename: 'Code.gs' });

function sched(over) {
  const s = {};
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .forEach((d) => { s[`${d}From`] = '08:00'; s[`${d}To`] = '17:00'; s[`${d}IsRestday`] = false; });
  return Object.assign(s, over || {});
}
const emp = (id, over) => ({
  basicInformation: { systemId: id, employeeId: String(id), firstName: 'T', lastName: String(id) },
  workInformation: { biometricId: 'B' + id, department: 'Ops', reportsTo: 'Sup' },
  workSchedule: sched(over)
});
function classify(e, logs, dayKey, caches) {
  sandbox.SCHEDULE_CACHE_SNAPSHOT = Object.assign(
    { adjustments: {}, leaves: {}, holidays: {} }, caches || {});
  return sandbox.classifyEmployeeForDay(e, {
    weekday: sandbox.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: sandbox.buildLogsByBioId(logs || [])
  });
}
const L = (bio, t, m) => ({ bioEmpID: bio, logTime: t, inOutMode: m });
const show = (label, r) => console.log(`  ${label}\n    -> status=${r.status}  in=${r.entry.loginTime || '-'}  out=${r.entry.logoutTime || '-'}  ${r.entry.reason || ''}`);

console.log('\n#1  Unparseable schedule time ("REST DAY" in a time field, isRestDay false)');
console.log('    Claim: boundaries come back {start:null,end:null}, the object is truthy, so');
console.log('    findShiftLogTimes scans the WHOLE log list and attributes another day\'s punch.\n');
{
  const e = emp(1, { thursdayFrom: 'REST DAY', thursdayTo: 'REST DAY' });
  const b = sandbox.getShiftBoundariesForDay('1', '2026-09-03', e.workSchedule);
  console.log('    boundaries for 2026-09-03 (a Thursday):', JSON.stringify(b));
  // A punch from 19 days earlier, inside the fetch window of a long report.
  const r = classify(e, [L('B1', '2026-08-15T07:00:00', 'In'), L('B1', '2026-08-15T16:00:00', 'Out')],
    '2026-09-03');
  show('report day 2026-09-03, only logs are from 2026-08-15:', r);
}

console.log('\n#2  A future day in a custom range');
console.log('    Claim: shift has not ended and dayKey is not < today, so everyone falls through to "late".\n');
{
  const future = new Date(Date.now() + 3 * 86400000).toISOString().substring(0, 10);
  show(`day ${future} (3 days ahead), no logs:`, classify(emp(2), [], future));
}

console.log('\n#3  Overnight shift where only the START came from an adjustment');
console.log('    Claim: the +24h correction is skipped when fromIsAdjustment, giving an inverted window.\n');
{
  const ADJ = { '3|2026-09-10': { shiftStart: '2026-09-10T21:00:00', shiftEnd: null, isRestDay: false } };
  const e = emp(3, { thursdayFrom: '21:00', thursdayTo: '06:00' });
  const logs = [L('B3', '2026-09-10T20:55:00', 'In'), L('B3', '2026-09-11T06:05:00', 'Out')];
  show('adjustment start 21:00 + no end, worked 20:55->06:05:', classify(e, logs, '2026-09-10', { adjustments: ADJ }));
  console.log('    control — same shift with NO adjustment at all:');
  show('  ', classify(e, logs, '2026-09-10'));
}

console.log('\n#4  Employee whose biometricId is 0');
console.log('    Claim: buildLogsByBioId keeps bioId 0, but classify uses a truthiness test.\n');
{
  const e = emp(4);
  e.workInformation.biometricId = 0;
  const logs = [L(0, '2026-09-10T07:55:00', 'In'), L(0, '2026-09-10T17:05:00', 'Out')];
  console.log('    logsByBioId keys:', JSON.stringify(Object.keys(sandbox.buildLogsByBioId(logs))));
  show('bioId 0, punched in on time:', classify(e, logs, '2026-09-10'));
}

console.log('\n#5  Half-day leave flagged with a non-boolean false');
console.log('    Claim: isWhole === false is strict, so "false"/0 read as a whole day.\n');
{
  const cases = [false, 'false', 0, 'False'];
  cases.forEach((v) => {
    const r = classify(emp(5), [], '2026-09-10',
      { leaves: { '5|2026-09-10': [{ type: 'Vacation', paid: 1, isWhole: v, isHalfDay: true }] } });
    console.log(`    isWhole=${JSON.stringify(v)} -> leaveIsHalfDay=${r.entry.leaveIsHalfDay}`);
  });
}

console.log('\n#6  Leave walk cap (120 days) vs cached past window (90 days)');
console.log('    Claim: a leave running past the cache edge is reported as an EXACT boundary.\n');
{
  const leaves = {};
  // A leave that is present for every cached day, i.e. it runs off the edge of
  // what the cache holds rather than ending.
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2026, 8, 10) - i * 86400000).toISOString().substring(0, 10);
    leaves['6|' + d] = [{ type: 'Maternity', paid: 1, isWhole: true }];
  }
  const r = classify(emp(6), [], '2026-09-10', { leaves });
  console.log('    range:', JSON.stringify(r.entry.leaveRange || r.entry));
}

console.log('\n#7  Sanity: the ordinary cases still behave (guards against a broken harness)');
{
  show('on time:', classify(emp(7), [L('B7', '2026-09-10T07:50:00', 'In'), L('B7', '2026-09-10T17:10:00', 'Out')], '2026-09-10'));
  show('late:   ', classify(emp(7), [L('B7', '2026-09-10T08:30:00', 'In')], '2026-09-10'));
  show('absent: ', classify(emp(7), [], '2026-09-10'));
}
