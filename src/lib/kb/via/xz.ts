// A small .xz decoder (LZMA2 filter only, which is what Python's lzma.compress writes), for the
// keyboard definition a Vial board keeps in its firmware (vial-qmk util/vial_generate_definition.py
// compresses the JSON with lzma.compress). The whole output stays in memory, so it is the LZMA
// dictionary. The stream's CRC32 / CRC64 check is verified. Pure: no I/O. Throws on anything else.

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

class Out {
  buf = new Uint8Array(4096);
  len = 0;
  push(b: number) {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }
  at(back: number): number {
    // back = distance + 1
    if (back > this.len || back <= 0) throw new Error("xz: match distance past the start");
    return this.buf[this.len - back];
  }
}

class Range {
  range = 0xffffffff;
  code = 0;
  pos: number;
  readonly src: Uint8Array;
  constructor(src: Uint8Array, start: number) {
    this.src = src;
    if (src[start] !== 0) throw new Error("xz: bad range coder start");
    this.pos = start + 1;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }
  byte(): number {
    if (this.pos >= this.src.length) throw new Error("xz: truncated");
    return this.src[this.pos++];
  }
  norm() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }
  bit(p: Uint16Array, i: number): number {
    const bound = ((this.range >>> 11) * p[i]) >>> 0;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      p[i] += (2048 - p[i]) >>> 5;
      b = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      p[i] -= p[i] >>> 5;
      b = 1;
    }
    this.norm();
    return b;
  }
  direct(n: number): number {
    let r = 0;
    for (let i = 0; i < n; i++) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code = (this.code - this.range) >>> 0;
        b = 1;
      }
      r = ((r << 1) | b) >>> 0;
      this.norm();
    }
    return r;
  }
  tree(p: Uint16Array, base: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(p, base + m);
    return m - (1 << bits);
  }
  reverse(p: Uint16Array, base: number, bits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(p, base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }
}

class LenDecoder {
  p = new Uint16Array(2 + 16 * 8 * 2 + 256).fill(1024);
  reset() {
    this.p.fill(1024);
  }
  decode(rc: Range, posState: number): number {
    if (!rc.bit(this.p, 0)) return rc.tree(this.p, 2 + posState * 8, 3);
    if (!rc.bit(this.p, 1)) return 8 + rc.tree(this.p, 2 + 128 + posState * 8, 3);
    return 16 + rc.tree(this.p, 2 + 256, 8);
  }
}

class Lzma {
  lc = 3;
  lp = 0;
  pb = 2;
  state = 0;
  reps = [0, 0, 0, 0];
  isMatch = new Uint16Array(192);
  isRep = new Uint16Array(12);
  isRepG0 = new Uint16Array(12);
  isRepG1 = new Uint16Array(12);
  isRepG2 = new Uint16Array(12);
  isRep0Long = new Uint16Array(192);
  posSlot = new Uint16Array(4 * 64);
  posDecoders = new Uint16Array(115);
  align = new Uint16Array(16);
  literal = new Uint16Array(0x300 << 4);
  len = new LenDecoder();
  repLen = new LenDecoder();

  setProps(props: number) {
    if (props >= 9 * 5 * 5) throw new Error("xz: bad LZMA properties");
    this.lc = props % 9;
    props = Math.floor(props / 9);
    this.lp = props % 5;
    this.pb = Math.floor(props / 5);
    if (this.lc + this.lp > 4) throw new Error("xz: lc + lp > 4");
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp));
  }

  resetState() {
    this.state = 0;
    this.reps = [0, 0, 0, 0];
    for (const a of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posDecoders, this.align, this.literal]) a.fill(1024);
    this.len.reset();
    this.repLen.reset();
  }

  /** Decodes exactly `size` bytes from `rc` into `out`. */
  chunk(rc: Range, out: Out, size: number) {
    const end = out.len + size;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    while (out.len < end) {
      const posState = out.len & pbMask;
      const s = this.state;
      if (!rc.bit(this.isMatch, (s << 4) | posState)) {
        const prev = out.len ? out.at(1) : 0;
        const base = 0x300 * (((out.len & lpMask) << this.lc) + (prev >> (8 - this.lc)));
        let sym = 1;
        if (s >= 7) {
          let match = out.at(this.reps[0] + 1);
          do {
            const mb = (match >> 7) & 1;
            match = (match << 1) & 0xff;
            const b = rc.bit(this.literal, base + ((1 + mb) << 8) + sym);
            sym = (sym << 1) | b;
            if (mb !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.literal, base + sym);
        out.push(sym & 0xff);
        this.state = s < 4 ? 0 : s < 10 ? s - 3 : s - 6;
        continue;
      }
      let len: number;
      if (rc.bit(this.isRep, s)) {
        if (!rc.bit(this.isRepG0, s)) {
          if (!rc.bit(this.isRep0Long, (s << 4) | posState)) {
            this.state = s < 7 ? 9 : 11;
            out.push(out.at(this.reps[0] + 1));
            continue;
          }
        } else {
          let dist: number;
          if (!rc.bit(this.isRepG1, s)) dist = this.reps[1];
          else {
            if (!rc.bit(this.isRepG2, s)) dist = this.reps[2];
            else {
              dist = this.reps[3];
              this.reps[3] = this.reps[2];
            }
            this.reps[2] = this.reps[1];
          }
          this.reps[1] = this.reps[0];
          this.reps[0] = dist;
        }
        len = this.repLen.decode(rc, posState);
        this.state = s < 7 ? 8 : 11;
      } else {
        this.reps[3] = this.reps[2];
        this.reps[2] = this.reps[1];
        this.reps[1] = this.reps[0];
        len = this.len.decode(rc, posState);
        this.state = s < 7 ? 7 : 10;
        const lenState = len < 4 ? len : 3;
        const slot = rc.tree(this.posSlot, lenState * 64, 6);
        let dist: number;
        if (slot < 4) dist = slot;
        else {
          const direct = (slot >> 1) - 1;
          dist = ((2 | (slot & 1)) << direct) >>> 0;
          if (slot < 14) dist += rc.reverse(this.posDecoders, dist - slot, direct);
          else {
            dist += rc.direct(direct - 4) << 4;
            dist += rc.reverse(this.align, 0, 4);
          }
          dist >>>= 0;
        }
        if (dist === 0xffffffff) break; // end marker
        this.reps[0] = dist;
      }
      for (let i = 0; i < len + 2 && out.len < end; i++) out.push(out.at(this.reps[0] + 1));
    }
  }
}

function vli(src: Uint8Array, at: { i: number }): number {
  let v = 0;
  for (let shift = 0; shift < 63; shift += 7) {
    const b = src[at.i++];
    if (b === undefined) throw new Error("xz: truncated header");
    v += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return v;
  }
  throw new Error("xz: bad number");
}

let crc32Table: Uint32Array | null = null;
export function crc32(data: Uint8Array, len = data.length): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32Table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) c = crc32Table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let crc64Table: BigUint64Array | null = null;
function crc64(data: Uint8Array, len: number): bigint {
  if (!crc64Table) {
    crc64Table = new BigUint64Array(256);
    const poly = 0xc96c5795d7870f42n;
    for (let n = 0; n < 256; n++) {
      let c = BigInt(n);
      for (let k = 0; k < 8; k++) c = c & 1n ? poly ^ (c >> 1n) : c >> 1n;
      crc64Table[n] = c;
    }
  }
  let c = 0xffffffffffffffffn;
  for (let i = 0; i < len; i++) c = crc64Table[Number((c ^ BigInt(data[i])) & 0xffn)] ^ (c >> 8n);
  return c ^ 0xffffffffffffffffn;
}

const u32le = (s: Uint8Array, i: number) => (s[i] | (s[i + 1] << 8) | (s[i + 2] << 16) | (s[i + 3] << 24)) >>> 0;

/** Decompresses an .xz stream (LZMA2 blocks) and checks its CRC. */
export function xzDecompress(src: Uint8Array): Uint8Array {
  if (src.length < 32 || MAGIC.some((b, i) => src[i] !== b)) throw new Error("Not an xz stream.");
  if (crc32(src.subarray(6, 8)) !== u32le(src, 8)) throw new Error("xz: stream header CRC");
  const check = src[7] & 0x0f;
  const checkSize = check === 0 ? 0 : check === 1 ? 4 : check === 4 ? 8 : check === 10 ? 32 : -1;
  if (checkSize < 0) throw new Error("xz: unknown check type");
  const out = new Out();
  const lz = new Lzma();
  let i = 12;
  while (src[i] !== 0x00) {
    // Block header.
    const blockStart = out.len;
    const headerSize = (src[i] + 1) * 4;
    if (crc32(src.subarray(i, i + headerSize - 4)) !== u32le(src, i + headerSize - 4)) throw new Error("xz: block header CRC");
    const flags = src[i + 1];
    const at = { i: i + 2 };
    if (flags & 0x40) vli(src, at);
    if (flags & 0x80) vli(src, at);
    const filters = (flags & 3) + 1;
    if (filters !== 1) throw new Error("xz: only plain LZMA2 is supported");
    const id = vli(src, at);
    const propSize = vli(src, at);
    if (id !== 0x21 || propSize !== 1) throw new Error("xz: only plain LZMA2 is supported");
    i += headerSize;
    const dataStart = i;
    // LZMA2 chunks.
    let needProps = true;
    for (;;) {
      const control = src[i++];
      if (control === undefined) throw new Error("xz: truncated");
      if (control === 0x00) break;
      if (control === 0x01 || control === 0x02) {
        const size = ((src[i] << 8) | src[i + 1]) + 1;
        i += 2;
        for (let k = 0; k < size; k++) out.push(src[i + k]);
        i += size;
        continue;
      }
      if (control < 0x80) throw new Error("xz: bad LZMA2 chunk");
      const unpacked = ((control & 0x1f) << 16) + (src[i] << 8) + src[i + 1] + 1;
      const packed = (src[i + 2] << 8) + src[i + 3] + 1;
      i += 4;
      const reset = (control >> 5) & 3;
      if (reset >= 2) {
        lz.setProps(src[i++]);
        needProps = false;
      } else if (needProps) throw new Error("xz: LZMA2 chunk without properties");
      if (reset >= 1) lz.resetState();
      lz.chunk(new Range(src, i), out, unpacked);
      i += packed;
    }
    // Padding to 4 bytes, then the check.
    while ((i - dataStart) % 4) i++;
    if (check === 1 && crc32(out.buf.subarray(blockStart), out.len - blockStart) !== u32le(src, i)) throw new Error("xz: data CRC32");
    if (check === 4) {
      const want = BigInt(u32le(src, i)) | (BigInt(u32le(src, i + 4)) << 32n);
      if (crc64(out.buf.subarray(blockStart), out.len - blockStart) !== want) throw new Error("xz: data CRC64");
    }
    i += checkSize;
    if (i >= src.length) throw new Error("xz: truncated");
  }
  return out.buf.slice(0, out.len);
}
