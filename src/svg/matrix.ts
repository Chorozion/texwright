/**
 * 2D affine matrices [a b c d e f], mapping (x, y) to
 * (a x + c y + e, b x + d y + f), as in SVG and PDF.
 */

import { isSpace, scanNumber } from "./num.js";

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Readonly<Matrix> = [1, 0, 0, 1, 0, 0];

/** m · n: apply n first, then m. */
export function multiply(m: Readonly<Matrix>, n: Readonly<Matrix>): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Readonly<Matrix>, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Readonly<Matrix>): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return undefined;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translate(tx: number, ty = 0): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx: number, sy = sx): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotation by `deg` degrees (clockwise on screen in SVG's y-down space), optionally about (cx, cy). */
export function rotate(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180;
  let cos = Math.cos(r);
  let sin = Math.sin(r);
  // Exact values for right angles keep axis-aligned results exact.
  if (Math.abs(cos) < 1e-15) cos = 0;
  if (Math.abs(sin) < 1e-15) sin = 0;
  const m: Matrix = [cos, sin, -sin, cos, 0, 0];
  if (cx || cy) return multiply(multiply(translate(cx, cy), m), translate(-cx, -cy));
  return m;
}

export function skewX(deg: number): Matrix {
  return [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
}

export function skewY(deg: number): Matrix {
  return [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];
}

/** Determinant scale: the factor by which lengths are scaled on average (exact for similarities). */
export function scaleOf(m: Readonly<Matrix>): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** True when m scales uniformly (with rotation and/or reflection), so a circle stays a circle. */
export function isSimilarity(m: Readonly<Matrix>): boolean {
  const n1 = m[0] * m[0] + m[1] * m[1];
  const n2 = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  const tol = 1e-9 * Math.max(n1, n2, 1e-300);
  return Math.abs(n1 - n2) <= tol && Math.abs(dot) <= tol;
}

const ANGLE_UNITS: Record<string, number> = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };

/**
 * Parses an SVG transform list (`matrix`, `translate`, `scale`, `rotate`,
 * `skewX`, `skewY`, separated by whitespace or commas). CSS-style units
 * (`px` on lengths, `deg`/`rad`/`grad`/`turn` on angles) are accepted.
 * Returns undefined for a malformed list, which SVG treats as no transform.
 */
export function parseTransform(s: string): Matrix | undefined {
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const n = s.length;
  let i = 0;
  const skipWs = () => {
    while (i < n && isSpace(s.charCodeAt(i))) i++;
  };
  skipWs();
  if (i >= n || s.slice(i).trim() === "none") return m;
  while (i < n) {
    const start = i;
    while (i < n && /[A-Za-z]/.test(s[i])) i++;
    const name = s.slice(start, i);
    if (!name) return undefined;
    skipWs();
    if (s[i] !== "(") return undefined;
    i++;
    const args: number[] = [];
    for (;;) {
      skipWs();
      if (s[i] === ")") {
        i++;
        break;
      }
      if (args.length && s[i] === ",") {
        i++;
        skipWs();
      }
      const end = scanNumber(s, i);
      if (end < 0) return undefined;
      let v = Number(s.slice(i, end));
      i = end;
      const u0 = i;
      while (i < n && /[A-Za-z%]/.test(s[i])) i++;
      const unit = s.slice(u0, i).toLowerCase();
      if (unit) {
        if (unit in ANGLE_UNITS) v *= ANGLE_UNITS[unit];
        else if (unit !== "px") return undefined;
      }
      if (!Number.isFinite(v) || args.length >= 6) return undefined;
      args.push(v);
    }
    let t: Matrix;
    const k = args.length;
    switch (name) {
      case "matrix":
        if (k !== 6) return undefined;
        t = args as Matrix;
        break;
      case "translate":
        if (k !== 1 && k !== 2) return undefined;
        t = translate(args[0], k === 2 ? args[1] : 0);
        break;
      case "translateX":
        if (k !== 1) return undefined;
        t = translate(args[0], 0);
        break;
      case "translateY":
        if (k !== 1) return undefined;
        t = translate(0, args[0]);
        break;
      case "scale":
        if (k !== 1 && k !== 2) return undefined;
        t = scale(args[0], k === 2 ? args[1] : args[0]);
        break;
      case "rotate":
        if (k !== 1 && k !== 3) return undefined;
        t = rotate(args[0], k === 3 ? args[1] : 0, k === 3 ? args[2] : 0);
        break;
      case "skewX":
        if (k !== 1) return undefined;
        t = skewX(args[0]);
        break;
      case "skewY":
        if (k !== 1) return undefined;
        t = skewY(args[0]);
        break;
      default:
        return undefined;
    }
    m = multiply(m, t);
    skipWs();
    if (s[i] === ",") {
      i++;
      skipWs();
    }
  }
  return m;
}
