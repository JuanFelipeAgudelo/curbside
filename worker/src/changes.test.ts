/**
 * What dispatch changed (changes.ts): one copy of a run against an earlier
 * one, one entry per change, addressed as GET addresses the new copy's rows.
 * The run is made up, the mock's 900742 (spec "What changed").
 *
 *   node --test --experimental-strip-types src/changes.test.ts
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

const { baseOf, diffCopies, sameContent } = await import("./changes.ts");
const { applyPatches } = await import("./patch.ts");

const DAY = "2026-09-30";

function person(name: string, flightNumber: string, scheduledText: string, extra: Record<string, unknown> = {}) {
  return { name, pax: 1, tag: "A", flightNumber, scheduledText, flightDate: DAY, phone: "+1 555 010 0100", bags: 1, ...extra };
}
const rivera = () => person("Rivera, Ana", "B61234", "7:45 AM Orlando (MCO)");
const chen = () => person("Chen, Wei", "DL400", "7:30 AM Atlanta (ATL)");
const okafor = () => person("Okafor, Sam", "UA2210", "8:10 AM Chicago (ORD)");

function stop(code: string, place: string, eta: string | null, etd: string | null, actions: unknown[] = [], extra = {}) {
  return { code, place, address: null, eta, etd, date: DAY, etaDate: DAY, actions, ...extra };
}

/** The copy printed 5:04p: WRK -> JFK (two arrivals) -> FKL. */
function runA(): any {
  return {
    number: "900742", start: `${DAY} 05:30`, end: `${DAY} 11:00`,
    vehicle: "Mercedes Benz Metris (72566) (7 Seats)", parking: "FKL-NBD-003",
    printedAt: "2026-09-29 17:04", importedAt: "2026-09-29T21:05:00.000Z",
    driverNotes: "Call dispatch when you leave.",
    steps: [
      stop("WRK", "Warwick", null, "5:30 AM", [], { address: "1 Sample Road" }),
      stop("JFK", "John F Kennedy Intl", "7:00 AM", "8:15 AM",
        [{ verb: "Pickup", where: "Terminal 4 arrivals, door 6", entities: [rivera(), chen()] }]),
      stop("FKL", "Fishkill", "10:30 AM", null,
        [{ verb: "Drop-off", where: "Main lobby", entities: [rivera(), chen()] }], { address: "2 Sample Lane" }),
    ],
  };
}

/** A later print of the same run, changed by `edit`. */
function later(edit: (a: any) => void, printedAt = "2026-09-29 20:12"): any {
  const a = runA();
  a.printedAt = printedAt;
  edit(a);
  return a;
}

const kinds = (d: { items: { kind: string }[] }) => d.items.map((c) => c.kind);

test("changes: a reprint that changed nothing counts nothing; case and spacing are not changes", () => {
  const b = later((a) => { a.steps[2].actions[0].where = "  main  LOBBY "; });
  const d = diffCopies(baseOf(runA()), b);
  assert.equal(d.count, 0);
  assert.deepEqual(d.items, []);
  assert.equal(d.since, "2026-09-29 17:04");
  assert.equal(sameContent(runA(), b), true);
});

test("changes: the mock's re-send -- vehicle, two stops retimed, one passenger new, one gone -- is 5", () => {
  const b = later((a) => {
    a.vehicle = "Toyota Sienna (00412) (7 Seats)";
    a.end = `${DAY} 11:30`;
    Object.assign(a.steps[1], { eta: "7:30 AM", etd: "8:45 AM" });
    a.steps[1].actions[0].entities = [rivera(), okafor()];
    a.steps[2].eta = "11:00 AM";
    a.steps[2].actions[0].entities = [rivera(), okafor()];
  });
  const d = diffCopies(baseOf(runA()), b);
  assert.deepEqual(kinds(d), ["vehicle", "times", "times", "personAdded", "personDropped"]);
  assert.equal(d.count, 5);
  const [vehicle, jfk, fkl, added, gone] = d.items as any[];
  assert.deepEqual(vehicle, { kind: "vehicle", was: "Mercedes Benz Metris (72566) (7 Seats)", now: "Toyota Sienna (00412) (7 Seats)" });
  assert.equal(jfk.at, "1");
  assert.deepEqual([jfk.was.eta, jfk.was.etd, jfk.now.eta, jfk.now.etd], ["7:00 AM", "8:15 AM", "7:30 AM", "8:45 AM"]);
  assert.equal(fkl.at, "2");
  assert.deepEqual([fkl.was.eta, fkl.now.eta], ["10:30 AM", "11:00 AM"]);
  // One change for a person, however many stops they are at.
  assert.deepEqual(added, { kind: "personAdded", name: "Okafor, Sam", codes: ["JFK", "FKL"], rows: ["1.0.1", "2.0.1"] });
  assert.equal(gone.name, "Chen, Wei");
  assert.deepEqual(gone.codes, ["JFK", "FKL"]);
  assert.deepEqual(gone.gone.map((g: any) => [g.step, g.action, g.code, g.to]), [["1", "1.0", "JFK", null], ["2", "2.0", "FKL", null]]);
  // The run's end moved with its stops: on the card, not counted again.
  assert.deepEqual(d.run, { end: `${DAY} 11:00` });
});

test("changes: every address is the one GET gives the new copy's row", () => {
  const b = later((a) => {
    Object.assign(a.steps[1], { eta: "7:30 AM" });
    a.steps[1].actions[0].where = "Terminal 4 arrivals, door 5";
    a.steps[1].actions[0].entities = [rivera(), okafor()];
    a.steps[2].actions[0].entities[0].flightNumber = "B61288";
    a.driverNotes = "Call dispatch when you leave.\n9:15 Fuel at the Fishkill yard.";
  });
  const d = diffCopies(baseOf(runA()), b);
  const served = structuredClone(b);
  applyPatches(served, []); // gives every row its `_at`, as GET does
  const rows = new Map<string, any>();
  for (const s of served.steps) {
    rows.set(s._at, s);
    for (const x of s.actions) {
      rows.set(x._at, x);
      for (const e of x.entities) rows.set(e._at, e);
    }
  }
  for (const l of served.lines) rows.set(l._at, l);
  const byKind = new Map((d.items as any[]).map((c) => [c.kind, c]));
  assert.equal(rows.get(byKind.get("times").at).code, "JFK");
  assert.equal(rows.get(byKind.get("place").doors[0].at).where, "Terminal 4 arrivals, door 5");
  assert.deepEqual(byKind.get("personAdded").rows.map((at: string) => rows.get(at).name), ["Okafor, Sam"]);
  assert.equal(rows.get(byKind.get("fact").rows[0].at).name, "Rivera, Ana");
  assert.equal(rows.get(byKind.get("legAdded").at).printed, "9:15 Fuel at the Fishkill yard.");
});

test("changes: a stop inserted before another of the same code takes neither's place", () => {
  const tux = (eta: string, who: any[]) => stop("TUX", "Tuxedo", eta, eta, [{ verb: "Pickup", where: "Lobby", entities: who }]);
  const a = { ...runA(), steps: [stop("WRK", "Warwick", null, "6:00 AM"), tux("8:00 AM", [rivera()]), stop("WRK", "Warwick", "11:00 AM", null)] };
  const b = { ...a, printedAt: "2026-09-29 20:12",
    steps: [stop("WRK", "Warwick", null, "6:00 AM"), tux("7:00 AM", [okafor()]), tux("8:00 AM", [rivera()]), stop("WRK", "Warwick", "11:00 AM", null)] };
  const d = diffCopies(baseOf(a), b);
  assert.deepEqual(kinds(d), ["stopAdded", "personAdded"]);
  assert.equal((d.items[0] as any).at, "1"); // the new 7:00, not the 8:00 Rivera is still at
  assert.deepEqual((d.items[1] as any).rows, ["1.0.0"]);
});

test("changes: the opening stop dropped is one change; the rest still pair (334184's shape)", () => {
  const s = (code: string, t: string) => stop(code, code, t, t);
  const a = { ...runA(), steps: [s("WRK", "6:00 AM"), s("TUX", "7:00 AM"), s("NCB", "8:00 AM"), s("TUX", "9:00 AM"), s("WRK", "10:00 AM")] };
  const b = { ...a, printedAt: "2026-09-29 20:12", steps: a.steps.slice(1) };
  const d = diffCopies(baseOf(a), b);
  assert.deepEqual(kinds(d), ["stopDropped"]);
  assert.deepEqual(d.items[0], {
    kind: "stopDropped", after: null, code: "WRK", place: "WRK", eta: "6:00 AM", etd: "6:00 AM", date: DAY, etaDate: DAY,
  });
});

test("changes: a stop dropped mid-run keeps its place in the rail: after the stop before it", () => {
  const b = later((a) => { a.steps.splice(1, 0, stop("MNT", "Maintenance Yard", "6:30 AM", "6:45 AM")); });
  const c = later((a) => { a.driverNotes = a.driverNotes; });
  const d = diffCopies(baseOf(b), c);
  assert.deepEqual(kinds(d), ["stopDropped"]);
  assert.equal((d.items[0] as any).after, "0");
  assert.equal((d.items[0] as any).code, "MNT");
});

test("changes: a passenger moved is one change -- MOVED HERE at the new stop, moved to it at the old", () => {
  const a = later((x) => {
    x.steps.splice(1, 1, stop("EWR", "Newark", "7:00 AM", "8:00 AM",
      [{ verb: "Pickup", where: "Terminal C", entities: [chen(), rivera()] }]));
  }, "2026-09-29 17:04");
  const b = later((x) => {
    x.steps.splice(1, 1,
      stop("EWR", "Newark", "7:00 AM", "8:00 AM", [{ verb: "Pickup", where: "Terminal C", entities: [rivera()] }]),
      stop("JFK", "John F Kennedy Intl", "8:30 AM", "9:15 AM", [{ verb: "Pickup", where: "Terminal 4", entities: [chen()] }]));
  });
  const d = diffCopies(baseOf(a), b);
  assert.deepEqual(kinds(d), ["stopAdded", "personMoved"]);
  const moved = d.items[1] as any;
  assert.equal(moved.name, "Chen, Wei");
  assert.deepEqual(moved.codes, ["JFK", "FKL"]);
  assert.deepEqual(moved.here, [{ at: "2.0.0", code: "JFK", from: "EWR" }]);
  assert.deepEqual(moved.gone, [{ step: "1", action: "1.0", verb: "Pickup", code: "EWR", to: "JFK" }]);
});

test("changes: a rebooked flight is one fact, marked on each of the passenger's rows", () => {
  const b = later((a) => {
    for (const s of [a.steps[1], a.steps[2]]) {
      Object.assign(s.actions[0].entities[0], { flightNumber: "B61288", scheduledText: "8:05 AM Orlando (MCO)" });
    }
    a.steps[1].actions[0].entities[1].phone = "+1 555 010 0199";
  });
  const d = diffCopies(baseOf(runA()), b);
  assert.deepEqual(kinds(d), ["fact", "fact"]);
  const [flight, phone] = d.items as any[];
  assert.equal(flight.fact, "flight");
  assert.equal(flight.name, "Rivera, Ana");
  assert.deepEqual(flight.was, { flightNumber: "B61234", scheduledText: "7:45 AM Orlando (MCO)", flightDate: DAY });
  assert.deepEqual(flight.now, { flightNumber: "B61288", scheduledText: "8:05 AM Orlando (MCO)", flightDate: DAY });
  assert.deepEqual(flight.rows.map((r: any) => r.at), ["1.0.0", "2.0.0"]);
  // Only the row that changed: the drop-off still printed the old number.
  assert.equal(phone.fact, "phone");
  assert.deepEqual(phone.rows, [{ at: "1.0.1", was: { phone: "+1 555 010 0100", otherPhones: null } }]);
});

test("changes: a door, a verb and a place are one change for their stop", () => {
  const b = later((a) => {
    a.steps[1].actions[0].where = "Terminal 4 arrivals, door 5";
    a.steps[2].place = "Fishkill Campus";
    a.steps[2].address = "3 Sample Lane";
  });
  const d = diffCopies(baseOf(runA()), b);
  assert.deepEqual(kinds(d), ["place", "place"]);
  const [jfk, fkl] = d.items as any[];
  assert.deepEqual(jfk.doors, [{ at: "1.0", was: { verb: "Pickup", where: "Terminal 4 arrivals, door 6" },
    now: { verb: "Pickup", where: "Terminal 4 arrivals, door 5" } }]);
  assert.deepEqual(jfk.was, {});
  assert.deepEqual(fkl.was, { place: "Fishkill", address: "2 Sample Lane" });
  assert.deepEqual(fkl.doors, []);
});

test("changes: legs retimed, new, dropped and reworded; the prose is one change", () => {
  const notes = (lines: string[]) => lines.join("\n");
  const a = later((x) => {
    x.driverNotes = notes(["6:15 NTH to STH.", "6:40 STH to LIB.", "7:10 Depart LIB, drop at STH on request.",
      "7:45* or 5 min after the meeting ends, LIB to NTH.", "8:30 Lunch run to CLN.", "Please be on time."]);
  }, "2026-09-29 17:04");
  const b = later((x) => {
    x.driverNotes = notes(["6:15 NTH to STH.", "7:10 Depart LIB, drop at STH on request.",
      "7:50* or 5 min after the meeting ends, LIB to NTH.", "8:05 Depart NTH for WRK.", "8:30 Lunch run to SGA.",
      "Please be early.", "Keys at the desk."]);
  });
  const d = diffCopies(baseOf(a), b);
  assert.deepEqual(d.items, [
    { kind: "legRetimed", at: "n2", was: "7:45* or 5 min after the meeting ends, LIB to NTH.",
      line: "7:50* or 5 min after the meeting ends, LIB to NTH." },
    { kind: "legAdded", at: "n3", line: "8:05 Depart NTH for WRK." },
    { kind: "legReworded", at: "n4", was: "8:30 Lunch run to CLN.", line: "8:30 Lunch run to SGA." },
    { kind: "legDropped", line: "6:40 STH to LIB." },
    { kind: "notes", added: ["Please be early.", "Keys at the desk."], dropped: ["Please be on time."] },
  ]);
  assert.equal(d.count, 5);
});

test("changes: the run's start or end alone is a change; with its stops it is theirs", () => {
  const alone = diffCopies(baseOf(runA()), later((a) => { a.end = `${DAY} 11:30`; }));
  assert.deepEqual(alone.items, [{ kind: "runTimes", was: { start: `${DAY} 05:30`, end: `${DAY} 11:00` },
    now: { start: `${DAY} 05:30`, end: `${DAY} 11:30` } }]);
  const withStop = diffCopies(baseOf(runA()), later((a) => { a.end = `${DAY} 11:30`; a.steps[2].eta = "11:00 AM"; }));
  assert.deepEqual(kinds(withStop), ["times"]);
  assert.deepEqual(withStop.run, { end: `${DAY} 11:00` });
});

test("changes: a stop's date alone moves its times; parking is its own change", () => {
  const b = later((a) => { a.steps[2].etaDate = "2026-10-01"; a.steps[2].date = "2026-10-01"; a.parking = "WRK-NBD-011"; });
  const d = diffCopies(baseOf(runA()), b);
  assert.deepEqual(kinds(d), ["parking", "times"]);
  assert.deepEqual((d.items[0] as any), { kind: "parking", was: "FKL-NBD-003", now: "WRK-NBD-011" });
});

test("changes: dispatch changing it back counts nothing against the copy it went back to", () => {
  const b = later((a) => { a.vehicle = "Toyota Sienna (00412) (7 Seats)"; });
  const back = later(() => {}, "2026-09-29 21:40");
  assert.equal(diffCopies(baseOf(runA()), b).count, 1);
  assert.equal(diffCopies(baseOf(runA()), back).count, 0);
  // Against the copy in between, the change back is a change.
  assert.deepEqual(kinds(diffCopies(baseOf(b), back)), ["vehicle"]);
});

test("changes: the base keeps dispatch's fields only, and none of the app's", () => {
  const a = runA();
  a.issues = ["an issue"];
  a.driver = "Someone";
  a.steps[1].actions[0].entities[0]._at = "1.0.0";
  const base = baseOf(a) as any;
  assert.deepEqual(Object.keys(base).sort(), ["driverNotes", "end", "parking", "printedAt", "start", "steps", "vehicle"]);
  assert.equal(base.steps[1].actions[0].entities[0]._at, undefined);
  assert.equal(base.steps[1].actions[0].entities[0].flightNumber, "B61234");
  assert.equal("note" in base.steps[1].actions[0].entities[0], false); // absent fields stay absent
});

test("changes: two rows printed with one name at one door are two rows, not one that moved", () => {
  // Dispatch prints the same name twice (a father and son, a name it reused).
  const twice = (a: any) => {
    a.steps[1].actions[0].entities.push(rivera());
    a.steps[2].actions[0].entities.push(rivera());
  };
  const a = runA(); twice(a);
  const reprint = later(twice);
  assert.equal(diffCopies(baseOf(a), reprint).count, 0, JSON.stringify(diffCopies(baseOf(a), reprint).items));
  assert.equal(sameContent(a, reprint), true);
  // One of the two changes: said once, on the row that changed.
  const bags = later((b) => { twice(b); b.steps[1].actions[0].entities[2].bags = 3; });
  const d = diffCopies(baseOf(a), bags);
  assert.deepEqual(d.items.map((c: any) => c.kind === "fact" ? `${c.fact}:${c.rows.map((r: any) => r.at)}` : c.kind), ["bags:1.0.2"]);
});
