/**
 * The client's time logic (public/assignments.js), run in node.
 *
 * assignments.js is a plain browser script: globals, no modules, helpers from
 * app.js. It is loaded unchanged into a node:vm context with just enough of a
 * browser stubbed for its top level to run, and the few app.js helpers it calls
 * lifted out of app.js's own source (app.js itself wires the DOM on load).
 * Dates are built in America/New_York, the driver's zone, so a local-vs-UTC
 * slip shows up: UTC turns the date over at 8 PM there.
 *
 *   node --test --experimental-strip-types src/client.test.ts
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pub = new URL("../../public/", import.meta.url);
// Checked out with CRLF on Windows; lift() looks for "\n}\n".
const appSrc = readFileSync(new URL("app.js", pub), "utf8").replace(/\r\n/g, "\n");
const clientSrc = readFileSync(new URL("assignments.js", pub), "utf8");

/** One top-level function out of app.js, as written there. */
function lift(name: string): string {
  const start = appSrc.indexOf(`\nfunction ${name}(`);
  const end = appSrc.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`app.js has no function ${name}`);
  return appSrc.slice(start, end + 2);
}

const store = new Map<string, string>();
const noop = () => {};
const ctx = vm.createContext({
  console,
  window: { addEventListener: noop, location: { hostname: "localhost" } },
  document: { addEventListener: noop, visibilityState: "visible" },
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
  setInterval: noop,
  setTimeout: noop,
  clearTimeout: noop,
  AbortController,
});
vm.runInContext(
  ["esc", "listHeaders", "icon", "parseWall", "timeParts", "shortTime", "shortDate", "instantTime", "deviceTime",
    "versionMajor", "releaseNews", "updateLine", "pushView", "testAlertWords", "routePlaces"].map(lift).join("\n")
    + "\nlet listCode = null;\nlet settings = {};\nconst API_BASE = \"https://worker.test\";\n",
  ctx, { filename: "app.js (lifted)" },
);
vm.runInContext(readFileSync(new URL("messages.js", pub), "utf8"), ctx, { filename: "messages.js" });
vm.runInContext(clientSrc, ctx, { filename: "assignments.js" });
// Top-level `let`s share the context's lexical scope, so a later script can set them.
vm.runInContext("function __setStatuses(s) { flightStatuses = s; }", ctx);
vm.runInContext("function __setState(a, l) { assignments = a; listCode = l; }\n"
  + "function __assignments() { return assignments; }", ctx);

type Fn = (...args: any[]) => any;
const c = ctx as unknown as Record<string, Fn>;
const { wallAt, nowAt, localStamp, stepAt, stepDone, clocksFor, noteLines, placeNoteLines } = c;
const setStatuses = (s: object) => c.__setStatuses(s);
/** Objects made inside the context have its prototypes; compare them as data. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

/** Local wall time, as the phone's clock gives it. */
const at = (y: number, mo: number, d: number, h: number, mi: number) => nowAt(new Date(y, mo - 1, d, h, mi));
const hm = (h: number, m: number) => h * 60 + m;

/* ---------------------------------------------------------------- shapes -- */

// 369736's shape: FKL -> LGA (two arrivals, across midnight) -> WKL -> FKL.
function overnight(): any {
  const pax = (flightNumber: string) => ({
    name: `Pax ${flightNumber}`, pax: 1, tag: "A", gb: false, bags: 0,
    origin: "LGA LaGuardia", destination: "Wallkill", flightNumber, flightDate: "2026-08-31",
  });
  return {
    number: "369736",
    start: "2026-08-31 21:30",
    end: "2026-09-01 03:00",
    driverNotes: "",
    steps: [
      { code: "FKL", place: "Fishkill", eta: null, etd: "9:30 PM", date: "2026-08-31", etaDate: "2026-08-31", actions: [] },
      {
        code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM",
        date: "2026-09-01", etaDate: "2026-08-31",
        actions: [{ verb: "Pickup", where: "Baggage Claim", entities: [pax("UA1503"), pax("WN748")] }],
      },
      {
        code: "WKL", place: "Wallkill", eta: "2:15 AM", etd: "2:15 AM", date: "2026-09-01", etaDate: "2026-09-01",
        actions: [{ verb: "Drop-Off", where: "Lobby", entities: [pax("WN748"), pax("UA1503")] }],
      },
      { code: "FKL", place: "Fishkill", eta: "3:00 AM", etd: null, date: "2026-09-01", etaDate: "2026-09-01", actions: [] },
    ],
  };
}

// Airport wall times as AeroDataBox gives them ("local" with its offset).
function leg(zone: string | null, scheduled: string | null, estimated: string | null = null) {
  return {
    timeZone: zone,
    scheduledTime: scheduled && `${scheduled}-04:00`,
    estimatedTime: estimated && `${estimated}-04:00`,
    terminal: null, gate: null, baggageBelt: null,
  };
}
function arriving(from: string | null, scheduled: string, estimated: string | null = null) {
  return { status: "Expected", departure: leg(from, null), arrival: leg("America/New_York", scheduled, estimated) };
}
function departing(to: string | null, scheduled: string, estimated: string | null = null) {
  return { status: "Expected", departure: leg("America/New_York", scheduled, estimated), arrival: leg(to, null) };
}

// 334184 as imported (passengers left out: nothing here reads them).
const NOTES_334184 = [
  "Please follow times:",
  "7:45a Load Mail for ALL Sites check cabinets for Mail & WRK Lobby for Rushes",
  "7:50a Call Dispatch & Load Passengers",
  "8:00a Depart WRK Lobby for HUB",
  "8:15a Depart TUX Lobby (only if passengers)",
  "--",
  "8:50a Exchange Mail check HUB Lobby for Rushes",
  "8:55a Call Dispatch & Load Passengers",
  "9:00a Depart from HUB for Home",
  "9:45a Drop-Off TUX Passengers",
  "9:55a Drop-Off WRK Passengers",
  "10:00a Put Mail in INCOMING CABINET Bring Rushes labeled “Lobby” to WRK Lobby",
  "10:00a Wash & Fuel",
].join("\n");

function shuttle(): any {
  const step = (code: string, eta: string | null, etd: string | null) =>
    ({ code, place: code, eta, etd, date: "2026-05-06", etaDate: "2026-05-06", actions: [] });
  return {
    number: "334184",
    start: "2026-05-06 08:00",
    end: "2026-05-06 09:50",
    driverNotes: NOTES_334184,
    steps: [
      step("WRK", null, "8:00 AM"),
      step("TUX", "8:10 AM", "8:10 AM"),
      step("NCB", "8:45 AM", "9:00 AM"),
      step("TUX", "9:40 AM", "9:40 AM"),
      step("WRK", "9:50 AM", null),
    ],
  };
}

const placedTimes = (placed: any) =>
  Object.fromEntries(Object.entries(plain(placed)).map(([i, ls]: [string, any]) => [i, ls.map((l: any) => l.time)]));

/* -------------------------------------------------- wallAt, nowAt, stepAt -- */

test("wallAt: 12:10a is 20 minutes after the 11:50p before it", () => {
  assert.equal(wallAt("2026-09-01", hm(0, 10)) - wallAt("2026-08-31", hm(23, 50)), 20);
  assert.equal(wallAt("2026-08-31", null), null);
  assert.equal(wallAt(null, 10), null);
});

test("nowAt/localStamp: the driver's local day, not UTC's (21:30 EDT is 01:30Z tomorrow)", () => {
  assert.equal(at(2026, 8, 31, 21, 30), wallAt("2026-08-31", hm(21, 30)));
  assert.equal(at(2026, 9, 1, 0, 5), wallAt("2026-09-01", 5));
  assert.equal(localStamp(new Date(2026, 7, 31, 21, 30)), "2026-08-31 21:30");
});

test("stepAt: eta on etaDate, etd on date -- LGA 11:00p to 12:00a is one hour", () => {
  const lga = overnight().steps[1];
  assert.equal(stepAt(lga, "eta"), wallAt("2026-08-31", hm(23, 0)));
  assert.equal(stepAt(lga, "etd") - stepAt(lga, "eta"), 60);
  // The "RUNNING ~1466M LATE" bug: five past midnight is 5 past the leave time.
  assert.equal(at(2026, 9, 1, 0, 5) - stepAt(lga, "etd"), 5);
  assert.equal(stepAt(overnight().steps[0], "eta"), null);
});

test("stepAt: a driver's 12:10a over dispatch's 11:50p sits 20 minutes later, not 23h40 earlier", () => {
  const step = {
    code: "LGA", eta: "11:00 PM", etd: "12:10 AM", date: "2026-08-31", etaDate: "2026-08-31",
    _edit: { etd: { documentValue: "11:50 PM" } }, actions: [],
  };
  assert.equal(stepAt(step, "etd"), wallAt("2026-08-31", hm(23, 50)) + 20);
});

test("stepAt: a driver's 11:50p over dispatch's 12:10a sits 20 minutes earlier", () => {
  const step = {
    code: "LGA", eta: "11:50 PM", etd: "12:30 AM", date: "2026-09-01", etaDate: "2026-09-01",
    _edit: { eta: { documentValue: "12:10 AM" } }, actions: [],
  };
  assert.equal(stepAt(step, "eta"), wallAt("2026-09-01", 10) - 20);
});

test("stepAt: an ordinary correction stays on dispatch's day; an added stop's `time` edit counts", () => {
  const moved = { eta: "11:10 PM", etd: "12:00 AM", date: "2026-09-01", etaDate: "2026-08-31",
    _edit: { eta: { documentValue: "11:00 PM" } } };
  assert.equal(stepAt(moved, "eta"), wallAt("2026-08-31", hm(23, 10)));
  const added = { eta: "12:05 AM", etd: "12:05 AM", date: "2026-08-31", etaDate: "2026-08-31",
    _add: { patchId: "p1" }, _edit: { time: { documentValue: "11:55 PM" } } };
  assert.equal(stepAt(added, "etd"), wallAt("2026-08-31", hm(23, 55)) + 10);
});

/* --------------------------------------------------------------- stepDone -- */

test("stepDone: past its leave time, and not a minute before", () => {
  setStatuses({});
  const lga = overnight().steps[1];
  const clocks = clocksFor(lga);
  assert.equal(stepDone(lga, clocks, at(2026, 8, 31, 23, 59)), false);
  assert.equal(stepDone(lga, clocks, at(2026, 9, 1, 0, 0)), false);
  assert.equal(stepDone(lga, clocks, at(2026, 9, 1, 0, 1)), true);
});

test("stepDone: a late flight holds the stop until the flight clock's LEAVING", () => {
  // UA1503 down at 11:41p, domestic: leaving 12:26a, after dispatch's 12:00a.
  setStatuses({ "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41") });
  const lga = overnight().steps[1];
  lga.actions[0].entities = [lga.actions[0].entities[0]];
  const clocks = clocksFor(lga);
  assert.equal(clocks.leavingAt, wallAt("2026-09-01", 26));
  assert.equal(stepDone(lga, clocks, at(2026, 9, 1, 0, 20)), false);
  assert.equal(stepDone(lga, clocks, at(2026, 9, 1, 0, 26)), false);
  assert.equal(stepDone(lga, clocks, at(2026, 9, 1, 0, 27)), true);
});

test("stepDone: an early flight does not end the stop before dispatch's leave time", () => {
  setStatuses({ "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 22:30") });
  const lga = overnight().steps[1];
  lga.actions[0].entities = [lga.actions[0].entities[0]];
  const clocks = clocksFor(lga);
  assert.equal(clocks.leavingAt, wallAt("2026-08-31", hm(23, 15)));
  assert.equal(stepDone(lga, clocks, at(2026, 8, 31, 23, 30)), false);
});

test("stepDone: a step with no leave time lasts its day", () => {
  setStatuses({});
  const last = overnight().steps[3]; // FKL, ETA 3:00a, no ETD
  assert.equal(stepDone(last, clocksFor(last), at(2026, 9, 1, 23, 59)), false);
  assert.equal(stepDone(last, clocksFor(last), at(2026, 9, 2, 0, 0)), true);
});

/* -------------------------------------------------------------- clocksFor -- */

test("clocksFor: off an airport there are no clocks, flights or not", () => {
  setStatuses({
    "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41"),
    "WN748:2026-08-31": arriving("America/Chicago", "2026-08-31 23:20", "2026-08-31 23:52"),
  });
  const c = plain(clocksFor(overnight().steps[2])); // WKL
  assert.equal(c.parkedBy, null);
  assert.equal(c.leavingAt, null);
  assert.equal(c.firstName, null);
});

test("clocksFor: parked by the earliest touchdown - 15, leaving at the latest + 45 (domestic)", () => {
  setStatuses({
    "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41"),
    "WN748:2026-08-31": arriving("America/Chicago", "2026-08-31 23:20", "2026-08-31 23:52"),
  });
  const c = plain(clocksFor(overnight().steps[1]));
  assert.equal(c.parkedBy, wallAt("2026-08-31", hm(23, 41) - 15)); // estimated, not scheduled
  assert.equal(c.firstName, "UA1503");
  assert.equal(c.leavingAt, wallAt("2026-09-01", 37)); // 11:52p + 45
  assert.equal(c.lastName, "WN748");
});

test("clocksFor: delay the earlier flight past the later one and they trade jobs", () => {
  setStatuses({
    "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-09-01 00:10"),
    "WN748:2026-08-31": arriving("America/Chicago", "2026-08-31 23:20", "2026-08-31 23:52"),
  });
  const c = plain(clocksFor(overnight().steps[1]));
  assert.equal(c.firstName, "WN748");
  assert.equal(c.parkedBy, wallAt("2026-08-31", hm(23, 52) - 15));
  assert.equal(c.lastName, "UA1503");
  assert.equal(c.leavingAt, wallAt("2026-09-01", 10 + 45));
});

test("clocksFor: a GB arrival is parked by touchdown - 30", () => {
  setStatuses({ "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15") });
  const lga = overnight().steps[1];
  lga.actions[0].entities = [{ ...lga.actions[0].entities[0], tag: "GBA", gb: true }];
  assert.equal(clocksFor(lga).parkedBy, wallAt("2026-08-31", hm(23, 15) - 30));
});

test("clocksFor: an international arrival leaves at + 105; an unknown one fails toward it", () => {
  // Spec line 84 on this branch still says 60m international; the owner's
  // HuB-checked figure is 105 (45 + 60), documented on fix/hub-request-types.
  setStatuses({ "UA1503:2026-08-31": arriving("Europe/London", "2026-08-31 23:15") });
  const lga = overnight().steps[1];
  lga.actions[0].entities = [lga.actions[0].entities[0]];
  assert.equal(clocksFor(lga).leavingAt, wallAt("2026-08-31", hm(23, 15) + 105));
  assert.equal(clocksFor(lga).parkedBy, wallAt("2026-08-31", hm(23, 15) - 15)); // no deplane subtracted
  setStatuses({ "UA1503:2026-08-31": arriving(null, "2026-08-31 23:15") });
  assert.equal(clocksFor(lga).leavingAt, wallAt("2026-08-31", hm(23, 15) + 105));
});

test("clocksFor: a departure's check-in is 120/180 before the EARLIER of scheduled and estimated", () => {
  const drop = (tag: string, flightNumber: string) => ({
    code: "EWR", place: "Newark", eta: "5:00 AM", etd: "5:15 AM", date: "2026-09-01", etaDate: "2026-09-01",
    actions: [{ verb: "Drop-Off", where: "Terminal C", entities: [
      { name: "Pax", pax: 1, tag, gb: tag === "GBD", flightNumber, flightDate: "2026-09-01" }] }],
  });
  // Delayed: the desk does not move, so the scheduled time counts.
  setStatuses({ "UA10:2026-09-01": departing("America/Chicago", "2026-09-01 07:00", "2026-09-01 07:40") });
  let c = plain(clocksFor(drop("D", "UA10")));
  assert.equal(c.parkedBy, wallAt("2026-09-01", hm(7, 0) - 120));
  assert.equal(c.leavingAt, null); // a drop-off releases the driver on hand-over
  // Early: the estimate counts.
  setStatuses({ "UA10:2026-09-01": departing("America/Chicago", "2026-09-01 07:00", "2026-09-01 06:30") });
  assert.equal(clocksFor(drop("D", "UA10")).parkedBy, wallAt("2026-09-01", hm(6, 30) - 120));
  // International, and GB departures keep the same lead.
  setStatuses({ "BA178:2026-09-01": departing("Europe/London", "2026-09-01 09:00") });
  assert.equal(clocksFor(drop("GBD", "BA178")).parkedBy, wallAt("2026-09-01", hm(9, 0) - 180));
});

test("clocksFor: with no instant to count from, a departure's check-in still runs from the earlier wall time", () => {
  // AeroDataBox's times name an instant (a UTC twin, an offset), and then
  // clockInstant decides. A time that reads as a wall clock and nothing more
  // leaves the wall arithmetic, and checkInBasis is all that keeps a delay
  // from moving the check-in desk there. Until this test its min could be
  // taken out and nothing failed.
  const wallOnly = (scheduled: string, estimated: string | null) => ({
    status: "Expected",
    departure: { timeZone: "America/New_York", scheduledTime: `${scheduled} local`,
      estimatedTime: estimated && `${estimated} local`, terminal: null, gate: null, baggageBelt: null },
    arrival: leg("America/Chicago", null),
  });
  const drop = {
    code: "EWR", place: "Newark", eta: "5:00 AM", etd: "5:15 AM", date: "2026-09-01", etaDate: "2026-09-01",
    actions: [{ verb: "Drop-Off", where: "Terminal C", entities: [
      { name: "Pax", pax: 1, tag: "D", gb: false, flightNumber: "UA10", flightDate: "2026-09-01" }] }],
  };
  const parkedBy = (scheduled: string, estimated: string | null) => {
    const status = wallOnly(scheduled, estimated);
    assert.equal(ctx.clockInstant(status.departure, true), null, "no instant: the wall decides");
    setStatuses({ "UA10:2026-09-01": status });
    return clocksFor(drop).parkedBy;
  };
  assert.equal(parkedBy("2026-09-01 07:00", "2026-09-01 07:40"), wallAt("2026-09-01", hm(7, 0) - 120), "delayed: the schedule counts");
  assert.equal(parkedBy("2026-09-01 07:00", "2026-09-01 06:30"), wallAt("2026-09-01", hm(6, 30) - 120), "early: the estimate counts");
  assert.equal(parkedBy("2026-09-01 07:00", null), wallAt("2026-09-01", hm(7, 0) - 120));
  setStatuses({});
});

test("clocksFor: a mixed stop is parked by the earliest obligation and left after the latest", () => {
  setStatuses({
    "UA10:2026-09-01": departing("America/Chicago", "2026-09-01 07:00"),
    "DL5:2026-09-01": arriving("America/Chicago", "2026-09-01 06:00"),
  });
  const step = {
    code: "LGA", place: "LaGuardia", eta: "5:00 AM", etd: "7:00 AM", date: "2026-09-01", etaDate: "2026-09-01",
    actions: [
      { verb: "Drop-Off", where: "B", entities: [{ name: "D", tag: "D", flightNumber: "UA10" }] },
      { verb: "Pickup", where: "B", entities: [{ name: "A", tag: "A", flightNumber: "DL5" }] },
    ],
  };
  const c = plain(clocksFor(step)); // no flightDate: keyed by the step's date
  assert.equal(c.parkedBy, wallAt("2026-09-01", hm(5, 0))); // check-in 5:00a beats 5:45a
  assert.equal(c.firstName, "UA10");
  assert.equal(c.leavingAt, wallAt("2026-09-01", hm(6, 45)));
  assert.equal(c.lastName, "DL5");
});

test("clocksFor: a passenger marked not coming sets no clock; no status, no clock", () => {
  setStatuses({
    "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41"),
    "WN748:2026-08-31": arriving("America/Chicago", "2026-08-31 23:20", "2026-08-31 23:52"),
  });
  const lga = overnight().steps[1];
  lga.actions[0].entities[1]._removed = { patchId: "p9" };
  assert.equal(clocksFor(lga).lastName, "UA1503");
  setStatuses({});
  assert.equal(clocksFor(lga).parkedBy, null);
});

/* ------------------------------------------------ noteLines, placeNoteLines -- */

test("noteLines: 334184's timed lines, prose skipped, words as printed", () => {
  const lines = plain(noteLines(shuttle()));
  assert.equal(lines.length, 11);
  assert.deepEqual({ ...lines[0], row: undefined }, { row: undefined,
    at: wallAt("2026-05-06", hm(7, 45)), time: "7:45a",
    text: "Load Mail for ALL Sites check cabinets for Mail & WRK Lobby for Rushes",
    key: "334184:7:45a Load Mail for ALL Sites check cabinets for Mail & WRK Lobby for Rushes",
  });
  assert.ok(!lines.some((l: any) => /Please follow|^--/.test(l.text)));
});

test("placeNoteLines: 334184 puts 3 under WRK, 4 under NCB (8:15a TUX among them), 4 under the last WRK", () => {
  const placed = plain(placeNoteLines(shuttle()));
  assert.deepEqual(placedTimes(placed), {
    0: ["7:45a", "7:50a", "8:00a"],
    2: ["8:15a", "8:50a", "8:55a", "9:00a"],
    4: ["9:45a", "9:55a", "10:00a", "10:00a"],
  });
  assert.match(placed[2][0].text, /^Depart TUX Lobby/);
});

test("noteLines: 7:55am, 7:45 AM, a bare 9:30 and 14:30 are timed; a mid-line time or a time alone is not", () => {
  const a = { ...shuttle(), driverNotes: "7:55am depart from RCA\n7:45 AM Load mail\n9:30 Call\n14:30 Wash\nCall at 9:00a\n9:05p\n25:10 x" };
  const lines = plain(noteLines(a));
  assert.deepEqual(lines.map((l: any) => [l.time, l.at]), [
    ["7:55am", wallAt("2026-05-06", hm(7, 55))],
    ["7:45 AM", wallAt("2026-05-06", hm(7, 45))],
    ["9:30a", wallAt("2026-05-06", hm(9, 30))],     // inside the 8:00a-9:50a run
    ["14:30", wallAt("2026-05-06", hm(14, 30))],
  ]);
});

// 374819 (the owner, 2026-09-29): two shuttles in one run, the steps printed
// as the notes, with bare times and one starred ("or 5 min after Morning
// Worship concludes"). The two printed shuttle stops are windows.
function twoShuttles(): any {
  const step = (code: string, eta: string, etd: string) =>
    ({ code, place: code, eta, etd, date: "2026-09-29", etaDate: "2026-09-29", actions: [] });
  return {
    number: "374819", start: "2026-09-29 06:00", end: "2026-09-29 10:00",
    driverNotes: "6:15 NCB to SGA.\n6:25 SGA to CLS\n7:10 Depart from CLN, drop off at RCA, SGA and NCB upon request.\n\n"
      + "7:45* or 5 min after Morning Worship concludes, depart SGA for NCA.\n7:55 NCA to NCB.\n8:00 NCB to MGW.\n\n"
      + "After you finish the driving assignment take one hour for late breakfast.",
    steps: [step("CLD", "6:00 AM", "7:30 AM"), step("ABS", "7:55 AM", "8:05 AM"),
            step("MGW", "8:20 AM", "8:25 AM"), step("NCA", "9:00 AM", "10:00 AM")],
  };
}

test("noteLines: a bare time takes the a/p inside the run; the star stays with it", () => {
  const lines = plain(noteLines(twoShuttles()));
  assert.deepEqual(lines.map((l: any) => [l.time, l.text]), [
    ["6:15a", "NCB to SGA."], ["6:25a", "SGA to CLS"],
    ["7:10a", "Depart from CLN, drop off at RCA, SGA and NCB upon request."],
    ["7:45a*", "or 5 min after Morning Worship concludes, depart SGA for NCA."],
    ["7:55a", "NCA to NCB."], ["8:00a", "NCB to MGW."],
  ]);
  assert.equal(lines[0].at, wallAt("2026-09-29", hm(6, 15)));
  assert.equal(lines[3].key, "374819:7:45* or 5 min after Morning Worship concludes, depart SGA for NCA.");
  // Each shuttle's legs under its own window.
  assert.deepEqual(placedTimes(plain(placeNoteLines(twoShuttles()))), {
    0: ["6:15a", "6:25a", "7:10a"], 1: ["7:45a*", "7:55a", "8:00a"],
  });
});

test("noteLines: a bare time on a run longer than 12 hours keeps the printed order", () => {
  const run = { ...twoShuttles(), start: "2026-09-29 06:00", end: "2026-09-29 21:00",
    driverNotes: "6:30 Load\n11:45 Lunch run\n1:15 Back to NCB\n8:30 Last loop" };
  assert.deepEqual(plain(noteLines(run)).map((l: any) => l.time), ["6:30a", "11:45a", "1:15p", "8:30p"]);
});

test("noteLines: bare times past the printed end keep the printed order (the afternoon)", () => {
  // Two real runs print 7:40a-12:00p (and -2:00p) with notes running on to
  // "12:50 ... 1:05 ... 4:45 ... 5:00": afternoon, never 4:45a and 5:00a.
  const run = { ...twoShuttles(), start: "2026-05-28 07:40", end: "2026-05-28 12:00",
    driverNotes: "7:50 Load\n11:45 Lunch\n12:50 Back\n1:05 Mail\n4:45 Wash\n5:00 Home" };
  assert.deepEqual(plain(noteLines(run)).map((l: any) => l.time), ["7:50a", "11:45a", "12:50p", "1:05p", "4:45p", "5:00p"]);
  // Printed out of order but inside the run: the reading inside wins.
  const odd = { ...twoShuttles(), driverNotes: "8:00 Second\n7:00 First" };
  assert.deepEqual(plain(noteLines(odd)).map((l: any) => l.time), ["8:00a", "7:00a"]);
});

test("placeNoteLines: an overnight run puts 12:10a after the 12:00a stop, on the next day", () => {
  const run = overnight();
  run.driverNotes = "9:40p Leave for LGA\n11:55p Call both\n12:10a Depart LGA\n2:50am Wash & Fuel";
  const lines = plain(noteLines(run));
  assert.equal(lines[2].at, wallAt("2026-09-01", 10));
  assert.deepEqual(placedTimes(placeNoteLines(run)), {
    1: ["9:40p", "11:55p"],
    2: ["12:10a"],
    3: ["2:50am"],
  });
});

test("placeNoteLines: an evening start that runs to morning puts morning lines on the next day", () => {
  // Review #5: 7:45a is under 12h before a 7:30p start, and the old rule dated
  // it the 24th, under the opening stop.
  const run = {
    number: "400100", start: "2026-09-24 19:30", end: "2026-09-25 09:00",
    driverNotes: "7:40p Load bags\n7:45a Load mail\n8:30a Back to base",
    steps: [
      { code: "WRK", place: "Warwick", eta: null, etd: "7:30 PM", date: "2026-09-24", actions: [] },
      { code: "EWR", place: "Newark", eta: "10:00 PM", etd: "11:00 PM", date: "2026-09-24", actions: [] },
      { code: "RCA", place: "Residence", eta: "7:30 AM", etd: "8:00 AM", date: "2026-09-25", actions: [] },
      { code: "WRK", place: "Warwick", eta: "9:00 AM", etd: null, date: "2026-09-25", actions: [] },
    ],
  };
  const lines = plain(noteLines(run));
  assert.equal(lines[1].at, wallAt("2026-09-25", hm(7, 45)));
  assert.deepEqual(placedTimes(placeNoteLines(run)), { 1: ["7:40p"], 2: ["7:45a"], 3: ["8:30a"] });
});

test("runDayOf: one rule for added stops and note lines; a run with no end gets the next day", () => {
  const run = { start: "2026-08-31 21:30", end: "2026-09-01 03:00" };
  assert.equal(c.runDayOf(run, hm(1, 30)), "2026-09-01");
  assert.equal(c.runDayOf(run, hm(22, 0)), "2026-08-31");
  assert.equal(c.runDayOf({ start: "2026-08-31 21:30" }, hm(0, 10)), "2026-09-01");
  assert.equal(c.runDayOf(run, null), "2026-08-31");
});

test("placeNoteLines: a removed stop takes no lines; they go to the next live one", () => {
  const run = shuttle();
  run.steps[2]._removed = { patchId: "p1" };
  const placed = placedTimes(placeNoteLines(run));
  assert.equal(placed[2], undefined);
  assert.deepEqual(placed[3], ["8:15a", "8:50a", "8:55a", "9:00a"]);
  run.steps.forEach((s: any) => { s._removed = { patchId: "p" }; });
  assert.deepEqual(plain(placeNoteLines(run)), {});
});

test("placeNoteLines: a leave time the driver set is the one lines are placed by", () => {
  const run = shuttle();
  Object.assign(run.steps[1], { etd: "8:20 AM", _edit: { etd: { documentValue: "8:10 AM" } } });
  assert.deepEqual(placedTimes(placeNoteLines(run))[1], ["8:15a"]);
});

test("noteLines: the same words twice get distinct keys, in order", () => {
  const a = { ...shuttle(), driverNotes: "10:00a Wash & Fuel\n9:00a Call\n10:00a Wash & Fuel" };
  assert.deepEqual(plain(noteLines(a)).map((l: any) => l.key), [
    "334184:10:00a Wash & Fuel", "334184:9:00a Call", "334184:10:00a Wash & Fuel#2",
  ]);
});

/* ---------------------------------------------------------------- windows -- */

test("isWindow: no address and nobody to carry; a place, a passenger, an airport or an added stop is a stop", () => {
  const run = twoShuttles();
  assert.deepEqual(run.steps.map((s: any) => c.isWindow(s)), [true, true, true, true]); // test shape: no addresses
  run.steps[2].address = "124 Bracken Road";
  assert.equal(c.isWindow(run.steps[2]), false);
  const withPax = { ...run.steps[0], actions: [{ verb: "Pickup", entities: [{ name: "A B" }] }] };
  assert.equal(c.isWindow(withPax), false);
  assert.equal(c.isWindow({ ...run.steps[0], code: "LGA" }), false);
  assert.equal(c.isWindow({ ...run.steps[0], _add: { patchId: "p1" } }), false);
});

/** 374819 as printed: two windows, then two real places. */
function shuttleRun(): any {
  const run = twoShuttles();
  run.steps[0].place = "CLD Shuttle";
  run.steps[1].place = "After Breakfast Shuttle";
  Object.assign(run.steps[2], { place: "Montgomery Warehouse", address: "124 Bracken Road" });
  Object.assign(run.steps[3], { place: "Newburgh Center A", address: "1292 NY-300 Newburgh, NY 12550" });
  return run;
}

test("nowLeg: a leg holds until the next leg's time or its tick; before the first, the first", () => {
  const run = shuttleRun();
  const legs = c.legsAhead(run, c.placeNoteLines(run), 0);
  assert.deepEqual(plain(legs).map((l: any) => l.time), ["6:15a", "6:25a", "7:10a", "7:45a*", "7:55a", "8:00a"]);
  const t = (h: number, m: number) => at(2026, 9, 29, h, m);
  assert.equal(c.nowLeg(legs, t(5, 50), {}), 0);           // before the first: the first
  assert.equal(c.nowLeg(legs, t(6, 20), {}), 0);           // 6:15 holds until 6:25
  assert.equal(c.nowLeg(legs, t(6, 25), {}), 1);           // ... and hands over at 6:25
  assert.equal(c.nowLeg(legs, t(6, 20), { [legs[0].key]: "x" }), 1); // ticked early: the next one
  assert.equal(c.nowLeg(legs, t(7, 30), {}), 2);           // 7:10 holds until 7:45*
  const all = Object.fromEntries(plain(legs).map((l: any) => [l.key, "x"]));
  assert.equal(c.nowLeg(legs, t(7, 0), all), -1);          // every leg ticked: none
});

test("legsAhead: from the live window on, across windows in a row; none for a window with no legs", () => {
  const run = shuttleRun();
  const placed = c.placeNoteLines(run);
  assert.deepEqual(plain(c.legsAhead(run, placed, 1)).map((l: any) => l.time), ["7:45a*", "7:55a", "8:00a"]);
  assert.equal(c.legsAhead(run, placed, 1)[0].step.code, "ABS");
  const duty = { ...shuttleRun(), driverNotes: "" };
  assert.deepEqual(plain(c.legsAhead(duty, c.placeNoteLines(duty), 0)), []);
});

/* --------------------------------------------------------------- versions -- */

test("versions: a whole number or a point; this release's whole number says what it brought, in one line", () => {
  const name = /const CACHE_NAME = "([^"]+)";/.exec(readFileSync(new URL("sw.js", pub), "utf8"))![1];
  const m = /^curbside-(v(\d+)(?:\.\d+)?)$/.exec(name);
  assert.ok(m, `${name}: curbside-v61 or curbside-v60.1`);
  const news = c.releaseNews(Number(m![2]));
  assert.ok(news, `releaseNews(${m![2]}) in app.js: what v${m![2]} brought`);
  assert.ok(news.length <= 28, `"${news}" fits the update line (28 characters)`);
});

test("versions: the update line says what's new once, on crossing into a whole number", () => {
  const news = `SHUTTLES AND ROUTE IN MAPS`;
  assert.equal(c.updateLine("v60.1", "v59", false), `UPDATED TO V60.1 · ${news}`); // crossed, found at launch
  assert.equal(c.updateLine("v60.2", "v60.1", false), null);                     // a point, not pulled: quiet
  assert.equal(c.updateLine("v60.2", "v60.1", true), "UPDATED TO V60.2");        // a point the driver pulled
  assert.equal(c.updateLine("v60.1", null, true), `UPDATED TO V60.1 · ${news}`); // from before phones kept one
  assert.equal(c.updateLine("v60.1", null, false), null);                        // a first install
  assert.equal(c.updateLine("v59", "v60.1", true), "UPDATED TO V59");            // a rollback counts down
  assert.equal(c.updateLine(null, "v60", true), "APP UPDATED");
  assert.equal(c.versionMajor("v60.1"), 60);
  assert.equal(c.versionMajor("60.1"), null);
});

/* --------------------------------------------- alerts on this phone (v66) -- */

test("alerts: Settings says what is true of this phone and offers the one thing to do", () => {
  const phone = { supported: true, ios: false, standalone: false, key: "BKey", permission: "default", wanted: false, on: false, looked: true };
  const view = (over: object) => plain(c.pushView({ ...phone, ...over }));
  const short = (over: object) => { const v = view(over); return [v.word, v.button, v.bar]; };

  assert.deepEqual(short({}), ["OFF", "TURN ON", "off"]);
  assert.deepEqual(short({ wanted: true, on: true, permission: "granted" }), ["ON", "TURN OFF", "on"]);
  assert.equal(view({ wanted: true, on: true, permission: "granted" }).tone, "on");

  // Turned on, and not working now: a problem, said on the list too.
  const stopped = view({ wanted: true, permission: "granted" });
  assert.deepEqual([stopped.word, stopped.button, stopped.bar, stopped.tone], ["STOPPED", "TURN ON", "lost", "bad"]);
  // Before this launch has looked, neither ON nor STOPPED is claimed.
  assert.deepEqual(short({ wanted: true, permission: "granted", looked: false }), ["…", null, null]);

  // Blocked in the phone's own settings: nothing the app can do but say where.
  assert.deepEqual(short({ wanted: true, permission: "denied" }), ["BLOCKED", null, "lost"]);
  assert.deepEqual(short({ permission: "denied" }), ["BLOCKED", null, null], "never turned on: the driver's choice, no bar");
  assert.match(view({ permission: "denied" }).say, /phone's Settings/);

  // No key on the server, or a browser that cannot: the ntfy app is named.
  assert.deepEqual(short({ key: null }), ["NOT YET", null, null]);
  assert.deepEqual(short({ supported: false }), ["NO", null, null]);
  assert.match(view({ supported: false }).say, /ntfy app/);
  // An iPhone in Safari: the Home Screen first. Already there: an old iOS.
  const safari = view({ supported: false, ios: true });
  assert.deepEqual([safari.word, safari.button, safari.bar], ["NOT YET", null, null]);
  assert.match(safari.say, /Add to Home Screen/);
  assert.match(view({ supported: false, ios: true, standalone: true }).say, /iOS 16\.4/);
});

test("alerts: the test's answer says whether THIS phone took it, and what to do when it did not", () => {
  const w = (status: number, d: object, on: boolean, renewed?: boolean, can = true) => c.testAlertWords(status, d, on, renewed, can);
  assert.match(w(200, { ok: true, app: 1, phones: 1, here: true, ntfy: false }, true), /^Sent to this phone\./);
  // On here, and the test went elsewhere: this phone's sign-up was stale.
  assert.match(w(200, { ok: true, app: 0, phones: 0, here: false, ntfy: true }, true, true), /renewed now\. Tap SEND A TEST again/);
  assert.match(w(200, { ok: true, app: 0, phones: 0, here: false, ntfy: true }, true, false), /off and on again/);
  // Not on here.
  assert.match(w(200, { ok: true, app: 1, phones: 1, here: false, ntfy: false }, false), /^Sent to another phone on this list, not to this one/);
  assert.match(w(200, { ok: true, app: 2, phones: 2, here: false, ntfy: true }, false), /^Sent to 2 other phones/);
  assert.match(w(200, { ok: true, app: 0, phones: 0, here: false, ntfy: true }, false), /^Sent to the ntfy app only\..*TURN ON above/);
  // Nothing took it.
  assert.match(w(503, { error: "ntfy.sh's daily limit for Curbside's server is used up", quota: true, app: 0, phones: 0 }, false),
    /^Not sent: no phone on this list has alerts on, and ntfy\.sh's daily limit.*TURN ON above/);
  assert.match(w(502, { error: "ntfy.sh did not take the alert; try again in a minute", app: 0, phones: 0 }, false), /TURN ON above, or try again/);
  assert.equal(w(503, { error: "the phone's push service did not take the alert, and ntfy.sh's daily limit for Curbside's server is used up", quota: true, app: 0, phones: 1 }, true),
    "Not sent: the phone's push service did not take the alert, and ntfy.sh's daily limit for Curbside's server is used up. Try again in a minute.");
  assert.equal(w(429, { error: "that's 5 test alerts this hour; try again later" }, true), "Not sent: that's 5 test alerts this hour; try again later.");
  assert.equal(w(500, {}, true), "Not sent: the server said no. Try again in a minute.");
  // No TURN ON to point at (blocked, Safari off the Home Screen, an old browser):
  // the row above says what to do, and the test's words never name a button that is not there.
  const cannot = [
    w(200, { ok: true, app: 1, phones: 1, here: false, ntfy: false }, false, undefined, false),
    w(200, { ok: true, app: 0, phones: 0, here: false, ntfy: true }, false, undefined, false),
    w(503, { error: "x", quota: true, app: 0, phones: 0 }, false, undefined, false),
    w(502, { error: "x", app: 0, phones: 0 }, false, undefined, false),
  ];
  for (const words of cannot) assert.doesNotMatch(words, /TURN ON/);
  assert.match(cannot[0], /^Sent to another phone on this list, not to this one\. The line above says/);
  assert.match(cannot[1], /^Sent to the ntfy app only\. The line above says/);
  assert.match(cannot[2], /is used up\. The line above says/);
  assert.match(cannot[3], /didn't take it\. Try again in a minute\.$/);
});

test("alerts: the list says so when this phone gets none; an offer once, a problem until it is fixed", () => {
  const bar = (state: string | null) => { vm.runInContext(`pushState = ${JSON.stringify(state)}`, ctx); return c.alertsBar() as string; };
  store.delete("fw_push_asked");
  assert.equal(bar(null), "");
  assert.equal(bar("on"), "");
  assert.match(bar("off"), /id="alerts-bar"[\s\S]*ALERTS ARE OFF ON THIS PHONE[\s\S]*class="left">TURN ON/);
  assert.match(bar("lost"), /ALERTS STOPPED ON THIS PHONE[\s\S]*class="bad">TURN ON/);
  store.set("fw_push_asked", "1");
  assert.equal(bar("off"), "", "tapped once: it is the driver's choice now");
  assert.match(bar("lost"), /ALERTS STOPPED/, "stopped is not a choice");
  store.delete("fw_push_asked");
  bar(null);
});

/* ------------------------------------------------------------ route in Maps -- */

vm.runInContext("function __setSettings(s) { settings = s; }", ctx);

test("routeStops: a shuttle's legs from the one RIGHT NOW, codes in order, then the stops; unknown codes named", () => {
  const run = shuttleRun();
  c.__setState([run], "a1b2c3d4");
  c.__setSettings({ places: [] });
  const t739 = at(2026, 9, 29, 7, 39);
  let r = plain(c.routeStops(run, t739));
  assert.deepEqual(r.stops.map((s: any) => s.code), ["SGA", "NCA", "NCB", "MGW", "NCA"]);
  assert.deepEqual(r.missing, ["SGA", "NCB"]);
  c.__setSettings({ places: [
    { code: "SGA", name: "Sample Apartments", address: "3 Sample Terrace" },
    { code: "NCB", name: "", address: "4 Sample Road" },
  ] });
  r = plain(c.routeStops(run, t739));
  assert.deepEqual(r.missing, []);
  assert.equal(r.stops[0].text, "Sample Apartments, 3 Sample Terrace");
  assert.equal(r.stops[1].text, "Newburgh Center A, 1292 NY-300 Newburgh, NY 12550"); // a code the sheets know
  // Ticked legs drop out; before the run starts, every leg and every stop.
  const ticks = { [c.noteLines(run)[3].key]: "x" };
  store.set("fw_ticks", JSON.stringify(ticks));
  assert.deepEqual(plain(c.routeStops(run, t739)).stops.map((s: any) => s.code), ["NCA", "NCB", "MGW", "NCA"]);
  store.delete("fw_ticks");
  const before = plain(c.routeStops(run, at(2026, 9, 29, 5, 0))).stops.map((s: any) => s.code);
  assert.deepEqual(before.slice(0, 4), ["NCB", "SGA", "CLS", "CLN"]);
  // A leg that names a window ("back to ABS") names no place.
  run.driverNotes = "6:15 NCB to ABS.";
  delete run.lines; // built from the notes on first read
  assert.deepEqual(plain(c.routeStops(run, at(2026, 9, 29, 5, 0))).stops.map((s: any) => s.code), ["NCB", "MGW", "NCA"]);
  c.__setSettings({});
});

test("routeStops: an airport by name and its live terminal, a stop by the list's place first", () => {
  const run = overnight();
  run.steps.forEach((s: any) => { s.address = "1 Main St"; });
  c.__setState([run], "a1b2c3d4");
  c.__setSettings({ places: [{ code: "WKL", name: "Wallkill", address: "5 Sample Ave" }] });
  setStatuses({
    "UA1503:2026-08-31": { arrival: { terminal: "B" } },
    "WN748:2026-08-31": { arrival: { terminal: "Terminal B" } },
  });
  const r = plain(c.routeStops(run, at(2026, 8, 31, 18, 0)));
  assert.deepEqual(r.stops.map((s: any) => [s.code, s.text]), [
    ["FKL", "Fishkill, 1 Main St"], ["LGA", "LaGuardia Airport Terminal B"],
    ["WKL", "Wallkill, 5 Sample Ave"], ["FKL", "Fishkill, 1 Main St"],
  ]);
  setStatuses({ "UA1503:2026-08-31": { arrival: { terminal: "B" } }, "WN748:2026-08-31": { arrival: { terminal: "C" } } });
  assert.equal(plain(c.routeStops(run, at(2026, 8, 31, 18, 0))).stops[1].text, "LaGuardia Airport"); // they disagree
  setStatuses({});
  c.__setSettings({});
});

test("car's lot: FKL-NBD collects at NCA -- first in the route until the run starts; no other prefix guessed", () => {
  const run = overnight();
  run.steps.forEach((s: any) => { s.address = "1 Main St"; });
  run.parking = "FKL-NBD-014";
  c.ensureAddresses(run);
  c.__setState([run], "a1b2c3d4");
  c.__setSettings({ places: [] });
  const lot = plain(c.carLot(run));
  assert.deepEqual([lot.code, lot.name, lot.address], ["NCA", "Newburgh Center A", "1292 NY-300, Newburgh, NY 12550"]);
  const before = plain(c.routeStops(run, at(2026, 8, 31, 12, 0)));
  assert.deepEqual(before.stops.map((s: any) => s.code), ["NCA", "FKL", "LGA", "WKL", "FKL"]);
  assert.deepEqual([before.stops[0].key, before.stops[0].label, before.stops[0].text],
    ["lot:NCA", "the car", "Newburgh Center A, 1292 NY-300, Newburgh, NY 12550"]);
  assert.equal(plain(c.routeStops(run, at(2026, 8, 31, 22, 0))).stops[0].code, "LGA"); // under way: no lot
  // The list's own words for NCA win.
  c.__setSettings({ places: [{ code: "NCA", name: "", address: "9 Sample Rd" }] });
  assert.equal(plain(c.carLot(run)).address, "9 Sample Rd");
  assert.equal(plain(c.routeStops(run, at(2026, 8, 31, 12, 0))).stops[0].text, "Newburgh Center A, 9 Sample Rd");
  // Only the prefix the owner named.
  for (const p of ["FKL-014", "WRK-NBD-2", "", null]) { run.parking = p; assert.equal(c.carLot(run), null, String(p)); }
  run.parking = "fkl-nbd 7";
  assert.equal(c.carLot(run).code, "NCA");
  // The first stop says where the car is.
  run.parking = "FKL-NBD-014";
  const html = c.renderStep(run.steps[0], 0, run, at(2026, 8, 31, 12, 0), [], false, null, []);
  assert.match(html, /FKL-NBD-014 &middot; collect at <b>NCA<\/b>/);
  run.parking = "B-12";
  assert.doesNotMatch(c.renderStep(run.steps[0], 0, run, at(2026, 8, 31, 12, 0), [], false, null, []), /collect at/);
  c.__setSettings({});
});

test("the driver's route: reorder, leave out, add, start elsewhere -- this phone, this run; DISPATCH'S ORDER undoes all", () => {
  const run = overnight();
  run.steps.forEach((s: any, i: number) => { s.address = `${i} Main St`; });
  c.ensureAddresses(run);
  c.__setState([run], "a1b2c3d4");
  c.__setSettings({ places: [] });
  store.delete("fw_routes");
  const t = at(2026, 8, 31, 12, 0);
  const codes = () => plain(c.mapsRoute(run, t)).stops.map((s: any) => s.code);
  const keys = plain(c.routeStops(run, t)).stops.map((s: any) => s.key);
  assert.deepEqual(codes(), ["FKL", "LGA", "WKL", "FKL"]);
  assert.equal(c.mapsRoute(run, t).edited, false);
  c.editRoute(run, { move: [keys[2], -1] }, t);                   // WKL before LGA
  assert.deepEqual(codes(), ["FKL", "WKL", "LGA", "FKL"]);
  assert.equal(c.mapsRoute(run, t).edited, true);
  c.editRoute(run, { out: keys[0] }, t);                          // leave the first FKL out
  let r = plain(c.mapsRoute(run, t));
  assert.deepEqual(r.stops.map((s: any) => s.code), ["WKL", "LGA", "FKL"]);
  assert.deepEqual(r.out.map((s: any) => s.key), [keys[0]]);
  c.editRoute(run, { move: [keys[2], -1] }, t);                   // the top can't go higher
  assert.deepEqual(codes(), ["WKL", "LGA", "FKL"]);
  c.editRoute(run, { add: { code: "EWR", label: "", text: "Newark Liberty International Airport" } }, t);
  r = plain(c.mapsRoute(run, t));
  assert.deepEqual(r.stops.map((s: any) => [s.code, !!s.yours]), [["WKL", false], ["LGA", false], ["FKL", false], ["EWR", true]]);
  c.editRoute(run, { start: { code: "NCA", label: "Newburgh Center A", text: "1292 NY-300" } }, t);
  assert.equal(c.mapsRoute(run, t).start.code, "NCA");
  // A stop of the driver's own goes; one of dispatch's comes back.
  c.editRoute(run, { out: r.stops[3].key }, t);
  c.editRoute(run, { back: keys[0] }, t);
  assert.deepEqual(codes(), ["FKL", "WKL", "LGA", "FKL"]);
  // Kept per run, on this phone.
  assert.ok(JSON.parse(store.get("fw_routes"))[run.number]);
  // Undoing every change by hand is dispatch's order again: nothing kept.
  c.editRoute(run, { start: null }, t);
  c.editRoute(run, { move: [keys[2], 1] }, t);
  assert.equal(c.mapsRoute(run, t).edited, false);
  assert.equal(JSON.parse(store.get("fw_routes"))[run.number], undefined);
  // A stop the sheet adds later goes in after the stop it follows on the sheet.
  c.editRoute(run, { move: [keys[3], -1] }, t);                   // FKL(3) before WKL
  assert.deepEqual(codes(), ["FKL", "LGA", "FKL", "WKL"]);
  const added = { ...run.steps[2], _at: "9", code: "SWF", place: "Stewart", address: "1 Airport Rd" };
  run.steps.splice(3, 0, added);                                  // after WKL on the new sheet
  assert.deepEqual(codes(), ["FKL", "LGA", "FKL", "WKL", "SWF"]);
  run.steps.splice(3, 1);
  c.editRoute(run, { reset: true }, t);
  assert.equal(c.mapsRoute(run, t).edited, false);
  c.__setSettings({});
});

test("routeUrl: a start of the driver's own, and the same place twice in a row told once", () => {
  const stops = [{ text: "A St" }, { text: "B St" }, { text: "B St" }, { text: "C St" }];
  const apple = new URL(c.routeUrl("apple", stops, { text: "Lot 1" }));
  assert.equal(apple.searchParams.get("source"), "Lot 1");
  assert.deepEqual(apple.searchParams.getAll("waypoint"), ["A St", "B St"]);
  assert.equal(apple.searchParams.get("destination"), "C St");
  const google = new URL(c.routeUrl("google", stops, { text: "Lot 1" }));
  assert.equal(google.searchParams.get("origin"), "Lot 1");
  assert.equal(google.searchParams.get("waypoints"), "A St|B St");
  assert.equal(new URL(c.routeUrl("google", stops.slice(0, 1))).searchParams.get("origin"), null);
});

test("routeUrl: Apple repeats waypoint; Google pipes 9 waypoints and the destination, in order", () => {
  const stops = Array.from({ length: 12 }, (_, i) => ({ code: `S${i}`, text: `${i} Main St, Town` }));
  const apple = c.routeUrl("apple", stops);
  assert.match(apple, /^https:\/\/maps\.apple\.com\/directions\?destination=11%20Main%20St%2C%20Town&waypoint=0%20Main/);
  assert.equal(apple.split("&waypoint=").length - 1, 11);
  const google = new URL(c.routeUrl("google", stops));
  assert.equal(google.searchParams.get("destination"), "9 Main St, Town");
  assert.deepEqual(google.searchParams.get("waypoints")!.split("|").map((w) => w.split(" ")[0]), ["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(google.searchParams.get("api"), "1");
  assert.equal(google.searchParams.get("travelmode"), "driving");
});

test("legCodes: three capitals that are not words, or codes the list knows", () => {
  assert.deepEqual(plain(c.legCodes("Load Mail for ALL Sites check cabinets for Mail & WRK Lobby for Rushes", new Set())), ["WRK"]);
  assert.deepEqual(plain(c.legCodes("Depart from CLN, drop off at RCA, SGA and NCB upon request.", new Set())), ["CLN", "RCA", "SGA", "NCB"]);
  assert.deepEqual(plain(c.legCodes("Wash at B2 then HQ", new Set(["HQ"]))), ["HQ"]);
});

test("legs: the driver's time leads and keeps dispatch's tick; an added leg goes in by time; a dropped one leaves RIGHT NOW", () => {
  const run = shuttleRun();
  const lines = c.ensureLines(run);
  const star = lines.find((l: any) => l.printed.startsWith("7:45*"));
  star.line = "7:40a or 5 min after Morning Worship concludes, depart SGA for NCA.";
  star._edit = { line: { patchId: "p1", value: star.line, documentValue: star.printed, contested: false, agreed: false } };
  lines.push({ printed: null, line: "7:58a Wait at NCB lobby for late riders", _at: "+r9", _add: { patchId: "p2" } });
  lines.find((l: any) => l.printed === "7:55 NCA to NCB.")._removed = { patchId: "p3" };
  const legs = plain(c.noteLines(run));
  const edited = legs.find((l: any) => l.row._at === star._at);
  assert.equal(edited.time, "7:40a");
  assert.equal(edited.printedTime, "7:45a*");
  assert.equal(edited.key, "374819:7:45* or 5 min after Morning Worship concludes, depart SGA for NCA.");
  assert.deepEqual(legs.map((l: any) => l.time), ["6:15a", "6:25a", "7:10a", "7:40a", "7:55a", "7:58a", "8:00a"]);
  assert.equal(legs[5].key, "374819:+r9");
  const placed = c.placeNoteLines(run);
  const ahead = c.legsAhead(run, placed, 1);
  assert.deepEqual(plain(ahead).map((l: any) => l.time), ["7:40a", "7:58a", "8:00a"]); // 7:55 not happening
  assert.equal(c.nowLeg(ahead, at(2026, 9, 29, 7, 39), {}), 0);                         // the driver's 7:40
  assert.equal(c.nowLeg(ahead, at(2026, 9, 29, 7, 56), {}), 0);                         // holds until 7:58
});

test("legs: a queued correction, add and removal show at once, as the server will apply them", () => {
  const run = shuttleRun();
  c.ensureAddresses(run);
  const op = (ref: string, body: object) => ({ ref, madeAt: "2026-09-29T11:00:00Z", listCode: "a1b2c3d4", number: "374819", kind: "post", body });
  c.overlayPost(run, op("q1", { at: "n0", field: "line", value: "6:20a NCB to SGA.", was: "6:15 NCB to SGA." }));
  c.overlayPost(run, op("q2", { kind: "addLeg", leg: { line: "7:58a Wait at NCB lobby" } }));
  c.overlayPost(run, op("q3", { kind: "remove", at: "n4" }));
  const lines = plain(run.lines);
  assert.equal(lines[0].line, "6:20a NCB to SGA.");
  assert.equal(lines[0]._edit.line.documentValue, "6:15 NCB to SGA.");
  assert.equal(lines[0]._edit.line.pending, true);
  assert.equal(lines.at(-1)._at, "+q2");
  assert.ok(lines[4]._removed);
  c.overlayDelete(run, "q:q2");
  assert.equal(run.lines.some((l: any) => l._at === "+q2"), false);
});

test("routeOf: windows by their label, commas between windows in a row", () => {
  assert.equal(c.routeOf(shuttleRun()), "CLD Shuttle, After Breakfast Shuttle → MGW → NCA");
  const run = overnight();
  run.steps.forEach((s: any) => { s.address = "1 Main St"; });
  assert.equal(c.routeOf(run), "FKL → LGA → WKL → FKL");
});

/* ----------------------------------------------------------------- outbox -- */

const LS = (k: string, v?: unknown) => {
  if (v === undefined) return JSON.parse(store.get(k) ?? "null");
  store.set(k, JSON.stringify(v));
};

/** 369736 as GET serves it, with a passenger the driver added (patch P1, ref r1). */
function servedWithAdd(): any {
  const run = overnight();
  const change = { patchId: "P1", kind: "addEntity", label: "Roe, Rick", agreed: false, at: "", ref: "r1" };
  run.steps[1].actions[0].entities.push({ name: "Roe, Rick", pax: 1, _add: change, _at: "+r1" });
  run.changes = [change];
  return run;
}

test("outbox: a sent edit is recognised by its ref when the server kept the other copy", () => {
  // The phone sent it twice (the first answer was lost); it holds P2, the server shows P1.
  const run = servedWithAdd();
  c.__setState([run], "L1");
  LS("fw_outbox", []);
  LS("fw_sent", [{
    kind: "post", listCode: "L1", number: "369736", ref: "r1", patchId: "P2",
    madeAt: new Date().toISOString(), sentAt: new Date().toISOString(),
    body: { kind: "addEntity", at: "1.0", entity: { name: "Roe, Rick" } },
  }]);
  c.overlayOutbox();
  const names = plain(c.__assignments()[0].steps[1].actions[0].entities).map((e: any) => e.name);
  assert.deepEqual(names, ["Pax UA1503", "Pax WN748", "Roe, Rick"]);
  c.pruneSent();
  assert.deepEqual(LS("fw_sent"), []);
});

test("outbox: an edit undone after its send timed out is removed once the server shows it", async () => {
  const requests: { method: string; body: any }[] = [];
  let served: any = overnight();
  let online = false;
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async (url: string, init: any = {}) => {
    const method = init.method || "GET";
    requests.push({ method, body: init.body ? JSON.parse(init.body) : null });
    // The server saves the POST; the answer is lost to one bar (the 10s abort).
    if (method === "POST") { served = servedWithAdd(); throw new Error("aborted"); }
    if (!online) throw new Error("no signal");
    if (method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ assignments: [structuredClone(served)] }), { status: 200 });
  };
  c.__setState([overnight()], "L1");
  LS("fw_sent", []);
  LS("fw_undone", []);
  LS("fw_outbox", [{
    kind: "post", ref: "r1", listCode: "L1", number: "369736", madeAt: new Date().toISOString(),
    body: { kind: "addEntity", at: "1.0", entity: { name: "Roe, Rick" } },
  }]);

  await c.flush();
  assert.equal(LS("fw_outbox")[0].tried, true); // still queued: no answer came back

  c.removePatch("369736", "q:r1"); // UNDO, while the server already has it
  assert.deepEqual(LS("fw_outbox"), []);

  online = true;
  await c.loadAssignments();
  await c.flush();
  const del = requests.find((r) => r.method === "DELETE");
  assert.ok(del, "the undone edit's removal is sent");
  assert.equal(del!.body.id, "P1");
  // And it is not drawn while that removal is on its way.
  const names = plain(c.__assignments()[0].steps[1].actions[0].entities).map((e: any) => e.name);
  assert.ok(!names.includes("Roe, Rick"));
});

test("a load answered after the list was switched is dropped: another list's runs never show", async () => {
  let answer: () => void = noop;
  const slow = new Promise<void>((r) => { answer = r; });
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async () => {
    await slow; // one bar: the old list's load is still out
    return new Response(JSON.stringify({ assignments: [overnight()], stamp: "s1" }), { status: 200 });
  };
  LS("fw_outbox", []);
  LS("fw_sent", []);
  c.__setState([], "L1");
  store.delete("fw_assign_cache");
  const load = c.loadAssignments();
  // The driver enters another list's code meanwhile (app.js adoptCode).
  vm.runInContext('listCode = "L2"; forgetAssignments();', ctx);
  answer();
  await load;
  assert.deepEqual(plain(c.__assignments()), [], "L1's runs are not painted under L2");
  assert.equal(store.has("fw_assign_cache"), false, "nor saved as L2's copy");

  // And a load that FAILS after the switch says nothing about the new list.
  (ctx as any).fetch = async () => { throw new Error("no signal"); };
  c.__setState([], "L1");
  const failing = c.loadAssignments();
  vm.runInContext('listCode = "L2"; offline = false;', ctx);
  await failing;
  assert.equal(vm.runInContext("offline", ctx), false);
});

/* ------------------------------------------------------------- escaping -- */

test("renderStep: a flight number in the clocks' why-lines is escaped, once", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  setStatuses({ [`${evil}:2026-08-31`]: arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41") });
  const run = overnight();
  const lga = run.steps[1];
  lga.actions[0].entities = [{ ...lga.actions[0].entities[0], flightNumber: evil }];
  const html = c.renderStep(lga, 1, run, at(2026, 8, 31, 22, 0), []);
  assert.ok(!html.includes("<img"), "no raw markup from a flight number");
  assert.match(html, /<span class="why">before &lt;img src=x onerror=alert\(1\)&gt; lands 11:41p/);
  assert.match(html, /<span class="why">&lt;img src=x onerror=alert\(1\)&gt; 11:41p \+ 45m bags/);
  assert.ok(!html.includes("&amp;lt;"), "not escaped twice");
  setStatuses({});
});

/* ------------------------------------------------------------ added stops -- */

test("addedStopDay: the day that puts the time inside the run, else nearest it", () => {
  const run = overnight(); // 2026-08-31 21:30 -> 2026-09-01 03:00
  assert.equal(c.addedStopDay(run, "1:30 AM"), "2026-09-01");
  assert.equal(c.addedStopDay(run, "10:00 PM"), "2026-08-31");
  assert.equal(c.addedStopDay(run, "5:00 AM"), "2026-09-01");  // 2h after the end beats 16h before the start
  assert.equal(c.addedStopDay(run, "8:00 PM"), "2026-08-31");  // 1h30 before the start
  const day = shuttle(); // 2026-05-06 08:00 -> 09:50
  assert.equal(c.addedStopDay(day, "7:00 AM"), "2026-05-06");
  assert.equal(c.addedStopDay(day, "11:30 PM"), "2026-05-06");
  assert.equal(c.addedStopDay(day, null), "2026-05-06");
});

test("saveAdd: a stop added at 1:30 AM on an evening run is dated the next morning", () => {
  const fields: Record<string, any> = {
    "r-place": { value: "EWR" }, "r-time": { value: "01:30" }, "r-date": { value: "2026-08-31" },
    "r-verb": { value: "Pickup" }, "r-where": { value: "" }, "row-error": { textContent: "" },
  };
  const doc = (ctx as any).document;
  const was = doc.getElementById;
  doc.getElementById = (id: string) => fields[id] ?? { value: "", textContent: "" };
  (ctx as any).closeSheet = noop;
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async () => { throw new Error("no signal"); };
  try {
    c.__setState([overnight()], "L1");
    LS("fw_outbox", []);
    LS("fw_sent", []);
    vm.runInContext("adding = { number: '369736', mode: 'step' };", ctx);
    c.saveAdd({ preventDefault: noop });
    const op = LS("fw_outbox")[0];
    assert.equal(op.body.step.date, "2026-09-01");
    assert.equal(op.body.step.time, "1:30 AM");

    // A date the driver picked on purpose stands.
    LS("fw_outbox", []);
    vm.runInContext("adding = { number: '369736', mode: 'step', dateTouched: true };", ctx);
    c.saveAdd({ preventDefault: noop });
    assert.equal(LS("fw_outbox")[0].body.step.date, "2026-08-31");
  } finally {
    doc.getElementById = was;
  }
});

test("outbox: an edit undone before it ever left the phone leaves nothing to chase", () => {
  c.__setState([overnight()], "L1");
  LS("fw_undone", []);
  LS("fw_outbox", [{ kind: "post", ref: "r2", listCode: "L1", number: "369736", madeAt: "", body: {} }]);
  c.removePatch("369736", "q:r2");
  assert.deepEqual(LS("fw_undone"), []);
});

test("calls: after today's morning run, the list is tomorrow's; before an evening run, today's", () => {
  const run = (number: string, start: string) => ({ number, start, end: start, steps: [] });
  const withPickup = (number: string, start: string) => ({ ...run(number, start), steps: [{
    date: start.slice(0, 10), eta: "8:00 AM",
    actions: [{ verb: "Pickup", entities: [{ name: "Doe, Jan", phone: "+1 555-0100-000" }] }] }] });
  c.__setState([withPickup("1", "2026-09-26 06:00"), withPickup("2", "2026-09-26 19:30"),
                withPickup("3", "2026-09-27 07:00")], "abcd1234");
  assert.equal(c.nextAssignmentDay(new Date(2026, 8, 26, 17, 0)), "2026-09-26");  // 7:30p not started
  assert.equal(c.nextAssignmentDay(new Date(2026, 8, 26, 19, 31)), "2026-09-27");
  c.__setState([withPickup("1", "2026-09-26 06:00"), withPickup("3", "2026-09-27 07:00")], "abcd1234");
  assert.equal(c.nextAssignmentDay(new Date(2026, 8, 26, 17, 0)), "2026-09-27");  // review #4
  assert.equal(c.nextAssignmentDay(new Date(2026, 8, 27, 8, 0)), null);
  // Tonight's dispatch shift has no one to call: the bar is tomorrow's.
  c.__setState([run("2", "2026-09-26 18:00"), withPickup("3", "2026-09-27 08:00")], "abcd1234");
  assert.equal(c.nextAssignmentDay(new Date(2026, 8, 26, 17, 0)), "2026-09-27");
  c.__setState([run("1", "2026-09-26 06:00"), run("3", "2026-09-27 07:00")], "abcd1234");
  assert.deepEqual(plain(c.callDays()), []);   // runs with no one to call
  // The day arrows step only onto days with someone to call.
  c.__setState([withPickup("1", "2026-09-26 06:00"), run("3", "2026-09-27 07:00"),
                withPickup("4", "2026-09-28 07:00")], "abcd1234");
  assert.deepEqual(plain(c.callDays()), ["2026-09-26", "2026-09-28"]);
  c.__setState([], null);
});

/* ------------------------------------------------------------ messages -- */

// WRK -> JFK -> WRK: a departing couple collected at their door, an arriving
// single collected at the airport, both taken on from where they were collected.
function messagedRun(): any {
  const castillo = { name: "Castillo, Ana & Luis", pax: 2, tag: "D", phone: "(845) 555-0142",
    otherPhones: ["(845) 555-0187"], flightNumber: "DL404", flightDate: "2026-09-29" };
  const okafor = { name: "Okafor, Daniel", pax: 1, tag: "A", phone: "(914) 555-0163",
    flightNumber: "B61123", flightDate: "2026-09-29", scheduledText: "9:05 AM Orlando, Florida (MCO)" };
  return {
    number: "380114", start: "2026-09-29 05:30", end: "2026-09-29 13:15",
    steps: [
      { _at: "0", code: "WRK", place: "Warwick", date: "2026-09-29", eta: "5:30 AM", etd: "5:40 AM",
        actions: [{ _at: "0.0", verb: "Pickup", where: "A-res WRK", entities: [castillo] }] },
      { _at: "1", code: "JFK", place: "Kennedy", date: "2026-09-29", eta: "7:10 AM", etd: "10:30 AM",
        actions: [{ _at: "1.0", verb: "Drop-off", where: "Departure Terminal", entities: [castillo] },
                  { _at: "1.1", verb: "Pickup", where: "Baggage Claim", entities: [okafor] }] },
      { _at: "2", code: "WRK", place: "Warwick", date: "2026-09-29", eta: "12:30 PM", etd: "1:15 PM",
        actions: [{ _at: "2.0", verb: "Drop-off", where: "", entities: [okafor] }] },
    ],
  };
}

test("messages: a passenger's facts are their own pickup and drop-off, as dispatch printed them", () => {
  const run = messagedRun();
  setStatuses({});
  const [castillo] = run.steps[0].actions[0].entities;
  const [okafor] = run.steps[1].actions[1].entities;
  assert.deepEqual(plain(c.messageFacts(run, castillo)), {
    name: "Castillo, Ana & Luis", phone: "(845) 555-0142", pax: 2, tag: "D", kind: "departure",
    from: "Warwick", to: "JFK", door: "A-res WRK", flight: "DL404", time: "5:30a", appointment: null, day: "2026-09-29",
  });
  // An arrival: the airport by its code, the landing as printed until the
  // flight is tracked; the places are sites, the door is the pickup's.
  const f = plain(c.messageFacts(run, okafor));
  assert.equal(f.from, "JFK");
  assert.equal(f.to, "Warwick");
  assert.equal(f.door, "Baggage Claim");
  // A pickup door left blank on the sheet falls back to the place.
  run.steps[0].actions[0].where = "";
  assert.equal(c.messageFacts(run, castillo).door, "Warwick");
  run.steps[0].actions[0].where = "A-res WRK";
  assert.equal(f.time, "9:05a");
  setStatuses({ "B61123:2026-09-29": { status: "Expected", arrival: {
    scheduledTime: "2026-09-29 09:05-04:00", estimatedTime: "2026-09-29 09:42-04:00" } } });
  assert.equal(c.messageFacts(run, okafor).time, "9:42a");   // live beats printed
  setStatuses({});
  // Someone no pickup lists still gets a message, with brackets where it can't say.
  const loose = plain(c.messageFacts(run, { name: "Added, Person", pax: 1, tag: "MED", appointmentTime: "10:30 AM" }));
  assert.deepEqual([loose.kind, loose.from, loose.time, loose.appointment], ["medical", null, null, "10:30a"]);
});

test("messages: the draft the evening before, an empty chat on the day", () => {
  const run = messagedRun();
  setStatuses({});
  const [castillo] = run.steps[0].actions[0].entities;
  const [okafor] = run.steps[1].actions[1].entities;
  LS("fw_messages", {});
  LS("fw_greet", {});
  const eve = new Date(2026, 8, 28, 19, 0);
  const facts = c.messageFacts(run, castillo);
  assert.match(c.messageText(run, facts, eve), /^Dear Family Castillo,\nI have the pleasure .* from Warwick to JFK for flight DL404\.\nI'll meet you outside A-res WRK at 5:30a\.[^]*See you tomorrow!\n-\[MY NAME\]$/);
  assert.equal(c.messageText(run, facts, new Date(2026, 8, 29, 4, 30)), "");
  // A single's greeting is asked once, before a draft that uses it.
  const of = c.messageFacts(run, okafor);
  assert.equal(c.needsGreeting(run, of, eve), true);
  assert.equal(c.needsGreeting(run, facts, eve), false);               // a family
  assert.equal(c.needsGreeting(run, of, new Date(2026, 8, 29, 8, 0)), false);  // an empty chat
  LS("fw_greet", { "Okafor, Daniel": "brother" });
  assert.equal(c.needsGreeting(run, of, eve), false);
  assert.match(c.messageText(run, of, eve), /^Dear Brother Okafor,\n.*from JFK to Warwick\.\nI'll meet you outside baggage claim when flight B61123 lands at 9:05a\./);
  LS("fw_messages", { arrival: "Hi [LAST NAME]" });
  assert.equal(c.needsGreeting(run, { ...of, name: "Other, Single" }, eve), false);  // no [NAME] in it
  assert.equal(c.messageText(run, of, eve), "Hi Okafor");
  LS("fw_messages", {});
  LS("fw_greet", {});
});

test("messages: the list's time is the message's time", () => {
  c.__setState([messagedRun()], "L1");
  setStatuses({});
  const rows = plain(c.callsFor("2026-09-29"));
  assert.deepEqual(rows.map((r: any) => [r.name, r.when, r.place]),
    [["Castillo, Ana & Luis", "5:30a", "WRK"], ["Okafor, Daniel", "9:05a", "JFK"]]);
  c.__setState([], null);
});

/* ------------------------------------------------ RIGHT NOW, freshness, live -- */

test("RIGHT NOW: parked-by until it passes, then the leaving clock, marked ~ with its reason", () => {
  setStatuses({
    "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41"),
    "WN748:2026-08-31": arriving("America/Chicago", "2026-08-31 23:20", "2026-08-31 23:52"),
  });
  const lga = overnight().steps[1];
  const clocks = clocksFor(lga);
  assert.equal(c.nowWhy(lga, clocks, at(2026, 8, 31, 23, 25)), "Parked by 11:26p · before UA1503 lands 11:41p");
  assert.equal(c.nowWhy(lga, clocks, at(2026, 8, 31, 23, 26)), "Leaving ~12:37a · WN748 11:52p + 45m bags");
  // No flight clocks: dispatch's time, said as dispatch's.
  setStatuses({});
  const wkl = overnight().steps[2];
  assert.equal(c.nowWhy(wkl, clocksFor(wkl), at(2026, 9, 1, 1, 0)), "Dispatch has you there at 2:15a");
});

test("RIGHT NOW: a departure has no leaving clock, so parked-by stays", () => {
  const jfk = { code: "JFK", place: "JFK", eta: "6:00 PM", etd: "6:15 PM", date: "2026-09-02", etaDate: "2026-09-02",
    actions: [{ verb: "Drop-Off", where: "T4", entities: [{ name: "P", tag: "D", flightNumber: "DL1", flightDate: "2026-09-02" }] }] };
  setStatuses({ "DL1:2026-09-02": departing("America/Chicago", "2026-09-02 20:00") });
  const clocks = clocksFor(jfk);
  assert.equal(c.nowWhy(jfk, clocks, at(2026, 9, 2, 19, 0)), "Parked by 6:00p · DL1 check-in, 2h domestic");
  setStatuses({});
});

test("freshness: the newest check among this run's flights, none when none was checked", () => {
  const run = overnight();
  setStatuses({});
  assert.equal(c.flightsCheckedAt(run), null);
  setStatuses({
    "UA1503:2026-08-31": { ...arriving("America/Chicago", "2026-08-31 23:15"), fetchedAt: "2026-09-01T03:10:00.000Z" },
    "WN748:2026-08-31": { ...arriving("America/Chicago", "2026-08-31 23:20"), fetchedAt: "2026-09-01T03:30:00.000Z" },
    "XX1:2026-08-31": { ...arriving("America/Chicago", "2026-08-31 23:20"), fetchedAt: "2026-09-01T03:59:00.000Z" },
  });
  assert.equal(c.flightsCheckedAt(run), "2026-09-01T03:30:00.000Z");
  // A passenger the driver said is not coming is not this run's flight any more.
  run.steps[1].actions[0].entities[1]._removed = { patchId: "p" };
  run.steps[2].actions[0].entities[0]._removed = { patchId: "p" };
  assert.equal(c.flightsCheckedAt(run), "2026-09-01T03:10:00.000Z");
  setStatuses({});
  const t = Date.parse("2026-09-01T03:30:00.000Z");
  assert.equal(c.checkedLabel("2026-09-01T03:29:40.000Z", t), "Flights checked just now");
  assert.equal(c.checkedLabel("2026-09-01T03:18:00.000Z", t), "Flights checked 12m ago");
  assert.equal(c.checkedLabel("2026-09-01T01:10:00.000Z", t), "Flights checked 2h ago");
  assert.equal(c.checkedLabel("2026-08-29T03:30:00.000Z", t), "Flights checked 3d ago");
});

test("international means outside the US, by country or else by a US zone", () => {
  const leg = (timeZone: string | null, countryCode?: string) => ({ timeZone, countryCode });
  const s = (dep: object, arr: object) => ({ departure: dep, arrival: arr });
  const ny = leg("America/New_York");
  assert.equal(ctx.isIntl(s(leg("America/Cancun"), ny)), true);
  assert.equal(ctx.isIntl(s(leg("America/Bogota"), ny)), true);
  assert.equal(ctx.isIntl(s(ny, leg("America/Toronto"))), true);
  assert.equal(ctx.isIntl(s(leg("America/Chicago"), ny)), false);
  assert.equal(ctx.isIntl(s(leg("Pacific/Honolulu"), ny)), false);
  assert.equal(ctx.isIntl(s(leg("America/Puerto_Rico"), ny)), false);
  assert.equal(ctx.isIntl(s(leg("America/Chicago", "MX"), leg("America/New_York", "US"))), true);
  assert.equal(ctx.isIntl(s(leg(null), ny)), null);
});

test("a run is live past its printed end while a late flight is still to be met", () => {
  const run = overnight();
  // WN748 lands 2:50 AM, three hours late: Leaving 3:35a, past the 3:00 AM end.
  setStatuses({ "WN748:2026-08-31": arriving("America/Chicago", "2026-08-31 23:20", "2026-09-01 02:50") });
  assert.equal(c.effectiveEnd(run), "2026-09-01 03:35");
  assert.equal(c.isInProgress(run, "2026-09-01 03:10"), true);
  assert.equal(c.isInProgress(run, "2026-09-01 03:40"), false);
  setStatuses({});
  assert.equal(c.effectiveEnd(run), "2026-09-01 03:00", "on time, the printed end stands");
});

test("clocks across a DST change count real minutes, as the push does", () => {
  const stop = (date: string, tag: string) => ({
    code: "EWR", place: "Newark", eta: "1:30 AM", etd: "2:30 AM", date, etaDate: date,
    actions: [{ verb: "Pickup", entities: [{ name: "Doe, Jan", tag, flightNumber: "UA1", flightDate: date }] }],
  });
  // Fall back: lands 1:30 EDT; 45 real minutes later the clock reads 1:15 EST.
  setStatuses({ "UA1:2026-11-01": arriving("America/Chicago", "2026-11-01 01:30") });
  assert.equal(clocksFor(stop("2026-11-01", "A")).leavingAt, wallAt("2026-11-01", hm(1, 15)));
  // Spring forward: departs 4:00 EDT; check-in two real hours earlier is 1:00 EST.
  setStatuses({ "UA1:2027-03-14": departing("America/Chicago", "2027-03-14 04:00") });
  assert.equal(clocksFor(stop("2027-03-14", "D")).parkedBy, wallAt("2027-03-14", hm(1, 0)));
  setStatuses({});
});

/* ---------------------------------------------------------------- imports -- */

/** A sheet as the phone reads it: 369736's shape under another number. */
function sheet(number: string, printedAt: string | null): any {
  return { ...overnight(), number, printedAt, issues: [] };
}

/** The one element the import code reaches for (the screen-reader line). */
async function withDom<T>(fn: () => T | Promise<T>): Promise<T> {
  const doc = (ctx as any).document;
  const was = doc.getElementById;
  doc.getElementById = () => null;
  try { return await fn(); } finally { doc.getElementById = was; }
}

const importLines = () => plain(vm.runInContext("importLines", ctx));

test("imports: the server's answer, as the line says it", () => {
  const op = { printedAt: "2026-08-31 19:18" };
  assert.equal(c.importOutcome(op, 200, { applied: true }), "new");
  assert.equal(c.importOutcome(op, 200, { applied: true, replaced: true }), "updated");
  // "a newer copy is already stored" is also the answer to an equal print.
  assert.equal(c.importOutcome(op, 200, { applied: false, assignment: { printedAt: "2026-08-31 19:18" } }), "same");
  assert.equal(c.importOutcome(op, 200, { applied: false, assignment: { printedAt: "2026-08-31 20:42" } }), "older");
  assert.equal(c.importOutcome(op, 404, { error: "Unknown listCode" }), "gone");
  assert.equal(c.importOutcome(op, 413, { error: "too many steps (max 60)" }), "refused");
});

test("imports: the phone answers what it already knows, and queues the rest", () => {
  c.__setState([sheet("900736", "2026-08-31 20:42")], "L1");
  LS("fw_outbox", []);
  vm.runInContext("importLines = []", ctx);
  assert.equal(c.queueImport(sheet("900736", "2026-08-31 20:42"), "a.pdf"), null); // this print is here
  assert.equal(c.queueImport(sheet("900736", "2026-08-31 19:18"), "b.pdf"), null); // an older one
  assert.ok(c.queueImport(sheet("900736", "2026-08-31 21:55"), "c.pdf"));         // newer: to the server
  assert.equal(c.queueImport(sheet("900736", "2026-08-31 21:55"), "d.pdf"), null); // already waiting
  assert.ok(c.queueImport(sheet("900737", "2026-08-31 19:18"), "e.pdf"));         // a new run
  assert.deepEqual(importLines().map((l: any) => l.state), ["same", "older", "sending", "already", "sending"]);
  assert.deepEqual(importLines().map((l: any) => l.theirs ?? null),
    ["2026-08-31 20:42", "2026-08-31 20:42", null, null, null]);
  assert.deepEqual(LS("fw_outbox").map((o: any) => [o.kind, o.number, o.printedAt, o.file]),
    [["import", "900736", "2026-08-31 21:55", "c.pdf"], ["import", "900737", "2026-08-31 19:18", "e.pdf"]]);
});

test("imports: a new run waiting for signal shows at once; a newer copy never covers the driver's", () => {
  c.__setState([sheet("900736", "2026-08-31 20:42")], "L1");
  LS("fw_sent", []);
  LS("fw_outbox", [
    { kind: "import", ref: "r1", listCode: "L1", number: "900737", printedAt: "2026-08-31 19:18", madeAt: "",
      assignment: sheet("900737", "2026-08-31 19:18") },
    { kind: "import", ref: "r2", listCode: "L1", number: "900736", printedAt: "2026-08-31 21:55", madeAt: "",
      assignment: sheet("900736", "2026-08-31 21:55") },
    { kind: "import", ref: "r3", listCode: "L2", number: "900738", printedAt: null, madeAt: "",
      assignment: sheet("900738", null) },
  ]);
  c.overlayOutbox();
  const runs = plain(c.__assignments());
  const queued = runs.find((a: any) => a.number === "900737");
  assert.equal(queued._queued, "r1");
  assert.equal(queued.importedAt, "q:r1", "edits made on it name the queued sheet as their basis");
  assert.equal(queued.steps[1].actions[0].entities[0]._at, "1.0.0");
  const updated = runs.find((a: any) => a.number === "900736");
  assert.equal(updated.printedAt, "2026-08-31 20:42", "the copy the server corrected stays on screen");
  assert.deepEqual(updated._newer, { printedAt: "2026-08-31 21:55", sent: false });
  assert.ok(!runs.some((a: any) => a.number === "900738"), "another list's queue");
});

test("imports: sent once a bar is back, its edits re-aimed, and drawn until GET shows it", async () => {
  const requests: any[] = [];
  let stored: any = null;
  let lag = true; // KV's list lag: GET does not show a new run at first
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async (url: string, init: any = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method, body, code: init.headers && init.headers["X-List-Code"] });
    if (method === "POST" && url.endsWith("/api/assignments")) {
      stored = { ...body, importedAt: "2026-09-28T12:00:00.000Z" };
      return new Response(JSON.stringify({ assignment: stored, applied: true, replaced: false }), { status: 200 });
    }
    if (method === "POST") return new Response(JSON.stringify({ patch: { id: "P9" } }), { status: 201 });
    const shown = lag ? [] : [{ ...structuredClone(stored), edits: [{ patchId: "P9", ref: "r2", field: "phone" }] }];
    return new Response(JSON.stringify({ assignments: shown }), { status: 200 });
  };
  c.__setState([], "L1");
  LS("fw_sent", []);
  LS("fw_undone", []);
  LS("fw_lost", []);
  LS("fw_outbox", [
    { kind: "import", ref: "r1", listCode: "L1", number: "900737", file: "a.pdf", printedAt: "2026-08-31 19:18",
      madeAt: "", assignment: sheet("900737", "2026-08-31 19:18") },
    { kind: "post", ref: "r2", listCode: "L1", number: "900737", madeAt: "", label: "Phone",
      body: { at: "1.0.0", field: "phone", value: "+1 555 010 7777", was: null, basis: "q:r1" } },
  ]);
  vm.runInContext("importLines = [{ ref: 'r1', file: 'a.pdf', number: '900737', state: 'sending' }]", ctx);
  await withDom(() => c.flush());

  const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/api/assignments"));
  assert.equal(post.code, "L1", "the list code rides in its header");
  assert.equal(post.body.number, "900737");
  const patch = requests.find((r) => r.url.endsWith("/api/assignments/patches"));
  assert.equal(patch.body.basis, "2026-09-28T12:00:00.000Z", "aimed at the server's copy, not the queued one");
  assert.equal(importLines()[0].state, "new");
  assert.deepEqual(LS("fw_outbox"), []);
  // GET lags: the run is drawn from the server's answer, the edit still on it.
  let run = plain(c.__assignments()).find((a: any) => a.number === "900737");
  assert.ok(run, "drawn while GET catches up");
  assert.equal(run.importedAt, "2026-09-28T12:00:00.000Z");
  assert.equal(run.steps[1].actions[0].entities[0].phone, "+1 555 010 7777");
  assert.deepEqual(LS("fw_sent").map((o: any) => o.kind).sort(), ["import", "post"]);

  lag = false;
  await withDom(() => c.loadAssignments());
  run = plain(c.__assignments()).find((a: any) => a.number === "900737");
  assert.ok(run && !run._queued);
  assert.deepEqual(LS("fw_sent"), [], "the server's copy took over");
});

test("imports: edits on a queued sheet follow it only to the same print", async () => {
  (ctx as any).renderCurrent = noop;
  const cases: [string, string, string, string[]][] = [
    ["2026-08-31 19:18", "same", "2026-09-28T09:00:00.000Z", ["import"]], // the same print: the same rows
    ["2026-08-31 20:42", "older", "q:r1", []],                            // another sheet: left for the 409
  ];
  for (const [printedAt, state, basis, ledger] of cases) {
    (ctx as any).fetch = async (url: string, init: any = {}) => {
      if (url.endsWith("/patches")) throw new Error("no signal"); // so the edit stays queued, as re-aimed
      if ((init.method || "GET") === "POST") {
        return new Response(JSON.stringify({ applied: false, reason: "a newer copy is already stored",
          assignment: { number: "900737", printedAt, importedAt: "2026-09-28T09:00:00.000Z" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ assignments: [] }), { status: 200 });
    };
    c.__setState([], "L1");
    LS("fw_sent", []);
    LS("fw_outbox", [
      { kind: "import", ref: "r1", listCode: "L1", number: "900737", printedAt: "2026-08-31 19:18", madeAt: "",
        assignment: sheet("900737", "2026-08-31 19:18") },
      { kind: "post", ref: "r2", listCode: "L1", number: "900737", madeAt: "", body: { at: "1.0.0", basis: "q:r1" } },
    ]);
    vm.runInContext("importLines = []", ctx);
    await withDom(() => c.flush());
    assert.equal(importLines()[0].state, state);
    assert.equal(LS("fw_outbox")[0].body.basis, basis);
    // The same print is drawn from the answer until GET shows it; another is never drawn.
    assert.deepEqual(LS("fw_sent").map((o: any) => o.kind), ledger);
  }
});

test("imports: a retry whose first answer was lost says New run, not Already here", async () => {
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async (url: string, init: any = {}) => ((init.method || "GET") === "POST"
    ? new Response(JSON.stringify({ applied: false, reason: "a newer copy is already stored",
        assignment: { ...sheet("900737", "2026-08-31 19:18"), importedAt: "2026-09-28T09:00:00.000Z" } }), { status: 200 })
    : new Response(JSON.stringify({ assignments: [] }), { status: 200 }));
  for (const [update, state] of [[false, "new"], [true, "same"]] as const) {
    c.__setState([], "L1");
    LS("fw_sent", []);
    LS("fw_outbox", [{ kind: "import", ref: "r1", listCode: "L1", number: "900737", printedAt: "2026-08-31 19:18",
      madeAt: "", tried: true, update, assignment: sheet("900737", "2026-08-31 19:18") }]);
    vm.runInContext("importLines = []", ctx);
    await withDom(() => c.flush());
    assert.equal(importLines()[0].state, state);
  }
  // Nobody's line on another list's screen.
  c.__setState([], "L2");
  LS("fw_outbox", [{ kind: "import", ref: "r1", listCode: "L1", number: "900737", printedAt: "2026-08-31 19:18",
    madeAt: "", assignment: sheet("900737", "2026-08-31 19:18") }]);
  vm.runInContext("importLines = []", ctx);
  await withDom(() => c.flush());
  assert.deepEqual(importLines(), []);
});

test("imports: edits made while an update waits are sent before it, so it carries them over", () => {
  LS("fw_outbox", [
    { kind: "import", ref: "r1", listCode: "L1", number: "900736", printedAt: "2026-08-31 21:55", update: true },
    { kind: "import", ref: "r2", listCode: "L1", number: "900737", printedAt: "2026-08-31 19:18" },
    { kind: "post", ref: "r3", listCode: "L1", number: "900737", body: { at: "1.0.0", basis: "q:r2" } },
    { kind: "post", ref: "r4", listCode: "L1", number: "900736", body: { at: "1.0.0", basis: "2026-09-28T09:00:00.000Z" } },
  ]);
  assert.equal(c.nextOp().ref, "r4", "made on the copy the server holds: first");
  LS("fw_outbox", LS("fw_outbox").filter((o: any) => o.ref !== "r4"));
  assert.equal(c.nextOp().ref, "r1");
  LS("fw_outbox", LS("fw_outbox").filter((o: any) => o.ref !== "r1"));
  assert.equal(c.nextOp().ref, "r2", "an edit on a waiting sheet waits for it");
});

/* import.js, in the same context: the ways in need a DOM, reading does not. */
{
  const doc = (ctx as any).document;
  const was = doc.getElementById;
  doc.getElementById = () => ({ addEventListener: noop });
  vm.runInContext(readFileSync(new URL("import.js", pub), "utf8"), ctx, { filename: "import.js" });
  doc.getElementById = was;
}

/** A picked file, as the browser hands it over. */
const picked = (name: string, bytes: Uint8Array, size = bytes.length) =>
  ({ name, size, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const fixturePdf = (name: string) => new Uint8Array(readFileSync(new URL(`../../tools/pdf-fixtures/${name}`, import.meta.url)));

test("import.js: each file read in order; a reader bug is one line, and the next file still reads", async () => {
  const { readSheet } = await import("../../public/importer/index.js");
  (ctx as any).showImports = noop;
  (ctx as any).loadReader = async () => ({
    readSheet: (bytes: Uint8Array, name: string) => {
      if (name === "boom.pdf") throw new RangeError("a bug in the reader");
      return readSheet(bytes, name);
    },
  });
  c.__setState([], "L1");
  LS("fw_outbox", []);
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    await c.importFiles([
      picked("boom.pdf", fixturePdf("dispatch-369736.pdf")),
      picked("Assignment.pdf", fixturePdf("dispatch-369736.pdf")),
      picked("operators.pdf", fixturePdf("operators.pdf")),
      picked("huge.pdf", new Uint8Array(0), 30 * 1024 * 1024),
    ]);
  } finally {
    console.error = log;
  }
  assert.deepEqual(importLines().map((l: any) => [l.state, l.file]), [
    ["bug", "boom.pdf"], ["sending", "Assignment.pdf"], ["not-a-sheet", "operators.pdf"], ["too-big", "huge.pdf"],
  ]);
  assert.equal(errors.length, 1, "the bug is logged");
  assert.deepEqual(LS("fw_outbox").map((o: any) => [o.kind, o.number, o.file]), [["import", "369736", "Assignment.pdf"]]);
});

test("import.js: a reader that won't load says why, once, for the whole pick", async () => {
  (ctx as any).showImports = noop;
  c.__setState([], "L1");
  const log = console.error;
  console.error = noop;
  try {
    for (const [err, state] of [[new SyntaxError("Invalid regular expression"), "no-reader"],
                                [new TypeError("Failed to fetch dynamically imported module"), "no-load"]] as const) {
      (ctx as any).loadReader = async () => { throw err; };
      await c.importFiles([picked("a.pdf", new Uint8Array(4)), picked("b.pdf", new Uint8Array(4))]);
      assert.deepEqual(importLines().map((l: any) => l.state), [state]);
    }
  } finally {
    console.error = log;
  }
});

test("outbox: a 429 is 'try again later', never a refusal", async () => {
  (ctx as any).fetch = async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
  c.__setState([overnight()], "L1");
  LS("fw_lost", []);
  LS("fw_outbox", [{ kind: "post", ref: "r5", listCode: "L1", number: "369736", madeAt: "",
    body: { at: "1.0.0", field: "phone", value: "1" } }]);
  await c.flush();
  assert.equal(LS("fw_outbox").length, 1);
  assert.deepEqual(LS("fw_lost"), []);
});

/* ------------------------------------------------- what dispatch changed -- */

// The server's own diff (worker/src/changes.ts) feeds these, so the phone is
// tested against what GET really sends. Siblings get ".ts" and are
// transpiled, as in cron.test.ts.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.endsWith(".test.ts")) {
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return next(url, context);
  },
});
const { baseOf, diffCopies } = await import("./changes.ts");
const { applyPatches: serverApply } = await import("./patch.ts");

/** 369736 as dispatch printed it at 5:04p. */
function printedRun(): any {
  return { ...overnight(), printedAt: "2026-08-31 17:04", vehicle: "Mercedes Benz Metris (72566) (7 Seats)" };
}

/** `run` re-sent at 8:42p, changed by `edit`, as GET serves it: rows
 *  addressed, what dispatch changed since `run` on it, through JSON. */
function resent(run: any, edit: (r: any) => void, seen = false): any {
  const next = structuredClone(run);
  next.printedAt = "2026-08-31 20:42";
  edit(next);
  const changes = diffCopies(baseOf(run), next);
  serverApply(next, []);
  if (changes.count) next.sheetChanges = { ...changes, seen };
  return JSON.parse(JSON.stringify(next));
}

const joiner = (name: string) => ({ ...overnight().steps[1].actions[0].entities[0], name, flightNumber: "DL88" });

test("a passenger count is a number wherever it is printed: a run holding markup for one prints none of it", () => {
  // The worker refuses such a run now (limits.ts checkAssignment); one stored
  // before that, or by anything that is not the app, must not run on a phone.
  const markup = "<img src=x onerror=alert(1)>";
  const run = overnight();
  run.steps[1].actions[0].entities[0].pax = markup;
  assert.equal(c.paxCount(run), 2, "counted as one person");
  const card = c.renderAssignmentCard(run, "2026-08-31 18:00");
  assert.ok(!card.includes("<img"), card);
  assert.match(card, /2 passengers/);

  run.steps[1].actions[0].entities[0].pax = "3";
  assert.equal(c.paxCount(run), 4, "a count that arrived as text still counts");

  const line = c.importView({ state: "new", number: "369736", run: { start: run.start, end: run.end, pax: markup } });
  assert.ok(!line.detail.includes("<img"), line.detail);
});

test("what changed: UPDATED and the old end on the card until OK; OK hides them at once and queues it", async () => {
  const served = resent(printedRun(), (r) => {
    r.end = "2026-09-01 03:30";
    Object.assign(r.steps[3], { eta: "3:30 AM" });
  });
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async () => { throw new Error("no signal"); };
  c.__setState([served], "L1");
  LS("fw_outbox", []);
  LS("fw_sent", []);
  let card = c.renderAssignmentCard(served, "2026-08-31 18:00");
  assert.match(card, /<span class="achip upd">UPDATED<\/span>/);
  assert.match(card, /3:30a<\/span><s class="swas awas">3:00a<\/s>/);

  c.okSheet("369736");
  await c.flush();
  const shown = c.__assignments()[0];
  assert.equal(shown.sheetChanges.seen, true);
  assert.deepEqual(LS("fw_outbox").map((o: any) => [o.kind, o.number, o.printedAt]), [["seen", "369736", "2026-08-31 20:42"]]);
  card = c.renderAssignmentCard(shown, "2026-08-31 18:00");
  assert.ok(!card.includes("UPDATED") && !card.includes("swas"), "gone with the OK");
  assert.equal(c.sheetPanel(shown), "");
  assert.equal(c.pendingFor("369736").length, 0, "an OK is not an edit waiting for signal");

  // Redrawn from the saved copy, the queued OK still holds.
  c.__setState([resent(printedRun(), (r) => { r.end = "2026-09-01 03:30"; Object.assign(r.steps[3], { eta: "3:30 AM" }); })], "L1");
  c.overlayOutbox();
  assert.equal(c.__assignments()[0].sheetChanges.seen, true);
});

test("what changed: an OK sent is held until GET says so, and dropped by a newer copy", async () => {
  const served = resent(printedRun(), (r) => { r.vehicle = "Toyota Sienna (00412) (7 Seats)"; });
  const requests: any[] = [];
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async (url: string, init: any = {}) => {
    requests.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/api/assignments/seen")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ assignments: [served] }), { status: 200 });
  };
  c.__setState([structuredClone(served)], "L1");
  LS("fw_outbox", []);
  LS("fw_sent", []);
  c.okSheet("369736");
  await c.flush();
  const post = requests.find((r) => r.url.endsWith("/api/assignments/seen"));
  assert.deepEqual(post.body, { listCode: "L1", number: "369736", printedAt: "2026-08-31 20:42" });
  assert.deepEqual(LS("fw_sent").map((o: any) => o.kind), ["seen"], "GET has not shown it yet");
  assert.equal(c.__assignments()[0].sheetChanges.seen, true, "still hidden meanwhile");

  c.__setState([{ ...structuredClone(served), sheetChanges: { ...served.sheetChanges, seen: true } }], "L1");
  c.pruneSent();
  assert.deepEqual(LS("fw_sent"), [], "GET shows it");

  LS("fw_sent", [{ kind: "seen", listCode: "L1", number: "369736", printedAt: "2026-08-31 17:04", sentAt: new Date().toISOString() }]);
  c.__setState([structuredClone(served)], "L1");
  c.pruneSent();
  assert.deepEqual(LS("fw_sent"), [], "an OK for an older print says nothing about this one");
  c.overlayOutbox();
  assert.equal(c.__assignments()[0].sheetChanges.seen, false);
});

test("what changed: the panel lists each change once, where it happened, the old struck", () => {
  const served = resent(printedRun(), (r) => {
    r.vehicle = "Toyota Sienna (00412) (7 Seats)";
    Object.assign(r.steps[1], { eta: "11:20 PM", etd: "12:20 AM" });
    r.steps[1].actions[0].entities = [r.steps[1].actions[0].entities[0], joiner("Diaz, Ana")];
    r.steps[2].actions[0].entities = [r.steps[2].actions[0].entities[1], joiner("Diaz, Ana")];
  });
  const html = c.sheetPanel(served);
  assert.match(html, /WHAT DISPATCH CHANGED/);
  assert.match(html, /against the one printed <span class="mono">[^<]*5:04p<\/span>\. 4 changes, each marked below\./);
  assert.match(html, /VEHICLE<\/span>[\s\S]*SIENNA 00412<\/b><s class="swas mono">BENZ 72566<\/s>/);
  assert.match(html, /LGA<\/span>[\s\S]*11:20p &ndash; 12:20a<\/b><s class="swas mono">11:00p &ndash; 12:00a<\/s>/);
  assert.match(html, /LGA, WKL<\/span>[\s\S]*Diaz, Ana<\/span><span class="schip">NEW<\/span>/);
  // WN748 kept at WKL, UA1503 gone from both.
  assert.match(html, /<s class="swas">Pax WN748<\/s>|<s class="swas">Pax UA1503<\/s>/);
  assert.equal((html.match(/class="sc-row"/g) || []).length, 4);
});

test("what changed: a stop's times struck under the new; under the driver's own, inside 'dispatch planned'", () => {
  const served = resent(printedRun(), (r) => { r.steps[1].eta = "11:20 PM"; });
  const lga = served.steps[1];
  let html = c.renderStep(lga, 1, served, at(2026, 8, 31, 20, 0), []);
  assert.match(html, /<div class="stdisp"><s class="swas">11:00p &ndash; 12:00a<\/s><\/div>/);
  lga._edit = { eta: { patchId: "p1", field: "eta", value: "11:10 PM", documentValue: "11:20 PM", was: "11:00 PM",
    contested: true, agreed: false } };
  lga.eta = "11:10 PM";
  html = c.renderStep(lga, 1, served, at(2026, 8, 31, 20, 0), []);
  assert.match(html, /dispatch planned <s class="swas">11:00p &ndash; 12:00a<\/s> 11:20p &ndash; 12:00a/);
  assert.match(html, /Sheet now says <b>11:20p<\/b>, you set <b>11:10p<\/b>/, "the contest row reads times as the app does");
  assert.match(c.sheetPanel(served), /You set arrive 11:10p: yours stands until you choose\./);
});

test("what changed: NEW and the ghost of who the new sheet dropped, with no UNDO; the car struck under the pill", () => {
  const served = resent(printedRun(), (r) => {
    r.vehicle = "Toyota Sienna (00412) (7 Seats)";
    r.steps[1].actions[0].entities = [r.steps[1].actions[0].entities[0], joiner("Diaz, Ana")];
    r.steps[2].actions[0].where = "Side door";
  });
  const lga = c.renderStep(served.steps[1], 1, served, at(2026, 8, 31, 20, 0), []);
  assert.match(lga, /Diaz, Ana<\/span><span class="schip">NEW<\/span>/);
  assert.match(lga, /<div class="entity dropped"><div class="sghost"><span class="gwhat">Pax WN748<\/span><span class="gverb">NO LONGER HERE<\/span><\/div><\/div>/);
  assert.ok(!/entity dropped[\s\S]*?data-use/.test(lga.split("stepfoot")[0].split("entity dropped")[1] || ""), "no UNDO");
  const wkl = c.renderStep(served.steps[2], 2, served, at(2026, 8, 31, 20, 0), []);
  assert.match(wkl, /Side door<\/button><s class="swas">Lobby<\/s>/);
  const fkl = c.renderStep(served.steps[0], 0, served, at(2026, 8, 31, 20, 0), []);
  assert.match(fkl, /<b>SIENNA 00412<\/b>[\s\S]*<div class="cwas"><s class="swas">BENZ 72566<\/s><\/div>/);
});

test("what changed: a passenger moved says MOVED HERE and where from; a stop dropped keeps its place", () => {
  const run = printedRun();
  run.steps.splice(1, 0, { code: "EWR", place: "Newark", eta: "10:30 PM", etd: "10:45 PM", date: "2026-08-31", etaDate: "2026-08-31",
    actions: [{ verb: "Pickup", where: "C", entities: [joiner("Diaz, Ana")] }] });
  const served = resent(run, (r) => {
    r.steps.splice(1, 1);
    r.steps[1].actions[0].entities.push(joiner("Diaz, Ana"));
  });
  const kinds = served.sheetChanges.items.map((x: any) => x.kind);
  assert.deepEqual(kinds, ["stopDropped", "personMoved"]);
  const html = c.renderStep(served.steps[1], 1, served, at(2026, 8, 31, 20, 0), []);
  assert.match(html, /Diaz, Ana<\/span><span class="schip">MOVED HERE<\/span>/);
  assert.match(html, /<div class="estat">was at EWR<\/div>/);
  const ghost = c.droppedStop(served.sheetChanges.items[0]);
  assert.match(ghost, /<div class="step dropped">[\s\S]*10:30p[\s\S]*<span class="gwhat">EWR<\/span><span class="gplace">Newark<\/span><span class="gverb">NOT ON THE NEW SHEET<\/span>/);
  assert.equal(c.sheetMarks(served).stopsAfter["0"].length, 1, "after FKL, where it was");
  assert.match(c.sheetPanel(served), /MOVED<\/span><span class="sc-note">was at EWR, now at LGA<\/span>/);
});

test("what changed: legs retimed (the old struck under the rail time), new, and dropped among them", () => {
  const run = { ...shuttleRun(), printedAt: "2026-09-28 17:04" };
  const served = resent(run, (r) => {
    r.driverNotes = r.driverNotes.replace("7:45* or", "7:50* or").replace("6:25 SGA to CLS\n", "")
      .replace("8:00 NCB to MGW.", "8:00 NCB to MGW.\n8:10 MGW to NCA.");
  });
  const kinds = served.sheetChanges.items.map((x: any) => x.kind);
  assert.deepEqual(kinds, ["legRetimed", "legAdded", "legDropped"]);
  const placed = c.placeNoteLines(served);
  const gone = c.placeGoneLegs(served);
  const cld = c.legMarks(served, placed[0], gone[0]);
  assert.deepEqual(plain(cld).map((l: any) => l.gone ? `gone ${l.gone.time}` : l.time), ["6:15a", "gone 6:25a", "7:10a"]);
  const abs = plain(c.legMarks(served, placed[1], gone[1]));
  const star = abs.find((l: any) => l.time === "7:50a*");
  assert.equal(star.sheet.wasTime, "7:45a*");
  // 8:10 is after the shuttle window: a line under MGW, the stop it falls in.
  const mgw = plain(c.legMarks(served, placed[2], gone[2]));
  assert.equal(mgw.find((l: any) => l.time === "8:10a").sheet.added, true);
  const html = c.renderLegs(c.legMarks(served, placed[0], gone[0]), null, "CLD Shuttle")
    + c.renderLegs(c.legMarks(served, placed[1], gone[1]), null, "After Breakfast Shuttle")
    + c.renderNoteLines(c.legMarks(served, placed[2], gone[2]), "MGW");
  assert.match(html, /<div class="leg dropped"><div class="rail"><span class="rtime">6:25a<\/span><\/div>[\s\S]*SGA to CLS<\/span><span class="gverb">NOT ON THE NEW SHEET/);
  assert.match(html, /<span class="rtime">7:50a\*<\/span><span class="rwas">7:45a\*<\/span>/);
  assert.match(html, /MGW to NCA\.<\/button><span class="schip">NEW<\/span>/);
  // Never part of RIGHT NOW: the dropped leg is not a leg.
  assert.ok(!plain(c.legsAhead(served, placed, 0)).some((l: any) => l.time === "6:25a"));
});

test("what changed: the notes' new prose marked NEW, the dropped struck", () => {
  const run = { ...printedRun(), driverNotes: "Call dispatch when you leave.\nBring the sign." };
  const served = resent(run, (r) => { r.driverNotes = "Call dispatch when you leave.\nBring two signs."; });
  const html = c.notesBlock(served);
  assert.match(html, /Bring two signs\. <span class="schip">NEW<\/span>/);
  assert.match(html, /<s class="swas">Bring the sign\.<\/s> <span class="sc-gone">not on the new sheet<\/span>/);
  assert.match(c.sheetPanel(served), /NOTES<\/span>[\s\S]*1 new line, 1 gone: in DRIVER NOTES below/);
});

test("what changed: none of it once nobody changed anything; a reprint and an update say so on the line", async () => {
  const same = resent(printedRun(), () => {});
  assert.equal(same.sheetChanges, undefined);
  assert.equal(c.sheetMarks(same), null);
  assert.equal(c.sheetPanel(same), "");
  const op = { printedAt: "2026-08-31 20:42" };
  assert.equal(c.importOutcome(op, 200, { applied: true, replaced: true, same: true }), "reprinted");
  assert.equal(c.importOutcome(op, 200, { applied: true, replaced: true, changes: 5 }), "updated");
  await withDom(() => {
    c.__setState([same], "L1");
    const line = (l: object) => c.importView({ number: "369736", printedAt: "2026-08-31 20:42", run: {}, ...l });
    const re = line({ state: "reprinted" });
    assert.equal(re.title, "Reprinted");
    // "at" goes with a bare time (printed today), never with a day.
    assert.equal(re.detail, "Printed again Mon 31 Aug, 8:42p &middot; nothing changed");
    const today = c.localStamp().slice(0, 10);
    assert.equal(line({ state: "reprinted", printedAt: `${today} 20:42` }).detail, "Printed again at 8:42p &middot; nothing changed");
    assert.match(line({ state: "updated", changes: 5 }).detail, /printed .*8:42p &middot; <b>5 changes<\/b>/);
    assert.match(line({ state: "updated", changes: 1 }).detail, /<b>1 change<\/b>/);
    assert.match(line({ state: "updated", changes: 0, since: "2026-08-31 17:04" }).detail,
      /the same as the one printed .*5:04p/);
  });
});

/* ------------------------------------------------ airlines the list learned -- */

const { applyLearned } = await import("./learned.ts");

function westJetRun(): any {
  const moss = { name: "Moss, Ida", pax: 1, tag: "A", flightNumber: null,
    unknownAirline: { name: "WestJet", number: "1680", date: "2026-10-01" } };
  const cole = { name: "Cole, Al", pax: 1, tag: "A", flightNumber: null };
  return {
    number: "900901", start: "2026-10-01 05:00", end: "2026-10-01 12:00",
    issues: [
      "Moss, Ida: could not resolve 'WestJet' (unknown-airline)",
      "Cole, Al: could not resolve 'Delta' (no-flight-number)",
      "last stop date disagrees with the document's stated end date -- check the multi-day rollover",
    ],
    steps: [{ code: "JFK", place: "Kennedy", date: "2026-10-01", etaDate: "2026-10-01", eta: "9:00 AM",
      actions: [{ verb: "Pickup", where: "Claim", entities: [moss, cole] }] }],
  };
}

test("learned airlines: the phone fills a row as the server does, takes it back when forgotten, never over the driver's", () => {
  const run = westJetRun();
  c.ensureAddresses(run);
  c.__setSettings({ airlines: [{ name: "westjet", code: "WS" }] });
  const server = structuredClone(run);
  applyLearned(server, [{ name: "westjet", code: "WS" }]);
  c.learnFlights(run);
  assert.deepEqual(plain(run.steps[0].actions[0].entities), plain(server.steps[0].actions[0].entities));
  const moss = run.steps[0].actions[0].entities[0];
  assert.equal(moss.flightNumber, "WS1680");
  // Learned under another code: follows it. Forgotten: blank again.
  c.__setSettings({ airlines: [{ name: "WestJet", code: "WG" }] });
  c.learnFlights(run);
  assert.equal(moss.flightNumber, "WG1680");
  c.__setSettings({ airlines: [] });
  c.learnFlights(run);
  assert.equal(moss.flightNumber, null);
  assert.equal(moss._learned, undefined);
  // The driver's own number (a queued or saved correction) is never touched.
  c.__setSettings({ airlines: [{ name: "WestJet", code: "WS" }] });
  moss.flightNumber = "AC1680";
  moss._edit = { flightNumber: { pending: true } };
  moss._learned = { name: "WestJet", code: "WS" };
  c.learnFlights(run);
  assert.equal(moss.flightNumber, "AC1680");
  assert.equal(moss._learned, undefined);
  c.__setSettings({});
});

test("learned airlines: a code from a typed number; one airline per name, on this phone at once", () => {
  assert.equal(c.flightCode("ws 1680"), "WS");
  assert.equal(c.flightCode("B61123"), "B6");
  for (const v of ["1680", "12345", "WS", "WSA1680", "", null]) assert.equal(c.flightCode(v), null, String(v));
  c.__setSettings({ airlines: [] });
  c.applyAirlineOp({ kind: "airline", name: "WestJet", code: "WS" });
  c.applyAirlineOp({ kind: "airline", name: "  westjet ", code: "WG" });
  c.applyAirlineOp({ kind: "airline", name: "Zed Air", code: "ZD" });
  assert.deepEqual(plain(c.listAirlines()), [{ name: "  westjet ", code: "WG" }, { name: "Zed Air", code: "ZD" }]);
  assert.equal(c.airlineShown({ name: "WESTJET", code: "WG" }), true);
  c.applyAirlineOp({ kind: "airline", name: "WestJet", remove: true });
  assert.equal(c.airlineShown({ name: "WestJet", remove: true }), true);
  c.__setSettings({});
});

test("could-not-read lines: a flight one is tied to its passenger, open until the row has a flight", () => {
  const run = westJetRun();
  c.ensureAddresses(run);
  c.__setSettings({});
  const rows = plain(c.issueRows(run));
  assert.deepEqual(rows.map((r: any) => [r.why ?? null, r.entity ? r.entity.name : null]), [
    ["unknown-airline", "Moss, Ida"], ["no-flight-number", "Cole, Al"], [null, null]]);
  assert.equal(c.openIssueCount(run), 3);
  // A run read before the number was kept still names its airline, from the line.
  const moss = run.steps[0].actions[0].entities[0];
  delete moss.unknownAirline;
  assert.deepEqual(plain(c.unknownAirlineOf(run, moss)), { name: "WestJet", number: null });
  moss.flightNumber = "WS1680";                                    // fixed
  assert.equal(c.openIssueCount(run), 2);
  c.__setSettings({});
});

/* ------------------------------------------------------------ v62.1 bits -- */

test("stop head: only what the rail doesn't already say", () => {
  assert.equal(c.headTimes("9:00 AM", "10:00 AM"), "until 10:00a");
  assert.equal(c.headTimes("2:15 AM", "2:15 AM"), "ARRIVE &amp; LEAVE");
  assert.equal(c.headTimes("3:00 AM", null), "ARRIVE");
  assert.equal(c.headTimes(null, "9:30 PM"), "LEAVE");
  assert.equal(c.headTimes(null, null), "");
});

test("theme: Auto follows the phone's light or dark mode; dark 11p-5a is late (index.html's one rule)", () => {
  const html = readFileSync(new URL("index.html", pub), "utf8");
  const src = html.slice(html.indexOf("function curbsideTheme("), html.indexOf("// The theme is set before the first paint"));
  let dark = true;
  const t = vm.createContext({ window: { matchMedia: () => ({ matches: dark }) } });
  vm.runInContext(src, t);
  const theme = (mode: string | null, h: number, isDark?: boolean) =>
    vm.runInContext("curbsideTheme", t)(mode, new Date(2026, 9, 1, Math.floor(h), Math.round((h % 1) * 60)), isDark);
  assert.equal(theme(null, 12), "night");      // the phone is dark at noon: night
  assert.equal(theme(null, 23.5), "late");
  assert.equal(theme(null, 4.5), "late");
  assert.equal(theme(null, 5), "night");
  dark = false;
  assert.equal(theme(null, 2), "day");         // light at 2 AM, as the phone says
  assert.equal(theme(null, 12, true), "night"); // passed in wins over the phone
  assert.equal(theme("night", 12), "night");
  assert.equal(theme("day", 23.5, true), "day");
});

/* ------------------------------------------------ messaged, then it changed -- */

test("messages: a tick keeps what was said; a change of plan makes them left again, a late flight never", () => {
  const run = messagedRun();
  c.__setState([run], "L1");
  setStatuses({});
  LS("fw_called", {});
  LS("fw_messages", {});
  LS("fw_greet", { "Okafor, Daniel": "brother" });
  const [castillo] = run.steps[0].actions[0].entities;
  const [okafor] = run.steps[1].actions[1].entities;
  assert.equal(c.messaged(run, castillo), null);
  c.markCalled("380114", "Castillo, Ana & Luis", true);
  c.markCalled("380114", "Okafor, Daniel", true);
  assert.deepEqual(LS("fw_called")["380114:Castillo, Ana & Luis"].said, {
    time: "5:30a", door: "A-res WRK", from: "Warwick", to: "JFK", flight: "DL404", appointment: null,
    day: "2026-09-29", phone: "(845) 555-0142",
  });
  assert.equal(c.messageDone(run, castillo), true);

  // The arrival's flight runs late: the message's time follows it, the tick stands.
  setStatuses({ "B61123:2026-09-29": { status: "Expected", arrival: {
    scheduledTime: "2026-09-29 09:05-04:00", estimatedTime: "2026-09-29 09:42-04:00" } } });
  assert.equal(c.messageFacts(run, okafor).time, "9:42a");
  assert.equal(c.messageDone(run, okafor), true, "a delay is not a change of plan");
  setStatuses({});

  // Dispatch (or the driver) moves the pickup and the door.
  run.steps[0].eta = "5:10 AM";
  run.steps[0].actions[0].where = "B-res WRK";
  const m = plain(c.messaged(run, castillo));
  assert.deepEqual(m.changes, [
    { field: "time", label: "time", now: "5:10a", was: "5:30a" },
    { field: "door", label: "door", now: "B-res WRK", was: "A-res WRK" },
  ]);
  assert.equal(c.changedWords(m.changes), "time 5:10a (was 5:30a) · door B-res WRK (was A-res WRK)");
  assert.equal(c.messageDone(run, castillo), false);
  assert.equal(c.messageDone(run, okafor), true, "nobody else is flagged");
  const eve = new Date(2026, 8, 28, 19, 0);
  assert.match(c.messageText(run, c.messageFacts(run, castillo), eve, true),
    /^Update:\nDear Family Castillo,\n[^]*outside B-res WRK at 5:10a\./);
  assert.equal(c.messageText(run, c.messageFacts(run, castillo), new Date(2026, 8, 29, 4, 30), true), "",
    "on the day the chat still opens empty");

  // Ticked again: what was said is the new plan.
  c.markCalled("380114", "Castillo, Ana & Luis", true);
  assert.equal(c.messageDone(run, castillo), true);
  // Dispatch changes it back to what the FIRST message said: changed again.
  run.steps[0].eta = "5:30 AM";
  assert.equal(c.messageDone(run, castillo), false);
  c.markCalled("380114", "Castillo, Ana & Luis", false);
  assert.equal(c.messaged(run, castillo), null);

  // A tick from before ticks kept what was said never flags.
  LS("fw_called", { "380114:Okafor, Daniel": "2026-09-28T22:12:00.000Z" });
  run.steps[1].actions[1].where = "Door 4";
  assert.deepEqual(plain(c.messaged(run, okafor)), { at: "2026-09-28T22:12:00.000Z", changes: [] });

  // A flight the driver filled in on a row that had none is not news to its passenger.
  LS("fw_called", {});
  okafor.flightNumber = null;
  c.markCalled("380114", "Okafor, Daniel", true);
  okafor.flightNumber = "B61123";
  assert.equal(c.messageDone(run, okafor), true);
  okafor.phone = "(914) 555-0199";
  assert.equal(c.changedWords(plain(c.messaged(run, okafor)).changes), "number (914) 555-0199 (was (914) 555-0163)");
  LS("fw_called", {});
  LS("fw_greet", {});
  c.__setState([], null);
});

/* ------------------------------------------------------- staying in sync -- */

test("sync: the stamp alone each minute; a load only when it moved, once more to settle, and on the way back from no signal", async () => {
  const asked: string[] = [];
  let stamp: string | null = "s1";
  let down = false;
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async (url: string) => {
    asked.push(url.replace("https://worker.test", ""));
    if (down) throw new Error("no signal");
    if (url.endsWith("/api/stamp")) return new Response(JSON.stringify({ stamp }), { status: 200 });
    return new Response(JSON.stringify({ assignments: [overnight()], stamp }), { status: 200 });
  };
  c.__setState([], "L1");
  for (const k of ["fw_outbox", "fw_sent", "fw_undone", "fw_lost"]) LS(k, []);
  LS("fw_hidden", {});
  const quiet = console.error;
  console.error = noop;
  try {
    await withDom(() => c.loadAssignments());
    const since = () => asked.splice(0);
    since();

    await c.checkStamp();
    assert.deepEqual(since(), ["/api/stamp"], "nothing changed: one small read");
    stamp = "s2";
    await withDom(() => c.checkStamp());
    assert.deepEqual(since(), ["/api/stamp", "/api/assignments"], "changed elsewhere: load");
    await withDom(() => c.checkStamp());
    assert.deepEqual(since(), ["/api/stamp", "/api/assignments"], "once more, for KV's list lag");
    await c.checkStamp();
    assert.deepEqual(since(), ["/api/stamp"]);

    // No signal: silent, and the copy on screen stays.
    down = true;
    await c.checkStamp();
    assert.deepEqual(since(), ["/api/stamp"]);
    assert.equal(c.__assignments().length, 1);
    // A load that failed left the screen saying so; the next answer brings it back.
    await withDom(() => c.loadAssignments());
    assert.equal(vm.runInContext("offline", ctx), true);
    down = false;
    since();
    await withDom(() => c.checkStamp());
    assert.deepEqual(since(), ["/api/stamp", "/api/assignments"]);
    assert.equal(vm.runInContext("offline", ctx), false);

    // An older worker (no such route) asks for nothing more.
    (ctx as any).fetch = async (url: string) => { asked.push(url); return new Response("{}", { status: 404 }); };
    await c.checkStamp();
    assert.equal(since().length, 1);
  } finally { console.error = quiet; }
  c.__setState([], null);
  store.delete("fw_assign_cache");
});

/* ------------------------------------------- removed from this phone only -- */

test("hidden: a run removed from this phone leaves every screen but its ghost; UNDO and a re-import bring it back", async () => {
  const two = () => [sheet("900736", "2026-08-31 17:04"), { ...messagedRun(), printedAt: "2026-09-28 17:00" }];
  (ctx as any).renderCurrent = noop;
  LS("fw_hidden", {});
  for (const k of ["fw_outbox", "fw_sent", "fw_undone", "fw_lost"]) LS(k, []);
  c.__setState(two(), "L1");
  const numbers = () => plain(c.__assignments()).map((a: any) => a.number);
  const hidden = () => plain(vm.runInContext("hiddenRuns", ctx)).map((a: any) => a.number);

  c.hideRun("380114");
  assert.deepEqual([numbers(), hidden()], [["900736"], ["380114"]]);
  assert.deepEqual(plain(c.callsFor("2026-09-29")), [], "nobody of theirs left to message");
  assert.equal(LS("fw_hidden")["L1:380114"].printedAt, "2026-09-28 17:00");
  const ghost = c.hiddenCard(vm.runInContext("hiddenRuns[0]", ctx));
  assert.match(ghost, /Removed from this phone<\/span>/);
  assert.match(ghost, /data-unhide="380114"/);
  assert.ok(!ghost.includes("data-assignment"), "the ghost opens nothing");

  // A fresh load keeps it out; another list's same number is not hidden.
  c.applyAssignments({ assignments: two() }, true);
  c.overlayOutbox();
  assert.deepEqual([numbers(), hidden()], [["900736"], ["380114"]]);
  c.overlayOutbox();
  assert.deepEqual(hidden(), ["380114"], "drawn again, still one ghost");
  c.__setState(two(), "L2");
  vm.runInContext("hiddenRuns = []", ctx);
  c.overlayOutbox();
  assert.deepEqual(numbers(), ["900736", "380114"]);

  // Dispatch's newer print (another phone imported it) stays hidden, and says so.
  c.__setState([{ ...messagedRun(), printedAt: "2026-09-28 20:30" }], "L1");
  vm.runInContext("hiddenRuns = []", ctx);
  c.overlayOutbox();
  assert.deepEqual(numbers(), []);
  assert.match(c.hiddenCard(vm.runInContext("hiddenRuns[0]", ctx)), /dispatch sent a newer copy since/);

  c.unhideRun("380114");
  assert.deepEqual([numbers(), hidden()], [["380114"], []]);
  assert.deepEqual(LS("fw_hidden"), {});

  // Importing its sheet on this phone is asking for it back.
  c.hideRun("380114");
  vm.runInContext("importLines = []", ctx);
  assert.equal(c.queueImport({ ...messagedRun(), printedAt: "2026-09-28 20:30" }, "a.pdf"), null);
  assert.deepEqual([numbers(), importLines()[0].state], [["380114"], "same"]);
  assert.deepEqual(LS("fw_hidden"), {});
  c.__setState([], null);
  vm.runInContext("hiddenRuns = []; importLines = []", ctx);
});

test("hidden: the entry goes once the list has cleaned the run up, never while it may only be lagging", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  c.__setState([], "L1");
  vm.runInContext("hiddenRuns = [{ number: '1' }]", ctx);
  LS("fw_hidden", {
    "L1:1": { at: "2026-09-20T12:00:00Z", printedAt: null },   // still on the list
    "L1:2": { at: "2026-09-20T12:00:00Z", printedAt: null },   // cleaned up
    "L1:3": { at: "2026-10-01T11:30:00Z", printedAt: null },   // hidden half an hour ago, not in GET yet
    "L2:4": { at: "2026-09-20T12:00:00Z", printedAt: null },   // another list's: not ours to judge
    "L2:5": { at: "2026-08-01T12:00:00Z", printedAt: null },   // ...until past any retention
  });
  c.pruneHidden(now);
  assert.deepEqual(Object.keys(LS("fw_hidden")).sort(), ["L1:1", "L1:3", "L2:4"]);
  LS("fw_hidden", {});
  c.__setState([], null);
  vm.runInContext("hiddenRuns = []", ctx);
});

/* ------------------------------- places and airlines every driver gets -- */

test("shared: every driver's places and airlines sit behind the list's own; the list's own are what it saves", () => {
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async () => { throw new Error("no signal"); };
  for (const k of ["fw_outbox", "fw_sent", "fw_undone", "fw_lost"]) LS(k, []);
  LS("fw_hidden", {});
  c.__setState([], "L1");
  const cls = { code: "CLS", name: "Clinic South", address: "10 Sample Road" };
  const cln = { code: "CLN", name: "Clinic North", address: "4 Sample Hill" };
  c.applyAssignments({
    assignments: [westJetRun()],
    settings: { places: [{ code: "CLS", name: "My clinic", address: "99 Other Road" }], airlines: [] },
    shared: { places: [cls, cln], airlines: [{ name: "WestJet", code: "WS" }] },
  }, true);
  c.overlayOutbox();
  assert.deepEqual(plain(c.listPlaces()), [
    { ...cln, shared: true }, { code: "CLS", name: "My clinic", address: "99 Other Road" }]);
  assert.deepEqual(plain(c.ownPlaces()).map((p: any) => p.code), ["CLS"]);
  // A learned airline of every driver's fills the row as the server does.
  assert.deepEqual(plain(c.listAirlines()), [{ name: "WestJet", code: "WS", shared: true }]);
  const filled = plain(c.__assignments()[0]).steps.flatMap((s: any) => s.actions.flatMap((a: any) => a.entities))
    .filter((e: any) => e._learned);
  assert.ok(filled.length && filled.every((e: any) => /^WS\d+$/.test(e.flightNumber)));

  // Saving a place writes only this list's own: every driver's is never copied in.
  c.savePlace({ code: "DRM", name: "Dr. Sample", address: "22 Sample Ave" });
  assert.deepEqual(plain(c.ownPlaces()).map((p: any) => p.code), ["CLS", "DRM"]);
  assert.deepEqual(plain(c.listPlaces()).map((p: any) => [p.code, !!p.shared]), [["CLN", true], ["CLS", false], ["DRM", false]]);
  assert.equal(c.keeper === true, false);
  LS("fw_outbox", []);
  c.__setState([], null);
  vm.runInContext("sharedCatalog = { places: [], airlines: [] }; settings = {};", ctx);
});

test("shared: the keeper sees what drivers added; ADD FOR EVERYONE is its own save, DISMISS goes through the outbox", async () => {
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async () => { throw new Error("no signal"); };
  for (const k of ["fw_outbox", "fw_sent", "fw_undone", "fw_lost"]) LS(k, []);
  c.__setState([], "L1");
  const served = () => ({
    assignments: [], settings: { places: [{ code: "CLS", name: "", address: "10 Sample Road" }], airlines: [] },
    shared: { places: [], airlines: [] }, keeper: true,
    suggestions: [
      { id: "aaaa0001", kind: "place", code: "DRM", name: "Dr. Sample", address: "22 Sample Ave", by: "t1", at: "" },
      { id: "aaaa0002", kind: "place", code: "CLS", name: "", address: "10 Sample Road", by: "t1", at: "" },
      { id: "aaaa0003", kind: "airline", code: "PD", name: "Porter", by: "t2", at: "" },
    ],
  });
  c.applyAssignments(served(), true);
  c.overlayOutbox();
  const open = (kind: string) => plain(c.openSuggestions(kind)).map((g: any) => g.id);
  assert.deepEqual(open("place"), ["aaaa0001"], "what the keeper's list already says is not asked again");
  assert.deepEqual(open("airline"), ["aaaa0003"]);

  c.takeSuggestion("aaaa0001");
  assert.deepEqual(open("place"), []);
  assert.deepEqual(plain(c.ownPlaces()).map((p: any) => p.code), ["CLS", "DRM"]);
  c.dismissSuggestion("aaaa0003");
  assert.deepEqual(open("airline"), []);
  await c.flush();
  assert.deepEqual(LS("fw_outbox").map((o: any) => [o.kind, o.code || o.id]), [["place", "DRM"], ["dismiss", "aaaa0003"]]);

  // Redrawn from the saved copy, both answers still hold.
  c.applyAssignments(served(), true);
  c.overlayOutbox();
  assert.deepEqual([open("place"), open("airline")], [[], []]);

  // Sent: POSTed to /api/suggestions, held until GET no longer lists it.
  const requests: any[] = [];
  let gone = false;
  (ctx as any).fetch = async (url: string, init: any = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "POST") return new Response(JSON.stringify({ ok: true, places: [] }), { status: 200 });
    const data = served();
    if (gone) data.suggestions = [];
    return new Response(JSON.stringify(data), { status: 200 });
  };
  await withDom(() => c.flush());
  const sent = requests.find((r) => r.url.endsWith("/api/suggestions"));
  assert.deepEqual(sent.body, { listCode: "L1", id: "aaaa0003" });
  assert.deepEqual(open("airline"), [], "GET still lists it; the phone does not");
  assert.ok(LS("fw_sent").some((o: any) => o.kind === "dismiss"));
  gone = true;
  await withDom(() => c.loadAssignments());
  assert.ok(!LS("fw_sent").some((o: any) => o.kind === "dismiss"));

  // Another driver's phone is never shown suggestions, whatever a response carries.
  c.applyAssignments({ ...served(), keeper: undefined }, true);
  assert.deepEqual(open("place"), []);
  for (const k of ["fw_outbox", "fw_sent"]) LS(k, []);
  store.delete("fw_assign_cache");
  c.__setState([], null);
  vm.runInContext("sharedCatalog = { places: [], airlines: [] }; settings = {}; keeper = false; suggestions = [];", ctx);
});

/* ------------------------------------------- the list card's moved flight -- */

test("movedFlight: the arriving flight furthest off schedule, 5 min or more; never a departure", () => {
  setStatuses({
    "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41"),
    "WN748:2026-08-31": arriving("America/Denver", "2026-08-31 22:50", "2026-08-31 22:38"),
  });
  assert.deepEqual(plain(c.movedFlight(overnight())), { flight: "UA1503", minutes: 26 });
  assert.equal(c.movedWords({ flight: "UA1503", minutes: 26 }), "UA1503 26M LATE");
  assert.equal(c.movedWords({ flight: "WN748", minutes: -12 }), "WN748 12M EARLY");
  assert.equal(c.movedWords({ flight: "DL1", minutes: 65 }), "DL1 1H 05M LATE");
  assert.equal(c.movedWords({ flight: "DL1", minutes: 120 }), "DL1 2H LATE");

  // Under 5 minutes either way is on time; a removed passenger is not asked.
  setStatuses({ "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:19") });
  assert.equal(c.movedFlight(overnight()), null);
  setStatuses({ "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:41") });
  const run = overnight();
  run.steps[1].actions[0].entities[0]._removed = { at: "x" };
  run.steps[2].actions[0].entities[1]._removed = { at: "x" }; // the same passenger at the drop-off
  assert.equal(c.movedFlight(run), null);

  // A late departure moves nothing the driver does (check-in runs from the earlier time).
  const out = overnight();
  out.steps[1].actions[0].entities[0].tag = "D";
  out.steps[2].actions[0].entities[1].tag = "D";
  setStatuses({ "UA1503:2026-08-31": departing("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:59") });
  assert.equal(c.movedFlight(out), null);
  setStatuses({});
});

test("list card: people to message again counted once each; the day-of line on the run's own page", () => {
  const run = messagedRun();
  c.__setState([run], "L1");
  setStatuses({});
  LS("fw_called", {});
  LS("fw_greet", { "Okafor, Daniel": "brother" });
  assert.equal(c.staleCount(run), 0);
  c.markCalled("380114", "Castillo, Ana & Luis", true);
  c.markCalled("380114", "Okafor, Daniel", true);
  assert.equal(c.staleCount(run), 0, "ticked and still true");
  run.steps[0].eta = "5:10 AM";
  assert.equal(c.staleCount(run), 1);
  run.steps[1].actions[1].where = "Door 4";
  assert.equal(c.staleCount(run), 2);
  run.steps[1].actions[1].entities[0]._removed = { at: "x" };
  assert.equal(c.staleCount(run), 1, "someone not coming is not counted");

  // The evening before: nothing. On the day, until the run ends: the line. After: nothing.
  const day = run.start.slice(0, 10);
  const [y, mo, d] = day.split("-").map(Number);
  assert.equal(c.dayOfNote(run, new Date(y, mo - 1, d - 1, 19, 0)), "");
  assert.match(c.dayOfNote(run, new Date(y, mo - 1, d, 0, 30)), /day of the run/);
  assert.equal(c.dayOfNote(run, new Date(y, mo - 1, d + 1, 12, 0)), "");
  LS("fw_called", {});
  LS("fw_greet", {});
  c.__setState([], null);
});

/* ---- the rules' own edges (mutation pass, 2026-10-03) ---- */

test("a flight exactly five minutes off its schedule is moved; a departure's clock runs from the earlier time", () => {
  setStatuses({ "UA1503:2026-08-31": arriving("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:20") });
  assert.deepEqual(plain(c.movedFlight(overnight())), { flight: "UA1503", minutes: 5 });

  // A drop-off for a flight due out 11:15p, now delayed to 11:59p: the
  // check-in desk has not moved, so parked-by still counts from 11:15p.
  const out = overnight();
  out.steps[1].actions[0].entities = [{ ...out.steps[1].actions[0].entities[0], tag: "D" }];
  setStatuses({ "UA1503:2026-08-31": departing("America/Chicago", "2026-08-31 23:15", "2026-08-31 23:59") });
  const delayed = clocksFor(out.steps[1]);
  assert.equal(delayed.parkedBy, wallAt("2026-08-31", hm(23, 15)) - 120);
  // Brought forward to 10:45p: the earlier time is the estimate.
  setStatuses({ "UA1503:2026-08-31": departing("America/Chicago", "2026-08-31 23:15", "2026-08-31 22:45") });
  assert.equal(clocksFor(out.steps[1]).parkedBy, wallAt("2026-08-31", hm(22, 45)) - 120);
  setStatuses({});
});

/* ---- the design audit's picks (v67; the owner, 2026-10-04) ---- */

vm.runInContext("function __setChecks(c) { flightChecks = c; }", ctx);

test("an airport stop's head is its name; the address shows only where dispatch changed it", () => {
  const run = printedRun();
  run.steps[1].address = "Grand Central Parkway Flushing, NY 11371";
  run.steps[2].address = "900 Red Mills Road Wallkill, NY 12589";
  serverApply(run, []);
  c.__setState([run], "L1");
  const lga = c.renderStep(run.steps[1], 1, run, at(2026, 8, 31, 20, 0), []);
  assert.match(lga, /<span class="splace">LaGuardia<\/span>/);
  assert.ok(!lga.includes("Grand Central"), "the airport's address is not on its head");
  // Anywhere else the address is how the driver finds the door.
  assert.match(c.renderStep(run.steps[2], 2, run, at(2026, 8, 31, 20, 0), []), /Wallkill · 900 Red Mills Road/);

  // Dispatch reprinted the airport's address: the new one beside the old, struck.
  const served = resent(run, (r) => { r.steps[1].address = "Terminal B, Flushing, NY 11371"; });
  c.__setState([served], "L1");
  const moved = c.renderStep(served.steps[1], 1, served, at(2026, 8, 31, 20, 0), []);
  assert.match(moved, /LaGuardia · Terminal B, Flushing/);
  assert.match(moved, /Grand Central Parkway/);
  c.__setState([], null);
});

test("the day-of line leaves the run's page once the run is under way", () => {
  const run = messagedRun(); // starts 5:30a
  const [y, mo, d] = run.start.slice(0, 10).split("-").map(Number);
  assert.match(c.dayOfNote(run, new Date(y, mo - 1, d, 5, 29)), /day of the run/);
  assert.equal(c.dayOfNote(run, new Date(y, mo - 1, d, 5, 30)), "");
  assert.equal(c.dayOfNote(run, new Date(y, mo - 1, d, 9, 0)), "");
});

test("the run's number leads the list card's line, and a removed run's", () => {
  const run = overnight();
  c.__setState([run], "L1");
  assert.match(c.renderAssignmentCard(run, "2026-08-31 18:00"), /<span class="ameta">#369736 &middot; 2 passengers<\/span>/);
  const none = { ...run, steps: [run.steps[0], run.steps[3]] };
  assert.match(c.renderAssignmentCard(none, "2026-08-31 18:00"), /<span class="ameta">#369736<\/span>/);
  assert.match(c.hiddenCard(run), /<span class="ameta">#369736 &middot; Removed from this phone<\/span>/);
  c.__setState([], null);
});

test("paused flight checks are one bar above the runs, and only when a run has a flight", () => {
  const run = overnight();
  c.__setChecks(null);
  assert.equal(c.checksBar([run]), "");
  c.__setChecks({ state: "low" });
  assert.equal(c.checksBar([run]), "", "running low is said on the run, not here");
  c.__setChecks({ state: "paused", until: "2026-10-16T16:12:00Z" });
  const bar = c.checksBar([run]);
  assert.match(bar, /<button class="callsbar" type="button" id="checks-bar">/);
  assert.match(bar, /#i-triangle-alert/);
  assert.match(bar, /FLIGHT CHECKS PAUSED<\/span>/);
  assert.match(bar, /<span class="bad">UNTIL FRI 16 OCT<\/span>/);
  c.__setChecks({ state: "paused" });
  assert.match(c.checksBar([run]), /<span class="bad">WHY<\/span>/);
  const noFlights = { ...run, steps: [run.steps[0], run.steps[3]] };
  assert.equal(c.checksBar([noFlights]), "");
  c.__setChecks(null);
});

test("a past stop's times are plain words beside the button: closed, only the head takes a tap", () => {
  const run = overnight();
  run.steps[0].address = "1 Main St"; // a place, not a window
  serverApply(run, []);
  c.__setState([run], "L1");
  const past = c.renderStep(run.steps[0], 0, run, at(2026, 8, 31, 22, 0), []);
  assert.match(past, /data-collapsible="1"/);
  assert.match(past, /<span class="stimes stplain">LEAVE<\/span><button class="editable stimes"/);
  // A window that is over closes the same way.
  const win = overnight();
  serverApply(win, []);
  assert.match(c.renderStep(win.steps[0], 0, win, at(2026, 8, 31, 22, 0), []), /<span class="stimes stplain">LEAVE<\/span>/);
  const now = c.renderStep(run.steps[1], 1, run, at(2026, 8, 31, 22, 0), []);
  assert.ok(!now.includes("stplain"), "the stop you are at keeps its times a button");
  c.__setState([], null);
});

test("the route's pick list names the car's lot once", () => {
  const run = overnight();
  run.parking = "FKL-NBD-014";
  run.steps.push({ code: "NCA", place: "Newburgh Center A", address: "1292 NY-300, Newburgh, NY 12550",
    eta: "3:10 AM", etd: null, date: "2026-09-01", etaDate: "2026-09-01", actions: [] });
  run.steps[2].address = "900 Red Mills Road Wallkill, NY 12589";
  c.__setState([run], "L1");
  c.__setSettings({ places: [] });
  const codes = (groups: any) => Object.fromEntries(plain(groups).map(([name, rows]: any) => [name, rows.map((r: any) => r.code)]));
  let groups = codes(c.routePlaces(run));
  assert.deepEqual(groups["THE CAR"], ["NCA"]);
  assert.deepEqual(groups["FROM DISPATCH’S SHEETS"], ["WKL"]);
  // The list's own place for the lot: its address is the car's, and it is still named once.
  c.__setSettings({ places: [{ code: "NCA", name: "", address: "9 Sample Rd" }, { code: "SGA", name: "Stonegate", address: "3000 Stonegate Terrace" }] });
  groups = codes(c.routePlaces(run));
  assert.deepEqual(groups["THE CAR"], ["NCA"]);
  assert.deepEqual(groups["YOUR PLACES"], ["SGA"]);
  // A run with no lot keeps every place.
  run.parking = "B-12";
  assert.deepEqual(codes(c.routePlaces(run))["YOUR PLACES"], ["NCA", "SGA"]);
  c.__setSettings({});
  c.__setState([], null);
});

test("the list: a finished run stays under EARLIER for ten hours, to the minute, then waits behind ARCHIVE", () => {
  // ARCHIVE_AFTER_H: a 3 AM finish is still on the home screen when the driver
  // wakes up. renderAssignments draws the split itself, so the page it writes
  // to is stood in for, and the phone's clock is held at noon.
  const page = { innerHTML: "", querySelectorAll: () => [] };
  const doc = (ctx as any).document;
  const was = doc.getElementById;
  doc.getElementById = () => null;
  Object.assign(ctx, { main: page, settleHistory: noop, setPageScroll: noop });
  const noon = new Date(2026, 8, 2, 12, 0).getTime();
  vm.runInContext(`var __Date = Date;
    Date = class extends __Date {
      constructor(...a) { if (a.length) super(...a); else super(${noon}); }
      static now() { return ${noon}; }
    };`, ctx);
  try {
    const ended = (number: string, h: number, mi: number, day = 2) => ({
      number, start: localStamp(new Date(2026, 8, day, h - 3, mi)), end: localStamp(new Date(2026, 8, day, h, mi)),
      steps: [], issues: [],
    });
    c.__setState([
      ended("900001", 2, 0),      // ended 2:00a, ten hours ago to the minute
      ended("900002", 1, 59),     // 1:59a: a minute more
      ended("900003", 11, 59),    // a minute ago
      ended("900004", 13, 0),     // still to end
      ended("900005", 22, 0, 1),  // last night
    ], "L1");
    c.renderAssignments();
    const shown = () => [...page.innerHTML.matchAll(/data-assignment="(\d+)"/g)].map((m) => m[1]);
    assert.match(page.innerHTML, /EARLIER &middot; 2</);
    assert.match(page.innerHTML, /ARCHIVE &middot; 2</);
    assert.deepEqual(shown(), ["900004", "900003", "900001"], "what is coming, then what just ended, newest first");
    // Behind ARCHIVE they are still readable, newest first.
    vm.runInContext("archiveOpen = true", ctx);
    c.renderAssignments();
    assert.deepEqual(shown(), ["900004", "900003", "900001", "900002", "900005"]);
  } finally {
    vm.runInContext("archiveOpen = false; Date = __Date;", ctx);
    doc.getElementById = was;
    c.__setState([], null);
  }
});

/* ------------------------------------------ v68: the card and its menus -- */

/** The run the messages tests use, addressed as GET serves it, the evening before. */
function cardRun(day = "2026-09-29"): any {
  const run = JSON.parse(JSON.stringify(messagedRun()).replaceAll("2026-09-29", day));
  run.importedAt = "2026-09-28T21:00:00.000Z";
  // The pickup and the drop-off are two rows of one passenger, not one object.
  run.steps[1].actions[0].entities = [{ ...run.steps[1].actions[0].entities[0] }];
  run.steps[2].actions[0].entities = [{ ...run.steps[2].actions[0].entities[0] }];
  c.ensureAddresses(run);
  return run;
}
const EVE = () => at(2026, 9, 28, 19, 0);
const count = (html: string, what: string) => html.split(what).length - 1;

test("v68 card: one menu button a passenger; FIX, NOT COMING and the chip are off it", () => {
  const run = cardRun();
  c.__setState([run], "L1");
  setStatuses({});
  LS("fw_called", {});
  LS("fw_messages", {});
  LS("fw_greet", { "Okafor, Daniel": "brother" });
  const jfk = c.renderStep(run.steps[1], 1, run, EVE(), []);
  assert.equal(count(jfk, 'class="more"'), 2, "one for each passenger at the stop");
  assert.match(jfk, /data-more="1\.1\.0" aria-label="More for Okafor, Daniel"/);
  for (const gone of ["data-remove", "editable fix", "greet-chip", "telrow", "ADD PASSENGER", "STOP NOT HAPPENING", "data-add-entity"]) {
    assert.ok(!jfk.includes(gone), `${gone} left the stop`);
  }
  // The stop's own menu, once, at its foot.
  assert.equal(count(jfk, 'data-stop-menu="1"'), 1);
  assert.match(jfk, /CHANGE THIS STOP/);
  // WA and TEXT on the number's line: the word alone, named for who it reaches.
  assert.match(jfk, /<a class="msgbtn wa c" href="https:\/\/wa\.me\/19145550163[^"]*" target="_blank" rel="noopener" aria-label="WhatsApp Okafor, Daniel">WA<\/a>/);
  assert.match(jfk, /<a class="msgbtn sms c" href="sms:[^"]*" aria-label="Text Okafor, Daniel">TEXT<\/a>/);
  // A party's other number keeps its small pair.
  assert.match(jfk, /class="msgbtn wa small"/);
  c.__setState([], null);
  LS("fw_greet", {});
});

test("v68 card: MESSAGED sits under the number; a corrected number carries the dot", () => {
  const run = cardRun();
  c.__setState([run], "L1");
  setStatuses({});
  LS("fw_called", {});
  LS("fw_greet", { "Okafor, Daniel": "brother" });
  c.markCalled("380114", "Okafor, Daniel", true);
  const okafor = run.steps[1].actions[1].entities[0];
  let jfk = c.renderStep(run.steps[1], 1, run, EVE(), []);
  assert.match(jfk, /<div class="tel"><span class="telnum" data-mark="1\.1\.0\|phone">\(914\) 555-0163<\/span><\/div>\s*<span class="when">MESSAGED /);
  // The driver's own number, waiting for signal, then landed.
  okafor._edit = { phone: { patchId: "q:r9", value: "(914) 555-0163", documentValue: "(914) 555-0100", pending: true } };
  jfk = c.renderStep(run.steps[1], 1, run, EVE(), []);
  assert.match(jfk, /<span class="telnum edited pending" data-mark="1\.1\.0\|phone">/);
  okafor._edit.phone.pending = false;
  assert.match(c.renderStep(run.steps[1], 1, run, EVE(), []), /<span class="telnum edited" data-mark/);
  // The evening before, the first tap still asks a single's greeting: buttons, not links.
  LS("fw_greet", {});
  const ahead = cardRun("2099-09-29");
  c.__setState([ahead], "L1");
  jfk = c.renderStep(ahead.steps[1], 1, ahead, at(2099, 9, 28, 19, 0), []);
  assert.match(jfk, /<button class="msgbtn wa c" type="button" data-ask="wa"\s+data-phone="\(914\) 555-0163" aria-label="WhatsApp Okafor, Daniel">WA<\/button>/);
  assert.match(jfk, /class="greet-ask" hidden/);
  c.__setState([], null);
  LS("fw_called", {});
});

test("v68: the call list keeps its full-width pair and its chip; each says where the fix is", () => {
  const run = cardRun();
  c.__setState([run], "L1");
  setStatuses({});
  LS("fw_called", {});
  LS("fw_greet", { "Okafor, Daniel": "brother" });
  const okafor = run.steps[1].actions[1].entities[0];
  const list = c.contactBlock(run, okafor);
  assert.match(list, /class="msgbtn wa" href=/);
  assert.match(list, />WHATSAPP<\/a>/);
  assert.match(list, /class="greet-chip"/);
  assert.ok(!list.includes("telline"));
  // No country code: TEXT alone, and the way to add it, from each screen.
  okafor.phone = "555-0163";
  assert.match(c.contactBlock(run, okafor), /add it on the run, under &bull;&bull;&bull; Fix phone\./);
  const card = c.renderStep(run.steps[1], 1, run, EVE(), []).split('<span class="ename">Okafor, Daniel')[1];
  assert.match(card, /so no WhatsApp: add it under &bull;&bull;&bull; Fix phone\./);
  assert.ok(!card.includes("msgbtn wa c"));
  assert.match(card, /class="msgbtn sms c only"/);
  c.__setState([], null);
  LS("fw_greet", {});
});

test("v68 the passenger's menu: its rows for each kind of row", () => {
  const run = cardRun();
  c.__setState([run], "L1");
  setStatuses({});
  LS("fw_greet", { "Okafor, Daniel": "sister" });
  const okafor = run.steps[1].actions[1].entities[0];
  const castillo = run.steps[0].actions[0].entities[0];
  const keys = (e: any) => plain(c.paxMenuRows(run, e)).map((r: any) => r.key);
  const row = (e: any, key: string) => plain(c.paxMenuRows(run, e)).find((r: any) => r.key === key);

  // A single with a number and a flight: everything.
  assert.deepEqual(keys(okafor), ["phone", "flight", "greeting", "remove"]);
  assert.deepEqual(row(okafor, "phone"), {
    key: "phone", title: "Fix phone", sub: "(914) 555-0163",
    edit: { at: "1.1.0", field: "phone", label: "Phone for Okafor, Daniel", current: "(914) 555-0163", documentValue: "(914) 555-0163" },
  });
  assert.equal(row(okafor, "flight").title, "Fix flight");
  assert.match(row(okafor, "flight").sub, /^B61123 · you can also tap/);
  assert.equal(row(okafor, "greeting").greet, "sister");
  assert.deepEqual([row(okafor, "remove").title, row(okafor, "remove").remove],
    ["Not coming", { at: "1.1.0", label: "Okafor, Daniel" }]);
  // The menu's rows open the very correction the card's own buttons open.
  const card = c.renderStep(run.steps[1], 1, run, EVE(), []);
  assert.ok(card.includes(`data-edit="${c.esc(JSON.stringify(row(okafor, "flight").edit))}"`), "the flight on the card");

  // A family is "Family Castillo": no greeting to ask.
  assert.deepEqual(keys(castillo), ["phone", "flight", "remove"]);
  // No number printed, no flight: the phone to add, and not coming.
  const med = { _at: "0.0.1", name: "Reyes, Faye", pax: 1, tag: "MED", phone: null };
  assert.deepEqual(keys(med), ["phone", "remove"]);
  assert.deepEqual([row(med, "phone").title, row(med, "phone").sub], ["Add phone", "No number printed"]);
  // A flight row whose number the sheet left blank.
  const blank = { _at: "0.0.2", name: "Diaz, Ana", pax: 1, tag: "A", phone: "(845) 555-0111", flightNumber: null };
  assert.equal(row(blank, "flight").title, "Add flight");
  assert.equal(row(blank, "flight").edit.documentValue, null);
  // The driver's own correction says so, and keeps dispatch's value for the sheet.
  okafor._edit = { phone: { patchId: "P9", value: "(914) 555-0163", documentValue: "(914) 555-0100" } };
  assert.equal(row(okafor, "phone").sub, "(914) 555-0163 · yours");
  assert.equal(row(okafor, "phone").edit.documentValue, "(914) 555-0100");
  // A row the driver added is theirs to remove.
  const added = { _at: "+r1", name: "Roe, Rick", pax: 1, phone: null, _add: { patchId: "P1" } };
  assert.deepEqual([row(added, "remove").title, row(added, "remove").remove], ["Remove", { at: "+r1", label: "Roe, Rick" }]);
  c.__setState([], null);
  LS("fw_greet", {});
});

test("v68 the stop's menu: add once per pickup and drop-off, the time, each door, not happening", () => {
  const run = cardRun();
  c.__setState([run], "L1");
  setStatuses({});
  const rows = (step: any) => plain(c.stopMenuRows(run, step));
  const jfk = rows(run.steps[1]);
  assert.deepEqual(jfk.map((r: any) => r.key), ["add:1.0", "add:1.1", "time", "door:1.0", "door:1.1", "remove"]);
  assert.deepEqual(jfk.slice(0, 2).map((r: any) => [r.title, r.sub]), [
    ["Add a passenger", "To the drop-off at Departure Terminal"],
    ["Add a passenger", "To the pickup at Baggage Claim"],
  ]);
  assert.deepEqual(jfk[0].add, { at: "1.0", verb: "Drop-off", code: "JFK", label: "Drop-off at JFK" });
  assert.equal(jfk[2].sub, "7:10a – 10:30a · you can also tap the times");
  assert.deepEqual(jfk[2].edit, plain(c.timeSpecOf(run.steps[1])));
  assert.deepEqual([jfk[3].title, jfk[3].sub], ["Fix the door", "Drop-off · Departure Terminal · you can also tap the door"]);
  assert.deepEqual(jfk[5], { key: "remove", apart: true, title: "Stop not happening",
    sub: "Stays on the run, struck, with its UNDO.", remove: { at: "1", label: "JFK Kennedy" } });
  // The card's own times and door open the same corrections.
  const html = c.renderStep(run.steps[1], 1, run, EVE(), []);
  assert.ok(html.includes(`data-edit-time="${c.esc(JSON.stringify(jfk[2].edit))}"`), "the times in the head");
  assert.ok(html.includes(`data-edit="${c.esc(JSON.stringify(jfk[4].edit))}"`), "the pickup's door");

  // One door, left blank on the sheet.
  const wrk = rows(run.steps[2]);
  assert.deepEqual(wrk.map((r: any) => [r.key, r.title, r.sub]), [
    ["add:2.0", "Add a passenger", "To the drop-off"],
    ["time", "Fix the time", "12:30p – 1:15p · you can also tap the times"],
    ["door:2.0", "Add the door", "The sheet gave none · you can also tap the door"],
    ["remove", "Stop not happening", "Stays on the run, struck, with its UNDO."],
  ]);
  // A stop with nobody at it and one printed time; and one with no time at all.
  const night = overnight();
  c.ensureAddresses(night);
  assert.deepEqual(rows(night.steps[0]).map((r: any) => [r.key, r.sub]), [
    ["time", "leave 9:30p · you can also tap the times"],
    ["remove", "Stays on the run, struck, with its UNDO."],
  ]);
  assert.deepEqual(rows({ ...night.steps[0], eta: null, etd: null }).map((r: any) => r.key), ["remove"]);
  c.__setState([], null);
});

test("v68 menus: the rows as the sheet draws them", () => {
  const run = cardRun();
  LS("fw_greet", { "Okafor, Daniel": "sister" });
  const html = c.menuRowsHtml(c.paxMenuRows(run, run.steps[1].actions[1].entities[0]));
  // A row that opens a correction is a button with its place in the list.
  assert.match(html, /<button class="menu-row" type="button" data-row="0">[^]*?<span class="menu-title">Fix phone<\/span><span class="menu-sub">\(914\) 555-0163<\/span>/);
  // The greeting is answered in the row itself.
  assert.match(html, /data-greet="sister" aria-pressed="true">SISTER<\/button>/);
  assert.match(html, /data-greet="brother" aria-pressed="false">BROTHER<\/button>/);
  // Not coming stands apart, last, and is not red: red is a problem.
  assert.match(html, /<div class="menu menu-apart">\s*<button class="menu-row" type="button" data-row="3">/);
  assert.ok(html.indexOf("menu-apart") > html.indexOf("SISTER"));
  assert.ok(!/warn|alert/.test(html));
  LS("fw_greet", {});
});

test("v68 menus: a row acts on the copy the menu was opened on, not on a sheet that landed since", () => {
  const doc = (ctx as any).document;
  const was = doc.getElementById;
  const el: any = { value: "", textContent: "", hidden: false, checked: true, className: "", dataset: {},
    focus: noop, select: noop, reset: noop, querySelector: () => el, addEventListener: noop };
  doc.getElementById = () => el;
  (ctx as any).closeSheet = noop;
  (ctx as any).openSheet = noop;
  (ctx as any).renderCurrent = noop;
  (ctx as any).fetch = async () => { throw new Error("no signal"); };
  try {
    const run = cardRun();
    c.__setState([run], "L1");
    LS("fw_outbox", []);
    LS("fw_sent", []);
    const pax = c.rowMenuOf("380114", "1.1.0", false);
    const stop = c.rowMenuOf("380114", "1", true);
    assert.equal(pax.title, "Okafor, Daniel");
    assert.equal(stop.title, "JFK Kennedy");
    // Dispatch re-sends the run while the menu is open.
    const newer = cardRun();
    newer.importedAt = "2026-09-28T23:00:00.000Z";
    c.__setState([newer], "L1");
    const at = (menu: any, key: string) => menu.rows.findIndex((r: any) => r.key === key);

    c.pickMenuRow(pax, at(pax, "remove"));
    let op = LS("fw_outbox")[0];
    assert.deepEqual([op.body.kind, op.body.at, op.body.label, op.body.basis],
      ["remove", "1.1.0", "Okafor, Daniel", "2026-09-28T21:00:00.000Z"]);

    c.pickMenuRow(pax, at(pax, "phone"));
    assert.deepEqual(plain(vm.runInContext("editing", ctx)).aim, { basis: "2026-09-28T21:00:00.000Z" });
    c.pickMenuRow(stop, at(stop, "time"));
    assert.deepEqual(plain(vm.runInContext("editing", ctx)).aim, { basis: "2026-09-28T21:00:00.000Z" });
    c.pickMenuRow(stop, at(stop, "add:1.1"));
    const adding = plain(vm.runInContext("adding", ctx));
    assert.deepEqual([adding.mode, adding.at, adding.verb, adding.aim], ["entity", "1.1", "Pickup", { basis: "2026-09-28T21:00:00.000Z" }]);

    // Tapped on the card itself, a value is read from the copy on screen, as before.
    c.openEdit("380114", { at: "1.1.0", field: "phone", label: "Phone" });
    assert.deepEqual(plain(vm.runInContext("editing", ctx)).aim, { basis: "2026-09-28T23:00:00.000Z" });
    // A row that is gone, or a run that is: no menu.
    assert.equal(c.rowMenuOf("380114", "9.9.9", false), null);
    assert.equal(c.rowMenuOf("000000", "1", true), null);
  } finally {
    doc.getElementById = was;
    vm.runInContext("editing = null; adding = null;", ctx);
    LS("fw_outbox", []);
    c.__setState([], null);
  }
});

test("v68: a row the driver added and then took back reads REMOVED, not NOT COMING", () => {
  const run = servedWithAdd();
  c.ensureAddresses(run);
  c.__setState([run], "L1");
  setStatuses({});
  const [, , roe] = run.steps[1].actions[0].entities;
  roe._removed = { patchId: "P2" };
  run.steps[1].actions[0].entities[0]._removed = { patchId: "P3" };
  const html = c.renderStep(run.steps[1], 1, run, at(2026, 8, 31, 20, 0), []);
  assert.match(html, /<span class="gwhat">Roe, Rick<\/span>\s*<span class="gverb">REMOVED<\/span>/);
  assert.match(html, /<span class="gwhat">Pax UA1503<\/span>\s*<span class="gverb">NOT COMING<\/span>/);
  assert.equal(count(html, 'class="more"'), 1, "a ghost has its UNDO, not a menu");
  c.__setState([], null);
});

test("v68: a shuttle's foot is as it was", () => {
  const win = overnight();
  c.ensureAddresses(win);
  c.__setState([win], "L1");
  const html = c.renderStep(win.steps[0], 0, win, at(2026, 8, 31, 20, 0), []);
  assert.match(html, /\+ ADD A LEG/);
  assert.match(html, /data-remove="0"/);
  assert.ok(!html.includes("data-stop-menu"));
  c.__setState([], null);
});
