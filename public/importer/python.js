/**
 * The Python semantics the importer depends on, reproduced exactly.
 *
 * The reader was ported from a Python importer on pypdf 6.18.1 and CPython
 * 3.12 (in git at the tag python-importer-last), and the answers it is held
 * to are theirs. Its text is fixed-width: a column position comes out of a float
 * division, a floor, a rounding and a compensated sum, and one unit of
 * difference shifts a cell by a column. So nothing here is "close enough":
 * each function is the CPython algorithm, named where it lives.
 *
 * Unicode tables are the JS engine's (Unicode 15.1+). CPython 3.12 has 15.0,
 * so only characters encoded since then can differ.
 */
import { FOLD } from "./casefold.js";

/** str.isspace() and re's \s on str patterns: the same 29 characters. */
export const WS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`;
const WS_CODES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** One code unit. Every Python whitespace character is in the BMP. */
export const isSpaceCode = (u) => WS_CODES.has(u);

export function strip(s) {
  return rstrip(lstrip(s));
}

export function lstrip(s) {
  let i = 0;
  while (i < s.length && WS_CODES.has(s.charCodeAt(i))) i++;
  return i ? s.slice(i) : s;
}

export function rstrip(s) {
  let j = s.length;
  while (j > 0 && WS_CODES.has(s.charCodeAt(j - 1))) j--;
  return j < s.length ? s.slice(0, j) : s;
}

/** str.split() with no separator: runs of whitespace, no empty ends. */
export function splitWs(s) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const ws = i === s.length || WS_CODES.has(s.charCodeAt(i));
    if (ws) {
      if (start >= 0) out.push(s.slice(start, i));
      start = -1;
    } else if (start < 0) start = i;
  }
  return out;
}

/** len(): code points, not UTF-16 units. */
export function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff && i + 1 < s.length) {
      const v = s.charCodeAt(i + 1);
      if (v >= 0xdc00 && v <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** s[:n], counted in code points. */
export function cpHead(s, n) {
  let i = 0;
  for (let k = 0; k < n && i < s.length; k++) {
    const u = s.charCodeAt(i);
    i += u >= 0xd800 && u <= 0xdbff && i + 1 < s.length
      && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff ? 2 : 1;
  }
  return s.slice(0, i);
}

/** Python's str ordering: by code point (JS < compares UTF-16 units). */
export function cpCompare(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0;
}

/** str.casefold(): per character, no context. */
export function casefold(s) {
  let out = "";
  for (const ch of s) {
    const f = FOLD[ch.codePointAt(0)];
    out += f === undefined ? ch.toLowerCase() : f;
  }
  return out;
}

/** round(x) on a float: CPython float___round___impl, ties to even. */
export function roundHalfEven(x) {
  const a = Math.abs(x);
  let r = Math.floor(a);
  if (a - r >= 0.5) r += 1; // C round(): half away from zero, exact
  let rounded = x < 0 ? -r : r;
  if (Math.abs(x - rounded) === 0.5) {
    const h = x / 2;
    const ha = Math.abs(h);
    let hr = Math.floor(ha);
    if (ha - hr >= 0.5) hr += 1;
    rounded = 2 * (h < 0 ? -hr : hr);
  }
  return rounded === 0 ? 0 : rounded;
}

/**
 * round(x, 3) on a float: CPython double_round, the correctly rounded
 * decimal (ties to even) read back as a float. toFixed is exact but breaks
 * ties upward; at 3 places a tie is x = m/16 with m odd, handled apart.
 */
export function round3(x) {
  if (!Number.isFinite(x)) return x;
  const s = x * 16;
  if (Number.isInteger(s) && Math.abs(s) % 2 === 1) {
    const t = x * 1000; // exact: 62.5 * m
    const lo = Math.floor(t);
    const n = lo % 2 === 0 ? lo : lo + 1;
    return n / 1000;
  }
  return parseFloat(x.toFixed(3));
}

/** a // b on floats: CPython _float_div_mod, snapped the way it snaps. */
export function floorDiv(vx, wx) {
  if (wx === 0) throw new RangeError("float floor division by zero");
  let mod = vx % wx; // fmod: exact, sign of the dividend
  let div = (vx - mod) / wx;
  if (mod) {
    if ((wx < 0) !== (mod < 0)) {
      mod += wx;
      div -= 1.0;
    }
  }
  let floordiv;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = Object.is(vx / wx, -0) || vx / wx < 0 ? -0 : 0;
  }
  return floordiv;
}

/**
 * sum() over floats, as CPython 3.12 does it: the first item starts the
 * total, the rest go through Neumaier's compensated addition, and the
 * compensation is added once at the end.
 */
export function fsum312(values) {
  if (!values.length) return 0;
  let f = 0 + values[0];
  let c = 0.0;
  for (let i = 1; i < values.length; i++) {
    const x = values[i];
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

// The zero of every run of Unicode decimal digits (category Nd), from
// CPython 3.12. int() accepts any of them; a digit's value is its distance
// from the zero of its run.
const ND_ZEROS = [
  48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558,
  3664, 3792, 3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232,
  7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016, 65296, 66720, 68912, 69734,
  69872, 69942, 70096, 70384, 70736, 70864, 71248, 71360, 71472, 71904, 72016, 72784,
  73040, 73120, 73552, 92768, 92864, 93008, 120782, 120792, 120802, 120812, 120822,
  123200, 123632, 124144, 125264, 130032,
];

/** int(s) for a string the regexes proved to be Unicode digits. */
export function pyInt(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 48 && cp <= 57) {
      n = n * 10 + (cp - 48);
      continue;
    }
    let zero = -1;
    for (const z of ND_ZEROS) if (z <= cp && cp < z + 10) zero = z;
    if (zero < 0) throw new SyntaxError(`invalid literal for int(): ${repr(s)}`);
    n = n * 10 + (cp - zero);
  }
  return n;
}

const WORD = String.raw`\p{L}\p{N}_`;
const SYNTAX = "^$\\.*+?()[]{}|/";

/**
 * A Python `re` pattern (str, Unicode) as a JS RegExp with the u flag, so the
 * importer's patterns are copied verbatim. What differs, and is rewritten:
 * \s \d \w \b are Unicode in Python; `.` stops only at "\n"; `$` also
 * matches before a final "\n" (and, with re.M, only "\n" ends a line);
 * `(?P<name>`; escapes JS's u flag refuses (`\-` outside a class). Only the
 * constructs these patterns use are handled; anything else throws.
 * Flags: "M" (re.M), "I" (re.IGNORECASE), "g" (for findall/sub).
 */
export function pyRe(src, flags = "") {
  const M = flags.includes("M");
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const e = src[++i];
      if (e === undefined) throw new SyntaxError("pattern ends with a backslash");
      if (inClass) {
        if (e === "s") out += WS;
        else if (e === "d") out += String.raw`\p{Nd}`;
        else if (e === "w") out += WORD;
        else if (e === "u" && src[i + 1] === "{") {
          const close = src.indexOf("}", i);
          out += src.slice(i - 1, close + 1);
          i = close;
        } else if ("SDWb".includes(e)) throw new SyntaxError(`\\${e} inside a class`);
        else out += "\\" + e;
        continue;
      }
      if (e === "s") out += `[${WS}]`;
      else if (e === "S") out += `[^${WS}]`;
      else if (e === "d") out += String.raw`\p{Nd}`;
      else if (e === "D") out += String.raw`\P{Nd}`;
      else if (e === "w") out += `[${WORD}]`;
      else if (e === "W") out += `[^${WORD}]`;
      else if (e === "b") out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
      else if (e === "u" && src[i + 1] === "{") {
        const close = src.indexOf("}", i);
        out += src.slice(i - 1, close + 1);
        i = close;
      } else if ("ntrfv".includes(e) || SYNTAX.includes(e)) out += "\\" + e;
      else if (/[A-Za-z0-9]/.test(e)) throw new SyntaxError(`unsupported escape \\${e}`);
      else out += e; // Python's identity escape of a plain character
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      // [^\W\d_] is "a letter": \w without digits and "_", with no \W in JS classes.
      if (src.startsWith(String.raw`[^\W\d_]`, i)) {
        out += String.raw`[\p{L}\p{Nl}\p{No}]`;
        i += 7;
        continue;
      }
      inClass = true;
      out += c;
      if (src[i + 1] === "^") out += src[++i];
      if (src[i + 1] === "]") out += "\\" + src[++i];
      continue;
    }
    if (c === ".") out += "[^\\n]";
    else if (c === "$") out += M ? "(?=\\n|$)" : "(?=\\n?$)";
    else if (c === "^") out += M ? "(?<=^|\\n)" : "^";
    else if (c === "(" && src.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
    } else out += c;
  }
  return new RegExp(out, "u" + (flags.includes("I") ? "i" : "") + (flags.includes("g") ? "g" : ""));
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** repr() of a str, as an f-string's !r writes it. */
export function repr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x7f || ch === " ") out += ch;
    else if (NON_PRINTABLE.test(ch)) {
      if (cp <= 0xff) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
      else out += "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}
