# Alerts: what a flight change says

An alert is the one screen a driver reads without opening anything, often at the wheel. So it says
**what to do**, not what happened: "Leave 20 minutes later", not "UA1503 — Delayed". The flight is
the evidence, on the next line. Built in `worker/src/notify.ts` (`noticeFor`); every example in
`alert-examples.md` is that function's own output on the sample runs.

## When one is written

After a flight check stores a new status, for **every airport stop that meets the flight** (on every
run that names it, with corrections applied), the stop's two clocks are worked out twice: from what
the driver was last told about the flight, and from the new status. What moved is what is said.

Nothing is sent when:

- no clock moved by **5 minutes or more** (estimates drift a minute or two all evening);
- the status changed in a way that moves no clock ("Expected", "En Route", "Departed");
- the stop is more than **3 hours** in the past (`STALE_AFTER_MIN` = 180): it is history;
- the row is marked not coming, or the stop not happening;
- only a gate at the far end of the flight changed.

The **first check** of a flight is compared with its own timetable (`asScheduled`): dispatch planned
the run with the flight on time, so "on time" is what the driver knows. On its timetable (under 5
minutes off, and not cancelled, diverted or down) it says nothing.

## What it says, in order of what wins

| Situation | Title | Priority |
|---|---|---|
| Cancelled or diverted | *Call dispatch — UA1503 cancelled* (diverted: "now landing ...") | 5 urgent |
| Landed before the driver was due to be parked, and the driver should still be leaving | *Leave now — landed early* | 5 |
| Landed early, the driver already on the road | *Call your UA1503 pickup — landed early* | 5 |
| Landed | *Call your UA1503 pickup — landed*, with belt and terminal | 4 high |
| Parked-by moved earlier, before the driver leaves, with dispatch's leg | *Leave 25 minutes earlier* (*Leave now — UA1503 early* when the new leave-by is within 2 minutes) | 5 |
| Parked-by moved later, before leaving | *Leave 20 minutes later* | 3 default |
| Parked-by moved, no leg in the sheet | *Be at LGA 20 minutes earlier / later* | 5 / 3 |
| Parked-by moved earlier, the driver on the road or there | *Park by 10:25p — UA1503 early*, or *Hurry to LGA — UA1503 early* once that time has passed | 5 |
| Leaving moved | *Wait 32 minutes longer at LGA* / *Leave LGA 10 minutes sooner* | 3 |
| A departure delayed (moves nothing) | *Leave as planned — UA1068 delayed* ("check-in keeps to the schedule") | 2 quiet |
| Terminal changed | *Go to Terminal C — UA995 moved from B* (departure: *Drop at Terminal C*) | 4 |
| Belt changed / first known | *Go to Belt 7 — UA1503 moved from 5* (4) / *Meet at Belt 5 — UA1503* (3) | |
| The gate at our airport changed (arrival gate for a pickup, departure gate for a drop-off) | *Expect gate B12 — UA1503 moved from B10* | 2 |

When several apply, **the loudest leads**; the rest ride underneath as extra lines, so nothing is
lost. The last line is always where and which: *LGA pickup · UA1503*.

"Before the driver leaves" = before dispatch's leave-by for the stop (parked-by minus dispatch's
leg), else before parked-by when the sheet has no leg.

## Dispatch's number, always beside

Every time the app computes goes out beside dispatch's for the same thing:
*leave by 9:05p, dispatch planned 9:30p*. Where the driver set their own time, both:
*leave by 9:59p, you set 9:45p, dispatch 9:30p*. A stop the driver added has no dispatch time: it is
quoted as *you set 9:40p*, never as *dispatch planned*.

## Governing Body

A GB stop (the run is GB, or any row at the stop is GBA/GBD) goes **one level louder** (2 becomes 3,
3 becomes 4, 4 becomes 5) and carries the tag **GOVERNING BODY**, which leads the alert. HuB's "no notifications"
setting for GB is about emails to the passenger; passengers never see this app.

## Early is urgent, late is calm

The urgency runs the opposite way from a flight tracker's. A delay **gives** the driver time; landing
early **takes it away**. So an early arrival is the alert that goes out urgent, and delays go out at
the default level.

## Names (the department version)

The Cloudflare app names no passenger in an alert: its topics were public. In Teams a one-to-one chat
is private, and **the owner decided (2026-10-23) that a Teams alert may name the passenger**: add a
line with the row's name as the sheet prints it ("Jonas, Ana"), after the title. Keep the title the
code's own words.

## Sending in Teams

- One message per alert, to the run's driver (and its assistants who use Curbside), from a flow:
  Microsoft Teams connector, *Post message in a chat or channel* or *Post card in a chat or channel*,
  as the Flow bot, in a chat with the user. The Teams admin must allow the Workflows app. Flow bot
  actions are throttled (about 25 per 5 minutes per connection): one connection per few drivers, or
  queue the messages.
- Teams has no sound level per message. A suggested mapping: priority 5 as a card whose first line is
  **URGENT** in bold, 4 as a card, 3 and 2 as plain messages. Check what the tenant's Teams allows.
- Keep what was told: store, per flight, the status the last sent alert was computed from. The next
  change is measured from it, so a slow drift of 2 minutes at a time still adds up to an alert.
- An alert about a run carries the run's number, so tapping it can open that run.

## Test alert

A driver can send themselves a test: *Test alert · Curbside* / "Flight alerts reach this phone. A
real one says which flight moved and your new times." Priority 3, so it sounds like a real one.
