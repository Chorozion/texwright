/**
 * Stroking: the outline of a path drawn with a pen of some width, as
 * polygons for the nonzero fill rule, computed in user space (so a scaled
 * or skewed pen comes out right once the polygons are transformed).
 *
 * Curves are flattened first. An open subpath becomes one polygon: its left
 * side forward, the end cap, its right side backward, the start cap. A
 * closed subpath becomes two, the left side and the right side reversed.
 * At each corner the outer side gets the join (miter, round or bevel) and
 * the inner side passes through the corner point itself. That makes each
 * polygon add up, winding number for winding number, to one quadrilateral
 * per segment plus one wedge per outer join plus the caps, all turning the
 * same way: wherever the pen passed the winding number is nonzero, however
 * sharp the corners or tight the curves, and nowhere else.
 *
 * Dash patterns cut subpaths into open pieces first, restarting the pattern
 * at each subpath (the writer always uses phase 0).
 */

import type { PathCommand } from "../layout/types.js";
import { cubicSteps } from "./rasterizer.js";

export interface StrokeStyle {
  /** Half the line width, in user units. */
  half: number;
  /** 0 butt, 1 round, 2 projecting square. */
  cap: 0 | 1 | 2;
  /** 0 miter, 1 round, 2 bevel. */
  join: 0 | 1 | 2;
  miterLimit: number;
  /** Dash lengths (on, off, on...); undefined or empty for a solid line. */
  dash?: number[];
}

/** A flattened subpath: x, y pairs. */
interface Polyline {
  pts: number[];
  closed: boolean;
}

/** More dash pieces than this in one path and the line is drawn solid. */
const MAX_DASHES = 100_000;
/** Points closer than this (user units) are merged before stroking. */
const MERGE = 1e-9;

/** Flattens a path into polylines; subpaths that never draw are dropped. */
function flatten(d: PathCommand[], tolerance: number): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  let drawn = false;
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const end = () => {
    if (cur && drawn) out.push(cur);
    cur = null;
    drawn = false;
  };
  const begin = () => {
    if (!cur) cur = { pts: [cx, cy], closed: false };
    drawn = true;
    return cur;
  };
  for (const c of d) {
    switch (c[0]) {
      case "M":
        end();
        cx = sx = c[1];
        cy = sy = c[2];
        cur = { pts: [cx, cy], closed: false };
        break;
      case "L":
        begin().pts.push(c[1], c[2]);
        cx = c[1];
        cy = c[2];
        break;
      case "C": {
        const p = begin().pts;
        const [, x1, y1, x2, y2, x3, y3] = c;
        const n = cubicSteps(cx, cy, x1, y1, x2, y2, x3, y3, tolerance);
        for (let i = 1; i < n; i++) {
          const t = i / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const e = 3 * u * t * t;
          const f = t * t * t;
          p.push(a * cx + b * x1 + e * x2 + f * x3, a * cy + b * y1 + e * y2 + f * y3);
        }
        p.push(x3, y3);
        cx = x3;
        cy = y3;
        break;
      }
      case "Z":
        begin().closed = true;
        end();
        // A segment after closepath starts a new subpath at the closed one's start.
        cx = sx;
        cy = sy;
        break;
    }
  }
  end();
  return out;
}

/** Cuts polylines into the "on" pieces of a dash pattern; undefined when the pattern is solid or would make too many pieces. */
function dashed(lines: Polyline[], dash: number[]): Polyline[] | undefined {
  // An odd-length pattern repeats to even length, as in PDF.
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
  const period = pattern.reduce((s, v) => s + v, 0);
  if (!(period > 0)) return undefined;
  let total = 0;
  for (const l of lines) {
    const p = l.pts;
    const n = p.length / 2;
    for (let i = 1; i < n + (l.closed ? 1 : 0); i++) {
      const j = i % n;
      total += Math.hypot(p[2 * j] - p[2 * i - 2], p[2 * j + 1] - p[2 * i - 1]);
    }
  }
  if ((total / period) * pattern.length > MAX_DASHES) return undefined;
  const out: Polyline[] = [];
  for (const l of lines) {
    const p = l.pts;
    const n = p.length / 2;
    let k = 0; // pattern index; even entries draw
    let left = pattern[0];
    let piece: number[] | null = [p[0], p[1]];
    for (let i = 1; i < n + (l.closed ? 1 : 0); i++) {
      const j = i % n;
      let x0 = p[2 * i - 2];
      let y0 = p[2 * i - 1];
      const x1 = p[2 * j];
      const y1 = p[2 * j + 1];
      let len = Math.hypot(x1 - x0, y1 - y0);
      while (len >= left) {
        // The pattern switches inside this segment (or, for a zero length, at its start).
        const t = len > 0 ? left / len : 0;
        x0 += (x1 - x0) * t;
        y0 += (y1 - y0) * t;
        len -= left;
        if (piece) {
          piece.push(x0, y0);
          out.push({ pts: piece, closed: false });
          piece = null;
        } else piece = [x0, y0];
        k = (k + 1) % pattern.length;
        left = pattern[k];
      }
      left -= len;
      if (piece) piece.push(x1, y1);
    }
    if (piece) out.push({ pts: piece, closed: false });
  }
  return out;
}

/** Drops points that repeat the one before (and, when closed, the last point equal to the first). */
function merged(l: Polyline): Polyline {
  const p = l.pts;
  const q: number[] = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const x = p[i];
    const y = p[i + 1];
    if (Math.abs(x - q[q.length - 2]) > MERGE || Math.abs(y - q[q.length - 1]) > MERGE) q.push(x, y);
  }
  if (l.closed && q.length > 2 && Math.abs(q[0] - q[q.length - 2]) <= MERGE && Math.abs(q[1] - q[q.length - 1]) <= MERGE) q.length -= 2;
  return { pts: q, closed: l.closed };
}

/**
 * Stroke polygons of a path in user space, each passed to `emit` as x, y
 * pairs (implicitly closed). `tolerance` is the flattening tolerance in
 * user units.
 */
export function strokePath(d: PathCommand[], style: StrokeStyle, tolerance: number, emit: (polygon: number[]) => void): void {
  const h = style.half;
  if (!(h > 0)) return;
  let lines = flatten(d, tolerance);
  if (style.dash?.length) lines = dashed(lines, style.dash) ?? lines;
  // Angle per segment of a round join or cap: the chord stays within tolerance of the arc.
  const step = h > tolerance ? 2 * Math.acos(1 - tolerance / h) : Math.PI / 2;
  for (const raw of lines) {
    const l = merged(raw);
    const p = l.pts;
    const n = p.length / 2;
    if (n === 1) {
      // A zero-length subpath shows only with round caps, as a dot.
      if (style.cap === 1) {
        const out: number[] = [p[0] + h, p[1]];
        arc(out, p[0], p[1], h, 1, 0, 2 * Math.PI, step);
        emit(out);
      }
      continue;
    }
    // Unit direction of each segment (n - 1 open, n closed).
    const segs = l.closed ? n : n - 1;
    const ux = new Float64Array(segs);
    const uy = new Float64Array(segs);
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const dx = p[2 * j] - p[2 * i];
      const dy = p[2 * j + 1] - p[2 * i + 1];
      const len = Math.hypot(dx, dy);
      ux[i] = dx / len;
      uy[i] = dy / len;
    }
    // Left normal of segment i is (-uy, ux).
    if (!l.closed) {
      const out: number[] = [];
      out.push(p[0] - h * uy[0], p[1] + h * ux[0]);
      for (let i = 1; i < n - 1; i++) corner(out, p[2 * i], p[2 * i + 1], ux[i - 1], uy[i - 1], ux[i], uy[i], 1, h, style, step);
      const e = n - 1;
      out.push(p[2 * e] - h * uy[e - 1], p[2 * e + 1] + h * ux[e - 1]);
      cap(out, p[2 * e], p[2 * e + 1], ux[e - 1], uy[e - 1], h, style.cap, step);
      out.push(p[2 * e] + h * uy[e - 1], p[2 * e + 1] - h * ux[e - 1]);
      for (let i = n - 2; i >= 1; i--) corner(out, p[2 * i], p[2 * i + 1], ux[i - 1], uy[i - 1], ux[i], uy[i], -1, h, style, step);
      out.push(p[0] + h * uy[0], p[1] - h * ux[0]);
      cap(out, p[0], p[1], -ux[0], -uy[0], h, style.cap, step);
      emit(out);
    } else {
      const left: number[] = [];
      for (let i = 0; i < n; i++) {
        const k = (i + n - 1) % n;
        corner(left, p[2 * i], p[2 * i + 1], ux[k], uy[k], ux[i], uy[i], 1, h, style, step);
      }
      emit(left);
      const right: number[] = [];
      for (let i = n - 1; i >= 0; i--) {
        const k = (i + n - 1) % n;
        corner(right, p[2 * i], p[2 * i + 1], ux[k], uy[k], ux[i], uy[i], -1, h, style, step);
      }
      emit(right);
    }
  }
}

/**
 * The points of one side of the outline at the corner (x, y), between the
 * incoming direction (ax, ay) and the outgoing (bx, by): from the end of the
 * incoming offset edge to the start of the outgoing one. side is 1 for the
 * left side walked forward, -1 for the right side walked backward.
 */
function corner(out: number[], x: number, y: number, ax: number, ay: number, bx: number, by: number, side: 1 | -1, h: number, style: StrokeStyle, step: number): void {
  // Offset directions on this side, in walking order.
  let nx0: number;
  let ny0: number;
  let nx1: number;
  let ny1: number;
  if (side === 1) {
    nx0 = -ay;
    ny0 = ax;
    nx1 = -by;
    ny1 = bx;
  } else {
    nx0 = by;
    ny0 = -bx;
    nx1 = ay;
    ny1 = -ax;
  }
  out.push(x + h * nx0, y + h * ny0);
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  if (cross === 0 && dot > 0) return; // straight on: the two offset edges meet
  // The left side is outside a right turn; a U-turn counts as one.
  const outer = side === 1 ? cross < 0 || (cross === 0 && dot < 0) : cross > 0;
  if (!outer) {
    out.push(x, y);
  } else if (style.join === 1) {
    const angle = Math.acos(Math.max(-1, Math.min(1, nx0 * nx1 + ny0 * ny1)));
    arc(out, x, y, h, nx0, ny0, angle, step);
  } else if (style.join === 0) {
    const c = 1 + nx0 * nx1 + ny0 * ny1; // 2 cos²(θ/2)
    // The miter is 1 / cos(θ/2) line widths long.
    if (c > 1e-12 && 2 / c <= style.miterLimit * style.miterLimit) out.push(x + (h * (nx0 + nx1)) / c, y + (h * (ny0 + ny1)) / c);
  }
  out.push(x + h * nx1, y + h * ny1);
}

/** The cap at (x, y) facing direction (ux, uy): points between the left offset and the right one. */
function cap(out: number[], x: number, y: number, ux: number, uy: number, h: number, kind: 0 | 1 | 2, step: number): void {
  if (kind === 2) {
    out.push(x + h * (ux - uy), y + h * (uy + ux), x + h * (ux + uy), y + h * (uy - ux));
  } else if (kind === 1) {
    arc(out, x, y, h, -uy, ux, Math.PI, step);
  }
}

/**
 * Points strictly inside a clockwise arc around (x, y) of radius h, from
 * direction (nx, ny) through `angle` radians.
 */
function arc(out: number[], x: number, y: number, h: number, nx: number, ny: number, angle: number, step: number): void {
  const m = Math.min(1000, Math.ceil(angle / step));
  for (let k = 1; k < m; k++) {
    const t = (-angle * k) / m;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push(x + h * (nx * c - ny * s), y + h * (nx * s + ny * c));
  }
}
