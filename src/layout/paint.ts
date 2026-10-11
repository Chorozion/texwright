/**
 * Paint arithmetic shared by the PDF writer (which turns a gradient into a
 * shading), the rasterizer (which colours pixels with it) and SVG filters:
 * where a point falls along a gradient, how the spread method folds that
 * into the stops, the colour there, and the blend modes' formulas.
 */

import type { BlendMode, Color, Gradient } from "./types.js";

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 then m2: points map through m1 first (PDF's order for `cm`). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** The inverse, or undefined for a matrix that flattens everything onto a line. */
export function invert(m: Matrix): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 1e-12)) return undefined;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Where (x, y), in gradient space, falls along the gradient: 0 at the start
 * (the first point, or the focal circle), 1 at the end, beyond either end
 * outside 0..1. NaN where a radial gradient whose focal circle sticks out of
 * its end circle paints nothing.
 */
export function gradientT(g: Gradient, x: number, y: number): number {
  const c = g.coords;
  if (g.kind === "linear") {
    const dx = c[2] - c[0];
    const dy = c[3] - c[1];
    const len = dx * dx + dy * dy;
    return len > 0 ? ((x - c[0]) * dx + (y - c[1]) * dy) / len : 0;
  }
  // The circle at t has centre f + t (c - f) and radius fr + t (r - fr); find
  // the largest t whose circle passes through the point with a radius >= 0.
  const [fx, fy, fr, cx, cy, r] = c;
  const dx = cx - fx;
  const dy = cy - fy;
  const dr = r - fr;
  const qx = x - fx;
  const qy = y - fy;
  const a = dx * dx + dy * dy - dr * dr;
  const b = qx * dx + qy * dy + fr * dr;
  const cc = qx * qx + qy * qy - fr * fr;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-12) return NaN;
    const t = cc / (2 * b);
    return fr + t * dr >= 0 ? t : NaN;
  }
  const disc = b * b - a * cc;
  if (disc < 0) return NaN;
  const s = Math.sqrt(disc);
  const t1 = (b + s) / a;
  const t2 = (b - s) / a;
  const hi = Math.max(t1, t2);
  const lo = Math.min(t1, t2);
  if (fr + hi * dr >= 0) return hi;
  if (fr + lo * dr >= 0) return lo;
  return NaN;
}

/** t folded into 0..1 by the spread method: clamped (pad), wrapped (repeat) or mirrored (reflect). */
export function spreadT(t: number, spread: Gradient["spread"]): number {
  if (spread === "pad") return t < 0 ? 0 : t > 1 ? 1 : t;
  const f = t - Math.floor(t);
  if (spread === "repeat") return f;
  return Math.floor(t) % 2 === 0 ? f : 1 - f;
}

/** The colour of the stops at t (0..1): the end colours before the first and after the last stop. */
export function stopColor(stops: Gradient["stops"], t: number): Color {
  if (!stops.length) return [0, 0, 0];
  if (t <= stops[0].offset) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (t < b.offset) {
      const a = stops[i - 1];
      const w = b.offset - a.offset;
      const k = w > 0 ? (t - a.offset) / w : 1;
      return [a.color[0] + (b.color[0] - a.color[0]) * k, a.color[1] + (b.color[1] - a.color[1]) * k, a.color[2] + (b.color[2] - a.color[2]) * k];
    }
  }
  return stops[stops.length - 1].color;
}

/**
 * Stops cleaned for drawing: offsets clamped to 0..1 and never decreasing
 * (as SVG requires), colours clamped, at least one stop.
 */
export function normalStops(stops: Gradient["stops"]): Gradient["stops"] {
  const out: Gradient["stops"] = [];
  let last = 0;
  for (const s of stops) {
    const o = Math.max(last, Math.min(1, Math.max(0, Number.isFinite(s.offset) ? s.offset : 0)));
    last = o;
    out.push({ offset: o, color: s.color.map((v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))) as Color });
  }
  if (!out.length) out.push({ offset: 0, color: [0, 0, 0] });
  return out;
}

/**
 * The range of t a box covers, the box given as user-space points
 * [x0, y0, x1, y1, ...] mapped into gradient space by `inv`. For a linear
 * gradient t is extreme at a corner; for a radial one the largest t is at
 * a corner too (the circles grow), and the smallest is no less than 0 when
 * the focal circle is a point.
 */
export function tRange(g: Gradient, inv: Matrix, points: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const [x, y] = apply(inv, points[i], points[i + 1]);
    const t = gradientT(g, x, y);
    if (Number.isNaN(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (g.kind === "radial") {
    // Points inside the start circle have t from the corners' minimum down to where the radius is 0.
    const fr = g.coords[2];
    const dr = g.coords[5] - fr;
    lo = Math.min(lo, 0);
    if (dr > 0) lo = Math.max(lo, -fr / dr);
  }
  if (!(lo <= hi)) return [0, 1];
  return [lo, hi];
}

/** True when every stop has the same colour: the gradient paints a flat colour. */
export function flatColor(g: Gradient): Color | undefined {
  const first = g.stops[0]?.color;
  if (!first) return [0, 0, 0];
  for (const s of g.stops) if (s.color[0] !== first[0] || s.color[1] !== first[1] || s.color[2] !== first[2]) return undefined;
  return first;
}

// ---------------------------------------------------------------- blend modes

/** A blend mode's mix of backdrop cb and source cs (unpremultiplied 0..1), one channel. */
function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "multiply":
      return cb * cs;
    case "screen":
      return cb + cs - cb * cs;
    case "overlay":
      return blendChannel("hard-light", cs, cb);
    case "darken":
      return Math.min(cb, cs);
    case "lighten":
      return Math.max(cb, cs);
    case "color-dodge":
      return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case "color-burn":
      return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case "hard-light":
      return cs <= 0.5 ? cb * 2 * cs : blendChannel("screen", cb, 2 * cs - 1);
    case "soft-light": {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case "difference":
      return Math.abs(cb - cs);
    case "exclusion":
      return cb + cs - 2 * cb * cs;
    default:
      return cs;
  }
}

const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function clipColor(c: number[]): number[] {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return out;
}

function setLum(c: number[], l: number): number[] {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function setSat(c: number[], s: number): number[] {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  return c.map((v) => ((v - mn) * s) / (mx - mn));
}

const sat = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

/** A blend mode's mix of backdrop and source colours (unpremultiplied 0..1). */
export function blendColor(mode: BlendMode, cb: number[], cs: number[]): number[] {
  switch (mode) {
    case "hue":
      return setLum(setSat(cs, sat(cb)), lum(cb));
    case "saturation":
      return setLum(setSat(cb, sat(cs)), lum(cb));
    case "color":
      return setLum(cs, lum(cb));
    case "luminosity":
      return setLum(cb, lum(cs));
    default:
      return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])];
  }
}
