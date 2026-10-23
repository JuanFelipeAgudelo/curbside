/**
 * zlib inflate (RFC 1950 around RFC 1951), synchronous.
 *
 * Not the browser's DecompressionStream: that throws on bytes after the end
 * of the data, which PDF writers leave in, and gives nothing back from a
 * damaged stream. pypdf's FlateDecode (the reference) calls zlib.decompress,
 * which ignores trailing bytes, and on an error falls back to feeding zlib a
 * byte at a time and keeping whatever came out. So: decode until the final
 * block, stop quietly at an error, return what was decoded. The checksum is
 * not checked, as that fallback doesn't either.
 */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
  5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Stop extends Error {}

/**
 * More output than pypdf allows (its zlib_maximum_output_length, 75 MB): pypdf
 * fails the extraction there, and so does this, rather than fill a phone's memory.
 */
export class InflateLimit extends Error {}
export const MAX_OUTPUT = 75000000;

/**
 * Canonical Huffman code from code lengths (puff's construct), refusing
 * what zlib's inflate_table refuses: an over-subscribed set, and an
 * incomplete one unless it is a single one-bit code outside the code-length
 * code. No codes at all is allowed until a symbol is asked for.
 */
function huffman(lengths, n, isCodes = false, isFixed = false) {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let s = 0; s < n; s++) count[lengths[s]]++;
  if (count[0] === n) return { count, symbol };
  let left = 1, max = 0;
  for (let len = 1; len < 16; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw new Stop("over-subscribed code");
    if (count[len]) max = len;
  }
  // The fixed distance code is 30 of 32 five-bit codes: incomplete by design.
  if (left > 0 && !isFixed && (isCodes || max !== 1)) throw new Stop("incomplete code");
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let s = 0; s < n; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

let FIXED = null;
function fixed() {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    const d = new Uint8Array(30).fill(5);
    FIXED = [huffman(l, 288, false, true), huffman(d, 30, false, true)];
  }
  return FIXED;
}

export function inflate(data, max = MAX_OUTPUT) {
  const out = new Output(max);
  if (data.length < 2) return out.bytes();
  const cmf = data[0], flg = data[1];
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) {
    return out.bytes(); // not zlib: pypdf ends with nothing too
  }
  let pos = 2, bitbuf = 0, bitcnt = 0;
  const bits = (need) => {
    while (bitcnt < need) {
      if (pos >= data.length) throw new Stop("out of input");
      bitbuf |= data[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << need) - 1);
    bitbuf >>>= need;
    bitcnt -= need;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Stop("ran out of codes");
  };
  try {
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitbuf = 0;
        bitcnt = 0;
        if (pos + 4 > data.length) throw new Stop("out of input");
        const len = data[pos] | (data[pos + 1] << 8);
        const nlen = data[pos + 2] | (data[pos + 3] << 8);
        pos += 4;
        if (len !== (~nlen & 0xffff)) throw new Stop("stored length");
        if (pos + len > data.length) {
          out.push(data.subarray(pos));
          throw new Stop("out of input");
        }
        out.push(data.subarray(pos, pos + len));
        pos += len;
        continue;
      }
      let lit, dist;
      if (type === 1) [lit, dist] = fixed();
      else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        if (nlen > 286 || ndist > 30) throw new Stop("bad counts");
        const lengths = new Uint8Array(320);
        for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(3);
        const lencode = huffman(lengths, 19, true);
        lengths.fill(0);
        let i = 0;
        while (i < nlen + ndist) {
          const sym = decode(lencode);
          if (sym < 16) lengths[i++] = sym;
          else {
            let len = 0, rep;
            if (sym === 16) {
              if (i === 0) throw new Stop("repeat with no length");
              len = lengths[i - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > nlen + ndist) throw new Stop("too many lengths");
            while (rep--) lengths[i++] = len;
          }
        }
        if (lengths[256] === 0) throw new Stop("no end-of-block code");
        lit = huffman(lengths.subarray(0, nlen), nlen);
        dist = huffman(lengths.subarray(nlen, nlen + ndist), ndist);
      } else throw new Stop("bad block type");
      for (;;) {
        let sym = decode(lit);
        if (sym < 256) out.byte(sym);
        else if (sym === 256) break;
        else {
          sym -= 257;
          if (sym >= 29) throw new Stop("bad length symbol");
          const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
          const ds = decode(dist);
          if (ds >= 30) throw new Stop("bad distance symbol");
          const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
          if (d > out.length) throw new Stop("distance too far back");
          out.copy(d, len);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return out.bytes();
}

class Output {
  constructor(max) {
    this.buf = new Uint8Array(1 << 16);
    this.length = 0;
    this.max = max;
  }
  room(n) {
    if (this.length + n > this.max) throw new InflateLimit("stream decompresses past the limit");
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(b) {
    this.room(1);
    this.buf[this.length++] = b;
  }
  push(chunk) {
    this.room(chunk.length);
    this.buf.set(chunk, this.length);
    this.length += chunk.length;
  }
  copy(dist, len) {
    this.room(len);
    const b = this.buf;
    let from = this.length - dist;
    for (let i = 0; i < len; i++) b[this.length++] = b[from++];
  }
  bytes() {
    return this.buf.slice(0, this.length);
  }
}
