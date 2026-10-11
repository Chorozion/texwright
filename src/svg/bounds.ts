/**
 * Bounding boxes of drawing operations, following save/restore/transform.
 * Curves are bounded exactly (cubic extrema), not by their control points.
 */

import type { DrawOp, PathCommand } from "../layout/types.js";
import { apply, IDENTITY, type Matrix, multiply } from "./matrix.js";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

class Acc {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add(x: number, y: number, pad = 0): void {
    if (x - pad < this.x0) this.x0 = x - pad;
    if (y - pad < this.y0) this.y0 = y - pad;
    if (x + pad > this.x1) this.x1 = x + pad;
    if (y + pad > this.y1) this.y1 = y + pad;
  }
  box(): Box | undefined {
    return this.x0 <= this.x1 ? { x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1 } : undefined;
  }
}

/** Parameter values in (0, 1) where one coordinate of a cubic has an extremum. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // derivative: 3[(p1-p0)(1-t)^2 + 2(p2-p1)t(1-t) + (p3-p2)t^2] = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      out.push((-b + r) / (2 * a), (-b - r) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Adds a path, transformed by m, to the accumulator. */
function addPath(acc: Acc, d: PathCommand[], m: Readonly<Matrix>, pad: number): void {
  let cx = 0;
  let cy = 0;
  for (const c of d) {
    if (c[0] === "M" || c[0] === "L") {
      [cx, cy] = apply(m, c[1], c[2]);
      acc.add(cx, cy, pad);
    } else if (c[0] === "C") {
      const [x1, y1] = apply(m, c[1], c[2]);
      const [x2, y2] = apply(m, c[3], c[4]);
      const [x3, y3] = apply(m, c[5], c[6]);
      for (const t of cubicExtrema(cx, x1, x2, x3)) acc.add(cubicAt(cx, x1, x2, x3, t), cubicAt(cy, y1, y2, y3, t), pad);
      for (const t of cubicExtrema(cy, y1, y2, y3)) acc.add(cubicAt(cx, x1, x2, x3, t), cubicAt(cy, y1, y2, y3, t), pad);
      acc.add(x3, y3, pad);
      cx = x3;
      cy = y3;
    }
  }
}

/** Bounds of a path's points in its own coordinates. */
export function pathBounds(d: PathCommand[], m: Readonly<Matrix> = IDENTITY): Box | undefined {
  const acc = new Acc();
  addPath(acc, d, m, 0);
  return acc.box();
}

/**
 * Bounds of drawing operations under the initial matrix `m0`. With
 * `strokes`, stroked paths are padded by half their line width (scaled);
 * `joins` widens that to what miter joins and square caps can reach. With
 * `clips`, each operation's box is cut to the bounding box of the
 * clip region in force (an over-estimate of what shows, never an under-estimate);
 * otherwise clip operations are ignored.
 */
export function opsBounds(ops: readonly DrawOp[], m0: Readonly<Matrix> = IDENTITY, opts: { strokes?: boolean; clips?: boolean; joins?: boolean } = {}): Box | undefined {
  const acc = new Acc();
  let m: Matrix = [...m0] as Matrix;
  let clip: Box | undefined;
  const stack: { m: Matrix; clip: Box | undefined }[] = [];
  const addBox = (b: Box | undefined) => {
    if (!b) return;
    if (clip) {
      b = { x0: Math.max(b.x0, clip.x0), y0: Math.max(b.y0, clip.y0), x1: Math.min(b.x1, clip.x1), y1: Math.min(b.y1, clip.y1) };
      if (b.x0 > b.x1 || b.y0 > b.y1) return;
    }
    acc.add(b.x0, b.y0);
    acc.add(b.x1, b.y1);
  };
  const corners = (pts: [number, number][]): Box | undefined => {
    const a = new Acc();
    for (const [x, y] of pts) {
      const p = apply(m, x, y);
      a.add(p[0], p[1]);
    }
    return a.box();
  };
  for (const op of ops) {
    switch (op.op) {
      case "save":
        stack.push({ m, clip });
        break;
      case "restore": {
        const top = stack.pop();
        if (top) {
          m = top.m;
          clip = top.clip;
        }
        break;
      }
      case "transform":
        m = multiply(m, op.m);
        break;
      case "path": {
        // With joins, room for miter joins and square caps too (the most a stroke can reach).
        const reach = opts.joins ? Math.max(op.lineJoin === 0 || op.lineJoin === undefined ? (op.miterLimit ?? 10) : 1, Math.SQRT2) : 1;
        const pad = opts.strokes && op.stroke && op.lineWidth ? (op.lineWidth / 2) * reach * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 0;
        const a = new Acc();
        addPath(a, op.d, m, pad);
        addBox(a.box());
        break;
      }
      case "glyphs": {
        const r = op.run;
        addBox(
          corners([
            [op.x, op.y - r.depth],
            [op.x + r.width, op.y - r.depth],
            [op.x, op.y + r.height],
            [op.x + r.width, op.y + r.height],
          ]),
        );
        break;
      }
      case "image":
        addBox(
          corners([
            [op.x, op.y],
            [op.x + op.width, op.y],
            [op.x, op.y + op.height],
            [op.x + op.width, op.y + op.height],
          ]),
        );
        break;
      case "group": {
        // What the group draws, within its box (and its mask, which can only hide).
        const inner = opsBounds(op.ops, m, opts);
        if (inner) {
          const [x0, y0, x1, y1] = op.bbox;
          const b = corners([
            [x0, y0],
            [x1, y0],
            [x0, y1],
            [x1, y1],
          ]);
          const both = b && { x0: Math.max(inner.x0, b.x0), y0: Math.max(inner.y0, b.y0), x1: Math.min(inner.x1, b.x1), y1: Math.min(inner.y1, b.y1) };
          if (both && both.x0 <= both.x1 && both.y0 <= both.y1) addBox(both);
        }
        break;
      }
      case "clip": {
        if (!opts.clips) break;
        const a = new Acc();
        addPath(a, op.d, m, 0);
        const b = a.box();
        if (!b) clip = { x0: 0, y0: 0, x1: -1, y1: -1 };
        else if (!clip) clip = b;
        else clip = { x0: Math.max(b.x0, clip.x0), y0: Math.max(b.y0, clip.y0), x1: Math.min(b.x1, clip.x1), y1: Math.min(b.y1, clip.y1) };
        break;
      }
    }
  }
  return acc.box();
}
