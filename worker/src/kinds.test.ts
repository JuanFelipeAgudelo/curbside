/**
 * Phase 7b: rows the driver adds and removes.
 *
 * The test that matters most is the first. An added stop sharing a key with
 * dispatch's (a second WRK visit dispatch phoned in) must not change the
 * sibling count the anchors are guarded by -- if it did, every correction on
 * every WRK would orphan the moment the driver added one.
 *
 *   node --test --experimental-strip-types src/kinds.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { aimPatch, applyPatches, targetFor, type Patch } from "./patch.ts";
import { flightsOf, type Assignment, type Step } from "./assignment.ts";
import { stopsFor } from "./notify.ts";

const DATE = "2026-05-06";
let seq = 0;

function step(code: string, eta: string | null, actions: Step["actions"] = []): Step {
  return { code, place: code, date: DATE, eta, etd: eta, actions };
}

function person(name: string, extra: Record<string, unknown> = {}) {
  return { name, pax: 1, ...extra } as never;
}

/** 334184's shape: WRK -> TUX -> NCB -> TUX -> WRK, with people on it. */
function run(): Assignment {
  return {
    number: "334184",
    start: `${DATE} 08:00`,
    end: `${DATE} 12:00`,
    importedAt: "2026-05-05T21:00:00.000Z",
    steps: [
      step("WRK", "8:00 AM", [{ verb: "Pickup", where: "Lobby", entities: [person("Best, Ana", { phone: null })] }]),
      step("TUX", "9:00 AM"),
      step("NCB", "10:00 AM"),
      step("TUX", "11:00 AM"),
      step("WRK", "12:00 PM", [{ verb: "Drop-off", where: "Lobby", entities: [person("Best, Ana", { phone: null })] }]),
    ],
  };
}

function patch(p: Partial<Patch>): Patch {
  seq++;
  return { id: `2026050${seq}T000000000Z-aa`, at: `2026-05-0${seq}`, ref: `r${seq}`, ...p } as Patch;
}

function fix(a: Assignment, s: number, ai: number, ei: number, field: string, value: string): Patch {
  return patch({ target: targetFor(a, s, ai, ei), field, value, was: null });
}

test("an added stop sharing a key does not orphan corrections on dispatch's", () => {
  const a = run();
  const before = fix(a, 0, 0, 0, "phone", "+1 555 010 0001");
  const add = patch({ kind: "addStep", step: { place: "WRK", code: "WRK", date: DATE, time: "10:30 AM", verb: "Pickup", sibs: 2 } });
  // Written AFTER the add, from the stored copy -- which never holds added rows.
  const after = fix(run(), 4, 0, 0, "note", "back door");

  const b = run();
  const { edits, orphaned } = applyPatches(b, [before, add, after]);
  assert.equal(orphaned.length, 0, "a correction orphaned because a stop was added");
  assert.equal(b.steps[0].actions[0].entities[0].phone, "+1 555 010 0001");
  assert.equal(b.steps[5].actions[0].entities[0].note, "back door");
  assert.equal(edits.length, 2);
});

test("an added stop is placed by its time and leaves dispatch's addresses alone", () => {
  const a = run();
  const add = patch({ kind: "addStep", step: { place: "Fuel", date: DATE, time: "10:30 AM", verb: "Pickup", sibs: 0 } });
  applyPatches(a, [add]);
  const codes = a.steps.map((s) => s.code ?? s.place);
  assert.deepEqual(codes, ["WRK", "TUX", "NCB", "Fuel", "TUX", "WRK"]);
  const at = a.steps.map((s) => (s as unknown as { _at: string })._at);
  assert.deepEqual(at, ["0", "1", "2", `+${add.ref}`, "3", "4"]);
  assert.equal((a.steps[3].actions[0] as unknown as { _at: string })._at, `+${add.ref}.0`);
});

test("a passenger added by phone joins the action, addressed by its own patch", () => {
  const a = run();
  const add = patch({ kind: "addEntity", target: targetFor(a, 0, 0), entity: { name: "Cruz, Leo", flightNumber: "UA995", tag: "D" } });
  // Corrected later, by the add's key -- as the phone does before the server
  // has even answered.
  const phone = patch({ target: { on: add.ref! }, field: "phone", value: "+1 555 010 0002", was: null });
  const b = run();
  const { orphaned, changes } = applyPatches(b, [add, phone]);
  assert.equal(orphaned.length, 0);
  const added = b.steps[0].actions[0].entities[1];
  assert.equal(added.name, "Cruz, Leo");
  assert.equal(added.phone, "+1 555 010 0002");
  assert.equal(changes[0].kind, "addEntity");
  assert.equal(changes[0].agreed, false);
  assert.ok(flightsOf(b).some((f) => f.flightNumber === "UA995"), "an added flight must be polled");
});

test("an added passenger does not disturb the door anchor of their action", () => {
  const a = run();
  const door = patch({ target: targetFor(a, 0, 0), field: "where", value: "Side gate", was: "Lobby" });
  const add = patch({ kind: "addEntity", target: targetFor(a, 0, 0), entity: { name: "Cruz, Leo" } });
  // The door written after the add still names dispatch's passenger set.
  const door2 = patch({ target: targetFor(run(), 4, 0), field: "where", value: "Garage", was: "Lobby" });
  const b = run();
  const { orphaned } = applyPatches(b, [add, door, door2]);
  assert.equal(orphaned.length, 0);
  assert.equal(b.steps[0].actions[0].where, "Side gate");
  assert.equal(b.steps[4].actions[0].where, "Garage");
});

test("an add the next sheet also has is reported as agreed, and kept", () => {
  const a = run();
  const add = patch({ kind: "addEntity", target: targetFor(a, 0, 0), entity: { name: "Cruz, Leo" } });
  const b = run();
  b.steps[0].actions[0].entities.push(person("CRUZ,  Leo"));
  const { changes } = applyPatches(b, [add]);
  assert.equal(changes[0].agreed, true);
  assert.equal(b.steps[0].actions[0].entities.length, 3, "never auto-dropped");

  const stop = patch({ kind: "addStep", step: { place: "NCB", code: "NCB", date: DATE, time: "10:30 AM", verb: "Pickup", sibs: 1 } });
  const c = run();
  c.steps.splice(3, 0, step("NCB", "10:30 AM"));
  assert.equal(applyPatches(c, [stop]).changes[0].agreed, true);
  assert.equal(applyPatches(run(), [stop]).changes[0].agreed, false);
});

test("a removal marks the row and never splices it", () => {
  const a = run();
  const gone = patch({ kind: "remove", target: targetFor(a, 1), label: "TUX" });
  const who = patch({ kind: "remove", target: targetFor(a, 0, 0, 0), label: "Best, Ana" });
  const b = run();
  const { changes } = applyPatches(b, [gone, who]);
  assert.equal(b.steps.length, 5);
  assert.ok((b.steps[1] as unknown as { _removed: unknown })._removed);
  assert.ok((b.steps[0].actions[0].entities[0] as unknown as { _removed: unknown })._removed);
  assert.equal(changes.length, 2);
});

test("a passenger not coming is not coming to any of their rows", () => {
  const a = run();
  const who = patch({ kind: "remove", target: targetFor(a, 0, 0, 0), label: "Best, Ana" });
  const b = run();
  b.steps[2].actions = [{ verb: "Pickup", where: "Front", entities: [person("Cole, Noor")] }];
  const { changes } = applyPatches(b, [who]);
  const mark = (e: unknown) => (e as { _removed?: { patchId: string } })._removed;
  assert.equal(mark(b.steps[0].actions[0].entities[0])?.patchId, who.id);
  assert.equal(mark(b.steps[4].actions[0].entities[0])?.patchId, who.id, "the drop-off goes too");
  assert.equal(mark(b.steps[2].actions[0].entities[0]), undefined, "nobody else");
  assert.equal(changes.length, 1, "one patch, one undo");
});

test("a removed row sends no push and spends no polling", () => {
  const a: Assignment = {
    ...run(),
    steps: [
      step("WRK", "8:00 AM"),
      step("JFK", "9:30 AM", [{ verb: "Pickup", where: "Terminal 4", entities: [
        person("Best, Ana", { flightNumber: "DL1", tag: "A" }),
        person("Cruz, Leo", { flightNumber: "DL2", tag: "A" }),
      ] }]),
    ],
  };
  const who = patch({ kind: "remove", target: targetFor(a, 1, 0, 1), label: "Cruz, Leo" });
  const b = structuredClone(a);
  applyPatches(b, [who]);
  assert.deepEqual(flightsOf(b).map((f) => f.flightNumber), ["DL1"]);
  assert.equal(stopsFor(b, { flightNumber: "DL2", date: DATE }).length, 0);
  assert.equal(stopsFor(b, { flightNumber: "DL1", date: DATE })[0].rows.length, 1);

  const stop = patch({ kind: "remove", target: targetFor(a, 1), label: "JFK" });
  const c = structuredClone(a);
  applyPatches(c, [stop]);
  assert.equal(flightsOf(c).length, 0);
  assert.equal(stopsFor(c, { flightNumber: "DL1", date: DATE }).length, 0);
});

test("a removal the next sheet agrees with is said, not orphaned", () => {
  const a = run();
  const who = patch({ kind: "remove", target: targetFor(a, 0, 0, 0), label: "Best, Ana" });
  const b = run();
  b.steps[0].actions[0].entities = [];
  b.steps[4].actions[0].entities = [];
  const r = applyPatches(b, [who]);
  assert.equal(r.orphaned.length, 0);
  assert.equal(r.changes[0].agreed, true);
  assert.equal(r.changes[0].gone, true);
  assert.equal(r.changes[0].label, "Best, Ana");

  // Still somewhere in the run: moved, not gone. Never guessed -- an orphan.
  const c = run();
  c.steps[0].actions[0].entities = [];
  c.steps[1].actions = [{ verb: "Pickup", where: "Front", entities: [person("Best, Ana")] }];
  c.steps[4].actions[0].entities = [];
  assert.equal(applyPatches(c, [who]).orphaned.length, 1);
});

test("aimPatch reads addresses, and only sheet addresses are basis-guarded", () => {
  const a = run();
  const ok = aimPatch(a, { kind: "remove", at: "0.0.0" });
  assert.ok(!("error" in ok) && ok.onSheet && ok.target?.entity === "best, ana");

  const added = aimPatch(a, { kind: "addEntity", at: "+r9.0", entity: { name: "X" } });
  assert.ok(!("error" in added) && !added.onSheet);
  assert.deepEqual(!("error" in added) && added.target, { on: "r9", level: "action" });

  const stop = aimPatch(a, { kind: "addStep", step: { place: "WRK", code: "WRK", date: DATE, time: "3:40 PM", verb: "Pickup" } });
  assert.ok(!("error" in stop) && stop.step?.sibs === 2);

  assert.ok("error" in aimPatch(a, { kind: "remove", at: "0.0" }), "removing an action alone is not a thing");
  assert.ok("error" in aimPatch(a, { kind: "addEntity", at: "0.0.0", entity: { name: "X" } }));
  assert.ok("error" in aimPatch(a, { kind: "field", at: "9", field: "note" }));
  assert.ok("error" in aimPatch(a, { kind: "addStep", step: { place: "X", date: DATE, time: "25:00", verb: "Pickup" } }));
  assert.ok("error" in aimPatch(a, { at: "junk", field: "note" }));
});

/* ---------------------------------------------- legs: the notes' timed lines -- */

/** 374819's notes: a shuttle whose steps are printed as timed lines. */
function shuttle(): Assignment {
  return {
    ...run(),
    number: "374819",
    driverNotes: "6:15 NCB to SGA.\n\n7:45* or 5 min after Morning Worship concludes, depart SGA for NCA.\n"
      + "8:00 NCB to MGW.\nAfter you finish take one hour for late breakfast.\n8:00 NCB to MGW.",
  };
}

type Line = { printed: string | null; line: string; _at: string; _edit?: Record<string, { value: string; documentValue: string; contested: boolean }>; _removed?: unknown; _add?: { agreed: boolean } };
const linesOf = (a: Assignment) => (a as unknown as { lines: Line[] }).lines;

test("legs: every notes line is served with its address; the notes stay as printed", () => {
  const a = shuttle();
  applyPatches(a, []);
  assert.deepEqual(linesOf(a).map((l) => l._at), ["n0", "n1", "n2", "n3", "n4"]);
  assert.equal(linesOf(a)[1].printed, "7:45* or 5 min after Morning Worship concludes, depart SGA for NCA.");
  assert.equal(a.driverNotes, shuttle().driverNotes);
});

test("legs: a corrected leg keeps dispatch's words beside the driver's, and survives a reprint", () => {
  const stored = shuttle();
  const aim = aimPatch(stored, { at: "n1", field: "line", value: "7:40a or 5 min after Morning Worship concludes, depart SGA for NCA." });
  assert.ok(!("error" in aim) && aim.onSheet);
  const p = patch({ target: (aim as { target: Patch["target"] }).target, field: "line",
    value: "7:40a or 5 min after Morning Worship concludes, depart SGA for NCA.",
    was: "7:45* or 5 min after Morning Worship concludes, depart SGA for NCA." });
  let a = shuttle();
  applyPatches(a, [p]);
  const leg = linesOf(a)[1];
  assert.equal(leg.line, p.value);
  assert.equal(leg._edit!.line.documentValue, "7:45* or 5 min after Morning Worship concludes, depart SGA for NCA.");
  assert.equal(leg._edit!.line.contested, false);
  // A reprint that adds a line above moves no correction (words, not position).
  a = { ...shuttle(), driverNotes: "6:00 Fuel up.\n" + shuttle().driverNotes };
  applyPatches(a, [p]);
  assert.equal(linesOf(a)[2].line, p.value);
  // A reprint that rewords it, same time: bound, and both are shown.
  a = { ...shuttle(), driverNotes: shuttle().driverNotes!.replace("5 min after", "10 min after") };
  applyPatches(a, [p]);
  assert.equal(linesOf(a)[1].line, p.value);
  assert.equal(linesOf(a)[1]._edit!.line.contested, true);
});

test("legs: a line printed twice is told apart; a third copy orphans rather than guess", () => {
  const stored = shuttle();
  const aim = aimPatch(stored, { at: "n4", field: "line", value: "8:05a NCB to MGW." }) as { target: Patch["target"] };
  assert.deepEqual(aim.target!.line, { text: "8:00 NCB to MGW.", nth: 1, sibs: 2, time: "8:00" });
  const p = patch({ target: aim.target, field: "line", value: "8:05a NCB to MGW.", was: "8:00 NCB to MGW." });
  const a = shuttle();
  applyPatches(a, [p]);
  assert.deepEqual(linesOf(a).map((l) => l.line).filter((l) => l.includes("MGW")), ["8:00 NCB to MGW.", "8:05a NCB to MGW."]);
  const three = { ...shuttle(), driverNotes: shuttle().driverNotes + "\n8:00 NCB to MGW." };
  assert.equal(applyPatches(three, [p]).orphaned.length, 1);
});

test("legs: added and not happening, like rows; prose and a time-less value are refused", () => {
  const stored = shuttle();
  const add = aimPatch(stored, { kind: "addLeg", leg: { line: "  7:58a Wait at NCB lobby for late riders " } });
  assert.deepEqual(add, { leg: { line: "7:58a Wait at NCB lobby for late riders" }, onSheet: false });
  assert.ok("error" in aimPatch(stored, { kind: "addLeg", leg: { line: "Wait at NCB" } }));
  assert.ok("error" in aimPatch(stored, { at: "n3", field: "line", value: "8:00 x" }), "prose is not a leg");
  assert.ok("error" in aimPatch(stored, { at: "n0", field: "line", value: "NCB to SGA" }), "a leg keeps a time");
  assert.ok("error" in aimPatch(stored, { at: "n0", field: "eta", value: "6:20 AM" }));
  const added = patch({ kind: "addLeg", leg: { line: "7:58a Wait at NCB lobby for late riders" } });
  const fixAdded = patch({ target: { on: added.ref! }, field: "line", value: "7:59a Wait at NCB lobby", was: null });
  const gone = patch({ kind: "remove", target: (aimPatch(stored, { kind: "remove", at: "n0" }) as { target: Patch["target"] }).target, label: "6:15 NCB to SGA." });
  const a = shuttle();
  const r = applyPatches(a, [added, fixAdded, gone]);
  assert.equal(r.orphaned.length, 0);
  const mine = linesOf(a).find((l) => l._at === `+${added.ref}`)!;
  assert.equal(mine.line, "7:59a Wait at NCB lobby");
  assert.equal(mine.printed, null);
  assert.ok(linesOf(a)[0]._removed);
  // Dispatch drops the line too: said, never an orphan.
  const later = { ...shuttle(), driverNotes: shuttle().driverNotes!.replace("6:15 NCB to SGA.\n", "") };
  const r2 = applyPatches(later, [gone]);
  assert.equal(r2.orphaned.length, 0);
  assert.equal(r2.changes[0].gone, true);
  // Dispatch prints the added leg too: agreed.
  const printed = { ...shuttle(), driverNotes: shuttle().driverNotes + "\n7:58a Wait at NCB lobby for late riders" };
  const r3 = applyPatches(printed, [added]);
  assert.equal(r3.changes[0].agreed, true);
});

/* ------------------------------------------- v69: the driver's own stops -- */

test("a stop where nothing happens has no pickup or drop-off, and no door", () => {
  const a = run();
  const aim = aimPatch(a, { kind: "addStep", step: { place: "Sunoco", date: DATE, time: "10:30 AM", where: "Pump 3" } as never });
  assert.ok(!("error" in aim), JSON.stringify(aim));
  assert.equal(aim.step!.verb, null);
  assert.equal(aim.step!.where, null, "a door belongs to what happens there");

  const add = patch({ kind: "addStep", step: aim.step });
  const { orphaned, changes } = applyPatches(a, [add]);
  assert.equal(orphaned.length, 0);
  assert.equal(changes[0].kind, "addStep");
  assert.equal(a.steps[3].place, "Sunoco");
  assert.deepEqual(a.steps[3].actions, []);
});

test("a stop in the driver's own words keeps them, with its door", () => {
  const a = run();
  const aim = aimPatch(a, { kind: "addStep", step: { place: "Sunoco", date: DATE, time: "10:30 AM", verb: "  Fuel ", where: "Pump 3" } });
  assert.ok(!("error" in aim));
  applyPatches(a, [patch({ kind: "addStep", step: aim.step })]);
  assert.deepEqual([a.steps[3].actions[0].verb, a.steps[3].actions[0].where], ["Fuel", "Pump 3"]);
});

test("a stop with an arrive and a leave has both, and a leave past midnight is the next day's", () => {
  const a = run();
  const aim = aimPatch(a, { kind: "addStep", step: { place: "Sunoco", date: DATE, time: "10:30 AM", leave: "10:45 AM", verb: "Fuel" } as never });
  assert.ok(!("error" in aim), JSON.stringify(aim));
  assert.equal(aim.step!.leave, "10:45 AM");
  applyPatches(a, [patch({ kind: "addStep", step: aim.step })]);
  const fuel = a.steps[3];
  assert.deepEqual([fuel.eta, fuel.etd, fuel.etaDate, fuel.date], ["10:30 AM", "10:45 AM", DATE, DATE]);

  // Reached at 11:50 PM, left at 12:10 AM: the leave is dated as a sheet's is.
  const b = run();
  applyPatches(b, [patch({ kind: "addStep", step: { place: "Sunoco", date: DATE, time: "11:50 PM", leave: "12:10 AM", verb: "Fuel" } as never })]);
  const late = b.steps.find((s) => s.place === "Sunoco")!;
  assert.deepEqual([late.eta, late.etd, late.etaDate, late.date], ["11:50 PM", "12:10 AM", DATE, "2026-05-07"]);

  assert.ok("error" in aimPatch(a, { kind: "addStep", step: { place: "X", date: DATE, time: "10:30 AM", leave: "25:00" } as never }),
    "a leave that is no time is refused, not dropped");
});

test("a stop added before v69 reads as it did: one time for both, one action", () => {
  const a = run();
  applyPatches(a, [patch({ kind: "addStep", step: { place: "WRK", code: "WRK", date: DATE, time: "10:30 AM", verb: "Pickup", where: "Lobby", sibs: 2 } })]);
  const mine = a.steps[3];
  assert.deepEqual([mine.eta, mine.etd, mine.etaDate, mine.date], ["10:30 AM", "10:30 AM", DATE, DATE]);
  assert.deepEqual(mine.actions.map((x) => [x.verb, x.where, x.entities.length]), [["Pickup", "Lobby", 0]]);
});
