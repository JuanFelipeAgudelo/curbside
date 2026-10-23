/**
 * pypdf 6.18.1's layout-mode text extraction, ported:
 *   page.extract_text(extraction_mode="layout") with its defaults
 *   (space_vertically, scale_weight 1.25, strip_rotated, font_height_weight 1).
 *
 * Sources, in pypdf: _text_extraction/_layout_mode/_fixed_width_page.py,
 * _text_state_manager.py, _text_state_params.py; _font.py (Font); _cmap.py
 * (encoding and ToUnicode); generic/_data_structures.py (ContentStream).
 *
 * Kept on purpose, because the output depends on them: a `cm` outside any
 * `q` is ignored, `Tj` never moves the pen, a TJ number moves it by the
 * whole preceding string plus the number, `space_tx` is in text space while
 * positions are in user space, and every rounding is Python's.
 *
 * Fonts: composite (Type0) fonts with a UTF-16 encoding (Identity-H and
 * kin), which is what dispatch's sheets use. Simple fonts need encoding and
 * glyph-name tables this port doesn't carry: they are refused, not guessed.
 */
import { latin1, Lexer, PdfDict, PdfError, PdfStream, PdfString, UnsupportedPdf } from "./pdf-reader.js";
import { cpLen, floorDiv, fsum312, round3, roundHalfEven, rstrip, strip } from "./python.js";

const WHITESPACE_LIMIT = 10000;
const NEWLINE_LIMIT = 1000;
const LAYOUT_NEW_BT_GROUP_SPACE_WIDTHS = 5;
const FIXED_PITCH = 1;

// ---------------------------------------------------------------- bytes utils

// bytes.strip() / bytes.split(): ASCII whitespace, VT and FF included.
const BWS = " \t\n\r\x0b\x0c";
const bstrip = (s, chars = BWS) => {
  let i = 0, j = s.length;
  while (i < j && chars.includes(s[i])) i++;
  while (j > i && chars.includes(s[j - 1])) j--;
  return s.slice(i, j);
};
const bsplit = (s) => s.split(/[ \t\n\r\x0b\x0c]+/).filter((x) => x !== "");

/** binascii.unhexlify on a latin-1 string: hex pairs, else binascii.Error. */
function unhexlify(s) {
  if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new HexError("Non-hexadecimal digit or odd length");
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

/** bytes.decode("utf-16-be", "surrogatepass"): pairs combine, lone halves stay. */
function utf16be(bytes) {
  if (bytes.length % 2) throw new CmapLineError("truncated data");
  let s = "";
  for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

/** int(token, 16) for a bytes token: sign, 0x prefix and underscores allowed. */
function int16(s) {
  const m = /^([+-]?)(?:0[xX]_?)?([0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)$/.exec(s);
  if (!m) throw new CmapLineError(`invalid literal for int() with base 16: ${s}`);
  const v = parseInt(m[2].replace(/_/g, ""), 16);
  return m[1] === "-" ? -v : v;
}

/** A ValueError that _cmap.process_cm_line swallows (the line is skipped). */
class CmapLineError extends Error {}
/** binascii.Error, the ValueError parse_bfchar catches for a destination. */
class HexError extends CmapLineError {}

// --------------------------------------------------------------- ToUnicode

const MAPPING_DICTIONARY_SIZE_LIMIT = 100000;
const MAX_CODE_HEX = 16; // MAX_CMAP_CODE_BYTES_LIMIT
const MAX_STRING_HEX = 1024; // MAX_CMAP_STRING_BYTES_LIMIT

function checkMappingSize(n) {
  if (n > MAPPING_DICTIONARY_SIZE_LIMIT) throw new PdfError("Maximum /ToUnicode size limit reached");
}
function checkTokenLength(token, limit) {
  if (token.length > limit) throw new PdfError("Maximum /ToUnicode token length exceeded");
}

/** _cmap.prepare_cm: the CMap text, re-lined so each entry parses alone. */
function prepareCm(bytes) {
  let cm = bstrip(latin1(bytes))
    .replaceAll("beginbfchar", "\nbeginbfchar\n")
    .replaceAll("endbfchar", "\nendbfchar\n")
    .replaceAll("beginbfrange", "\nbeginbfrange\n")
    .replaceAll("endbfrange", "\nendbfrange\n")
    .replaceAll("<<", "\n{\n")
    .replaceAll(">>", "\n}\n");
  const ll = cm.split("<");
  for (let i = 0; i < ll.length; i++) {
    const j = ll[i].indexOf(">");
    if (j >= 0) {
      const content = j === 0 ? "." : ll[i].slice(0, j).replaceAll(" ", "");
      ll[i] = content + " " + ll[i].slice(j + 1);
    }
  }
  return ll.join(" ").replaceAll("[", " [ ").replaceAll("]", " ]\n ").replaceAll("\r", "\n");
}

/** _cmap._parse_to_unicode for a /ToUnicode stream. Map: source char -> text. */
function parseToUnicode(bytes) {
  const map = new Map();
  const intEntry = [];
  const st = { rg: false, chr: false, multi: null, width: undefined };
  for (const raw of prepareCm(bytes).split("\n")) {
    let line = bstrip(raw, " \t");
    if (line === "" || line[0] === "%") continue;
    line = line.replaceAll("\t", " ");
    if (line.includes("beginbfrange")) st.rg = true;
    else if (line.includes("endbfrange")) st.rg = false;
    else if (line.includes("beginbfchar")) st.chr = true;
    else if (line.includes("endbfchar")) st.chr = false;
    else if (st.rg) {
      try {
        st.multi = parseBfrange(line, map, intEntry, st);
      } catch (e) {
        if (!(e instanceof CmapLineError)) throw e;
      }
    } else if (st.chr) {
      try {
        parseBfchar(line, map, intEntry, st);
      } catch (e) {
        if (!(e instanceof CmapLineError)) throw e;
      }
    }
  }
  return map;
}

/** __parse_bfrange__decode: a source code as the key string pypdf uses. */
function sourceKey(code, st) {
  const n = st.width;
  if (n === undefined) throw new PdfError("bfrange continuation before any range");
  if (code < 0 || code >= 2 ** (8 * n)) throw new PdfError("int too big to convert");
  const bytes = [];
  for (let k = n - 1; k >= 0; k--) bytes.push(Math.floor(code / 2 ** (8 * k)) % 256);
  return n === 1 ? String.fromCharCode(bytes[0]) : utf16be(bytes);
}

function parseBfrange(line, map, intEntry, st) {
  const lst = bsplit(line);
  let closure = false;
  let count = intEntry.length;
  checkMappingSize(count);
  const listed = (tokens, a) => {
    for (const sq of tokens) {
      if (sq === "]") {
        closure = true;
        break;
      }
      checkTokenLength(sq, MAX_STRING_HEX);
      checkMappingSize(++count);
      map.set(sourceKey(a, st), utf16be(unhexlify(sq)));
      intEntry.push(a);
      a += 1;
    }
    return a;
  };
  const at = (i) => {
    if (i >= lst.length) throw new CmapLineError("list index out of range"); // IndexError
    return lst[i];
  };
  let a, b;
  if (st.multi) {
    [a, b] = st.multi;
    a = listed(lst, a);
  } else {
    checkTokenLength(at(0), MAX_CODE_HEX);
    checkTokenLength(at(1), MAX_CODE_HEX);
    a = int16(lst[0]);
    b = int16(lst[1]);
    st.width = Math.floor((Math.max(lst[0].length, lst[1].length) + 1) / 2);
    if (at(2) === "[") a = listed(lst.slice(3), a);
    else {
      checkTokenLength(lst[2], MAX_STRING_HEX);
      let c = int16(lst[2]);
      const digits = Math.max(4, lst[2].length);
      closure = true;
      checkMappingSize(count + Math.max(0, b - a + 1));
      while (a <= b) {
        let hex = c.toString(16).toUpperCase();
        if (hex.length < digits) hex = hex.padStart(digits, "0");
        const destination = unhexlify(hex);
        checkTokenLength(destination, MAX_CODE_HEX);
        map.set(sourceKey(a, st), utf16be(destination));
        intEntry.push(a);
        a += 1;
        c += 1;
      }
    }
  }
  return closure ? null : [a, b];
}

function parseBfchar(line, map, intEntry, st) {
  let lst = line.split(" ").filter((x) => x !== "");
  if (!lst.length) return;
  checkMappingSize(intEntry.length + Math.floor(lst.length / 2));
  st.width = Math.floor(lst[0].length / 2);
  while (lst.length > 1) {
    const [source, destination] = lst;
    checkTokenLength(source, MAX_CODE_HEX);
    let mapTo = "";
    if (destination !== ".") {
      checkTokenLength(destination, MAX_STRING_HEX);
      try {
        const bytes = unhexlify(destination);
        mapTo = destination.length < 4 ? String.fromCharCode(...bytes) : utf16be(bytes);
      } catch (e) {
        // binascii.Error is caught here; a utf-16 decode error skips the line.
        if (!(e instanceof HexError)) throw e;
      }
    }
    const src = unhexlify(source);
    map.set(st.width === 1 ? String.fromCharCode(...src) : utf16be(src), mapTo);
    intEntry.push(int16(source));
    lst = lst.slice(2);
  }
}

// -------------------------------------------------------------------- fonts

const PREDEFINED_UTF16 = new Set(["/Identity-H", "/Identity-V", "/UniCNS-UTF16-H",
  "/UniCNS-UTF16-V", "/UniJIS-UTF16-H", "/UniJIS-UTF16-V"]);

/** Font.from_font_resource, composite fonts only. */
function fontFrom(pdf, ft) {
  const name = String(pdf.resolve(ft.get("/BaseFont")) ?? "Unknown").replace(/^\//, "");
  const subtype = pdf.resolve(ft.get("/Subtype"));
  if (["/Type1", "/MMType1", "/TrueType", "/Type3"].includes(subtype) || !ft.has("/Encoding")) {
    throw new UnsupportedPdf(`simple font ${name}`);
  }
  // _cmap._parse_encoding: a named CMap that decodes as UTF-16.
  const enc = pdf.resolve(ft.get("/Encoding"));
  if (typeof enc !== "string" || !(PREDEFINED_UTF16.has(enc) || enc.includes("-UCS2-"))) {
    throw new UnsupportedPdf(`font encoding ${typeof enc === "string" ? enc : "(embedded CMap)"}`);
  }
  let characterMap = new Map();
  const tu = ft.has("/ToUnicode") ? pdf.resolve(ft.get("/ToUnicode")) : undefined;
  if (tu instanceof PdfStream) characterMap = parseToUnicode(pdf.streamData(tu));
  else if (ft.has("/ToUnicode")) {
    // prepare_cm: a /ToUnicode that isn't a stream (/Identity-H) reads as this.
    characterMap = parseToUnicode(Uint8Array.from("beginbfrange\n<0000> <0001> <0000>\nendbfrange",
      (c) => c.charCodeAt(0)));
  }

  const widths = new Map(); // chr(cid) -> width; "default" apart
  let dflt = 0;
  let flags = 32;
  const descendants = pdf.resolve(ft.get("/DescendantFonts"));
  if (!Array.isArray(descendants)) throw new PdfError(`font ${name} has no /DescendantFonts`);
  for (const ref of descendants) {
    const d = pdf.resolve(ref);
    if (!(d instanceof PdfDict)) throw new PdfError("bad descendant font");
    collectCidWidths(pdf, d, widths);
    if (d.has("/DW")) dflt = pdf.resolve(d.get("/DW"));
    const fd = d.has("/FontDescriptor") ? pdf.resolve(d.get("/FontDescriptor")) : new PdfDict();
    flags = 32;
    if (fd instanceof PdfDict) {
      if (fd.has("/Flags")) flags = pdf.resolve(fd.get("/Flags"));
      if (["/FontFile", "/FontFile2", "/FontFile3"].filter((k) => fd.has(k)).length > 1) {
        throw new PdfError("More than one /FontFile found");
      }
    }
  }
  // Font._get_space_char: the first code the ToUnicode map sends to " ".
  let spaceChar = " ";
  for (const [code, text] of characterMap) {
    if (text === " ") {
      spaceChar = code;
      break;
    }
  }
  // Font._add_default_width, when /DW is missing or 0.
  if (!dflt) {
    if (!widths.size) dflt = 500;
    else if (widths.has(spaceChar) && widths.get(spaceChar) !== 0) {
      dflt = (flags & FIXED_PITCH) === FIXED_PITCH ? widths.get(spaceChar)
        : Math.trunc(2 * widths.get(spaceChar));
    } else {
      const valid = [...widths.values()].filter((w) => w > 0);
      dflt = valid.length ? floorDiv(valid.reduce((s, w) => s + w, 0), valid.length) : 500;
    }
  }
  // Font._add_space_width
  let spaceWidth = widths.get(spaceChar) ?? 0;
  if (spaceWidth === 0) spaceWidth = (flags & FIXED_PITCH) === FIXED_PITCH ? dflt : floorDiv(dflt, 2);
  return { name, characterMap, widths, dflt, spaceChar, spaceWidth, interpretable: true };
}

/** Font._collect_cid_character_widths: the /W array, both of its forms. */
function collectCidWidths(pdf, d, widths) {
  const w = d.has("/W") ? pdf.resolve(d.get("/W")) : [];
  if (!Array.isArray(w)) return;
  let skip = 0, entries = 0;
  for (let idx = 0; idx < w.length; idx++) {
    if (skip) {
      skip--;
      continue;
    }
    const entry = pdf.resolve(w[idx]);
    if (typeof entry !== "number") continue;
    const next = idx + 1 < w.length ? pdf.resolve(w[idx + 1]) : undefined;
    if (Array.isArray(next)) {
      const start = Math.trunc(entry);
      if (next.length > 65536) throw new PdfError("CID width range too large");
      entries += next.length;
      if (entries > 100000) throw new PdfError("Too many character widths");
      next.forEach((width, k) => widths.set(String.fromCodePoint(start + k), pdf.resolve(width)));
      skip = 1;
    } else if (typeof next === "number" && idx + 2 < w.length && typeof pdf.resolve(w[idx + 2]) === "number") {
      const start = Math.trunc(entry), stop = Math.trunc(next);
      const width = pdf.resolve(w[idx + 2]);
      if (stop + 1 < start || stop + 1 - start > 65536) throw new PdfError("Invalid CID width range");
      entries += stop - start + 1;
      if (entries > 100000) throw new PdfError("Too many character widths");
      for (let cid = start; cid <= stop; cid++) widths.set(String.fromCodePoint(cid), width);
      skip = 2;
    }
  }
}

/** str.count(sub): non-overlapping; an empty sub counts len + 1. */
function countSub(s, sub) {
  if (!sub) return cpLen(s) + 1;
  let n = 0;
  for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + sub.length)) n++;
  return n;
}

const textWidth = (font, ch) => {
  const w = font.widths.get(ch);
  return 0.0 + (w === undefined ? font.dflt : w);
};

// ------------------------------------------------------------- text state

const mult = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

const orient = (m) => (m[3] > 1e-6 ? 0 : m[3] < -1e-6 ? 180 : m[1] > 0 ? 90 : 270);

/** TextStateParams: one text-show string and the state it was drawn in. */
class TextParams {
  constructor(value, font, fontSize, Tc, Tw, Tz, TL, Ts, transform) {
    Object.assign(this, { value, font, fontSize, Tc, Tw, Tz, TL, Ts, transform });
    this.rotated = false;
    if (value instanceof PdfString) {
      const b = value.bytes;
      if (font.byteEncoding) {
        // Font("Unknown", encoding={}): bytes((x,)).decode() per byte, and on
        // the first non-ASCII byte the whole value as utf-8 with replacement.
        this.decoded = b.every((x) => x < 0x80) ? String.fromCharCode(...b)
          : new TextDecoder("utf-8").decode(b);
      } else if (b.length % 2 === 0) {
        let s = "";
        for (let i = 0; i < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
        this.decoded = s;
      } else {
        this.decoded = new TextDecoder("utf-8").decode(b); // pypdf: utf-8, "replace"
      }
      let text = "";
      for (const ch of this.decoded) {
        const t = font.characterMap.get(ch);
        text += t === undefined ? ch : t;
      }
      this.text = text;
    } else {
      this.decoded = "";
      this.text = value;
    }
    let t = transform;
    if (orient(t) === 90 || orient(t) === 270) {
      t = mult([1.0, -t[1], -t[2], 1.0, 0.0, 0.0], t);
      this.rotated = true;
    }
    if (orient(t) === 180 && t[0] < -1e-6) {
      t = mult([-1.0, 0.0, 0.0, -1.0, 0.0, 0.0], t);
      this.rotated = true;
    }
    this.transform = t;
    this.displacedTx = mult(this.displacementMatrix(), t)[4];
    this.tx = t[4];
    this.ty = mult(this.fontSizeMatrix(), t)[5];
    this.spaceTx = round3(this.wordTx(font.spaceChar));
    if (this.spaceTx < 1e-6) this.spaceTx = round3(this.wordTx("", -font.spaceWidth));
    this.fontHeight = fontSize * Math.sqrt(t[1] * t[1] + t[3] * t[3]);
    this.flipVertical = t[3] < -1e-6;
  }

  fontSizeMatrix() {
    return [this.fontSize * (this.Tz / 100.0), 0.0, 0.0, this.fontSize, 0.0, this.Ts];
  }

  displacementMatrix(word = null, tdOffset = 0.0) {
    return [1.0, 0.0, 0.0, 1.0, this.wordTx(word ?? this.value, tdOffset), 0.0];
  }

  /** word_tx: a string's advance under this state (bytes mean the decoded value). */
  wordTx(word, tdOffset = 0.0) {
    if (word instanceof PdfString) word = this.decoded;
    const font = this.font;
    let width = 0.0, n = 0;
    for (const ch of word) {
      n++;
      if (ch === font.spaceChar) width += font.spaceWidth;
      else width += textWidth(font, ch);
    }
    return (this.fontSize * ((width - tdOffset) / 1000.0) + n * this.Tc
      + countSub(word, font.spaceChar) * this.Tw) * (this.Tz / 100.0);
  }
}

/** TextStateManager: the cm/Tm/Trm stack (newest first) and the text state. */
class TextState {
  constructor() {
    this.stack = [{ m: [1, 0, 0, 1, 0, 0], text: false, render: false }];
    this.qQueue = new Map();
    this.qDepth = [0];
    this.Tc = 0.0;
    this.Tw = 0.0;
    this.Tz = 100.0;
    this.TL = 0.0;
    this.Ts = 0.0;
    this.fontStack = [];
    this.font = null;
    this.fontSize = 0;
  }

  setStateParam(op, value) {
    if (!["Tc", "Tz", "Tw", "TL", "Ts"].includes(op)) return;
    if (Array.isArray(value)) {
      if (!value.length) throw new PdfError(`${op} without an operand`);
      value = value[0];
    }
    this[op] = value;
  }

  setFont(font, size) {
    this.font = font;
    this.fontSize = size;
  }

  params(value = "") {
    if (!this.font) throw new PdfError("font not set: is PDF missing a Tf operator?");
    return new TextParams(value, this.font, this.fontSize, this.Tc, this.Tw, this.Tz, this.TL,
      this.Ts, this.effective());
  }

  resetTm() {
    while (this.stack[0].text || this.stack[0].render) this.stack = this.stack.slice(1);
  }

  resetTrm() {
    while (this.stack[0].render) this.stack = this.stack.slice(1);
  }

  removeQ() {
    if (!this.fontStack.length) throw new PdfError("pop from empty list");
    [this.font, this.fontSize] = this.fontStack.pop();
    this.resetTm();
    const key = this.qDepth.pop();
    const n = this.qQueue.get(key) ?? 0;
    this.qQueue.delete(key);
    this.stack = this.stack.slice(n);
  }

  addQ() {
    this.fontStack.push([this.font, this.fontSize]);
    this.qDepth.push(this.qDepth.length);
  }

  addCm(args) {
    this.resetTm();
    const key = this.qDepth[this.qDepth.length - 1];
    this.qQueue.set(key, (this.qQueue.get(key) ?? 0) + 1);
    this.stack = [{ m: matrix6(args), text: false, render: false }, ...this.stack];
  }

  addTm(operands) {
    this.stack = [{ m: matrix6(operands), text: true, render: false }, ...this.stack];
  }

  addTrm(operands) {
    this.stack = [{ m: matrix6(operands), text: true, render: true }, ...this.stack];
  }

  effective() {
    let eff = this.stack[0].m;
    for (let i = 1; i < this.stack.length; i++) eff = mult(eff, this.stack[i].m);
    return eff;
  }
}

/** new_transform(*operands) after _complete_matrix: 2 operands are a Td. */
function matrix6(ops) {
  if (ops.length === 2) ops = [1.0, 0.0, 0.0, 1.0, ...ops];
  if (ops.length > 6) throw new PdfError("too many matrix operands");
  const dflt = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
  return dflt.map((v, i) => {
    if (i >= ops.length) return v;
    if (typeof ops[i] !== "number") throw new PdfError("matrix operand is not a number");
    return ops[i];
  });
}

// --------------------------------------------------------- content stream

// NameObject.delimiter_pattern, which ends an operator too.
const OPCH = new Uint8Array(256);
for (const b of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d,
  0x7b, 0x7d, 0x2f, 0x25]) OPCH[b] = 1;

/** ContentStream(...).operations with forced_encoding "bytes". */
export function contentOps(data) {
  const lx = new Lexer(data);
  const ops = [];
  let operands = [];
  for (;;) {
    const peek = lx.nonWhitespace();
    if (peek === -1) break;
    lx.pos--;
    const isAlpha = (peek >= 0x41 && peek <= 0x5a) || (peek >= 0x61 && peek <= 0x7a);
    if (isAlpha || peek === 0x27 || peek === 0x22) {
      const op = latin1(lx.until(OPCH, 128));
      if (op === "BI") {
        skipInlineImage(lx);
        ops.push([[], "INLINE IMAGE"]);
        continue;
      }
      ops.push([operands, op]);
      operands = [];
    } else if (peek === 0x25) {
      while (!lx.eof) {
        const b = lx.data[lx.pos++];
        if (b === 0x0d || b === 0x0a) break;
      }
    } else operands.push(lx.object(null));
  }
  return ops;
}

/**
 * Past an inline image (BI ... ID data EI). Layout mode ignores images, so
 * only the position after it matters: the settings are read as objects, the
 * data runs to the first "EI" between whitespace (pypdf's fallback scan).
 */
function skipInlineImage(lx) {
  const d = lx.data;
  for (;;) {
    const tok = lx.nonWhitespace();
    if (tok === -1) throw new PdfError("Unexpected end of stream.");
    lx.pos--;
    if (tok === 0x49) break; // "ID"
    lx.object(null);
    lx.nonWhitespace();
    lx.pos--;
    lx.object(null);
  }
  lx.pos += 3; // "ID" and one whitespace byte
  const ws = (b) => b === undefined || b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09
    || b === 0x0c || b === 0x00;
  for (let i = lx.pos; i < d.length - 1; i++) {
    if (d[i] === 0x45 && d[i + 1] === 0x49 && ws(d[i - 1]) && ws(d[i + 2])) {
      lx.pos = i + 2;
      return;
    }
  }
  throw new PdfError("Could not extract inline image");
}

// ------------------------------------------------------ layout-mode groups

function btGroup(tj, text, displacedTx) {
  return {
    tx: tj.tx, ty: tj.ty, fontSize: tj.fontSize, fontHeight: tj.fontHeight,
    text, displacedTx, flipSort: tj.flipVertical ? -1 : 1,
  };
}

/** recurse_to_target_op */
function recurse(it, st, endTarget, fonts) {
  const btGroups = [];
  const tjOps = [];
  if (endTarget === "Q") st.addQ();
  let ended = false;
  while (it.i < it.ops.length) {
    let [operands, op] = it.ops[it.i++];
    if (op === endTarget) {
      if (op === "Q") st.removeQ();
      if (op === "ET") {
        if (!tjOps.length) return [btGroups, tjOps];
        let text = "";
        let btIdx = 0;
        let lastDisplacedTx = tjOps[btIdx].displacedTx;
        let lastTy = tjOps[btIdx].ty;
        tjOps.forEach((tj, idx) => {
          if (tj.rotated) return; // strip_rotated
          if (!tj.font.interpretable) return;
          if (Math.abs(tj.ty - lastTy) > tj.fontHeight) {
            if (strip(text)) btGroups.push(btGroup(tjOps[btIdx], text, lastDisplacedTx));
            btIdx = idx;
            text = "";
          }
          if (lastDisplacedTx - tj.tx > tj.spaceTx * LAYOUT_NEW_BT_GROUP_SPACE_WIDTHS) {
            if (strip(text)) btGroups.push(btGroup(tjOps[btIdx], text, lastDisplacedTx));
            btIdx = idx;
            lastDisplacedTx = tj.displacedTx;
            text = "";
          }
          const excess = round3(tj.tx - lastDisplacedTx) * (idx !== btIdx ? 1 : 0);
          let spaces = 0;
          if (excess > 0) {
            if (tj.spaceTx === 0) throw new PdfError("float division by zero");
            spaces = roundHalfEven(excess / tj.spaceTx);
          }
          if (spaces > WHITESPACE_LIMIT) spaces = WHITESPACE_LIMIT;
          lastTy = tj.ty;
          text = text + " ".repeat(Math.max(0, spaces)) + tj.text;
          lastDisplacedTx = tj.displacedTx;
        });
        if (text) btGroups.push(btGroup(tjOps[btIdx], text, lastDisplacedTx));
        st.resetTm();
      }
      ended = true;
      break;
    }
    if (op === "q") {
      const [bts, tjs] = recurse(it, st, "Q", fonts);
      btGroups.push(...bts);
      tjOps.push(...tjs);
    } else if (op === "cm") st.addCm(operands);
    else if (op === "BT") {
      const [bts, tjs] = recurse(it, st, "ET", fonts);
      btGroups.push(...bts);
      tjOps.push(...tjs);
    } else if (op === "Tj") tjOps.push(st.params(needOperand(operands, 0)));
    else if (op === "TJ") {
      let tj = st.params();
      const arr = needOperand(operands, 0);
      if (!Array.isArray(arr)) throw new PdfError("TJ operand is not an array");
      for (const el of arr) {
        if (el instanceof PdfString) {
          tj = st.params(el);
          tjOps.push(tj);
        } else {
          if (typeof el !== "number") throw new PdfError("TJ element is neither text nor a number");
          st.addTrm(tj.displacementMatrix(null, el));
        }
      }
    } else if (op === "'") {
      st.resetTrm();
      st.addTm([0, -st.TL]);
      tjOps.push(st.params(needOperand(operands, 0)));
    } else if (op === '"') {
      st.resetTrm();
      st.setStateParam("Tw", needOperand(operands, 0));
      st.setStateParam("Tc", needOperand(operands, 1));
      st.addTm([0, -st.TL]);
      tjOps.push(st.params(needOperand(operands, 2)));
    } else if (op === "Td" || op === "Tm" || op === "TD" || op === "T*") {
      st.resetTrm();
      if (op === "Tm") st.resetTm();
      else if (op === "TD") st.setStateParam("TL", -needOperand(operands, 1));
      else if (op === "T*") operands = [0, -st.TL];
      st.addTm(operands);
    } else if (op === "Tf") st.setFont(fonts.get(needOperand(operands, 0)), needOperand(operands, 1));
    else st.setStateParam(op, operands);
  }
  void ended;
  return [btGroups, tjOps];
}

function needOperand(operands, i) {
  if (i >= operands.length) throw new PdfError("operator is missing an operand");
  return operands[i];
}

/** text_show_operations */
function textShowOperations(ops, fonts) {
  const st = new TextState();
  const it = { ops, i: 0 };
  let btGroups = [];
  while (it.i < ops.length) {
    const [operands, op] = ops[it.i++];
    if (op === "BT" || op === "q") {
      const [bts] = recurse(it, st, op === "BT" ? "ET" : "Q", fonts);
      btGroups.push(...bts);
    } else if (op === "Tf") st.setFont(fonts.get(needOperand(operands, 0)), needOperand(operands, 1));
    else st.setStateParam(op, operands);
  }
  let minX = 0.0;
  if (btGroups.length) {
    minX = btGroups[0].tx;
    for (const g of btGroups) if (g.tx < minX) minX = g.tx;
  }
  const keyed = btGroups.map((g) => [g.ty * g.flipSort, -g.tx, g]);
  keyed.sort((a, b) => (b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : 0));
  return keyed.map(([, , g]) => ({ ...g, tx: g.tx - minX, displacedTx: g.displacedTx - minX }));
}

/** y_coordinate_groups: lines by rendered y, near lines merged. Ordered pairs. */
function yCoordinateGroups(btGroups) {
  const groups = []; // [ty, members], in first-seen order
  let current = null;
  for (const g of btGroups) {
    const ty = Math.trunc(g.ty * g.flipSort) + 0;
    if (!current || current[0] !== ty) {
      current = [ty, []];
      groups.push(current);
    }
    current[1].push(g);
  }
  for (const grp of groups) grp[1] = stableByTx(grp[1]);
  const live = new Map(groups.map((g) => [g[0], g]));
  const txSet = (members) => new Set(members.filter((t) => strip(t.text)).map((t) => Math.trunc(t.tx) + 0));
  let last = groups[0];
  let lastTxs = txSet(last[1]);
  for (const grp of groups.slice(1)) {
    const fsz = Math.min(grp[1][0].fontHeight, last[1][0].fontHeight);
    const txs = txSet(grp[1]);
    let overlap = false;
    for (const x of txs) if (lastTxs.has(x)) overlap = true;
    if (!overlap && Math.abs(grp[0] - last[0]) < fsz) {
      last[1] = stableByTx([...grp[1], ...last[1]]);
      live.delete(grp[0]);
      for (const x of txs) lastTxs.add(x);
    } else {
      last = grp;
      lastTxs = txs;
    }
  }
  return groups.filter((g) => live.get(g[0]) === g);
}

const stableByTx = (arr) => arr.map((g, i) => [g, i])
  .sort((a, b) => (a[0].tx < b[0].tx ? -1 : a[0].tx > b[0].tx ? 1 : a[1] - b[1]))
  .map(([g]) => g);

/** fixed_char_width */
function fixedCharWidth(btGroups, scaleWeight = 1.25) {
  const ws = [], ls = [];
  for (const bt of btGroups) {
    const len = cpLen(bt.text) * scaleWeight;
    const w = (bt.displacedTx - bt.tx) / len;
    ws.push(w * len);
    ls.push(len);
  }
  return fsum312(ws) / fsum312(ls);
}

/** fixed_width_page */
function fixedWidthPage(tyGroups, charWidth) {
  const lines = [];
  let lastY = 0;
  for (const [y, lineData] of tyGroups) {
    if (lines.length) {
      const fh = lineData[0].fontHeight;
      let blank = fh === 0 ? 0 : Math.trunc(Math.abs(y - lastY) / fh) - 1;
      if (blank > NEWLINE_LIMIT) blank = NEWLINE_LIMIT;
      for (let k = 0; k < blank; k++) lines.push("");
    }
    let line = "";
    let currentLen = 0;
    let lastDisp = 0.0;
    for (const bt of lineData) {
      const tx = bt.tx;
      if (charWidth === 0) throw new PdfError("float floor division by zero");
      const offset = Math.trunc(floorDiv(tx, charWidth)) + 0;
      let needed = offset - currentLen;
      if (needed > 0 && Math.ceil(lastDisp) < Math.trunc(tx)) {
        if (needed > WHITESPACE_LIMIT) needed = WHITESPACE_LIMIT;
        line += " ".repeat(needed);
        currentLen += needed;
      }
      const text = bt.text.replace(/[\x0e-\x1f]/g, " ");
      line += text;
      currentLen += cpLen(text);
      lastDisp = bt.displacedTx;
    }
    const full = rstrip(line);
    if (strip(full) || lines.length) lines.push(full);
    lastY = y;
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------- pages

/** PageObject._layout_mode_fonts: page resources, then each ancestor's, later wins. */
function pageFonts(pdf, page) {
  const dicts = new Map();
  let obj = page;
  const visited = new Set();
  while (obj instanceof PdfDict && !visited.has(obj)) {
    visited.add(obj);
    const res = pdf.resolve(obj.get("/Resources"));
    const fontDict = res instanceof PdfDict ? pdf.resolve(res.get("/Font")) : null;
    if (fontDict instanceof PdfDict) {
      for (const [k, v] of fontDict) dicts.set(k, pdf.resolve(v));
    }
    if (!obj.has("/Parent")) break;
    obj = pdf.resolve(obj.get("/Parent"));
  }
  // Built when a Tf selects it: a font the page never uses can't refuse the page.
  const built = new Map();
  return {
    get(name) {
      if (!built.has(name)) {
        const d = dicts.get(name);
        if (!(d instanceof PdfDict)) {
          // resolve_font: an unknown name is an uninterpretable font.
          built.set(name, { name: "Unknown", characterMap: new Map(), widths: new Map(), dflt: 500,
            spaceChar: " ", spaceWidth: 250, interpretable: false, byteEncoding: true });
        } else built.set(name, fontFrom(pdf, d));
      }
      return built.get(name);
    },
  };
}

/** One page's layout-mode text. */
export function pageText(pdf, page) {
  if (!page.has("/Contents")) throw new PdfError("page has no /Contents");
  const contents = pdf.resolve(page.get("/Contents"));
  let data;
  if (Array.isArray(contents)) {
    // ContentStream over an array: the streams joined, each ended by "\n".
    const parts = [];
    let size = 0, lastByte = -1;
    for (const ref of contents) {
      const s = pdf.resolve(ref);
      if (s === null) continue;
      if (s instanceof PdfStream) {
        const d = pdf.streamData(s);
        parts.push(d);
        size += d.length;
        if (d.length) lastByte = d[d.length - 1];
      }
      if (size === 0 || lastByte !== 0x0a) {
        parts.push(Uint8Array.of(0x0a));
        size += 1;
        lastByte = 0x0a;
      }
    }
    data = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      data.set(p, at);
      at += p.length;
    }
  } else if (contents instanceof PdfStream) data = pdf.streamData(contents);
  else throw new PdfError("page /Contents is not a stream");
  const btGroups = textShowOperations(contentOps(data), pageFonts(pdf, page));
  if (!btGroups.length) return "";
  const tyGroups = yCoordinateGroups(btGroups);
  const charWidth = fixedCharWidth(btGroups);
  return fixedWidthPage(tyGroups, charWidth);
}

/** The whole document, pages joined by "\n" as the importer's extract() does. */
export function documentText(pdf) {
  return pdf.pages().map((p) => pageText(pdf, p) || "").join("\n");
}
