/**
 * SVG path data and basic shapes as absolute M/L/C/Z commands.
 *
 * The whole path grammar is read: absolute and relative forms of M, L, H, V,
 * C, S, Q, T, A and Z, implicit repeated commands, compact numbers ("1.5.5",
 * "1-2") and compact arc flags ("a1 1 0 00 1 1"). Quadratics become cubics
 * exactly; arcs become one cubic per quarter turn or less. On an error the
 * path is kept up to the last complete segment, as SVG requires.
 */

import type { PathCommand } from "../layout/types.js";
import { NumberReader, isSpace } from "./num.js";

/** A vertex for markers: its position and the path direction arriving at and leaving it (user space). */
export interface PathVertex {
  x: number;
  y: number;
  /** Direction of the path arriving at the vertex, or undefined (start of an open subpath). */
  inDir?: [number, number];
  /** Direction of the path leaving the vertex, or undefined (end of an open subpath). */
  outDir?: [number, number];
}

export interface ParsedPath {
  cmds: PathCommand[];
  /** Marker vertices, when requested. */
  vertices?: PathVertex[];
  /** Why parsing stopped early, if it did. */
  error?: string;
  /** True when the command budget cut the path short. */
  truncated?: boolean;
}

interface Segment {
  x1: number;
  y1: number;
  /** Start and end directions; undefined for a zero-length segment. */
  d0?: [number, number];
  d1?: [number, number];
}

function dir(dx: number, dy: number): [number, number] | undefined {
  return dx === 0 && dy === 0 ? undefined : [dx, dy];
}

/** Collects marker vertices subpath by subpath. */
class VertexBuilder {
  readonly out: PathVertex[] = [];
  private sx = 0;
  private sy = 0;
  private segs: Segment[] = [];
  private open = false;

  move(x: number, y: number): void {
    this.flush(false);
    this.sx = x;
    this.sy = y;
    this.segs = [];
    this.open = true;
  }

  seg(s: Segment): void {
    this.segs.push(s);
  }

  close(x: number, y: number): void {
    this.segs.push({ x1: this.sx, y1: this.sy, d0: dir(this.sx - x, this.sy - y), d1: dir(this.sx - x, this.sy - y) });
    this.flush(true);
  }

  flush(closed: boolean): void {
    if (!this.open) return;
    this.open = false;
    const segs = this.segs;
    const n = segs.length;
    const firstOut = (from: number): [number, number] | undefined => {
      for (let k = from; k < n; k++) if (segs[k].d0) return segs[k].d0;
      return undefined;
    };
    const lastIn = (from: number): [number, number] | undefined => {
      for (let k = from; k >= 0; k--) if (segs[k].d1) return segs[k].d1;
      return undefined;
    };
    // Vertex 0 is the moveto; vertex k (k >= 1) is the end of segment k-1.
    for (let k = 0; k <= n; k++) {
      const x = k === 0 ? this.sx : segs[k - 1].x1;
      const y = k === 0 ? this.sy : segs[k - 1].y1;
      let inDir = k > 0 ? lastIn(k - 1) : undefined;
      let outDir = k < n ? firstOut(k) : undefined;
      if (closed && n > 0) {
        if (k === 0) inDir = lastIn(n - 1);
        if (k === n) outDir = firstOut(0);
      }
      this.out.push({ x, y, inDir, outDir });
    }
  }
}

/** Parses path data. `maxCommands` bounds the output size (the path is cut short and `truncated` set). */
export function parsePath(d: string, opts: { vertices?: boolean; maxCommands?: number } = {}): ParsedPath {
  const max = opts.maxCommands ?? Infinity;
  const cmds: PathCommand[] = [];
  const vb = opts.vertices ? new VertexBuilder() : undefined;
  const r = new NumberReader(d);
  const s = d;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // Reflection points for S and T.
  let lastC2x = 0;
  let lastC2y = 0;
  let lastQx = 0;
  let lastQy = 0;
  let prev = ""; // previous command letter, upper case
  let cmd = "";
  let error: string | undefined;
  let truncated = false;
  let needMove = false; // after Z, a drawing command must start a new subpath explicitly

  const done = (): ParsedPath => {
    vb?.flush(false);
    const res: ParsedPath = { cmds };
    if (vb) res.vertices = vb.out;
    if (error) res.error = error;
    if (truncated) res.truncated = true;
    return res;
  };
  const ensureMove = () => {
    if (needMove) {
      cmds.push(["M", cx, cy]);
      vb?.move(cx, cy);
      needMove = false;
    }
  };
  const lineTo = (x: number, y: number) => {
    ensureMove();
    cmds.push(["L", x, y]);
    const dd = dir(x - cx, y - cy);
    vb?.seg({ x1: x, y1: y, d0: dd, d1: dd });
    cx = x;
    cy = y;
  };
  const curveTo = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    ensureMove();
    cmds.push(["C", x1, y1, x2, y2, x, y]);
    if (vb) {
      const d0 = dir(x1 - cx, y1 - cy) ?? dir(x2 - cx, y2 - cy) ?? dir(x - cx, y - cy);
      const d1 = dir(x - x2, y - y2) ?? dir(x - x1, y - y1) ?? dir(x - cx, y - cy);
      vb.seg({ x1: x, y1: y, d0, d1 });
    }
    lastC2x = x2;
    lastC2y = y2;
    cx = x;
    cy = y;
  };

  r.skipSpace();
  while (!r.atEnd()) {
    if (cmds.length >= max) {
      truncated = true;
      break;
    }
    const ch = s[r.i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      cmd = ch;
      r.i++;
      r.skipSpace();
    } else if (!cmd) {
      error = `path data must start with a moveto command, found '${ch}'`;
      break;
    } else if (cmd === "Z" || cmd === "z") {
      error = `unexpected '${ch}' after closepath`;
      break;
    } else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    if (!prev && cmd !== "M" && cmd !== "m") {
      error = "path data must start with a moveto command";
      break;
    }
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    const nums = (k: number): number[] | undefined => {
      const out: number[] = [];
      for (let j = 0; j < k; j++) {
        if (j > 0) r.skipSep();
        const v = r.number();
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    };
    const flag = (): number | undefined => {
      r.skipSep();
      const c = s.charCodeAt(r.i);
      if (c === 0x30 || c === 0x31) {
        r.i++;
        return c - 0x30;
      }
      return undefined;
    };
    let ok = true;
    switch (up) {
      case "M": {
        const a = nums(2);
        if (!a) {
          ok = false;
          break;
        }
        cx = a[0] + ox;
        cy = a[1] + oy;
        sx = cx;
        sy = cy;
        cmds.push(["M", cx, cy]);
        vb?.move(cx, cy);
        needMove = false;
        break;
      }
      case "L": {
        const a = nums(2);
        if (!a) ok = false;
        else lineTo(a[0] + ox, a[1] + oy);
        break;
      }
      case "H": {
        const a = nums(1);
        if (!a) ok = false;
        else lineTo(a[0] + ox, cy);
        break;
      }
      case "V": {
        const a = nums(1);
        if (!a) ok = false;
        else lineTo(cx, a[0] + oy);
        break;
      }
      case "C": {
        const a = nums(6);
        if (!a) ok = false;
        else curveTo(a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy);
        break;
      }
      case "S": {
        const a = nums(4);
        if (!a) {
          ok = false;
          break;
        }
        const x1 = prev === "C" || prev === "S" ? 2 * cx - lastC2x : cx;
        const y1 = prev === "C" || prev === "S" ? 2 * cy - lastC2y : cy;
        curveTo(x1, y1, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy);
        break;
      }
      case "Q":
      case "T": {
        let qx: number;
        let qy: number;
        let x: number;
        let y: number;
        if (up === "Q") {
          const a = nums(4);
          if (!a) {
            ok = false;
            break;
          }
          qx = a[0] + ox;
          qy = a[1] + oy;
          x = a[2] + ox;
          y = a[3] + oy;
        } else {
          const a = nums(2);
          if (!a) {
            ok = false;
            break;
          }
          qx = prev === "Q" || prev === "T" ? 2 * cx - lastQx : cx;
          qy = prev === "Q" || prev === "T" ? 2 * cy - lastQy : cy;
          x = a[0] + ox;
          y = a[1] + oy;
        }
        const x0 = cx;
        const y0 = cy;
        curveTo(x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
        lastQx = qx;
        lastQy = qy;
        break;
      }
      case "A": {
        const a = nums(3);
        const fa = a ? flag() : undefined;
        const fs = fa !== undefined ? flag() : undefined;
        let end: number[] | undefined;
        if (fs !== undefined) {
          r.skipSep();
          end = nums(2);
        }
        if (!a || fa === undefined || fs === undefined || !end) {
          ok = false;
          break;
        }
        const x = end[0] + ox;
        const y = end[1] + oy;
        if (x === cx && y === cy) {
          // An arc to its own start point is omitted, but still counts as a segment for markers.
          ensureMove();
          vb?.seg({ x1: x, y1: y });
          break;
        }
        const cubics = arcToCubics(cx, cy, a[0], a[1], a[2], fa === 1, fs === 1, x, y);
        if (cubics.length === 0) {
          lineTo(x, y);
          break;
        }
        ensureMove();
        const x0 = cx;
        const y0 = cy;
        for (const c of cubics) cmds.push(["C", c[0], c[1], c[2], c[3], c[4], c[5]]);
        if (vb) {
          const f = cubics[0];
          const l = cubics[cubics.length - 1];
          const d0 = dir(f[0] - x0, f[1] - y0) ?? dir(x - x0, y - y0);
          const d1 = dir(l[4] - l[2], l[5] - l[3]) ?? dir(x - x0, y - y0);
          vb.seg({ x1: x, y1: y, d0, d1 });
        }
        cx = x;
        cy = y;
        break;
      }
      case "Z": {
        if (!needMove) {
          cmds.push(["Z"]);
          vb?.close(cx, cy);
        }
        cx = sx;
        cy = sy;
        needMove = true;
        break;
      }
    }
    if (!ok) {
      error = `bad arguments for '${cmd}' at offset ${r.i}`;
      break;
    }
    prev = up;
    r.skipSep();
    // A comma right before a command letter is an error; stop quietly at it.
    if (s.charCodeAt(r.i) === 0x2c) {
      error = `unexpected ',' at offset ${r.i}`;
      break;
    }
  }
  return done();
}

/**
 * An elliptical arc from (x1, y1) to (x2, y2) as cubic Béziers
 * (SVG 1.1 Appendix F.6: endpoint to centre parameterization, out-of-range
 * radii scaled up). Each entry is [c1x, c1y, c2x, c2y, x, y].
 * Empty when the endpoints coincide; a single straight cubic is never
 * produced: zero radii return [] too, and the caller draws a line.
 */
export function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): number[][] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || !Number.isFinite(rx) || !Number.isFinite(ry)) return [];
  const phi = ((phiDeg % 360) * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let dtheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const delta = dtheta / n;
  const t = (4 / 3) * Math.tan(delta / 4);
  const map = (ex: number, ey: number): [number, number] => [cx + rx * cos * ex - ry * sin * ey, cy + rx * sin * ex + ry * cos * ey];
  const out: number[][] = [];
  for (let k = 0; k < n; k++) {
    const a = theta1 + k * delta;
    const b = a + delta;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const cb = Math.cos(b);
    const sb = Math.sin(b);
    const c1 = map(ca - t * sa, sa + t * ca);
    const c2 = map(cb + t * sb, sb - t * cb);
    const p = k === n - 1 ? [x2, y2] : map(cb, sb);
    out.push([c1[0], c1[1], c2[0], c2[1], p[0], p[1]]);
  }
  return out;
}

const KAPPA = 0.5522847498307936; // 4/3 (sqrt 2 - 1): quarter circle as a cubic

/** An ellipse as four cubics, starting at (cx + rx, cy) and turning towards (cx, cy + ry), as SVG specifies. */
export function ellipseCommands(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ["C", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ["C", cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ["C", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ["Z"],
  ];
}

/** A rectangle, with rounded corners when rx and ry are positive (already clamped by the caller). */
export function rectCommands(x: number, y: number, w: number, h: number, rx: number, ry: number): PathCommand[] {
  if (rx <= 0 || ry <= 0) {
    return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
  }
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + w;
  const b = y + h;
  return [
    ["M", x + rx, y],
    ["L", r - rx, y],
    ["C", r - rx + kx, y, r, y + ry - ky, r, y + ry],
    ["L", r, b - ry],
    ["C", r, b - ry + ky, r - rx + kx, b, r - rx, b],
    ["L", x + rx, b],
    ["C", x + rx - kx, b, x, b - ry + ky, x, b - ry],
    ["L", x, y + ry],
    ["C", x, y + ry - ky, x + rx - kx, y, x + rx, y],
    ["Z"],
  ];
}

/** Points of a polyline/polygon `points` attribute; an odd trailing number is dropped. */
export function parsePoints(s: string, max = Infinity): number[] {
  const r = new NumberReader(s);
  const out: number[] = [];
  r.skipSpace();
  while (!r.atEnd() && out.length < max) {
    const v = r.number();
    if (v === undefined) break;
    out.push(v);
    r.skipSep();
  }
  if (out.length % 2) out.pop();
  return out;
}

/** Whitespace test re-exported for callers that scan attribute values. */
export { isSpace };
