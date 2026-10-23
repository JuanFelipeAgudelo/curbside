/**
 * Import dispatch's assignment PDFs from the laptop, with the same reader
 * the app uses (public/importer/).
 *
 *   node tools/import.mjs <pdf|txt|dir>...                    print each assignment as JSON
 *   node tools/import.mjs <pdf>... --post-assignment <CODE>   import them into that list
 *   node tools/import.mjs <pdf> --text                        print the layout text the parser is given
 *   options: --since YYYY-MM-DD   only runs starting on or after that day
 *
 * CURBSIDE_API points at another worker (`wrangler dev`: http://127.0.0.1:8787).
 * The same number twice: the newest printed copy wins, as on the server.
 * --text is one file's text and nothing else on stdout (tools/redact.py reads
 * it); a real sheet's text is the sheet: never into the repo or a log.
 */
import fs from "node:fs";
import path from "node:path";
import { documentText, PdfFile, readSheet, readText } from "../public/importer/index.js";

const API = (process.env.CURBSIDE_API || "https://flightwatch-worker.juanfe02agu.workers.dev").replace(/\/+$/, "");

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node tools/import.mjs <pdf|txt|dir>... [--post-assignment CODE] [--since YYYY-MM-DD] | <pdf> --text");
  process.exit(2);
}

const args = process.argv.slice(2);
let listCode = null, since = null, textOnly = false;
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--post-assignment") listCode = args[++i] || usage("--post-assignment needs a list code");
  else if (args[i] === "--since") since = args[++i] || usage("--since needs a date");
  else if (args[i] === "--text") textOnly = true;
  else if (args[i].startsWith("--")) usage(`unknown option ${args[i]}`);
  else paths.push(args[i]);
}
if (!paths.length) usage();
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) usage("--since takes YYYY-MM-DD");

if (textOnly) {
  if (paths.length !== 1 || listCode || since || !paths[0].toLowerCase().endsWith(".pdf")) usage("--text takes one PDF and nothing else");
  let text;
  try {
    text = documentText(new PdfFile(fs.readFileSync(paths[0])));
  } catch (e) {
    console.error(`not read: ${e.name}: ${e.message}`);
    process.exit(1);
  }
  await new Promise((flushed) => process.stdout.write(text, flushed));
  process.exit(0);
}

/** Directories contribute their *.pdf then their *.txt, each sorted. */
function collect(list) {
  const out = [];
  for (const p of list) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const names = fs.readdirSync(p).sort();
      for (const ext of [".pdf", ".txt"]) {
        for (const n of names) if (n.toLowerCase().endsWith(ext)) out.push(path.join(p, n));
      }
    } else out.push(p);
  }
  return out;
}

const REASONS = {
  "not-pdf": "not a PDF this reader can open",
  unsupported: "uses a PDF feature dispatch's sheets don't",
  picture: "a picture, not text (a scan?)",
  "not-a-sheet": "not an assignment sheet",
  unreadable: "an assignment, but a date or time can't be read",
};

const latest = new Map();
let failed = 0;
for (const file of collect(paths)) {
  const name = path.basename(file);
  let result;
  try {
    result = file.toLowerCase().endsWith(".txt")
      ? readText(fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"), name)
      : readSheet(fs.readFileSync(file), name);
  } catch (e) {
    result = { ok: false, reason: "bug", detail: `${e.name}: ${e.message}` };
  }
  if (!result.ok) {
    failed++;
    console.error(`  ${name}: ${REASONS[result.reason] ?? result.reason} (${result.detail})`);
    continue;
  }
  const a = result.assignment;
  const prev = latest.get(a.number);
  if (!prev || (a.printedAt && prev.printedAt && a.printedAt > prev.printedAt)) latest.set(a.number, a);
}

let runs = [...latest.values()].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
if (since) runs = runs.filter((a) => a.start.slice(0, 10) >= since);

for (const a of runs) {
  if (listCode) {
    let status, resp;
    try {
      const r = await fetch(`${API}/api/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "curbside-import/1.0", "X-List-Code": listCode },
        body: JSON.stringify(a),
      });
      status = r.status;
      resp = await r.json().catch(() => ({}));
    } catch (e) {
      console.error(`  ${a.number}  not sent: ${e.message}`);
      failed++;
      continue;
    }
    let note = resp.replaced ? "replaced an older copy" : "new";
    if (!resp.applied) note = resp.reason || resp.error || "not applied";
    console.log(`  ${a.number}  HTTP ${status}  ${note}  (${resp.flightsTracked ?? 0} flight(s) tracked)`);
    if (status >= 400) failed++;
  } else {
    console.log(JSON.stringify(a, null, 2));
  }
  for (const issue of a.issues) console.error(`     ! ${issue}`);
}
process.exitCode = failed ? 1 : 0;
