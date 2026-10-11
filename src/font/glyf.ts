/**
 * TrueType outlines: loca offsets, glyph headers, composite components and
 * the outlines themselves. Glyphs are located on demand; nothing is decoded
 * until asked for.
 */

import type { PathCommand } from "../layout/types.js";
import { FontError } from "./errors.js";
import { Reader } from "./reader.js";

export interface GlyphBox {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

// Simple glyph flags.
const ON_CURVE_POINT = 0x01;
const X_SHORT_VECTOR = 0x02;
const Y_SHORT_VECTOR = 0x04;
const REPEAT_FLAG = 0x08;
const X_IS_SAME_OR_POSITIVE = 0x10;
const Y_IS_SAME_OR_POSITIVE = 0x20;

// Composite glyph flags.
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const SCALED_COMPONENT_OFFSET = 0x0800;
const UNSCALED_COMPONENT_OFFSET = 0x1000;

/** Deeper composite nesting than this is treated as corrupt. */
export const MAX_COMPOSITE_DEPTH = 64;
/**
 * Budgets for assembling one outline. Composites can repeat a component at
 * every level, so a small hostile glyf table could otherwise ask for an
 * exponential number of points or component visits.
 */
const MAX_OUTLINE_POINTS = 1 << 18;
const MAX_COMPONENT_VISITS = 1 << 16;

/** Glyph points as they are assembled: coordinates, on-curve flags and the last point of each contour. */
interface Points {
  xs: number[];
  ys: number[];
  on: boolean[];
  ends: number[];
}

const f2dot14 = (r: Reader, p: number) => r.i16(p) / 16384;

export class GlyfTable {
  readonly loca: Reader;
  readonly glyf: Reader;
  readonly longOffsets: boolean;
  readonly numGlyphs: number;
  /** Glyphs with a full pair of loca entries; any beyond are empty. */
  private readonly located: number;

  constructor(loca: Reader, glyf: Reader, indexToLocFormat: number, numGlyphs: number) {
    if (indexToLocFormat !== 0 && indexToLocFormat !== 1) {
      throw new FontError(`head.indexToLocFormat ${indexToLocFormat} is neither 0 nor 1`);
    }
    this.loca = loca;
    this.glyf = glyf;
    this.longOffsets = indexToLocFormat === 1;
    this.numGlyphs = numGlyphs;
    const entries = Math.floor(loca.length / (this.longOffsets ? 4 : 2));
    this.located = Math.max(0, Math.min(numGlyphs, entries - 1));
  }

  /** [start, end) of a glyph's data in glyf; equal when the glyph is empty. */
  range(gid: number): [number, number] {
    if (!(gid >= 0 && gid < this.located)) return [0, 0];
    let start: number;
    let end: number;
    if (this.longOffsets) {
      start = this.loca.u32(4 * gid);
      end = this.loca.u32(4 * gid + 4);
    } else {
      start = 2 * this.loca.u16(2 * gid);
      end = 2 * this.loca.u16(2 * gid + 2);
    }
    if (start === end) return [start, end];
    if (start > end) throw new FontError(`glyph ${gid}: loca offsets decrease (${start} > ${end})`);
    // Tolerate a last glyph that claims glyf's missing padding.
    if (end > this.glyf.length && end - this.glyf.length <= 3) end = this.glyf.length;
    if (end > this.glyf.length) {
      throw new FontError(`glyph ${gid}: data (${start}..${end}) lies outside the ${this.glyf.length}-byte glyf table`);
    }
    return [start, end];
  }

  /** Glyph data, or an empty slice for an empty glyph. */
  data(gid: number): Uint8Array {
    const [start, end] = this.range(gid);
    return this.glyf.bytes.subarray(start, end);
  }

  /** Header bounding box; undefined for an empty glyph. */
  box(gid: number): GlyphBox | undefined {
    const [start, end] = this.range(gid);
    if (start === end) return undefined;
    if (end - start < 10) throw new FontError(`glyph ${gid}: ${end - start} bytes is too short for a glyph header`);
    const g = this.glyf;
    return { xMin: g.i16(start + 2), yMin: g.i16(start + 4), xMax: g.i16(start + 6), yMax: g.i16(start + 8) };
  }

  isComposite(gid: number): boolean {
    const [start, end] = this.range(gid);
    return end - start >= 10 && this.glyf.i16(start) < 0;
  }

  /** Glyph ids a composite glyph refers to (empty for a simple glyph). */
  components(gid: number): number[] {
    const [start, end] = this.range(gid);
    if (end - start < 10) return [];
    const r = this.glyf.sub(start, end - start, `glyph ${gid}`);
    if (r.i16(0) >= 0) return [];
    const out: number[] = [];
    let p = 10;
    for (;;) {
      const flags = r.u16(p);
      const component = r.u16(p + 2);
      if (component >= this.numGlyphs) r.fail(`component glyph ${component} is out of range (font has ${this.numGlyphs} glyphs)`);
      out.push(component);
      p += 4 + (flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
      if (flags & WE_HAVE_A_SCALE) p += 2;
      else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) p += 4;
      else if (flags & WE_HAVE_A_TWO_BY_TWO) p += 8;
      if (!(flags & MORE_COMPONENTS)) break;
      // Each component takes at least 6 bytes, so the loop ends with the data.
      r.check(p, 4);
    }
    r.check(0, p);
    return out;
  }

  /**
   * The glyph's outline in font units: quadratic segments become the exact
   * equivalent cubics, composite components are placed with their offsets
   * (or matched points) and transforms. Empty for an empty glyph. Throws
   * FontError for corrupt data, reference cycles and runaway composites.
   *
   * TrueType rasterizers put a simple glyph's origin at its left phantom
   * point, so the header xMin lands on the hmtx left side bearing. The two
   * agree in almost every font; where they do not, `leftSideBearing` (when
   * given) moves a simple glyph drawn on its own, as fontTools does.
   * Components keep their coordinates, and so does a composite.
   */
  outline(gid: number, leftSideBearing?: (gid: number) => number): PathCommand[] {
    const pts: Points = { xs: [], ys: [], on: [], ends: [] };
    this.collect(gid, pts, new Set(), { visits: 0 }, leftSideBearing);
    return toPath(pts);
  }

  /** Appends a glyph's points to `out`; composites recurse through their components. */
  private collect(gid: number, out: Points, active: Set<number>, budget: { visits: number }, lsb: ((gid: number) => number) | undefined): void {
    const [start, end] = this.range(gid);
    if (start === end) return;
    if (end - start < 10) throw new FontError(`glyph ${gid}: ${end - start} bytes is too short for a glyph header`);
    const r = this.glyf.sub(start, end - start, `glyph ${gid}`);
    const contours = r.i16(0);
    if (contours >= 0) {
      this.simple(r, contours, out, lsb ? lsb(gid) - r.i16(2) : 0);
      return;
    }
    if (active.size >= MAX_COMPOSITE_DEPTH) r.fail(`composite glyphs nested more than ${MAX_COMPOSITE_DEPTH} deep`);
    active.add(gid);
    let p = 10;
    for (;;) {
      const flags = r.u16(p);
      const component = r.u16(p + 2);
      p += 4;
      if (component >= this.numGlyphs) r.fail(`component glyph ${component} is out of range (font has ${this.numGlyphs} glyphs)`);
      if (active.has(component)) r.fail(`composite glyph references itself (cycle through glyph ${component})`);
      if (++budget.visits > MAX_COMPONENT_VISITS) r.fail(`composite expands to more than ${MAX_COMPONENT_VISITS} components`);
      const xy = (flags & ARGS_ARE_XY_VALUES) !== 0;
      let arg1: number;
      let arg2: number;
      if (flags & ARG_1_AND_2_ARE_WORDS) {
        arg1 = xy ? r.i16(p) : r.u16(p);
        arg2 = xy ? r.i16(p + 2) : r.u16(p + 2);
        p += 4;
      } else {
        arg1 = xy ? r.i8(p) : r.u8(p);
        arg2 = xy ? r.i8(p + 1) : r.u8(p + 1);
        p += 2;
      }
      // x' = a x + c y, y' = b x + d y
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & WE_HAVE_A_SCALE) {
        a = d = f2dot14(r, p);
        p += 2;
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        a = f2dot14(r, p);
        d = f2dot14(r, p + 2);
        p += 4;
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        a = f2dot14(r, p);
        b = f2dot14(r, p + 2);
        c = f2dot14(r, p + 4);
        d = f2dot14(r, p + 6);
        p += 8;
      }

      const sub: Points = { xs: [], ys: [], on: [], ends: [] };
      this.collect(component, sub, active, budget, undefined);
      const n = sub.xs.length;
      for (let i = 0; i < n; i++) {
        const x = sub.xs[i];
        const y = sub.ys[i];
        sub.xs[i] = a * x + c * y;
        sub.ys[i] = b * x + d * y;
      }
      let dx: number;
      let dy: number;
      if (xy) {
        // Offsets are in the composite's units unless the font asks for them to be transformed too.
        const scaled = (flags & SCALED_COMPONENT_OFFSET) !== 0 && (flags & UNSCALED_COMPONENT_OFFSET) === 0;
        dx = scaled ? a * arg1 + c * arg2 : arg1;
        dy = scaled ? b * arg1 + d * arg2 : arg2;
      } else {
        // Point matching: the component's point arg2 lands on the composite's point arg1.
        if (arg1 >= out.xs.length || arg2 >= n) r.fail(`component glyph ${component} matches points ${arg1} and ${arg2}, which do not exist`);
        dx = out.xs[arg1] - sub.xs[arg2];
        dy = out.ys[arg1] - sub.ys[arg2];
      }
      if (out.xs.length + n > MAX_OUTLINE_POINTS) r.fail(`composite outline has more than ${MAX_OUTLINE_POINTS} points`);
      const base = out.xs.length;
      for (let i = 0; i < n; i++) {
        out.xs.push(sub.xs[i] + dx);
        out.ys.push(sub.ys[i] + dy);
        out.on.push(sub.on[i]);
      }
      for (const e of sub.ends) out.ends.push(base + e);
      if (!(flags & MORE_COMPONENTS)) break;
    }
    active.delete(gid);
  }

  /** Decodes a simple glyph's points (header at offset 0 of `r`) onto `out`, x moved by `dx`. */
  private simple(r: Reader, contours: number, out: Points, dx: number): void {
    let p = 10;
    const ends: number[] = [];
    for (let i = 0; i < contours; i++) {
      const e = r.u16(p);
      if (ends.length && e < ends[ends.length - 1]) r.fail("contour end points decrease");
      ends.push(e);
      p += 2;
    }
    const count = contours ? ends[contours - 1] + 1 : 0;
    p += 2 + r.u16(p); // instructions
    if (out.xs.length + count > MAX_OUTLINE_POINTS) r.fail(`outline has more than ${MAX_OUTLINE_POINTS} points`);
    const flags = new Uint8Array(count);
    for (let i = 0; i < count; ) {
      const f = r.u8(p++);
      flags[i++] = f;
      if (f & REPEAT_FLAG) {
        // A repeat count running past the last point is cut short.
        for (let k = r.u8(p++); k > 0 && i < count; k--) flags[i++] = f;
      }
    }
    const base = out.xs.length;
    let v = 0;
    for (let i = 0; i < count; i++) {
      const f = flags[i];
      if (f & X_SHORT_VECTOR) v += f & X_IS_SAME_OR_POSITIVE ? r.u8(p++) : -r.u8(p++);
      else if (!(f & X_IS_SAME_OR_POSITIVE)) {
        v += r.i16(p);
        p += 2;
      }
      out.xs.push(v + dx);
      out.on.push((f & ON_CURVE_POINT) !== 0);
    }
    v = 0;
    for (let i = 0; i < count; i++) {
      const f = flags[i];
      if (f & Y_SHORT_VECTOR) v += f & Y_IS_SAME_OR_POSITIVE ? r.u8(p++) : -r.u8(p++);
      else if (!(f & Y_IS_SAME_OR_POSITIVE)) {
        v += r.i16(p);
        p += 2;
      }
      out.ys.push(v);
    }
    for (const e of ends) out.ends.push(base + e);
  }

  /**
   * Adds every glyph the given glyphs depend on through composite
   * references. Throws FontError on a reference cycle or nesting deeper than
   * MAX_COMPOSITE_DEPTH.
   */
  closure(roots: Iterable<number>): Set<number> {
    const done = new Set<number>();
    const active = new Set<number>();
    for (const root of roots) {
      if (done.has(root)) continue;
      // Iterative depth-first walk: [glyph, its components, next index].
      const stack: [number, number[], number][] = [[root, this.components(root), 0]];
      active.add(root);
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top[2] >= top[1].length) {
          stack.pop();
          active.delete(top[0]);
          done.add(top[0]);
          continue;
        }
        const child = top[1][top[2]++];
        if (done.has(child)) continue;
        if (active.has(child)) throw new FontError(`glyph ${child}: composite glyph references itself (cycle through glyph ${top[0]})`);
        if (stack.length >= MAX_COMPOSITE_DEPTH) throw new FontError(`glyph ${root}: composite glyphs nested more than ${MAX_COMPOSITE_DEPTH} deep`);
        active.add(child);
        stack.push([child, this.components(child), 0]);
      }
    }
    return done;
  }
}

/**
 * Contours of on- and off-curve points as a path. Two off-curve points in a
 * row imply an on-curve point midway between them; a contour may start off
 * the curve. Each quadratic (p0, q, p1) becomes the cubic with control points
 * p0 + 2/3 (q - p0) and p1 + 2/3 (q - p1), which traces the same curve.
 */
function toPath(pts: Points): PathCommand[] {
  const out: PathCommand[] = [];
  const { xs, ys, on } = pts;
  let first = 0;
  for (const last of pts.ends) {
    const n = last - first + 1;
    if (n <= 0) continue;
    // Start at an on-curve point: the first, else the last, else the midpoint of the two.
    let sx: number;
    let sy: number;
    let from: number;
    let count: number;
    if (on[first]) {
      sx = xs[first];
      sy = ys[first];
      from = first + 1;
      count = n - 1;
    } else if (on[last]) {
      sx = xs[last];
      sy = ys[last];
      from = first;
      count = n - 1;
    } else {
      sx = (xs[first] + xs[last]) / 2;
      sy = (ys[first] + ys[last]) / 2;
      from = first;
      count = n;
    }
    out.push(["M", sx, sy]);
    let cx = sx;
    let cy = sy;
    let qx = 0;
    let qy = 0;
    let pending = false;
    const quad = (x: number, y: number) => {
      out.push(["C", cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]);
      cx = x;
      cy = y;
    };
    for (let k = 0; k < count; k++) {
      const i = from + k;
      const x = xs[i];
      const y = ys[i];
      if (on[i]) {
        if (pending) quad(x, y);
        else {
          out.push(["L", x, y]);
          cx = x;
          cy = y;
        }
        pending = false;
      } else {
        if (pending) quad((qx + x) / 2, (qy + y) / 2);
        qx = x;
        qy = y;
        pending = true;
      }
    }
    if (pending) quad(sx, sy);
    out.push(["Z"]);
    first = last + 1;
  }
  return out;
}
