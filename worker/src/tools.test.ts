/**
 * The laptop's gates (tools/*.mjs): what stands in for the Python importer
 * now that it is gone. A gate that could not fail would be worse than none,
 * so each is shown failing here.
 *
 *   node --test --experimental-strip-types src/tools.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import zlib from "node:zlib";
import { differences, record } from "../../tools/corpus.mjs";
import { fixture, singlePage } from "../../tools/make-pdf.mjs";
import { readSheet } from "../../public/importer/index.js";

const ROOT = new URL("../../", import.meta.url);
const PDFS = new URL("../../tools/pdf-fixtures/", import.meta.url);
const pdf = (name: string) => readFileSync(new URL(name, PDFS));
const lf = (s: string) => s.replace(/\r\n?/g, "\n");

// ------------------------------------------------- the corpus snapshot

test("corpus: a PDF's record is hashes and field names, the same every time, and nothing of the sheet", () => {
  const bytes = pdf("dispatch-369736.pdf");
  const rec = record(bytes);
  assert.deepEqual(record(bytes), rec);
  assert.deepEqual(differences(rec, record(bytes)), []);
  assert.equal(rec.outcome, "sheet");
  const text = lf(readFileSync(new URL("dispatch-369736.txt", PDFS), "utf8"));
  assert.equal(rec.text, createHash("sha256").update(text).digest("hex"), "the layout text's hash");
  assert.match(rec.run, /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(rec.fields).includes("flightNumber") && Object.keys(rec.fields).includes("phone"));
  for (const h of [rec.shape, ...Object.values(rec.fields)]) assert.match(h as string, /^[0-9a-f]{16}$/);
  // What the fixture says (a name, a number, a flight, the file's own name) is nowhere in it.
  const stored = JSON.stringify(rec);
  for (const said of ["Jonas", "Reyes", "555", "UA1503", "369736", "Sienna", "sheet.pdf"]) assert.ok(!stored.includes(said), said);
});

test("corpus: what is not a sheet is recorded as that, with its text's hash", () => {
  const rec = record(pdf("operators.pdf"));
  assert.equal(rec.outcome, "not-a-sheet");
  assert.match(rec.text, /^[0-9a-f]{64}$/);
  assert.equal(rec.run, null);
  assert.deepEqual(rec.fields, {});
  const junk = record(new TextEncoder().encode("not a PDF"));
  assert.deepEqual([junk.outcome, junk.text, junk.run], ["not-pdf", null, null]);
});

test("corpus: a difference says which fields moved", () => {
  const was = record(pdf("dispatch-369736.pdf"));
  const moved = (change: Record<string, unknown>) => differences(was, { ...was, ...change });
  assert.deepEqual(moved({ run: "x", fields: { ...was.fields, flightNumber: "0".repeat(16) } }), ["flightNumber"]);
  assert.deepEqual(moved({ run: "x", shape: "0".repeat(16), fields: { ...was.fields, eta: "1", etd: "2" } }), ["shape", "eta", "etd"]);
  assert.deepEqual(moved({ text: "x" }), ["text"], "the text layer moved and the run did not");
  const { phone, ...rest } = was.fields;
  assert.deepEqual(moved({ run: "x", fields: rest }), ["phone"], "a field that is gone");
  assert.deepEqual(moved({ run: "x", fields: { ...was.fields, gate: "1" } }), ["gate"], "a field that is new");
  assert.deepEqual(moved({ run: "x" }), ["run"], "a run that differs is never called the same");
  // A sheet that stops being one: said once, not once per field.
  assert.deepEqual(differences(was, record(pdf("operators.pdf"))), ["text", "outcome"]);
  // Two different sheets differ in nearly everything.
  const other = differences(was, record(pdf("xref-stream-348400.pdf")));
  for (const name of ["text", "shape", "number", "start", "flightNumber", "name"]) assert.ok(other.includes(name), name);
});

// ------------------------------------------------- the PDF writer

/** A PDF's objects in order, each stream inflated, then its trailer: what it says, whatever deflate wrote. */
function objectsOf(bytes: Uint8Array): string[] {
  const s = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  let at = s.indexOf("1 0 obj\n");
  for (let n = 1; s.startsWith(`${n} 0 obj\n`, at); n++) {
    const start = at + `${n} 0 obj\n`.length;
    const end = s.indexOf("\nendobj\n", start), stream = s.indexOf("\nstream\n", start);
    if (stream !== -1 && stream < end) {
      const dict = s.slice(start, stream);
      const length = Number(/\/Length (\d+)/.exec(dict)![1]);
      const data = Buffer.from(s.slice(stream + 8, stream + 8 + length), "latin1");
      out.push(dict.replace(/\/Length \d+/, "/Length N") + "\n" + zlib.inflateSync(data).toString("latin1"));
      at = stream + 8 + length + "\nendstream\nendobj\n".length;
    } else {
      out.push(s.slice(start, end));
      at = end + "\nendobj\n".length;
    }
  }
  out.push(s.slice(s.lastIndexOf("trailer\n"), s.lastIndexOf("startxref")));
  return out;
}

const MADE: [string, () => Uint8Array][] = [
  ["dispatch-369736", () => singlePage(fixture("369736"))],
  ["broken-xref-339460", () => singlePage(fixture("339460"), { wrongOffsets: true, ranges: true, dw: 1000 })],
];

for (const [stem, make] of MADE) {
  test(`make-pdf: ${stem} comes out, object for object, as the Python's writer made it`, () => {
    // The committed PDF was made by the Python writer this one was ported from
    // (tag python-importer-last) and read by pypdf: the .txt beside it. Only
    // deflate's own bytes may differ.
    const made = objectsOf(make()), kept = objectsOf(pdf(`${stem}.pdf`));
    assert.equal(kept.length, 10, "nine objects and the trailer");
    assert.deepEqual(made, kept);
  });
  test(`make-pdf: ${stem} reads back as the text and the run pypdf and the Python read`, () => {
    const got = readSheet(make(), `${stem}.pdf`);
    assert.ok(got.ok, JSON.stringify(got));
    assert.equal(got.text, lf(readFileSync(new URL(`${stem}.txt`, PDFS), "utf8")));
    assert.deepEqual(got.assignment, JSON.parse(readFileSync(new URL(`${stem}.json`, PDFS), "utf8")));
  });
}

test("make-pdf: a re-sent copy of a made-up run, and the corpus gate naming exactly what moved", () => {
  // The recipe the pane tests use: a fixture under a number nobody was driven on, printed again later.
  const first = fixture("369736").replaceAll("369736", "900736");
  const again = first.replace("Monday, August 31, 2026 7:18 PM", "Monday, August 31, 2026 8:05 PM");
  assert.notEqual(again, first);
  const a = readSheet(singlePage(first), "a.pdf"), b = readSheet(singlePage(again), "b.pdf");
  assert.ok(a.ok && b.ok);
  assert.deepEqual([a.assignment.number, a.assignment.printedAt], ["900736", "2026-08-31 19:18"]);
  assert.deepEqual([b.assignment.number, b.assignment.printedAt], ["900736", "2026-08-31 20:05"]);
  assert.deepEqual(differences(record(singlePage(first)), record(singlePage(again))), ["text", "printedAt"]);
  // And one flight renumbered on the sheet: the flight's field, nothing beside it.
  const other = first.replaceAll("United Airlines UA1503", "United Airlines UA1504");
  assert.notEqual(other, first);
  assert.deepEqual(differences(record(singlePage(first)), record(singlePage(other))), ["text", "flightNumber"]);
});

// ------------------------------------------------------- source hygiene

test("no source carries a stray control character", () => {
  // The trap this guards has been sprung more than once: an escape written
  // through a script or a tool that eats a backslash level (a "\b" that became
  // a BACKSPACE, an escaped line separator that became the character itself and
  // ended a regex; it happened again while this very test was being written).
  // It parses, it runs, and it never matches, or it shows as stray text on screen.
  const SOURCE = /\.(js|mjs|ts|py|sh|html|css|json|webmanifest|svg|toml)$|^_headers$/;
  const files: string[] = [];
  const walk = (dir: string, deep: boolean) => {
    for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      if (e.isDirectory()) { if (deep) walk(`${dir}${e.name}/`, deep); }
      else if (SOURCE.test(e.name)) files.push(dir + e.name);
    }
  };
  walk("public/", true);
  walk("tools/", false);
  walk("worker/src/", false);
  assert.ok(files.length > 40 && files.includes("public/assignments.js") && files.includes("tools/redact.py"), `${files.length} files`);
  for (const rel of files) {
    const body = readFileSync(new URL(rel, ROOT), "utf8");
    // Tab, newline and carriage return are the only ones a source holds on purpose.
    const bad = [...new Set([...body].map((c) => c.codePointAt(0)!)
      .filter((n) => (n < 32 && n !== 9 && n !== 10 && n !== 13) || n === 0x7f || n === 0x2028 || n === 0x2029))];
    assert.deepEqual(bad.map((n) => "0x" + n.toString(16)), [], rel);
  }
});
