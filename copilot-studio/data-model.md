# The tables (Dataverse)

The Cloudflare app keeps one driver's list in a key-value store. The department's version keeps
every driver's runs in Dataverse, in the department's tenant. This is the design; the prefix `cs_` is
a placeholder for the solution's own publisher prefix.

## The one idea to keep

**Dispatch's copy is never edited.** A run is stored exactly as the sheet was read (the JSON in
`assignment.schema.json`), and the driver's changes are a separate, ordered log. What a driver sees
is dispatch's copy with the log applied, rebuilt after every import and every change
(`rules/corrections.md`). Rebuilding is cheap (a run is a few KB), and it is what lets a change
survive a re-sent sheet and lets dispatch's original always be shown beside the driver's.

So there are two kinds of tables:

- **Kept**: the run's sheet, the change log, flights, places, airlines. Written by imports, by the
  driver's changes and by the flight checks.
- **Shown**: stops and passengers flattened for the agent, views and a Power App to read and search.
  **Rebuilt, never edited by hand.** Any edit goes to the change log, then the run is rebuilt.

## Time: the trap

Dataverse's *Date and time* columns with the default *User local* behaviour convert to each viewer's
time zone. The sheet's times are New York wall clock, as printed, and must read the same for
everyone. So:

- dispatch's times stay **text, as printed** ("11:00 PM"), with a **Date only** column for the day;
- the run's start and end, as text `YYYY-MM-DD HH:MM` (sortable), plus a *Date only* day;
- computed instants (a flight's estimate, Parked by, Leaving at, when a check is due) are true
  instants: *Date and time*, behaviour **Time zone independent**, written in UTC, and shown on the
  New York clock in the `9:30p` format.

## Kept tables

### `cs_run`: one per assignment number

| Column | Type | Notes |
|---|---|---|
| `cs_number` | Text, **alternate key** | The identity. The same number updates in place. |
| `cs_sheet` | Multiple lines (JSON) | Dispatch's copy as read, whole. Never edited. Up to 256 KB. |
| `cs_base` | Multiple lines (JSON) | Dispatch's copy as of the last OK, for "what dispatch changed" (`rules/resent-sheets.md`). Never shown. |
| `cs_okprinted` | Text | The print time the last OK was given on. |
| `cs_printedat` | Text `YYYY-MM-DD HH:MM` | The footer's print time of the stored copy: decides which copy wins. |
| `cs_start`, `cs_end` | Text `YYYY-MM-DD HH:MM` | From the sheet, New York. |
| `cs_day` | Date only | The start's day, for views. |
| `cs_enddate` | Date only | For archive (10 h) and retention. |
| `cs_sheetdriver` | Text | The sheet's "Driver" as printed. |
| `cs_driver` | Lookup → `cs_driver` | Who the run is assigned to (see "Assigning a run"). Owner of the row. |
| `cs_gb` | Yes/No | Any GBA/GBD row. |
| `cs_issues` | Multiple lines | What the reader could not do, one per line. |
| `cs_importedat` | Date and time (UTC) | When this copy arrived. |
| `cs_importedby` | Lookup → user | Dispatch, or the driver. |
| `cs_pdf` | File (optional) | Only if the department wants the PDF kept; deleted with the run. |

### `cs_change`: the driver's change log (never compacted)

| Column | Type | Notes |
|---|---|---|
| `cs_run` | Lookup → `cs_run` | |
| `cs_kind` | Choice | field, remove, addEntity, addStep, addLeg |
| `cs_target` | Multiple lines (JSON) | How the change finds its row: the stop's key + which of how many, the door's verb + passenger names, the passenger's normalised name, a notes line's words, or the change that added the row (`rules/corrections.md`). |
| `cs_field` | Text | flightNumber, phone, note, where, eta, etd, time, line |
| `cs_value` | Text | What the driver set. |
| `cs_was` | Text | **What the sheet said when the driver made the change.** Without it a dispatch correction cannot be told from the value already overridden. |
| `cs_payload` | Multiple lines (JSON) | For adds: the passenger, stop or leg as typed. |
| `cs_label` | Text | For a removal: what was removed, in words. |
| `cs_basis` | Text | Which copy (`cs_importedat`) the driver was looking at: a change made on an older copy is refused. |
| `cs_at` | Date and time (UTC), **set by the server** | Orders the log. Not the phone's clock: a skewed clock would wedge a change into the middle. |
| `cs_by` | Lookup → user (+ device text) | Driver and helper share a run; this keeps the log readable. |
| `cs_ref` | Text, unique | The client's own id for the change: a change sent twice is recognised and stored once. |
| `cs_state` | Choice (written by the rebuild) | applied, contested, agreed, orphan. Shown; never acted on by itself. |

Undo = delete one `cs_change` row (and any row with the same `cs_ref`), then rebuild.

### `cs_flight`: one per flight number and date

| Column | Type | Notes |
|---|---|---|
| `cs_key` | Text, alternate key | `UA1503:2026-08-31` |
| `cs_role` | Choice | arriving / departing (from the tag) |
| `cs_sheettime` | Date and time (UTC, time zone independent) | The printed time, for planning the first check. |
| `cs_plan` | Multiple lines (JSON) | Next check (time and which), checks made, misses, unmet (`rules/flight-checks.md`). |
| `cs_nextcheck` | Date and time (UTC) | Copied from the plan, so the scheduled flow can query "due". |
| `cs_status` | Multiple lines (JSON) | The last status: both ends' scheduled and estimated times, terminal, gate, belt, country, time zone. |
| `cs_told` | Multiple lines (JSON) | The status the last alert was computed from. |
| `cs_fetchedat` | Date and time (UTC) | |

`cs_flight_run` (many-to-many with `cs_run`): which runs name the flight. Rebuilt with the run. A
flight with no run left, and no check left, is deleted.

### `cs_driver`: who is who

| Column | Type | Notes |
|---|---|---|
| `cs_user` | Lookup → user (Entra) | |
| `cs_sheetname` | Text, unique | The driver's name **exactly as dispatch's sheets print it**, "Reyes, Mara". |
| `cs_myname` | Text | What `[MY NAME]` fills with in messages. |
| `cs_retentiondays` | Whole number | 2, 7, 14 or 30; default 7 (if retention is per driver; else one department setting). |

### Places, airlines, car lots

| Table | Columns | Notes |
|---|---|---|
| `cs_place` | code, name, address, scope (everyone / one driver), driver, state (live / suggested / dismissed) | `rules/places-and-routes.md`. A driver's own wins over everyone's, which wins over the sheet's. |
| `cs_airline` | name (normalised: lower case, single spaces), code, scope, driver, state | A driver's taught airline is a suggestion for everyone. |
| `cs_carlot` | parking prefix, code, name, address | `FKL-NBD` → NCA. Dispatch keeps it. |

### Per driver, not per run

| Table | What |
|---|---|
| `cs_message` | driver, kind (departure / arrival / medical / shuttle / other), text. Only the kinds a driver changed; the rest use the default (`rules/messages.md`). |
| `cs_greeting` | driver, passenger name, brother / sister / name. |
| `cs_messaged` | driver, run, passenger name, when, what was said (time, door, from, to, flight, appointment, day, phone), for "changed since". |
| `cs_tick` | driver, run, notes line: a ticked leg. |

The Cloudflare app keeps these on the phone. In the department they can live per driver in Dataverse
(they then follow the driver between devices), or in the Power App's own storage.

### `cs_budget`

The flight-data budget: month, units spent, the service's own remaining and reset when it sends
them (`rules/flight-checks.md`).

## Shown tables (rebuilt from `cs_sheet` + `cs_change`)

| Table | One row per | Columns |
|---|---|---|
| `cs_stop` | stop on the served run | run, position (the stop's address on the stored sheet, `2` or `+<ref>` for an added stop), code, place, address, eta and etd (text: the value shown), dispatch's eta and etd (text, when the driver changed them), date, etaDate, added (yes/no), not happening (yes/no), window (yes/no), Parked by and Leaving at (UTC instants, with which flight sets each), dispatch's leg in minutes |
| `cs_passenger` | passenger row at a stop | stop, position (`2.0.1`), verb, door, dispatch's door, name, pax, tag, GB, origin, destination, phone (+ dispatch's), other phones, bags, note (+ dispatch's), flight number (+ dispatch's, + learned yes/no), flight date, printed time, appointment, route, not supported, added, not coming, contested fields |

**Address rows by their position on the stored sheet** (`2.0.1` = stop 2, door 0, passenger 1), or by
the change that added them, never by their place on a screen: added stops are placed by time, and
an index into what is shown would point at a different row on the server.

## Assigning a run

The sheet prints the driver's name ("Driver Reyes, Mara"). Look it up in `cs_driver.cs_sheetname`,
**exactly** (case and spacing normalised, nothing else). Found: the run is that driver's. Not found:
the run goes to dispatch's unassigned view, and dispatch assigns it by hand. **Never fuzzy-match a
name**: it is how one driver's run, with its passengers' names and phones, lands with another.

Assistants on the sheet (the Assistant table) who are drivers too see the run: match them the same
way and share the run with them (an access team per run, or a `cs_run_assistant` link).

A re-sent sheet updates the run under its number, whoever imports it.

## Roles

| Role | May |
|---|---|
| **Driver** | Read their own runs and those they assist on. Import a sheet (it is assigned by the rule above). Write changes on those runs (`cs_change`). Read places, airlines, car lots; suggest new ones. Write their own messages, greetings, ticks. |
| **Dispatch** | Read every run. Import sheets for anyone. Assign unassigned runs. Keep places, airlines and car lots (approve or dismiss suggestions). Delete a run for everyone. |
| **The flows' account** | Read runs and changes; write flights, statuses, plans, alerts and the shown tables. Nothing else. |

Dispatch's copy (`cs_sheet`, `cs_base`) is written **only by an import**, never by a driver's change
and never by the agent.

**The agent's Dataverse tools must run with the signed-in driver's own credentials** (end-user
authentication), so Dataverse's security decides what each driver can read. A tool that uses the
maker's connection lets every driver read every run.

## Limits worth keeping (from the Cloudflare app)

A run: 60 stops, 20 doors a stop, 60 passengers a door, 300 passengers, **12 flights**, 256 KB; 300
changes a run; notes up to 10,000 characters, other text 500.
