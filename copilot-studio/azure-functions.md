# The Azure Function: the app's own code behind a connector

If IT allows an Azure Functions app (`it-request.md`, item 4), the hardest parts of Curbside do not
need rebuilding at all: they are pure code with no storage, no network and no clock of their own,
already tested, and they run in Node.js as they are. Copilot Studio and Power Automate call them
through one custom connector, described by `connector.swagger.json` (OpenAPI 2.0, the version
Copilot Studio imports: [Learn](https://learn.microsoft.com/microsoft-copilot-studio/agent-extend-action-rest-api)).

The function code itself is written once IT says yes (the owner, 2026-10-23). This is what it wraps.

## What runs unchanged

| Files | What | Depends on |
|---|---|---|
| `public/importer/*.js` | The sheet reader: `readSheet(bytes, fileName)` | nothing (plain JavaScript modules) |
| `worker/src/notify.ts` | The two clocks (`stopsFor`, `clocksFor`) and the alert wording (`noticeFor`, `asScheduled`, `offSchedule`) | types only |
| `worker/src/checks.ts` | The check ladder and the budget (`checkMetaOf`, `anchorsOf`, `planNext`, `allowChecks`, `checksView`) | `assignment.ts` |
| `worker/src/patch.ts` | The driver's changes: finding the row (`aimPatch`), applying the log (`applyPatches`), duplicates and stale copies (`admitPatch`) | types only |
| `worker/src/changes.ts` | What dispatch changed between two copies (`baseOf`, `diffCopies`, `sameContent`) | `patch.ts` |
| `worker/src/learned.ts` | Airlines a driver taught (`applyLearned`) | types only |
| `worker/src/assignment.ts`, `types.ts` | The model and its checks (`isNewerCopy`, `flightsOf`) | nothing |

The repo's imports have no file extensions (its TypeScript settings use bundler resolution, with no
output), so bundle what a handler needs into one file, for example
`npx esbuild handler.ts --bundle --platform=node --format=esm --outfile=dist/handler.mjs`, where
`handler.ts` imports from `worker/src/` and `public/importer/`. `worker/src/index.ts` is **not** wrapped: it is the Cloudflare
Worker (routes, storage, cron); Dataverse and the flows take its place.

## The operations

All `POST`, JSON in and out, no state kept between calls.

| Operation | Wraps | In | Out |
|---|---|---|---|
| `ReadSheet` | `readSheet` | the PDF (base64) and its file name | `{ok: true, assignment}` or `{ok: false, reason}` (`reading-the-sheet.md`, "Refused") |
| `ServeRun` | `applyPatches`, `applyLearned`, `diffCopies`, as `assignmentsOf` in `worker/src/index.ts` does | dispatch's copy, the change log in order, the base (if any), the learned airlines | the run as shown: every row with its address (`_at`), the driver's values with dispatch's beside them, contested / agreed marks, orphans, and what dispatch changed since the base |
| `AimChange` | `aimPatch`, then `admitPatch` against the log | dispatch's stored copy, the change the driver asked for (row address, field, value; or an add or remove), the copy the driver was looking at | the change to store (with its target and `was`) or the reason it is refused |
| `IsNewerCopy` | `isNewerCopy`, `sameContent`, `baseOf` | the stored copy and an incoming one | whether the incoming one wins, whether only its print time changed, and the new base |
| `Clocks` | `stopsFor`, `clocksFor` | a served run, the flights' statuses | per airport stop: Parked by, Leaving at, the flight setting each, dispatch's times, dispatch's leg |
| `Notices` | `stopsFor`, `noticeFor` (and `asScheduled` for a first check) | the served runs that meet a flight, its previous and new status, the other flights' statuses, now, what was last told | the alerts to send: title, body lines, priority, tags, run number |
| `PlanCheck` | `checkMetaOf`, `anchorsOf`, `planNext` | a run (for its flights' sheet times) or one flight's role, sheet time, status, checks made, misses, now | the next check per flight, or done |
| `Budget` | `currentBudget`, `allowChecks`, `checksView` | the stored budget, the due checks, now | which checks may be made, and what to tell drivers |

## How the flows use it

- **Import** (a driver sends a PDF to the agent, or dispatch drops sheets in a folder): `ReadSheet` →
  refused: say why; else look up the run by number → `IsNewerCopy` → store `cs_sheet` (and the base)
  → `ServeRun` → write the shown tables → `PlanCheck` for its flights → tell the driver what happened.
- **A driver's change**: `AimChange` → store one `cs_change` row → `ServeRun` → write the shown tables.
- **The checker** (every 20 minutes): query `cs_flight` where the next check is due → `Budget` →
  for each allowed: is any run still naming the flight (`ServeRun` of its runs) → look it up (HTTP to
  the flight service) → store the status → `Notices` → post to Teams → `PlanCheck` → store the plan.

## Keep it right

- The tests already hold this code (`cd worker && npm test`: 487 tests on the commit that added this kit). The function adds only
  the JSON in and out: test each operation with the samples (`samples/*.json`) and the alert cases
  (`alert-examples.md`), which were produced by these same functions.
- **Log nothing from a request body**: it carries passengers' names and phones. Counts and flight
  numbers only, as the Worker does.
- Protect it with a function key (the connector sends it as `x-functions-key`) or Entra
  authentication (App Service authentication); allow only the Power Platform environment to call it.
- Copy the files from the repo at a tagged commit, and re-copy them when the repo's rules change, so
  the department's Curbside and this one never disagree about a clock.
