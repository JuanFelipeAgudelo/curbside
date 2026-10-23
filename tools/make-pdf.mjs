/**
 * Layout text -> a one-page PDF in the shape dispatch's generator uses, for
 * tests that need a sheet nobody was driven on: a made-up run, a re-sent
 * copy with a later print time, a run moved to today.
 *
 *   node tools/make-pdf.mjs <fixture number | file.txt> <out.pdf> [--replace old=new]...
 *   node tools/make-pdf.mjs 369736 /tmp/900736.pdf --replace 369736=900736
 *
 *   import { fixture, singlePage } from "./make-pdf.mjs";
 *   singlePage(fixture("369736").replaceAll("369736", "900736"))  // -> Uint8Array
 *
 * The shape: a Type0 font with Identity-H and a ToUnicode map, a page-level
 * `cm` outside any `q`, `q 4 0 0 4 cm`, one `BT` per cell, a flipped `Tm`,
 * `Tj`, Flate streams. No font program: reading text needs only the widths
 * and the ToUnicode map. Only a scrubbed fixture (tools/fixtures/) or made-up
 * text goes in: a PDF made from a real sheet is a real sheet.
 *
 * Ported from the Python that made tools/pdf-fixtures/ (tools/pdf_fixtures.py,
 * in git at the tag python-importer-last). Those four PDFs stay as committed:
 * their .txt is pypdf's own reading of them. The worker's tests hold this
 * writer to them, object for object.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));

// Proportional widths (1/1000 em), kept under 625 so a character's advance at
// 8 pt in the 4x space (w * 0.032) never passes the 20-unit column pitch below:
// cells can't run into each other, so the reader keeps the text's columns apart.
const WIDTHS = new Map(Object.entries({
  " ": 274, "-": 392, ".": 252, ",": 217, ":": 252, "/": 386, "|": 239, "(": 303,
  ")": 303, "+": 560, "'": 177, "&": 600, "#": 550, "@": 620,
}));
for (const c of "0123456789") WIDTHS.set(c, 550);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") WIDTHS.set(c, "MW".includes(c) ? 620 : 580);
for (const c of "abcdefghijklmnopqrstuvwxyz") WIDTHS.set(c, "mw".includes(c) ? 610 : "il".includes(c) ? 300 : 500);
// Line pitch 33 against a font height of 32 (8 pt x 4): layout mode's blank-line
// rule, int(dy / 32) - 1, then gives back the text's blank lines exactly.
const COL = 20, ROW = 33;

const latin1 = (s) => Buffer.from(s, "latin1");
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

class Doc {
  objs = [];

  add(body) {
    this.objs.push(typeof body === "string" ? latin1(body) : body);
    return this.objs.length;
  }

  reserve() {
    return this.add("null");
  }

  set(num, body) {
    this.objs[num - 1] = typeof body === "string" ? latin1(body) : body;
  }

  stream(data) {
    const z = zlib.deflateSync(data);
    return this.add(Buffer.concat([latin1(`<< /Filter /FlateDecode /Length ${z.length} >>\nstream\n`), z, latin1("\nendstream")]));
  }

  /** A classic xref table. `wrongOffsets`: every offset 7 bytes out, for the reader's rebuild-by-scan. */
  pdf(root, wrongOffsets = false) {
    const parts = [Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]; // %PDF-1.4, a binary comment
    let at = parts[0].length;
    const offsets = [];
    this.objs.forEach((body, i) => {
      offsets.push(at);
      const obj = Buffer.concat([latin1(`${i + 1} 0 obj\n`), body, latin1("\nendobj\n")]);
      parts.push(obj);
      at += obj.length;
    });
    let tail = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) tail += `${String(o + (wrongOffsets ? 7 : 0)).padStart(10, "0")} 00000 n \n`;
    tail += `trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R >>\nstartxref\n${at}\n%%EOF\n`;
    parts.push(latin1(tail));
    return new Uint8Array(Buffer.concat(parts));
  }
}

function utf16Hex(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) out += hex4(text.charCodeAt(i));
  return out;
}

/** A Type0 font over the characters of `chars`. Returns [its object number, Map(char -> cid)]. */
function font(doc, chars, { dw = 0, ranges = false, flags = 32, name = "SegoeUI" } = {}) {
  const set = [...new Set([...chars])].filter((ch) => ch !== "\n").sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const cid = new Map(set.map((ch, i) => [ch, 3 + i]));
  const widths = new Map(set.map((ch) => [cid.get(ch), WIDTHS.get(ch) ?? 600]));
  const cids = [...widths.keys()].sort((a, b) => a - b);
  const first = cids[0], last = cids[cids.length - 1];
  const span = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const w = ranges // "c1 c2 w" form, or "c [w w w]"
    ? "[" + cids.map((c) => `${c} ${c} ${widths.get(c)}`).join(" ") + "]"
    : `[${first} [${span.map((c) => widths.get(c) ?? 0).join(" ")}]]`;
  const cmap = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange"];
  if (ranges) { // one bfrange with an array, entries on their own lines
    cmap.push("1 beginbfrange", `<${hex4(first)}> <${hex4(last)}> [`);
    for (const ch of set) cmap.push(`<${utf16Hex(ch)}>`);
    cmap.push("]", "endbfrange");
  } else {
    cmap.push(`${set.length} beginbfchar`);
    for (const ch of set) cmap.push(`<${hex4(cid.get(ch))}> <${utf16Hex(ch)}>`);
    cmap.push("endbfchar");
  }
  cmap.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end");
  const tu = doc.stream(Buffer.from(cmap.join("\n"), "utf8"));
  const fd = doc.add(`<< /Type /FontDescriptor /FontName /ABCDEF+${name} /Flags ${flags} /FontBBox [-500 -300 1500 1000] `
    + "/ItalicAngle 0 /Ascent 1079 /Descent -250 /CapHeight 700 /StemV 80 >>");
  const cf = doc.add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+${name} /CIDSystemInfo << /Registry `
    + `(Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fd} 0 R /DW ${dw} /W ${w} `
    + "/CIDToGIDMap /Identity >>");
  const f = doc.add(`<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+${name} /Encoding /Identity-H `
    + `/DescendantFonts [${cf} 0 R] /ToUnicode ${tu} 0 R >>`);
  return [f, cid];
}

/** A fixed-width text drawn the way the sheets draw it: one BT per cell. */
function drawn(text, cid) {
  const ops = ["0.25 0 0 -0.25 0 792 cm"];
  text.split("\n").forEach((row, n) => {
    const line = [...row];
    let k = 0;
    while (k < line.length) {
      if (line[k] === " ") { k++; continue; }
      let j = k; // a cell runs to two spaces, or to a space that ends the line
      while (j < line.length && !(line[j] === " " && (j + 1 >= line.length || line[j + 1] === " "))) j++;
      const shown = "<" + line.slice(k, j).map((ch) => hex4(cid.get(ch))).join("") + ">";
      ops.push(`q 4 0 0 4 0 0 cm /GS0 gs 0 0 0 rg BT /F1 8 Tf 1 0 0 -1 ${((20 + k * COL) / 4).toFixed(4)} ${((30 + n * ROW) / 4).toFixed(4)} Tm ${shown} Tj ET Q`);
      k = j;
    }
  });
  return Buffer.from(ops.join("\n"), "utf8");
}

/** A scrubbed fixture's text, by the number it starts with. */
export function fixture(stem) {
  const dir = path.join(TOOLS, "fixtures");
  const name = fs.readdirSync(dir).sort().find((n) => n.startsWith(stem) && n.endsWith(".txt"));
  if (!name) throw new Error(`no fixture starting ${stem}`);
  return fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n?/g, "\n");
}

/** The PDF's bytes. Options are the odd shapes the reader must also take: see tools/pdf-fixtures/. */
export function singlePage(text, { wrongOffsets = false, ranges = false, dw = 0 } = {}) {
  const d = new Doc();
  const [f, cid] = font(d, text, { dw, ranges });
  const gs = d.add("<< /Type /ExtGState /CA 1 /ca 1 >>");
  const c = d.stream(drawn(text, cid));
  const pages = d.reserve();
  const page = d.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${f} 0 R >> `
    + `/ExtGState << /GS0 ${gs} 0 R >> >> /Contents ${c} 0 R >>`);
  d.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  return d.pdf(d.add(`<< /Type /Catalog /Pages ${pages} 0 R >>`), wrongOffsets);
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node tools/make-pdf.mjs <fixture number | file.txt> <out.pdf> [--replace old=new]...");
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const swaps = [], rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--replace") {
      const pair = args[++i] ?? "", cut = pair.indexOf("=");
      if (cut < 1) usage("--replace takes old=new");
      swaps.push([pair.slice(0, cut), pair.slice(cut + 1)]);
    } else rest.push(args[i]);
  }
  if (rest.length !== 2) usage();
  let text = /^\d+$/.test(rest[0]) ? fixture(rest[0]) : fs.readFileSync(rest[0], "utf8").replace(/\r\n?/g, "\n");
  for (const [a, b] of swaps) {
    if (!text.includes(a)) usage(`nothing to replace: ${a}`);
    text = text.replaceAll(a, b);
  }
  fs.writeFileSync(rest[1], singlePage(text));
  console.log(`wrote ${rest[1]}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
