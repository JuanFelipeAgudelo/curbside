# Words Curbside uses

| Word | Means |
|---|---|
| **Run** / **assignment** | One job from dispatch, under one assignment number: its stops in order, with times, doors and passengers. |
| **Sheet** | Dispatch's assignment PDF for a run. |
| **Stop** (step) | A place and a time on the run: WRK Warwick, LGA LaGuardia. |
| **Door** (action) | What happens at a stop and exactly where: Pickup at Baggage Claim, Drop-off at A Front. |
| **Passenger row** (entity) | Who, and what they travel on. A **party** is several people on one row: same surname, same flight, same drop-off door ("Hauser, Marcus & Vera"). |
| **ETA / ETD** | Dispatch's arrive and leave times for a stop. The first stop has no ETA, the last no ETD. |
| **Leg** | Dispatch's drive time between two stops: one stop's ETD to the next one's ETA. Also: a timed line of a shuttle's notes. |
| **Parked by** | The app's time to be in the airport's lot: the earliest obligation at the stop (`two-clocks.md`). |
| **Leaving at** | The app's time the last passenger is out: the latest landing plus bags (and customs). |
| **Check-in deadline** | 2 hours before a domestic departure, 3 before an international one. |
| **Tags** | The row's type: `A` arrival, `D` departure, `GBA` / `GBD` Governing Body arrival / departure, `MED` medical, `S` shuttle, `TD` train, `HO` embassy or consulate. |
| **GB** | Governing Body. Double margin before landing (30 min), louder alerts, never combined without the on-site overseer. |
| **Window** | A printed stop with no address and nobody on it: a shuttle or a duty (CLD Shuttle, Dispatch, Taxi 1). |
| **Not coming / not happening** | The driver's mark for a no-show or a cancellation. Never deleted; undo any time. |
| **YOURS** | Something the driver added. |
| **Orphan** | A driver's change that a re-sent sheet left with no row to land on. Kept and shown, never moved. |
| **Contested** | The new sheet says something else than when the driver made their change: both shown, the driver chooses. |
| **Printed at** | The sheet's footer time: the newest printed copy is the run. |
| **HuB** | The department's back-end system (travel-time table, request types). |
| **Site codes** | WRK Warwick, FKL Fishkill, WKL Wallkill, TUX Tuxedo Property, NCA / NCB Newburgh Center A / B; airports EWR, JFK, LGA, SWF, HPN, ALB, BDL. |
| **Lookup** | One check of a flight with the flight data service. Lookups cost money; see `flight-checks.md`. |
