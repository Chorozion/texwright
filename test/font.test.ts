import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUNDLED_STYLES,
  type BundledFamily,
  type Font,
  FontError,
  bundledFont,
  bundledFontPath,
  collectionSize,
  fallbackFor,
  findSystemFont,
  fontsDir,
  parseFont,
  setSystemFontDirs,
  systemFontFiles,
  systemFonts,
  tableChecksum,
} from "../src/font/index.js";
import { STANDARD_GLYPH_NAMES } from "../src/font/encodings.js";
import { GposKerning, KernTable } from "../src/font/layout.js";
import { Reader } from "../src/font/reader.js";
import { FLAVOR_OTTO, buildSfnt } from "../src/font/sfnt.js";

// ---------------------------------------------------------------------------
// Helpers

function load(path: string): Uint8Array | undefined {
  if (!existsSync(path)) return undefined;
  const b = readFileSync(path);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

const WIN = "C:/Windows/Fonts";
const winPath = (name: string) => join(WIN, name);
const hasWin = (name: string) => existsSync(winPath(name));
const LIBERATION = join(fontsDir(), "..", "node_modules", "pdfjs-dist", "standard_fonts", "LiberationSans-Regular.ttf");
const KATEX_OTF = join(fontsDir(), "..", "node_modules", "katex", "src", "fonts", "lib", "Extra.otf");

const cp = (s: string) => s.codePointAt(0)!;
const gidsOf = (font: Font, text: string) => [...text].map((c) => font.glyphForCodePoint(cp(c)));

function u16(b: Uint8Array, o: number) {
  return (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function tag(b: Uint8Array, o: number) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Table directory of a single (non-collection) font. */
function directory(b: Uint8Array): Map<string, { checksum: number; offset: number; length: number }> {
  const n = u16(b, 4);
  const out = new Map<string, { checksum: number; offset: number; length: number }>();
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i;
    out.set(tag(b, p), { checksum: u32(b, p + 4), offset: u32(b, p + 8), length: u32(b, p + 12) });
  }
  return out;
}

/** Recomputes every table checksum and the whole-file checksum. */
function assertChecksumsValid(b: Uint8Array) {
  for (const [t, rec] of directory(b)) {
    let data = b.subarray(rec.offset, rec.offset + rec.length);
    if (t === "head") {
      data = new Uint8Array(data);
      data.fill(0, 8, 12);
    }
    assert.equal(tableChecksum(data), rec.checksum, `checksum of '${t}'`);
  }
  assert.equal(tableChecksum(b), 0xb1b0afba, "whole-file checksum");
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs every public query on a font; only FontError may escape. */
function exercise(font: Font) {
  void font.capHeight;
  void font.xHeight;
  let n = 0;
  for (const c of font.codePoints()) {
    font.glyphForCodePoint(c);
    if (++n > 200000) break;
  }
  for (const c of [0x20, 0x41, 0x66, 0x69, 0xe9, 0x2212, 0x4e2d, 0x1f600]) font.glyphForCodePoint(c);
  const limit = Math.min(font.glyphCount, 400);
  for (let g = 0; g < limit; g++) {
    font.advance(g);
    font.bounds(g);
    font.glyphName(g);
  }
  font.glyphForName("A");
  for (let g = 0; g < Math.min(limit, 40); g++) font.kerning(g, (g * 7) % limit);
  font.ligatures([1, 2, 3, 4, 5].filter((g) => g < font.glyphCount));
  void font.bytes;
  if (font.outlines === "truetype") font.subset([1, 2, 3, 10, 20].filter((g) => g < font.glyphCount));
}

function expectFontErrorOrSuccess(fn: () => void) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof FontError)) throw new Error(`expected FontError, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
}

// ---------------------------------------------------------------------------
// A tiny TrueType font builder for synthetic and hostile fonts

interface SynthGlyph {
  /** Simple glyph box, or a composite of these glyph ids. */
  box?: [number, number, number, number];
  components?: number[];
}

function simpleGlyph([x0, y0, x1, y1]: [number, number, number, number]): Uint8Array {
  // One contour, three on-curve points with 16-bit deltas.
  const b = new Uint8Array(10 + 2 + 2 + 3 + 6 + 6);
  const v = new DataView(b.buffer);
  v.setInt16(0, 1);
  v.setInt16(2, x0);
  v.setInt16(4, y0);
  v.setInt16(6, x1);
  v.setInt16(8, y1);
  v.setUint16(10, 2); // endPtsOfContours[0]
  v.setUint16(12, 0); // instructionLength
  b.fill(0x01, 14, 17); // on-curve, x and y as int16 deltas
  const xs = [x0, x1 - x0, x0 - x1];
  const ys = [y0, y1 - y0, 0];
  xs.forEach((x, i) => v.setInt16(17 + 2 * i, x));
  ys.forEach((y, i) => v.setInt16(23 + 2 * i, y));
  return b;
}

function compositeGlyph(components: number[]): Uint8Array {
  const b = new Uint8Array(10 + 8 * components.length);
  const v = new DataView(b.buffer);
  v.setInt16(0, -1);
  v.setInt16(6, 500);
  v.setInt16(8, 700);
  components.forEach((g, i) => {
    const p = 10 + 8 * i;
    const more = i < components.length - 1 ? 0x0020 : 0;
    v.setUint16(p, 0x0001 | 0x0002 | more); // word args, xy values
    v.setUint16(p + 2, g);
    v.setInt16(p + 4, 10 * i);
    v.setInt16(p + 6, 0);
  });
  return b;
}

function cmapFormat12(map: [number, number][], format: 12 | 13 = 12, platform: [number, number] = [3, 10]): Uint8Array {
  const sub = new Uint8Array(16 + 12 * map.length);
  const v = new DataView(sub.buffer);
  v.setUint16(0, format);
  v.setUint32(4, sub.length);
  v.setUint32(12, map.length);
  map.forEach(([c, g], i) => {
    v.setUint32(16 + 12 * i, c);
    v.setUint32(20 + 12 * i, c);
    v.setUint32(24 + 12 * i, g);
  });
  return cmapWrap(sub, platform);
}

function cmapWrap(sub: Uint8Array, [platformID, encodingID]: [number, number]): Uint8Array {
  const out = new Uint8Array(12 + sub.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1);
  v.setUint16(4, platformID);
  v.setUint16(6, encodingID);
  v.setUint32(8, 12);
  out.set(sub, 12);
  return out;
}

function synthFont(glyphs: SynthGlyph[], extra: { tag: string; data: Uint8Array }[] = []): Uint8Array {
  const n = glyphs.length;
  const datas = glyphs.map((g) => (g.components ? compositeGlyph(g.components) : g.box ? simpleGlyph(g.box) : new Uint8Array(0)));
  const offsets: number[] = [];
  let size = 0;
  for (const d of datas) {
    offsets.push(size);
    size += (d.length + 3) & ~3;
  }
  offsets.push(size);
  const glyf = new Uint8Array(size);
  datas.forEach((d, i) => glyf.set(d, offsets[i]));
  const loca = new Uint8Array(4 * (n + 1));
  offsets.forEach((o, i) => new DataView(loca.buffer).setUint32(4 * i, o));
  const head = new Uint8Array(54);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x00010000);
  hv.setUint32(12, 0x5f0f3cf5);
  hv.setUint16(18, 1000);
  hv.setInt16(36, 0);
  hv.setInt16(38, -200);
  hv.setInt16(40, 1000);
  hv.setInt16(42, 800);
  hv.setInt16(50, 1);
  const hhea = new Uint8Array(36);
  const hh = new DataView(hhea.buffer);
  hh.setUint32(0, 0x00010000);
  hh.setInt16(4, 800);
  hh.setInt16(6, -200);
  hh.setUint16(34, n);
  const maxp = new Uint8Array(32);
  new DataView(maxp.buffer).setUint32(0, 0x00010000);
  new DataView(maxp.buffer).setUint16(4, n);
  const hmtx = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) new DataView(hmtx.buffer).setUint16(4 * i, 500 + i);
  return buildSfnt([
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "maxp", data: maxp },
    { tag: "hmtx", data: hmtx },
    { tag: "loca", data: loca },
    { tag: "glyf", data: glyf },
    ...extra,
  ]);
}

/** Overwrites a table directory field of a single font. */
function patchDirectory(b: Uint8Array, t: string, field: "offset" | "length", value: number): Uint8Array {
  const out = new Uint8Array(b);
  const n = u16(out, 4);
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i;
    if (tag(out, p) === t) {
      new DataView(out.buffer).setUint32(p + (field === "offset" ? 8 : 12), value >>> 0);
      return out;
    }
  }
  throw new Error(`no table ${t}`);
}

/** A font collection built from single fonts (tables copied, not shared). */
function makeTtc(fonts: Uint8Array[]): Uint8Array {
  const dirs = fonts.map((f) => directory(f));
  const headerSize = 12 + 4 * fonts.length;
  let size = headerSize;
  const dirOffsets: number[] = [];
  for (const d of dirs) {
    dirOffsets.push(size);
    size += 12 + 16 * d.size;
  }
  const tableOffsets: Map<string, number>[] = [];
  for (const d of dirs) {
    const m = new Map<string, number>();
    for (const [t, rec] of d) {
      m.set(t, size);
      size += (rec.length + 3) & ~3;
    }
    tableOffsets.push(m);
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0]);
  v.setUint32(8, fonts.length);
  fonts.forEach((font, i) => {
    v.setUint32(12 + 4 * i, dirOffsets[i]);
    out.set(font.subarray(0, 12), dirOffsets[i]);
    let k = 0;
    for (const [t, rec] of dirs[i]) {
      const p = dirOffsets[i] + 12 + 16 * k++;
      for (let c = 0; c < 4; c++) out[p + c] = t.charCodeAt(c);
      v.setUint32(p + 4, rec.checksum);
      v.setUint32(p + 8, tableOffsets[i].get(t)!);
      v.setUint32(p + 12, rec.length);
      out.set(font.subarray(rec.offset, rec.offset + rec.length), tableOffsets[i].get(t)!);
    }
  });
  return out;
}

/** Sets OS/2.fsType in a copy of a single font (checksums are not fixed up). */
function withFsType(b: Uint8Array, fsType: number): Uint8Array {
  const out = new Uint8Array(b);
  const os2 = directory(out).get("OS/2")!;
  new DataView(out.buffer).setUint16(os2.offset + 8, fsType);
  return out;
}

function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const v = fn();
  return [v, performance.now() - t0];
}

// ---------------------------------------------------------------------------

describe("bundled KaTeX fonts", () => {
  it("ships all 25 files with their licenses and README", () => {
    const dir = fontsDir();
    let count = 0;
    for (const [family, styles] of Object.entries(BUNDLED_STYLES)) {
      for (const style of styles) {
        assert.ok(existsSync(bundledFontPath(family as BundledFamily, style)), `${family}-${style}`);
        count++;
      }
    }
    assert.equal(count, 25);
    assert.ok(existsSync(join(dir, "LICENSE-KaTeX.txt")));
    assert.ok(existsSync(join(dir, "OFL-KaTeX.txt")), "the KaTeX fonts are under the SIL OFL, which must ship with them");
    assert.ok(existsSync(join(dir, "GUST-FONT-LICENSE.TXT")));
    assert.ok(existsSync(join(dir, "README-Latin-Modern.TXT")));
    assert.ok(existsSync(join(dir, "README.md")));
  });

  it("parses every bundled font", () => {
    for (const [family, styles] of Object.entries(BUNDLED_STYLES)) {
      for (const style of styles) {
        const f = bundledFont(family as BundledFamily, style);
        if (family.startsWith("LM")) {
          // Latin Modern, OpenType with CFF outlines: "LMRoman10-BoldItalic", "LMMono10-Regular".
          assert.equal(f.postscriptName, `${family}10-${style}`);
          assert.equal(f.outlines, "cff");
        } else {
          assert.equal(f.familyName, `KaTeX_${family}`);
          assert.equal(f.postscriptName, `KaTeX_${family}-${style}`);
          assert.equal(f.outlines, "truetype");
        }
        assert.equal(f.unitsPerEm, 1000);
        assert.ok(f.embeddingAllowed);
        assert.deepEqual(f.warnings, []);
        assert.ok(f.glyphCount > 20);
      }
    }
  });

  it("reads KaTeX_Main-Regular metadata", () => {
    const f = bundledFont("Main");
    assert.equal(f.postscriptName, "KaTeX_Main-Regular");
    assert.equal(f.familyName, "KaTeX_Main");
    assert.equal(f.subfamilyName, "Regular");
    assert.equal(f.fullName, "KaTeX_Main-Regular");
    assert.equal(f.glyphCount, 286);
    assert.equal(f.ascent, 903);
    assert.equal(f.descent, -272);
    assert.equal(f.lineGap, 90);
    assert.equal(f.capHeight, 683);
    assert.ok(f.xHeight > 400 && f.xHeight < 460, `xHeight ${f.xHeight}`);
    assert.equal(f.italicAngle, 0);
    assert.equal(f.isFixedPitch, false);
    assert.equal(f.bold, false);
    assert.equal(f.italic, false);
    assert.deepEqual(f.bbox, { xMin: -471, yMin: -272, xMax: 1803, yMax: 903 });
    assert.equal(f.collectionIndex, 0);
  });

  it("knows styles and defaults", () => {
    assert.equal(bundledFont("Main", "Bold").bold, true);
    assert.equal(bundledFont("Main", "Bold").weight, 700);
    assert.equal(bundledFont("Main", "Italic").italic, true);
    assert.equal(bundledFont("Main", "Italic").bold, false);
    assert.equal(bundledFont("Main", "BoldItalic").italic, true);
    assert.equal(bundledFont("Main", "Regular").italic, false);
    const math = bundledFont("Math");
    assert.equal(math.subfamilyName, "Italic");
    assert.equal(math.italic, true);
    assert.equal(bundledFont("Typewriter").isFixedPitch, true);
    assert.equal(bundledFont("Main"), bundledFont("Main", "Regular"), "cached");
    assert.throws(() => bundledFont("Math", "Regular"), (e: unknown) => e instanceof FontError && /Italic, BoldItalic/.test(e.message));
  });

  it("maps characters through the format 4 cmap", () => {
    const f = bundledFont("Main");
    const A = f.glyphForCodePoint(0x41);
    assert.ok(A > 0);
    assert.equal(f.glyphName(A), "A");
    assert.ok(f.glyphForCodePoint(0x2212) > 0, "minus sign");
    assert.ok(f.glyphForCodePoint(0x393) > 0, "Gamma");
    assert.ok(f.glyphForCodePoint(0x2014) > 0, "em dash");
    assert.equal(f.glyphForCodePoint(0x60), 0, "no grave accent character");
    assert.equal(f.glyphForCodePoint(0xe9), 0, "no precomposed e-acute");
    assert.equal(f.glyphForCodePoint(0xfb01), 0, "no fi ligature code point");
    assert.equal(f.glyphForCodePoint(0x1d400), 0);
    assert.equal(f.glyphForCodePoint(-1), 0);
    assert.equal(f.glyphForCodePoint(0x110000), 0);
    assert.equal(f.glyphForCodePoint(Number.NaN), 0);
    assert.equal(f.glyphForCodePoint(65.5), 0);
    assert.equal(f.glyphName(1.5), undefined);
    assert.equal(f.kerning(1.5, 2), 0);
  });

  it("lists code points in order, each mapped", () => {
    const f = bundledFont("Main");
    const cps = [...f.codePoints()];
    assert.equal(cps.length, 283);
    for (let i = 1; i < cps.length; i++) assert.ok(cps[i] > cps[i - 1]);
    for (const c of cps) assert.ok(f.glyphForCodePoint(c) > 0);
    for (let c = 0x20; c < 0x7f; c++) assert.equal(cps.includes(c), c !== 0x60, `U+${c.toString(16)}`);
  });

  it("reads advances and bounds", () => {
    const f = bundledFont("Main");
    const A = f.glyphForCodePoint(0x41);
    assert.equal(f.advance(A), 750);
    assert.deepEqual(f.bounds(A), { xMin: 32, yMin: 0, xMax: 717, yMax: 716 });
    const space = f.glyphForCodePoint(0x20);
    assert.ok(f.advance(space) > 0);
    assert.deepEqual(f.bounds(space), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
    assert.equal(f.advance(-1), 0);
    assert.equal(f.advance(f.glyphCount), 0);
    assert.deepEqual(f.bounds(99999), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
    const g = bundledFont("Math").glyphForCodePoint(0x67); // g has a descender
    assert.ok(bundledFont("Math").bounds(g).yMin < 0);
  });

  it("reads post format 2 glyph names", () => {
    const f = bundledFont("Main");
    assert.equal(f.glyphName(0), ".notdef");
    assert.equal(f.glyphForName("A"), f.glyphForCodePoint(0x41));
    assert.equal(f.glyphForName("no-such-glyph"), 0);
    assert.equal(f.glyphName(f.glyphCount), undefined);
    for (let g = 0; g < f.glyphCount; g++) {
      const name = f.glyphName(g);
      assert.ok(name !== undefined, `glyph ${g}`);
      assert.equal(f.glyphForName(name!), g);
    }
  });

  it("has no kerning or ligatures, and says so with zero and identity", () => {
    const f = bundledFont("Main");
    const [A, V] = gidsOf(f, "AV");
    assert.equal(f.kerning(A, V), 0);
    const run = gidsOf(f, "office");
    assert.deepEqual(f.ligatures(run), run);
    assert.deepEqual(f.ligatureClusters(run).counts, [1, 1, 1, 1, 1, 1]);
  });

  it("matches the table checksums stored in the files", () => {
    const b = load(bundledFontPath("Main"))!;
    for (const [t, rec] of directory(b)) {
      if (t === "head") continue;
      assert.equal(tableChecksum(b, rec.offset, rec.length), rec.checksum, t);
    }
  });

  it("has the 258 standard Macintosh glyph names", () => {
    assert.equal(STANDARD_GLYPH_NAMES.length, 258);
    assert.equal(STANDARD_GLYPH_NAMES[3], "space");
    assert.equal(STANDARD_GLYPH_NAMES[36], "A");
    assert.equal(STANDARD_GLYPH_NAMES[257], "dcroat");
  });
});

describe("character maps", () => {
  it("reads format 12 supplementary-plane mappings", () => {
    const font = parseFont(synthFont([{}, { box: [0, 0, 500, 500] }, { box: [0, 0, 400, 400] }], [
      { tag: "cmap", data: cmapFormat12([[0x41, 1], [0x1f600, 2]]) },
    ]));
    assert.equal(font.glyphForCodePoint(0x41), 1);
    assert.equal(font.glyphForCodePoint(0x1f600), 2);
    assert.equal(font.glyphForCodePoint(0x1f601), 0);
    assert.deepEqual([...font.codePoints()], [0x41, 0x1f600]);
  });

  it("reads format 13 many-to-one mappings", () => {
    const sub = new Uint8Array(16 + 12);
    const v = new DataView(sub.buffer);
    v.setUint16(0, 13);
    v.setUint32(12, 1);
    v.setUint32(16, 0x4e00);
    v.setUint32(20, 0x4e0f);
    v.setUint32(24, 1);
    const font = parseFont(synthFont([{}, { box: [0, 0, 1, 1] }], [{ tag: "cmap", data: cmapWrap(sub, [3, 10]) }]));
    assert.equal(font.glyphForCodePoint(0x4e00), 1);
    assert.equal(font.glyphForCodePoint(0x4e0f), 1);
    assert.equal(font.glyphForCodePoint(0x4e10), 0);
    assert.equal([...font.codePoints()].length, 16);
  });

  it("reads Mac Roman (1,0) format 0 subtables through Unicode", () => {
    const sub = new Uint8Array(6 + 256);
    new DataView(sub.buffer).setUint16(0, 0);
    sub[6 + 0x41] = 1;
    sub[6 + 0x8e] = 2; // e-acute in Mac OS Roman
    const font = parseFont(synthFont([{}, { box: [0, 0, 1, 1] }, { box: [0, 0, 1, 1] }], [
      { tag: "cmap", data: cmapWrap(sub, [1, 0]) },
    ]));
    assert.equal(font.glyphForCodePoint(0x41), 1);
    assert.equal(font.glyphForCodePoint(0xe9), 2);
    assert.equal(font.glyphForCodePoint(0x8e), 0);
    assert.deepEqual([...font.codePoints()], [0x41, 0xe9]);
  });

  it("prefers a (3,10) subtable over (3,1)", { skip: !hasWin("seguiemj.ttf") }, () => {
    const f = parseFont(load(winPath("seguiemj.ttf"))!);
    assert.ok(f.glyphForCodePoint(0x1f600) > 0, "grinning face");
    assert.ok([...f.codePoints()].some((c) => c > 0xffff));
  });

  it("finds supplementary ideographs in SimSun-ExtB", { skip: !hasWin("simsunb.ttf") }, () => {
    const f = parseFont(load(winPath("simsunb.ttf"))!);
    assert.ok(f.glyphForCodePoint(0x20000) > 0);
    assert.ok(f.glyphForCodePoint(0x2a6d6) > 0);
  });

  it("maps 8-bit codes into Symbol fonts' F0xx area", { skip: !hasWin("symbol.ttf") }, () => {
    const f = parseFont(load(winPath("symbol.ttf"))!);
    assert.equal(f.symbolic, true);
    assert.ok(f.glyphForCodePoint(0x41) > 0);
    assert.equal(f.glyphForCodePoint(0x41), f.glyphForCodePoint(0xf041));
  });
});

describe("Windows system fonts", () => {
  it("reads Times New Roman", { skip: !hasWin("times.ttf") }, () => {
    const f = parseFont(load(winPath("times.ttf"))!);
    assert.equal(f.familyName, "Times New Roman");
    assert.equal(f.subfamilyName, "Regular");
    assert.equal(f.postscriptName, "TimesNewRomanPSMT");
    assert.equal(f.unitsPerEm, 2048);
    assert.equal(f.ascent, 1825);
    assert.equal(f.descent, -443);
    assert.equal(f.bold, false);
    assert.equal(f.italic, false);
    assert.equal(f.isFixedPitch, false);
    assert.equal(f.embeddingAllowed, true);
    assert.equal(f.serif, true);
    assert.ok(f.capHeight > 1300 && f.capHeight < 1400);
    assert.ok(f.xHeight > 880 && f.xHeight < 960);
    assert.deepEqual(f.warnings, []);
  });

  it("kerns AV and To in Times New Roman, with GPOS and kern agreeing", { skip: !hasWin("times.ttf") }, () => {
    const f = parseFont(load(winPath("times.ttf"))!);
    const [A, V, T, o] = gidsOf(f, "AVTo");
    assert.ok(f.kerning(A, V) < 0, `AV ${f.kerning(A, V)}`);
    assert.ok(f.kerning(T, o) < 0);
    assert.equal(f.kerning(V, V), 0);
    const gpos = new GposKerning(new Reader(f.table("GPOS")!));
    const kern = new KernTable(new Reader(f.table("kern")!));
    for (const [l, r] of [[A, V], [T, o], [o, T]]) assert.equal(gpos.kern(l, r), kern.kern(l, r));
  });

  it("reads bold and italic styles", { skip: !hasWin("timesbd.ttf") || !hasWin("timesi.ttf") }, () => {
    const bold = parseFont(load(winPath("timesbd.ttf"))!);
    assert.equal(bold.bold, true);
    assert.equal(bold.weight, 700);
    const italic = parseFont(load(winPath("timesi.ttf"))!);
    assert.equal(italic.italic, true);
    assert.ok(italic.italicAngle < 0);
  });

  it("reads Consolas as fixed pitch", { skip: !hasWin("consola.ttf") }, () => {
    const f = parseFont(load(winPath("consola.ttf"))!);
    assert.equal(f.isFixedPitch, true);
    const widths = new Set(gidsOf(f, "iiWW.,mM").map((g) => f.advance(g)));
    assert.equal(widths.size, 1);
  });

  it("indexes the Cambria collection", { skip: !hasWin("cambria.ttc") }, () => {
    const b = load(winPath("cambria.ttc"))!;
    assert.equal(collectionSize(b), 2);
    const cambria = parseFont(b);
    const math = parseFont(b, 1);
    assert.equal(cambria.familyName, "Cambria");
    assert.equal(math.familyName, "Cambria Math");
    assert.equal(math.collectionIndex, 1);
    assert.ok(math.glyphForCodePoint(0x1d400) > 0, "mathematical bold A");
    assert.ok(math.glyphForCodePoint(0x222b) > 0, "integral");
    assert.throws(() => parseFont(b, 2), FontError);
    assert.throws(() => parseFont(b, -1), FontError);
    // A collection member's bytes are a standalone font.
    const own = math.bytes;
    assert.equal(collectionSize(own), 1);
    assertChecksumsValid(own);
    const again = parseFont(own);
    assert.equal(again.familyName, "Cambria Math");
    assert.equal(again.glyphCount, math.glyphCount);
    const g = math.glyphForCodePoint(0x222b);
    assert.equal(again.advance(g), math.advance(g));
    assert.deepEqual(again.bounds(g), math.bounds(g));
  });

  it("applies GSUB standard ligatures in Calibri", { skip: !hasWin("calibri.ttf") }, () => {
    const f = parseFont(load(winPath("calibri.ttf"))!);
    const run = gidsOf(f, "office");
    const out = f.ligatureClusters(run);
    assert.equal(out.glyphs.length, 4);
    assert.deepEqual(out.counts, [1, 3, 1, 1]);
    assert.equal(out.glyphs[0], run[0]);
    assert.notEqual(out.glyphs[1], run[1]);
    assert.deepEqual(f.ligatures(gidsOf(f, "fl")).length, 1);
    assert.deepEqual(f.ligatures(gidsOf(f, "xyz")), gidsOf(f, "xyz"));
    assert.deepEqual(f.ligatures([]), []);
  });

  it("leaves Times New Roman's discretionary-only ligatures alone", { skip: !hasWin("times.ttf") }, () => {
    // Times New Roman lists fi/fl under 'dlig', not 'liga', for Latin.
    const f = parseFont(load(winPath("times.ttf"))!);
    const run = gidsOf(f, "fi");
    assert.deepEqual(f.ligatures(run), run);
  });

  it("opens a big CJK collection quickly", { skip: !hasWin("msyh.ttc") }, (t) => {
    const b = load(winPath("msyh.ttc"))!;
    parseFont(b); // warm up the JIT
    const [f, ms] = timed(() => parseFont(b, 0));
    t.diagnostic(`msyh.ttc (${(b.length / 1e6).toFixed(1)} MB): parse ${ms.toFixed(2)} ms`);
    assert.ok(ms < 100, `parse took ${ms} ms`);
    assert.equal(collectionSize(b), 2);
    assert.equal(f.familyName, "Microsoft YaHei");
    assert.ok(f.glyphCount > 20000);
    const zhong = f.glyphForCodePoint(cp("中"));
    assert.ok(zhong > 0);
    assert.ok(f.advance(zhong) > 0);
    const [count, iterMs] = timed(() => {
      let n = 0;
      for (const _ of f.codePoints()) n++;
      return n;
    });
    t.diagnostic(`msyh.ttc: ${count} code points iterated in ${iterMs.toFixed(1)} ms`);
    assert.ok(count > 20000);
    const [sub, subMs] = timed(() => f.subset(gidsOf(f, "中文字体测试")));
    t.diagnostic(`msyh.ttc: 6-character subset ${sub.length} bytes in ${subMs.toFixed(1)} ms`);
    assert.ok(sub.length < b.length / 100);
    assertChecksumsValid(sub);
  });

  it("reads post format 2 names and kern in Liberation Sans", { skip: !existsSync(LIBERATION) }, () => {
    const f = parseFont(load(LIBERATION)!);
    assert.equal(f.glyphName(f.glyphForCodePoint(0x20ac)), "Euro");
    assert.equal(f.glyphForName("Euro"), f.glyphForCodePoint(0x20ac));
    const [A, V] = gidsOf(f, "AV");
    assert.ok(f.kerning(A, V) < 0);
    const kern = new KernTable(new Reader(f.table("kern")!));
    assert.equal(kern.kern(A, V), f.kerning(A, V));
  });

  it("recognises CFF outlines", { skip: !existsSync(KATEX_OTF) }, () => {
    const f = parseFont(load(KATEX_OTF)!);
    assert.equal(f.outlines, "cff");
    assert.equal(f.glyphCount, 2);
    // The one real glyph spans the whole font bounding box.
    assert.deepEqual(f.bounds(1), f.bbox);
    assert.equal(f.glyphForCodePoint(0x5f), 1);
    const s = parseFont(f.subset([1]));
    assert.equal(s.outlines, "cff");
    assert.equal(s.glyphCount, f.glyphCount);
    assert.deepEqual(s.bounds(1), f.bounds(1));
    assert.ok(f.table("CFF ")!.length > 0);
  });
});

// ---------------------------------------------------------------------------
// A tiny CFF / CFF2 builder

/** Charstring operand as a 16-bit integer. */
const n16 = (v: number) => [28, (v >> 8) & 255, v & 255];
/** DICT operand as a 32-bit integer. */
const int5 = (v: number) => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function cffIndex(items: number[][], cff2 = false): number[] {
  if (!items.length) return cff2 ? [0, 0, 0, 0] : [0, 0];
  const out: number[] = cff2 ? [0, 0, (items.length >> 8) & 255, items.length & 255] : [(items.length >> 8) & 255, items.length & 255];
  out.push(4);
  let off = 1;
  const offsets = [off];
  for (const it of items) offsets.push((off += it.length));
  for (const o of offsets) out.push((o >>> 24) & 255, (o >>> 16) & 255, (o >>> 8) & 255, o & 255);
  for (const it of items) out.push(...it);
  return out;
}

function cffFontTables(cff: number[], tableTag: "CFF " | "CFF2", glyphs: number): { tag: string; data: Uint8Array }[] {
  const head = new Uint8Array(54);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x00010000);
  hv.setUint32(12, 0x5f0f3cf5);
  hv.setUint16(18, 1000);
  hv.setInt16(40, 1000);
  hv.setInt16(42, 800);
  const hhea = new Uint8Array(36);
  new DataView(hhea.buffer).setInt16(4, 800);
  new DataView(hhea.buffer).setInt16(6, -200);
  new DataView(hhea.buffer).setUint16(34, 1);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint32(0, 0x00005000);
  new DataView(maxp.buffer).setUint16(4, glyphs);
  const hmtx = new Uint8Array(4 + 2 * (glyphs - 1));
  new DataView(hmtx.buffer).setUint16(0, 600);
  return [
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "maxp", data: maxp },
    { tag: "hmtx", data: hmtx },
    { tag: tableTag, data: new Uint8Array(cff) },
  ];
}

/** A CFF 1 font from charstrings, local and global subroutines. */
function synthCff(charstrings: number[][], subrs: number[][], gsubrs: number[][]): Uint8Array {
  const name = cffIndex([[...new TextEncoder().encode("Test")]]);
  const strings = cffIndex([]);
  const global = cffIndex(gsubrs);
  const chars = cffIndex(charstrings);
  const topSize = 2 + 1 + 8 + 17;
  const charStringsOffset = 4 + name.length + topSize + strings.length + global.length;
  const privateOffset = charStringsOffset + chars.length;
  const privateDict = [...int5(6), 19];
  const top = cffIndex([[...int5(charStringsOffset), 17, ...int5(privateDict.length), ...int5(privateOffset), 18]]);
  assert.equal(top.length, topSize);
  const cff = [1, 0, 4, 4, ...name, ...top, ...strings, ...global, ...chars, ...privateDict, ...cffIndex(subrs)];
  return buildSfnt(cffFontTables(cff, "CFF ", charstrings.length), FLAVOR_OTTO);
}

describe("CFF outlines", () => {
  // Subroutine numbers are biased by 107 when there are fewer than 1240.
  const subr = (i: number) => n16(i - 107);
  const chain: number[][] = [];
  // Subrs 2..8 each call the next one 100 times: 100^7 calls, far past any
  // budget, while staying inside the nesting limit.
  for (let k = 2; k <= 8; k++) {
    const body: number[] = [];
    for (let i = 0; i < 100; i++) body.push(...subr(k + 1), 10);
    chain.push(body.concat([11]));
  }
  const subrs = [
    [...n16(50), ...n16(50), 5, 11], // 0: rlineto 50 50
    [...subr(1), 10, 11], // 1: calls itself
    ...chain,
    [11], // 9: return
  ];
  const gsubrs = [[...n16(0), ...n16(100), 5, 11]]; // rlineto 0 100
  const font = parseFont(
    synthCff(
      [
        [14], // .notdef: empty
        // width, rmoveto 100 0, a 300 x 500 rectangle
        [...n16(600), ...n16(100), ...n16(0), 21, ...n16(300), ...n16(0), 5, ...n16(0), ...n16(500), 5, ...n16(-300), ...n16(0), 5, 14],
        // two stems, a hint mask, and a curve bulging above its end points
        [
          ...n16(0), ...n16(10), ...n16(0), ...n16(10), 1, 19, 0xc0, ...n16(0), ...n16(0), 21,
          ...n16(0), ...n16(200), ...n16(200), ...n16(0), ...n16(0), ...n16(-200), 8, 14,
        ],
        // local and global subroutines
        [...n16(10), ...n16(10), 21, ...subr(0), 10, ...n16(-107), 29, 14],
        // flex
        [...n16(0), ...n16(0), 21, ...[10, 20, 10, 20, 10, 0, 10, 0, 10, -20, 10, -20, 50].flatMap(n16), 12, 35, 14],
        [...n16(0), ...n16(0), 21, ...subr(1), 10, 14], // endless recursion
        [...n16(0), ...n16(0), 21, ...subr(2), 10, 14], // exponential fan-out
        // hvcurveto then vhcurveto with the final extra operand
        [...n16(0), ...n16(0), 21, ...[100, 50, 100, 100].flatMap(n16), 31, ...[100, 50, -100, -100, 30].flatMap(n16), 30, 14],
      ],
      subrs,
      gsubrs,
    ),
  );

  it("computes exact bounds from charstrings", () => {
    assert.equal(font.outlines, "cff");
    assert.deepEqual(font.bounds(0), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
    assert.deepEqual(font.bounds(1), { xMin: 100, yMin: 0, xMax: 400, yMax: 500 });
    assert.deepEqual(font.bounds(2), { xMin: 0, yMin: 0, xMax: 200, yMax: 150 });
    assert.deepEqual(font.bounds(3), { xMin: 10, yMin: 10, xMax: 60, yMax: 160 });
    assert.deepEqual(font.bounds(4), { xMin: 0, yMin: 0, xMax: 60, yMax: 40 });
    // hvcurveto runs (0,0) -> (150,200); vhcurveto rises above y 200 and
    // ends at (100,230), its extreme x staying short of its 200 control.
    const b = font.bounds(7);
    assert.equal(b.xMin, 0);
    assert.equal(b.yMin, 0);
    assert.ok(b.yMax > 200 && b.yMax <= 300, `yMax ${b.yMax}`);
    assert.ok(b.xMax > 150 && b.xMax < 200, `xMax ${b.xMax}`);
    assert.equal(font.advance(3), 600);
  });

  it("stops runaway subroutines with FontError", () => {
    const [, ms1] = timed(() => assert.throws(() => font.bounds(5), /nested/));
    const [, ms2] = timed(() => assert.throws(() => font.bounds(6), /operations/));
    assert.ok(ms1 < 100 && ms2 < 1000, `${ms1} ms, ${ms2} ms`);
  });

  it("subsets CFF, keeping glyph ids and only the subroutines the kept glyphs call", () => {
    const sub = font.subset([3]);
    const s = parseFont(sub);
    assert.equal(s.outlines, "cff");
    assert.equal(s.glyphCount, font.glyphCount);
    assert.deepEqual(s.bounds(3), font.bounds(3), "glyph 3 draws through local subr 0 and global subr 0");
    assert.equal(s.advance(3), font.advance(3));
    assert.deepEqual(s.bounds(1), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }, "an unused glyph is empty");
    // The runaway subroutines nobody calls are gone, so glyph 6 (now empty) is harmless.
    assert.deepEqual(s.bounds(6), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
    assert.ok(sub.length < font.bytes.length);
  });

  it("subsets fonts with runaway subroutines quickly, keeping every subroutine", () => {
    for (const g of [5, 6]) {
      const [sub, ms] = timed(() => font.subset([g, 3]));
      assert.ok(ms < 1000, `${ms} ms`);
      const s = parseFont(sub);
      // The tracer gave up, so all subroutines stay and glyph 3 still draws.
      assert.deepEqual(s.bounds(3), font.bounds(3));
      assert.throws(() => s.bounds(g), g === 5 ? /nested/ : /operations/);
    }
  });

  it("resolves CFF2 blends to the default instance", () => {
    // Top DICT: CharStrings, FDArray, vstore (all 5-byte operands).
    const topLength = 3 * 6 + 1;
    const header = [2, 0, 5, 0, topLength];
    const global = cffIndex([], true);
    const charStringsOffset = header.length + topLength + global.length;
    // rmoveto with blended operands (2 values, 2 regions), then rlineto.
    const glyph = [...n16(100), ...n16(0), ...n16(5), ...n16(6), ...n16(7), ...n16(8), ...n16(2), 16, 21, ...n16(50), ...n16(50), 5];
    const chars = cffIndex([[], glyph], true);
    const fdArrayOffset = charStringsOffset + chars.length;
    const privateDict: number[] = [];
    const fontDictSize = 11;
    const fdArraySize = 4 + 1 + 8 + fontDictSize;
    const privateOffset = fdArrayOffset + fdArraySize;
    const fdArray = cffIndex([[...int5(privateDict.length), ...int5(privateOffset), 18]], true);
    assert.equal(fdArray.length, fdArraySize);
    const vstoreOffset = privateOffset + privateDict.length;
    // length, ItemVariationStore {format 1, region list offset, 1 data at 12},
    // ItemVariationData {0 items, 0 word deltas, 2 regions: 0, 1}.
    const vstore = [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1];
    const top = [...int5(charStringsOffset), 17, ...int5(fdArrayOffset), 12, 36, ...int5(vstoreOffset), 24];
    assert.equal(top.length, topLength);
    const cff2 = [...header, ...top, ...global, ...chars, ...fdArray, ...privateDict, ...vstore];
    const f = parseFont(buildSfnt(cffFontTables(cff2, "CFF2", 2), FLAVOR_OTTO));
    assert.equal(f.outlines, "cff");
    assert.deepEqual(f.bounds(1), { xMin: 100, yMin: 0, xMax: 150, yMax: 50 });
    assert.deepEqual(f.bounds(0), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
  });
});

describe("subsetting", () => {
  it("subsets Latin Modern (CFF): same glyph ids, same outlines, a fraction of the size", () => {
    const f = bundledFont("LMRoman", "Regular");
    assert.equal(f.outlines, "cff");
    const gids = gidsOf(f, "Typesetting office fjords with ligatures: é ü ß — 0123456789");
    const sub = f.subset(gids);
    const s = parseFont(sub);
    assert.equal(s.outlines, "cff");
    assert.equal(s.glyphCount, f.glyphCount);
    assert.equal(s.postscriptName, f.postscriptName);
    for (const g of [0, ...gids]) {
      assert.deepEqual(s.bounds(g), f.bounds(g), `bounds ${g}`);
      assert.equal(s.advance(g), f.advance(g), `advance ${g}`);
    }
    const unused = f.glyphForCodePoint(0x5a); // Z is not in the text
    assert.deepEqual(s.bounds(unused), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
    assert.ok(sub.length < f.bytes.length * 0.3, `${sub.length} of ${f.bytes.length} bytes`);
  });

  it("keeps glyph ids, advances and bounds", () => {
    const f = bundledFont("Main");
    const text = "Hello, world";
    const gids = gidsOf(f, text);
    const sub = f.subset(gids);
    const s = parseFont(sub);
    const max = Math.max(...gids);
    assert.equal(s.glyphCount, max + 1);
    assert.equal(s.unitsPerEm, f.unitsPerEm);
    assert.equal(s.postscriptName, f.postscriptName);
    assert.equal(s.familyName, f.familyName);
    assert.equal(s.ascent, f.ascent);
    assert.equal(s.descent, f.descent);
    assert.deepEqual(s.bbox, f.bbox);
    for (const g of [0, ...gids]) {
      assert.equal(s.advance(g), f.advance(g), `advance ${g}`);
      assert.deepEqual(s.bounds(g), f.bounds(g), `bounds ${g}`);
    }
    // Glyphs not asked for are empty but keep their metrics.
    const unused = f.glyphForCodePoint(cp("Q"));
    assert.ok(unused < max && !gids.includes(unused));
    assert.deepEqual(s.bounds(unused), { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
    assert.equal(s.advance(unused), f.advance(unused));
    assert.ok(sub.length < (load(bundledFontPath("Main"))!.length * 2) / 5, `subset is ${sub.length} bytes`);
  });

  it("writes valid checksums and only the tables a PDF needs", () => {
    const f = bundledFont("Main", "Bold");
    const sub = f.subset(gidsOf(f, "Typeset"));
    assertChecksumsValid(sub);
    const tags = [...directory(sub).keys()].sort();
    assert.deepEqual(tags, ["cvt ", "fpgm", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post", "prep"]);
    const dir = directory(sub);
    const head = dir.get("head")!;
    const locaFormat = u16(sub, head.offset + 50);
    const n = u16(sub, dir.get("maxp")!.offset + 4);
    assert.equal(dir.get("loca")!.length, (n + 1) * (locaFormat ? 4 : 2));
    assert.equal(u32(sub, dir.get("post")!.offset), 0x00030000);
    // Table directory is sorted and 4-byte aligned.
    for (const rec of dir.values()) assert.equal(rec.offset % 4, 0);
  });

  it("subsets every bundled font and round-trips", () => {
    for (const [family, styles] of Object.entries(BUNDLED_STYLES)) {
      for (const style of styles) {
        const f = bundledFont(family as BundledFamily, style);
        const gids = [...f.codePoints()].filter((_, i) => i % 3 === 0).map((c) => f.glyphForCodePoint(c));
        const s = parseFont(f.subset(gids));
        for (const g of gids) {
          assert.equal(s.advance(g), f.advance(g));
          assert.deepEqual(s.bounds(g), f.bounds(g));
        }
      }
    }
  });

  it("pulls in composite glyph components", () => {
    const font = parseFont(
      synthFont([
        { box: [0, 0, 500, 700] },
        { box: [10, 0, 300, 400] },
        { box: [20, 500, 200, 650] },
        { components: [1, 2] },
        { box: [0, 0, 100, 100] },
        { components: [3, 4] },
        { box: [0, 0, 50, 50] },
      ]),
    );
    const s = parseFont(font.subset([3]));
    assert.equal(s.glyphCount, 4);
    for (const g of [0, 1, 2, 3]) assert.deepEqual(s.bounds(g), font.bounds(g));
    const nested = parseFont(font.subset([5]));
    assert.equal(nested.glyphCount, 6);
    for (const g of [0, 1, 2, 3, 4, 5]) assert.deepEqual(nested.bounds(g), font.bounds(g));
  });

  it("keeps the components of accented letters in Times New Roman", { skip: !hasWin("times.ttf") }, () => {
    const b = load(winPath("times.ttf"))!;
    const f = parseFont(b);
    const eacute = f.glyphForCodePoint(0xe9);
    const sub = f.subset([eacute, ...gidsOf(f, "AV")]);
    assertChecksumsValid(sub);
    const s = parseFont(sub);
    assert.deepEqual(s.bounds(eacute), f.bounds(eacute));
    const e = f.glyphForCodePoint(cp("e"));
    assert.deepEqual(s.bounds(e), f.bounds(e), "base letter kept through the composite");
    assert.ok(sub.length < b.length / 20, `subset is ${sub.length} bytes of ${b.length}`);
  });

  it("rejects glyph ids out of range", () => {
    const f = bundledFont("Size1");
    assert.throws(() => f.subset([f.glyphCount]), FontError);
    assert.throws(() => f.subset([-1]), FontError);
    assert.throws(() => f.subset([1.5]), FontError);
  });

  it("always keeps .notdef", () => {
    const f = bundledFont("Size3");
    const s = parseFont(f.subset([]));
    assert.equal(s.glyphCount, 1);
    assert.deepEqual(s.bounds(0), f.bounds(0));
  });

  it("switches to long loca offsets when glyph data passes 128 KB", { skip: !hasWin("times.ttf") }, () => {
    const f = parseFont(load(winPath("times.ttf"))!);
    const all = Array.from({ length: f.glyphCount }, (_, i) => i);
    const sub = f.subset(all);
    const dir = directory(sub);
    assert.equal(u16(sub, dir.get("head")!.offset + 50), 1);
    assertChecksumsValid(sub);
    const s = parseFont(sub);
    for (let g = 0; g < f.glyphCount; g += 17) assert.deepEqual(s.bounds(g), f.bounds(g));
  });
});

describe("hostile input", () => {
  const isFontError = (e: unknown) => e instanceof FontError;

  it("rejects empty, tiny and random data", () => {
    assert.throws(() => parseFont(new Uint8Array(0)), isFontError);
    assert.throws(() => parseFont(new Uint8Array(3)), isFontError);
    assert.throws(() => collectionSize(new Uint8Array(2)), isFontError);
    assert.throws(() => parseFont(new TextEncoder().encode("wOFF0000000000000000")), /WOFF/);
    const rand = rng(1);
    for (let i = 0; i < 300; i++) {
      const b = new Uint8Array(Math.floor(rand() * 2000));
      for (let k = 0; k < b.length; k++) b[k] = Math.floor(rand() * 256);
      // Random data with a valid sfnt header, to get past the first check.
      if (i % 2 && b.length >= 12) b.set([0, 1, 0, 0, 0, Math.floor(rand() * 20)], 0);
      assert.throws(() => parseFont(b), isFontError);
    }
  });

  it("rejects truncated files", () => {
    const b = load(bundledFontPath("Size3"))!;
    for (const cut of [0, 1, 4, 11, 12, 40, 100, 300, 1000, b.length >> 1, b.length - 200, b.length - 8]) {
      const [, ms] = timed(() => assert.throws(() => parseFont(b.subarray(0, cut)), isFontError, `cut at ${cut}`));
      assert.ok(ms < 50);
    }
  });

  it("rejects huge declared table lengths and counts", () => {
    const b = load(bundledFontPath("Main"))!;
    assert.throws(() => parseFont(patchDirectory(b, "glyf", "length", 0x7ffffff0)), /glyf/);
    assert.throws(() => parseFont(patchDirectory(b, "hmtx", "offset", 0xfffffff0)), /hmtx/);
    const many = new Uint8Array(b);
    many[4] = 0xff;
    many[5] = 0xff;
    assert.throws(() => parseFont(many), isFontError);
    const ttc = new Uint8Array(16);
    ttc.set([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    assert.throws(() => collectionSize(ttc), isFontError);
    assert.throws(() => parseFont(ttc), isFontError);
    // hmtx too short for numberOfHMetrics
    assert.throws(() => parseFont(patchDirectory(b, "hmtx", "length", 8)), /hmtx/);
  });

  it("throws on cyclic or runaway composite glyphs, quickly", () => {
    const cyclic = parseFont(synthFont([{ box: [0, 0, 1, 1] }, { components: [2] }, { components: [1] }]));
    const [, ms] = timed(() => assert.throws(() => cyclic.subset([1]), (e: unknown) => isFontError(e) && /cycle|itself/.test((e as Error).message)));
    assert.ok(ms < 50);
    const self = parseFont(synthFont([{ box: [0, 0, 1, 1] }, { components: [1] }]));
    assert.throws(() => self.subset([1]), isFontError);
    const outOfRange = parseFont(synthFont([{ box: [0, 0, 1, 1] }, { components: [7] }]));
    assert.throws(() => outOfRange.subset([1]), /out of range/);
    const deep: SynthGlyph[] = [{ box: [0, 0, 1, 1] }];
    for (let i = 1; i < 100; i++) deep.push({ components: [i + 1 < 100 ? i + 1 : 0] });
    assert.throws(() => parseFont(synthFont(deep)).subset([1]), /nested/);
  });

  it("bounds hostile cmap iteration", () => {
    // 2,000 groups that each claim the whole code space.
    const map: [number, number][] = [];
    for (let i = 0; i < 2000; i++) map.push([0, 1]);
    const sub = new Uint8Array(16 + 12 * map.length);
    const v = new DataView(sub.buffer);
    v.setUint16(0, 12);
    v.setUint32(12, map.length);
    for (let i = 0; i < map.length; i++) {
      v.setUint32(16 + 12 * i, 0);
      v.setUint32(20 + 12 * i, 0xffffffff);
      v.setUint32(24 + 12 * i, 1);
    }
    const font = parseFont(synthFont([{}, { box: [0, 0, 1, 1] }, { box: [0, 0, 1, 1] }], [{ tag: "cmap", data: cmapWrap(sub, [3, 10]) }]));
    const [count, ms] = timed(() => {
      let n = 0;
      for (const _ of font.codePoints()) n++;
      return n;
    });
    assert.ok(count <= 0x110000);
    assert.ok(ms < 3000, `${ms} ms`);
  });

  it("ignores a corrupt GPOS or GSUB instead of failing layout", () => {
    const junk = new Uint8Array(64);
    junk.set([0, 1, 0, 0, 0xff, 0xf0, 0xff, 0xf0, 0xff, 0xf0]);
    const font = parseFont(synthFont([{}, { box: [0, 0, 1, 1] }, { box: [0, 0, 1, 1] }], [
      { tag: "GPOS", data: junk },
      { tag: "GSUB", data: junk },
      { tag: "kern", data: junk },
    ]));
    assert.equal(font.kerning(1, 2), 0);
    assert.deepEqual(font.ligatures([1, 2]), [1, 2]);
    assert.ok(font.warnings.length >= 2, font.warnings.join("; "));
  });

  it("survives random corruption of real fonts with only FontError", () => {
    const sources = [bundledFontPath("Main"), bundledFontPath("Size1"), bundledFontPath("AMS")].map((p) => load(p)!);
    if (existsSync(LIBERATION)) sources.push(load(LIBERATION)!);
    const rand = rng(42);
    const t0 = performance.now();
    let parsed = 0;
    for (let i = 0; i < 400; i++) {
      const src = sources[i % sources.length];
      const b = new Uint8Array(src);
      const flips = 1 + Math.floor(rand() * 20);
      for (let k = 0; k < flips; k++) {
        // Half the damage lands in the header and table directory.
        const at = rand() < 0.5 ? Math.floor(rand() * Math.min(b.length, 12 + 16 * 20)) : Math.floor(rand() * b.length);
        b[at] = Math.floor(rand() * 256);
      }
      expectFontErrorOrSuccess(() => {
        const font = parseFont(b);
        parsed++;
        exercise(font);
      });
    }
    const ms = performance.now() - t0;
    assert.ok(parsed > 50, `only ${parsed} corrupted fonts parsed at all`);
    assert.ok(ms < 20000, `${ms} ms`);
  });

  it("survives corrupted subtables in a font with GPOS and GSUB", { skip: !hasWin("calibri.ttf") }, () => {
    const src = load(winPath("calibri.ttf"))!;
    const dir = directory(src);
    const rand = rng(7);
    for (let i = 0; i < 60; i++) {
      const b = new Uint8Array(src);
      for (const t of ["GPOS", "GSUB", "cmap", "post", "kern"]) {
        const rec = dir.get(t);
        if (!rec) continue;
        for (let k = 0; k < 30; k++) b[rec.offset + Math.floor(rand() * Math.min(rec.length, 4096))] = Math.floor(rand() * 256);
      }
      expectFontErrorOrSuccess(() => {
        const font = parseFont(b);
        exercise(font);
        font.ligatures(gidsOf(font, "office affluent"));
        const [A, V] = gidsOf(font, "AV");
        font.kerning(A, V);
      });
    }
  });
});

describe("collections and licensing", () => {
  it("indexes a collection built from bundled fonts", () => {
    const main = load(bundledFontPath("Main"))!;
    const math = load(bundledFontPath("Math", "Italic"))!;
    const ttc = makeTtc([main, math]);
    assert.equal(collectionSize(ttc), 2);
    assert.equal(collectionSize(main), 1);
    const a = parseFont(ttc);
    const b = parseFont(ttc, 1);
    assert.equal(a.familyName, "KaTeX_Main");
    assert.equal(b.familyName, "KaTeX_Math");
    assert.equal(b.collectionIndex, 1);
    assert.throws(() => parseFont(ttc, 2), /out of range/);
    assert.throws(() => parseFont(main, 1), FontError);
    const g = b.glyphForCodePoint(0x3b1); // alpha
    assert.ok(g > 0);
    assert.deepEqual(b.bounds(g), bundledFont("Math").bounds(g));
    const own = b.bytes;
    assert.equal(collectionSize(own), 1);
    assertChecksumsValid(own);
    assert.equal(parseFont(own).postscriptName, "KaTeX_Math-Italic");
    assert.equal(a.bytes.length > 0 && parseFont(a.bytes).glyphCount, a.glyphCount);
    const sub = parseFont(b.subset([g]));
    assert.deepEqual(sub.bounds(g), b.bounds(g));
  });

  it("reads fsType embedding permissions", () => {
    const main = load(bundledFontPath("Main"))!;
    assert.equal(parseFont(withFsType(main, 0x0000)).embeddingAllowed, true);
    assert.equal(parseFont(withFsType(main, 0x0002)).embeddingAllowed, false, "restricted licence");
    assert.equal(parseFont(withFsType(main, 0x0004)).embeddingAllowed, true, "preview and print");
    assert.equal(parseFont(withFsType(main, 0x0008)).embeddingAllowed, true, "editable");
    assert.equal(parseFont(withFsType(main, 0x000a)).embeddingAllowed, true, "least restrictive bit wins");
    assert.equal(parseFont(withFsType(main, 0x0200)).embeddingAllowed, false, "bitmap embedding only");
    assert.equal(parseFont(withFsType(main, 0x0100)).subsettingAllowed, false);
    assert.equal(parseFont(main).subsettingAllowed, true);
  });
});

describe("system font discovery", () => {
  it("skips junk, restricted fonts and non-font files in a font folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "texwright-fonts-"));
    try {
      const main = load(bundledFontPath("Main"))!;
      mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
      writeFileSync(join(dir, "nested", "deeper", "good.ttf"), main);
      writeFileSync(join(dir, "restricted.ttf"), withFsType(load(bundledFontPath("Main", "Bold"))!, 0x0002));
      writeFileSync(join(dir, "truncated.ttf"), main.subarray(0, 500));
      writeFileSync(join(dir, "empty.otf"), new Uint8Array(0));
      const junk = new Uint8Array(4096);
      const rand = rng(3);
      for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rand() * 256);
      junk.set([0, 1, 0, 0, 0, 8], 0);
      writeFileSync(join(dir, "junk.ttc"), junk);
      writeFileSync(join(dir, "collection.TTC"), makeTtc([load(bundledFontPath("AMS"))!, load(bundledFontPath("Size1"))!]));
      writeFileSync(join(dir, "notes.txt"), "not a font");
      setSystemFontDirs([dir]);
      const files = systemFontFiles();
      assert.equal(files.length, 6, files.join(", "));
      const faces = systemFonts();
      assert.deepEqual(faces.map((f) => f.postscriptName).sort(), ["KaTeX_AMS-Regular", "KaTeX_Main-Regular", "KaTeX_Size1-Regular"]);
      const f = fallbackFor(0x41, { bold: true });
      assert.ok(f && f.glyphForCodePoint(0x41) > 0);
      assert.notEqual(f!.postscriptName, "KaTeX_Main-Bold", "the restricted bold face is never used");
      assert.equal(fallbackFor(0x4e2d), undefined);
      assert.equal(findSystemFont("katex_size1")?.postscriptName, "KaTeX_Size1-Regular");
    } finally {
      setSystemFontDirs(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds bundled fonts when pointed at fonts/", () => {
    const files = systemFontFiles([fontsDir()]);
    assert.equal(files.length, 25);
    assert.equal(files.filter((f) => f.endsWith(".ttf")).length, 20);
    assert.equal(files.filter((f) => f.endsWith(".otf")).length, 5);
  });

  it("falls back within a configured folder", () => {
    try {
      setSystemFontDirs([fontsDir()]);
      const faces = systemFonts();
      assert.equal(faces.length, 25);
      const f = fallbackFor(0x2211); // n-ary summation
      assert.ok(f, "some KaTeX font has U+2211");
      assert.ok(f!.glyphForCodePoint(0x2211) > 0);
      const bb = fallbackFor(0x1d538); // double-struck A is not in KaTeX's cmaps
      assert.equal(bb, undefined);
      const bold = fallbackFor(0x41, { bold: true });
      assert.ok(bold && bold.glyphForCodePoint(0x41) > 0);
      assert.equal(bold!.bold, true);
    } finally {
      setSystemFontDirs(undefined);
    }
  });

  it("lists installed fonts", { skip: !existsSync(WIN) }, () => {
    const files = systemFontFiles();
    assert.ok(files.length > 10);
    assert.ok(files.some((f) => /times\.ttf$/i.test(f)));
    assert.ok(files.every((f) => /\.(ttf|otf|ttc)$/i.test(f)));
  });

  it("finds fallback fonts for CJK, symbols and Latin", { skip: !hasWin("msyh.ttc") }, (t) => {
    const [cjk, first] = timed(() => fallbackFor(cp("中")));
    assert.ok(cjk);
    assert.ok(cjk!.glyphForCodePoint(cp("中")) > 0);
    assert.ok(cjk!.embeddingAllowed);
    const [again, second] = timed(() => fallbackFor(cp("文")));
    t.diagnostic(`first fallback query ${first.toFixed(0)} ms (builds the index), next ${second.toFixed(2)} ms`);
    assert.equal(again, cjk, "same block, same font");
    assert.ok(second < 20);
    const latin = fallbackFor(0x41);
    assert.ok(latin && latin.glyphForCodePoint(0x41) > 0);
    assert.equal(latin!.serif, true);
    const sans = fallbackFor(0x41, { serif: false });
    assert.ok(sans && sans.serif !== true);
    const arrow = fallbackFor(0x21d2);
    assert.ok(arrow && arrow.glyphForCodePoint(0x21d2) > 0);
    assert.equal(fallbackFor(0x2fffe), undefined, "noncharacter");
    assert.equal(fallbackFor(-5), undefined);
    for (const face of systemFonts()) assert.ok(face.family.length > 0);
  });

  it("finds a family by name", { skip: !hasWin("timesbd.ttf") }, () => {
    const bold = findSystemFont("times new roman", { bold: true });
    assert.ok(bold);
    assert.equal(bold!.familyName, "Times New Roman");
    assert.equal(bold!.bold, true);
    assert.equal(findSystemFont("No Such Family 12345"), undefined);
  });
});
