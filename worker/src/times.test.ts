/**
 * Driver-corrected step times (the owner, 2026-09-23: "as mine beside theirs").
 *
 * The driver's time is written into the field, so every clock runs on it; what
 * must not be lost is dispatch's, which every "dispatch planned" still prints.
 *
 *   node --test --experimental-strip-types src/times.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { aimPatch, applyPatches, targetFor, type Patch } from "./patch.ts";
import type { Assignment } from "./assignment.ts";
import { noticeFor, stopsFor } from "./notify.ts";
import type { FlightStatus } from "./types.ts";

let seq = 0;
function patch(p: Partial<Patch>): Patch {
  seq++;
  return { id: `20260923T0000${String(seq).padStart(2, "0")}000Z-aa`, at: "2026-09-23", ref: `t${seq}`, ...p } as Patch;
}

/** 369736's shape: FKL -> LGA (two arrivals) -> WKL. */
function run(): Assignment {
  return {
    number: "369736",
    start: "2026-08-31 21:30",
    end: "2026-09-01 03:00",
    importedAt: "2026-08-30T21:00:00.000Z",
    steps: [
      { code: "FKL", place: "Fishkill", etd: "9:30 PM", date: "2026-08-31", actions: [] },
      {
        code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM",
        date: "2026-09-01", etaDate: "2026-08-31",
        actions: [{
          verb: "Pickup", where: "Baggage Claim",
          entities: [
            { name: "R. Alvarez", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: "2026-08-31" },
          ],
        }],
      },
      { code: "WKL", place: "Wallkill", eta: "2:15 AM", date: "2026-09-01", actions: [] },
    ],
  } as Assignment;
}

function time(a: Assignment, s: number, field: string, value: string, was: string | null): Patch {
  return patch({ target: targetFor(a, s), field, value, was });
}

test("a corrected time is the step's time, with dispatch's kept as the document value", () => {
  const a = run();
  const p = time(a, 0, "etd", "9:15 PM", "9:30 PM");
  const { edits } = applyPatches(a, [p]);
  assert.equal(a.steps[0].etd, "9:15 PM");
  assert.equal(edits[0].documentValue, "9:30 PM");
  assert.equal(edits[0].contested, false);
});

test("a later sheet that moves the time too is contested, and the driver still wins", () => {
  const a = run();
  const p = time(a, 1, "eta", "11:10 PM", "11:00 PM");
  const next = run();
  next.steps[1].eta = "11:20 PM";
  const { edits } = applyPatches(next, [p]);
  assert.equal(next.steps[1].eta, "11:10 PM");
  assert.equal(edits[0].contested, true);
  assert.equal(edits[0].documentValue, "11:20 PM");
});

test("a time the sheet never printed is not invented, and a time is never cleared", () => {
  const a = run();
  assert.ok("error" in aimPatch(a, { at: "0", field: "eta", value: "9:00 PM" }), "FKL has no ETA");
  assert.ok("error" in aimPatch(a, { at: "0", field: "etd", value: null }));
  assert.ok("error" in aimPatch(a, { at: "0", field: "etd", value: "21:15" }), "the sheet's format only");
  assert.ok("error" in aimPatch(a, { at: "0", field: "date", value: "2026-09-02" }));
  assert.ok("error" in aimPatch(a, { at: "1.0", field: "eta", value: "9:00 PM" }), "a time belongs to a stop");
  assert.ok(!("error" in aimPatch(a, { at: "0", field: "etd", value: "9:15 PM" })));
  assert.ok(!("error" in aimPatch(a, { at: "1.0.0", field: "phone", value: "+1 555 010 0000" })));
  assert.ok("error" in aimPatch(a, { at: "1.0.0", field: "_removed", value: "x" }), "only correctable fields");
});

test("an added stop's time moves both, and re-places it among dispatch's", () => {
  const a = run();
  const add = patch({ kind: "addStep", step: { place: "SWF", code: "SWF", date: "2026-08-31", time: "10:00 PM", verb: "Pickup", sibs: 0 } });
  const aim = aimPatch(a, { at: `+${add.ref}`, field: "time", value: "9:00 PM" });
  assert.ok(!("error" in aim));
  const move = patch({ target: { on: add.ref! }, field: "time", value: "9:00 PM", was: "10:00 PM" });

  applyPatches(a, [add]);
  assert.deepEqual(a.steps.map((s) => s.code), ["FKL", "SWF", "LGA", "WKL"]);

  const b = run();
  applyPatches(b, [add, move]);
  const swf = b.steps.find((s) => s.code === "SWF")!;
  assert.equal(swf.eta, "9:00 PM");
  assert.equal(swf.etd, "9:00 PM");
  // 9:00 PM on the 31st sorts before FKL's 9:30 PM. Dispatch's order is kept.
  assert.deepEqual(b.steps.map((s) => s.code), ["SWF", "FKL", "LGA", "WKL"]);
});

test("dispatch's steps are never re-sorted by a driver's time", () => {
  const a = run();
  applyPatches(a, [time(a, 1, "eta", "9:00 PM", "11:00 PM")]);
  assert.deepEqual(a.steps.map((s) => s.code), ["FKL", "LGA", "WKL"]);
});

test("a time field aimed at a passenger binds nowhere", () => {
  const a = run();
  const add = patch({ kind: "addEntity", target: targetFor(a, 1, 0), entity: { name: "New, Pat" } });
  const bad = patch({ target: { on: add.ref! }, field: "time", value: "9:00 PM" });
  const { orphaned } = applyPatches(a, [add, bad]);
  assert.deepEqual(orphaned.map((p) => p.id), [bad.id]);
});

/* ---------------------------------------------------------- the pushes -- */

const ET = "-04:00";
const at = (hhmm: string, day = "2026-08-31") => Date.parse(`${day}T${hhmm}:00${ET}`);

function status(fn: string, arr: string): FlightStatus {
  const local = `2026-08-31 ${arr}${ET}`;
  return {
    flightNumber: fn, date: "2026-08-31", status: "Expected",
    departure: { airport: "X", airportCode: "XXX", scheduledTime: null, estimatedTime: null, actualTime: null, terminal: null, gate: null } as never,
    arrival: { airport: "LaGuardia", airportCode: "LGA", scheduledTime: local, estimatedTime: local, actualTime: null, terminal: null, gate: null, baggageBelt: null } as never,
  } as FlightStatus;
}

function moved(s: FlightStatus, arr: string): FlightStatus {
  const next = structuredClone(s);
  next.arrival.estimatedTime = `2026-08-31 ${arr}${ET}`;
  return next;
}

test("the push runs on the driver's time and still names dispatch's", () => {
  const a = run();
  // The driver sets off from FKL at 9:45 instead of 9:30: a 75-minute leg.
  applyPatches(a, [time(a, 0, "etd", "9:45 PM", "9:30 PM")]);
  const [stop] = stopsFor(a, { flightNumber: "UA1503", date: "2026-08-31" });
  assert.equal(stop.plannedLeave, "9:30 PM", "dispatch's, for the label");
  assert.equal(stop.yourLeave, "9:45 PM");
  assert.equal(stop.legMinutes, 75, "the clocks run on the driver's time");

  const ua = status("UA1503", "23:09");
  const n = noticeFor(stop, { flightNumber: "UA1503", date: "2026-08-31" }, ua, moved(ua, "23:29"), {}, at("20:00"));
  assert.ok(n);
  assert.equal(n.title, "Leave 20 minutes later");
  assert.match(n.body, /leave by 9:59p, you set 9:45p, dispatch 9:30p/);
  // On dispatch's 90-minute leg it would have been 9:44p.
  assert.doesNotMatch(n.body, /9:44p/);
});

test("an uncorrected stop still says only what dispatch planned", () => {
  const [stop] = stopsFor(run(), { flightNumber: "UA1503", date: "2026-08-31" });
  assert.equal(stop.yourLeave, null);
  assert.equal(stop.plannedEta, "11:00 PM");
});

/* ------------------------------------------- v69: the driver's own stops -- */

test("an added stop's arrive and leave are each corrected on their own", () => {
  const a = run();
  const add = patch({ kind: "addStep", step: { place: "SWF", code: "SWF", date: "2026-08-31", time: "10:00 PM", leave: "10:20 PM", verb: "Pickup", sibs: 0 } as never });
  for (const field of ["eta", "etd"]) {
    assert.ok(!("error" in aimPatch(a, { at: `+${add.ref}`, field, value: "10:05 PM" })), field);
  }
  const later = patch({ target: { on: add.ref! }, field: "etd", value: "10:30 PM", was: "10:20 PM" });
  const { edits, orphaned } = applyPatches(a, [add, later]);
  const swf = a.steps.find((s) => s.code === "SWF")!;
  assert.deepEqual([swf.eta, swf.etd], ["10:00 PM", "10:30 PM"]);
  assert.equal(edits[0].documentValue, "10:20 PM", "what it was added as");
  assert.equal(orphaned.length, 0);
});

test("an alert quotes an added stop's time as the driver's, never as dispatch's plan", () => {
  const a = run();
  // A fuel stop on the way, left at 9:40 PM: an 80-minute leg to LGA.
  const add = patch({ kind: "addStep", step: { place: "Sunoco", date: "2026-08-31", time: "9:35 PM", leave: "9:40 PM", verb: "Fuel", sibs: 0 } as never });
  applyPatches(a, [add]);
  assert.deepEqual(a.steps.map((s) => s.code ?? s.place), ["FKL", "Sunoco", "LGA", "WKL"]);
  const [stop] = stopsFor(a, { flightNumber: "UA1503", date: "2026-08-31" });
  assert.equal(stop.plannedLeave, null, "dispatch planned no such stop");
  assert.equal(stop.yourLeave, "9:40 PM");
  assert.equal(stop.legMinutes, 80);

  const ua = status("UA1503", "23:09");
  const n = noticeFor(stop, { flightNumber: "UA1503", date: "2026-08-31" }, ua, moved(ua, "23:29"), {}, at("20:00"));
  assert.ok(n);
  assert.match(n.body, /leave by 9:54p, you set 9:40p(\n|$)/);
  assert.doesNotMatch(n.body, /dispatch (planned )?9:40p/);
});

test("an airport stop the driver added has no time of dispatch's, edited or not", () => {
  const a = run();
  const add = patch({ kind: "addStep", step: { place: "SWF", code: "SWF", date: "2026-08-31", time: "10:00 PM", verb: "Pickup", sibs: 0 } });
  const who = patch({ kind: "addEntity", target: { on: add.ref!, level: "action" },
    entity: { name: "New, Pat", flightNumber: "DL5", tag: "A" } });
  const retimed = patch({ target: { on: add.ref! }, field: "time", value: "10:10 PM", was: "10:00 PM" });
  applyPatches(a, [add, who, retimed]);
  const [stop] = stopsFor(a, { flightNumber: "DL5", date: "2026-08-31" });
  assert.equal(stop.code, "SWF");
  assert.deepEqual([stop.plannedEta, stop.plannedEtd], [null, null]);
  assert.deepEqual([stop.yourEta, stop.yourEtd], ["10:10 PM", "10:10 PM"]);
});

test("an alert carries its run's number, for the tap that opens it", () => {
  const [stop] = stopsFor(run(), { flightNumber: "UA1503", date: "2026-08-31" });
  assert.equal(stop.run, "369736");
  const ua = status("UA1503", "23:09");
  const n = noticeFor(stop, { flightNumber: "UA1503", date: "2026-08-31" }, ua, moved(ua, "23:29"), {}, at("20:00"));
  assert.equal(n!.run, "369736");
});
