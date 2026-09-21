# Verification harness

Loads the real `Code.gs` and the real Azure `src/sprout.js` into Node and exercises their
classification logic directly — no API, no mocking framework, no deployment.

## Setup

```
cp /path/to/shift-board-no-auth/src/sprout.js ./node-sprout.js
cat >> node-sprout.js <<'APPEND'
module.exports.__test = {
  scheduleAdjustmentCache, leaveCache,
  classifyEmployeeForDay, buildLogsByBioId, getShiftBoundariesForDay,
  findShiftLogTimes, reconstructLeaveRange, formatDateKey, weekdayForDayKey,
  parseManilaDateTime
};
APPEND

cp /path/to/shift-board-no-auth/src/auth-store.js ./node-auth-store.js
npm install bcryptjs      # only needed by auth-compare.js
```

## The four suites

| File | What it checks |
|---|---|
| `compare.js` | Port vs Azure produce **identical** classifications (32 cases) |
| `auth-compare.js` | Port vs Azure session tokens are cross-compatible, plus registration/login/reset rules (25 cases) |
| `holiday-check.js` | Holidays and half-day leave (14 cases) |
| `divergence-check.js` | The places the two **deliberately differ**, and why (5 cases) |
| `gas-hardening-check.js` | The port's login throttle and unrecognised-holiday-type warning (17 cases) |
| `ampm-leave-check.js` | AM/PM half-day leave, port vs Azure, plus the rendered label (12 cases) |
| `azure-18sep-check.js` | Asymmetric attendance thresholds, scheduled shift hours, viewedDayKey (17 cases) |
| `seconds-format-check.js` | "HH:MM:SS" schedule times, and the both-null boundary guard (10 cases) |
| `azure-latest-check.js` | Azure's 11 Sep fixes — rate-limiter sweep and credential warning (12 cases) |
| `azure-audit.js` | Azure's logic against adversarial edge cases; prints findings |

Total as of 22 Sep 2026: **132 passing**. All nine suites were mutation-tested — each one was
re-run against deliberately broken copies of the code it covers, and each caught the break.
A suite that stays green when you sabotage the thing it tests is decoration.

## Read `divergence-check.js` before trusting `compare.js`

`compare.js` passing does **not** mean the two versions are in sync. It means the paths it
covers agree. As of 11 Sep 2026 they intentionally differ on overnight shifts, holidays, long
leave ranges and stray biometric IDs — `compare.js` has no cases for any of those, so it would
keep passing regardless.

Two divergences are structural and will never converge:

- **Holiday bucket.** Both sides apply the same rule (only a Non-Working Holiday excuses
  anyone); they differ only in where the person lands. Azure reuses Rest Day with the holiday
  name attached, the port gives holidays their own category so the count is visible.
- **Login throttling.** Azure rate-limits per IP. Apps Script cannot: a `google.script.run`
  call exposes no caller IP to the script at all, so the port counts failures per System ID
  instead. See the header comment in `Auth.gs` for the trade-off that forces.

`divergence-check.js` exists to make that visible. A failure there means a gap **closed** —
either Azure got patched (good; move the case into `compare.js`) or the port regressed (bad).

## What these do and don't prove

**Do:** classification rules, shift boundary parsing, log-to-shift matching, leave range
reconstruction, timezone handling, the employment filter, token signing and auth rules.

**Don't:** anything touching the Sprout API, Google Sheets, triggers, or a browser. All stubbed.
Two of the three worst bugs found on 11 Sep were invisible to these suites — one lived in the
Sheets layer they don't touch, the other was shared with Node so the comparison couldn't see it.

**When adding a case, assert the old behaviour first and watch it fail.** A test that passes
before and after your fix is testing nothing. Both bugs above passed a green 25-case suite the
entire time they were live.
