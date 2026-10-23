/**
 * The cron tick end to end: a run posted through the routes, AeroDataBox and
 * ntfy stubbed on fetch, scheduled() run against an in-memory KV.
 *
 *   node --test --experimental-strip-types src/cron.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// As in routes.test.ts: add ".ts" to sibling imports and transpile them.
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

interface Entry { value: string; metadata?: unknown }

class FakeKV {
  data = new Map<string, Entry>();
  /** The day's writes are used up: KV refuses every put (a 429 on the free plan). */
  full = false;
  async get(key: string) { return this.data.get(key)?.value ?? null; }
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    if (this.full) throw new Error("KV PUT failed: 429 Too Many Requests");
    // KV's own limit: metadata is at most 1024 bytes of JSON.
    if (opts?.metadata !== undefined && Buffer.byteLength(JSON.stringify(opts.metadata), "utf8") > 1024) {
      throw new Error("metadata over 1024 bytes");
    }
    this.data.set(key, { value, metadata: opts?.metadata });
  }
  async delete(key: string) { this.data.delete(key); }
  async list(opts: { prefix?: string }) {
    const prefix = opts.prefix ?? "";
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()
      .map((name) => ({ name, metadata: this.data.get(name)!.metadata }));
    return { keys, list_complete: true, cursor: undefined };
  }
  keys(prefix = "") { return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

const env = (kv: FakeKV) => ({ FLIGHT_DATA: kv, AERODATABOX_KEY: "test" }) as never;
const LIST = "abcd1234";

async function call(kv: FakeKV, method: string, path: string, body?: unknown) {
  const res = await worker.fetch(new Request("https://w.test" + path, {
    method, headers: { "X-List-Code": LIST },
    body: body === undefined ? undefined : JSON.stringify({ listCode: LIST, ...(body as object) }),
  }), env(kv));
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/** A run with one pickup at LGA: Owens, Ada on UA1503. */
async function seeded() {
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [], topic: "curbside-test" }));
  const r = await call(kv, "POST", "/api/assignments", {
    number: "369736", start: "2026-08-31 21:30", end: "2026-09-01 03:00", printedAt: "2026-08-30 17:00",
    steps: [
      { code: "WRK", place: "Warwick", eta: null, etd: "9:30 PM", date: "2026-08-31", etaDate: "2026-08-31", actions: [] },
      { code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM", date: "2026-09-01", etaDate: "2026-08-31",
        actions: [{ verb: "Pickup", where: "Claim", entities: [
          { name: "Owens, Ada", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: "2026-08-31" },
        ] }] },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return kv;
}

async function run(kv: FakeKV) {
  return (await call(kv, "GET", "/api/assignments")).data.assignments[0];
}

/** AeroDataBox's answer for UA1503 landing (or due) at `arrMs`. */
function adb(status: string, arrMs: number) {
  const utc = (ms: number) => new Date(ms).toISOString().replace(/T(\d\d:\d\d).*/, " $1Z");
  const loc = (ms: number) => new Date(ms - 4 * 3600e3).toISOString().replace(/T(\d\d:\d\d).*/, " $1-04:00");
  return [{
    number: "UA 1503", status,
    departure: { airport: { name: "Chicago", iata: "ORD", timeZone: "America/Chicago", countryCode: "US" },
      scheduledTime: { local: loc(arrMs - 2 * 3600e3), utc: utc(arrMs - 2 * 3600e3) } },
    arrival: { airport: { name: "LaGuardia", iata: "LGA", timeZone: "America/New_York", countryCode: "US" },
      scheduledTime: { local: loc(arrMs), utc: utc(arrMs) }, revisedTime: { local: loc(arrMs), utc: utc(arrMs) } },
  }];
}

/** One cron tick where UA1503 goes from `before` to `after`; the pushes sent. */
async function tick(kv: FakeKV, before: unknown, after: unknown) {
  const pushes: { title: string; message: string }[] = [];
  const real = globalThis.fetch;
  let answer = before;
  globalThis.fetch = (async (u: string, init?: { body?: string }) => {
    if (String(u).startsWith("https://ntfy.sh")) { pushes.push(JSON.parse(init!.body!)); return new Response("ok"); }
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as never;
  try {
    const { fetchFlightStatus } = await import("./aerodatabox.ts");
    const prev = await fetchFlightStatus("test", { flightNumber: "UA1503", date: "2026-08-31" });
    await kv.put("flight:UA1503:2026-08-31", JSON.stringify(prev));
    // A check due now (checks.ts): without one, the flight is only planned.
    await kv.put("flight:UA1503:2026-08-31:sched",
      JSON.stringify({ at: new Date(Date.now() - 1000).toISOString(), rung: "a45", done: [] }));
    answer = after;
    await worker.scheduled({ scheduledTime: Date.now() } as never, env(kv));
  } finally { globalThis.fetch = real; }
  return pushes;
}

const landed = () => [adb("Expected", Date.now() - 5 * 60e3), adb("Landed", Date.now() - 5 * 60e3)] as const;

test("a landing on the run pushes", async () => {
  const kv = await seeded();
  assert.equal((await tick(kv, ...landed())).length, 1);
});

test("a check stamps every list that has the flight, moved or not", async () => {
  const kv = await seeded();
  const stamp = () => kv.data.get(`stamp:${LIST}`)!.value;
  const before = stamp();
  const same = adb("Expected", Date.now() + 3 * 3600e3);
  assert.deepEqual(await tick(kv, same, same), []);
  const checked = stamp();
  assert.notEqual(checked, before, "checked, nothing moved: the freshness line still changes");
  await tick(kv, ...landed());
  assert.notEqual(stamp(), checked);
});

test("a passenger marked not coming sends no push for their flight", async () => {
  const kv = await seeded();
  const rm = await call(kv, "POST", "/api/assignments/patches", {
    number: "369736", ref: "r1", kind: "remove", at: "1.0.0", label: "Owens, Ada", basis: (await run(kv)).importedAt,
  });
  assert.equal(rm.status, 201, JSON.stringify(rm.data));
  assert.deepEqual(await tick(kv, ...landed()), []);
});

test("a flight number corrected away sends no push for the old flight", async () => {
  const kv = await seeded();
  const fx = await call(kv, "POST", "/api/assignments/patches", {
    number: "369736", ref: "r2", at: "1.0.0", field: "flightNumber", value: "UA999", was: "UA1503",
    basis: (await run(kv)).importedAt,
  });
  assert.equal(fx.status, 201, JSON.stringify(fx.data));
  // The stub answers "landed" for any number: the corrected flight's own
  // first check says so, and the old flight, still polled, says nothing.
  const pushes = await tick(kv, ...landed());
  assert.deepEqual(pushes.map((p) => p.title), ["Call your UA999 pickup — landed"]);
  assert.ok(!JSON.stringify(pushes).includes("UA1503"));
});

test("a flight only an old flat-list job names is not looked up and never pushed: no run, no stop", async () => {
  // The flat list (the retired flight UI) could add a flight by hand, and its
  // job stood in for a stop, with a drive time and margin of its own. The
  // routes are gone; a list may still hold such a job, and its flight may
  // still be in the poll set. It is nobody's pickup on any sheet, and since
  // v69 a flight no run meets is not paid for.
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({
    flights: [{ flightNumber: "UA1503", date: "2026-08-31", driveMinutes: 90 }], topic: "curbside-test",
  }));
  await kv.put("poll:UA1503:2026-08-31", JSON.stringify({ flightNumber: "UA1503", date: "2026-08-31" }));
  await kv.put("flight:UA1503:2026-08-31:trackers", JSON.stringify([LIST]));
  assert.deepEqual(await tick(kv, ...landed()), []);
  assert.equal(JSON.parse(kv.data.get("flight:UA1503:2026-08-31")!.value).status, "Expected", "no check was made");
  assert.equal(JSON.parse(kv.data.get(`list:${LIST}`)!.value).flights.length, 1, "the old job is left where it is");
});

test("a check that moves a flight keeps no history: nothing reads one any more", async () => {
  const kv = await seeded();
  assert.equal((await tick(kv, ...landed())).length, 1);
  assert.deepEqual(kv.keys("flight:UA1503:2026-08-31:history"), []);
  // One an older Worker wrote goes with the flight, when the last run that meets it does.
  await kv.put("flight:UA1503:2026-08-31:history", JSON.stringify([{ at: "2026-08-31T20:00:00Z", changes: ["x"] }]));
  assert.equal((await call(kv, "DELETE", "/api/assignments", { number: "369736" })).status, 200);
  assert.deepEqual(kv.keys("flight:UA1503:2026-08-31"), [], "status, schedule, trackers, history: all gone");
});

test("an estimate creeping 4 minutes a poll is pushed once it has moved 8", async () => {
  const kv = await seeded();
  const t = Date.now() + 3 * 3600e3;
  const step = (m: number) => adb("Expected", t - m * 60e3);
  assert.deepEqual(await tick(kv, step(0), step(4)), [], "4 minutes is not worth a buzz");
  const pushes = await tick(kv, step(4), step(8));
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /8 minutes earlier/);
  assert.deepEqual(await tick(kv, step(8), step(12)), [], "measured from the push, not from the start");
});

test("a long note in another alphabet saves (metadata is sized in bytes)", async () => {
  const kv = await seeded();
  const note = "请在行李提取处等候，我会带一个小推车。".repeat(20).slice(0, 300);
  const r = await call(kv, "POST", "/api/assignments/patches", {
    number: "369736", ref: "r5", at: "1.0.0", field: "note", value: note, was: null,
    basis: (await run(kv)).importedAt,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await run(kv)).steps[1].actions[0].entities[0].note, note);
});

test("AeroDataBox: the instance at our airport on the date asked for, not simply the first", async () => {
  const { pickFlight } = await import("./aerodatabox.ts");
  const leg = (iata: string, local: string) => ({ airport: { name: iata, iata }, scheduledTime: { local, utc: "" } });
  const legOne = { departure: leg("MDW", "2026-08-31 14:00-05:00"), arrival: leg("STL", "2026-08-31 15:10-05:00") };
  const legTwo = { departure: leg("STL", "2026-08-31 16:00-05:00"), arrival: leg("LGA", "2026-08-31 19:40-04:00") };
  assert.equal(pickFlight([legOne, legTwo], "2026-08-31"), legTwo);
  const yesterdays = { departure: leg("LHR", "2026-08-30 20:00+01:00"), arrival: leg("JFK", "2026-08-30 23:10-04:00") };
  const todays = { departure: leg("JFK", "2026-08-31 21:00-04:00"), arrival: leg("LHR", "2026-09-01 09:00+01:00") };
  assert.equal(pickFlight([yesterdays, todays], "2026-08-31"), todays);
  assert.equal(pickFlight([legOne], "2026-08-31"), legOne, "nothing better: the first");
});

/* ---- flight checks on the free plan (checks.ts) ---- */

const SCHED = "flight:UA1503:2026-08-31:sched";
/** What the last check said: landing at `arrMs`. */
async function known(kv: FakeKV, arrMs: number) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(adb("Expected", arrMs)))) as never;
  try {
    const { fetchFlightStatus } = await import("./aerodatabox.ts");
    await kv.put("flight:UA1503:2026-08-31", JSON.stringify(await fetchFlightStatus("test", { flightNumber: "UA1503", date: "2026-08-31" })));
  } finally { globalThis.fetch = real; }
}
const dueCheck = (kv: FakeKV, rung = "a45") =>
  kv.put(SCHED, JSON.stringify({ at: new Date(Date.now() - 1000).toISOString(), rung, done: [] }));

/** One cron tick; AeroDataBox answers `answer` with `init`. Its calls, counted. */
async function cron(kv: FakeKV, answer: unknown = [], init: ResponseInit = {}) {
  let lookups = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    if (String(u).startsWith("https://ntfy.sh")) return new Response("ok");
    lookups++;
    return new Response(JSON.stringify(answer), { status: 200, ...init });
  }) as never;
  try { await worker.scheduled({ scheduledTime: Date.now() } as never, env(kv)); }
  finally { globalThis.fetch = real; }
  return lookups;
}
const budget = async (kv: FakeKV) => JSON.parse((await kv.get("adb:budget")) ?? "null");
const checks = async (kv: FakeKV) => (await call(kv, "GET", "/api/assignments")).data.flightChecks;

test("importing a run costs no lookup: the first check is planned from the sheet's time", async () => {
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [], topic: "curbside-test" }));
  const day = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
  const r = await call(kv, "POST", "/api/assignments", {
    number: "369737", start: `${day} 13:00`, end: `${day} 18:00`, printedAt: "2026-09-27 17:00",
    steps: [{ code: "LGA", place: "LaGuardia", eta: "3:00 PM", etd: "4:00 PM", date: day, etaDate: day,
      actions: [{ verb: "Pickup", where: "Claim", entities: [
        { name: "Owens, Ada", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: day, scheduledText: "3:39 PM ORD - Chicago" },
      ] }] }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await cron(kv), 0, "no lookup at import");
  const plan = JSON.parse((await kv.get(`flight:UA1503:${day}:sched`))!);
  assert.equal(plan.rung, "a3h");
  assert.equal(Date.parse(plan.at), Date.parse(`${day}T19:39:00Z`) - 3 * 3600e3, "3h before the printed 3:39 PM EDT");
  const view = await checks(kv);
  assert.equal(view.state, "ok");
  assert.equal(view.left, 200, "400 units, 2 a lookup");
});

test("a lookup is counted, with RapidAPI's own figure when it gives one", async () => {
  const kv = await seeded();
  await dueCheck(kv);
  const n = await cron(kv, adb("Expected", Date.now() + 40 * 60e3), { headers: { "x-ratelimit-units-remaining": "150" } });
  assert.equal(n, 1);
  const b = await budget(kv);
  assert.equal(b.spent, 2);
  assert.equal(b.remaining, 150);
  assert.equal(JSON.parse((await kv.get(SCHED))!).rung, "a15", "next: after landing");
});

test("with the month's units spent, no lookup, and the app is told until when", async () => {
  const kv = await seeded();
  await known(kv, Date.now() + 40 * 60e3);
  await dueCheck(kv);
  await kv.put("adb:budget", JSON.stringify({ period: new Date().toISOString().slice(0, 7), spent: 396 }));
  assert.equal(await cron(kv), 0);
  assert.equal(readPlanRung(await kv.get(SCHED)), "a15", "the skipped check is passed, not retried every tick");
  const c = await checks(kv);
  assert.equal(c.state, "paused");
  assert.match(c.until, /^\d{4}-\d{2}-01T00:00:00/);
});

test("a quota refusal (429) pauses the checks at once", async () => {
  const kv = await seeded();
  await dueCheck(kv);
  assert.equal(await cron(kv, { message: "quota" }, { status: 429 }), 1);
  const b = await budget(kv);
  assert.equal(b.spent, 0, "a refusal is not charged");
  assert.equal(b.remaining, 0);
  assert.equal((await checks(kv)).state, "paused");
});

test("when KV takes no write, the tick looks nothing up: a lookup it cannot record is paid for again every tick", async () => {
  const kv = await seeded();
  await known(kv, Date.now() + 40 * 60e3);
  await dueCheck(kv);
  const answer = adb("Expected", Date.now() + 40 * 60e3);
  kv.full = true;
  const realError = console.error;
  const said: string[] = [];
  console.error = (...words: unknown[]) => { said.push(words.map(String).join(" ")); };
  try {
    assert.equal(await cron(kv, answer), 0, "no unit spent");
    assert.equal(await cron(kv, answer), 0, "nor at the next tick");
    assert.ok(said.some((s) => /no flight is looked up/.test(s)), "and the log says why");
  } finally { console.error = realError; }
  assert.equal(JSON.parse((await kv.get(SCHED))!).rung, "a45", "the check still waits");

  // Writes are back: the check that waited is made, once, and counted once.
  kv.full = false;
  assert.equal(await cron(kv, answer), 1);
  assert.equal((await budget(kv)).spent, 2, "not as reserved plus made");
  assert.equal(JSON.parse((await kv.get(SCHED))!).rung, "a15");
});

test("a lookup AeroDataBox never answers is given up on: a failed lookup, not a tick that never ends", async () => {
  const real = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal!.reason));
  })) as never;
  try {
    const { fetchFlightStatus } = await import("./aerodatabox.ts");
    const lookup = (fetchFlightStatus as (...a: unknown[]) => Promise<unknown>)(
      "test", { flightNumber: "UA1503", date: "2026-08-31" }, undefined, 20);
    const outcome = await Promise.race([
      lookup.then(() => "answered", () => "gave up"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 400)),
    ]);
    assert.equal(outcome, "gave up");
    assert.ok(signal, "the fetch carries the signal that ends it");
  } finally { globalThis.fetch = real; }
});

test("AeroDataBox: a status that is not text is kept as Unknown, never as whatever arrived", async () => {
  const real = globalThis.fetch;
  const odd = adb("Expected", Date.now() + 40 * 60e3);
  (odd[0] as { status: unknown }).status = { html: "<b>late</b>" };
  globalThis.fetch = (async () => new Response(JSON.stringify(odd))) as never;
  try {
    const { fetchFlightStatus } = await import("./aerodatabox.ts");
    const status = await fetchFlightStatus("test", { flightNumber: "UA1503", date: "2026-08-31" });
    assert.equal(status!.status, "Unknown");
  } finally { globalThis.fetch = real; }
});

test("a lookup that fails is tried once more, then that check is passed: the flight is never given up for an error", async () => {
  const kv = await seeded();
  await known(kv, Date.now() + 40 * 60e3);
  await dueCheck(kv);
  const realError = console.error;
  console.error = () => {};
  try {
    // AeroDataBox is down: the check before landing is the one worth a retry.
    assert.equal(await cron(kv, { message: "down" }, { status: 503 }), 1);
    let plan = JSON.parse((await kv.get(SCHED))!);
    assert.equal(plan.rung, "a45", "the same check, at the next tick");
    assert.equal(plan.miss, 1);
    assert.ok(Date.parse(plan.at) <= Date.now(), "still due");
    // Down again: this check is passed, and the landing is still looked for.
    assert.equal(await cron(kv, { message: "down" }, { status: 503 }), 1);
    plan = JSON.parse((await kv.get(SCHED))!);
    assert.equal(plan.rung, "a15");
    assert.equal(plan.miss ?? 0, 0, "an error is not a flight nobody knows");
    // Back up before the retry: the check is made, and the count starts again.
    await dueCheck(kv);
    await cron(kv, { message: "down" }, { status: 503 });
    assert.equal(await cron(kv, adb("Expected", Date.now() + 40 * 60e3)), 1);
    assert.equal(JSON.parse((await kv.get(SCHED))!).rung, "a15");
  } finally { console.error = realError; }
});

test("a flight AeroDataBox does not know is still given up after two lookups", async () => {
  const kv = await seeded();
  await known(kv, Date.now() + 4 * 3600e3);
  await kv.put(SCHED, JSON.stringify({ at: new Date(Date.now() - 1000).toISOString(), rung: "a3h", done: [] }));
  assert.equal(await cron(kv, [], { status: 404 }), 1);
  const plan = JSON.parse((await kv.get(SCHED))!);
  assert.equal(plan.miss, 1);
  assert.notEqual(plan.rung, "a3h", "that check is spent");
  await kv.put(SCHED, JSON.stringify({ ...plan, at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(await cron(kv, [], { status: 404 }), 1);
  assert.equal(await kv.get(SCHED), "done");
});

function readPlanRung(raw: string | null) {
  return raw && raw[0] === "{" ? JSON.parse(raw).rung : raw;
}

test("the 08:00 clean-up stamps each list that lost a run, and only those", async () => {
  const kv = await seeded();
  await kv.put("list:feed0003", JSON.stringify({ flights: [], topic: "curbside-other" }));
  await kv.delete(`stamp:${LIST}`);
  assert.equal(kv.keys(`assign:${LIST}`).length, 1);
  const today = new Date();
  const eight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 5);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as never;
  try { await worker.scheduled({ scheduledTime: eight } as never, env(kv)); }
  finally { globalThis.fetch = real; }
  assert.deepEqual(kv.keys(`assign:${LIST}`), [], "the run ended over a week ago");
  assert.ok(kv.data.has(`stamp:${LIST}`), "its phones see it gone within a minute");
  assert.equal(kv.data.has("stamp:feed0003"), false);
});

/* ---------------------------------------------- alerts in the app (v66) -- */

/** A tick where UA1503 lands, with push keys set, a phone on the list or not,
 *  and ntfy.sh refusing for its daily limit: production as found 2026-10-02. */
async function landingWithNtfyFull(phoneOn: boolean) {
  const kv = await seeded();
  const { b64u } = await import("./webpush.ts");
  const pair = async () => {
    const p = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    return {
      pub: b64u(await crypto.subtle.exportKey("raw", p.publicKey) as ArrayBuffer),
      d: (await crypto.subtle.exportKey("jwk", p.privateKey) as { d: string }).d,
    };
  };
  const server = await pair(), phone = await pair();
  const endpoint = "https://web.push.apple.com/phone-one";
  if (phoneOn) {
    await kv.put("push:curbside-test", JSON.stringify([
      { endpoint, p256dh: phone.pub, auth: b64u(new Uint8Array(16)), at: "2026-10-02T12:00:00.000Z" }]));
  }
  const sent: string[] = [];
  const real = globalThis.fetch, realError = console.error, realLog = console.log;
  const lines: string[] = [];
  console.error = () => {};
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const [before, after] = landed();
  let answer: unknown = before;
  globalThis.fetch = (async (u: string) => {
    const url = String(u);
    if (url.startsWith("https://ntfy.sh")) { sent.push("ntfy"); return new Response('{"code":42908}', { status: 429 }); }
    if (url === endpoint) { sent.push("phone"); return new Response(null, { status: 201 }); }
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as never;
  try {
    const { fetchFlightStatus } = await import("./aerodatabox.ts");
    const prev = await fetchFlightStatus("test", { flightNumber: "UA1503", date: "2026-08-31" });
    await kv.put("flight:UA1503:2026-08-31", JSON.stringify(prev));
    await kv.put("flight:UA1503:2026-08-31:sched",
      JSON.stringify({ at: new Date(Date.now() - 1000).toISOString(), rung: "a45", done: [] }));
    answer = after;
    await worker.scheduled({ scheduledTime: Date.now() } as never,
      { FLIGHT_DATA: kv, AERODATABOX_KEY: "test", VAPID_PUBLIC: server.pub, VAPID_PRIVATE: server.d } as never);
  } finally { globalThis.fetch = real; console.error = realError; console.log = realLog; }
  const told = JSON.parse((await kv.get("flight:UA1503:2026-08-31:told"))!);
  return { sent: sent.sort(), told: told.status as string, line: lines.find((l) => l.startsWith("Checks:")) ?? "" };
}

test("a flight alert reaches a phone with alerts on though ntfy refuses it, and the driver counts as told (v66)", async () => {
  const on = await landingWithNtfyFull(true);
  assert.deepEqual(on.sent, ["ntfy", "phone"]);
  assert.equal(on.told, "Landed", "the next change is measured from this one");
  assert.match(on.line, /1 push\(es\) sent \(1 to phones, 0 by ntfy\), 0 taken by nothing/);
});

test("with no phone on the list and ntfy refusing, the driver was told nothing, and the next change still adds to this one", async () => {
  const off = await landingWithNtfyFull(false);
  assert.deepEqual(off.sent, ["ntfy"]);
  assert.equal(off.told, "Expected");
  assert.match(off.line, /0 push\(es\) sent \(0 to phones, 0 by ntfy\), 1 taken by nothing/);
});

/* ---- a flight's first check: nothing is stored to compare it with ---- */

/** AeroDataBox's answer with the timetable (`schedMs`) and the estimate apart. */
function adbAt(status: string, schedMs: number, estMs: number) {
  const [a] = adb(status, schedMs);
  return [{ ...a, arrival: { ...a.arrival, revisedTime: adb(status, estMs)[0].arrival.scheduledTime } }];
}

/**
 * The run as imported the evening before: its flight tracked, never looked
 * up. One tick makes the first check, which finds `answer`. The pushes, and
 * how many list() calls the tick made (the 1,000 a day).
 */
async function firstCheck(answer: unknown, again?: unknown) {
  const kv = await seeded();
  assert.equal(await kv.get("flight:UA1503:2026-08-31"), null, "an import looks nothing up");
  const due = () => kv.put(SCHED, JSON.stringify({ at: new Date(Date.now() - 1000).toISOString(), rung: "a3h", done: [] }));
  await due();
  const pushes: { title: string; message: string; priority: number }[] = [];
  let lists = 0;
  const list = kv.list.bind(kv);
  kv.list = (async (o: { prefix?: string }) => { lists++; return list(o); }) as never;
  const real = globalThis.fetch;
  let now = answer;
  globalThis.fetch = (async (u: string, init?: { body?: string }) => {
    if (String(u).startsWith("https://ntfy.sh")) { pushes.push(JSON.parse(init!.body!)); return new Response("ok"); }
    return new Response(JSON.stringify(now), { status: 200 });
  }) as never;
  // Noon UTC: not the tick that runs the retention sweep.
  const noon = { scheduledTime: Date.UTC(2026, 9, 3, 12, 0) } as never;
  try {
    await worker.scheduled(noon, env(kv));
    const first = { pushes: pushes.length, lists };
    if (again !== undefined) {
      now = again;
      await due();
      await worker.scheduled(noon, env(kv));
    }
    return { kv, pushes, first };
  } finally { globalThis.fetch = real; }
}

test("a flight already late at its first check says so, measured from its timetable", async () => {
  const sched = Date.now() + 3 * 3600e3;
  const late = adbAt("Expected", sched, sched + 90 * 60e3);
  const { kv, pushes, first } = await firstCheck(late, late);
  assert.equal(first.pushes, 1, "the check before leaving is the one that says a delay");
  assert.equal(first.lists, 3, "the push is written from the runs already read: no second look");
  assert.equal(pushes[0].title, "Leave 90 minutes later");
  assert.match(pushes[0].message, /UA1503 now lands .* · leave by .*, dispatch planned 9:30p/);
  assert.equal(pushes[0].priority, 3, "a delay is calm");
  // Told once: the same news at the next check says nothing more.
  assert.equal(pushes.length, 1);
  const told = JSON.parse((await kv.get("flight:UA1503:2026-08-31:told"))!);
  assert.equal(Date.parse(told.arrival.estimatedTimeUtc), Math.floor((sched + 90 * 60e3) / 60e3) * 60e3);
});

test("a flight early at its first check is urgent", async () => {
  const sched = Date.now() + 3 * 3600e3;
  const { pushes } = await firstCheck(adbAt("Expected", sched, sched - 40 * 60e3));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "Leave 40 minutes earlier");
  assert.equal(pushes[0].priority, 5);
});

test("a flight cancelled before its first check is told, not dropped in silence", async () => {
  const sched = Date.now() + 3 * 3600e3;
  const { kv, pushes } = await firstCheck(adbAt("Canceled", sched, sched));
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /^Call dispatch — UA1503 cancelled$/);
  assert.equal(await kv.get(SCHED), "done", "and nothing more is spent on it");
});

test("a run imported after its flight landed hears it once", async () => {
  const at = Date.now() - 5 * 60e3;
  const down = adbAt("Landed", at, at);
  const { pushes } = await firstCheck(down, down);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /^Call your UA1503 pickup — landed$/);
});

test("a flight on time at its first check says nothing; the list's runs are read once, to ask who meets it", async () => {
  const sched = Date.now() + 3 * 3600e3;
  const { kv, pushes, first } = await firstCheck(adbAt("Expected", sched, sched + 4 * 60e3));
  assert.deepEqual(pushes, [], "4 minutes off the timetable is noise");
  assert.equal(first.lists, 3, "the poll set, then the list's runs and their corrections (v69), and nothing else");
  // What the driver knows so far is the timetable: a later creep adds to it.
  const told = JSON.parse((await kv.get("flight:UA1503:2026-08-31:told"))!);
  assert.equal(told.arrival.estimatedTimeUtc, null);
  assert.equal(Date.parse(told.arrival.scheduledTimeUtc), Math.floor(sched / 60e3) * 60e3);
});

test("the timetable is what a first check is measured from; later ones add to what was said", async () => {
  const sched = Date.now() + 3 * 3600e3;
  // 4 minutes late at first (nothing said), 7 minutes late at the next: said,
  // as 7 from the timetable, not as 3 from the last look.
  const { pushes } = await firstCheck(adbAt("Expected", sched, sched + 4 * 60e3), adbAt("Expected", sched, sched + 7 * 60e3));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "Leave 7 minutes later");
});

/* ------------------- v69: who meets the flight is asked before a unit is spent -- */

const POLL = "poll:UA1503:2026-08-31";
const TRACKERS = "flight:UA1503:2026-08-31:trackers";
const planOf = async (kv: FakeKV) => JSON.parse((await kv.get(SCHED))!);

/**
 * One tick at noon UTC (never the clean-up's), AeroDataBox answering `answer`
 * for any flight: the flights looked up, the pushes, and the list() calls.
 */
async function asked(kv: FakeKV, answer: unknown = []) {
  const lookups: string[] = [];
  const pushes: { title: string }[] = [];
  let lists = 0;
  const list = kv.list;
  kv.list = (async (o: { prefix?: string }) => { lists++; return list.call(kv, o); }) as never;
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string, init?: { body?: string }) => {
    if (String(u).startsWith("https://ntfy.sh")) { pushes.push(JSON.parse(init!.body!)); return new Response("ok"); }
    lookups.push(decodeURIComponent(String(u).split("/flights/number/")[1].split(/[/?]/)[0]));
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as never;
  try { await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 3, 12, 0) } as never, env(kv)); }
  finally { globalThis.fetch = real; kv.list = list; }
  return { lookups, pushes, lists };
}

/** Owens, Ada is not coming: the run's one flight is nobody's pickup. */
async function notComing(kv: FakeKV, number = "369736") {
  const rm = await call(kv, "POST", "/api/assignments/patches", {
    number, ref: `rm-${number}`, kind: "remove", at: "1.0.0", label: "Owens, Ada", basis: (await run(kv)).importedAt,
  });
  assert.equal(rm.status, 201, JSON.stringify(rm.data));
  return rm.data.patch.id as string;
}

test("a flight nobody meets costs no lookup: asked at two ticks running, then its check is passed", async () => {
  const kv = await seeded();
  await notComing(kv);
  const arr = Date.now() + 40 * 60e3;
  await known(kv, arr);
  await dueCheck(kv);

  const one = await asked(kv, adb("Expected", arr));
  assert.deepEqual(one.lookups, [], "no unit for a pickup that is not happening");
  assert.equal(one.lists, 3, "the poll set, then the list's runs and their corrections");
  assert.deepEqual([(await planOf(kv)).rung, (await planOf(kv)).unmet], ["a45", 1],
    "asked once: still due, in case the list was read in the middle of a change");

  const two = await asked(kv, adb("Expected", arr));
  assert.deepEqual(two.lookups, []);
  assert.deepEqual([(await planOf(kv)).rung, (await planOf(kv)).unmet], ["a15", undefined],
    "the 45-minute check is passed; the one after landing is still planned");
  assert.ok(kv.data.has(POLL) && kv.data.has(TRACKERS), "still tracked: an UNDO finds the flight as it was");
  assert.equal(JSON.parse((await kv.get("flight:UA1503:2026-08-31"))!).status, "Expected");
});

test("with the month's units spent nothing is looked up, so no list is read to ask who meets a flight", async () => {
  const kv = await seeded();
  await notComing(kv);
  await known(kv, Date.now() + 40 * 60e3);
  await dueCheck(kv);
  await kv.put("adb:budget", JSON.stringify({ period: new Date().toISOString().slice(0, 7), spent: 400 }));
  const r = await asked(kv);
  assert.deepEqual([r.lookups, r.lists], [[], 1], "the poll set alone");
  assert.equal((await planOf(kv)).unmet, undefined, "held for the budget, as any check is");
});

test("when KV takes no write, a flight nobody meets stays due and the tick still ends", async () => {
  const kv = await seeded();
  await notComing(kv);
  await known(kv, Date.now() + 40 * 60e3);
  await dueCheck(kv);
  kv.full = true;
  const errors: unknown[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try { assert.deepEqual((await asked(kv)).lookups, []); } finally { console.error = real; kv.full = false; }
  assert.equal(errors.length, 1);
  assert.deepEqual([(await planOf(kv)).rung, (await planOf(kv)).unmet], ["a45", undefined], "asked about again at the next tick");
});

test("a passenger back on the run before the check is checked as ever", async () => {
  const kv = await seeded();
  const id = await notComing(kv);
  const arr = Date.now() + 40 * 60e3;
  await known(kv, arr);
  await dueCheck(kv);
  assert.deepEqual((await asked(kv, adb("Expected", arr))).lookups, []);

  assert.equal((await call(kv, "DELETE", "/api/assignments/patches", { number: "369736", id })).status, 200);
  const back = await asked(kv, adb("Expected", arr));
  assert.deepEqual(back.lookups, ["UA1503"]);
  assert.deepEqual([(await planOf(kv)).rung, (await planOf(kv)).unmet], ["a15", undefined]);
});

test("when no check is left for a flight nobody meets, it is let go; an UNDO tracks it again", async () => {
  const kv = await seeded();
  const id = await notComing(kv);
  await known(kv, Date.now() - 20 * 60e3);
  await dueCheck(kv, "a15");
  await kv.put("flight:UA1503:2026-08-31:told", "{}");

  assert.deepEqual((await asked(kv)).lookups, []);
  assert.ok(kv.data.has(POLL), "asked once: nothing is let go on one look");
  assert.deepEqual((await asked(kv)).lookups, []);
  assert.deepEqual(kv.keys("flight:UA1503"), [], "its status, its plan, what was told and who tracked it");
  assert.deepEqual(kv.keys("poll:"), [], "and no tick reads it again");

  assert.equal((await call(kv, "DELETE", "/api/assignments/patches", { number: "369736", id })).status, 200);
  assert.ok(kv.data.has(POLL), "polled again");
  assert.deepEqual(JSON.parse((await kv.get(TRACKERS))!), [LIST]);
});

test("a flight another run on the list still meets is looked up", async () => {
  const kv = await seeded();
  const twin = await call(kv, "POST", "/api/assignments", {
    number: "369738", start: "2026-08-31 22:00", end: "2026-09-01 03:00", printedAt: "2026-08-30 17:00",
    steps: [{ code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM", date: "2026-09-01", etaDate: "2026-08-31",
      actions: [{ verb: "Pickup", where: "Claim", entities: [
        { name: "Reyes, Sol", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: "2026-08-31" },
      ] }] }],
  });
  assert.equal(twin.status, 200, JSON.stringify(twin.data));
  await notComing(kv);
  const arr = Date.now() + 40 * 60e3;
  await known(kv, arr);
  await dueCheck(kv);
  assert.deepEqual((await asked(kv, adb("Expected", arr))).lookups, ["UA1503"]);
});

test("a flight corrected away costs nothing; the one it was corrected to is looked up", async () => {
  const kv = await seeded();
  const fx = await call(kv, "POST", "/api/assignments/patches", {
    number: "369736", ref: "fx1", at: "1.0.0", field: "flightNumber", value: "UA999", was: "UA1503",
    basis: (await run(kv)).importedAt,
  });
  assert.equal(fx.status, 201, JSON.stringify(fx.data));
  await known(kv, Date.now() + 40 * 60e3);
  await dueCheck(kv);
  const r = await asked(kv, adb("Landed", Date.now() - 5 * 60e3));
  assert.deepEqual(r.lookups, ["UA999"]);
  assert.deepEqual(r.pushes.map((p) => p.title), ["Call your UA999 pickup — landed"]);
});

test("a flight a re-sent sheet dropped costs nothing", async () => {
  const kv = await seeded();
  const again = await call(kv, "POST", "/api/assignments", {
    number: "369736", start: "2026-08-31 21:30", end: "2026-09-01 03:00", printedAt: "2026-08-30 19:00",
    steps: [
      { code: "WRK", place: "Warwick", eta: null, etd: "9:30 PM", date: "2026-08-31", etaDate: "2026-08-31", actions: [] },
      { code: "LGA", place: "LaGuardia", eta: "11:00 PM", etd: "12:00 AM", date: "2026-09-01", etaDate: "2026-08-31",
        actions: [{ verb: "Pickup", where: "Claim", entities: [
          { name: "Owens, Ada", pax: 1, tag: "A", flightNumber: "DL88", flightDate: "2026-08-31" },
        ] }] },
    ],
  });
  assert.equal(again.data.applied, true, JSON.stringify(again.data));
  const arr = Date.now() + 40 * 60e3;
  await known(kv, arr);
  await dueCheck(kv);
  await kv.put("flight:DL88:2026-08-31:sched", "done");
  assert.deepEqual((await asked(kv, adb("Expected", arr))).lookups, []);
  assert.deepEqual((await asked(kv, adb("Expected", arr))).lookups, []);
  assert.equal((await planOf(kv)).rung, "a15");
});

test("a re-sent sheet that moves a flight's printed time plans its first check again, until a check has been made", async () => {
  const kv = new FakeKV();
  await kv.put(`list:${LIST}`, JSON.stringify({ flights: [], topic: "curbside-test" }));
  const day = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
  const send = (printedAt: string, printed: string) => call(kv, "POST", "/api/assignments", {
    number: "369737", start: `${day} 13:00`, end: `${day} 18:00`, printedAt,
    steps: [{ code: "LGA", place: "LaGuardia", eta: "3:00 PM", etd: "4:00 PM", date: day, etaDate: day,
      actions: [{ verb: "Pickup", where: "Claim", entities: [
        { name: "Owens, Ada", pax: 1, tag: "A", flightNumber: "UA1503", flightDate: day, scheduledText: printed },
      ] }] }],
  });
  const sched = `flight:UA1503:${day}:sched`;
  const at = async () => Date.parse(JSON.parse((await kv.get(sched))!).at);
  const H3 = 3 * 3600e3;

  assert.equal((await send("2026-09-27 17:00", "3:39 PM ORD - Chicago")).status, 200);
  assert.equal(await cron(kv), 0);
  assert.equal(await at(), Date.parse(`${day}T19:39:00Z`) - H3);

  // Dispatch re-sends the run: the passenger is on the 1:39 PM now.
  const again = await send("2026-09-27 19:00", "1:39 PM ORD - Chicago");
  assert.equal(again.data.applied, true, JSON.stringify(again.data));
  assert.equal(await at(), Date.parse(`${day}T17:39:00Z`) - H3, "three hours before the new time, not the old");
  assert.equal((kv.data.get(`poll:UA1503:${day}`)!.metadata as { t: string }).t, `${day}T17:39:00.000Z`);

  // Once AeroDataBox has answered, its times plan the checks: a sheet's no longer do.
  await kv.put(`flight:UA1503:${day}`, JSON.stringify({ status: "Expected" }));
  const planned = await kv.get(sched);
  assert.equal((await send("2026-09-27 20:00", "5:39 PM ORD - Chicago")).data.applied, true);
  assert.equal(await kv.get(sched), planned);
});
