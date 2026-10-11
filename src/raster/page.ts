/**
 * One preview page: the PdfPage drawing calls carried out on pixels
 * instead of written to a content stream.
 *
 * Pixels are RGBA with colour premultiplied by alpha; the page starts
 * opaque white (or transparent, for figures cut out to an image). The
 * graphics state is the current transformation matrix (user space to
 * device pixels, y down) and the clip, a coverage mask over the pixels it
 * leaves visible; save() and restore() push and pop both. Every shape goes
 * through the coverage rasterizer: fills with their own rule, strokes as
 * the polygons stroke.ts makes from them (nonzero), glyphs as their font
 * outlines. Colour, flat or from a gradient, is laid over what is there in
 * proportion to coverage times the clip times its opacity. A group is drawn
 * on a layer of its own, then laid over the page through its opacity and
 * soft mask with its blend mode, as PDF composites a transparency group.
 * Links and destinations draw nothing.
 *
 * Like PDF viewers, the page lines some things up with the pixel grid,
 * which makes them crisper and moves nothing by more than a pixel: upright
 * glyphs sit on whole pixel rows and quarter pixels across, rules and
 * horizontal or vertical strokes get pixel-aligned edges and at least a
 * pixel of thickness, and upright images fill the pixels they touch.
 */

import type { Font } from "../font/index.js";
import { blendColor, gradientT, invert, multiply, normalStops, spreadT, stopColor } from "../layout/paint.js";
import { type BlendMode, type Color, type Gradient, type ImageRef, type Paint, type PathCommand, isGradient } from "../layout/types.js";
import type { GroupOptions, PathStyle, PdfPage } from "../pdf/api.js";
import { PdfError } from "../pdf/errors.js";
import type { RasterImage } from "./image.js";
import { encodePng } from "./png.js";
import { COVERAGE_EPSILON, type CoverageRasterizer } from "./rasterizer.js";
import { strokePath } from "./stroke.js";

type Matrix = [number, number, number, number, number, number];

/** What a page needs from its writer. */
export interface RasterHost {
  readonly warnings: string[];
  checkOpen(): void;
  /** The coverage accumulator for a canvas of this size (shared between pages). */
  rasterizer(width: number, height: number): CoverageRasterizer;
  /** The image registered under this reference; PdfError when there is none. */
  image(ref: ImageRef): RasterImage;
  /** A glyph's outline in font units, or undefined when the font cannot draw it. */
  glyphOutline(font: Font, gid: number): PathCommand[] | undefined;
  /** The cache of glyph masks for one font at one scale. */
  glyphMasks(font: Font, scale: string): Map<number, GlyphMask | null>;
  /** Records the memory a new glyph mask takes (the host may drop its caches). */
  cachedMask(bytes: number): void;
  /** Notes once per image that it is drawn as a placeholder. */
  placeholder(ref: ImageRef, image: RasterImage): void;
}

/** A glyph's coverage at one sub-pixel offset, placed relative to its integer origin pixel. */
export interface GlyphMask {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Coverage 0..255, row-major. */
  alpha: Uint8Array;
}

interface Clip {
  /** Pixel box [x0, x1) x [y0, y1) outside which nothing shows. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Coverage of each pixel in the box, row-major. */
  mask: Float32Array;
}

interface GState {
  ctm: Matrix;
  clip: Clip | null;
}

/** Pixels over the box [x0, x1) x [y0, y1): RGBA, colour premultiplied by alpha, row-major. */
interface Surface {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  data: Uint8Array;
}

/** What a shape is painted with: a flat colour or a gradient (device pixel to gradient space), at an opacity. */
type Source = { r: number; g: number; b: number; alpha: number; lut?: undefined } | { lut: Uint8Array; inv: Matrix; gradient: Gradient; alpha: number };

/** Entries in a gradient's colour table. */
const LUT_SIZE = 1024;

/** Curves are flattened to within this many pixels. */
const TOLERANCE = 0.05;
/**
 * Upright glyphs sit on whole pixel rows and on quarter pixels across:
 * every letter on a line then gets the same crisp baseline, and each
 * glyph's coverage is computed once per quarter-pixel offset and reused.
 */
const GLYPH_STEPS = 4;
/** PDF's default miter limit, for strokes that give none. */
const MITER_LIMIT = 10;
const UNIT_SQUARE: PathCommand[] = [["M", 0, 0], ["L", 1, 0], ["L", 1, 1], ["L", 0, 1], ["Z"]];

/** m1 then m2: points map through m1 first. */
function concat(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** The largest factor by which the matrix stretches any direction. */
function stretch(m: Matrix): number {
  const p = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const q = m[0] * m[3] - m[1] * m[2];
  return Math.sqrt((p + Math.sqrt(Math.max(0, p * p - 4 * q * q))) / 2);
}

function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new PdfError(`${what} must be a finite number, got ${String(v)}`);
  return v;
}

/** 0..255 components of a colour (clamped). */
function rgb(c: Color, what: string): [number, number, number] {
  if (!Array.isArray(c) || c.length !== 3) throw new PdfError(`${what} must be an [r, g, b] array`);
  return c.map((v) => Math.round(255 * Math.min(1, Math.max(0, finite(v, what))))) as [number, number, number];
}

/** An opacity 0..1 (default 1), checked as the PDF writer does. */
function opacity(v: number | undefined, what: string): number {
  return v === undefined ? 1 : Math.min(1, Math.max(0, finite(v, what)));
}

function checkGradient(g: Gradient, what: string): void {
  if (g.kind !== "linear" && g.kind !== "radial") throw new PdfError(`${what}: unknown gradient kind ${JSON.stringify(g.kind)}`);
  const n = g.kind === "linear" ? 4 : 6;
  if (!Array.isArray(g.coords) || g.coords.length !== n) throw new PdfError(`${what}: a ${g.kind} gradient needs ${n} coordinates`);
  for (const v of g.coords) finite(v, `${what} gradient coordinate`);
  if (g.kind === "radial" && (g.coords[2] < 0 || g.coords[5] < 0)) throw new PdfError(`${what}: gradient radii must not be negative`);
  if (!Array.isArray(g.matrix) || g.matrix.length !== 6) throw new PdfError(`${what}: gradient matrix needs six numbers`);
  for (const v of g.matrix) finite(v, `${what} gradient matrix entry`);
  if (!Array.isArray(g.stops) || !g.stops.length) throw new PdfError(`${what}: a gradient needs at least one stop`);
  for (const st of g.stops) {
    finite(st.offset, `${what} gradient stop offset`);
    rgb(st.color, `${what} gradient stop colour`);
  }
  if (g.spread !== "pad" && g.spread !== "reflect" && g.spread !== "repeat") throw new PdfError(`${what}: spread must be pad, reflect or repeat`);
}

const BLENDS = new Set<BlendMode>([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

/**
 * Two device coordinates moved to the nearest pixel boundaries, in the same
 * order; when that would leave nothing between them, the pixel holding
 * their midpoint.
 */
function snapPair(a: number, b: number): [number, number] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let p = Math.round(lo);
  let q = Math.round(hi);
  if (q <= p) {
    p = Math.floor((lo + hi) / 2);
    q = p + 1;
  }
  return a <= b ? [p, q] : [q, p];
}

/** Checks a path the way the PDF writer does. */
function checkPath(d: PathCommand[]): void {
  if (!Array.isArray(d)) throw new PdfError("path must be an array of commands");
  let current = false;
  for (const cmd of d) {
    if (!Array.isArray(cmd)) throw new PdfError("path command must be an array");
    const count = cmd[0] === "M" || cmd[0] === "L" ? 2 : cmd[0] === "C" ? 6 : cmd[0] === "Z" ? 0 : -1;
    if (count < 0) throw new PdfError(`unknown path command ${JSON.stringify(cmd[0])}`);
    if (cmd[0] !== "M" && !current) throw new PdfError("path must start with M");
    if (cmd.length !== count + 1) throw new PdfError(`path command ${cmd[0]} needs ${count} numbers`);
    for (let i = 1; i <= count; i++) finite(cmd[i], "path coordinate");
    current = true;
  }
}

export class RasterPage implements PdfPage {
  readonly width: number;
  readonly height: number;
  /** 1-based page number. */
  readonly number: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** The page starts transparent instead of white (its PNG then has an alpha channel). */
  readonly transparent: boolean;
  /** The page's pixels; undefined once encoded. */
  private page: Surface | undefined;
  /** Where drawing goes: the page, or the layer of the group being drawn. */
  private target: Surface | undefined;
  private encoded: Uint8Array | undefined;
  private gs: GState;
  private stack: GState[] = [];
  private readonly ras: CoverageRasterizer;

  constructor(
    private readonly host: RasterHost,
    number: number,
    width: number,
    height: number,
    pixelWidth: number,
    pixelHeight: number,
    transparent = false,
  ) {
    this.number = number;
    this.width = width;
    this.height = height;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
    this.transparent = transparent;
    this.page = { x0: 0, y0: 0, x1: pixelWidth, y1: pixelHeight, data: new Uint8Array(pixelWidth * pixelHeight * 4).fill(transparent ? 0 : 255) };
    this.target = this.page;
    this.ras = host.rasterizer(pixelWidth, pixelHeight);
    // PDF points (origin bottom left, y up) to pixels (origin top left, y down).
    const sx = pixelWidth / width;
    const sy = pixelHeight / height;
    this.gs = { ctm: [sx, 0, 0, -sy, 0, pixelHeight], clip: null };
  }

  // ------------------------------------------------------------- PdfPage

  glyphs(font: Font, size: number, x: number, y: number, gids: number[], advances: number[], _text: string[], color?: Color, yOffsets?: number[], alpha?: number, hscale?: number): void {
    this.host.checkOpen();
    if (!Array.isArray(gids) || !Array.isArray(advances)) throw new PdfError("glyphs(): gids and advances must be arrays");
    const n = gids.length;
    if (advances.length !== n) throw new PdfError(`glyphs(): ${n} glyph ids but ${advances.length} advances`);
    if (yOffsets && yOffsets.length !== n) throw new PdfError(`glyphs(): ${n} glyph ids but ${yOffsets.length} y offsets`);
    if (!font || typeof font.outline !== "function") throw new PdfError("glyphs() needs a Font from the font module");
    finite(x, "glyphs() x");
    finite(y, "glyphs() y");
    if (finite(size, "font size") === 0) throw new PdfError(`font size ${size} is too small`);
    // Expanded glyphs (microtype) are drawn wider or narrower; the advances already include it.
    const hs = hscale === undefined ? 1 : finite(hscale, "glyph horizontal scale");
    if (!(hs > 0)) throw new PdfError(`glyph horizontal scale ${hscale} must be positive`);
    const [r, g, b] = rgb(color ?? [0, 0, 0], "glyph colour");
    const src: Source = { r, g, b, alpha: opacity(alpha, "glyph opacity") };
    const count = font.glyphCount;
    for (let i = 0; i < n; i++) {
      const gid = gids[i];
      if (!Number.isInteger(gid) || gid < 0 || gid >= count || gid > 0xffff) throw new PdfError(`glyph id ${gid} is not in font ${font.postscriptName} (${count} glyphs)`);
      finite(advances[i], "glyph advance");
      if (yOffsets) finite(yOffsets[i], "glyph y offset");
    }
    if (!n || !this.target || src.alpha === 0) return;
    const k = size / font.unitsPerEm;
    const kx = k * hs;
    const m = this.gs.ctm;
    const upright = m[1] === 0 && m[2] === 0;
    const masks = upright ? this.host.glyphMasks(font, `${kx * m[0]} ${k * m[3]}`) : undefined;
    let pen = x;
    for (let i = 0; i < n; i++) {
      const outline = this.host.glyphOutline(font, gids[i]);
      if (outline?.length) {
        const gy = y + (yOffsets ? yOffsets[i] : 0);
        // The glyph origin in device pixels.
        const ox = pen * m[0] + gy * m[2] + m[4];
        const oy = pen * m[1] + gy * m[3] + m[5];
        let mask: GlyphMask | null | undefined;
        let ix = 0;
        if (masks) {
          const qx = Math.floor(ox * GLYPH_STEPS);
          const step = ((qx % GLYPH_STEPS) + GLYPH_STEPS) % GLYPH_STEPS;
          ix = (qx - step) / GLYPH_STEPS;
          const key = gids[i] * GLYPH_STEPS + step;
          mask = masks.get(key);
          if (mask === undefined) {
            mask = this.glyphMask(outline, kx * m[0], k * m[3], step / GLYPH_STEPS);
            if (mask !== undefined) masks.set(key, mask);
            if (mask) this.host.cachedMask(mask.alpha.length);
          }
        }
        if (mask) this.blit(mask, ix + mask.x, Math.floor(oy) + mask.y, src);
        else if (mask === undefined) {
          // Not upright, or larger than the page: drawn where it falls.
          this.addPath(outline, [kx * m[0], kx * m[1], k * m[2], k * m[3], ox, oy]);
          this.paint(false, src);
        }
      }
      pen += advances[i];
    }
  }

  path(d: PathCommand[], style: PathStyle): void {
    this.host.checkOpen();
    checkPath(d);
    const fill = style.fill ? this.source(style.fill, opacity(style.fillAlpha, "fill opacity"), "path fill") : undefined;
    const stroke = style.stroke ? this.source(style.stroke, opacity(style.strokeAlpha, "stroke opacity"), "path stroke") : undefined;
    let lineWidth = 1;
    let dash: number[] | undefined;
    const cap = style.lineCap ?? 0;
    const join = style.lineJoin ?? 0;
    const miterLimit = Math.max(1, finite(style.miterLimit ?? MITER_LIMIT, "miter limit"));
    if (stroke) {
      lineWidth = finite(style.lineWidth ?? 1, "line width");
      if (lineWidth < 0) throw new PdfError(`line width ${style.lineWidth} is negative`);
      if (style.dash?.length) {
        dash = style.dash.map((v) => finite(v, "dash length"));
        if (dash.some((v) => v < 0)) throw new PdfError("dash lengths must not be negative");
        if (dash.every((v) => v === 0)) dash = undefined;
      }
      if (cap !== 0 && cap !== 1 && cap !== 2) throw new PdfError(`line cap ${cap} is not 0, 1 or 2`);
      if (join !== 0 && join !== 1 && join !== 2) throw new PdfError(`line join ${join} is not 0, 1 or 2`);
    }
    if (!this.target || !d.length) return;
    if (fill && fill.alpha > 0) {
      this.addPath(d, this.gs.ctm);
      this.paint(style.evenOdd === true, fill);
    }
    if (stroke && stroke.alpha > 0) {
      const m = this.gs.ctm;
      const s = stretch(m);
      if (!(s > 0)) return;
      // Width 0 is the thinnest line the device can draw: one pixel.
      const half = lineWidth > 0 ? lineWidth / 2 : 0.5 / s;
      if (dash || !this.adjustedStroke(d, m, half, cap, join)) {
        strokePath(d, { half, cap, join, miterLimit, dash }, TOLERANCE / s, (poly) => this.addPolygon(poly, m));
      }
      this.paint(false, stroke);
    }
  }

  rect(x: number, y: number, width: number, height: number, fill: Color): void {
    this.host.checkOpen();
    for (const v of [x, y, width, height]) finite(v, "rect() coordinate");
    const [r, g, b] = rgb(fill, "rect fill");
    if (!this.target || width === 0 || height === 0) return;
    const m = this.gs.ctm;
    if (m[1] === 0 && m[2] === 0) {
      // Rules and boxes get pixel-aligned edges (see adjustedStroke).
      this.addSnapped(x * m[0] + m[4], y * m[3] + m[5], (x + width) * m[0] + m[4], (y + height) * m[3] + m[5]);
    } else {
      this.addPolygon([x, y, x + width, y, x + width, y + height, x, y + height], m);
    }
    this.paint(false, { r, g, b, alpha: 1 });
  }

  image(image: ImageRef, x: number, y: number, width: number, height: number, alpha?: number, pixelated?: boolean): void {
    this.host.checkOpen();
    for (const v of [x, y, width, height]) finite(v, "image() coordinate");
    const imageAlpha = opacity(alpha, "image opacity");
    const img = this.host.image(image);
    const target = this.target;
    if (!target || imageAlpha === 0) return;
    // The image occupies the unit square of its own space, row 0 at the top.
    const m = concat([width, 0, 0, height, x, y], this.gs.ctm);
    if (m[1] === 0 && m[2] === 0) {
      // An upright image fills every pixel it touches (slivers under 1/64 aside), so its edges are crisp.
      const e = 1 / 64;
      const outward = (a: number, b: number): [number, number] => (a <= b ? [Math.floor(a + e), Math.ceil(b - e)] : [Math.ceil(a - e), Math.floor(b + e)]);
      const [x0, x1] = outward(m[4], m[0] + m[4]);
      const [y0, y1] = outward(m[5], m[3] + m[5]);
      m[0] = x1 - x0;
      m[4] = x0;
      m[3] = y1 - y0;
      m[5] = y0;
    }
    const det = m[0] * m[3] - m[1] * m[2];
    if (!(Math.abs(det) > 1e-12)) return;
    // Device pixel -> image pixel (before any reduction): u = W (i0 X + i2 Y + i4), v = H (1 - (i1 X + i3 Y + i5)).
    const i0 = m[3] / det;
    const i1 = -m[1] / det;
    const i2 = -m[2] / det;
    const i3 = m[0] / det;
    const i4 = (m[2] * m[5] - m[3] * m[4]) / det;
    const i5 = (m[1] * m[4] - m[0] * m[5]) / det;
    const footprint = Math.max(Math.hypot(i0 * img.width, i1 * img.height), Math.hypot(i2 * img.width, i3 * img.height));
    const factor = footprint >= 2 ? Math.floor(footprint) : 1;
    // Square pixels only when scaling up; reduced images are always averaged.
    const nearest = pixelated === true && footprint < 1;
    const bmp = img.pixels(factor);
    this.addPath(UNIT_SQUARE, m);
    if (!bmp) {
      this.host.placeholder(image, img);
      this.paint(false, { r: 235, g: 235, b: 235, alpha: imageAlpha });
      // A diagonal cross and a border, one pixel wide, between the corners in device space.
      const corners = [0, 0, 1, 0, 1, 1, 0, 1];
      const pts: number[] = [];
      for (let k = 0; k < 8; k += 2) pts.push(m[0] * corners[k] + m[2] * corners[k + 1] + m[4], m[1] * corners[k] + m[3] * corners[k + 1] + m[5]);
      const line = (a: number, b: number): PathCommand[] => [
        ["M", pts[2 * a], pts[2 * a + 1]],
        ["L", pts[2 * b], pts[2 * b + 1]],
      ];
      const device: Matrix = [1, 0, 0, 1, 0, 0];
      for (const [a, b] of [[0, 2], [1, 3], [0, 1], [1, 2], [2, 3], [3, 0]]) {
        strokePath(line(a, b), { half: 0.5, cap: 2, join: 0, miterLimit: MITER_LIMIT }, TOLERANCE, (poly) => this.addPolygon(poly, device));
      }
      this.paint(false, { r: 150, g: 150, b: 150, alpha: imageAlpha });
      return;
    }
    const bw = bmp.width;
    const bh = bmp.height;
    const sx = bw / img.width; // reduced pixels per original pixel
    const sy = bh / img.height;
    const src = bmp.rgb;
    const balpha = bmp.alpha;
    const px = target.data;
    const TW = target.x1 - target.x0;
    const clip = this.gs.clip;
    const maxX = bw - 1;
    const maxY = bh - 1;
    this.ras.sweep(false, (yy, x0, x1, cov) => {
      if (yy < target.y0 || yy >= target.y1) return;
      if (x0 < target.x0) x0 = target.x0;
      if (x1 > target.x1) x1 = target.x1;
      let crow = 0;
      if (clip) {
        if (yy < clip.y0 || yy >= clip.y1) return;
        if (x0 < clip.x0) x0 = clip.x0;
        if (x1 > clip.x1) x1 = clip.x1;
        crow = (yy - clip.y0) * (clip.x1 - clip.x0) - clip.x0;
      }
      const cy = yy + 0.5;
      const trow = (yy - target.y0) * TW - target.x0;
      for (let xx = x0; xx < x1; xx++) {
        let a = cov[xx] * imageAlpha;
        if (clip) a *= clip.mask[crow + xx];
        if (a < COVERAGE_EPSILON) continue;
        const cx = xx + 0.5;
        // Sample position in the (reduced) bitmap, pixel centres at .5.
        let fx = (i0 * cx + i2 * cy + i4) * img.width * sx - 0.5;
        let fy = (1 - (i1 * cx + i3 * cy + i5)) * img.height * sy - 0.5;
        if (nearest) {
          // The pixel the sample falls in, whole.
          fx = Math.round(fx);
          fy = Math.round(fy);
        }
        fx = fx < 0 ? 0 : fx > maxX ? maxX : fx;
        fy = fy < 0 ? 0 : fy > maxY ? maxY : fy;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const jx = ix < maxX ? ix + 1 : ix;
        const jy = iy < maxY ? iy + 1 : iy;
        const p00 = iy * bw + ix;
        const p10 = iy * bw + jx;
        const p01 = jy * bw + ix;
        const p11 = jy * bw + jx;
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        const op = balpha ? (balpha[p00] * w00 + balpha[p10] * w10 + balpha[p01] * w01 + balpha[p11] * w11) / 255 : 1;
        const o = (trow + xx) * 4;
        const keep = 1 - a * op;
        for (let ch = 0; ch < 3; ch++) {
          const s = src[3 * p00 + ch] * w00 + src[3 * p10 + ch] * w10 + src[3 * p01 + ch] * w01 + src[3 * p11 + ch] * w11;
          const v = s * a + px[o + ch] * keep;
          px[o + ch] = v >= 255 ? 255 : Math.round(v);
        }
        const va = 255 * a * op + px[o + 3] * keep;
        px[o + 3] = va >= 255 ? 255 : Math.round(va);
      }
    });
  }

  group(opts: GroupOptions, draw: () => void): void {
    this.host.checkOpen();
    if (!opts || !Array.isArray(opts.bbox) || opts.bbox.length !== 4) throw new PdfError("group() needs a bbox [x0, y0, x1, y1]");
    for (const v of opts.bbox) finite(v, "group() bbox");
    const groupAlpha = opacity(opts.opacity, "group opacity");
    const blend = opts.blend ?? "normal";
    if (!BLENDS.has(blend)) throw new PdfError(`unknown blend mode ${JSON.stringify(blend)}`);
    if (typeof draw !== "function") throw new PdfError("group() needs a function that draws its content");
    if (opts.mask && typeof opts.mask.draw !== "function") throw new PdfError("group() mask needs a function that draws it");
    const parent = this.target;
    if (!parent || groupAlpha === 0) return;
    // The layer covers the group's box on the device, within what can show.
    const [bx0, by0, bx1, by1] = opts.bbox;
    if (!(bx1 > bx0 && by1 > by0)) return;
    const m = this.gs.ctm;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of [
      [bx0, by0],
      [bx1, by0],
      [bx1, by1],
      [bx0, by1],
    ]) {
      const dx = m[0] * px + m[2] * py + m[4];
      const dy = m[1] * px + m[3] * py + m[5];
      x0 = Math.min(x0, dx);
      y0 = Math.min(y0, dy);
      x1 = Math.max(x1, dx);
      y1 = Math.max(y1, dy);
    }
    const clip = this.gs.clip;
    const box = {
      x0: Math.max(Math.floor(x0), parent.x0, clip ? clip.x0 : 0),
      y0: Math.max(Math.floor(y0), parent.y0, clip ? clip.y0 : 0),
      x1: Math.min(Math.ceil(x1), parent.x1, clip ? clip.x1 : Infinity),
      y1: Math.min(Math.ceil(y1), parent.y1, clip ? clip.y1 : Infinity),
    };
    if (!(box.x1 > box.x0 && box.y1 > box.y0)) return;
    const layer = (): Surface => ({ ...box, data: new Uint8Array((box.x1 - box.x0) * (box.y1 - box.y0) * 4) });
    const content = layer();
    this.drawInto(content, draw);
    let mask: Surface | undefined;
    if (opts.mask) {
      mask = layer();
      this.drawInto(mask, opts.mask.draw);
    }
    composite(content, parent, groupAlpha, blend, mask, opts.mask?.luminance !== false);
  }

  /** Runs `draw` with drawing going to `layer`, from the current graphics state; saves left open are dropped. */
  private drawInto(layer: Surface, draw: () => void): void {
    const saved = { target: this.target, gs: this.gs, stack: this.stack };
    this.target = layer;
    this.stack = [];
    try {
      draw();
    } finally {
      this.target = saved.target;
      this.gs = saved.gs;
      this.stack = saved.stack;
    }
  }

  /** The gradient's or colour's paint source at an opacity, for the current transformation. */
  private source(p: Paint, alpha: number, what: string): Source {
    if (!isGradient(p)) {
      const [r, g, b] = rgb(p, what);
      return { r, g, b, alpha };
    }
    checkGradient(p, what);
    const stops = normalStops(p.stops);
    const inv = invert(multiply(p.matrix, this.gs.ctm));
    if (!inv) {
      const [r, g, b] = rgb(stops[stops.length - 1].color, what);
      return { r, g, b, alpha };
    }
    const lut = new Uint8Array(LUT_SIZE * 3);
    for (let i = 0; i < LUT_SIZE; i++) {
      const c = stopColor(stops, i / (LUT_SIZE - 1));
      lut[3 * i] = Math.round(255 * c[0]);
      lut[3 * i + 1] = Math.round(255 * c[1]);
      lut[3 * i + 2] = Math.round(255 * c[2]);
    }
    return { lut, inv, gradient: p, alpha };
  }

  save(): void {
    this.host.checkOpen();
    this.stack.push({ ...this.gs });
  }

  restore(): void {
    this.host.checkOpen();
    const prev = this.stack.pop();
    if (!prev) {
      this.host.warnings.push(`page ${this.number}: restore() without a matching save() ignored`);
      return;
    }
    this.gs = prev;
  }

  transform(m: [number, number, number, number, number, number]): void {
    this.host.checkOpen();
    if (!Array.isArray(m) || m.length !== 6) throw new PdfError("transform() needs six numbers");
    for (const v of m) finite(v, "transform() entry");
    this.gs = { ...this.gs, ctm: concat(m, this.gs.ctm) };
  }

  clip(d: PathCommand[], evenOdd?: boolean): void {
    this.host.checkOpen();
    checkPath(d);
    if (!this.target) return;
    const prev = this.gs.clip;
    this.addPath(d, this.gs.ctm);
    const b = this.ras.bounds();
    let x0 = b ? b[0] : 0;
    let y0 = b ? b[1] : 0;
    let x1 = b ? b[2] : 0;
    let y1 = b ? b[3] : 0;
    if (prev) {
      x0 = Math.max(x0, prev.x0);
      y0 = Math.max(y0, prev.y0);
      x1 = Math.min(x1, prev.x1);
      y1 = Math.min(y1, prev.y1);
    }
    if (x1 <= x0 || y1 <= y0) {
      // Nothing visible: an empty clip path, or no overlap with the clip before.
      this.ras.clear();
      this.gs = { ...this.gs, clip: { x0: 0, y0: 0, x1: 0, y1: 0, mask: new Float32Array(0) } };
      return;
    }
    const w = x1 - x0;
    const mask = new Float32Array(w * (y1 - y0));
    this.ras.sweep(evenOdd === true, (y, sx0, sx1, cov) => {
      if (y < y0 || y >= y1) return;
      const row = (y - y0) * w - x0;
      const prow = prev ? (y - prev.y0) * (prev.x1 - prev.x0) - prev.x0 : 0;
      for (let x = Math.max(sx0, x0); x < Math.min(sx1, x1); x++) mask[row + x] = prev ? cov[x] * prev.mask[prow + x] : cov[x];
    });
    this.gs = { ...this.gs, clip: { x0, y0, x1, y1, mask } };
  }

  link(): void {
    this.host.checkOpen();
  }

  destination(): void {
    this.host.checkOpen();
  }

  // -------------------------------------------------------------- output

  /** The page as a PNG. The first call encodes it and lets the pixel buffer go. */
  png(): Uint8Array {
    if (!this.encoded) {
      const data = this.page!.data;
      const n = this.pixelWidth * this.pixelHeight;
      if (this.transparent) {
        // PNG stores colour unpremultiplied.
        const out = new Uint8Array(n * 4);
        for (let i = 0; i < n * 4; i += 4) {
          const a = data[i + 3];
          if (!a) continue;
          out[i] = Math.min(255, Math.round((data[i] * 255) / a));
          out[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / a));
          out[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / a));
          out[i + 3] = a;
        }
        this.encoded = encodePng(this.pixelWidth, this.pixelHeight, out, 4);
      } else {
        const out = new Uint8Array(n * 3);
        for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) {
          out[j] = data[i];
          out[j + 1] = data[i + 1];
          out[j + 2] = data[i + 2];
        }
        this.encoded = encodePng(this.pixelWidth, this.pixelHeight, out);
      }
      this.page = this.target = undefined;
    }
    return this.encoded;
  }

  /** The page's pixels, RGBA with colour premultiplied by alpha (undefined once png() has been called). */
  rgba(): Uint8Array | undefined {
    return this.page?.data;
  }

  // ------------------------------------------------------------ drawing

  /**
   * An upright glyph's coverage with its origin `fx` pixels right of a
   * pixel corner, scaled by sx and sy (device pixels per font unit; sy is
   * negative as y turns down). null when it covers no pixel, undefined when
   * it is larger than the page and has to be drawn directly.
   */
  private glyphMask(outline: PathCommand[], sx: number, sy: number, fx: number): GlyphMask | null | undefined {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of outline) {
      for (let j = 1; j < c.length; j += 2) {
        const x = (c[j] as number) * sx + fx;
        const y = (c[j + 1] as number) * sy;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (!(x0 < x1 && y0 < y1)) return null;
    const left = Math.floor(x0);
    const top = Math.floor(y0);
    const w = Math.ceil(x1) - left;
    const h = Math.ceil(y1) - top;
    if (w > this.ras.width || h > this.ras.height) return undefined;
    this.addPath(outline, [sx, 0, 0, sy, fx - left, -top]);
    const alpha = new Uint8Array(w * h);
    let any = false;
    this.ras.sweep(false, (y, xa, xb, cov) => {
      const end = Math.min(xb, w);
      for (let x = xa; x < end; x++) {
        const v = Math.round(cov[x] * 255);
        if (v) {
          alpha[y * w + x] = v;
          any = true;
        }
      }
    });
    return any ? { x: left, y: top, w, h, alpha } : null;
  }

  /** Lays a colour over the pixels through a glyph mask whose top-left pixel is (left, top). */
  private blit(mask: GlyphMask, left: number, top: number, src: Source): void {
    const t = this.target!;
    const clip = this.gs.clip;
    let x0 = Math.max(left, t.x0);
    let y0 = Math.max(top, t.y0);
    let x1 = Math.min(left + mask.w, t.x1);
    let y1 = Math.min(top + mask.h, t.y1);
    if (clip) {
      x0 = Math.max(x0, clip.x0);
      y0 = Math.max(y0, clip.y0);
      x1 = Math.min(x1, clip.x1);
      y1 = Math.min(y1, clip.y1);
    }
    const px = t.data;
    const TW = t.x1 - t.x0;
    const alpha = mask.alpha;
    const hi = 1 - COVERAGE_EPSILON;
    const { r, g, b } = src as { r: number; g: number; b: number };
    const k = src.alpha / 255;
    for (let y = y0; y < y1; y++) {
      const mrow = (y - top) * mask.w - left;
      const crow = clip ? (y - clip.y0) * (clip.x1 - clip.x0) - clip.x0 : 0;
      for (let x = x0, o = ((y - t.y0) * TW + x0 - t.x0) * 4; x < x1; x++, o += 4) {
        const v = alpha[mrow + x];
        if (!v) continue;
        let a = v * k;
        if (clip) {
          a *= clip.mask[crow + x];
          if (a < COVERAGE_EPSILON) continue;
        }
        if (a > hi) {
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = b;
          px[o + 3] = 255;
        } else {
          px[o] += Math.round((r - px[o]) * a);
          px[o + 1] += Math.round((g - px[o + 1]) * a);
          px[o + 2] += Math.round((b - px[o + 2]) * a);
          px[o + 3] += Math.round((255 - px[o + 3]) * a);
        }
      }
    }
  }

  /**
   * Stroke adjustment, as PDF viewers do it: a stroke made only of
   * horizontal and vertical segments, under an upright transformation, is
   * drawn as rectangles whose edges sit on pixel boundaries, at least a
   * pixel thick, so rules, axes and frames come out crisp instead of as two
   * faint rows. Ends and corners are square, which thin lines cannot show
   * otherwise; thick lines with round ends or corners are left to the exact
   * stroker. Adds the rectangles and returns true, or returns false when the
   * path does not qualify.
   */
  private adjustedStroke(d: PathCommand[], m: Matrix, half: number, cap: 0 | 1 | 2, join: 0 | 1 | 2): boolean {
    if (m[1] !== 0 || m[2] !== 0) return false;
    const hx = half * Math.abs(m[0]);
    const hy = half * Math.abs(m[3]);
    if (Math.max(hx, hy) > 1 && (cap === 1 || join !== 0)) return false;
    // Subpaths in device space.
    const subs: { pts: number[]; closed: boolean }[] = [];
    let cur: { pts: number[]; closed: boolean } | null = null;
    let sx = 0;
    let sy = 0;
    for (const c of d) {
      if (c[0] === "C") return false;
      if (c[0] === "M") {
        sx = c[1] * m[0] + m[4];
        sy = c[2] * m[3] + m[5];
        cur = { pts: [sx, sy], closed: false };
        subs.push(cur);
      } else if (c[0] === "L") {
        if (!cur) {
          cur = { pts: [sx, sy], closed: false };
          subs.push(cur);
        }
        cur.pts.push(c[1] * m[0] + m[4], c[2] * m[3] + m[5]);
      } else if (cur) {
        cur.closed = true;
        cur = null;
      }
    }
    const rects: [number, number, number, number][] = [];
    for (const { pts, closed } of subs) {
      const n = pts.length / 2;
      if (n < 2) {
        if (closed && cap === 1) return false; // a dot
        continue;
      }
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const x0 = pts[2 * i];
        const y0 = pts[2 * i + 1];
        const x1 = pts[2 * j];
        const y1 = pts[2 * j + 1];
        // Ends meet another segment or carry a cap; only butt caps stop at the end point.
        const e0 = closed || i > 0 || cap !== 0 ? 1 : 0;
        const e1 = closed || i < segs - 1 || cap !== 0 ? 1 : 0;
        if (y0 === y1 && x0 !== x1) {
          rects.push(x0 < x1 ? [x0 - e0 * hx, y0 - hy, x1 + e1 * hx, y0 + hy] : [x1 - e1 * hx, y0 - hy, x0 + e0 * hx, y0 + hy]);
        } else if (x0 === x1 && y0 !== y1) {
          rects.push(y0 < y1 ? [x0 - hx, y0 - e0 * hy, x0 + hx, y1 + e1 * hy] : [x0 - hx, y1 - e1 * hy, x0 + hx, y0 + e0 * hy]);
        } else return false;
      }
    }
    for (const r of rects) this.addSnapped(...r);
    return true;
  }

  /**
   * Adds the device-space rectangle between two corners with each edge moved
   * to the nearest pixel boundary; a rectangle thinner than a pixel becomes
   * the one pixel row or column holding its middle.
   */
  private addSnapped(xa: number, ya: number, xb: number, yb: number): void {
    const [x0, x1] = snapPair(xa, xb);
    const [y0, y1] = snapPair(ya, yb);
    this.addPolygon([x0, y0, x1, y0, x1, y1, x0, y1], [1, 0, 0, 1, 0, 0]);
  }

  /** Adds a path's edges (each subpath closed, as filling does) through matrix m. */
  private addPath(d: PathCommand[], m: Matrix): void {
    const ras = this.ras;
    const [a, b, c, dd, e, f] = m;
    let sx = 0;
    let sy = 0;
    let cx = 0;
    let cy = 0;
    for (const cmd of d) {
      switch (cmd[0]) {
        case "M":
          ras.line(cx, cy, sx, sy);
          sx = cx = a * cmd[1] + c * cmd[2] + e;
          sy = cy = b * cmd[1] + dd * cmd[2] + f;
          break;
        case "L": {
          const x = a * cmd[1] + c * cmd[2] + e;
          const y = b * cmd[1] + dd * cmd[2] + f;
          ras.line(cx, cy, x, y);
          cx = x;
          cy = y;
          break;
        }
        case "C": {
          const x3 = a * cmd[5] + c * cmd[6] + e;
          const y3 = b * cmd[5] + dd * cmd[6] + f;
          ras.cubic(cx, cy, a * cmd[1] + c * cmd[2] + e, b * cmd[1] + dd * cmd[2] + f, a * cmd[3] + c * cmd[4] + e, b * cmd[3] + dd * cmd[4] + f, x3, y3, TOLERANCE);
          cx = x3;
          cy = y3;
          break;
        }
        case "Z":
          ras.line(cx, cy, sx, sy);
          cx = sx;
          cy = sy;
          break;
      }
    }
    ras.line(cx, cy, sx, sy);
  }

  /** Adds a closed polygon (x, y pairs) through matrix m. */
  private addPolygon(p: number[], m: Matrix): void {
    const n = p.length;
    if (n < 6) return;
    const [a, b, c, d, e, f] = m;
    let px = a * p[n - 2] + c * p[n - 1] + e;
    let py = b * p[n - 2] + d * p[n - 1] + f;
    for (let i = 0; i < n; i += 2) {
      const x = a * p[i] + c * p[i + 1] + e;
      const y = b * p[i] + d * p[i + 1] + f;
      this.ras.line(px, py, x, y);
      px = x;
      py = y;
    }
  }

  /**
   * Lays the source over the pixels in proportion to the accumulated
   * coverage times the clip times the source's opacity.
   */
  private paint(evenOdd: boolean, src: Source): void {
    const t = this.target!;
    const px = t.data;
    const TW = t.x1 - t.x0;
    const clip = this.gs.clip;
    const hi = 1 - COVERAGE_EPSILON;
    const k = src.alpha;
    const lut = src.lut;
    const inv = src.lut ? src.inv : undefined;
    const gradient = src.lut ? src.gradient : undefined;
    let r = src.lut ? 0 : src.r;
    let g = src.lut ? 0 : src.g;
    let b = src.lut ? 0 : src.b;
    this.ras.sweep(evenOdd, (y, x0, x1, cov) => {
      if (y < t.y0 || y >= t.y1) return;
      if (x0 < t.x0) x0 = t.x0;
      if (x1 > t.x1) x1 = t.x1;
      let crow = 0;
      if (clip) {
        if (y < clip.y0 || y >= clip.y1) return;
        if (x0 < clip.x0) x0 = clip.x0;
        if (x1 > clip.x1) x1 = clip.x1;
        crow = (y - clip.y0) * (clip.x1 - clip.x0) - clip.x0;
      }
      const cy = y + 0.5;
      for (let x = x0, o = ((y - t.y0) * TW + x0 - t.x0) * 4; x < x1; x++, o += 4) {
        let a = cov[x] * k;
        if (clip) a *= clip.mask[crow + x];
        if (a < COVERAGE_EPSILON) continue;
        if (lut) {
          const cx = x + 0.5;
          const u = gradientT(gradient!, inv![0] * cx + inv![2] * cy + inv![4], inv![1] * cx + inv![3] * cy + inv![5]);
          if (Number.isNaN(u)) continue;
          const i = Math.round(spreadT(u, gradient!.spread) * (LUT_SIZE - 1)) * 3;
          r = lut[i];
          g = lut[i + 1];
          b = lut[i + 2];
        }
        if (a > hi) {
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = b;
          px[o + 3] = 255;
        } else {
          px[o] += Math.round((r - px[o]) * a);
          px[o + 1] += Math.round((g - px[o + 1]) * a);
          px[o + 2] += Math.round((b - px[o + 2]) * a);
          px[o + 3] += Math.round((255 - px[o + 3]) * a);
        }
      }
    });
  }
}

/**
 * Lays a group's layer over its parent: each pixel scaled by the group's
 * opacity and the mask (its luminance over black, or its alpha), mixed
 * with what is under it by the blend mode (PDF's and CSS's formulas).
 */
function composite(layer: Surface, parent: Surface, groupAlpha: number, blend: BlendMode, mask: Surface | undefined, luminance: boolean): void {
  const LW = layer.x1 - layer.x0;
  const PW = parent.x1 - parent.x0;
  const src = layer.data;
  const dst = parent.data;
  const md = mask?.data;
  const cs = [0, 0, 0];
  const cb = [0, 0, 0];
  for (let y = layer.y0; y < layer.y1; y++) {
    for (let x = layer.x0; x < layer.x1; x++) {
      const i = ((y - layer.y0) * LW + (x - layer.x0)) * 4;
      const sa = src[i + 3];
      if (!sa) continue;
      let f = groupAlpha;
      if (md) {
        f *= luminance ? (0.2125 * md[i] + 0.7154 * md[i + 1] + 0.0721 * md[i + 2]) / 255 : md[i + 3] / 255;
        if (f <= 0) continue;
      }
      const o = ((y - parent.y0) * PW + (x - parent.x0)) * 4;
      const as = (sa / 255) * f;
      const ab = dst[o + 3] / 255;
      if (blend === "normal" || ab === 0) {
        const keep = 1 - as;
        for (let c = 0; c < 4; c++) {
          const v = src[i + c] * f + dst[o + c] * keep;
          dst[o + c] = v >= 255 ? 255 : Math.round(v);
        }
        continue;
      }
      for (let c = 0; c < 3; c++) {
        cs[c] = src[i + c] / sa;
        cb[c] = dst[o + c] / 255 / ab;
      }
      const mixed = blendColor(blend, cb, cs);
      for (let c = 0; c < 3; c++) {
        // The source colour where the backdrop shows through, the blend where both are there.
        const sc = (1 - ab) * cs[c] + ab * Math.min(1, Math.max(0, mixed[c]));
        const v = 255 * as * sc + dst[o + c] * (1 - as);
        dst[o + c] = v >= 255 ? 255 : v <= 0 ? 0 : Math.round(v);
      }
      const va = 255 * (as + ab * (1 - as));
      dst[o + 3] = va >= 255 ? 255 : Math.round(va);
    }
  }
}
