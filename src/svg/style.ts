/**
 * Styling: lengths, the cascade (presentation attributes < style sheet rules
 * by specificity and order < style attribute, with !important on top) and
 * computed styles with SVG's inheritance rules.
 */

import type { BlendMode } from "../layout/types.js";
import { parseColor, type Rgba } from "./color.js";
import { type Declaration, matches, parseDeclarations, type Rule, splitTopLevel } from "./css.js";
import { scanNumber } from "./num.js";
import type { XmlElement } from "./xml.js";

// ---------------------------------------------------------------- lengths

export interface Viewport {
  /** Width and height in user units, for percentages. */
  w: number;
  h: number;
}

export type Axis = "x" | "y" | "other";

const ABS_UNITS: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

/** Parses a length; undefined when malformed. */
export function parseLength(s: string): { v: number; unit: string } | undefined {
  const t = s.trim();
  const end = scanNumber(t, 0);
  if (end < 0) return undefined;
  const v = Number(t.slice(0, end));
  const unit = t.slice(end).toLowerCase();
  if (!Number.isFinite(v)) return undefined;
  if (unit === "" || unit === "%" || unit in ABS_UNITS || unit === "em" || unit === "ex" || unit === "rem" || unit === "ch" || unit === "vw" || unit === "vh" || unit === "vmin" || unit === "vmax")
    return { v, unit };
  return undefined;
}

/** A length in user units (px). Percentages refer to the viewport width, height, or normalized diagonal. */
export function resolveLength(len: { v: number; unit: string }, axis: Axis, fontSize: number, vp: Viewport): number {
  const { v, unit } = len;
  if (unit === "") return v;
  const abs = ABS_UNITS[unit];
  if (abs !== undefined) return v * abs;
  switch (unit) {
    case "em":
      return v * fontSize;
    case "ex":
    case "ch":
      return v * fontSize * 0.5;
    case "rem":
      return v * 16;
    case "vw":
      return (v * vp.w) / 100;
    case "vh":
      return (v * vp.h) / 100;
    case "vmin":
      return (v * Math.min(vp.w, vp.h)) / 100;
    case "vmax":
      return (v * Math.max(vp.w, vp.h)) / 100;
    case "%": {
      const ref = axis === "x" ? vp.w : axis === "y" ? vp.h : Math.sqrt((vp.w * vp.w + vp.h * vp.h) / 2);
      return (v * ref) / 100;
    }
  }
  return v;
}

/** Parses and resolves a length attribute; `dflt` when absent or malformed. */
export function lengthAttr(el: XmlElement, name: string, axis: Axis, fontSize: number, vp: Viewport, dflt: number): number;
export function lengthAttr(el: XmlElement, name: string, axis: Axis, fontSize: number, vp: Viewport, dflt?: number): number | undefined;
export function lengthAttr(el: XmlElement, name: string, axis: Axis, fontSize: number, vp: Viewport, dflt?: number): number | undefined {
  const raw = el.attrs.get(name);
  if (raw === undefined) return dflt;
  const len = parseLength(raw);
  if (!len) return dflt;
  return resolveLength(len, axis, fontSize, vp);
}

/** A list of lengths (text x/y/dx/dy). */
export function lengthList(s: string, axis: Axis, fontSize: number, vp: Viewport, max = 100_000): number[] {
  const out: number[] = [];
  for (const part of s.trim().split(/[\s,]+/)) {
    if (!part) continue;
    if (out.length >= max) break;
    const len = parseLength(part);
    if (!len) break;
    out.push(resolveLength(len, axis, fontSize, vp));
  }
  return out;
}

// ---------------------------------------------------------------- properties

/** Presentation properties: name -> inherited. */
export const PROPERTIES: Readonly<Record<string, boolean>> = {
  fill: true,
  "fill-opacity": true,
  "fill-rule": true,
  stroke: true,
  "stroke-width": true,
  "stroke-opacity": true,
  "stroke-dasharray": true,
  "stroke-dashoffset": true,
  "stroke-linecap": true,
  "stroke-linejoin": true,
  "stroke-miterlimit": true,
  opacity: false,
  display: false,
  visibility: true,
  color: true,
  "font-family": true,
  "font-size": true,
  "font-weight": true,
  "font-style": true,
  "text-anchor": true,
  "dominant-baseline": true,
  "alignment-baseline": false,
  "baseline-shift": false,
  "letter-spacing": true,
  "word-spacing": true,
  "clip-path": false,
  "clip-rule": true,
  mask: false,
  filter: false,
  "marker-start": true,
  "marker-mid": true,
  "marker-end": true,
  "stop-color": false,
  "stop-opacity": false,
  overflow: false,
  "vector-effect": false,
  "paint-order": true,
  "white-space": true,
  "text-decoration": false,
  "text-decoration-line": false,
  "mix-blend-mode": false,
  "mask-type": false,
  isolation: false,
  "text-align": true,
  "line-height": true,
  "flood-color": false,
  "flood-opacity": false,
  "color-interpolation-filters": true,
  "image-rendering": true,
};

/**
 * CSS properties read only from style sheets and style attributes (never
 * from attributes of the same name): the layout of HTML labels inside
 * foreignObject.
 */
export const CSS_ONLY: ReadonlySet<string> = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-left",
  "margin-top",
  "width",
  "height",
  "align-items",
  "justify-content",
  "vertical-align",
  "background-color",
  "background",
]);

const BLEND_MODES: ReadonlySet<string> = new Set([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

export type Paint =
  | { kind: "none" }
  | { kind: "color"; c: Rgba }
  | { kind: "current" }
  | { kind: "url"; id: string; fallback?: Paint }
  | { kind: "context-fill" }
  | { kind: "context-stroke" };

export interface Style {
  // inherited
  fill: Paint;
  fillOpacity: number;
  fillRule: "nonzero" | "evenodd";
  stroke: Paint;
  strokeOpacity: number;
  strokeWidth: number;
  dashArray: number[] | null;
  dashOffset: number;
  lineCap: 0 | 1 | 2;
  lineJoin: 0 | 1 | 2;
  miterLimit: number;
  visible: boolean;
  color: Rgba;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textAnchor: "start" | "middle" | "end";
  dominantBaseline: string;
  letterSpacing: number;
  wordSpacing: number;
  clipRule: "nonzero" | "evenodd";
  markerStart?: string;
  markerMid?: string;
  markerEnd?: string;
  strokeFirst: boolean;
  /** xml:space="preserve" or white-space: pre*. */
  preserveSpace: boolean;
  // not inherited
  opacity: number;
  display: boolean;
  alignmentBaseline?: string;
  /** A length up; sub and super are set as `shift` (they depend on the font). */
  baselineShift: number;
  shift?: "sub" | "super";
  /** Decorations of the element and its ancestors (they reach every descendant). */
  decoration: { underline: boolean; overline: boolean; lineThrough: boolean };
  clipPath?: string;
  mask?: string;
  filter?: string;
  stopColor: Rgba;
  stopOpacity: number;
  /** undefined: not set (the element's default applies). */
  overflowVisible?: boolean;
  nonScalingStroke: boolean;
  /** mix-blend-mode other than normal. */
  blend?: BlendMode;
  /** mask-type on a <mask> (or its attribute). */
  maskType: "luminance" | "alpha";
  // inherited, for HTML inside foreignObject
  textAlign: "left" | "right" | "center" | "start" | "end" | "justify";
  /** image-rendering asks for square pixels (pixelated, crisp-edges, optimizeSpeed). */
  pixelated: boolean;
  /** A multiple of the font size; undefined is "normal". */
  lineHeight?: number;
}

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

export function initialStyle(): Style {
  return {
    fill: { kind: "color", c: BLACK },
    fillOpacity: 1,
    fillRule: "nonzero",
    stroke: { kind: "none" },
    strokeOpacity: 1,
    strokeWidth: 1,
    dashArray: null,
    dashOffset: 0,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 4,
    visible: true,
    color: BLACK,
    fontFamily: "serif",
    fontSize: 16,
    bold: false,
    italic: false,
    textAnchor: "start",
    dominantBaseline: "auto",
    letterSpacing: 0,
    wordSpacing: 0,
    clipRule: "nonzero",
    strokeFirst: false,
    preserveSpace: false,
    opacity: 1,
    display: true,
    baselineShift: 0,
    decoration: { underline: false, overline: false, lineThrough: false },
    stopColor: BLACK,
    stopOpacity: 1,
    nonScalingStroke: false,
    maskType: "luminance",
    textAlign: "start",
    pixelated: false,
  };
}

/** Copy of the parent's inherited properties with non-inherited ones reset. */
function inheritFrom(p: Style): Style {
  const s: Style = { ...p, dashArray: p.dashArray };
  s.opacity = 1;
  s.display = true;
  s.alignmentBaseline = undefined;
  s.baselineShift = 0;
  s.shift = undefined;
  s.clipPath = undefined;
  s.mask = undefined;
  s.filter = undefined;
  s.stopColor = BLACK;
  s.stopOpacity = 1;
  s.overflowVisible = undefined;
  s.nonScalingStroke = false;
  s.blend = undefined;
  s.maskType = "luminance";
  return s;
}

/** `url(#id)` or `url("#id")`: the id, "" for an external or malformed reference, undefined when not a url(). */
export function urlId(v: string): { id: string; rest: string } | undefined {
  const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)\s*(.*)$/i.exec(v.trim());
  if (!m) return undefined;
  const ref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  const id = ref.startsWith("#") ? ref.slice(1) : "";
  return { id, rest: m[4] };
}

export function parsePaint(v: string): Paint | undefined {
  const t = v.trim();
  const lower = t.toLowerCase();
  if (lower === "none") return { kind: "none" };
  if (lower === "context-fill") return { kind: "context-fill" };
  if (lower === "context-stroke") return { kind: "context-stroke" };
  const u = urlId(t);
  if (u) {
    const fb = u.rest ? parsePaint(u.rest) : undefined;
    return { kind: "url", id: u.id, fallback: fb };
  }
  const c = parseColor(t);
  if (c === "currentColor") return { kind: "current" };
  if (c) return { kind: "color", c };
  return undefined;
}

export function parseOpacity(v: string): number | undefined {
  const t = v.trim();
  const end = scanNumber(t, 0);
  if (end < 0) return undefined;
  let n = Number(t.slice(0, end));
  const rest = t.slice(end);
  if (rest === "%") n /= 100;
  else if (rest) return undefined;
  return Math.min(1, Math.max(0, n));
}

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

function fontSizeValue(v: string, parentSize: number, vp: Viewport): number | undefined {
  const t = v.trim().toLowerCase();
  if (t in FONT_SIZE_KEYWORDS) return FONT_SIZE_KEYWORDS[t];
  if (t === "smaller") return parentSize / 1.2;
  if (t === "larger") return parentSize * 1.2;
  const len = parseLength(t);
  if (!len || len.v < 0) return undefined;
  if (len.unit === "%") return (len.v * parentSize) / 100;
  return resolveLength(len, "other", parentSize, vp);
}

function weightBold(v: string): boolean | undefined {
  const t = v.trim().toLowerCase();
  if (t === "bold" || t === "bolder") return true;
  if (t === "normal" || t === "lighter") return false;
  const n = Number(t);
  if (Number.isFinite(n) && n >= 1 && n <= 1000) return n >= 600;
  return undefined;
}

function markerRef(v: string): string | undefined | null {
  const t = v.trim();
  if (t.toLowerCase() === "none") return undefined;
  const u = urlId(t);
  if (!u) return null; // invalid
  return u.id || undefined;
}

/** Expands shorthands (`marker`, `font`) into longhands. */
function expand(d: Declaration): Declaration[] {
  if (d.name === "marker") {
    return ["marker-start", "marker-mid", "marker-end"].map((name) => ({ name, value: d.value, important: d.important }));
  }
  if (d.name === "font") {
    // [style] [variant] [weight] size[/line-height] family
    const out: Declaration[] = [];
    const v = d.value.trim();
    if (v.length > 1000) return [];
    const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00)\s+)*)([^\s/]+)(?:\s*\/\s*(\S+))?\s+(.+)$/i.exec(v);
    if (!m) return [];
    for (const w of m[1].trim().split(/\s+/)) {
      if (!w) continue;
      if (/^(italic|oblique)$/i.test(w)) out.push({ name: "font-style", value: w, important: d.important });
      else if (/^(bold|bolder|lighter|[1-9]00)$/i.test(w)) out.push({ name: "font-weight", value: w, important: d.important });
    }
    out.push({ name: "font-size", value: m[2], important: d.important });
    if (m[3]) out.push({ name: "line-height", value: m[3], important: d.important });
    out.push({ name: "font-family", value: m[4], important: d.important });
    return out;
  }
  return [d];
}

// ---------------------------------------------------------------- cascade

export class Cascade {
  private readonly cache = new WeakMap<XmlElement, Map<string, string>>();
  private readonly budget: { steps: number };
  /** Set when the selector matching budget ran out. */
  exhausted = false;

  constructor(
    private readonly rules: Rule[],
    matchBudget = 20_000_000,
  ) {
    this.budget = { steps: matchBudget };
  }

  /** Cascaded (specified) property values of an element, without inheritance. */
  specified(el: XmlElement): Map<string, string> {
    let m = this.cache.get(el);
    if (m) return m;
    m = new Map();
    // 1. presentation attributes
    for (const [name, value] of el.attrs) {
      if (name in PROPERTIES && Object.prototype.hasOwnProperty.call(PROPERTIES, name)) m.set(name, value);
    }
    if (el.attrs.has("xml:space")) m.set("xml:space", el.attrs.get("xml:space") as string);
    // 2. style sheet rules, by specificity then order
    const normal: { spec: number; order: number; d: Declaration }[] = [];
    const important: { spec: number; order: number; d: Declaration }[] = [];
    if (this.rules.length && !this.exhausted) {
      for (const rule of this.rules) {
        let best = -1;
        for (const sel of rule.selectors) {
          if (sel.specificity > best && matches(sel, el, this.budget)) best = sel.specificity;
        }
        if (this.budget.steps < 0) {
          this.exhausted = true;
          break;
        }
        if (best < 0) continue;
        for (const d of rule.decls) (d.important ? important : normal).push({ spec: best, order: rule.order, d });
      }
    }
    const byRank = (a: { spec: number; order: number }, b: { spec: number; order: number }) => a.spec - b.spec || a.order - b.order;
    normal.sort(byRank);
    important.sort(byRank);
    const inline = el.attrs.has("style") ? parseDeclarations(el.attrs.get("style") as string) : [];
    const set = (d: Declaration) => {
      for (const e of expand(d)) if (Object.prototype.hasOwnProperty.call(PROPERTIES, e.name) || CSS_ONLY.has(e.name)) m!.set(e.name, e.value);
    };
    for (const x of normal) set(x.d);
    for (const d of inline) if (!d.important) set(d);
    for (const x of important) set(x.d);
    for (const d of inline) if (d.important) set(d);
    this.cache.set(el, m);
    return m;
  }
}

// ---------------------------------------------------------------- computed style

function dashArray(v: string, fontSize: number, vp: Viewport): number[] | null | undefined {
  const t = v.trim();
  if (t.toLowerCase() === "none") return null;
  const out: number[] = [];
  for (const part of t.split(/[\s,]+/)) {
    if (!part) continue;
    const len = parseLength(part);
    if (!len) return undefined;
    const x = resolveLength(len, "other", fontSize, vp);
    if (x < 0) return undefined;
    out.push(x);
    if (out.length > 1000) return undefined;
  }
  if (out.length === 0) return undefined;
  if (out.every((x) => x === 0)) return null;
  return out.length % 2 ? [...out, ...out] : out;
}

/**
 * The computed style of `el` given its parent's computed style.
 * Invalid values are ignored, as if the property were not specified.
 */
export function computeStyle(el: XmlElement, parent: Style, cascade: Cascade, vp: Viewport): Style {
  const spec = cascade.specified(el);
  const s = inheritFrom(parent);
  if (spec.size === 0) return s;
  const get = (name: string): string | undefined => {
    const v = spec.get(name);
    if (v === undefined) return undefined;
    const t = v.trim().toLowerCase();
    if (t === "inherit") {
      // Copy the parent's value of a non-inherited property.
      applyInherit(name, s, parent);
      return undefined;
    }
    if (t === "initial" || t === "unset") {
      applyInherit(name, s, PROPERTIES[name] && t === "unset" ? parent : initialStyle());
      return undefined;
    }
    return v;
  };
  let v: string | undefined;
  if ((v = get("font-size")) !== undefined) {
    const fs = fontSizeValue(v, parent.fontSize, vp);
    if (fs !== undefined) s.fontSize = fs;
  }
  const fs = s.fontSize;
  if ((v = get("color")) !== undefined) {
    const c = parseColor(v);
    if (c === "currentColor") s.color = parent.color;
    else if (c) s.color = c;
  }
  if ((v = get("fill")) !== undefined) {
    const p = parsePaint(v);
    if (p) s.fill = p;
  }
  if ((v = get("stroke")) !== undefined) {
    const p = parsePaint(v);
    if (p) s.stroke = p;
  }
  if ((v = get("fill-opacity")) !== undefined) s.fillOpacity = parseOpacity(v) ?? s.fillOpacity;
  if ((v = get("stroke-opacity")) !== undefined) s.strokeOpacity = parseOpacity(v) ?? s.strokeOpacity;
  if ((v = get("opacity")) !== undefined) s.opacity = parseOpacity(v) ?? s.opacity;
  if ((v = get("fill-rule")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "nonzero" || t === "evenodd") s.fillRule = t;
  }
  if ((v = get("clip-rule")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "nonzero" || t === "evenodd") s.clipRule = t;
  }
  if ((v = get("stroke-width")) !== undefined) {
    const len = parseLength(v);
    if (len && len.v >= 0) s.strokeWidth = resolveLength(len, "other", fs, vp);
  }
  if ((v = get("stroke-dasharray")) !== undefined) {
    const d = dashArray(v, fs, vp);
    if (d !== undefined) s.dashArray = d;
  }
  if ((v = get("stroke-dashoffset")) !== undefined) {
    const len = parseLength(v);
    if (len) s.dashOffset = resolveLength(len, "other", fs, vp);
  }
  if ((v = get("stroke-linecap")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "butt") s.lineCap = 0;
    else if (t === "round") s.lineCap = 1;
    else if (t === "square") s.lineCap = 2;
  }
  if ((v = get("stroke-linejoin")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "miter" || t === "miter-clip" || t === "arcs") s.lineJoin = 0;
    else if (t === "round") s.lineJoin = 1;
    else if (t === "bevel") s.lineJoin = 2;
  }
  if ((v = get("stroke-miterlimit")) !== undefined) {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n >= 1) s.miterLimit = n;
  }
  if ((v = get("display")) !== undefined) s.display = v.trim().toLowerCase() !== "none";
  if ((v = get("visibility")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "visible") s.visible = true;
    else if (t === "hidden" || t === "collapse") s.visible = false;
  }
  if ((v = get("font-family")) !== undefined && v.trim()) s.fontFamily = v.trim();
  if ((v = get("font-weight")) !== undefined) {
    const b = weightBold(v);
    if (b !== undefined) s.bold = b;
  }
  if ((v = get("font-style")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "normal") s.italic = false;
    else if (t === "italic" || t.startsWith("oblique")) s.italic = true;
  }
  if ((v = get("text-anchor")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "start" || t === "middle" || t === "end") s.textAnchor = t;
  }
  if ((v = get("dominant-baseline")) !== undefined) s.dominantBaseline = v.trim().toLowerCase();
  if ((v = get("alignment-baseline")) !== undefined) s.alignmentBaseline = v.trim().toLowerCase();
  if ((v = get("baseline-shift")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "sub" || t === "super") {
      s.shift = t;
      s.baselineShift = 0;
    } else if (t === "baseline") {
      s.shift = undefined;
      s.baselineShift = 0;
    } else {
      const len = parseLength(t);
      if (len) {
        s.shift = undefined;
        s.baselineShift = len.unit === "%" ? (len.v * fs) / 100 : resolveLength(len, "other", fs, vp);
      }
    }
  }
  if ((v = get("text-decoration")) !== undefined || (v = get("text-decoration-line")) !== undefined) {
    const t = v.toLowerCase();
    const d = s.decoration;
    if (/\bunderline\b|\boverline\b|\bline-through\b/.test(t)) {
      s.decoration = { underline: d.underline || /\bunderline\b/.test(t), overline: d.overline || /\boverline\b/.test(t), lineThrough: d.lineThrough || /\bline-through\b/.test(t) };
    }
  }
  if ((v = get("letter-spacing")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "normal") s.letterSpacing = 0;
    else {
      const len = parseLength(t);
      if (len) s.letterSpacing = resolveLength(len, "other", fs, vp);
    }
  }
  if ((v = get("word-spacing")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "normal") s.wordSpacing = 0;
    else {
      const len = parseLength(t);
      if (len) s.wordSpacing = resolveLength(len, "other", fs, vp);
    }
  }
  for (const [prop, key] of [
    ["marker-start", "markerStart"],
    ["marker-mid", "markerMid"],
    ["marker-end", "markerEnd"],
  ] as const) {
    if ((v = get(prop)) !== undefined) {
      const r = markerRef(v);
      if (r !== null) s[key] = r;
    }
  }
  if ((v = get("clip-path")) !== undefined) {
    const u = urlId(v);
    s.clipPath = u ? u.id || undefined : undefined;
  }
  if ((v = get("mask")) !== undefined) {
    const u = urlId(v);
    s.mask = u ? u.id || undefined : undefined;
  }
  if ((v = get("filter")) !== undefined) {
    const t = v.trim();
    s.filter = t && t.toLowerCase() !== "none" ? t : undefined;
  }
  if ((v = get("stop-color")) !== undefined) {
    const c = parseColor(v);
    if (c === "currentColor") s.stopColor = s.color;
    else if (c) s.stopColor = c;
  }
  if ((v = get("stop-opacity")) !== undefined) s.stopOpacity = parseOpacity(v) ?? s.stopOpacity;
  if ((v = get("overflow")) !== undefined) {
    const t = v.trim().toLowerCase();
    s.overflowVisible = t === "visible" || t === "auto";
  }
  if ((v = get("vector-effect")) !== undefined) s.nonScalingStroke = v.trim().toLowerCase() === "non-scaling-stroke";
  if ((v = get("paint-order")) !== undefined) {
    const t = v.trim().toLowerCase().split(/\s+/);
    const fi = t.indexOf("fill");
    const st = t.indexOf("stroke");
    s.strokeFirst = t[0] !== "normal" && st >= 0 && (fi < 0 || st < fi);
  }
  if ((v = get("white-space")) !== undefined) {
    const t = v.trim().toLowerCase();
    s.preserveSpace = t === "pre" || t === "pre-wrap" || t === "break-spaces" || t === "pre-line";
  }
  if ((v = get("mix-blend-mode")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (BLEND_MODES.has(t)) s.blend = t === "normal" ? undefined : (t as BlendMode);
  }
  if ((v = get("mask-type")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "alpha" || t === "luminance") s.maskType = t;
  }
  if ((v = get("image-rendering")) !== undefined) {
    const t = v.trim().toLowerCase();
    s.pixelated = t === "pixelated" || t === "crisp-edges" || t === "optimizespeed" || t === "-moz-crisp-edges";
  }
  if ((v = get("text-align")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "left" || t === "right" || t === "center" || t === "start" || t === "end" || t === "justify") s.textAlign = t;
  }
  if ((v = get("line-height")) !== undefined) {
    const t = v.trim().toLowerCase();
    if (t === "normal") s.lineHeight = undefined;
    else {
      const n = Number(t);
      const len = Number.isFinite(n) ? undefined : parseLength(t);
      if (Number.isFinite(n) && n >= 0) s.lineHeight = n;
      else if (len && len.v >= 0) s.lineHeight = len.unit === "%" ? len.v / 100 : resolveLength(len, "other", fs, vp) / fs;
    }
  }
  const xs = spec.get("xml:space");
  if (xs !== undefined && spec.get("white-space") === undefined) s.preserveSpace = xs.trim() === "preserve";
  return s;
}

const KEYS: Record<string, (keyof Style)[]> = {
  fill: ["fill"],
  "fill-opacity": ["fillOpacity"],
  "fill-rule": ["fillRule"],
  stroke: ["stroke"],
  "stroke-width": ["strokeWidth"],
  "stroke-opacity": ["strokeOpacity"],
  "stroke-dasharray": ["dashArray"],
  "stroke-dashoffset": ["dashOffset"],
  "stroke-linecap": ["lineCap"],
  "stroke-linejoin": ["lineJoin"],
  "stroke-miterlimit": ["miterLimit"],
  opacity: ["opacity"],
  display: ["display"],
  visibility: ["visible"],
  color: ["color"],
  "font-family": ["fontFamily"],
  "font-size": ["fontSize"],
  "font-weight": ["bold"],
  "font-style": ["italic"],
  "text-anchor": ["textAnchor"],
  "dominant-baseline": ["dominantBaseline"],
  "alignment-baseline": ["alignmentBaseline"],
  "baseline-shift": ["baselineShift"],
  "letter-spacing": ["letterSpacing"],
  "word-spacing": ["wordSpacing"],
  "clip-path": ["clipPath"],
  "clip-rule": ["clipRule"],
  mask: ["mask"],
  filter: ["filter"],
  "marker-start": ["markerStart"],
  "marker-mid": ["markerMid"],
  "marker-end": ["markerEnd"],
  "stop-color": ["stopColor"],
  "stop-opacity": ["stopOpacity"],
  overflow: ["overflowVisible"],
  "vector-effect": ["nonScalingStroke"],
  "paint-order": ["strokeFirst"],
  "white-space": ["preserveSpace"],
  "mix-blend-mode": ["blend"],
  "mask-type": ["maskType"],
  "text-align": ["textAlign"],
  "image-rendering": ["pixelated"],
  "line-height": ["lineHeight"],
};

function applyInherit(name: string, s: Style, from: Style): void {
  const keys = KEYS[name];
  if (!keys) return;
  const target = s as unknown as Record<string, unknown>;
  const source = from as unknown as Record<string, unknown>;
  for (const k of keys) target[k] = source[k];
}

/** Font family list split into names, unquoted. */
export function familyList(v: string): string[] {
  return splitTopLevel(v, ",")
    .map((f) => f.trim().replace(/^["']|["']$/g, "").trim())
    .filter((f) => f.length > 0);
}
