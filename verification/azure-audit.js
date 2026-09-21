/**
 * Adversarial audit of the AZURE/Node classification logic (src/sprout.js).
 * Runs the real production code against edge cases and reports what it does.
 * Nothing here is compared against the Apps Script port — this is about
 * whether Azure itself behaves correctly.
 */
const nodeSide = require('./node-sprout.js').__test;

const findings = [];
function finding(severity, title, detail) {
  findings.push({ severity, title, detail });
}

function sched(overrides) {
  const s = {};
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((d) => {
    s[`${d}From`] = '08:00';
    s[`${d}To`] = '17:00';
    s[`${d}IsRestday`] = false;
  });
  return Object.assign(s, overrides || {});
}

function emp(systemId, bioId, schedule) {
  return {
    basicInformation: { systemId, employeeId: String(systemId), firstName: 'T', lastName: String(systemId) },
    workInformation: { biometricId: bioId, department: 'Ops', reportsTo: 'Sup' },
    workSchedule: schedule
  };
}
const log = (bio, t, mode) => ({ bioEmpID: bio, logTime: t, inOutMode: mode });

function classify(employee, logs, dayKey, adjustments = {}, leaves = {}) {
  nodeSide.scheduleAdjustmentCache.clear();
  nodeSide.leaveCache.clear();
  Object.keys(adjustments).forEach((k) => nodeSide.scheduleAdjustmentCache.set(k, adjustments[k]));
  Object.keys(leaves).forEach((k) => nodeSide.leaveCache.set(k, leaves[k]));
  return nodeSide.classifyEmployeeForDay(employee, {
    weekday: nodeSide.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: nodeSide.buildLogsByBioId(logs)
  });
}
const show = (r) => `${r.status}` +
  (r.entry.lateMinutes != null ? ` (${r.entry.lateMinutes} min)` : '') +
  (r.entry.reason ? ` [${r.entry.reason}]` : '') +
  (r.entry.loginTime ? ` IN=${r.entry.loginTime.slice(11, 16)}` : '') +
  (r.entry.logoutTime ? ` OUT=${r.entry.logoutTime.slice(11, 16)}` : '') +
  (r.entry.leaveFrom ? ` leave ${r.entry.leaveFrom}..${r.entry.leaveTo}` : '');

console.log('='.repeat(70));
console.log('AZURE (src/sprout.js) — behavioural audit');
console.log('='.repeat(70));

// ---------------------------------------------------------------- 1
console.log('\n[1] Night shift from the WEEKLY SCHEDULE (21:00 -> 06:00)');
{
  const e = emp(1, 'B1', sched({
    thursdayFrom: '21:00', thursdayTo: '06:00',
    fridayFrom: '21:00', fridayTo: '06:00'
  }));
  const logs = [log('B1', '2026-09-03T21:05:00', 'In'), log('B1', '2026-09-04T06:10:00', 'Out')];
  const d1 = classify(e, logs, '2026-09-03');
  const d2 = classify(e, logs, '2026-09-04');
  console.log('  shift night   :', show(d1));
  console.log('  morning after :', show(d2));
  if (d1.status === 'didNotReport') {
    finding('HIGH', 'Permanent night shifts always show as Did Not Report',
      'A weekly schedule of 21:00->06:00 puts both times on the same calendar day, so end lands ' +
      'before start, the log-match window inverts and both punches are discarded. Only night ' +
      'shifts arriving as a schedule ADJUSTMENT work, because those carry full datetimes.');
  }
}

// ---------------------------------------------------------------- 2
console.log('\n[2] Lunch-break punches (in, out, in, out)');
{
  const e = emp(2, 'B2', sched());
  const logs = [
    log('B2', '2026-09-03T07:55:00', 'In'), log('B2', '2026-09-03T12:00:00', 'Out'),
    log('B2', '2026-09-03T13:00:00', 'In'), log('B2', '2026-09-03T17:05:00', 'Out')
  ];
  console.log(' ', show(classify(e, logs, '2026-09-03')), '(want: onTime, IN=07:55, OUT=17:05)');
}

// ---------------------------------------------------------------- 3
console.log('\n[3] inOutMode variants');
{
  const e = emp(3, 'B3', sched());
  [['In', 'Out'], ['in', 'out'], ['IN', 'OUT'], ['0', '1'], [0, 1]].forEach(([i, o]) => {
    const r = classify(e, [log('B3', '2026-09-03T07:55:00', i), log('B3', '2026-09-03T17:00:00', o)], '2026-09-03');
    console.log(`  ${JSON.stringify(i)}/${JSON.stringify(o)} -> ${show(r)}`);
  });
  const weird = classify(e, [log('B3', '2026-09-03T07:55:00', 'TimeIn'), log('B3', '2026-09-03T17:00:00', 'TimeOut')], '2026-09-03');
  console.log('  "TimeIn"/"TimeOut" ->', show(weird));
  if (weird.status === 'didNotReport') {
    finding('MEDIUM', 'Only four inOutMode spellings are recognised',
      'buildLogsByBioId accepts "in"/"out"/"0"/"1" and silently DROPS anything else. A device or ' +
      'a Sprout change emitting "TimeIn"/"TimeOut" (or 2/3 for break punches) would make every ' +
      'affected employee read as Did Not Report, with no error anywhere.');
  }
}

// ---------------------------------------------------------------- 4
console.log('\n[4] Missing schedule data');
{
  console.log('  no To time      :', show(classify(emp(4, 'B4', sched({ thursdayTo: '' })), [], '2026-09-03')));
  console.log('  no From time    :', show(classify(emp(5, 'B5', sched({ thursdayFrom: '' })),
    [log('B5', '2026-09-03T10:00:00', 'In')], '2026-09-03')));
  console.log('  no workSchedule :', show(classify(
    { basicInformation: { systemId: 6 }, workInformation: { biometricId: 'B6' } },
    [log('B6', '2026-09-03T10:00:00', 'In')], '2026-09-03')));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] Employee with no biometricId');
{
  const e = emp(7, undefined, sched());
  const other = [log(undefined, '2026-09-03T08:00:00', 'In')];
  const r = classify(e, other, '2026-09-03');
  console.log(' ', show(r));
  if (r.entry.loginTime) {
    finding('MEDIUM', 'Employees with no biometricId collect every unmatched punch',
      'buildLogsByBioId keys on log.bioEmpID with no guard, so logs whose bioEmpID is missing ' +
      'bucket under "undefined" — and every employee lacking a biometricId looks that bucket up. ' +
      'They inherit attendance that is not theirs, and several such employees share one set.');
  }
}

// ---------------------------------------------------------------- 6
console.log('\n[6] Lateness boundaries');
{
  const e = emp(8, 'B8', sched());
  [['08:00:00', 'exactly on time'], ['08:00:29', '29s late'], ['08:00:31', '31s late'], ['07:59:00', 'a minute early']]
    .forEach(([t, label]) => {
      console.log(`  ${label.padEnd(16)} -> ${show(classify(e, [log('B8', `2026-09-03T${t}`, 'In')], '2026-09-03'))}`);
    });
}

// ---------------------------------------------------------------- 7
console.log('\n[7] Rest day vs leave precedence');
{
  const e = emp(9, 'B9', sched({ saturdayIsRestday: true }));
  const lv = { '9|2026-09-05': [{ type: 'Vacation', isWhole: true }] };
  console.log('  rest day AND on leave ->', show(classify(e, [], '2026-09-05', {}, lv)));
}

// ---------------------------------------------------------------- 8
console.log('\n[8] Adjustment turning a rest day into a working day');
{
  const e = emp(10, 'B10', sched({ saturdayIsRestday: true, saturdayFrom: '', saturdayTo: '' }));
  const adj = { '10|2026-09-05': { isRestDay: false, shiftFrom: '2026-09-05T09:00:00', shiftTo: '2026-09-05T18:00:00' } };
  console.log(' ', show(classify(e, [log('B10', '2026-09-05T09:10:00', 'In')], '2026-09-05', adj)), '(want: 10 min late)');
}

// ---------------------------------------------------------------- 9
console.log('\n[9] Leave range: 14-day walk cap');
{
  const e = emp(11, 'B11', sched());
  const lv = {};
  for (let i = 0; i < 40; i++) {
    const d = new Date('2026-08-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    lv[`11|${d.toISOString().slice(0, 10)}`] = [{ type: 'Vacation', isWhole: true }];
  }
  const r = classify(e, [], '2026-08-20', {}, lv);
  console.log(' ', show(r), '(real leave runs 2026-08-01..2026-09-09)');
}

// ---------------------------------------------------------------- 10
console.log('\n[10] Leave entry with no type');
{
  const e = emp(12, 'B12', sched());
  const lv = { '12|2026-09-03': [{ paid: 1, isWhole: true }] };
  console.log(' ', show(classify(e, [], '2026-09-03', {}, lv)));
}

// ---------------------------------------------------------------- 11
console.log('\n[11] Unparseable / odd log timestamps');
{
  const e = emp(13, 'B13', sched());
  const logs = [
    log('B13', 'not-a-date', 'In'),
    log('B13', '2026-09-03T08:30:00.500Z', 'In'),
    log('B13', null, 'Out')
  ];
  console.log(' ', show(classify(e, logs, '2026-09-03')), '(the .500Z one is 08:30 Manila)');
}

// ---------------------------------------------------------------- 12
console.log('\n[12] Two employees sharing one biometricId');
{
  const a = emp(14, 'SHARED', sched());
  const b = emp(15, 'SHARED', sched());
  const logs = [log('SHARED', '2026-09-03T08:30:00', 'In')];
  console.log('  employee 14 ->', show(classify(a, logs, '2026-09-03')));
  console.log('  employee 15 ->', show(classify(b, logs, '2026-09-03')));
}

// ---------------------------------------------------------------- 13
console.log('\n[13] Timezone handling of log timestamps');
{
  ['2026-09-03T08:30:00', '2026-09-03T08:30:00Z', '2026-09-03T08:30:00+08:00', '2026-09-03T08:30:00.123Z']
    .forEach((t) => {
      const d = nodeSide.parseManilaDateTime(t);
      console.log(`  ${t.padEnd(30)} -> ${d.toISOString()} (Manila ${nodeSide.formatDateKey(d)})`);
    });
}

// ---------------------------------------------------------------- 14
console.log('\n[14] Manila midnight boundary');
{
  [['2026-09-03T23:59:00', 'just before midnight Manila'], ['2026-09-04T00:30:00', 'just after']]
    .forEach(([t, label]) => {
      const d = nodeSide.parseManilaDateTime(t);
      console.log(`  ${label.padEnd(30)} -> dayKey ${nodeSide.formatDateKey(d)}`);
    });
}

console.log('\n' + '='.repeat(70));
console.log(`FINDINGS: ${findings.length}`);
console.log('='.repeat(70));
findings.forEach((f, i) => {
  console.log(`\n${i + 1}. [${f.severity}] ${f.title}\n   ${f.detail}`);
});
