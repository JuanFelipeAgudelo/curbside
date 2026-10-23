# Spec: Curbside — the assignment-centric rebuild

Status: **agreed 2026-09-16. Phase 4 next.**
Supersedes the flight-centric framing in [`spec-assignments.md`](spec-assignments.md),
whose Phase 0–3 findings remain the factual basis for everything here.

UX direction, agreed with the owner:
<https://claude.ai/artifact/94T4tbv9egodyxCDW4n3qA>

## Why the reframe

FlightWatch treats a flight as the unit of work and renders a flat list of jobs.
That model **destroys information the driver needs**. In real assignment 369736 a
passenger appears twice — once at the LGA pickup, once at their own Wallkill
drop-off — and the importer discards the second appearance as a duplicate. It
isn't a duplicate. It is the other half of the work.

A driver does not do "a job". They follow a sequence: leave Fishkill 9:30 PM,
collect two people off separate flights at LaGuardia baggage claim, drop one at
A Front and one at B Carport, return by 3:00 AM. **That itinerary is the
product.**

### What the app is actually for

The department's own scheduling already computes a departure time — field #2 of
every assignment. So leave-by is **not** the app's unique contribution; it is a
cross-check. The unique contribution is narrower and sharper:

> Dispatch's 9:30 PM was computed when UA1503 was on time. When the flight
> moves, their number is stale and this app is the only thing that knows.

Everything else in this spec exists to make that sentence legible at 2 AM.

## Data model

Four levels, from the owner's own markup of the assignment sheet:

```
Assignment
├─ number          identity of the RUN, not of one person's copy
├─ start / end     #2 default depart time, #5 back at start location
├─ vehicle         id + make/model — present in 183/186
├─ parking         site code; the three letters say where the day starts
├─ driver
├─ assistants[]    name + role + note — present in 48/186 (25%)
├─ driverNotes     free text, often multi-line, sometimes a timed itinerary
└─ steps[]
   ├─ site code, place, address
   ├─ eta / etd    blank eta = first step, blank etd = last
   └─ actions[]
      ├─ verb      Pickup / Drop-off / others exist — do not assume a closed set
      ├─ where     "Baggage Claim", "A Front", "B Carport"
      └─ entities[]
         ├─ passenger, bags
         ├─ origin / destination (the row's own cells — authoritative)
         └─ info    flight, appointment time, route, or other
```

### Rules that are easy to get wrong

**Identity is the assignment number alone.** The helper receives the same
assignment under the same number, so `driver` is *not* part of identity. Two
people on one run should converge on one record, never two drifting copies.

**A passenger row is printed once per step it participates in.** Deduping across
steps is wrong. Dedupe only within a step.

**The row's Origin/Destination cells beat the enclosing stop.** A row appears
under both the pickup and drop-off stop, so the stop it sits under is only right
half the time.

**`(Unavailable)` rows are the driver's own calendar**, not trips.

**A combo has two clocks, not one.** Multiple entities under one action are
collected together, but they do not constrain the same thing:

- **When the driver must BE there** is set by the **earliest** arrival. The
  driver is on site before the first plane touches down — never after, and
  without subtracting the deplane allowance. That allowance is a maximum, not a
  guarantee: a passenger with only a carry-on can reach the kerb in ten minutes.
  And the driver's own routine — call the passenger on reaching the airport,
  again until they are in the car — cannot be run from the road.
- **When the driver may LEAVE** is set by the **latest** arrival, plus its
  deplane allowance (45m domestic, 60m international).

Generalised across step types: **be there for the earliest obligation, leave
after the latest one.** A drop-off's obligation is its check-in deadline
(departure − 2h domestic, − 3h international); a pickup's is its touchdown. One
sentence covers arrivals, departures, and the mixed steps where a driver sets
one party down and collects another at the same airport.

Both roles are read from **current estimated** times, not scheduled, and can
swap mid-run: delay the earlier flight past the later one and the two rows
trade jobs.

The failure is asymmetric, which is why the rule is worth stating. Anchor both
clocks on the latest arrival and the driver is *late*; anchor both on the
earliest and the driver is *early*. Early costs a wait in the car park. Late
means a passenger lands to no driver and no call. In 369736, with WN748 slipped
to 11:52 PM, the wrong rule puts the driver at LaGuardia at 11:37 PM —
**28 minutes after UA1503 was already on the ground**.

The document neither confirms nor contradicts this at schedule: dispatch's LGA
ETA of 11:00 PM sits ahead of both scheduled landings, so the rules only
diverge once a flight moves. This is the owner's rule, from how the work
actually runs.

**Origin matters for drive time.** The start is Warwick 107 times and Fishkill 37
in the sample, and Warwick→EWR is 75 minutes where Fishkill→EWR is 90.

**The document's own leg is the drive time. The table is only ever a
suggestion.** The owner's rule, stated plainly: *always do what the PDF says; if
we don't understand the PDF, the driver inputs manually, and we suggest the time
we learned from the table.* So:

1. **The assignment's own ETD-to-ETA gap.** Dispatch's plan for this run. Used,
   full stop, with nothing consulted and nothing compared.
2. **No usable leg in the document** → the field is **empty and the driver fills
   it**, with the department's table offered as a pre-filled suggestion, labelled
   as coming from the table rather than from this assignment.
3. **Not in the table either** → empty, and the driver says. Never a guess.

Note what step 2 is *not*: the table is *not* silently substituted for a number
the document failed to provide. A table value that lands in the record without
anyone looking at it is indistinguishable, a week later, from a value dispatch
actually specified — and it is the app deciding, which is the line drawn in
*Who owns a change* below. A suggestion the driver accepts is the driver's
number. A suggestion the app applies on its own is the app's.

## Who owns a change

**The app is a converter for dispatch's PDF, not a planner.** The owner's line,
and it settles a class of question rather than one question. Two owners, and
the app must never blur them:

- **Dispatch owns the assignment** — the steps, the doors, the passengers, the
  times. The app never edits these and never proposes an alternative to them. A
  change to the run arrives the only way it can: the driver uploads the new PDF.
- **The world owns the flights** — delays, gates, terminals, belts. The app
  tracks these, because that is the whole reason it exists, and shows what they
  imply.

The visible consequence is how a moved time is drawn, and it differs by owner:

- Dispatch moved it (a re-import): **strike the old time, show the new one.**
  Dispatch's new number replaces dispatch's old number, and an `UPDATED` chip
  marks the card until someone on the list says OK (see *What changed*).
- A flight is late: **dispatch's time stays on the step.** The delay is reported
  underneath as a consequence — *running ~37m late, WN748* — attributed to the
  flight that caused it. The app does not restate the plan in its own numbers.
  The stop does stay *the stop* (current, and Right Now) until the later of its
  leave time and the flight clock's LEAVING (the owner, 2026-09-25): that is
  where the driver is, not a new plan. Times compare with their dates, so a
  stop that crosses midnight reads ~26m late, not 1466m.

The two-clock figures (`PARKED AT`, `CLEAR`) do not break this rule, because
each one is shown *beside dispatch's own number for the same thing*, labelled
with where it came from. Two numbers with their sources is reporting. One
number that has quietly replaced dispatch's is deciding.

This is a Phase-6 constraint, not a permanent one — the owner's "not a decision
taker **yet**". Anything that would re-plan a run is deferred until it is asked
for explicitly.

**The line is who decides, not whether anything changes** (the owner,
2026-09-23: *"'the app never changes them' means the app doesn't make any
unasked-for decisions. But if the driver needs to edit, that's fine."*). The
APP never alters, re-plans or substitutes on its own. The DRIVER may edit what
they need to — correct a value, add or remove a stop or a passenger — and the
app records it as the driver's, visibly, with dispatch's original kept so the
two stay distinguishable. Step times too (the owner, 2026-09-23: "as mine
beside theirs"): the driver's time runs the clocks, and dispatch's stays on
screen beside it, in plain type — see *Corrections*.

## Updates and edits

Re-sends replace the whole record, and dispatch's sheet carries no diff marker
(Phase 0): the server works out what changed itself (*What changed*). So:

- **Identity is the assignment number.** The same number updates the assignment
  in place; a different number is a new assignment. The owner's rule, and the
  document's own: the helper receives the same run under the same number, so
  `driver` is not part of identity.
- Imports are **whole-record replace**, latest wins by the page-footer
  timestamp — **not** by the order copies arrive. Re-sends do not always reach
  the driver in order, and the footer is the only reliable clock in the
  document.
- Manual edits live in an **ordered patch log**, reapplied after each import —
  never merged into the record. Without this, a new email silently eats a
  driver's correction.
- That patch log **is the undo stack**. Undo removes one patch by its id, and
  every copy with the same `ref` goes with it (a replayed send can store two).
  The old pop-the-last route (`/patches/undo`) was retired 2026-09-26.
- On update, show *what changed* in place (old time struck beside the new one)
  and an `UPDATED` chip on the list card. **Not** version history — the owner
  asked for "this changed", not a timeline. Built 2026-09-30: *What changed*.

## What changed (a re-sent sheet, built 2026-09-30, v61)

Dispatch re-sends a sheet when a run changes: 35 of the owner's 186 runs, 62
re-sends, 13 of which changed nothing but the print time (count-only corpus
script). Decided by the owner 2026-09-30 on a mock
(https://claude.ai/artifact/Snceh4WTrZKg4nJtcDd5CM); built in
`worker/src/changes.ts` and the "what dispatch changed" section of
`public/assignments.js`.

- **Dispatch's copies only.** Marks compare dispatch's stored copies, raw against
  raw. The driver's corrections never count as dispatch's changes: GET diffs the
  stored copy before the patch log is applied to it.
- **Since the list's last OK.** The stored record keeps `base`: dispatch's copy
  as of the list's last OK, else its first copy (only the fields a driver can
  see; never served). Changes add up across re-sends until someone on the list
  taps OK; after an OK, dispatch's next change is measured from the OK'd copy. A
  reprint that changed nothing keeps the base, and the OK carries over to it.
  One OK per run for the whole list (every phone on the code), kept in the
  list's record (`seen`: run number → the print OK'd) and never written into the
  run: KV reads can lag a write made elsewhere, and writing a run back could put
  an older copy over a newer one another phone had just imported. A lost race
  only brings a panel back.
- **What shows.** Until OK: `UPDATED` on the list card, with the run's old start
  and end struck when they moved, and **WHAT DISPATCH CHANGED** under RIGHT NOW
  and the route: one row per change, by place (VEHICLE, the stop's code, a
  person's stops), with OK. In place, and staying after OK until dispatch's next
  change: the old value struck under or beside the new (a stop's times under its
  head; the vehicle and parking under the pill; a door, a verb, a flight number,
  a phone, a tag beside theirs; a flight's printed time on its status line; BAGS
  in its slot; a retimed leg's time under the rail time); `NEW` on a stop, a
  passenger, a door or a leg; a dashed, struck ghost **NOT ON THE NEW SHEET**,
  with no UNDO (it is dispatch's), for a dropped stop (in the rail where it was),
  passenger (in the door they were in) or leg (among the legs, by its time); a
  passenger dispatch moved says `MOVED HERE` and "was at EWR" at the new stop,
  with a ghost MOVED TO JFK at the old (Claude's choice, not in the mock). New
  prose in the notes is marked NEW and dropped prose struck, in DRIVER NOTES. No
  new colour (the strike is dispatch moving it; the chips are neutral ink), no
  push for a re-import, no history.
- **The driver's own values.** A value the driver set is never struck: "dispatch
  planned ~~7:00a – 8:15a~~ 7:30a – 8:45a", and the existing contest row (KEEP
  MINE / USE THE SHEET) stays, its times read 7:30a like every time on screen.
  The panel's row says where theirs stands ("You set arrive 7:10a: yours stands
  until you choose.", "What you had set.", "You had marked them not coming.").
  The driver's removal of a row dispatch then dropped is also THE SHEET AGREES,
  and a value dispatch now agrees with is CLEAR MY EDIT, as before.
- **Counting**, one each; a person's pickup and drop-off are one change: the
  vehicle; the parking; a stop's times (ETA, ETD and their dates together); a
  stop's door, verb, place or address; a stop added or dropped; a person added,
  dropped or moved; a person's fact (the flight: its number, printed time and
  date together; the phone; bags; party size; tag and GB; their note; an
  appointment; the route); a leg added, dropped, retimed or reworded; the prose
  notes (one). The run's start and end follow its stops, so they count only when
  no stop changed. A name dispatch prints twice at one door is two rows, paired
  in the printed order (v66.1: a reprint of such a sheet used to read as that
  person moved).
- **Pairing.** Stops by a small alignment: the same code (else the same printed
  place) is required; the same date, each passenger both hold and a close time
  score; gaps are free. So a stop inserted before another of the same code takes
  neither's place, and a dropped opening stop does not shift the rest. The doors
  of a paired stop by verb, their people, then order; people by exact
  normalised name (nameKey), never fuzzy. Legs: the same words first, then the
  same words at a new time (retimed), then a time only one line on each side
  has (reworded); the rest are added or dropped.
- **The import line.** "Updated · Dispatch's newer copy, printed 8:12p · 5
  changes" (counted since the list's last OK: what the panel shows), then "your N
  changes carried over" as before. A count of 0 (dispatch changed it back): "the
  same as the one printed 5:04p". A newer print that changed nothing:
  "Reprinted · Printed again at 8:14p · nothing changed" (the phone's own
  "Already here" is the same print).
- **Cost.** An import is still 1 get + 1 put (the base rides inside the record);
  it answers `same: true`, or `changes` and `since`. GET: no extra KV operation.
  OK: POST /api/assignments/seen {number, printedAt}, 2 gets + 1 write, 409
  unless it names the stored print; on the phone at once, and through the outbox
  (op `seen`, held in the sent ledger until GET shows it). Checked against every
  re-send in the corpus, counts only: 13 of 62 pairs count 0, the rest match the
  corpus analysis, and every address resolves to a row.

## UX direction

Four data levels, **two screens**. Nesting is shown with a rail and indentation
on one scrolling page, never with navigation.

| Decision | Resolution |
|---|---|
| Screens | Two, plus one sheet. The sheet may only ever hold **live flight data for one entity** — history, terminal, gate, belt. Anything else goes on the itinerary. |
| Headline | **Right Now** once an assignment starts; leave-by before it does. |
| Depth | Managed by **time, not taps**. Past steps collapse to a dim line, current is open, future are compact. |
| Past steps | Reopenable by tap — **one at a time**, and the current step never collapses. |
| Density | **Removed** (the owner, 2026-09-25; built 2026-09-26): one layout. The board/card toggle only ever styled the old flight list, and went with it, along with its Settings rows for per-airport drive time and buffer, which fed only that list: Curbside takes the drive time from dispatch's own leg and the buffer from HuB (15/30). |
| Accent | **One meaning per colour** (the owner, 2026-09-26; replaces "one brass thing per screen"): see *The look* below. If a colour means two things, it means neither. |
| Editing | **No edit mode.** Dashed affordances where a thing would go; tap any value to change it. |
| Undo | **In place and never expiring** — a removed step leaves a ghost row. No toast: five seconds to react at 2 AM is a promise the app cannot keep. |

### Messaging passengers — two surfaces, no lecture

The phone number is operational data, not a nicety. The driver has to reach
every passenger the evening before, and again from the kerb until they are in
the car. A number that has to be retyped out of a PDF is a number nobody uses.

**Messages, not calls** (the owner, 2026-09-28/29, built 2026-09-29; mock:
https://claude.ai/artifact/EJ3QHAm7xB4LqYohWF35MD). Drivers reach passengers by
WhatsApp, else Messages; Teams can't be opened from a phone number. So every
number has **WHATSAPP** (primary) and **TEXT**, and no call button anywhere: the
number is shown, not dialled.

- **The driver's own message, one per kind of trip**, picked by the tag on
  dispatch's row: Departures (D, GBD), Arrivals (A, GBA), Medical (MED), Shuttle
  (S), Everything else (HO, TD, no tag). Written in Settings → MESSAGES in their
  own words, with fields in brackets, inserted by buttons: `[NAME]`,
  `[LAST NAME]`, `[FROM]`, `[TO]`, `[DOOR]`, `[FLIGHT]` (flights), `[APPOINTMENT]`
  (medical), `[TIME]`, `[DAY]`, `[MY NAME]` (a Settings field). The defaults are
  the owner's own message. A preview fills it for real passengers of that kind
  on the list. Kept on this device (`fw_messages`, `fw_my_name`), like theme.
- **The fields, as the owner decided:** `[TIME]` is the passenger's own pickup,
  not the run's start: dispatch's time at the door, or for an arrival the
  landing, live once the flight is tracked and printed before. `[FROM]`/`[TO]`
  are the places a passenger knows: an airport's code (JFK), else the site dispatch
  printed (Warwick, Fishkill, Patterson). They were the door until v62; the owner
  (2026-09-30): "Main Lobby" says nothing about which one. `[DOOR]` is the pickup's
  door as printed ("A-res WRK", "Baggage Claim"), the place when the door is blank;
  the defaults say "I'll meet you outside [DOOR]", and a message a driver wrote with
  "outside [FROM]" became "outside [DOOR]" once, on crossing into v62
  (`fw_messages_door`), nothing else in it touched. `[NAME]` is "Family Castillo" for a
  row of two or more; a single is Brother, Sister or the name alone, which the
  app cannot know and never guesses: it asks the first time a draft needs it
  (three buttons in the row) and remembers per device (`fw_greet`).
- **A field with nothing to fill stays in brackets** (`[FLIGHT]` when the sheet
  has no flight): the driver sees it in the draft before sending. The editor's
  preview shows it red.
- **The evening before, a draft; on the day of the run, an empty chat** (the
  owner, 2026-09-29): the message says "see you tomorrow", and at the kerb the
  driver writes their own.
- **The app never sends.** WhatsApp (`wa.me/<number>?text=`) or Messages
  (`sms:<number>?&body=`) opens with the draft; the driver edits and sends. The
  number for WhatsApp needs its country: a US 10-digit number gets its 1, "+"
  and "00" say it themselves, anything else gets TEXT only and a line saying why.
- **The tick stays the driver's** (the owner, 2026-09-29): the app can't see a
  message sent, and a draft opened but never sent must not read as done.

**The evening list.** *MESSAGES FOR TUE 29 SEP · 4 LEFT* on the list. Each row
is a passenger, their pickup time and place, the number and its two buttons,
ticked off as you go (MESSAGED 7:02p); a party's other numbers get a smaller
pair each. Passengers with **no number on file** are flagged rather than
absent, because 61 of 411 entities in the sample have none (29 of them have a
`Phone:` label printed with nothing after it) and those are exactly the ones
that otherwise slip through. It opens on the first day with a run that has not
started yet — tomorrow's at 5 PM after a morning run, still today's before an
evening one — and ‹ › step through the days that have runs (the owner,
2026-09-26).

**From the itinerary row.** The same number and buttons, at the kerb. Since v68 they
are compact and on the number's own line, *WA* and *TEXT*, the word alone; see "One
menu a row".

**No reminder text.** The app does not explain the deadline or restate the
rule; the driver knows their own job. The list is the feature. Explaining it
would be the app talking down to someone who has done this a thousand times —
the same reason the GB rules strip was cut.

### Right Now belongs to the list, not the assignment

Assignments can overlap. Two cards both claiming `IN PROGRESS` is exactly the
confusion this design exists to avoid, so **Right Now is one band at the top of
the home screen** — the single next thing across everything. An open assignment
shows its own current step in its own header, with no competition.

### On the dash: live, fresh, reachable (built 2026-09-26, audit P1)

- **Right Now names the next clock.** Its second line is *Parked by 10:54p · before
  WN748 lands* until that time passes, then *Leaving ~12:26a · UA1503 11:41p + 45m
  bags*. Both are ours, each with its reason; the `~` marks an estimate, and dispatch's
  own time stays in the step's clock block. A departure has no leaving clock, so
  parked-by stays. With no flight clock the line is dispatch's time, said as dispatch's.
- **How old the flights are.** Under the band: *Flights checked 12m ago*, from the
  newest `fetchedAt` among the run's flights (passengers not coming left out). Hidden
  when none has been checked, because the rows already say "as printed".
- **A screen left open keeps moving.** Every minute, while the page is visible, the
  open screen is repainted from what the app holds, at no cost: Right Now,
  done/current, the clocks. A past step the driver opened stays open, the scroll stays,
  and nothing repaints while a field in the page has focus. The runs are loaded again
  when the list's stamp says something changed: see "Staying in sync".
- **Back walks the app.** The phone's back button or swipe closes an open sheet, then
  goes from a run or the call list to the list. Each layer adds one history entry when
  it opens, and closing it in the app removes that entry, so one press is always one
  step and a refresh adds nothing. The app only ever pops entries it made itself, so
  it cannot send the driver out of the app.
- **44px targets.** Small controls keep their look and get an invisible 44px box
  centred on them. Where two boxes meet, the later control wins, and the phone number
  wins every overlap. Since the design pass, spacing keeps the boxes apart (the number's
  fixes sit 20px under it, *+ ADD PASSENGER* has its own margins) and a timed note line is
  a 44px row that ticks from anywhere on it: 200 controls measured at 44 or more.
  The second audit (2026-10-04, v66.3) measured every screen added since, at 375 and
  360px, in each theme, and brought the late-comers under the rule: the segmented
  buttons (theme, finished runs, the greeting, what Maps gets), the greeting chip, the
  route's move and leave-out buttons and its place rows, the check rows, the message
  editor's fields and arrows, the guide's and the testers' page's chips and links. A
  stop whose address wraps puts its times 9px over the door: their two boxes lean
  apart (times up, door down) instead of meeting. Left as measured: the testers'
  tour dots (28px wide, eleven in a row; BACK and NEXT are full size). A stop already
  left (v67): closed, its head is the one tap, 44px of it (the heads sat 31px apart),
  and its times are words; open, they are the button again, and opening moves nothing.
  v68: the card's three dots, *WA*, *TEXT* and *CHANGE THIS STOP* are each a real 44px
  box (measured at 375 and 360, uncovered edge to edge); the fixes under the number and
  *+ ADD PASSENGER* are gone, so nothing leans on their margins any more.
- **The screen stays on during a run** (design pass): a screen wake lock while the
  itinerary of a run in progress is visible, asked for again when the app comes back to
  the foreground, let go when the driver leaves the run or it ends.
- **Launch opens the run in progress**, once per launch; back leads to the list.

### One menu a row (the owner, 2026-10-04; built v68)

The card was busy and the page had a control for every change on every row: 48 on
a three-stop run, 116 on a shuttle with 14 passengers (the audit's count). The owner
picked, from a mock (https://claude.ai/artifact/UUSKHD9u58NWEJ3jY1zu3i): card A,
compact; one menu per passenger; one menu per stop.

- **The card.** Three dots end the name line (a real 44px button that hangs into the
  card's padding, so the line keeps its height). *WA* and *TEXT* sit on the number's
  line, 44px each, the word alone; *MESSAGED 7:02p* is under the number. FIX, NOT
  COMING and the greeting chip are off the card. The call list is unchanged: the
  full-width WHATSAPP and TEXT, and its chip.
- **The number's line has to fit, and the mock's did not.** The card is 239px wide
  inside on a 375px phone and 224 on a 360 (the mock drew 259). Of 605 printed numbers
  in the sample 76% are 15 characters, 135px at 15px mono, and the pair with its gap
  takes 104. So the buttons carry no icon, and the number steps from 15px (390 and
  wider) through 14 (375) to 13 (360): the 15-character number holds the line on each.
  A longer number, or an old one struck beside it, drops the pair under the number
  (flex-wrap) rather than squeeze it.
- **The driver's own number** carried its dot on FIX. The dot is on the number now,
  hung in the gap after it so it takes no width; hollow until it is sent.
- **The passenger's menu** (a full-screen sheet of rows, like Settings, titled with the
  name): *Fix phone* (*Add phone* when none is printed); *Fix flight* (*Add flight*),
  only on a row whose card has a flight to tap; *Greeting*, Brother / Sister / Name
  only answered in the row itself, for a single with a number (a family is never
  asked; the first WA or TEXT still asks on the card when it has not been answered);
  and, set apart and last, *Not coming*.
- **The stop's menu**, from *CHANGE THIS STOP* across the stop's foot: *Add a
  passenger* once for each pickup and drop-off, *Fix the time* where the stop shows
  one, *Fix the door* once for each door, and *Stop not happening*, apart. *+ ADD
  PASSENGER* and *STOP NOT HAPPENING* are off the page. A shuttle's foot keeps
  *+ ADD A LEG* and *NOT HAPPENING* (v69 reworks it).
- **A second way in, never the only one for a value on screen.** No edit mode: the
  flight, the door and the times are still fixed by tapping them, and their rows say
  so ("you can also tap the door"). A row opens the very correction the value's own
  button opens (one spec, built once), the same add, or queues the same remove.
  Nothing sent or stored changed.
- **Not red.** The mock drew *Not coming* in red; red means a problem. The row is
  ink, in a group of its own. A row that opens a sheet has a chevron; one that acts
  at once has none. No confirm: the ghost's UNDO on the page is the safety.
- **A row the driver added** reads *Remove* in its menu and *REMOVED* as a ghost:
  the same remove, with its UNDO. (A leg the driver added is deleted outright by its
  REMOVE; whether a passenger's should be is open for v69.)
- **The menu keeps the copy it was opened on.** If dispatch re-sends the run while a
  menu is open, a row tapped after that still names the copy its address points
  into, and the server refuses it (409, "a change I could not place") instead of
  aiming it at whatever row sits there now. The edit sheet's own rule, one step
  earlier.
- **One tap further, on purpose.** A no-show at the kerb is two taps now. It is rare;
  the clutter was on every row every day.
- The message that a number has no country code says where the fix is: "add it under
  ••• Fix phone" on the card, "on the run, under ••• Fix phone" on the call list.

### The look (Claude Design pass, built 2026-09-26)

Claude Design proposed five switchable looks; the owner chose **one, "Polish"**: the
original navy and brass, Instrument Sans for text, IBM Plex Mono **for numbers only**,
rounded (14px cards and Right Now, 12px strips, 10px buttons, 4–6px chips).

**Colour grammar**: one meaning per colour.

| Colour | Means | Never |
|---|---|---|
| Brass | You are here: Right Now, the current stop's ring, the in-progress card, the clock being worked to | buttons, labels, GB, focus |
| Blue (`--moved`) | A flight time 5 min or more off schedule, shown with the schedule beside it | problems |
| Red (`--alert-text`) | A problem: a computed time after dispatch's, no number printed, *to check*, flight checks paused (the free plan's month used up) | a flight that merely landed; the passenger who sets a clock |
| Green (`--ok`) | Done, called, live data, the dial icon | |
| Violet (`--gb`) | Governing Body: plate, 6px card edge, 4px strip atop the itinerary | anything else |
| Ink / ink-2 | Everything else, including a passed clock (grey, ticked) | |

The passenger who sets a clock gets a neutral chip naming it: *Sets Leaving*, *Sets
Parked by*.

**Themes**: night (default), day, and **late** (Auto only, 11p–5a: near-black, dimmer
ink, Right Now an outline). Auto follows the phone's own light or dark
mode (`prefers-color-scheme`; the owner, v62.2: "some like having night time during the
day and vice versa"), and dark from 11p to 5a is the late theme. It was 6:30a–7:30p all
year, then briefly (v62.1) sunrise to sunset. The theme is set by a script in `<head>`
before the first paint, so a 2 AM launch never flashes; that script's `curbsideTheme()`
is the one rule, app.js calls it, and the clock tick re-reads it every second, so a phone
switching modes switches the app.

**The stop head (v62.1, audit #16):** the rail shows a stop's first time (ETA, else ETD),
so the head no longer repeats it: "until 10:00a" when the stop has an end, else what the
rail's time is (ARRIVE, LEAVE, ARRIVE & LEAVE). It is still the button that corrects the
times. **SWITCH** (Settings, another list's code) is a field under the row, not a
browser pop-up. Tokens live in
`public/index.html` `:root`, `[data-theme="day"]`, `[data-theme="late"]`. Right Now: at
night a 10% brass wash with a brass outline, by day a brass fill with ink, late an
outline only. Every text/background pair measured ≥ 4.5:1 in all three themes.

**Type**: caps labels are the sans at **11px, the floor** (700, +0.06–0.08em); sentences
12.5px or more. Names 17/600, the current stop's code 26/700 (other stops 17), Right Now's
title 21/600, flight values (TERM/GATE/BELT/BAGS) 17 mono, the phone 15 mono, a clock 20
mono, meta 12.5–14.

**Time**: one format everywhere, `h:mm` + `a`/`p`: *9:30p*, *12:26a*, the header clock
too; ranges with an en dash, *9:30p – 3:00a*. A delay is said in words beside dispatch's
number: *Leaving ~26m after dispatch's 12:00a*.

**Identity**: the icon is a brass curb with the pickup point above its left third, full
bleed on navy (maskable). The wordmark is lowercase *curbside* after a 16×4 brass curb.

**Parked until after real use** (the owner, 2026-09-26): the one-row header, the NOW
strip with one big number and the clocks side by side, grouping passengers by flight, the list's next-up card with a mini
route and a *late* line, the calls rows redesign, the pinned band, motion, and two new
app numbers: a knock-on *~1:56a* on later stops and an *in 56m / leave now* countdown.
Compact drop-off rows are **not approved**: TERM / GATE / BELT / BAGS stay on every
flight. The ⋯ row menu left this list on 2026-10-04: built as v68, "One menu a row".

### Progress: Automatic / Confirm / Manual

| Mode | Advances on the clock | Asks first |
|---|---|---|
| **Automatic** (default) | yes | no |
| **Confirm** | yes | yes |
| **Manual** | no | — |

Correction by tapping the rail dot exists in **all three**; the setting only
governs whether the app advances without you. Confirm is **never a modal** — the
Right Now band grows a non-blocking "Still at LGA? · Yes / Moved on" row.

Default is Automatic because a driver who never opens settings still gets a
working headline, and its failure mode is mild: wrong step, one tap to fix.
Manual's failure mode is worse — the headline silently does nothing until you
discover you were meant to be tapping.

Progress state and this setting are **per-device** (`localStorage`), for the same
reason the theme is: two people on one list code must not fight over
whose progress is real.

## Archive and retention

Two mechanisms, deliberately separate:

- **Archive** 10 hours after a run completes. It leaves the home screen but stays
  readable behind an Archive control, still grouped by day. Ten hours means a
  3 AM finish is still on screen when you wake up.
- **Delete** after a user-chosen window: **2 / 7 / 14 / 30 days, default 7.**
  Long enough to check what happened last Tuesday, short enough that passenger
  names, mobile numbers and named hospitals are not sitting around for a month
  by default.

This is the retention answer the privacy section of `spec-assignments.md` asked
for. One cron rule now; a conversation nobody wants later.

**As built (2026-09-25).** "Ends" is the run's printed `end`, on the home wall
clock (New York). Archive is a view only: the home screen keeps a finished run
for 10 hours, then an ARCHIVE control holds it, grouped by day, newest first.
Retention is a list setting (`retentionDays`, Settings > Finished runs), since
the data it deletes is the list's. Cron sweeps once a day, in the 08:00 UTC
tick, and a deletion takes the run's corrections and flight trackers with it,
exactly as DELETE does. A run that cannot be dated is kept: deleting on a
guess is the one mistake with no undo. The sweep costs one KV list per
thousand runs; each run's `end` rides in its key's metadata. Each run it
removes costs two more lists (the list's corrections, read once to apply
and to delete; the list's other runs, so a flight one of them still meets
stays tracked), a delete per correction, one for the run and up to five per
flight nobody else meets. Corrections go before the run: a quota trip
between the two leaves a finished run uncorrected until the next sweep,
never corrections waiting for a recycled number (the owner, 2026-09-26).

**Removed from this phone (the owner, 2026-09-30; built 2026-10-01, v63).** "Drivers
need to be able to delete assignments." Decided: only this phone, an UNDO that lasts
until the run's normal clean-up, the button at the foot of the run's page. So nothing
is sent: `fw_hidden` (`"<list>:<number>": {at, printedAt}`, per device) names the runs,
and a hidden run is taken out of what every screen reads (the list, MESSAGES, IN
PROGRESS, open-to-now, the wake lock, the route). The list draws a ghost where its
card was, dashed and struck like a row that is not happening, with UNDO; it moves to
EARLIER and ARCHIVE with time, and its entry is dropped once a load no longer returns
the run (not within an hour of hiding: a run just imported can be missing from GET).
No question is asked on the way out; the UNDO is the answer. Importing the run's sheet
on this phone brings it back, the driver's own act. A newer print from dispatch,
imported on another phone, stays hidden and the ghost says so: the app reports, it
does not decide. Pushes go to the list's topic, so a hidden run's flight alerts still
arrive; removing a run for every phone is DELETE /api/assignments, which exists and has
no button.

## Staying in sync (the owner, 2026-09-30; built 2026-10-01, v63)

A change made elsewhere (another phone's import or correction, a flight check)
shows within a minute or two, not at the next ten-minute reload. What made that
affordable: Cloudflare requests and KV reads are plentiful (100,000 a day each), KV
lists are not (1,000; a full GET costs 2).

- **The stamp.** `stamp:<list>` holds a fresh value (time + random). Every write GET
  would show puts a new one, blind (no read, nothing to race): an import that was
  applied, a run removed, a correction made or taken back, a place, an airline,
  settings, an OK that wrote, the retention sweep (per list that lost a run), and cron
  each time it stores a flight's status (per list tracking it; a check that found
  nothing moved still changes "Flights checked ..."). A write that changed nothing puts
  none. A stamp that cannot be written never fails the write it follows.
- **GET /api/stamp** answers `{ stamp }` for one KV read: no list, and no look at the
  list record, so an unknown code and a list never written to both answer null (no
  existence oracle). GET /api/assignments carries the same `stamp` (+1 read, still 2
  lists). Both read it with `cacheTtl: 30`, the shortest KV allows.
- **The phone**, every minute while visible with a list code and no field in focus:
  asks for the stamp; if it is not the one its copy came with, loads the runs, and
  loads once more the minute after (KV's listings can trail a write by 20 seconds or
  more, so the first load may not hold the change). A failed ask is silent. A phone
  showing "No signal" loads as soon as the stamp answers. This replaced the
  ten-minute reload while a run was live.
- **Costs.** Each write path +1 put (1,000 a day account-wide). A change seen by a
  phone costs 4 lists (two loads). An idle open phone costs 60 reads an hour.

## Messages after a change (the owner, 2026-09-30; built 2026-10-01, v63)

Sheets land around 5 PM, the driver messages passengers that evening, and re-sends
come the same evening (35 of 186 corpus runs, often with new times). A passenger
messaged before the change was told the old plan.

- **The tick keeps what was said.** `fw_called` values are `{ at, said }`, where `said`
  is the plan at the tick: time, door, from, to, flight, appointment, day, phone. The
  plan only: dispatch's sheet with the driver's corrections, never a live flight
  estimate (an arrival's time is the printed one). A tick from before v63 (a plain
  date) is ticked and never flagged.
- **Changed since** = the plan now differs from `said` in any field. That covers a
  re-sent sheet and the driver's own correction alike; a flight running late never
  flags. A flight filled in on a row that had none is not a change.
- **They count as left again** (the owner): the list bar and the MESSAGES header count
  them, the row is not ticked, and says in red (a problem, the driver's to fix)
  "MESSAGED 6:12p · CHANGED SINCE" and "Changed since your message: time 7:30a (was
  7:00a) · door ...". Ticking again keeps the new plan as said.
- **The draft starts "Update:"** on its own line (the owner), then the driver's normal
  message with the new details. On the run's day the chat still opens empty.
- **NEW in the call list:** a passenger a re-sent sheet added, or moved to this
  pickup, carries the NEW chip until ticked.

## Offline is a data-layer constraint, not a polish item

The driver is standing in an LGA baggage hall at 11 PM. Airport garages and
terminals eat signal. A flight tracker degrades gracefully offline — it just
stops updating. **An assignment companion that cannot show the next stop is
useless at exactly the moment it matters most.**

So: the full assignment must be readable offline, and step taps and edits must be
**queued**, not dropped. This lands before the UI, not after.

## Phases

Revised 2026-09-17, after Phase 4 and a day of testing against real assignments.
What changed and why is recorded below the table, because the reasons matter
more than the order.

| Phase | What | Status |
|---|---|---|
| **4** | Redacted fixtures + parser regression suite | **done** — 15 fixtures, 44 tests |
| **5** | Assignment model and storage. Identity is the assignment number; the same number replaces, a new number is a new assignment | **done** |
| **6** | Assignments list + itinerary UI, including the GB marking and Right&nbsp;Now | **done** — plus the call list |
| **7** | Manual create and edit of steps and children, with undo and the edit overlay | **correction half done** — see below; creating steps/passengers still open |
| **8** | Offline: the full assignment readable, step taps and edits queued | **done** — see *Offline* below |
| **9** | Notification rewrite — verb first, early arrivals urgent | **done** — see *Notifications* below |
| **10** | Archive at 10h, delete at the chosen retention | **done** 2026-09-25 |
| **11** | Notes timeline — the 124 timed lines | **done** 2026-09-25 — see *Driver notes* below |
| **12** | `TD` and `HO` support, retiring the exclusion | |
| scale | Auth, then self-serve upload, then a dispatch view | gate on a second user |

Phases 5–8 give a personal app worth using every day. 9–12 are additions, each
safe to do alone. The scale row is what stands between that and other drivers.

### Five changes from the first plan

**Update-on-same-number moved from Phase 9 into Phase 5.** It was listed as a
later refinement. It is not — it is a property of *storage identity*, and
without it the app fills with duplicates from the first week, because re-sends
are routine. What genuinely belongs later is the *visible* "this changed" diff,
which needs the edit overlay to exist first.

**Self-serve upload moved out of the numbered phases entirely.** Porting the
parser to JavaScript is the single biggest chunk of work in this plan, and it
buys nothing for one driver: handing PDFs over in a session already works. It is
a scaling feature, so it now sits in the scale row behind auth.

**Offline is promoted to a phase of its own.** It was written down as a
"data-layer constraint", which is a good way for something to never get built.
The driver is in an LGA baggage hall with one bar; an assignment app that cannot
show the next stop is useless exactly then.

**The notification rewrite is new.** It was designed and then not planned. It is
independent of everything else and cheap, so it can be pulled forward whenever —
and it is the only screen read *without opening the app*.

**Archive, retention and `TD`/`HO` are now listed.** All three were agreed and
then lived only in prose. `TD`/`HO` became cheaper once an all-excluded
assignment stopped vanishing: the shape is already on screen, so supporting the
rows is an addition rather than a rescue.

### What Phase 5 carries that the first plan did not

Real data added five fields the original model had nowhere to put:

- **vehicle** — id and make/model, in 183 of 186 assignments
- **parking site** — the three-letter prefix, which is where the day starts
- **assistants** — name, role and note, in 48 of 186 (Helper 13, Trainer 10)
- **per-passenger notes** — 76 of them, and they change the work
  (*"I will be bringing a small cart with me"*, *"Cell is WhatsApp#"*)
- **party grouping** — half the passenger groups are parties, not individuals

Plus a **GB flag**, since `GBA`/`GBD` is 20% of passenger rows and changes both
the marking and the combining rules.

Drive time no longer needs a table lookup at import: the gap between one stop's
ETD and the next stop's ETA is dispatch's own planned leg, and 209 of 209 flight
jobs take it from the document. The derived table survives only for jobs typed
in by hand.

## Corrections (Phase 7, first half)

A driver taps a value and corrects it: an unresolved flight number, a missing
phone, a blank door. Adding and removing stops and passengers is the second
half, below.

- **Never written into the record.** Each correction is its own KV key,
  `patch:<list>:<number>:<stamp>-<rand>`, applied on read in `GET
  /api/assignments`. Dispatch's copy stays as sent, and the offline cache
  inherits corrections because it caches that response verbatim.
- **Targeted by content, with a guard.** Nothing below the assignment number has
  an id, so a patch names its step by `code|date` plus an ordinal among steps
  sharing that key, **and the sibling count at the time**. A changed count
  orphans the patch instead of binding to the wrong occurrence — without it,
  dropping the opening WRK sends a correction for the departure to the return.
  Actions are matched by their passenger set first. Names are normalised,
  **never fuzzy-matched**.
- **Orphans are kept and shown**, never applied to a near miss.
- **Driver wins, disagreement is flagged.** Each patch records what the sheet
  said when it was made. A later sheet that differs shows both, with *keep
  mine* / *use the sheet*.
- **Person-level facts reach every appearance** of that passenger holding the
  same value — correct Best's flight at WRK and the JFK row follows.
- **Step times are correctable, as the driver's beside dispatch's** (the owner,
  2026-09-23: "as mine beside theirs"). Tap a stop's time; ARRIVE and LEAVE are
  separate corrections, each with its own undo and its own *keep mine* / *use
  the sheet*. Only a time the sheet printed: the first stop's missing ETA is
  not invented, and a time is corrected, never cleared. Only the wall clock
  changes, never the date — a time pushed past midnight is out of scope until
  asked for. The driver's time is written into the field, so the clocks, the
  leg, *right now*, the call list and the pushes all run on it; dispatch's is
  kept as the edit's document value and printed beside it — *dispatch planned
  11:00p* under the stop, *you set 11:10p, dispatch 11:00p* under a clock — in
  plain type, not struck (strike-through means dispatch moved it). A driver's
  time never re-sorts dispatch's stops: that would be the app re-planning.
  An added stop has one time and is corrected as one (`time` writes both), and
  added stops are placed again after every patch, so a corrected time moves
  one among dispatch's.
- **Only the fields above.** The server refuses any other field, and a time
  aimed at anything but a stop.
- **A corrected flight is registered for polling**, or it would display and
  never update.
- Deleting an assignment deletes its patches, so a recycled number cannot
  inherit a dead run's corrections.

The patch log is ordered, retained and shared — which *is* a history in all but
rendering. "No version history" means none is shown; it must not become a
reason to compact or delete the log, because orphan and conflict handling depend
on it.

## Adding and removing (Phase 7, second half)

What dispatch tells the driver by phone, and the no-show at the kerb. Same log,
same outbox, same sharing as corrections: each is a patch with a `kind` —
`remove`, `addEntity`, `addStep` — applied on read by `applyPatches`.

- **Remove is "not happening"**: a no-show, or cancelled by phone. A stop or a
  passenger (not an action alone). The row is **marked, never spliced**:
  dispatch's original stays in the copy, and the driver sees a ghost — struck,
  dim, *NOT COMING* / *NOT HAPPENING* — with its own **UNDO that never
  expires**. No confirm: the undo is the safety. A passenger not coming is not
  coming to any of their rows — the drop-off goes with the pickup, exact name
  only, one patch and one undo (the owner, 2026-09-23). A removed row sets no clock,
  sends no push, is not polled, and leaves the call list and the route.
- **Add is what dispatch said by phone.** A passenger under any pickup or
  drop-off (name; flight, phone, note optional), or a stop (place, date, time,
  pickup/drop-off, door). Drawn with a dashed **YOURS** chip, never blended
  with dispatch's rows. An added stop is placed among dispatch's by its time.
  An added passenger's flight is polled and drives the clocks; the phone
  proposes *arriving/departing* from the stop and verb, and the driver can
  change it.
- **A stop of the driver's own (v69; the Worker's half built 2026-10-05, the
  sheet comes with the app's v69).** Not only what dispatch phoned in: fuel, a
  wait, an errand. What happens there is a pickup, a drop-off, the driver's
  own words (up to 40 characters) or **nothing**: then the stop has no action
  and no door. It has the time it is reached (`time`, as before) and, when
  the driver gives one, the time it is left (`leave`); a leave past midnight
  is dated the next day, as a sheet's stop is. Each is corrected later like
  any time (`eta`, `etd`; `time` still moves a one-time stop whole), a
  leave it was added without included, and the correction keeps what the stop
  was *added as* beside it. A stop added before v69 (one time, a pickup or a
  drop-off) reads exactly as it did. It is the driver's throughout: an alert
  quotes its time as *you set 9:40p*, never as *dispatch planned*, and it
  gets no PARKED BY / LEAVING of its own unless it is an airport with a
  flight to meet (the two clocks are about flights).
- **Added rows do not count for anchoring.** An added WRK counted as a sibling
  would change the count every WRK correction is guarded by and orphan all of
  them. So anchors see dispatch's rows only, and an added row is addressed by
  the patch that added it (`target.on` = that patch's client `ref`, which the
  phone knows before the server answers — a correction on a row added offline
  needs no rewriting).
- **Rows are addressed by `_at`, not by position on screen.** GET gives every
  row its place in the STORED copy (`2.0.1`) or `+<ref>` for an added one. Added
  stops are placed by time, so an index into the served array would point at a
  different stop on the server — and move again when KV's list lag hides the
  add. `basis` guards only sheet addresses; no re-import can move an added row.
- **Dispatch agreeing is said, never acted on.** A later sheet that has the
  added passenger (same action, exact name) or more stops of the added key
  marks the add *agreed*: *CLEAR MINE*. A removed passenger whose name is
  nowhere in a later sheet, or a removed stop whose key is gone, is listed
  under *THE SHEET AGREES*. Anything moved rather than gone orphans, as
  corrections do.
- **Undo last edit** still pops the newest patch, of any kind.

## Offline (Phase 8)

One path, not an online path with an offline fallback. Every edit goes to a
queue on the phone first (`fw_outbox`) and to the server when it can. Built in
`public/assignments.js`, *outbox*.

- **Readable with no signal.** The last `GET /api/assignments` is kept whole and
  painted before the network is tried, so the next stop never waits on a
  request that one bar can hold open for minutes (requests time out at 10s).
  Offline shows the header flag and *No signal. Showing the copy from 11:05p*.
- **An edit shows at once**, with a hollow dot until the server has it, then the
  ordinary solid one. It survives closing the app. Undo, *use the sheet* and
  *keep mine* are queued the same way; undoing an edit that never left the
  phone just drops it from the queue.
- **Sent in order, one at a time**, stopping at the first that cannot be sent
  (no signal, a 5xx, or a 429: all "later", never a refusal). Tried on load, on
  `online`, on returning to the app, and every 30s while anything waits —
  `online` alone is unreliable on phones. Imported sheets go through the same
  queue (see *Importing a sheet*).
- **Replay-safe.** Each op carries a `ref`; a POST whose answer was lost is
  recognised on the retry and not written twice.
- **Never aimed at a sheet it was not made on.** A queued edit names its value
  by index into the copy the driver saw and carries that copy's `importedAt` as
  `basis`. If dispatch re-sent the run meanwhile, the server refuses it (409)
  rather than point old indices at a new document, and it is listed with the
  corrections the app could not place, for the driver to re-enter or discard.
- **KV lag is covered.** A patch the server accepted can be missing from GET for
  20s or more (measured). Accepted ops stay drawn from a short ledger
  (`fw_sent`, 5 min) until the server's copy shows them, so a correction does
  not vanish the moment it sends.

*Step taps* have nothing to queue yet: progress (Automatic / Confirm / Manual)
is not built, and the call-list ticks are per-device already.

## Notifications (Phase 9)

The push says what to do; the flight is the evidence on the second line. Built
in `worker/src/notify.ts`, pure, and tested on the 369736 shape.

- **Written from the stop's two clocks**, the same arithmetic the itinerary
  draws, re-run with the old and the new status. What moved is what is said:
  parked-by moving → *Leave 20 minutes later* (or *Be at LGA…* when the
  document has no leg to leave by); leaving moving → *Wait 32 minutes longer at
  LGA*. A combo's later flight slipping says nothing about when to arrive,
  because it does not change it.
- **Phase by the clock.** Before dispatch's leave-by, the verb is *leave*. On the
  road, an early flight becomes *Park by 10:25p*; *Leave now* only when the new
  leave-by has already passed.
- **Early is urgent (ntfy 5), delay is calm (3).** Landing before the driver was
  due to be parked is urgent; an ordinary landing is *Call your UA1503 pickup —
  landed*, high, with belt and terminal.
- **No passenger names in a push.** The topic lives on public ntfy.sh; the
  flight and the stop (*LGA pickup · UA1503*) say who, and the app has the name
  (the owner, 2026-09-26).
- **The topic is its own secret**, `curbside-` + 24 random hex, stored on the
  list, never derived from the list code: holding the pushes must not open the
  list. A list made before is given one on its first load; Settings shows it
  with COPY and SUBSCRIBE (ntfy's page for it). The driver resubscribes once
  (the owner, 2026-09-26). Cancelled or diverted → *Call
  dispatch*, urgent. Terminal and belt moves are high; a far-end gate is low.
- **Every computed time goes out beside dispatch's** (*leave by 9:50p, dispatch
  planned 9:30p*). Nothing is re-planned. Where the driver corrected the time,
  the arithmetic uses theirs and both are said: *leave by 9:59p, you set 9:45p,
  dispatch 9:30p*. "Dispatch planned" is always dispatch's number.
- **A departure's check-in runs from the earlier of scheduled and estimated.** A
  delay does not move the check-in desk, so it says *Leave as planned*, low. The
  itinerary uses the same rule, so the row and the push agree.
- **Under five minutes is noise**, and status churn that moves no clock
  (*En Route*, *Departed*) sends nothing. A stop three hours behind sends
  nothing.
- **A flight's first check is measured from its timetable** (v66.1, found by
  review 2026-10-03). Importing looks nothing up, so the first check, the one
  about three hours out, has no earlier check to be compared with; until this
  it could say nothing, and a flight that was late then and stayed as late was
  never told at all, nor one cancelled before it. Dispatch planned the run with
  the flight on time, so that is what the driver knows: the first check is
  compared with the schedule in the same answer (`asScheduled` in notify.ts),
  the difference the list's LATE chip shows. On its timetable (under five
  minutes off; not cancelled, diverted or down) it says nothing and no run is
  read for it, and a later creep adds to the timetable, not to that first look.
- **GB runs go one level louder** and carry a *GOVERNING BODY* tag.
- **Read through corrections.** Cron loads each list's assignments with patches
  applied, so a corrected flight is the flight the push names. A flight no run
  on the list meets is never pushed: there is no stop to be at. (Until
  2026-10-04 a flight added by hand on the old flat list got a stop built from
  its job. That list's routes, `/api/flights` and `/api/history`, are gone, as
  is the per-flight change history only they read; a job an old list still
  holds is left in its record and read by nothing.)
- Published as JSON, not headers: a Title header is Latin-1 only, and the old
  `UA1503 — Delayed` title made fetch throw before the push left the Worker.
- **Test alert (v65).** Settings → List code and alerts → SEND A TEST: one
  push to the list's own topic (POST /api/alerts/test, one KV get, 5 an hour
  per list per isolate). Its first use, 2026-10-02, found the reason no alert
  had been seen: **ntfy.sh limits anonymous publishing per IP address, and a
  Worker's IP is Cloudflare's, shared with every other Worker**; ntfy answered
  429 "daily message quota reached" (and once 522 after 19.5 s). The worker now
  sends with `NTFY_TOKEN` when that secret is set (Bearer; the token's plan
  limits apply, not the shared IP's) and gives up on a push after 5 s, so a
  stuck ntfy never holds a save past the phone's own 10 s wait. The test says
  the quota in words when that is the cause.

## Alerts in the app (Web Push, v66)

ntfy.sh refusing the Worker meant no alert reached anyone. The owner left the
fix to Claude (2026-10-02: an ntfy paid plan, or Web Push); Web Push it is:
free, no second app for a tester to install and subscribe, no flight on a
public topic, no quota shared with strangers. Built 2026-10-02.

- **The phone signs up, the Worker sends.** Settings → List code and alerts →
  *Alerts on this phone* → TURN ON asks the phone's own question, subscribes
  with the browser's push service under the server's public key (`pushKey`,
  which comes with GET /api/assignments), and hands the subscription to the
  list (POST /api/push). Each notice is then POSTed to the phone's push
  service, and `public/sw.js` shows it. A tap opens the app. Since v69 an
  alert about a run carries the run's number (`run` in the payload), so the
  tap can open that run; a phone on an older app ignores it, and a test alert
  or a tester's note carries none.
- **`worker/src/webpush.ts`, WebCrypto only, no library.** VAPID (RFC 8292):
  an ES256 token per push service, good for 12 hours, signed with the
  `VAPID_PRIVATE` secret, `sub` the app's own address. The body (RFC 8291,
  `aes128gcm`): a fresh P-256 key and salt per message, encrypted to the
  phone's key, so the push service carries it without reading it. Tested
  against RFC 8291's own worked example, byte for byte, and read back by a
  receiver written apart from the sender. Asked with a made-up subscription
  on 2026-10-02, Apple and Google both took the signed request (Apple 400
  *BadDeviceToken*, Google 410) and refused the same one signed by the wrong
  key (403), so the token is what they expect.
- **Kept by topic, not by code**: `push:<topic>`, up to 10 phones, the oldest
  gives way. Its own key, never a field of the list record, which a settings
  save from a minute-old copy would overwrite. By topic, so a notice for the
  keeper (feedback, a driver's suggestion, sent to `FEEDBACK_TOPIC`) reaches
  the keeper's phones with no lookup. Never the stamp: no phone shows
  another's.
- **Only a real push service is ever fetched.** A subscription is whatever a
  caller with a list code posts, and the Worker fetches its endpoint, so the
  host must be Google's, Mozilla's, Apple's or Microsoft's push service, over
  https, with no port or credentials, and the keys must be a point on the
  curve and 16 bytes. Checked when taken and again when sent; redirects are
  not followed.
- **Both ways, always** (`pushTo` in index.ts): every notice goes to each
  phone with alerts on AND to the list's ntfy topic. A second phone on the
  list may still rely on the ntfy app, and a push a service took is not yet
  one on a screen. A driver with both gets it twice until they unsubscribe in
  ntfy. The driver *was told* when either took it; when neither did, the next
  change is still measured from the last thing they were told.
- **A phone that is gone leaves the list**: 404 or 410 from its push service
  (the app removed, notifications turned off), or Apple's 400 *BadDeviceToken*.
  Any other refusal keeps it: that is the server's to fix.
- **Urgency and life.** Anything about a flight (priority 3 and up) is sent
  `high`: `normal` waits for a sleeping Android phone to wake by itself, and a
  delay heard after the driver left is no use. Kept three hours for a phone
  out of reach, so one coming out of a dead zone still hears that a flight is
  early; past that the stop is history. Quiet news (priority 2: a gate to
  expect, feedback, a suggestion) is `normal`, kept a day, and shown without
  a sound, as ntfy showed it. Nothing is ever `low`.
- **Always shown.** The service worker shows a notification for every push,
  even one it cannot read: an iPhone ends the subscription of an app whose
  pushes show nothing. A GB run's notice leads with *GOVERNING BODY*.
- **Per phone, never synced** (`fw_push_on`). At every launch the phone makes
  its subscription again if the browser let it go or the server's key changed,
  and tells the list once (two reads when the list already had it), which
  also puts back a phone the list lost. Moving to another list ends the old
  subscription and makes a new one, so the list left behind cannot reach the
  phone even if it never heard.
- **The page says what is true**: ON, OFF, STOPPED (it was on and is not
  working), BLOCKED (the phone's own settings), or why it cannot be (an iPhone
  only lets a Home Screen app have alerts, iOS 16.4: in Safari it says *Add to
  Home Screen*). The list says it too: *ALERTS ARE OFF ON THIS PHONE* as an
  offer until tapped once, *ALERTS STOPPED ON THIS PHONE* until it is fixed.
- **SEND A TEST goes the way a real alert goes**, and the phone sends its own
  endpoint, so the answer is about THIS phone: sent to it; sent to other
  phones or to ntfy only; or taken by nothing, in words. A phone that should
  have got it and did not makes its subscription again and says so.
- **The keys** are two Worker secrets, `VAPID_PUBLIC` and `VAPID_PRIVATE`
  (base64url: the 65-byte point, the 32-byte scalar), made once. Without both,
  no phone can turn alerts on and everything goes by ntfy as before. Changing
  them ends every subscription; each phone signs up again at its next launch.
- **Not built:** a subscription the browser replaces while the app is closed
  is picked up at the next launch, not by the service worker; an alert does
  not open its own run, only the app.

## Flight checks (the free plan)

AeroDataBox's free plan is **400 units a month, a hard limit**, and a flight
lookup is a Tier 2 call: 2 units, so **200 lookups a month for every driver
together**. The owner chose to stay free (2026-09-28). Real sheets carry about
one flight per driver per day. Built in `worker/src/checks.ts`.

- **Only the checks that change what the driver does.** An arrival: ~3h before
  landing (a delay or a cancellation before leaving), ~45m before (the new time
  and the terminal, on the road), ~15m after (landed, and the belt). A
  departure: ~3h before take-off (terminal, cancellation) and no more, because
  a later departure never moves the drop-off (the check-in deadline counts from
  the earlier of scheduled and estimated). No extra checks after a change.
- **Importing costs nothing.** The first check is planned from the sheet's own
  printed time (Eastern, at our airports) and its A / D tag, kept in the poll
  key's metadata. A flight with no time anywhere gets one lookup to learn it.
- **Late imports skip, never bunch:** a check is passed when the next is under
  40 minutes away. A check before one already made is passed too. Two lookups
  in a row that find nothing give the flight up; a cancellation ends it.
- **A lookup that fails is not a flight nobody knows** (v66.1). AeroDataBox
  down, or the network: the same check is tried once more at the next tick,
  then passed for the one after. A flight is never given up for an error (two
  in a row used to end it, and its landing was never looked for), and each
  check is made at most twice.
- **The budget.** The worker counts units per month (RapidAPI's own remaining /
  reset headers win when present) and never runs into the hard limit. Under
  60 units left only the ~45m-before-landing check is made; under 6, none. A
  429 means none left. The app is told (`flightChecks` on GET): *Flight checks
  running low: only the one before landing*, or, in red, *Flight checks paused
  until Thu 1 Oct*.
- **A flight nobody meets is not looked up (v69).** A passenger marked not
  coming, a flight number corrected away, a stop not happening, a sheet
  re-sent without the flight: the flight stays tracked, and used to keep its
  remaining checks (up to 6 units) for nobody. Now the tick asks, before a
  unit is spent, whether any run on a list that tracks the flight still
  names it, as GET serves the runs (corrections applied, learned airlines
  filled in). Nobody: the check is left due and marked; nobody again at the
  next tick, 20 minutes on: the check is passed without a lookup. Met again
  in between (an UNDO): looked up as ever. When no check is left the flight
  is let go (its poll key, status, plan, what was told and its trackers are
  deleted), and undoing a not-coming or a flight fix tracks it again, as does
  the next load of the list. **Asked at the tick, not at the edit**: KV's
  lists lag a write by seconds and a phone sends its changes back to back, so
  a flight let go at an edit could be one on the screen that is never checked
  again; two ticks apart, nothing is read mid-change. The cost is one read of
  each tracking list's runs per tick that looks a flight up (2 list() calls
  and a get per run; the pushes are written from the same read), none when
  the month's units are spent.
- **A re-sent sheet that moves a flight's printed time plans its first check
  again (v69)**, with the new time on the poll key: a time moved earlier left
  the check before the driver leaves too late to be that. Only while no check
  has been made: after that AeroDataBox's own times plan the rest.
- **Freshness is never red for its age**: hours between checks is the plan.
  The green dot still marks a check in the last five minutes.
- **Lookups left (v65).** `flightChecks` also carries `left` (lookups, every
  driver's pool) and `renews`; Settings → List code and alerts shows them, red
  once checks are cut back. Paused checks are also said once on the list of
  runs, above the runs they touch, not only on a run's page (a bar since v67).

## Alpha testers (2026-09-28)

Three drivers on different runs, each on their own list. What they get:

- **Save the code, once.** START A NEW LIST is followed by one screen: *This
  code is your list. Save it now.* SHARE (text only, to Notes or a text to
  themselves) or COPY, then SAVED. It holds the screen (`holdScreen`: the
  minute tick and a return from the background paint nothing over it) and
  comes back on relaunch until SAVED (`fw_code_unsaved`). A list entered by its
  code never sees it. Settings still shows the code.
- **Feedback.** Settings → HELP → SEND FEEDBACK: a text box (2,000 characters)
  and the app version. POST `/api/feedback` stores one KV key per note,
  `feedback:<iso>:<tester>:<rand>`, kept 60 days by KV expiry, with a
  **tester id** (the first 8 hex of SHA-256 of the code and the list's topic:
  the code alone is 32 bits and could be reversed), never the code. Five a day
  per list (a per-isolate count, then a KV list of the day). The owner gets a
  quiet ntfy push, *New feedback · v52*, to the `FEEDBACK_TOPIC` secret, **never
  the text**: a note may name a passenger, and ntfy topics are public by name.
  It does not go through the outbox (it changes no run): with no signal it is
  refused with a line, and the note stays in the box and in `fw_feedback_draft`.
  Cost: 1 get, 1 list, 1 write.
- **The guide**, `/guide/` (a static page, precached): install, the code,
  importing on each phone, colours, the two clocks, flight checks on the free
  plan, feedback. Linked from the welcome screen and Settings.

## Versions (the owner, 2026-09-29)

Every release gets a new version, because the service worker's name (`CACHE_NAME`
in `public/sw.js`, `curbside-v60.1`) is what makes a phone fetch new code: a fix
shipped under the old name would never arrive. Two kinds:

- **A whole number (v61)**: a release a driver would notice: a new feature, or a
  screen, a clock or a rule that behaves differently. That is also when the
  testers hear about it. `releaseNews(major)` in `public/app.js` holds what it
  brought, in at most 28 characters (a test fails without it).
- **A point (v60.1)**: a fix, wording, polish; nothing about how a run is worked.

Claude picks one at each deploy and says which in the commit; the owner can
overrule. Settings shows the version, feedback carries it (the worker keeps
`v61` and `v60.1`, nothing else). After an update the driver pulled in, the strip
says "UPDATED TO V60.2"; on crossing into a new whole number since the phone
last ran (`fw_seen_version`), even an update that happened unseen, it adds what's
new, once: "UPDATED TO V61 · ROUTE IN MAPS", held a little longer. A phone
updated before it kept a version counts as coming from an older whole number; a
first install says nothing; a rollback counts down. The scheme started at v60.1
(v60 was the shuttle release).

## Abuse limits

The worker is on workers.dev (no zone, so no dashboard rate rule), and one
account's KV free tier is the whole budget. Every request except a preflight
passes the `API_LIMITER` binding (120 a minute per client address) **before
any KV call**; new lists also pass `REGISTER_LIMITER` (3 a minute), backed by
10 an hour per isolate. Over the limit: 429 with CORS and `Retry-After: 60`.
Both bindings are per Cloudflare location and approximate, and the code fails
open without them. Built 2026-09-26; the remote preview on the owner's account
enforced it (121 allowed, then 429). Cron is not limited.

**Where the KV quota goes (v65).** Each request or cron tick that touched KV logs one
object to Workers Logs: `{kv: "ops", route, get, put, delete, list}` (`worker/src/kvcount.ts`).
The route is the app's own path or "other", never a code; logged only on Cloudflare. The
dashboard's query builder sums a field by route over a day, which is the decision point
for the $5 plan before the free tier (1,000 lists / writes / deletes a day, account-wide)
refuses production.

**Trackers put back (review B8, v65).** A flight's trackers are one key read and written
whole, so two lists saving it at once can lose one, and that list gets no pushes. Each
GET of a list now reads the trackers of its flights from yesterday on and puts the list
back when it is missing (with the poll key): a get per flight, a write only when one was
lost, and a count-only "Tracking restored" log line. A Durable Object would remove the
race itself; not worth it at this size.

**Security review (2026-10-04, v66.2).** What it found and what now holds:

- *What a list code protects.* Everything on its list: the runs with their names, phones and
  doors, the corrections, the places, the alerts sign-up. It is the only key, eight hex
  characters (32 bits). No route lets one list read or change another's; the shared records
  (the catalog, the suggestions, a flight's status) hold no list's code or passengers. Guessing
  a code is bounded by the plan, not by the code: 100,000 requests a day in all, so about one
  chance in 43,000 a day per list that exists. Longer codes are wanted before a paid plan.
- *A run's fields have their types* (`limits.ts checkAssignment`): text, a count, true or
  false, as the importer sends them; a print time at most a day ahead of now. The list card
  printed the passenger count unescaped, so a run posted with markup for `pax` ran as script
  on every phone on the list; and a footer from the future outranked every later re-send.
- *A list code, a run's number and a change's id are a key's shape* before any KV call
  (`isListCode`, `checkRunKey`): text, no colon, bounded. A JSON number was taken as a code.
- *The pages' policy* (`public/_headers`, checked by `headers.test.ts`): only this origin's
  script files and the pages' own inline scripts (by hash) run; the app talks to its Worker
  only; no framing by another site. An inline script that changes needs its new hash there.
  API answers are `nosniff` and `no-store`.
- *What one list can cost the rest:* 300 runs a list (one `list()` per new run imported), 300
  changes a run, 20 suggestions waiting per list, 20 new lists a day from everywhere (`+1 get,
  +1 put` per registration). `GET /api/travel-times` needs a list code or the write token.
- *Cron and KV's daily writes:* a tick first writes the units it is about to spend; if KV
  refuses, it looks nothing up. Before, a refused write left the flight due and it was looked
  up again every tick. A lookup gets ten seconds.
- *The sheet reader* stops at 150 MB inflated per file, as well as 75 MB per stream.

Tightened since (2026-10-04, the review's leftovers; no change a driver sees):

- *The list code is read from the `X-List-Code` header and nowhere else.* The query string
  and the body were still read for a frontend and an importer that are gone; a code in either
  now names nothing (400, no KV call). A URL lands in history and in logs; a header does not.
- *The old flat list's routes are gone* (`/api/flights`, `/api/history`, the retired flight
  UI's): five routes fewer to keep safe, and no PATCH among the allowed methods.
- *A run meets at most 12 flights* (was 100). Each one is tracked, with lookups from the month
  every list shares; the most a real sheet has carried is 3. Since v69 corrections are held to
  the same: a change that would make a run name a thirteenth flight is refused (413), one that
  names no new flight never is; and a flight a correction drops is no longer looked up (Flight
  checks, "a flight nobody meets").
- *The list's buffer and drive times are gone* (v69: `bufferMinutes`, `driveMinutes`, the old
  flat list's). Nothing had read them since its routes went. A list that stored them loads as
  before, they are not served, a save that still sends them is taken without them, and the
  list's next save drops them.

Still open, and the owner's to decide: registering is open to anyone with the address, so a
stranger's list shares the day's KV and the month's flight lookups with the driver's; a PDF
sent to the share target from a web page is imported like a shared one.

## Importing a sheet

The #1 priority from 2026-09-27: the driver hands dispatch's PDF to the app and
the app converts it. Until it is deployed, imports run from the laptop
(`node tools/import.mjs <pdf> --post-assignment <code>`; the Python importer
stayed, untouched, as the reference until the in-app import had had real use,
then went: the owner, 2026-09-28, and again 2026-10-04. See "Without the
Python" below). Designed and approved 2026-09-28; the owner:
"not to be rushed though, it has to work smoothly and integrate cleanly with the
app."

**On the device, never the Worker.** The PDF and its PII never leave the phone;
only the assignment it converts to is sent, to the same `POST /api/assignments`
the laptop uses today (no server change). Workers have hard CPU limits, and
device parsing costs nothing per extra driver.

**One reader, in JavaScript, proven against the Python.** The parser depends on
pypdf's *layout-mode* text: columns (`\s{2,}` cell splits, `cand[:30]`,
`.{60,}`) and blank lines (`lines[i:i+4]` windows). So the text layer is a
faithful port of pypdf 6.18.1's layout mode (`_layout_mode/`, and the font,
ToUnicode and content-stream code it reads through), down to its rounding,
`//`, Python 3.12's compensated `sum()` and its quirks (a `cm` outside `q` is
ignored; `Tj` never advances the pen). The parser (`parse_text`,
`build_assignment`, `airlines.py`) is ported beside it, with Python's regex
semantics kept (Unicode `\s`, `\w`, `\b`, `\d`; `$` before a final newline).
**Gate: identical text AND identical assignment JSON on all 251 real sheets**,
plus the 15 fixtures. Then the laptop runs the same module under node, and the
Python retires once the owner agrees. (Pyodide running the unchanged Python was
the fallback: also 251/251, but a 13 MB download and 5–10 s on a phone.)

**No pdf.js: a small reader of our own.** The design first named pdf.js's
operator list as the base. It was dropped in the build (2026-09-28): every sheet
comes from one generator (PDF 1.4, a classic xref table, one Flate content
stream per page, Type0 Segoe UI fonts with Identity-H and a ToUnicode map, text
drawn with `Tj`/`TJ` only, 251 of 251), and pypdf's output depends on how *it*
reads those fonts (widths per CID, the space glyph, a zero `/DW`), which pdf.js
hides or computes its own way. Porting pypdf's own reading is exact and
checkable line by line; the whole importer (reader, layout port, parser) is
about 110 KB of plain JS instead of a 2 MB library, synchronous, and cached with
the app. What the sheets never use (encryption, simple fonts, other filters) is
refused with a plain message, never guessed at. xref streams, object streams
and a broken xref (rebuilt by scanning) are read, since a re-saved copy would
use them.

**PDF only.** A screenshot is pixels, not text: OCR misreads digits (times,
flight numbers), shows part of a sheet, and a vision API would send names and
phones to a third party. The picker takes `application/pdf`; a PDF with no text
(a scan) gets "this PDF is a picture, not text", never a guess (the owner agreed,
2026-09-28). Revisit only if dispatch ever sends images.

**Getting the PDF in** (the owner, 2026-09-28): it arrives by Outlook on both
phones. Android: Share → Curbside (a share target) and IMPORT. iPhone: IMPORT →
the file picker (Save to Files from Mail/Outlook first; Recents makes it quick).
Laptop: drag and drop. Open: a managed (Intune) Outlook may block Share / Save to
Files; the owner is trying both phones before the share target is built.

**The import UI, as approved (the owner, 2026-09-28, from a mock:
https://claude.ai/artifact/LN3EaeN9gdS3S6xBMEEe28, "version A and everything
else"):**

- **Ways in.** A file-plus icon in the header, left of Settings (its centre 44px
  from Settings', so each keeps its whole target; the word IMPORT did not fit
  beside OFFLINE on a 360px Android). An empty list has IMPORT A SHEET and one
  hint for the device: iPhone, save the attachment to Files first; Android
  (installed), share it to Curbside; a laptop, drop it anywhere. The picker takes
  PDFs, several at once. The laptop: a PDF dropped anywhere shows a dashed veil.
  Android: Share → Curbside (below).
- **No confirm step.** The newest printed copy wins on the server and
  corrections live apart from the sheet, so an import can't cost the driver
  anything.
- **What it did, on the list, until OK** (no toasts): one line per file, in
  order, each opening its run. A green check: *New run* (day, times,
  passengers) or *Updated* (dispatch's newer copy, printed …, *your 2 changes
  carried over*, or in red *1 of your changes needs placing*). A dash: *Already
  here* or *Older copy, not used*. Hollow: *Sending…*, *Waiting for signal*,
  *Already waiting*. Red: *Not an assignment sheet*, *A picture, not text*,
  *Not a PDF*, *A locked or unusual PDF*, *A date or time can't be read*,
  *Couldn't read this sheet*, *Not saved* (refused, or the list code is gone),
  *This phone can't read sheets* (a browser too old for the reader), *No PDF
  arrived* (a share with no file). The server answers `applied:false` for an
  equal *and* an older print, so the app tells them apart by printedAt. What the
  phone already holds it answers itself (the same print, an older one, or one
  already waiting), with no request. After an import the app shows the list from
  the top; it never opens a run on its own. The same words go to a screen reader.
- **Offline: one path, the outbox.** A sheet is read at once, so a bad file is
  said at once; only the POST waits for signal. A **new** run shows at once,
  marked NOT SENT, and its itinerary says it is on this phone only; edits made on
  it are aimed at the sheet as read (`basis: "q:<ref>"`) and re-aimed at the
  server's copy when the sheet lands, but only when that copy is the same print.
  An **updated** sheet does not replace the copy on screen: only the server
  re-applies the driver's corrections, so the older copy stays, with them, and
  the itinerary says a newer one is waiting. Edits made on it meanwhile are sent
  *before* the sheet (they were made on the copy the server still holds), so the
  new sheet carries them over like any correction; after both land, KV's list
  lag can hide the new patch for about 20 seconds.
- **KV's list lag.** A new run the server took is drawn from its own answer
  (`fw_sent`, kind `import`) until GET shows it, with any edit sent to it; the
  app asks again after 20 seconds until it does. A retry whose first answer was
  lost to a bar gets "already stored"; a run that was not on the phone is then
  said as *New run*.
- **Android: Share → Curbside.** `share_target` (POST, multipart, field `sheets`,
  PDFs) to `/share-target`, which the service worker answers: the files wait in
  Cache Storage (`curbside-shared`, never cleared by an update) and the share is
  answered 303 → `/?shared=1`; the page reads them like picked files and lets
  them go. Checked on every launch with a list, so a share the app was closed on
  is not lost. Only an installed PWA on Android Chrome is a share target; iOS has
  none.
- **Cached.** The reader's modules and `import.js` are precached (`sw.js`, v38,
  fetched past the HTTP cache), so a sheet reads with no signal; a test fails if
  a module is missing from the list. The reader loads on the first import.

Keeping the original PDF on the phone: later (the reader already gets the bytes).

**Build order:** (1) text layer to 251/251, (2) parser and its tests to 251/251,
the laptop via node, (3) the UI, (4) a phone test, deploy on the owner's go.

*As built, steps 1–2 (2026-09-28, branch `feat/pdf-import`):* `public/importer/`
holds ES modules: `pdf-reader.js` (file, objects, streams, pages), `inflate.js`
(zlib that, like pypdf's, ignores bytes after the end and keeps what a damaged
stream had), `pdf-text.js` (layout mode), `python.js` + `casefold.js` (the
CPython semantics), `sheet.js` + `airlines.js` (the parser), and `index.js`:
`readSheet(bytes, fileName)` gives `{ok, assignment}` or one reason the UI can
say plainly: `not-pdf`, `unsupported`, `picture` (no text), `not-a-sheet`,
`unreadable` (a date or time strptime would refuse). Measured against the
Python: text and assignment identical on 252 of 252 real sheets (the corpus
and the owner's Floater, 378072), the 15 fixtures, and 4 synthetic PDFs
(`tools/pdf-fixtures/`, drawn from the redacted fixtures by
`tools/pdf_fixtures.py`) that add what the sheets never use: every text
operator layout mode reads, rotated text, a font the page lacks, ligatures and
emoji, xref streams, a broken xref. About 8 ms a sheet on the laptop. Tests:
`worker/src/importer.test.ts` and `sheet.test.ts` (the parser tests of
`tools/test_parser.py`, ported; the flat-job ones belong to the retired UI).
The gate was `tools/parity.mjs` (JS against the Python, counts only), until
the Python went. The laptop: `node tools/import.mjs <pdf> --post-assignment <code>`
gives the same runs, in the same order, as the Python did.

*Without the Python (2026-10-04, the owner's yes).* The Python importer, its 67
tests, `parity.mjs` and the Python PDF writer are removed; the last commit that
has them is the tag `python-importer-last` (parity there: 252 of 252 real
sheets, 4 of 4 synthetic PDFs, 15 of 15 fixtures, text and run). One reader is
left, and what the Python proved is kept as answers on file:

- **Golden answers.** `tools/fixtures/<name>.json` is the whole run each
  scrubbed fixture must read as; `tools/pdf-fixtures/<name>.json` the same for
  the synthetic PDFs. Byte for byte the Python's answers when written. A worker
  test compares every field. `node tools/golden.mjs` rewrites them after a
  change to the parser that was meant: the diff is then read, and committed with
  the change. The `.txt` beside each synthetic PDF is pypdf 6.18.1's text for
  it and is never rewritten: it is what is left of pypdf.
- **A snapshot of the real sheets, outside the repo.**
  `CURBSIDE_CORPUS=<folder> node tools/corpus.mjs [more PDFs]` reads every real
  PDF and compares it with `../curbside-private/corpus-snapshot.json` (or
  `CURBSIDE_SNAPSHOT`): per sheet, keyed by the hash of its bytes, the layout
  text's hash, how the reading ended, the run's hash and a short hash per field
  name. It prints counts, indexes and field names only ("changed 13: by field:
  flightNumber 13"): never a value, never a file name. Exit 1 when a sheet reads
  differently; new and missing files are counted, and `--accept` takes a new
  snapshot (on a commit known good). The first was taken on the tagged commit:
  252 files, 250 distinct (two are copies), all read as sheets.
- **The tests.** Each of the Python's 67 has its twin in the worker's tests
  (the map is in the commit that says "67 tests"); the leg times live in
  `notify.test.ts` (the leg is the Worker's `legBetween` now), source hygiene in
  `tools.test.ts`.
- **Made-up sheets.** `tools/make-pdf.mjs` (the Python's PDF writer, ported:
  text to a one-page PDF in the generator's shape) for a made-up run or a
  re-sent copy; held, object for object, to the two single-page PDFs the Python
  made. `node tools/make-pdf.mjs 369736 out.pdf --replace 369736=900736`.
- **New fixtures.** `tools/redact.py` stays (Python, standard library only) and
  asks this reader for each PDF's text (`node tools/import.mjs <pdf> --text`).
  The committed fixtures were also scrubbed by hand after they were generated:
  a regeneration is never committed unread.

A change to the reader is done when `npm test` passes and the corpus says
`changed 0` (or every changed field is the one that was meant, and `--accept`
follows).

*As built, step 3 (2026-09-28, the same branch):* `public/import.js` (the ways
in: picker, drop, share pickup; reading each file), the imports section of
`public/assignments.js` (the queue's `import` op, the phone's own answers, the
lines, the strips), `sw.js` (share target, precache), `manifest.json`
(`share_target`). Tests in `client.test.ts` (outcomes, queued runs, re-aimed
edits, list lag, send order, reading with the real reader on the synthetic PDFs)
and `sw.test.ts` (precache, share, update). Checked in Chromium against the dev
worker: every line above from real files, the offline → online path, the share
through the real service worker, the drop, and the owner's Floater (read in
7 ms). Not yet on a phone: step 4.

## Parsing decisions

**A party: same surname, same flight, same drop-off door.** Passengers who share
all three are one row (`Hauser, Marcus & Vera`, the passengers counted, the bags
summed, every number kept); a different door or a different flight keeps them
apart, always. The surname is compared whatever its case (v67.1, the owner,
2026-10-04): on run 378725 dispatch typed one of a couple in capitals and they
came out as two rows; no sheet before it had a surname in capitals (1,070 named
rows on 252 sheets). The row still shows each name as dispatch typed it, in the
party's one order: `WOODHAM, JOHN & Mary`. Nothing is retyped: the app converts.
A run stored before the fix stays as it was read until its sheet is imported
again (the same print is left alone: remove the run from the list, then import).

**Driver notes: parse the timed lines, not the prose.** 62 of 179 notes contain a
time and 124 lines *start* with one — `7:45a Load Mail for ALL Sites` splits
cleanly into a time and an instruction. What cannot be done reliably is inferring
a location or a type from the instruction: that line has none, and
`8:00a Depart WRK Lobby for HUB` has two. So timed lines become a checklist
attached to the enclosing step, verbatim, and prose is displayed as written with
a control to promote any line into a real step by hand.

*As built (Phase 11, 2026-09-25; widened 2026-09-29):* a timed line is one that
starts with `h:mm`: with `a`/`am`/`p`/`pm` (`7:45a`, `7:55am`), 24-hour (`14:30`),
or bare (`6:15`, as the first shuttle sheet printed, 374819). A bare time takes
the a/p that puts it inside the run (6:15 on a 6:00a–10:00a run is 6:15a), and
when both do, the one that keeps the lines in their printed order; when neither
does, the one that keeps the order (two real runs printed 7:40a–12:00p run their
notes on to "12:50 … 4:45 … 5:00": the afternoon), else the nearer. It is shown
with the a/p it was read as. Checked on the owner's corpus (188 runs): 104 bare
lines, all read in printed order. A star after the time (`7:45*`, dispatch's mark for a
time that hangs on something else: "or 5 min after Morning Worship concludes")
stays with it.
It goes under the first stop whose leave time (the driver's if they set one,
else the arrival when there is no leave) is at or after it — the stop that is
RIGHT NOW at that time — and under the last stop when it is later than all of
them; removed stops take none. The line has no date: it takes the run's day
that puts it inside the run's start–end window, else the one nearest it — the
same rule that dates a stop the driver adds (the owner, 2026-09-26; the old
"within 12 hours of the start" rule put 7:45a on a 7:30p-to-morning run under
the opening stop). Parsed on the device from the stored notes, so no re-import.
Worded as printed. Once any line is on the timeline, the DRIVER NOTES block keeps
the prose (the untimed lines) and SHOW ALL gives back every line as printed
(2026-09-29). Ticks are per device (`fw_ticks`, keyed by the line's words) and
never set by the app. A done stop folds its lines away with the rest.
Promote-to-stop is later (the owner, 2026-09-25). Under a window the lines are
its legs: see *Shuttles and windows*.

## Shuttles and windows

The owner's first shuttle sheet (374819, 2026-09-29) printed two shuttles as
stops with no address — `CLD` "CLD Shuttle" 6:00a–7:30a, `ABS` "After Breakfast
Shuttle" 7:55a–8:05a — and the real steps as timed notes lines ("6:15 NCB to SGA.",
"7:45* or 5 min after Morning Worship concludes, depart SGA for NCA."). The owner:
"here the notes are the real steps".

- **A window** is a printed stop with no address and no passenger (and not an
  airport, not one the driver added). The owner's corpus: 24 of 503 stops lack an
  address, and all 24 carry nobody: shuttles and duties (Dispatch, Office Projects,
  Floater, Taxi 1, Washing Car). It shows as a dashed band with dispatch's code,
  label and hours, never "Head to CLD Shuttle". Real places stay stops, passengers
  or not (MGW, NCA on 374819).
- **Its legs** are the timed lines placed under it (the placement rule above), drawn
  as rail items: time, dot, the line as printed, a tickbox. Ticked = done: filled
  and struck. NOT HAPPENING stays, once per window, quiet. A done window folds.
- **RIGHT NOW on a window** reads a leg: a leg holds from its time until the next
  leg's time or its tick, whichever comes first; outside every leg, the next one
  not ticked (the owner, 2026-09-29: "I trust you"). The legs run on across windows
  printed one after another, so CLD's last leg hands over to ABS's first. The band
  gives the window's label, the leg's time big (with its `*`), "in 6 min" or "now",
  the line verbatim and "Then" the next leg, or the next real stop. A window with no
  legs left (or none at all, like Dispatch) says its label and "Until 7:30a" /
  "From 6:00a to 7:30a". The app never ticks and never computes a starred time.
- **The driver edits and adds legs** (the owner: "so that they can edit and add
  stops with check boxes"), through the patch log like any row. The server serves
  the notes as rows (`lines`: `n0`, `n1`... dispatch's non-blank lines, trimmed;
  `printed` = dispatch's words, `line` = what shows), and `driverNotes` stays as
  printed. A leg is corrected as one field, `line` (its time first, then its
  words); the target is the line's own words with the sibling guard, never its
  position, so a line added above moves nothing. A later sheet that rewords the
  line but keeps its printed time still binds when exactly one line has that time,
  and the driver sees both (KEEP MINE / USE THE SHEET); otherwise it orphans.
  Tap a leg's words: TIME + WHAT, dispatch's line shown, SAVE / USE DISPATCH'S /
  NOT HAPPENING. The driver's shows with the ink dot and "you set 7:40a · dispatch
  printed 7:45a*", and RIGHT NOW and placement run on it. One correction per leg (a
  second replaces the first). "+ ADD A LEG" (per window) writes an `addLeg` patch,
  YOURS, placed among dispatch's by its time; REMOVE takes it back. NOT HAPPENING
  is a ghost with UNDO; a removed leg leaves RIGHT NOW and the route. A tick stays
  keyed by dispatch's words, so it survives the driver's edit. Lines under a
  real stop (334184) get the same controls.
- **The list card** names windows by their label, commas between windows in a row
  ("CLD Shuttle, After Breakfast Shuttle → MGW → NCA"), a "2 SHUTTLES" chip for
  windows labelled shuttle, and "6 legs in the notes".

## Places and airlines every driver gets (the owner, 2026-10-01, v64)

The first tester's Places were empty. The owner: "CLS and CLN will always be the same
for everyone, so if I set it he shouldn't have to. But if he goes to a new spot, like a
new doctor, when he adds the address we should see it to decide if it is baked into the
app. Same for airlines."

- **The keeper.** One list is the keeper's: the one whose push topic is the
  `FEEDBACK_TOPIC` secret (the owner's). No new secret, no login. With the secret
  unset nothing is shared, suggested or pushed.
- **Everything of the keeper's is everyone's** (the owner's choice over a switch per
  place): its Places and Airlines are the catalog, one KV record (`shared:catalog`),
  rewritten whole from the keeper's list whenever it saves or removes one, and made
  from the list on the keeper's first read if it does not exist yet. GET
  /api/assignments carries it as `shared` for every list (+1 read).
- **A list's own wins.** Places: own, then every driver's, then the sheet's. Airlines:
  own, then every driver's, by name. Every driver's are never copied into a list; a
  driver's EDIT makes that list's own. The catalog's airlines fill and track flights
  like a list's own (import, cron, removal). A run imported before the catalog learned
  an airline is tracked on the list's next read, once per change of the catalog's
  airlines (`sharedseen:<list>`, the list's own key: a read never rewrites the list).
- **What a driver adds is a suggestion.** A place saved or an airline taught on any
  other list is kept for the keeper (`shared:suggestions`: kind, code, name, address,
  the list's tester id, never its code) with one quiet push naming only the code.
  Not suggested: exactly what the catalog has, the same thing twice, a thing already
  answered, a removal. At most 100 wait.
- **The keeper's review is in its own app**: Settings shows "1 NEW" on Places or
  Airlines, and the page lists ADDED BY OTHER DRIVERS with ADD FOR EVERYONE (an ordinary
  save on the keeper's list, which is what shares it; "USE THIS FOR EVERYONE" when the
  keeper has that code, with the keeper's own said) or DISMISS (POST /api/suggestions,
  through the outbox; any other list is refused). Either way it does not come back.
  The app never adds one by itself.
- **Drivers are told** in the guide that a place or airline they add is sent to the
  person who looks after Curbside: the code, name and address, not who they are.

## Settings (the owner, 2026-10-01, v64)

A short menu, "clean and concise": cards of rows, each with what is set now under its
name, each opening its own page (Messages, Maps, Places, Airlines, List code and
alerts, Finished runs, the guide, feedback). Theme stays on the menu: three buttons
are quicker than a page. The version is the menu's last line. Back closes one page.

In MESSAGES, on the day of the run, one line says why WHATSAPP and TEXT open an empty
chat (the first tester took it for a fault). Since v65 the run's own page says it too,
once, above the stops, on the run's day; since v67 only until the run starts (under
way, the page is for driving; the call list keeps the line).

**v67 (2026-10-04, the design audit's suggestions the owner picked, 1 to 7 less 5):**
- An airport stop's head is its name. The printed address wrapped the head and put
  the stop's times on a line of their own; it shows there only when a re-sent sheet
  changed it, beside the old one struck. Maps is given the airport by name.
- The list card's last line starts with the run's number (`#369736 · 2 passengers ·
  SIENNA 70011`), as import lines and dispatch name it; a run removed from this phone too.
- Paused flight checks on the list are a bar like the others (alert icon, `FLIGHT
  CHECKS PAUSED`, `UNTIL FRI 16 OCT` in red). Its tap opens List code and alerts, where
  the lookups left and what running out means are said. A run's page keeps the sentence.
- The route's pick list names the car's lot once, under THE CAR.
- Suggestion 5 (the edit controls behind one menu per row) is designed with the
  passenger card, from a mock.

**v65 (2026-10-02, the owner's "do it all" of the idea list):**
- The list card says what only Curbside knows: the run's arriving flight furthest off
  schedule, 5 min or more (`UA1503 26M LATE`, blue = moved; a departure never, since a
  late one moves no check-in), and `N TO MESSAGE AGAIN` (red) for people messaged before
  their plan changed, each once. Neither once the run has ended.
- Places, on the keeper's phone: SHARE on a sheet's place (and SHARE ALL N WITH EVERY
  DRIVER) makes it his own as printed, so it reaches every driver; EDIT first when the
  sheet's words are short of what Maps needs.
- Save a copy (YOUR LIST): a JSON file of the runs as last loaded (with corrections),
  the list's settings, and this phone's message words, name and greetings. Built on the
  phone from its saved copy: no server cost, works offline. Never the list code or the
  topic. The share sheet when the phone can take a file, else a download.

## Route in Maps (built 2026-09-29)

The owner's idea: drivers know a shuttle's route, but an airport or medical run
wants "a button that automatically builds the entire route in maps". One bar per
run, under RIGHT NOW: ROUTE IN MAPS, the count ("2 STOPS LEFT"), and under it the
stops Maps will get ("From where you are → LGA Terminal B → FKL Fishkill, in
dispatch's order").

- **The stops first (v62, the owner 2026-09-30):** a tap opens a sheet listing
  exactly what Maps will get, with APPLE MAPS and GOOGLE MAPS at its foot (the last
  one used is marked, kept in `fw_maps`). "Don't show the stops again: go straight
  to Maps" (`fw_maps_direct`) makes the tap open Maps directly; Settings → Routes →
  Maps changes the app and turns that off. A stop with no address always shows the sheet.
- **The driver's route (v62):** in the sheet the driver moves a stop up or down,
  leaves one out (ADD BACK returns it), adds one (the car's lot, their places, the
  sheets', an airport), starts somewhere other than the phone's location (CHANGE),
  or sends NEXT STOP ONLY. Kept on this phone for that run until it ends
  (`fw_routes`, by number; a run the phone no longer holds takes its route with it),
  marked YOUR ORDER / "· YOURS" on the bar; DISPATCH'S ORDER drops it all, and undoing
  every change by hand is dispatch's order again. Only what Maps is given changes:
  the run keeps dispatch's order (a navigation choice, not a correction, so not
  synced). Stops are keyed (`s:<_at>`, `l:<leg key>:<code>`, `lot:<code>`,
  `p:<code>:<id>` for added ones); a stop dispatch adds later goes in after the stop
  it follows on the sheet, and stops behind the driver drop out as before.
- **The car's lot (the owner, 2026-09-30):** a parking space whose prefix the owner
  named says where the car waits, which is where the run starts: `FKL-NBD…` is NCA,
  Newburgh Center A, 1292 NY-300, Newburgh, NY 12550 (the space's letters read
  Fishkill; the importer's `originCode` says FKL and is wrong for these). The first
  stop's vehicle line says "collect at NCA", and until the run is under way the route
  starts with NCA ("the car"). A built-in table (`CAR_LOTS`), read when shown, never
  written into a run; the list's own place for the code wins over its words. Only
  prefixes the owner has named: never guessed.
- **Which stops:** dispatch's order, never optimised; the phone's location is the
  start. Before the run starts, all of them; once it has, the stop RIGHT NOW and
  the rest. A window adds nothing itself: its legs' codes do, in the order printed,
  from the leg RIGHT NOW reads (ticked legs and legs it has moved past drop out).
  A leg's codes are its three-capital words that are not words ("ALL") or a
  window's code, plus any code the list knows. The same code twice in a row is one stop.
- **What Maps is told:** the list's own place for the code; else the sheet's place
  and address; an airport by its full name, plus the live terminal when every
  flight there has the same one.
- **A code with no address** holds the Maps buttons: the bar says "SGA NEEDS AN
  ADDRESS" and which codes are missing; in the sheet the stop has ADD (the place
  form for that code) and can be left out instead.
- **Links:** Google `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=a%7Cb&travelmode=driving`
  (9 waypoints + the destination: over that, the next 10, and the line says so;
  `origin` only when the driver chose a start);
  Apple (iOS 18.4+) `https://maps.apple.com/directions?source=…&destination=…&waypoint=…&mode=driving`,
  no stated limit (`source` likewise). The same place twice in a row is told once.
  Opened in a new window, as WhatsApp is.

**Places** belong to the list (every phone on it) and the drivers add them:
Settings → Routes → Places: YOURS (EDIT, + ADD A PLACE) and FROM DISPATCH'S SHEETS
(every printed stop with an address, not an airport, in the newest print's words;
EDIT makes the driver's own, used instead). A place is a code, an optional name
and an address. Stored in the list's settings (`places`), written one at a time by
`POST /api/places` (upsert or `remove` by code; 1 get + 1 write; 200 at most),
through the outbox like an edit, so it works offline and two phones adding
different places never overwrite each other. The owner's own places are entered
by the owner in the app, never in the repo.

**Import what is understood; hand the rest to the driver.** An unknown airline, an
excluded row type, a date that disagrees with the document's stated end date — all
reported, never guessed. A confidently wrong pickup time is worse than an obvious
gap.

**Fixing what could not be read, and learning from it (v62, the owner
2026-09-30).** The run's "I could not read" lines tie a flight line (unknown
airline, no flight number, no airline) to its passenger: FIX opens that
passenger's flight; once the row has a flight the line says whose (✓ WS1680 ·
yours, or · learned) and the card's TO CHECK counts only what is still open. For
an unknown airline the importer now keeps what it printed on the row,
`unknownAirline: {name, number, date}` (the date pinned like `flightDate`). Fixing such a flight offers, ticked,
"Remember WestJet is WS": the list learns the code (`settings.airlines`, by name
compared as the importer's table does; `POST /api/airlines`, one per call, upsert
or `remove`, 100 at most, through the outbox like places). Every sheet naming that
airline then gets its flights filled in when read, `flightNumber` = code + the
printed number, marked `_learned` (LEARNED beside the number): applied after the
corrections, so a driver's own number for a row, even a blank, always wins; never
written into the stored run, so dispatch's copy and the "what changed" diff are
untouched. The server applies it on GET and cron (pushes name the learned flight),
tracks the learned flights at import and when the airline is learned, and untracks
them with their run; the phone applies the same rule at once, offline too, and
takes it back when an airline is forgotten (Settings → Routes → Airlines, FORGET).
Learning is the driver's act, marked as such: the app never guesses a code.
WestJet (WS), from the owner's sheet, is also in the importer's table now.

## What the department manuals say

Read on 2026-09-16 (department guidelines, scheduling, dispatch, HuB essentials,
office skills) on the unmerged `spec/curbside` branch; carried over here on
2026-09-29, corrected where the sheets or later decisions disagree. Facts about
the work, not app behaviour unless it says so.

- **GBA / GBD are Governing Body arrivals and departures.** The branch read GBA as
  "Governing Body Assistant"; the owner's 188 real runs say otherwise: all 13 GBA
  pickups are at an airport and all 13 drop-offs at home, exactly like `A`; all 15
  GBD pickups are at home and drop-offs at an airport, exactly like `D`.
- **Curbside is permitted for GB** (and Helpers, and BC when requested): "The
  driver should always try and park first... Exceptions: ... for members of the
  GB, Helpers, or BC (if specifically requested)." So a GB pickup may genuinely be
  the curb; the app must not assume baggage claim.
- **A GB row is never combined without the on-site overseer**: "Never combine
  with other requests without consulting on-site overseer."
- **GB notifications go up, not down.** HuB's "for a GB member select NO
  NOTIFICATIONS" is a setting on the passenger's record (HuB stops emailing
  them); for the driver a GB change is louder (built: one notification level up).
- **Combining has written thresholds.** Same site: flights about 45 minutes
  apart. Different sites: when travel times are not hurt. Older passengers should
  not wait more than 15-20 minutes, nor be asked to wait for a combination.
  Not built; a combo outside the guideline could be flagged, never re-planned.
- **Dispatch's time can be a deliberate exception.** Scheduling records a
  recommended (RDT) and the passenger's preferred departure time (PDT); a PDT
  shorter than the RDT is agreed with the requester and assigned anyway, and for
  GB/Helpers/BC the PDT is never changed. Why the app's numbers sit *beside*
  dispatch's, never over them (the app converts, it does not plan).
- **Check-in leads are 2 h domestic, 3 h international** (TSA Pre-Check's 1.5 h
  and 2 h apply only to passengers who hold it: 4 of 186 sheets mention it).
  Built as 120/180; an early build shipped the Pre-Check pair.
- **Vehicle priority**: GB / Helper / BC first, then Passenger Transportation,
  then Batch, then Medical Services, then other departments. Context only.

HuB's full request-type list (LOCAL, TAXI, GBM, GBO, GBV, SCF, TA, PO beside the
tags the importer reads) was drafted on PR #22 for the old Python importer and
closed on 2026-09-29: none of those tags appears on the owner's 188 sheets. The
branch `fix/hub-request-types` keeps it for the day one does.

## The name

**Curbside.** The owner's own reasoning: curbside is the pickup drivers prefer and
the guidelines discourage — park first, meet the passenger inside at baggage
claim. It is the simple path, the one that skips the parking and the walk. The app
does the same thing to a complicated email.

Noted so nobody is surprised: the department manual explicitly steers away from
curbside pickups. If this is ever shown to oversight, the name invites the
question. That may be the point.

The rename touches the manifest, the service-worker cache name, the title, the
icon and the theme color — cheap now, less cheap once other drivers have it
installed.

**As built (2026-09-26):** the title, the home-screen label (`apple-mobile-web-app-title`,
`application-name`), the manifest's name, short name and description, and its colours
(`#0E1B30`, the night page) say Curbside. The icon is still the old plane and goes to
the design pass. The repo, the worker and the Pages project keep the FlightWatch name.

## Explicitly not doing

- **Rebuilding dispatch.** Oversight has a system. This app answers "what do I do
  next", not "who should drive what".
- **Email ingest automation.** Considered and declined — no email infrastructure,
  no parser in production, no email-as-a-write-path.
- **Version history.** "This changed" only.
- **Undo on step taps** — tapping another dot is the undo — **or on re-imports**,
  which the edit overlay already protects against.

## Open

- `TD` (train) and `HO` (embassy/consulate) rows remain excluded and reported.
- Other action verbs beyond Pickup/Drop-off exist and are not yet enumerated.
- ALB, BDL, HPN and SWF have no drive time from any site — they never appear in
  the sample and must come from the department's own table, not a guess.
- Warwick's address differs between the owner's table (40 Kings Dr, Tuxedo Park)
  and the assignment documents (`WRK ... Warwick | 1 Kings Drive`). Unresolved,
  and not to be reconciled by guessing.
