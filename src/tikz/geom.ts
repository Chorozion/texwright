/** Points, affine transforms and path segments, in TeX points with y pointing up. */

export type Pt = [number, number];
/** Affine map [a, b, c, d, e, f]: (x, y) -> (a x + c y + e, b x + d y + f), as in SVG and PDF. */
export type Mat = [number, number, number, number, number, number];

export const ID: Mat = [1, 0, 0, 1, 0, 0];

export function apply(m: Mat, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** The linear part only (for offsets). */
export function applyLinear(m: Mat, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];
}

/** m then n: the point is mapped by n first, then m (TikZ appends transformations this way). */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function rotation(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
export const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const angleOf = (v: Pt): number => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
export const dir = (deg: number): Pt => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

export function unit(v: Pt): Pt {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-9 ? [v[0] / l, v[1] / l] : [1, 0];
}

export type Seg =
  | { t: "M"; p: Pt }
  | { t: "L"; p: Pt; r?: number }
  | { t: "C"; c1: Pt; c2: Pt; p: Pt }
  | { t: "Z"; r?: number };

/** A cubic's point at t. */
export function bez(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
  ];
}

/** The cubic's tangent direction at t. */
export function bezTangent(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const d: Pt = [
    3 * u * u * (c1[0] - p0[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]),
    3 * u * u * (c1[1] - p0[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]),
  ];
  if (Math.hypot(d[0], d[1]) < 1e-9) return sub(p3, p0);
  return d;
}

/**
 * Cubics for an elliptical arc around `center` with radii rx, ry along the
 * (already transformed) axis vectors ex, ey, from angle a0 to a1 in degrees.
 */
export function arcCubics(center: Pt, ex: Pt, ey: Pt, a0: number, a1: number): { start: Pt; segs: { c1: Pt; c2: Pt; p: Pt }[] } {
  const at = (deg: number): Pt => {
    const r = (deg * Math.PI) / 180;
    return [center[0] + ex[0] * Math.cos(r) + ey[0] * Math.sin(r), center[1] + ex[1] * Math.cos(r) + ey[1] * Math.sin(r)];
  };
  const deriv = (deg: number): Pt => {
    const r = (deg * Math.PI) / 180;
    return [-ex[0] * Math.sin(r) + ey[0] * Math.cos(r), -ex[1] * Math.sin(r) + ey[1] * Math.cos(r)];
  };
  const total = a1 - a0;
  const n = Math.max(1, Math.min(64, Math.ceil(Math.abs(total) / 90 - 1e-9)));
  const step = total / n;
  const k = (4 / 3) * Math.tan((step * Math.PI) / 180 / 4);
  const segs: { c1: Pt; c2: Pt; p: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const s = a0 + i * step;
    const e = s + step;
    const p0 = at(s);
    const p3 = at(e);
    const d0 = deriv(s);
    const d3 = deriv(e);
    segs.push({ c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]], c2: [p3[0] - k * d3[0], p3[1] - k * d3[1]], p: p3 });
  }
  return { start: at(a0), segs };
}

/** Catmull-Rom style smooth curve through points (TikZ's `smooth`, tension 0.55). */
export function smoothThrough(pts: Pt[], closed: boolean, tension = 0.55): { c1: Pt; c2: Pt; p: Pt }[] {
  const n = pts.length;
  const out: { c1: Pt; c2: Pt; p: Pt }[] = [];
  if (n < 2) return out;
  // pgf scales the tension so that 0.55 is close to a Catmull-Rom spline (a sixth of the chord).
  const k = tension * 0.3;
  const get = (i: number): Pt => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const t1: Pt = scale(sub(p2, p0), k);
    const t2: Pt = scale(sub(p3, p1), k);
    out.push({ c1: add(p1, t1), c2: sub(p2, t2), p: p2 });
  }
  return out;
}

/** Intersection of lines p1-p2 and p3-p4 (infinite lines), or undefined when parallel. */
export function lineIntersection(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | undefined {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-12) return undefined;
  const a = p1[0] * p2[1] - p1[1] * p2[0];
  const b = p3[0] * p4[1] - p3[1] * p4[0];
  return [(a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d, (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d];
}
