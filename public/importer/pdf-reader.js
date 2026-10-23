/**
 * A small PDF reader: the file structure, objects and streams, and the page
 * list, which is what pypdf reads before its layout-mode text extraction.
 *
 * Object syntax follows pypdf 6.18.1's parser (generic/_base.py,
 * generic/_data_structures.py, generic/_utils.py) rather than the PDF spec
 * where the two differ, because the text must come out the same: which
 * bytes are whitespace, how a number or a string escape is read, where a
 * dictionary gives up. The file structure (xref tables and streams, object
 * streams, a rebuild by scanning when the xref is wrong) is read the usual
 * way; there the result, not the route, is what has to match.
 *
 * Refused, not guessed at: encryption, and filters the sheets never use.
 */
import { inflate, InflateLimit, MAX_OUTPUT } from "./inflate.js";

export class PdfError extends Error {}

/** A PDF feature this reader doesn't take on. The message is for people. */
export class UnsupportedPdf extends PdfError {}

/** A PDF that inflates to more than any sheet could be. */
export class PdfTooBig extends PdfError {}

/**
 * What all of one file's streams may inflate to together. inflate() holds a
 * single stream to pypdf's 75 MB, but a file is many streams: 25 MB of small
 * ones that each inflate a thousandfold would be read one after another, on
 * the phone's main thread, into gigabytes (security review, 2026-10-04).
 * Dispatch's sheets inflate to well under a megabyte in all.
 */
export const MAX_TOTAL_OUTPUT = 2 * MAX_OUTPUT;

export class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

/** A string object: its bytes, undecoded. Names are plain JS strings ("/F1"). */
export class PdfString {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

/** A dictionary, keyed by name ("/Type"). Values may be Refs. */
export class PdfDict extends Map {}

export class PdfStream {
  constructor(dict, raw) {
    this.dict = dict;
    this.raw = raw;
  }
}

// pypdf's WHITESPACES: NUL, TAB, LF, FF, CR, SPACE (no VT).
const WS = new Uint8Array(256);
for (const b of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[b] = 1;
// bytes.isspace(): ASCII whitespace, VT included, NUL not.
const ISSPACE = new Uint8Array(256);
for (const b of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) ISSPACE[b] = 1;
// NameObject.delimiter_pattern: \s (bytes: incl. VT, not NUL) or ()<>[]{}/%
const DELIM = new Uint8Array(256);
for (const b of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d,
  0x7b, 0x7d, 0x2f, 0x25]) DELIM[b] = 1;
// NumberObject.NumberPattern is [^+-.0-9]: "+-." is a RANGE, so ',' counts.
const NUMCH = new Uint8Array(256);
for (const b of [0x2b, 0x2c, 0x2d, 0x2e]) NUMCH[b] = 1;
for (let b = 0x30; b <= 0x39; b++) NUMCH[b] = 1;
const NOT_NUM = NUMCH.map((v) => (v ? 0 : 1));
const HEX = new Uint8Array(256);
for (const c of "0123456789abcdefABCDEF") HEX[c.charCodeAt(0)] = 1;
const isAlpha = (b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

const ESCAPES = new Map([
  [0x6e, 0x0a], [0x72, 0x0d], [0x74, 0x09], [0x62, 0x08], [0x66, 0x0c],
  [0x28, 0x28], [0x29, 0x29], [0x2f, 0x2f], [0x5c, 0x5c], [0x20, 0x20],
  [0x25, 0x25], [0x3c, 0x3c], [0x3e, 0x3e], [0x5b, 0x5b], [0x5d, 0x5d],
  [0x23, 0x23], [0x5f, 0x5f], [0x26, 0x26], [0x24, 0x24],
]);

/** Bytes as a string, one char per byte (TextDecoder's "latin1" is cp1252). */
export function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return s;
}

/** A read position over bytes, with pypdf's token readers. */
export class Lexer {
  constructor(data, pos = 0) {
    this.data = data;
    this.pos = pos;
  }

  get eof() {
    return this.pos >= this.data.length;
  }

  /** read_non_whitespace: the next non-whitespace byte, consumed; -1 at EOF. */
  nonWhitespace() {
    const d = this.data;
    while (this.pos < d.length && WS[d[this.pos]]) this.pos++;
    return this.pos < d.length ? d[this.pos++] : -1;
  }

  /**
   * read_until_regex over a one-byte class, with its length limit: it reads
   * in chunks of 16, 32, 64 ... and gives up once it has read `limit` bytes.
   */
  until(cls, limit) {
    const d = this.data, start = this.pos;
    let end = start;
    while (end < d.length && !cls[d[end]]) end++;
    let total = 0, chunk = 16;
    for (;;) {
      const token = Math.min(chunk, d.length - (start + total));
      if (token <= 0) break;
      if (total + token >= limit) throw new PdfError("token too long");
      if (end < start + total + token) break;
      total += token;
      if (chunk < 8192) chunk <<= 1;
    }
    this.pos = end;
    return d.subarray(start, end);
  }

  skipComment() {
    const d = this.data;
    if (d[this.pos] !== 0x25) return;
    while (this.pos < d.length) {
      const b = d[this.pos++];
      if (b === 0x0a || b === 0x0d) return;
    }
    throw new PdfError("File ended unexpectedly.");
  }

  /** read_object. `pdf` resolves stream lengths; null inside content streams. */
  object(pdf) {
    const d = this.data;
    const tok = this.pos < d.length ? d[this.pos] : -1;
    if (tok === 0x2f) return this.name();
    if (tok === 0x3c) {
      if (d[this.pos + 1] === 0x3c) return this.dict(pdf);
      return this.hexString();
    }
    if (tok === 0x5b) return this.array(pdf);
    if (tok === 0x74 || tok === 0x66) {
      const word = latin1(d.subarray(this.pos, this.pos + 4));
      this.pos += 4;
      if (word === "true") return true;
      if (word === "fals") {
        this.pos += 1;
        return false;
      }
      throw new PdfError("Could not read Boolean object");
    }
    if (tok === 0x28) return this.literalString();
    if (tok === 0x65) {
      const word = latin1(d.subarray(this.pos, this.pos + 6));
      this.pos += 6;
      if (word === "endobj") return null;
      throw new PdfError("Invalid Elementary Object starting with 'e'");
    }
    if (tok === 0x6e) {
      const word = latin1(d.subarray(this.pos, this.pos + 4));
      this.pos += 4;
      if (word !== "null") throw new PdfError("Could not read Null object");
      return null;
    }
    if (tok === 0x25) {
      this.skipComment();
      this.nonWhitespace();
      this.pos--;
      return this.object(pdf);
    }
    if (tok === -1 || NUMCH[tok] && tok !== 0x2c) {
      const peek = latin1(d.subarray(this.pos, this.pos + 20));
      const m = /^[+-]?(\d+)[ \t\n\r\f\v]+(\d+)[ \t\n\r\f\v]+R[^a-zA-Z]/.exec(peek);
      if (m) {
        if (!pdf) throw new PdfError("indirect reference in a content stream");
        return this.ref();
      }
      return this.number();
    }
    throw new PdfError(`Invalid Elementary Object starting with ${tok}`);
  }

  ref() {
    const d = this.data;
    const part = (skipLeading) => {
      let s = "";
      for (;;) {
        if (this.pos >= d.length) throw new PdfError("Stream has ended unexpectedly");
        const b = d[this.pos++];
        if (ISSPACE[b] || WS[b]) {
          if (skipLeading && !s) continue;
          break;
        }
        s += String.fromCharCode(b);
      }
      return s;
    };
    const num = part(false);
    const gen = part(true);
    if (this.nonWhitespace() !== 0x52) throw new PdfError("Error reading indirect object reference");
    return new Ref(parseInt(num, 10), parseInt(gen, 10));
  }

  /** NumberObject / FloatObject: an unparsable token is 0, with no complaint. */
  number() {
    const s = latin1(this.until(NOT_NUM, 64));
    if (s.includes(".")) {
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : 0;
    }
    return /^[+-]?\d+$/.test(s) ? Number(s) + 0 : 0;
  }

  name() {
    this.pos++; // "/"
    const raw = this.until(DELIM, 4096);
    // NameObject.unnumber: "#" then int(the next two bytes, 16), which also
    // takes one digit (at the end), "+h" and "-0", and always steps 3 bytes;
    // anything else keeps the "#". Then utf-8, else latin-1 (pypdf tries gbk
    // between the two: font names here are ASCII).
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0x23) {
        const x = latin1(raw.subarray(i + 1, i + 3));
        if (/^([0-9a-fA-F]{1,2}|\+[0-9a-fA-F]|-0)$/.test(x)) {
          out.push(x === "-0" ? 0 : parseInt(x, 16));
          i += 2;
          continue;
        }
      }
      out.push(raw[i]);
    }
    const bytes = Uint8Array.from(out);
    try {
      return "/" + new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return "/" + latin1(bytes);
    }
  }

  hexString() {
    this.pos++; // "<"
    const out = [];
    let x = "";
    for (;;) {
      const tok = this.nonWhitespace();
      if (tok === -1) throw new PdfError("Stream has ended unexpectedly");
      if (tok === 0x3e) break;
      if (!HEX[tok]) throw new PdfError("Invalid hexadecimal character in hex string");
      x += String.fromCharCode(tok);
      if (x.length === 2) {
        out.push(parseInt(x, 16));
        x = "";
      }
    }
    if (x.length === 1) out.push(parseInt(x + "0", 16));
    return new PdfString(Uint8Array.from(out));
  }

  literalString() {
    const d = this.data;
    this.pos++; // "("
    let parens = 1;
    const out = [];
    for (;;) {
      if (this.pos >= d.length) throw new PdfError("Stream has ended unexpectedly");
      let tok = d[this.pos++];
      if (tok === 0x28) parens++;
      else if (tok === 0x29) {
        parens--;
        if (parens === 0) break;
      } else if (tok === 0x5c) {
        if (this.pos >= d.length) throw new PdfError("Stream has ended unexpectedly");
        tok = d[this.pos++];
        if (ESCAPES.has(tok)) {
          out.push(ESCAPES.get(tok));
          continue;
        }
        if (tok >= 0x30 && tok <= 0x37) {
          const sav = this.pos - 1;
          let oct = String.fromCharCode(tok);
          for (let k = 0; k < 2; k++) {
            const n = d[this.pos];
            if (this.pos < d.length && n >= 0x30 && n <= 0x37) {
              oct += String.fromCharCode(n);
              this.pos++;
            } else break;
          }
          const i = parseInt(oct, 8);
          if (i > 255) {
            out.push(0x5c);
            this.pos = sav;
          } else out.push(i);
          continue;
        }
        if (tok === 0x0a || tok === 0x0d) {
          const n = d[this.pos];
          if (this.pos < d.length && (n === 0x0a || n === 0x0d)) this.pos++;
          continue;
        }
        out.push(0x5c);
      }
      out.push(tok);
    }
    return new PdfString(Uint8Array.from(out));
  }

  array(pdf) {
    const d = this.data;
    this.pos++; // "["
    const arr = [];
    for (;;) {
      while (this.pos < d.length && ISSPACE[d[this.pos]]) this.pos++;
      if (this.pos >= d.length) break;
      const tok = d[this.pos];
      if (tok === 0x25) {
        this.skipComment();
        continue;
      }
      if (tok === 0x5d) {
        this.pos++;
        break;
      }
      arr.push(this.object(pdf));
    }
    return arr;
  }

  dict(pdf) {
    const d = this.data;
    this.pos += 2; // "<<"
    const data = new PdfDict();
    for (;;) {
      const tok = this.nonWhitespace();
      if (tok === 0x00) continue;
      if (tok === 0x25) {
        this.pos--;
        this.skipComment();
        continue;
      }
      if (tok === -1) throw new PdfError("Stream has ended unexpectedly");
      if (tok === 0x3e) {
        this.pos++;
        break;
      }
      this.pos--;
      let key, value;
      try {
        try {
          key = this.object(pdf);
          if (key === null) break;
          if (typeof key !== "string") throw new PdfError("Expecting a NameObject for key");
        } catch (e) {
          if (!(e instanceof PdfError)) throw e;
          continue;
        }
        this.nonWhitespace();
        this.pos--;
        value = this.object(pdf);
      } catch (e) {
        if (!(e instanceof PdfError)) throw e;
        return data; // pypdf returns the partial dictionary
      }
      if (!data.has(key)) data.set(key, value);
    }
    const pos = this.pos;
    const s = this.nonWhitespace();
    if (s === 0x73 && latin1(d.subarray(this.pos, this.pos + 5)) === "tream") {
      this.pos += 5;
      let eol = this.pos < d.length ? d[this.pos++] : -1;
      while (eol === 0x20) eol = this.pos < d.length ? d[this.pos++] : -1;
      if (eol !== 0x0a && eol !== 0x0d) throw new PdfError("Stream data must be followed by a newline");
      if (eol === 0x0d) {
        if (d[this.pos] === 0x0a) this.pos++;
      }
      if (!pdf) throw new PdfError("stream in a content stream");
      return new PdfStream(data, pdf.streamBody(this, data));
    }
    this.pos = pos;
    return data;
  }
}

const FILTER_NAMES = { "/Fl": "/FlateDecode", "/AHx": "/ASCIIHexDecode", "/A85": "/ASCII85Decode" };

/** The PDF. Objects are read on demand and cached. */
export class PdfFile {
  /** `limits.maxInflated`: the file's budget for inflated bytes (the tests
   *  set a small one; the default is MAX_TOTAL_OUTPUT). */
  constructor(bytes, limits = {}) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    this.data = bytes;
    this.cache = new Map();
    this.offsets = new Map(); // num -> {offset} | {stream, index}
    this.trailer = new PdfDict();
    this.inflated = 0;
    this.maxInflated = limits.maxInflated ?? MAX_TOTAL_OUTPUT;
    const head = latin1(bytes.subarray(0, 1024));
    if (!head.includes("%PDF-")) throw new PdfError("not a PDF");
    try {
      this.readXref();
    } catch (e) {
      if (e instanceof UnsupportedPdf || e instanceof PdfTooBig) throw e;
      this.rebuildXref();
    }
    if (this.trailer.has("/Encrypt")) throw new UnsupportedPdf("encrypted PDF");
    if (!this.trailer.has("/Root")) this.rebuildXref();
    if (!this.trailer.has("/Root")) throw new PdfError("no document catalog");
  }

  readXref() {
    const d = this.data;
    const tail = latin1(d.subarray(Math.max(0, d.length - 1024)));
    const at = tail.lastIndexOf("startxref");
    if (at < 0) throw new PdfError("no startxref");
    const m = /^startxref\s+(\d+)/.exec(tail.slice(at));
    if (!m) throw new PdfError("bad startxref");
    const seen = new Set();
    let offset = Number(m[1]);
    let first = true;
    while (offset !== undefined && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefSection(offset);
      if (first) {
        this.trailer = trailer;
        first = false;
      } else {
        for (const [k, v] of trailer) if (!this.trailer.has(k)) this.trailer.set(k, v);
      }
      const prev = trailer.get("/Prev");
      offset = typeof prev === "number" ? prev : undefined;
    }
    // Every object the xref names must be where it says, or rebuild.
    for (const [num, loc] of this.offsets) {
      if (loc.offset !== undefined && !this.headerAt(loc.offset, num)) {
        throw new PdfError("xref offset does not point at its object");
      }
    }
  }

  headerAt(offset, num) {
    const s = latin1(this.data.subarray(offset, offset + 40));
    const m = /^[\0\t\n\f\r ]*(\d+)\s+(\d+)\s+obj/.exec(s);
    return m && Number(m[1]) === num;
  }

  readXrefSection(offset) {
    const d = this.data;
    const lx = new Lexer(d, offset);
    lx.nonWhitespace();
    lx.pos--;
    if (latin1(d.subarray(lx.pos, lx.pos + 4)) === "xref") {
      lx.pos += 4;
      for (;;) {
        lx.nonWhitespace();
        lx.pos--;
        const line = latin1(d.subarray(lx.pos, lx.pos + 32));
        if (line.startsWith("trailer")) {
          lx.pos += 7;
          lx.nonWhitespace();
          lx.pos--;
          const trailer = lx.object(this);
          if (!(trailer instanceof PdfDict)) throw new PdfError("bad trailer");
          const stm = trailer.get("/XRefStm");
          if (typeof stm === "number") this.readXrefSection(stm);
          return trailer;
        }
        const sub = /^(\d+)\s+(\d+)/.exec(line);
        if (!sub) throw new PdfError("bad xref subsection");
        lx.pos += sub[0].length;
        const start = Number(sub[1]), count = Number(sub[2]);
        for (let i = 0; i < count; i++) {
          lx.nonWhitespace();
          lx.pos--;
          const e = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(latin1(d.subarray(lx.pos, lx.pos + 20)));
          if (!e) throw new PdfError("bad xref entry");
          lx.pos += e[0].length;
          const num = start + i;
          if (e[3] === "n" && !this.offsets.has(num)) this.offsets.set(num, { offset: Number(e[1]) });
          if (e[3] === "f" && !this.offsets.has(num)) this.offsets.set(num, { free: true });
        }
      }
    }
    // An xref stream: "n g obj << /Type /XRef ... >> stream".
    const { value } = this.objectAt(offset);
    if (!(value instanceof PdfStream) || value.dict.get("/Type") !== "/XRef") {
      throw new PdfError("startxref points at neither xref table nor xref stream");
    }
    const dict = value.dict;
    const w = this.resolve(dict.get("/W")).map((x) => this.resolve(x));
    const size = this.resolve(dict.get("/Size"));
    const index = dict.has("/Index") ? this.resolve(dict.get("/Index")).map((x) => this.resolve(x)) : [0, size];
    const data = this.streamData(value);
    let p = 0;
    const field = (width, dflt) => {
      if (!width) return dflt;
      let v = 0;
      for (let k = 0; k < width; k++) v = v * 256 + data[p++];
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i++) {
        if (p + w[0] + w[1] + w[2] > data.length) break;
        const type = field(w[0], 1), a = field(w[1], 0), b = field(w[2], 0);
        const num = index[s] + i;
        if (this.offsets.has(num)) continue;
        if (type === 1) this.offsets.set(num, { offset: a });
        else if (type === 2) this.offsets.set(num, { stream: a, index: b });
        else if (type === 0) this.offsets.set(num, { free: true });
      }
    }
    return dict;
  }

  /** No usable xref: find every "n g obj" in the file; the last one wins. */
  rebuildXref() {
    this.offsets = new Map();
    this.cache = new Map();
    const text = latin1(this.data);
    const re = /(?:^|[\0\t\n\f\r ])(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj\b/g;
    let m;
    while ((m = re.exec(text))) {
      const offset = m.index + (/\d/.test(m[0][0]) ? 0 : 1);
      this.offsets.set(Number(m[1]), { offset });
    }
    let t;
    const tre = /trailer[\0\t\n\f\r ]*<</g;
    let lastTrailer = null;
    while ((t = tre.exec(text))) lastTrailer = t.index + t[0].length - 2;
    if (lastTrailer !== null) {
      try {
        const trailer = new Lexer(this.data, lastTrailer).object(this);
        if (trailer instanceof PdfDict) this.trailer = trailer;
      } catch {
        /* keep looking below */
      }
    }
    if (!this.trailer.has("/Root")) {
      for (const [num] of this.offsets) {
        try {
          const v = this.get(new Ref(num, 0));
          if (v instanceof PdfStream && v.dict.get("/Type") === "/XRef" && v.dict.has("/Root")) {
            this.trailer = v.dict;
          } else if (v instanceof PdfDict && v.get("/Type") === "/Catalog") {
            this.trailer.set("/Root", new Ref(num, 0));
          }
        } catch {
          /* a broken object is skipped */
        }
      }
    }
  }

  /** The object at a byte offset, header included. */
  objectAt(offset) {
    const lx = new Lexer(this.data, offset);
    lx.nonWhitespace();
    lx.pos--;
    const head = /^(\d+)\s+(\d+)\s+obj/.exec(latin1(this.data.subarray(lx.pos, lx.pos + 40)));
    if (!head) throw new PdfError(`no object at ${offset}`);
    lx.pos += head[0].length;
    lx.nonWhitespace();
    lx.pos--;
    return { num: Number(head[1]), value: lx.object(this) };
  }

  get(ref) {
    if (this.cache.has(ref.num)) return this.cache.get(ref.num);
    const loc = this.offsets.get(ref.num);
    let value = null;
    if (loc && loc.offset !== undefined) {
      this.cache.set(ref.num, null); // a cycle reads as null
      value = this.objectAt(loc.offset).value;
    } else if (loc && loc.stream !== undefined) {
      this.cache.set(ref.num, null);
      value = this.fromObjectStream(loc.stream, loc.index, ref.num);
    }
    this.cache.set(ref.num, value);
    return value;
  }

  fromObjectStream(stmNum, index, num) {
    const stm = this.get(new Ref(stmNum, 0));
    if (!(stm instanceof PdfStream)) throw new PdfError("object stream missing");
    if (!stm.parsed) {
      const data = this.streamData(stm);
      const n = this.resolve(stm.dict.get("/N"));
      const first = this.resolve(stm.dict.get("/First"));
      const lx = new Lexer(data, 0);
      const table = [];
      for (let i = 0; i < n; i++) {
        lx.nonWhitespace();
        lx.pos--;
        const objNum = lx.number();
        lx.nonWhitespace();
        lx.pos--;
        const off = lx.number();
        table.push([objNum, off]);
      }
      stm.parsed = { data, first, table };
    }
    const { data, first, table } = stm.parsed;
    const entry = table.find((e) => e[0] === num); // pypdf takes the first match
    if (!entry) return null;
    const lx = new Lexer(data, first + entry[1]);
    lx.nonWhitespace();
    lx.pos--;
    return lx.object(this);
  }

  resolve(v) {
    let guard = 0;
    while (v instanceof Ref) {
      if (++guard > 32) throw new PdfError("reference loop");
      v = this.get(v);
    }
    return v;
  }

  /** A stream's raw body, positioned just after "stream" + EOL (pypdf's rules). */
  streamBody(lx, dict) {
    const d = this.data;
    let length = dict.has("/Length") ? dict.get("/Length") : -1;
    if (length instanceof Ref) {
      const saved = lx.pos;
      length = this.resolve(length);
      lx.pos = saved;
    }
    if (typeof length !== "number") length = -1;
    // pypdf's maximum_declared_stream_length
    if (length > MAX_OUTPUT) throw new PdfError("Declared stream length exceeds maximum allowed length.");
    const pstart = lx.pos;
    let body;
    if (length >= 0) {
      body = d.subarray(lx.pos, lx.pos + length);
      lx.pos += body.length;
    } else {
      const at = indexOf(d, ENDSTREAM, lx.pos);
      body = d.subarray(lx.pos, at < 0 ? d.length : at);
      lx.pos += body.length;
    }
    const e = lx.nonWhitespace();
    const nd = latin1(d.subarray(lx.pos, lx.pos + 8));
    lx.pos = Math.min(d.length, lx.pos + 8);
    if ((e >= 0 ? String.fromCharCode(e) : "") + nd !== "endstream") {
      if (latin1(d.subarray(lx.pos - 10, lx.pos - 1)) === "endstream") {
        body = body.subarray(0, body.length - 1);
      } else {
        const at = indexOf(d, ENDSTREAM, pstart);
        if (at < 0) throw new PdfError("Unable to find 'endstream' marker");
        body = d.subarray(pstart, Math.max(pstart, at - 1));
        lx.pos = at + 9;
      }
    }
    return body;
  }

  /** decode_stream_data: the filter chain. */
  streamData(stream) {
    if (stream.decoded) return stream.decoded;
    const dict = stream.dict;
    let filters = this.resolve(dict.get("/Filter") ?? dict.get("/F"));
    let parms = this.resolve(dict.get("/DecodeParms") ?? dict.get("/DP"));
    if (typeof filters === "string") filters = [filters];
    if (!Array.isArray(filters)) filters = [];
    if (!Array.isArray(parms)) parms = [parms];
    let data = stream.raw;
    filters.forEach((f, i) => {
      const name = FILTER_NAMES[this.resolve(f)] ?? this.resolve(f);
      const p = this.resolve(parms[i]);
      if (name === "/FlateDecode") {
        // What is left of the file's budget, and never more than one stream may be.
        const room = this.maxInflated - this.inflated;
        let raw;
        try {
          raw = inflate(data, Math.min(MAX_OUTPUT, room));
        } catch (e) {
          if (e instanceof InflateLimit) {
            if (room < MAX_OUTPUT) throw new PdfTooBig("This PDF decompresses to more than a sheet could be.");
            throw new PdfError("Limit reached while decompressing.");
          }
          throw e;
        }
        this.inflated += raw.length;
        data = predict(raw, p instanceof PdfDict ? p : null, this);
      }
      else if (name === "/ASCIIHexDecode") data = asciiHex(data);
      else if (name === "/ASCII85Decode") data = ascii85(data);
      else throw new UnsupportedPdf(`stream filter ${name}`);
    });
    stream.decoded = data;
    return data;
  }

  /** pypdf's reader.pages: the page tree flattened, inheritable keys copied down. */
  pages() {
    const root = this.resolve(this.trailer.get("/Root"));
    const tree = root instanceof PdfDict ? this.resolve(root.get("/Pages")) : null;
    const out = [];
    const INHERIT = ["/Resources", "/MediaBox", "/CropBox", "/Rotate"];
    // One `inherit` map for the whole walk, as pypdf's _flatten shares its
    // dict: a /Pages node's /Resources reach its later siblings too.
    const walk = (node, inherit, depth) => {
      if (!(node instanceof PdfDict) || !node.size || depth > 64) return;
      const type = node.has("/Type") ? this.resolve(node.get("/Type"))
        : node.has("/Kids") ? "/Pages" : "/Page";
      if (type === "/Pages") {
        for (const k of INHERIT) if (node.has(k)) inherit.set(k, node.get(k));
        const kids = this.resolve(node.get("/Kids"));
        if (Array.isArray(kids)) for (const kid of kids) walk(this.resolve(kid), inherit, depth + 1);
      } else if (type === "/Page") {
        for (const [k, v] of inherit) if (!node.has(k)) node.set(k, v);
        out.push(node);
      }
    };
    walk(tree, new Map(), 0);
    return out;
  }
}

const ENDSTREAM = Uint8Array.from("endstream", (c) => c.charCodeAt(0));

function indexOf(hay, needle, from) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** FlateDecode's /Predictor: TIFF 2 and PNG 10-15, as pypdf applies them. */
function predict(data, parms, pdf) {
  if (!parms) return data;
  const get = (k, dflt) => {
    const v = pdf.resolve(parms.get(k));
    return typeof v === "number" ? v : dflt;
  };
  const predictor = get("/Predictor", 1);
  if (predictor === 1) return data;
  const columns = get("/Columns", 1), colors = get("/Colors", 1);
  const bpc = get("/BitsPerComponent", 8);
  const rowlength = Math.ceil((columns * colors * bpc) / 8) + 1;
  if (predictor === 2) {
    const row = rowlength - 1;
    const bpp = Math.floor(row / columns);
    const out = Uint8Array.from(data);
    for (let i = 0; i < out.length; i++) if (i % row >= bpp) out[i] = (out[i] + out[i - bpp]) & 0xff;
    return out;
  }
  if (predictor < 10 || predictor > 15) throw new UnsupportedPdf(`predictor ${predictor}`);
  // FlateDecode._decode_png_prediction: bpp is 1 byte, as pypdf assumes.
  const width = rowlength - 1;
  const rows = [];
  let prev = new Uint8Array(width);
  for (let r = 0; r + rowlength <= data.length; r += rowlength) {
    const ft = data[r];
    const row = Uint8Array.from(data.subarray(r + 1, r + rowlength));
    for (let i = 0; i < width; i++) {
      const left = i > 0 ? row[i - 1] : 0, up = prev[i], ul = i > 0 ? prev[i - 1] : 0;
      if (ft === 1) row[i] = (row[i] + left) & 0xff;
      else if (ft === 2) row[i] = (row[i] + up) & 0xff;
      else if (ft === 3) row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
      else if (ft === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)) & 0xff;
      } else if (ft !== 0) throw new PdfError(`Unsupported PNG filter ${ft}`);
    }
    rows.push(row);
    prev = row;
  }
  const out = new Uint8Array(rows.length * width);
  rows.forEach((row, i) => out.set(row, i * width));
  return out;
}

function asciiHex(data) {
  const out = [];
  let x = "";
  for (const b of data) {
    if (b === 0x3e) break;
    if (WS[b]) continue;
    x += String.fromCharCode(b);
    if (x.length === 2) {
      out.push(parseInt(x, 16));
      x = "";
    }
  }
  if (x) out.push(parseInt(x + "0", 16));
  return Uint8Array.from(out);
}

function ascii85(data) {
  const out = [];
  let group = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0x7e) break; // "~>"
    if (WS[b]) continue;
    if (b === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(b - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}
