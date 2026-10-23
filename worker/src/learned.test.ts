/**
 * Airlines a list learned (learned.ts): filled in on read, marked, the
 * driver's own correction always first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { airlineKey, applyLearned } from "./learned.ts";

function run(): any {
  const row = (name: string, extra: object) => ({ name, pax: 1, tag: "A", flightNumber: null, ...extra });
  return {
    number: "900900", start: "2026-10-01 05:00", end: "2026-10-01 12:00",
    steps: [{ code: "JFK", place: "Kennedy", date: "2026-10-01", etaDate: "2026-10-01", actions: [{ verb: "Pickup", entities: [
      row("Moss, Ida", { unknownAirline: { name: "WestJet", number: "1680", date: "2026-10-01" } }),
      row("Cole, Al", { unknownAirline: { name: "Zed  Air", number: "7" } }),
      row("Fixed, By Driver", { unknownAirline: { name: "WestJet", number: "12" }, flightNumber: "AC12" }),
      row("Cleared, By Driver", { unknownAirline: { name: "WestJet", number: "13" }, _edit: { flightNumber: { documentValue: null } } }),
      row("No, Number", { unknownAirline: { name: "WestJet", number: "" } }),
      row("Plain, Row", { flightNumber: "UA1" }),
    ] }] }],
  };
}

test("learned: a known name fills the flight and its date, marked; nothing else is touched", () => {
  const a = run();
  assert.equal(applyLearned(a, [{ name: "westjet", code: "WS" }]), 1);
  const [moss, cole, fixed, cleared, none, plain] = a.steps[0].actions[0].entities;
  assert.equal(moss.flightNumber, "WS1680");
  assert.equal(moss.flightDate, "2026-10-01");
  assert.deepEqual(moss._learned, { name: "westjet", code: "WS" });
  assert.equal(cole.flightNumber, null);                // not learned
  assert.equal(fixed.flightNumber, "AC12");             // the driver's number stands
  assert.equal(cleared.flightNumber, null);             // the driver's blank too
  assert.equal(none.flightNumber, null);                // no number to put a code on
  assert.equal(plain._learned, undefined);
  assert.equal(applyLearned(a, [{ name: "ZED AIR", code: "ZD" }]), 1);
  assert.equal(cole.flightNumber, "ZD7");
  assert.equal(cole.flightDate, undefined);             // no date kept: the step's is used
  assert.equal(applyLearned(run(), []), 0);
  assert.equal(applyLearned(run(), undefined), 0);
});

test("learned: names compare as the importer's table does", () => {
  assert.equal(airlineKey("  West\tJet  Airlines "), "west jet airlines");
  assert.equal(airlineKey("WestJet"), airlineKey("westjet"));
});
