/**
 * Targeting tests.
 *
 * Every shape below is taken from a real fixture in tools/fixtures/, because
 * the collision cases are not hypothetical: measured across 15 real
 * assignments, the step key `(code|date)` collides in 11 of them, 4 of 48 steps
 * hold two actions sharing a verb, and a passenger name repeats within a step
 * twice.
 *
 * The test that matters most is the last one. Everything else here guards
 * against orphaning when we should bind; that one guards against BINDING when
 * we should orphan, which is the only failure mode that can silently put a
 * correction on the wrong stop.
 *
 *   node --test --experimental-strip-types src/patch.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  admitPatch,
  applyPatches,
  nameKey,
  resolveTarget,
  targetFor,
  type Patch,
} from "./patch.ts";
import type { Assignment, Step } from "./assignment.ts";

const DATE = "2026-05-06";

function step(code: string, actions: Step["actions"] = []): Step {
  return { code, place: code, date: DATE, actions };
}

function person(name: string, extra: Record<string, unknown> = {}) {
  return { name, pax: 1, ...extra } as never;
}

/** 334184: WRK -> TUX -> NCB -> TUX -> WRK. Both WRK and TUX appear twice. */
function run334184(): Assignment {
  return {
    number: "334184",
    start: `${DATE} 08:00`,
    end: `${DATE} 09:50`,
    importedAt: new Date().toISOString(),
    steps: [step("WRK"), step("TUX"), step("NCB"), step("TUX"), step("WRK")],
  };
}

/** 369736's shape: one step, two Drop-Offs, different doors, different people. */
function twoDoors(): Assignment {
  return {
    number: "369736",
    start: `${DATE} 21:30`,
    end: `${DATE} 23:00`,
    importedAt: new Date().toISOString(),
    steps: [
      step("WKL", [
        { verb: "Drop-Off", where: "A Front", entities: [person("Owens, Dana")] },
        { verb: "Drop-Off", where: "B Carport", entities: [person("Jonas, Ana")] },
      ]),
    ],
  };
}

test("a repeated step key is disambiguated by the sibling ordinal", () => {
  const a = run334184();
  const first = targetFor(a, 0);
  const last = targetFor(a, 4);
  assert.equal(first.step.key, `WRK|${DATE}`);
  assert.equal(last.step.key, `WRK|${DATE}`);
  assert.notEqual(first.step.nth, last.step.nth);
  assert.equal(first.step.sibs, 2);

  assert.equal(resolveTarget(a, first)!.step, a.steps[0]);
  assert.equal(resolveTarget(a, last)!.step, a.steps[4]);
});

test("a stop inserted mid-run leaves every target resolving correctly", () => {
  const a = run334184();
  const targets = a.steps.map((_, i) => targetFor(a, i));
  const originals = [...a.steps];

  // A fuel stop, which is what a re-send adding a stop actually looks like.
  a.steps.splice(2, 0, step("FUEL"));

  for (let i = 0; i < targets.length; i++) {
    const got = resolveTarget(a, targets[i]);
    assert.ok(got, `target ${i} orphaned when it should have resolved`);
    assert.equal(got.step, originals[i], `target ${i} bound to the wrong step`);
  }
});

test("an earlier sibling being removed ORPHANS rather than mis-targeting", () => {
  // The one that matters. Without the sibling-count guard, WRK#0 resolves to
  // the RETURN stop once the opening WRK is dropped -- a correction meant for
  // the departure silently landing on the arrival.
  const a = run334184();
  const openingWrk = targetFor(a, 0);
  const closingWrk = targetFor(a, 4);
  const untouched = targetFor(a, 2); // NCB, only occurrence

  a.steps.splice(0, 1); // dispatch drops the opening WRK

  assert.equal(resolveTarget(a, openingWrk), null, "must orphan, not bind");
  assert.equal(resolveTarget(a, closingWrk), null, "must orphan, not bind");
  // and the guard must not be trigger-happy: an unaffected step still binds
  assert.ok(resolveTarget(a, untouched));
});

test("two actions sharing a verb are told apart by their passengers", () => {
  const a = twoDoors();
  const front = targetFor(a, 0, 0);
  const carport = targetFor(a, 0, 1);

  assert.equal(resolveTarget(a, front)!.action, a.steps[0].actions[0]);
  assert.equal(resolveTarget(a, carport)!.action, a.steps[0].actions[1]);

  // Reordered by a re-print: an ordinal alone would send a door correction to
  // the wrong kerb. The passenger set does not move with position.
  a.steps[0].actions.reverse();
  assert.equal(resolveTarget(a, front)!.action.where, "A Front");
  assert.equal(resolveTarget(a, carport)!.action.where, "B Carport");
});

test("a name repeated within a step is still unambiguous inside its action", () => {
  // 350568 prints Diaz, Tess twice at EWR, and 366824 prints a party twice.
  const a: Assignment = {
    number: "350568",
    start: `${DATE} 06:45`,
    end: `${DATE} 09:15`,
    importedAt: new Date().toISOString(),
    steps: [
      step("EWR", [
        { verb: "Drop-Off", where: "Departure Terminal", entities: [person("Diaz, Tess")] },
        { verb: "Pickup", where: "Customs Exit", entities: [person("Diaz, Tess")] },
      ]),
    ],
  };
  const dropped = targetFor(a, 0, 0, 0);
  const collected = targetFor(a, 0, 1, 0);
  assert.equal(dropped.entity, collected.entity); // same person
  assert.notEqual(dropped.action!.verb, collected.action!.verb); // different work

  assert.equal(resolveTarget(a, dropped)!.action!.verb, "Drop-Off");
  assert.equal(resolveTarget(a, collected)!.action!.verb, "Pickup");
});

test("names are normalised, but never fuzzy-matched", () => {
  assert.equal(nameKey("Sandoval, Noor & Vera"), nameKey("sandoval,  Noor  &Vera"));
  // A party splitting must NOT match either half: that is how one person's
  // phone number would land on somebody else.
  assert.notEqual(nameKey("Sandoval, Noor & Vera"), nameKey("Sandoval, Noor"));
});

test("applying a patch fills a gap and reports it as the driver's", () => {
  const a = twoDoors();
  a.steps[0].actions[0].entities[0] = person("Owens, Dana", { flightNumber: null, tag: "A" });

  const patch: Patch = {
    id: "p1",
    target: targetFor(a, 0, 0, 0),
    field: "flightNumber",
    value: "QF3",
    was: null,
    at: new Date().toISOString(),
  };
  const { edits, orphaned } = applyPatches(a, [patch]);

  assert.equal(orphaned.length, 0);
  assert.equal(a.steps[0].actions[0].entities[0].flightNumber, "QF3");
  assert.equal(edits[0].contested, false);
  assert.equal(edits[0].documentValue, null);
});

test("a re-print that disagrees is flagged contested, and the driver still wins", () => {
  const a = twoDoors();
  a.steps[0].actions[0].entities[0] = person("Owens, Dana", { flightNumber: null });
  const patch: Patch = {
    id: "p1",
    target: targetFor(a, 0, 0, 0),
    field: "flightNumber",
    value: "QF3",
    was: null,                       // the sheet was blank when they fixed it
    at: new Date().toISOString(),
  };

  // Dispatch reprints, and this time it DID resolve the airline — differently.
  a.steps[0].actions[0].entities[0].flightNumber = "QF33" as never;

  const { edits } = applyPatches(a, [patch]);
  assert.equal(edits[0].contested, true, "a dispatch correction must be surfaced");
  assert.equal(edits[0].documentValue, "QF33");
  assert.equal(
    a.steps[0].actions[0].entities[0].flightNumber,
    "QF3",
    "the driver's value still displays while unresolved"
  );
});

test("dispatch catching up is reported as agreed, not silently dropped", () => {
  const a = twoDoors();
  a.steps[0].actions[0].entities[0] = person("Owens, Dana", { flightNumber: "QF3" });
  const patch: Patch = {
    id: "p1",
    target: targetFor(a, 0, 0, 0),
    field: "flightNumber",
    value: "QF3",
    was: null,
    at: new Date().toISOString(),
  };
  const { edits } = applyPatches(a, [patch]);
  assert.equal(edits[0].agreed, true);
  assert.equal(edits[0].contested, false);
});

test("an orphaned patch is kept and reported, never applied to a near miss", () => {
  const a = run334184();
  const target = targetFor(a, 0);
  a.steps.splice(0, 1);
  const patch: Patch = {
    id: "p1", target, field: "where", value: "A Front", was: null,
    at: new Date().toISOString(),
  };
  const { edits, orphaned } = applyPatches(a, [patch]);
  assert.equal(edits.length, 0);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].id, "p1");
});

test("a correction reaches every appearance of the same passenger", () => {
  // 356385: Best is picked up at WRK and dropped at JFK, blank at both.
  const a: Assignment = {
    number: "356385", start: `${DATE} 15:30`, end: `${DATE} 22:00`,
    importedAt: new Date().toISOString(),
    steps: [
      step("WRK", [{ verb: "Pickup", where: null, entities: [person("Best, Omar & Ivan", { flightNumber: null })] }]),
      step("JFK", [{ verb: "Drop-Off", where: "Departure Terminal", entities: [person("Best, Omar & Ivan", { flightNumber: null })] }]),
    ],
  };
  applyPatches(a, [{ id: "p1", target: targetFor(a, 0, 0, 0), field: "flightNumber",
                     value: "TP1234", was: null, at: new Date().toISOString() }]);
  assert.equal(a.steps[0].actions[0].entities[0].flightNumber, "TP1234");
  assert.equal(a.steps[1].actions[0].entities[0].flightNumber, "TP1234");
});

test("an appearance holding a DIFFERENT value is left alone", () => {
  // The same person on two different flights in one run: correcting one must
  // not overwrite the other.
  const a: Assignment = {
    number: "x", start: `${DATE} 06:00`, end: `${DATE} 22:00`,
    importedAt: new Date().toISOString(),
    steps: [
      step("EWR", [{ verb: "Pickup", where: null, entities: [person("Diaz, Tess", { flightNumber: null })] }]),
      step("JFK", [{ verb: "Drop-Off", where: null, entities: [person("Diaz, Tess", { flightNumber: "AA100" })] }]),
    ],
  };
  applyPatches(a, [{ id: "p1", target: targetFor(a, 0, 0, 0), field: "flightNumber",
                     value: "UA995", was: null, at: new Date().toISOString() }]);
  assert.equal(a.steps[0].actions[0].entities[0].flightNumber, "UA995");
  assert.equal(a.steps[1].actions[0].entities[0].flightNumber, "AA100");
});

/* ------------------------------------------------ queued edits (Phase 8) -- */

test("a queued edit made against an older copy is refused, not re-aimed", () => {
  // The driver corrected step 1 offline; dispatch re-sent the run, dropping the
  // opening WRK, before the phone found signal. Index 1 now names a different
  // stop, so the edit must come back to the driver rather than land there.
  const a: Assignment = {
    number: "x", start: `${DATE} 06:00`, end: `${DATE} 22:00`,
    importedAt: "2026-05-06T12:00:00.000Z", steps: [],
  };
  assert.deepEqual(admitPatch(a, [], "2026-05-06T09:00:00.000Z", "r1"), { kind: "stale" });
  assert.deepEqual(admitPatch(a, [], "2026-05-06T12:00:00.000Z", "r1"), { kind: "new" });
  // A client that sends no basis is a live tap on the current copy.
  assert.deepEqual(admitPatch(a, [], null, null), { kind: "new" });
});

test("a replayed edit returns the patch already written, even across a re-import", () => {
  const a: Assignment = {
    number: "x", start: `${DATE} 06:00`, end: `${DATE} 22:00`,
    importedAt: "2026-05-06T12:00:00.000Z", steps: [],
  };
  const written: Patch = { id: "p1", target: { step: { code: "WRK", date: DATE, ordinal: 0, siblings: 1 } } as Patch["target"],
    field: "phone", value: "555", was: null, at: "", ref: "r1" };
  const got = admitPatch(a, [written], "2026-05-06T09:00:00.000Z", "r1");
  assert.equal(got.kind, "duplicate");
  assert.equal(got.kind === "duplicate" && got.patch.id, "p1");
});

test("an edit written twice under one ref (a replay behind KV's list lag) applies once", () => {
  const a = twoDoors();
  const door = targetFor(a, 0, 0);
  const add = (id: string): Patch => ({
    id, kind: "addEntity", target: door, entity: { name: "Roe, Rick" }, at: id, ref: "r1",
  });
  const r = applyPatches(a, [add("p1"), add("p2")]);
  const names = a.steps[0].actions[0].entities.map((e) => e.name);
  assert.deepEqual(names, ["Owens, Dana", "Roe, Rick"]);
  assert.deepEqual(r.changes.map((c) => [c.patchId, c.ref]), [["p1", "r1"]]);
  assert.equal(r.orphaned.length, 0);

  // A field: the first copy is the edit.
  const b = twoDoors();
  const fix = (id: string, value: string): Patch => ({
    id, target: door, field: "where", value, was: "A Front", at: id, ref: "r2",
  });
  const r2 = applyPatches(b, [fix("p1", "A Side"), fix("p2", "A Side")]);
  assert.deepEqual(r2.edits.map((e) => [e.patchId, e.ref]), [["p1", "r2"]]);

  // Patches with no ref (written before refs existed) are never collapsed.
  const c = twoDoors();
  const bare = (id: string, value: string): Patch => ({ id, target: door, field: "where", value, at: id });
  assert.equal(applyPatches(c, [bare("p1", "X"), bare("p2", "Y")]).edits.length, 2);
  assert.equal(c.steps[0].actions[0].where, "Y");
});

/* A passenger picked up at JFK late, dropped at a door after midnight. */
function lateRun(): Assignment {
  return {
    number: "1", importedAt: "x",
    steps: [
      { code: "JFK", place: "JFK", date: "2026-09-01", etaDate: "2026-09-01", eta: "11:00 PM", etd: "11:50 PM",
        actions: [{ verb: "Pickup", where: null, entities: [{ name: "Doe, Jane", pax: 1, tag: "A", flightNumber: null, phone: null }] }] },
      { code: null, place: "Home", date: "2026-09-02", etaDate: "2026-09-02", eta: "12:40 AM", etd: "12:50 AM",
        actions: [{ verb: "Drop-Off", where: null, entities: [{ name: "Doe, Jane", pax: 1, tag: "A", flightNumber: null, phone: null }] }] },
    ],
  } as unknown as Assignment;
}

test("a second correction of the same field still names dispatch's value, uncontested", () => {
  const a = lateRun();
  const t = targetFor(a, 0);
  const r = applyPatches(a, [
    { id: "1", target: t, field: "eta", value: "11:10 PM", was: "11:00 PM", at: "t1" },
    { id: "2", target: t, field: "eta", value: "11:20 PM", was: "11:00 PM", at: "t2" },
  ]);
  assert.equal(r.edits[1].documentValue, "11:00 PM");
  assert.equal(r.edits[1].contested, false);
  const mark = (a.steps[0] as unknown as { _edit: Record<string, { documentValue: string; value: string }> })._edit.eta;
  assert.deepEqual([mark.documentValue, mark.value], ["11:00 PM", "11:20 PM"]);
});

test("a second phone fix reaches the other appearance, dispatch's blank kept as the sheet's", () => {
  const a = lateRun();
  const t = targetFor(a, 0, 0, 0);
  applyPatches(a, [
    { id: "1", target: t, field: "phone", value: "+1 555-0100-111", was: null, at: "t1" },
    { id: "2", target: t, field: "phone", value: "+1 555-0100-222", was: null, at: "t2" },
  ]);
  const drop = a.steps[1].actions[0].entities[0] as unknown as { phone: string; _edit: Record<string, { documentValue: unknown }> };
  assert.equal(drop.phone, "+1 555-0100-222");
  assert.equal(drop._edit.phone.documentValue, null);
});
