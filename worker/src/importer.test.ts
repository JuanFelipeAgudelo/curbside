/**
 * The JS importer's lower layers (public/importer/): the Python semantics it
 * copies, zlib, the PDF reader and pypdf's layout mode.
 *
 * Layout text is held to pypdf itself: tools/pdf-fixtures/ has synthetic PDFs
 * (drawn from the redacted fixtures in the shape dispatch's generator uses,
 * plus structures and operators it never uses) beside pypdf 6.18.1's text for
 * each. The Python that made them is gone (tools/pdf_fixtures.py, in git at
 * the tag python-importer-last), so the PDFs and their .txt are never
 * rewritten: they are what is left of pypdf. The .json beside each is the run
 * it reads as, the Python importer's answer when written (tools/golden.mjs
 * rewrites it after a change that was meant). Real sheets are PII:
 * tools/corpus.mjs checks those against a snapshot kept outside the repo.
 *
 *   node --test --experimental-strip-types src/importer.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import {
  casefold, floorDiv, fsum312, pyInt, pyRe, repr, round3, roundHalfEven, splitWs, strip,
} from "../../public/importer/python.js";
import { inflate, InflateLimit, MAX_OUTPUT } from "../../public/importer/inflate.js";
import { MAX_TOTAL_OUTPUT, PdfFile, PdfTooBig } from "../../public/importer/pdf-reader.js";
import { documentText } from "../../public/importer/pdf-text.js";
import { readSheet } from "../../public/importer/index.js";

const IMPORTER = new URL("../../public/importer/", import.meta.url);
const PDFS = new URL("../../tools/pdf-fixtures/", import.meta.url);
const lf = (s: string) => s.replace(/\r\n?/g, "\n");

// ------------------------------------------------ Python, to the last bit

test("round() ties to even, as CPython", () => {
  const got = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 3.5000000000000004].map(roundHalfEven);
  assert.deepEqual(got, [0, 2, 2, 0, -2, -2, 4]);
});

test("round(x, 3) is the correctly rounded decimal, ties to even", () => {
  const got = [0.0625, 0.1875, -0.0625, 2.675, 1.0005, 0.3125, 12.5625].map(round3);
  assert.deepEqual(got, [0.062, 0.188, -0.062, 2.675, 1.0, 0.312, 12.562]);
});

test("// on floats snaps the way CPython does (1 // 0.1 is 9)", () => {
  const got = [[1, 0.1], [-1, 0.1], [7.5, 2], [-7.5, 2], [0.3, 0.1], [5.0, 0.5]].map(([a, b]) => floorDiv(a, b));
  assert.deepEqual(got, [9, -10, 3, -4, 2, 10]);
});

test("sum() of floats is Python 3.12's compensated sum", () => {
  assert.equal(fsum312(Array(10).fill(0.1)), 1.0);
  assert.equal(fsum312([1e16, 1.0, -1e16]), 1.0);
  assert.equal(fsum312([0.1, 0.2, 0.3]), 0.6);
});

test("repr() of a str picks its quotes and escapes what isn't printable", () => {
  assert.equal(repr("it's"), `"it's"`);
  assert.equal(repr(`a'b"c`), `'a\\'b"c'`);
  assert.equal(repr("\u{a0}x"), "'\\xa0x'");
  assert.equal(repr("e\u{301}"), "'e\u{301}'");
  assert.equal(repr("\u{0}\t"), "'\\x00\\t'");
  assert.equal(repr("\u{200b}"), "'\\u200b'");
});

test("casefold, whitespace and digits are Unicode, as in Python", () => {
  assert.equal(casefold("Stra\u{df}e"), "strasse");
  assert.equal(strip("\u{a0} x \u{1c}"), "x");
  assert.deepEqual(splitWs(" a\u{2003}b \u{3000}c "), ["a", "b", "c"]);
  assert.equal(pyInt("\u{663}4"), 34);
});

test("pyRe keeps Python's regex meaning where JS differs", () => {
  assert.ok(pyRe("a$").test("a\n"), "$ also matches before a final newline");
  assert.ok(!pyRe("a$").test("a\nb"));
  assert.ok(pyRe("^b", "M").test("a\nb"));
  assert.ok(!pyRe("^b", "M").test("a\rb"), "only \\n ends a line");
  assert.ok(pyRe("a.b").test("a\rb"), ". stops only at \\n");
  assert.ok(!pyRe("a.b").test("a\nb"));
  assert.ok(pyRe(String.raw`\s`).test("\u{1c}"));
  assert.equal(pyRe(String.raw`\bor\b`).exec("se\u{f1}or"), null, "\\b is Unicode: no boundary inside se\u{f1}or");
  assert.equal(pyRe(String.raw`(?P<n>\d+)`).exec("x\u{663}4")?.groups?.n, "\u{663}4");
});

// -------------------------------------------------------------------- zlib

test("inflate matches zlib at every level and strategy", () => {
  const S = zlib.constants;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const n of [0, 1, 300, 70000]) {
    for (const strategy of [S.Z_DEFAULT_STRATEGY, S.Z_FILTERED, S.Z_HUFFMAN_ONLY, S.Z_RLE, S.Z_FIXED]) {
      for (const level of [0, 1, 6, 9]) {
        const data = Buffer.alloc(n);
        for (let i = 0; i < n; i++) data[i] = rand() < 0.6 ? Math.floor(rand() * 40) : data[Math.max(0, i - 1 - Math.floor(rand() * 200))];
        const z = zlib.deflateSync(data, { level, strategy });
        assert.deepEqual(Buffer.from(inflate(new Uint8Array(z))), data, `n=${n} strategy=${strategy} level=${level}`);
      }
    }
  }
});

test("inflate reads past trailing bytes and keeps what a damaged stream had", () => {
  const data = Buffer.from("BT /F1 8 Tf (hello) Tj ET\n".repeat(400));
  const z = zlib.deflateSync(data);
  assert.deepEqual(Buffer.from(inflate(new Uint8Array(Buffer.concat([z, Buffer.from("\r\nendstream")])))), data);
  const cut = Buffer.from(inflate(new Uint8Array(z.subarray(0, z.length >> 1))));
  assert.ok(cut.length > 0 && cut.length < data.length);
  assert.deepEqual(cut, data.subarray(0, cut.length));
  assert.equal(inflate(new Uint8Array(Buffer.from("not zlib at all"))).length, 0);
});

test("inflate stops at pypdf's output limit instead of filling memory", () => {
  const z = new Uint8Array(zlib.deflateSync(Buffer.alloc(5000)));
  assert.equal(inflate(z, 5000).length, 5000);
  assert.throws(() => inflate(z, 4999), InflateLimit);
});

// ------------------------------------------------------ PDFs against pypdf

const pdfNames = readdirSync(PDFS).filter((n) => n.endsWith(".pdf")).sort();

test("the synthetic PDFs are there", () => {
  assert.ok(pdfNames.length >= 4, `only ${pdfNames.length} in tools/pdf-fixtures`);
});

for (const name of pdfNames) {
  const stem = name.slice(0, -4);
  test(`${name}: pypdf's layout text, exactly`, () => {
    const got = documentText(new PdfFile(readFileSync(new URL(name, PDFS))));
    assert.equal(got, lf(readFileSync(new URL(`${stem}.txt`, PDFS), "utf8")));
  });
  test(`${name}: the run on file for it`, () => {
    const want = JSON.parse(readFileSync(new URL(`${stem}.json`, PDFS), "utf8"));
    const got = readSheet(readFileSync(new URL(name, PDFS)), name);
    if (want === null) assert.equal(got.ok ? "sheet" : got.reason, "not-a-sheet");
    else {
      assert.ok(got.ok, JSON.stringify(got));
      assert.deepEqual(got.assignment, want);
    }
  });
}

/** A one-page PDF around `content` and `resources`, with a classic xref. */
function tinyPdf(content: string, resources = "<< >>", trailerExtra = ""): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /Resources ${resources} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const at = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${at}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("what isn't a readable sheet says why, and nothing is guessed", () => {
  const reason = (bytes: Uint8Array) => {
    const r = readSheet(bytes, "x.pdf");
    return r.ok ? "sheet" : r.reason;
  };
  assert.equal(reason(new TextEncoder().encode("hello, not a PDF")), "not-pdf");
  assert.equal(reason(tinyPdf("q 1 0 0 1 0 0 cm Q")), "picture", "a page with no text is a scan");
  assert.equal(reason(tinyPdf("BT /F1 12 Tf 1 0 0 1 50 700 Tm (Hello) Tj ET", "<< /Font << /F1 5 0 R >> >>")),
    "unsupported", "simple fonts need tables this port doesn't carry");
  assert.equal(reason(tinyPdf("q Q", "<< >>", "/Encrypt 5 0 R ")), "unsupported", "encrypted");
});

/** A PDF of `pages` pages, each one Flate stream that inflates to `size` spaces. */
function paddedPdf(pages: number, size: number): Uint8Array {
  const z = zlib.deflateSync(Buffer.alloc(size, 0x20));
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  const add = (b: Buffer | string) => { const buf = Buffer.from(b); parts.push(buf); at += buf.length; };
  const obj = (n: number, body: Buffer | string) => { offsets[n] = at; add(`${n} 0 obj\n`); add(body); add("\nendobj\n"); };
  add("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    obj(3 + i * 2, `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents ${4 + i * 2} 0 R >>`);
    obj(4 + i * 2, Buffer.concat([
      Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from("\nendstream")]));
  }
  const count = 2 + pages * 2, xref = at;
  add(`xref\n0 ${count + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= count; n++) add(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

test("a PDF may inflate to only so much in all: many small bombs are refused as too big, not read one by one", () => {
  // A few KB on disk, 1.2 MB once inflated: 25 MB of these would be gigabytes.
  const bytes = paddedPdf(4, 300_000);
  assert.ok(bytes.length < 20_000, `${bytes.length} bytes`);
  const reason = (limits?: { maxInflated: number }) => {
    const r = (readSheet as (...a: unknown[]) => { ok: boolean; reason?: string })(bytes, "x.pdf", limits);
    return r.ok ? "sheet" : r.reason;
  };
  assert.equal(reason(), "picture", "inside the budget it is read: pages with no text");
  assert.equal(reason({ maxInflated: 1_000_000 }), "too-big");
  assert.throws(() => documentText(new (PdfFile as new (...a: unknown[]) => PdfFile)(bytes, { maxInflated: 1_000_000 })), PdfTooBig);
  assert.equal(MAX_TOTAL_OUTPUT, 2 * MAX_OUTPUT, "twice what one stream may be");
});

test("the importer's sources are plain ASCII", () => {
  // A literal U+2028 inside a regex literal ends it; escapes are written \u{...}.
  for (const name of readdirSync(IMPORTER).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(name, IMPORTER), "utf8");
    const bad = [...src].filter((c) => (c < " " && !"\n\r\t".includes(c)) || c > "~");
    assert.deepEqual(bad, [], `${name} has ${bad.length} non-ASCII or control characters`);
  }
});
