# Alert examples (generated)

Written by `node tools/kit.mjs` from the app's own `noticeFor` (`worker/src/notify.ts`) on the
sample runs; `worker/src/kit.test.ts` fails if they drift. Do not edit by hand. The rules behind
them are in `rules/alerts.md`. In Teams the flow may add the passenger's name on a line of its
own (the owner, 2026-10-23); the code's own wording names none.

## WN748 slips from 11:20p to 11:52p; it is 8:00p, before the driver leaves

Run 369736, LGA.

- **Title:** Wait 32 minutes longer at LGA
- **Line:** WN748 now lands 11:52p · leaving 12:37a, dispatch planned 12:00a · still parked by 11:00p
- **Line:** LGA pickup · WN748
- **Priority:** 3 (default)

## UA1503 moves earlier, from 11:15p to 10:50p; it is 8:00p

Run 369736, LGA.

- **Title:** Leave 25 minutes earlier
- **Line:** UA1503 now lands 10:50p · leave by 9:05p, dispatch planned 9:30p
- **Line:** LGA pickup · UA1503
- **Priority:** 5 (urgent)

## UA1503 slips from 11:15p to 11:45p, past WN748; it is 8:00p

Run 369736, LGA.

- **Title:** Leave 5 minutes later
- **Line:** UA1503 now lands 11:45p · leave by 9:35p, dispatch planned 9:30p
- **Line:** Wait 25 minutes longer at LGA · UA1503 now lands 11:45p · leaving 12:30a, dispatch planned 12:00a
- **Line:** LGA pickup · UA1503
- **Priority:** 3 (default)

## UA1503 is cancelled; it is 8:00p

Run 369736, LGA.

- **Title:** Call dispatch — UA1503 cancelled
- **Line:** dispatch planned LGA 11:00p
- **Line:** LGA pickup · UA1503
- **Priority:** 5 (urgent)

## UA1503 lands at 11:12p, belt 5, terminal B; the driver is parked

Run 369736, LGA.

- **Title:** Call your UA1503 pickup — landed
- **Line:** on the ground 11:12p · Belt 5 · Terminal B
- **Line:** Meet at Belt 5 — UA1503
- **Line:** LGA pickup · UA1503
- **Priority:** 4 (high)

## UA1503 lands early, at 10:40p, while the driver is on the road

Run 369736, LGA.

- **Title:** Call your UA1503 pickup — landed early
- **Line:** UA1503 on the ground 10:40p · 35 minutes ahead
- **Line:** LGA pickup · UA1503
- **Priority:** 5 (urgent)

## UA1503 moves from 11:15p to 11:18p

Run 369736, LGA.

**No alert.** Nothing the driver does has moved by 5 minutes or more.

## Governing Body: TK1 slips from 5:55p to 6:25p; it is noon

Run 352711, JFK.

- **Title:** Leave 30 minutes later
- **Line:** TK1 now lands 6:25p · leave by 3:55p, dispatch planned 3:30p
- **Line:** Wait 30 minutes longer at JFK · TK1 now lands 6:25p · leaving 8:10p, dispatch planned 7:45p
- **Line:** JFK pickup · TK1
- **Priority:** 4 (high), tagged GOVERNING BODY

## UA1068 (a departure) is delayed from 1:55p to 2:40p; it is 9:00a

Run 348400, EWR.

- **Title:** Leave as planned — UA1068 delayed
- **Line:** UA1068 now departs 2:40p · check-in keeps to the schedule
- **Line:** EWR drop-off · UA1068
- **Priority:** 2 (quiet)

## UA1068 moves from terminal A to terminal C; it is 9:00a

Run 348400, EWR.

- **Title:** Drop at Terminal C — UA1068 moved from A
- **Line:** EWR drop-off · UA1068
- **Priority:** 4 (high)
