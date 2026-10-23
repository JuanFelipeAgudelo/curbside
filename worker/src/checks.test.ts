/**
 * Flight checks on the free plan (checks.ts): the lean plan per flight, the
 * sheet's time, and the unit budget.
 *
 *   node --test --experimental-strip-types src/checks.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// As in cron.test.ts: add ".ts" to sibling imports and transpile them.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
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

const C = await import("./checks.ts");
type Rung = import("./checks.ts").Rung;

const MIN = 60e3, H = 60 * MIN;
const LAND = Date.parse("2026-09-29T18:00:00Z");
const arrival = { role: "a" as const, arr: LAND, dep: null };
const departure = { role: "d" as const, arr: null, dep: LAND };

/** Plays a flight's checks from `from`, each made on time (or `late` after):
 *  the rungs made, in order. */
function play(anchors: typeof arrival | typeof departure, from: number, late = 0) {
  const made: string[] = [];
  let done: Rung[] = [];
  let now = from;
  for (let i = 0; i < 10; i++) {
    const p = C.planNext(anchors, done, now);
    if (p === C.DONE) return made;
    now = Math.max(now, Date.parse(p.at)) + late;
    made.push(p.rung);
    done = [...p.done, p.rung];
  }
  throw new Error("never done");
}

test("an arrival imported the evening before: three checks, none at import", () => {
  const p = C.planNext(arrival, [], LAND - 20 * H);
  assert.notEqual(p, C.DONE);
  assert.equal((p as { at: string }).at, new Date(LAND - 3 * H).toISOString());
  assert.deepEqual(play(arrival, LAND - 20 * H), ["a3h", "a45", "a15"]);
});

test("a departure: one check, three hours out", () => {
  assert.deepEqual(play(departure, LAND - 20 * H), ["d3h"]);
  assert.deepEqual(play(departure, LAND - 1 * H), ["d3h"], "imported late: once, now");
  assert.equal(C.planNext(departure, [], LAND + MIN), C.DONE, "gone: nothing to learn");
});

test("imported late, the checks already passed are skipped, not made at once", () => {
  assert.deepEqual(play(arrival, LAND - 2 * H), ["a3h", "a45", "a15"], "2h out: one now, then the rest");
  assert.deepEqual(play(arrival, LAND - 60 * MIN), ["a45", "a15"], "1h out: straight to the 45m check");
  assert.deepEqual(play(arrival, LAND - 10 * MIN), ["a15"], "10m out: the after-landing check is near enough");
  assert.deepEqual(play(arrival, LAND + 30 * MIN), ["a15"], "landed: the belt only");
  assert.equal(C.planNext(arrival, [], LAND + 3 * H), C.DONE);
});

test("a cron 20 minutes late still makes every check", () => {
  assert.deepEqual(play(arrival, LAND - 20 * H, 20 * MIN), ["a3h", "a45", "a15"]);
});

test("no time from the sheet or the API: one lookup to learn it, then no more", () => {
  const none = { role: "a" as const, arr: null, dep: null };
  const p = C.planNext(none, [], LAND);
  assert.equal((p as { rung: string }).rung, "first");
  assert.equal(C.planNext(none, ["first"], LAND), C.DONE);
});

test("two lookups in a row that find nothing give the flight up", () => {
  assert.notEqual(C.planNext(arrival, ["a3h"], LAND - 2 * H, 1), C.DONE);
  assert.equal(C.planNext(arrival, ["a3h", "a45"], LAND - 30 * MIN, 2), C.DONE);
});

test("the plan is re-read; legacy schedules (an instant) are re-planned", () => {
  const p = C.planNext(arrival, [], LAND - 20 * H) as import("./checks.ts").Plan;
  assert.deepEqual(C.readPlan(C.writePlan(p)), p);
  assert.equal(C.readPlan("done"), C.DONE);
  assert.equal(C.readPlan("2026-09-29T15:00:00.000Z"), null);
  assert.equal(C.readPlan(null), null);
});

test("the sheet's time is Eastern, summer and winter", () => {
  assert.equal(new Date(C.easternInstant("2026-09-29", "3:39 PM ORD - Chicago")!).toISOString(), "2026-09-29T19:39:00.000Z");
  assert.equal(new Date(C.easternInstant("2026-12-01", "12:05 AM MIA - Miami")!).toISOString(), "2026-12-01T05:05:00.000Z");
  assert.equal(new Date(C.easternInstant("2026-11-01", "11:30 PM")!).toISOString(), "2026-11-02T04:30:00.000Z", "the night the clocks go back");
  assert.equal(C.easternInstant("2026-09-29", null), null);
  assert.equal(C.easternInstant("2026-09-29", "ORD - Chicago"), null);
});

test("each flight's role and time come from its row on the sheet", () => {
  const meta = C.checkMetaOf({
    steps: [{ date: "2026-09-29", etaDate: "2026-09-29", actions: [{ entities: [
      { name: "A", tag: "A", flightNumber: "UA1", flightDate: "2026-09-29", scheduledText: "3:39 PM ORD - Chicago" },
      { name: "B", tag: "GBD", flightNumber: "B62", flightDate: "2026-09-29", scheduledText: "9:15 AM" },
      { name: "C", tag: "D", flightNumber: "DL3", flightDate: "2026-09-29", _removed: { patchId: "x" } },
    ] }] }],
  } as never);
  assert.deepEqual(Object.fromEntries(meta), {
    "UA1:2026-09-29": { r: "a", t: "2026-09-29T19:39:00.000Z" },
    "B62:2026-09-29": { r: "d", t: "2026-09-29T13:15:00.000Z" },
  });
});

test("the budget: a new month starts from nothing", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(C.currentBudget({ period: "2026-09", spent: 300 }, now).spent, 0);
  assert.equal(C.currentBudget({ period: "2026-10", spent: 30 }, now).spent, 30);
  const rapid = { period: "2026-09", spent: 300, remaining: 100, resetAt: "2026-10-05T00:00:00.000Z" };
  assert.equal(C.currentBudget(rapid, now).spent, 300, "RapidAPI's month, when it said, wins");
  assert.equal(C.currentBudget(rapid, Date.parse("2026-10-05T00:00:01Z")).spent, 0);
});

test("the budget: before-landing checks first, never past the hard limit", () => {
  const b = (spent: number, remaining?: number) => ({ period: "2026-09", spent, remaining });
  assert.deepEqual(C.allowChecks(b(0), ["a3h", "d3h", "a45"]), [true, true, true]);
  // 56 left: under the reserve, only the check before landing.
  assert.deepEqual(C.allowChecks(b(344), ["a3h", "a45", "a15", "a45"]), [false, true, false, true]);
  // 6 left: one lookup, and it goes to the 45m check whatever the order.
  assert.deepEqual(C.allowChecks(b(394), ["a3h", "a15", "a45", "a45"]), [false, false, true, false]);
  assert.deepEqual(C.allowChecks(b(396), ["a45"]), [false], "4 left: none");
  assert.deepEqual(C.allowChecks(b(0, 5), ["a45"]), [false], "RapidAPI's count wins when lower");
  assert.equal(C.checkState(b(0)), "ok");
  assert.equal(C.checkState(b(344)), "low");
  assert.equal(C.checkState(b(396)), "paused");
  assert.deepEqual(C.checksView(b(396)), { state: "paused", until: "2026-10-01T00:00:00.000Z", left: 2, renews: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(C.checksView(b(344)), { state: "low", left: 28, renews: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(C.checksView(b(0, 151)), { state: "ok", left: 75, renews: "2026-10-01T00:00:00.000Z" }, "RapidAPI's count, in lookups");
  assert.equal(C.checksView(b(401)).left, 0, "never below none");
});

test("RapidAPI's quota headers are read, whatever their exact names", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const h = new Headers({
    "x-ratelimit-requests-remaining": "1500",
    "X-RateLimit-Units-Remaining": "212",
    "x-ratelimit-units-reset": "86400",
  });
  assert.deepEqual(C.quotaFrom(h, now), { remaining: 212, resetAt: "2026-09-29T12:00:00.000Z" });
  assert.deepEqual(C.quotaFrom(new Headers({ "content-type": "application/json" }), now), {});
});

/* ---- each number of the plan, pinned (mutation pass, 2026-10-03) ---- */

test("each check's own time: 45 minutes before landing, 15 after; a departure's 3 hours before take-off", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const before = C.planNext(arrival, ["a3h"], LAND - 2 * H) as any;
  assert.deepEqual([before.rung, before.at], ["a45", iso(LAND - 45 * MIN)]);
  const after = C.planNext(arrival, ["a3h", "a45"], LAND - 30 * MIN) as any;
  assert.deepEqual([after.rung, after.at], ["a15", iso(LAND + 15 * MIN)]);
  const dep = C.planNext(departure, [], LAND - 20 * H) as any;
  assert.deepEqual([dep.rung, dep.at], ["d3h", iso(LAND - 3 * H)]);
});

test("a check is passed only when the next is under 40 minutes away", () => {
  // Imported 85 minutes before landing: the 45m check is exactly 40 away, so
  // the 3h one is still made, now. One minute later it is passed.
  const kept = C.planNext(arrival, [], LAND - 85 * MIN) as any;
  assert.equal(kept.rung, "a3h");
  const passed = C.planNext(arrival, [], LAND - 84 * MIN) as any;
  assert.deepEqual([passed.rung, passed.done], ["a45", ["a3h"]]);
});

test("the reserve starts under 60 units, not at them", () => {
  const b = (spent: number) => ({ period: "2026-09", spent });
  assert.deepEqual(C.allowChecks(b(340), ["a3h"]), [true], "60 left: any check");
  assert.deepEqual(C.allowChecks(b(340), ["a3h", "d3h"]), [true, false], "and it counts as it spends: 58 after the first");
  assert.deepEqual(C.allowChecks(b(342), ["a3h", "a45"]), [false, true], "58 left: only the one before landing");
  assert.equal(C.checkState(b(340)), "ok");
  assert.equal(C.checkState(b(342)), "low");
});
