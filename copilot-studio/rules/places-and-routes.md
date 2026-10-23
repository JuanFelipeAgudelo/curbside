# Places, airlines and the route in Maps

## Places

A place is a **site code** (three capitals: WRK, FKL, WKL, NCA...), an optional name and an address.

- **Where a place's address comes from, in order:** the driver's own place for that code; then the
  department's (everyone's) place; then the sheet's printed place and address.
- Places from dispatch's sheets are listed as such ("FROM DISPATCH'S SHEETS"), in the newest print's
  words; editing one makes it the driver's own.
- **What a driver adds is a suggestion** for the person who looks after Curbside (in the Cloudflare
  app, the owner; in the department, dispatch or an admin role): code, name and address, never who
  sent it. Approved, it becomes everyone's. The app never adds one by itself.
- The airports are built in, by full name for Maps: EWR Newark Liberty International Airport, JFK
  John F. Kennedy International Airport, LGA LaGuardia Airport, SWF New York Stewart International
  Airport, HPN Westchester County Airport, ALB Albany International Airport, BDL Bradley
  International Airport. ALB, BDL, HPN and SWF have no drive times from any site in the sample:
  they must come from the department's own table, never a guess.
- Warwick's address differs between a travel-time table (40 Kings Dr, Tuxedo Park) and the sheets
  (1 Kings Drive): unresolved, and not to be reconciled by guessing.

## The car's lot

A parking space whose prefix the owner named says where the car waits, which is where the run
starts. Only one so far:

| Parking prefix | Lot | Address |
|---|---|---|
| `FKL-NBD` | NCA, Newburgh Center A | 1292 NY-300, Newburgh, NY 12550 |

(The space's letters read Fishkill; the run really starts at NCA.) The first stop says "collect at
NCA". Only prefixes someone has named: never guessed. In the department, a table dispatch keeps.

## Airlines

The sheet prints an airline's name ("United Airlines 1068"); the reader turns it into a flight
number (UA1068) through a closed table (`../reading-the-sheet.md`). **An airline not in the table is
never guessed**: a wrong code makes a real-looking number for the wrong flight. The driver fixes the
flight, and may **teach the airline** ("Remember Volaris is Y4"): every later sheet naming it gets its
flights filled in, marked LEARNED, applied after the driver's own corrections (a driver's own value,
even a blank, always wins) and never written into dispatch's copy. A taught airline is a suggestion
for everyone, like a place.

## Route in Maps

One button per run builds the route in Apple Maps or Google Maps.

- **Dispatch's order, never optimised.** The phone's location is the start. Before the run starts,
  every stop; once under way, the current stop and the rest.
- A window adds its legs' site codes in printed order. The same code twice in a row is one stop.
- What Maps gets for each stop: the place's address as above; an airport by its full name (plus the
  terminal when every flight there has the same one).
- A code with no address holds the buttons: "SGA NEEDS AN ADDRESS", with ADD.
- **The driver may change the route** for Maps (move, leave out, add the car's lot or a place, start
  elsewhere, next stop only). That is navigation, not a correction: the run keeps dispatch's order.
- Links: Google `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=a%7Cb&travelmode=driving`
  (up to 9 waypoints plus the destination); Apple `https://maps.apple.com/directions?source=…&destination=…&waypoint=…&mode=driving`.
