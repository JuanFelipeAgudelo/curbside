# Flight checks: when a flight is looked up

Every lookup of a flight costs money (today AeroDataBox through RapidAPI: 2 units a lookup, 400 units
a month on the free plan, so 200 lookups a month for every driver together). So each flight gets
only the checks that can change what the driver does. Built in `worker/src/checks.ts`; the numbers
below are its constants.

## The ladder

| Flight | Check | When | Why |
|---|---|---|---|
| Arriving | `a3h` | ~3 hours before landing | a delay or a cancellation, before the driver leaves |
| Arriving | `a45` | ~45 minutes before landing | the new time and the terminal, on the road |
| Arriving | `a15` | ~15 minutes after landing (may still be made up to 2 hours late) | landed, and the belt |
| Departing | `d3h` | ~3 hours before take-off | the terminal, or a cancellation |

A departure gets one check only: a later departure never moves the drop-off (the check-in deadline
counts from the earlier of scheduled and estimated, see `two-clocks.md`). No extra checks are added
after a change.

Whether a flight is arriving or departing comes from the row's tag (`A`/`GBA` arriving,
`D`/`GBD` departing). The **first check is planned from the time the sheet printed** for the flight
(its Time/City cell, on the New York clock, since every one of our airports is Eastern), so
importing a sheet looks nothing up. After a lookup, the next check is planned from the flight's own
latest estimate. A flight with no time anywhere (sheet or lookup) gets one lookup to learn it.

## Skipping, never bunching

- **A check is skipped when the next one is less than 40 minutes away** (`SUPERSEDE_MS`). A sheet
  imported late does not fire three lookups at once.
- A check before one already made is skipped too: a delay can put the 3-hour mark back in the
  future, and that is no reason to go back for it.
- **Two lookups in a row that find nothing** (`MAX_MISSES` = 2; a wrong number) and the flight is
  given up. A cancellation ends it.
- **A lookup that fails is not a flight nobody knows**: the service down or the network gone, the
  same check is tried once more at the next run of the schedule, then skipped for the one after.
  A flight is never given up for an error, and each check is made at most twice.

Worked through by the code (UA1503 lands 11:15p):

| Sheet imported | Checks made |
|---|---|
| 5:00p | 8:15p (a3h), 10:30p (a45), 11:30p (a15) |
| 9:00p | 9:00p (a3h, at once: it is due), 10:30p, 11:30p |
| 10:00p | 10:30p (a3h skipped: a45 is under 40 minutes away), 11:30p |
| 11:00p | 11:30p only (a3h and a45 skipped) |

AF5 departs 6:30p: imported 9:00a, one check at 3:30p; imported 4:00p, one check at once.

## The schedule

The checker runs **every 20 minutes** (the Cloudflare app's cron, `*/20 * * * *`) and looks up the
flights whose next check is due. In Power Platform this is one scheduled flow (see `README.md` for
whether it is a Power Automate cloud flow or an agent flow: they are billed differently).

## A flight nobody meets is not looked up (v69)

A passenger marked not coming, a flight number corrected away, a stop not happening, a re-sent sheet
without the flight: the flight may still be tracked, and its remaining checks would cost money for
nobody. So **before a lookup, the checker asks whether any run still names the flight**, with the
driver's corrections applied and learned airlines filled in.

- Nobody meets it: the check is left due and marked (`unmet`).
- Nobody again at the next run, 20 minutes on: the check is skipped without a lookup.
- Met again in between (the driver pressed UNDO): looked up as usual.
- When no check is left, the flight is let go (its plan, status and trackers deleted). Undoing a
  not-coming or a flight fix tracks it again.

**Asked at the check, not at the edit:** a driver's changes can arrive back to back, and a flight let
go at the moment of an edit could be one still on the screen that is never checked again.

## A re-sent sheet that moves a flight's printed time (v69)

The first check is planned again from the new time, **only while no check has been made**. After
that, the flight's own times plan the rest.

## The budget

| What | Value | Constant |
|---|---|---|
| Units a month (the free plan) | 400 | `MONTHLY_UNITS` |
| Units a lookup | 2 | `UNITS_PER_LOOKUP` |
| Below this many units left, only the ~45-minutes-before-landing check is made | 60 | `RESERVE_UNITS` |
| Checks stop when a lookup would leave fewer than this | 4 | `STOP_UNITS` |

So with 6 or more units left checks run (only `a45` under 60), and with fewer than 6 they are
paused until the month renews. The service's own "remaining" and "reset" figures win over the count
when it sends them. When several checks are due at once, the before-landing ones go first.

What the driver is told: *Flight checks running low: only the one before landing*, or in red,
*Flight checks paused until Thu 1 Oct*. Settings shows the lookups left and when they renew.

**For the department:** 200 lookups a month cannot serve every driver. A rough count: an arriving
flight costs up to 3 lookups and a departing one 1; 20 drivers with one flight a day each is
roughly 1,200–1,800 lookups a month. That needs a paid plan or the department's own flight data
(`it-request.md`, item 5). Keep the ladder either way: it is what keeps the cost proportional to the
work. Set `MONTHLY_UNITS` and the thresholds to the plan bought.

## What a lookup stores

Per flight: the status (terminal, gate, belt, scheduled and estimated times on both ends, each
end's country and time zone), when it was fetched, and the plan (next check, checks made, misses).
Then every stop that meets the flight is re-computed (`two-clocks.md`) and an alert is written if
something the driver does moved (`alerts.md`).

## Freshness

Never red for its age: hours between checks is the plan. *Flights checked 12m ago* under the run's
headline uses the newest check among its flights; a green dot marks a check in the last five minutes.
