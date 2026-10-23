/**
 * The Copilot Studio build kit (copilot-studio/) says what the app does, to a
 * department that rebuilds it without this code. A kit that drifts from the
 * code builds the wrong app, so it is held to the code here: the generated
 * files must be what tools/kit.mjs makes now, the numbers in the rules must be
 * the constants, the samples must read as their answers and fit the schema.
 *
 *   node --test --experimental-strip-types src/kit.test.ts
 *
 * After a change to the clocks, the alerts or the reader: `node tools/kit.mjs`,
 * read `git diff copilot-studio/`, commit both together.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  NAME_SWAPS, alertExamplesMd, fixtureNames, samples, swapNames, testRows, testSetCsv,
} from "../../tools/kit.mjs";
import { goldenJson } from "../../tools/golden.mjs";
import { readSheet } from "../../public/importer/index.js";

const ROOT = new URL("../../", import.meta.url);
const KIT = new URL("copilot-studio/", ROOT);
const lf = (s: string) => s.replace(/\r\n?/g, "\n");
const kit = (path: string) => lf(readFileSync(new URL(path, KIT), "utf8"));
const source = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

/** Runs of spaces as one, so a made PDF's wider spacing does not count. */
function spaced(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/ {2,}/g, " ");
  if (Array.isArray(v)) return v.map(spaced);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "source").map(([k, x]) => [k, spaced(x)]));
  }
  return v;
}

// ---------------------------------------------------------------- samples

test("kit samples: one PDF and one answer per fixture, as tools/kit.mjs makes them", () => {
  const made = samples();
  assert.equal(made.length, fixtureNames().length);
  assert.ok(made.length >= 15);
  for (const s of made) {
    const pdf = readFileSync(new URL(`samples/${s.name}.pdf`, KIT));
    assert.ok(Buffer.compare(pdf, Buffer.from(s.pdf)) === 0, `${s.name}.pdf is stale: run node tools/kit.mjs`);
    assert.equal(kit(`samples/${s.name}.json`), goldenJson(s.assignment), `${s.name}.json is stale`);
  }
  const files = readdirSync(new URL("samples/", KIT)).filter((n) => !n.startsWith("."));
  assert.equal(files.length, made.length * 2, "a sample with no fixture behind it");
});

test("kit samples: each committed PDF reads as its committed answer, and as its fixture's", () => {
  for (const name of fixtureNames()) {
    const read = readSheet(readFileSync(new URL(`samples/${name}.pdf`, KIT)), `${name}.pdf`);
    assert.ok(read.ok, name);
    const answer = JSON.parse(kit(`samples/${name}.json`));
    assert.deepEqual(JSON.parse(goldenJson(read.assignment)), answer, name);
    const golden = JSON.parse(swapNames(source(`tools/fixtures/${name}.json`)));
    assert.deepEqual(spaced(answer), spaced(golden), `${name} reads differently from its fixture`);
  }
});

test("kit samples: the owner's own name is in none of them", () => {
  for (const name of fixtureNames()) {
    const json = kit(`samples/${name}.json`).toLowerCase();
    const text = readSheet(readFileSync(new URL(`samples/${name}.pdf`, KIT)), "x.pdf").text.toLowerCase();
    for (const [real] of NAME_SWAPS) {
      assert.ok(!json.includes(real.toLowerCase()) && !text.includes(real.toLowerCase()), `${name}: ${real}`);
    }
  }
});

/** The few JSON Schema rules assignment.schema.json uses. */
function check(schema: any, value: unknown, path: string, errors: string[]): void {
  const types: string[] = [].concat(schema.type ?? []);
  const typeOf = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array"
    : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
  const t = typeOf(value);
  if (types.length && !types.includes(t) && !(t === "integer" && types.includes("number"))) {
    errors.push(`${path}: ${t}, wanted ${types.join("|")}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} fails ${schema.pattern}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (t === "array" && schema.items) (value as unknown[]).forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errors));
  if (t === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errors.push(`${path}: no ${r}`);
    for (const [k, v] of Object.entries(obj)) {
      if (schema.properties[k]) check(schema.properties[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: ${k} is not in the schema`);
    }
  }
}

test("kit schema: every sample fits assignment.schema.json, and the checker can fail", () => {
  const schema = JSON.parse(kit("assignment.schema.json"));
  for (const name of fixtureNames()) {
    const errors: string[] = [];
    check(schema, JSON.parse(kit(`samples/${name}.json`)), name, errors);
    assert.deepEqual(errors, [], name);
  }
  const bad: string[] = [];
  check(schema, { number: "x1", start: "today", steps: [{ place: 1, mystery: true }] }, "bad", bad);
  assert.ok(bad.length >= 5, bad.join("; "));
});

// ------------------------------------------------------------ test set

test("kit test set: what tools/kit.mjs makes, in the shape Copilot Studio imports", () => {
  const csv = kit("test-set.csv");
  assert.equal(csv, testSetCsv(), "test-set.csv is stale: run node tools/kit.mjs");
  assert.equal(csv.split("\n")[0], "Question,Expected response");
  const rows = testRows();
  assert.ok(rows.length >= 30 && rows.length <= 100, `${rows.length} rows (Copilot Studio takes 100)`);
  for (const [q, a] of rows) {
    assert.ok(q.length <= 1000, `question over 1,000 characters: ${q.slice(0, 40)}`);
    assert.ok(a.length > 20 && !/undefined|null|NaN/.test(a), `answer: ${a.slice(0, 80)}`);
  }
  assert.equal(new Set(rows.map(([q]) => q)).size, rows.length, "a question twice");
});

test("kit test set: the clock answers are the code's (369736 at LGA, on time and slipped)", () => {
  const by = (start: string) => testRows().find(([q]) => q.startsWith(start))![1];
  assert.match(by("Run 369736: UA1503 is due"), /^Parked by 11:00p: UA1503 lands first, 11:15p, less 15 minutes\. Leaving at 12:05a: WN748/);
  assert.match(by("Run 369736: UA1503 slipped"), /^Parked by 11:05p: WN748 .* Leaving at 12:26a: UA1503/);
  assert.match(by("Run 352711"), /Parked by 5:25p.*30 minutes.*Leaving at 7:40p.*105 minutes/);
  assert.match(by("Run 348400: UA1068 is now delayed"), /^Parked by 11:55a: .*still counts from 1:55p/);
});

test("kit alerts: alert-examples.md is what noticeFor says now", () => {
  const md = kit("alert-examples.md");
  assert.equal(md, alertExamplesMd(), "alert-examples.md is stale: run node tools/kit.mjs");
  assert.ok(md.includes("**Title:** Wait 32 minutes longer at LGA"));
  assert.ok(md.includes("**No alert.**"));
  assert.ok(md.includes("tagged GOVERNING BODY"));
});

// ------------------------------------------------------- numbers in the rules

/** `| what | 15 min | \`BUFFER_MIN\` |` rows: the number and the constant. */
function tableConstants(md: string): [string, number][] {
  return [...md.matchAll(/^\|[^|\n]*\|\s*(\d[\d,]*)(?: min)?\s*\|\s*`([A-Z_]+)`\s*\|$/gm)]
    .map((m) => [m[2], Number(m[1].replaceAll(",", ""))]);
}

function constantIn(src: string, name: string): number | null {
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) return null;
  const minutes = m[1].replace(/\bHOUR\b/g, "60").replace(/\bMIN\b/g, "1").replace(/_/g, "");
  if (!/^[\d\s*+\-()]+$/.test(minutes)) throw new Error(`${name} = ${m[1]}: not a plain number`);
  return Function(`return (${minutes});`)();
}

test("kit rules: two-clocks.md's table is notify.ts's and the phone's constants", () => {
  const rows = tableConstants(kit("rules/two-clocks.md"));
  assert.equal(rows.length, 7, "the table lost a row");
  const notify = source("worker/src/notify.ts"), phone = source("public/assignments.js");
  for (const [name, value] of rows) {
    assert.equal(constantIn(notify, name), value, `notify.ts ${name}`);
    const onPhone = constantIn(phone, name);
    if (onPhone !== null) assert.equal(onPhone, value, `assignments.js ${name}`);
  }
  assert.equal(constantIn(phone, "MOVED_MIN"), constantIn(notify, "MIN_SHIFT_MIN"), "the phone's 'moved' and the alerts' noise floor");
});

test("kit rules: flight-checks.md's budget table is checks.ts's", async () => {
  const rows = tableConstants(kit("rules/flight-checks.md"));
  assert.equal(rows.length, 4, "the budget table lost a row");
  const checks = source("worker/src/checks.ts");
  for (const [name, value] of rows) assert.equal(constantIn(checks, name), value, `checks.ts ${name}`);
  // The prose numbers: skip under 40 minutes, two misses, the after-landing window.
  assert.equal(constantIn(checks, "SUPERSEDE_MS"), 40);
  assert.equal(constantIn(checks, "MAX_MISSES"), 2);
  assert.equal(constantIn(checks, "LATE_MS"), 120);
});

test("kit rules: the retention choices and the archive hours are the code's", () => {
  assert.match(source("worker/src/retention.ts"), /RETENTION_CHOICES = \[2, 7, 14, 30\]/);
  assert.equal(constantIn(source("public/assignments.js"), "ARCHIVE_AFTER_H"), 10);
  assert.match(kit("rules/archive-and-retention.md"), /10 hours after its printed end[\s\S]*2, 7, 14 or 30 days/);
});

// ----------------------------------------------------------- the rest

test("kit instructions: the pasted block fits Copilot Studio's 8,000 characters", () => {
  const md = kit("agent-instructions.md");
  const from = md.indexOf("<!-- paste from here -->"), to = md.indexOf("<!-- to here -->");
  assert.ok(from > 0 && to > from, "the markers");
  const block = md.slice(from + "<!-- paste from here -->".length, to).trim();
  assert.ok(block.length > 2000 && block.length <= 8000, `${block.length} characters`);
  for (const tool of ["Get my runs", "Get run", "Import a sheet", "Change a value", "Add a passenger",
    "Add a stop", "Mark not happening", "Undo a change", "Draft a message"]) {
    assert.ok(block.includes(tool), tool);
    assert.ok(kit("README.md").includes(`**${tool}**`), `README asks for ${tool}`);
  }
});

test("kit README: every file it lists exists, and every kit file is listed", () => {
  const readme = kit("README.md");
  const listed = [...readme.matchAll(/^\| `([^`]+)`(?:, `([^`]+)`)? \|/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
  for (const f of listed) assert.ok(existsSync(new URL(f, KIT)), f);
  const all = [
    ...readdirSync(KIT).filter((n) => /\.(md|json|csv)$/.test(n) && n !== "README.md"),
    ...readdirSync(new URL("rules/", KIT)).map((n) => `rules/${n}`),
  ];
  for (const f of all) assert.ok(listed.includes(f), `${f} is not in the README's table`);
});

test("kit connector: an OpenAPI 2.0 file whose operations azure-functions.md describes", () => {
  const spec = JSON.parse(kit("connector.swagger.json"));
  assert.equal(spec.swagger, "2.0");
  const ops = Object.values(spec.paths as Record<string, Record<string, { operationId: string }>>)
    .flatMap((p) => Object.values(p).map((o) => o.operationId));
  assert.ok(ops.length >= 8);
  const doc = kit("azure-functions.md");
  for (const op of ops) assert.ok(doc.includes(`| \`${op}\` |`), `${op} in azure-functions.md`);
});
