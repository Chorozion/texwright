/**
 * SVG filters, drawn to pixels: the element is rasterized by texwright's
 * own rasterizer on a grid aligned with its user space (so blurs and
 * offsets keep their direction under rotation), the filter primitives run
 * on those pixels, and the result comes back as an image with alpha that
 * covers the filter region. When the filter ends by laying the element
 * itself over what it made (a drop shadow, a glow), only that part is an
 * image: the element is drawn over it as vectors, so its text stays text.
 *
 * Primitives: feGaussianBlur (the three box blurs SVG prescribes, or an
 * exact kernel for small deviations), feOffset, feFlood, feComposite (every
 * operator, arithmetic included), feMerge, feBlend (every mode),
 * feColorMatrix, feComponentTransfer, feMorphology and feDropShadow, in
 * linearRGB or sRGB as color-interpolation-filters says. The rest
 * (lighting, turbulence, displacement, convolution, feImage, feTile) pass
 * their input through; the caller reports them.
 */

import { drawOps } from "../layout/shipout.js";
import { blendColor } from "../layout/paint.js";
import type { BlendMode, DrawOp, PathCommand } from "../layout/types.js";
import { encodePng } from "../raster/png.js";
import { createRasterWriter } from "../raster/writer.js";
import { createHash } from "node:crypto";
import { type EmbeddedImageRef, isEmbeddedImage } from "./image.js";
import { opsBounds } from "./bounds.js";
import { isSimilarity, type Matrix, multiply, invert, scaleOf } from "./matrix.js";

/** A transfer function of feComponentTransfer. */
export interface TransferFunction {
  type: "identity" | "table" | "discrete" | "linear" | "gamma";
  values: number[];
  slope: number;
  intercept: number;
  amplitude: number;
  exponent: number;
  offset: number;
}

export interface FilterPrimitive {
  /** The element name: feGaussianBlur, feOffset, ... */
  type: string;
  in?: string;
  in2?: string;
  result?: string;
  /** Attributes as written. */
  attrs: Map<string, string>;
  /** flood-color with flood-opacity applied to its alpha (feFlood, feDropShadow), sRGB 0..1. */
  flood?: [number, number, number, number];
  /** Works in linearRGB (the default) rather than sRGB. */
  linear: boolean;
  /** feMerge's inputs. */
  merge?: (string | undefined)[];
  /** feComponentTransfer's functions. */
  funcs?: Partial<Record<"R" | "G" | "B" | "A", TransferFunction>>;
  /** feDropShadow giving its shadow alone. */
  shadowOnly?: boolean;
}

export interface FilterSpec {
  /** The filter region in user space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** User units per primitive unit (the bounding box size for primitiveUnits="objectBoundingBox"). */
  unitX: number;
  unitY: number;
  primitives: FilterPrimitive[];
}

export interface FilterResult {
  /** What to draw instead of the element: an image in figure space, or nothing. */
  ops: DrawOp[];
  /** Primitive types that passed their input through. */
  unsupported: string[];
  /** Images in the element that could not be drawn into the filter (registered elsewhere). */
  droppedImages: boolean;
}

/** Pixels per figure point the filter works at (216 dpi; 144 for an effect drawn under the element), and the most pixels a filter may use. */
export const FILTER_PX_PER_PT = 3;
const UNDER_PX_PER_PT = 2;
export const FILTER_MAX_PIXELS = 4_000_000;

/** Premultiplied RGBA, 0..1, row-major. */
interface Buffer {
  data: Float32Array;
  linear: boolean;
}

const SUPPORTED = new Set(["feGaussianBlur", "feOffset", "feFlood", "feComposite", "feMerge", "feBlend", "feColorMatrix", "feComponentTransfer", "feMorphology", "feDropShadow"]);

/**
 * Runs a filter on drawing operations (in figure space) of an element whose
 * user space maps to figure space by `m`.
 */
export function runFilter(spec: FilterSpec, ops: DrawOp[], m: Readonly<Matrix>, split = true, pxPerPt = FILTER_PX_PER_PT): FilterResult {
  const unsupported = [...new Set(spec.primitives.filter((p) => !SUPPORTED.has(p.type)).map((p) => p.type))];
  // The element over an effect: draw the effect as an image, then the element itself.
  const under = unsupported.length || !split ? undefined : underneath(spec.primitives);
  if (under) {
    const r = runFilter({ ...spec, primitives: under }, ops, m, false, UNDER_PX_PER_PT);
    const inv = invert(m);
    const b = inv ? opsBounds(ops, inv, { strokes: true, clips: true, joins: true }) : undefined;
    const inside = b && b.x0 >= spec.x && b.y0 >= spec.y && b.x1 <= spec.x + spec.width && b.y1 <= spec.y + spec.height;
    // The filter region clips the element too.
    const region: DrawOp[] = inside
      ? ops
      : [{ op: "save" }, { op: "clip", d: rectPath(spec.x, spec.y, spec.width, spec.height, m) }, ...ops, { op: "restore" }];
    return { ops: [...r.ops, ...region], unsupported, droppedImages: r.droppedImages };
  }
  const empty: FilterResult = { ops: [], unsupported, droppedImages: false };
  if (!(spec.width > 0 && spec.height > 0)) return empty;
  const inv = invert(m);
  if (!inv) return empty;
  // Pixels per user unit.
  let k = pxPerPt * scaleOf(m);
  if (!(k > 0) || !Number.isFinite(k)) return empty;
  const area = spec.width * spec.height * k * k;
  if (area > FILTER_MAX_PIXELS) k *= Math.sqrt(FILTER_MAX_PIXELS / area);
  const W = Math.max(1, Math.ceil(spec.width * k - 1e-6));
  const H = Math.max(1, Math.ceil(spec.height * k - 1e-6));

  // The element, drawn on a grid over the filter region: pixel (i, j) is user point (x + i/k, y + j/k).
  const writer = createRasterWriter({ dpi: 72, transparent: true });
  let droppedImages = false;
  const register = (list: DrawOp[]): DrawOp[] =>
    list.flatMap((op): DrawOp[] => {
      if (op.op === "group") return [{ ...op, ops: register(op.ops), ...(op.mask ? { mask: { ...op.mask, ops: register(op.mask.ops) } } : {}) }];
      if (op.op !== "image") return [op];
      if (!isEmbeddedImage(op.image)) {
        droppedImages = true;
        return [];
      }
      try {
        return [{ ...op, image: writer.addImage(op.image.bytes) }];
      } catch {
        return [];
      }
    });
  const page = writer.addPage(W, H);
  // Page points (y up) from user space: (ux, uy) -> ((ux - x) k, H - (uy - y) k); then figure space through m.
  const toPage: Matrix = [k, 0, 0, -k, -spec.x * k, H + spec.y * k];
  page.save();
  page.transform(multiply(toPage, inv));
  drawOps(page, { t: "drawing", ops: register(ops), width: 0, height: 0, depth: 0 }, 0, 0);
  page.restore();
  const raster = writer.pages[0].rgba();
  writer.finish();
  if (!raster) return empty;
  const source = new Float32Array(W * H * 4);
  for (let i = 0; i < source.length; i++) source[i] = raster[i] / 255;

  const out = applyPrimitives(spec, source, W, H, k);
  const png = toPng(out, W, H);
  if (!png) return { ...empty, droppedImages };
  const image: EmbeddedImageRef = { id: `svg-filter-${createHash("sha256").update(png).digest("hex").slice(0, 24)}`, pixelWidth: W, pixelHeight: H, bytes: png, format: "png" };
  // The image covers the pixels' user rectangle, row 0 at its top.
  const uw = W / k;
  const uh = H / k;
  const N = multiply(m, [1, 0, 0, -1, spec.x, spec.y + uh]);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const result: DrawOp[] =
    isSimilarity(N) && Math.abs(N[1]) < 1e-12 && Math.abs(N[2]) < 1e-12 && N[0] > 0 && N[3] > 0
      ? [{ op: "image", x: r4(N[4]), y: r4(N[5]), width: r4(uw * N[0]), height: r4(uh * N[3]), image }]
      : [{ op: "save" }, { op: "transform", m: N.map((v) => Math.round(v * 1e6) / 1e6) as Matrix }, { op: "image", x: 0, y: 0, width: uw, height: uh, image }, { op: "restore" }];
  return { ops: result, unsupported, droppedImages };
}

/**
 * When a filter's last step lays the source graphic over something else
 * (feMerge ending with SourceGraphic, feComposite or feBlend in normal mode
 * with in="SourceGraphic", a drop shadow of the source), the primitives
 * that make that something else; undefined otherwise.
 */
function underneath(prims: FilterPrimitive[]): FilterPrimitive[] | undefined {
  const n = prims.length;
  if (!n) return undefined;
  const last = prims[n - 1];
  const isSource = (name: string | undefined, index: number) => name === "SourceGraphic" || ((name === undefined || name === "") && index === 0);
  // Earlier results the last step reads must not be the source graphic changed in colour space only: any name is fine.
  const before = prims.slice(0, n - 1);
  const pass = (input: string | undefined): FilterPrimitive => ({ type: "feOffset", in: input, attrs: new Map(), linear: last.linear });
  if (last.type === "feMerge" && last.merge && last.merge.length >= 2 && last.merge[last.merge.length - 1] === "SourceGraphic") {
    return [...before, { ...last, merge: last.merge.slice(0, -1) }];
  }
  if ((last.type === "feComposite" && (last.attrs.get("operator") ?? "over").trim() === "over") || (last.type === "feBlend" && (last.attrs.get("mode") ?? "normal").trim() === "normal")) {
    if (isSource(last.in, n - 1) && last.in2 !== undefined && last.in2 !== "SourceGraphic") return [...before, pass(last.in2)];
    return undefined;
  }
  if (last.type === "feDropShadow" && isSource(last.in, n - 1)) return [...before, { ...last, shadowOnly: true }];
  return undefined;
}

/** A rectangle in user space as a path in figure space. */
function rectPath(x: number, y: number, w: number, h: number, m: Readonly<Matrix>): PathCommand[] {
  const X = (px: number, py: number) => m[0] * px + m[2] * py + m[4];
  const Y = (px: number, py: number) => m[1] * px + m[3] * py + m[5];
  return [["M", X(x, y), Y(x, y)], ["L", X(x + w, y), Y(x + w, y)], ["L", X(x + w, y + h), Y(x + w, y + h)], ["L", X(x, y + h), Y(x, y + h)], ["Z"]];
}

// ---------------------------------------------------------------- primitives

/** Runs the primitives; the last result, in sRGB. */
function applyPrimitives(spec: FilterSpec, source: Float32Array, W: number, H: number, k: number): Float32Array {
  const results = new Map<string, Buffer>();
  const sourceGraphic: Buffer = { data: source, linear: false };
  let sourceAlpha: Buffer | undefined;
  let last: Buffer = sourceGraphic;
  const input = (name: string | undefined, linear: boolean): Buffer => {
    let b: Buffer;
    if (name === undefined || name === "") b = last;
    else if (name === "SourceGraphic") b = sourceGraphic;
    else if (name === "SourceAlpha") {
      if (!sourceAlpha) {
        const d = new Float32Array(W * H * 4);
        for (let i = 3; i < d.length; i += 4) d[i] = source[i];
        sourceAlpha = { data: d, linear: false };
      }
      // Alpha alone is the same in either space.
      return { data: sourceAlpha.data, linear };
    } else b = results.get(name) ?? (name === "BackgroundImage" || name === "BackgroundAlpha" || name === "FillPaint" || name === "StrokePaint" ? { data: new Float32Array(W * H * 4), linear } : last);
    return b.linear === linear ? b : { data: convert(b.data, linear), linear };
  };
  const px = (v: number, axis: "x" | "y") => v * (axis === "x" ? spec.unitX : spec.unitY) * k;
  for (const p of spec.primitives) {
    const lin = p.linear;
    let out: Float32Array;
    const num = (name: string, dflt: number) => {
      const v = Number(p.attrs.get(name)?.trim());
      return Number.isFinite(v) ? v : dflt;
    };
    const pair = (name: string, dflt: number): [number, number] => {
      const parts = (p.attrs.get(name) ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
      const a = Number.isFinite(parts[0]) ? parts[0] : dflt;
      const b = Number.isFinite(parts[1]) ? parts[1] : a;
      return [a, b];
    };
    switch (p.type) {
      case "feGaussianBlur": {
        const [sx, sy] = pair("stdDeviation", 0);
        out = blur(input(p.in, lin).data, W, H, Math.max(0, px(sx, "x")), Math.max(0, px(sy, "y")));
        break;
      }
      case "feOffset":
        out = offset(input(p.in, lin).data, W, H, px(num("dx", 0), "x"), px(num("dy", 0), "y"));
        break;
      case "feFlood":
        out = flood(W, H, p.flood ?? [0, 0, 0, 1], lin);
        break;
      case "feDropShadow": {
        const src = input(p.in, lin).data;
        const [sx, sy] = pair("stdDeviation", 2);
        const blurred = blur(src, W, H, Math.max(0, px(sx, "x")), Math.max(0, px(sy, "y")), true);
        const moved = offset(blurred, W, H, px(num("dx", 2), "x"), px(num("dy", 2), "y"));
        const shadow = composite(flood(W, H, p.flood ?? [0, 0, 0, 1], lin), moved, "in");
        out = p.shadowOnly ? shadow : composite(src, shadow, "over");
        break;
      }
      case "feComposite": {
        const op = (p.attrs.get("operator") ?? "over").trim();
        out = composite(input(p.in, lin).data, input(p.in2, lin).data, op, [num("k1", 0), num("k2", 0), num("k3", 0), num("k4", 0)]);
        break;
      }
      case "feMerge": {
        out = new Float32Array(W * H * 4);
        for (const name of p.merge ?? []) out = composite(input(name, lin).data, out, "over");
        break;
      }
      case "feBlend": {
        const mode = (p.attrs.get("mode") ?? "normal").trim() as BlendMode;
        out = blendBuffers(input(p.in, lin).data, input(p.in2, lin).data, mode);
        break;
      }
      case "feColorMatrix":
        out = colorMatrix(input(p.in, lin).data, (p.attrs.get("type") ?? "matrix").trim(), p.attrs.get("values"));
        break;
      case "feComponentTransfer":
        out = componentTransfer(input(p.in, lin).data, p.funcs ?? {});
        break;
      case "feMorphology": {
        const [rx, ry] = pair("radius", 0);
        out = morphology(input(p.in, lin).data, W, H, Math.round(px(rx, "x")), Math.round(px(ry, "y")), (p.attrs.get("operator") ?? "erode").trim() === "dilate");
        break;
      }
      case "feImage":
        out = new Float32Array(W * H * 4);
        break;
      default:
        out = input(p.in, lin).data;
    }
    last = { data: out, linear: lin };
    if (p.result) results.set(p.result, last);
  }
  return last.linear ? convert(last.data, false) : last.data;
}

// ---------------------------------------------------------------- colour spaces

const TO_LINEAR = new Float32Array(4097);
const TO_SRGB = new Float32Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  TO_SRGB[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function lookup(table: Float32Array, v: number): number {
  const x = (v <= 0 ? 0 : v >= 1 ? 1 : v) * 4096;
  const i = Math.floor(x);
  if (i >= 4096) return table[4096];
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

/** Premultiplied pixels from one colour space to the other (to linearRGB when `toLinear`). */
function convert(src: Float32Array, toLinear: boolean): Float32Array {
  const table = toLinear ? TO_LINEAR : TO_SRGB;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    out[i + 3] = a;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) out[i + c] = lookup(table, src[i + c] / a) * a;
  }
  return out;
}

// ---------------------------------------------------------------- operations

/**
 * Gaussian blur: an exact kernel below a deviation of 2 pixels, SVG's three
 * box blurs from there. With `alphaOnly` the colour channels are left at 0
 * (for shadows, which use the alpha alone).
 */
export function blur(src: Float32Array, W: number, H: number, sx: number, sy: number, alphaOnly = false): Float32Array {
  let data = src;
  if (sx > 0) data = blurAxis(data, W, H, sx, true, alphaOnly);
  if (sy > 0) data = blurAxis(data, W, H, sy, false, alphaOnly);
  if (data !== src) return data;
  if (!alphaOnly) return src.slice();
  const out = new Float32Array(src.length);
  for (let i = 3; i < src.length; i += 4) out[i] = src[i];
  return out;
}

function blurAxis(src: Float32Array, W: number, H: number, s: number, horizontal: boolean, alphaOnly: boolean): Float32Array {
  const len = horizontal ? W : H;
  const lines = horizontal ? H : W;
  const step = horizontal ? 4 : 4 * W;
  const lineStep = horizontal ? 4 * W : 4;
  let a = new Float32Array(len);
  let b = new Float32Array(len);
  const out = new Float32Array(src.length);
  let passes: ((from: Float32Array, to: Float32Array) => void)[];
  if (s < 2) {
    const r = Math.ceil(3 * s);
    const kernel = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += kernel[i + r] = Math.exp(-(i * i) / (2 * s * s));
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    passes = [(from, to) => convolve(from, to, len, kernel, r)];
  } else {
    const d = Math.floor(s * ((3 * Math.sqrt(2 * Math.PI)) / 4) + 0.5);
    const h = (d - 1) / 2;
    passes =
      d % 2 === 1
        ? [(from, to) => box(from, to, len, h, h), (from, to) => box(from, to, len, h, h), (from, to) => box(from, to, len, h, h)]
        : [(from, to) => box(from, to, len, d / 2, d / 2 - 1), (from, to) => box(from, to, len, d / 2 - 1, d / 2), (from, to) => box(from, to, len, d / 2, d / 2)];
  }
  for (let c = alphaOnly ? 3 : 0; c < 4; c++) {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep + c;
      let any = false;
      for (let i = 0, o = base; i < len; i++, o += step) {
        const v = src[o];
        a[i] = v;
        if (v !== 0) any = true;
      }
      // A line with nothing on it stays empty.
      if (!any) continue;
      for (const pass of passes) {
        pass(a, b);
        const t = a;
        a = b;
        b = t;
      }
      for (let i = 0, o = base; i < len; i++, o += step) out[o] = a[i];
    }
  }
  return out;
}

/** Average over [i - left, i + right] of one channel, transparent outside the line. */
function box(from: Float32Array, to: Float32Array, len: number, left: number, right: number): void {
  const n = left + right + 1;
  let sum = 0;
  for (let j = 0; j <= right && j < len; j++) sum += from[j];
  for (let i = 0; i < len; i++) {
    to[i] = sum / n;
    const add = i + right + 1;
    const drop = i - left;
    if (add < len) sum += from[add];
    if (drop >= 0) sum -= from[drop];
  }
}

function convolve(from: Float32Array, to: Float32Array, len: number, kernel: Float32Array, r: number): void {
  for (let i = 0; i < len; i++) {
    let sum = 0;
    const j0 = Math.max(-r, -i);
    const j1 = Math.min(r, len - 1 - i);
    for (let j = j0; j <= j1; j++) sum += from[i + j] * kernel[j + r];
    to[i] = sum;
  }
}

/** Moves the image by (dx, dy) pixels, bilinearly. */
function offset(src: Float32Array, W: number, H: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(src.length);
  const ix = Math.floor(dx);
  const iy = Math.floor(dy);
  const fx = dx - ix;
  const fy = dy - iy;
  const weights: [number, number, number][] = [
    [0, 0, (1 - fx) * (1 - fy)],
    [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy],
    [1, 1, fx * fy],
  ];
  for (const [ox, oy, w] of weights) {
    if (w < 1e-6) continue;
    const sx = ix + ox;
    const sy = iy + oy;
    for (let y = Math.max(0, sy); y < Math.min(H, H + sy); y++) {
      const from = ((y - sy) * W + Math.max(0, -sx)) * 4;
      const to = (y * W + Math.max(0, sx)) * 4;
      const n = (W - Math.abs(sx)) * 4;
      for (let i = 0; i < n; i++) out[to + i] += src[from + i] * w;
    }
  }
  return out;
}

function flood(W: number, H: number, c: [number, number, number, number], linear: boolean): Float32Array {
  const out = new Float32Array(W * H * 4);
  const a = Math.min(1, Math.max(0, c[3]));
  const col = [0, 1, 2].map((i) => (linear ? lookup(TO_LINEAR, c[i]) : c[i]) * a);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = col[0];
    out[i + 1] = col[1];
    out[i + 2] = col[2];
    out[i + 3] = a;
  }
  return out;
}

/** Porter-Duff compositing of A (in) with B (in2); arithmetic uses k1..k4. */
function composite(A: Float32Array, B: Float32Array, op: string, k: number[] = [0, 0, 0, 0]): Float32Array {
  const out = new Float32Array(A.length);
  for (let i = 0; i < A.length; i += 4) {
    const aa = A[i + 3];
    const ab = B[i + 3];
    let fa: number;
    let fb: number;
    switch (op) {
      case "in":
        fa = ab;
        fb = 0;
        break;
      case "out":
        fa = 1 - ab;
        fb = 0;
        break;
      case "atop":
        fa = ab;
        fb = 1 - aa;
        break;
      case "xor":
        fa = 1 - ab;
        fb = 1 - aa;
        break;
      case "lighter":
        fa = 1;
        fb = 1;
        break;
      case "arithmetic": {
        const v = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) v[c] = Math.min(1, Math.max(0, k[0] * A[i + c] * B[i + c] + k[1] * A[i + c] + k[2] * B[i + c] + k[3]));
        out[i + 3] = v[3];
        for (let c = 0; c < 3; c++) out[i + c] = Math.min(v[c], v[3]);
        continue;
      }
      default:
        fa = 1;
        fb = 1 - aa;
    }
    for (let c = 0; c < 4; c++) out[i + c] = Math.min(1, A[i + c] * fa + B[i + c] * fb);
  }
  return out;
}

/** feBlend: `top` (in) laid over `bottom` (in2) with a blend mode. */
function blendBuffers(top: Float32Array, bottom: Float32Array, mode: BlendMode): Float32Array {
  if (mode === "normal" || !mode) return composite(top, bottom, "over");
  const out = new Float32Array(top.length);
  const cs = [0, 0, 0];
  const cb = [0, 0, 0];
  for (let i = 0; i < top.length; i += 4) {
    const as = top[i + 3];
    const ab = bottom[i + 3];
    if (as <= 0 || ab <= 0) {
      for (let c = 0; c < 4; c++) out[i + c] = top[i + c] + bottom[i + c] * (1 - as);
      continue;
    }
    for (let c = 0; c < 3; c++) {
      cs[c] = top[i + c] / as;
      cb[c] = bottom[i + c] / ab;
    }
    const mixed = blendColor(mode, cb, cs);
    for (let c = 0; c < 3; c++) {
      const sc = (1 - ab) * cs[c] + ab * Math.min(1, Math.max(0, mixed[c]));
      out[i + c] = as * sc + bottom[i + c] * (1 - as);
    }
    out[i + 3] = as + ab * (1 - as);
  }
  return out;
}

/** feColorMatrix on unpremultiplied colour. */
function colorMatrix(src: Float32Array, type: string, valuesAttr: string | undefined): Float32Array {
  const values = (valuesAttr ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  let m: number[];
  if (type === "saturate") {
    const s = Number.isFinite(values[0]) ? values[0] : 1;
    m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0, 0, 0, 0, 1, 0];
  } else if (type === "hueRotate") {
    const a = ((Number.isFinite(values[0]) ? values[0] : 0) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    m = [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0, 0,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0,
      0, 0, 0, 1, 0,
    ];
  } else if (type === "luminanceToAlpha") {
    m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2125, 0.7154, 0.0721, 0, 0];
  } else {
    m = values.length === 20 && values.every(Number.isFinite) ? values : [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  }
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    const r = a > 0 ? src[i] / a : 0;
    const g = a > 0 ? src[i + 1] / a : 0;
    const b = a > 0 ? src[i + 2] / a : 0;
    const na = Math.min(1, Math.max(0, m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19]));
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, m[5 * c] * r + m[5 * c + 1] * g + m[5 * c + 2] * b + m[5 * c + 3] * a + m[5 * c + 4]));
      out[i + c] = v * na;
    }
    out[i + 3] = na;
  }
  return out;
}

function transfer(f: TransferFunction | undefined, v: number): number {
  if (!f) return v;
  switch (f.type) {
    case "table": {
      const t = f.values;
      if (!t.length) return v;
      if (t.length === 1) return t[0];
      const n = t.length - 1;
      const k = Math.min(n - 1, Math.floor(v * n));
      return t[k] + (v * n - k) * (t[k + 1] - t[k]);
    }
    case "discrete": {
      const t = f.values;
      if (!t.length) return v;
      return t[Math.min(t.length - 1, Math.floor(v * t.length))];
    }
    case "linear":
      return f.slope * v + f.intercept;
    case "gamma":
      return f.amplitude * Math.pow(v, f.exponent) + f.offset;
    default:
      return v;
  }
}

function componentTransfer(src: Float32Array, funcs: Partial<Record<"R" | "G" | "B" | "A", TransferFunction>>): Float32Array {
  const out = new Float32Array(src.length);
  const keys = ["R", "G", "B"] as const;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    const na = Math.min(1, Math.max(0, transfer(funcs.A, a)));
    for (let c = 0; c < 3; c++) {
      const v = a > 0 ? src[i + c] / a : 0;
      out[i + c] = Math.min(1, Math.max(0, transfer(funcs[keys[c]], v))) * na;
    }
    out[i + 3] = na;
  }
  return out;
}

/**
 * Erode (minimum) or dilate (maximum) over a (2rx + 1) x (2ry + 1) window,
 * per channel, outside the image counting as transparent black. Each pass
 * is van Herk and Gil-Werman's: block-wise running extremes from both
 * sides, so the cost does not grow with the radius.
 */
function morphology(src: Float32Array, W: number, H: number, rx: number, ry: number, dilate: boolean): Float32Array {
  if (rx <= 0 && ry <= 0) return src.slice();
  const pick = dilate ? (a: number, b: number) => (a > b ? a : b) : (a: number, b: number) => (a < b ? a : b);
  const pass = (from: Float32Array, r: number, horizontal: boolean): Float32Array => {
    if (r <= 0) return from;
    const len = horizontal ? W : H;
    const lines = horizontal ? H : W;
    const step = horizontal ? 4 : 4 * W;
    const lineStep = horizontal ? 4 * W : 4;
    const k = 2 * r + 1;
    // The line padded by r transparent pixels each side, rounded up to whole blocks of k.
    const n = Math.ceil((len + 2 * r) / k) * k;
    const line = new Float32Array(n);
    const g = new Float32Array(n);
    const h = new Float32Array(n);
    const out = new Float32Array(from.length);
    for (let c = 0; c < 4; c++) {
      for (let l = 0; l < lines; l++) {
        const base = l * lineStep + c;
        line.fill(0);
        for (let i = 0, o = base; i < len; i++, o += step) line[r + i] = from[o];
        for (let b = 0; b < n; b += k) {
          g[b] = line[b];
          for (let i = b + 1; i < b + k; i++) g[i] = pick(g[i - 1], line[i]);
          h[b + k - 1] = line[b + k - 1];
          for (let i = b + k - 2; i >= b; i--) h[i] = pick(h[i + 1], line[i]);
        }
        // The window of output i is line[i .. i + 2r] (padded coordinates).
        for (let i = 0, o = base; i < len; i++, o += step) out[o] = pick(h[i], g[i + k - 1]);
      }
    }
    return out;
  };
  const cap = Math.max(W, H);
  return pass(pass(src, Math.min(rx, cap), true), Math.min(ry, cap), false);
}

/** The result as an RGBA PNG (unpremultiplied); undefined when it is fully transparent. */
function toPng(src: Float32Array, W: number, H: number): Uint8Array | undefined {
  const out = new Uint8Array(W * H * 4);
  let any = false;
  for (let i = 0; i < src.length; i += 4) {
    const a = Math.min(1, Math.max(0, src[i + 3]));
    const a8 = Math.round(a * 255);
    if (!a8) continue;
    any = true;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(Math.min(1, Math.max(0, src[i + c] / a)) * 255);
    out[i + 3] = a8;
  }
  return any ? encodePng(W, H, out, 4) : undefined;
}
