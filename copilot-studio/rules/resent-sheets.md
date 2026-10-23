# A sheet dispatch sends again

Dispatch re-sends a sheet when a run changes: in the owner's sample, 35 of 186 runs were re-sent, 62
times in all, and 13 of those re-sends changed nothing but the print time. The sheet carries no mark
saying what changed, so Curbside works it out. Built in `worker/src/assignment.ts` (which copy wins)
and `worker/src/changes.ts` (what changed).

## Which copy counts

- **The run's identity is its assignment number, alone.** The same number updates the run in place;
  a different number is a different run. The driver's name is *not* part of it: a helper receives the
  same run under the same number, and both must see one run, not two drifting copies.
- **The newest printed copy wins**, by the print time in the page footer ("Monday, August 31, 2026
  7:18 PM  Page 1 of 1"), **not by the order the copies arrive**. Re-sends do not always arrive in
  order, and the footer is the only reliable clock in the document.
- A copy with no readable footer never replaces one that has one.
- An import is a **whole replace** of dispatch's copy. The driver's changes live apart and are
  applied to the new copy (`corrections.md`).
- What the import says: *New run*; *Updated · Dispatch's newer copy, printed 8:12p · 5 changes*
  (and *your 2 changes carried over*, or in red *1 of your changes needs placing*); *Reprinted ·
  Printed again at 8:14p · nothing changed*; *Already here* (the same print); *Older copy, not used*.
  A sheet that cannot be read says why (`../reading-the-sheet.md`, "Refused").

## What changed, and until when

- **Dispatch's copies only**, raw against raw. The driver's own changes never count as dispatch's.
- **Since the last OK.** The run keeps a *base*: dispatch's copy as of the last time someone on the
  run tapped **OK**, else its first copy. Changes add up across re-sends until someone taps OK; then
  the next change is measured from the OK'd copy. A reprint that changed nothing keeps the base.
  One OK per run, for everyone who sees it.
- **What shows until OK:** *UPDATED* on the run's card (its old start and end struck when they moved),
  and a **WHAT DISPATCH CHANGED** panel: one row per change, by place.
- **What stays after OK, until dispatch's next change:** the old value struck beside the new one, in
  place; *NEW* on a stop, passenger, door or leg; a dashed, struck **NOT ON THE NEW SHEET** ghost for a
  dropped stop, passenger or leg (no undo: it is dispatch's); *MOVED HERE* / *MOVED TO JFK* for a
  passenger dispatch moved.
- **A value the driver set is never struck.** "dispatch planned ~~7:00a – 8:15a~~ 7:30a – 8:45a", and
  the driver's own row with KEEP MINE / USE THE SHEET.
- **No alert for a re-import**, no new colour, no history: "this changed", not a timeline.

## Counting changes (one each)

The vehicle; the parking; a stop's times (ETA, ETD and their dates together); a stop's door, verb,
place or address; a stop added or dropped; a person added, dropped or moved; a person's fact (the
flight: number, printed time and date together; the phone; bags; party size; tag and GB; their note;
an appointment; the route); a leg added, dropped, retimed or reworded; the notes' prose (one). A
person's pickup and drop-off are one change. The run's start and end count only when no stop
changed. A name dispatch prints twice at one door is two rows, paired in printed order.

## Pairing old and new

- **Stops** by a small alignment: the same code (else the same printed place) is required; the same
  date, the passengers both copies hold and a close time score; gaps are free. So a stop inserted
  before another of the same code takes neither's place, and a dropped first stop does not shift the
  rest.
- **Doors** of a paired stop by verb, then their people, then order.
- **People** by exact normalised name, **never fuzzy**.
- **Legs** (timed notes lines): the same words first; then the same words at a new time (retimed);
  then a time only one line on each side has (reworded); the rest are added or dropped.

## Messages after a change

A passenger messaged before the change was told the old plan: they count as *to message again*
(`messages.md`, "After a change").

## Flights after a change

A re-sent sheet that moves a flight's printed time plans its first check again while none has been
made; a flight the new sheet no longer names stops being looked up (`flight-checks.md`).
