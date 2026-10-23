/**
 * The committed answers the tests hold the reader (public/importer/) to.
 *
 *   node tools/golden.mjs      rewrite them from the reader as it is now
 *
 *   tools/fixtures/<name>.json       the run each scrubbed .txt reads as
 *   tools/pdf-fixtures/<name>.json   the run each synthetic PDF reads as
 *                                    (null: not a sheet)
 *
 * `npm test` in worker/ compares; this only writes. After a deliberate change
 * to the parser: run it, read `git diff tools/`, and commit the answers with
 * the change. A difference nobody meant is the bug.
 *
 * Never rewritten: the .txt beside each synthetic PDF. That is pypdf 6.18.1's
 * layout text for it, the one record left of what the text layer was ported
 * from.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSheet, readText } from "../public/importer/index.js";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));

/** One line per value, ASCII only (each UTF-16 unit escaped): the same bytes on every machine. */
export function goldenJson(value) {
  return JSON.stringify(value, null, 1)
    .replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
}

function answer(result, name) {
  if (result.ok) return result.assignment;
  if (result.reason === "not-a-sheet") return null;
  throw new Error(`${name}: ${result.reason} (${result.detail})`);
}

function main() {
  let wrote = 0, same = 0;
  const put = (file, value) => {
    const next = goldenJson(value);
    const had = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n") : null;
    if (had === next) return void same++;
    fs.writeFileSync(file, next);
    wrote++;
    console.log(`  wrote ${path.relative(path.dirname(TOOLS), file).replaceAll("\\", "/")}`);
  };
  const dir = (name, ext) => fs.readdirSync(path.join(TOOLS, name)).sort()
    .filter((n) => n.endsWith(ext)).map((n) => path.join(TOOLS, name, n));

  for (const file of dir("fixtures", ".txt")) {
    const name = path.basename(file);
    const text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
    put(file.slice(0, -4) + ".json", answer(readText(text, name), name));
  }
  for (const file of dir("pdf-fixtures", ".pdf")) {
    const name = path.basename(file);
    put(file.slice(0, -4) + ".json", answer(readSheet(fs.readFileSync(file), name), name));
  }
  console.log(`${wrote} written, ${same} already right`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
