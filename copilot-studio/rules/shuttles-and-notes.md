# Driver notes, timed lines and shuttle windows

## Driver notes

Dispatch's free text for the run, often several lines, sometimes a whole timed itinerary. Kept
exactly as printed. In the owner's sample, 62 of 179 notes contain a time and 124 lines start with
one.

## Timed lines become a checklist

A line that **starts with a time** is a timed line: `7:45a Load Mail for ALL Sites`. The forms read:
`7:45a`, `7:55am`, `7:45 pm`, 24-hour `14:30`, or bare `6:15`.

- **A bare time** takes the a/p that puts it inside the run's start–end window (6:15 on a
  6:00a–10:00a run is 6:15a); when both do, the one that keeps the lines in printed order; when
  neither does, the one that keeps the order, else the nearer. It is shown with the a/p it was read
  as.
- **A star after the time** (`7:45*`) is dispatch's mark for a time that hangs on something else
  ("or 5 min after Morning Worship concludes"). It stays with the time. **The app never computes a
  starred time.**
- **The line's date:** the run's day that puts it inside the run's window, else the nearest.
- **Which stop it goes under:** the first stop whose leave time (the driver's if they set one, else
  the arrival when there is no leave) is at or after the line's time: the stop that is current at
  that time. Later than every stop: the last one. A stop not happening takes none.
- **Worded as printed.** Nothing is inferred from the words: `8:00a Depart WRK Lobby for HUB` has two
  places and `7:45a Load Mail` none, so a line never becomes a stop on its own.
- **Ticks are the driver's** and per device; the app never ticks a line.
- Lines without a time stay as prose in DRIVER NOTES; SHOW ALL gives back every line as printed.

## Windows (shuttles and duties)

A **window** is a printed stop with **no address and nobody on it**, that is not an airport and not
one the driver added. In the owner's sample, 24 of 503 stops lack an address, and all 24 carry
nobody: shuttles and duties (Dispatch, Office Projects, Floater, Taxi 1, Washing Car).

- Shown as a dashed band with dispatch's code, label and hours ("CLD Shuttle 6:00a – 7:30a"), never
  "Head to CLD Shuttle".
- **Its legs** are the timed lines placed under it, each with a tickbox. Ticked = done.
- **Right now on a window:** a leg holds from its time until the next leg's time or its tick,
  whichever comes first; outside every leg, the next one not ticked. Legs run on across windows
  printed one after another. A window with no legs left says its label and "Until 7:30a".
- The driver corrects, adds and drops legs like any row (`corrections.md`): "+ ADD A LEG", REMOVE
  for their own, NOT HAPPENING with UNDO for dispatch's.
- Real places stay stops, passengers or not.

The run's card names windows by their label ("CLD Shuttle, After Breakfast Shuttle → MGW → NCA"),
with a "2 SHUTTLES" chip and "6 legs in the notes".

## Assistants

The sheet's Assistant / Role / Notes table: a helper or trainer riding along (25% of runs in the
sample). Shown on the run. In the department version they see the run too (`data-model.md`).

## Samples

334184 (a timed itinerary in the notes, under real stops), 339460 (a shuttle with named passenger
rows), 361028 (three windows, Taxi 1, After Breakfast Shuttle and Before Lunch Shuttle, with two
timed lines as legs), 366222 (real places with addresses and nobody on them: stops, not windows; its
notes' times are mid-sentence, so they are prose), 353328 (prose notes in paragraphs, with an e-mail
address in them).
