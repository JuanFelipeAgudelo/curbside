# Reading dispatch's assignment sheet

Dispatch sends each run as a PDF, around 5 PM for the next day, by Outlook. This is what every part
of the page means and how Curbside turns it into a run (the shape in `assignment.schema.json`).
Built in `public/importer/sheet.js` and `public/importer/airlines.js`; proven identical to the
original reader on 252 of 252 of the owner's real sheets. **Anything uncertain is reported, never
guessed: a confidently wrong pickup time is worse than an obvious gap.**

## The page, top to bottom

From sample 369736 (names and numbers made up):

```
 Assignment number    369736                         Driver               Reyes, Mara
 Start date and time  Monday, August 31, 2026 9:30 PM   End date and time  Tuesday, September 1, 2026 3:00 AM
 Vehicle              Branch (72398) 2020 Toyota Sienna (7 Seats)   Parking space   FKL-NBD-003
 Driver notes         LGA pickup. Take arriving passengers to WKL

 FKL            ETA:            ETD: 9:30 PM     Fishkill | 33 Vaughn Way
 (Unavailable)  8:00 AM                          Late Runs Driver from 8/31/2026 8:00 AM to ...
 LGA            ETA: 11:00 PM   ETD: 12:00 AM    LGA LaGuardia | Grand Central Parkway Flushing, NY 11371
     Pickup:                                              Baggage Claim
                Passenger      Origin          Destination   Information                              Bags
                Jonas, Ana     LGA LaGuardia   Wallkill      Airline/Flight: United Airlines UA1503    0
          A     Phone:
                +1 555-0100-000                               Time/City: 11:15 PM Houston, Texas (IAH)
 WKL            ETA: 2:15 AM    ETD: 2:15 AM     Wallkill | 900 Red Mills Rd.
     Drop-off :                                           A Front
                ...
 FKL            ETA: 3:00 AM    ETD:             Fishkill | 33 Vaughn Way

 Monday, August 31, 2026 7:18 PM                                                 Page 1 of 1
```

## The run

| Field | From | Rule |
|---|---|---|
| `number` | "Assignment number 369736" | The run's identity (`rules/resent-sheets.md`). |
| `driver` | "Driver Reyes, Mara" | As printed, "Last, First". |
| `start`, `end` | "Start date and time" / "End date and time" | Written `YYYY-MM-DD HH:MM`, 24-hour, New York wall clock. The AM/PM can wrap onto the next line. `start` is dispatch's leave time for the run; `end` is back at the start site. |
| `vehicle` | "Vehicle ..." up to the next column | As printed, e.g. "Branch (72398) 2020 Toyota Sienna (7 Seats)". The sheet often wraps it, so the tail can be cut ("(8"). The branch number in brackets is what the driver goes and finds. |
| `parking` | "Parking space ..." | As printed, e.g. "FKL-NBD-003". |
| `originCode` | the parking space | Its first three letters when it looks like `ABC-...` (FKL), else null. Where the day starts; but see the car's lot (`rules/places-and-routes.md`): `FKL-NBD` really starts at NCA. |
| `driverNotes` | "Driver notes" and the lines under it | Continuation lines are those indented under the label's column (up to 6 characters less). It ends at a line starting Assistant, Passenger or (Unavailable), at any line with ETA: or ETD:, or after 3 blank lines. Blank lines inside are dropped. Kept as printed. |
| `assistants` | the Assistant / Role / Notes table | One per row, `{name, role, note}`; a name looks like "Last, First". Ends at a blank line or a stop. |
| `printedAt` | the footer "Monday, August 31, 2026 7:18 PM  Page 1 of 1" | The **last** footer on the document, `YYYY-MM-DD HH:MM`. Decides which copy of a re-sent sheet wins. Null when there is none. |
| `gb` | the rows | True when any passenger row is tagged GBA or GBD. |
| `issues` | everything above and below | What could not be done, in words, each once. |

## Stops

A stop is a line with **ETA:** and a **|** on it: `<label>  ETA: <time>  ETD: <time>  <place> | <address>`.

- `code`: the label when it is 2 to 5 capitals (WRK, LGA, ABS), else null (a free-text stop such as
  "Taxi 1", "Dispatch", "Enterprise Rent A Car").
- `place`: the text before the `|` (else the label). `address`: after it, or null.
- `eta`, `etd`: as printed, "11:00 PM"; either can be blank (the first stop has no ETA, the last no ETD).
- **Lines starting "(Unavailable)" are the driver's own calendar, not stops.** Skip them.
- **Dates walk forward from the start date:** read the stops' times in order (each stop's ETA, then its
  ETD); whenever a time is earlier than the one before it, the date moves on a day. `etaDate` is the
  ETA's date, `date` the ETD's (the stop's order on the run). With no ETA, `etaDate` = `date`; with no
  ETD, `date` = `etaDate`. LGA in 369736 is reached at 11:00 PM on the 31st and left at 12:00 AM on the 1st.
- If the last stop's date is not the sheet's end date: issue *"last stop date disagrees with the
  document's stated end date -- check the multi-day rollover"* (sample 361028). Keep the walked
  dates; never "fix" them.

## Doors (actions)

A line `Pickup: <where>` or `Drop-off : <where>` (a space before the colon happens) under a stop.

- `verb`: "Pickup" or "Drop-Off" as the sheet's words in title case. Other verbs may exist: do not
  assume a closed set.
- `where`: the door ("Baggage Claim", "A Front", "Customs Exit"), or null when dispatch left it blank
  (24 times in the sample; sample 341156 has none on one action).
- An action holds the passenger rows under it, up to the next action or stop. A stop can have several
  actions with the same verb, one per door (369736 drops one passenger at A Front, one at B Carport).

## Passengers (entities)

A passenger row is a line with an Information label: `Airline/Flight:`, `Route:`, `Appointment time:`
or `Arrival time:`. **A passenger is printed once under each stop they take part in** (at the airport
pickup and again at their own drop-off): both are the work, never duplicates. Only de-duplicate
within one door.

| Field | Rule |
|---|---|
| `name` | The first cell, as printed: "Jonas, Ana". Must look like "Last, First" (letters, then a comma). A row whose name cannot be read is an issue: *"a passenger row whose name could not be read (line N): check the sheet"*, and the row is left out. |
| `tag` | The narrow column within the first 30 characters of the row's line, or up to 3 lines below it, or the line above: `GBA`, `GBD`, `MED`, `HO`, `TD`, `A`, `D`, `S`. |
| `gb` | Tag starts with GB. |
| `origin`, `destination` | The two cells just before the Information cell. **They beat the stop the row sits under**: a row appears under both its pickup and its drop-off, so the enclosing stop is right only half the time (sample 340343). |
| `phone` | After `Phone:` in the row's lines (up to the next named row): a number of at least 9 characters, `+` and digits with `-`, `(`, `)`, `.` or spaces. Null is common (61 of 411 in the sample; 29 had the label printed with nothing after it). |
| `bags` | The number at the end of the row's line (the Bags column). |
| `note` | After `Notes:` in the row's lines. |
| `scheduledText` | After `Time/City:`: "11:15 PM Houston, Texas (IAH)", the flight's printed time and city. |
| `appointmentTime` | After `Appointment time:` or `Arrival time:` ("9:30 AM"). |
| `duration`, `route` | After `Duration:` / `Route:`. |
| `flightNumber` | From the `Airline/Flight:` cell: see Flights. Null when it cannot be resolved: never guessed. |
| `flightDate` | See Flights. |
| `unknownAirline` | When the airline is not in the table: `{name, number, date}` as printed, so a code the driver teaches later can fill it. |
| `unsupported` | `train` for TD rows, `embassy/consulate` for HO rows (see Excluded rows). |
| `otherPhones` | A party's other members' numbers, when they differ. |
| `pax` | 1, or the party's size. |

### Parties

Rows under one door are **one party when they share the surname (in any case), the same flight text
(the first 40 characters of the Airline/Flight cell) and the same drop-off door** (the door of the
drop-off they appear under). A different door or a different flight keeps them apart, always.

- `name`: "Hauser, Marcus & Vera"; three or more: "Warner, Ana, Dana & Noor". The surname is the
  first member's as typed; the given names in one order (sorted, ignoring case) at every stop.
- `pax`: how many; `bags`: the members' bags added up (each person once); `phone`: the first number,
  the rest in `otherPhones`.
- A couple typed one in capitals ("WOODHAM, JOHN" and "Woodham, Mary") is still one party (v67.1).

### Flights

The `Airline/Flight:` cell, with the Bags number at its end removed:

1. "Non-flight pickup..." → no flight, and **no issue** (dispatch's way of saying no flight is behind
   it; sample 356385).
2. A two-character code written in: "United Airlines UA1503", "Lufthansa LH7603" → that code and the
   number: UA1503, LH7603.
3. Else an airline name and a number: "Southwest Airlines 748" → the name through the airline table →
   WN748.
4. **An airline not in the table** → no flight number; issue *"Owens, Dana: could not resolve
   'Volaris' (unknown-airline)"*, and `unknownAirline` kept. **No number** at all → issue
   *"...(no-flight-number)"*.
5. A codeshare, "Delta 1234 or AF 5678" (the alternate may wrap onto the next line): the alternate
   whose code begins the main number, else the last alternate; here AF5678.

The number is written without leading zeros (UA0995 → UA995).

**The flight's date is the day it operates at its airport**, not the day of the stop the row sits
under: for an arriving row (A, GBA) the ETA date of the stop whose code is the row's Origin; for any
other the ETD date (`date`) of the stop whose code is the row's Destination; else the enclosing
stop's `etaDate`. A passenger's drop-off can fall on the next day; keying on it tracked one flight
twice, on two dates.

The airline table (a closed set, from every airline in the sample; a code taught later is added):

| Name as printed | Code |
|---|---|
| Aero Mexico | AM |
| Air Canada | AC |
| Alaska Airlines | AS |
| American Airlines | AA |
| Arajet | DM |
| Asiana, Asiana OZ | OZ |
| British Airways | BA |
| Caribbean (Caribbean Airlines) | BW |
| Cathay Pacific Airways | CX |
| Delta, Delta Air Lines | DL |
| EVA Airways | BR |
| Finnair | AY |
| JetBlue, JetBlue Airways | B6 |
| Korean Air, Korean Air Lines | KE |
| Lufthansa | LH |
| Porter Airlines | PD |
| Qantas Airways | QF |
| Singapore Airlines | SQ |
| Southwest Airlines | WN |
| Sun Country | SY |
| Turkish, Turkish Airlines | TK |
| United Airlines | UA |
| WestJet | WS |

Names are matched ignoring case and extra spaces.

### Excluded rows

`TD` (train) and `HO` (embassy/consulate) rows are not supported yet (about 1% of rows). They are
**kept and shown** with `unsupported`, with the issue *"HO row not yet supported: Diaz, Tess"*, and no
flight or bags are read for them. A run whose rows are all excluded still appears (sample 366824).

## Refused, with the reason

| Reason | When | What the driver is told |
|---|---|---|
| `not-pdf` | not a PDF file | *Not a PDF* |
| `unsupported` | encrypted, or a font or compression the sheets never use | *A locked or unusual PDF* |
| `picture` | a PDF with no text in it (a scan, a photo) | *A picture, not text* |
| `not-a-sheet` | no "Assignment number" / start-and-end header | *Not an assignment sheet* |
| `unreadable` | a date or time that cannot be read | *A date or time can't be read* |
| `too-big` | more than 75 MB in one stream or 150 MB in all | *Couldn't read this sheet* |

**PDF only.** A photo or screenshot is pixels: misread digits give wrong times and flight numbers,
and sending it to a vision service sends names and phones to a third party.

## Three ways to read it in the department

| Way | What runs | Exact? | Needs |
|---|---|---|---|
| **A. Azure Function** | this reader, `public/importer/` unchanged (plain JavaScript, no dependencies) | Yes: the same code | Azure Functions (Node.js), a custom connector (`azure-functions.md`) |
| **B. A skill with scripts** | the original Python reader (git tag `python-importer-last`: `tools/import_assignment.py`, `tools/airlines.py`, with pypdf 6.18.1 packed in) in Copilot Studio's GitHub Copilot harness sandbox (Python 3.12, no network) | Yes, if pypdf runs there; that copy also needs v67.1's surname-case fix | The GitHub Copilot harness (usage billing); not tried |
| **C. AI extraction** | a prompt with a document input and JSON output, or a workflow's Extract node, given this file and `assignment.schema.json` | **No**: approximate | A flow (a prompt with a document input cannot be an agent tool); 8 Copilot Credits a page |

The owner's choice (2026-10-23): the kit describes B; it is built only if picked later.

**With C, the driver confirms every sheet** before it becomes their run: show what was read beside
the PDF, and refuse to save a reading that fails the checks below. And never use C on photos.

## Judging a reading: the 15 samples

`samples/<name>.pdf` is a scrubbed fixture made into a PDF (`tools/make-pdf.mjs`); `samples/<name>.json`
is exactly what this reader makes of that PDF (`tools/kit.mjs` writes both; `worker/src/kit.test.ts`
proves they agree, and agree with the fixture's own answer). A reading passes a sample when:

- `number`, `start`, `end`, `printedAt`, `parking`, `gb` are equal;
- the stops are the same, in order, each with the same `code`, `place`, `eta`, `etd`, `date`, `etaDate`;
- the doors are the same, in order, each with the same `verb` and `where`;
- the passengers are the same, in order, each with the same `name`, `pax`, `tag`, `gb`, `phone`,
  `bags`, `flightNumber`, `flightDate`, `origin`, `destination`;
- **a null stays null**: no flight number, phone or door where the answer has none;
- `issues` say the same things (wording may differ);
- text compared with runs of spaces counted as one (`driverNotes`, `vehicle`, `route`, `where`).

Known quirks of the reader, which an AI reading need not copy: a shuttle row's `route` keeps the Bags
number at its end ("Warwick > Patterson      0"); `driverNotes` and some doors keep the page's wide
spacing.

| Sample | What it tests |
|---|---|
| 334184 | a timed itinerary in the notes; shuttle rows (tag S) with routes; an assistant |
| 339460 | a shuttle with named passenger rows |
| 340343 | a row's Origin/Destination beat the stop it sits under; a departure (AF5) |
| 341156 | a door left blank; a free-text stop (Enterprise Rent A Car) |
| 348400 | departures and arrivals at one stop; a code written in ("Lufthansa LH7603"); parties |
| 350568 | an HO row (excluded, issue) beside departures; a row with no phone |
| 352711 | a Governing Body arrival (GBA), international (TK1); an airline needing the table |
| 353328 | prose notes in paragraphs; a run with one stop |
| 356385 | a non-flight pickup (no flight, no issue); a party of three; per-row notes |
| 361028 | windows (no address, nobody on them); the last date disagrees with the end (issue) |
| 366222 | stops with addresses and nobody on them (stops, not windows) |
| 366824 | every row excluded (HO): the run must still appear |
| 369736 | a combo: two flights at LGA, dropped at two doors; a stop across midnight |
| 373621 | a dispatch shift with no vehicle |
| 375126 | the print time wraps in the middle |

**A real sheet is never a sample.** Real sheets carry passengers' names and numbers; anything uploaded
as knowledge is readable by everyone who talks to the agent.
