/**
 * Gradients as PDF shading patterns (PatternType 2): an axial or radial
 * shading whose colour comes from the stops, as a stitching function of
 * linear segments. PDF shadings only pad (Extend), so a repeating or
 * reflecting gradient is drawn over the stretch of t the shape actually
 * spans, one copy of the stops function per period, mirrored for reflect.
 */

import { type Matrix, normalStops } from "../layout/paint.js";
import type { Color, Gradient } from "../layout/types.js";
import { num, round4 } from "./serialize.js";

/** More periods than this and a repeating gradient is drawn padded instead (the copies would be too many to matter). */
const MAX_PERIODS = 256;

const n4 = (v: number) => num(round4(v));
const rgb = (c: Color) => `[${c.map(n4).join(" ")}]`;

/** The stops as a function of t in 0..1. */
export function stopsFunction(stops: Gradient["stops"]): string {
  const s = normalStops(stops);
  const segs: { a: number; b: number; c0: Color; c1: Color }[] = [];
  if (s[0].offset > 0) segs.push({ a: 0, b: s[0].offset, c0: s[0].color, c1: s[0].color });
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i + 1].offset > s[i].offset) segs.push({ a: s[i].offset, b: s[i + 1].offset, c0: s[i].color, c1: s[i + 1].color });
  }
  const last = s[s.length - 1];
  if (last.offset < 1 || !segs.length) segs.push({ a: last.offset < 1 ? last.offset : 0, b: 1, c0: last.color, c1: last.color });
  const piece = (c0: Color, c1: Color) => `<< /FunctionType 2 /Domain [0 1] /C0 ${rgb(c0)} /C1 ${rgb(c1)} /N 1 >>`;
  if (segs.length === 1) return piece(segs[0].c0, segs[0].c1);
  return (
    `<< /FunctionType 3 /Domain [0 1] /Functions [${segs.map((g) => piece(g.c0, g.c1)).join(" ")}]` +
    ` /Bounds [${segs.slice(1).map((g) => n4(g.a)).join(" ")}] /Encode [${segs.map(() => "0 1").join(" ")}] >>`
  );
}

/**
 * The pattern dictionary for a gradient, `matrix` taking gradient space to
 * the pattern's parent space (the page, or the form it is drawn in), and
 * `range` the t the painted shape spans (used by repeat and reflect).
 */
export function patternDict(g: Gradient, matrix: Matrix, range: [number, number]): string {
  const f = stopsFunction(g.stops);
  let t0 = 0;
  let t1 = 1;
  let fn = f;
  if (g.spread !== "pad") {
    const lo = Math.floor(range[0]);
    const hi = Math.max(lo + 1, Math.ceil(range[1]));
    if (hi - lo <= MAX_PERIODS && (lo < 0 || hi > 1)) {
      t0 = lo;
      t1 = hi;
      const fns: string[] = [];
      const bounds: string[] = [];
      const encode: string[] = [];
      for (let k = lo; k < hi; k++) {
        fns.push(f);
        if (k > lo) bounds.push(String(k));
        encode.push(g.spread === "reflect" && ((k % 2) + 2) % 2 === 1 ? "1 0" : "0 1");
      }
      fn = `<< /FunctionType 3 /Domain [${t0} ${t1}] /Functions [${fns.join(" ")}] /Bounds [${bounds.join(" ")}] /Encode [${encode.join(" ")}] >>`;
    }
  }
  const c = g.coords;
  let shading: string;
  if (g.kind === "linear") {
    // The axis stretched to cover t0..t1.
    const at = (t: number) => [c[0] + t * (c[2] - c[0]), c[1] + t * (c[3] - c[1])];
    shading = `/ShadingType 2 /Coords [${[...at(t0), ...at(t1)].map(n4).join(" ")}]`;
  } else {
    const at = (t: number) => [c[0] + t * (c[3] - c[0]), c[1] + t * (c[4] - c[1]), Math.max(0, c[2] + t * (c[5] - c[2]))];
    shading = `/ShadingType 3 /Coords [${[...at(t0), ...at(t1)].map(n4).join(" ")}]`;
  }
  return (
    `<< /Type /Pattern /PatternType 2 /Matrix [${matrix.map(n4).join(" ")}] /Shading << ${shading} /ColorSpace /DeviceRGB` +
    ` /Domain [${t0} ${t1}] /Function ${fn} /Extend [true true] >> >>`
  );
}
