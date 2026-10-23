/**
 * What the push says, on the shape of real assignment 369736: out of Fishkill
 * at 9:30 PM, a two-flight combo at LaGuardia (UA1503 and WN748, domestic),
 * both passengers dropped at Wallkill. Dispatch has LGA at 11:00p-12:00a, so
 * the leg is 90 minutes and the untouched clocks are parked 10:54p, leaving
 * 12:05a.
 *
 *   node --test --experimental-strip-types src/notify.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { clocksFor, noticeFor, stopsFor, type Stop } from "./notify.ts";
import type { Assignment } from "./assignment.ts";
import type { FlightStatus } from "./types.ts";

const ET = "-04:00";

function at(hhmm: string, day = "2026-08-31"): number {
  return Date.parse(`${day}T${hhmm}:00${ET}`);
}

function status(fn: string, arr: string, o: Partial<{
  status: string; terminal: string | null; belt: string | null; gate: string | null;
  dep: string; depZone: string; day: string; depDay: string;
}> = {}): FlightStatus {
  const day = o.day ?? "2026-08-31";
  const local = (t: string, d: string) => `${d} ${t}${ET}`;
  const utc = (t: string, d: string) => new Date(Date.parse(`${d}T${t}:00${ET}`)).toISOString();
  const dep = o.dep ?? "20:00";
  const depDay = o.depDay ?? day;
  return {
    flightNumber: fn,
    date: day,
    status: o.status ?? "Expected",
    airline: null,
    departure: {
      airport: "Origin", airportCode: "IAH", timeZone: o.depZone ?? "America/Chicago",
      scheduledTime: local(dep, depDay), estimatedTime: local(dep, depDay),
      scheduledTimeUtc: utc(dep, depDay), estimatedTimeUtc: utc(dep, depDay),
      terminal: null, gate: null, baggageBelt: null,
    },
    arrival: {
      airport: "LaGuardia", airportCode: "LGA", timeZone: "America/New_York",
      scheduledTime: local(arr, day), estimatedTime: local(arr, day),
      scheduledTimeUtc: utc(arr, day), estimatedTimeUtc: utc(arr, day),
      terminal: o.terminal ?? "B", gate: o.gate ?? null, baggageBelt: o.belt ?? null,
    },
    fetchedAt: "",
  };
}

/** Move the estimate only; the schedule stays where it was. */
function moved(s: FlightStatus, arr: string, o: Partial<{ status: string; terminal: string; belt: string }> = {}): FlightStatus {
  const next: FlightStatus = JSON.parse(JSON.stringify(s));
  next.arrival.estimatedTime = `2026-08-31 ${arr}${ET}`;
  next.arrival.estimatedTimeUtc = new Date(at(arr)).toISOString();
  if (o.status) next.status = o.status;
  if (o.terminal) next.arrival.terminal = o.terminal;
  if (o.belt) next.arrival.baggageBelt = o.belt;
  return next;
}

const UA = { flightNumber: "UA1503", date: "2026-08-31" };
const WN = { flightNumber: "WN748", date: "2026-08-31" };

function run369736(gb = false): Assignment {
  return {
    number: "369736",
    start: "2026-08-31 21:30",
    end: "2026-09-01 03:00",
    importedAt: "",
    gb,
    steps: [
      { code: "FKL", place: "Fishkill", etd: "9:30 PM", date: "2026-08-31", actions: [] },
      {
        code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM",
        date: "2026-09-01", etaDate: "2026-08-31",
        actions: [{
          verb: "Pickup", where: "Baggage Claim",
          entities: [
            { name: "R. Alvarez", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: "2026-08-31" },
            { name: "T. Brennan", pax: 1, tag: "A", flightNumber: "WN748", flightDate: "2026-08-31" },
          ],
        }],
      },
      {
        code: "WKL", place: "Wallkill", eta: "2:15 AM", date: "2026-09-01",
        actions: [{
          verb: "Drop-off", where: "A Front",
          entities: [{ name: "T. Brennan", pax: 1, tag: "A", flightNumber: "WN748", flightDate: "2026-08-31" }],
        }],
      },
    ],
  };
}

function lga(gb = false): Stop {
  const stops = stopsFor(run369736(gb), UA);
  assert.equal(stops.length, 1);
  return stops[0];
}

const ua = status("UA1503", "23:09");
const wn = status("WN748", "23:20");

test("only the airport stop is a stop, with dispatch's own 90-minute leg", () => {
  const stops = stopsFor(run369736(), WN);
  assert.equal(stops.length, 1, "the Wallkill drop-off carries the flight but is not where it is worked");
  assert.equal(stops[0].code, "LGA");
  assert.equal(stops[0].legMinutes, 90);
  assert.equal(stops[0].plannedLeave, "9:30 PM");
});

test("a leg across midnight is still dispatch's, and a stop with no time before it has none", () => {
  // Out at 11:30 PM, at the airport at 12:15 AM: 45 minutes, not minus 1395
  // and not thrown away (the dates differ; the clock arithmetic wraps).
  const late = run369736();
  late.steps[0].etd = "11:30 PM";
  late.steps[1].eta = "12:15 AM";
  late.steps[1].etaDate = "2026-09-01";
  assert.equal(stopsFor(late, UA)[0].legMinutes, 45);
  const untimed = run369736();
  delete untimed.steps[0].etd;
  const stop = stopsFor(untimed, UA)[0];
  assert.equal(stop.legMinutes, null, "never a guess");
  assert.equal(stop.plannedLeave, null);
});

test("the later flight slipping moves when you leave, not when you arrive", () => {
  const n = noticeFor(lga(), WN, wn, moved(wn, "23:52"), { "UA1503:2026-08-31": ua }, at("20:00"));
  assert.ok(n);
  assert.equal(n.title, "Wait 32 minutes longer at LGA");
  assert.equal(n.priority, 3);
  assert.match(n.body, /WN748 now lands 11:52p · leaving 12:37a, dispatch planned 12:00a/);
  assert.match(n.body, /still parked by 10:54p/);
  assert.match(n.body, /LGA pickup · WN748/);
});

test("a delay to the first flight is calm, verb first, and quotes dispatch", () => {
  const n = noticeFor(lga(), UA, ua, moved(ua, "23:29"), { "WN748:2026-08-31": wn }, at("20:00"));
  assert.ok(n);
  // WN748 becomes the earliest: parked 11:05p rather than 10:54p.
  assert.equal(n.title, "Leave 11 minutes later");
  assert.equal(n.priority, 3);
  assert.match(n.body, /^UA1503 now lands 11:29p · leave by 9:35p, dispatch planned 9:30p/);
  assert.match(n.body, /Wait 9 minutes longer at LGA/);
});

test("early is the urgent one", () => {
  const n = noticeFor(lga(), UA, ua, moved(ua, "22:50"), { "WN748:2026-08-31": wn }, at("20:00"));
  assert.ok(n);
  assert.equal(n.title, "Leave 19 minutes earlier");
  assert.equal(n.priority, 5);
  assert.match(n.body, /leave by 9:05p, dispatch planned 9:30p/);
});

test("early past the new leave-by says leave now", () => {
  const n = noticeFor(lga(), UA, ua, moved(ua, "22:30"), { "WN748:2026-08-31": wn }, at("21:10"));
  assert.ok(n);
  assert.equal(n.title, "Leave now — UA1503 early");
  assert.equal(n.priority, 5);
});

test("early once already on the road names the time to be parked", () => {
  const n = noticeFor(lga(), UA, ua, moved(ua, "22:40"), { "WN748:2026-08-31": wn }, at("21:45"));
  assert.ok(n);
  assert.equal(n.title, "Park by 10:25p — UA1503 early");
  assert.equal(n.priority, 5);
});

test("landing before you were due to be parked is urgent", () => {
  const n = noticeFor(lga(), UA, ua, moved(ua, "22:40", { status: "Landed" }), { "WN748:2026-08-31": wn }, at("22:41"));
  assert.ok(n);
  assert.equal(n.title, "Call your UA1503 pickup — landed early");
  assert.equal(n.priority, 5);
  assert.match(n.body, /UA1503 on the ground 10:40p · 29 minutes ahead/);
});

test("an ordinary landing starts the call routine", () => {
  const n = noticeFor(lga(), UA, ua, moved(ua, "23:10", { status: "Landed", belt: "4" }), { "WN748:2026-08-31": wn }, at("23:11"));
  assert.ok(n);
  assert.equal(n.title, "Call your UA1503 pickup — landed");
  assert.equal(n.priority, 4);
  assert.match(n.body, /on the ground 11:10p · Belt 4 · Terminal B/);
});

test("a cancellation goes to dispatch, urgently", () => {
  const next = { ...wn, status: "Canceled" };
  const n = noticeFor(lga(), WN, wn, next, { "UA1503:2026-08-31": ua }, at("20:00"));
  assert.ok(n);
  assert.equal(n.title, "Call dispatch — WN748 cancelled");
  assert.equal(n.priority, 5);
});

test("a moved terminal says where to go", () => {
  const n = noticeFor(lga(), WN, wn, moved(wn, "23:20", { terminal: "A" }), { "UA1503:2026-08-31": ua }, at("20:00"));
  assert.ok(n);
  assert.equal(n.title, "Go to Terminal A — WN748 moved from B");
  assert.equal(n.priority, 4);
});

test("a two-minute revision is not worth a buzz", () => {
  assert.equal(noticeFor(lga(), UA, ua, moved(ua, "23:11"), { "WN748:2026-08-31": wn }, at("20:00")), null);
});

test("status churn that moves no clock says nothing", () => {
  assert.equal(noticeFor(lga(), UA, ua, { ...ua, status: "En Route" }, { "WN748:2026-08-31": wn }, at("20:00")), null);
});

test("a run long finished says nothing", () => {
  assert.equal(noticeFor(lga(), UA, ua, moved(ua, "22:30"), { "WN748:2026-08-31": wn }, at("06:00", "2026-09-01")), null);
});

test("a GB run reaches the driver louder, and says so", () => {
  const n = noticeFor(lga(true), WN, wn, moved(wn, "23:52"), { "UA1503:2026-08-31": ua }, at("20:00"));
  assert.ok(n);
  assert.equal(n.priority, 4);
  assert.deepEqual(n.tags, ["GOVERNING BODY"]);
});

/* --------------------------------------------------------- departures -- */

function dropAtEwr(): Stop {
  const a: Assignment = {
    number: "348400", start: "2026-08-31 07:00", end: "2026-08-31 14:00", importedAt: "",
    steps: [
      { code: "WRK", place: "Warwick", etd: "8:25 AM", date: "2026-08-31", actions: [] },
      {
        code: "EWR", place: "Newark", eta: "9:40 AM", etd: "10:00 AM", date: "2026-08-31",
        actions: [{ verb: "Drop-off", where: "Departures", entities: [
          { name: "Ford, J. & M.", pax: 2, tag: "D", flightNumber: "UA100", flightDate: "2026-08-31" },
        ] }],
      },
    ],
  };
  return stopsFor(a, { flightNumber: "UA100", date: "2026-08-31" })[0];
}

// Domestic departure at 11:55a: check-in by 9:55a.
const ua100 = status("UA100", "15:00", { dep: "11:55", depZone: "America/New_York" });
ua100.arrival.timeZone = "America/Chicago";
const UA100 = { flightNumber: "UA100", date: "2026-08-31" };

function departs(s: FlightStatus, hhmm: string): FlightStatus {
  const next: FlightStatus = JSON.parse(JSON.stringify(s));
  next.departure.estimatedTime = `2026-08-31 ${hhmm}${ET}`;
  next.departure.estimatedTimeUtc = new Date(at(hhmm)).toISOString();
  return next;
}

test("a departure delay does not move the check-in desk", () => {
  const n = noticeFor(dropAtEwr(), UA100, ua100, departs(ua100, "12:40"), {}, at("07:00"));
  assert.ok(n);
  assert.equal(n.title, "Leave as planned — UA100 delayed");
  assert.equal(n.priority, 2);
});

test("a departure moved earlier is urgent", () => {
  const n = noticeFor(dropAtEwr(), UA100, ua100, departs(ua100, "11:30"), {}, at("07:00"));
  assert.ok(n);
  assert.equal(n.title, "Leave 25 minutes earlier");
  assert.equal(n.priority, 5);
  assert.match(n.body, /UA100 now departs 11:30a · leave by 8:15a, dispatch planned 8:25a/);
  assert.match(n.body, /EWR drop-off · UA100$/);
});

test("no push names a passenger: the flight and the stop say who", () => {
  const cases = [
    noticeFor(lga(), UA, ua, moved(ua, "22:40"), { "WN748:2026-08-31": wn }, at("21:45")),
    noticeFor(lga(), UA, ua, moved(ua, "22:40", { status: "Landed" }), { "WN748:2026-08-31": wn }, at("22:41")),
    noticeFor(lga(), UA, ua, moved(ua, "23:10", { status: "Landed", belt: "4" }), { "WN748:2026-08-31": wn }, at("23:11")),
    noticeFor(lga(), WN, wn, { ...wn, status: "Canceled" }, { "UA1503:2026-08-31": ua }, at("20:00")),
  ];
  for (const n of cases) {
    assert.ok(n);
    assert.doesNotMatch(`${n.title}
${n.body}`, /Alvarez|Brennan/);
  }
  assert.match(cases[2]!.body, /LGA pickup · UA1503/);
});

test("the Americas outside the US are international: Cancun gets customs time", () => {
  const id = "UA1503:2026-08-31";
  const leaving = (st: FlightStatus) => (clocksFor(lga(), { [id]: st }).leavingAt! - at("23:09")) / 60000;
  assert.equal(leaving(status("UA1503", "23:09", { depZone: "America/Cancun" })), 105);
  assert.equal(leaving(status("UA1503", "23:09", { depZone: "America/Toronto" })), 105);
  assert.equal(leaving(status("UA1503", "23:09", { depZone: "America/Chicago" })), 45);
  assert.equal(leaving(status("UA1503", "23:09", { depZone: "Pacific/Honolulu" })), 45);
  assert.equal(leaving(status("UA1503", "23:09", { depZone: "America/Puerto_Rico" })), 45);
  // The airport's country, when AeroDataBox gave one, decides over the zone.
  const mx = status("UA1503", "23:09");
  mx.departure.countryCode = "MX";
  mx.arrival.countryCode = "US";
  assert.equal(leaving(mx), 105);
});

test("a departure to the Caribbean checks in three hours ahead", () => {
  const dep: Stop = { ...lga(), rows: [{ ...lga().rows[0], departure: true }] };
  const st = status("UA1503", "23:09", { dep: "21:00", depZone: "America/New_York" });
  st.arrival.timeZone = "America/Santo_Domingo";
  const c = clocksFor(dep, { [dep.rows[0].id]: st });
  assert.equal((at("21:00") - c.parkedBy!) / 60000, 180);
});

test("small moves add up against what the driver was last told", () => {
  const others = { "WN748:2026-08-31": wn };
  const told = moved(ua, "23:09"), prev = moved(ua, "23:05"), next = moved(ua, "23:01");
  assert.equal(noticeFor(lga(), UA, prev, next, others, at("20:00")), null, "4 minutes alone says nothing");
  const n = noticeFor(lga(), UA, prev, next, others, at("20:00"), told);
  assert.ok(n);
  assert.equal(n.title, "Leave 8 minutes earlier");
});

/* ---- the rules' own edges (mutation pass, 2026-10-03): each number is pinned ---- */

test("five minutes is said, four is not; three hours behind is history", () => {
  const others = { "WN748:2026-08-31": wn };
  const five = noticeFor(lga(), UA, ua, moved(ua, "23:04"), others, at("20:00"));
  assert.ok(five, "exactly five minutes is worth a buzz");
  assert.equal(five.title, "Leave 5 minutes earlier");
  assert.equal(noticeFor(lga(), UA, ua, moved(ua, "23:05"), others, at("20:00")), null);

  // The stop's last clock is WN748's 12:05a leaving. Three hours past it the
  // stop is behind the driver, and one more minute says nothing.
  const late = moved(ua, "23:29");
  assert.ok(noticeFor(lga(), UA, ua, late, others, at("03:05", "2026-09-01")));
  assert.equal(noticeFor(lga(), UA, ua, late, others, at("03:06", "2026-09-01")), null);
});

test("a GB arrival is met 30 minutes ahead, anyone else 15", () => {
  const stop = lga();
  const statuses = { "UA1503:2026-08-31": ua, "WN748:2026-08-31": wn };
  assert.equal((at("23:09") - clocksFor(stop, statuses).parkedBy!) / 60000, 15);
  const gb: Stop = { ...stop, rows: stop.rows.map((r) => ({ ...r, gb: true })) };
  assert.equal((at("23:09") - clocksFor(gb, statuses).parkedBy!) / 60000, 30);
});
