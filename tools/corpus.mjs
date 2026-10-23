/**
 * The gate on real sheets: does the reader (public/importer/) still read every
 * one of dispatch's PDFs exactly as it did when the snapshot was taken?
 *
 *   CURBSIDE_CORPUS=<dir of PDFs> node tools/corpus.mjs [more PDFs or dirs]
 *   ... --accept     take what the reader says now as the new snapshot
 *
 * Real sheets carry names and phone numbers. So the corpus and the snapshot
 * stay outside the repo, the snapshot holds hashes and no content, and this
 * prints counts, indexes and field names only: never a value, never a file
 * name. A hash of a short field can still be guessed, which is why the
 * snapshot is kept with the sheets and not here.
 *
 * The snapshot: CURBSIDE_SNAPSHOT, or ../curbside-private/corpus-snapshot.json
 * beside the repo. One record per PDF, keyed by the hash of its bytes (a
 * renamed file is the same file): the layout text's hash, how the reading
 * ended, the run's hash, and one short hash per field name, so a change can
 * say WHICH fields moved ("flightNumber 12") without showing one.
 *
 * The first snapshot was taken while the Python importer still ran and agreed
 * with this reader on all 252 sheets, text and run; it is what is left of
 * that proof. Exits 1 when a sheet reads differently, 2 when it cannot
 * compare. New and missing files are counted, not failed: --accept takes them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentText, PdfFile, readSheet, readText } from "../public/importer/index.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = 1;
/** The run's `source` is the file's name: one name for all, so a rename changes nothing. */
const NAME = "sheet.pdf";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const short = (s) => sha(s).slice(0, 16);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** Keys and list lengths, no values: a stop or a passenger more or less. */
function shapeOf(v) {
  if (Array.isArray(v)) return v.map(shapeOf);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  return 1;
}

/** Every value in the run, in order, under the name of the field that holds it. */
function valuesByField(v, key = "", out = new Map()) {
  if (Array.isArray(v)) for (const x of v) valuesByField(x, key, out);
  else if (v && typeof v === "object") for (const k of Object.keys(v).sort()) valuesByField(v[k], k, out);
  else {
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(v);
  }
  return out;
}

/** What the reader says about one PDF, as hashes. */
export function record(bytes) {
  let text = null, result;
  try {
    text = documentText(new PdfFile(bytes));
  } catch {
    text = null; // readSheet below says which kind of refusal, or throws the bug again
  }
  try {
    result = text === null ? readSheet(bytes, NAME) : readText(text, NAME);
  } catch (e) {
    result = { ok: false, reason: `bug:${e.name}` };
  }
  const rec = { text: text === null ? null : sha(text), outcome: result.ok ? "sheet" : result.reason, run: null, shape: null, fields: {} };
  if (result.ok) {
    rec.run = sha(canon(result.assignment));
    rec.shape = short(canon(shapeOf(result.assignment)));
    for (const [name, values] of [...valuesByField(result.assignment)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      rec.fields[name] = short(JSON.stringify(values));
    }
  }
  return rec;
}

/** The names of what differs between two records of the same PDF; [] when nothing does. */
export function differences(was, now) {
  const out = [];
  if (was.text !== now.text) out.push("text");
  if (was.outcome !== now.outcome) return [...out, "outcome"]; // a sheet no longer one: every field would follow
  if (was.run !== now.run) {
    const before = out.length;
    if (was.shape !== now.shape) out.push("shape");
    for (const name of [...new Set([...Object.keys(was.fields), ...Object.keys(now.fields)])].sort()) {
      if (was.fields[name] !== now.fields[name]) out.push(name);
    }
    if (out.length === before) out.push("run");
  }
  return out;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: CURBSIDE_CORPUS=<dir> node tools/corpus.mjs [pdf|dir]... [--accept]");
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const accept = args.includes("--accept");
  for (const a of args) if (a.startsWith("--") && a !== "--accept") usage(`unknown option ${a}`);
  const inputs = [process.env.CURBSIDE_CORPUS, ...args.filter((a) => !a.startsWith("--"))].filter(Boolean);
  if (!inputs.length) usage("no sheets: set CURBSIDE_CORPUS to the folder of dispatch's PDFs");

  const snapshotPath = path.resolve(process.env.CURBSIDE_SNAPSHOT || path.join(REPO, "..", "curbside-private", "corpus-snapshot.json"));
  const fromRepo = path.relative(REPO, snapshotPath);
  if (!fromRepo.startsWith("..") && !path.isAbsolute(fromRepo)) usage("the snapshot belongs outside the repo: set CURBSIDE_SNAPSHOT");

  const pdfs = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) usage("an input is not there (not named here: paths can carry names)");
    if (fs.statSync(p).isDirectory()) {
      for (const n of fs.readdirSync(p).sort()) if (n.toLowerCase().endsWith(".pdf")) pdfs.push(path.join(p, n));
    } else pdfs.push(p);
  }
  if (!pdfs.length) usage("no PDFs there");

  const t0 = performance.now();
  const now = new Map(); // bytes' hash -> { rec, index }
  let copies = 0;
  pdfs.forEach((file, index) => {
    const bytes = fs.readFileSync(file);
    const key = sha(bytes);
    if (now.has(key)) return void copies++;
    now.set(key, { rec: record(bytes), index });
  });
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);

  const outcomes = new Map();
  for (const { rec } of now.values()) outcomes.set(rec.outcome, (outcomes.get(rec.outcome) ?? 0) + 1);
  const said = [...outcomes].sort().map(([o, n]) => `${n} ${o === "sheet" ? "read as sheets" : o}`).join(", ");
  console.log(`${pdfs.length} PDFs${copies ? ` (${copies} a copy of another)` : ""} in ${seconds} s: ${said}`);

  let snapshot = null;
  if (fs.existsSync(snapshotPath)) {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    if (snapshot.version !== VERSION) usage(`the snapshot is version ${snapshot.version}, this tool writes ${VERSION}: --accept on a commit known good`);
  }

  let changed = 0;
  if (snapshot) {
    const was = snapshot.files;
    const byField = new Map(), notes = [];
    let same = 0, fresh = 0, freshSheets = 0;
    for (const [key, { rec, index }] of now) {
      if (!(key in was)) {
        fresh++;
        if (rec.outcome === "sheet") freshSheets++;
        continue;
      }
      const d = differences(was[key], rec);
      if (!d.length) { same++; continue; }
      changed++;
      for (const name of d) byField.set(name, (byField.get(name) ?? 0) + 1);
      notes.push(`#${index}: ${d.join(", ")}`);
    }
    const gone = Object.keys(was).filter((key) => !now.has(key)).length;
    console.log(`same ${same}, changed ${changed}, new ${fresh}${fresh ? ` (${freshSheets} read as sheets)` : ""}, gone ${gone}`);
    if (changed) {
      console.log("  by field: " + [...byField].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([f, n]) => `${f} ${n}`).join(", "));
      for (const n of notes.slice(0, 20)) console.log("  " + n);
      if (notes.length > 20) console.log(`  ... and ${notes.length - 20} more`);
    }
  } else if (!accept) {
    usage("no snapshot yet: --accept takes one, on a commit known good");
  }

  if (accept) {
    const files = Object.fromEntries([...now].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, { rec }]) => [key, rec]));
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({ version: VERSION, files }, null, 1) + "\n");
    console.log(`snapshot taken: ${now.size} sheets`);
    return;
  }
  process.exitCode = changed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
