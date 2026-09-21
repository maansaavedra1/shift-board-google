/**
 * Does the overnight fix work when the night shift comes from the DEFAULT
 * WEEKLY SCHEDULE (bare "21:00"/"06:00") rather than from a schedule
 * adjustment (full datetimes)? The differential tests only ever covered the
 * adjustment path. Run both implementations to find out.
 */
const nodeSide = require('./node-sprout.js').__test;
const { gas, setCache } = require('./load-gas.js');

function schedule(from, to) {
  const s = {};
  ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].forEach((d) => {
    s[`${d}From`] = from; s[`${d}To`] = to; s[`${d}IsRestday`] = false;
  });
  return s;
}
const emp = {
  basicInformation: { systemId: 8000, employeeId: '8000', firstName: 'Night', lastName: 'Worker' },
  workInformation: { biometricId: 'B8000', department: 'Ops', reportsTo: 'Someone' },
  workSchedule: schedule('21:00', '06:00')   // permanent graveyard, NO adjustment
};
const logs = [
  { bioEmpID: 'B8000', logTime: '2026-09-03T21:05:00', inOutMode: 'In'  },
  { bioEmpID: 'B8000', logTime: '2026-09-04T06:10:00', inOutMode: 'Out' }
];

nodeSide.scheduleAdjustmentCache.clear();
nodeSide.leaveCache.clear();
setCache({}, {});

['2026-09-03', '2026-09-04'].forEach((dayKey) => {
  const ctx = (impl) => ({
    weekday: impl.weekdayForDayKey(dayKey),
    dayDate: new Date(`${dayKey}T12:00:00Z`),
    dayKey,
    logsByBioId: impl.buildLogsByBioId(logs)
  });
  const n = nodeSide.classifyEmployeeForDay(emp, ctx(nodeSide));
  const g = gas.classifyEmployeeForDay(emp, ctx(gas));
  const b = nodeSide.getShiftBoundariesForDay(8000, dayKey, emp.workSchedule);
  console.log(`\n${dayKey} (shift 21:00 -> 06:00, from the weekly schedule)`);
  console.log('  computed start :', b.start.toISOString());
  console.log('  computed end   :', b.end.toISOString(),
    b.end < b.start ? '   <-- END IS BEFORE START' : '');
  console.log('  node ->', n.status, JSON.stringify({ in: n.entry.loginTime, out: n.entry.logoutTime, reason: n.entry.reason }));
  console.log('  gas  ->', g.status, JSON.stringify({ in: g.entry.loginTime, out: g.entry.logoutTime, reason: g.entry.reason }));
  console.log('  identical:', JSON.stringify(n) === JSON.stringify(g));
});
