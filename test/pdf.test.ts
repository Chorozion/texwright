import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { type Font, bundledFont, parseFont } from "../src/font/index.js";
import { cffGlyphCids } from "../src/pdf/cff.js";
import { widthArray } from "../src/pdf/fonts.js";
import { num, pdfName, sanitizeFontName, textString } from "../src/pdf/serialize.js";
import { toUnicodeCMap } from "../src/pdf/tounicode.js";
import { PdfError, type PdfWriter, createPdfWriter } from "../src/pdf/writer.js";
import type { Gradient, PathCommand } from "../src/layout/types.js";

// ===========================================================================
// Reading PDFs back without pdf.js: the xref table, objects and streams.

interface PdfObject {
  num: number;
  offset: number;
  /** The object's text up to "stream" or "endobj" (dictionary or other value). */
  body: string;
  /** Decoded stream data (Flate undone; other filters left alone). */
  data?: Buffer;
  /** Raw stream bytes as stored. */
  raw?: Buffer;
}

interface ParsedPdf {
  objects: Map<number, PdfObject>;
  trailer: string;
  root: PdfObject;
  info: PdfObject;
}

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

/** Parses the cross-reference table and checks every offset points at "N 0 obj". */
function parsePdf(bytes: Uint8Array): ParsedPdf {
  const text = latin1(bytes);
  assert.ok(text.startsWith("%PDF-1.7\n%"), "header");
  const bin = bytes.subarray(10, 14);
  assert.ok([...bin].every((b) => b >= 128), "binary comment has four high bytes");
  assert.ok(text.endsWith("%%EOF\n"), "ends with %%EOF");
  const sx = text.lastIndexOf("startxref\n");
  assert.ok(sx > 0, "startxref present");
  const xrefAt = Number(text.slice(sx + 10).split("\n")[0]);
  assert.equal(text.slice(xrefAt, xrefAt + 5), "xref\n", "startxref points at the xref table");
  const lines = text.slice(xrefAt).split("\n");
  const [first, count] = lines[1].split(" ").map(Number);
  assert.equal(first, 0);
  // Entries are exactly 20 bytes each.
  const entriesStart = xrefAt + 5 + lines[1].length + 1;
  const objects = new Map<number, PdfObject>();
  for (let i = 0; i < count; i++) {
    const e = text.slice(entriesStart + 20 * i, entriesStart + 20 * (i + 1));
    assert.match(e, /^\d{10} \d{5} [nf]\r\n$/, `xref entry ${i}`);
    if (i === 0) {
      assert.equal(e, "0000000000 65535 f\r\n");
      continue;
    }
    const offset = Number(e.slice(0, 10));
    const head = `${i} 0 obj\n`;
    assert.equal(text.slice(offset, offset + head.length), head, `xref offset of object ${i}`);
    const start = offset + head.length;
    const endobj = text.indexOf("\nendobj\n", start);
    const streamAt = text.indexOf(">>\nstream\n", start);
    const obj: PdfObject = { num: i, offset, body: "" };
    if (streamAt >= 0 && streamAt < endobj) {
      obj.body = text.slice(start, streamAt + 2);
      const len = Number(/\/Length (\d+)/.exec(obj.body)![1]);
      const dataAt = streamAt + 10;
      obj.raw = Buffer.from(bytes.subarray(dataAt, dataAt + len));
      assert.equal(text.slice(dataAt + len, dataAt + len + 18), "\nendstream\nendobj\n", `stream length of object ${i}`);
      obj.data = /\/Filter \/FlateDecode/.test(obj.body) ? zlib.inflateSync(obj.raw) : obj.raw;
    } else {
      obj.body = text.slice(start, endobj);
    }
    objects.set(i, obj);
  }
  const trailerAt = text.indexOf("trailer\n", xrefAt);
  assert.equal(trailerAt, entriesStart + 20 * count, "trailer follows the xref entries");
  const trailer = text.slice(trailerAt, sx);
  assert.match(trailer, new RegExp(`/Size ${count} `));
  const ids = /\/ID \[<([0-9A-F]{32})> <([0-9A-F]{32})>\]/.exec(trailer);
  assert.ok(ids, "trailer /ID with two MD5 strings");
  assert.equal(ids![1], ids![2], "both /ID entries are equal");
  const rootNum = Number(/\/Root (\d+) 0 R/.exec(trailer)![1]);
  const infoNum = Number(/\/Info (\d+) 0 R/.exec(trailer)![1]);
  return { objects, trailer, root: objects.get(rootNum)!, info: objects.get(infoNum)! };
}

function refOf(body: string, key: string): number | undefined {
  const m = new RegExp(`/${key} (\\d+) 0 R`).exec(body);
  return m ? Number(m[1]) : undefined;
}

function getRef(pdf: ParsedPdf, body: string, key: string): PdfObject {
  const n = refOf(body, key);
  assert.ok(n !== undefined, `/${key} reference in ${body.slice(0, 120)}`);
  return pdf.objects.get(n!)!;
}

/** Page objects in order. */
function pageObjects(pdf: ParsedPdf): PdfObject[] {
  const pages = getRef(pdf, pdf.root.body, "Pages");
  const kids = /\/Kids \[([^\]]*)\]/.exec(pages.body)![1];
  return [...kids.matchAll(/(\d+) 0 R/g)].map((m) => pdf.objects.get(Number(m[1]))!);
}

function objectsWith(pdf: ParsedPdf, re: RegExp): PdfObject[] {
  return [...pdf.objects.values()].filter((o) => re.test(o.body));
}

// ===========================================================================
// Producing documents: every finished PDF is structure-checked and kept for
// the PyMuPDF pass at the end.

const produced: { name: string; bytes: Uint8Array }[] = [];
/** Text MuPDF must extract from a produced PDF (whitespace-normalized). */
const expectText = new Map<string, string>();

function finish(w: PdfWriter, name: string, text?: string): Uint8Array {
  const bytes = w.finish();
  parsePdf(bytes);
  produced.push({ name, bytes });
  if (text !== undefined) expectText.set(name, text);
  return bytes;
}

const DATE = new Date(Date.UTC(2026, 9, 7, 12, 30, 45));

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

async function open(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isOffscreenCanvasSupported: false, useSystemFonts: false }).promise;
}

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  eol: boolean;
}

async function items(doc: PdfDoc, pageNo = 1): Promise<Item[]> {
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  const out: Item[] = [];
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    out.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, eol: it.hasEOL });
  }
  return out;
}

async function pageText(doc: PdfDoc, pageNo = 1): Promise<string> {
  return (await items(doc, pageNo)).map((i) => i.str + (i.eol ? "\n" : "")).join("");
}

// ===========================================================================
// Fonts

function loadFile(path: string): Uint8Array | undefined {
  if (!existsSync(path)) return undefined;
  const b = readFileSync(path);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function systemFont(name: string, index = 0): Font | undefined {
  const bytes = loadFile(join("C:/Windows/Fonts", name));
  if (!bytes) return undefined;
  try {
    const f = parseFont(bytes, index);
    return f.embeddingAllowed ? f : undefined;
  } catch {
    return undefined;
  }
}

const main = bundledFont("Main");
const arial = systemFont("arial.ttf");
const calibri = systemFont("calibri.ttf");
const emojiFont = systemFont("seguiemj.ttf");
const cjkFont = systemFont("msyh.ttc") ?? systemFont("simsun.ttc");
const KATEX_OTF = join(process.cwd(), "node_modules", "katex", "src", "fonts", "lib", "Extra.otf");

interface Run {
  gids: number[];
  advances: number[];
  text: string[];
}

/** Shapes a string: cmap, standard ligatures, pair kerning folded into the advances. */
function shape(font: Font, str: string, size: number, opts: { liga?: boolean; kern?: boolean } = {}): Run {
  const cps = [...str];
  let gids = cps.map((c) => font.glyphForCodePoint(c.codePointAt(0)!));
  let counts = gids.map(() => 1);
  if (opts.liga !== false) {
    const r = font.ligatureClusters(gids);
    gids = r.glyphs;
    counts = r.counts;
  }
  const text: string[] = [];
  let k = 0;
  for (const c of counts) {
    text.push(cps.slice(k, k + c).join(""));
    k += c;
  }
  const advances = gids.map(
    (g, i) => ((font.advance(g) + (opts.kern !== false && i + 1 < gids.length ? font.kerning(g, gids[i + 1]) : 0)) * size) / font.unitsPerEm,
  );
  return { gids, advances, text };
}

function draw(page: ReturnType<PdfWriter["addPage"]>, font: Font, size: number, x: number, y: number, str: string, color?: [number, number, number]) {
  const r = shape(font, str, size);
  page.glyphs(font, size, x, y, r.gids, r.advances, r.text, color);
  return r;
}

/** A copy of a TrueType font with OS/2 fsType replaced. */
function withFsType(bytes: Uint8Array, fsType: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const v = new DataView(copy.buffer);
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i;
    if (String.fromCharCode(copy[p], copy[p + 1], copy[p + 2], copy[p + 3]) === "OS/2") {
      v.setUint16(v.getUint32(p + 8) + 8, fsType);
      return copy;
    }
  }
  throw new Error("no OS/2 table");
}

// ===========================================================================
// PNG and JPEG test images, generated here.

const crc32: (b: Uint8Array) => number =
  typeof (zlib as { crc32?: unknown }).crc32 === "function"
    ? (b) => zlib.crc32(b)
    : (b) => {
        let c = 0xffffffff;
        for (const x of b) {
          c ^= x;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return (c ^ 0xffffffff) >>> 0;
      };

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface PngSpec {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  depth: 1 | 2 | 4 | 8 | 16;
  interlace?: boolean;
  palette?: number[][];
  trns?: number[];
  /** Raw samples (at the PNG's bit depth) of pixel (x, y). */
  sample: (x: number, y: number) => number[];
}

function ihdr(w: number, h: number, depth: number, colorType: number, interlace = 0): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = depth;
  d[9] = colorType;
  d[12] = interlace;
  return pngChunk("IHDR", d);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes a PNG, cycling through all five row filters and splitting the data over two IDAT chunks. */
function encodePng(spec: PngSpec): Uint8Array {
  const { width, height, colorType, depth } = spec;
  const channels = CHANNELS[colorType];
  const bitsPP = channels * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const passes = spec.interlace ? ADAM7 : [[0, 0, 1, 1]];
  const out: number[] = [];
  let rowIndex = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (!w || !h) continue;
    const rowBytes = Math.ceil((w * bitsPP) / 8);
    let prev: Uint8Array | undefined;
    for (let r = 0; r < h; r++) {
      const raw = new Uint8Array(rowBytes);
      let bit = 0;
      for (let c = 0; c < w; c++) {
        for (const v of spec.sample(x0 + c * dx, y0 + r * dy)) {
          if (depth === 16) {
            raw[bit >> 3] = v >> 8;
            raw[(bit >> 3) + 1] = v & 255;
          } else if (depth === 8) raw[bit >> 3] = v;
          else raw[bit >> 3] |= v << (8 - depth - (bit & 7));
          bit += depth;
        }
      }
      const filter = rowIndex++ % 5;
      out.push(filter);
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? raw[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (filter === 1) pred = a;
        else if (filter === 2) pred = b;
        else if (filter === 3) pred = (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out.push((raw[i] - pred) & 255);
      }
      prev = raw;
    }
  }
  const z = zlib.deflateSync(Uint8Array.from(out));
  const half = z.length >> 1;
  const parts = [PNG_SIG, ihdr(width, height, depth, colorType, spec.interlace ? 1 : 0)];
  if (spec.palette) parts.push(pngChunk("PLTE", Uint8Array.from(spec.palette.flat())));
  if (spec.trns) parts.push(pngChunk("tRNS", Uint8Array.from(spec.trns)));
  parts.push(pngChunk("tEXt", Buffer.from("Comment\0texwright test", "latin1")));
  parts.push(pngChunk("IDAT", z.subarray(0, half)), pngChunk("IDAT", z.subarray(half)), pngChunk("IEND", new Uint8Array(0)));
  return new Uint8Array(Buffer.concat(parts));
}

/** What the writer should produce: 8-bit colour samples and alpha (undefined when opaque). */
function expectedPixels(spec: PngSpec): { pixels: number[]; alpha?: number[] } {
  const { width, height, colorType, depth } = spec;
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth < 8 && colorType !== 3 ? Math.round((v * 255) / ((1 << depth) - 1)) : v);
  const pixels: number[] = [];
  const alpha: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = spec.sample(x, y);
      let a = 255;
      if (colorType === 0) {
        pixels.push(to8(s[0]));
        if (spec.trns && s[0] === ((spec.trns[0] << 8) | spec.trns[1])) a = 0;
      } else if (colorType === 2) {
        pixels.push(to8(s[0]), to8(s[1]), to8(s[2]));
        const t = spec.trns;
        if (t && s[0] === ((t[0] << 8) | t[1]) && s[1] === ((t[2] << 8) | t[3]) && s[2] === ((t[4] << 8) | t[5])) a = 0;
      } else if (colorType === 3) {
        pixels.push(s[0]);
        if (spec.trns && s[0] < spec.trns.length) a = spec.trns[s[0]];
      } else if (colorType === 4) {
        pixels.push(to8(s[0]));
        a = to8(s[1]);
      } else {
        pixels.push(to8(s[0]), to8(s[1]), to8(s[2]));
        a = to8(s[3]);
      }
      alpha.push(a);
    }
  }
  return { pixels, alpha: alpha.every((a) => a === 255) ? undefined : alpha };
}

/** Deterministic pseudo-random integers. */
function hash(x: number, y: number, c: number): number {
  let h = (x * 374761393 + y * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Undoes /Predictor 15 (PNG row filters) on decoded stream data. */
function unpredict(data: Buffer, colors: number, columns: number): Uint8Array {
  const rowBytes = colors * columns;
  const rows = data.length / (rowBytes + 1);
  assert.ok(Number.isInteger(rows), "predicted data is whole rows");
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (rowBytes + 1)];
    for (let i = 0; i < rowBytes; i++) {
      const x = data[r * (rowBytes + 1) + 1 + i];
      const a = i >= colors ? out[r * rowBytes + i - colors] : 0;
      const b = r > 0 ? out[(r - 1) * rowBytes + i] : 0;
      const c = r > 0 && i >= colors ? out[(r - 1) * rowBytes + i - colors] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(f, 0, "row filter");
      out[r * rowBytes + i] = (x + pred) & 255;
    }
  }
  return out;
}

/** An image XObject's samples, predictor undone. */
function imageSamples(obj: PdfObject): Uint8Array {
  const parms = /\/DecodeParms << \/Predictor 15 \/Colors (\d+) \/Columns (\d+) >>/.exec(obj.body);
  return parms ? unpredict(obj.data!, Number(parms[1]), Number(parms[2])) : new Uint8Array(obj.data!);
}

/** A minimal baseline (or progressive) JPEG of one 8x8 block per component, every sample 128. */
function tinyJpeg(opts: { components?: 1 | 3 | 4; progressive?: boolean; adobe?: boolean; width?: number; height?: number; precision?: number } = {}): Uint8Array {
  const nc = opts.components ?? 1;
  const w = opts.width ?? 8;
  const h = opts.height ?? 8;
  const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
  const bytes: number[] = [0xff, 0xd8];
  if (opts.adobe) bytes.push(...seg(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]));
  bytes.push(...seg(0xdb, [0, ...new Array(64).fill(1)]));
  const comps: number[] = [];
  for (let c = 1; c <= nc; c++) comps.push(c, 0x11, 0);
  bytes.push(...seg(opts.progressive ? 0xc2 : 0xc0, [opts.precision ?? 8, h >> 8, h & 255, w >> 8, w & 255, nc, ...comps]));
  const huff = (cls: number) => seg(0xc4, [cls, 1, ...new Array(15).fill(0), 0]);
  const scanComps: number[] = [];
  for (let c = 1; c <= nc; c++) scanComps.push(c, 0);
  if (!opts.progressive) {
    bytes.push(...huff(0x00), ...huff(0x10));
    bytes.push(...seg(0xda, [nc, ...scanComps, 0, 63, 0]));
    // Per block: DC difference category 0 ("0") and end of block ("0"); padded with ones.
    const bits = "00".repeat(nc);
    const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "1");
    for (let i = 0; i < padded.length; i += 8) bytes.push(parseInt(padded.slice(i, i + 8), 2));
  } else {
    bytes.push(...huff(0x00));
    bytes.push(...seg(0xda, [nc, ...scanComps, 0, 0, 0]));
    const bits = "0".repeat(nc);
    const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "1");
    for (let i = 0; i < padded.length; i += 8) bytes.push(parseInt(padded.slice(i, i + 8), 2));
    bytes.push(...huff(0x10));
    for (let c = 1; c <= nc; c++) {
      bytes.push(...seg(0xda, [1, c, 0, 1, 63, 0]));
      bytes.push(0x7f); // end-of-band run of one
    }
  }
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}

function findJpeg(dir: string, depth = 0): string | undefined {
  if (depth > 3 || !existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && /\.jpe?g$/i.test(e.name)) return p;
    if (e.isDirectory()) {
      const f = findJpeg(p, depth + 1);
      if (f) return f;
    }
  }
  return undefined;
}

/** pdf.js's decoded images on page 1: [{width, height, kind, data}] in drawing order. */
async function decodedImages(doc: PdfDoc, pageNo = 1): Promise<{ width: number; height: number; kind: number; data: Uint8ClampedArray | Uint8Array }[]> {
  const page = await doc.getPage(pageNo);
  const ops = await page.getOperatorList();
  const out = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
    const id = ops.argsArray[i][0] as string;
    const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
    const img = await new Promise<{ width: number; height: number; kind: number; data: Uint8Array }>((resolve) => objs.get(id, resolve));
    out.push(img);
  }
  return out;
}

function expectPdfError(fn: () => unknown, re?: RegExp, maxMs = 250): void {
  const t0 = performance.now();
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PdfError, `expected PdfError, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    if (re) assert.match((e as Error).message, re);
    return true;
  });
  const ms = performance.now() - t0;
  assert.ok(ms < maxMs, `took ${ms.toFixed(1)} ms`);
}

// ===========================================================================

describe("PDF primitives", () => {
  it("writes numbers compactly: four decimals at most, no exponents, no -0", () => {
    assert.equal(num(0), "0");
    assert.equal(num(-0), "0");
    assert.equal(num(12), "12");
    assert.equal(num(-3), "-3");
    assert.equal(num(1.5), "1.5");
    assert.equal(num(1.23456), "1.2346");
    assert.equal(num(-0.00004), "0");
    assert.equal(num(0.00005 + 1e-12), "0.0001");
    assert.equal(num(1e-7), "0");
    assert.equal(num(123456789.123), "123456789.123");
    assert.equal(num(2.5e15), "2500000000000000");
    assert.equal(num(-1e25), "-100000000000000000000");
    assert.throws(() => num(NaN), PdfError);
    assert.throws(() => num(Infinity), PdfError);
  });

  it("escapes names and strings", () => {
    assert.equal(pdfName("F1"), "/F1");
    assert.equal(pdfName("A B#(x)"), "/A#20B#23#28x#29");
    assert.equal(pdfName("é"), "/#C3#A9");
    assert.equal(sanitizeFontName("Times New Roman (Bold)/X"), "TimesNewRomanBoldX");
    assert.equal(sanitizeFontName("\u00e9\u00e8"), "Font");
    assert.equal(sanitizeFontName("x".repeat(100)).length, 63);
    assert.equal(textString("a (b) \\c"), "(a \\(b\\) \\\\c)");
    assert.equal(textString("é😀"), "<FEFF00E9D83DDE00>");
    assert.equal(textString("a\ud800b"), "<FEFF0061FFFD0062>", "lone surrogates are replaced");
  });

  it("writes /W arrays in compact range form", () => {
    const w = new Map<number, number>([
      [3, 250],
      [4, 300],
      [10, 500],
      [11, 500],
      [12, 500],
      [13, 500],
      [14, 600],
      [20, 722.5],
    ]);
    assert.equal(widthArray(w), "[3 [250 300] 10 13 500 14 [600] 20 [722.5]]");
    assert.equal(widthArray(new Map([[5, 1], [6, 1], [7, 2], [8, 3], [9, 3], [10, 3]])), "[5 [1 1 2] 8 10 3]");
    assert.equal(widthArray(new Map()), "[]");
  });

  it("builds ToUnicode CMaps with bfchar, bfrange and surrogate pairs", () => {
    const m = new Map<number, string>();
    for (let i = 0; i < 5; i++) m.set(0x24 + i, String.fromCharCode(0x41 + i)); // A..E: a range
    m.set(0x100, "ffi");
    m.set(0x200, "😀");
    m.set(0x300, "");
    m.set(0x2fe, "x");
    m.set(0x2ff, "y");
    const cmap = toUnicodeCMap(m);
    assert.match(cmap, /1 beginbfrange\n<0024> <0028> <0041>\nendbfrange/);
    assert.match(cmap, /<0100> <006600660069>/);
    assert.match(cmap, /<0200> <D83DDE00>/);
    assert.match(cmap, /<02FE> <0078>\n<02FF> <0079>/);
    assert.doesNotMatch(cmap, /<0300>/, "glyphs without text are not mapped");
    assert.match(cmap, /begincodespacerange\n<0000> <FFFF>\nendcodespacerange/);
    // Ranges never cross a 256-code row on either side.
    const m2 = new Map<number, string>();
    for (let i = 0xfd; i <= 0x102; i++) m2.set(i, String.fromCharCode(0x41 + i));
    const c2 = toUnicodeCMap(m2);
    for (const r of c2.matchAll(/<([0-9A-F]{4})> <([0-9A-F]{4})> <([0-9A-F]{4})>/g)) {
      assert.equal(parseInt(r[1], 16) >> 8, parseInt(r[2], 16) >> 8);
    }
    // At most 100 entries per block.
    const big = new Map<number, string>();
    for (let i = 0; i < 250; i++) big.set(i * 2, String.fromCharCode(0x4e00 + i * 3));
    const blocks = [...toUnicodeCMap(big).matchAll(/(\d+) beginbfchar/g)].map((x) => Number(x[1]));
    assert.deepEqual(blocks, [100, 100, 50]);
  });

  it("maps glyph ids to CIDs through a CID-keyed CFF charset", () => {
    // A synthetic CFF: header, Name INDEX, Top DICT INDEX (ROS, charset, CharStrings), empty String and Subr INDEXes.
    const build = (charset: number[]) => {
      const enc = (v: number) => [29, (v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
      const dictFor = (csOff: number, chOff: number) => [...enc(0), ...enc(0), ...enc(0), 12, 30, ...enc(chOff), 15, ...enc(csOff), 17];
      const header = [1, 0, 4, 1];
      const nameIndex = [0, 1, 1, 1, 2, 0x41];
      const dictLen = dictFor(0, 0).length;
      const topIndexLen = 2 + 1 + 2 + dictLen;
      const afterTop = header.length + nameIndex.length + topIndexLen;
      const strings = [0, 0];
      const gsubrs = [0, 0];
      const charsetOff = afterTop + strings.length + gsubrs.length;
      const csOff = charsetOff + charset.length;
      const charStrings = [0, 4, 1, 1, 2, 3, 4, 5, 14, 14, 14, 14]; // 4 glyphs of one byte (endchar)
      const top = [0, 1, 1, 1, 1 + dictLen, ...dictFor(csOff, charsetOff)];
      return Uint8Array.from([...header, ...nameIndex, ...top, ...strings, ...gsubrs, ...charset, ...charStrings]);
    };
    assert.deepEqual([...cffGlyphCids(build([0, 0, 10, 0, 20, 0, 30]))!], [0, 10, 20, 30], "format 0");
    assert.deepEqual([...cffGlyphCids(build([1, 0, 100, 2]))!], [0, 100, 101, 102], "format 1");
    assert.deepEqual([...cffGlyphCids(build([2, 0, 7, 0, 0, 0, 50, 0, 1]))!], [0, 7, 50, 51], "format 2");
    assert.throws(() => cffGlyphCids(Uint8Array.from([1, 0, 4, 1, 0, 5])), /malformed CFF/);
    const otf = loadFile(KATEX_OTF);
    if (otf) {
      const f = parseFont(otf);
      assert.equal(cffGlyphCids(f.table("CFF ")!), undefined, "a name-keyed CFF uses glyph ids as CIDs");
    }
  });
});

describe("file structure", () => {
  it("writes a header, objects, a correct xref table and a trailer with /Root, /Info and /ID", () => {
    const w = createPdfWriter();
    const page = w.addPage(200, 100);
    draw(page, main, 12, 10, 50, "xref");
    w.setInfo({ date: DATE });
    const bytes = finish(w, "structure");
    const pdf = parsePdf(bytes);
    assert.match(pdf.root.body, /\/Type \/Catalog/);
    assert.match(pdf.info.body, /\/Producer \(texwright\)/);
    const text = latin1(bytes);
    assert.match(text, /trailer\n<< \/Size \d+ \/Root 1 0 R \/Info 3 0 R \/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\] >>\nstartxref\n\d+\n%%EOF\n$/);
    // The /ID is the MD5 of everything before the trailer.
    const id = /\/ID \[<([0-9A-F]{32})>/.exec(text)![1];
    const before = bytes.subarray(0, text.indexOf("trailer\n"));
    assert.equal(id, createHash("md5").update(before).digest("hex").toUpperCase());
  });

  it("compresses content streams and fonts with FlateDecode unless asked not to", () => {
    const build = (compress: boolean) => {
      const w = createPdfWriter({ compress });
      draw(w.addPage(100, 100), main, 10, 10, 10, "flate");
      w.setInfo({ date: DATE });
      return finish(w, `compress-${compress}`);
    };
    const packed = parsePdf(build(true));
    const plain = parsePdf(build(false));
    const contentOf = (p: ParsedPdf) => getRef(p, pageObjects(p)[0].body, "Contents");
    assert.match(contentOf(packed).body, /\/Filter \/FlateDecode/);
    assert.doesNotMatch(contentOf(plain).body, /\/Filter/);
    assert.equal(contentOf(packed).data!.toString("latin1"), contentOf(plain).data!.toString("latin1"));
    assert.match(contentOf(plain).raw!.toString("latin1"), /^BT\n\/F1 10 Tf\n10 10 Td\n<[0-9A-F]+> Tj\nET$/);
    for (const o of objectsWith(packed, /\/Length1 /)) assert.match(o.body, /\/FlateDecode/);
  });

  it("moves the pen back for a run that starts where the previous one started (\\not= overlays)", () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(100, 100);
    draw(page, main, 10, 10, 10, "=");
    draw(page, main, 10, 10, 10, "/");
    w.setInfo({ date: DATE });
    const p = parsePdf(finish(w, "overlay"));
    const content = getRef(p, pageObjects(p)[0].body, "Contents").raw!.toString("latin1");
    // Without "0 0 Td" the second run would start where the first one ended.
    assert.match(content, /^BT\n\/F1 10 Tf\n10 10 Td\n<[0-9A-F]+> Tj\n0 0 Td\n<[0-9A-F]+> Tj\nET$/);
  });

  it("is deterministic: the same calls and date give byte-identical files", async () => {
    const png = encodePng({ width: 5, height: 4, colorType: 6, depth: 8, sample: (x, y) => [x * 40, y * 60, 100, 128 + x] });
    const jpeg = tinyJpeg();
    const build = (date: Date) => {
      const w = createPdfWriter();
      const p1 = w.addPage(300, 200);
      draw(p1, main, 12, 20, 150, "Deterministic output");
      if (calibri) draw(p1, calibri, 11, 20, 120, "office fjord");
      p1.image(w.addImage(png), 20, 20, 50, 40);
      p1.image(w.addImage(jpeg), 100, 20, 40, 40);
      p1.destination("top", 0, 200);
      p1.link(20, 150, 100, 12, { dest: "end" });
      p1.link(20, 120, 100, 12, { url: "https://example.org" });
      const p2 = w.addPage(300, 200);
      p2.destination("end", 0, 100);
      draw(p2, main, 12, 20, 150, "Second page");
      w.outline("Top", 1, "top");
      w.outline("End", 2, "end");
      w.pageLabels([{ startPage: 0, style: "r" }]);
      w.setInfo({ title: "Determinism", author: "texwright", date });
      return w.finish();
    };
    const a = build(DATE);
    const b = build(DATE);
    assert.ok(Buffer.from(a).equals(Buffer.from(b)), "byte-identical");
    const c = build(new Date(DATE.getTime() + 1000));
    assert.ok(!Buffer.from(a).equals(Buffer.from(c)), "a different date changes the file");
    assert.equal(a.length, c.length);
    produced.push({ name: "determinism", bytes: a });
    const doc = await open(a);
    assert.equal(doc.numPages, 2);
  });

  it("returns the same bytes from repeated finish() and refuses changes afterwards", () => {
    const w = createPdfWriter();
    const page = w.addPage(100, 100);
    w.setInfo({ date: DATE });
    const a = w.finish();
    const b = w.finish();
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    expectPdfError(() => w.addPage(100, 100), /already been finished/);
    expectPdfError(() => page.rect(0, 0, 1, 1, [0, 0, 0]), /already been finished/);
    expectPdfError(() => w.setInfo({ title: "x" }), /already been finished/);
  });

  it("rejects documents without pages and invalid page sizes", () => {
    expectPdfError(() => createPdfWriter().finish(), /at least one page/);
    expectPdfError(() => createPdfWriter().addPage(0, 100));
    expectPdfError(() => createPdfWriter().addPage(100, NaN));
    expectPdfError(() => createPdfWriter().addPage(-5, 100));
  });
});

describe("pages", () => {
  it("writes every page with its own MediaBox", async () => {
    const w = createPdfWriter();
    const sizes: [number, number][] = [
      [595.28, 841.89],
      [612, 792],
      [200.5, 100.25],
    ];
    for (const [width, height] of sizes) {
      const p = w.addPage(width, height);
      assert.equal(p.width, width);
      assert.equal(p.height, height);
      draw(p, main, 10, 10, 10, `${width}x${height}`);
    }
    w.setInfo({ date: DATE });
    const bytes = finish(w, "pages");
    const doc = await open(bytes);
    assert.equal(doc.numPages, 3);
    for (let i = 0; i < 3; i++) {
      const page = await doc.getPage(i + 1);
      assert.deepEqual(page.view, [0, 0, sizes[i][0], sizes[i][1]]);
      assert.equal(await pageText(doc, i + 1), `${sizes[i][0]}x${sizes[i][1]}\n`.replace(/\n$/, ""));
    }
    // Resources list only what each page uses; no empty font or XObject dictionaries.
    const pdf = parsePdf(bytes);
    for (const p of pageObjects(pdf)) {
      assert.match(p.body, /\/Resources << \/Font << \/F1 \d+ 0 R >> >>/);
      assert.doesNotMatch(p.body, /XObject|ExtGState|ProcSet/);
    }
  });
});

describe("text and fonts", () => {
  it("extracts the text drawn with the bundled font (ToUnicode)", async () => {
    const w = createPdfWriter();
    const page = w.addPage(400, 200);
    draw(page, main, 12, 20, 150, "Hello, world! The quick brown fox.");
    draw(page, main, 12, 20, 120, "Mixed: 0123456789 (parens) [brackets]");
    w.setInfo({ date: DATE });
    const expected = "Hello, world! The quick brown fox.\nMixed: 0123456789 (parens) [brackets]";
    const doc = await open(finish(w, "text-main", expected));
    assert.equal(await pageText(doc), expected);
  });

  it("maps a ligature glyph to all the characters it replaced", { skip: !calibri && "Calibri not installed" }, async () => {
    const w = createPdfWriter();
    const page = w.addPage(400, 200);
    const run = draw(page, calibri!, 14, 20, 150, "office fish affluent fjord");
    assert.ok(run.gids.length < [..."office fish affluent fjord"].length, "ligatures applied");
    assert.ok(run.text.includes("ffi"), "an ffi ligature glyph");
    assert.ok(run.text.includes("fi"), "an fi ligature glyph");
    w.setInfo({ date: DATE });
    const bytes = finish(w, "ligature", "office fish affluent fjord");
    const doc = await open(bytes);
    assert.equal(await pageText(doc), "office fish affluent fjord");
    const pdf = parsePdf(bytes);
    const tu = objectsWith(pdf, /CMapType|\/Length/).find((o) => o.data?.toString("latin1").includes("begincmap"));
    assert.match(tu!.data!.toString("latin1"), /<006600660069>/, "ffi in the CMap");
  });

  it("extracts accented and Greek text drawn from a system font", { skip: !arial && "Arial not installed" }, async () => {
    const w = createPdfWriter();
    const page = w.addPage(400, 200);
    const s = "Café naïve Ærøskøbing — Ωμέγα “quotes” ½";
    draw(page, arial!, 12, 20, 150, s);
    w.setInfo({ date: DATE });
    const doc = await open(finish(w, "accents", s));
    assert.equal(await pageText(doc), s);
  });

  it("extracts emoji (surrogate pairs) and CJK text", { skip: !emojiFont && !cjkFont && "no emoji or CJK font" }, async () => {
    const w = createPdfWriter();
    const page = w.addPage(400, 200);
    const lines: string[] = [];
    if (emojiFont) {
      draw(page, emojiFont, 16, 20, 150, "😀🚀");
      lines.push("😀🚀");
    }
    if (cjkFont) {
      draw(page, cjkFont, 16, 20, 110, "中文字体");
      lines.push("中文字体");
    }
    w.setInfo({ date: DATE });
    const bytes = finish(w, "emoji-cjk", lines.join("\n"));
    const doc = await open(bytes);
    assert.equal(await pageText(doc), lines.join("\n"));
    // Subsets stay small even for big fonts.
    assert.ok(bytes.length < 200_000, `file is ${bytes.length} bytes`);
  });

  it("places every glyph at the advances it was given (within 0.01 pt)", async () => {
    const w = createPdfWriter();
    const page = w.addPage(600, 200);
    const str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const gids = [...str].map((c) => main.glyphForCodePoint(c.codePointAt(0)!));
    // Gaps of 9-15 pt with fractional parts; pdf.js sees each glyph as its own item.
    const size = 11.3;
    const advances = gids.map((g, i) => (main.advance(g) * size) / main.unitsPerEm + 9 + ((i * 7) % 13) / 2.17);
    const x0 = 13.37;
    page.glyphs(main, size, x0, 100, gids, advances, [...str]);
    w.setInfo({ date: DATE });
    const doc = await open(finish(w, "positions"));
    const glyphItems = (await items(doc)).filter((i) => i.str.trim());
    assert.equal(glyphItems.map((i) => i.str).join(""), str);
    let x = x0;
    for (let i = 0; i < str.length; i++) {
      assert.ok(Math.abs(glyphItems[i].x - x) < 0.01, `glyph ${str[i]} at ${glyphItems[i].x}, expected ${x}`);
      assert.ok(Math.abs(glyphItems[i].y - 100) < 0.01);
      x += advances[i];
    }
  });

  it("encodes kerning as TJ adjustments in thousandths of the size", async () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(400, 200);
    const font = arial ?? main;
    const size = 20;
    const run = shape(font, "AVATAR WAVE To", size);
    // Squeeze one pair by exactly 1 pt and widen another by 2.5 pt on top of the font's kerning.
    run.advances[0] -= 1;
    run.advances[3] += 2.5;
    page.glyphs(font, size, 50, 100, run.gids, run.advances, run.text);
    w.setInfo({ date: DATE });
    const bytes = finish(w, "kerning");
    const content = getRef(parsePdf(bytes), pageObjects(parsePdf(bytes))[0].body, "Contents").data!.toString("latin1");
    const tj = /\[(.*)\] TJ/.exec(content);
    assert.ok(tj, content);
    const nums = [...tj![1].matchAll(/>(-?[\d.]+)</g)].map((m) => Number(m[1]));
    // A glyph narrower than its width means a positive TJ number: (w - a) * 1000 / size.
    const w0 = (font.advance(run.gids[0]) * 1000) / font.unitsPerEm;
    const expected0 = w0 - (run.advances[0] * 1000) / size;
    assert.ok(Math.abs(nums[0] - expected0) < 0.01, `first adjustment ${nums[0]} vs ${expected0}`);
    assert.ok(nums.some((n) => n < 0), "a widened pair gives a negative number");
    const doc = await open(bytes);
    const it0 = (await items(doc)).filter((i) => i.str.trim());
    const total = run.advances.reduce((a, b) => a + b, 0);
    const lastAdvanceNatural = (font.advance(run.gids[run.gids.length - 1]) * size) / font.unitsPerEm;
    const start = it0[0].x;
    const end = it0[it0.length - 1].x + it0[it0.length - 1].width;
    assert.ok(Math.abs(start - 50) < 0.01);
    assert.ok(Math.abs(end - start - (total - run.advances[run.advances.length - 1] + lastAdvanceNatural)) < 0.01, `run width ${end - start}`);
    // The widened pair is a gap pdf.js may read as a space, depending on the font's own space width
    // (it does with the bundled fallback used where Arial is missing), so compare the letters only.
    assert.equal(it0.map((i) => i.str).join("").replace(/\s+/g, ""), "AVATARWAVETo");
  });

  it("writes no TJ numbers when advances equal the font's widths", () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(400, 200);
    const run = shape(arial ?? main, "Plain text without kerning at all, repeated. ".repeat(4), 9.5, { kern: false });
    page.glyphs(arial ?? main, 9.5, 10, 100, run.gids, run.advances, run.text);
    w.setInfo({ date: DATE });
    const bytes = finish(w, "no-kerning");
    const pdf = parsePdf(bytes);
    const content = getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.toString("latin1");
    assert.match(content, /<[0-9A-F]+> Tj/);
    assert.doesNotMatch(content, /TJ/);
  });

  it("raises glyphs by their y offsets with Ts and resets the rise afterwards", async () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(400, 200);
    const run = shape(main, "x2y", 12, { kern: false });
    page.glyphs(main, 12, 20, 100, run.gids, run.advances, run.text, undefined, [0, 5, -2]);
    draw(page, main, 12, 20, 60, "after");
    w.setInfo({ date: DATE });
    const bytes = finish(w, "rise");
    const pdf = parsePdf(bytes);
    const content = getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.toString("latin1");
    assert.match(content, /Tj\n5 Ts\n<[0-9A-F]{4}> Tj\n-2 Ts\n<[0-9A-F]{4}> Tj/);
    assert.match(content, /-2 Ts[\s\S]*\n0 Ts\n/, "the next run resets the rise");
    const doc = await open(bytes);
    const its = (await items(doc)).filter((i) => i.str.trim());
    const y = its.find((i) => i.str.includes("y") && !i.str.includes("x"));
    assert.ok(y && Math.abs(y.y - 98) < 0.01, `rise on y: ${JSON.stringify(its)}`);
    const afterItem = its.find((i) => i.str === "after");
    assert.ok(afterItem && Math.abs(afterItem.y - 60) < 0.01);
  });

  it("keeps the first text seen for a glyph", async () => {
    const w = createPdfWriter();
    const page = w.addPage(300, 100);
    const g = main.glyphForCodePoint(0x41);
    const adv = (main.advance(g) * 12) / main.unitsPerEm;
    page.glyphs(main, 12, 10, 50, [g], [adv], ["A"]);
    page.glyphs(main, 12, 40, 50, [g], [adv], ["Z"]);
    page.glyphs(main, 12, 70, 50, [g, g], [adv, adv], ["", "A"]);
    w.setInfo({ date: DATE });
    const doc = await open(finish(w, "first-text"));
    assert.equal((await items(doc)).map((i) => i.str).join("").replace(/\s/g, ""), "AAAA");
  });

  it("writes Type0/CIDFontType2 fonts with a subset tag, widths, descriptor and FontFile2", () => {
    const w = createPdfWriter();
    const page = w.addPage(300, 100);
    draw(page, main, 12, 10, 50, "Subset me");
    draw(page, bundledFont("Main", "Italic"), 12, 10, 30, "italic");
    if (calibri) draw(page, calibri, 12, 10, 10, "Calibri");
    w.setInfo({ date: DATE });
    const bytes = finish(w, "font-objects");
    const pdf = parsePdf(bytes);
    const type0 = objectsWith(pdf, /\/Subtype \/Type0/);
    assert.equal(type0.length, calibri ? 3 : 2, "one Type0 font per Font object");
    for (const t0 of type0) {
      assert.match(t0.body, /\/BaseFont \/[A-Z]{6}\+[!-~]+ \/Encoding \/Identity-H/);
      const cid = pdf.objects.get(Number(/\/DescendantFonts \[(\d+) 0 R\]/.exec(t0.body)![1]))!;
      assert.match(cid.body, /\/Subtype \/CIDFontType2/);
      assert.match(cid.body, /\/CIDSystemInfo << \/Registry \(Adobe\) \/Ordering \(Identity\) \/Supplement 0 >>/);
      assert.match(cid.body, /\/CIDToGIDMap \/Identity/);
      assert.match(cid.body, /\/W \[\d+ (\[[\d. ]+\]|\d+ [\d.]+)/);
      const fd = getRef(pdf, cid.body, "FontDescriptor");
      for (const key of ["Flags", "FontBBox", "ItalicAngle", "Ascent", "Descent", "CapHeight", "StemV", "FontFile2"]) {
        assert.match(fd.body, new RegExp(`/${key} `), key);
      }
      const file = getRef(pdf, fd.body, "FontFile2");
      const len1 = Number(/\/Length1 (\d+)/.exec(file.body)![1]);
      assert.equal(file.data!.length, len1, "Length1 is the decompressed size");
      const sub = parseFont(new Uint8Array(file.data!));
      assert.ok(sub.glyphCount > 0, "the subset parses as a font");
      getRef(pdf, t0.body, "ToUnicode");
    }
    const italic = objectsWith(pdf, /\/FontName \/[A-Z]{6}\+KaTeX_Main-Italic/)[0];
    assert.ok((Number(/\/Flags (\d+)/.exec(italic.body)![1]) & 64) !== 0, "italic flag");
    assert.match(italic.body, /\/ItalicAngle -?\d/);
    // Subsets are much smaller than the font.
    if (calibri) {
      const fd = objectsWith(pdf, /\/FontName \/[A-Z]{6}\+Calibri /)[0];
      const file = getRef(pdf, fd.body, "FontFile2");
      assert.ok(file.data!.length < calibri.bytes.length / 10);
    }
  });

  it("uses a deterministic subset tag that depends on the glyphs used", () => {
    const tagFor = (s: string) => {
      const w = createPdfWriter();
      draw(w.addPage(100, 100), main, 10, 0, 0, s);
      w.setInfo({ date: DATE });
      return /\/BaseFont \/([A-Z]{6})\+/.exec(latin1(w.finish()))![1];
    };
    assert.equal(tagFor("abc"), tagFor("cab"));
    assert.notEqual(tagFor("abc"), tagFor("abd"));
  });

  it("embeds CFF fonts whole as CIDFontType0 with FontFile3 /OpenType", { skip: !existsSync(KATEX_OTF) && "KaTeX Extra.otf not found" }, async () => {
    const font = parseFont(loadFile(KATEX_OTF)!);
    assert.equal(font.outlines, "cff");
    const w = createPdfWriter();
    const page = w.addPage(200, 100);
    draw(page, font, 20, 10, 50, "___");
    w.setInfo({ date: DATE });
    const bytes = finish(w, "cff", "___");
    const pdf = parsePdf(bytes);
    const cid = objectsWith(pdf, /\/Subtype \/CIDFontType0/)[0];
    assert.ok(cid, "CIDFontType0");
    assert.doesNotMatch(cid.body, /CIDToGIDMap/);
    assert.match(cid.body, /\/BaseFont \/Extra /, "a whole font has no subset tag");
    const fd = getRef(pdf, cid.body, "FontDescriptor");
    const file = getRef(pdf, fd.body, "FontFile3");
    assert.match(file.body, /\/Subtype \/OpenType/);
    assert.ok(Buffer.from(file.data!).equals(Buffer.from(font.bytes)), "the whole OpenType file");
    const doc = await open(bytes);
    assert.equal(await pageText(doc), "___");
  });

  it("refuses fonts whose licence forbids embedding", () => {
    const bytes = loadFile(join(process.cwd(), "fonts", "KaTeX_Main-Regular.ttf"))!;
    for (const fsType of [0x0002, 0x0200, 0x0202]) {
      const font = parseFont(withFsType(bytes, fsType));
      assert.equal(font.embeddingAllowed, false);
      const w = createPdfWriter();
      const page = w.addPage(100, 100);
      expectPdfError(() => draw(page, font, 10, 0, 0, "x"), /does not allow embedding/);
    }
  });

  it("embeds the whole font when subsetting is not allowed", async () => {
    const bytes = loadFile(join(process.cwd(), "fonts", "KaTeX_Main-Regular.ttf"))!;
    const font = parseFont(withFsType(bytes, 0x0100));
    assert.equal(font.embeddingAllowed, true);
    assert.equal(font.subsettingAllowed, false);
    const w = createPdfWriter();
    draw(w.addPage(200, 100), font, 12, 10, 50, "whole");
    w.setInfo({ date: DATE });
    const out = finish(w, "no-subsetting", "whole");
    const pdf = parsePdf(out);
    const fd = objectsWith(pdf, /\/Type \/FontDescriptor/)[0];
    assert.match(fd.body, /\/FontName \/KaTeX_Main-Regular /, "no subset tag");
    assert.ok(Buffer.from(getRef(pdf, fd.body, "FontFile2").data!).equals(Buffer.from(font.bytes)));
    assert.equal(await pageText(await open(out)), "whole");
  });

  it("rejects bad glyph runs", () => {
    const w = createPdfWriter();
    const page = w.addPage(100, 100);
    const g = main.glyphForCodePoint(0x41);
    expectPdfError(() => page.glyphs(main, 10, 0, 0, [g, g], [5], ["A", "A"]), /advances/);
    expectPdfError(() => page.glyphs(main, 10, 0, 0, [main.glyphCount], [5], ["?"]), /glyph id/);
    expectPdfError(() => page.glyphs(main, 10, 0, 0, [1.5], [5], ["?"]), /glyph id/);
    expectPdfError(() => page.glyphs(main, 10, NaN, 0, [g], [5], ["A"]), /finite/);
    expectPdfError(() => page.glyphs(main, 0, 0, 0, [g], [5], ["A"]), /size/);
    expectPdfError(() => page.glyphs(main, 10, 0, 0, [g], [Infinity], ["A"]), /advance/);
    expectPdfError(() => page.glyphs(main, 10, 0, 0, [g], [5], ["A"], [0, 2, 3] as unknown as [number, number, number], [1, 2]), /y offsets/);
    page.glyphs(main, 10, 0, 0, [], [], []); // nothing drawn, no error
  });
});

describe("vector graphics", () => {
  it("writes gradients as shadings, opacity as ExtGStates, groups as transparency groups with soft masks", async () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(200, 200);
    const box = (x0: number, y0: number, x1: number, y1: number): PathCommand[] => [["M", x0, y0], ["L", x1, y0], ["L", x1, y1], ["L", x0, y1], ["Z"]];
    const lin: Gradient = {
      kind: "linear",
      coords: [0, 0, 1, 0],
      matrix: [100, 0, 0, 100, 0, 0],
      stops: [
        { offset: 0, color: [1, 0, 0] },
        { offset: 0.5, color: [0, 1, 0] },
        { offset: 1, color: [0, 0, 1] },
      ],
      spread: "pad",
    };
    page.rect(0, 0, 200, 200, [0, 0, 1]); // the colour in force when the group is painted
    page.save();
    page.transform([1, 0, 0, 1, 10, 10]);
    page.path(box(0, 0, 100, 50), { fill: lin, fillAlpha: 0.5 });
    page.path(box(0, 60, 100, 70), { fill: { ...lin, spread: "reflect", matrix: [20, 0, 0, 20, 0, 0] } });
    page.path(box(0, 72, 100, 78), { stroke: { ...lin, kind: "radial", coords: [50, 75, 0, 50, 75, 40], matrix: [1, 0, 0, 1, 0, 0] }, lineWidth: 2 });
    page.group(
      { bbox: [0, 80, 100, 120], opacity: 0.4, blend: "multiply", mask: { luminance: true, draw: () => page.path(box(0, 80, 50, 120), { fill: [1, 1, 1] }) } },
      () => page.path(box(0, 80, 100, 120), { fill: [0, 0, 0] }),
    );
    page.restore();
    const bytes = finish(w, "transparency");
    const text = Buffer.from(bytes).toString("latin1");
    // Patterns, painted in the pattern colour space, their matrix taking the transformation in force.
    assert.match(text, /\/Pattern cs \/P1 scn/);
    assert.match(text, /\/Pattern CS \/P3 SCN/);
    assert.match(text, /\/PatternType 2 \/Matrix \[100 0 0 100 10 10\] \/Shading << \/ShadingType 2 \/Coords \[0 0 1 0\]/);
    assert.match(text, /\/ShadingType 3 /);
    // Three stops: a stitching function of two pieces.
    assert.match(text, /\/FunctionType 3 \/Domain \[0 1\] \/Functions \[<< \/FunctionType 2 \/Domain \[0 1\] \/C0 \[1 0 0\] \/C1 \[0 1 0\] \/N 1 >> << [^>]*>>\] \/Bounds \[0\.5\] \/Encode \[0 1 0 1\]/);
    // Reflect over the five periods the shape spans: copies alternate direction.
    assert.match(text, /\/Domain \[0 5\] \/Functions/);
    assert.match(text, /\/Encode \[0 1 1 0 0 1 1 0 0 1\]/);
    // Opacity, and the group's opacity, blend mode and luminosity soft mask.
    assert.match(text, /<< \/Type \/ExtGState \/ca 0\.5 \/CA 1 >>/);
    assert.match(text, /\/ca 0\.4 \/CA 0\.4 \/BM \/Multiply \/SMask << \/Type \/Mask \/S \/Luminosity \/G \d+ 0 R \/BC \[0 0 0\] >>/);
    assert.match(text, /q \/GS\d+ gs \/Fm1 Do Q/);
    assert.match(text, /\/Subtype \/Form \/BBox \[0 80 100 120\] \/Group << \/S \/Transparency \/CS \/DeviceRGB \/I true \/K false >>/);
    // A form starts with the graphics state where it is painted (blue here): black is written out.
    const forms = [...text.matchAll(/\/BBox \[0 80 100 120\][^]*?stream\r?\n([^]*?)endstream/g)].map((m) => m[1]);
    assert.equal(forms.length, 2, "the group and its mask");
    assert.ok(
      forms.some((f) => /^0 g$/m.test(f)),
      forms.join(" | "),
    );
    const doc = await open(bytes);
    const ops = await (await doc.getPage(1)).getOperatorList();
    assert.ok(ops.fnArray.includes(pdfjs.OPS.paintFormXObjectBegin), "pdf.js paints the group");
  });

  it("writes paths, rectangles, line styles, clipping and transforms", async () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(300, 300);
    page.save();
    page.transform([1, 0, 0, 1, 10.5, 20.25]);
    page.rect(10, 10, 50, 20, [0, 0.5, 1]);
    page.path([["M", 0, 0], ["L", 10, 10], ["L", 20, 0], ["Z"]], { fill: [1, 0, 0], evenOdd: true });
    page.path([["M", 0, 0], ["C", 10, 10, 20, 10, 30, 0]], { stroke: [0, 0, 1], lineWidth: 2, dash: [2, 1], lineCap: 1, lineJoin: 2 });
    page.path([["M", 50, 50], ["L", 60, 60], ["L", 70, 50], ["Z"]], { fill: [0.2, 0.2, 0.2], stroke: [0, 0, 0] });
    page.clip([["M", 0, 0], ["L", 100, 0], ["L", 100, 100], ["Z"]], true);
    page.path([["M", 0, 0], ["L", 1, 1]], {}); // nothing to paint: nothing written
    page.restore();
    page.path([["M", 5, 5], ["L", 6, 6]], { stroke: [0, 0, 0], lineWidth: 0.25 });
    w.setInfo({ date: DATE });
    const bytes = finish(w, "graphics");
    const pdf = parsePdf(bytes);
    const content = getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.toString("latin1");
    assert.equal(
      content,
      [
        "q",
        "1 0 0 1 10.5 20.25 cm",
        "0 0.5 1 rg",
        "10 10 50 20 re f",
        "1 0 0 rg",
        "0 0 m\n10 10 l\n20 0 l\nh",
        "f*",
        "0 0 1 RG",
        "2 w",
        "[2 1] 0 d",
        "1 J",
        "2 j",
        "0 0 m\n10 10 20 10 30 0 c",
        "S",
        "0.2 g",
        "0 G",
        "1 w",
        "[] 0 d",
        "0 J",
        "0 j",
        "50 50 m\n60 60 l\n70 50 l\nh",
        "B",
        "0 0 m\n100 0 l\n100 100 l\nh",
        "W* n",
        "Q",
        "0.25 w",
        "5 5 m\n6 6 l",
        "S",
      ].join("\n"),
    );
    const doc = await open(bytes);
    const ops = await (await doc.getPage(1)).getOperatorList();
    const names = new Map(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
    const seen = new Set<string>();
    ops.fnArray.forEach((f, i) => {
      seen.add(names.get(f)!);
      if (names.get(f) === "constructPath") seen.add(`paint:${names.get(ops.argsArray[i][0] as number)}`);
    });
    for (const op of ["save", "restore", "transform", "setFillRGBColor", "setStrokeRGBColor", "setLineWidth", "setDash", "setLineCap", "setLineJoin", "constructPath", "eoClip"]) {
      assert.ok(seen.has(op), `${op} in ${[...seen].join(" ")}`);
    }
    // PDF.js 4 emits painting as separate operators; newer readers fold it into constructPath.
    for (const paint of ["fill", "eoFill", "stroke", "fillStroke", "endPath"]) assert.ok(seen.has(paint) || seen.has(`paint:${paint}`), paint);
  });

  it("closes unbalanced saves and ignores unmatched restores with a warning", () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(100, 100);
    page.restore();
    page.save();
    page.save();
    page.rect(0, 0, 1, 1, [0, 0, 0]);
    page.restore();
    w.setInfo({ date: DATE });
    const bytes = finish(w, "unbalanced");
    const pdf = parsePdf(bytes);
    const content = getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.toString("latin1");
    assert.equal(content, "q\nq\n0 0 1 1 re f\nQ\nQ");
    assert.equal(w.warnings.length, 1);
    assert.match(w.warnings[0], /restore\(\) without a matching save\(\)/);
  });

  it("tracks colour and font state across save/restore and text", () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(200, 100);
    draw(page, main, 10, 10, 80, "red", [1, 0, 0]);
    draw(page, main, 10, 10, 60, "red2", [1, 0, 0]);
    page.save();
    draw(page, main, 12, 10, 40, "blue", [0, 0, 1]);
    page.restore();
    draw(page, main, 10, 10, 20, "red3", [1, 0, 0]);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "state"));
    const content = getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.toString("latin1");
    const lines = content.split("\n");
    // Q restores the red fill and the 10 pt font, so neither is written again.
    assert.equal(lines.filter((l) => l === "1 0 0 rg").length, 1, content);
    assert.equal(lines.filter((l) => l === "0 0 1 rg").length, 1, content);
    assert.deepEqual(
      lines.filter((l) => l.endsWith(" Tf")),
      ["/F1 10 Tf", "/F1 12 Tf"],
    );
    assert.deepEqual(
      lines.filter((l) => /^(BT|ET|q|Q)$/.test(l)),
      ["BT", "ET", "q", "BT", "ET", "Q", "BT", "ET"],
      "consecutive runs share one text object",
    );
  });

  it("rejects malformed paths before writing anything", () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(100, 100);
    expectPdfError(() => page.path([["L", 1, 1]], { fill: [0, 0, 0] }), /start with M/);
    expectPdfError(() => page.path([["M", 1, NaN]], { fill: [0, 0, 0] }), /finite/);
    expectPdfError(() => page.path([["Q", 1, 1]] as unknown as ["M", number, number][], { fill: [0, 0, 0] }), /unknown path command/);
    expectPdfError(() => page.path([["M", 1, 1]], { stroke: [0, 0, 0], lineWidth: -1 }), /negative/);
    expectPdfError(() => page.rect(0, 0, 1, 1, [0, 0] as unknown as [number, number, number]), /\[r, g, b\]/);
    expectPdfError(() => page.transform([1, 0, 0, 1, 0] as unknown as [number, number, number, number, number, number]), /six/);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "bad-paths"));
    assert.equal(getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.length, 0);
  });
});

// ===========================================================================

const PALETTE = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
  [128, 128, 128],
  [10, 20, 30],
  [200, 100, 50],
  [1, 2, 3],
  [250, 240, 230],
  [33, 66, 99],
  [99, 66, 33],
  [0, 0, 0],
  [255, 255, 255],
  [77, 88, 99],
];

function pngCases(): { name: string; spec: PngSpec }[] {
  const cases: { name: string; spec: PngSpec }[] = [];
  const W = 13;
  const H = 11;
  for (const depth of [1, 2, 4, 8, 16] as const) {
    const max = (1 << depth) - 1;
    cases.push({ name: `gray ${depth}-bit`, spec: { width: W, height: H, colorType: 0, depth, sample: (x, y) => [hash(x, y, 0) % (max + 1)] } });
  }
  for (const depth of [8, 16] as const) {
    const m = (1 << depth) - 1;
    cases.push({ name: `rgb ${depth}-bit`, spec: { width: W, height: H, colorType: 2, depth, sample: (x, y) => [0, 1, 2].map((c) => hash(x, y, c) & m) } });
    cases.push({ name: `gray+alpha ${depth}-bit`, spec: { width: W, height: H, colorType: 4, depth, sample: (x, y) => [0, 1].map((c) => hash(x, y, c) & m) } });
    cases.push({ name: `rgba ${depth}-bit`, spec: { width: W, height: H, colorType: 6, depth, sample: (x, y) => [0, 1, 2, 3].map((c) => hash(x, y, c) & m) } });
  }
  for (const depth of [1, 2, 4, 8] as const) {
    const entries = Math.min(16, 1 << depth);
    cases.push({
      name: `palette ${depth}-bit`,
      spec: { width: W, height: H, colorType: 3, depth, palette: PALETTE.slice(0, entries), sample: (x, y) => [hash(x, y, 9) % entries] },
    });
  }
  cases.push({
    name: "palette 4-bit with tRNS",
    spec: { width: W, height: H, colorType: 3, depth: 4, palette: PALETTE, trns: [0, 128, 255, 64], sample: (x, y) => [hash(x, y, 3) % 16] },
  });
  cases.push({
    name: "gray 4-bit with a tRNS key",
    spec: { width: W, height: H, colorType: 0, depth: 4, trns: [0, 5], sample: (x, y) => [hash(x, y, 4) % 8] },
  });
  cases.push({
    name: "rgb 16-bit with a tRNS key",
    spec: { width: W, height: H, colorType: 2, depth: 16, trns: [0x12, 0x34, 0, 0, 0xff, 0xff], sample: (x, y) => ((x + y) % 3 === 0 ? [0x1234, 0, 0xffff] : [x * 1000, y * 2000, 7]) },
  });
  cases.push({
    name: "opaque rgba (alpha dropped)",
    spec: { width: W, height: H, colorType: 6, depth: 8, sample: (x, y) => [x, y, x + y, 255] },
  });
  // Interlaced images, including sizes smaller than the Adam7 grid (empty passes).
  cases.push({ name: "interlaced rgba 8-bit", spec: { width: 17, height: 9, colorType: 6, depth: 8, interlace: true, sample: (x, y) => [0, 1, 2, 3].map((c) => hash(x, y, c) & 255) } });
  cases.push({ name: "interlaced gray 1-bit", spec: { width: 19, height: 13, colorType: 0, depth: 1, interlace: true, sample: (x, y) => [hash(x, y, 1) & 1] } });
  cases.push({
    name: "interlaced palette 2-bit with tRNS",
    spec: { width: 9, height: 10, colorType: 3, depth: 2, interlace: true, palette: PALETTE.slice(0, 4), trns: [0, 255, 100], sample: (x, y) => [hash(x, y, 2) & 3] },
  });
  cases.push({ name: "interlaced rgb 16-bit 3x2", spec: { width: 3, height: 2, colorType: 2, depth: 16, interlace: true, sample: (x, y) => [x * 9999, y * 7777, 4242] } });
  cases.push({ name: "interlaced gray 1x1", spec: { width: 1, height: 1, colorType: 0, depth: 8, interlace: true, sample: () => [77] } });
  return cases;
}

describe("PNG images", () => {
  const cases = pngCases();

  it("decodes every colour type, bit depth and interlacing to the right 8-bit samples", async () => {
    const w = createPdfWriter();
    const refs = cases.map((c) => w.addImage(encodePng(c.spec)));
    const pages = cases.map((_, i) => {
      const page = w.addPage(100, 100);
      page.image(refs[i], 10, 10, 80, 60);
      return page;
    });
    assert.equal(pages.length, cases.length);
    w.setInfo({ date: DATE });
    const bytes = finish(w, "png-matrix");
    const pdf = parsePdf(bytes);
    const pageObjs = pageObjects(pdf);
    const doc = await open(bytes);
    for (let i = 0; i < cases.length; i++) {
      const { name, spec } = cases[i];
      assert.deepEqual(refs[i], { id: refs[i].id, pixelWidth: spec.width, pixelHeight: spec.height }, name);
      const xobj = getRef(pdf, pageObjs[i].body, "Im\\d+");
      assert.match(xobj.body, new RegExp(`/Width ${spec.width} /Height ${spec.height} /BitsPerComponent 8`), name);
      const exp = expectedPixels(spec);
      if (spec.colorType === 3) {
        assert.match(xobj.body, /\/ColorSpace \[\/Indexed \/DeviceRGB \d+ <[0-9A-F]+>\]/, name);
        const pal = /<([0-9A-F]+)>\]/.exec(xobj.body)![1];
        assert.equal(pal.slice(0, 6 * spec.palette!.length), Buffer.from(spec.palette!.flat()).toString("hex").toUpperCase(), name);
      } else {
        const rgb = spec.colorType === 2 || spec.colorType === 6;
        assert.match(xobj.body, new RegExp(`/ColorSpace /Device${rgb ? "RGB" : "Gray"}`), name);
      }
      const samples = imageSamples(xobj);
      assert.equal(samples.length, exp.pixels.length, `${name}: sample count`);
      assert.deepEqual([...samples], exp.pixels, `${name}: samples`);
      if (exp.alpha) {
        const mask = getRef(pdf, xobj.body, "SMask");
        assert.match(mask.body, /\/ColorSpace \/DeviceGray/);
        assert.deepEqual([...imageSamples(mask)], exp.alpha, `${name}: alpha`);
      } else {
        assert.doesNotMatch(xobj.body, /SMask/, `${name}: opaque images have no mask`);
      }
      // pdf.js decodes the same thing.
      const [img] = await decodedImages(doc, i + 1);
      assert.ok(img, `${name}: pdf.js image`);
      assert.equal(img.width, spec.width, name);
      assert.equal(img.height, spec.height, name);
      const bpp = img.kind === 3 ? 4 : img.kind === 2 ? 3 : 0;
      if (bpp) {
        assert.equal(img.data.length, spec.width * spec.height * bpp, `${name}: decoded length`);
        // Check the first pixel's colour (and alpha) as pdf.js sees it.
        const rgbOf = (k: number): number[] => {
          if (spec.colorType === 3) return spec.palette![exp.pixels[k]] ?? [0, 0, 0];
          if (spec.colorType === 2 || spec.colorType === 6) return exp.pixels.slice(3 * k, 3 * k + 3);
          return [exp.pixels[k], exp.pixels[k], exp.pixels[k]];
        };
        for (const k of [0, spec.width * spec.height - 1]) {
          assert.deepEqual([...img.data.subarray(k * bpp, k * bpp + 3)], rgbOf(k), `${name}: pixel ${k} colour`);
          if (bpp === 4) assert.equal(img.data[k * bpp + 3], exp.alpha ? exp.alpha[k] : 255, `${name}: pixel ${k} alpha`);
        }
      }
    }
  });

  it("embeds identical image bytes once", () => {
    const png = encodePng(cases[0].spec);
    const w = createPdfWriter();
    const a = w.addImage(png);
    const b = w.addImage(new Uint8Array(png));
    assert.equal(a.id, b.id);
    const page = w.addPage(100, 100);
    page.image(a, 0, 0, 10, 10);
    page.image(b, 20, 0, 10, 10);
    w.addPage(100, 100).image(a, 0, 0, 50, 50);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "image-dedup"));
    assert.equal(objectsWith(pdf, /\/Subtype \/Image/).length, 1);
    const [p1, p2] = pageObjects(pdf);
    assert.equal(/\/XObject << \/Im1 (\d+) 0 R >>/.exec(p1.body)![1], /\/XObject << \/Im1 (\d+) 0 R >>/.exec(p2.body)![1]);
  });

  it("does not embed images that are never drawn, and refuses foreign image refs", () => {
    const w = createPdfWriter();
    w.addImage(encodePng(cases[1].spec));
    const page = w.addPage(100, 100);
    expectPdfError(() => page.image({ id: "img-nope", pixelWidth: 1, pixelHeight: 1 }, 0, 0, 1, 1), /addImage/);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "image-unused"));
    assert.equal(objectsWith(pdf, /\/Subtype \/Image/).length, 0);
  });

  it("draws images with a scaling cm inside q/Q", () => {
    const w = createPdfWriter({ compress: false });
    const ref = w.addImage(encodePng(cases[0].spec));
    w.addPage(100, 100).image(ref, 5, 6.5, 40, 30.25);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "image-cm"));
    assert.equal(getRef(pdf, pageObjects(pdf)[0].body, "Contents").data!.toString("latin1"), "q 40 0 0 30.25 5 6.5 cm /Im1 Do Q");
    // Uncompressed: plain 8-bit samples, no filter, no predictor.
    const im = objectsWith(pdf, /\/Subtype \/Image/)[0];
    assert.doesNotMatch(im.body, /Filter|DecodeParms/);
    assert.deepEqual([...im.raw!], expectedPixels(cases[0].spec).pixels);
  });

  it("passes 8-bit gray, RGB and palette data through as the PNG stores it", () => {
    for (const spec of cases.map((c) => c.spec).filter((s) => s.depth === 8 && !s.interlace && !s.trns && [0, 2, 3].includes(s.colorType))) {
      const png = encodePng(spec);
      const w = createPdfWriter();
      w.addPage(100, 100).image(w.addImage(png), 0, 0, 10, 10);
      w.setInfo({ date: DATE });
      const im = objectsWith(parsePdf(finish(w, `png-passthrough-${spec.colorType}`)), /\/Subtype \/Image/)[0];
      // The IDAT payloads, concatenated.
      const idat: Buffer[] = [];
      for (let p = 8; p < png.length; ) {
        const len = (png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3];
        if (latin1(png.subarray(p + 4, p + 8)) === "IDAT") idat.push(Buffer.from(png.subarray(p + 8, p + 8 + len)));
        p += 12 + len;
      }
      assert.ok(im.raw!.equals(Buffer.concat(idat)), `colour type ${spec.colorType}`);
      assert.match(im.body, new RegExp(`/DecodeParms << /Predictor 15 /Colors ${spec.colorType === 2 ? 3 : 1} /Columns ${spec.width} >>`));
    }
  });
});

describe("JPEG images", () => {
  it("embeds a baseline grayscale JPEG unchanged with DCTDecode", async () => {
    const jpeg = tinyJpeg();
    const w = createPdfWriter();
    const ref = w.addImage(jpeg);
    assert.equal(ref.pixelWidth, 8);
    assert.equal(ref.pixelHeight, 8);
    w.addPage(100, 100).image(ref, 0, 0, 80, 80);
    w.setInfo({ date: DATE });
    const bytes = finish(w, "jpeg-gray");
    const pdf = parsePdf(bytes);
    const im = objectsWith(pdf, /\/Subtype \/Image/)[0];
    assert.match(im.body, /\/Width 8 \/Height 8 \/ColorSpace \/DeviceGray \/BitsPerComponent 8 \/Filter \/DCTDecode/);
    assert.ok(im.raw!.equals(Buffer.from(jpeg)), "bytes unchanged");
    const [img] = await decodedImages(await open(bytes));
    assert.equal(img.width, 8);
    assert.equal(img.height, 8);
    assert.ok([...img.data].every((v, i) => (img.kind === 3 && i % 4 === 3 ? v === 255 : Math.abs(v - 128) <= 1)), "mid gray");
  });

  it("reads progressive JPEG headers", async () => {
    const jpeg = tinyJpeg({ progressive: true, components: 3, width: 8, height: 8 });
    const w = createPdfWriter();
    const ref = w.addImage(jpeg);
    w.addPage(100, 100).image(ref, 0, 0, 80, 80);
    w.setInfo({ date: DATE });
    const bytes = finish(w, "jpeg-progressive");
    const im = objectsWith(parsePdf(bytes), /\/Subtype \/Image/)[0];
    assert.match(im.body, /\/ColorSpace \/DeviceRGB/);
    const [img] = await decodedImages(await open(bytes));
    assert.equal(img.width * img.height, 64);
  });

  it("inverts Adobe CMYK JPEGs with a Decode array", () => {
    const w = createPdfWriter();
    const cmyk = w.addImage(tinyJpeg({ components: 4, adobe: true }));
    const plain = w.addImage(tinyJpeg({ components: 4, adobe: false, width: 16 }));
    const page = w.addPage(100, 100);
    page.image(cmyk, 0, 0, 10, 10);
    page.image(plain, 20, 0, 10, 10);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "jpeg-cmyk"));
    const ims = objectsWith(pdf, /\/Subtype \/Image/);
    assert.match(ims[0].body, /\/ColorSpace \/DeviceCMYK .*\/Decode \[1 0 1 0 1 0 1 0\]/);
    assert.match(ims[1].body, /\/ColorSpace \/DeviceCMYK/);
    assert.doesNotMatch(ims[1].body, /\/Decode \[/);
  });

  const real = findJpeg("C:/Windows/Web");
  it("embeds a real photograph", { skip: !real && "no JPEG under C:/Windows/Web" }, async () => {
    const bytes = loadFile(real!)!;
    const w = createPdfWriter();
    const ref = w.addImage(bytes);
    assert.ok(ref.pixelWidth > 0 && ref.pixelHeight > 0);
    w.addPage(400, 300).image(ref, 0, 0, 400, 300);
    w.setInfo({ date: DATE });
    const out = finish(w, "jpeg-real");
    const [img] = await decodedImages(await open(out));
    assert.equal(img.width, ref.pixelWidth);
    assert.equal(img.height, ref.pixelHeight);
  });
});

describe("hostile images", () => {
  const good = encodePng({ width: 4, height: 4, colorType: 2, depth: 8, sample: (x, y) => [x, y, 0] });

  /** A PNG from chunks, CRCs correct. */
  const build = (...chunks: Buffer[]) => new Uint8Array(Buffer.concat([PNG_SIG, ...chunks, pngChunk("IEND", new Uint8Array(0))]));

  it("rejects corrupt and oversized PNGs quickly with PdfError", () => {
    const w = createPdfWriter();
    // Inputs are built first so only addImage() is timed.
    const reject = (input: Uint8Array, re: RegExp) => expectPdfError(() => w.addImage(input), re);
    const corruptCrc = new Uint8Array(good);
    corruptCrc[good.length - 20] ^= 0xff;
    reject(corruptCrc, /CRC/);
    reject(good.subarray(0, good.length >> 1), /truncated|past the end/);
    reject(good.subarray(0, 12), /truncated/);
    const z10 = zlib.deflateSync(new Uint8Array(10));
    // A header claiming ten billion pixels with a few bytes of data.
    reject(build(ihdr(100000, 100000, 8, 6), pngChunk("IDAT", z10)), /megapixel/);
    reject(build(ihdr(0xffffffff, 1, 8, 0), pngChunk("IDAT", z10)), /invalid size/);
    // Within the pixel limit but with almost no data: refused before any big allocation.
    reject(build(ihdr(9000, 9000, 8, 6), pngChunk("IDAT", zlib.deflateSync(new Uint8Array(1000)))), /truncated/);
    // A deflate bomb: far more data than the header needs; inflating stops early.
    reject(build(ihdr(64, 64, 8, 0), pngChunk("IDAT", zlib.deflateSync(new Uint8Array(50_000_000)))), /more image data/);
    reject(build(ihdr(4, 4, 8, 0), pngChunk("IDAT", Buffer.from("not zlib at all"))), /corrupt/);
    const badAdler = zlib.deflateSync(new Uint8Array(20));
    badAdler[badAdler.length - 1] ^= 1;
    reject(build(ihdr(4, 4, 8, 0), pngChunk("IDAT", badAdler)), /corrupt/);
    reject(build(ihdr(2, 2, 8, 0), pngChunk("IDAT", zlib.deflateSync(Uint8Array.from([7, 1, 2, 0, 3, 4])))), /filter type 7/);
    reject(build(ihdr(4, 4, 4, 2), pngChunk("IDAT", zlib.deflateSync(new Uint8Array(40)))), /bit depth/);
    reject(build(ihdr(4, 4, 8, 5), pngChunk("IDAT", zlib.deflateSync(new Uint8Array(40)))), /colour type/);
    reject(build(ihdr(4, 4, 8, 3), pngChunk("IDAT", zlib.deflateSync(new Uint8Array(20)))), /PLTE/);
    reject(build(ihdr(4, 4, 8, 0)), /no image data/);
    reject(build(pngChunk("IDAT", zlib.deflateSync(new Uint8Array(20)))), /IHDR/);
    reject(build(ihdr(4, 4, 8, 0), ihdr(4, 4, 8, 0)), /two IHDR/);
    reject(build(ihdr(4, 4, 8, 0), pngChunk("ABCD", new Uint8Array(1)), pngChunk("IDAT", zlib.deflateSync(new Uint8Array(20)))), /critical/);
    const longChunk = Buffer.concat([PNG_SIG, ihdr(4, 4, 8, 0), Buffer.from([0x7f, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54, ...new Array(10).fill(0)])]);
    reject(new Uint8Array(longChunk), /past the end/);
    reject(Uint8Array.from([1, 2, 3, 4, 5]), /unsupported image format/);
    reject(new Uint8Array(0), /unsupported image format/);
    // Unknown ancillary chunks are skipped; palette indices past the palette's end read as black.
    const withAncillary = build(ihdr(1, 1, 8, 0), pngChunk("zzZz", new Uint8Array(3)), pngChunk("IDAT", zlib.deflateSync(Uint8Array.from([0, 9]))));
    assert.equal(w.addImage(withAncillary).pixelWidth, 1);
    const outOfPalette = build(ihdr(2, 1, 8, 3), pngChunk("PLTE", Uint8Array.from([1, 2, 3])), pngChunk("IDAT", zlib.deflateSync(Uint8Array.from([0, 0, 5]))));
    assert.equal(w.addImage(outOfPalette).pixelWidth, 2);
  });

  it("rejects corrupt and oversized JPEGs quickly with PdfError", () => {
    const w = createPdfWriter();
    const reject = (input: Uint8Array, re: RegExp) => expectPdfError(() => w.addImage(input), re);
    const jpeg = tinyJpeg();
    reject(Uint8Array.from([0xff, 0xd8, 0xff]), /before its first scan/);
    reject(jpeg.subarray(0, 30), /past the end|before its first scan/);
    reject(tinyJpeg({ width: 0 }), /invalid size/);
    reject(tinyJpeg({ width: 65535, height: 65535 }), /megapixel/);
    reject(tinyJpeg({ components: 2 as 1 }), /components/);
    reject(tinyJpeg({ precision: 12 }), /12-bit/);
    const lossless = new Uint8Array(jpeg);
    lossless[lossless.indexOf(0xc0, 2)] = 0xc3;
    reject(lossless, /SOF3/);
    const sof = jpeg.indexOf(0xc0, 2) - 1;
    const sofLen = (jpeg[sof + 2] << 8) | jpeg[sof + 3];
    const twoFrames = Buffer.concat([jpeg.subarray(0, sof + 2 + sofLen), jpeg.subarray(sof)]);
    reject(new Uint8Array(twoFrames), /two frame headers/);
    reject(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 0x3f, 0xff, 0xd9]), /before its frame header/);
    reject(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0]), /past the end/);
    reject(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), /before its first scan/);
    const garbage = new Uint8Array(1_000_000);
    garbage.set([0xff, 0xd8, 0xff, 0xd8]);
    reject(garbage, /before its first scan/);
  });
});

// ===========================================================================

describe("links and navigation", () => {
  it("creates URI links and internal links that resolve to the right page", async () => {
    const w = createPdfWriter();
    const p1 = w.addPage(300, 300);
    const p2 = w.addPage(300, 300);
    const p3 = w.addPage(300, 300);
    p1.link(10, 10, 100, 20, { url: "https://example.com/a?b=c&d=é" });
    p1.link(10, 40, 100, 20, { url: "mailto:someone@example.com" });
    p1.link(10, 70, 100, 20, { url: "javascript:alert(1)" });
    p1.link(10, 100, 100, 20, { url: "file:///etc/passwd" });
    p1.link(110, 150, -100, -20, { dest: "sec:results" });
    p1.link(10, 190, 100, 20, { dest: "missing" });
    p3.destination("sec:results", 72, 250.5);
    p2.destination("intro", 0, 300);
    p2.link(0, 0, 50, 50, { dest: "intro" });
    w.setInfo({ date: DATE });
    const bytes = finish(w, "links");
    assert.ok(w.warnings.some((m) => /javascript:alert/.test(m)), "javascript link warned");
    assert.ok(w.warnings.some((m) => /file:\/\/\/etc/.test(m)), "file link warned");
    assert.ok(w.warnings.some((m) => /undefined destination "missing" dropped/.test(m)), "dangling link warned");
    const doc = await open(bytes);
    const annots = await (await doc.getPage(1)).getAnnotations();
    assert.equal(annots.length, 3);
    assert.equal(annots[0].url, "https://example.com/a?b=c&d=%C3%A9");
    assert.deepEqual(annots[0].rect, [10, 10, 110, 30]);
    assert.equal(annots[1].url, "mailto:someone@example.com");
    assert.equal(annots[2].dest, "sec:results");
    assert.deepEqual(annots[2].rect, [10, 130, 110, 150], "negative sizes are normalized");
    const dest = await doc.getDestination("sec:results");
    assert.ok(dest);
    assert.equal(await doc.getPageIndex(dest![0]), 2);
    assert.equal(dest![1].name, "XYZ");
    assert.equal(dest![2], 72);
    assert.equal(dest![3], 250.5);
    assert.equal(dest![4], null);
    const intro = await doc.getDestination("intro");
    assert.equal(await doc.getPageIndex(intro![0]), 1);
    const pdf = parsePdf(bytes);
    for (const a of objectsWith(pdf, /\/Subtype \/Link/)) assert.match(a.body, /\/Border \[0 0 0\]/);
  });

  it("splits a large destination name tree into sorted kids", async () => {
    const w = createPdfWriter();
    const pages = Array.from({ length: 5 }, () => w.addPage(200, 200));
    const names: string[] = [];
    for (let i = 0; i < 300; i++) {
      const name = `d${String((i * 7919) % 300).padStart(3, "0")}-${i % 3 === 0 ? "é" : "x"}`;
      names.push(name);
      pages[i % 5].destination(name, i % 200, 100);
    }
    w.setInfo({ date: DATE });
    const bytes = finish(w, "name-tree");
    const pdf = parsePdf(bytes);
    const dests = getRef(pdf, /\/Names << \/Dests (\d+ 0 R) >>/.exec(pdf.root.body)![0].replace("/Names << ", "").replace(" >>", ""), "Dests");
    assert.match(dests.body, /^<< \/Kids \[/);
    const leaves = objectsWith(pdf, /\/Limits .* \/Names \[/);
    assert.equal(leaves.length, Math.ceil(300 / 64));
    const doc = await open(bytes);
    const all = await doc.getDestinations();
    assert.equal(Object.keys(all).length || (all as unknown as Map<string, unknown>).size, 300);
    for (const i of [0, 1, 63, 64, 150, 299]) {
      const d = await doc.getDestination(names[i]);
      assert.ok(d, names[i]);
      assert.equal(await doc.getPageIndex(d![0]), i % 5, names[i]);
    }
  });

  it("builds the outline tree from levels", async () => {
    const w = createPdfWriter();
    const page = w.addPage(300, 300);
    const entries: [string, number][] = [
      ["Introduction", 1],
      ["Background", 2],
      ["History", 3],
      ["Methods", 1],
      ["Setup", 2],
      ["Skipped level", 4],
      ["Analysis", 2],
      ["Résumé ünïcode", 1],
    ];
    entries.forEach((_, i) => page.destination(`d${i}`, 0, 300 - i * 10));
    entries.forEach(([title, level], i) => w.outline(title, level, `d${i}`));
    w.outline("Dangling", 2, "nowhere");
    w.setInfo({ date: DATE });
    const bytes = finish(w, "outline");
    assert.ok(w.warnings.some((m) => /Dangling/.test(m)));
    const doc = await open(bytes);
    const outline = await doc.getOutline();
    const shape = (items: { title: string; items: unknown[] }[]): unknown => items.map((it) => [it.title, shape(it.items as { title: string; items: unknown[] }[])]);
    assert.deepEqual(shape(outline as { title: string; items: unknown[] }[]), [
      ["Introduction", [["Background", [["History", []]]]]],
      ["Methods", [["Setup", [["Skipped level", []]]], ["Analysis", []]]],
      ["Résumé ünïcode", [["Dangling", []]]],
    ]);
    assert.equal((outline[0] as { dest: unknown }).dest, "d0");
    // /First /Last /Prev /Next /Parent and /Count.
    const pdf = parsePdf(bytes);
    const root = getRef(pdf, pdf.root.body, "Outlines");
    assert.match(pdf.root.body, /\/PageMode \/UseOutlines/);
    const items2 = objectsWith(pdf, /\/Title /);
    const byTitle = (t: string) => items2.find((o) => o.body.includes(`/Title ${textString(t)}`))!;
    // Top level open: 3 top items + their visible children (level-2 items; level 3+ are closed).
    assert.match(root.body, new RegExp(`/First ${byTitle("Introduction").num} 0 R /Last ${byTitle("Résumé ünïcode").num} 0 R /Count 7`));
    const intro = byTitle("Introduction");
    assert.match(intro.body, /\/Count 1\b/);
    assert.match(byTitle("Background").body, /\/Count -1\b/, "level 2 items are closed");
    assert.match(byTitle("Methods").body, /\/Count 2\b/);
    assert.match(byTitle("Setup").body, new RegExp(`/Parent ${byTitle("Methods").num} 0 R /Next ${byTitle("Analysis").num} 0 R`));
    assert.match(byTitle("Analysis").body, new RegExp(`/Prev ${byTitle("Setup").num} 0 R`));
    assert.doesNotMatch(byTitle("Dangling").body, /\/Dest/);
  });

  it("validates link targets, outline levels and duplicate destinations", () => {
    const w = createPdfWriter();
    const page = w.addPage(100, 100);
    expectPdfError(() => page.link(0, 0, 1, 1, {} as { url: string }), /target/);
    expectPdfError(() => page.link(0, NaN, 1, 1, { url: "https://x.org" }), /finite/);
    expectPdfError(() => w.outline("x", 0, "d"), /level/);
    expectPdfError(() => w.outline("x", 1.5, "d"), /level/);
    page.destination("d", 1, 2);
    page.destination("d", 3, 4);
    assert.match(w.warnings.join("\n"), /destination "d" defined twice/);
    w.addPage(20000, 100);
    assert.match(w.warnings.join("\n"), /14400/);
    w.setInfo({ date: DATE });
    const pdf = parsePdf(finish(w, "nav-validation"));
    assert.match(pdf.objects.get(refOf(pdf.root.body, "Dests")!)!.body, /\(d\) \[\d+ 0 R \/XYZ 1 2 null\]/, "the first definition wins");
  });

  it("writes page labels", async () => {
    const w = createPdfWriter();
    for (let i = 0; i < 6; i++) w.addPage(100, 100);
    w.pageLabels([
      { startPage: 0, style: "r" },
      { startPage: 3, style: "D", start: 1 },
      { startPage: 5, style: "A", prefix: "App-" },
      { startPage: 99, style: "D" },
    ]);
    w.setInfo({ date: DATE });
    const bytes = finish(w, "page-labels");
    assert.ok(w.warnings.some((m) => /page index 99/.test(m)));
    const doc = await open(bytes);
    assert.deepEqual(await doc.getPageLabels(), ["i", "ii", "iii", "1", "2", "App-A"]);
  });
});

describe("metadata", () => {
  it("writes the document information dictionary, /Lang and viewer preferences", async () => {
    const w = createPdfWriter();
    w.addPage(100, 100);
    w.setInfo({ title: "A Title (with parens)", author: "Ada Lovelace", subject: "Testing", keywords: "pdf, test", creator: "texwright test", lang: "de-CH", date: DATE });
    w.setInfo({ subject: "Testing ✓" });
    const bytes = finish(w, "metadata");
    const doc = await open(bytes);
    const { info } = (await doc.getMetadata()) as unknown as { info: Record<string, unknown> };
    assert.equal(info.Title, "A Title (with parens)");
    assert.equal(info.Author, "Ada Lovelace");
    assert.equal(info.Subject, "Testing ✓");
    assert.equal(info.Keywords, "pdf, test");
    assert.equal(info.Creator, "texwright test");
    assert.equal(info.Producer, "texwright");
    assert.equal(info.CreationDate, "D:20261007123045+00'00'");
    assert.equal(info.ModDate, "D:20261007123045+00'00'");
    assert.equal(info.Language, "de-CH");
    const prefs = (await doc.getViewerPreferences()) as unknown;
    assert.equal(prefs instanceof Map ? prefs.get("DisplayDocTitle") : (prefs as Record<string, unknown>)?.DisplayDocTitle, true);
    const date = pdfjs.PDFDateString.toDateObject(info.CreationDate as string);
    assert.equal(date?.getTime(), DATE.getTime());
  });

  it("lets the producer be overridden and defaults the date to now", () => {
    const w = createPdfWriter();
    w.addPage(100, 100);
    w.setInfo({ producer: "custom" });
    const before = Date.now();
    const text = latin1(finish(w, "producer"));
    assert.match(text, /\/Producer \(custom\)/);
    const m = /\/CreationDate \(D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\+00'00'\)/.exec(text)!;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    assert.ok(Math.abs(t - before) < 5000);
  });
});

describe("performance", () => {
  it("writes a 200-page document with text on every page in under a second", async (t) => {
    const fonts = [main, bundledFont("Main", "Bold"), bundledFont("Main", "Italic")];
    const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");
    // Shaping is the layout's job; prepare lines first.
    const lines: { font: Font; run: Run }[] = [];
    for (let i = 0; i < 50; i++) {
      let s = "";
      for (let k = 0; s.length < 85; k++) s += words[(i * 7 + k * 3) % words.length] + " ";
      const font = fonts[i % 3];
      lines.push({ font, run: shape(font, s.trim(), 10) });
    }
    const t0 = performance.now();
    const w = createPdfWriter();
    for (let p = 0; p < 200; p++) {
      const page = w.addPage(595.28, 841.89);
      page.destination(`page${p}`, 0, 841.89);
      for (let l = 0; l < 50; l++) {
        const { font, run } = lines[(p + l) % lines.length];
        page.glyphs(font, 10, 72, 770 - l * 13.6, run.gids, run.advances, run.text);
      }
      page.rect(72, 60, 451, 0.5, [0, 0, 0]);
      if (p % 10 === 0) w.outline(`Chapter ${p / 10 + 1}`, 1, `page${p}`);
    }
    w.setInfo({ title: "Performance", date: DATE });
    const t1 = performance.now();
    const bytes = w.finish();
    const t2 = performance.now();
    t.diagnostic(`200 pages: drawing ${(t1 - t0).toFixed(0)} ms, finish ${(t2 - t1).toFixed(0)} ms, ${(bytes.length / 1024).toFixed(0)} KiB`);
    assert.ok(t2 - t0 < 1000, `took ${(t2 - t0).toFixed(0)} ms`);
    parsePdf(bytes);
    produced.push({ name: "performance", bytes });
    const doc = await open(bytes);
    assert.equal(doc.numPages, 200);
    const text = await pageText(doc, 200);
    assert.ok(text.startsWith(lines[199 % 50].run.text.join("")), text.slice(0, 80));
  });
});

// ===========================================================================
// Every PDF produced above, opened with MuPDF when PyMuPDF is installed.

const python = spawnSync("python", ["-c", "import fitz"], { encoding: "utf8" });
const hasFitz = python.status === 0;

describe("PyMuPDF validation", () => {
  it("opens every test PDF without repairs or warnings", { skip: !hasFitz && "PyMuPDF not available" }, () => {
    assert.ok(produced.length >= 20, `${produced.length} PDFs`);
    const dir = mkdtempSync(join(tmpdir(), "texwright-pdf-"));
    try {
      const files = produced.map((p, i) => {
        const f = join(dir, `${String(i).padStart(2, "0")}-${p.name}.pdf`);
        writeFileSync(f, p.bytes);
        return f;
      });
      const script = [
        "import fitz, json, sys, os",
        "fitz.TOOLS.mupdf_display_errors(False)",
        "try:\n    fitz.TOOLS.mupdf_display_warnings(False)\nexcept Exception:\n    pass",
        "out = {}",
        "for f in sys.argv[1:]:",
        "    fitz.TOOLS.reset_mupdf_warnings()",
        "    d = fitz.open(f)",
        "    n = 0",
        "    text = []",
        "    for p in d:",
        "        text.append(p.get_text())",
        "        p.get_pixmap(dpi=20)",
        "        n += 1",
        "    out[os.path.basename(f)] = {'repaired': d.is_repaired, 'pages': n, 'warnings': fitz.TOOLS.mupdf_warnings(), 'text': chr(10).join(text)}",
        "print(json.dumps(out))",
      ].join("\n");
      const r = spawnSync("python", ["-c", script, ...files], { encoding: "utf8", maxBuffer: 1 << 24 });
      assert.equal(r.status, 0, r.stderr);
      const results = JSON.parse(r.stdout) as Record<string, { repaired: boolean; pages: number; warnings: string; text: string }>;
      const norm = (t: string) => t.replace(/\s+/g, " ").trim();
      let checkedText = 0;
      produced.forEach((p, i) => {
        const name = `${String(i).padStart(2, "0")}-${p.name}.pdf`;
        const res = results[name];
        assert.ok(res, name);
        assert.equal(res.repaired, false, `${name} needed repair`);
        assert.equal(res.warnings, "", `${name}: ${res.warnings}`);
        assert.ok(res.pages >= 1, name);
        const want = expectText.get(p.name);
        if (want !== undefined) {
          assert.equal(norm(res.text), norm(want), `${name}: text extracted by MuPDF`);
          checkedText++;
        }
      });
      assert.ok(checkedText >= 3, `${checkedText} texts compared`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
