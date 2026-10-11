import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { brotliCompressSync, constants as zc, deflateSync } from "node:zlib";
import { type Font, FontError, fontsDir, isWebFont, parseFont, tableChecksum, webFontToSfnt } from "../src/font/index.js";
import { Reader } from "../src/font/reader.js";
import { buildSfnt, readDirectory } from "../src/font/sfnt.js";
import { toWoff } from "../src/font/woff.js";

// ---------------------------------------------------------------------------
// Helpers

function load(name: string): Uint8Array {
  const b = readFileSync(join(fontsDir(), name));
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

const KATEX_MAIN = "KaTeX_Main-Regular.ttf";
const KATEX_SANS = "KaTeX_SansSerif-Regular.ttf";
const LM_ROMAN = "lmroman10-regular.otf";

function sfntTables(bytes: Uint8Array): Map<string, Uint8Array> {
  const dir = readDirectory(new Reader(bytes));
  const out = new Map<string, Uint8Array>();
  for (const [tag, t] of dir.tables) out.set(tag, bytes.subarray(t.offset, t.offset + t.length));
  return out;
}

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const i16 = (b: Uint8Array, at: number) => (u16(b, at) << 16) >> 16;
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** glyf data of each glyph, from loca. */
function glyphSlices(tables: Map<string, Uint8Array>): Uint8Array[] {
  const glyf = tables.get("glyf")!;
  const loca = tables.get("loca")!;
  const long = i16(tables.get("head")!, 50) === 1;
  const n = u16(tables.get("maxp")!, 4);
  const at = (g: number) => (long ? u32(loca, 4 * g) : 2 * u16(loca, 2 * g));
  const out: Uint8Array[] = [];
  for (let g = 0; g < n; g++) out.push(glyf.subarray(at(g), at(g + 1)));
  return out;
}

interface SimpleGlyph {
  kind: "simple";
  nContours: number;
  box: number[];
  ends: number[];
  instructions: Uint8Array;
  flags: number[];
  xs: number[];
  ys: number[];
}
interface CompositeGlyph {
  kind: "composite";
  box: number[];
  /** Component records, byte for byte. */
  components: Uint8Array;
  instructions: Uint8Array;
}
type Glyph = { kind: "empty" } | SimpleGlyph | CompositeGlyph;

const MORE_COMPONENTS = 0x20;
const WE_HAVE_INSTRUCTIONS = 0x100;

function componentsEnd(d: Uint8Array, start: number): { end: number; instructions: boolean } {
  let p = start;
  let flags = MORE_COMPONENTS;
  let instructions = false;
  while (flags & MORE_COMPONENTS) {
    flags = u16(d, p);
    p += 4 + (flags & 1 ? 4 : 2);
    if (flags & 0x08) p += 2;
    else if (flags & 0x40) p += 4;
    else if (flags & 0x80) p += 8;
    if (flags & WE_HAVE_INSTRUCTIONS) instructions = true;
  }
  return { end: p, instructions };
}

/** Decodes one glyph's points and flags (flags keep only the on-curve and overlap bits). */
function parseGlyph(d: Uint8Array): Glyph {
  if (d.length === 0) return { kind: "empty" };
  const nContours = i16(d, 0);
  const box = [i16(d, 2), i16(d, 4), i16(d, 6), i16(d, 8)];
  if (nContours < 0) {
    const { end, instructions } = componentsEnd(d, 10);
    const n = instructions ? u16(d, end) : 0;
    return {
      kind: "composite",
      box,
      components: d.slice(10, end),
      instructions: instructions ? d.slice(end + 2, end + 2 + n) : new Uint8Array(0),
    };
  }
  const ends: number[] = [];
  for (let k = 0; k < nContours; k++) ends.push(u16(d, 10 + 2 * k));
  let p = 10 + 2 * nContours;
  const nInstr = u16(d, p);
  const instructions = d.slice(p + 2, p + 2 + nInstr);
  p += 2 + nInstr;
  const total = nContours ? ends[nContours - 1] + 1 : 0;
  const raw: number[] = [];
  while (raw.length < total) {
    const f = d[p++];
    raw.push(f);
    if (f & 8) {
      const rep = d[p++];
      for (let k = 0; k < rep; k++) raw.push(f);
    }
  }
  const coords = (short: number, same: number) => {
    const out: number[] = [];
    let v = 0;
    for (const f of raw) {
      if (f & short) {
        v += f & same ? d[p] : -d[p];
        p += 1;
      } else if (!(f & same)) {
        v += i16(d, p);
        p += 2;
      }
      out.push(v);
    }
    return out;
  };
  const xs = coords(0x02, 0x10);
  const ys = coords(0x04, 0x20);
  return { kind: "simple", nContours, box, ends, instructions, flags: raw.map((f) => f & 0x41), xs, ys };
}

// ---------------------------------------------------------------------------
// A test-only WOFF2 encoder, following the W3C spec

function base128(v: number): number[] {
  const out = [v & 0x7f];
  v = Math.floor(v / 128);
  while (v > 0) {
    out.unshift(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  return out;
}

function u255(v: number): number[] {
  if (v < 253) return [v];
  if (v < 506) return [255, v - 253];
  if (v < 762) return [254, v - 506];
  return [253, v >> 8, v & 255];
}

class Bytes {
  a: number[] = [];
  u8(v: number) {
    this.a.push(v & 255);
  }
  u16(v: number) {
    this.a.push((v >> 8) & 255, v & 255);
  }
  u32(v: number) {
    this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  push(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.a.push(b[i]);
  }
  get bytes() {
    return Uint8Array.from(this.a);
  }
}

const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF "];

interface Woff2Table {
  tag: string;
  /** Bytes as stored in the stream (the transformed form when transformed). */
  data: Uint8Array;
  origLength: number;
  /** Transform version as written in the flags. */
  version: number;
  transformed: boolean;
}

/** Writes a WOFF2 file around already-prepared table data. */
function writeWoff2(flavor: number, tables: Woff2Table[], opts: { totalSfntSize?: number; stream?: Uint8Array; quality?: number } = {}): Uint8Array {
  const dir = new Bytes();
  for (const t of tables) {
    const known = KNOWN.indexOf(t.tag);
    dir.u8((t.version << 6) | (known >= 0 ? known : 63));
    if (known < 0) for (let k = 0; k < 4; k++) dir.u8(t.tag.charCodeAt(k));
    dir.push(base128(t.origLength));
    if (t.transformed) dir.push(base128(t.data.length));
  }
  const raw = new Bytes();
  for (const t of tables) raw.push(t.data);
  const stream =
    opts.stream ??
    new Uint8Array(brotliCompressSync(raw.bytes, { params: { [zc.BROTLI_PARAM_QUALITY]: opts.quality ?? 11, [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_FONT } }));
  const headerLen = 48 + dir.a.length;
  const length = (headerLen + stream.length + 3) & ~3;
  const h = new Bytes();
  h.u32(0x774f4632);
  h.u32(flavor);
  h.u32(length);
  h.u16(tables.length);
  h.u16(0);
  h.u32(opts.totalSfntSize ?? 12 + 16 * tables.length + tables.reduce((s, t) => s + ((t.origLength + 3) & ~3), 0));
  h.u32(stream.length);
  h.u16(1);
  h.u16(0);
  for (let k = 0; k < 5; k++) h.u32(0);
  h.push(dir.a);
  h.push(stream);
  while (h.a.length < length) h.u8(0);
  return h.bytes;
}

/** Point deltas as WOFF2 triplets (the encoding of the spec's reference encoder). */
function triplet(flags: Bytes, glyph: Bytes, x: number, y: number, onCurve: boolean): void {
  const on = onCurve ? 0 : 128;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const xs = x < 0 ? 0 : 1;
  const ys = y < 0 ? 0 : 1;
  const xy = xs + 2 * ys;
  if (x === 0 && ay < 1280) {
    flags.u8(on + ((ay & 0xf00) >> 7) + ys);
    glyph.u8(ay & 0xff);
  } else if (y === 0 && ax < 1280) {
    flags.u8(on + 10 + ((ax & 0xf00) >> 7) + xs);
    glyph.u8(ax & 0xff);
  } else if (ax < 65 && ay < 65) {
    flags.u8(on + 20 + ((ax - 1) & 0x30) + (((ay - 1) & 0x30) >> 2) + xy);
    glyph.u8((((ax - 1) & 0xf) << 4) | ((ay - 1) & 0xf));
  } else if (ax < 769 && ay < 769) {
    flags.u8(on + 84 + 12 * (((ax - 1) & 0x300) >> 8) + (((ay - 1) & 0x300) >> 6) + xy);
    glyph.u8((ax - 1) & 0xff);
    glyph.u8((ay - 1) & 0xff);
  } else if (ax < 4096 && ay < 4096) {
    flags.u8(on + 120 + xy);
    glyph.u8(ax >> 4);
    glyph.u8(((ax & 0xf) << 4) | (ay >> 8));
    glyph.u8(ay & 0xff);
  } else {
    flags.u8(on + 124 + xy);
    glyph.u16(ax);
    glyph.u16(ay);
  }
}

/** The glyf transform, version 0. Returns the transformed table and each glyph's xMin. */
function transformGlyf(tables: Map<string, Uint8Array>, overlapGlyphs: ReadonlySet<number> = new Set()): { data: Uint8Array; xMins: number[] } {
  const glyphs = glyphSlices(tables);
  const n = glyphs.length;
  const indexFormat = i16(tables.get("head")!, 50);
  const nContour = new Bytes();
  const nPoints = new Bytes();
  const flagS = new Bytes();
  const glyphS = new Bytes();
  const composite = new Bytes();
  const bboxBitmap = new Uint8Array(4 * ((n + 31) >> 5));
  const bboxS = new Bytes();
  const instr = new Bytes();
  const overlap = new Uint8Array((n + 7) >> 3);
  let anyOverlap = false;
  const xMins: number[] = [];
  glyphs.forEach((d, g) => {
    const glyph = parseGlyph(d);
    const explicit = (box: number[]) => {
      bboxBitmap[g >> 3] |= 0x80 >> (g & 7);
      for (const v of box) bboxS.u16(v);
    };
    if (glyph.kind === "empty") {
      nContour.u16(0);
      xMins.push(0);
      return;
    }
    xMins.push(glyph.box[0]);
    if (glyph.kind === "composite") {
      nContour.u16(0xffff);
      explicit(glyph.box);
      composite.push(glyph.components);
      if (componentsEnd(glyph.components, 0).instructions) {
        glyphS.push(u255(glyph.instructions.length));
        instr.push(glyph.instructions);
      }
      return;
    }
    nContour.u16(glyph.nContours);
    let prev = -1;
    for (const e of glyph.ends) {
      nPoints.push(u255(e - prev));
      prev = e;
    }
    let px = 0;
    let py = 0;
    glyph.xs.forEach((x, p) => {
      triplet(flagS, glyphS, x - px, glyph.ys[p] - py, (glyph.flags[p] & 1) === 1);
      px = x;
      py = glyph.ys[p];
    });
    glyphS.push(u255(glyph.instructions.length));
    instr.push(glyph.instructions);
    if ((glyph.flags[0] & 0x40) !== 0 || overlapGlyphs.has(g)) {
      overlap[g >> 3] |= 0x80 >> (g & 7);
      anyOverlap = true;
    }
    // An explicit box only where the computed one would differ.
    const computed = glyph.xs.length
      ? [Math.min(...glyph.xs), Math.min(...glyph.ys), Math.max(...glyph.xs), Math.max(...glyph.ys)]
      : [0, 0, 0, 0];
    if (computed.some((v, k) => v !== glyph.box[k])) explicit(glyph.box);
  });
  const bbox = new Bytes();
  bbox.push(bboxBitmap);
  bbox.push(bboxS.a);
  const streams = [nContour, nPoints, flagS, glyphS, composite, bbox, instr];
  const out = new Bytes();
  out.u16(0);
  out.u16(anyOverlap ? 1 : 0);
  out.u16(n);
  out.u16(indexFormat);
  for (const s of streams) out.u32(s.a.length);
  for (const s of streams) out.push(s.a);
  if (anyOverlap) out.push(overlap);
  return { data: out.bytes, xMins };
}

/** The hmtx transform, version 1, when the side bearings equal the glyph xMins; undefined otherwise. */
function transformHmtx(tables: Map<string, Uint8Array>, xMins: number[]): Uint8Array | undefined {
  const hmtx = tables.get("hmtx")!;
  const nhm = u16(tables.get("hhea")!, 34);
  const n = u16(tables.get("maxp")!, 4);
  let propSame = true;
  let monoSame = true;
  for (let g = 0; g < nhm; g++) if (i16(hmtx, 4 * g + 2) !== xMins[g]) propSame = false;
  for (let g = nhm; g < n; g++) if (i16(hmtx, 4 * nhm + 2 * (g - nhm)) !== xMins[g]) monoSame = false;
  if (!propSame && !monoSame) return undefined;
  const out = new Bytes();
  out.u8((propSame ? 1 : 0) | (monoSame ? 2 : 0));
  for (let g = 0; g < nhm; g++) out.u16(u16(hmtx, 4 * g));
  if (!propSame) for (let g = 0; g < nhm; g++) out.u16(u16(hmtx, 4 * g + 2));
  if (!monoSame) for (let g = nhm; g < n; g++) out.u16(u16(hmtx, 4 * nhm + 2 * (g - nhm)));
  return out.bytes;
}

interface EncodeOptions {
  transformGlyf?: boolean;
  transformHmtx?: boolean;
  overlapGlyphs?: ReadonlySet<number>;
}

/** Encodes a TrueType or CFF font as WOFF2; returns the file and whether hmtx was transformed. */
function toWoff2(sfnt: Uint8Array, opts: EncodeOptions = {}): { woff2: Uint8Array; hmtxTransformed: boolean } {
  const tables = sfntTables(sfnt);
  const flavor = u32(sfnt, 0);
  const tags = [...tables.keys()].sort();
  // The spec wants loca right after glyf.
  if (tags.includes("glyf") && tags.includes("loca")) {
    tags.splice(tags.indexOf("loca"), 1);
    tags.splice(tags.indexOf("glyf") + 1, 0, "loca");
  }
  const glyfT = opts.transformGlyf !== false && tables.has("glyf") ? transformGlyf(tables, opts.overlapGlyphs) : undefined;
  const hmtxT = glyfT && opts.transformHmtx !== false ? transformHmtx(tables, glyfT.xMins) : undefined;
  const list: Woff2Table[] = tags.map((tag) => {
    const orig = tables.get(tag)!;
    if (tag === "glyf" && glyfT) return { tag, data: glyfT.data, origLength: orig.length, version: 0, transformed: true };
    if (tag === "loca" && glyfT) return { tag, data: new Uint8Array(0), origLength: orig.length, version: 0, transformed: true };
    if ((tag === "glyf" || tag === "loca") && !glyfT) return { tag, data: orig, origLength: orig.length, version: 3, transformed: false };
    if (tag === "hmtx" && hmtxT) return { tag, data: hmtxT, origLength: orig.length, version: 1, transformed: true };
    return { tag, data: orig, origLength: orig.length, version: 0, transformed: false };
  });
  return { woff2: writeWoff2(flavor, list), hmtxTransformed: hmtxT !== undefined };
}

/**
 * KaTeX_Main with composite glyphs appended (the bundled fonts have none):
 * byte and word offsets, a uniform scale, an x/y scale, a 2x2 matrix and
 * component instructions, so every composite record shape is exercised.
 */
function withComposites(ttf: Uint8Array): Uint8Array {
  const tables = sfntTables(ttf);
  const glyphs = glyphSlices(tables).map((d) => d.slice());
  const n0 = glyphs.length;
  const nhm = u16(tables.get("hhea")!, 34);
  // Each component: flags, glyph index, then argument and transform bytes.
  const comp = (flags: number, gid: number, rest: number[]) => [flags >> 8, flags & 255, gid >> 8, gid & 255, ...rest];
  const comps: { records: number[]; instr?: number[]; box: number[] }[] = [
    // Byte offsets, then word offsets.
    { records: [...comp(0x0022, 36, [10, 20]), ...comp(0x0003, 37, [0x01, 0x2c, 0xff, 0x38])], box: [10, -200, 900, 700] },
    // A uniform scale of 0.5, then byte offsets.
    { records: [...comp(0x002a, 40, [0, 0, 0x20, 0x00]), ...comp(0x0002, 41, [5, 0xfb])], box: [0, -10, 600, 700] },
    // An x/y scale, then component instructions.
    { records: [...comp(0x0062, 42, [3, 4, 0x40, 0x00, 0xc0, 0x00]), ...comp(0x0102, 43, [0, 0])], instr: [0xb0, 0x01, 0x2c], box: [-50, 0, 700, 750] },
    // A 2x2 matrix.
    { records: comp(0x0082, 44, [0, 0, 0x40, 0, 0x10, 0, 0xf0, 0, 0x40, 0]), box: [-5, -5, 500, 500] },
  ];
  for (const c of comps) {
    const b = new Bytes();
    b.u16(0xffff);
    for (const v of c.box) b.u16(v);
    b.push(c.records);
    if (c.instr) {
      b.u16(c.instr.length);
      b.push(c.instr);
    }
    glyphs.push(b.bytes);
  }
  const n = glyphs.length;
  const glyf = new Bytes();
  const loca = new Bytes();
  for (const g of glyphs) {
    loca.u32(glyf.a.length);
    glyf.push(g);
    while (glyf.a.length & 3) glyf.u8(0);
  }
  loca.u32(glyf.a.length);
  const head = tables.get("head")!.slice();
  new DataView(head.buffer).setInt16(50, 1);
  const maxp = tables.get("maxp")!.slice();
  new DataView(maxp.buffer).setUint16(4, n);
  const hhea = tables.get("hhea")!.slice();
  new DataView(hhea.buffer).setUint16(34, n);
  // Every glyph gets a full metric; lsb = xMin keeps the hmtx transform possible.
  const old = tables.get("hmtx")!;
  const hmtx = new Bytes();
  hmtx.push(old.subarray(0, 4 * nhm));
  for (let g = nhm; g < n0; g++) {
    hmtx.u16(u16(old, 4 * (nhm - 1)));
    hmtx.u16(u16(old, 4 * nhm + 2 * (g - nhm)));
  }
  for (const c of comps) {
    hmtx.u16(800);
    hmtx.u16(c.box[0]);
  }
  const out = new Map(tables);
  out.set("glyf", glyf.bytes);
  out.set("loca", loca.bytes);
  out.set("head", head);
  out.set("maxp", maxp);
  out.set("hhea", hhea);
  out.set("hmtx", hmtx.bytes);
  return buildSfnt([...out].map(([tag, data]) => ({ tag, data })), 0x10000);
}

// ---------------------------------------------------------------------------
// Comparisons

function assertValidSfnt(bytes: Uint8Array): void {
  const dir = readDirectory(new Reader(bytes));
  for (const t of dir.tables.values()) {
    assert.equal(t.offset % 4, 0, `table '${t.tag}' is 4-byte aligned`);
    if (t.tag !== "head") assert.equal(tableChecksum(bytes, t.offset, t.length), t.checksum, `checksum of '${t.tag}'`);
  }
  assert.equal(tableChecksum(bytes), 0xb1b0afba, "whole-file checksum (head.checkSumAdjustment)");
}

function assertSameFont(a: Font, b: Font): void {
  assert.equal(b.glyphCount, a.glyphCount);
  assert.equal(b.outlines, a.outlines);
  assert.equal(b.postscriptName, a.postscriptName);
  assert.equal(b.unitsPerEm, a.unitsPerEm);
  assert.deepEqual([...b.codePoints()], [...a.codePoints()]);
  for (const cp of a.codePoints()) assert.equal(b.glyphForCodePoint(cp), a.glyphForCodePoint(cp));
  for (let g = 0; g < a.glyphCount; g++) {
    assert.equal(b.advance(g), a.advance(g), `advance of glyph ${g}`);
    assert.deepEqual(b.bounds(g), a.bounds(g), `bounds of glyph ${g}`);
    assert.deepEqual(b.outline(g), a.outline(g), `outline of glyph ${g}`);
  }
  for (const tag of ["hmtx", "cmap", "head", "hhea", "maxp", "post", "name", "OS/2", "CFF "]) {
    const ta = a.table(tag);
    const tb = b.table(tag);
    if (tag === "head" && ta && tb) {
      // checkSumAdjustment (bytes 8..11) depends on the whole file.
      assert.deepEqual([...tb.subarray(0, 8), ...tb.subarray(12)], [...ta.subarray(0, 8), ...ta.subarray(12)], "head");
    } else assert.deepEqual(tb, ta, `table '${tag}'`);
  }
}

/** Compares every glyph's points, on-curve flags, instructions and composite components. */
function assertSameGlyphs(orig: Uint8Array, decoded: Uint8Array): { simple: number; composite: number } {
  const ga = glyphSlices(sfntTables(orig)).map(parseGlyph);
  const gb = glyphSlices(sfntTables(decoded)).map(parseGlyph);
  assert.equal(gb.length, ga.length);
  let simple = 0;
  let composite = 0;
  ga.forEach((a, g) => {
    assert.deepEqual(gb[g], a, `glyph ${g}`);
    if (a.kind === "simple") simple++;
    if (a.kind === "composite") composite++;
  });
  return { simple, composite };
}

function expectFontError(name: string, bytes: Uint8Array, fn: (b: Uint8Array) => unknown = webFontToSfnt): void {
  const t0 = performance.now();
  assert.throws(() => fn(bytes), FontError, name);
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `${name}: took ${ms.toFixed(1)} ms`);
}

// ---------------------------------------------------------------------------

describe("isWebFont", () => {
  it("recognises the WOFF and WOFF2 signatures only", () => {
    assert.equal(isWebFont(Uint8Array.from([0x77, 0x4f, 0x46, 0x46])), true);
    assert.equal(isWebFont(Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0])), true);
    assert.equal(isWebFont(Uint8Array.from([0x77, 0x4f, 0x46])), false);
    assert.equal(isWebFont(load(KATEX_MAIN)), false);
    assert.equal(isWebFont(load(LM_ROMAN)), false);
  });
});

describe("WOFF 1.0", () => {
  for (const name of [KATEX_MAIN, LM_ROMAN]) {
    it(`round-trips ${name} through toWoff`, () => {
      const orig = load(name);
      const woff = toWoff(orig);
      const sfnt = webFontToSfnt(woff);
      assertValidSfnt(sfnt);
      // Every table comes back byte for byte.
      const ta = sfntTables(orig);
      const tb = sfntTables(sfnt);
      assert.deepEqual([...tb.keys()].sort(), [...ta.keys()].sort());
      for (const [tag, data] of ta) {
        if (tag !== "head") assert.deepEqual(tb.get(tag), data, `table '${tag}'`);
      }
      assertSameFont(parseFont(orig), parseFont(woff));
    });
  }

  it("reads stored (uncompressed) tables", () => {
    const orig = load(KATEX_SANS);
    const woff = toWoff(orig);
    // Rewrite every table as stored, keeping the layout of toWoff's header.
    const tables = sfntTables(orig);
    const n = tables.size;
    const out = new Bytes();
    const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : 1));
    let offset = 44 + 20 * n;
    const body = new Bytes();
    out.push(woff.subarray(0, 44));
    for (const [tag, data] of entries) {
      for (let k = 0; k < 4; k++) out.u8(tag.charCodeAt(k));
      out.u32(offset);
      out.u32(data.length);
      out.u32(data.length);
      out.u32(tableChecksum(data));
      body.push(data);
      while (body.a.length & 3) body.u8(0);
      offset = 44 + 20 * n + body.a.length;
    }
    out.push(body.a);
    const file = out.bytes;
    new DataView(file.buffer).setUint32(8, file.length);
    assertSameFont(parseFont(orig), parseFont(file));
  });
});

describe("WOFF 2.0", () => {
  for (const name of [KATEX_MAIN, KATEX_SANS]) {
    it(`round-trips ${name} with the glyf/loca and hmtx transforms`, () => {
      const orig = load(name);
      const { woff2, hmtxTransformed } = toWoff2(orig);
      assert.ok(woff2.length < orig.length, "WOFF2 is smaller than the TTF");
      const sfnt = webFontToSfnt(woff2);
      assertValidSfnt(sfnt);
      const counts = assertSameGlyphs(orig, sfnt);
      assert.ok(counts.simple > 100, "many simple glyphs compared");
      assertSameFont(parseFont(orig), parseFont(woff2));
      if (name === KATEX_MAIN) assert.ok(hmtxTransformed, "hmtx transform exercised");
    });
  }

  it("round-trips composite glyphs of every record shape", () => {
    const orig = withComposites(load(KATEX_MAIN));
    const { woff2, hmtxTransformed } = toWoff2(orig);
    assert.ok(hmtxTransformed);
    const sfnt = webFontToSfnt(woff2);
    assertValidSfnt(sfnt);
    const counts = assertSameGlyphs(orig, sfnt);
    assert.equal(counts.composite, 4);
    assertSameFont(parseFont(orig), parseFont(woff2));
    // The appended composites draw their components.
    const f = parseFont(woff2);
    for (let g = f.glyphCount - 4; g < f.glyphCount; g++) assert.ok(f.outline(g).length > 0, `composite ${g} has an outline`);
  });

  const ARIAL = "C:/Windows/Fonts/arial.ttf";
  it("round-trips Arial (hinted, with composites) when installed", { skip: !existsSync(ARIAL) }, () => {
    const b = readFileSync(ARIAL);
    const orig = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const sfnt = webFontToSfnt(toWoff2(orig).woff2);
    assertValidSfnt(sfnt);
    const counts = assertSameGlyphs(orig, sfnt);
    assert.ok(counts.composite > 100, `composites compared: ${counts.composite}`);
    assertSameFont(parseFont(orig), parseFont(sfnt));
  });

  it("round-trips a TrueType font without the hmtx transform", () => {
    const orig = load(KATEX_MAIN);
    const { woff2, hmtxTransformed } = toWoff2(orig, { transformHmtx: false });
    assert.equal(hmtxTransformed, false);
    assertSameFont(parseFont(orig), parseFont(woff2));
  });

  it("round-trips a TrueType font with null-transformed glyf and loca", () => {
    const orig = load(KATEX_SANS);
    const { woff2 } = toWoff2(orig, { transformGlyf: false });
    const sfnt = webFontToSfnt(woff2);
    assert.deepEqual(sfntTables(sfnt).get("glyf"), sfntTables(orig).get("glyf"));
    assertSameFont(parseFont(orig), parseFont(woff2));
  });

  it("round-trips a CFF font (null transform)", () => {
    const orig = load(LM_ROMAN);
    const { woff2 } = toWoff2(orig);
    const sfnt = webFontToSfnt(woff2);
    assertValidSfnt(sfnt);
    const f = parseFont(woff2);
    assert.equal(f.outlines, "cff");
    assertSameFont(parseFont(orig), f);
  });

  it("sets OVERLAP_SIMPLE from the overlapSimpleBitmap", () => {
    const orig = load(KATEX_MAIN);
    const glyphs = glyphSlices(sfntTables(orig)).map(parseGlyph);
    const g = glyphs.findIndex((x) => x.kind === "simple" && x.xs.length > 0);
    const sfnt = webFontToSfnt(toWoff2(orig, { overlapGlyphs: new Set([g]) }).woff2);
    const out = glyphSlices(sfntTables(sfnt)).map(parseGlyph);
    const a = glyphs[g] as SimpleGlyph;
    const b = out[g] as SimpleGlyph;
    assert.equal(b.flags[0], a.flags[0] | 0x40);
    assert.deepEqual(b.flags.slice(1), a.flags.slice(1));
    assert.deepEqual([b.xs, b.ys], [a.xs, a.ys]);
    assert.deepEqual(out[g + 1], glyphs[g + 1]);
  });

  it("decodes UIntBase128 and 255UInt16 edge values", () => {
    // A table with an unknown tag (index 63) and a five-byte length still decodes.
    const orig = load(KATEX_SANS);
    const tables = sfntTables(orig);
    const list: Woff2Table[] = [...tables].map(([tag, data]) => ({
      tag,
      data,
      origLength: data.length,
      version: tag === "glyf" || tag === "loca" ? 3 : 0,
      transformed: false,
    }));
    list.push({ tag: "zzzz", data: Uint8Array.from([1, 2, 3]), origLength: 3, version: 0, transformed: false });
    const f = parseFont(writeWoff2(u32(orig, 0), list));
    assert.deepEqual(f.table("zzzz"), Uint8Array.from([1, 2, 3]));
    assert.deepEqual(base128(0xffffffff), [0x8f, 0xff, 0xff, 0xff, 0x7f]);
    for (const v of [0, 252, 253, 505, 506, 761, 762, 65535]) {
      const e = u255(v);
      const r = e[0] === 253 ? (e[1] << 8) | e[2] : e[0] === 255 ? e[1] + 253 : e[0] === 254 ? e[1] + 506 : e[0];
      assert.equal(r, v);
    }
  });

  it("rejects collections", () => {
    const file = toWoff2(load(KATEX_SANS)).woff2;
    new DataView(file.buffer).setUint32(4, 0x74746366);
    assert.throws(() => webFontToSfnt(file), /WOFF2 font collections are not supported/);
  });
});

describe("hostile web fonts", () => {
  const ttf = load(KATEX_SANS);
  const woff2 = toWoff2(ttf).woff2;
  const woff = toWoff(ttf);

  it("rejects wrong signatures", () => {
    expectFontError("empty", new Uint8Array(0));
    expectFontError("short", Uint8Array.from([0x77, 0x4f]));
    const bad = woff2.slice();
    bad[3] = 0x33;
    expectFontError("wOF3", bad);
    expectFontError("TTF passed to webFontToSfnt", ttf);
  });

  it("rejects every truncation", () => {
    for (const [name, file] of [
      ["woff", woff],
      ["woff2", woff2],
    ] as const) {
      for (let n = 0; n < file.length; n += Math.max(1, Math.floor(file.length / 400))) {
        const cut = file.slice(0, n);
        expectFontError(`${name} cut at ${n}`, cut);
        expectFontError(`${name} cut at ${n} via parseFont`, cut, parseFont);
      }
    }
  });

  it("rejects bad lengths and huge declared sizes", () => {
    const set32 = (file: Uint8Array, at: number, v: number) => {
      const c = file.slice();
      new DataView(c.buffer).setUint32(at, v);
      return c;
    };
    expectFontError("woff2 length past file", set32(woff2, 8, woff2.length + 1));
    expectFontError("woff2 huge totalSfntSize", set32(woff2, 16, 0xffffffff));
    expectFontError("woff2 huge compressed size", set32(woff2, 20, 0xfffffff0));
    expectFontError("woff2 zero compressed size", set32(woff2, 20, 0));
    expectFontError("woff length past file", set32(woff, 8, woff.length + 1));
    // First WOFF table entry: offset, compLength, origLength.
    expectFontError("woff table offset", set32(woff, 44 + 4, 0xfffffff0));
    expectFontError("woff compLength", set32(woff, 44 + 8, 0xfffffff0));
    expectFontError("woff origLength huge", set32(woff, 44 + 12, 0xfffffff0));
    expectFontError("woff origLength wrong", set32(woff, 44 + 12, u32(woff, 44 + 12) + 1));
    const many = woff2.slice();
    new DataView(many.buffer).setUint16(12, 0xffff);
    expectFontError("woff2 numTables 65535", many);

    // Directory lengths that disagree with the data.
    const tables = sfntTables(ttf);
    const entry = (tag: string, data: Uint8Array, origLength = data.length): Woff2Table => ({
      tag,
      data,
      origLength,
      version: tag === "glyf" || tag === "loca" ? 3 : 0,
      transformed: false,
    });
    const head = tables.get("head")!;
    expectFontError("woff2 origLength 2^32-1", writeWoff2(0x10000, [entry("head", head, 0xffffffff)]));
    const short = writeWoff2(0x10000, [entry("head", head)], {
      stream: new Uint8Array(brotliCompressSync(head.subarray(0, 20))),
    });
    expectFontError("woff2 stream shorter than declared", short);
    const loca: Woff2Table = { tag: "loca", data: Uint8Array.from([1]), origLength: 4, version: 0, transformed: true };
    expectFontError("woff2 loca with transform length", writeWoff2(0x10000, [entry("head", head), loca]));
    const badHmtx: Woff2Table = { tag: "hmtx", data: Uint8Array.from([1]), origLength: 4, version: 1, transformed: true };
    expectFontError("woff2 hmtx transform without glyf", writeWoff2(0x10000, [entry("head", head), badHmtx]));
    const unknown: Woff2Table = { tag: "GSUB", data: Uint8Array.from([1]), origLength: 4, version: 2, transformed: true };
    expectFontError("woff2 unknown transform", writeWoff2(0x10000, [entry("head", head), unknown]));
    expectFontError("woff2 duplicate table", writeWoff2(0x10000, [entry("head", head), entry("head", head)]));
  });

  it("rejects decompression bombs quickly", () => {
    const zeros = new Uint8Array(48 * 1024 * 1024);
    const brotliBomb = new Uint8Array(brotliCompressSync(zeros, { params: { [zc.BROTLI_PARAM_QUALITY]: 1 } }));
    const bomb = writeWoff2(0x10000, [{ tag: "head", data: new Uint8Array(1000), origLength: 1000, version: 0, transformed: false }], {
      stream: brotliBomb,
    });
    expectFontError("brotli bomb", bomb);

    const zlibBomb = new Uint8Array(deflateSync(zeros, { level: 1 }));
    const w = new Bytes();
    w.u32(0x774f4646);
    w.u32(0x10000);
    w.u32(44 + 20 + zlibBomb.length);
    w.u16(1);
    w.u16(0);
    w.u32(1100);
    for (let k = 0; k < 6; k++) w.u32(0);
    for (const ch of "head") w.u8(ch.charCodeAt(0));
    w.u32(64);
    w.u32(zlibBomb.length);
    w.u32(zlibBomb.length + 10);
    w.u32(0);
    const file = new Uint8Array(64 + zlibBomb.length);
    file.set(w.bytes);
    file.set(zlibBomb, 64);
    expectFontError("zlib bomb", file);
  });

  it("rejects hostile glyf transforms", () => {
    const tables = sfntTables(ttf);
    const fixed = (tag: string): Woff2Table => ({ tag, data: tables.get(tag)!, origLength: tables.get(tag)!.length, version: 0, transformed: false });
    const withGlyf = (glyf: Uint8Array, locaLength: number) =>
      writeWoff2(0x10000, [
        fixed("head"),
        fixed("hhea"),
        fixed("maxp"),
        fixed("hmtx"),
        { tag: "glyf", data: glyf, origLength: 1000, version: 0, transformed: true },
        { tag: "loca", data: new Uint8Array(0), origLength: locaLength, version: 0, transformed: true },
      ]);
    const header = (numGlyphs: number, sizes: number[], indexFormat = 0) => {
      const b = new Bytes();
      b.u16(0);
      b.u16(0);
      b.u16(numGlyphs);
      b.u16(indexFormat);
      for (const s of sizes) b.u32(s);
      return b;
    };
    // 65535 glyphs, each claiming 32767 contours, with almost no data.
    const h1 = header(0xffff, [4, 2, 0, 0, 0, 4 * 2048, 0]);
    h1.push([0x7f, 0xff, 0x7f, 0xff, 0xfd, 0xff]);
    h1.push(new Uint8Array(4 * 2048));
    expectFontError("huge contour counts", withGlyf(h1.bytes, 2 * 0x10000));
    // Stream sizes past the end of the table.
    expectFontError("stream past end", withGlyf(header(1, [0xffffffff, 0, 0, 0, 0, 0, 0]).bytes, 4));
    // A composite whose component records run off the composite stream.
    const h2 = header(1, [2, 0, 0, 0, 4, 4 + 8, 0]);
    h2.push([0xff, 0xff]);
    h2.push([0x00, 0x20, 0x00, 0x01]);
    h2.push([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expectFontError("composite runs off its stream", withGlyf(h2.bytes, 4));
    // A simple glyph with 65535 points per contour and no flags.
    const h3 = header(1, [2, 6, 0, 0, 0, 4, 0]);
    h3.push([0x00, 0x02]);
    h3.push([253, 0xff, 0xff, 253, 0xff, 0xff]);
    h3.push([0, 0, 0, 0]);
    expectFontError("too many points", withGlyf(h3.bytes, 4));
    // Wrong loca length for the glyph count.
    const h4 = header(1, [2, 0, 0, 0, 0, 4, 0]);
    h4.push([0, 0]);
    h4.push([0, 0, 0, 0]);
    expectFontError("loca length mismatch", withGlyf(h4.bytes, 6));
    // Bad indexFormat.
    expectFontError("indexFormat 2", withGlyf(header(1, [2, 0, 0, 0, 0, 4, 0], 2).bytes, 4));
  });

  it("survives random corruption with only FontError", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    // Corrupt inside the header, directory and glyf transform (the Brotli
    // stream would mostly just fail to decompress), so the uncompressed
    // stream is rebuilt around the change.
    const tables = sfntTables(ttf);
    const glyfT = transformGlyf(tables).data;
    for (let trial = 0; trial < 300; trial++) {
      let file: Uint8Array;
      if (trial % 2) {
        file = woff2.slice();
        const span = Math.min(file.length, 120);
        for (let k = 0; k < 3; k++) file[Math.floor(rand() * span)] = Math.floor(rand() * 256);
      } else {
        const glyf = glyfT.slice();
        for (let k = 0; k < 4; k++) glyf[Math.floor(rand() * Math.min(glyf.length, 4000))] = Math.floor(rand() * 256);
        const list: Woff2Table[] = [...tables].map(([tag, data]) =>
          tag === "glyf"
            ? { tag, data: glyf, origLength: data.length, version: 0, transformed: true }
            : tag === "loca"
              ? { tag, data: new Uint8Array(0), origLength: data.length, version: 0, transformed: true }
              : { tag, data, origLength: data.length, version: 0, transformed: false },
        );
        file = writeWoff2(0x10000, list, { quality: 1 });
      }
      const t0 = performance.now();
      try {
        const f = parseFont(file);
        for (let g = 0; g < f.glyphCount; g++) {
          try {
            f.outline(g);
          } catch (err) {
            if (!(err instanceof FontError)) throw err;
          }
        }
      } catch (err) {
        if (!(err instanceof FontError)) throw err;
      }
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `trial ${trial} took ${ms.toFixed(1)} ms`);
    }
  });
});
