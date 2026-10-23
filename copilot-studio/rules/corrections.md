# The driver's changes: corrections, adds and removes

**Who decides is the line** (the owner, 2026-09-23): the app never makes a decision nobody asked
for, but **the driver may change anything they need to**. Every change is recorded as the driver's,
visibly, with dispatch's original kept so the two stay apart. Built in `worker/src/patch.ts`.

## Never written into dispatch's copy

Dispatch's sheet is stored exactly as read and **never edited**. Each change is its own record in an
ordered log (the corrections table, `data-model.md`). What a driver sees is dispatch's copy with the
log applied on top, worked out again after every import and every change. This is what lets a
change survive a re-sent sheet: the import replaces dispatch's copy whole, and the log is applied to
the new one.

The log is also **the undo**: undoing removes one change by its id (and any duplicate of it sent
twice). The log is never compacted or cleaned up, because finding orphans and disagreements
depends on it. It is deleted with its run.

## What can be corrected

| Row | Fields |
|---|---|
| A passenger | flight number, phone, note |
| A door (pickup or drop-off) | where (the door) |
| A stop of dispatch's | ETA, ETD |
| A stop the driver added | its time (moves both), ETA, ETD |
| A timed notes line (a leg) | the line (its time, then its words) |

Anything else is refused. A step time: only one dispatch printed (a first stop's missing ETA is not
invented), only the wall clock (never the date), and a time is corrected, never cleared. The driver's
time **never re-sorts dispatch's stops**: that would be the app re-planning.

**Person-level facts reach every row of that passenger** that held the same value: correct a
passenger's flight at the airport and their drop-off row follows. The choice of *keep mine / use the
sheet* is asked once, where the correction was made.

**A corrected flight is tracked** (or it would show and never update), and a flight corrected away
stops being looked up (`flight-checks.md`). A run may name at most **12 flights**, corrections
included: a change that would make it 13 is refused.

## How a change finds its row (the hard part)

Nothing below the run number has an id on dispatch's sheet, and a re-sent sheet can add, drop or
move rows. So a change names its row **by content, with a guard**, and **never guesses**:

- **A stop:** its site code (or printed place) and date, which one of the stops sharing that key it
  is (the 1st WRK, the 2nd WRK), and **how many shared it when the change was made**. If that count
  differs on a later sheet, the change is an orphan: without this, dropping the opening WRK would send
  a correction meant for the departure to the return.
- **A door (action):** its verb and the exact set of passengers under it, then the same "which one,
  of how many" guard. 4 of 48 real stops have two actions with one verb (369736 has two Drop-offs at
  WKL, one per door).
- **A passenger:** their name, normalised (case, accents, spacing and separators), and **never
  fuzzy-matched**. Fuzzy matching is the only way one person's phone number lands on somebody else.
- **A timed notes line:** its own words, with the same guard; a reworded line that keeps its printed
  time still binds when exactly one line has that time (and both are shown).
- **A row the driver added** is addressed by the change that added it, not by content.

Rows the driver added are **invisible to the guards**: counted in, an added WRK would change every
WRK correction's count and orphan them all.

**An orphan is kept and shown**, listed with the changes the app could not place, for the driver to
re-enter or discard. It is never applied to a near miss.

**A change made on an older copy is refused.** Each change carries which copy of the sheet the driver
was looking at. If dispatch re-sent the run meanwhile, the change is refused (it would point at a
different row) and shown to the driver, never re-aimed.

## The driver wins, and the disagreement is shown

Each change records **what the sheet said when it was made**. When a later sheet says something else
for that field, the driver's value stands and both are shown, with **KEEP MINE** and **USE THE
SHEET**. When dispatch's new sheet agrees with the driver, it says so (**CLEAR MY EDIT**); nothing is
dropped on its own, because that would be a silent write.

## Removing: "not happening"

A no-show at the curb, or a cancellation by phone. A stop or a passenger (not a door alone).

- **Marked, never deleted.** Dispatch's row stays, struck and dim: *NOT COMING* / *NOT HAPPENING*,
  with an **UNDO that never expires**. No "are you sure": the undo is the safety.
- **A passenger not coming is not coming to any of their rows**: the drop-off goes with the pickup,
  by exact name, as one change with one undo.
- A removed row sets no clock, sends no alert, is not looked up, and leaves the message list and the
  route.
- A row **the driver added** reads *Remove*, and its ghost says *REMOVED*, with the same undo.
- When a later sheet drops the row too, it is listed under **THE SHEET AGREES**.

## Adding: what dispatch said by phone, or the driver's own

- **A passenger** under any pickup or drop-off: a name; flight, phone and note optional; arriving or
  departing (proposed from the stop and the verb, the driver can change it). An added passenger's
  flight is tracked and sets the clocks.
- **A stop**: a place (code, name), a date, the time it is reached, optionally the time it is left
  (a leave past midnight is the next day), and what happens there: a pickup, a drop-off, the driver's
  own words (up to 40 characters: "Fuel"), or nothing (then it has no door). It is placed among
  dispatch's stops **by its time**, and placed again after every change.
- **A leg** (a timed notes line, for shuttles): its time first, then its words.

Everything added is drawn with a dashed **YOURS** chip, never blended with dispatch's rows. It is the
driver's throughout: an alert quotes its time as *you set 9:40p*. When a later sheet has the same
passenger under the same action (exact name), or more stops of the added key, the add is marked
*agreed* (**CLEAR MINE**). Nothing is merged on its own.

## Several devices, one run

A driver and their helper see the same run. Each change records **who** made it (and from which
device), so the log never reads as one person contradicting themselves. Changes made offline are
queued and sent in order; a change whose answer was lost is recognised by its own id and not stored
twice.

## Limits

At most 300 changes on a run (`MAX_PATCHES`), 12 flights a run (`MAX_FLIGHTS`). A phone number up
to 40 characters, a door 120, a note 500, a notes line 300.
