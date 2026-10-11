/**
 * Page previews: glyph outlines from the font reader, the coverage
 * rasterizer, fills, strokes, clipping, transforms and images on a raster
 * page, the PNG encoder, the baseline JPEG decoder, and whole documents
 * drawn by renderPages.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import { Diagnostics } from "../src/diagnostics.js";
import { type Font, FontError, bundledFont, parseFont } from "../src/font/index.js";
import { FLAVOR_OTTO, buildSfnt } from "../src/font/sfnt.js";
import type { Gradient, PathCommand } from "../src/layout/types.js";
import { documentLayout } from "../src/layoutopts.js";
import { fileContext } from "../src/parse/context.js";
import { parseMarkdown } from "../src/parse/markdown.js";
import type { PdfPage } from "../src/pdf/api.js";
import { PdfError } from "../src/pdf/errors.js";
import { crc32, decodePng } from "../src/pdf/png.js";
import { createRasterWriter, decodeJpeg, encodePng, renderPages } from "../src/raster/index.js";
import { CoverageRasterizer } from "../src/raster/rasterizer.js";
import { processCitations } from "../src/transform/citations.js";
import { numberDocument } from "../src/transform/numbering.js";
import { convertRawLatex } from "../src/transform/rawlatex.js";
import type { PdfInput, PdfLayoutOptions } from "../src/typeset/index.js";

// ---------------------------------------------------------------------------
// Helpers

function timed<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
}

/** Exact bounds of a path: its points plus the extremes of each cubic. */
function pathBounds(path: PathCommand[]): [number, number, number, number] | undefined {
  let b: [number, number, number, number] | undefined;
  const add = (x: number, y: number) => {
    b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
  };
  const extremes = (p0: number, p1: number, p2: number, p3: number) => {
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const bb = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const ts: number[] = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(bb) > 1e-12) ts.push(-c / bb);
    } else {
      const d = bb * bb - 4 * a * c;
      if (d >= 0) ts.push((-bb + Math.sqrt(d)) / (2 * a), (-bb - Math.sqrt(d)) / (2 * a));
    }
    return ts.filter((t) => t > 0 && t < 1).map((t) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3);
  };
  let cx = 0;
  let cy = 0;
  for (const c of path) {
    if (c[0] === "M" || c[0] === "L") {
      add(c[1], c[2]);
      cx = c[1];
      cy = c[2];
    } else if (c[0] === "C") {
      add(c[5], c[6]);
      for (const x of extremes(cx, c[1], c[3], c[5])) add(x, c[6]);
      for (const y of extremes(cy, c[2], c[4], c[6])) add(c[5], y);
      cx = c[5];
      cy = c[6];
    }
  }
  return b;
}

/** Rounds every number in a path, for comparisons. */
const rounded = (path: PathCommand[], digits = 3) => path.map((c) => c.map((v) => (typeof v === "number" ? Number(v.toFixed(digits)) : v)));

// A tiny TrueType font builder: simple glyphs from points, composites from components.

type Pt = [number, number, boolean]; // x, y, on curve

function simpleGlyph(contours: Pt[][]): Uint8Array {
  const pts = contours.flat();
  const n = pts.length;
  const b = new Uint8Array(10 + 2 * contours.length + 2 + 5 * n);
  const v = new DataView(b.buffer);
  v.setInt16(0, contours.length);
  v.setInt16(2, Math.min(...pts.map((p) => p[0])));
  v.setInt16(4, Math.min(...pts.map((p) => p[1])));
  v.setInt16(6, Math.max(...pts.map((p) => p[0])));
  v.setInt16(8, Math.max(...pts.map((p) => p[1])));
  let p = 10;
  let end = -1;
  for (const c of contours) {
    end += c.length;
    v.setUint16(p, end);
    p += 2;
  }
  p += 2; // no instructions
  for (const q of pts) b[p++] = q[2] ? 1 : 0; // coordinates as 16-bit deltas
  let prev = 0;
  for (const q of pts) {
    v.setInt16(p, q[0] - prev);
    prev = q[0];
    p += 2;
  }
  prev = 0;
  for (const q of pts) {
    v.setInt16(p, q[1] - prev);
    prev = q[1];
    p += 2;
  }
  return b;
}

interface Component {
  gid: number;
  dx?: number;
  dy?: number;
  /** Point matching: [point in the composite so far, point in this component]. */
  match?: [number, number];
  scale?: number;
  /** xscale, scale01, scale10, yscale */
  matrix?: [number, number, number, number];
}

function compositeGlyph(parts: Component[]): Uint8Array {
  const bytes = [0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0];
  const w16 = (v: number) => bytes.push((v >> 8) & 255, v & 255);
  parts.forEach((c, i) => {
    let flags = 0x0001; // 16-bit arguments
    if (!c.match) flags |= 0x0002;
    if (c.scale !== undefined) flags |= 0x0008;
    if (c.matrix) flags |= 0x0080;
    if (i < parts.length - 1) flags |= 0x0020;
    w16(flags);
    w16(c.gid);
    const [a1, a2] = c.match ?? [c.dx ?? 0, c.dy ?? 0];
    w16(a1 & 0xffff);
    w16(a2 & 0xffff);
    const f2 = (v: number) => w16(Math.round(v * 16384) & 0xffff);
    if (c.scale !== undefined) f2(c.scale);
    c.matrix?.forEach(f2);
  });
  return Uint8Array.from(bytes);
}

/** A TrueType font; each glyph's left side bearing is its xMin unless `lsb` says otherwise. */
function trueTypeFont(glyphs: Uint8Array[], lsb: (gid: number, xMin: number) => number = (_g, x) => x): Font {
  const n = glyphs.length;
  const offsets: number[] = [];
  let size = 0;
  for (const g of glyphs) {
    offsets.push(size);
    size += (g.length + 3) & ~3;
  }
  offsets.push(size);
  const glyf = new Uint8Array(size);
  glyphs.forEach((g, i) => glyf.set(g, offsets[i]));
  const loca = new Uint8Array(4 * (n + 1));
  offsets.forEach((o, i) => new DataView(loca.buffer).setUint32(4 * i, o));
  const head = new Uint8Array(54);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x00010000);
  hv.setUint32(12, 0x5f0f3cf5);
  hv.setUint16(18, 1000);
  hv.setInt16(50, 1); // long loca offsets
  const hhea = new Uint8Array(36);
  new DataView(hhea.buffer).setInt16(4, 800);
  new DataView(hhea.buffer).setInt16(6, -200);
  new DataView(hhea.buffer).setUint16(34, n);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint32(0, 0x00005000);
  new DataView(maxp.buffer).setUint16(4, n);
  const hmtx = new Uint8Array(4 * n);
  glyphs.forEach((g, i) => {
    const xMin = g.length >= 10 ? new DataView(g.buffer, g.byteOffset).getInt16(2) : 0;
    new DataView(hmtx.buffer).setUint16(4 * i, 600);
    new DataView(hmtx.buffer).setInt16(4 * i + 2, lsb(i, xMin));
  });
  return parseFont(
    buildSfnt([
      { tag: "head", data: head },
      { tag: "hhea", data: hhea },
      { tag: "maxp", data: maxp },
      { tag: "hmtx", data: hmtx },
      { tag: "loca", data: loca },
      { tag: "glyf", data: glyf },
    ]),
  );
}

// A tiny CFF font builder (charstrings, local and global subroutines).

const n16 = (v: number) => [28, (v >> 8) & 255, v & 255];
const int5 = (v: number) => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function cffIndex(items: number[][]): number[] {
  if (!items.length) return [0, 0];
  const out = [(items.length >> 8) & 255, items.length & 255, 4];
  let off = 1;
  const offsets = [off];
  for (const it of items) offsets.push((off += it.length));
  for (const o of offsets) out.push((o >>> 24) & 255, (o >>> 16) & 255, (o >>> 8) & 255, o & 255);
  for (const it of items) out.push(...it);
  return out;
}

function cffFont(charstrings: number[][], subrs: number[][]): Font {
  const name = cffIndex([[...new TextEncoder().encode("Test")]]);
  const strings = cffIndex([]);
  const global = cffIndex([]);
  const chars = cffIndex(charstrings);
  const topSize = 2 + 1 + 8 + 17;
  const charStringsOffset = 4 + name.length + topSize + strings.length + global.length;
  const privateOffset = charStringsOffset + chars.length;
  const privateDict = [...int5(6), 19];
  const top = cffIndex([[...int5(charStringsOffset), 17, ...int5(privateDict.length), ...int5(privateOffset), 18]]);
  const cff = [1, 0, 4, 4, ...name, ...top, ...strings, ...global, ...chars, ...privateDict, ...cffIndex(subrs)];
  const head = new Uint8Array(54);
  new DataView(head.buffer).setUint32(0, 0x00010000);
  new DataView(head.buffer).setUint32(12, 0x5f0f3cf5);
  new DataView(head.buffer).setUint16(18, 1000);
  const hhea = new Uint8Array(36);
  new DataView(hhea.buffer).setUint16(34, 1);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint32(0, 0x00005000);
  new DataView(maxp.buffer).setUint16(4, charstrings.length);
  const hmtx = new Uint8Array(4 + 2 * (charstrings.length - 1));
  return parseFont(
    buildSfnt(
      [
        { tag: "head", data: head },
        { tag: "hhea", data: hhea },
        { tag: "maxp", data: maxp },
        { tag: "hmtx", data: hmtx },
        { tag: "CFF ", data: new Uint8Array(cff) },
      ],
      FLAVOR_OTTO,
    ),
  );
}

// Coverage straight from the rasterizer.

function coverage(w: number, h: number, add: (r: CoverageRasterizer) => void, evenOdd = false): Float64Array {
  const r = new CoverageRasterizer(w, h);
  add(r);
  const out = new Float64Array(w * h);
  r.sweep(evenOdd, (y, x0, x1, cov) => {
    for (let x = x0; x < x1; x++) out[y * w + x] = cov[x];
  });
  return out;
}

/** A closed polygon from x, y pairs. */
function polygon(r: CoverageRasterizer, pts: number[]): void {
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    r.line(pts[i], pts[i + 1], pts[j], pts[j + 1]);
  }
}

const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);

// A raster page at 72 dpi (one pixel per point, y up in page space).

interface Drawn {
  w: number;
  h: number;
  rgb: Uint8Array;
  /** Darkness of a pixel's red channel, 0 (white) to 1. */
  ink(x: number, y: number): number;
  /** Total darkness. */
  total(): number;
  pixel(x: number, y: number): [number, number, number];
}

function draw(width: number, height: number, fn: (p: PdfPage, add: (bytes: Uint8Array) => ReturnType<ReturnType<typeof createRasterWriter>["addImage"]>) => void): Drawn {
  const writer = createRasterWriter({ dpi: 72 });
  const page = writer.addPage(width, height);
  fn(page, (bytes) => writer.addImage(bytes));
  writer.finish();
  const png = decodePng(writer.pages[0].png());
  assert.equal(png.color, "rgb");
  const rgb = png.pixels!;
  const w = png.width;
  const ink = (x: number, y: number) => 1 - rgb[3 * (y * w + x)] / 255;
  return {
    w,
    h: png.height,
    rgb,
    ink,
    total: () => {
      let t = 0;
      for (let i = 0; i < rgb.length; i += 3) t += 1 - rgb[i] / 255;
      return t;
    },
    pixel: (x, y) => [rgb[3 * (y * w + x)], rgb[3 * (y * w + x) + 1], rgb[3 * (y * w + x) + 2]],
  };
}

const rectPath = (x0: number, y0: number, x1: number, y1: number): PathCommand[] => [["M", x0, y0], ["L", x1, y0], ["L", x1, y1], ["L", x0, y1], ["Z"]];
const BLACK: [number, number, number] = [0, 0, 0];

/** An 8-bit RGBA PNG. */
function rgbaPng(w: number, h: number, rgba: number[]): Uint8Array {
  const raw = new Uint8Array(h * (4 * w + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.slice(4 * w * y, 4 * w * (y + 1)), y * (4 * w + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const c = new Uint8Array(12 + data.length);
    const v = new DataView(c.buffer);
    v.setUint32(0, data.length);
    c.set(new TextEncoder().encode(type), 4);
    c.set(data, 8);
    v.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
    return c;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]));
}

// JPEG fixtures written by Pillow (libjpeg): a 40 x 24 image in four flat
// quadrants, (200,40,40) (40,160,60) / (30,60,200) (240,240,240).
const JPEG = {
  q444: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAYACgDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5fr8TP9QAoA7L4Sf8xD/tl/7PWNXof57/AE7/APmnf+5v/wB1TsqxP89woA+cf+Fmf9QT/wAmf/sa/tj/AIlG/wCp1/5bf/dz/Tz/AInA/wCpJ/5c/wD3uH/CzP8AqCf+TP8A9jR/xKN/1Ov/AC2/+7h/xOB/1JP/AC5/+9z7G/4JMfsf/wDDef8Awn//ABcT/hFP+EU/sr/mEfbvtX2r7Z/01i2bfs/+1nf2xz+Y+I/gP/qJ9V/4Ufbe25/+XPJbk5P+nsr35vK1utz8V8YOMf8AiYL6j+4+pfUva/a9tz+29n/dpcvL7L+9fm6W1+xv+HGf/V0X/lk//dtfmP8AqT/1Ef8Akn/2x+K/8Qh/6jf/ACn/APdA/wCHGf8A1dF/5ZP/AN20f6k/9RH/AJJ/9sH/ABCH/qN/8p//AHQ/Emv9aACgD9Wv+DYz/mt3/ctf+5Wv5p+kR/zLP+43/uI+04Q/5f8A/bv/ALcfq1X80n2gUAf/2Q==",
  q422: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAYACgDASEAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5for8TP8AUA7L4Sf8xD/tl/7PXZVzVPjZ/jn9Kn/k/Wcf9y//AKi0AoqD+ez5x/4WZ/1BP/Jn/wCxo/4WZ/1BP/Jn/wCxr+2P+JRv+p1/5bf/AHc/08/4nA/6kn/lz/8Ae59jf8EmP2P/APhvP/hP/wDi4n/CKf8ACKf2V/zCPt32r7V9s/6axbNv2f8A2s7+2Ofsb/hxn/1dF/5ZP/3bX4Vxl4Uf6q8SV8r+ue09ny+97PlvzQjPbnla3Nbd7X8j+YPETKP+IucY4rizn+rfWeT91b2nL7OnCl8d6fNzez5vgVr21tdn/DjP/q6L/wAsn/7tor5j/Un/AKiP/JP/ALY+K/4hD/1G/wDlP/7ofiTRX+tAH6tf8Gxn/Nbv+5a/9ytfq1X8PeMH/Jxcd/3C/wDTNM/TuHv+RPS/7e/9KYUV+aHtH//Z",
  q420restart: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAYACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAB/9oADAMBAAIRAxEAPwD5forlf+Fmf9QT/wAmf/saP+Fmf9QT/wAmf/sax/4l88Xv+hb/AOVsP/8ALT+1v+JiPB3/AKGf/lHEf/Kj/9DxH4Sf8xD/ALZf+z12Vdx/wSY/Y/8A+G8/+E//AOLif8Ip/wAIp/ZX/MI+3favtX2z/prFs2/Z/wDazv7Y5+xv+HGf/V0X/lk//dtfnWd8A8WZDmdTA47DclWFuaPPTdrxUlrGTWzT0f4n5/475fjPEHxWzHP8gj7fCV/Y8k7qHNyUKVOXu1HCatOElrFXtdXTTf8A/9Hg6K+/v+HGf/V0X/lk/wD3bRX5L/qznn/Pr/yaP/yR/Mf/ABDzjD/oG/8AJ6f/AMmf/9L4Looor/Sw/Fz/0/Zv+DYz/mt3/ctf+5Wv1aoor9L8YP8Ak4uO/wC4X/pmmeLw9/yJ6X/b3/pTP//U/cCiiigD/9k=",
  gray: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/wAALCAAYACgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APl+iuy+En/MQ/7Zf+z12VFfOP8Awsz/AKgn/kz/APY0f8LM/wCoJ/5M/wD2NfY3/BJj9j//AIbz/wCE/wD+Lif8Ip/win9lf8wj7d9q+1fbP+msWzb9n/2s7+2Ofsb/AIcZ/wDV0X/lk/8A3bR/w4z/AOrov/LJ/wDu2vxJor9Wv+DYz/mt3/ctf+5Wv1aor//Z",
  cmyk: "/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwACAQEBAQECAQEBAgICAgIEAwICAgIFBAQDBAYFBgYGBQYGBgcJCAYHCQcGBggLCAkKCgoKCgYICwwLCgwJCgoK/8AAFAgAGAAoBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD9IK/J+vyfr9/KKKKK/L//AIORP+aM/wDcxf8AuMr7w/4Imf8ANTP+4L/7fV1Hw2/5ff8Atn/7NRX5f194V1FFFFFFfpZ/xE0f9WT/APmSP/vbX4j/APCtv+o1/wCS3/2VfeH/ABDd/wDV5n/mO/8A74UUf8RNH/Vk/wD5kj/720f8K2/6jX/kt/8AZUf8Q3f/AFeZ/wCY7/8AvhRXZfCTwT/xEwf2h/xM/wDhSn/ClPK/5Y/8JJ/bP9sb/wDasvs/k/2X/wBNN/n/AMGz5v0s/wCDd/8AZK/4XH/wt/8A4uB/Z39nf8I//wAwrzvM8z+0v+mq4xs9859q7z4Jf8Gy/wDwkP8Aaf8Axmx5Pk+T/wA033Zz5n/USHpRXZf8QlX/AFf/AP8AmKv/AL61+ln/AA7d/wCqzf8Alu//AHRXef8AELn/ANXy/wDmMv8A750Uf8QlX/V//wD5ir/760f8O3f+qzf+W7/90Uf8Quf/AFfL/wCYy/8AvnRX4j1/OfX2RRRRRRX7Sf8ABoN/zcN/3KX/ALma/Wj/AINcv+a5/wDcs/8AuWr1D9m7/mNf9u3/ALVor9pK/WivUKKKKKK//9k=",
  progressive:
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wgARCAAYACgDASIAAhEBAxEB/8QAGAABAAMBAAAAAAAAAAAAAAAAAAUHCAb/xAAZAQACAwEAAAAAAAAAAAAAAAAEBgIHCAX/2gAMAwEAAhADEAAAAavRSF19dMzlxr+dKAX+FUcSDYfa1bq0o5nBaN//xAAcEAACAQUBAAAAAAAAAAAAAAAAEBUFBgcIFxb/2gAIAQEAAQUCVJcmSZiaz/eHDDhj1jf/xAArEQAAAwUDDQAAAAAAAAAAAAABAgQAAwUGERASMRYXITRBU1SBoaKx0dL/2gAIAQMBAT8BziSdxPY8+WntO+mCa1C9AF90e5QcK0IUo6DUHEB2Nk9GN31L7sh+pl5+bP/EACoRAAAEAwMNAAAAAAAAAAAAAAECAwQABREGEBUXMTZBUVJUgqGistHS/9oACAECAQE/Acn1r+G70/qHsgmzByZBdOhgzhUuyuoYwx9u9Q93Ww0iX5fAt3//xAAoEAAAAwMMAwAAAAAAAAAAAAAAEBIUMzYBAwQFEyVDUmGipOKBhMP/2gAIAQEABj8CKc8G53BzuFPvFlZbLCWpS9ZMoijhdxFHC7nXfrfU/wD/xAAdEAABAwUBAAAAAAAAAAAAAADwABDxETAxYXGB/9oACAEBAAE/IWJ64wQwRbe0U6zYZs//2gAMAwEAAgADAAAAEAAgAAgP/8QAGxEBAAICAwAAAAAAAAAAAAAAARARAEEhYfD/2gAIAQMBAT8Qwncu7N3A6NyLqyxFi31do//EABoRAQEAAgMAAAAAAAAAAAAAAAEhABEgMaH/2gAIAQIBAT8QyGRH0tbAqHSMfeJCn//EABkQAAEFAAAAAAAAAAAAAAAAACARIVHw8f/aAAgBAQABPxA7Zrbw3iKOYjf/2Q==",
};
const jpeg = (k: keyof typeof JPEG) => new Uint8Array(Buffer.from(JPEG[k], "base64"));
const QUADRANTS = [
  [200, 40, 40],
  [40, 160, 60],
  [30, 60, 200],
  [240, 240, 240],
];

/** Parses and transforms a Markdown file the way convert() does, ready for renderPages. */
function prepare(file: string): { input: PdfInput; layout: PdfLayoutOptions } {
  const diagnostics = new Diagnostics();
  const ctx = fileContext(file, diagnostics);
  const doc = parseMarkdown(readFileSync(file, "utf8"), ctx);
  convertRawLatex(doc, ctx);
  const numbering = numberDocument(doc, diagnostics);
  const citations = processCitations(doc, [], diagnostics);
  const l = documentLayout({}, doc.meta, diagnostics);
  return {
    input: { doc, numbering, citations, macros: {}, diagnostics },
    layout: {
      theme: l.theme ?? "article",
      paper: l.paper ?? "letter",
      landscape: !!l.landscape,
      margin: l.margin ?? "1in",
      images: { baseDir: ctx.baseDir, allowPaths: [], allowNet: false, embed: false },
    },
  };
}

// ---------------------------------------------------------------------------

describe("glyph outlines", () => {
  it("bound CFF glyphs exactly as Font.bounds does, every contour closed", () => {
    const font = bundledFont("LMRoman", "Regular");
    assert.equal(font.outlines, "cff");
    let drawn = 0;
    for (let g = 0; g < font.glyphCount; g++) {
      const path = font.outline(g);
      const b = pathBounds(path);
      const fb = font.bounds(g);
      if (!b) {
        assert.deepEqual(fb, { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }, `glyph ${g}`);
        continue;
      }
      drawn++;
      assert.deepEqual([Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])], [fb.xMin, fb.yMin, fb.xMax, fb.yMax], `glyph ${g}`);
      assert.equal(path[0][0], "M");
      assert.equal(path[path.length - 1][0], "Z");
      assert.equal(path.filter((c) => c[0] === "M").length, path.filter((c) => c[0] === "Z").length);
    }
    assert.ok(drawn > 500, `${drawn} glyphs with outlines`);
  });

  it("keep TrueType glyphs inside their header boxes, touching them almost always", () => {
    const font = bundledFont("Main", "Regular");
    assert.equal(font.outlines, "truetype");
    let same = 0;
    let drawn = 0;
    for (let g = 0; g < font.glyphCount; g++) {
      const b = pathBounds(font.outline(g));
      if (!b) continue;
      drawn++;
      const h = font.bounds(g);
      // Off-curve points may stick out of the curve, so the header box can be larger, never smaller.
      assert.ok(b[0] >= h.xMin - 1 && b[1] >= h.yMin - 1 && b[2] <= h.xMax + 1 && b[3] <= h.yMax + 1, `glyph ${g}`);
      if (Math.floor(b[0]) === h.xMin && Math.floor(b[1]) === h.yMin && Math.ceil(b[2]) === h.xMax && Math.ceil(b[3]) === h.yMax) same++;
    }
    assert.ok(same / drawn > 0.8, `${same} of ${drawn}`);
  });

  it("turn quadratic segments into the same curves as cubics", () => {
    const font = trueTypeFont([
      new Uint8Array(0),
      simpleGlyph([
        [
          [0, 0, true],
          [100, 200, false],
          [200, 0, true],
        ],
      ]),
      // Only off-curve points: on-curve points are implied midway, starting between the last and the first.
      simpleGlyph([
        [
          [0, 100, false],
          [100, 0, false],
          [0, -100, false],
          [-100, 0, false],
        ],
      ]),
    ]);
    assert.deepEqual(rounded(font.outline(1)), [["M", 0, 0], ["C", 66.667, 133.333, 133.333, 133.333, 200, 0], ["Z"]]);
    const ring = font.outline(2);
    assert.deepEqual(ring[0], ["M", -50, 50]);
    assert.equal(ring.filter((c) => c[0] === "C").length, 4);
    assert.deepEqual(rounded(ring.slice(1, 2)), [["C", -16.667, 83.333, 16.667, 83.333, 50, 50]]);
    assert.deepEqual(ring[ring.length - 2].slice(5), [-50, 50]);
    // A cubic made from (p0, q, p1) passes through the quadratic's midpoint p0/4 + q/2 + p1/4.
    const [, x1, y1, x2, y2, x3, y3] = font.outline(1)[1] as Extract<PathCommand, ["C", ...number[]]>;
    assert.ok(Math.abs((0 + 3 * x1 + 3 * x2 + x3) / 8 - 100) < 1e-9 && Math.abs((0 + 3 * y1 + 3 * y2 + y3) / 8 - 100) < 1e-9);
  });

  it("assemble composites with offsets, scales, 2x2 transforms and matched points", () => {
    const square = simpleGlyph([
      [
        [0, 0, true],
        [100, 0, true],
        [100, 100, true],
        [0, 100, true],
      ],
    ]);
    const font = trueTypeFont([
      new Uint8Array(0),
      square,
      compositeGlyph([
        { gid: 1, dx: 300, dy: 50, scale: 0.5 },
        { gid: 1, matrix: [0, 1, -1, 0] }, // a quarter turn: (x, y) -> (-y, x)
      ]),
      compositeGlyph([{ gid: 1 }, { gid: 1, match: [2, 0] }]), // the second square's corner on the first's top right
    ]);
    assert.deepEqual(rounded(font.outline(2)), [
      ["M", 300, 50],
      ["L", 350, 50],
      ["L", 350, 100],
      ["L", 300, 100],
      ["Z"],
      ["M", 0, 0],
      ["L", 0, 100],
      ["L", -100, 100],
      ["L", -100, 0],
      ["Z"],
    ]);
    assert.deepEqual(font.outline(3).slice(5), [["M", 100, 100], ["L", 200, 100], ["L", 200, 200], ["L", 100, 200], ["Z"]]);
  });

  it("place a simple glyph at its left side bearing, but not as a component", () => {
    const square = simpleGlyph([
      [
        [10, 0, true],
        [110, 0, true],
        [110, 100, true],
      ],
    ]);
    const font = trueTypeFont([new Uint8Array(0), square, compositeGlyph([{ gid: 1 }])], (g, xMin) => (g === 1 ? xMin + 7 : xMin));
    assert.deepEqual(font.outline(1)[0], ["M", 17, 0]);
    assert.deepEqual(font.outline(2)[0], ["M", 10, 0]);
  });

  it("stop hostile composite glyphs with FontError, quickly", () => {
    const leaf = simpleGlyph([
      [
        [0, 0, true],
        [10, 0, true],
        [10, 10, true],
      ],
    ]);
    // 1: cycle; 2..41: each uses the next twice (2^40 copies); 42..111: nested 70 deep.
    const glyphs: Uint8Array[] = [leaf, compositeGlyph([{ gid: 1 }])];
    for (let k = 2; k <= 41; k++) glyphs.push(compositeGlyph([{ gid: k + 1 }, { gid: k + 1 }]));
    for (let k = 42; k <= 111; k++) glyphs.push(compositeGlyph([{ gid: k + 1 }]));
    glyphs[42] = compositeGlyph([{ gid: 0 }]); // the fan-out ends in the leaf
    glyphs.push(compositeGlyph([{ gid: 0 }]));
    const font = trueTypeFont(glyphs);
    assert.throws(() => font.outline(1), (e: unknown) => e instanceof FontError && /itself|cycle/.test((e as Error).message));
    const [, ms] = timed(() => assert.throws(() => font.outline(2), FontError));
    assert.ok(ms < 2000, `${ms} ms`);
    assert.throws(() => font.outline(43), (e: unknown) => e instanceof FontError && /nested/.test((e as Error).message));
    assert.equal(font.outline(0).length, 4);
  });

  it("run CFF charstrings into paths, and stop runaway ones with FontError", () => {
    const subr = (i: number) => n16(i - 107);
    const chain: number[][] = [];
    for (let k = 1; k <= 7; k++) {
      const body: number[] = [];
      for (let i = 0; i < 100; i++) body.push(...subr(k + 1), 10);
      chain.push([...body, 11]);
    }
    const font = cffFont(
      [
        [14],
        // width, rmoveto 100 0, a 300 x 500 rectangle
        [...n16(600), ...n16(100), ...n16(0), 21, ...n16(300), ...n16(0), 5, ...n16(0), ...n16(500), 5, ...n16(-300), ...n16(0), 5, 14],
        // two contours: the second moveto closes the first
        [...n16(0), ...n16(0), 21, ...n16(10), ...n16(0), 5, ...n16(0), ...n16(10), 5, ...n16(100), ...n16(0), 21, ...n16(0), ...n16(200), ...n16(200), ...n16(0), ...n16(0), ...n16(-200), 8, 14],
        [...n16(0), ...n16(0), 21, ...subr(0), 10, 14], // endless recursion
        [...n16(0), ...n16(0), 21, ...subr(1), 10, 14], // exponential fan-out
      ],
      [[...subr(0), 10, 11], ...chain, [11]],
    );
    assert.deepEqual(font.outline(0), []);
    assert.deepEqual(font.outline(1), [["M", 100, 0], ["L", 400, 0], ["L", 400, 500], ["L", 100, 500], ["Z"]]);
    assert.deepEqual(font.outline(2), [["M", 0, 0], ["L", 10, 0], ["L", 10, 10], ["Z"], ["M", 110, 10], ["C", 110, 210, 310, 210, 310, 10], ["Z"]]);
    const [, ms1] = timed(() => assert.throws(() => font.outline(3), (e: unknown) => e instanceof FontError && /nested/.test((e as Error).message)));
    const [, ms2] = timed(() => assert.throws(() => font.outline(4), (e: unknown) => e instanceof FontError && /operations/.test((e as Error).message)));
    assert.ok(ms1 < 200 && ms2 < 2000, `${ms1} ms, ${ms2} ms`);
    assert.deepEqual(font.outline(99), [], "an id outside the font draws nothing");
  });
});

describe("coverage rasterizer", () => {
  it("gives a square exact coverage at its edges, corners and inside", () => {
    const c = coverage(10, 10, (r) => polygon(r, [2.25, 3.5, 6.75, 3.5, 6.75, 7, 2.25, 7]));
    const at = (x: number, y: number) => c[y * 10 + x];
    assert.equal(at(4, 5), 1);
    assert.ok(Math.abs(at(2, 5) - 0.75) < 1e-6, `left edge ${at(2, 5)}`);
    assert.ok(Math.abs(at(6, 5) - 0.75) < 1e-6, `right edge ${at(6, 5)}`);
    assert.ok(Math.abs(at(4, 3) - 0.5) < 1e-6, `top edge ${at(4, 3)}`);
    assert.equal(at(4, 6), 1, "the bottom edge lies on a pixel boundary");
    assert.ok(Math.abs(at(2, 3) - 0.375) < 1e-6 && Math.abs(at(6, 3) - 0.375) < 1e-6, "corners");
    assert.equal(at(4, 7), 0);
    assert.equal(at(1, 5), 0);
    assert.ok(Math.abs(sum(c) - 4.5 * 3.5) < 1e-5);
  });

  it("splits pixels on a diagonal edge by area", () => {
    const c = coverage(6, 6, (r) => polygon(r, [0, 0, 4, 0, 0, 4]));
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(c[k * 6 + (3 - k)] - 0.5) < 1e-6, `pixel ${3 - k},${k}`);
    assert.equal(c[0], 1);
    assert.ok(Math.abs(sum(c) - 8) < 1e-5);
  });

  it("fills nested contours by the nonzero or even-odd rule", () => {
    const outer = [1, 1, 9, 1, 9, 9, 1, 9];
    const inner = [3, 3, 7, 3, 7, 7, 3, 7];
    const innerReversed = [3, 3, 3, 7, 7, 7, 7, 3];
    const same = (evenOdd: boolean) => coverage(10, 10, (r) => (polygon(r, outer), polygon(r, inner)), evenOdd);
    assert.equal(same(false)[5 * 10 + 5], 1, "nonzero: same direction fills the middle");
    assert.equal(same(true)[5 * 10 + 5], 0, "even-odd: the middle is a hole");
    const opposite = coverage(10, 10, (r) => (polygon(r, outer), polygon(r, innerReversed)));
    assert.equal(opposite[5 * 10 + 5], 0, "nonzero: opposite direction cuts a hole");
    for (const c of [same(false), same(true), opposite]) assert.equal(c[2 * 10 + 2], 1);
  });

  it("clips edges outside the canvas without changing what is inside", () => {
    const c = coverage(10, 10, (r) => polygon(r, [-5, -5, 5, -5, 5, 5, -5, 5]));
    assert.equal(sum(c), 25);
    assert.equal(c[4 * 10 + 4], 1);
    assert.equal(c[4 * 10 + 5], 0);
    const huge = coverage(10, 10, (r) => polygon(r, [-1e9, 2, 1e9, 2, 1e9, 4, -1e9, 4]));
    assert.equal(sum(huge), 20);
    assert.equal(sum(coverage(10, 10, (r) => polygon(r, [20, 0, 30, 0, 30, 10]))), 0);
  });
});

describe("raster pages", () => {
  it("paint gradients, opacity, groups, soft masks and blend modes", () => {
    const red: [number, number, number] = [1, 0, 0];
    const d = draw(100, 50, (p) => {
      p.path(rectPath(0, 40, 100, 50), {
        fill: {
          kind: "linear",
          coords: [0, 0, 100, 0],
          matrix: [1, 0, 0, 1, 0, 0],
          stops: [
            { offset: 0, color: [1, 0, 0] },
            { offset: 1, color: [0, 0, 1] },
          ],
          spread: "pad",
        },
      });
      p.path(rectPath(0, 30, 100, 40), { fill: BLACK, fillAlpha: 0.5 });
      // Overlapping shapes in a group at half opacity: one even grey, no darker overlap.
      p.group({ bbox: [0, 20, 100, 30], opacity: 0.5 }, () => {
        p.path(rectPath(0, 20, 60, 30), { fill: BLACK });
        p.path(rectPath(40, 20, 100, 30), { fill: BLACK });
      });
      // A luminance mask: white shows, black hides.
      p.group({ bbox: [0, 10, 100, 20], mask: { luminance: true, draw: () => p.path(rectPath(0, 10, 50, 20), { fill: [1, 1, 1] }) } }, () => p.path(rectPath(0, 10, 100, 20), { fill: BLACK }));
      // Multiply: cyan over red is black; screen: blue over red is magenta.
      p.path(rectPath(0, 0, 100, 10), { fill: red });
      p.group({ bbox: [0, 0, 50, 10], blend: "multiply" }, () => p.path(rectPath(0, 0, 50, 10), { fill: [0, 1, 1] }));
      p.group({ bbox: [50, 0, 100, 10], blend: "screen" }, () => p.path(rectPath(50, 0, 100, 10), { fill: [0, 0, 1] }));
    });
    const near = (a: number[], b: number[], tol = 3) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), `${a} vs ${b}`);
    near(d.pixel(0, 5), [254, 0, 1]);
    near(d.pixel(99, 5), [1, 0, 254]);
    near(d.pixel(50, 5), [126, 0, 129]);
    near(d.pixel(50, 15), [128, 128, 128]);
    near(d.pixel(10, 25), [128, 128, 128]);
    near(d.pixel(50, 25), [128, 128, 128]);
    near(d.pixel(25, 35), [0, 0, 0]);
    near(d.pixel(75, 35), [255, 255, 255]);
    near(d.pixel(25, 45), [0, 0, 0]);
    near(d.pixel(75, 45), [255, 0, 255]);
  });

  it("repeat and reflect gradients, and draw radial ones from their focal point", () => {
    const g = (spread: "repeat" | "reflect"): Gradient => ({
      kind: "linear",
      coords: [0, 0, 10, 0],
      matrix: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: [0, 0, 0] },
        { offset: 1, color: [1, 1, 1] },
      ],
      spread,
    });
    const d = draw(40, 30, (p) => {
      p.path(rectPath(0, 20, 40, 30), { fill: g("repeat") });
      p.path(rectPath(0, 10, 40, 20), { fill: g("reflect") });
      p.path(rectPath(0, 0, 40, 10), { fill: { kind: "radial", coords: [20, 5, 0, 20, 5, 10], matrix: [1, 0, 0, 1, 0, 0], stops: [{ offset: 0, color: [1, 1, 1] }, { offset: 1, color: [0, 0, 0] }], spread: "pad" } });
    });
    // Repeat: dark again just after each period; reflect: light on both sides of x = 10.
    assert.ok(d.ink(11, 5) > 0.8 && d.ink(9, 5) < 0.2);
    assert.ok(d.ink(11, 15) < 0.2 && d.ink(9, 15) < 0.2 && d.ink(19, 15) > 0.8);
    assert.ok(d.ink(20, 25) < 0.15 && d.ink(2, 25) > 0.9, "white at the centre, black past the radius");
  });

  it("draw transparent pages, keeping alpha in the PNG", () => {
    const writer = createRasterWriter({ dpi: 72, transparent: true });
    const page = writer.addPage(10, 10);
    page.path(rectPath(0, 0, 5, 10), { fill: [1, 0, 0], fillAlpha: 0.5 });
    writer.finish();
    const png = decodePng(writer.pages[0].png());
    assert.equal(png.color, "rgb");
    assert.ok(png.alpha);
    assert.equal(png.alpha![0], 128);
    assert.equal(png.alpha![9], 0);
    assert.deepEqual([...png.pixels!.slice(0, 3)], [255, 0, 0], "colour is stored unpremultiplied");
  });

  it("fill paths in page space, y up", () => {
    const d = draw(30, 30, (p) => p.path(rectPath(10, 10, 20, 20), { fill: BLACK }));
    assert.equal(d.w, 30);
    assert.equal(d.ink(15, 15), 1);
    assert.equal(d.ink(10, 10), 1);
    assert.equal(d.ink(9, 15), 0);
    assert.equal(d.ink(15, 20), 0);
    assert.equal(Math.round(d.total()), 100);
    const tall = draw(30, 30, (p) => p.path(rectPath(0, 0, 5, 30), { fill: BLACK }));
    assert.equal(tall.ink(2, 0), 1);
  });

  it("leave a hole with the even-odd rule", () => {
    const d = draw(20, 20, (p) => p.path([...rectPath(2, 2, 18, 18), ...rectPath(6, 6, 14, 14)], { fill: BLACK, evenOdd: true }));
    assert.equal(d.ink(10, 10), 0);
    assert.equal(d.ink(3, 10), 1);
    assert.equal(Math.round(d.total()), 16 * 16 - 8 * 8);
  });

  it("stroke lines at their width", () => {
    // A diagonal line, butt caps: ink equals length times width.
    const diag = draw(100, 100, (p) => p.path([["M", 10, 10], ["L", 90, 90]], { stroke: BLACK, lineWidth: 4 }));
    const expected = Math.hypot(80, 80) * 4;
    assert.ok(Math.abs(diag.total() - expected) < expected * 0.01, `${diag.total()} vs ${expected}`);
    // A horizontal rule lands on whole pixel rows.
    const rule = draw(40, 40, (p) => p.path([["M", 5, 20], ["L", 35, 20]], { stroke: BLACK, lineWidth: 3 }));
    for (const y of [19, 20, 21]) assert.equal(rule.ink(10, y), 1, `row ${y}`);
    assert.equal(rule.ink(10, 18), 0);
    assert.equal(rule.ink(10, 22), 0);
    assert.equal(rule.ink(4, 20), 0, "butt caps stop at the end points");
    assert.equal(Math.round(rule.total()), 90);
    // Width 0 is one pixel.
    const hair = draw(40, 40, (p) => p.path([["M", 5, 20.3], ["L", 35, 20.3]], { stroke: BLACK, lineWidth: 0 }));
    assert.equal(Math.round(hair.total()), 30);
    // A thin rule fills one whole row rather than two faint ones.
    const thin = draw(40, 40, (p) => p.rect(5, 19.7, 30, 0.4, BLACK));
    assert.equal(Math.round(thin.total()), 30);
    assert.equal(thin.ink(10, 20), 1);
  });

  it("draw caps, joins and dashes", () => {
    // A zero-length subpath shows as a dot with round caps only.
    const dot = draw(40, 40, (p) => p.path([["M", 20, 20], ["L", 20, 20]], { stroke: BLACK, lineWidth: 10, lineCap: 1 }));
    assert.ok(Math.abs(dot.total() - Math.PI * 25) < 2, `dot ${dot.total()}`);
    assert.equal(draw(40, 40, (p) => p.path([["M", 20, 20], ["L", 20, 20]], { stroke: BLACK, lineWidth: 10 })).total(), 0);
    // Square caps add half the width at each end.
    const square = draw(60, 40, (p) => p.path([["M", 10, 20], ["L", 50, 20]], { stroke: BLACK, lineWidth: 4, lineCap: 2 }));
    assert.equal(Math.round(square.total()), 44 * 4);
    // A right-angle corner: the miter fills the corner square, a bevel cuts it in half.
    const corner: PathCommand[] = [["M", 10, 10], ["L", 30, 10], ["L", 30, 30]];
    const tilt = (m: PathCommand[]) => m.map((c) => (c[0] === "Z" ? c : ([c[0], c[1] + 0.25 * c[2], c[2]] as PathCommand)));
    const miter = draw(50, 50, (p) => p.path(tilt(corner), { stroke: BLACK, lineWidth: 6, lineJoin: 0 })).total();
    const bevel = draw(50, 50, (p) => p.path(tilt(corner), { stroke: BLACK, lineWidth: 6, lineJoin: 2 })).total();
    const round = draw(50, 50, (p) => p.path(tilt(corner), { stroke: BLACK, lineWidth: 6, lineJoin: 1 })).total();
    assert.ok(miter > round && round > bevel, `miter ${miter}, round ${round}, bevel ${bevel}`);
    // Dashes: 5 on, 5 off.
    const dashed = draw(40, 20, (p) => p.path([["M", 0, 10.5], ["L", 40, 10.5]], { stroke: BLACK, lineWidth: 1, dash: [5, 5] }));
    assert.equal(dashed.ink(2, 9), 1);
    assert.equal(dashed.ink(7, 9), 0);
    assert.equal(dashed.ink(12, 9), 1);
    assert.equal(Math.round(dashed.total()), 20);
  });

  it("clip to a path until restore()", () => {
    const d = draw(40, 40, (p) => {
      p.save();
      p.clip(rectPath(10, 10, 30, 30));
      p.rect(0, 0, 40, 40, BLACK);
      p.restore();
      p.rect(0, 35, 40, 5, BLACK);
    });
    assert.equal(d.ink(20, 20), 1);
    assert.equal(d.ink(5, 20), 0);
    assert.equal(Math.round(d.total()), 400 + 200);
    // A circular clip (four cubics) passes its area.
    const k = 0.5523 * 15;
    const circle: PathCommand[] = [["M", 35, 20], ["C", 35, 20 + k, 20 + k, 35, 20, 35], ["C", 20 - k, 35, 5, 20 + k, 5, 20], ["C", 5, 20 - k, 20 - k, 5, 20, 5], ["C", 20 + k, 5, 35, 20 - k, 35, 20], ["Z"]];
    const c = draw(40, 40, (p) => {
      p.clip(circle);
      p.rect(0, 0, 40, 40, BLACK);
    });
    assert.ok(Math.abs(c.total() - Math.PI * 225) < 3, `${c.total()}`);
    // Clips intersect, and an empty clip hides everything.
    const both = draw(40, 40, (p) => {
      p.clip(rectPath(0, 0, 20, 40));
      p.clip(rectPath(10, 0, 40, 40));
      p.rect(0, 0, 40, 40, BLACK);
    });
    assert.equal(Math.round(both.total()), 400);
    assert.equal(draw(40, 40, (p) => (p.clip([]), p.rect(0, 0, 40, 40, BLACK))).total(), 0);
  });

  it("apply transforms, and restore them", () => {
    const d = draw(60, 60, (p) => {
      p.save();
      p.transform([2, 0, 0, 2, 10, 10]);
      p.path(rectPath(0, 0, 10, 10), { fill: BLACK });
      p.restore();
      p.path(rectPath(50, 50, 55, 55), { fill: BLACK });
    });
    assert.equal(d.ink(15, 60 - 15), 1);
    assert.equal(d.ink(9, 60 - 15), 0);
    assert.equal(d.ink(29, 60 - 29), 1);
    assert.equal(d.ink(31, 60 - 15), 0);
    assert.equal(Math.round(d.total()), 400 + 25);
    // A quarter turn about (30, 30): x in [0, 20], y in [0, 10] maps to x in [20, 30], y in [30, 50].
    const r = draw(60, 60, (p) => {
      p.transform([0, 1, -1, 0, 30, 30]);
      p.path(rectPath(0, 0, 20, 10), { fill: BLACK });
    });
    assert.equal(r.ink(25, 60 - 40), 1);
    assert.equal(r.ink(35, 60 - 40), 0);
    assert.equal(Math.round(r.total()), 200);
  });

  it("draw glyphs from their outlines", () => {
    const font = bundledFont("LMRoman", "Regular");
    const gid = font.glyphForCodePoint(0x48); // H
    const d = draw(100, 100, (p) => p.glyphs(font, 72, 10, 20, [gid], [font.advance(gid) * 0.072], ["H"]));
    let x0 = 99;
    let x1 = 0;
    let y0 = 99;
    let y1 = 0;
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        if (d.ink(x, y) > 0.5) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    const b = font.bounds(gid);
    // 72 pt at 72 dpi: 0.072 pixels per font unit; the baseline is at y = 100 - 20.
    assert.ok(Math.abs(x0 - (10 + b.xMin * 0.072)) <= 1.5 && Math.abs(x1 + 1 - (10 + b.xMax * 0.072)) <= 1.5, `x ${x0}..${x1}`);
    assert.ok(Math.abs(y1 + 1 - 80) <= 1 && Math.abs(y0 - (80 - b.yMax * 0.072)) <= 1.5, `y ${y0}..${y1}`);
    // Coloured, offset and repeated glyphs.
    const c = draw(100, 40, (p) => p.glyphs(font, 20, 5, 10, [gid, gid], [20, 20], ["H", "H"], [1, 0, 0], [0, 5]));
    let red = 0;
    for (let i = 0; i < c.rgb.length; i += 3) if (c.rgb[i] === 255 && c.rgb[i + 1] < 128 && c.rgb[i + 1] === c.rgb[i + 2]) red++;
    assert.ok(red > 50, `${red} red pixels`);
  });

  it("draw PNG images with alpha and JPEG images", () => {
    // 2 x 2: red, green / blue, white, stretched over 20 x 20 points.
    const png = encodePng(2, 2, Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
    const d = draw(40, 40, (p, add) => p.image(add(png), 10, 10, 20, 20));
    assert.deepEqual(d.pixel(12, 12), [255, 0, 0]);
    assert.deepEqual(d.pixel(27, 12), [0, 255, 0]);
    assert.deepEqual(d.pixel(12, 27), [0, 0, 255]);
    assert.deepEqual(d.pixel(5, 5), [255, 255, 255]);
    // Half-transparent black over red.
    const a = draw(20, 20, (p, add) => {
      p.rect(0, 0, 20, 20, [1, 0, 0]);
      p.image(add(rgbaPng(1, 1, [0, 0, 0, 128])), 0, 0, 20, 20);
    });
    const [r, g, b] = a.pixel(10, 10);
    assert.ok(Math.abs(r - 127) <= 1 && g === 0 && b === 0, `${r},${g},${b}`);
    // A JPEG, drawn at 4x (40 x 24 pixels over 160 x 96 points).
    const j = draw(160, 96, (p, add) => p.image(add(jpeg("q444")), 0, 0, 160, 96));
    const centres = [j.pixel(40, 24), j.pixel(120, 24), j.pixel(40, 72), j.pixel(120, 72)];
    centres.forEach((px, k) => px.forEach((v, ch) => assert.ok(Math.abs(v - QUADRANTS[k][ch]) <= 4, `quadrant ${k}: ${px}`)));
  });

  it("show a progressive JPEG as a grey box, and say so", () => {
    const writer = createRasterWriter({ dpi: 72 });
    const ref = writer.addImage(jpeg("progressive"));
    assert.deepEqual([ref.pixelWidth, ref.pixelHeight], [40, 24]);
    const page = writer.addPage(60, 40);
    page.image(ref, 10, 10, 40, 24);
    page.image(ref, 10, 10, 40, 24);
    writer.finish();
    const d = decodePng(writer.pages[0].png());
    const px = (x: number, y: number) => d.pixels![3 * (y * 60 + x)];
    assert.ok(px(20, 20) > 200 && px(20, 20) < 250, "light grey inside");
    assert.equal(px(5, 5), 255);
    assert.equal(writer.warnings.length, 1, "one warning per image");
    assert.match(writer.warnings[0], /progressive JPEG \(40x24 pixels\)/);
  });

  it("refuse what the PDF writer refuses", () => {
    const writer = createRasterWriter({ dpi: 72 });
    assert.throws(() => writer.addImage(new Uint8Array([1, 2, 3])), PdfError);
    const page = writer.addPage(10, 10);
    assert.throws(() => page.image({ id: "nope", pixelWidth: 1, pixelHeight: 1 }, 0, 0, 1, 1), PdfError);
    assert.throws(() => page.path([["L", 1, 1]], { fill: BLACK }), PdfError);
    assert.throws(() => page.path([["M", Number.NaN, 1]], { fill: BLACK }), PdfError);
    assert.throws(() => page.path([["M", 0, 0], ["L", 1, 1]], { stroke: BLACK, lineWidth: -1 }), PdfError);
    assert.throws(() => page.transform([1, 0, 0, 1, Infinity, 0]), PdfError);
    page.restore(); // unbalanced: ignored with a warning
    assert.match(writer.warnings[0], /restore\(\) without a matching save\(\)/);
    assert.throws(() => writer.addPage(0, 10), PdfError);
    assert.throws(() => createRasterWriter({ dpi: 5 }), RangeError);
    assert.throws(() => createRasterWriter({ dpi: 1200 }).addPage(14400, 14400), PdfError, "too many pixels");
    writer.finish();
    assert.throws(() => page.rect(0, 0, 1, 1, BLACK), PdfError);
  });
});

describe("PNG encoder", () => {
  it("writes files the PNG decoder reads back exactly", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    const rgb = Uint8Array.from({ length: 37 * 23 * 3 }, rnd);
    const png = encodePng(37, 23, rgb);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(Buffer.from(png.subarray(12, 16)).toString("latin1"), "IHDR");
    assert.equal(Buffer.from(png.subarray(png.length - 8, png.length - 4)).toString("latin1"), "IEND");
    const d = decodePng(png);
    assert.equal(d.width, 37);
    assert.equal(d.height, 23);
    assert.equal(d.color, "rgb");
    assert.deepEqual(d.pixels, rgb);
    assert.throws(() => encodePng(2, 2, new Uint8Array(11)), RangeError);
  });
});

describe("baseline JPEG decoder", () => {
  const centres = (img: { width: number; rgb: Uint8Array }) =>
    [
      [8, 5],
      [30, 5],
      [8, 18],
      [30, 18],
    ].map(([x, y]) => [...img.rgb.subarray(3 * (y * img.width + x), 3 * (y * img.width + x) + 3)]);

  for (const k of ["q444", "q422", "q420restart", "cmyk"] as const) {
    it(`decodes ${k}`, () => {
      const img = decodeJpeg(jpeg(k));
      assert.ok(img !== "progressive");
      assert.equal(img.width, 40);
      assert.equal(img.height, 24);
      centres(img).forEach((px, q) => px.forEach((v, ch) => assert.ok(Math.abs(v - QUADRANTS[q][ch]) <= 4, `quadrant ${q}: ${px}`)));
    });
  }

  it("decodes grayscale", () => {
    const img = decodeJpeg(jpeg("gray"));
    assert.ok(img !== "progressive");
    // libjpeg reads the same file as 88, 113, 67, 240.
    centres(img).forEach((px, q) => {
      assert.equal(px[0], px[1]);
      assert.equal(px[1], px[2]);
      assert.ok(Math.abs(px[0] - [88, 113, 67, 240][q]) <= 2, `quadrant ${q}: ${px}`);
    });
  });

  it("reports progressive files and survives damaged ones", () => {
    assert.equal(decodeJpeg(jpeg("progressive")), "progressive");
    const full = jpeg("q420restart");
    // Cut inside the scan: what is missing decodes as if it were zeros.
    const cut = decodeJpeg(full.subarray(0, full.length - 300));
    assert.ok(cut !== "progressive" && cut.rgb.length === 40 * 24 * 3);
    // A Huffman table with more codes than its lengths allow.
    const bad = jpeg("q444");
    const dht = bad.findIndex((v, i) => v === 0xff && bad[i + 1] === 0xc4);
    bad.fill(0xff, dht + 5, dht + 21);
    assert.throws(() => decodeJpeg(bad), PdfError);
    assert.throws(() => decodeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), PdfError);
  });
});

describe("renderPages", () => {
  const dir = mkdtempSync(join(tmpdir(), "texwright-raster-"));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="10" y="10" width="180" height="80" fill="#2a6" stroke="#000" stroke-width="3"/><circle cx="100" cy="50" r="30" fill="#fc0"/></svg>';
  writeFileSync(join(dir, "fig.svg"), svg);
  writeFileSync(join(dir, "prog.jpg"), jpeg("progressive"));
  writeFileSync(
    join(dir, "doc.md"),
    [
      "---",
      "title: Raster preview",
      "---",
      "",
      "# Introduction {#sec:intro}",
      "",
      "A paragraph of text with $E = mc^2$ inline and a display:",
      "",
      "$$ \\int_0^1 x^2 \\, dx = \\frac{1}{3} $$ {#eq:int}",
      "",
      "| Year | Value |",
      "|-----:|------:|",
      "| 2024 | 1.5   |",
      "",
      "Table: Some numbers. {#tbl:t}",
      "",
      "![A figure.](fig.svg){#fig:f width=60%}",
      "",
      "\\newpage",
      "",
      "# Second page",
      "",
      "![A progressive JPEG.](prog.jpg){width=30%}",
      "",
    ].join("\n"),
  );
  const file = join(dir, "doc.md");
  const decode = (png: Uint8Array) => decodePng(png).pixels!;
  const inkIn = (px: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (px[3 * (y * w + x)] < 128) n++;
    return n;
  };

  it("draws every page at 100 dpi, with text, mathematics, tables and figures", () => {
    const { input, layout } = prepare(file);
    const res = renderPages(input, layout);
    assert.equal(res.pageCount, 2);
    assert.deepEqual(
      res.pages.map((p) => [p.page, p.width, p.height]),
      [
        [1, 850, 1100],
        [2, 850, 1100],
      ],
    );
    const px = decode(res.pages[0].png);
    // Ink in the text block, none in the margins.
    assert.ok(inkIn(px, 850, 100, 100, 750, 1000) > 2000);
    assert.equal(inkIn(px, 850, 0, 0, 850, 60), 0);
    assert.equal(inkIn(px, 850, 0, 0, 60, 1100), 0);
    // The figure's green and yellow.
    let green = 0;
    let yellow = 0;
    for (let i = 0; i < px.length; i += 3) {
      if (px[i] === 0x22 && px[i + 1] === 0xaa && px[i + 2] === 0x66) green++;
      if (px[i] === 0xff && px[i + 1] === 0xcc && px[i + 2] === 0) yellow++;
    }
    assert.ok(green > 1000 && yellow > 1000, `green ${green}, yellow ${yellow}`);
    assert.deepEqual(res.warnings, ["a progressive JPEG (40x24 pixels) is drawn as a grey box"]);
  });

  it("draws only the pages asked for, at the resolution asked for, the same bytes every time", () => {
    const first = prepare(file);
    const a = renderPages(first.input, first.layout, { dpi: 50, pages: [2, 7] });
    assert.equal(a.pageCount, 2);
    assert.deepEqual(
      a.pages.map((p) => [p.page, p.width, p.height]),
      [[2, 425, 550]],
    );
    assert.match(a.warnings[0], /no page 7: the document has 2 pages/);
    const second = prepare(file);
    const b = renderPages(second.input, second.layout, { dpi: 50, pages: [2] });
    assert.deepEqual(b.pages[0].png, a.pages[0].png);
    const third = prepare(file);
    const all = renderPages(third.input, third.layout, { dpi: 50 });
    assert.deepEqual(all.pages[1].png, a.pages[0].png, "drawing one page or all gives the same image");
  });

  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
