/**
 * pgfplots: \begin{axis}[...] with \addplot (coordinates, expressions,
 * tables), legends, bar charts, scatter plots and log axes, drawn the way
 * pgfplots draws them: a box with inward ticks, tick labels set as math,
 * labels, a title, a legend box, plots clipped to the box. TikZ commands
 * inside the axis (\node at (axis cs:2,3) ...) use the axis coordinates.
 *
 * Series without their own style take colours from the diagram palette
 * with pgfplots' marks (dot, square, triangle, ...), like its cycle list.
 * fill between (the fillbetween library) fills the region between two
 * named paths. Axes with \addplot3 or a view go to pgfplots3d.ts.
 */

import { THEMES } from "../diagram/theme.js";
import { mix, parseColor } from "./color.js";
import { evaluate, fmt, length, num } from "./expr.js";
import type { Pt, Seg } from "./geom.js";
import { add, apply, smoothThrough } from "./geom.js";
import { type Interp, Stop, anchorPoint, drawMarks, findEnd } from "./interp.js";
import { type OptionHost, applyOptions, expandList } from "./options.js";
import { Scanner, matchClose, parseOptions, splitTop, unbrace } from "./scan.js";
import { isAxis3d, renderAxis3d } from "./pgfplots3d.js";
import { CM, type AxisMap, type GS, cloneGS, nodeGS } from "./state.js";

export const PALETTE = THEMES.default.palette;
export const MARKS = ["*", "square*", "triangle*", "diamond*", "pentagon*", "o", "square", "triangle"];

export interface Plot {
  g: GS;
  pts: [number, number][];
  /** Labels for nodes near coords (the y values by default). */
  bar?: "y" | "x";
  closed: boolean;
  legend?: string;
  forget: boolean;
  index: number;
  nearCoords: boolean;
  smooth: boolean;
  /** name path=... of the plot. */
  name?: string;
  /** fill between[of=A and B]: the two paths and the x range of soft clip. */
  fill?: { a: string; b: string; clip?: [number, number] };
}

export interface AxisOpts {
  width: number;
  height: number;
  scaleOnly: boolean;
  xmin?: number;
  xmax?: number;
  ymin?: number;
  ymax?: number;
  xlabel?: string;
  ylabel?: string;
  title?: string;
  grid: "none" | "major" | "minor" | "both";
  xgrid?: boolean;
  ygrid?: boolean;
  legendPos: string;
  legendAt?: [number, number];
  legendAnchor?: string;
  legendCols: number;
  legendEntries: string[];
  legendFont?: string;
  legendDraw: boolean;
  axisLines: "box" | "left" | "middle" | "none";
  axisArrows: boolean;
  xtick?: number[] | "data" | "none";
  ytick?: number[] | "data" | "none";
  xticklabels?: string[];
  yticklabels?: string[];
  xtickRotate: number;
  ytickRotate: number;
  xtickAnchor?: string;
  tickFont?: string;
  labelFont?: string;
  font?: string;
  bars?: "ybar" | "xbar";
  stacked: boolean;
  barWidth: number;
  barGap: number;
  xsym?: string[];
  ysym?: string[];
  nearCoords: boolean;
  enlargeX?: number;
  enlargeY?: number;
  xlog: boolean;
  ylog: boolean;
  at?: string;
  anchor?: string;
  name?: string;
  hideX: boolean;
  hideY: boolean;
  xdirReverse: boolean;
  ydirReverse: boolean;
  scaledTicks: boolean;
  clip: boolean;
  xtickDistance?: number;
  ytickDistance?: number;
  minorTicks: number;
  rad: boolean;
  extraXTicks: number[];
  extraYTicks: number[];
}

/** Keys of \begin{axis}[...] the axis reads; the rest apply to every plot as TikZ options. */
export function axisKey(o: AxisOpts, key: string, v: string | undefined, it: Interp): boolean {
  const list = (s: string | undefined): number[] | "data" | "none" | undefined => {
    if (s === undefined) return undefined;
    const t = s.trim();
    if (t === "data") return "data";
    if (t === "" || t === "\\empty" || t === "{}") return "none";
    return expandList(t, 200)
      .map((x) => num(x))
      .filter((x): x is number => x !== undefined);
  };
  const labels = (s: string | undefined) => splitTop(s ?? "", ",").map((x) => unbrace(x.trim()));
  if (key.startsWith("colormap/")) return true;
  switch (key) {
    case "width":
      o.width = length(v ?? "240pt", CM) ?? o.width;
      return true;
    case "height":
      o.height = length(v ?? "207pt", CM) ?? o.height;
      return true;
    case "scale only axis":
      o.scaleOnly = true;
      return true;
    case "scale": {
      const s = num(v ?? "1") ?? 1;
      o.width *= s;
      o.height *= s;
      return true;
    }
    case "xmin":
    case "xmax":
    case "ymin":
    case "ymax": {
      const n = num(v ?? "");
      if (n !== undefined) o[key] = n;
      return true;
    }
    case "xlabel":
    case "ylabel":
    case "title":
      o[key] = v ?? "";
      return true;
    case "zlabel":
    case "zmin":
    case "zmax":
    case "ztick":
    case "view":
    case "colormap":
    case "colormap name":
    case "colorbar":
    case "colorbar style":
    case "point meta":
    case "point meta min":
    case "point meta max":
    case "compat":
    case "cycle list name":
    case "cycle list":
    case "legend cell align":
    case "legend image post style":
    case "legend plot pos":
    case "reverse legend":
    case "transpose legend":
    case "tick align":
    case "xtick align":
    case "ytick align":
    case "tick pos":
    case "xtick pos":
    case "ytick pos":
    case "xticklabel pos":
    case "yticklabel pos":
    case "separate axis lines":
    case "axis line style":
    case "every axis x line":
    case "every axis y line":
    case "inner axis line style":
    case "tick style":
    case "xtick style":
    case "ytick style":
    case "major tick length":
    case "minor tick length":
    case "ylabel near ticks":
    case "xlabel near ticks":
    case "ylabel style":
    case "xlabel style":
    case "title style":
    case "label style":
    case "every axis label":
    case "every axis title":
    case "axis background":
    case "area style":
    case "stack plots":
    case "unbounded coords":
    case "restrict y to domain":
    case "restrict x to domain":
    case "axis on top":
    case "unit vector ratio":
    case "axis equal":
    case "axis equal image":
    case "max space between ticks":
    case "try min ticks":
    case "x tick label as interval":
    case "xticklabel shift":
    case "yticklabel shift":
    case "xlabel shift":
    case "ylabel shift":
    case "legend to name":
    case "clip marker paths":
    case "clip mode":
    case "extra tick style":
    case "every axis plot post":
    case "nodes near coords align":
    case "every node near coord":
    case "visualization depends on":
    case "y tick label style":
    case "x tick scale label style":
    case "y tick scale label style":
    case "every x tick scale label":
    case "every y tick scale label":
    case "enlarge z limits":
    case "z buffer":
    case "boxplot":
    case "table/col sep":
    case "x filter":
    case "y filter":
    case "xticklabel":
    case "yticklabel":
      return true;
    case "grid":
      o.grid = v === "minor" || v === "both" || v === "none" ? v : "major";
      return true;
    case "xmajorgrids":
      o.xgrid = v !== "false";
      return true;
    case "ymajorgrids":
      o.ygrid = v !== "false";
      return true;
    case "xminorgrids":
    case "yminorgrids":
      return true;
    case "minor tick num":
    case "minor x tick num":
    case "minor y tick num":
      o.minorTicks = Math.max(0, Math.min(9, Math.round(num(v ?? "0") ?? 0)));
      return true;
    case "legend pos":
      o.legendPos = (v ?? "north east").trim();
      return true;
    case "legend entries":
      o.legendEntries = labels(v);
      return true;
    case "legend columns": {
      const n = num(v ?? "1") ?? 1;
      o.legendCols = n < 0 ? 100 : Math.max(1, Math.round(n));
      return true;
    }
    case "legend style":
    case "every axis legend": {
      for (const { key: k, value: val } of parseOptions(v ?? "")) {
        if (k === "at" && val) {
          const m = /^\(?\s*([^,]+),([^)]+)\)?$/.exec(val.trim().replace(/^\{|\}$/g, ""));
          if (m) {
            const x = num(m[1]);
            const y = num(m[2]);
            if (x !== undefined && y !== undefined) o.legendAt = [x, y];
          }
        } else if (k === "anchor" && val) o.legendAnchor = val.trim();
        else if (k === "legend columns") {
          const n = num(val ?? "1") ?? 1;
          o.legendCols = n < 0 ? 100 : Math.max(1, Math.round(n));
        } else if (k === "font" && val) o.legendFont = val;
        else if (k === "draw" && val === "none") o.legendDraw = false;
      }
      return true;
    }
    case "axis lines":
    case "axis lines*": {
      const t = (v ?? "box").trim();
      o.axisLines = t === "left" || t === "middle" || t === "center" || t === "none" ? (t === "center" ? "middle" : t) : "box";
      o.axisArrows = key === "axis lines" && o.axisLines !== "box";
      return true;
    }
    case "axis x line":
    case "axis y line":
    case "axis x line*":
    case "axis y line*": {
      const t = (v ?? "box").trim();
      if (t === "none") {
        if (key.startsWith("axis x")) o.hideX = true;
        else o.hideY = true;
        return true;
      }
      o.axisLines = t === "middle" || t === "center" ? "middle" : t === "box" ? "box" : "left";
      o.axisArrows = !key.endsWith("*") && o.axisLines !== "box";
      return true;
    }
    case "hide axis":
      o.axisLines = "none";
      o.xtick = "none";
      o.ytick = "none";
      return true;
    case "hide x axis":
      o.hideX = true;
      return true;
    case "hide y axis":
      o.hideY = true;
      return true;
    case "xtick":
      o.xtick = list(v);
      return true;
    case "ytick":
      o.ytick = list(v);
      return true;
    case "extra x ticks":
      o.extraXTicks = (list(v) as number[]) ?? [];
      return true;
    case "extra y ticks":
      o.extraYTicks = (list(v) as number[]) ?? [];
      return true;
    case "xtick distance":
      o.xtickDistance = num(v ?? "");
      return true;
    case "ytick distance":
      o.ytickDistance = num(v ?? "");
      return true;
    case "xticklabels":
      o.xticklabels = labels(v);
      return true;
    case "yticklabels":
      o.yticklabels = labels(v);
      return true;
    case "xticklabel style":
    case "x tick label style":
    case "yticklabel style":
    case "ticklabel style":
    case "tick label style":
    case "every tick label": {
      for (const { key: k, value: val } of parseOptions(v ?? "")) {
        if (k === "rotate") {
          const r = num(val ?? "0") ?? 0;
          if (key.startsWith("y")) o.ytickRotate = r;
          else o.xtickRotate = r;
        } else if (k === "anchor" && val && !key.startsWith("y")) o.xtickAnchor = val.trim();
        else if (k === "font" && val) o.tickFont = val;
      }
      return true;
    }
    case "font":
      o.font = v;
      return true;
    case "ybar":
    case "xbar":
    case "ybar stacked":
    case "xbar stacked":
    case "ybar interval": {
      o.bars = key.startsWith("x") ? "xbar" : "ybar";
      o.stacked = key.endsWith("stacked");
      const gap = length(v ?? "", 1);
      if (gap !== undefined) o.barGap = gap;
      return true;
    }
    case "bar width":
      o.barWidth = length(v ?? "10pt", 1) ?? o.barWidth;
      return true;
    case "bar shift":
      return true;
    case "symbolic x coords":
      o.xsym = labels(v);
      return true;
    case "symbolic y coords":
      o.ysym = labels(v);
      return true;
    case "nodes near coords":
      o.nearCoords = true;
      return true;
    case "enlargelimits":
    case "enlarge x limits":
    case "enlarge y limits": {
      const t = (v ?? "true").trim();
      const kv = parseOptions(t);
      let f = t === "false" ? 0 : t === "true" ? 0.1 : (num(t) ?? (kv.find((k) => k.key === "value")?.value ? (num(kv.find((k) => k.key === "value")!.value!) ?? 0.1) : 0.1));
      if (/abs/.test(t)) f = 0.1;
      if (key !== "enlarge y limits") o.enlargeX = f;
      if (key !== "enlarge x limits") o.enlargeY = f;
      return true;
    }
    case "xmode":
      o.xlog = (v ?? "").trim() === "log";
      return true;
    case "ymode":
      o.ylog = (v ?? "").trim() === "log";
      return true;
    case "log basis x":
    case "log basis y":
    case "log ticks with fixed point":
      return true;
    case "at":
      o.at = v;
      return true;
    case "anchor":
      o.anchor = v;
      return true;
    case "name":
      o.name = v;
      return true;
    case "x dir":
      o.xdirReverse = (v ?? "").trim() === "reverse";
      return true;
    case "y dir":
      o.ydirReverse = (v ?? "").trim() === "reverse";
      return true;
    case "scaled ticks":
    case "scaled x ticks":
    case "scaled y ticks":
      o.scaledTicks = (v ?? "true").trim() !== "false";
      return true;
    case "clip":
      o.clip = (v ?? "true").trim() !== "false";
      return true;
    case "trig format plots":
    case "trig format":
      o.rad = (v ?? "").trim() === "rad";
      return true;
  }
  void it;
  return false;
}

export function defaultAxis(env: string): AxisOpts {
  return {
    width: 240,
    height: 207,
    scaleOnly: false,
    grid: "none",
    legendPos: "north east",
    legendCols: 1,
    legendEntries: [],
    legendDraw: true,
    axisLines: "box",
    axisArrows: false,
    xtickRotate: 0,
    ytickRotate: 0,
    stacked: false,
    barWidth: 10,
    barGap: 2,
    nearCoords: false,
    xlog: env === "semilogxaxis" || env === "loglogaxis",
    ylog: env === "semilogyaxis" || env === "loglogaxis",
    hideX: false,
    hideY: false,
    xdirReverse: false,
    ydirReverse: false,
    scaledTicks: true,
    clip: true,
    minorTicks: 0,
    rad: false,
    extraXTicks: [],
    extraYTicks: [],
  };
}

/** Plot keys handled here rather than by TikZ. */
export const PLOT_KEYS = new Set(["forget plot", "ybar", "xbar", "bar width", "bar shift", "nodes near coords", "error bars/.cd", "error bars", "name path", "unbounded coords", "y filter/.code", "x filter/.code", "restrict y to domain", "restrict x to domain", "point meta", "scatter", "scatter src", "area legend", "legend image post style", "line legend", "mark phase", "mark repeat", "mark indices", "table/col sep", "every node near coord", "error bar style", "y dir", "y error", "x error", "y explicit", "x explicit", "trig format plots", "discard if", "discard if not", "fill between", "point meta min", "point meta max", "colormap", "draw error bar", "shader", "mesh", "surf", "patch", "ycomb", "xcomb", "jump mark left"]);

export function hostFor(it: Interp, extra?: OptionHost["extra"]): OptionHost {
  return {
    unknown: (k) => it.unknown(k),
    warn: (m) => it.warn(m),
    colors: it.colors,
    ...(it.lookup ? { lookup: it.lookup } : {}),
    coordOffset: (t, g) => it.coordOffset(t, g),
    ...(extra ? { extra } : {}),
  };
}

export function renderAxis(it: Interp, env: string, optsText: string, body: string, g0: GS, off: number): void {
  // Axes with ddplot3 or a view are drawn in 3D.
  if (isAxis3d(optsText, body, env)) {
    renderAxis3d(it, env, optsText, body, g0, off);
    return;
  }
  const o = defaultAxis(env);
  const plotBase = cloneGS(g0);
  plotBase.doDraw = true;
  plotBase.lw = 0.4;
  let plotOpts = "";
  const axisHost = hostFor(it, (key, value, _g) => {
    if (axisKey(o, key, value, it)) return true;
    // Every other key is a plot style for all plots.
    plotOpts += `,${value !== undefined ? `${key}={${value}}` : key}`;
    return true;
  });
  const axisG = cloneGS(g0);
  for (const d of it.pgfplotsDefaults) applyPgfplotsSet(d, axisG, axisHost, plotBase, it);
  const every = axisG.styles.get("every axis");
  if (every?.body) applyOptions(axisG, every.body, "scope", axisHost);
  applyOptions(axisG, optsText, "scope", axisHost);
  const plotHost = hostFor(it, (key) => PLOT_KEYS.has(key) || key.startsWith("error bar") || key.startsWith("table/") || key.startsWith("colormap/"));
  const everyPlot = axisG.styles.get("every axis plot");
  if (plotOpts) applyOptions(plotBase, plotOpts, "path", plotHost);
  if (everyPlot?.body) applyOptions(plotBase, everyPlot.body, "path", plotHost);

  // Read the body: plots, legend commands, TikZ statements.
  const plots: Plot[] = [];
  const legendCmds: string[] = [];
  const tikz: { text: string; off: number }[] = [];
  const sc = new Scanner(body);
  let cycle = 0;
  let skipped = 0;
  while (!sc.done) {
    it.tick();
    const start = sc.i;
    it.off = off + start;
    if (sc.s[sc.i] !== "\\") {
      const k = sc.s.indexOf("\\", sc.i);
      sc.i = k < 0 ? sc.s.length : k;
      continue;
    }
    const cmd = sc.peekCommand() ?? "";
    sc.i += cmd.length + 1;
    if (cmd === "addplot" || cmd === "addplot3") {
      // The command reader stops before digits: \addplot3 arrives as addplot followed by 3.
      if (cmd === "addplot3" || sc.s[sc.i] === "3") {
        it.warnOnce("addplot3", "\\addplot3 (3D plots) is not supported; the plot was skipped");
        skipped++;
        sc.statement();
        continue;
      }
      sc.ws();
      let plus = false;
      if (sc.s[sc.i] === "+") {
        plus = true;
        sc.i++;
      }
      const stmt = it.expand(sc.statement());
      const plot = readPlot(it, stmt, plus, plotBase, plotHost, o, plots.filter((p) => !p.forget).length, cycle);
      if (plot) {
        if (!plot.forget) cycle++;
        plots.push(plot);
      } else skipped++;
      continue;
    }
    if (cmd === "legend") {
      const v = sc.group("{") ?? "";
      o.legendEntries = splitTop(v, ",").map((x) => unbrace(x.trim()));
      continue;
    }
    if (cmd === "addlegendentry") {
      sc.options();
      const v = sc.group("{") ?? "";
      // Entries go to the plots in order, as pgfplots does.
      legendCmds.push(v);
      continue;
    }
    if (cmd === "pgfplotsset") {
      const v = sc.group("{") ?? "";
      applyPgfplotsSet(v, axisG, axisHost, plotBase, it);
      continue;
    }
    if (cmd === "closedcycle") continue;
    if (cmd === "pgfplotsinvokeforeach" || cmd === "foreach") {
      // \foreach around \addplot: expand it in place.
      if (cmd === "foreach") {
        const head = it.foreachHead(sc);
        sc.ws();
        const b = sc.s[sc.i] === "{" ? (sc.group("{") ?? "") : `${sc.statement()};`;
        if (!head) continue;
        let expanded = "";
        it.loop(head, (vars) => {
          let x = b;
          for (const [k, v] of vars) x = x.replace(new RegExp(`\\\\${k}(?![A-Za-z@])`, "g"), () => v);
          expanded += x;
        });
        const rest = sc.s.slice(sc.i);
        renderBodyInto(expanded);
        sc.i = sc.s.length;
        if (rest.trim()) renderBodyInto(rest);
        continue;
      }
      const list = sc.group("{") ?? "";
      const b = sc.group("{") ?? "";
      let expanded = "";
      for (const item of expandList(list, 200)) expanded += b.replace(/#1/g, item);
      const rest = sc.s.slice(sc.i);
      renderBodyInto(expanded);
      sc.i = sc.s.length;
      if (rest.trim()) renderBodyInto(rest);
      continue;
    }
    // TikZ inside the axis: run once the axis is laid out.
    sc.i = start;
    const st = sc.statement();
    tikz.push({ text: `${st};`, off: off + start });
  }

  function renderBodyInto(text: string): void {
    // A tiny recursive reader for bodies produced by loops: only \addplot, \addlegendentry and TikZ statements.
    const s2 = new Scanner(text);
    while (!s2.done) {
      if (s2.s[s2.i] !== "\\") {
        const k = s2.s.indexOf("\\", s2.i);
        s2.i = k < 0 ? s2.s.length : k;
        continue;
      }
      const c = s2.peekCommand() ?? "";
      s2.i += c.length + 1;
      if (c === "addplot") {
        s2.ws();
        let plus = false;
        if (s2.s[s2.i] === "+") {
          plus = true;
          s2.i++;
        }
        const plot = readPlot(it, it.expand(s2.statement()), plus, plotBase, plotHost, o, plots.filter((p) => !p.forget).length, cycle);
        if (plot) {
          if (!plot.forget) cycle++;
          plots.push(plot);
        }
      } else if (c === "addlegendentry") {
        s2.options();
        legendCmds.push(s2.group("{") ?? "");
      } else if (c === "legend") {
        o.legendEntries = splitTop(s2.group("{") ?? "", ",").map((x) => unbrace(x.trim()));
      } else {
        const st = s2.statement();
        tikz.push({ text: `\\${c}${st};`, off });
      }
    }
  }

  // An axis whose every plot was skipped (3D surfaces, say) is left out rather than drawn empty.
  if (!plots.length && skipped && !tikz.length) return;
  if (!o.legendEntries.length) o.legendEntries = legendCmds;
  drawAxis(it, o, plots, tikz, g0, off);
}

export function applyPgfplotsSet(v: string, axisG: GS, axisHost: OptionHost, plotBase: GS, it: Interp): void {
  // \pgfplotsset{compat=..., every axis/.append style={...}, width=...}: axis keys and styles.
  for (const { key, value } of parseOptions(v)) {
    if (/^(\/pgfplots\/)?every axis\/\.(append )?style$/.test(key) || /^(\/pgfplots\/)?every axis plot\/\.(append )?style$/.test(key) || key.endsWith("/.style") || key.endsWith("/.append style")) {
      applyOptions(axisG, `${key}={${value ?? ""}}`, "scope", axisHost);
      continue;
    }
    if (key === "compat" || key.startsWith("compat")) continue;
    if (key === "cycle list" || key === "cycle list name") continue;
    applyOptions(axisG, value !== undefined ? `${key}={${value}}` : key, "scope", axisHost);
  }
  void plotBase;
  void it;
}

/** Reads one \addplot statement (after \addplot and the optional +). `idx` counts the plots before it, `cyc` the cycle-list position. */
function readPlot(it: Interp, stmt: string, plus: boolean, base: GS, host: OptionHost, ax: AxisOpts, idx: number, cyc: number): Plot | undefined {
  const sc = new Scanner(stmt);
  const g = cloneGS(base);
  const optsText = sc.options();
  const opts = parseOptions(optsText ?? "");
  const forget = opts.some((x) => x.key === "forget plot");
  const isBar = !!ax?.bars || opts.some((x) => x.key === "ybar" || x.key === "xbar");
  const barDir: "y" | "x" | undefined = isBar ? ((ax?.bars ?? (opts.some((x) => x.key === "xbar") ? "xbar" : "ybar")) === "xbar" ? "x" : "y") : undefined;
  // Cycle-list style for \addplot without options, or with +.
  if (optsText === undefined || plus) {
    const color = PALETTE[cyc % PALETTE.length];
    g.color = color;
    if (isBar) {
      g.drawColor = color;
      g.fillColor = mix(color, "#ffffff", 0.75);
      g.doFill = true;
    } else {
      g.mark = MARKS[cyc % MARKS.length];
      g.markOpts = [];
    }
  } else if (isBar) {
    g.doFill = true;
    g.fillColor = g.fillColor ?? mix(g.color, "#ffffff", 0.3);
  }
  if (optsText) applyOptions(g, optsText, "path", host);
  if (isBar && optsText !== undefined && !plus) {
    // \addplot[fill=blue] for a bar: the outline follows the colour too.
    if (!g.doFill && g.fillColor === undefined) {
      g.doFill = true;
      g.fillColor = mix(g.color, "#ffffff", 0.3);
    }
  }
  const nearCoords = !!ax?.nearCoords || opts.some((x) => x.key === "nodes near coords");
  sc.ws();
  let pts: [number, number][] = [];
  const pushPt = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      pts.push([NaN, NaN]);
      return;
    }
    if (pts.length < 20000) pts.push([x, y]);
  };
  const symX = (t: string): number | undefined => {
    const k = ax?.xsym?.indexOf(t.trim());
    if (k !== undefined && k >= 0) return k;
    return num(t);
  };
  const symY = (t: string): number | undefined => {
    const k = ax?.ysym?.indexOf(t.trim());
    if (k !== undefined && k >= 0) return k;
    return num(t);
  };
  if (sc.word("coordinates")) {
    const bodyText = sc.group("{") ?? "";
    for (const m of bodyText.matchAll(/\(([^()]*)\)/g)) {
      const parts = splitTop(m[1], ",");
      if (parts.length < 2) continue;
      pushPt(symX(parts[0]), symY(parts[1]));
    }
    if (/\+-|\+=|-=/.test(bodyText)) it.warnOnce("errorbars", "Error bars in \\addplot coordinates are not drawn");
  } else if (sc.word("table")) {
    const topts = sc.options() ?? "";
    sc.ws();
    let data: string;
    if (sc.s[sc.i] === "{") {
      const inner = (sc.group("{") ?? "").trim();
      const macro = /^\\([A-Za-z@]+)$/.exec(inner);
      if (macro) data = it.tables.get(macro[1]) ?? "";
      else if (!inner.includes("\n") && !/\\\\/.test(inner) && /^[\w./-]+$/.test(inner)) {
        const file = it.opts.readFile?.(inner);
        if (file === undefined) it.warn(`table file ${inner} could not be read`, it.off, "Put the data file next to the document, or write the data inline");
        data = file ?? "";
      } else data = inner;
    } else {
      const m = /^\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i));
      data = m ? (it.tables.get(m[1]) ?? "") : "";
      if (m) sc.i += m[0].length;
    }
    for (const [x, y] of readTable(it, data, topts, ax)) pushPt(x, y);
  } else if (sc.s[sc.i] === "{" || sc.s[sc.i] === "(" || sc.word("expression")) {
    sc.ws();
    let xs: number[] = g.samplesAt ?? [];
    if (!xs.length) {
      const [a, b] = g.domain;
      const n = Math.max(2, Math.min(2000, g.samples));
      xs = [];
      for (let i = 0; i < n; i++) xs.push(a + ((b - a) * i) / (n - 1));
    }
    it.tick(xs.length);
    const v = g.variable === "x" ? "x" : g.variable;
    const rad = !!ax?.rad;
    if (sc.s[sc.i] === "(") {
      const inner = sc.group("(") ?? "";
      const parts = splitTop(inner, ",").map(unbrace);
      for (const t of xs) pushPt(evalAt(parts[0] ?? "0", v, t, rad), evalAt(parts[1] ?? "0", v, t, rad));
    } else {
      const ex = sc.group("{") ?? "0";
      for (const x of xs) pushPt(x, evalAt(ex, v, x, rad));
    }
  } else if (sc.word("fill between")) {
    const fo = new Map(parseOptions(sc.options() ?? "").map((k) => [k.key, k.value ?? ""]));
    const of = /^\s*(.+?)\s+and\s+(.+?)\s*$/.exec(fo.get("of") ?? "");
    if (!of) {
      it.warn("fill between needs of=A and B, the name path of two plots", it.off, "Give the plots name path=A and name path=B, then write fill between[of=A and B]");
      return undefined;
    }
    let clip: [number, number] | undefined;
    const soft = fo.get("soft clip") ?? fo.get("soft clip first") ?? fo.get("soft clip second");
    if (soft) {
      const d = /domain\s*=\s*([^:,]+):([^,}]+)/.exec(soft) ?? /^\s*\(\s*([^,()]+),[^()]*\)\s*rectangle\s*\(\s*([^,()]+),/.exec(soft);
      const a = d ? num(d[1].replace(/^\s*axis cs:/, "")) : undefined;
      const b = d ? num(d[2].replace(/^\s*axis cs:/, "")) : undefined;
      if (a !== undefined && b !== undefined) clip = [Math.min(a, b), Math.max(a, b)];
    }
    // Filled, not outlined (unless the plot asks for draw), without marks.
    g.doFill = true;
    g.fillColor = g.fillColor ?? g.color;
    g.doDraw = opts.some((x) => x.key === "draw" && x.value !== "none");
    g.mark = undefined;
    return { g, pts: [], closed: false, forget, index: idx, nearCoords: false, smooth: false, fill: { a: of[1], b: of[2], ...(clip ? { clip } : {}) } };
  } else if (sc.word("gnuplot")) {
    it.warnOnce("gnuplot", "\\addplot gnuplot needs gnuplot; the plot was skipped", "Write the expression as \\addplot {...}");
    return undefined;
  } else {
    it.warn(`cannot read this \\addplot; write coordinates {...}, table {...} or {expression}`);
    return undefined;
  }
  sc.ws();
  const closed = /\\closedcycle/.test(sc.s.slice(sc.i));
  // Trailing NaNs and empty plots.
  pts = pts.filter((p, i, a) => !(Number.isNaN(p[0]) && (i === 0 || Number.isNaN(a[i - 1][0]))));
  if (!pts.some((p) => !Number.isNaN(p[0]))) {
    it.warnOnce(`emptyplot:${stmt.slice(0, 30)}`, "An \\addplot gave no points");
  }
  const name = opts.find((x) => x.key === "name path" || x.key === "name path global")?.value?.trim();
  return { g, pts, ...(barDir ? { bar: barDir } : {}), closed, forget, index: idx, nearCoords, smooth: g.smooth, ...(name ? { name } : {}) };
}

function evalAt(ex: string, v: string, x: number, rad: boolean): number | undefined {
  try {
    const t = ex.split(`\\${v}`).join(`(${x})`);
    return evaluate(t, { [v]: x, x }, rad).v;
  } catch {
    return undefined;
  }
}

/** Rows of a pgfplots table as (x, y): columns by name (x=..., y=...), index, or expression. */
function readTable(it: Interp, data: string, opts: string, ax: AxisOpts | undefined): [number | undefined, number | undefined][] {
  const kv = new Map(parseOptions(opts).map((o) => [o.key.replace(/^\/pgfplots\/table\//, ""), o.value ?? ""]));
  const sep = kv.get("col sep");
  const rowSep = kv.get("row sep");
  let text = data;
  if (rowSep === "\\\\" || /\\\\/.test(text)) text = text.replace(/\\\\/g, "\n");
  const splitter = sep === "comma" ? /\s*,\s*/ : sep === "semicolon" ? /\s*;\s*/ : sep === "tab" ? /\t/ : sep === "&" || sep === "ampersand" ? /\s*&\s*/ : /\s+/;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^\\])%.*$/, "$1").trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return [];
  let header: string[] | undefined;
  const first = lines[0].split(splitter);
  if (first.some((c) => num(c) === undefined && !(ax?.xsym?.includes(c) ?? false))) {
    header = first.map((c) => unbrace(c));
    lines.shift();
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
  const xexpr = kv.get("x expr");
  const yexpr = kv.get("y expr");
  const out: [number | undefined, number | undefined][] = [];
  for (const line of lines.slice(0, 20000)) {
    const cells = line.split(splitter);
    const value = (c: number, expr: string | undefined, sym?: string[]): number | undefined => {
      if (expr) {
        const e = expr
          .replace(/\\thisrow\{([^}]*)\}/g, (_m, n: string) => `(${cells[header ? header.indexOf(n.trim()) : 0] ?? "0"})`)
          .replace(/\\thisrowno\{(\d+)\}/g, (_m, n: string) => `(${cells[Number(n)] ?? "0"})`)
          .replace(/\\coordindex/g, String(out.length));
        return num(e);
      }
      const cell = cells[c];
      if (cell === undefined) return undefined;
      const s = sym?.indexOf(cell.trim());
      if (s !== undefined && s >= 0) return s;
      return num(cell);
    };
    out.push([value(xc, xexpr, ax?.xsym), value(yc, yexpr, ax?.ysym)]);
  }
  return out;
}

// ---------------------------------------------------------------- layout

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return step * p;
}

export function ticksFor(lo: number, hi: number, len: number, log: boolean, distance?: number): number[] {
  if (!(hi > lo)) return [lo];
  if (log) {
    const out: number[] = [];
    const a = Math.ceil(lo - 1e-9);
    const b = Math.floor(hi + 1e-9);
    const stepE = Math.max(1, Math.ceil((b - a + 1) / Math.max(2, len / 30)));
    for (let e = a; e <= b; e += stepE) out.push(e);
    return out;
  }
  const step = distance && distance > 0 ? distance : niceStep(hi - lo, Math.max(3, Math.min(9, len / 38)));
  const out: number[] = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let v = start, k = 0; v <= hi + step * 1e-9 && k < 200; v += step, k++) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** A tick label as pgfplots prints it: 1,000, 0.25, -3 (as math). */
export function tickLabel(v: number, scaleExp: number): string {
  const x = v / Math.pow(10, scaleExp);
  let s: string;
  const r = Math.round(x * 100) / 100;
  if (Math.abs(r) >= 1000 && Number.isInteger(r)) s = Math.abs(r).toLocaleString("en-US").replace(/,/g, "{,}");
  else s = String(Math.abs(r));
  return `$${r < 0 ? "-" : ""}${s}$`;
}

function drawAxis(it: Interp, o: AxisOpts, plots: Plot[], tikz: { text: string; off: number }[], g0: GS, off: number): void {
  // The axis box.
  const W = o.scaleOnly ? o.width : Math.max(40, o.width - 45);
  const H = o.scaleOnly ? o.height : Math.max(40, o.height - 45);
  // Data range.
  const tx = (x: number) => (o.xlog ? (x > 0 ? Math.log10(x) : NaN) : x);
  const ty = (y: number) => (o.ylog ? (y > 0 ? Math.log10(y) : NaN) : y);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  // Stacked bars: cumulative values.
  const stackBase = new Map<number, number>();
  const barPlots = plots.filter((p) => p.bar && !p.forget);
  if (o.stacked) {
    for (const p of barPlots) {
      p.pts = p.pts.map(([x, y]) => {
        const k = p.bar === "x" ? y : x;
        const v = p.bar === "x" ? x : y;
        const b = stackBase.get(k) ?? 0;
        stackBase.set(k, b + v);
        return p.bar === "x" ? [b + v, y] : [x, b + v];
      });
    }
  }
  for (const p of plots) {
    for (const [x, y] of p.pts) {
      const X = tx(x);
      const Y = ty(y);
      if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
      x0 = Math.min(x0, X);
      x1 = Math.max(x1, X);
      y0 = Math.min(y0, Y);
      y1 = Math.max(y1, Y);
    }
  }
  if (barPlots.length) {
    if (barPlots.some((p) => p.bar === "y") && !o.ylog) {
      y0 = Math.min(y0, 0);
      y1 = Math.max(y1, 0);
    }
    if (barPlots.some((p) => p.bar === "x") && !o.xlog) {
      x0 = Math.min(x0, 0);
      x1 = Math.max(x1, 0);
    }
  }
  if (o.xsym?.length) {
    x0 = Math.min(x0, 0);
    x1 = Math.max(x1, o.xsym.length - 1);
  }
  if (!Number.isFinite(x0)) {
    x0 = 0;
    x1 = 1;
  }
  if (!Number.isFinite(y0)) {
    y0 = 0;
    y1 = 1;
  }
  if (o.xmin !== undefined) x0 = tx(o.xmin);
  if (o.xmax !== undefined) x1 = tx(o.xmax);
  if (o.ymin !== undefined) y0 = ty(o.ymin);
  if (o.ymax !== undefined) y1 = ty(o.ymax);
  if (!(x1 > x0)) {
    x0 -= 1;
    x1 += 1;
  }
  if (!(y1 > y0)) {
    const d = Math.abs(y0) * 0.1 || 1;
    y0 -= d;
    y1 += d;
  }
  // Room for bars at the ends, and enlarged limits.
  const nBars = o.stacked ? Math.min(1, barPlots.length) : barPlots.length;
  const groupW = nBars * o.barWidth + Math.max(0, nBars - 1) * o.barGap;
  const enlarge = (lo: number, hi: number, f: number | undefined, explicitLo: boolean, explicitHi: boolean): [number, number] => {
    if (!f) return [lo, hi];
    const d = (hi - lo) * f;
    return [explicitLo ? lo : lo - d, explicitHi ? hi : hi + d];
  };
  if (barPlots.some((p) => p.bar === "y") && o.enlargeX === undefined && o.xmin === undefined && o.xmax === undefined) {
    const m = groupW / 2 + o.barWidth;
    const r = (x1 - x0) / Math.max(1e-9, 1 - (2 * m) / W);
    const pad = (r - (x1 - x0)) / 2 || 0.5;
    x0 -= pad;
    x1 += pad;
  } else [x0, x1] = enlarge(x0, x1, o.enlargeX, o.xmin !== undefined, o.xmax !== undefined);
  if (barPlots.some((p) => p.bar === "x") && o.enlargeY === undefined && o.ymin === undefined && o.ymax === undefined) {
    const m = groupW / 2 + o.barWidth;
    const r = (y1 - y0) / Math.max(1e-9, 1 - (2 * m) / H);
    const pad = (r - (y1 - y0)) / 2 || 0.5;
    y0 -= pad;
    y1 += pad;
  } else [y0, y1] = enlarge(y0, y1, o.enlargeY, o.ymin !== undefined, o.ymax !== undefined);
  // Bars standing on zero keep their base on the axis.
  if (barPlots.some((p) => p.bar === "y") && o.ymin === undefined && y0 < 0 && plots.every((p) => p.pts.every(([, y]) => Number.isNaN(y) || y >= 0))) y0 = 0;
  if (barPlots.some((p) => p.bar === "x") && o.xmin === undefined && x0 < 0 && plots.every((p) => p.pts.every(([x]) => Number.isNaN(x) || x >= 0))) x0 = 0;

  // Placement of the axis in the picture.
  let origin: Pt = [g0.T[4], g0.T[5]];
  if (o.at) {
    const c = it.coord(o.at.trim().replace(/^\(([^]*)\)$/, "$1"), g0);
    if (c) origin = c.p;
  }
  if (o.anchor) {
    const a = o.anchor.trim().replace(/^outer /, "");
    const box = { name: "", center: [W / 2, H / 2] as Pt, shape: "rectangle", hw: W / 2, hh: H / 2, rot: 0, baseDy: 0 };
    const pt = anchorPoint(box, a);
    origin = [origin[0] - pt[0], origin[1] - pt[1]];
  }
  const sx = (x: number) => origin[0] + (o.xdirReverse ? (x1 - x) : (x - x0)) / (x1 - x0) * W;
  const sy = (y: number) => origin[1] + (o.ydirReverse ? (y1 - y) : (y - y0)) / (y1 - y0) * H;
  const map = (x: number, y: number): Pt => [sx(tx(x)), sy(ty(y))];
  if (o.name) it.nodes.set(o.name, { name: o.name, center: [origin[0] + W / 2, origin[1] + H / 2], shape: "rectangle", hw: W / 2, hh: H / 2, rot: 0, baseDy: 0 });

  const ink = "#000000";
  const gridColor = "#bfbfbf";
  const scene = it.scene;
  const layer = g0.layer;
  const lineStyle = (color: string, lw: number) => ({ stroke: color, lineWidth: lw });

  // Ticks.
  const xticks: number[] = o.xtick === "none" ? [] : o.xtick === "data" ? [...new Set(plots.flatMap((p) => p.pts.map(([x]) => tx(x))).filter(Number.isFinite))].sort((a, b) => a - b) : o.xtick ? o.xtick.map(tx) : o.xsym ? o.xsym.map((_, i) => i).filter((v) => v >= x0 - 1e-9 && v <= x1 + 1e-9) : ticksFor(x0, x1, W, o.xlog, o.xtickDistance);
  const yticks: number[] = o.ytick === "none" ? [] : o.ytick === "data" ? [...new Set(plots.flatMap((p) => p.pts.map(([, y]) => ty(y))).filter(Number.isFinite))].sort((a, b) => a - b) : o.ytick ? o.ytick.map(ty) : o.ysym ? o.ysym.map((_, i) => i).filter((v) => v >= y0 - 1e-9 && v <= y1 + 1e-9) : ticksFor(y0, y1, H, o.ylog, o.ytickDistance);
  const inX = (v: number) => v >= Math.min(x0, x1) - 1e-9 && v <= Math.max(x0, x1) + 1e-9;
  const inY = (v: number) => v >= Math.min(y0, y1) - 1e-9 && v <= Math.max(y0, y1) + 1e-9;
  const xt = [...xticks.filter(inX), ...o.extraXTicks.map(tx).filter(inX)];
  const yt = [...yticks.filter(inY), ...o.extraYTicks.map(ty).filter(inY)];
  // Scaled ticks: a common power of ten printed once.
  const scaleOf = (ts: number[], log: boolean, explicit: boolean): number => {
    if (log || explicit || !o.scaledTicks || !ts.length) return 0;
    const m = Math.max(...ts.map(Math.abs));
    if (m >= 1e5) return Math.floor(Math.log10(m));
    if (m > 0 && m < 1e-3) return Math.floor(Math.log10(m));
    return 0;
  };
  const xScale = scaleOf(xt, o.xlog, !!o.xticklabels || !!o.xsym);
  const yScale = scaleOf(yt, o.ylog, !!o.yticklabels || !!o.ysym);

  // Grid.
  const gridX = o.xgrid ?? (o.grid === "major" || o.grid === "both");
  const gridY = o.ygrid ?? (o.grid === "major" || o.grid === "both");
  const gridSegs: Seg[] = [];
  if (gridX) for (const v of xt) gridSegs.push({ t: "M", p: [sx(v), origin[1]] }, { t: "L", p: [sx(v), origin[1] + H] });
  if (gridY) for (const v of yt) gridSegs.push({ t: "M", p: [origin[0], sy(v)] }, { t: "L", p: [origin[0] + W, sy(v)] });
  if (o.grid === "minor" || o.grid === "both") {
    const minor: Seg[] = [];
    const k = o.minorTicks || 4;
    const addMinor = (ts: number[], horiz: boolean) => {
      for (let i = 0; i + 1 < ts.length; i++) {
        for (let j = 1; j <= k; j++) {
          const v = ts[i] + ((ts[i + 1] - ts[i]) * j) / (k + 1);
          if (horiz) minor.push({ t: "M", p: [sx(v), origin[1]] }, { t: "L", p: [sx(v), origin[1] + H] });
          else minor.push({ t: "M", p: [origin[0], sy(v)] }, { t: "L", p: [origin[0] + W, sy(v)] });
        }
      }
    };
    addMinor(xt, true);
    addMinor(yt, false);
    scene.path(minor, lineStyle("#e3e3e3", 0.2), g0.clips, layer);
  }
  if (gridSegs.length) scene.path(gridSegs, lineStyle(gridColor, 0.2), g0.clips, layer);

  // Plots, clipped to the box.
  const boxSegs: Seg[] = [
    { t: "M", p: [origin[0], origin[1]] },
    { t: "L", p: [origin[0] + W, origin[1]] },
    { t: "L", p: [origin[0] + W, origin[1] + H] },
    { t: "L", p: [origin[0], origin[1] + H] },
    { t: "Z" },
  ];
  const clip = o.clip ? scene.clipPath(boxSegs) : undefined;
  const plotClips = clip ? [...g0.clips, clip] : g0.clips;
  const barIndex = new Map<Plot, number>();
  barPlots.forEach((p, i) => barIndex.set(p, o.stacked ? 0 : i));
  const baseY = o.ylog ? y0 : Math.max(Math.min(0, y1), y0);
  const baseX = o.xlog ? x0 : Math.max(Math.min(0, x1), x0);
  const nearLabels: { at: Pt; text: string; anchor: string; g: GS }[] = [];
  drawFills(it, plots, tikz, [x0, x1, y0, y1], map, plotClips, layer);
  for (const p of plots) {
    if (p.fill) continue;
    it.tick(p.pts.length);
    const g = cloneGS(p.g);
    g.clips = plotClips;
    g.layer = layer;
    if (p.bar) {
      const k = barIndex.get(p) ?? 0;
      const shift = (k - (nBars - 1) / 2) * (o.barWidth + o.barGap);
      const segs: Seg[] = [];
      p.pts.forEach(([x, y], i) => {
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        let prevStack = 0;
        if (o.stacked) {
          // The bar starts where the previous series ended.
          const prevPlot = barPlots[barPlots.indexOf(p) - 1];
          const q = prevPlot?.pts[i];
          prevStack = q ? (p.bar === "x" ? q[0] : q[1]) : 0;
        }
        if (p.bar === "y") {
          const cx = sx(tx(x)) + shift;
          const top = sy(ty(y));
          const bottom = o.stacked && prevStack ? sy(ty(prevStack)) : sy(baseY);
          segs.push({ t: "M", p: [cx - o.barWidth / 2, bottom] }, { t: "L", p: [cx + o.barWidth / 2, bottom] }, { t: "L", p: [cx + o.barWidth / 2, top] }, { t: "L", p: [cx - o.barWidth / 2, top] }, { t: "Z" });
          if (p.nearCoords) nearLabels.push({ at: [cx, top], text: tickLabel(o.stacked ? y - prevStack : y, 0), anchor: y >= 0 ? "south" : "north", g });
        } else {
          const cy = sy(ty(y)) + shift;
          const right = sx(tx(x));
          const left = o.stacked && prevStack ? sx(tx(prevStack)) : sx(baseX);
          segs.push({ t: "M", p: [left, cy - o.barWidth / 2] }, { t: "L", p: [right, cy - o.barWidth / 2] }, { t: "L", p: [right, cy + o.barWidth / 2] }, { t: "L", p: [left, cy + o.barWidth / 2] }, { t: "Z" });
          if (p.nearCoords) nearLabels.push({ at: [right, cy], text: tickLabel(o.stacked ? x - prevStack : x, 0), anchor: x >= 0 ? "west" : "east", g });
        }
      });
      if (segs.length) {
        scene.path(segs, it.paint(g, g.doDraw, true), plotClips, layer);
        it.drawn++;
      }
      continue;
    }
    // Lines, broken at undefined points.
    const runs: Pt[][] = [[]];
    for (const [x, y] of p.pts) {
      const X = tx(x);
      const Y = ty(y);
      if (!Number.isFinite(X) || !Number.isFinite(Y)) {
        if (runs[runs.length - 1].length) runs.push([]);
        continue;
      }
      runs[runs.length - 1].push([sx(X), sy(Y)]);
    }
    const allPts = runs.flat();
    if (!g.onlyMarks) {
      const segs: Seg[] = [];
      for (const run of runs) {
        if (!run.length) continue;
        let pts = run;
        if (g.plotKind === "const") {
          pts = [];
          run.forEach((q, i) => {
            if (i > 0) pts.push([q[0], run[i - 1][1]]);
            pts.push(q);
          });
        }
        if (g.plotKind === "ycomb") {
          for (const q of run) segs.push({ t: "M", p: [q[0], sy(baseY)] }, { t: "L", p: q });
          continue;
        }
        segs.push({ t: "M", p: pts[0] });
        if (p.smooth && pts.length > 2) for (const s of smoothThrough(pts, false, g.tension)) segs.push({ t: "C", ...s });
        else for (const q of pts.slice(1)) segs.push({ t: "L", p: q });
        if (p.closed) {
          segs.push({ t: "L", p: [pts[pts.length - 1][0], sy(baseY)] }, { t: "L", p: [pts[0][0], sy(baseY)] }, { t: "Z" });
        }
      }
      if (segs.length) {
        if (p.closed) {
          const fillG = cloneGS(g);
          it.strokeWithArrows(segs, fillG, fillG.doFill);
        } else it.strokeWithArrows(segs, g, g.doFill);
      }
    }
    if (g.mark || g.onlyMarks) {
      const mg = cloneGS(g);
      if (!mg.mark) mg.mark = "*";
      mg.clips = g0.clips;
      drawMarks(it, allPts.filter((q) => q[0] >= origin[0] - 1 && q[0] <= origin[0] + W + 1 && q[1] >= origin[1] - 1 && q[1] <= origin[1] + H + 1), mg);
    }
    if (p.nearCoords) for (const [x, y] of p.pts) if (Number.isFinite(x) && Number.isFinite(y)) nearLabels.push({ at: map(x, y), text: tickLabel(y, 0), anchor: "south", g });
  }

  // Axis lines and ticks.
  const tickLen = 0.15 * CM;
  const axisSegs: Seg[] = [];
  const tickSegs: Seg[] = [];
  const crossX = o.axisLines === "middle" ? sy(Math.max(Math.min(o.ylog ? y0 : 0, y1), y0)) : origin[1];
  const crossY = o.axisLines === "middle" ? sx(Math.max(Math.min(o.xlog ? x0 : 0, x1), x0)) : origin[0];
  if (o.axisLines === "box") {
    axisSegs.push(...boxSegs);
    if (!o.hideX)
      for (const v of xt) {
        tickSegs.push({ t: "M", p: [sx(v), origin[1]] }, { t: "L", p: [sx(v), origin[1] + tickLen] });
        tickSegs.push({ t: "M", p: [sx(v), origin[1] + H] }, { t: "L", p: [sx(v), origin[1] + H - tickLen] });
      }
    if (!o.hideY)
      for (const v of yt) {
        tickSegs.push({ t: "M", p: [origin[0], sy(v)] }, { t: "L", p: [origin[0] + tickLen, sy(v)] });
        tickSegs.push({ t: "M", p: [origin[0] + W, sy(v)] }, { t: "L", p: [origin[0] + W - tickLen, sy(v)] });
      }
  } else if (o.axisLines !== "none") {
    const ext = o.axisArrows ? 0.25 * CM : 0;
    const xLine: Seg[] = [
      { t: "M", p: [origin[0], crossX] },
      { t: "L", p: [origin[0] + W + ext, crossX] },
    ];
    const yLine: Seg[] = [
      { t: "M", p: [crossY, origin[1]] },
      { t: "L", p: [crossY, origin[1] + H + ext] },
    ];
    const lg = cloneGS(g0);
    lg.doDraw = true;
    lg.lw = 0.4;
    lg.color = ink;
    lg.drawColor = undefined;
    lg.dash = undefined;
    lg.arrows = o.axisArrows ? { start: [], end: [{ kind: "stealth" }] } : undefined;
    if (!o.hideX) it.strokeWithArrows(xLine, lg);
    if (!o.hideY) it.strokeWithArrows(yLine, lg);
    if (!o.hideX) for (const v of xt) tickSegs.push({ t: "M", p: [sx(v), crossX - tickLen / 2] }, { t: "L", p: [sx(v), crossX + tickLen / 2] });
    if (!o.hideY) for (const v of yt) tickSegs.push({ t: "M", p: [crossY - tickLen / 2, sy(v)] }, { t: "L", p: [crossY + tickLen / 2, sy(v)] });
  }
  if (axisSegs.length) scene.path(axisSegs, lineStyle(ink, 0.4), g0.clips, layer);
  if (tickSegs.length) scene.path(tickSegs, lineStyle(ink, 0.4), g0.clips, layer);
  it.drawn++;

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
  const labelNode = (text: string, at: Pt, anchor: string, g: GS, rotate = 0): { box: [number, number, number, number] } | undefined => {
    const lg = cloneGS(g);
    lg.anchor = anchor;
    lg.nrot = rotate;
    const n = it.node({ text, g: lg, off, onNext: false }, { point: at }, g0);
    if (!n) return undefined;
    // Rotated nodes: a generous box.
    const r = Math.max(n.hw, n.hh);
    return rotate ? { box: [n.center[0] - r, n.center[1] - r, n.center[0] + r, n.center[1] + r] } : { box: [n.center[0] - n.hw, n.center[1] - n.hh, n.center[0] + n.hw, n.center[1] + n.hh] };
  };
  const tickG = fontG(o.tickFont);
  let xLabelBottom = o.axisLines === "middle" ? crossX : origin[1];
  let yLabelLeft = o.axisLines === "middle" ? crossY : origin[0];
  const hideOrigin = o.axisLines === "middle";
  if (!o.hideX && o.axisLines !== "none") {
    xt.forEach((v, i) => {
      if (hideOrigin && Math.abs(v) < 1e-12 && !o.xlog && crossY === sx(0)) return;
      let text: string;
      if (o.xticklabels) text = o.xticklabels[i] ?? "";
      else if (o.xsym) text = o.xsym[Math.round(v)] ?? "";
      else if (o.xlog) text = `$10^{${fmt(v)}}$`;
      else text = tickLabel(v, xScale);
      if (!text) return;
      const anchor = o.xtickAnchor ?? (o.xtickRotate ? (o.xtickRotate > 0 ? "east" : "west") : "north");
      const r = labelNode(text, [sx(v), (o.axisLines === "middle" ? crossX : origin[1]) - (o.axisLines === "box" ? 0 : tickLen / 2)], anchor, tickG, o.xtickRotate);
      if (r) xLabelBottom = Math.min(xLabelBottom, r.box[1]);
    });
  }
  if (!o.hideY && o.axisLines !== "none") {
    yt.forEach((v, i) => {
      if (hideOrigin && Math.abs(v) < 1e-12 && !o.ylog && crossX === sy(0)) return;
      let text: string;
      if (o.yticklabels) text = o.yticklabels[i] ?? "";
      else if (o.ysym) text = o.ysym[Math.round(v)] ?? "";
      else if (o.ylog) text = `$10^{${fmt(v)}}$`;
      else text = tickLabel(v, yScale);
      if (!text) return;
      const r = labelNode(text, [(o.axisLines === "middle" ? crossY : origin[0]) - (o.axisLines === "box" ? 0 : tickLen / 2), sy(v)], "east", tickG, o.ytickRotate);
      if (r) yLabelLeft = Math.min(yLabelLeft, r.box[0]);
    });
  }
  if (xScale) labelNode(`$\\cdot 10^{${xScale}}$`, [origin[0] + W, xLabelBottom], "north east", tickG);
  if (yScale) labelNode(`$\\cdot 10^{${yScale}}$`, [origin[0], origin[1] + H], "south west", tickG);

  // Labels and title.
  const labG = fontG(o.labelFont);
  if (o.axisLines === "middle" || (o.axisLines === "left" && o.axisArrows && false)) {
    if (o.xlabel) labelNode(o.xlabel, [origin[0] + W + 0.25 * CM, crossX], "west", labG);
    if (o.ylabel) labelNode(o.ylabel, [crossY, origin[1] + H + 0.25 * CM], "south", labG);
  } else {
    if (o.xlabel) labelNode(o.xlabel, [origin[0] + W / 2, xLabelBottom], "north", labG);
    if (o.ylabel) labelNode(o.ylabel, [yLabelLeft, origin[1] + H / 2], "south", labG, 90);
  }
  if (o.title) labelNode(o.title, [origin[0] + W / 2, origin[1] + H + (o.axisLines === "middle" ? 0.4 * CM : 0)], "south", labG);

  // Nodes near coords.
  for (const nl of nearLabels) {
    const g = fontG(o.tickFont);
    g.color = ink;
    labelNode(nl.text, nl.at, nl.anchor, g);
  }

  // Legend.
  const entries: { plot: Plot; text: string }[] = [];
  const visible = plots.filter((p) => !p.forget);
  visible.forEach((p, i) => {
    const t = o.legendEntries[i] ?? p.legend;
    if (t !== undefined && t !== "") entries.push({ plot: p, text: t });
  });
  if (entries.length) drawLegend(it, o, entries, origin, W, H, g0, off, fontG(o.legendFont));

  // TikZ statements inside the axis, in axis coordinates.
  const axisMap: AxisMap = {
    map: (x, y) => [map(x, y)[0] - g0.T[4], map(x, y)[1] - g0.T[5]],
    rel: (x, y) => [origin[0] + x * W - g0.T[4], origin[1] + y * H - g0.T[5]],
    ...(o.xsym ? { xsym: new Map(o.xsym.map((s, i) => [s, i])) } : {}),
    ...(o.ysym ? { ysym: new Map(o.ysym.map((s, i) => [s, i])) } : {}),
  };
  const tg = cloneGS(g0);
  tg.T = [1, 0, 0, 1, g0.T[4], g0.T[5]];
  tg.axis = axisMap;
  for (const t of tikz) {
    try {
      it.run(t.text, t.off, false, tg);
    } catch (e) {
      if (e instanceof Stop) throw e;
    }
  }
}

export function drawLegend(it: Interp, o: AxisOpts, entries: { plot: Plot; text: string }[], origin: Pt, W: number, H: number, g0: GS, off: number, textG: GS): void {
  const cols = Math.min(o.legendCols, entries.length);
  const rows = Math.ceil(entries.length / cols);
  const imgW = 0.6 * CM;
  const pad = 2.5;
  const gap = 3;
  // Measure entries by laying them out off to the side, then place them for real.
  const sizes = entries.map((e) => {
    const lg = cloneGS(textG);
    lg.ix = lg.iy = 1.5;
    const probe = new Map(it.nodes);
    const n = measureNode(it, e.text, lg);
    it.nodes.clear();
    for (const [k, v] of probe) it.nodes.set(k, v);
    return n;
  });
  const colW: number[] = new Array(cols).fill(0);
  sizes.forEach((s, i) => (colW[i % cols] = Math.max(colW[i % cols], s.w)));
  const rowH = Math.max(...sizes.map((s) => s.h), 8);
  const cellW = colW.map((w) => imgW + gap + w);
  const totalW = cellW.reduce((a, b) => a + b, 0) + (cols - 1) * 6 + 2 * pad;
  const totalH = rows * rowH + 2 * pad;
  // Position.
  const rel: Record<string, [[number, number], string]> = {
    "north east": [[0.98, 0.98], "north east"],
    "north west": [[0.02, 0.98], "north west"],
    "south east": [[0.98, 0.02], "south east"],
    "south west": [[0.02, 0.02], "south west"],
    "outer north east": [[1.03, 1], "north west"],
  };
  const [at, anchor] = o.legendAt ? [o.legendAt, o.legendAnchor ?? "south west"] : (rel[o.legendPos] ?? rel["north east"]);
  const ap: Pt = [origin[0] + at[0] * W, origin[1] + at[1] * H];
  const box = { name: "", center: [0, 0] as Pt, shape: "rectangle", hw: totalW / 2, hh: totalH / 2, rot: 0, baseDy: 0 };
  const a = anchorPoint(box, o.legendAnchor ?? anchor);
  const center: Pt = [ap[0] - a[0], ap[1] - a[1]];
  const left = center[0] - totalW / 2;
  const top = center[1] + totalH / 2;
  const rect: Seg[] = [
    { t: "M", p: [left, top - totalH] },
    { t: "L", p: [left + totalW, top - totalH] },
    { t: "L", p: [left + totalW, top] },
    { t: "L", p: [left, top] },
    { t: "Z" },
  ];
  it.scene.path(rect, { fill: "#ffffff", ...(o.legendDraw ? { stroke: "#000000" } : {}), lineWidth: 0.4 }, g0.clips, g0.layer);
  entries.forEach((e, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = left + pad + cellW.slice(0, c).reduce((s, v) => s + v + 6, 0);
    const y = top - pad - r * rowH - rowH / 2;
    const g = cloneGS(e.plot.g);
    g.clips = g0.clips;
    g.layer = g0.layer;
    g.arrows = undefined;
    if (e.plot.bar || e.plot.fill) {
      const h = Math.min(rowH * 0.7, 6);
      const segs: Seg[] = [
        { t: "M", p: [x + imgW * 0.3, y - h / 2] },
        { t: "L", p: [x + imgW * 0.7, y - h / 2] },
        { t: "L", p: [x + imgW * 0.7, y + h / 2] },
        { t: "L", p: [x + imgW * 0.3, y + h / 2] },
        { t: "Z" },
      ];
      it.scene.path(segs, it.paint(g, g.doDraw, true), g.clips, g.layer);
    } else {
      if (!g.onlyMarks) it.scene.path([{ t: "M", p: [x, y] }, { t: "L", p: [x + imgW, y] }], it.paint(g, true, false), g.clips, g.layer);
      if (g.mark || g.onlyMarks) drawMarks(it, [[x + imgW / 2, y]], g.mark ? g : { ...g, mark: "*" });
    }
    const tg = cloneGS(textG);
    tg.ix = tg.iy = 1.5;
    tg.anchor = "west";
    it.node({ text: e.text, g: tg, off, onNext: false }, { point: add([x + imgW + gap - 1.5, y], [0, 0]) }, g0);
  });
}

/**
 * fill between[of=A and B]: the region between two named paths (plots with
 * name path, or \path[name path=...] (axis cs:a,b) -- (axis cs:c,d) lines),
 * soft-clipped to an x range. Drawn before the plots, as pgfplots puts it on
 * the layer under them.
 */
function drawFills(it: Interp, plots: Plot[], tikz: { text: string; off: number }[], lim: [number, number, number, number], map: (x: number, y: number) => Pt, clips: string[], layer: number): void {
  if (!plots.some((p) => p.fill)) return;
  const named = new Map<string, [number, number][]>();
  for (const p of plots) if (p.name) named.set(p.name, p.pts);
  const limits: Record<string, number> = { xmin: lim[0], xmax: lim[1], ymin: lim[2], ymax: lim[3] };
  for (const t of tikz) {
    const m = /^\s*\\(?:path|draw)\b[^;]*?name path(?: global)?\s*=\s*\{?([^,\]}]+)/.exec(t.text);
    if (!m) continue;
    const pts: [number, number][] = [];
    for (const c of t.text.matchAll(/\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const body = c[1]
        .replace(/^\s*axis cs\s*:/, "")
        .replace(/\\pgfkeysvalueof\{\/pgfplots\/(xmin|xmax|ymin|ymax)\}/g, (_x, k: string) => `(${limits[k]})`);
      const parts = splitTop(body, ",");
      if (parts.length !== 2) continue;
      const x = num(parts[0]);
      const y = num(parts[1]);
      if (x !== undefined && y !== undefined) pts.push([x, y]);
    }
    if (pts.length >= 2) named.set(m[1].trim(), pts);
  }
  for (const p of plots) {
    if (!p.fill) continue;
    const A = named.get(p.fill.a);
    const B = named.get(p.fill.b);
    if (!A || !B) {
      it.warnOnce(`fill:${p.fill.a}:${p.fill.b}`, `fill between: no path named ${!A ? p.fill.a : p.fill.b}`, "Give the plot name path=... before the fill between");
      continue;
    }
    const poly = [...clipToX(A, p.fill.clip), ...clipToX(B, p.fill.clip).reverse()].map(([x, y]) => map(x, y)).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
    if (poly.length < 3) continue;
    const segs: Seg[] = poly.map((q, i) => ({ t: i ? "L" : "M", p: q }) as Seg);
    segs.push({ t: "Z" });
    const g = cloneGS(p.g);
    it.scene.path(segs, it.paint(g, g.doDraw, true), clips, layer);
    it.drawn++;
  }
}

/** The part of a polyline with x in [a, b], cut at the crossings. */
export function clipToX(pts: [number, number][], clip?: [number, number]): [number, number][] {
  const q = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!clip) return q;
  const [a, b] = clip;
  const out: [number, number][] = [];
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    if (i > 0) {
      const r = q[i - 1];
      const cuts: [number, number][] = [];
      for (const e of [a, b]) {
        if ((r[0] - e) * (p[0] - e) < 0) {
          const t = (e - r[0]) / (p[0] - r[0]);
          cuts.push([t, r[1] + (p[1] - r[1]) * t]);
        }
      }
      cuts.sort((u, v) => u[0] - v[0]);
      for (const [t, y] of cuts) out.push([r[0] + (p[0] - r[0]) * t, y]);
    }
    if (p[0] >= a && p[0] <= b) out.push(p);
  }
  return out;
}

/** The size a node's text would take, without drawing it. */
function measureNode(it: Interp, text: string, g: GS): { w: number; h: number } {
  const before = it.scene.items.length;
  const n = it.node({ text, g: cloneGS(g), off: it.off, onNext: false }, { point: [-1e6, -1e6] }, g);
  it.scene.items.length = before;
  return { w: n ? 2 * n.hw : 0, h: n ? 2 * n.hh : 0 };
}

export { matchClose, findEnd, apply, parseColor };
