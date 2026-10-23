# The two clocks at an airport stop

Curbside's one job that nothing else does: dispatch worked out the run's times when every flight
was on time. When a flight moves, dispatch's numbers are stale, and these two clocks say what the
flight now means for the driver. They are **the app's numbers, always shown beside dispatch's**,
never in place of them.

## The rule, in one sentence

**Be there for the earliest obligation; leave after the latest one.**

- **Parked by** is set by the *earliest* obligation at the stop. Parked means in the parking lot.
- **Leaving at** is set by the *latest* release at the stop.

A pickup's obligation is its flight's touchdown. A drop-off's is its check-in deadline. One stop can
hold both (set one party down, collect another).

## The numbers

Checked against the code: `worker/src/notify.ts` (the alerts) and `public/assignments.js` (the
screen) carry the same constants, and `worker/src/kit.test.ts` fails if this table drifts from them.

| What | Minutes | Constant |
|---|---|---|
| Parked before an arriving flight lands | 15 min | `BUFFER_MIN` |
| Parked before a Governing Body (GBA) passenger's flight lands | 30 min | `BUFFER_GB_MIN` |
| Check-in deadline before a domestic departure | 120 min | `LEAD_DOM_MIN` |
| Check-in deadline before an international departure | 180 min | `LEAD_INTL_MIN` |
| After a domestic landing, until the passenger is out (bags) | 45 min | `DEPLANE_DOM_MIN` |
| After an international landing (45 bags + 60 customs) | 105 min | `DEPLANE_INTL_MIN` |
| A moved time smaller than this is noise | 5 min | `MIN_SHIFT_MIN` |

## How each row counts

For every passenger row at an airport stop (EWR, JFK, LGA, SWF, HPN, ALB, BDL) that has a flight
and is not marked "not coming":

- **An arriving row** (tag `A` or `GBA`):
  - its obligation = the flight's **estimated** landing (scheduled when there is no estimate)
    minus 15 minutes (30 for a GB row). **Nothing is subtracted for deplaning**: that allowance is a
    maximum, not a licence to arrive late; a passenger with a carry-on is at the curb in ten minutes.
  - its release = the same landing plus 45 minutes (domestic) or 105 minutes (international).
- **A departing row** (tag `D`, `GBD`; `TD` would count the same way but train rows are not supported):
  - its obligation = the **earlier** of the scheduled and the estimated departure, minus 2 hours
    (domestic) or 3 hours (international). A delayed flight does not move the check-in desk, and
    guessing that it does is the expensive mistake.
  - it has no release: a drop-off is done when it is handed over.

Then **Parked by** = the earliest obligation of all the rows; **Leaving at** = the latest release.
The row that sets each is named beside it ("Sets Parked by", "Sets Leaving").

**International** = either end of the flight outside the US and its territories (US, PR, VI, GU, AS,
MP), told by each airport's country; when only a time zone is known, only a US zone counts as
domestic. **When it cannot be told, use the longer allowance** (3 hours, 105 minutes): guessing
domestic can make the driver late; guessing international only makes them wait.

GB for the buffer is **per row** (that passenger is GBA). GB for loudness of alerts is **per stop**:
the run is GB or any row at the stop is.

## What it is not

- It never changes dispatch's times. The stop keeps dispatch's ETA and ETD. A delay is reported
  underneath, named for its flight: *running ~37m late, WN748*.
- It never re-orders stops or suggests a different plan.
- When the driver set their own time for the stop, the clocks run on the driver's, and both are said:
  *leave by 9:59p, you set 9:45p, dispatch 9:30p*. "Dispatch planned" is always dispatch's number.
- A stop the driver added has no clocks of its own unless it is an airport with a flight to meet.
- A drop-off at home of someone who landed earlier has no flight clock: flights are worked at the airport.

## Leave by

When dispatch's sheet has a leg to this stop (the previous stop's ETD to this stop's ETA, both
printed), **leave by** = Parked by − that leg. The leg is dispatch's own drive time; no table is
consulted. With no leg in the sheet, only *be there by* is said, never a guessed drive time.

## Why earliest and latest (the owner's rule, 2026-09-19)

"When it's two passengers, the driver does not arrive when the last flight gets there; they are
always at the airport BEFORE the first flight arrives." Anchor both clocks on the latest flight and
the driver is late: a passenger lands to no car and no call. Anchor both on the earliest and the
driver waits in a lot, which costs only time. The rule bends toward the cheap mistake. Read both
from **estimated** times: they can swap mid-run when the earlier flight slips past the later one.

## Worked examples

Generated from the code, in `test-set.csv` (the rows that start "Run 369736", "Run 352711",
"Run 340343", "Run 348400"). For instance, run 369736 at LGA with UA1503 at 11:15p and WN748 at
11:20p, both domestic: parked by 11:00p (UA1503 − 15), leaving at 12:05a (WN748 + 45), beside
dispatch's 11:00p to 12:00a.

## For a builder without the Azure Function

The arithmetic above as steps a flow can run per airport stop, after each flight status update:

```
parked = none; leaving = none
for each row at the stop with a flight, not marked not coming, with a stored status:
    intl = not (departure country in US-set and arrival country in US-set)   # unknown -> true
    if row tag is D or GBD:
        basis = min(scheduled departure, estimated departure)   # whichever exist
        due = basis - (intl ? 180 : 120) minutes
        if parked is none or due < parked: parked = due, parkedRow = row
    else:
        landing = estimated arrival, else scheduled arrival
        due = landing - (row is GB ? 30 : 15) minutes
        if parked is none or due < parked: parked = due, parkedRow = row
        free = landing + (intl ? 105 : 45) minutes
        if leaving is none or free > leaving: leaving = free, leavingRow = row
```

Count in real instants (UTC), and show them on the New York clock: across a daylight-saving change
the wall clock jumps, real time does not. With the Azure Function, call `clocksFor` instead
(`azure-functions.md`): it is this, already tested.
