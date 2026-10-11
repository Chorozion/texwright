/**
 * pst-plot and the grid: \psaxes with its ticks and labels, \psplot and
 * \psparametricplot (PostScript or algebraic code), \listplot, \dataplot,
 * \fileplot with \readdata and \savedata, and \psgrid.
 */

import { type Pt, type Seg, add, apply } from "../tikz/geom.js";
import { type PstInterp, curveSegs, fmtNum, objectState, polySegs } from "./interp.js";
import { cmd } from "./registry.js";
import { RpnError, compileAlgebraic, compileRpn, splitBar } from "./rpn.js";
import { type PState, cloneState, color, dimen } from "./state.js";

/** Font sizes of labelFontSize values. */
const SIZES: Record<string, number> = {
  scriptscriptstyle: 5,
  scriptstyle: 7,
  textstyle: 10,
  displaystyle: 10,
  tiny: 5,
  scriptsize: 7,
  footnotesize: 8,
  small: 9,
  normalsize: 10,
  large: 12,
  Large: 14.4,
};

function fontSizeOf(spec: string | undefined, def: number): number {
  const m = /\\([A-Za-z]+)/.exec(spec ?? "");
  if (m && Object.hasOwn(SIZES, m[1])) return SIZES[m[1]];
  return def;
}

/** A number as a tick label: integers bare, others with up to 4 decimals. */
function label(v: number, comma: boolean): string {
  let s = fmtNum(v, 4);
  if (comma) s = s.replace(".", "{,}");
  return s;
}

/** Multiples of pi as a fraction (trigLabels). */
function trigLabel(v: number): string {
  const q = v / Math.PI;
  for (let d = 1; d <= 12; d++) {
    const n = Math.round(q * d);
    if (Math.abs(q * d - n) < 2e-4 * d) {
      if (n === 0) return "0";
      const sign = n < 0 ? "-" : "";
      const an = Math.abs(n);
      const num = an === 1 ? "\\pi" : `${an}\\pi`;
      return d === 1 ? `${sign}${num}` : `${sign}\\frac{${num}}{${d}}`;
    }
  }
  return fmtNum(v, 3);
}

// ---------------------------------------------------------------- \psaxes

cmd("psaxes", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 3);
  // [xlabel,angle][ylabel,angle] after the coordinates (pst-plot).
  const axisLabels: string[] = [];
  while (axisLabels.length < 2 && sc.peek() === "[") axisLabels.push(sc.options() ?? "");
  const nums = cs.map((s) => {
    const p = s.split(",");
    return [it.number(p[0]) ?? 0, it.number(p[1]) ?? 0] as Pt;
  });
  let o: Pt = [0, 0];
  let a: Pt = [0, 0];
  let b: Pt = [1, 1];
  if (nums.length === 1) b = nums[0];
  else if (nums.length === 2) {
    o = nums[0];
    a = nums[0];
    b = nums[1];
  } else if (nums.length === 3) [o, a, b] = nums;
  const kv = st.kv;
  const num = (k: string, d: number) => it.number(kv.get(k)) ?? d;
  const Ox = num("Ox", 0);
  const Oy = num("Oy", 0);
  const Dx = num("Dx", 1) || 1;
  const Dy = num("Dy", 1) || 1;
  const dx = kv.has("dx") ? (it.len(kv.get("dx"), st.xunit, st) ?? Dx * st.xunit) / st.xunit : Dx;
  const dy = kv.has("dy") ? (it.len(kv.get("dy"), st.yunit, st) ?? Dy * st.yunit) / st.yunit : Dy;
  const labels = (kv.get("labels") ?? "all").trim();
  const ticks = (kv.get("ticks") ?? "all").trim();
  const tickstyle = (kv.get("tickstyle") ?? "full").trim();
  const axesstyle = (kv.get("axesstyle") ?? "axes").trim();
  const comma = /^(true|)$/.test((kv.get("comma") ?? "false").trim());
  const trig = /^(true|)$/.test((kv.get("trigLabels") ?? "false").trim());
  const fontSize = fontSizeOf(kv.get("labelFontSize"), 10);
  const showOrigin = !/^false$/.test((kv.get("showorigin") ?? "true").trim());
  const labelsep = it.len(kv.get("labelsep"), st.xunit, st) ?? st.labelsep;
  // ticksize: one length (both sides for tickstyle=full) or "neg pos".
  const tsParts = (kv.get("ticksize") ?? "").trim().split(/\s+/).filter(Boolean);
  let tNeg = -3;
  let tPos = 3;
  if (tsParts.length === 2) {
    tNeg = it.len(tsParts[0], st.xunit, st) ?? -3;
    tPos = it.len(tsParts[1], st.xunit, st) ?? 3;
  } else if (tsParts.length === 1) {
    const t = it.len(tsParts[0], st.xunit, st) ?? 3;
    tNeg = -Math.abs(t);
    tPos = Math.abs(t);
  }
  if (tickstyle === "top") tNeg = 0;
  else if (tickstyle === "bottom") tPos = 0;
  const subticks = Math.max(0, Math.min(50, Math.round(num("subticks", 0))));
  const xsub = Math.max(0, Math.min(50, Math.round(num("xsubticks", subticks))));
  const ysub = Math.max(0, Math.min(50, Math.round(num("ysubticks", subticks))));
  const P = (x: number, y: number): Pt => apply(st.T, [x * st.xunit, y * st.yunit]);
  const x1 = Math.min(a[0], b[0]);
  const x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]);
  const y2 = Math.max(a[1], b[1]);
  const tickColor = color(kv.get("tickcolor") ?? "", it.colors) ?? st.lc;
  const tickSt = cloneState(st);
  tickSt.lc = tickColor;
  tickSt.arrows = "-";
  tickSt.linestyle = (kv.get("ticklinestyle") ?? "solid").trim();
  tickSt.shadow = false;
  tickSt.doubleline = false;
  tickSt.lw = it.len(kv.get("tickwidth"), st.xunit, st) ?? st.lw;
  const frame = axesstyle === "frame";
  // Axis lines.
  const xAxis = !/^false$/.test((kv.get("xAxis") ?? "true").trim());
  const yAxis = !/^false$/.test((kv.get("yAxis") ?? "true").trim());
  if (axesstyle === "axes") {
    const ls = cloneState(st);
    ls.fillstyle = "none";
    if (xAxis && x2 > x1) it.drawPath(polySegs([P(a[0], o[1]), P(b[0], o[1])], false), ls);
    if (yAxis && y2 > y1) it.drawPath(polySegs([P(o[0], a[1]), P(o[0], b[1])], false), ls);
  } else if (frame) {
    const ls = cloneState(st);
    ls.arrows = "-";
    it.drawPath(polySegs([P(x1, y1), P(x2, y1), P(x2, y2), P(x1, y2)], true), ls, { closed: true });
  }
  // The x axis's labels go below when the axis is at the bottom of the range or in the middle, above when at the top.
  const xBelow = !(frame ? false : o[1] >= y2 && y2 > y1);
  const yLeft = !(frame ? false : o[0] >= x2 && x2 > x1);
  const crossing = !frame && o[0] > x1 && o[0] < x2 && o[1] > y1 && o[1] < y2;
  const ticksAt = (lo: number, hi: number, origin: number, step: number): number[] => {
    const out: number[] = [];
    if (!(step > 0)) return out;
    const k0 = Math.ceil((lo - origin) / step - 1e-9);
    const k1 = Math.floor((hi - origin) / step + 1e-9);
    if (k1 - k0 > 2000) return out;
    for (let k = k0; k <= k1; k++) out.push(k);
    return out;
  };
  const tickSegs: Seg[] = [];
  const subSegs: Seg[] = [];
  const doXT = (ticks === "all" || ticks === "x") && xAxis;
  const doYT = (ticks === "all" || ticks === "y") && yAxis;
  const doXL = (labels === "all" || labels === "x") && xAxis;
  const doYL = (labels === "all" || labels === "y") && yAxis;
  const yLine = frame ? y1 : o[1];
  const xLine = frame ? x1 : o[0];
  const xs = ticksAt(x1, x2, o[0], Math.abs(dx));
  const ys = ticksAt(y1, y2, o[1], Math.abs(dy));
  const along = (p: Pt, v: Pt): Seg[] => [{ t: "M", p: add(p, [v[0] * tNeg, v[1] * tNeg]) }, { t: "L", p: add(p, [v[0] * tPos, v[1] * tPos]) }];
  // Tick directions in the picture: perpendicular to each axis (transformation applied).
  const yDir = unitOf(sub2(P(0, 1), P(0, 0)));
  const xDir = unitOf(sub2(P(1, 0), P(0, 0)));
  for (const k of xs) {
    const x = o[0] + k * dx;
    if (doXT && !(crossing && k === 0)) tickSegs.push(...along(P(x, yLine), yDir));
    if (doXT && xsub > 1) {
      for (let j = 1; j < xsub; j++) {
        const xx = x + (j * dx) / xsub;
        if (xx > x2 + 1e-9) break;
        subSegs.push(...along(P(xx, yLine), [yDir[0] * 0.6, yDir[1] * 0.6]));
      }
    }
  }
  for (const k of ys) {
    const y = o[1] + k * dy;
    if (doYT && !(crossing && k === 0)) tickSegs.push(...along(P(xLine, y), xDir));
    if (doYT && ysub > 1) {
      for (let j = 1; j < ysub; j++) {
        const yy = y + (j * dy) / ysub;
        if (yy > y2 + 1e-9) break;
        subSegs.push(...along(P(xLine, yy), [xDir[0] * 0.6, xDir[1] * 0.6]));
      }
    }
  }
  if (tickSegs.length && (tNeg !== 0 || tPos !== 0)) it.drawPath(tickSegs, tickSt, { noArrows: true });
  if (subSegs.length) it.drawPath(subSegs, { ...tickSt, lw: tickSt.lw * 0.6 }, { noArrows: true });
  // Labels.
  const ls = cloneState(st);
  ls.fontSize = fontSize;
  const putLabel = (text: string, at: Pt, angle: number) => {
    const bx = it.textBox(`$${text}$`, ls);
    const v = angle === 270 ? [0, -1] : angle === 90 ? [0, 1] : angle === 180 ? [-1, 0] : [1, 0];
    const Q: Pt = add(at, [v[0] * labelsep, v[1] * labelsep]);
    const ref: Pt = angle === 270 ? [bx.w / 2, bx.h] : angle === 90 ? [bx.w / 2, -bx.d] : angle === 180 ? [bx.w, (bx.h - bx.d) / 2] : [0, (bx.h - bx.d) / 2];
    it.place(bx, Q, ref, 0, { ...ls, T: [1, 0, 0, 1, 0, 0] });
  };
  const atOrigin = (k: number) => k === 0 && (crossing || !showOrigin);
  if (doXL) {
    for (const k of xs) {
      if (atOrigin(k) && (crossing || !showOrigin)) continue;
      const v = Ox + k * Dx;
      const pos = P(o[0] + k * dx, yLine);
      const off = Math.max(0, xBelow ? -tNeg : tPos) * (doXT ? 1 : 0);
      putLabel(trig ? trigLabel(v) : label(v, comma), add(pos, [0, xBelow ? -off : off]), xBelow ? 270 : 90);
    }
  }
  if (doYL) {
    for (const k of ys) {
      if (atOrigin(k) && (crossing || !showOrigin)) continue;
      const v = Oy + k * Dy;
      const pos = P(xLine, o[1] + k * dy);
      const off = Math.max(0, yLeft ? -tNeg : tPos) * (doYT ? 1 : 0);
      putLabel(trig ? trigLabel(v) : label(v, comma), add(pos, [yLeft ? -off : off, 0]), yLeft ? 180 : 0);
    }
  }
  // Axis names: [$x$,angle] at the end of each axis.
  const named = (spec: string, end: Pt, defAngle: number) => {
    const parts = spec.split(",");
    const angleRaw = parts.length > 1 ? parts.pop()! : undefined;
    const text = parts.join(",").trim();
    if (!text) return;
    const ang = angleRaw !== undefined ? (it.number(angleRaw) ?? defAngle) : defAngle;
    const bx = it.makeBox(text, st, c.base, false);
    const rad = (ang * Math.PI) / 180;
    const Q: Pt = add(end, [Math.cos(rad) * st.labelsep, Math.sin(rad) * st.labelsep]);
    const a8 = ((Math.round(ang / 45) % 8) + 8) % 8;
    const cy = (bx.h - bx.d) / 2;
    const refs: Pt[] = [[0, cy], [0, -bx.d], [bx.w / 2, -bx.d], [bx.w, -bx.d], [bx.w, cy], [bx.w, bx.h], [bx.w / 2, bx.h], [0, bx.h]];
    it.place(bx, Q, refs[a8], 0, { ...st, T: [1, 0, 0, 1, 0, 0] });
  };
  if (axisLabels[0] !== undefined) named(axisLabels[0], P(b[0], frame ? y1 : o[1]), 0);
  if (axisLabels[1] !== undefined) named(axisLabels[1], P(frame ? x1 : o[0], b[1]), 90);
});

const sub2 = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
function unitOf(v: Pt): Pt {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-12 ? [v[0] / l, v[1] / l] : [0, 1];
}

// ---------------------------------------------------------------- plotting

/** Draws data points (unit coordinates) in the state's plotstyle. */
export function plotPoints(it: PstInterp, raw: Pt[], st: PState): void {
  const P = (p: Pt): Pt => apply(st.T, [p[0] * st.xunit, p[1] * st.yunit]);
  // Points far off (a pole of tan, 1/x at 0) break the curve.
  const runs: Pt[][] = [[]];
  for (const p of raw) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 1e5 || Math.abs(p[1]) > 1e5) {
      if (runs[runs.length - 1].length) runs.push([]);
      continue;
    }
    runs[runs.length - 1].push(P(p));
  }
  const style = st.plotstyle.trim();
  const all = runs.flat();
  if (!all.length) {
    it.warnOnce("plot-empty", "The plot has no finite points to draw");
    return;
  }
  switch (style) {
    case "dots":
      for (const p of all) it.dot(p, st);
      return;
    case "polygon":
      it.drawPath(polySegs(all, true), st, { closed: true });
      break;
    case "curve":
    case "ecurve":
    case "ccurve": {
      for (const r of runs) {
        if (r.length < 2) continue;
        if (style === "ccurve") it.drawPath(curveSegs(r, true), st, { closed: true });
        else if (style === "ecurve" && r.length >= 4) {
          const segs = curveSegs(r, false);
          it.drawPath([{ t: "M", p: r[1] }, ...segs.slice(2, segs.length - 1)], st);
        } else it.drawPath(curveSegs(r, false), st);
      }
      break;
    }
    case "bar":
    case "ybar": {
      const bw = (it.len(st.kv.get("barwidth"), 28.4528, st) ?? 0.25 * 28.4528) / 2;
      const s2 = cloneState(st);
      if (s2.fillstyle === "none") s2.fillstyle = "solid", (s2.fc = s2.lc);
      for (const p of raw) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const a = P([p[0], 0]);
        const b = P(p);
        it.drawPath(polySegs([add(a, [-bw, 0]), add(a, [bw, 0]), add(b, [bw, 0]), add(b, [-bw, 0])], true), s2, { closed: true });
      }
      return;
    }
    case "LineToXAxis":
    case "LineToYAxis": {
      const segs: Seg[] = [];
      for (const p of raw) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        segs.push({ t: "M", p: P(style === "LineToXAxis" ? [p[0], 0] : [0, p[1]]) }, { t: "L", p: P(p) });
      }
      it.drawPath(segs, st, { noArrows: true });
      return;
    }
    default: {
      const segs: Seg[] = [];
      for (const r of runs) if (r.length) segs.push(...polySegs(r, false));
      if (segs.length > 1) it.drawPath(segs, st);
    }
  }
  if (st.showpoints) for (const p of all) it.dot(p, st);
}

type Fn1 = (v: Record<string, number>) => number[];

/** Compiles plot code: algebraic infix (components split at |), or PostScript. */
export function compilePlot(it: PstInterp, code: string, algebraic: boolean): Fn1 | undefined {
  const src = it.expandText(code);
  try {
    if (algebraic) {
      const parts = splitBar(src).map((p) => compileAlgebraic(p));
      return (v) => parts.map((f) => f(v));
    }
    const f = compileRpn(src);
    return (v) => f(v);
  } catch (e) {
    if (!(e instanceof RpnError)) throw e;
    // A likely mix-up: infix code without `algebraic`, or the other way round.
    try {
      if (!algebraic) {
        const parts = splitBar(src).map((p) => compileAlgebraic(p));
        const probe = parts.map((f) => f({ x: 0.5, t: 0.5, y: 0.5 }));
        if (probe.every(Number.isFinite)) {
          it.warnOnce("plot-infix", "Plot code looks algebraic but `algebraic` is not set; it was read as algebraic", "Add [algebraic] to the plot, or write the function in PostScript (x 2 exp)");
          return (v) => parts.map((f) => f(v));
        }
      }
    } catch {
      // fall through
    }
    it.warn(`Cannot read the plot function: ${(e as Error).message}`, it.off, algebraic ? "Algebraic code uses x, t, +, -, *, /, ^ and functions such as sin(x), exp(x), sqrt(x)" : "PostScript code is in reverse Polish notation: x 2 exp 3 mul (or add [algebraic] for infix)");
    return undefined;
  }
}

/** Runs f over n+1 samples, catching evaluation errors (reported once). */
function sample(it: PstInterp, f: Fn1, name: string, a: number, b: number, n: number, map: (r: number[], v: number) => Pt | undefined): Pt[] {
  const out: Pt[] = [];
  let err: string | undefined;
  it.tick(Math.ceil(n / 20));
  for (let k = 0; k <= n; k++) {
    const v = a + ((b - a) * k) / n;
    try {
      const r = f({ [name]: v });
      const p = map(r, v);
      out.push(p ?? [Number.NaN, Number.NaN]);
    } catch (e) {
      if (!(e instanceof RpnError)) throw e;
      err = err ?? (e as Error).message;
      out.push([Number.NaN, Number.NaN]);
    }
    if ((k & 63) === 63 && !it.timeLeft()) break;
  }
  if (err) it.warnOnce(`plot-err:${err}`, `Plot function: ${err}`);
  return out;
}

cmd("psplot", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const a = it.number(it.arg(sc));
  const b = it.number(it.arg(sc));
  sc.options();
  const code = it.arg(sc) ?? "";
  if (a === undefined || b === undefined) {
    it.warn("\\psplot needs numbers for the start and end of the domain");
    return;
  }
  const f = compilePlot(it, code, st.algebraic);
  if (!f) return;
  const polar = /^(true|)$/.test((st.kv.get("polarplot") ?? "false").trim());
  const n = Math.max(2, st.plotpoints - 1);
  const pts = sample(it, f, "x", a, b, n, (r, x) => {
    const y = r[r.length - 1];
    if (!polar) return [x, y];
    // Polar plots: x is an angle (degrees in PostScript, radians in algebraic code).
    const ang = st.algebraic ? x : (x * Math.PI) / 180;
    return [y * Math.cos(ang), y * Math.sin(ang)];
  });
  plotPoints(it, pts, st);
});

cmd("psparametricplot parametricplot", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const a = it.number(it.arg(sc));
  const b = it.number(it.arg(sc));
  sc.options();
  const code = it.arg(sc) ?? "";
  if (a === undefined || b === undefined) {
    it.warn("\\psparametricplot needs numbers for the start and end of t");
    return;
  }
  const f = compilePlot(it, code, st.algebraic);
  if (!f) return;
  const n = Math.max(2, st.plotpoints - 1);
  const pts = sample(it, f, "t", a, b, n, (r) => (r.length >= 2 ? [r[r.length - 2], r[r.length - 1]] : undefined));
  plotPoints(it, pts, st);
});

/** Numbers of a data list: `{1,2} {3,4}`, `1 2 3 4`, `1,2,3,4`. */
export function dataNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)) {
    out.push(Number(m[0]));
    if (out.length > 200_000) break;
  }
  return out;
}

function pairs(nums: number[]): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k + 1 < nums.length; k += 2) out.push([nums[k], nums[k + 1]]);
  return out;
}

/** The data a \listplot or \dataplot argument names: a \savedata/\readdata macro, a \def, or the numbers themselves. */
function dataOf(it: PstInterp, arg: string): string {
  const t = arg.trim();
  const m = /^\\([A-Za-z@]+)$/.exec(t);
  if (m && it.data.has(m[1])) return it.data.get(m[1])!;
  return it.expandText(t);
}

cmd("listplot dataplot fileplot", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const arg = it.arg(sc) ?? "";
  let text: string;
  if (name === "fileplot") {
    const f = it.opts.readFile?.(arg.trim());
    if (f === undefined) {
      it.warn(`Data file "${arg.trim()}" could not be read`, it.off, "Put the file next to the document");
      return;
    }
    text = f;
  } else text = dataOf(it, arg);
  const pts = pairs(dataNumbers(text.replace(/%[^\n]*/g, "")));
  if (!pts.length) {
    it.warn(`\\${name} has no data points`);
    return;
  }
  if (st.plotstyle === "line" && name === "dataplot" && !st.kv.has("plotstyle")) st.plotstyle = "line";
  plotPoints(it, pts, st);
});

cmd("readdata", ({ it, sc }) => {
  sc.options();
  const m = /^\s*\{?\s*\\([A-Za-z@]+)\s*\}?/.exec(sc.s.slice(sc.i, sc.i + 80));
  if (!m) return;
  sc.i += m[0].length;
  const file = (it.arg(sc) ?? "").trim();
  const f = it.opts.readFile?.(file);
  if (f === undefined) {
    it.warn(`Data file "${file}" could not be read`, it.off, "Put the file next to the document");
    return;
  }
  it.data.set(m[1], f.replace(/%[^\n]*/g, "").slice(0, 2_000_000));
});

cmd("savedata", ({ it, sc }) => {
  const m = /^\s*\{?\s*\\([A-Za-z@]+)\s*\}?/.exec(sc.s.slice(sc.i, sc.i + 80));
  if (!m) return;
  sc.i += m[0].length;
  const data = sc.options() ?? it.arg(sc) ?? "";
  it.data.set(m[1], data);
});

cmd("pstScalePoints", ({ it, sc }) => {
  it.coordList(sc, 1);
  it.arg(sc);
  it.arg(sc);
  it.warnOnce("scalepoints", "\\pstScalePoints was ignored");
});

// ---------------------------------------------------------------- \psgrid

cmd("psgrid", (c) => {
  const { it, sc } = c;
  const opts = sc.options();
  const st = cloneState(c.st);
  it.set(st, opts);
  const cs = it.coordList(sc, 3);
  const nums = cs.map((s) => {
    const p = s.split(",");
    return [it.number(p[0]) ?? 0, it.number(p[1]) ?? 0] as Pt;
  });
  let o: Pt;
  let a: Pt;
  let b: Pt;
  if (nums.length === 3) [o, a, b] = nums;
  else if (nums.length === 2) [o, a, b] = [nums[0], nums[0], nums[1]];
  else if (nums.length === 1) [o, a, b] = [[0, 0], [0, 0], nums[0]];
  else {
    const f = it.frame;
    if (!f) return;
    a = [Math.round(f[0][0] / st.xunit), Math.round(f[0][1] / st.yunit)];
    b = [Math.round(f[1][0] / st.xunit), Math.round(f[1][1] / st.yunit)];
    o = [0, 0];
    if (!(o[0] >= a[0] && o[0] <= b[0])) o = [a[0], o[1]];
    if (!(o[1] >= a[1] && o[1] <= b[1])) o = [o[0], a[1]];
  }
  const kv = st.kv;
  const x1 = Math.min(a[0], b[0]);
  const x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]);
  const y2 = Math.max(a[1], b[1]);
  if ((x2 - x1) * (y2 - y1) > 250_000) {
    it.warn("The grid is too large to draw");
    return;
  }
  const P = (x: number, y: number): Pt => apply(st.T, [x * st.xunit, y * st.yunit]);
  const div = Math.max(1, Math.min(50, Math.round(it.number(kv.get("subgriddiv")) ?? 5)));
  const gridwidth = dimen(kv.get("gridwidth"), st.xunit, st) ?? 0.8;
  const subwidth = dimen(kv.get("subgridwidth"), st.xunit, st) ?? 0.4;
  const gridcolor = color(kv.get("gridcolor") ?? "", it.colors) ?? "#000000";
  const subcolor = color(kv.get("subgridcolor") ?? "", it.colors) ?? "#808080";
  const griddots = Math.max(0, it.number(kv.get("griddots")) ?? 0);
  const subdots = Math.max(0, it.number(kv.get("subgriddots")) ?? 0);
  const labelsize = dimen(kv.get("gridlabels"), st.xunit, st) ?? 10;
  const labelcolor = color(kv.get("gridlabelcolor") ?? "", it.colors) ?? "#000000";
  const lines = (step: number): Seg[] => {
    const segs: Seg[] = [];
    const kx0 = Math.ceil((x1 - o[0]) / step - 1e-9);
    const kx1 = Math.floor((x2 - o[0]) / step + 1e-9);
    for (let k = kx0; k <= kx1; k++) segs.push({ t: "M", p: P(o[0] + k * step, y1) }, { t: "L", p: P(o[0] + k * step, y2) });
    const ky0 = Math.ceil((y1 - o[1]) / step - 1e-9);
    const ky1 = Math.floor((y2 - o[1]) / step + 1e-9);
    for (let k = ky0; k <= ky1; k++) segs.push({ t: "M", p: P(x1, o[1] + k * step) }, { t: "L", p: P(x2, o[1] + k * step) });
    return segs;
  };
  const gs = cloneState(st);
  gs.arrows = "-";
  gs.fillstyle = "none";
  gs.shadow = false;
  gs.doubleline = false;
  if (div > 1 && subwidth > 0) {
    gs.lw = subwidth;
    gs.lc = subcolor;
    gs.linestyle = subdots > 0 ? "dotted" : "solid";
    if (subdots > 0) gs.dotsep = Math.max(0.5, st.xunit / div / subdots - subwidth);
    it.drawPath(lines(1 / div), gs, { noArrows: true });
  }
  gs.lw = gridwidth;
  gs.lc = gridcolor;
  gs.linestyle = griddots > 0 ? "dotted" : "solid";
  if (griddots > 0) gs.dotsep = Math.max(0.5, st.xunit / griddots - gridwidth);
  if (gridwidth > 0) it.drawPath(lines(1), gs, { noArrows: true });
  if (labelsize > 0.5) {
    const ls = cloneState(st);
    ls.fontSize = labelsize;
    ls.textColor = labelcolor;
    const put = (v: number, at: Pt) => {
      const bx = it.textBox(`$${fmtNum(v, 3)}$`, ls);
      it.place(bx, add(at, [-1.5, -1.5]), [bx.w, bx.h], 0, { ...ls, T: [1, 0, 0, 1, 0, 0] });
    };
    for (let x = Math.ceil(x1 - o[0] - 1e-9) + o[0]; x <= x2 + 1e-9; x++) put(x, P(x, o[1]));
    for (let y = Math.ceil(y1 - o[1] - 1e-9) + o[1]; y <= y2 + 1e-9; y++) if (Math.abs(y - o[1]) > 1e-9) put(y, P(o[0], y));
  }
});
