/**
 * TikZ options: what each key does to the graphic state. Styles defined
 * with /.style are expanded where they are used (with #1 for an argument);
 * colour names and arrow specs are keys too. Keys texwright does not know
 * are reported once each and otherwise ignored.
 */

import { parseArrowSpec, parseTip } from "./arrows.js";
import { type RGB, isColorName, parseColor } from "./color.js";
import { evaluate, length, num } from "./expr.js";
import { type Mat, type Pt, mul, rotation } from "./geom.js";
import { parseOptions, splitTop, unbrace } from "./scan.js";
import type { Shade } from "./scene.js";
import { CM, type GS, type LabelSpec } from "./state.js";
import { applyFont } from "./text.js";

export interface OptionHost {
  /** Reports an option texwright does not handle (once per key). */
  unknown(key: string): void;
  warn(message: string): void;
  colors: Map<string, RGB>;
  lookup?: (name: string) => string | undefined;
  /** A coordinate in the picture as an offset (for shift={(1,2)}). */
  coordOffset(text: string, g: GS): Pt | undefined;
  /** Extra keys a caller (pgfplots) handles; true when consumed. */
  extra?: (key: string, value: string | undefined, g: GS) => boolean;
}

export type Ctx = "scope" | "path" | "node";

const WIDTHS: Record<string, number> = {
  "ultra thin": 0.1,
  "very thin": 0.2,
  thin: 0.4,
  semithick: 0.6,
  thick: 0.8,
  "very thick": 1.2,
  "ultra thick": 1.6,
};

const DASHES = new Set(["dashed", "densely dashed", "loosely dashed", "dotted", "densely dotted", "loosely dotted", "dash dot", "densely dash dot", "loosely dash dot", "dash dot dot", "densely dash dot dot", "loosely dash dot dot", "solid"]);

export const DIRECTIONS = new Set(["above", "below", "left", "right", "above left", "above right", "below left", "below right"]);

const SHAPES = new Set(["rectangle", "circle", "ellipse", "diamond", "coordinate", "rounded rectangle", "regular polygon", "star", "trapezium", "cylinder", "circle split", "rectangle split", "semicircle", "isosceles triangle", "kite", "dart", "cloud", "signal", "single arrow", "double arrow", "tape", "magnetic tape", "cross out", "strike out", "forbidden sign", "chamfered rectangle", "starburst", "circular sector", "rectangle callout", "ellipse callout", "cloud callout", "correct forbidden sign", "partial ellipse", "state", "shape"]);

/** Keys that only matter to features texwright draws without them, accepted silently. */
const QUIET = new Set([
  "baseline",
  "remember picture",
  "overlay",
  "transform canvas",
  "inner frame sep",
  "execute at begin node",
  "execute at end node",
  "node font",
  "line join",
  "miter limit",
  "trim left",
  "trim right",
  "name path",
  "name path global",
  "name intersections",
  "on grid",
  "every to",
  "level distance",
  "sibling distance",
  "level",
  "grow",
  "edge from parent",
  "anchor base",
  "text height",
  "text depth",
  "outer xsep",
  "outer ysep",
  "font size",
  "inner frame xsep",
  "inner frame ysep",
  "growth parent anchor",
  "spy using outlines",
  "mark phase",
  "mark repeat",
  "mark indices",
  "text centered",
  "text badly centered",
  "text ragged",
  "text justified",
  "text badly ragged",
  "preaction",
  "pattern color",
  "shading angle",
  "path picture",
  "label position",
  "fill between",
  "on background layer",
  "behind path",
  "in front of path",
  "pin position",
  "minimum height",
  "nodes near coords",
  "arrows.meta",
  "every node/.style",
  "line cap",
  "bend angle",
  "looseness",
  "decoration",
  "decorate",
  "postaction",
  "matrix",
  "matrix of nodes",
  "matrix of math nodes",
  "row sep",
  "column sep",
  "nodes",
  "ampersand replacement",
  "every outer matrix",
  "cells",
  "isosceles triangle apex angle",
  "shape border rotate",
  "shape border uses incircle",
  "regular polygon sides",
  "star points",
  "star point ratio",
  "trapezium left angle",
  "trapezium right angle",
  "trapezium angle",
  "aspect",
  "cylinder uses custom fill",
  "shape aspect",
  "rectangle split parts",
  "rectangle split horizontal",
  "rectangle split part fill",
  "circle split part fill",
  "rounded rectangle arc length",
  "chamfered rectangle corners",
  "fill opacity",
  "anchor",
  "minimum width",
  "align",
  "angle radius",
  "angle eccentricity",
  "pic text",
  "pic text options",
  "double distance",
  "double equal sign distance",
  "initial distance",
  "accepting distance",
]);

export function dashPattern(g: GS): number[] | undefined {
  if (g.dashPattern) return g.dashPattern;
  const lw = g.lw;
  switch (g.dash) {
    case "dashed":
      return [3, 3];
    case "densely dashed":
      return [3, 2];
    case "loosely dashed":
      return [3, 6];
    case "dotted":
      return [lw, 2];
    case "densely dotted":
      return [lw, 1];
    case "loosely dotted":
      return [lw, 4];
    case "dash dot":
      return [3, 2, lw, 2];
    case "densely dash dot":
      return [3, 1, lw, 1];
    case "loosely dash dot":
      return [3, 4, lw, 4];
    case "dash dot dot":
      return [3, 2, lw, 2, lw, 2];
    case "densely dash dot dot":
      return [3, 1, lw, 1, lw, 1];
    case "loosely dash dot dot":
      return [3, 4, lw, 4, lw, 4];
    default:
      return undefined;
  }
}

const MAX_STYLE_DEPTH = 24;

/** Applies an option list to `g`. */
/** Style expansions within one top-level option list (styles that use each other can multiply). */
let expansions = 0;
const MAX_EXPANSIONS = 2000;

export function applyOptions(g: GS, opts: string | undefined, ctx: Ctx, host: OptionHost, depth = 0): void {
  if (!opts || depth > MAX_STYLE_DEPTH) return;
  if (depth === 0) expansions = 0;
  for (const { key, value } of parseOptions(opts)) applyKey(g, key, value, ctx, host, depth);
}

function dim(value: string | undefined, unit = 1): number | undefined {
  return value === undefined ? undefined : length(value, unit);
}

function setColor(g: GS, value: string, host: OptionHost): string | undefined {
  return parseColor(value, host.colors, host.lookup, g.color);
}

function applyTransform(g: GS, m: Mat): void {
  g.T = mul(g.T, m);
}

export function applyKey(g: GS, rawKey: string, value: string | undefined, ctx: Ctx, host: OptionHost, depth: number): void {
  let key = rawKey.replace(/^\/(tikz|pgfplots|pgf)\//, "").trim();
  if (!key) return;
  // Style definitions.
  const def = /^(.*?)\/\.(style|append style|prefix style|default|estyle|code|style 2 args|style n args|add code|list|is choice|initial)$/.exec(key);
  if (def) {
    const name = def[1].replace(/^\/(tikz|pgfplots|pgf)\//, "").trim();
    const kind = def[2];
    const map = new Map(g.styles);
    const old = map.get(name);
    if (kind === "style" || kind === "estyle") map.set(name, { body: value ?? "", ...(old?.default !== undefined ? { default: old.default } : {}) });
    else if (kind === "append style") map.set(name, { body: old?.body ? `${old.body}, ${value ?? ""}` : (value ?? ""), ...(old?.default !== undefined ? { default: old.default } : {}) });
    else if (kind === "prefix style") map.set(name, { body: old?.body ? `${value ?? ""}, ${old.body}` : (value ?? ""), ...(old?.default !== undefined ? { default: old.default } : {}) });
    else if (kind === "default") map.set(name, { body: old?.body ?? "", default: value ?? "" });
    else if (kind === "style 2 args" || kind === "style n args") map.set(name, { body: value ?? "" });
    g.styles = map;
    return;
  }
  // A style used by name.
  const st = g.styles.get(key);
  if (st) {
    if (++expansions > MAX_EXPANSIONS) {
      if (expansions === MAX_EXPANSIONS + 1) host.warn(`styles expand into each other too often (at "${key}"); the rest were ignored`);
      return;
    }
    const arg = value ?? st.default ?? "";
    applyOptions(g, st.body.replace(/#1/g, arg), ctx, host, depth + 1);
    if (key === "state" && ctx !== "node") g.shape = "circle";
    return;
  }
  if (key.startsWith("every ") || key.endsWith(" style")) {
    // every foo/.style used as a key, or xlabel style=... for pgfplots: handled by its owner or ignored.
    if (host.extra?.(key, value, g)) return;
    return;
  }
  if (host.extra?.(key, value, g)) return;
  // Quoted labels (quotes library) on edges: "text" or "text"'.
  if (key.startsWith('"')) {
    const m = /^"([^"]*)"\s*('?)\s*(.*)$/.exec(key + (value !== undefined ? `=${value}` : ""));
    if (m) g.labels.push({ pin: false, opts: `${m[2] ? "swap," : ""}${m[3]}`, angle: "quote", text: m[1] });
    return;
  }
  const v = value;
  switch (key) {
    case "draw":
      if (v === "none") {
        g.doDraw = false;
        g.drawColor = null;
      } else {
        g.doDraw = true;
        if (v) g.drawColor = setColor(g, v, host) ?? g.drawColor;
      }
      return;
    case "fill":
      if (v === "none") {
        g.doFill = false;
        g.fillColor = null;
      } else {
        g.doFill = true;
        if (v) g.fillColor = setColor(g, v, host) ?? g.fillColor;
      }
      return;
    case "color": {
      const c = v ? setColor(g, v, host) : undefined;
      if (c) {
        g.color = c;
        g.drawColor = undefined;
        g.fillColor = g.fillColor === null ? null : undefined;
        g.textColor = undefined;
      }
      return;
    }
    case "text":
    case "text color":
    case "font color": {
      const c = v ? setColor(g, v, host) : undefined;
      if (c) g.textColor = c;
      return;
    }
    case "line width":
      g.lw = dim(v) ?? g.lw;
      return;
    case "dash pattern": {
      const parts = [...(v ?? "").matchAll(/(on|off)\s*([^\s]+(?:\s*pt|\s*mm|\s*cm)?)/g)].map((m) => length(m[2].replace(/\\pgflinewidth/, `${g.lw}pt`), 1) ?? 0);
      if (parts.length) g.dashPattern = parts;
      return;
    }
    case "dash phase":
    case "dash offset":
      g.dashOffset = dim(v) ?? 0;
      return;
    case "dash":
      g.dash = "dashed";
      return;
    case "solid":
      g.dash = undefined;
      g.dashPattern = undefined;
      return;
    case "rounded corners":
      g.rounded = v !== undefined ? (dim(v) ?? 4) : 4;
      return;
    case "sharp corners":
      g.rounded = 0;
      return;
    case "line cap":
      if (v === "round" || v === "butt" || v === "rect") g.cap = v === "rect" ? "square" : v;
      return;
    case "line join":
      if (v === "round" || v === "miter" || v === "bevel") g.join = v;
      return;
    case "opacity":
      g.opacity = num(v ?? "1") ?? 1;
      g.drawOpacity = g.fillOpacity = g.textOpacity = undefined;
      return;
    case "draw opacity":
      g.drawOpacity = num(v ?? "1");
      return;
    case "fill opacity":
      g.fillOpacity = num(v ?? "1");
      return;
    case "text opacity":
      g.textOpacity = num(v ?? "1");
      return;
    case "transparent":
      g.opacity = 0;
      return;
    case "semitransparent":
      g.opacity = 0.5;
      return;
    case "nearly transparent":
      g.opacity = 0.25;
      return;
    case "nearly opaque":
      g.opacity = 0.75;
      return;
    case "even odd rule":
      g.evenOdd = true;
      return;
    case "nonzero rule":
      g.evenOdd = false;
      return;
    case "double":
      g.double = v ? (setColor(g, v, host) ?? "#ffffff") : "#ffffff";
      return;
    case "double distance":
      g.doubleDist = dim(v) ?? 0.6;
      return;
    case "arrows":
      if (v) applyKey(g, v, undefined, ctx, host, depth + 1);
      return;
    case ">":
      if (v) {
        const t = parseTip(v);
        if (t) g.defTip = t;
      }
      return;
    case "<": {
      return;
    }
    case "shorten >":
      g.shortenE = dim(v) ?? 0;
      return;
    case "shorten <":
      g.shortenS = dim(v) ?? 0;
      return;
    // Transformations.
    case "scale": {
      const s = num(v ?? "1") ?? 1;
      if (ctx === "node") g.nscale *= s;
      else applyTransform(g, [s, 0, 0, s, 0, 0]);
      return;
    }
    case "xscale":
      if (ctx !== "node") applyTransform(g, [num(v ?? "1") ?? 1, 0, 0, 1, 0, 0]);
      return;
    case "yscale":
      if (ctx !== "node") applyTransform(g, [1, 0, 0, num(v ?? "1") ?? 1, 0, 0]);
      return;
    case "rotate": {
      const a = num(v ?? "0") ?? 0;
      if (ctx === "node") g.nrot += a;
      else applyTransform(g, rotation(a));
      return;
    }
    case "rotate around": {
      const m = /^\s*([^:]+):\s*\((.*)\)\s*$/.exec(v ?? "");
      if (m) {
        const a = num(m[1]) ?? 0;
        const c = host.coordOffset(m[2], g) ?? [0, 0];
        applyTransform(g, [1, 0, 0, 1, c[0], c[1]]);
        applyTransform(g, rotation(a));
        applyTransform(g, [1, 0, 0, 1, -c[0], -c[1]]);
      }
      return;
    }
    case "xshift":
    case "yshift": {
      const d = dim(v) ?? 0;
      const off: Pt = key === "xshift" ? [d, 0] : [0, d];
      if (ctx === "node") g.nshift = [g.nshift[0] + off[0], g.nshift[1] + off[1]];
      else applyTransform(g, [1, 0, 0, 1, off[0], off[1]]);
      return;
    }
    case "shift": {
      const off = v ? host.coordOffset(unbrace(v).replace(/^\(([^]*)\)$/, "$1"), g) : undefined;
      if (!off) return;
      if (ctx === "node") g.nshift = [g.nshift[0] + off[0], g.nshift[1] + off[1]];
      else {
        // The offset is in the current frame already; undo the linear part so it is not applied twice.
        const lin = g.T;
        const det = lin[0] * lin[3] - lin[1] * lin[2] || 1;
        const x = (lin[3] * off[0] - lin[2] * off[1]) / det;
        const y = (-lin[1] * off[0] + lin[0] * off[1]) / det;
        applyTransform(g, [1, 0, 0, 1, x, y]);
      }
      return;
    }
    case "x":
    case "y":
    case "z": {
      if (!v) return;
      // The vector as written: the picture's transformation applies once, to the points (as in TikZ).
      const vec = /^\s*\(/.test(v) ? host.coordOffset(v.trim().replace(/^\(([^]*)\)$/, "$1"), { ...g, T: [1, 0, 0, 1, 0, 0] }) : undefined;
      const l = vec ? undefined : length(v, CM);
      const out: Pt | undefined = vec ?? (l !== undefined ? (key === "x" ? [l, 0] : key === "y" ? [0, l] : [-l * 0.385 / 1, -l * 0.385]) : undefined);
      if (!out) return;
      if (key === "x") g.xv = out;
      else if (key === "y") g.yv = out;
      else g.zv = out;
      return;
    }
    case "cm": {
      const parts = splitTop(v ?? "", ",").map((s) => s.trim());
      if (parts.length >= 4) {
        const [a, b, c, d] = parts.slice(0, 4).map((s) => num(s) ?? 0);
        const off = parts[4] ? host.coordOffset(parts.slice(4).join(",").replace(/^\(([^]*)\)$/, "$1"), g) : [0, 0];
        applyTransform(g, [a, b, c, d, off?.[0] ?? 0, off?.[1] ?? 0]);
      }
      return;
    }
    case "reset cm":
      return;
    case "transform shape":
      g.transformShape = true;
      return;
    // Nodes.
    case "shape":
      if (v) g.shape = v;
      return;
    case "anchor":
      if (v) g.anchor = v;
      return;
    case "inner sep":
      g.ix = g.iy = dim(v) ?? g.ix;
      return;
    case "inner xsep":
      g.ix = dim(v) ?? g.ix;
      return;
    case "inner ysep":
      g.iy = dim(v) ?? g.iy;
      return;
    case "outer sep":
      g.outer = dim(v) ?? 0;
      return;
    case "minimum width":
      g.minW = dim(v) ?? g.minW;
      return;
    case "minimum height":
      g.minH = dim(v) ?? g.minH;
      return;
    case "minimum size":
      g.minW = g.minH = dim(v) ?? g.minW;
      return;
    case "text width":
      g.textWidth = dim(v);
      if (!g.align) g.align = "left";
      return;
    case "align": {
      const a = (v ?? "").trim();
      g.align = a === "left" || a === "flush left" ? "left" : a === "right" || a === "flush right" ? "right" : "center";
      return;
    }
    case "text centered":
    case "text badly centered":
      g.align = "center";
      return;
    case "text ragged":
    case "text badly ragged":
    case "text justified":
      g.align = "left";
      return;
    case "text ragged left":
      g.align = "right";
      return;
    case "font":
      if (v !== undefined) applyFont(v, g.font);
      return;
    case "node font":
      if (v !== undefined) applyFont(v, g.font);
      return;
    case "name":
      if (v) g.alias = v;
      return;
    case "alias":
      if (v) g.alias = v;
      return;
    case "label":
    case "pin": {
      if (!v) return;
      g.labels = [...g.labels, parseLabel(v, key === "pin")];
      return;
    }
    case "label distance":
      g.labelDist = dim(v) ?? 0;
      return;
    case "pin distance":
      g.pinDist = dim(v) ?? g.pinDist;
      return;
    case "node distance": {
      const parts = (v ?? "").split(/\s+and\s+/);
      const a = length(parts[0], CM);
      const b = parts[1] !== undefined ? length(parts[1], CM) : a;
      if (a !== undefined && b !== undefined) g.nodeDist = [a, b];
      return;
    }
    case "pos":
      g.pos = num(v ?? "0.5");
      return;
    case "midway":
      g.pos = 0.5;
      return;
    case "near start":
      g.pos = 0.25;
      return;
    case "near end":
      g.pos = 0.75;
      return;
    case "very near start":
      g.pos = 0.125;
      return;
    case "very near end":
      g.pos = 0.875;
      return;
    case "at start":
      g.pos = 0;
      return;
    case "at end":
      g.pos = 1;
      return;
    case "auto":
      g.auto = v === "right" ? "right" : v === "false" ? undefined : "left";
      return;
    case "swap":
    case "'":
      g.swap = !g.swap;
      return;
    case "sloped":
      g.sloped = true;
      return;
    case "allow upside down":
      return;
    case "initial":
      g.initial = "left";
      return;
    case "initial left":
    case "initial right":
    case "initial above":
    case "initial below":
      g.initial = key.slice(8);
      return;
    case "initial where":
      g.initial = v ?? "left";
      return;
    case "initial text":
      g.initialText = v ?? "";
      return;
    case "accepting":
    case "accepting by double":
      g.accepting = true;
      return;
    case "fit":
      g.fit = v;
      return;
    case "aspect":
    case "shape aspect":
      g.aspect = Math.max(0.05, Math.min(20, num(v ?? "1") ?? 1));
      return;
    case "regular polygon sides":
      g.sides = Math.max(3, Math.min(64, Math.round(num(v ?? "5") ?? 5)));
      return;
    case "star points":
      g.points = Math.max(3, Math.min(64, Math.round(num(v ?? "5") ?? 5)));
      return;
    // to paths.
    case "out":
      g.out = num(v ?? "0");
      return;
    case "in":
      g.in = num(v ?? "0");
      return;
    case "bend left":
      g.bend = num(v ?? "30") ?? 30;
      return;
    case "bend right":
      g.bend = -(num(v ?? "30") ?? 30);
      return;
    case "bend angle":
      return;
    case "looseness":
      g.looseness = num(v ?? "1") ?? 1;
      return;
    case "out looseness":
    case "in looseness":
      g.looseness = num(v ?? "1") ?? 1;
      return;
    case "min distance":
      g.minDist = dim(v);
      return;
    case "loop":
      g.loop = true;
      g.looseness = 8;
      g.minDist = 5 * (72.27 / 25.4);
      return;
    case "loop above":
    case "loop below":
    case "loop left":
    case "loop right": {
      g.loop = true;
      g.looseness = 8;
      g.minDist = 5 * (72.27 / 25.4);
      const a = { above: 90, below: -90, left: 180, right: 0 }[key.slice(5) as "above"];
      g.out = a + 15;
      g.in = a - 15;
      return;
    }
    case "relative":
      return;
    // Plots.
    case "domain": {
      const m = /^(.*?):(.*)$/.exec(v ?? "");
      if (m) {
        const a = num(m[1]);
        const b = num(m[2]);
        if (a !== undefined && b !== undefined) g.domain = [a, b];
      }
      return;
    }
    case "samples":
      g.samples = Math.max(2, Math.min(2000, Math.round(num(v ?? "25") ?? 25)));
      return;
    case "samples at":
      g.samplesAt = expandList(v ?? "").map((s) => num(s)).filter((x): x is number => x !== undefined).slice(0, 2000);
      return;
    case "variable":
      g.variable = (v ?? "x").replace(/^\\/, "");
      return;
    case "smooth":
      g.smooth = true;
      return;
    case "smooth cycle":
      g.smooth = true;
      g.smoothCycle = true;
      return;
    case "sharp plot":
    case "sharp cycle":
      g.smooth = false;
      return;
    case "tension":
      g.tension = num(v ?? "0.55") ?? 0.55;
      return;
    case "mark":
      g.mark = v === "none" ? undefined : v;
      return;
    case "mark size":
      g.markSize = dim(v) ?? 2;
      return;
    case "mark options":
      g.markOpts = [...g.markOpts, v ?? ""];
      return;
    case "only marks":
      g.onlyMarks = true;
      return;
    case "no marks":
    case "no markers":
      g.mark = undefined;
      return;
    case "ycomb":
    case "xcomb":
      g.plotKind = key;
      return;
    case "const plot":
    case "const plot mark left":
      g.plotKind = "const";
      return;
    case "jump mark left":
    case "jump mark right":
      g.plotKind = "jump";
      return;
    // Grids, circles, arcs.
    case "step":
    case "xstep":
    case "ystep": {
      if (!v) return;
      if (/^\s*\(/.test(v)) {
        const off = host.coordOffset(v.trim().replace(/^\(([^]*)\)$/, "$1"), g);
        if (off) g.step = [Math.abs(off[0]) || g.step[0], Math.abs(off[1]) || g.step[1]];
        return;
      }
      const l = length(v, CM);
      if (l === undefined) return;
      if (key !== "ystep") g.step = [l, key === "step" ? l : g.step[1]];
      if (key === "ystep") g.step = [g.step[0], l];
      return;
    }
    case "radius":
      g.radius = lenPair(v);
      return;
    case "x radius":
      g.xradius = lenPair(v);
      return;
    case "y radius":
      g.yradius = lenPair(v);
      return;
    case "start angle":
      g.startAngle = num(v ?? "0");
      return;
    case "end angle":
      g.endAngle = num(v ?? "0");
      return;
    case "delta angle":
      g.deltaAngle = num(v ?? "0");
      return;
    // Shading.
    case "shade":
      if (!g.shade) g.shade = { kind: "linear", angle: -90, stops: [[0, "#808080"], [1, "#ffffff"]] };
      return;
    case "shading":
      g.shade = { kind: v === "radial" ? "radial" : v === "ball" ? "ball" : "linear", angle: -90, stops: g.shade?.stops ?? [[0, "#808080"], [1, "#ffffff"]] };
      return;
    case "left color":
    case "right color":
    case "top color":
    case "bottom color":
    case "middle color":
    case "inner color":
    case "outer color":
    case "ball color": {
      const c = v ? setColor(g, v, host) : undefined;
      if (c) shadeColor(g, key, c);
      return;
    }
    case "shading angle":
      if (g.shade) g.shade = { ...g.shade, angle: -90 + (num(v ?? "0") ?? 0) };
      return;
    case "pattern":
      // Patterns are drawn as a light fill of the pattern colour.
      g.doFill = true;
      if (g.fillColor === undefined || g.fillColor === null) g.fillColor = "#d0d0d0";
      host.warn("pattern fills are drawn as a light grey fill");
      return;
    case "pattern color": {
      const c = v ? setColor(g, v, host) : undefined;
      if (c) g.fillColor = parseColor(`${c}!30`, host.colors, host.lookup, g.color) ?? c;
      return;
    }
    case "decorate":
      g.decorate = true;
      return;
    case "decoration":
      g.decoration = parseDecoration(v ?? "", g);
      return;
    case "postaction":
    case "preaction":
      if (v && /\bdecorate\b/.test(v)) g.postDecorate = true;
      return;
    case "use as bounding box":
      g.useAsBox = true;
      return;
    case "clip":
      g.doClip = true;
      return;
    case "on background layer":
      g.layer = -1;
      return;
    case "nodes": {
      if (v) g.nodesOpts = [...g.nodesOpts, v];
      return;
    }
    case "style":
      if (v) applyOptions(g, v, ctx, host, depth + 1);
      return;
    case "every node":
      return;
  }
  if (Object.hasOwn(WIDTHS, key)) {
    g.lw = WIDTHS[key];
    return;
  }
  if (DASHES.has(key)) {
    g.dash = key === "solid" ? undefined : key;
    g.dashPattern = undefined;
    return;
  }
  if (DIRECTIONS.has(key)) {
    setPlace(g, key, v, host);
    return;
  }
  const oldPlace = /^(above|below|left|right|above left|above right|below left|below right) of$/.exec(key);
  if (oldPlace) {
    if (v) g.place = { dir: oldPlace[1], of: v.trim(), old: true };
    return;
  }
  if (SHAPES.has(key) && key !== "shape") {
    g.shape = key;
    return;
  }
  if (value === undefined) {
    const spec = parseArrowSpec(key);
    if (spec) {
      g.arrows = spec.start.length || spec.end.length ? spec : undefined;
      return;
    }
    if (isColorName(key, host.colors, host.lookup)) {
      const c = setColor(g, key, host);
      if (c) {
        g.color = c;
        g.drawColor = g.drawColor === null ? null : undefined;
        g.fillColor = g.fillColor === null ? null : undefined;
        g.textColor = undefined;
      }
      return;
    }
  }
  if (QUIET.has(key)) return;
  host.unknown(key);
}

function lenPair(v: string | undefined): [number, boolean] | undefined {
  if (v === undefined) return undefined;
  try {
    const r = evaluate(v);
    return [r.v, r.dim];
  } catch {
    return undefined;
  }
}

function shadeColor(g: GS, key: string, c: string): void {
  const sh: Shade = g.shade ? { ...g.shade, stops: [...g.shade.stops] } : { kind: "linear", angle: 0, stops: [] };
  g.doFill = true;
  switch (key) {
    case "left color":
    case "right color": {
      sh.kind = "linear";
      sh.angle = 0;
      const others = sh.stops.filter(([o]) => o === 0.5 || (key === "left color" ? o === 1 : o === 0));
      sh.stops = [...others, [key === "left color" ? 0 : 1, c]];
      break;
    }
    case "top color":
    case "bottom color": {
      sh.kind = "linear";
      sh.angle = 90;
      const others = sh.stops.filter(([o]) => o === 0.5 || (key === "bottom color" ? o === 1 : o === 0));
      sh.stops = [...others, [key === "bottom color" ? 0 : 1, c]];
      break;
    }
    case "middle color":
      sh.stops = [...sh.stops.filter(([o]) => o !== 0.5), [0.5, c]];
      break;
    case "inner color":
    case "outer color": {
      sh.kind = "radial";
      const others = sh.stops.filter(([o]) => (key === "inner color" ? o === 1 : o === 0));
      sh.stops = [...others, [key === "inner color" ? 0 : 1, c]];
      break;
    }
    case "ball color":
      sh.kind = "ball";
      sh.stops = [
        [0, "#ffffff"],
        [0.55, c],
        [1, darken(c)],
      ];
      break;
  }
  sh.stops.sort((a, b) => a[0] - b[0]);
  // A one-colour shading fades from white (TikZ's other default colour).
  if (sh.stops.length === 1) sh.stops = sh.kind === "radial" ? [sh.stops[0], [1, "#ffffff"]] : sh.stops[0][0] === 0 ? [sh.stops[0], [1, "#ffffff"]] : [[0, "#ffffff"], sh.stops[0]];
  g.shade = sh;
}

function darken(c: string): string {
  const v = [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.35));
  return `#${v.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function setPlace(g: GS, dir: string, v: string | undefined, host: OptionHost): void {
  if (v === undefined) {
    g.place = { dir };
    return;
  }
  const m = /^(.*?)\s*\bof\s+(.+)$/s.exec(v.trim());
  const distText = m ? m[1].trim() : v.trim();
  let dx: number | undefined;
  let dy: number | undefined;
  if (distText) {
    const parts = distText.split(/\s+and\s+/);
    const a = length(parts[0], CM);
    const b = parts[1] !== undefined ? length(parts[1], CM) : a;
    if (a === undefined) host.warn(`cannot read the distance "${distText}" in ${dir}=...`);
    dy = a;
    dx = b;
  }
  g.place = { dir, ...(dx !== undefined ? { dx } : {}), ...(dy !== undefined ? { dy } : {}), ...(m ? { of: m[2].trim() } : {}) };
}

/** label=[opts]angle:text, label=text (above), pin=... */
export function parseLabel(v: string, pin: boolean): LabelSpec {
  let s = v.trim();
  let opts = "";
  if (s.startsWith("[")) {
    let depth = 0;
    let k = 0;
    for (; k < s.length; k++) {
      if (s[k] === "[" || s[k] === "{") depth++;
      else if (s[k] === "]" || s[k] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    opts = s.slice(1, k);
    s = s.slice(k + 1).trim();
  }
  // The angle is everything before the first colon outside braces and math.
  let depth = 0;
  let math = false;
  let colon = -1;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "$") math = !math;
    else if (c === ":" && depth === 0 && !math) {
      colon = k;
      break;
    }
  }
  if (colon < 0) return { pin, opts, angle: "above", text: unbrace(s) };
  return { pin, opts, angle: s.slice(0, colon).trim(), text: unbrace(s.slice(colon + 1)) };
}

/** {1,...,5}, {0,0.5,...,2}, {a,b,c}, {1/a, 2/b}: the items of a \foreach list. */
export function expandList(list: string, max = 10000): string[] {
  const items = splitTop(list, ",").map((s) => s.trim()).filter((s, i, a) => s !== "" || i < a.length - 1);
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === "..." || it === "\\ldots" || it === "\\dots") {
      const prev = out[out.length - 1];
      const prev2 = out.length >= 2 ? out[out.length - 2] : undefined;
      const next = items[i + 1];
      if (prev === undefined || next === undefined) continue;
      const a = num(prev);
      const b = num(next);
      if (a !== undefined && b !== undefined) {
        const p2 = prev2 !== undefined ? num(prev2) : undefined;
        const step = p2 !== undefined && out.length >= 2 && i >= 2 ? a - p2 : b >= a ? 1 : -1;
        if (step === 0 || Math.sign(step) !== Math.sign(b - a || step)) continue;
        const dec = Math.max(decimals(prev), decimals(prev2 ?? ""), decimals(next));
        for (let x = a + step, k = 0; step > 0 ? x < b - 1e-9 : x > b + 1e-9; x += step, k++) {
          if (out.length >= max) return out;
          out.push(fmtNum(x, dec));
        }
        continue;
      }
      // Letters: a,...,e.
      if (prev.length === 1 && next.length === 1) {
        const ca = prev.charCodeAt(0);
        const cb = next.charCodeAt(0);
        for (let c = ca + 1; c < cb && out.length < max; c++) out.push(String.fromCharCode(c));
      }
      continue;
    }
    if (out.length >= max) return out;
    out.push(it);
  }
  return out;
}

function decimals(s: string): number {
  const m = /\.(\d+)/.exec(s);
  return m ? m[1].length : 0;
}

function fmtNum(x: number, dec: number): string {
  const r = Number(x.toFixed(Math.max(dec, 0) + 6));
  return dec ? String(Number(r.toFixed(dec))) : String(Math.round(r * 1e6) / 1e6);
}

function parseDecoration(v: string, g: GS): GS["decoration"] {
  const d = { kind: "", amplitude: 4, segmentLength: 10, mirror: false, raise: 0, marks: [] as { at: number; abs: boolean; tip: string; reversed: boolean }[] };
  for (const { key, value } of parseOptions(v)) {
    if (key === "brace" || key === "calligraphic brace") d.kind = "brace";
    else if (key === "zigzag" || key === "snake" || key === "coil" || key === "saw" || key === "bumps" || key === "random steps" || key === "markings" || key === "border" || key === "ticks" || key === "waves" || key === "expanding waves") d.kind = key;
    else if (key === "amplitude") d.amplitude = length(value ?? "4pt", 1) ?? 4;
    else if (key === "segment length") d.segmentLength = length(value ?? "10pt", 1) ?? 10;
    else if (key === "mirror") d.mirror = true;
    else if (key === "raise") d.raise = length(value ?? "0", 1) ?? 0;
    else if (key === "mark") {
      // mark=at position 0.5 with {\arrow{>}}
      const m = /at position\s+([^\s]+)\s+with\s*\{?\s*\\(arrow|arrowreversed)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(value ?? "");
      if (m) {
        const at = evaluate(m[1]);
        d.marks.push({ at: at.v, abs: at.dim, tip: m[3], reversed: m[2] === "arrowreversed" });
        if (!d.kind) d.kind = "markings";
      }
    }
  }
  void g;
  return d;
}
