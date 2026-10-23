/**
 * The worker's routes, run in node against an in-memory KV.
 *
 * index.ts imports its siblings without an extension (wrangler's bundler
 * resolves them); node does not, so a resolve hook adds ".ts". The fake KV
 * counts every operation -- the free tier's 1,000 lists a day is the budget
 * these tests guard -- and can hide keys from list() the way KV's ~20s list
 * lag does.
 *
 *   node --test --experimental-strip-types src/routes.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// index.ts imports types without `import type`, which node's type stripping
// cannot elide, so the worker's sources are transpiled by the TypeScript the
// project already has -- the same erasure wrangler's bundler does.
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

const worker = (await import("./index.ts")).default;

/* ------------------------------------------------------------- fake KV -- */

interface Entry { value: string; metadata?: unknown }

class FakeKV {
  data = new Map<string, Entry>();
  /** Written, but not yet returned by list() -- KV's list lag. */
  lagging = new Set<string>();
  ops = { get: 0, put: 0, delete: 0, list: 0 };

  async get(key: string): Promise<string | null> {
    this.ops.get++;
    return this.data.get(key)?.value ?? null;
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void> {
    this.ops.put++;
    this.data.set(key, { value, metadata: opts?.metadata });
  }
  async delete(key: string): Promise<void> {
    this.ops.delete++;
    this.data.delete(key);
    this.lagging.delete(key);
  }
  async list(opts: { prefix?: string; cursor?: string }) {
    this.ops.list++;
    const prefix = opts.prefix ?? "";
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(prefix) && !this.lagging.has(k))
      .sort()
      .map((name) => ({ name, metadata: this.data.get(name)!.metadata }));
    return { keys, list_complete: true, cursor: undefined };
  }
  resetOps() { this.ops = { get: 0, put: 0, delete: 0, list: 0 }; }
  keys(prefix = "") { return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

function envWith(kv: FakeKV) {
  return { FLIGHT_DATA: kv, AERODATABOX_KEY: "test" } as never;
}

const BASE = "https://worker.test";

/** One request, exactly as given. */
async function bare(
  kv: FakeKV, method: string, path: string, body?: unknown, headers?: Record<string, string>, raw?: string,
) {
  const init: RequestInit = { method, headers };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const res = await worker.fetch(new Request(BASE + path, init), envWith(kv));
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/**
 * One request, the list named the way the app names it: in the X-List-Code
 * header, the only place the Worker reads a code from. A test names its list
 * in the body (`listCode`, as the app's own bodies still carry it) and it is
 * sent as that header too; `headers` wins. The tests about the header itself
 * use bare().
 */
function call(
  kv: FakeKV, method: string, path: string, body?: unknown, raw?: string, headers?: Record<string, string>,
) {
  const named = (body as { listCode?: unknown } | undefined)?.listCode;
  const code = typeof named === "string" ? { "X-List-Code": named } : {};
  return bare(kv, method, path, body, { ...code, ...headers }, raw);
}

const LIST = "abcd1234";

/** GET /api/assignments for a list. */
const listOf = (kv: FakeKV, code = LIST) => bare(kv, "GET", "/api/assignments", undefined, { "X-List-Code": code });

/** A list with one run on it: WRK -> LGA, one passenger on a flight. */
async function seeded(): Promise<FakeKV> {
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [] }));
  const res = await call(kv, "POST", "/api/assignments", seedRun());
  assert.equal(res.status, 200, JSON.stringify(res.data));
  kv.resetOps();
  return kv;
}

/** The seeded run as imported: printed 2026-08-30 17:00. */
function seedRun(): any {
  return {
    listCode: LIST,
    number: "369736",
    start: "2026-08-31 21:30",
    end: "2026-09-01 03:00",
    printedAt: "2026-08-30 17:00",
    steps: [
      { code: "WRK", place: "Warwick", eta: null, etd: "9:30 PM", date: "2026-08-31", etaDate: "2026-08-31", actions: [] },
      {
        code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM", date: "2026-09-01", etaDate: "2026-08-31",
        actions: [{ verb: "Pickup", where: "Claim", entities: [
          { name: "Owens, Ada", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: "2026-08-31" },
        ] }],
      },
    ],
  };
}

async function getRun(kv: FakeKV) {
  const res = await listOf(kv);
  assert.equal(res.status, 200);
  return res.data.assignments[0];
}

test("harness: a seeded list reads back with its run", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  assert.equal(run.number, "369736");
  assert.equal(kv.ops.list, 2);
});

/* ------------------------------------------------ fix 1: replayed patch -- */

test("a replay behind the list lag is written twice, read once, and undone whole", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  const add = {
    listCode: LIST, number: "369736", ref: "r-roe", kind: "addEntity", at: "1.0",
    entity: { name: "Roe, Rick" }, basis: run.importedAt,
  };
  const first = await call(kv, "POST", "/api/assignments/patches", add);
  assert.equal(first.status, 201);
  // The answer never reached the phone, and the list does not show it yet.
  for (const k of kv.keys("patch:")) kv.lagging.add(k);
  const second = await call(kv, "POST", "/api/assignments/patches", add);
  assert.equal(second.status, 201);
  assert.equal(kv.keys("patch:").length, 2);
  kv.lagging.clear();

  const after = await getRun(kv);
  const names = after.steps[1].actions[0].entities.map((e: any) => e.name);
  assert.deepEqual(names, ["Owens, Ada", "Roe, Rick"]);
  assert.equal(after.changes.length, 1);
  assert.equal(after.changes[0].ref, "r-roe");

  // Undo by the id the phone holds (the second) takes both copies, for one list.
  kv.resetOps();
  const del = await call(kv, "DELETE", "/api/assignments/patches",
    { listCode: LIST, number: "369736", id: second.data.patch.id });
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, 2);
  assert.equal(kv.keys("patch:").length, 0);
  assert.equal(kv.ops.list, 1);
});

test("deleting a patch the list does not show yet still works, by its key", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  const res = await call(kv, "POST", "/api/assignments/patches", {
    listCode: LIST, number: "369736", ref: "r-door", at: "1.0", field: "where", value: "Door 4",
    was: "Claim", basis: run.importedAt,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  for (const k of kv.keys("patch:")) kv.lagging.add(k);
  const del = await call(kv, "DELETE", "/api/assignments/patches",
    { listCode: LIST, number: "369736", id: res.data.patch.id });
  assert.equal(del.status, 200);
  assert.equal(kv.keys("patch:").length, 0);
  const none = await call(kv, "DELETE", "/api/assignments/patches",
    { listCode: LIST, number: "369736", id: res.data.patch.id });
  assert.equal(none.status, 404);
});

test("a correction writes the patch and the stamp: a flight the list already tracks is not written again", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  kv.resetOps();
  const door = await call(kv, "POST", "/api/assignments/patches", {
    listCode: LIST, number: "369736", ref: "r-door2", at: "1.0", field: "where", value: "Door 4",
    was: "Claim", basis: run.importedAt,
  });
  assert.equal(door.status, 201, JSON.stringify(door.data));
  assert.equal(door.data.flightsTracked, 1);
  assert.equal(kv.ops.put, 2, "the patch and the list's stamp");

  // A flight the correction brings in is tracked: its poll key, its trackers.
  kv.resetOps();
  const flight = await call(kv, "POST", "/api/assignments/patches", {
    listCode: LIST, number: "369736", ref: "r-fl", at: "1.0.0", field: "flightNumber", value: "UA999",
    was: "UA1503", basis: run.importedAt,
  });
  assert.equal(flight.status, 201, JSON.stringify(flight.data));
  assert.equal(kv.ops.put, 4);
  assert.ok(kv.data.has("poll:UA999:2026-08-31"));
  assert.deepEqual(JSON.parse((await kv.get("flight:UA999:2026-08-31:trackers"))!), [LIST]);

  // A flight no longer polled (landed long ago) is not put back by an edit.
  kv.data.delete("poll:UA999:2026-08-31");
  await call(kv, "POST", "/api/assignments/patches", {
    listCode: LIST, number: "369736", ref: "r-ph", at: "1.0.0", field: "phone", value: "+1 845 555 0100",
    was: null, basis: run.importedAt,
  });
  assert.equal(kv.data.has("poll:UA999:2026-08-31"), false);
});

/* ------------------------------------------- B1: unknown code costs a read -- */

test("every list-code route turns an unknown code away before any list() or write", async () => {
  const kv = await seeded();
  const nobody = "00000000";
  const probes: [string, string, unknown?][] = [
    ["GET", "/api/assignments"],
    ["DELETE", "/api/assignments", { number: "369736" }],
    ["POST", "/api/assignments", { number: "1", start: "2026-09-01 08:00", end: "2026-09-01 09:00", steps: [] }],
    ["POST", "/api/assignments/patches", { number: "369736", at: "1", field: "eta", value: "11:10 PM" }],
    ["DELETE", "/api/assignments/patches", { number: "369736", id: "x" }],
    ["PUT", "/api/settings", { retentionDays: 14 }],
    ["POST", "/api/assignments/seen", { number: "369736", printedAt: "2026-08-30 17:00" }],
  ];
  for (const [method, path, body] of probes) {
    kv.resetOps();
    const res = await bare(kv, method, path, body, { "X-List-Code": nobody });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.match(res.data.error, /Unknown listCode/, `${method} ${path}`);
    assert.deepEqual(kv.ops, { get: 1, put: 0, delete: 0, list: 0 }, `${method} ${path}`);
  }
});

test("a list code is checked before it names a key: text of a code's shape, or no KV call at all", async () => {
  const kv = await seeded();
  // On a route that reads, one that writes a record and one that deletes.
  const bad = [`${LIST}:369736`, "ab cd1234", "../list", "abc", "x".repeat(65), "x".repeat(600), "a/b"];
  for (const code of bad) {
    const h = { "X-List-Code": code };
    for (const res of [
      await bare(kv, "GET", "/api/assignments", undefined, h),
      await bare(kv, "PUT", "/api/settings", { retentionDays: 14 }, h),
      await bare(kv, "DELETE", "/api/assignments", { number: "369736" }, h),
    ]) {
      assert.equal(res.status, 400, code.slice(0, 20));
      assert.match(res.data.error, /not a list code/);
    }
  }
  assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  assert.ok(kv.data.has(`assign:${LIST}:369736`), "the run is still there");

  // No code at all is still "required", and a real one still works.
  assert.match((await bare(kv, "PUT", "/api/settings", { retentionDays: 14 })).data.error, /listCode is required/);
  assert.equal((await bare(kv, "PUT", "/api/settings", { retentionDays: 14 }, { "X-List-Code": LIST })).status, 200);
});

/* ---------------------------------------------- B2: caps on what is stored -- */

function runBody(over: Record<string, unknown> = {}) {
  return {
    listCode: LIST, number: "400001", start: "2026-09-01 08:00", end: "2026-09-01 12:00",
    steps: [{ code: "EWR", place: "Newark", eta: "9:00 AM", etd: "9:30 AM", date: "2026-09-01", etaDate: "2026-09-01",
      actions: [{ verb: "Pickup", where: "C", entities: [
        { name: "Diaz, Ana", pax: 1, tag: "A", flightNumber: "UA995", flightDate: "2026-09-01" }] }] }],
    ...over,
  };
}

test("import: a real-shaped run is stored; oversized or malformed ones are refused before any KV op", async () => {
  const kv = await seeded();
  assert.equal((await call(kv, "POST", "/api/assignments", runBody())).status, 200);

  const step = runBody().steps[0];
  const entity = step.actions[0].entities[0];
  const withEntity = (e: Record<string, unknown>) =>
    runBody({ steps: [{ ...step, actions: [{ ...step.actions[0], entities: [{ ...entity, ...e }] }] }] });
  const cases: [unknown, number, RegExp, string?][] = [
    [runBody({ pad: "x".repeat(300 * 1024) }), 413, /too large/],
    [runBody({ steps: Array.from({ length: 61 }, () => step) }), 413, /too many steps/],
    [runBody({ steps: [{ ...step, actions: [{ ...step.actions[0],
      entities: Array.from({ length: 61 }, (_, i) => ({ ...entity, name: `P ${i}` })) }] }] }), 413, /too many passengers/],
    [runBody({ driverNotes: "n".repeat(10_001) }), 413, /driverNotes is too long/],
    [withEntity({ note: "n".repeat(501) }), 413, /note is too long/],
    [runBody({ steps: [{ ...step, date: "01/09/2026" }] }), 400, /date must look like/],
    [runBody({ start: "tomorrow" }), 400, /start must look like/],
    [runBody({ number: "1:x" }), 400, /number must be/],
    [undefined, 400, /malformed JSON/, "{not json"],
  ];
  for (const [body, status, message, raw] of cases) {
    kv.resetOps();
    const res = await call(kv, "POST", "/api/assignments", body, raw);
    assert.equal(res.status, status, String(message));
    assert.match(res.data.error, message);
    assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 }, String(message));
  }
});

test("import: a run's fields have their types, so no phone is handed markup where a count belongs", async () => {
  const kv = await seeded();
  const step = runBody().steps[0];
  const action = step.actions[0];
  const entity = action.entities[0];
  const withEntity = (e: Record<string, unknown>) =>
    runBody({ steps: [{ ...step, actions: [{ ...action, entities: [{ ...entity, ...e }] }] }] });
  const cases: [unknown, RegExp][] = [
    // The list card prints the passenger count as it is (security review, 2026-10-04).
    [withEntity({ pax: "<img src=x onerror=alert(1)>" }), /pax must be a number/],
    [withEntity({ pax: -1 }), /pax must be a number/],
    [withEntity({ bags: "2" }), /bags must be a number/],
    [withEntity({ gb: "yes" }), /gb must be true or false/],
    [withEntity({ name: { first: "Ana" } }), /name must be text/],
    [withEntity({ name: null }), /name must be text/],
    [withEntity({ phone: 8455550142 }), /phone must be text/],
    [withEntity({ otherPhones: ["+1 845 555 0142", 7] }), /otherPhones must be a list of text/],
    [withEntity({ unknownAirline: "WestJet" }), /unknownAirline must be an airline's name and number/],
    [withEntity({ unknownAirline: { name: "WestJet", number: 1680 } }), /unknownAirline must be an airline's name and number/],
    [runBody({ vehicle: 5 }), /vehicle must be text/],
    [runBody({ gb: 1 }), /gb must be true or false/],
    [runBody({ issues: ["one", {}] }), /issues must be a list of text/],
    [runBody({ assistants: [{ name: ["x"] }] }), /assistants\[0\]\.name must be text/],
    [runBody({ assistants: "Ana" }), /assistants must be a list/],
    [runBody({ steps: [{ ...step, place: 7 }] }), /place must be text/],
    [runBody({ steps: [{ ...step, actions: [{ ...action, verb: true }] }] }), /verb must be text/],
  ];
  for (const [body, message] of cases) {
    kv.resetOps();
    const res = await call(kv, "POST", "/api/assignments", body);
    assert.equal(res.status, 400, String(message));
    assert.match(res.data.error, message);
    assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 }, String(message));
  }

  // What the importer sends: nothing where the sheet printed nothing.
  const real = withEntity({
    pax: 3, bags: 0, gb: true, phone: null, note: null, origin: "EWR Newark", destination: null,
    otherPhones: ["+1 845 555 0142"], unknownAirline: { name: "WestJet", number: "1680", date: "2026-09-01" },
  });
  Object.assign(real, { driver: null, vehicle: "Toyota Sienna (40123)", parking: null, driverNotes: null, gb: true,
    issues: [], assistants: [{ name: "Reyes, Sol", role: null }], source: "sheet.pdf", printedAt: "2026-08-31 17:00" });
  assert.equal((await call(kv, "POST", "/api/assignments", real)).status, 200);
});

test("import: a copy printed in the future is refused, so no forged print outranks dispatch's next one", async () => {
  const kv = await seeded();
  const wall = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  for (const [printedAt, message] of [
    ["yesterday", /printedAt must look like/],
    ["2099-01-01 08:00", /printed in the future/],
    [wall(Date.now() + 3 * 86400e3), /printed in the future/],
  ] as [string, RegExp][]) {
    kv.resetOps();
    const res = await call(kv, "POST", "/api/assignments", runBody({ printedAt }));
    assert.equal(res.status, 400, printedAt);
    assert.match(res.data.error, message);
    assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  }
  // Printed just now, by a clock a little ahead of ours, or with no footer at all.
  assert.equal((await call(kv, "POST", "/api/assignments", runBody({ printedAt: wall(Date.now()) }))).status, 200);
  assert.equal((await call(kv, "POST", "/api/assignments", runBody({ number: "400002", printedAt: null }))).status, 200);
});

test("import: a malformed flight is kept on the sheet but never tracked", async () => {
  const kv = await withVictim();
  const step = runBody().steps[0];
  const odd = (number: string, e: Record<string, unknown>) => runBody({ listCode: "evil0001", number,
    steps: [{ ...step, actions: [{ ...step.actions[0], entities: [{ ...step.actions[0].entities[0], ...e }] }] }] });
  const cases: [string, Record<string, unknown>][] = [
    ["400011", { flightNumber: "Q4-114/2" }],
    ["400012", { flightNumber: "DL114", flightDate: "2026-10-01:trackers" }],
  ];
  for (const [number, e] of cases) {
    const res = await call(kv, "POST", "/api/assignments", odd(number, e));
    assert.equal(res.status, 200, JSON.stringify(e));
    const stored = JSON.parse((await kv.get(`assign:evil0001:${number}`))!);
    assert.equal(stored.steps[0].actions[0].entities[0].flightNumber, e.flightNumber);
  }
  assert.deepEqual(JSON.parse((await kv.get(VICTIM_TRACKERS))!), ["victim01"]);
  assert.deepEqual([...kv.data.keys()].filter((k) => k.includes("Q4-114") || k.includes("trackers:")), []);
});

test("patches: values are trimmed and cut to length, flight numbers checked, stops stored field by field", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  const post = (b: Record<string, unknown>) =>
    call(kv, "POST", "/api/assignments/patches", { listCode: LIST, number: "369736", basis: run.importedAt, ...b });

  const flight = await post({ at: "1.0.0", field: "flightNumber", value: " ua 995 " });
  assert.equal(flight.status, 201);
  assert.equal(flight.data.patch.value, "UA995");
  const bad = await post({ at: "1.0.0", field: "flightNumber", value: "UA995:2026-09-01:trackers" });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /flight number looks like UA995/);

  const note = await post({ at: "1.0.0", field: "note", value: `  ${"n".repeat(2000)}  `, by: "b".repeat(200) });
  assert.equal(note.data.patch.value.length, 500);
  assert.equal(note.data.patch.by.length, 40);

  const stop = await post({ kind: "addStep", step: {
    place: "Newark", code: "EWR", date: "2026-09-01", time: "1:30 AM", verb: "Pickup", junk: "x".repeat(900),
  } });
  assert.equal(stop.status, 201);
  assert.deepEqual(Object.keys(stop.data.patch.step).sort(), ["code", "date", "place", "sibs", "time", "verb", "where"]);

  const passenger = await post({ kind: "addEntity", at: "1.0", entity: { name: "Roe, Rick", flightNumber: "not a flight" } });
  assert.equal(passenger.status, 400);
  assert.equal((await post({ kind: "teleport", at: "1" })).status, 400);
  assert.equal((await post({ at: "1", field: "eta", value: 1110 })).status, 400);
  assert.equal((await post({ at: "1", field: "eta", value: "11:10 PM", ref: "a b<c>" })).status, 400);
  const huge = await post({ at: "1", field: "note", value: "n".repeat(9000) });
  assert.equal(huge.status, 413);
});

/* --------------------------------------- B3: flight refs name KV keys safely -- */

const VICTIM_TRACKERS = "flight:DL114:2026-10-01:trackers";

async function withVictim(): Promise<FakeKV> {
  const kv = await seeded();
  await kv.put("list:evil0001", JSON.stringify({ flights: [] }));
  await kv.put(VICTIM_TRACKERS, JSON.stringify(["victim01"]));
  kv.resetOps();
  return kv;
}

test("the old flat list's routes are gone: each answers 404 without a KV call, and PATCH is no method here", async () => {
  // /api/flights (GET, POST, PATCH, DELETE) and /api/history served the retired
  // flight UI; nothing has called them since. A flight is tracked by a run now.
  const kv = await withVictim();
  const h = { "X-List-Code": "evil0001" };
  const probes: [string, string, unknown?][] = [
    ["GET", "/api/flights"],
    ["POST", "/api/flights", { flightNumber: "DL114", date: "2026-10-01" }],
    ["POST", "/api/flights", { flightNumber: "DL114", date: "2026-10-01:trackers" }],
    ["POST", "/api/flights", { kind: "appointment", targetTime: "2026-09-01 10:00", place: "Clinic" }],
    ["PATCH", "/api/flights", { id: "DL114:2026-10-01", note: "gate B" }],
    ["DELETE", "/api/flights", { id: "DL114:2026-10-01:trackers" }],
    ["GET", "/api/history?flightNumber=DL114&date=2026-10-01"],
  ];
  for (const [method, path, body] of probes) {
    const res = await call(kv, method, path, body, undefined, h);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.data.error, "Not found", `${method} ${path}`);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  }
  assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  assert.deepEqual(kv.keys("poll:"), ["poll:UA1503:2026-08-31"], "nothing new is tracked");
  assert.deepEqual(JSON.parse((await kv.get(VICTIM_TRACKERS))!), ["victim01"]);
  const allowed = (await call(kv, "OPTIONS", "/api/assignments")).headers.get("Access-Control-Allow-Methods");
  assert.equal(allowed, "GET, POST, PUT, DELETE, OPTIONS");
});

test("a job an old list still holds is left where it is: read past, kept by every save", async () => {
  const kv = await seeded();
  const job = { flightNumber: "DL114", date: "2026-10-01", passenger: "Diaz, Ana", driveMinutes: 75 };
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [job], topic: "curbside-test" }));
  const got = await call(kv, "GET", "/api/assignments", undefined, undefined, { "X-List-Code": LIST });
  assert.equal(got.status, 200);
  assert.equal(got.data.assignments.length, 1);
  assert.ok(!JSON.stringify(got.data).includes("Diaz"), "and never served");
  assert.equal((await call(kv, "PUT", "/api/settings", { retentionDays: 14 }, undefined, { "X-List-Code": LIST })).status, 200);
  assert.deepEqual(JSON.parse((await kv.get(`list:${LIST}`))!).flights, [job]);
});

test("assignments: a stored run with a malformed flight never tracks or untracks it", async () => {
  const kv = await withVictim();
  await kv.put("assign:evil0001:400002", JSON.stringify({
    number: "400002", start: "2026-10-01 08:00", end: "2026-10-01 12:00",
    steps: [{ code: "JFK", place: "JFK", date: "2026-10-01", actions: [{ verb: "Pickup", entities: [
      { name: "X", pax: 1, flightNumber: "DL114", flightDate: "2026-10-01:trackers" }] }] }],
  }));
  const { flightsOf } = await import("./assignment.ts");
  assert.deepEqual(flightsOf(JSON.parse((await kv.get("assign:evil0001:400002"))!)), []);
  const del = await call(kv, "DELETE", "/api/assignments", { listCode: "evil0001", number: "400002" });
  assert.equal(del.status, 200);
  assert.deepEqual(JSON.parse((await kv.get(VICTIM_TRACKERS))!), ["victim01"]);
});

test("removing a run keeps a flight another run on the list still meets; two lists in all", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  // A second run meeting the same UA1503, and a correction on the first.
  const twin = { ...run, number: "369737", listCode: LIST };
  delete (twin as Record<string, unknown>).edits;
  assert.equal((await call(kv, "POST", "/api/assignments", twin)).status, 200);
  const note = await call(kv, "POST", "/api/assignments/patches",
    { listCode: LIST, number: "369736", basis: run.importedAt, at: "1.0.0", field: "note", value: "gate B" });
  assert.equal(note.status, 201);
  const trackers = "flight:UA1503:2026-08-31:trackers";
  assert.deepEqual(JSON.parse((await kv.get(trackers))!), [LIST]);

  kv.resetOps();
  const del = await call(kv, "DELETE", "/api/assignments", { listCode: LIST, number: "369736" });
  assert.equal(del.status, 200);
  assert.equal(kv.ops.list, 2);
  assert.deepEqual(JSON.parse((await kv.get(trackers))!), [LIST], "the twin still meets UA1503");
  assert.deepEqual([...kv.data.keys()].filter((k) => k.startsWith(`patch:${LIST}:369736:`)), []);

  const last = await call(kv, "DELETE", "/api/assignments", { listCode: LIST, number: "369737" });
  assert.equal(last.status, 200);
  assert.equal(await kv.get(trackers), null, "nobody meets it now");
});

test("the list code is read from its header and nowhere else: in the URL or the body it names nothing", async () => {
  const kv = await seeded();
  // A second list, its code all digits: a body once sent the same digits as a JSON number.
  await kv.put("list:12345678", JSON.stringify({ flights: [] }));
  const h = { "X-List-Code": LIST };
  const get = await bare(kv, "GET", "/api/assignments", undefined, h);
  assert.equal(get.status, 200);
  assert.equal(get.data.assignments.length, 1);
  assert.match(get.headers.get("Access-Control-Allow-Headers")!, /X-List-Code/);
  const run = get.data.assignments[0];

  // A URL lands in browser history and in every log on the way (review B5):
  // a code there is not read, real or not.
  kv.resetOps();
  for (const path of ["/api/assignments", "/api/stamp", "/api/travel-times"]) {
    for (const code of [LIST, "00000000", "a:b"]) {
      const res = await bare(kv, "GET", `${path}?listCode=${encodeURIComponent(code)}`);
      assert.equal(res.status, 400, `${path} ${code}`);
      assert.match(res.data.error, /listCode is required/, `${path} ${code}`);
    }
  }
  // Nor a body's, whatever it holds: a list's code, another's, or not text at all.
  for (const code of [LIST, "12345678", 12345678, { $ne: "" }, [LIST], true, "a:b"]) {
    for (const res of [
      await bare(kv, "PUT", "/api/settings", { listCode: code, retentionDays: 14 }),
      await bare(kv, "DELETE", "/api/assignments", { listCode: code, number: "369736" }),
      await bare(kv, "POST", "/api/assignments/patches",
        { listCode: code, number: "369736", basis: run.importedAt, at: "1.0.0", field: "note", value: "gate B" }),
    ]) {
      assert.equal(res.status, 400, JSON.stringify(code));
      assert.match(res.data.error, /^listCode( and number)? (is|are) required$/, JSON.stringify(code));
    }
  }
  assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 }, "and none of it read a key");
  assert.ok(kv.data.has(`assign:${LIST}:369736`), "the run is still there");

  // The header names the list, over a body that names another.
  const post = await bare(kv, "POST", "/api/assignments/patches",
    { number: "369736", basis: run.importedAt, at: "1.0.0", field: "note", value: "gate B" }, h);
  assert.equal(post.status, 201);
  const other = await bare(kv, "PUT", "/api/settings", { listCode: "12345678", retentionDays: 14 }, h);
  assert.equal(other.status, 200);
  assert.equal(JSON.parse((await kv.get(`list:${LIST}`))!).settings.retentionDays, 14);
  assert.equal(JSON.parse((await kv.get("list:12345678"))!).settings, undefined, "nothing was written to the other");
  assert.equal((await bare(kv, "OPTIONS", "/api/assignments")).headers.get("Access-Control-Max-Age"), "86400");
});

test("the ntfy topic is its own secret: given at register, or once to an older list", async () => {
  const kv = new FakeKV();
  const reg = await call(kv, "POST", "/api/register");
  assert.equal(reg.status, 200);
  assert.match(reg.data.ntfyTopic, /^curbside-[0-9a-f]{24}$/);
  assert.ok(!reg.data.ntfyTopic.includes(reg.data.listCode));
  assert.equal(JSON.parse((await kv.get(`list:${reg.data.listCode}`))!).topic, reg.data.ntfyTopic);

  const old = await seeded(); // a list stored before topics: { flights: [] }
  const first = await listOf(old);
  assert.match(first.data.ntfyTopic, /^curbside-[0-9a-f]{24}$/);
  assert.equal(old.ops.put, 1);
  old.resetOps();
  const again = await listOf(old);
  assert.equal(again.data.ntfyTopic, first.data.ntfyTopic);
  assert.equal(old.ops.put, 0);
});

test("aerodatabox: the date is encoded into the URL, never a path", async () => {
  const { fetchFlightStatus } = await import("./aerodatabox.ts");
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => { seen.push(String(u)); return new Response("", { status: 404 }); }) as never;
  try {
    await fetchFlightStatus("k", { flightNumber: "UA995", date: "../../airports/x" });
  } finally {
    globalThis.fetch = real;
  }
  assert.match(seen[0], /\/flights\/number\/UA995\/\.\.%2F\.\.%2Fairports%2Fx$/);
});

/* ------------------------------- B6 settings and jobs, B8 malformed bodies -- */

test("a malformed body is a 400 with CORS headers on every route, never a bare 500", async () => {
  const kv = await seeded();
  const routes: [string, string][] = [
    ["PUT", "/api/settings"], ["POST", "/api/assignments"], ["DELETE", "/api/assignments"],
    ["POST", "/api/assignments/patches"],
    ["DELETE", "/api/assignments/patches"], ["POST", "/api/places"], ["POST", "/api/airlines"],
  ];
  for (const [method, path] of routes) {
    for (const raw of ["{oops", "[1]", "null", ""]) {
      const res = await call(kv, method, path, undefined, raw);
      assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(raw)}`);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    }
  }
});

test("an unexpected failure answers 500 with CORS headers", async () => {
  const kv = await seeded();
  kv.get = async () => { throw new Error("KV down"); };
  const errors: unknown[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const res = await listOf(kv);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.data.error, "internal error");
  } finally {
    console.error = real;
  }
  assert.equal(errors.length, 1);
});

test("settings: each field is type- and range-checked; the app's own saves pass", async () => {
  const kv = await seeded();
  const put = (b: Record<string, unknown>) => call(kv, "PUT", "/api/settings", { listCode: LIST, ...b });
  for (const bad of [
    { checkInLeadMinutes: "20" }, { checkInLeadMinutes: -5 }, { checkInLeadIntlMinutes: 1e9 }, { checkInLeadMinutes: null },
    { showPassengerNames: "yes" }, { retentionDays: "7" },
  ]) {
    kv.resetOps();
    const res = await put(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(kv.ops.put, 0);
  }
  const ok = await put({ checkInLeadMinutes: 100, retentionDays: 14 });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.settings.checkInLeadMinutes, ok.data.settings.retentionDays], [100, 14]);
});

test("corrections cannot take a run past 12 flights: the 13th is refused, a swap, a door and a walk-up are not (v69)", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  const post = (ref: string, body: Record<string, unknown>) => call(kv, "POST", "/api/assignments/patches",
    { listCode: LIST, number: "369736", ref, basis: run.importedAt, ...body });
  const add = (i: number) => post(`cap-${i}`, { kind: "addEntity", at: "1.0", entity: { name: `P ${i}`, flightNumber: `DL${200 + i}`, tag: "A" } });
  for (let i = 1; i <= 11; i++) assert.equal((await add(i)).status, 201, `flight ${i + 1}`);

  kv.resetOps();
  const over = await add(12);
  assert.equal(over.status, 413, JSON.stringify(over.data));
  assert.match(over.data.error, /12 flights/);
  assert.deepEqual([kv.ops.put, kv.ops.delete], [0, 0], "nothing is written");
  assert.equal(await kv.get("poll:DL212:2026-08-31"), null);

  // Twelve still: one flight for another, a door, a passenger who has none.
  assert.equal((await post("cap-swap", { at: "1.0.0", field: "flightNumber", value: "UA999", was: "UA1503" })).status, 201);
  assert.equal((await post("cap-door", { at: "1.0", field: "where", value: "Door 4", was: "Claim" })).status, 201);
  assert.equal((await post("cap-walk", { kind: "addEntity", at: "1.0", entity: { name: "P walk" } })).status, 201);
});

test("undoing a not-coming or a flight fix tracks the flight again if it was let go; any other undo costs what it did (v69)", async () => {
  const kv = await seeded();
  const run = await getRun(kv);
  const post = (ref: string, body: Record<string, unknown>) => call(kv, "POST", "/api/assignments/patches",
    { listCode: LIST, number: "369736", ref, basis: run.importedAt, ...body });
  const undo = (id: string) => call(kv, "DELETE", "/api/assignments/patches", { listCode: LIST, number: "369736", id });
  const poll = "poll:UA1503:2026-08-31", trackers = "flight:UA1503:2026-08-31:trackers";
  // What cron does once nobody has met a flight through its last check (cron.test.ts).
  const letGo = async () => { await kv.delete(poll); await kv.delete(trackers); };

  const rm = await post("u-rm", { kind: "remove", at: "1.0.0", label: "Owens, Ada" });
  assert.equal(rm.status, 201, JSON.stringify(rm.data));
  await letGo();
  assert.equal((await undo(rm.data.patch.id)).status, 200);
  assert.ok(kv.data.has(poll), "polled again");
  assert.deepEqual(JSON.parse((await kv.get(trackers))!), [LIST]);

  const fix = await post("u-fix", { at: "1.0.0", field: "flightNumber", value: "UA999", was: "UA1503" });
  assert.equal(fix.status, 201, JSON.stringify(fix.data));
  await letGo();
  assert.equal((await undo(fix.data.patch.id)).status, 200);
  assert.ok(kv.data.has(poll), "dispatch's flight is the passenger's again, and polled");
  assert.deepEqual(JSON.parse((await kv.get(trackers))!), [LIST]);

  // A door brings no flight back: the list, its corrections, the delete, the stamp.
  const door = await post("u-door", { at: "1.0", field: "where", value: "Door 4", was: "Claim" });
  kv.resetOps();
  assert.equal((await undo(door.data.patch.id)).status, 200);
  assert.deepEqual(kv.ops, { get: 1, put: 1, delete: 1, list: 1 });
});

test("settings: the buffer and the drive times nothing reads are gone; a list that stored them still loads (v69)", async () => {
  const kv = await seeded();
  // As a list saved before v69 holds them.
  const old = JSON.parse((await kv.get(`list:${LIST}`))!);
  old.settings = { driveMinutes: { JFK: 75 }, bufferMinutes: 20, checkInLeadMinutes: 100, showPassengerNames: true,
    checkInLeadIntlMinutes: 180, retentionDays: 14, places: [{ code: "SGA", name: "", address: "3 Sample Terrace" }], airlines: [] };
  await kv.put(`list:${LIST}`, JSON.stringify(old));

  const got = await listOf(kv);
  assert.equal(got.status, 200);
  assert.ok(!("bufferMinutes" in got.data.settings) && !("driveMinutes" in got.data.settings), "not served");
  assert.deepEqual([got.data.settings.checkInLeadMinutes, got.data.settings.retentionDays, got.data.settings.places.length],
    [100, 14, 1], "what the list chose is kept");

  // An older phone may still send them: ignored, never refused, never stored.
  const put = await call(kv, "PUT", "/api/settings", { listCode: LIST, bufferMinutes: "20", driveMinutes: [75], retentionDays: 30 });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const stored = JSON.parse((await kv.get(`list:${LIST}`))!).settings;
  assert.deepEqual(Object.keys(stored).sort(),
    ["airlines", "checkInLeadIntlMinutes", "checkInLeadMinutes", "places", "retentionDays", "showPassengerNames"]);
  assert.deepEqual([stored.retentionDays, stored.checkInLeadMinutes, stored.places.length], [30, 100, 1]);
});

test("places: one per call, by code, 1 get + 1 write; checked; kept by a settings save; in GET", async () => {
  const kv = await seeded();
  const post = (b: Record<string, unknown>) => call(kv, "POST", "/api/places", { listCode: LIST, ...b });
  for (const bad of [
    { code: "sga", address: "1 Main St" }, { code: "S", address: "1 Main St" }, { code: 5, address: "x" },
    { code: "SGA" }, { code: "SGA", address: "  " }, { code: "SGA", address: "x", name: 7 },
    { code: "SGA", remove: "yes" },
  ]) {
    kv.resetOps();
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal(kv.ops.put, 0);
  }
  assert.equal((await post({ code: "SGA", address: "x".repeat(201) })).status, 413);
  kv.resetOps();
  const a = await post({ code: "SGA", name: "Stonegate", address: "1 Sample Terrace" });
  assert.equal(a.status, 200);
  assert.deepEqual(kv.ops, { get: 1, put: 2, delete: 0, list: 0 }); // the list and its stamp
  await post({ code: "CLN", name: "", address: "2 Sample Loop" });
  const b = await post({ code: "SGA", name: "Stonegate Apartments", address: "3 Sample Terrace" });
  assert.deepEqual(b.data.places, [
    { code: "CLN", name: "", address: "2 Sample Loop" },
    { code: "SGA", name: "Stonegate Apartments", address: "3 Sample Terrace" },
  ]);
  await call(kv, "PUT", "/api/settings", { listCode: LIST, retentionDays: 14 });
  const got = await listOf(kv);
  assert.equal(got.data.settings.places.length, 2);
  const c = await post({ code: "CLN", remove: true });
  assert.deepEqual(c.data.places.map((p: any) => p.code), ["SGA"]);
  assert.equal((await call(kv, "POST", "/api/places", { listCode: "00000000", code: "SGA", address: "x" })).status, 404);
});

test("airlines: the list learns one by name; its runs' flights fill in on read, marked, tracked; the stored run stays dispatch's", async () => {
  const kv = await seeded();
  const post = (b: Record<string, unknown>) => call(kv, "POST", "/api/airlines", { listCode: LIST, ...b });
  for (const bad of [
    { code: "WS" }, { name: "  ", code: "WS" }, { name: "WestJet", code: "ws" }, { name: "WestJet", code: "W" },
    { name: "WestJet", code: "12" }, { name: "WestJet" }, { name: "x".repeat(61), code: "WS" },
    { name: "WestJet", remove: "yes" },
  ]) {
    kv.resetOps();
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal(kv.ops.put, 0);
  }
  // A second run, with a WestJet row the importer could not name.
  const run = seedRun();
  run.number = "369737";
  run.steps[1].actions[0].entities.push({ name: "Moss, Ida", pax: 1, tag: "A", flightNumber: null,
    unknownAirline: { name: "WestJet", number: "1680", date: "2026-08-31" } });
  assert.equal((await call(kv, "POST", "/api/assignments", run)).status, 200);
  const tracked = () => [...kv.data.keys()].filter((k) => k.includes("WS1680"));
  assert.deepEqual(tracked(), []);

  const learned = await post({ name: "  WestJet ", code: "WS" });
  assert.equal(learned.status, 200);
  assert.deepEqual(learned.data.airlines, [{ name: "WestJet", code: "WS" }]);
  assert.equal(learned.data.tracked, 2); // that run's flights: UA1503 and the learned WS1680
  assert.ok(tracked().length > 0, "the learned flight is tracked");
  const got = await listOf(kv);
  const moss = got.data.assignments.find((a: any) => a.number === "369737").steps[1].actions[0].entities[1];
  assert.equal(moss.flightNumber, "WS1680");
  assert.equal(moss.flightDate, "2026-08-31");
  assert.deepEqual(moss._learned, { name: "WestJet", code: "WS" });
  assert.deepEqual(got.data.settings.airlines, [{ name: "WestJet", code: "WS" }]);
  const stored = JSON.parse((await kv.get(`assign:${LIST}:369737`))!);
  assert.equal(stored.steps[1].actions[0].entities[1].flightNumber, null);
  // Same name, other spacing and case: one entry, replaced. A settings save keeps it.
  assert.deepEqual((await post({ name: "westjet", code: "WS" })).data.airlines, [{ name: "westjet", code: "WS" }]);
  await call(kv, "PUT", "/api/settings", { listCode: LIST, retentionDays: 14 });
  assert.equal((await listOf(kv)).data.settings.airlines.length, 1);
  // A new sheet naming it is tracked on import.
  const next = seedRun();
  next.number = "369738";
  next.steps[1].actions[0].entities = [{ name: "Moss, Ida", pax: 1, tag: "A", flightNumber: null,
    unknownAirline: { name: "WestJet", number: "22", date: "2026-08-31" } }];
  assert.equal((await call(kv, "POST", "/api/assignments", next)).data.flightsTracked, 1);
  // Forgotten: the row is dispatch's again.
  assert.deepEqual((await post({ name: "WestJet", remove: true })).data.airlines, []);
  const after = await listOf(kv);
  assert.equal(after.data.assignments.find((a: any) => a.number === "369737").steps[1].actions[0].entities[1].flightNumber, null);
  assert.equal((await call(kv, "POST", "/api/airlines", { listCode: "00000000", name: "WestJet", code: "WS" })).status, 404);
});

test("register: no body or a small object is fine; junk and bulk are refused; a loop is slowed", async () => {
  const kv = new FakeKV();
  const reg = (raw: string | undefined, ip: string) =>
    worker.fetch(new Request(`${BASE}/api/register`, {
      method: "POST", body: raw, headers: { "CF-Connecting-IP": ip },
    }), envWith(kv));
  assert.equal((await reg(undefined, "198.51.100.1")).status, 200);
  assert.equal((await reg("{}", "198.51.100.1")).status, 200);
  assert.equal((await reg("not json", "198.51.100.1")).status, 400);
  assert.equal((await reg("[1,2]", "198.51.100.1")).status, 400);
  assert.equal((await reg(JSON.stringify({ pad: "x".repeat(2000) }), "198.51.100.1")).status, 413);
  kv.resetOps();
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await reg(undefined, "198.51.100.2")).status);
  assert.deepEqual(statuses.filter((s) => s === 429).length, 2);
  assert.equal(kv.ops.put, 20, "each new list is its record and the day's count");
});

/* -------------------------------------------------------- rate limits -- */

/** A stand-in for a Workers rate-limit binding: answers `ok`, remembers keys. */
function limiter(ok: boolean | "throw") {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }: { key: string }) {
      keys.push(key);
      if (ok === "throw") throw new Error("binding down");
      return { success: ok };
    },
  };
}

async function limited(kv: FakeKV, limits: object, method: string, path: string, headers: Record<string, string> = {}) {
  const env = { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", ...limits } as never;
  return worker.fetch(new Request(BASE + path, { method, headers: { "CF-Connecting-IP": "203.0.113.9", ...headers } }), env);
}

test("rate limit: over the API limit is a 429 with CORS, before any KV call, known list or not", async () => {
  const kv = await seeded();
  const api = limiter(false);
  for (const code of [LIST, "ffffffff"]) {
    kv.resetOps();
    const res = await limited(kv, { API_LIMITER: api }, "GET", "/api/assignments", { "X-List-Code": code });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  }
  assert.deepEqual(api.keys, ["203.0.113.9", "203.0.113.9"]);
  // A preflight is never counted: the browser sends it, not the app.
  const pre = await limited(kv, { API_LIMITER: api }, "OPTIONS", "/api/assignments");
  assert.equal(pre.status, 200);
  assert.equal(api.keys.length, 2);
});

test("rate limit: no binding, or a binding that fails, lets the request through", async () => {
  const kv = await seeded();
  const headers = { "X-List-Code": LIST };
  assert.equal((await limited(kv, {}, "GET", "/api/assignments", headers)).status, 200);
  const broken = limiter("throw");
  assert.equal((await limited(kv, { API_LIMITER: broken }, "GET", "/api/assignments", headers)).status, 200);
  assert.equal(broken.keys.length, 1);
  const fine = limiter(true);
  assert.equal((await limited(kv, { API_LIMITER: fine, REGISTER_LIMITER: limiter(false) }, "GET", "/api/assignments", headers)).status, 200);
});

test("rate limit: registering has its own limiter, and a refusal writes nothing", async () => {
  const kv = new FakeKV();
  const api = limiter(true), reg = limiter(false);
  const res = await limited(kv, { API_LIMITER: api, REGISTER_LIMITER: reg }, "POST", "/api/register");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(kv.ops.put, 0);
  assert.deepEqual([api.keys.length, reg.keys.length], [1, 1]);
  const ok = await limited(kv, { API_LIMITER: api, REGISTER_LIMITER: limiter(true) }, "POST", "/api/register");
  assert.equal(ok.status, 200);
});

/* ------------------------------------------------------------ feedback -- */

const { testerId, FEEDBACK_PER_DAY } = await import("./feedback.ts");

/** POST /api/feedback with the owner's topic set and ntfy stubbed. */
async function feedback(kv: FakeKV, code: string, body: unknown, opts: { topic?: string; ntfy?: "ok" | "fail" } = {}) {
  const pushes: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    pushes.push(JSON.parse(init?.body ?? "null"));
    return new Response("", { status: opts.ntfy === "fail" ? 500 : 200 });
  }) as never;
  try {
    const env = { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", FEEDBACK_TOPIC: opts.topic } as never;
    const res = await worker.fetch(new Request(`${BASE}/api/feedback`, {
      method: "POST", headers: { "X-List-Code": code }, body: typeof body === "string" ? body : JSON.stringify(body),
    }), env);
    return { status: res.status, data: await res.json() as any, pushes };
  } finally { globalThis.fetch = real; }
}

async function registered(kv: FakeKV): Promise<{ code: string; topic: string }> {
  const reg = await call(kv, "POST", "/api/register");
  kv.resetOps();
  return { code: reg.data.listCode, topic: reg.data.ntfyTopic };
}

test("feedback: one write, a tester id and never the code, a push without the text", async () => {
  const kv = new FakeKV();
  const { code, topic } = await registered(kv);
  const res = await feedback(kv, code, { text: "  The clocks were right. Ada Owens was late.  ", version: "v52" }, { topic: "owner-topic" });
  assert.equal(res.status, 200);
  assert.deepEqual(kv.ops, { get: 1, put: 1, delete: 0, list: 1 });
  const [key] = kv.keys("feedback:");
  const tester = await testerId(code, topic);
  assert.match(key, new RegExp(`^feedback:\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z:${tester}:[0-9a-f]{4}$`));
  const stored = kv.data.get(key)!;
  assert.deepEqual(JSON.parse(stored.value), {
    at: JSON.parse(stored.value).at, tester, version: "v52", text: "The clocks were right. Ada Owens was late.",
  });
  assert.ok(!key.includes(code) && !stored.value.includes(code) && !stored.value.includes(topic));
  assert.deepEqual(stored.metadata, { version: "v52", chars: 42 });
  assert.equal(res.pushes.length, 1);
  assert.equal(res.pushes[0].topic, "owner-topic");
  assert.equal(res.pushes[0].title, "New feedback · v52");
  assert.equal(res.pushes[0].priority, 2);
  assert.ok(!JSON.stringify(res.pushes[0]).includes("Owens"));
  // The same list is the same tester; another list is another.
  assert.equal(await testerId(code, topic), tester);
  assert.notEqual(await testerId("ffffffff", topic), tester);
});

test("feedback: empty, too long, junk version, unknown or no code; none of them writes", async () => {
  const kv = new FakeKV();
  const { code } = await registered(kv);
  assert.equal((await feedback(kv, code, { text: "   " })).status, 400);
  assert.equal((await feedback(kv, code, { text: 42 })).status, 400);
  const long = await feedback(kv, code, { text: "x".repeat(2001) });
  assert.equal(long.status, 413);
  assert.match(long.data.error, /2000/);
  assert.equal((await feedback(kv, "ffffffff", { text: "hello" })).status, 404);
  assert.equal((await feedback(kv, "", { text: "hello" })).status, 400);
  assert.equal((await feedback(kv, code, "not json")).status, 400);
  assert.equal(kv.ops.put, 0);
  assert.equal(kv.ops.list, 0);
  // A version that isn't ours is dropped, not stored; no topic, no push.
  const ok = await feedback(kv, code, { text: "x".repeat(2000), version: "<b>" });
  assert.equal(ok.status, 200);
  assert.equal(ok.pushes.length, 0);
  assert.equal(JSON.parse(kv.data.get(kv.keys("feedback:")[0])!.value).version, null);
});

test("feedback: a whole-number version and a point one are both kept; anything else is not", async () => {
  const { cleanVersion } = await import("./feedback.ts");
  assert.equal(cleanVersion("v61"), "v61");
  assert.equal(cleanVersion("v60.1"), "v60.1");
  for (const junk of ["60.1", "v60.", "v60.1.2", "v60.1a", "V61", "", null, 61]) assert.equal(cleanVersion(junk), null, String(junk));
});

test("feedback: five a day per list; the sixth is refused, and then costs no list", async () => {
  const kv = new FakeKV();
  const { code } = await registered(kv);
  for (let i = 0; i < FEEDBACK_PER_DAY; i++) {
    assert.equal((await feedback(kv, code, { text: `note ${i}` })).status, 200);
  }
  kv.resetOps();
  const sixth = await feedback(kv, code, { text: "one more" });
  assert.equal(sixth.status, 429);
  assert.match(sixth.data.error, /5 notes today/);
  assert.deepEqual(kv.ops, { get: 1, put: 0, delete: 0, list: 0 });
  // Another list is not held back.
  const other = await registered(kv);
  assert.equal((await feedback(kv, other.code, { text: "mine" })).status, 200);
});

test("feedback: the day's count is read from KV too, for another isolate's notes", async () => {
  const kv = new FakeKV();
  const { code, topic } = await registered(kv);
  const tester = await testerId(code, topic);
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FEEDBACK_PER_DAY; i++) {
    await kv.put(`feedback:${day}T0${i}:00:00.000Z:${tester}:000${i}`, "{}");
  }
  await kv.put(`feedback:${day}T09:00:00.000Z:0badc0de:0009`, "{}"); // someone else's
  kv.resetOps();
  const res = await feedback(kv, code, { text: "hello" });
  assert.equal(res.status, 429);
  assert.deepEqual(kv.ops, { get: 1, put: 0, delete: 0, list: 1 });
});

test("feedback: a failed push still keeps the note and answers ok", async () => {
  const kv = new FakeKV();
  const { code } = await registered(kv);
  const res = await feedback(kv, code, { text: "hello", version: "v52" }, { topic: "owner-topic", ntfy: "fail" });
  assert.equal(res.status, 200);
  assert.equal(res.pushes.length, 1);
  assert.equal(kv.keys("feedback:").length, 1);
});

/* ---------------------------------------------------------- test alert -- */

const { TEST_ALERT_LIMIT } = await import("./limits.ts");

/** POST /api/alerts/test with ntfy stubbed. */
async function testAlert(kv: FakeKV, code: string, ntfy: "ok" | "fail" | "quota" = "ok", token?: string) {
  const pushes: any[] = [];
  const real = globalThis.fetch;
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (_u: string, init?: { body?: string; headers?: Record<string, string> }) => {
    pushes.push({ ...JSON.parse(init?.body ?? "null"), auth: init?.headers?.Authorization });
    if (ntfy === "quota") return new Response('{"code":42908,"error":"limit reached: daily message quota reached"}', { status: 429 });
    return new Response(ntfy === "fail" ? `no ${pushes.at(-1).topic}` : "", { status: ntfy === "fail" ? 500 : 200 });
  }) as never;
  try {
    const res = await worker.fetch(new Request(`${BASE}/api/alerts/test`, {
      method: "POST", headers: { "X-List-Code": code }, body: "{}",
    }), { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", NTFY_TOKEN: token } as never);
    return { status: res.status, data: await res.json() as any, pushes, errors };
  } finally { globalThis.fetch = real; console.error = realError; }
}

test("test alert: one push to the list's own topic for one KV get; unknown or no code is refused", async () => {
  const kv = new FakeKV();
  const { code, topic } = await registered(kv);
  const res = await testAlert(kv, code);
  assert.equal(res.status, 200);
  assert.deepEqual(kv.ops, { get: 1, put: 0, delete: 0, list: 0 });
  assert.equal(res.pushes.length, 1);
  assert.equal(res.pushes[0].topic, topic);
  assert.equal(res.pushes[0].priority, 3);
  assert.match(res.pushes[0].title, /^Test alert/);
  assert.equal((await testAlert(kv, "ffffffff")).status, 404);
  assert.equal((await testAlert(kv, "")).status, 400);
});

test("test alert: a list from before topics gets its own, once; a failed push answers 502 without the topic in the log", async () => {
  const kv = new FakeKV();
  await kv.put("list:feed0001", JSON.stringify({ flights: [] }));
  const failed = await testAlert(kv, "feed0001", "fail");
  assert.equal(failed.status, 502);
  const topic = JSON.parse((await kv.get("list:feed0001"))!).topic;
  assert.match(topic, /^curbside-[0-9a-f]{24}$/);
  assert.equal(failed.pushes[0].topic, topic);
  assert.ok(failed.errors.length && failed.errors.every((e) => !e.includes(topic) && !e.includes("feed0001")));
});

test(`test alert: ${TEST_ALERT_LIMIT} an hour per list; the next is refused before any push`, async () => {
  const kv = new FakeKV();
  const { code } = await registered(kv);
  for (let i = 0; i < TEST_ALERT_LIMIT; i++) assert.equal((await testAlert(kv, code)).status, 200);
  const over = await testAlert(kv, code);
  assert.equal(over.status, 429);
  assert.equal(over.pushes.length, 0);
  const other = await registered(kv);
  assert.equal((await testAlert(kv, other.code)).status, 200);
});

/* ------------------------------------------------ what dispatch changed -- */

/** The seeded run printed again at `printedAt`, changed by `edit`. */
function reprint(printedAt: string, edit: (r: any) => void = () => {}): any {
  const r = seedRun();
  r.printedAt = printedAt;
  edit(r);
  return r;
}
const retimed = (r: any) => { r.steps[1].eta = "11:20 PM"; };
const newCar = (r: any) => { r.vehicle = "Toyota Sienna (00412) (7 Seats)"; };
const seen = (kv: FakeKV, printedAt: string) =>
  call(kv, "POST", "/api/assignments/seen", { listCode: LIST, number: "369736", printedAt });

test("what changed: a re-send answers its count; GET marks it by the rows' own addresses, never serving the base", async () => {
  const kv = await seeded();
  const res = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", (r) => { retimed(r); newCar(r); }));
  assert.equal(res.status, 200);
  assert.equal(res.data.changes, 2);
  assert.equal(res.data.since, "2026-08-30 17:00");
  assert.equal(res.data.same, undefined);
  assert.equal(res.data.assignment.base, undefined);
  // The stored record keeps the copy it counts from.
  const stored = JSON.parse(kv.data.get(`assign:${LIST}:369736`)!.value);
  assert.equal(stored.base.printedAt, "2026-08-30 17:00");
  kv.resetOps();
  const run = await getRun(kv);
  assert.equal(kv.ops.list, 2, "GET is still two lists");
  assert.equal(run.base, undefined);
  assert.equal(run.seenPrintedAt, undefined);
  assert.equal(run.sheetChanges.count, 2);
  assert.equal(run.sheetChanges.seen, false);
  assert.deepEqual(run.sheetChanges.items.map((c: any) => c.kind), ["vehicle", "times"]);
  assert.equal(run.sheetChanges.items[1].at, run.steps[1]._at);
});

test("what changed: counted from dispatch's copies, never from the driver's corrections", async () => {
  const kv = await seeded();
  const fix = await call(kv, "POST", "/api/assignments/patches",
    { listCode: LIST, number: "369736", at: "1", field: "eta", value: "11:10 PM", was: "11:00 PM" });
  assert.equal(fix.status, 201);
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", newCar));
  const run = await getRun(kv);
  assert.deepEqual(run.sheetChanges.items.map((c: any) => c.kind), ["vehicle"]);
  assert.equal(run.steps[1].eta, "11:10 PM"); // the driver's still stands
});

test("what changed: OK is kept for the list; the chip goes, the marks stay; a repeat writes nothing", async () => {
  const kv = await seeded();
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", retimed));
  kv.resetOps();
  const ok = await seen(kv, "2026-08-30 20:12");
  assert.equal(ok.status, 200);
  assert.deepEqual(kv.ops, { get: 2, put: 2, delete: 0, list: 0 }); // the list and its stamp
  assert.deepEqual(JSON.parse(kv.data.get(`list:${LIST}`)!.value).seen, { "369736": "2026-08-30 20:12" });
  // Never written into the run: the run's key and metadata are as imported.
  assert.equal(JSON.parse(kv.data.get(`assign:${LIST}:369736`)!.value).seenPrintedAt, undefined);
  const run = await getRun(kv);
  assert.equal(run.sheetChanges.seen, true);
  assert.equal(run.sheetChanges.count, 1);
  kv.resetOps();
  assert.equal((await seen(kv, "2026-08-30 20:12")).status, 200);
  assert.deepEqual(kv.ops, { get: 2, put: 0, delete: 0, list: 0 });
});

test("what changed: an OK for another print is refused; malformed is a 400 before any KV op", async () => {
  const kv = await seeded();
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", retimed));
  kv.resetOps();
  const old = await seen(kv, "2026-08-30 17:00");
  assert.equal(old.status, 409);
  assert.equal(old.data.printedAt, "2026-08-30 20:12");
  assert.equal(kv.ops.put, 0);
  assert.equal((await call(kv, "POST", "/api/assignments/seen",
    { listCode: LIST, number: "999999", printedAt: "2026-08-30 20:12" })).status, 404);
  for (const body of [{ number: "1:x", printedAt: "2026-08-30 20:12" }, { number: "369736" }, { number: "369736", printedAt: 5 }]) {
    kv.resetOps();
    const res = await call(kv, "POST", "/api/assignments/seen", { listCode: LIST, ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  }
});

test("what changed: without an OK, re-sends add up; after one, the next counts from the OK'd copy", async () => {
  const kv = await seeded();
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", retimed));
  const more = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 21:00", (r) => { retimed(r); newCar(r); }));
  assert.equal(more.data.changes, 2, "both, since nobody said OK");
  assert.equal((await getRun(kv)).sheetChanges.count, 2);

  assert.equal((await seen(kv, "2026-08-30 21:00")).status, 200);
  const next = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 22:00", (r) => {
    retimed(r); newCar(r); r.parking = "WRK-NBD-011";
  }));
  assert.equal(next.data.changes, 1, "only what came after the OK");
  const run = await getRun(kv);
  assert.deepEqual(run.sheetChanges.items.map((c: any) => c.kind), ["parking"]);
  assert.equal(run.sheetChanges.since, "2026-08-30 21:00");
  assert.equal(run.sheetChanges.seen, false);
});

test("what changed: a reprint that changes nothing says so, and keeps the marks and the OK", async () => {
  const kv = await seeded();
  const first = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 18:00"));
  assert.equal(first.data.same, true);
  assert.equal((await getRun(kv)).sheetChanges, undefined, "nothing to mark");

  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", retimed));
  await seen(kv, "2026-08-30 20:12");
  const again = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 21:00", retimed));
  assert.equal(again.data.same, true);
  assert.equal(again.data.changes, undefined);
  const run = await getRun(kv);
  assert.equal(run.printedAt, "2026-08-30 21:00");
  assert.equal(run.sheetChanges.count, 1, "the marks stay");
  assert.equal(run.sheetChanges.seen, true, "the OK carries over to the reprint");
  // ...and the next change is still counted from the OK'd copy.
  const next = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 22:00", (r) => { retimed(r); newCar(r); }));
  assert.equal(next.data.changes, 1);
});

test("what changed: dispatch changing it back leaves nothing to mark", async () => {
  const kv = await seeded();
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", newCar));
  const back = await call(kv, "POST", "/api/assignments", reprint("2026-08-30 21:00"));
  assert.equal(back.data.changes, 0);
  assert.equal(back.data.since, "2026-08-30 17:00");
  assert.equal((await getRun(kv)).sheetChanges, undefined);
});

test("what changed: a base, an OK or marks sent by a client are never stored", async () => {
  const kv = await seeded();
  const forged = (r: any) => {
    r.base = { printedAt: "x", start: "", end: "", vehicle: "fake", parking: null, driverNotes: null, steps: [] };
    r.seenPrintedAt = r.printedAt;
    r.sheetChanges = { count: 99 };
  };
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 18:00", forged));
  let stored = JSON.parse(kv.data.get(`assign:${LIST}:369736`)!.value);
  assert.deepEqual([stored.base, stored.seenPrintedAt, stored.sheetChanges], [undefined, undefined, undefined]);
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", (r) => { forged(r); retimed(r); }));
  stored = JSON.parse(kv.data.get(`assign:${LIST}:369736`)!.value);
  assert.equal(stored.base.printedAt, "2026-08-30 18:00");
  assert.deepEqual([stored.seenPrintedAt, stored.sheetChanges], [undefined, undefined]);
  assert.equal((await getRun(kv)).sheetChanges.seen, false);
});

/* ------------------------------------------------------ staying in sync -- */

const stampNow = (kv: FakeKV) => kv.data.get(`stamp:${LIST}`)?.value ?? null;

test("stamp: one read and no list; an unknown code and a list never written to both answer null", async () => {
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [] }));
  kv.resetOps();
  const ask = (code: string) => call(kv, "GET", "/api/stamp", undefined, undefined, { "X-List-Code": code });
  const none = await ask(LIST);
  assert.deepEqual([none.status, none.data], [200, { stamp: null }]);
  assert.deepEqual(kv.ops, { get: 1, put: 0, delete: 0, list: 0 });
  assert.deepEqual((await ask("00000000")).data, { stamp: null });
  // A code KV would not take as a key is answered without a read.
  kv.resetOps();
  assert.deepEqual((await ask("x".repeat(600))).data, { stamp: null });
  assert.deepEqual((await ask("a:b")).data, { stamp: null });
  assert.equal(kv.ops.get, 0);
  assert.equal((await call(kv, "GET", "/api/stamp")).status, 400);
});

test("stamp: every write GET would show gives the list a new one, and GET carries it", async () => {
  const kv = await seeded();
  const first = stampNow(kv);
  assert.ok(first, "the import stamped the list");
  const got = await listOf(kv);
  assert.equal(got.data.stamp, first);
  assert.equal((await call(kv, "GET", "/api/stamp", undefined, undefined, { "X-List-Code": LIST })).data.stamp, first);

  let last = first;
  const moved = (what: string) => {
    const now = stampNow(kv);
    assert.notEqual(now, last, what);
    last = now;
  };
  const same = (what: string) => assert.equal(stampNow(kv), last, what);

  const fix = await call(kv, "POST", "/api/assignments/patches",
    { listCode: LIST, number: "369736", at: "1", field: "eta", value: "11:10 PM", was: "11:00 PM" });
  moved("a correction");
  await call(kv, "DELETE", "/api/assignments/patches", { listCode: LIST, number: "369736", id: fix.data.patch.id });
  moved("a correction taken back");
  await call(kv, "POST", "/api/places", { listCode: LIST, code: "SGA", name: "Stonegate", address: "1 Sample Terrace" });
  moved("a place");
  await call(kv, "POST", "/api/airlines", { listCode: LIST, name: "WestJet", code: "WS" });
  moved("an airline");
  await call(kv, "PUT", "/api/settings", { listCode: LIST, retentionDays: 14 });
  moved("settings");
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 20:12", retimed));
  moved("a re-sent sheet");
  await seen(kv, "2026-08-30 20:12");
  moved("an OK");

  // What changes nothing writes no stamp.
  await seen(kv, "2026-08-30 20:12");
  same("an OK repeated");
  await call(kv, "POST", "/api/assignments", reprint("2026-08-30 17:00"));
  same("an older copy, not stored");
  await call(kv, "POST", "/api/assignments/patches", { listCode: LIST, number: "999999", at: "1", field: "eta", value: "1:00 PM" });
  same("a refused correction");
  await getRun(kv);
  same("a read");

  await call(kv, "DELETE", "/api/assignments", { listCode: LIST, number: "369736" });
  moved("a run removed");
});

test("stamp: a stamp that cannot be written never fails the write it follows", async () => {
  const kv = await seeded();
  const put = kv.put.bind(kv);
  kv.put = async (key: string, value: string, opts?: { metadata?: unknown }) => {
    if (key.startsWith("stamp:")) throw new Error("KV put() limit exceeded for the day.");
    return put(key, value, opts);
  };
  const real = console.error;
  console.error = () => {};
  try {
    const res = await call(kv, "POST", "/api/places", { listCode: LIST, code: "SGA", name: "", address: "1 Sample Terrace" });
    assert.equal(res.status, 200);
  } finally { console.error = real; }
});

test("stamp: GET costs one more read and still two lists", async () => {
  const kv = await seeded();
  await getRun(kv);
  assert.equal(kv.ops.list, 2);
  assert.equal(kv.data.has(`stamp:${LIST}`), true);
});

/* ------------------------------- places and airlines every driver gets -- */

const KEEPER = "feed0001", DRIVER = "d21ce002", KEEPER_TOPIC = "curbside-keeper-topic";

/** Two lists: the keeper's (its topic is FEEDBACK_TOPIC) and a driver's. */
async function twoLists(): Promise<FakeKV> {
  const kv = new FakeKV();
  await kv.put(`list:${KEEPER}`, JSON.stringify({ flights: [], topic: KEEPER_TOPIC }));
  await kv.put(`list:${DRIVER}`, JSON.stringify({ flights: [], topic: "curbside-driver-topic" }));
  kv.resetOps();
  return kv;
}

/** A call as a list, with the keeper's topic set and ntfy stubbed. */
async function as(kv: FakeKV, code: string, method: string, path: string, body?: object) {
  const pushes: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    pushes.push(JSON.parse(init?.body ?? "null"));
    return new Response("", { status: 200 });
  }) as never;
  try {
    const env = { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", FEEDBACK_TOPIC: KEEPER_TOPIC } as never;
    const res = await worker.fetch(new Request(BASE + path, {
      method, headers: { "X-List-Code": code }, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, data: await res.json() as any, pushes };
  } finally { globalThis.fetch = real; }
}

const CLS = { code: "CLS", name: "Clinic South", address: "10 Sample Road, Newburgh, NY" };

test("shared: the keeper's places and airlines are every list's defaults; the driver's list is not asked to hold them", async () => {
  const kv = await twoLists();
  assert.equal((await as(kv, KEEPER, "POST", "/api/places", CLS)).status, 200);
  assert.equal((await as(kv, KEEPER, "POST", "/api/airlines", { name: "WestJet", code: "WS" })).status, 200);

  const driver = (await as(kv, DRIVER, "GET", "/api/assignments")).data;
  assert.deepEqual(driver.shared.places, [CLS]);
  assert.deepEqual(driver.shared.airlines, [{ name: "WestJet", code: "WS" }]);
  assert.deepEqual(driver.settings.places, [], "its own list stays its own");
  assert.equal(driver.keeper, undefined);
  assert.equal(driver.suggestions, undefined, "only the keeper sees what drivers added");

  const keeper = (await as(kv, KEEPER, "GET", "/api/assignments")).data;
  assert.equal(keeper.keeper, true);
  assert.deepEqual(keeper.suggestions, []);

  // The keeper takes one back: gone for everyone.
  await as(kv, KEEPER, "POST", "/api/places", { code: "CLS", remove: true });
  assert.deepEqual((await as(kv, DRIVER, "GET", "/api/assignments")).data.shared.places, []);
});

test("shared: a catalog not yet written is made from the keeper's list on its first read", async () => {
  const kv = new FakeKV();
  await kv.put(`list:${KEEPER}`, JSON.stringify({ flights: [], topic: KEEPER_TOPIC, settings: { places: [CLS] } }));
  await kv.put(`list:${DRIVER}`, JSON.stringify({ flights: [], topic: "t" }));
  assert.deepEqual((await as(kv, DRIVER, "GET", "/api/assignments")).data.shared.places, [], "not before the keeper's read");
  await as(kv, KEEPER, "GET", "/api/assignments");
  assert.deepEqual((await as(kv, DRIVER, "GET", "/api/assignments")).data.shared.places, [CLS]);
});

test("shared: what a driver adds is a suggestion for the keeper, pushed once, without the address", async () => {
  const kv = await twoLists();
  const doc = { code: "DRM", name: "Dr. Sample", address: "22 Sample Ave, Goshen, NY" };
  const first = await as(kv, DRIVER, "POST", "/api/places", doc);
  assert.equal(first.status, 200);
  assert.equal(first.pushes.length, 1);
  assert.equal(first.pushes[0].topic, KEEPER_TOPIC);
  assert.equal(first.pushes[0].title, "A driver added a place · DRM");
  assert.ok(!JSON.stringify(first.pushes[0]).includes("Sample Ave"));
  assert.ok(!JSON.stringify(kv.data.get("shared:suggestions")!.value).includes(DRIVER), "never the driver's list code");

  // The same again, or with other spacing and case: nothing new, no push.
  const again = await as(kv, DRIVER, "POST", "/api/places", { ...doc, address: "22  sample ave, goshen, NY" });
  assert.equal(again.pushes.length, 0);
  const air = await as(kv, DRIVER, "POST", "/api/airlines", { name: "Porter", code: "PD" });
  assert.equal(air.pushes[0].title, "A driver taught an airline · PD");
  // A removal on a driver's own list is theirs alone.
  assert.equal((await as(kv, DRIVER, "POST", "/api/places", { code: "DRM", remove: true })).pushes.length, 0);

  const items = (await as(kv, KEEPER, "GET", "/api/assignments")).data.suggestions;
  assert.deepEqual(items.map((s: any) => [s.kind, s.code, s.name, s.address]), [
    ["place", "DRM", "Dr. Sample", "22 Sample Ave, Goshen, NY"], ["airline", "PD", "Porter", undefined]]);
  assert.match(items[0].by, /^[0-9a-f]{8}$/);

  // Exactly what the catalog already has is not a suggestion.
  await as(kv, KEEPER, "POST", "/api/places", CLS);
  assert.equal((await as(kv, DRIVER, "POST", "/api/places", CLS)).pushes.length, 0);
  assert.equal((await as(kv, KEEPER, "GET", "/api/assignments")).data.suggestions.length, 2);
});

test("shared: the keeper adds it (an ordinary save) or dismisses it; either way it does not come back", async () => {
  const kv = await twoLists();
  const doc = { code: "DRM", name: "Dr. Sample", address: "22 Sample Ave, Goshen, NY" };
  await as(kv, DRIVER, "POST", "/api/places", doc);
  await as(kv, DRIVER, "POST", "/api/airlines", { name: "Porter", code: "PD" });
  const [place, airline] = (await as(kv, KEEPER, "GET", "/api/assignments")).data.suggestions;

  // Only the keeper answers.
  assert.equal((await as(kv, DRIVER, "POST", "/api/suggestions", { id: airline.id })).status, 403);
  assert.equal((await as(kv, KEEPER, "POST", "/api/suggestions", { id: "nope" })).status, 400);
  assert.equal((await call(kv, "POST", "/api/suggestions", { listCode: KEEPER, id: airline.id })).status, 403,
    "with no keeper set, nobody is one");

  const before = kv.data.get(`stamp:${KEEPER}`)?.value;
  const gone = await as(kv, KEEPER, "POST", "/api/suggestions", { id: airline.id });
  assert.deepEqual([gone.status, gone.data.dismissed], [200, true]);
  assert.notEqual(kv.data.get(`stamp:${KEEPER}`)?.value, before, "the keeper's other phone sees it go");
  assert.equal((await as(kv, KEEPER, "POST", "/api/suggestions", { id: airline.id })).data.dismissed, false);
  assert.equal((await as(kv, DRIVER, "POST", "/api/airlines", { name: "porter", code: "PD" })).pushes.length, 0, "dismissed stays dismissed");

  // ADD FOR EVERYONE is the keeper saving the place: in the catalog, the suggestion answered.
  await as(kv, KEEPER, "POST", "/api/places", { code: place.code, name: place.name, address: place.address });
  const keeper = (await as(kv, KEEPER, "GET", "/api/assignments")).data;
  assert.deepEqual(keeper.suggestions, []);
  assert.deepEqual(keeper.shared.places.map((p: any) => p.code), ["DRM"]);
});

test("shared: with no keeper configured nothing is shared, suggested or pushed, and a save costs what it did", async () => {
  const kv = await seeded();
  const res = await call(kv, "POST", "/api/places", { listCode: LIST, code: "SGA", name: "", address: "1 Sample Terrace" });
  assert.equal(res.status, 200);
  assert.deepEqual(kv.ops, { get: 1, put: 2, delete: 0, list: 0 });
  assert.equal(kv.data.has("shared:catalog"), false);
  assert.equal(kv.data.has("shared:suggestions"), false);
});

/** A run whose passenger flies an airline the importer has no code for. */
function westJet(listCode: string): any {
  const r = seedRun();
  r.listCode = listCode;
  r.steps[1].actions[0].entities = [{ name: "Owens, Ada", pax: 1, tag: "A", flightNumber: null,
    unknownAirline: { name: "WestJet", number: "1680", date: "2026-08-31" } }];
  return r;
}

test("shared: an airline the keeper learned fills and tracks every list's flights, old runs and new", async () => {
  const kv = await twoLists();
  // The driver's run was imported BEFORE the keeper learned the airline.
  assert.equal((await as(kv, DRIVER, "POST", "/api/assignments", westJet(DRIVER))).status, 200);
  assert.equal(kv.data.has("flight:WS1680:2026-08-31:trackers"), false);
  await as(kv, KEEPER, "POST", "/api/airlines", { name: "WestJet", code: "WS" });

  const run = (await as(kv, DRIVER, "GET", "/api/assignments")).data.assignments[0];
  assert.equal(run.steps[1].actions[0].entities[0].flightNumber, "WS1680");
  assert.deepEqual(JSON.parse(kv.data.get("flight:WS1680:2026-08-31:trackers")!.value), [DRIVER], "tracked on its next read");
  // Once per change: the next read writes nothing.
  kv.resetOps();
  await as(kv, DRIVER, "GET", "/api/assignments");
  assert.equal(kv.ops.put, 0);

  // A run imported after is tracked at import. The driver's own code for the name wins.
  await as(kv, DRIVER, "POST", "/api/airlines", { name: "WestJet", code: "WJ" });
  const r2 = westJet(DRIVER);
  r2.number = "369737";
  await as(kv, DRIVER, "POST", "/api/assignments", r2);
  assert.deepEqual(JSON.parse(kv.data.get("flight:WJ1680:2026-08-31:trackers")!.value), [DRIVER]);
});

/* ------------------------------------------- trackers put back (B8) -- */

test("trackers: a list whose tracker was lost to a race gets it back on its next load; present costs a get, no write", async () => {
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [], topic: "curbside-test" }));
  const day = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
  const run = {
    listCode: LIST, number: "369790", start: `${day} 13:00`, end: `${day} 18:00`, printedAt: "2026-09-27 17:00",
    steps: [{ code: "LGA", place: "LaGuardia", eta: "3:00 PM", etd: "4:00 PM", date: day, etaDate: day,
      actions: [{ verb: "Pickup", where: "Claim", entities: [
        { name: "Owens, Ada", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: day, scheduledText: "3:39 PM ORD - Chicago" },
      ] }] }],
  };
  assert.equal((await call(kv, "POST", "/api/assignments", run)).status, 200);
  const trackers = `flight:UA1503:${day}:trackers`;
  assert.deepEqual(JSON.parse((await kv.get(trackers))!), [LIST]);

  // Another list saved the same key at the same moment, from a copy without us.
  await kv.put(trackers, JSON.stringify(["feed0002"]));
  kv.resetOps();
  assert.equal((await call(kv, "GET", "/api/assignments", undefined, undefined, { "X-List-Code": LIST })).status, 200);
  assert.deepEqual(JSON.parse((await kv.get(trackers))!), ["feed0002", LIST]);
  assert.ok(kv.data.has(`poll:UA1503:${day}`), "polled");

  // Already there: one more read, nothing written.
  const quiet = new FakeKV();
  for (const [k, v] of kv.data) quiet.data.set(k, v);
  const before = { ...quiet.ops };
  assert.equal((await call(quiet, "GET", "/api/assignments", undefined, undefined, { "X-List-Code": LIST })).status, 200);
  assert.equal(quiet.ops.put - before.put, 0);
});

test("test alert: ntfy's daily limit is said as it is; a token goes as a Bearer header, never in the body", async () => {
  const kv = new FakeKV();
  const code = "feed0004";
  await kv.put(`list:${code}`, JSON.stringify({ flights: [], topic: "curbside-feed0004topic" }));
  const quota = await testAlert(kv, code, "quota");
  assert.equal(quota.status, 503);
  assert.equal(quota.data.quota, true);
  assert.match(quota.data.error, /daily limit/);
  assert.equal(quota.pushes[0].auth, undefined, "no token set: anonymous");
  const withToken = await testAlert(kv, code, "ok", "tk_example");
  assert.equal(withToken.status, 200);
  assert.equal(withToken.pushes[0].auth, "Bearer tk_example");
  assert.ok(!JSON.stringify(withToken.pushes[0]).replace("Bearer tk_example", "").includes("tk_example"));
});

/* ---------------------------------------------- alerts in the app (v66) -- */

const { b64u } = await import("./webpush.ts");

/** The server's push keys and a phone's subscription, made up for the tests. */
async function pushKit(endpoint = "https://fcm.googleapis.com/fcm/send/phone-one") {
  const pair = async () => {
    const p = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    return {
      publicKey: b64u(await crypto.subtle.exportKey("raw", p.publicKey) as ArrayBuffer),
      privateKey: (await crypto.subtle.exportKey("jwk", p.privateKey) as { d: string }).d,
    };
  };
  const server = await pair(), phone = await pair();
  return {
    // A secret piped into wrangler ends in a newline.
    keys: { VAPID_PUBLIC: `${server.publicKey}\n`, VAPID_PRIVATE: `${server.privateKey}\n` },
    publicKey: server.publicKey,
    subscription: {
      endpoint, expirationTime: null,
      keys: { p256dh: phone.publicKey, auth: b64u(crypto.getRandomValues(new Uint8Array(16))) },
    },
  };
}

/** A call as a list with push keys set. Every fetch the Worker makes is
 *  recorded and answered by `answer`: a status per URL. */
async function pushCall(
  kv: FakeKV, vars: object, code: string, method: string, path: string, body?: object,
  answer: (url: string) => number = (url) => (url.startsWith("https://ntfy.sh") ? 200 : 201),
) {
  const sent: { url: string; ntfy: any; headers: Record<string, string> }[] = [];
  const real = globalThis.fetch;
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (u: string, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const url = String(u);
    sent.push({ url, ntfy: url.startsWith("https://ntfy.sh") ? JSON.parse(init!.body as string) : null, headers: init?.headers ?? {} });
    const status = answer(url);
    return new Response(status === 201 ? null : "no", { status });
  }) as never;
  try {
    const res = await worker.fetch(new Request(BASE + path, {
      method, headers: { "X-List-Code": code }, body: body ? JSON.stringify(body) : undefined,
    }), { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", ...vars } as never);
    return { status: res.status, data: await res.json() as any, sent, errors };
  } finally { globalThis.fetch = real; console.error = realError; }
}

const NTFY_FULL = (url: string) => (url.startsWith("https://ntfy.sh") ? 429 : 201);

test("push: only a browser's own subscription, refused before any KV call; kept under the list's topic", async () => {
  const kv = new FakeKV();
  const code = "feed0010", topic = "curbside-0a1b2c3d4e5f60718293a4b5";
  await kv.put(`list:${code}`, JSON.stringify({ flights: [], topic }));
  const { keys, publicKey, subscription } = await pushKit();
  kv.resetOps();

  for (const bad of [
    { ...subscription, endpoint: "https://evil.example/collect" },
    { ...subscription, endpoint: "http://fcm.googleapis.com/fcm/send/x" },
    { ...subscription, endpoint: `${BASE}/api/assignments` },
    { ...subscription, keys: { ...subscription.keys, auth: "short" } },
    { ...subscription, keys: { ...subscription.keys, p256dh: subscription.keys.auth } },
    // The right size, and not a point on the curve: nothing could be encrypted to it.
    { ...subscription, keys: { ...subscription.keys, p256dh: b64u(Uint8Array.from({ length: 65 }, (_, i) => (i ? 1 : 4))) } },
    { endpoint: subscription.endpoint },
    null,
  ]) {
    assert.equal((await pushCall(kv, keys, code, "POST", "/api/push", { subscription: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await pushCall(kv, {}, code, "POST", "/api/push", { subscription })).status, 503, "no keys on the server");
  assert.equal((await pushCall(kv, { VAPID_PUBLIC: publicKey }, code, "POST", "/api/push", { subscription })).status, 503, "half a pair");
  assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  assert.equal((await pushCall(kv, keys, "nolist00", "POST", "/api/push", { subscription })).status, 404);
  assert.equal((await pushCall(kv, keys, "", "POST", "/api/push", { subscription })).status, 400);
  kv.resetOps();

  const ok = await pushCall(kv, keys, code, "POST", "/api/push", { subscription });
  assert.equal(ok.status, 200);
  assert.deepEqual(kv.ops, { get: 2, put: 1, delete: 0, list: 0 });
  assert.equal(ok.sent.length, 0, "taking a subscription pushes nothing");
  const stored = JSON.parse((await kv.get(`push:${topic}`))!);
  assert.deepEqual(stored.map((s: any) => [s.endpoint, s.p256dh, s.auth]),
    [[subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]]);
  assert.ok(!Number.isNaN(Date.parse(stored[0].at)));
  assert.ok(kv.keys().every((k) => k === `list:${code}` || !k.includes(code)), "never under the list code");
  assert.ok(!("push" in JSON.parse((await kv.get(`list:${code}`))!)), "the list record is not rewritten");
  assert.equal(kv.data.has(`stamp:${code}`), false, "nothing another phone would show");

  // The phone says so again at every launch: two reads, no write.
  kv.resetOps();
  assert.equal((await pushCall(kv, keys, code, "POST", "/api/push", { subscription })).status, 200);
  assert.deepEqual(kv.ops, { get: 2, put: 0, delete: 0, list: 0 });

  // An eleventh phone pushes the oldest out.
  for (let i = 2; i <= 11; i++) {
    const more = { ...subscription, endpoint: `https://web.push.apple.com/phone-${i}` };
    assert.equal((await pushCall(kv, keys, code, "POST", "/api/push", { subscription: more })).status, 200);
  }
  const ten = JSON.parse((await kv.get(`push:${topic}`))!).map((s: any) => s.endpoint);
  assert.equal(ten.length, 10);
  assert.ok(!ten.includes(subscription.endpoint));

  // Turned off: gone from the list; the last one leaves no key behind.
  assert.equal((await pushCall(kv, keys, code, "DELETE", "/api/push", {})).status, 400);
  assert.equal((await pushCall(kv, keys, "nolist00", "DELETE", "/api/push", { endpoint: ten[0] })).status, 404);
  for (const endpoint of ten) {
    assert.equal((await pushCall(kv, keys, code, "DELETE", "/api/push", { endpoint })).data.removed, true);
  }
  assert.equal(kv.data.has(`push:${topic}`), false);
  assert.equal((await pushCall(kv, keys, code, "DELETE", "/api/push", { endpoint: ten[0] })).data.removed, false);

  // The phone learns the server's key with its runs.
  assert.equal((await pushCall(kv, keys, code, "GET", "/api/assignments")).data.pushKey, publicKey);
  assert.equal((await call(kv, "GET", "/api/assignments", undefined, undefined, { "X-List-Code": code })).data.pushKey, null);
});

test("test alert: to every phone with alerts on and to ntfy; it says whether THIS phone took it", async () => {
  const kv = new FakeKV();
  const code = "feed0011", topic = "curbside-feed0011topic";
  await kv.put(`list:${code}`, JSON.stringify({ flights: [], topic }));
  const { keys, publicKey, subscription } = await pushKit();
  const mine = { endpoint: subscription.endpoint };

  // Nobody has alerts on in the app: ntfy alone, as before.
  const before = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine);
  assert.deepEqual([before.status, before.data], [200, { ok: true, app: 0, phones: 0, here: false, ntfy: true }]);
  assert.deepEqual(before.sent.map((s) => s.ntfy?.topic), [topic]);

  await pushCall(kv, keys, code, "POST", "/api/push", { subscription });
  const second = { ...subscription, endpoint: "https://web.push.apple.com/phone-two" };
  await pushCall(kv, keys, code, "POST", "/api/push", { subscription: second });
  kv.resetOps();

  const both = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine);
  assert.deepEqual([both.status, both.data], [200, { ok: true, app: 2, phones: 2, here: true, ntfy: true }]);
  assert.deepEqual(kv.ops, { get: 2, put: 0, delete: 0, list: 0 });
  assert.deepEqual(both.sent.map((s) => s.url).sort(), [subscription.endpoint, "https://ntfy.sh/", second.endpoint].sort());
  for (const s of both.sent.filter((x) => !x.ntfy)) {
    assert.equal(s.headers["Content-Encoding"], "aes128gcm");
    assert.equal(s.headers.Urgency, "high");
    assert.match(s.headers.Authorization, new RegExp(`^vapid t=[\\w.-]+, k=${publicKey}$`));
  }
  // Asked from a phone that has not turned them on: sent, and not to it.
  assert.equal((await pushCall(kv, keys, code, "POST", "/api/alerts/test", {})).data.here, false);

  // What v66 is for: ntfy's daily limit is used up, and the alert arrives anyway.
  const full = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine, NTFY_FULL);
  assert.deepEqual([full.status, full.data], [200, { ok: true, app: 2, phones: 2, here: true, ntfy: false }]);

  // One phone's subscription is over: it leaves the list; the other took it.
  const one = await pushCall(kv, keys, code, "POST", "/api/alerts/test", { endpoint: second.endpoint },
    (url) => (url === second.endpoint ? 410 : 201));
  assert.deepEqual([one.data.app, one.data.phones, one.data.here], [1, 2, false]);
  assert.deepEqual(JSON.parse((await kv.get(`push:${topic}`))!).map((s: any) => s.endpoint), [subscription.endpoint]);
});

test("test alert: refused only when nothing took it, in words; the phone is kept and never named in a log", async () => {
  const kv = new FakeKV();
  const code = "feed0012", topic = "curbside-feed0012topic";
  await kv.put(`list:${code}`, JSON.stringify({ flights: [], topic }));
  const { keys, subscription } = await pushKit();
  await pushCall(kv, keys, code, "POST", "/api/push", { subscription });
  const mine = { endpoint: subscription.endpoint };

  const down = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine,
    (url) => (url.startsWith("https://ntfy.sh") ? 429 : 500));
  assert.equal(down.status, 503);
  assert.deepEqual([down.data.quota, down.data.app, down.data.phones, down.data.here, down.data.ntfy], [true, 0, 1, false, false]);
  assert.match(down.data.error, /push service did not take the alert, and ntfy\.sh's daily limit/);
  assert.equal(JSON.parse((await kv.get(`push:${topic}`))!).length, 1, "a refusal is not a phone gone");
  assert.ok(down.errors.some((e) => /not taken for 1 phone\(s\): 500/.test(e)));
  assert.ok(down.errors.every((e) => !e.includes("phone-one") && !e.includes(topic) && !e.includes(code)));

  const both = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine, () => 500);
  assert.equal(both.status, 502);
  assert.match(both.data.error, /^the phone's push service did not take the alert, and ntfy\.sh did not/);

  // The last phone is gone: no key left; ntfy alone carries it.
  const gone = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine,
    (url) => (url.startsWith("https://ntfy.sh") ? 200 : 404));
  assert.deepEqual([gone.status, gone.data.app, gone.data.here, gone.data.ntfy], [200, 0, false, true]);
  assert.equal(kv.data.has(`push:${topic}`), false);
  const none = await pushCall(kv, keys, code, "POST", "/api/alerts/test", mine, NTFY_FULL);
  assert.equal(none.status, 503);
  assert.match(none.data.error, /^ntfy\.sh's daily limit/);
});

test("the keeper's notices reach the keeper's phones: feedback and what a driver added", async () => {
  const kv = await twoLists();
  const { keys, subscription } = await pushKit();
  const vars = { ...keys, FEEDBACK_TOPIC: KEEPER_TOPIC };
  const note = { text: "The clocks were right.", version: "v66" };

  // A driver's own phone is not the keeper's.
  const drivers = { ...subscription, endpoint: "https://web.push.apple.com/driver" };
  await pushCall(kv, vars, DRIVER, "POST", "/api/push", { subscription: drivers });
  const early = await pushCall(kv, vars, DRIVER, "POST", "/api/feedback", note);
  assert.equal(early.status, 200);
  assert.deepEqual(early.sent.map((s) => s.ntfy?.topic ?? s.url), [KEEPER_TOPIC]);

  await pushCall(kv, vars, KEEPER, "POST", "/api/push", { subscription });
  const later = await pushCall(kv, vars, DRIVER, "POST", "/api/feedback", note, NTFY_FULL);
  assert.equal(later.status, 200);
  assert.deepEqual(later.sent.map((s) => s.url).sort(), [subscription.endpoint, "https://ntfy.sh/"].sort());
  // Quiet news: it may wait for the phone to wake, and for a day.
  const push = later.sent.find((s) => !s.ntfy)!;
  assert.deepEqual([push.headers.Urgency, push.headers.TTL], ["normal", "86400"]);

  // A place a driver adds is told the same way.
  const place = await pushCall(kv, vars, DRIVER, "POST", "/api/places", CLS, NTFY_FULL);
  assert.equal(place.status, 200, JSON.stringify(place.data));
  assert.deepEqual(place.sent.map((s) => s.url).sort(), [subscription.endpoint, "https://ntfy.sh/"].sort());
});

test("the same print sent again changes nothing: not the copy, not what edits are aimed at", async () => {
  const kv = await seeded();
  const first = await getRun(kv);
  await new Promise((r) => setTimeout(r, 5)); // a later importedAt, were it written
  kv.resetOps();
  const again = await call(kv, "POST", "/api/assignments", seedRun());
  assert.equal(again.status, 200);
  assert.equal(again.data.applied, false);
  assert.equal(kv.ops.put, 0, "nothing is written, the stamp included");
  // importedAt is what a queued edit names as the copy it was made on.
  assert.equal((await getRun(kv)).importedAt, first.importedAt);
  const older = await call(kv, "POST", "/api/assignments", { ...seedRun(), printedAt: "2026-08-30 16:00" });
  assert.equal(older.data.applied, false);
  const newer = await call(kv, "POST", "/api/assignments", { ...seedRun(), printedAt: "2026-08-30 17:01" });
  assert.equal(newer.data.applied, true);
});

/* --------------------------------------- what one list can cost the rest -- */

// The free plan's KV is one pool a day for every list (100,000 reads, 1,000
// writes, 1,000 lists), and anyone can register a list. These keep one list's
// own cost bounded (security review, 2026-10-04).
const { MAX_RUNS, MAX_PATCHES, MAX_FLIGHTS, REGISTER_PER_DAY } = await import("./limits.ts");
const { MAX_SUGGESTIONS_PER_LIST } = await import("./shared.ts");

test("a run meets at most 12 flights: one more is refused before any KV op; the most a real sheet has carried is 3", async () => {
  // Each flight is a poll key, a tracker record and, on the free plan, a
  // handful of the month's lookups: a run sent with a hundred would spend
  // every driver's. Counted as the cron tracks them: by number and day.
  assert.equal(MAX_FLIGHTS, 12);
  const kv = await seeded();
  const step = runBody().steps[0];
  const entity = step.actions[0].entities[0];
  const rows = (n: number, flight: (i: number) => string) => runBody({ steps: [{ ...step, actions: [{ ...step.actions[0],
    entities: Array.from({ length: n }, (_, i) => ({ ...entity, name: `P ${i}`, flightNumber: flight(i) })) }] }] });
  kv.resetOps();
  const over = await call(kv, "POST", "/api/assignments", rows(13, (i) => `UA${100 + i}`));
  assert.equal(over.status, 413);
  assert.match(over.data.error, /^too many flights \(max 12\)$/);
  assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  // Twelve are taken, and tracked; forty people off one plane are one flight.
  const most = await call(kv, "POST", "/api/assignments", rows(12, (i) => `UA${100 + i}`));
  assert.deepEqual([most.status, most.data.flightsTracked], [200, 12]);
  const plane = await call(kv, "POST", "/api/assignments", { ...rows(40, () => "UA995"), number: "400002" });
  assert.deepEqual([plane.status, plane.data.flightsTracked], [200, 1]);
});

test(`a list holds at most ${MAX_RUNS} runs: a new one past that is refused, a re-send of one it has is not`, async () => {
  const kv = await seeded();
  // GET reads every run on the list, so a list is one read a run for every load.
  for (let i = 1; i < MAX_RUNS; i++) {
    const number = `5${String(i).padStart(5, "0")}`;
    await kv.put(`assign:${LIST}:${number}`, JSON.stringify({ number, start: "2026-09-01 08:00", end: "2026-09-01 09:00", steps: [] }),
      { metadata: { end: "2026-09-01 09:00" } });
  }
  kv.resetOps();
  const over = await call(kv, "POST", "/api/assignments", runBody());
  assert.equal(over.status, 413);
  assert.match(over.data.error, new RegExp(`holds ${MAX_RUNS} runs`));
  assert.deepEqual(kv.ops, { get: 2, put: 0, delete: 0, list: 1 });

  // Dispatch re-sends a run the list has: taken as ever, and no count is made.
  kv.resetOps();
  const again = await call(kv, "POST", "/api/assignments", { ...seedRun(), printedAt: "2026-08-30 19:00" });
  assert.equal(again.status, 200);
  assert.equal(again.data.applied, true);
  assert.equal(kv.ops.list, 0);

  // One removed: room for one.
  assert.equal((await call(kv, "DELETE", "/api/assignments", { listCode: LIST, number: "500001" })).status, 200);
  assert.equal((await call(kv, "POST", "/api/assignments", runBody())).status, 200);
});

test(`a run holds at most ${MAX_PATCHES} changes: one more is refused; a replay and an undo still work`, async () => {
  const kv = await seeded();
  const basis = (await getRun(kv)).importedAt;
  const edit = (i: number) => call(kv, "POST", "/api/assignments/patches",
    { listCode: LIST, number: "369736", basis, at: "1.0.0", field: "note", value: `note ${i}`, ref: `r${i}` });
  let last: any = null;
  for (let i = 0; i < MAX_PATCHES; i++) {
    last = await edit(i);
    assert.equal(last.status, 201, String(i));
  }
  kv.resetOps();
  const over = await edit(MAX_PATCHES);
  assert.equal(over.status, 413);
  assert.match(over.data.error, new RegExp(`${MAX_PATCHES} changes`));
  assert.equal(kv.ops.put, 0);
  // The same edit sent twice is the one already written, not one more.
  const replay = await edit(7);
  assert.deepEqual([replay.status, replay.data.duplicate], [200, true]);
  // Undo one: room for one.
  assert.equal((await call(kv, "DELETE", "/api/assignments/patches",
    { listCode: LIST, number: "369736", id: last.data.patch.id })).status, 200);
  assert.equal((await edit(MAX_PATCHES + 1)).status, 201);
});

test(`shared: one list has at most ${MAX_SUGGESTIONS_PER_LIST} suggestions waiting: past that the keeper is neither told nor asked`, async () => {
  const kv = await twoLists();
  let pushes = 0;
  for (let i = 0; i < MAX_SUGGESTIONS_PER_LIST + 3; i++) {
    const res = await as(kv, DRIVER, "POST", "/api/places",
      { code: `P${String(i).padStart(2, "0")}`, name: "", address: `${i} Sample Road, Goshen, NY` });
    assert.equal(res.status, 200, "the place is saved on the driver's own list either way");
    pushes += res.pushes.length;
  }
  assert.equal(pushes, MAX_SUGGESTIONS_PER_LIST);
  const items = (await as(kv, KEEPER, "GET", "/api/assignments")).data.suggestions;
  assert.equal(items.length, MAX_SUGGESTIONS_PER_LIST);
  assert.equal((await as(kv, DRIVER, "GET", "/api/assignments")).data.settings.places.length, MAX_SUGGESTIONS_PER_LIST + 3);

  // The keeper answers one: the driver's next is a suggestion again.
  assert.equal((await as(kv, KEEPER, "POST", "/api/suggestions", { id: items[0].id })).status, 200);
  const more = await as(kv, DRIVER, "POST", "/api/places", { code: "P99", name: "", address: "99 Sample Road, Goshen, NY" });
  assert.equal(more.pushes.length, 1);
});

test(`register: at most ${REGISTER_PER_DAY} new lists a day, from anywhere; past that nothing is written`, async () => {
  const kv = new FakeKV();
  const reg = (ip: string) => worker.fetch(new Request(`${BASE}/api/register`, {
    method: "POST", headers: { "CF-Connecting-IP": ip },
  }), envWith(kv));
  for (let i = 0; i < REGISTER_PER_DAY; i++) assert.equal((await reg(`203.0.113.${i}`)).status, 200, String(i));
  kv.resetOps();
  const over = await reg("203.0.113.200");
  assert.equal(over.status, 429);
  assert.match(((await over.json()) as { error: string }).error, /no more new lists today/);
  assert.equal(kv.ops.put, 0);
  assert.equal(kv.keys("list:").length, REGISTER_PER_DAY);
  // Counted by the UTC day, in a key that expires by itself.
  assert.deepEqual(kv.keys("registered:"), [`registered:${new Date().toISOString().slice(0, 10)}`]);
});

test("travel times: the department's table is for a list or the write token, not for whoever has the address", async () => {
  const kv = await seeded();
  await kv.put("travel-times", JSON.stringify({ source: "HuB", pairs: { "WRK>EWR": 75 } }));
  kv.resetOps();
  const bare = await call(kv, "GET", "/api/travel-times");
  assert.equal(bare.status, 400);
  assert.match(bare.data.error, /listCode is required/);
  assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 });
  assert.equal((await call(kv, "GET", "/api/travel-times", undefined, undefined, { "X-List-Code": "00000000" })).status, 404);

  const mine = await call(kv, "GET", "/api/travel-times", undefined, undefined, { "X-List-Code": LIST });
  assert.deepEqual([mine.status, mine.data.pairs], [200, { "WRK>EWR": 75 }]);
  // The loader's own --show: the token it uploads with.
  const res = await worker.fetch(new Request(`${BASE}/api/travel-times`, { headers: { Authorization: "Bearer t0ken" } }),
    { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", WRITE_TOKEN: "t0ken" } as never);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { pairs: object }).pairs, { "WRK>EWR": 75 });
  // The app's own copy still rides with the runs.
  assert.deepEqual((await listOf(kv)).data.travelTimes.pairs, { "WRK>EWR": 75 });
});

test("every answer is JSON nothing may sniff or keep: a run holds names and phones, an error may quote a field", async () => {
  const kv = await seeded();
  const answers = [
    await listOf(kv),
    await call(kv, "GET", "/api/assignments"),
    await call(kv, "POST", "/api/assignments", undefined, "{not json"),
    await call(kv, "GET", "/api/nothing-here"),
  ];
  assert.deepEqual(answers.map((a) => a.status), [200, 400, 400, 404]);
  for (const res of answers) {
    assert.equal(res.headers.get("Content-Type"), "application/json");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
});

test("a run's number and a change's id are a key's part: checked on every route before any KV call", async () => {
  const kv = await seeded();
  const long = "9".repeat(600);
  const probes: [string, string, Record<string, unknown>][] = [
    ["DELETE", "/api/assignments", { number: long }],
    ["DELETE", "/api/assignments", { number: "369736:x" }],
    ["DELETE", "/api/assignments", { number: 369736 }],
    ["DELETE", "/api/assignments/patches", { number: long, id: "x" }],
    ["DELETE", "/api/assignments/patches", { number: "369736", id: "a".repeat(600) }],
    ["DELETE", "/api/assignments/patches", { number: "369736", id: "x:y" }],
    ["DELETE", "/api/assignments/patches", { number: "369736", id: ["x"] }],
    ["POST", "/api/assignments/patches", { number: long, at: "1.0.0", field: "note", value: "x" }],
    ["POST", "/api/assignments/patches", { number: "369736:x", at: "1.0.0", field: "note", value: "x" }],
  ];
  for (const [method, path, body] of probes) {
    kv.resetOps();
    const res = await call(kv, method, path, { listCode: LIST, ...body });
    assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body).slice(0, 40)}`);
    assert.deepEqual(kv.ops, { get: 0, put: 0, delete: 0, list: 0 }, `${method} ${path}`);
  }
  assert.ok(kv.data.has(`assign:${LIST}:369736`));
});
