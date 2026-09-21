# Shift Board — Google Workspace (Apps Script) Version

This is the original, simplest version of Shift Board — built entirely on
Google Apps Script. No Docker, no Keycloak, no Azure, no separate hosting
for a backend. Good fit for demos, since there's nothing external to stand
up first.

**Access control is per-person login** as of September 2026 — System ID and
password, restricted to an allowlist. The shared access key this version used
to rely on is gone. See the Authentication section below for how it differs
from the Azure deployment, including two places where it is genuinely weaker.

## What's in this folder

```
shift-board-google-workspace/
├── Code.gs         (Sprout API, classification, the schedule/leave cache)
├── Web.gs          (serves the dashboard + the functions the page calls)
├── Auth.gs         (login, registration, sessions, admin reset)
├── Debug.gs        (dev-only helper functions — see note below)
├── index.html      (the dashboard — goes in the project as an HTML file)
└── verification/   (the differential test harness — not needed to deploy)
```

**All five go into the Apps Script project.** The dashboard is no longer a
separate file you open or host — Apps Script serves it, the same way the
Azure version's Express app serves its own `index.html`. One URL does
everything.

## How to deploy this for a demo

### 1. Set up the Apps Script backend

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Delete the default empty `Code.gs` content, paste in this repo's `Code.gs`
3. Click the **+** next to "Files" → **Script** → name it `Debug` → paste in `Debug.gs`. Repeat for `Auth` → `Auth.gs`, and `Web` → `Web.gs`
3b. Click **+** → **HTML** → name it `index` (no `.html` — Apps Script adds that) → paste in `index.html`
4. Go to **Project Settings** (gear icon) → **Script Properties** → add:
   - `SPROUT_BASE` — `https://gateway-sb.sprout.ph` for sandbox, or the real production URL for production use. **Confirm the production value directly with Sprout before using it for a real client** — sandbox and production turned out to use different API paths and request formats, not just a different domain, so this isn't just a URL swap (see the comment block at the top of `Code.gs` for details)
   - `SPROUT_CLIENT_ID`, `SPROUT_CLIENT_SECRET`, `SPROUT_SUBSCRIPTION_KEY`, `SPROUT_USER_ID` — your real Sprout HR credentials
   - `ADMIN_ALLOWLIST` — comma-separated System IDs allowed to register, e.g. `2414,2767,2696`. Nobody outside this list can create an account
5. **Run `installScheduleCacheTrigger()` once from the editor.** Pick it from
   the function dropdown at the top and click Run.

   **Do not skip this.** Schedule adjustments and leave both come from an
   endpoint that needs one call *per employee* — far too slow to run while
   someone waits for the dashboard. A background trigger keeps them cached
   instead. Without the trigger, the dashboard still loads, but every
   employee looks as though they have no adjustment and no leave, which is
   indistinguishable at a glance from "nobody is on leave today".

   A full cache cycle takes roughly 30 minutes to complete the first time
   (~359 employees, several trigger firings). Run `inspectScheduleCache()`
   in `Debug.gs` to watch its progress and confirm the trigger is installed.
6. Click **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (needed for the dashboard to reach it — the login is what actually gates the data, not this setting)
7. Copy the Web App URL Google gives you — you'll need it in step 2

**Before your first real use:** open `Debug.gs`, find `testLogging()` in the function dropdown at the top of the editor, and run it once directly from the editor. This is the only way Google shows the "allow this script to create Sheets?" permission popup — Web App requests never trigger that popup themselves, they just fail silently until this has been done once. Running `installScheduleCacheTrigger()` and `runOneCacheChunkNow()` from the editor covers the same ground for the Sheets and trigger permissions the cache needs.

### 2. Open the dashboard

Open the Web App URL from step 1. That's it — the page *is* the deployment.
No file to open, no URL to paste, nothing to host.

You'll get the login screen. Register with a System ID on your
`ADMIN_ALLOWLIST`, and you're in.

#### Why it isn't a standalone file any more

It was, until three separate problems made that untenable — all from the same
root, a static page calling Apps Script across origins:

1. A page opened from disk has origin `null`, which Apps Script rejects. Only
   fixable by hosting it somewhere.
2. **Apps Script answers a POST with a redirect, and browsers re-issue a
   redirected POST as a GET — dropping the body.** Login credentials never
   arrived; the request landed in `doGet` and came back "Not logged in".
   Nothing on the page's side can fix that.
3. Moving credentials into the query string *would* survive the redirect, but
   would write users' passwords into Google's execution logs in plain text.

Serving the page from the project removes all three at once, and matches how
the Azure version works: one server, one origin, page and API together.

## Full port — September 2026

`Code.gs`, `Auth.gs`, `Debug.gs` and `index.html` are all up to date with the
verified Node/Express version. All three stages are done: classification and
endpoint fixes, the login system, and the UI.

### Authentication (step 2)

System ID + password, restricted to the `ADMIN_ALLOWLIST` script property,
with each System ID checked against real Sprout employee data at
registration. Admin-assisted reset and 30-minute idle logout both carry over.
`DASHBOARD_ACCESS_KEY` is **gone** — a shared secret in a URL is what the
login system exists to replace — so delete that script property and drop the
`?key=` from your saved dashboard URL.

**Three deliberate differences from Azure, two of which are weaker.** These
are documented at the top of `Auth.gs`; the short version:

| | Azure/Node | Here | Why |
|---|---|---|---|
| Session | httpOnly cookie | HMAC-signed token in `localStorage` | Apps Script web apps can't set cookies. **Weaker:** an httpOnly cookie can't be read by JavaScript; a localStorage token can |
| Password hashing | bcrypt (cost 10) | iterated HMAC-SHA256 + per-account salt | No npm in Apps Script. **Weaker:** bcrypt is memory-hard and GPU-hostile; SHA-256 is not |
| Account storage | JSON file on disk | Script Properties | Equivalent, and no Docker-volume caveat |

The token format is otherwise identical to Node's, and verified to be: a
token minted by this implementation validates under Node's
`verifySessionToken` and vice versa, byte-for-byte, given the same secret.

Run `timePasswordHash()` in `Debug.gs` once and set `PASSWORD_HASH_ITERATIONS`
in `Auth.gs` to whatever lands around 1–2 seconds on your account. Raising it
later is safe — each account records the count it was created with.

### index.html

This is now the Node version's `public/index.html` with its server-side
credentials panel removed (Apps Script keeps those in Script Properties
instead) and its data layer pointed at the Apps Script Web App. The login
gate and admin-reset panel are the Node markup verbatim. It carries every
display change:

- Clickable summary cards — click a count to expand and scroll to that category
- Every category starts collapsed on each load (the old build remembered
  expand/collapse state in localStorage forever)
- Multi-day "quick-scan" pills are clickable too, correctly scoped per day
- Summary card numbers stay aligned when a label wraps to two lines
- Leave shows a reconstructed date range — "On leave (Sep 10, 2026 – Sep 14, 2026)"
- A login during approved leave is flagged in red next to the leave entry
- Employee ID replaces System ID in the Excel export
- A "Schedule adjustments synced HH:MM:SS" note sits next to "Last updated",
  reading the cache status this backend now returns

Two Apps Script-specific differences from the Node original:

- **The nudge is a GET, not a POST.** Apps Script web apps only expose
  `doGet`, so a dashboard refresh appends `&nudge=1` instead of POSTing to a
  dedicated endpoint. Same intent — push the cache along sooner than the next
  trigger firing — on a short 30-second budget, and it returns immediately if
  a trigger firing already holds the lock.
- **Unauthorized arrives as `ok:false`, not a 401.** Apps Script always
  returns HTTP 200, so an expired or missing session comes back as
  `{ ok: false, notLoggedIn: true }`. The dashboard treats that flag exactly
  as the Node version treats a 401: drop the token, show the login gate.
- **Login and register are POSTs with `Content-Type: text/plain`.** A JSON
  content type would trigger a CORS preflight, and an Apps Script web app has
  no way to answer an `OPTIONS` request. The body is still JSON; only the
  header differs.

The setup box asks for the plain `/exec` URL — no `?key=` any more.

**Endpoint corrections**

- The `ScheduleAdjustments` / `ScheduleAdjustment/:id` endpoints **do not
  exist** (confirmed with three separate 404s against production). The real
  per-date override data lives inside each day's `Schedules` response.
- `Leaves/SearchCriteria` is **blocked on Sprout's own side** — a
  token-issuer mismatch, escalated to Sprout, not fixable from this code.
  Leave now comes from that same `Schedules` response, at no extra API cost.

**Classification fixes**

- **The "893 minutes late" bug.** Adjustment times are full datetimes;
  default weekly schedule times are bare `HH:MM`. Feeding both through the
  same parser silently produced `Invalid Date`, so adjustments never took
  effect and people were scored against their unadjusted shift.
- **The graveyard/overnight shift bug.** Logs were bucketed by their own
  calendar day, so a 9 PM → 9 AM shift had its checkout land on the next
  day, disconnected from its shift — and then showed there as a bogus
  "checked out but never checked in".
- **Employment status filter.** Resigned and terminated employees are now
  excluded everywhere (~750 → ~359 at Firstmac).
- **Leave date ranges** are reconstructed by walking outward from a leave
  day, treating scheduled rest days as tolerated gaps, so a leave spanning a
  weekend reads as one range.

**The one place this deliberately differs from the Node version**

Node keeps the schedule/leave cache in memory on a long-running server and
refreshes every 5 minutes. Apps Script executions are stateless and
time-limited, so the cache lives in a Google Sheet and the refresh is
resumable across trigger firings.

The refresh interval also had to change. `UrlFetchApp` is capped per day
(20,000 consumer / 100,000 Workspace). A 5-minute full cycle here would be
roughly 207,000 calls a day — past even the Workspace ceiling. At the
default 10-minute trigger a full cycle takes ~30 minutes, or ~34,500
calls/day, which fits comfortably. **The tradeoff is that cached data can be
~30 minutes old rather than ~5.** If that's too stale, lower
`TRIGGER_INTERVAL_MINUTES` at the top of `Code.gs` and re-run
`installScheduleCacheTrigger()` — but redo the arithmetic first.

## Known caveats

- **This port has not been executed.** The Node original was run and verified
  against live production data. The classification logic here was checked by
  running both implementations against identical scenarios and diffing the
  results (25 cases, all matching), but everything that touches the Sprout
  API, Sheets, or triggers is unverified until someone runs it in a real
  Apps Script deployment.
- `Debug.gs` contains developer troubleshooting functions, including one that prints your actual `DASHBOARD_ACCESS_KEY` to the execution log. Delete this file (or at least don't mention it) before handing this off to anyone outside your dev team — see the comment at the top of `Debug.gs` for details.
- The dashboard URL is no longer a secret — it shows nothing without a login — but the Apps Script project itself still holds your Sprout credentials, so keep edit access to it tight.
