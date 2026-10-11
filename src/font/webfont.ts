/**
 * WOFF 1.0 and WOFF 2.0 decoding: a web font becomes the sfnt it wraps, so
 * the rest of the font engine only ever reads TrueType/OpenType.
 *
 * WOFF 1.0 tables are zlib-compressed one by one. WOFF 2.0 compresses all
 * tables as one Brotli stream and stores glyf/loca (and optionally hmtx) in a
 * transformed form that is rebuilt here, per https://www.w3.org/TR/WOFF2/.
 *
 * Every length and offset is checked, decompression is capped, and every
 * loop is bounded by the input size, so hostile input fails with a FontError.
 */

import { brotliDecompressSync, inflateSync } from "node:zlib";
import { FontError } from "./errors.js";
import { Reader } from "./reader.js";
import { FLAVOR_OTTO, FLAVOR_TRUE, FLAVOR_TRUETYPE, TAG_TTCF, buildSfnt, type TableData } from "./sfnt.js";

const SIG_WOFF = 0x774f4646; // 'wOFF'
const SIG_WOFF2 = 0x774f4632; // 'wOF2'

/** Upper bound on the decompressed table data and on the rebuilt font. */
const MAX_SFNT_SIZE = 64 * 1024 * 1024;

/** True when the bytes start with a WOFF ('wOFF') or WOFF2 ('wOF2') signature. */
export function isWebFont(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return sig === SIG_WOFF || sig === SIG_WOFF2;
}

/** Decodes a WOFF or WOFF2 font to the TrueType/OpenType font it wraps. Throws FontError on bad data. */
export function webFontToSfnt(bytes: Uint8Array): Uint8Array {
  const file = new Reader(bytes, "web font");
  if (file.length < 4) file.fail("too short to be a WOFF or WOFF2 font");
  const sig = file.u32(0);
  try {
    if (sig === SIG_WOFF) return decodeWoff(new Reader(bytes, "WOFF font"));
    if (sig === SIG_WOFF2) return decodeWoff2(new Reader(bytes, "WOFF2 font"));
  } catch (err) {
    if (err instanceof FontError) throw err;
    throw new FontError(`web font: ${err instanceof Error ? err.message : String(err)}`);
  }
  return file.fail("not a WOFF or WOFF2 font (bad signature)");
}

function checkFlavor(r: Reader, flavor: number): void {
  if (flavor === TAG_TTCF) r.fail("WOFF2 font collections are not supported");
  if (flavor !== FLAVOR_TRUETYPE && flavor !== FLAVOR_OTTO && flavor !== FLAVOR_TRUE) {
    r.fail(`unknown sfnt flavor 0x${flavor.toString(16).padStart(8, "0")}`);
  }
}

function inflateTable(r: Reader, tag: string, data: Uint8Array, origLength: number): Uint8Array {
  let out: Uint8Array;
  try {
    out = inflateSync(data, { maxOutputLength: Math.max(1, origLength) });
  } catch {
    return r.fail(`table '${tag}' does not decompress to its declared ${origLength} bytes`);
  }
  if (out.length !== origLength) r.fail(`table '${tag}' decompresses to ${out.length} bytes, not the declared ${origLength}`);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// WOFF 1.0

function decodeWoff(r: Reader): Uint8Array {
  if (r.length < 44) r.fail("truncated header (need 44 bytes)");
  const flavor = r.u32(4);
  if (flavor === TAG_TTCF) r.fail("WOFF font collections are not supported");
  checkFlavor(r, flavor);
  const length = r.u32(8);
  if (length > r.length) r.fail(`header declares ${length} bytes but the file has ${r.length}`);
  const numTables = r.u16(12);
  if (numTables === 0) r.fail("font has no tables");
  if (!r.has(44, 20 * numTables)) r.fail(`table directory declares ${numTables} tables but the file is truncated`);
  const tables: TableData[] = [];
  let total = 0;
  for (let i = 0; i < numTables; i++) {
    const at = 44 + 20 * i;
    const tag = r.tag(at);
    const offset = r.u32(at + 4);
    const compLength = r.u32(at + 8);
    const origLength = r.u32(at + 12);
    if (!r.has(offset, compLength) || offset + compLength > length) {
      r.fail(`table '${tag}' (offset ${offset}, length ${compLength}) lies outside the file`);
    }
    total += origLength;
    if (total > MAX_SFNT_SIZE) r.fail(`tables declare more than ${MAX_SFNT_SIZE} bytes of data`);
    if (compLength > origLength) r.fail(`table '${tag}' is longer compressed (${compLength}) than original (${origLength})`);
    const raw = r.bytes.subarray(offset, offset + compLength);
    const data = compLength === origLength ? new Uint8Array(raw) : inflateTable(r, tag, raw, origLength);
    tables.push({ tag, data });
  }
  return buildSfnt(tables, flavor);
}

// WOFF 2.0

const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** A forward cursor over a Reader. */
class Cursor {
  pos: number;
  constructor(
    readonly r: Reader,
    start = 0,
  ) {
    this.pos = start;
  }
  u8(): number {
    return this.r.u8(this.pos++);
  }
  u16(): number {
    const v = this.r.u16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.r.i16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.r.u32(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.r.check(this.pos, n);
    const out = this.r.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** UIntBase128: 1 to 5 bytes, 7 bits each, no leading zeros, at most 2^32 - 1. */
  base128(): number {
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 0 && b === 0x80) this.r.fail("UIntBase128 value has a leading zero");
      if (acc > 0x1ffffff) this.r.fail("UIntBase128 value overflows 32 bits");
      acc = acc * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return acc;
    }
    return this.r.fail("UIntBase128 value is longer than 5 bytes");
  }
  /** 255UInt16. */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

interface Woff2Entry {
  tag: string;
  transformed: boolean;
  version: number;
  origLength: number;
  /** Bytes in the decompressed stream (transformLength when transformed). */
  length: number;
  offset: number;
}

function decodeWoff2(r: Reader): Uint8Array {
  if (r.length < 48) r.fail("truncated header (need 48 bytes)");
  const flavor = r.u32(4);
  checkFlavor(r, flavor);
  const length = r.u32(8);
  if (length > r.length) r.fail(`header declares ${length} bytes but the file has ${r.length}`);
  const numTables = r.u16(12);
  if (numTables === 0) r.fail("font has no tables");
  const totalSfntSize = r.u32(16);
  if (totalSfntSize > MAX_SFNT_SIZE) r.fail(`declared font size ${totalSfntSize} exceeds the ${MAX_SFNT_SIZE}-byte limit`);
  const totalCompressedSize = r.u32(20);

  const c = new Cursor(r, 48);
  const entries: Woff2Entry[] = [];
  let streamSize = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = c.u8();
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = r.tag(c.pos);
      c.pos += 4;
    }
    const version = flags >> 6;
    const origLength = c.base128();
    const glyfOrLoca = tag === "glyf" || tag === "loca";
    const transformed = glyfOrLoca ? version !== 3 : version !== 0;
    if (glyfOrLoca && version !== 0 && version !== 3) r.fail(`table '${tag}' has unknown transform version ${version}`);
    if (transformed && !glyfOrLoca && !(tag === "hmtx" && version === 1)) {
      r.fail(`table '${tag}' has unknown transform version ${version}`);
    }
    let len = origLength;
    if (transformed) {
      len = c.base128();
      if (tag === "loca" && len !== 0) r.fail("transformed loca must have a transform length of 0");
    }
    if (origLength > MAX_SFNT_SIZE) r.fail(`table '${tag}' declares ${origLength} bytes, over the limit`);
    entries.push({ tag, transformed, version, origLength, length: len, offset: streamSize });
    streamSize += len;
    if (streamSize > MAX_SFNT_SIZE) r.fail(`tables declare more than ${MAX_SFNT_SIZE} bytes of data`);
  }
  const start = c.pos;
  if (start + totalCompressedSize > length) {
    r.fail(`compressed data (${totalCompressedSize} bytes at ${start}) runs past the end of the file`);
  }
  if (totalCompressedSize === 0) r.fail("no compressed data");
  let stream: Uint8Array;
  try {
    const out = brotliDecompressSync(r.bytes.subarray(start, start + totalCompressedSize), {
      maxOutputLength: Math.max(1, streamSize),
    });
    stream = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return r.fail(`compressed data does not decompress to the declared ${streamSize} bytes`);
  }
  if (stream.length !== streamSize) r.fail(`compressed data holds ${stream.length} bytes, not the declared ${streamSize}`);

  const byTag = new Map<string, Woff2Entry>();
  for (const e of entries) {
    if (byTag.has(e.tag)) r.fail(`duplicate table '${e.tag}'`);
    byTag.set(e.tag, e);
  }
  const slice = (e: Woff2Entry) => stream.subarray(e.offset, e.offset + e.length);

  const glyf = byTag.get("glyf");
  const loca = byTag.get("loca");
  if ((glyf?.transformed ?? false) !== (loca?.transformed ?? false)) r.fail("glyf and loca must both be transformed or both not");
  let rebuilt: { glyf: Uint8Array; loca: Uint8Array; xMins: Int16Array } | undefined;
  if (glyf?.transformed && loca) {
    rebuilt = rebuildGlyf(new Reader(slice(glyf), "WOFF2 glyf"));
    if (rebuilt.loca.length !== loca.origLength) {
      r.fail(`rebuilt loca is ${rebuilt.loca.length} bytes but the directory declares ${loca.origLength}`);
    }
  }

  const tables: TableData[] = [];
  for (const e of entries) {
    let data: Uint8Array;
    if (e.tag === "glyf" && rebuilt) data = rebuilt.glyf;
    else if (e.tag === "loca" && rebuilt) data = rebuilt.loca;
    else if (e.tag === "hmtx" && e.transformed) {
      if (!rebuilt) r.fail("transformed hmtx needs a transformed glyf table");
      data = rebuildHmtx(new Reader(slice(e), "WOFF2 hmtx"), stream, byTag, rebuilt.xMins, e.origLength);
    } else data = new Uint8Array(slice(e));
    tables.push({ tag: e.tag, data });
  }
  const total = tables.reduce((s, t) => s + ((t.data.length + 3) & ~3), 12 + 16 * tables.length);
  if (total > MAX_SFNT_SIZE) r.fail(`rebuilt font would be ${total} bytes, over the limit`);
  return buildSfnt(tables, flavor);
}

/** A growable output buffer with a hard size cap. */
class Out {
  buf = new Uint8Array(1024);
  len = 0;
  ensure(n: number): void {
    const need = this.len + n;
    if (need > MAX_SFNT_SIZE) throw new FontError(`WOFF2 glyf: rebuilt table exceeds ${MAX_SFNT_SIZE} bytes`);
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(Math.min(size, MAX_SFNT_SIZE));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 255;
  }
  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = (v >> 8) & 255;
    this.buf[this.len++] = v & 255;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  pad4(): void {
    while (this.len & 3) this.u8(0);
  }
}

// Composite glyph flags.
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;
const OVERLAP_SIMPLE = 0x40;

const withSign = (flag: number, v: number) => (flag & 1 ? v : -v);

/** Rebuilds glyf and loca from the version 0 transform; also returns each glyph's xMin for hmtx. */
function rebuildGlyf(r: Reader): { glyf: Uint8Array; loca: Uint8Array; xMins: Int16Array } {
  if (r.length < 36) r.fail("truncated transform header");
  const optionFlags = r.u16(2);
  const numGlyphs = r.u16(4);
  const indexFormat = r.u16(6);
  if (indexFormat > 1) r.fail(`indexFormat ${indexFormat} is neither 0 nor 1`);
  const sizes: number[] = [];
  for (let i = 0; i < 7; i++) sizes.push(r.u32(8 + 4 * i));
  let at = 36;
  const streams: Reader[] = [];
  const names = ["nContour", "nPoints", "flag", "glyph", "composite", "bbox", "instruction"];
  for (let i = 0; i < 7; i++) {
    if (!r.has(at, sizes[i])) r.fail(`${names[i]} stream (${sizes[i]} bytes at ${at}) runs past the table`);
    streams.push(r.sub(at, sizes[i], `WOFF2 glyf ${names[i]} stream`));
    at += sizes[i];
  }
  let overlap: Reader | undefined;
  if (optionFlags & 1) {
    const n = (numGlyphs + 7) >> 3;
    if (!r.has(at, n)) r.fail("overlapSimpleBitmap runs past the table");
    overlap = r.sub(at, n, "WOFF2 glyf overlap bitmap");
  }
  const nContourS = new Cursor(streams[0]);
  const nPointsS = new Cursor(streams[1]);
  const flagS = new Cursor(streams[2]);
  const glyphS = new Cursor(streams[3]);
  const compositeS = new Cursor(streams[4]);
  const bboxR = streams[5];
  const instrS = new Cursor(streams[6]);
  const bitmapLen = 4 * ((numGlyphs + 31) >> 5);
  if (bboxR.length < bitmapLen) bboxR.fail("bbox bitmap is truncated");
  const bboxS = new Cursor(bboxR, bitmapLen);
  const hasBox = (g: number) => (bboxR.bytes[g >> 3] & (0x80 >> (g & 7))) !== 0;

  const out = new Out();
  const offsets = new Uint32Array(numGlyphs + 1);
  const xMins = new Int16Array(numGlyphs);
  const xs: number[] = [];
  const ys: number[] = [];
  const on: boolean[] = [];
  const ends: number[] = [];
  for (let g = 0; g < numGlyphs; g++) {
    offsets[g] = out.len;
    const nContours = nContourS.i16();
    if (nContours === 0) {
      if (hasBox(g)) r.fail(`empty glyph ${g} has a bounding box`);
    } else if (nContours === -1) {
      if (!hasBox(g)) r.fail(`composite glyph ${g} has no bounding box`);
      const box = [bboxS.i16(), bboxS.i16(), bboxS.i16(), bboxS.i16()];
      const begin = compositeS.pos;
      let flags = MORE_COMPONENTS;
      let instructions = false;
      while (flags & MORE_COMPONENTS) {
        flags = compositeS.u16();
        compositeS.pos += 2; // glyph index
        let n = flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2;
        if (flags & WE_HAVE_A_SCALE) n += 2;
        else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) n += 4;
        else if (flags & WE_HAVE_A_TWO_BY_TWO) n += 8;
        compositeS.bytes(n);
        if (flags & WE_HAVE_INSTRUCTIONS) instructions = true;
      }
      const components = compositeS.r.bytes.subarray(begin, compositeS.pos);
      out.u16(0xffff);
      for (const v of box) out.u16(v);
      out.bytes(components);
      if (instructions) {
        const n = glyphS.u255();
        out.u16(n);
        out.bytes(instrS.bytes(n));
      }
      xMins[g] = box[0];
    } else if (nContours > 0) {
      xs.length = ys.length = on.length = ends.length = 0;
      let total = 0;
      for (let k = 0; k < nContours; k++) {
        total += nPointsS.u255();
        if (total > 0xffff) r.fail(`glyph ${g} has more than 65535 points`);
        ends.push(total - 1);
      }
      if (!flagS.r.has(flagS.pos, total)) r.fail(`glyph ${g}: flag stream is truncated`);
      let x = 0;
      let y = 0;
      for (let p = 0; p < total; p++) {
        let flag = flagS.u8();
        on.push((flag & 0x80) === 0);
        flag &= 0x7f;
        let dx: number;
        let dy: number;
        if (flag < 10) {
          dx = 0;
          dy = withSign(flag, ((flag & 14) << 7) + glyphS.u8());
        } else if (flag < 20) {
          dx = withSign(flag, (((flag - 10) & 14) << 7) + glyphS.u8());
          dy = 0;
        } else if (flag < 84) {
          const b0 = flag - 20;
          const b1 = glyphS.u8();
          dx = withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
          dy = withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
        } else if (flag < 120) {
          const b0 = flag - 84;
          dx = withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + glyphS.u8());
          dy = withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + glyphS.u8());
        } else if (flag < 124) {
          const b0 = glyphS.u8();
          const b1 = glyphS.u8();
          dx = withSign(flag, (b0 << 4) + (b1 >> 4));
          dy = withSign(flag >> 1, ((b1 & 0x0f) << 8) + glyphS.u8());
        } else {
          dx = withSign(flag, glyphS.u16());
          dy = withSign(flag >> 1, glyphS.u16());
        }
        x += dx;
        y += dy;
        if (x < -32768 || x > 32767 || y < -32768 || y > 32767) r.fail(`glyph ${g}: point ${p} lies outside the 16-bit range`);
        xs.push(x);
        ys.push(y);
      }
      const nInstr = glyphS.u255();
      const instr = instrS.bytes(nInstr);
      let box: number[];
      if (hasBox(g)) box = [bboxS.i16(), bboxS.i16(), bboxS.i16(), bboxS.i16()];
      else if (total === 0) box = [0, 0, 0, 0];
      else {
        let x0 = xs[0];
        let y0 = ys[0];
        let x1 = x0;
        let y1 = y0;
        for (let p = 1; p < total; p++) {
          if (xs[p] < x0) x0 = xs[p];
          if (xs[p] > x1) x1 = xs[p];
          if (ys[p] < y0) y0 = ys[p];
          if (ys[p] > y1) y1 = ys[p];
        }
        box = [x0, y0, x1, y1];
      }
      xMins[g] = box[0];
      const overlapping = overlap !== undefined && (overlap.bytes[g >> 3] & (0x80 >> (g & 7))) !== 0;
      writeSimpleGlyph(out, nContours, box, ends, instr, xs, ys, on, overlapping);
    } else {
      r.fail(`glyph ${g} has an invalid contour count ${nContours}`);
    }
    out.pad4();
  }
  offsets[numGlyphs] = out.len;

  const loca = new Uint8Array((numGlyphs + 1) * (indexFormat ? 4 : 2));
  const lv = new DataView(loca.buffer);
  for (let g = 0; g <= numGlyphs; g++) {
    if (indexFormat) lv.setUint32(4 * g, offsets[g]);
    else {
      if (offsets[g] > 0x1fffe) r.fail("glyf is too large for short loca offsets");
      lv.setUint16(2 * g, offsets[g] >> 1);
    }
  }
  return { glyf: out.buf.slice(0, out.len), loca, xMins };
}

/** Writes a simple glyph with the usual compact flag and coordinate encoding. */
function writeSimpleGlyph(
  out: Out,
  nContours: number,
  box: number[],
  ends: number[],
  instr: Uint8Array,
  xs: number[],
  ys: number[],
  on: boolean[],
  overlap: boolean,
): void {
  out.u16(nContours);
  for (const v of box) out.u16(v);
  for (const e of ends) out.u16(e);
  out.u16(instr.length);
  out.bytes(instr);
  const n = xs.length;
  const flags = new Uint8Array(n);
  let px = 0;
  let py = 0;
  for (let p = 0; p < n; p++) {
    const dx = xs[p] - px;
    const dy = ys[p] - py;
    let f = on[p] ? 1 : 0;
    if (p === 0 && overlap) f |= OVERLAP_SIMPLE;
    if (dx === 0) f |= 0x10;
    else if (dx > -256 && dx < 256) f |= 0x02 | (dx > 0 ? 0x10 : 0);
    if (dy === 0) f |= 0x20;
    else if (dy > -256 && dy < 256) f |= 0x04 | (dy > 0 ? 0x20 : 0);
    flags[p] = f;
    px = xs[p];
    py = ys[p];
  }
  for (let p = 0; p < n; ) {
    let run = 1;
    while (p + run < n && run < 256 && flags[p + run] === flags[p]) run++;
    if (run > 1) {
      out.u8(flags[p] | 0x08);
      out.u8(run - 1);
    } else out.u8(flags[p]);
    p += run;
  }
  for (const [coords, short, same] of [
    [xs, 0x02, 0x10],
    [ys, 0x04, 0x20],
  ] as const) {
    let prev = 0;
    for (let p = 0; p < n; p++) {
      const d = coords[p] - prev;
      prev = coords[p];
      const f = flags[p];
      if (f & short) out.u8(Math.abs(d));
      else if (!(f & same)) {
        if (d < -32768 || d > 32767) throw new FontError("WOFF2 glyf: coordinate delta outside the 16-bit range");
        out.u16(d & 0xffff);
      }
    }
  }
}

/** Rebuilds hmtx from transform version 1, taking omitted side bearings from the glyph boxes. */
function rebuildHmtx(
  r: Reader,
  stream: Uint8Array,
  byTag: Map<string, Woff2Entry>,
  xMins: Int16Array,
  origLength: number,
): Uint8Array {
  const hhea = byTag.get("hhea");
  const maxp = byTag.get("maxp");
  if (!hhea || hhea.transformed || hhea.length < 36) r.fail("transformed hmtx needs an hhea table");
  if (!maxp || maxp.transformed || maxp.length < 6) r.fail("transformed hmtx needs a maxp table");
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const numHMetrics = view.getUint16(hhea.offset + 34);
  const numGlyphs = view.getUint16(maxp.offset + 4);
  if (numHMetrics < 1 || numHMetrics > numGlyphs) r.fail(`hhea.numberOfHMetrics ${numHMetrics} does not fit ${numGlyphs} glyphs`);
  if (numGlyphs > xMins.length) r.fail(`maxp declares ${numGlyphs} glyphs but glyf holds ${xMins.length}`);
  const expected = 4 * numHMetrics + 2 * (numGlyphs - numHMetrics);
  // A longer declared table keeps its zero-filled tail, as some fonts pad hmtx.
  if (origLength < expected) r.fail(`hmtx declares ${origLength} bytes but ${numGlyphs} glyphs need ${expected}`);
  const c = new Cursor(r);
  const flags = c.u8();
  if (flags & 0xfc || !(flags & 3)) r.fail(`invalid transform flags 0x${flags.toString(16)}`);
  const out = new Uint8Array(origLength);
  const w = new DataView(out.buffer);
  for (let g = 0; g < numHMetrics; g++) w.setUint16(4 * g, c.u16());
  for (let g = 0; g < numHMetrics; g++) w.setInt16(4 * g + 2, flags & 1 ? xMins[g] : c.i16());
  for (let g = numHMetrics; g < numGlyphs; g++) {
    w.setInt16(4 * numHMetrics + 2 * (g - numHMetrics), flags & 2 ? xMins[g] : c.i16());
  }
  return out;
}
