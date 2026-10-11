/**
 * Three-dimensional pgfplots axes: \addplot3 with expressions (one or two
 * variables), coordinates and tables, drawn as surf, mesh, scatter, quiver
 * or line plots in a box seen from view={azimuth}{elevation} (pgfplots'
 * default 25, 30). The box is projected orthographically, then stretched to
 * the axis width and height as pgfplots does; the back panes carry the grid
 * and the edges with the ticks are the outline edges nearest the viewer.
 *
 * Surface patches and mesh segments are sorted by depth (painter's
 * algorithm). Colours come from the colour map by point meta (z by
 * default); shader=interp is approximated by subdividing each patch.
 * Samples are capped at 100 x 100 per surface.
 */

import { type Colormap, DEFAULT_COLORMAP, colorAt, gradientStops, namedColormap, parseColormap } from "./colormap.js";
import { isColorName, mix, parseColor } from "./color.js";
import { evaluate, length, num } from "./expr.js";
import type { Pt, Seg } from "./geom.js";
import { type Interp, Stop, drawMarks } from "./interp.js";
import { applyOptions, expandList } from "./options.js";
import { type AxisOpts, MARKS, PALETTE, PLOT_KEYS, type Plot, applyPgfplotsSet, axisKey, defaultAxis, drawLegend, hostFor, tickLabel, ticksFor } from "./pgfplots.js";
import { Scanner, parseOptions, splitTop, unbrace } from "./scan.js";
import { CM, type GS, cloneGS, nodeGS } from "./state.js";

type V3 = [number, number, number];

/** Most samples per direction of a surface. */
export const MAX_SURFACE_SAMPLES = 100;
/** Most sub-patches drawn for shader=interp over one plot. */
const MAX_INTERP_PATCHES = 8000;

/** A point of a 3D plot: coordinates and point meta (NaN when it has none). */
export interface P3 {
  x: number;
  y: number;
  z: number;
  m: number;
}

/** Options of one \addplot3 that TikZ does not know. */
interface PlotOpts3 {
  kind: "line" | "surf" | "mesh" | "patch" | "contour";
  /** contour gnuplot={number=..., levels={...}}: its options. */
  contour?: string;
  /** Points per patch of a patch plot: 3 (triangle, the default) or 4 (rectangle). */
  patchSize?: number;
  scatter: boolean;
  shader?: string;
  quiver?: string;
  meta?: string;
  ydomain?: [number, number];
  samplesY?: number;
  varY: string;
  rows?: number;
  cols?: number;
  zbuf?: string;
  facetedColor?: string;
  colormap?: Colormap;
  explicitDraw: boolean;
  explicitFill: boolean;
  restrictZ?: [number, number];
}

function defaultPlotOpts(): PlotOpts3 {
  return { kind: "line", scatter: false, varY: "y", explicitDraw: false, explicitFill: false };
}

export interface Plot3 {
  o: PlotOpts3;
  g: GS;
  pts: P3[];
  /** A grid: points per scan line and number of scan lines; 0 when the points are not a grid. */
  cols: number;
  rows: number;
  /** Indices where a new scan line starts (line plots break there). */
  breaks: Set<number>;
  /** Arrows of a quiver plot, in data units, one per point. */
  vec?: V3[];
  /** \addplot in a 3D axis: drawn in the plane z = 0, which does not count for the limits. */
  flat: boolean;
  /** z as a function of x and y (not a parametric surface): seen from above, its patches cannot overlap. */
  graph: boolean;
  forget: boolean;
  legend?: string;
}

/** Options of a 3D axis besides those AxisOpts holds. */
interface Axis3 {
  az: number;
  el: number;
  zmin?: number;
  zmax?: number;
  zlabel?: string;
  ztick?: number[] | "data" | "none";
  zticklabels?: string[];
  ztickDistance?: number;
  zgrid?: boolean;
  enlargeZ?: number;
  colormap: Colormap;
  colorbar?: "right" | "horizontal";
  colorbarStyle: string;
  metaMin?: number;
  metaMax?: number;
  equal: boolean;
  boxRatio?: V3;
  complete: boolean;
  onTop?: boolean;
}

const ADDPLOT3 = /\\addplot3|\\addplot\s*\+?\s*3/;

/**
 * Whether this code draws an axis: it has \addplot3 or a view, or it is an
 * ordinary axis with a colour bar or a quiver plot (drawn seen from above,
 * which looks like a 2D axis).
 */
export function isAxis3d(opts: string, body: string, env = "axis"): boolean {
  if (ADDPLOT3.test(body)) return true;
  const keys = parseOptions(opts).map((o) => o.key);
  if (keys.some((k) => k === "view" || k === "view/h" || k === "view/az")) return true;
  return env === "axis" && (keys.some((k) => k.startsWith("colorbar")) || /quiver\s*=/.test(body)) && !/\b[xy]bar\b|\b[xy]mode\b|symbolic/.test(opts + body);
}

/** Colour maps a picture defined with colormap={name}{...}, by name. */
const defined = new WeakMap<Interp, Map<string, Colormap>>();
function colormapsOf(it: Interp): Map<string, Colormap> {
  let m = defined.get(it);
  if (!m) defined.set(it, (m = new Map()));
  return m;
}

function view(v: string | undefined): [number, number] | undefined {
  if (!v) return undefined;
  const m = /^\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*$/.exec(v) ?? /^\s*([^{},]+)\s*,\s*([^{},]+)$/.exec(v);
  if (!m) return undefined;
  const a = num(m[1]);
  const e = num(m[2]);
  return a !== undefined && e !== undefined ? [a, e] : undefined;
}

/** 3D keys of \begin{axis}[...]; true when consumed. */
function axis3Key(a: Axis3, o: AxisOpts, key: string, v: string | undefined, it: Interp): boolean {
  const list = (s: string | undefined): number[] | "data" | "none" | undefined => {
    if (s === undefined) return undefined;
    const t = s.trim();
    if (t === "data") return "data";
    if (t === "" || t === "\\empty" || t === "{}") return "none";
    return expandList(t, 200)
      .map((x) => num(x))
      .filter((x): x is number => x !== undefined);
  };
  if (key.startsWith("colormap/")) {
    const m = namedColormap(key);
    if (m) a.colormap = m;
    else it.warnOnce(`cmap:${key}`, `Colour map ${key.slice(9)} is not known; the default (hot) was used`, "Use viridis, jet, hot, hot2, cool, bluered, blackwhite, or define one with colormap={name}{...}");
    return true;
  }
  switch (key) {
    case "view": {
      const r = view(v);
      if (r) [a.az, a.el] = r;
      return true;
    }
    case "view/h":
    case "view/az":
      a.az = num(v ?? "") ?? a.az;
      return true;
    case "view/v":
    case "view/el":
      a.el = num(v ?? "") ?? a.el;
      return true;
    case "zmin":
    case "zmax": {
      const n = num(v ?? "");
      if (n !== undefined) a[key] = n;
      return true;
    }
    case "zlabel":
      a.zlabel = v ?? "";
      return true;
    case "ztick":
      a.ztick = list(v);
      return true;
    case "zticklabels":
      a.zticklabels = splitTop(v ?? "", ",").map((x) => unbrace(x.trim()));
      return true;
    case "ztick distance":
      a.ztickDistance = num(v ?? "");
      return true;
    case "zmajorgrids":
      a.zgrid = v !== "false";
      return true;
    case "enlarge z limits": {
      const t = (v ?? "true").trim();
      a.enlargeZ = t === "false" ? 0 : (num(t) ?? 0.1);
      return true;
    }
    case "enlargelimits": {
      const t = (v ?? "true").trim();
      a.enlargeZ = t === "false" ? 0 : (num(t) ?? 0.1);
      return false;
    }
    case "colormap name": {
      const m = namedColormap(v ?? "") ?? colormapsOf(it).get((v ?? "").trim());
      if (m) a.colormap = m;
      else it.warnOnce(`cmap:${v}`, `Colour map ${v} is not known; the default (hot) was used`);
      return true;
    }
    case "colormap": {
      const m = parseColormap(v ?? "", it.colors, it.lookup);
      if (m) {
        colormapsOf(it).set(m.name, m);
        a.colormap = m;
      } else it.warnOnce("cmap-spec", "Cannot read this colormap={name}{...}; the default was used");
      return true;
    }
    case "colorbar":
    case "colorbar right":
      a.colorbar = (v ?? "true").trim() === "false" ? undefined : "right";
      return true;
    case "colorbar horizontal":
      a.colorbar = "horizontal";
      return true;
    case "colorbar left":
      a.colorbar = "right";
      return true;
    case "colorbar style":
    case "every colorbar":
      a.colorbarStyle += `,${v ?? ""}`;
      return true;
    case "point meta min":
      a.metaMin = num(v ?? "");
      return true;
    case "point meta max":
      a.metaMax = num(v ?? "");
      return true;
    case "axis equal":
    case "axis equal image":
      a.equal = (v ?? "true").trim() !== "false";
      return true;
    case "unit vector ratio":
    case "unit vector ratio*": {
      const t = (v ?? "").trim();
      a.equal = /^1(\s+1){1,2}$/.test(t);
      return true;
    }
    case "plot box ratio": {
      const r = (v ?? "").trim().split(/\s+/).map((x) => num(x));
      if (r.length === 3 && r.every((x) => x !== undefined && x > 0)) a.boxRatio = r as V3;
      return true;
    }
    case "axis on top":
      a.onTop = (v ?? "true").trim() !== "false";
      return true;
    case "3d box":
      a.complete = (v ?? "").trim() === "complete" || (v ?? "").trim() === "complete*";
      return true;
    case "z buffer":
    case "zlabel style":
    case "every axis z label":
    case "zticklabel style":
    case "z tick label style":
    case "minor z tick num":
    case "zminorgrids":
    case "ztick align":
    case "ztick style":
    case "zticklabel pos":
    case "axis z line":
    case "axis z line*":
    case "z dir":
    case "zmode":
    case "zlabel near ticks":
    case "scaled z ticks":
    case "zticklabel":
    case "zlabel shift":
    case "axis background":
    case "mesh/ordering":
      return true;
  }
  void o;
  return false;
}

/** 3D keys of \addplot3[...]; true when consumed. */
function plot3Key(p: PlotOpts3, key: string, v: string | undefined, it: Interp): boolean {
  if (key.startsWith("colormap/")) {
    const m = namedColormap(key);
    if (m) p.colormap = m;
    return true;
  }
  if (key.startsWith("mesh/") && key !== "mesh/rows" && key !== "mesh/cols") return true;
  switch (key) {
    case "surf":
      p.kind = "surf";
      return true;
    case "patch":
      p.kind = "patch";
      return true;
    case "patch type": {
      const t = (v ?? "").trim();
      p.patchSize = t === "rectangle" || t === "bilinear" ? 4 : 3;
      if (t && t !== "rectangle" && t !== "bilinear" && t !== "triangle" && t !== "default") it.warnOnce(`patch:${t}`, `patch type=${t} is drawn as triangles`);
      return true;
    }
    case "contour gnuplot":
    case "contour lua":
      p.kind = "contour";
      p.contour = v ?? "";
      return true;
    case "contour filled":
      p.kind = "surf";
      p.shader = "interp";
      return true;
    case "mesh":
      p.kind = "mesh";
      return true;
    case "scatter":
      p.scatter = true;
      return true;
    case "shader":
      p.shader = (v ?? "faceted").trim();
      return true;
    case "quiver":
      p.quiver = v ?? "";
      return true;
    case "point meta":
      p.meta = (v ?? "").trim();
      return true;
    case "domain y":
    case "y domain": {
      const m = /^(.*?):(.*)$/.exec(v ?? "");
      const a = m ? num(m[1]) : undefined;
      const b = m ? num(m[2]) : undefined;
      if (a !== undefined && b !== undefined) p.ydomain = [a, b];
      return true;
    }
    case "samples y": {
      const n = num(v ?? "");
      if (n !== undefined) p.samplesY = Math.max(0, Math.round(n));
      return true;
    }
    case "variable y":
      p.varY = (v ?? "y").trim().replace(/^\\/, "");
      return true;
    case "mesh/rows":
    case "mesh/cols": {
      const n = num(v ?? "");
      if (n !== undefined && n >= 1) {
        if (key === "mesh/rows") p.rows = Math.round(n);
        else p.cols = Math.round(n);
      }
      return true;
    }
    case "z buffer":
      p.zbuf = (v ?? "").trim();
      return true;
    case "faceted color":
      p.facetedColor = v;
      return true;
    case "colormap name": {
      const m = namedColormap(v ?? "") ?? colormapsOf(it).get((v ?? "").trim());
      if (m) p.colormap = m;
      return true;
    }
    case "colormap": {
      const m = parseColormap(v ?? "", it.colors, it.lookup);
      if (m) p.colormap = m;
      return true;
    }
    case "restrict z to domain": {
      const m = /^(.*?):(.*)$/.exec(v ?? "");
      const a = m ? num(m[1]) : undefined;
      const b = m ? num(m[2]) : undefined;
      if (a !== undefined && b !== undefined) p.restrictZ = [a, b];
      return true;
    }
    case "restrict z to domain*":
    case "z filter/.code":
    case "z filter":
    case "scatter/use mapped color":
    case "scatter/classes":
    case "matrix plot":
    case "matrix plot*":
    case "point meta rel":
    case "colorbar":
    case "contour prepared":
      return true;
    case "color":
    case "draw":
      if (v !== undefined && v !== "none") p.explicitDraw = true;
      return false;
    case "fill":
      if (v !== undefined && v !== "none") p.explicitFill = true;
      return false;
  }
  if (v === undefined && isColorName(key, it.colors, it.lookup)) p.explicitDraw = true;
  return false;
}

/** Evaluates `ex` with variables; undefined when it fails. */
function evalVars(ex: string, vars: Record<string, number>, rad: boolean): number | undefined {
  try {
    let t = ex;
    for (const k of Object.keys(vars)) if (t.includes(`\\${k}`)) t = t.split(`\\${k}`).join(`(${vars[k]})`);
    return evaluate(t, vars, rad).v;
  } catch {
    return undefined;
  }
}

/** Whether expression text mentions variable `v` (as v or \v). */
function mentions(ex: string, v: string): boolean {
  return new RegExp(`(^|[^A-Za-z@])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`).test(ex);
}

const nan = (): P3 => ({ x: NaN, y: NaN, z: NaN, m: NaN });

/** Reads one \addplot3 (or \addplot) statement inside a 3D axis. */
function readPlot3(it: Interp, stmt: string, is3: boolean, plus: boolean, base: GS, base3: PlotOpts3, cyc: number, rad: boolean): Plot3 | undefined {
  const sc = new Scanner(stmt);
  const g = cloneGS(base);
  const o: PlotOpts3 = { ...base3 };
  const optsText = sc.options();
  const host = hostFor(it, (key, value) => plot3Key(o, key, value, it) || PLOT_KEYS.has(key) || key.startsWith("error bar") || key.startsWith("table/"));
  if (optsText === undefined || plus) {
    g.color = PALETTE[cyc % PALETTE.length];
    g.mark = MARKS[cyc % MARKS.length];
    g.markOpts = [];
  }
  if (optsText) applyOptions(g, optsText, "path", host);
  const forget = parseOptions(optsText ?? "").some((x) => x.key === "forget plot");
  const pts: P3[] = [];
  const breaks = new Set<number>();
  let cols = 0;
  let rows = 0;
  // Point meta: z unless given (x, y, explicit, an expression).
  const metaSpec = o.meta ?? (o.kind !== "line" || o.scatter ? (is3 ? "z" : "y") : "none");
  const metaOf = (p: P3, explicit: number, row?: (name: string) => number | undefined): number => {
    switch (metaSpec) {
      case "z":
        return p.z;
      case "x":
        return p.x;
      case "y":
        return p.y;
      case "none":
        return NaN;
      case "explicit":
      case "explicit symbolic":
        return explicit;
    }
    let ex = metaSpec;
    if (row) ex = ex.replace(/\\thisrow\{([^}]*)\}/g, (_m, n: string) => `(${row(n.trim()) ?? "0"})`);
    return evalVars(ex.replace(/\\pgfplots@current@point@[xyz]/g, ""), { x: p.x, y: p.y, z: p.z }, rad) ?? NaN;
  };
  const push = (x: number | undefined, y: number | undefined, z: number | undefined, explicit = NaN, row?: (name: string) => number | undefined) => {
    if (pts.length >= 40000) return;
    it.tick();
    if (x === undefined || y === undefined || z === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      pts.push(nan());
      return;
    }
    if (o.restrictZ && (z < o.restrictZ[0] || z > o.restrictZ[1])) {
      pts.push(nan());
      return;
    }
    const p: P3 = { x, y, z, m: NaN };
    p.m = metaOf(p, explicit, row);
    pts.push(p);
  };
  sc.ws();
  let quiverRow: ((i: number) => (name: string) => number | undefined) | undefined;
  let graph = true;
  if (sc.word("coordinates")) {
    const text = sc.group("{") ?? "";
    let last = 0;
    for (const m of text.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)(\s*\[([^\]]*)\])?/g)) {
      if (pts.length && /\n[ \t]*\r?\n/.test(text.slice(last, m.index))) breaks.add(pts.length);
      last = (m.index ?? 0) + m[0].length;
      const parts = splitTop(m[1], ",");
      if (parts.length < 2) continue;
      const z = is3 ? num(parts[2] ?? "") : 0;
      push(num(parts[0]), num(parts[1]), z, m[3] !== undefined ? (num(m[3]) ?? NaN) : NaN);
    }
  } else if (sc.word("table")) {
    const topts = sc.options() ?? "";
    sc.ws();
    let data = "";
    if (sc.s[sc.i] === "{") {
      const inner = sc.group("{") ?? "";
      const macro = /^\s*\\([A-Za-z@]+)\s*$/.exec(inner);
      if (macro) data = it.tables.get(macro[1]) ?? "";
      else if (!inner.trim().includes("\n") && /^[\w./-]+$/.test(inner.trim())) {
        const file = it.opts.readFile?.(inner.trim());
        if (file === undefined) it.warn(`table file ${inner.trim()} could not be read`, it.off, "Put the data file next to the document, or write the data inline");
        data = file ?? "";
      } else data = inner;
    } else {
      const m = /^\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i));
      data = m ? (it.tables.get(m[1]) ?? "") : "";
      if (m) sc.i += m[0].length;
    }
    const t = readTable3(it, data, topts, is3);
    const rowsData = t.rows;
    rowsData.forEach((r, i) => {
      if (t.breaks.has(i)) breaks.add(pts.length);
      push(r.x, r.y, r.z, r.m, r.get);
    });
    quiverRow = (i) => rowsData[i]?.get ?? (() => undefined);
  } else if (sc.s[sc.i] === "{" || sc.s[sc.i] === "(" || sc.word("expression")) {
    sc.ws();
    const v1 = g.variable || "x";
    const v2 = o.varY || "y";
    let exprs: string[];
    if (sc.s[sc.i] === "(") exprs = splitTop(sc.group("(") ?? "", ",").map((s) => unbrace(s.trim()));
    else exprs = [sc.group("{") ?? "0"];
    const text = exprs.join(",");
    graph = exprs.length < 3;
    const twoD = o.samplesY !== 0 && o.samplesY !== 1 && !(o.ydomain && o.ydomain[0] === o.ydomain[1]) && (o.kind === "surf" || o.kind === "mesh" || o.kind === "contour" || o.scatter || !!o.quiver || mentions(text, v2)) && is3;
    let xs: number[] = g.samplesAt ?? [];
    const n1 = twoD ? Math.min(MAX_SURFACE_SAMPLES, g.samples) : g.samples;
    if (twoD && g.samples > MAX_SURFACE_SAMPLES) it.warnOnce("samples3d", `A surface was sampled ${MAX_SURFACE_SAMPLES} times per direction instead of ${g.samples}`, `Use samples=${MAX_SURFACE_SAMPLES} or fewer`);
    if (!xs.length || twoD) {
      const [a, b] = g.domain;
      const n = Math.max(2, n1);
      xs = [];
      for (let i = 0; i < n; i++) xs.push(a + ((b - a) * i) / (n - 1));
    }
    let ys: number[] = [0];
    if (twoD) {
      const [a, b] = o.ydomain ?? g.domain;
      const want = o.samplesY ?? g.samples;
      const n = Math.max(2, Math.min(MAX_SURFACE_SAMPLES, want));
      if (want > MAX_SURFACE_SAMPLES) it.warnOnce("samples3d", `A surface was sampled ${MAX_SURFACE_SAMPLES} times per direction instead of ${want}`, `Use samples y=${MAX_SURFACE_SAMPLES} or fewer`);
      ys = [];
      for (let i = 0; i < n; i++) ys.push(a + ((b - a) * i) / (n - 1));
      cols = xs.length;
      rows = ys.length;
    }
    for (const yv of ys) {
      if (twoD && pts.length) breaks.add(pts.length);
      for (const xv of xs) {
        const vars: Record<string, number> = { x: xv, y: yv, [v1]: xv, [v2]: yv };
        if (exprs.length >= 3 && is3) push(evalVars(exprs[0], vars, rad), evalVars(exprs[1], vars, rad), evalVars(exprs[2], vars, rad));
        else if (exprs.length >= 2) push(evalVars(exprs[0], vars, rad), evalVars(exprs[1], vars, rad), is3 ? 0 : 0);
        else if (is3) push(xv, twoD ? yv : 0, evalVars(exprs[0], vars, rad));
        else push(xv, evalVars(exprs[0], vars, rad), 0);
      }
    }
  } else if (sc.word("graphics")) {
    it.warnOnce("plot3-graphics", "\\addplot3 graphics (an image on the axis) is not supported; the plot was skipped");
    return undefined;
  } else if (sc.word("gnuplot")) {
    it.warnOnce("gnuplot", "\\addplot gnuplot needs gnuplot; the plot was skipped", "Write the expression as \\addplot3 {...}");
    return undefined;
  } else if (sc.word("fill between")) {
    it.warnOnce("fillbetween3d", "fill between in a 3D axis is not supported; the fill was skipped");
    return undefined;
  } else {
    it.warn("cannot read this \\addplot3; write coordinates {...}, table {...}, {expression} or (x, y, z)");
    return undefined;
  }
  // The grid of a surface: mesh/rows or mesh/cols, else equal scan lines, else runs of equal y or x.
  if (!cols && pts.length > 1) {
    const n = pts.length;
    if (o.cols && n % o.cols === 0) cols = o.cols;
    else if (o.rows && n % o.rows === 0) cols = n / o.rows;
    else if (breaks.size) {
      const starts = [0, ...[...breaks].sort((a, b) => a - b)];
      const lens = starts.map((s, i) => (starts[i + 1] ?? n) - s);
      if (lens.every((l) => l === lens[0]) && lens[0] > 1) cols = lens[0];
    } else if (o.kind === "surf" || o.kind === "mesh" || o.kind === "contour") {
      const same = (k: "x" | "y") => {
        let l = 1;
        while (l < n && pts[l][k] === pts[0][k]) l++;
        return l;
      };
      for (const k of ["y", "x"] as const) {
        const l = same(k);
        if (l > 1 && l < n && n % l === 0) {
          cols = l;
          break;
        }
      }
    }
    if (cols) rows = Math.floor(n / cols);
  }
  if ((o.kind === "surf" || o.kind === "mesh" || o.kind === "contour") && (cols < 2 || rows < 2)) {
    it.warnOnce("surf-grid", `${o.kind} needs a grid of points; the plot was drawn as a line`, "Give mesh/rows=... (or mesh/cols), or leave an empty line between scan lines of the data");
    o.kind = "line";
  }
  // Quiver: one arrow per point, from the u, v, w expressions.
  let vec: V3[] | undefined;
  if (o.quiver !== undefined) {
    const q = new Map(parseOptions(o.quiver).map((k) => [k.key, k.value ?? ""]));
    const sa = num(q.get("scale arrows") ?? "1") ?? 1;
    const ex = (name: string, p: P3, i: number): number => {
      let e = q.get(name);
      if (e === undefined) return 0;
      const row = quiverRow?.(i);
      if (row) e = e.replace(/\\thisrow\{([^}]*)\}/g, (_m, c: string) => `(${row(c.trim()) ?? "0"})`);
      return evalVars(e, { x: p.x, y: p.y, z: p.z }, rad) ?? NaN;
    };
    vec = pts.map((p, i) => (Number.isFinite(p.x) ? [ex("u", p, i) * sa, ex("v", p, i) * sa, is3 ? ex("w", p, i) * sa : 0] : [NaN, NaN, NaN]));
  }
  if (!pts.some((p) => Number.isFinite(p.x))) it.warnOnce(`emptyplot:${stmt.slice(0, 30)}`, "An \\addplot3 gave no points");
  return { o, g, pts, cols, rows, breaks, ...(vec ? { vec } : {}), flat: !is3, graph, forget };
}

interface Row3 {
  x?: number;
  y?: number;
  z?: number;
  m: number;
  get: (name: string) => number | undefined;
}

/** Rows of a table for \addplot3 table: x, y, z (by name, index or expression), meta, and empty lines as scan-line breaks. */
function readTable3(it: Interp, data: string, opts: string, is3: boolean): { rows: Row3[]; breaks: Set<number> } {
  const kv = new Map(parseOptions(opts).map((o) => [o.key.replace(/^\/pgfplots\/table\//, ""), o.value ?? ""]));
  const sep = kv.get("col sep");
  let text = data;
  if (kv.get("row sep") === "\\\\" || /\\\\/.test(text)) text = text.replace(/\\\\/g, "\n");
  const splitter = sep === "comma" ? /\s*,\s*/ : sep === "semicolon" ? /\s*;\s*/ : sep === "tab" ? /\t/ : sep === "&" || sep === "ampersand" ? /\s*&\s*/ : /\s+/;
  const raw = text.split(/\r?\n/).map((l) => l.replace(/(^|[^\\])%.*$/, "$1").trim());
  const breaks = new Set<number>();
  const lines: string[] = [];
  let blank = false;
  for (const l of raw) {
    if (!l || l.startsWith("#")) {
      if (!l) blank = true;
      continue;
    }
    if (blank && lines.length) breaks.add(lines.length);
    blank = false;
    lines.push(l);
  }
  if (!lines.length) return { rows: [], breaks };
  let header: string[] | undefined;
  const first = lines[0].split(splitter);
  if (first.some((c) => num(c) === undefined)) {
    header = first.map((c) => unbrace(c));
    lines.shift();
    // Breaks counted the header line.
    const shifted = new Set<number>();
    for (const b of breaks) if (b - 1 > 0) shifted.add(b - 1);
    breaks.clear();
    for (const b of shifted) breaks.add(b);
  }
  const col = (spec: string | undefined, idx: string | undefined, fallback: number): number => {
    if (spec && header) {
      const k = header.indexOf(spec.trim());
      if (k >= 0) return k;
      it.warnOnce(`col:${spec}`, `Table column "${spec}" not found${header.length ? `; columns are ${header.join(", ")}` : ""}`);
    }
    if (idx !== undefined) return Number(idx) || 0;
    if (spec !== undefined && /^\d+$/.test(spec.trim())) return Number(spec);
    return fallback;
  };
  const xc = col(kv.get("x"), kv.get("x index"), 0);
  const yc = col(kv.get("y"), kv.get("y index"), 1);
  const zc = col(kv.get("z"), kv.get("z index"), 2);
  const mSpec = kv.get("meta") ?? kv.get("point meta");
  const mc = mSpec !== undefined || kv.has("meta index") ? col(mSpec, kv.get("meta index"), 3) : -1;
  const out: Row3[] = [];
  for (const line of lines.slice(0, 40000)) {
    const cells = line.split(splitter);
    const get = (name: string): number | undefined => {
      const k = header ? header.indexOf(name) : -1;
      return k >= 0 ? num(cells[k] ?? "") : /^\d+$/.test(name) ? num(cells[Number(name)] ?? "") : undefined;
    };
    const value = (c: number, expr: string | undefined): number | undefined => {
      if (expr) {
        const e = expr
          .replace(/\\thisrow\{([^}]*)\}/g, (_m, n: string) => `(${get(n.trim()) ?? "0"})`)
          .replace(/\\thisrowno\{(\d+)\}/g, (_m, n: string) => `(${cells[Number(n)] ?? "0"})`)
          .replace(/\\coordindex/g, String(out.length));
        return num(e);
      }
      return cells[c] === undefined ? undefined : num(cells[c]);
    };
    out.push({ x: value(xc, kv.get("x expr")), y: value(yc, kv.get("y expr")), z: is3 ? value(zc, kv.get("z expr")) : 0, m: mc >= 0 ? (value(mc, undefined) ?? NaN) : NaN, get });
  }
  return { rows: out, breaks };
}

// ---------------------------------------------------------------- projection

/** The view: orthographic projection of the unit box, stretched to the axis size. */
export class Projection {
  readonly r1: V3;
  readonly r2: V3;
  /** Towards the viewer. */
  readonly r3: V3;
  readonly L: V3;
  kx = 1;
  ky = 1;
  bx0 = 0;
  by0 = 0;
  ox = 0;
  oy = 0;

  constructor(
    az: number,
    el: number,
    readonly lo: V3,
    readonly hi: V3,
    ratio: V3,
  ) {
    const a = (az * Math.PI) / 180;
    const e = (el * Math.PI) / 180;
    const c = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
    this.r1 = [c(Math.cos(a)), c(Math.sin(a)), 0];
    this.r2 = [c(-Math.sin(a) * Math.sin(e)), c(Math.cos(a) * Math.sin(e)), c(Math.cos(e))];
    this.r3 = [c(Math.sin(a) * Math.cos(e)), c(-Math.cos(a) * Math.cos(e)), c(Math.sin(e))];
    const m = Math.max(...ratio) || 1;
    this.L = ratio.map((r) => r / m) as V3;
  }

  /** Fits the projected box into w x h with its lower left corner at (ox, oy); equal keeps one scale for both directions. */
  fit(w: number, h: number, ox: number, oy: number, equal: boolean): void {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      const [sx, sy] = this.raw([k & 1, (k >> 1) & 1, (k >> 2) & 1]);
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    this.kx = dx > 1e-9 ? w / dx : 1;
    this.ky = dy > 1e-9 ? h / dy : this.kx;
    if (dx <= 1e-9) this.kx = this.ky;
    if (equal) this.kx = this.ky = Math.min(this.kx, this.ky);
    this.bx0 = x0;
    this.by0 = y0;
    this.ox = ox + (w - dx * this.kx) / 2;
    this.oy = oy + (h - dy * this.ky) / 2;
  }

  /** Unit-box coordinates (0..1 each) of a data point. */
  unit(x: number, y: number, z: number): V3 {
    const u = (v: number, i: number) => (this.hi[i] > this.lo[i] ? (v - this.lo[i]) / (this.hi[i] - this.lo[i]) : 0.5);
    return [u(x, 0), u(y, 1), u(z, 2)];
  }

  private raw(u: V3): Pt {
    const c: V3 = [(u[0] - 0.5) * this.L[0], (u[1] - 0.5) * this.L[1], (u[2] - 0.5) * this.L[2]];
    return [this.r1[0] * c[0] + this.r1[1] * c[1] + this.r1[2] * c[2], this.r2[0] * c[0] + this.r2[1] * c[1] + this.r2[2] * c[2]];
  }

  /** The picture point of unit-box coordinates. */
  screenU(u: V3): Pt {
    const [sx, sy] = this.raw(u);
    return [this.ox + (sx - this.bx0) * this.kx, this.oy + (sy - this.by0) * this.ky];
  }

  screen(x: number, y: number, z: number): Pt {
    return this.screenU(this.unit(x, y, z));
  }

  /** Distance towards the viewer (larger is nearer). */
  depthU(u: V3): number {
    return this.r3[0] * (u[0] - 0.5) * this.L[0] + this.r3[1] * (u[1] - 0.5) * this.L[1] + this.r3[2] * (u[2] - 0.5) * this.L[2];
  }

  depth(x: number, y: number, z: number): number {
    return this.depthU(this.unit(x, y, z));
  }

  /** Whether the face of the box at side 0 (min) or 1 (max) of axis a faces away from the viewer (or is seen edge-on). */
  back(a: number, side: number): boolean {
    return (2 * side - 1) * this.r3[a] <= 1e-9;
  }

  edgeOn(a: number): boolean {
    return Math.abs(this.r3[a]) <= 1e-9;
  }
}

/** Corner of the unit box with u[a] = t, u[b] = fb, u[c] = fc. */
function corner(a: number, t: number, fb: number, fc: number): V3 {
  const u: V3 = [0, 0, 0];
  const [b, c] = others(a);
  u[a] = t;
  u[b] = fb;
  u[c] = fc;
  return u;
}

function others(a: number): [number, number] {
  return a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
}

interface TickEdge {
  /** Fixed sides of the other two axes. */
  fb: number;
  fc: number;
  /** Ends in the picture (axis min, axis max). */
  p0: Pt;
  p1: Pt;
  /** Unit vector in the picture pointing away from the box. */
  out: Pt;
  /** Tick direction (into the box face) and the parallel edge across that face, for the mirrored ticks. */
  inward?: Pt;
  mirror?: { fb: number; fc: number };
}

/** Whether the box edge parallel to axis a at (fb, fc) is drawn: it belongs to a back face. */
function edgeDrawn(P: Projection, a: number, fb: number, fc: number): boolean {
  const [b, c] = others(a);
  return P.back(b, fb) || P.back(c, fc);
}

/** The edge that carries the ticks of axis a: an outline edge of the box, lowest (x, y) or leftmost (z). */
export function tickEdge(P: Projection, a: number): TickEdge | undefined {
  const corners: Pt[] = [];
  for (let k = 0; k < 8; k++) corners.push(P.screenU([k & 1, (k >> 1) & 1, (k >> 2) & 1]));
  const cx = corners.reduce((s, p) => s + p[0], 0) / 8;
  const cy = corners.reduce((s, p) => s + p[1], 0) / 8;
  const span = Math.max(...corners.map((p) => Math.abs(p[0] - cx) + Math.abs(p[1] - cy)), 1);
  let best: TickEdge | undefined;
  let bestKey = Infinity;
  let bestKey2 = Infinity;
  for (const fb of [0, 1])
    for (const fc of [0, 1]) {
      if (!edgeDrawn(P, a, fb, fc)) continue;
      const p0 = P.screenU(corner(a, 0, fb, fc));
      const p1 = P.screenU(corner(a, 1, fb, fc));
      const d: Pt = [p1[0] - p0[0], p1[1] - p0[1]];
      const len = Math.hypot(d[0], d[1]);
      if (len < 1e-6 * span) continue;
      // An outline edge has every corner on one side.
      let pos = false;
      let neg = false;
      for (const q of corners) {
        const cr = (d[0] * (q[1] - p0[1]) - d[1] * (q[0] - p0[0])) / len;
        if (cr > 1e-6 * span) pos = true;
        if (cr < -1e-6 * span) neg = true;
      }
      if (pos && neg) continue;
      const mx = (p0[0] + p1[0]) / 2;
      const my = (p0[1] + p1[1]) / 2;
      const tol = 1e-3 * span;
      const key = a === 2 ? mx : my;
      const key2 = a === 2 ? my : mx;
      if (key < bestKey - tol || (Math.abs(key - bestKey) <= tol && key2 < bestKey2)) {
        let out: Pt = [-d[1] / len, d[0] / len];
        if (out[0] * (mx - cx) + out[1] * (my - cy) < 0) out = [-out[0], -out[1]];
        best = { fb, fc, p0, p1, out };
        bestKey = key;
        bestKey2 = key2;
      }
    }
  if (!best) return undefined;
  // Ticks run into a back face that holds the edge, towards its far side.
  const [b, c] = others(a);
  const faces: { axis: number; side: number; along: number; alongSide: number }[] = [
    { axis: b, side: best.fb, along: c, alongSide: best.fc },
    { axis: c, side: best.fc, along: b, alongSide: best.fb },
  ].filter((f) => P.back(f.axis, f.side));
  faces.sort((f1, f2) => Math.abs(P.r3[f2.axis]) - Math.abs(P.r3[f1.axis]));
  const f = faces[0];
  if (f) {
    const from = P.screenU(corner(a, 0.5, best.fb, best.fc));
    const otherFb = f.along === b ? 1 - best.fb : best.fb;
    const otherFc = f.along === c ? 1 - best.fc : best.fc;
    const to = P.screenU(corner(a, 0.5, otherFb, otherFc));
    const l = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (l > 1e-6 * span) {
      best.inward = [(to[0] - from[0]) / l, (to[1] - from[1]) / l];
      if (edgeDrawn(P, a, otherFb, otherFc)) best.mirror = { fb: otherFb, fc: otherFc };
    }
  }
  return best;
}

// ---------------------------------------------------------------- rendering

/** Draws a 3D axis. Same arguments as renderAxis. */
export function renderAxis3d(it: Interp, env: string, optsText: string, body: string, g0: GS, off: number): void {
  const o = defaultAxis(env);
  // Without \addplot3 the axis is seen from above unless it gives a view.
  const flat = !ADDPLOT3.test(body);
  const a3: Axis3 = { az: flat ? 0 : 25, el: flat ? 90 : 30, colormap: DEFAULT_COLORMAP, colorbarStyle: "", equal: false, complete: false };
  const plotBase = cloneGS(g0);
  plotBase.doDraw = true;
  plotBase.lw = 0.4;
  const base3 = defaultPlotOpts();
  let plotOpts = "";
  const axisHost = hostFor(it, (key, value) => {
    if (axis3Key(a3, o, key, value, it)) return true;
    if (axisKey(o, key, value, it)) return true;
    plotOpts += `,${value !== undefined ? `${key}={${value}}` : key}`;
    return true;
  });
  const axisG = cloneGS(g0);
  for (const d of it.pgfplotsDefaults) applyPgfplotsSet(d, axisG, axisHost, plotBase, it);
  const every = axisG.styles.get("every axis");
  if (every?.body) applyOptions(axisG, every.body, "scope", axisHost);
  applyOptions(axisG, optsText, "scope", axisHost);
  const baseHost = hostFor(it, (key, value) => plot3Key(base3, key, value, it) || PLOT_KEYS.has(key) || key.startsWith("error bar") || key.startsWith("table/"));
  if (plotOpts) applyOptions(plotBase, plotOpts, "path", baseHost);
  const everyPlot = axisG.styles.get("every axis plot");
  if (everyPlot?.body) applyOptions(plotBase, everyPlot.body, "path", baseHost);

  // Body: plots, legend commands, TikZ statements.
  const plots: Plot3[] = [];
  const legendCmds: string[] = [];
  const tikz: { text: string; off: number }[] = [];
  let cycle = 0;
  const readBody = (text: string, at: number, depth: number): void => {
    const sc = new Scanner(text);
    while (!sc.done) {
      it.tick();
      const start = sc.i;
      it.off = at + start;
      if (sc.s[sc.i] !== "\\") {
        const k = sc.s.indexOf("\\", sc.i);
        sc.i = k < 0 ? sc.s.length : k;
        continue;
      }
      const cmd = sc.peekCommand() ?? "";
      sc.i += cmd.length + 1;
      if (cmd === "addplot" || cmd === "addplot3") {
        let is3 = cmd === "addplot3";
        if (sc.s[sc.i] === "3") {
          is3 = true;
          sc.i++;
        }
        sc.ws();
        let plus = false;
        if (sc.s[sc.i] === "+") {
          plus = true;
          sc.i++;
        }
        const stmt = it.expand(sc.statement());
        const p = readPlot3(it, stmt, is3, plus, plotBase, base3, cycle, o.rad);
        if (p) {
          if (!p.forget) cycle++;
          plots.push(p);
        }
        continue;
      }
      if (cmd === "legend") {
        o.legendEntries = splitTop(sc.group("{") ?? "", ",").map((x) => unbrace(x.trim()));
        continue;
      }
      if (cmd === "addlegendentry") {
        sc.options();
        legendCmds.push(sc.group("{") ?? "");
        continue;
      }
      if (cmd === "pgfplotsset") {
        applyPgfplotsSet(sc.group("{") ?? "", axisG, axisHost, plotBase, it);
        continue;
      }
      if (cmd === "closedcycle") continue;
      if ((cmd === "foreach" || cmd === "pgfplotsinvokeforeach") && depth < 4) {
        let expanded = "";
        if (cmd === "foreach") {
          const head = it.foreachHead(sc);
          sc.ws();
          const b = sc.s[sc.i] === "{" ? (sc.group("{") ?? "") : `${sc.statement()};`;
          if (!head) continue;
          it.loop(head, (vars) => {
            let x = b;
            for (const [k, v] of vars) x = x.replace(new RegExp(`\\\\${k}(?![A-Za-z@])`, "g"), () => v);
            expanded += x;
          });
        } else {
          const list = sc.group("{") ?? "";
          const b = sc.group("{") ?? "";
          for (const item of expandList(list, 200)) expanded += b.replace(/#1/g, item);
        }
        readBody(expanded, at + start, depth + 1);
        continue;
      }
      sc.i = start;
      const st = sc.statement();
      tikz.push({ text: `${st};`, off: at + start });
    }
  };
  readBody(body, off, 0);
  if (!o.legendEntries.length) o.legendEntries = legendCmds;
  drawAxis3(it, o, a3, plots, tikz, g0, off);
}

/** Limits of one axis direction: data range, explicit min and max, enlargement. */
function limits(vals: number[], lo: number | undefined, hi: number | undefined, enlarge: number | undefined): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (v < a) a = v;
    if (v > b) b = v;
  }
  if (!Number.isFinite(a)) {
    a = 0;
    b = 1;
  }
  if (enlarge) {
    const d = (b - a) * enlarge;
    a -= d;
    b += d;
  }
  if (lo !== undefined) a = lo;
  if (hi !== undefined) b = hi;
  if (!(b > a)) {
    const d = Math.abs(a) * 0.1 || 1;
    a -= d;
    b += d;
  }
  return [a, b];
}

function nearestAngle(v: Pt): number {
  return (Math.atan2(v[1], v[0]) * 180) / Math.PI;
}

function drawAxis3(it: Interp, o: AxisOpts, a3: Axis3, plots: Plot3[], tikz: { text: string; off: number }[], g0: GS, off: number): void {
  const W = o.scaleOnly ? o.width : Math.max(40, o.width - 45);
  const H = o.scaleOnly ? o.height : Math.max(40, o.height - 45);
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const p of plots)
    for (const q of p.pts) {
      if (!Number.isFinite(q.x)) continue;
      xs.push(q.x);
      ys.push(q.y);
      if (!p.flat) zs.push(q.z);
    }
  const [x0, x1] = limits(xs, o.xmin, o.xmax, o.enlargeX);
  const [y0, y1] = limits(ys, o.ymin, o.ymax, o.enlargeY);
  const [z0, z1] = limits(zs, a3.zmin, a3.zmax, a3.enlargeZ);
  const lo: V3 = [x0, y0, z0];
  const hi: V3 = [x1, y1, z1];
  const ratio: V3 = a3.boxRatio ?? (a3.equal ? [x1 - x0, y1 - y0, z1 - z0] : [1, 1, 1]);
  const P = new Projection(a3.az, a3.el, lo, hi, ratio);
  let origin: Pt = [g0.T[4], g0.T[5]];
  if (o.at) {
    const c = it.coord(o.at.trim().replace(/^\(([^]*)\)$/, "$1"), g0);
    if (c) origin = c.p;
  }
  P.fit(W, H, origin[0], origin[1], a3.equal);
  // The projected box in the picture.
  let hull: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const q = P.screenU([k & 1, (k >> 1) & 1, (k >> 2) & 1]);
    hull = [Math.min(hull[0], q[0]), Math.min(hull[1], q[1]), Math.max(hull[2], q[0]), Math.max(hull[3], q[1])];
  }
  if (o.anchor) {
    // Anchors of the axis refer to the projected box.
    const a = o.anchor.trim().replace(/^outer /, "");
    const cx = (hull[0] + hull[2]) / 2;
    const cy = (hull[1] + hull[3]) / 2;
    const ax = /west/.test(a) ? hull[0] : /east/.test(a) ? hull[2] : cx;
    const ay = /south/.test(a) ? hull[1] : /north/.test(a) ? hull[3] : cy;
    const dx = origin[0] - ax;
    const dy = origin[1] - ay;
    P.ox += dx;
    P.oy += dy;
    hull = [hull[0] + dx, hull[1] + dy, hull[2] + dx, hull[3] + dy];
  }
  const bw = hull[2] - hull[0];
  const bh = hull[3] - hull[1];
  if (o.name) it.nodes.set(o.name, { name: o.name, center: [(hull[0] + hull[2]) / 2, (hull[1] + hull[3]) / 2], shape: "rectangle", hw: bw / 2, hh: bh / 2, rot: 0, baseDy: 0 });

  const ink = "#000000";
  const scene = it.scene;
  const layer = g0.layer;
  const clips = g0.clips;
  const tickLen = 0.15 * CM;
  const axes = [o.axisLines !== "none" && !o.hideX, o.axisLines !== "none" && !o.hideY, o.axisLines !== "none"];
  const box = o.axisLines === "box";

  // Ticks.
  const edges: (TickEdge | undefined)[] = box || o.axisLines === "left" ? [0, 1, 2].map((a) => tickEdge(P, a)) : [undefined, undefined, undefined];
  const edgeLen = (a: number) => {
    const e = edges[a];
    if (e) return Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1]);
    const p = P.screenU(corner(a, 0, 0, 0));
    const q = P.screenU(corner(a, 1, 0, 0));
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  };
  const tickList = (a: number, spec: number[] | "data" | "none" | undefined, dist: number | undefined): number[] => {
    if (edgeLen(a) < 4) return [];
    const [l, h] = [lo[a], hi[a]];
    const inR = (v: number) => v >= l - 1e-9 * (h - l) && v <= h + 1e-9 * (h - l);
    if (spec === "none") return [];
    if (spec === "data") {
      const k = a === 0 ? "x" : a === 1 ? "y" : "z";
      return [...new Set(plots.flatMap((p) => p.pts.map((q) => q[k])).filter(Number.isFinite))].sort((u, v) => u - v).filter(inR).slice(0, 100);
    }
    if (spec) return spec.filter(inR);
    // At least four ticks where they fit, as pgfplots tries; seen from above, as a 2D axis.
    return ticksFor(l, h, Math.abs(a3.el) >= 89.99 ? edgeLen(a) : Math.max(152, edgeLen(a)), false, dist).filter(inR);
  };
  const ticks = [tickList(0, o.xtick, o.xtickDistance), tickList(1, o.ytick, o.ytickDistance), tickList(2, a3.ztick, a3.ztickDistance)];
  const extra = [o.extraXTicks, o.extraYTicks, []];
  for (let a = 0; a < 3; a++) for (const v of extra[a]) if (v >= lo[a] && v <= hi[a]) ticks[a].push(v);

  const uOf = (a: number, v: number): number => (v - lo[a]) / (hi[a] - lo[a]);

  // Grid on the back faces.
  if (box) {
    const gridOn = [o.xgrid ?? (o.grid === "major" || o.grid === "both"), o.ygrid ?? (o.grid === "major" || o.grid === "both"), a3.zgrid ?? (o.grid === "major" || o.grid === "both")];
    const grid: Seg[] = [];
    for (let a = 0; a < 3; a++) {
      if (!gridOn[a]) continue;
      for (const b of others(a)) {
        if (P.edgeOn(b)) continue;
        const side = P.back(b, 0) ? 0 : 1;
        const c = 3 - a - b;
        for (const v of ticks[a]) {
          const u0: V3 = [0, 0, 0];
          u0[a] = uOf(a, v);
          u0[b] = side;
          const u1: V3 = [...u0];
          u1[c] = 1;
          grid.push({ t: "M", p: P.screenU(u0) }, { t: "L", p: P.screenU(u1) });
        }
      }
    }
    if (grid.length) scene.path(grid, { stroke: "#bfbfbf", lineWidth: 0.2 }, clips, layer);
  }

  // Axis lines through the origin (axis lines=center) or along the tick edges (axis lines=left).
  const arrowLines: { a: number; from: Pt; to: Pt }[] = [];
  const ext = o.axisArrows ? 0.25 * CM : 0;
  if (o.axisLines === "middle") {
    const c0 = [0, 1, 2].map((a) => uOf(a, Math.max(lo[a], Math.min(hi[a], 0))));
    for (let a = 0; a < 3; a++) {
      if (!axes[a]) continue;
      const u0: V3 = [c0[0], c0[1], c0[2]];
      const u1: V3 = [c0[0], c0[1], c0[2]];
      u0[a] = 0;
      u1[a] = 1;
      arrowLines.push({ a, from: P.screenU(u0), to: P.screenU(u1) });
    }
  } else if (o.axisLines === "left") {
    for (let a = 0; a < 3; a++) {
      const e = edges[a];
      if (e && axes[a]) arrowLines.push({ a, from: e.p0, to: e.p1 });
    }
  }

  // The frame: box edges, tick marks, axis lines. Over the plots when seen from straight above (a heat
  // map fills the box) or with axis on top, else under them.
  const frame = (): void => {
    if (box) {
      // Box edges on the back faces (all twelve with 3d box=complete).
      const boxSegs: Seg[] = [];
      for (let a = 0; a < 3; a++)
        for (const fb of [0, 1])
          for (const fc of [0, 1]) {
            if (!a3.complete && !edgeDrawn(P, a, fb, fc)) continue;
            boxSegs.push({ t: "M", p: P.screenU(corner(a, 0, fb, fc)) }, { t: "L", p: P.screenU(corner(a, 1, fb, fc)) });
          }
      scene.path(boxSegs, { stroke: ink, lineWidth: 0.4 }, clips, layer);
    }
    // Tick marks on the tick edges and their mirrors.
    const tickSegs: Seg[] = [];
    for (let a = 0; a < 3; a++) {
      const e = edges[a];
      if (!e || !axes[a] || !e.inward) continue;
      for (const v of ticks[a]) {
        const p = P.screenU(corner(a, uOf(a, v), e.fb, e.fc));
        tickSegs.push({ t: "M", p }, { t: "L", p: [p[0] + e.inward[0] * tickLen, p[1] + e.inward[1] * tickLen] });
        if (e.mirror && box) {
          const q = P.screenU(corner(a, uOf(a, v), e.mirror.fb, e.mirror.fc));
          tickSegs.push({ t: "M", p: q }, { t: "L", p: [q[0] - e.inward[0] * tickLen, q[1] - e.inward[1] * tickLen] });
        }
      }
    }
    if (tickSegs.length) scene.path(tickSegs, { stroke: ink, lineWidth: 0.4 }, clips, layer);
    for (const l of arrowLines) {
      const d: Pt = [l.to[0] - l.from[0], l.to[1] - l.from[1]];
      const len = Math.hypot(d[0], d[1]);
      if (len < 1) continue;
      const end: Pt = [l.to[0] + (d[0] / len) * ext, l.to[1] + (d[1] / len) * ext];
      const lg = cloneGS(g0);
      lg.doDraw = true;
      lg.lw = 0.4;
      lg.color = ink;
      lg.drawColor = undefined;
      lg.dash = undefined;
      lg.arrows = o.axisArrows ? { start: [], end: [{ kind: "stealth" }] } : undefined;
      it.strokeWithArrows([{ t: "M", p: l.from }, { t: "L", p: end }], lg);
    }
  };
  const onTop = a3.onTop ?? Math.abs(a3.el) >= 89.99;
  if (!onTop) frame();

  // Plots: patches and segments sorted by depth within each plot.
  const metaRange = (): [number, number] => {
    let a = Infinity;
    let b = -Infinity;
    for (const p of plots)
      for (const q of p.pts)
        if (Number.isFinite(q.m)) {
          if (q.m < a) a = q.m;
          if (q.m > b) b = q.m;
        }
    if (a3.metaMin !== undefined) a = a3.metaMin;
    if (a3.metaMax !== undefined) b = a3.metaMax;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [0, 1];
    if (!(b > a)) return [a - 0.5, a + 0.5];
    return [a, b];
  };
  const [m0, m1] = metaRange();
  for (const p of plots) drawPlot3(it, p, P, a3.colormap, m0, m1, clips, layer);
  if (onTop) frame();

  // Tick labels.
  const fontG = (font?: string): GS => {
    const g = nodeGS(g0);
    g.color = ink;
    g.textColor = undefined;
    g.ix = g.iy = 3.333;
    if (o.font) applyOptions(g, `font={${o.font}}`, "node", hostFor(it));
    if (font) applyOptions(g, `font={${font}}`, "node", hostFor(it));
    return g;
  };
  let ext2: [number, number, number, number] = [...hull];
  const grow = (b: [number, number, number, number]) => {
    ext2 = [Math.min(ext2[0], b[0]), Math.min(ext2[1], b[1]), Math.max(ext2[2], b[2]), Math.max(ext2[3], b[3])];
  };
  const labelNode = (text: string, at: Pt, anchor: string, g: GS, rotate = 0): [number, number, number, number] | undefined => {
    const lg = cloneGS(g);
    lg.anchor = anchor;
    lg.nrot = rotate;
    const n = it.node({ text, g: lg, off, onNext: false }, { point: at }, g0);
    if (!n) return undefined;
    const rx = rotate ? Math.abs(Math.cos((rotate * Math.PI) / 180)) * n.hw + Math.abs(Math.sin((rotate * Math.PI) / 180)) * n.hh : n.hw;
    const ry = rotate ? Math.abs(Math.sin((rotate * Math.PI) / 180)) * n.hw + Math.abs(Math.cos((rotate * Math.PI) / 180)) * n.hh : n.hh;
    const b: [number, number, number, number] = [n.center[0] - rx, n.center[1] - ry, n.center[0] + rx, n.center[1] + ry];
    grow(b);
    return b;
  };
  const tickG = fontG(o.tickFont);
  const labG = fontG(o.labelFont);
  const labels = [o.xlabel, o.ylabel, a3.zlabel];
  const tickTexts = [o.xticklabels, o.yticklabels, a3.zticklabels];
  // Where tick labels went: a label of another axis at the same spot (the shared front corner) is left out.
  const tickSpots: Pt[] = [];
  for (let a = 0; a < 3; a++) {
    if (!axes[a]) continue;
    let e = edges[a];
    let out: Pt | undefined = e?.out;
    let base: (v: number) => Pt;
    if (o.axisLines === "middle") {
      const l = arrowLines.find((x) => x.a === a);
      if (!l) continue;
      const d: Pt = [l.to[0] - l.from[0], l.to[1] - l.from[1]];
      const len = Math.hypot(d[0], d[1]) || 1;
      // Labels below the x and y axes and left of the z axis.
      out = a === 2 ? (d[1] >= 0 ? [-d[1] / len, d[0] / len] : [d[1] / len, -d[0] / len]) : d[0] >= 0 ? [d[1] / len, -d[0] / len] : [-d[1] / len, d[0] / len];
      if (a !== 2 && out[1] > 0) out = [-out[0], -out[1]];
      if (a === 2 && out[0] > 0) out = [-out[0], -out[1]];
      const c0 = [0, 1, 2].map((k) => uOf(k, Math.max(lo[k], Math.min(hi[k], 0))));
      base = (v) => {
        const u: V3 = [c0[0], c0[1], c0[2]];
        u[a] = uOf(a, v);
        return P.screenU(u);
      };
      const n = out;
      const tk: Seg[] = [];
      for (const v of ticks[a]) {
        const q = base(v);
        tk.push({ t: "M", p: [q[0] - (n[0] * tickLen) / 2, q[1] - (n[1] * tickLen) / 2] }, { t: "L", p: [q[0] + (n[0] * tickLen) / 2, q[1] + (n[1] * tickLen) / 2] });
      }
      if (tk.length) scene.path(tk, { stroke: ink, lineWidth: 0.4 }, clips, layer);
      e = undefined;
    } else {
      if (!e || !out) continue;
      const ed = e;
      base = (v) => P.screenU(corner(a, uOf(a, v), ed.fb, ed.fc));
    }
    const anchor = String(Math.round(nearestAngle([-out[0], -out[1]])));
    const boxes: [number, number, number, number][] = [];
    const isOrigin = (v: number) => o.axisLines === "middle" && Math.abs(v) < 1e-12 && [0, 1, 2].some((k) => k !== a && lo[k] < 0 && hi[k] > 0);
    ticks[a].forEach((v, i) => {
      if (isOrigin(v)) return;
      const text = tickTexts[a] ? (tickTexts[a]![i] ?? "") : tickLabel(v, 0);
      if (!text) return;
      const q = base(v);
      const at: Pt = o.axisLines === "middle" ? [q[0] + (out![0] * tickLen) / 2, q[1] + (out![1] * tickLen) / 2] : q;
      if (tickSpots.some((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) < 6)) return;
      tickSpots.push(at);
      const b = labelNode(text, at, anchor, tickG);
      if (b) boxes.push(b);
    });
    const label = labels[a];
    if (!label) continue;
    if (o.axisLines === "middle") {
      const l = arrowLines.find((x) => x.a === a)!;
      const d: Pt = [l.to[0] - l.from[0], l.to[1] - l.from[1]];
      const len = Math.hypot(d[0], d[1]) || 1;
      const tip: Pt = [l.to[0] + (d[0] / len) * (ext + 2), l.to[1] + (d[1] / len) * (ext + 2)];
      labelNode(label, tip, String(Math.round(nearestAngle([-d[0], -d[1]]))), labG);
      continue;
    }
    const ed = e!;
    const mid: Pt = [(ed.p0[0] + ed.p1[0]) / 2, (ed.p0[1] + ed.p1[1]) / 2];
    let dist = 0;
    for (const b of boxes)
      for (const q of [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[0], b[3]],
        [b[2], b[3]],
      ] as Pt[])
        dist = Math.max(dist, (q[0] - mid[0]) * out[0] + (q[1] - mid[1]) * out[1]);
    const at: Pt = [mid[0] + out[0] * dist, mid[1] + out[1] * dist];
    const d: Pt = [ed.p1[0] - ed.p0[0], ed.p1[1] - ed.p0[1]];
    // Labels of steep edges (z, and y seen from above) are turned like a 2D y label.
    const steep = Math.abs(d[0]) < Math.abs(d[1]) * 0.18;
    const rot = steep ? 90 : 0;
    labelNode(label, at, String(Math.round(nearestAngle([-out[0], -out[1]]) - rot)), labG, rot);
  }

  // Colour bar.
  if (a3.colorbar) ext2 = drawColorbar(it, a3, o, m0, m1, hull, ext2, g0, off, fontG);

  // Title above everything of the axis.
  if (o.title) labelNode(o.title, [(hull[0] + hull[2]) / 2, Math.max(hull[3], ext2[3] - 0)], "south", labG);

  // Legend.
  const visible = plots.filter((p) => !p.forget);
  const entries: { plot: Plot; text: string }[] = [];
  visible.forEach((p, i) => {
    const t = o.legendEntries[i] ?? p.legend;
    if (t !== undefined && t !== "") entries.push({ plot: legendPlot(p, a3.colormap, i), text: t });
  });
  if (entries.length) drawLegend(it, o, entries, [hull[0], hull[1]], bw, bh, g0, off, fontG(o.legendFont));

  // TikZ statements inside the axis: x, y and z unit vectors of the data.
  const p0 = P.screen(0, 0, 0);
  const px = P.screen(1, 0, 0);
  const py = P.screen(0, 1, 0);
  const pz = P.screen(0, 0, 1);
  const tg = cloneGS(g0);
  tg.T = [1, 0, 0, 1, p0[0], p0[1]];
  tg.xv = [px[0] - p0[0], px[1] - p0[1]];
  tg.yv = [py[0] - p0[0], py[1] - p0[1]];
  tg.zv = [pz[0] - p0[0], pz[1] - p0[1]];
  tg.axis = undefined;
  for (const t of tikz) {
    try {
      it.run(t.text, t.off, false, tg);
    } catch (e) {
      if (e instanceof Stop) throw e;
    }
  }
  it.drawn++;
}

/** A stand-in for drawLegend: a filled patch for surfaces, a line for meshes and curves. */
function legendPlot(p: Plot3, cmap: Colormap, index: number): Plot {
  const g = cloneGS(p.g);
  const mid = colorAt(p.o.colormap ?? cmap, 0.5);
  if (p.o.kind === "surf" || p.o.kind === "patch") {
    if (!p.o.explicitFill) g.fillColor = mid;
    g.doFill = true;
    g.drawColor = mix(g.fillColor ?? mid, "#000000", 0.8);
    g.doDraw = true;
    return { g, pts: [], bar: "y", closed: false, forget: false, index, nearCoords: false, smooth: false };
  }
  if ((p.o.kind === "mesh" || p.o.kind === "contour" || p.o.scatter) && !p.o.explicitDraw) g.color = mid;
  if (p.o.scatter && !g.mark) g.mark = "*";
  return { g, pts: [], closed: false, forget: false, index, nearCoords: false, smooth: false };
}

/**
 * The patches of a cols x rows grid (each named by its first corner), back to
 * front by the mean depth of their corners; patches with an undefined corner
 * (NaN depth) are left out. Ties keep the grid order, so the result is stable.
 */
export function patchOrder(dep: number[], cols: number, rows: number): number[] {
  const out: { i: number; d: number }[] = [];
  for (let r = 0; r + 1 < rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      const i = r * cols + c;
      const d = (dep[i] + dep[i + 1] + dep[i + cols + 1] + dep[i + cols]) / 4;
      if (Number.isFinite(d)) out.push({ i, d });
    }
  out.sort((u, v) => u.d - v.d || u.i - v.i);
  return out.map((x) => x.i);
}

/** Draws one plot: surfaces and meshes sorted back to front, lines, marks, arrows. */
function drawPlot3(it: Interp, p: Plot3, P: Projection, axisMap: Colormap, m0: number, m1: number, clips: string[], layer: number): void {
  const cmap = p.o.colormap ?? axisMap;
  const g = cloneGS(p.g);
  g.clips = clips;
  g.layer = layer;
  const zOf = (q: P3) => (p.flat ? Math.max(P.lo[2], Math.min(P.hi[2], 0)) : q.z);
  const scr = p.pts.map((q) => {
    it.tick();
    return Number.isFinite(q.x) ? P.screen(q.x, q.y, zOf(q)) : undefined;
  });
  const dep = p.pts.map((q) => (Number.isFinite(q.x) ? P.depth(q.x, q.y, zOf(q)) : NaN));
  const tOf = (m: number) => (m1 > m0 ? (m - m0) / (m1 - m0) : 0.5);
  const mapped = (m: number) => colorAt(cmap, Number.isFinite(m) ? tOf(m) : 0.5);
  const opacity = g.fillOpacity ?? g.opacity;
  const strokeOpacity = g.drawOpacity ?? g.opacity;
  if (p.o.kind === "surf" && p.cols >= 2 && p.rows >= 2) {
    const shader = p.o.shader ?? "faceted";
    const faceted = shader === "faceted" || shader === "faceted interp";
    const explicitFill = p.o.explicitFill ? (g.fillColor ?? g.color) : undefined;
    const facetedColor = p.o.facetedColor !== undefined ? parseColor(p.o.facetedColor, it.colors, it.lookup, g.color) : undefined;
    const patches = patchOrder(dep, p.cols, p.rows).map((i) => ({ i }));
    // shader=interp: each patch is cut into k x k pieces, k growing with the colour change across it,
    // within a budget for the plot. faceted interp keeps one colour per patch: its edges hide the rest.
    const smooth = shader === "interp" && !explicitFill;
    const want = (i: number): number => {
      const M = [i, i + 1, i + p.cols + 1, i + p.cols].map((j) => p.pts[j].m);
      if (!smooth || !M.every(Number.isFinite) || !(m1 > m0)) return 1;
      return Math.max(1, Math.min(8, Math.ceil(((Math.max(...M) - Math.min(...M)) / (m1 - m0)) * 24)));
    };
    const ks = new Map<number, number>();
    let total = 0;
    for (const { i } of patches) {
      const k = want(i);
      ks.set(i, k);
      total += k * k;
    }
    const shrink = total > MAX_INTERP_PATCHES ? Math.sqrt(MAX_INTERP_PATCHES / total) : 1;
    // Colours of the pieces in 128 steps of the map, so that pieces of one colour share a path.
    const quantized = (m: number) => colorAt(cmap, Math.round(Math.max(0, Math.min(1, tOf(m))) * 127) / 127);
    const seam = opacity === undefined || opacity >= 1;
    // Neighbouring pieces of one colour share a path; a hairline of their colour hides the seams.
    let run: Seg[] = [];
    let runColor = "";
    const flush = () => {
      if (run.length) it.scene.path(run, { fill: runColor, ...(seam ? { stroke: runColor } : {}), lineWidth: 0.25, join: "round", ...(opacity !== undefined ? { fillOpacity: opacity } : {}) }, clips, layer);
      run = [];
    };
    // Seen from straight above, the patches of a graph z = f(x, y) do not overlap: their order does
    // not matter, and all pieces of one colour share a path.
    const free = p.graph && Math.abs(P.r3[2]) >= 1 - 1e-9;
    const freeFill = new Map<string, Seg[]>();
    const freeEdge = new Map<string, Seg[]>();
    const add = (m: Map<string, Seg[]>, c: string, segs: Seg[]) => {
      let a = m.get(c);
      if (!a) m.set(c, (a = []));
      for (const x of segs) a.push(x);
    };
    const piece = (segs: Seg[], c: string) => {
      if (free) {
        add(freeFill, c, segs);
        return;
      }
      if (c !== runColor) {
        flush();
        runColor = c;
      }
      for (const x of segs) run.push(x);
    };
    for (const { i } of patches) {
      it.tick();
      const ids = [i, i + 1, i + p.cols + 1, i + p.cols];
      const S = ids.map((j) => scr[j]!);
      const M = ids.map((j) => p.pts[j].m);
      const meanM = M.every(Number.isFinite) ? (M[0] + M[1] + M[2] + M[3]) / 4 : NaN;
      const fill = explicitFill ?? mapped(meanM);
      const edge = facetedColor ?? (p.o.explicitDraw && p.g.drawColor ? p.g.drawColor : mix(fill, "#000000", 0.8));
      const poly: Seg[] = [{ t: "M", p: S[0] }, { t: "L", p: S[1] }, { t: "L", p: S[2] }, { t: "L", p: S[3] }, { t: "Z" }];
      const k = Math.max(1, Math.floor((ks.get(i) ?? 1) * shrink));
      if (smooth && M.every(Number.isFinite)) {
        // Bilinear subdivision: S[0] at (0,0), S[1] at (1,0), S[2] at (1,1), S[3] at (0,1).
        const at = (s: number, t: number): Pt => [
          (1 - s) * (1 - t) * S[0][0] + s * (1 - t) * S[1][0] + s * t * S[2][0] + (1 - s) * t * S[3][0],
          (1 - s) * (1 - t) * S[0][1] + s * (1 - t) * S[1][1] + s * t * S[2][1] + (1 - s) * t * S[3][1],
        ];
        const mAt = (s: number, t: number) => (1 - s) * (1 - t) * M[0] + s * (1 - t) * M[1] + s * t * M[2] + (1 - s) * t * M[3];
        // The pieces of one patch lie side by side, so they may go in any order: grouped by colour.
        const groups = new Map<string, Seg[]>();
        for (let a = 0; a < k; a++)
          for (let b = 0; b < k; b++) {
            const s0 = a / k;
            const s1 = (a + 1) / k;
            const t0 = b / k;
            const t1 = (b + 1) / k;
            const c = k > 1 ? quantized(mAt((s0 + s1) / 2, (t0 + t1) / 2)) : fill;
            let gr = groups.get(c);
            if (!gr) groups.set(c, (gr = []));
            gr.push({ t: "M", p: at(s0, t0) }, { t: "L", p: at(s1, t0) }, { t: "L", p: at(s1, t1) }, { t: "L", p: at(s0, t1) }, { t: "Z" });
          }
        // Start with the colour the previous patch ended with, so that runs continue.
        const order = [...groups.keys()].sort((u, v) => (u === runColor ? -1 : v === runColor ? 1 : 0));
        for (const c of order) piece(groups.get(c)!, c);
      } else if (!faceted) {
        piece(poly, fill);
        continue;
      } else if (free) {
        piece(poly, fill);
        add(freeEdge, edge, poly);
        continue;
      } else {
        flush();
        it.scene.path(poly, { fill, stroke: edge, lineWidth: g.lw, join: "round", ...(opacity !== undefined ? { fillOpacity: opacity } : {}), ...(strokeOpacity !== undefined ? { strokeOpacity } : {}) }, clips, layer);
        continue;
      }
      if (faceted && free) add(freeEdge, edge, poly);
      else if (faceted) {
        flush();
        it.scene.path(poly, { stroke: edge, lineWidth: g.lw, join: "round", ...(strokeOpacity !== undefined ? { strokeOpacity } : {}) }, clips, layer);
      }
    }
    flush();
    for (const [c, segs] of freeFill) it.scene.path(segs, { fill: c, ...(seam ? { stroke: c } : {}), lineWidth: 0.25, join: "round", ...(opacity !== undefined ? { fillOpacity: opacity } : {}) }, clips, layer);
    for (const [c, segs] of freeEdge) it.scene.path(segs, { stroke: c, lineWidth: g.lw, join: "round", ...(strokeOpacity !== undefined ? { strokeOpacity } : {}) }, clips, layer);
    it.drawn++;
  } else if (p.o.kind === "mesh" && p.cols >= 2 && p.rows >= 2) {
    const segs: { a: number; b: number; d: number }[] = [];
    for (let r = 0; r < p.rows; r++)
      for (let c = 0; c < p.cols; c++) {
        const i = r * p.cols + c;
        if (!scr[i]) continue;
        if (c + 1 < p.cols && scr[i + 1]) segs.push({ a: i, b: i + 1, d: (dep[i] + dep[i + 1]) / 2 });
        if (r + 1 < p.rows && scr[i + p.cols]) segs.push({ a: i, b: i + p.cols, d: (dep[i] + dep[i + p.cols]) / 2 });
      }
    segs.sort((u, v) => u.d - v.d);
    const fixed = p.o.explicitDraw ? (g.drawColor ?? g.color) : undefined;
    // Consecutive segments of one colour share a path.
    let cur: Seg[] = [];
    let curColor = "";
    const flush = () => {
      if (cur.length) it.scene.path(cur, { stroke: curColor, lineWidth: g.lw, cap: "round", ...(strokeOpacity !== undefined ? { strokeOpacity } : {}) }, clips, layer);
      cur = [];
    };
    // Colours in 64 steps of the map, so that runs are longer.
    const stepped = (m: number) => colorAt(cmap, Math.round(Math.max(0, Math.min(1, tOf(m))) * 63) / 63);
    for (const s of segs) {
      it.tick();
      const c = fixed ?? (Number.isFinite(p.pts[s.a].m + p.pts[s.b].m) ? stepped((p.pts[s.a].m + p.pts[s.b].m) / 2) : mapped(NaN));
      if (c !== curColor) {
        flush();
        curColor = c;
      }
      cur.push({ t: "M", p: scr[s.a]! }, { t: "L", p: scr[s.b]! });
    }
    flush();
    it.drawn++;
  } else if (p.o.kind === "contour" && p.cols >= 2 && p.rows >= 2) {
    drawContours(it, p, P, cmap, m0, m1, g, clips, layer);
  } else if (p.o.kind === "patch") {
    // Triangles (or quadrilaterals) of consecutive points, back to front, coloured by their mean meta.
    const n = p.o.patchSize ?? 3;
    const polys: { i: number; d: number }[] = [];
    for (let i = 0; i + n <= p.pts.length; i += n) {
      let d = 0;
      for (let j = i; j < i + n; j++) d += dep[j];
      if (Number.isFinite(d)) polys.push({ i, d: d / n });
    }
    polys.sort((u, v) => u.d - v.d || u.i - v.i);
    const faceted = (p.o.shader ?? "faceted").startsWith("faceted");
    for (const { i } of polys) {
      it.tick();
      const ms = p.pts.slice(i, i + n).map((q) => q.m);
      const fill = p.o.explicitFill ? (g.fillColor ?? g.color) : mapped(ms.reduce((a, b) => a + b, 0) / n);
      const segs: Seg[] = [];
      for (let j = 0; j < n; j++) segs.push({ t: j ? "L" : "M", p: scr[i + j]! });
      segs.push({ t: "Z" });
      it.scene.path(segs, { fill, stroke: faceted ? mix(fill, "#000000", 0.8) : fill, lineWidth: faceted ? g.lw : 0.25, join: "round", ...(opacity !== undefined ? { fillOpacity: opacity } : {}) }, clips, layer);
    }
    it.drawn++;
  } else if (p.vec) {
    // Quiver: one arrow per point.
    p.pts.forEach((q, i) => {
      const v = p.vec![i];
      const s = scr[i];
      if (!s || !v.every(Number.isFinite) || (v[0] === 0 && v[1] === 0 && v[2] === 0)) return;
      const e = P.screen(q.x + v[0], q.y + v[1], zOf(q) + v[2]);
      const ag = cloneGS(g);
      if (p.o.scatter || p.o.meta) ag.color = mapped(q.m);
      it.strokeWithArrows([{ t: "M", p: s }, { t: "L", p: e }], ag);
    });
    it.drawn++;
  } else {
    // Lines, broken at undefined points and between scan lines.
    if (!g.onlyMarks) {
      const segs: Seg[] = [];
      let open = false;
      scr.forEach((s, i) => {
        if (!s || p.breaks.has(i)) open = false;
        if (!s) return;
        segs.push({ t: open ? "L" : "M", p: s });
        open = true;
      });
      if (segs.some((s) => s.t === "L")) it.strokeWithArrows(segs, g, false);
    }
    const marks = g.mark || g.onlyMarks || p.o.scatter;
    if (marks) {
      const order = scr.map((_, i) => i).filter((i) => scr[i]);
      if (p.o.zbuf === "sort" || p.o.scatter) order.sort((u, v) => dep[u] - dep[v] || u - v);
      if (p.o.scatter && !p.o.explicitDraw) {
        for (const i of order) {
          const mg = cloneGS(g);
          if (!mg.mark) mg.mark = "*";
          const c = mapped(p.pts[i].m);
          mg.color = c;
          mg.fillColor = c;
          mg.drawColor = mix(c, "#000000", 0.8);
          drawMarks(it, [scr[i]!], mg);
        }
      } else {
        const mg = cloneGS(g);
        if (!mg.mark) mg.mark = "*";
        drawMarks(it, order.map((i) => scr[i]!), mg);
      }
    }
    it.drawn++;
  }
}

/**
 * Contour lines of a grid (contour gnuplot or contour lua, computed here by
 * marching squares): at the given levels, or at `number` (5) levels evenly
 * inside the range of z, each at its height and coloured from the map.
 */
function drawContours(it: Interp, p: Plot3, P: Projection, cmap: Colormap, m0: number, m1: number, g: GS, clips: string[], layer: number): void {
  const kv = new Map(parseOptions(p.o.contour ?? "").map((k) => [k.key, k.value ?? ""]));
  let zlo = Infinity;
  let zhi = -Infinity;
  for (const q of p.pts)
    if (Number.isFinite(q.z)) {
      zlo = Math.min(zlo, q.z);
      zhi = Math.max(zhi, q.z);
    }
  if (!(zhi > zlo)) return;
  let levels: number[];
  const given = kv.get("levels");
  if (given !== undefined) levels = expandList(given, 100).map((x) => num(x)).filter((x): x is number => x !== undefined);
  else {
    const n = Math.max(1, Math.min(50, Math.round(num(kv.get("number") ?? "5") ?? 5)));
    levels = [];
    for (let i = 0; i < n; i++) levels.push(zlo + ((zhi - zlo) * (i + 1)) / (n + 1));
  }
  const fixed = kv.get("draw color") ? parseColor(kv.get("draw color")!, it.colors, it.lookup, g.color) : p.o.explicitDraw ? (g.drawColor ?? g.color) : undefined;
  const at = (a: P3, b: P3, L: number): Pt => {
    const t = (L - a.z) / (b.z - a.z);
    return P.screen(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, L);
  };
  for (const L of levels) {
    const segs: Seg[] = [];
    for (let r = 0; r + 1 < p.rows; r++) {
      it.tick();
      for (let c = 0; c + 1 < p.cols; c++) {
        const i = r * p.cols + c;
        const q = [p.pts[i], p.pts[i + 1], p.pts[i + p.cols + 1], p.pts[i + p.cols]];
        if (q.some((x) => !Number.isFinite(x.z))) continue;
        const cuts: Pt[] = [];
        for (let k = 0; k < 4; k++) {
          const a = q[k];
          const b = q[(k + 1) % 4];
          if ((a.z < L) !== (b.z < L)) cuts.push(at(a, b, L));
        }
        // Two crossings make a segment; four (a saddle) make two, paired around the cell.
        if (cuts.length === 2) segs.push({ t: "M", p: cuts[0] }, { t: "L", p: cuts[1] });
        else if (cuts.length === 4) segs.push({ t: "M", p: cuts[0] }, { t: "L", p: cuts[1] }, { t: "M", p: cuts[2] }, { t: "L", p: cuts[3] });
      }
    }
    if (segs.length) it.scene.path(segs, { stroke: fixed ?? colorAt(cmap, m1 > m0 ? (L - m0) / (m1 - m0) : 0.5), lineWidth: g.lw, cap: "round", join: "round" }, clips, layer);
  }
  it.drawn++;
}

/** The colour bar right of (or below) the axis, with its own ticks; returns the grown extent. */
function drawColorbar(it: Interp, a3: Axis3, o: AxisOpts, m0: number, m1: number, hull: [number, number, number, number], ext: [number, number, number, number], g0: GS, off: number, fontG: (font?: string) => GS): [number, number, number, number] {
  const st = new Map(parseOptions(a3.colorbarStyle).map((k) => [k.key, k.value]));
  const horizontal = a3.colorbar === "horizontal";
  const thick = length(st.get(horizontal ? "height" : "width") ?? "", CM) ?? 0.5 * CM;
  const gap = 0.3 * CM;
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  if (horizontal) {
    w = length(st.get("width") ?? "", CM) ?? hull[2] - hull[0];
    h = thick;
    x = (hull[0] + hull[2]) / 2 - w / 2;
    y = ext[1] - gap - h;
  } else {
    w = thick;
    h = length(st.get("height") ?? "", CM) ?? hull[3] - hull[1];
    x = ext[2] + gap;
    y = hull[3] - h;
  }
  const rect: Seg[] = [{ t: "M", p: [x, y] }, { t: "L", p: [x + w, y] }, { t: "L", p: [x + w, y + h] }, { t: "L", p: [x, y + h] }, { t: "Z" }];
  it.scene.path(rect, { shade: { kind: "linear", angle: horizontal ? 0 : 90, stops: gradientStops(a3.colormap) }, lineWidth: 0.4 }, g0.clips, g0.layer);
  it.scene.path(rect, { stroke: "#000000", lineWidth: 0.4 }, g0.clips, g0.layer);
  const len = horizontal ? w : h;
  const tickSpec = st.get(horizontal ? "xtick" : "ytick");
  const ts = tickSpec !== undefined ? expandList(tickSpec, 100).map((s) => num(s)).filter((v): v is number => v !== undefined && v >= m0 && v <= m1) : ticksFor(m0, m1, len, false);
  const tl = 0.15 * CM;
  const segs: Seg[] = [];
  const pos = (v: number) => ((v - m0) / (m1 - m0)) * len;
  for (const v of ts) {
    if (horizontal) segs.push({ t: "M", p: [x + pos(v), y] }, { t: "L", p: [x + pos(v), y + tl] }, { t: "M", p: [x + pos(v), y + h] }, { t: "L", p: [x + pos(v), y + h - tl] });
    else segs.push({ t: "M", p: [x, y + pos(v)] }, { t: "L", p: [x + tl, y + pos(v)] }, { t: "M", p: [x + w, y + pos(v)] }, { t: "L", p: [x + w - tl, y + pos(v)] });
  }
  if (segs.length) it.scene.path(segs, { stroke: "#000000", lineWidth: 0.4 }, g0.clips, g0.layer);
  const tg = fontG(o.tickFont);
  let out: [number, number, number, number] = [Math.min(ext[0], x), Math.min(ext[1], y), Math.max(ext[2], x + w), Math.max(ext[3], y + h)];
  let far = horizontal ? y : x + w;
  for (const v of ts) {
    const lg = cloneGS(tg);
    lg.anchor = horizontal ? "north" : "west";
    const n = it.node({ text: tickLabel(v, 0), g: lg, off, onNext: false }, { point: horizontal ? [x + pos(v), y] : [x + w, y + pos(v)] }, g0);
    if (n) {
      far = horizontal ? Math.min(far, n.center[1] - n.hh) : Math.max(far, n.center[0] + n.hw);
      out = [Math.min(out[0], n.center[0] - n.hw), Math.min(out[1], n.center[1] - n.hh), Math.max(out[2], n.center[0] + n.hw), Math.max(out[3], n.center[1] + n.hh)];
    }
  }
  const label = st.get(horizontal ? "xlabel" : "ylabel");
  if (label) {
    const lg = fontG(o.labelFont);
    lg.anchor = "north";
    lg.nrot = horizontal ? 0 : 90;
    const n = it.node({ text: label, g: lg, off, onNext: false }, { point: horizontal ? [x + w / 2, far] : [far, y + h / 2] }, g0);
    if (n) out = [Math.min(out[0], n.center[0] - n.hh), out[1], Math.max(out[2], n.center[0] + n.hh), out[3]];
  }
  const title = st.get("title");
  if (title) {
    const lg = fontG(o.labelFont);
    lg.anchor = "south";
    it.node({ text: title, g: lg, off, onNext: false }, { point: [x + w / 2, y + h] }, g0);
  }
  it.drawn++;
  return out;
}
