/**
 * Compact Font Format (the 'CFF ' and 'CFF2' tables): enough to run Type 2
 * charstrings for exact glyph bounds and for glyph outlines.
 *
 * Supported: CFF 1 name-keyed and CID-keyed fonts (FDArray/FDSelect), CFF2
 * at its default instance (blend operands resolved to their defaults), local
 * and global subroutines, hint masks, flex, and the arithmetic operators.
 * Not supported: Type 1 charstrings (CharstringType 1) and the deprecated
 * seac form of endchar, whose accent is ignored.
 *
 * Every charstring runs under an operator budget and a subroutine depth
 * limit, so a hostile font cannot loop or recurse without bound.
 */

import type { PathCommand } from "../layout/types.js";
import { FontError } from "./errors.js";
import type { GlyphBox } from "./glyf.js";
import { Reader } from "./reader.js";

/** An INDEX: count items, each a byte range inside the Reader. */
class CffIndex {
  readonly count: number;
  /** Offset just past the INDEX. */
  readonly end: number;
  private readonly r: Reader;
  private readonly offSize: number;
  private readonly offsetsAt: number;
  private readonly dataBase: number;

  constructor(r: Reader, off: number, cff2: boolean) {
    this.r = r;
    this.count = cff2 ? r.u32(off) : r.u16(off);
    const hdr = cff2 ? 4 : 2;
    if (this.count === 0) {
      this.offSize = 1;
      this.offsetsAt = off + hdr;
      this.dataBase = off + hdr;
      this.end = off + hdr;
      return;
    }
    this.offSize = r.u8(off + hdr);
    if (this.offSize < 1 || this.offSize > 4) r.fail(`INDEX at ${off} has offSize ${this.offSize}`);
    this.offsetsAt = off + hdr + 1;
    r.check(this.offsetsAt, (this.count + 1) * this.offSize);
    this.dataBase = this.offsetsAt + (this.count + 1) * this.offSize - 1;
    const last = this.offset(this.count);
    r.check(this.dataBase + 1, last - 1);
    this.end = this.dataBase + last;
  }

  private offset(i: number): number {
    const p = this.offsetsAt + i * this.offSize;
    switch (this.offSize) {
      case 1:
        return this.r.u8(p);
      case 2:
        return this.r.u16(p);
      case 3:
        return this.r.u24(p);
      default:
        return this.r.u32(p);
    }
  }

  /** [start, end) of item i within the Reader. */
  range(i: number): [number, number] {
    if (!(i >= 0 && i < this.count)) this.r.fail(`INDEX item ${i} out of range (${this.count} items)`);
    const a = this.offset(i);
    const b = this.offset(i + 1);
    if (a < 1 || b < a) this.r.fail(`INDEX item ${i} has bad offsets ${a}..${b}`);
    const start = this.dataBase + a;
    const end = this.dataBase + b;
    this.r.check(start, end - start);
    return [start, end];
  }
}

type Dict = Map<number, number[]>;

const REAL_NIBBLES = "0123456789.EE?-";

/** Parses a DICT; escaped operators are numbered 1200 + second byte. */
function parseDict(r: Reader, start: number, end: number): Dict {
  const dict: Dict = new Map();
  let operands: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = r.u8(p);
    if (b0 === 23) {
      // CFF2 blend inside a DICT: the defaults stay for the next operator.
      // (The deltas are left in place too; no operator read here is blended.)
      operands.pop();
      p++;
    } else if (b0 <= 27) {
      let op = b0;
      p++;
      if (b0 === 12) op = 1200 + r.u8(p++);
      dict.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(r.i16(p + 1));
      p += 3;
    } else if (b0 === 29) {
      operands.push(r.i32(p + 1));
      p += 5;
    } else if (b0 === 30) {
      let s = "";
      p++;
      for (let done = false; !done; p++) {
        const byte = r.u8(p);
        for (const nib of [byte >> 4, byte & 15]) {
          if (nib === 15) {
            done = true;
            break;
          }
          s += nib === 12 ? "E-" : REAL_NIBBLES[nib];
        }
        if (p - start > 64 + (end - start)) r.fail("unterminated real number in DICT");
      }
      const v = Number.parseFloat(s);
      operands.push(Number.isFinite(v) ? v : 0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + r.u8(p + 1) + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - r.u8(p + 1) - 108);
      p += 2;
    } else {
      r.fail(`reserved byte ${b0} in DICT`);
    }
    if (operands.length > 513) r.fail("DICT operand stack overflow");
  }
  return dict;
}

function subrBias(count: number): number {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

interface PrivateData {
  readonly subrs: CffIndex | undefined;
  readonly vsindex: number;
}

const MAX_OPS = 200_000;
const MAX_DEPTH = 10;

/**
 * What a charstring draws, in charstring units: the start of each contour
 * (only once something is drawn from it, so a bare moveto adds nothing),
 * then its segments from the current point.
 */
interface OutlineSink {
  start(x: number, y: number): void;
  line(x: number, y: number): void;
  /** A cubic Bézier from the current point (x0, y0). */
  curve(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
}

class BoxBuilder implements OutlineSink {
  xMin = Infinity;
  yMin = Infinity;
  xMax = -Infinity;
  yMax = -Infinity;

  add(x: number, y: number): void {
    if (x < this.xMin) this.xMin = x;
    if (x > this.xMax) this.xMax = x;
    if (y < this.yMin) this.yMin = y;
    if (y > this.yMax) this.yMax = y;
  }

  start(x: number, y: number): void {
    this.add(x, y);
  }

  line(x: number, y: number): void {
    this.add(x, y);
  }

  /** Adds a cubic Bézier's extremes (the start point is already in). */
  curve(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    this.add(x3, y3);
    const xs = extremes(x0, x1, x2, x3);
    const ys = extremes(y0, y1, y2, y3);
    for (const t of xs) this.add(bezier(x0, x1, x2, x3, t), y3);
    for (const t of ys) this.add(x3, bezier(y0, y1, y2, y3, t));
    // The second coordinate of those points is a placeholder (y3/x3, both
    // inside the box already), so only the extreme coordinate matters.
  }
}

/**
 * Collects the path in font units: coordinates scaled by the FontMatrix (to
 * match the advances in hmtx), and every contour closed, since Type 2
 * contours close implicitly at the next moveto and at endchar.
 */
class PathBuilder implements OutlineSink {
  private readonly path: PathCommand[] = [];

  constructor(
    private readonly sx: number,
    private readonly sy: number,
  ) {}

  start(x: number, y: number): void {
    if (this.path.length) this.path.push(["Z"]);
    this.path.push(["M", x * this.sx, y * this.sy]);
  }

  line(x: number, y: number): void {
    this.path.push(["L", x * this.sx, y * this.sy]);
  }

  curve(_x0: number, _y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    const { sx, sy } = this;
    this.path.push(["C", x1 * sx, y1 * sy, x2 * sx, y2 * sy, x3 * sx, y3 * sy]);
  }

  finish(): PathCommand[] {
    if (this.path.length) this.path.push(["Z"]);
    return this.path;
  }
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Parameters in (0, 1) where a cubic's derivative is zero. */
function extremes(p0: number, p1: number, p2: number, p3: number): number[] {
  const lo = Math.min(p0, p3);
  const hi = Math.max(p0, p3);
  if (p1 >= lo && p1 <= hi && p2 >= lo && p2 <= hi) return [];
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

export class CffOutlines {
  private readonly r: Reader;
  private readonly cff2: boolean;
  private readonly charStrings: CffIndex;
  private readonly gsubrs: CffIndex;
  private readonly privates: PrivateData[] = [];
  private readonly fdSelect: ((gid: number) => number) | undefined;
  private readonly regionCounts: number[] = [];
  private readonly scaleX: number;
  private readonly scaleY: number;
  readonly supported: boolean;

  constructor(r: Reader, cff2: boolean, unitsPerEm: number) {
    this.r = r;
    this.cff2 = cff2;
    const major = r.u8(0);
    const hdrSize = r.u8(2);
    let top: Dict;
    let afterTop: number;
    if (cff2) {
      if (major !== 2) r.fail(`CFF2 table has major version ${major}`);
      const topLength = r.u16(3);
      top = parseDict(r, hdrSize, hdrSize + topLength);
      r.check(hdrSize, topLength);
      afterTop = hdrSize + topLength;
      this.gsubrs = new CffIndex(r, afterTop, true);
    } else {
      if (major !== 1) r.fail(`CFF table has major version ${major}`);
      const names = new CffIndex(r, hdrSize, false);
      const tops = new CffIndex(r, names.end, false);
      if (tops.count < 1) r.fail("CFF has no Top DICT");
      const [ts, te] = tops.range(0);
      top = parseDict(r, ts, te);
      const strings = new CffIndex(r, tops.end, false);
      this.gsubrs = new CffIndex(r, strings.end, false);
    }
    const charStringsOffset = top.get(17)?.[0];
    if (charStringsOffset === undefined) r.fail("CFF Top DICT has no CharStrings");
    this.charStrings = new CffIndex(r, charStringsOffset, cff2);
    this.supported = (top.get(1206)?.[0] ?? 2) === 2;

    const matrix = top.get(1207);
    this.scaleX = matrix && matrix.length >= 4 && matrix[0] ? matrix[0] * unitsPerEm : 1;
    this.scaleY = matrix && matrix.length >= 4 && matrix[3] ? matrix[3] * unitsPerEm : 1;

    const fdArrayOffset = top.get(1236)?.[0];
    if (fdArrayOffset !== undefined) {
      const fdArray = new CffIndex(r, fdArrayOffset, cff2);
      for (let i = 0; i < Math.min(fdArray.count, 256); i++) {
        const [s, e] = fdArray.range(i);
        this.privates.push(this.readPrivate(parseDict(r, s, e)));
      }
      const fdSelectOffset = top.get(1237)?.[0];
      if (fdSelectOffset !== undefined) this.fdSelect = this.readFdSelect(fdSelectOffset);
      else if (!cff2 || this.privates.length !== 1) r.fail("CID-keyed CFF has no FDSelect");
    } else {
      if (cff2) r.fail("CFF2 has no FDArray");
      this.privates.push(this.readPrivate(top));
    }
    const vstore = top.get(24)?.[0];
    if (cff2 && vstore !== undefined) this.readVariationStore(vstore);
  }

  private readPrivate(dict: Dict): PrivateData {
    const priv = dict.get(18);
    if (!priv || priv.length < 2) return { subrs: undefined, vsindex: 0 };
    const [size, offset] = priv;
    this.r.check(offset, size);
    const pd = parseDict(this.r, offset, offset + size);
    const subrsOffset = pd.get(19)?.[0];
    const subrs = subrsOffset !== undefined && subrsOffset > 0 ? new CffIndex(this.r, offset + subrsOffset, this.cff2) : undefined;
    return { subrs, vsindex: pd.get(22)?.[0] ?? 0 };
  }

  private readFdSelect(off: number): (gid: number) => number {
    const r: Reader = this.r;
    const format = r.u8(off);
    const n = this.charStrings.count;
    if (format === 0) {
      r.check(off + 1, n);
      return (gid) => r.u8(off + 1 + gid);
    }
    if (format === 3 || format === 4) {
      const wide = format === 4;
      const nRanges = wide ? r.u32(off + 1) : r.u16(off + 1);
      const recSize = wide ? 6 : 3;
      const base = off + (wide ? 5 : 3);
      r.check(base, nRanges * recSize + (wide ? 4 : 2));
      const first = (i: number) => (wide ? r.u32(base + recSize * i) : r.u16(base + recSize * i));
      return (gid) => {
        let lo = 0;
        let hi = nRanges - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const start = first(mid);
          const next = mid + 1 < nRanges ? first(mid + 1) : wide ? r.u32(base + recSize * nRanges) : r.u16(base + recSize * nRanges);
          if (gid < start) hi = mid - 1;
          else if (gid >= next) lo = mid + 1;
          else return wide ? r.u16(base + recSize * mid + 4) : r.u8(base + recSize * mid + 2);
        }
        return 0;
      };
    }
    return r.fail(`unknown FDSelect format ${format}`);
  }

  /** Region counts of each ItemVariationData, for the blend operator. */
  private readVariationStore(off: number): void {
    const r: Reader = this.r;
    const store = off + 2; // skip the 16-bit length
    if (r.u16(store) !== 1) return;
    const count = r.u16(store + 6);
    r.check(store + 8, 4 * count);
    for (let i = 0; i < count; i++) {
      const data = store + r.u32(store + 8 + 4 * i);
      this.regionCounts.push(r.u16(data + 4));
    }
  }

  /** Exact outline bounds of a glyph, or undefined when it draws nothing. */
  box(gid: number): GlyphBox | undefined {
    const box = new BoxBuilder();
    this.draw(gid, box);
    if (box.xMin === Infinity) return undefined;
    return {
      xMin: Math.floor(box.xMin * this.scaleX),
      yMin: Math.floor(box.yMin * this.scaleY),
      xMax: Math.ceil(box.xMax * this.scaleX),
      yMax: Math.ceil(box.yMax * this.scaleY),
    };
  }

  /** A glyph's outline in font units, every contour closed; empty when it draws nothing. */
  outline(gid: number): PathCommand[] {
    const path = new PathBuilder(this.scaleX, this.scaleY);
    this.draw(gid, path);
    return path.finish();
  }

  /** Runs a glyph's charstring into `sink`; nothing for an id outside the font. */
  private draw(gid: number, sink: OutlineSink): void {
    if (!(gid >= 0 && gid < this.charStrings.count)) return;
    if (!this.supported) this.r.fail("Type 1 charstrings are not supported");
    const fd = this.fdSelect ? this.fdSelect(gid) : 0;
    const priv = this.privates[fd];
    if (!priv) this.r.fail(`glyph ${gid} selects missing Font DICT ${fd}`);
    const r: Reader = this.r;
    const cff2 = this.cff2;
    const stack: number[] = [];
    const transient: number[] = new Array(32).fill(0);
    const gsubrs = this.gsubrs;
    const lsubrs = priv.subrs;
    const gbias = subrBias(gsubrs.count);
    const lbias = lsubrs ? subrBias(lsubrs.count) : 0;
    let vsindex = priv.vsindex;
    let stems = 0;
    let widthDone = cff2;
    let x = 0;
    let y = 0;
    let open = false;
    let ops = 0;
    const maxStack = cff2 ? 513 : 48;

    const push = (v: number) => {
      if (stack.length >= maxStack) r.fail(`glyph ${gid}: charstring stack overflow`);
      stack.push(v);
    };
    const need = (n: number) => {
      if (stack.length < n) r.fail(`glyph ${gid}: charstring stack underflow`);
    };
    /** Drops a leading width operand when the count says there is one. */
    const width = (hasWidth: boolean) => {
      if (!widthDone) {
        widthDone = true;
        if (hasWidth) stack.shift();
      }
    };
    const start = () => {
      if (!open) {
        sink.start(x, y);
        open = true;
      }
    };
    const moveTo = (dx: number, dy: number) => {
      x += dx;
      y += dy;
      open = false;
    };
    const lineTo = (dx: number, dy: number) => {
      start();
      x += dx;
      y += dy;
      sink.line(x, y);
    };
    const curveTo = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) => {
      start();
      const x1 = x + dx1;
      const y1 = y + dy1;
      const x2 = x1 + dx2;
      const y2 = y1 + dy2;
      const x3 = x2 + dx3;
      const y3 = y2 + dy3;
      sink.curve(x, y, x1, y1, x2, y2, x3, y3);
      x = x3;
      y = y3;
    };
    const stemHint = () => {
      width(stack.length % 2 === 1);
      stems += stack.length >> 1;
      stack.length = 0;
    };

    /** Runs one charstring; returns true at endchar. */
    const run = (start0: number, end: number, depth: number): boolean => {
      if (depth > MAX_DEPTH) r.fail(`glyph ${gid}: subroutines nested more than ${MAX_DEPTH} deep`);
      let p = start0;
      while (p < end) {
        if (++ops > MAX_OPS) r.fail(`glyph ${gid}: charstring exceeds ${MAX_OPS} operations`);
        const b0 = r.u8(p);
        if (b0 >= 32) {
          if (b0 <= 246) {
            push(b0 - 139);
            p += 1;
          } else if (b0 <= 250) {
            push((b0 - 247) * 256 + r.u8(p + 1) + 108);
            p += 2;
          } else if (b0 <= 254) {
            push(-(b0 - 251) * 256 - r.u8(p + 1) - 108);
            p += 2;
          } else {
            push(r.i32(p + 1) / 65536);
            p += 5;
          }
          continue;
        }
        if (b0 === 28) {
          push(r.i16(p + 1));
          p += 3;
          continue;
        }
        p++;
        switch (b0) {
          case 1: // hstem
          case 3: // vstem
          case 18: // hstemhm
          case 23: // vstemhm
            stemHint();
            break;
          case 19: // hintmask
          case 20: // cntrmask
            stemHint();
            p += (stems + 7) >> 3;
            break;
          case 21: // rmoveto
            width(stack.length > 2);
            need(2);
            moveTo(stack[0], stack[1]);
            stack.length = 0;
            break;
          case 22: // hmoveto
            width(stack.length > 1);
            need(1);
            moveTo(stack[0], 0);
            stack.length = 0;
            break;
          case 4: // vmoveto
            width(stack.length > 1);
            need(1);
            moveTo(0, stack[0]);
            stack.length = 0;
            break;
          case 5: // rlineto
            for (let i = 0; i + 1 < stack.length; i += 2) lineTo(stack[i], stack[i + 1]);
            stack.length = 0;
            break;
          case 6: // hlineto
          case 7: {
            // vlineto
            let horizontal = b0 === 6;
            for (const d of stack) {
              if (horizontal) lineTo(d, 0);
              else lineTo(0, d);
              horizontal = !horizontal;
            }
            stack.length = 0;
            break;
          }
          case 8: // rrcurveto
            for (let i = 0; i + 5 < stack.length; i += 6) {
              curveTo(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
            }
            stack.length = 0;
            break;
          case 24: {
            // rcurveline
            let i = 0;
            for (; i + 5 < stack.length - 2; i += 6) {
              curveTo(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
            }
            if (i + 1 < stack.length) lineTo(stack[i], stack[i + 1]);
            stack.length = 0;
            break;
          }
          case 25: {
            // rlinecurve
            let i = 0;
            for (; i + 1 < stack.length - 6; i += 2) lineTo(stack[i], stack[i + 1]);
            if (i + 5 < stack.length) curveTo(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
            stack.length = 0;
            break;
          }
          case 26: {
            // vvcurveto: [dx1] {dya dxb dyb dyc}+
            let i = 0;
            let dx1 = 0;
            if (stack.length % 4 === 1) dx1 = stack[i++];
            for (; i + 3 < stack.length; i += 4) {
              curveTo(dx1, stack[i], stack[i + 1], stack[i + 2], 0, stack[i + 3]);
              dx1 = 0;
            }
            stack.length = 0;
            break;
          }
          case 27: {
            // hhcurveto: [dy1] {dxa dxb dyb dxc}+
            let i = 0;
            let dy1 = 0;
            if (stack.length % 4 === 1) dy1 = stack[i++];
            for (; i + 3 < stack.length; i += 4) {
              curveTo(stack[i], dy1, stack[i + 1], stack[i + 2], stack[i + 3], 0);
              dy1 = 0;
            }
            stack.length = 0;
            break;
          }
          case 30: // vhcurveto
          case 31: {
            // hvcurveto
            let horizontal = b0 === 31;
            let i = 0;
            while (i + 3 < stack.length) {
              const last = stack.length - i === 5;
              const extra = last ? stack[i + 4] : 0;
              if (horizontal) curveTo(stack[i], 0, stack[i + 1], stack[i + 2], extra, stack[i + 3]);
              else curveTo(0, stack[i], stack[i + 1], stack[i + 2], stack[i + 3], extra);
              horizontal = !horizontal;
              i += last ? 5 : 4;
            }
            stack.length = 0;
            break;
          }
          case 10: {
            // callsubr
            need(1);
            if (!lsubrs) r.fail(`glyph ${gid}: callsubr without local subroutines`);
            const [s, e] = lsubrs.range(stack.pop()! + lbias);
            if (run(s, e, depth + 1)) return true;
            break;
          }
          case 29: {
            // callgsubr
            need(1);
            const [s, e] = gsubrs.range(stack.pop()! + gbias);
            if (run(s, e, depth + 1)) return true;
            break;
          }
          case 11: // return
            if (cff2) r.fail(`glyph ${gid}: return is not allowed in CFF2`);
            return false;
          case 14: // endchar
            if (cff2) r.fail(`glyph ${gid}: endchar is not allowed in CFF2`);
            width(stack.length === 1 || stack.length === 5);
            stack.length = 0;
            return true;
          case 15: // vsindex
            if (!cff2) r.fail(`glyph ${gid}: vsindex outside CFF2`);
            need(1);
            vsindex = stack.pop()!;
            break;
          case 16: {
            // blend: keep the default values, drop the deltas
            if (!cff2) r.fail(`glyph ${gid}: blend outside CFF2`);
            need(1);
            const n = stack.pop()!;
            const k = this.regionCounts[vsindex];
            if (k === undefined) r.fail(`glyph ${gid}: blend with unknown vsindex ${vsindex}`);
            if (!(n >= 0) || stack.length < n * (k + 1)) r.fail(`glyph ${gid}: blend stack underflow`);
            stack.length -= n * k;
            break;
          }
          case 12: {
            const b1 = r.u8(p++);
            escape(b1);
            break;
          }
          default:
            r.fail(`glyph ${gid}: reserved charstring operator ${b0}`);
        }
      }
      return false;
    };

    const escape = (op: number) => {
      const s = stack;
      switch (op) {
        case 35: // flex
          need(13);
          curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
          curveTo(s[6], s[7], s[8], s[9], s[10], s[11]);
          s.length = 0;
          break;
        case 34: {
          // hflex
          need(7);
          const y0 = y;
          curveTo(s[0], 0, s[1], s[2], s[3], 0);
          curveTo(s[4], 0, s[5], y0 - y, s[6], 0);
          s.length = 0;
          break;
        }
        case 36: {
          // hflex1
          need(9);
          const y0 = y;
          curveTo(s[0], s[1], s[2], s[3], s[4], 0);
          curveTo(s[5], 0, s[6], s[7], s[8], y0 - y - s[7]);
          s.length = 0;
          break;
        }
        case 37: {
          // flex1
          need(11);
          const x0 = x;
          const y0 = y;
          let dx = 0;
          let dy = 0;
          for (let i = 0; i < 10; i += 2) {
            dx += s[i];
            dy += s[i + 1];
          }
          curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
          const last = s[10];
          if (Math.abs(dx) > Math.abs(dy)) curveTo(s[6], s[7], s[8], s[9], last, y0 - y - s[7] - s[9]);
          else curveTo(s[6], s[7], s[8], s[9], x0 - x - s[6] - s[8], last);
          s.length = 0;
          break;
        }
        case 0: // dotsection (deprecated)
          s.length = 0;
          break;
        case 3: {
          // and
          need(2);
          const a = s.pop()!;
          const b = s.pop()!;
          s.push(a && b ? 1 : 0);
          break;
        }
        case 4: {
          // or
          need(2);
          const a = s.pop()!;
          const b = s.pop()!;
          s.push(a || b ? 1 : 0);
          break;
        }
        case 5: // not
          need(1);
          s.push(s.pop()! ? 0 : 1);
          break;
        case 9: // abs
          need(1);
          s.push(Math.abs(s.pop()!));
          break;
        case 10: // add
          need(2);
          s.push(s.pop()! + s.pop()!);
          break;
        case 11: {
          // sub
          need(2);
          const b = s.pop()!;
          s.push(s.pop()! - b);
          break;
        }
        case 12: {
          // div
          need(2);
          const b = s.pop()!;
          const a = s.pop()!;
          s.push(b === 0 ? 0 : a / b);
          break;
        }
        case 14: // neg
          need(1);
          s.push(-s.pop()!);
          break;
        case 15: // eq
          need(2);
          s.push(s.pop()! === s.pop()! ? 1 : 0);
          break;
        case 18: // drop
          need(1);
          s.pop();
          break;
        case 20: {
          // put
          need(2);
          const i = s.pop()!;
          const v = s.pop()!;
          if (i >= 0 && i < transient.length) transient[i | 0] = v;
          break;
        }
        case 21: {
          // get
          need(1);
          const i = s.pop()!;
          s.push(i >= 0 && i < transient.length ? transient[i | 0] : 0);
          break;
        }
        case 22: {
          // ifelse
          need(4);
          const v2 = s.pop()!;
          const v1 = s.pop()!;
          const s2 = s.pop()!;
          const s1 = s.pop()!;
          s.push(v1 <= v2 ? s1 : s2);
          break;
        }
        case 23: // random (deterministic here)
          push(0.5);
          break;
        case 24: // mul
          need(2);
          s.push(s.pop()! * s.pop()!);
          break;
        case 26: // sqrt
          need(1);
          s.push(Math.sqrt(Math.abs(s.pop()!)));
          break;
        case 27: // dup
          need(1);
          push(s[s.length - 1]);
          break;
        case 28: {
          // exch
          need(2);
          const b = s.pop()!;
          const a = s.pop()!;
          s.push(b, a);
          break;
        }
        case 29: {
          // index
          need(1);
          let i = s.pop()!;
          if (i < 0) i = 0;
          need((i | 0) + 1);
          push(s[s.length - 1 - (i | 0)]);
          break;
        }
        case 30: {
          // roll
          need(2);
          const j = s.pop()! | 0;
          const n = s.pop()! | 0;
          if (n < 0) r.fail(`glyph ${gid}: roll with negative count`);
          need(n);
          if (n > 0) {
            const items = s.splice(s.length - n, n);
            const shift = ((j % n) + n) % n;
            s.push(...items.slice(n - shift), ...items.slice(0, n - shift));
          }
          break;
        }
        default:
          r.fail(`glyph ${gid}: reserved charstring operator 12 ${op}`);
      }
    };

    const [s, e] = this.charStrings.range(gid);
    run(s, e, 0);
  }

  get glyphCount(): number {
    return this.charStrings.count;
  }
}

/** Parses a 'CFF ' or 'CFF2' table; FontError when it is malformed. */
export function parseCff(r: Reader, cff2: boolean, unitsPerEm: number): CffOutlines {
  if (r.length < 4) throw new FontError(`${r.label}: too short`);
  return new CffOutlines(r, cff2, unitsPerEm);
}
