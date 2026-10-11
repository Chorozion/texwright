/**
 * SVG to Drawing: walks the parsed SVG tree and emits vector drawing
 * operations in points, origin at the bottom-left of the figure, y up.
 *
 * Paths are emitted already transformed into figure space whenever that is
 * exact (fills always; strokes when the transform scales uniformly).
 * Strokes under non-uniform transforms are wrapped in save/transform/restore
 * so the pen is shaped exactly as in SVG. Text becomes glyph runs shaped
 * from real fonts (see fonts.ts); rotated or skewed text is drawn under a
 * transform, and text painted with a gradient or a stroke as its outlines.
 * Clip paths become clip operations inside save/restore.
 *
 * Text can follow a path (textPath), and HTML labels in foreignObject
 * (Mermaid, draw.io) are laid out as wrapped, aligned lines of text.
 *
 * Paint is exact: colours with their opacity, linear and radial gradients
 * (stop opacity through a soft mask). An element with opacity is drawn as
 * a group, unless it paints only once (one shape with a fill or a stroke,
 * an image), when the opacity goes on that paint. Masks become soft masks
 * of a group, mix-blend-mode a group's blend mode; filters are drawn into
 * an image (filter.ts).
 */

import type { Pos } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import type { Font } from "../font/index.js";
import { type Color, type DrawOp, type Drawing, type Glyphs, type Gradient, type ImageRef, isGradient, type Paint as DrawPaint, type PathCommand } from "../layout/types.js";
import { type Box, opsBounds, pathBounds } from "./bounds.js";
import { parseStylesheet, type Rule } from "./css.js";
import { parseColor } from "./color.js";
import { splitTopLevel } from "./css.js";
import { FILTER_MAX_PIXELS, FILTER_PX_PER_PT, type FilterPrimitive, type FilterSpec, runFilter, type TransferFunction } from "./filter.js";
import { type Face, glyphFor, isInvisible, resolveFace, shapeRun } from "./fonts.js";
import { embeddedImage } from "./image.js";
import { apply, IDENTITY, invert, isSimilarity, type Matrix, multiply, parseTransform, rotate, scale, scaleOf, translate } from "./matrix.js";
import { parseNumberList } from "./num.js";
import { ellipseCommands, parsePath, parsePoints, type PathVertex, rectCommands } from "./path.js";
import {
  Cascade,
  computeStyle,
  initialStyle,
  lengthAttr,
  lengthList,
  type Paint,
  parseLength,
  parseOpacity,
  resolveLength,
  type Style,
  type Viewport,
} from "./style.js";
import { parseXml, textContent, type XmlElement } from "./xml.js";

export interface SvgOptions {
  /** Target width in points; the figure is scaled to it, keeping its aspect ratio. */
  widthPt?: number;
  /** Target height in points; with widthPt too, the figure is scaled to fit inside both. */
  heightPt?: number;
  /** Resolves an <image> href (file path or data: URL) to an image registered with the PDF writer. */
  resolveImage?: (href: string) => ImageRef | undefined;
  diagnostics?: Diagnostics;
  /** Where the figure is referenced, for diagnostics. */
  pos?: Pos;
}

/** Work caps that keep hostile files fast. */
export const SVG_LIMITS = {
  /** Elements rendered, counting every <use> and marker instance. */
  nodes: 500_000,
  /** Path commands emitted over the whole figure. */
  pathCommands: 1_000_000,
  /** Glyphs emitted over the whole figure. */
  glyphs: 500_000,
  /** Nesting of <use>, markers and clip paths. */
  refDepth: 24,
  /** Pixels drawn for filters over the whole figure. */
  filterPixels: 20_000_000,
  /** Nesting of groups (opacity, masks, blend modes); deeper ones are drawn without their effect. */
  groupDepth: 16,
};

const PX_TO_PT = 0.75;

// ---------------------------------------------------------------- diagnostics

class Reporter {
  private readonly seen = new Set<string>();
  constructor(
    private readonly diags: Diagnostics | undefined,
    private readonly pos: Pos | undefined,
  ) {}

  error(message: string, hint?: string): void {
    this.diags?.add("IMG001", message, this.pos, hint ? { hint } : undefined);
  }

  internal(message: string): void {
    this.diags?.add("INT001", message, this.pos);
  }

  /** A warning, reported once per key. */
  warn(key: string, message: string, hint?: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diags?.add("SVG001", message, this.pos, hint ? { hint } : undefined);
  }
}

// ---------------------------------------------------------------- viewBox / preserveAspectRatio

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AspectRatio {
  /** Alignment fractions (0 min, 0.5 mid, 1 max) or "none" to stretch. */
  align: "none" | [number, number];
  slice: boolean;
}

/** viewBox="minx miny width height"; undefined when absent or invalid (negative size). */
export function parseViewBox(s: string | undefined): ViewBox | undefined {
  if (s === undefined) return undefined;
  const n = parseNumberList(s, 5);
  if (n.length !== 4 || n[2] < 0 || n[3] < 0) return undefined;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

export function parseAspectRatio(s: string | undefined): AspectRatio {
  const dflt: AspectRatio = { align: [0.5, 0.5], slice: false };
  if (!s) return dflt;
  const t = s.trim().split(/\s+/);
  if (t[0] === "defer") t.shift();
  const a = t[0];
  let align: AspectRatio["align"];
  if (a === "none") align = "none";
  else {
    const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(a ?? "");
    if (!m) return dflt;
    const f = (k: string) => (k === "Min" ? 0 : k === "Mid" ? 0.5 : 1);
    align = [f(m[1]), f(m[2])];
  }
  const ms = t[1];
  if (ms !== undefined && ms !== "meet" && ms !== "slice") return dflt;
  return { align, slice: ms === "slice" };
}

/** The transform mapping a viewBox onto the viewport (x, y, w, h). */
export function viewBoxTransform(vb: ViewBox, x: number, y: number, w: number, h: number, par: AspectRatio): Matrix {
  let sx = vb.w > 0 ? w / vb.w : 1;
  let sy = vb.h > 0 ? h / vb.h : 1;
  let tx = x - vb.x * sx;
  let ty = y - vb.y * sy;
  if (par.align !== "none") {
    const s = par.slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
    tx = x - vb.x * s + (w - vb.w * s) * par.align[0];
    ty = y - vb.y * s + (h - vb.h * s) * par.align[1];
  }
  return [sx, 0, 0, sy, tx, ty];
}

// ---------------------------------------------------------------- helpers

const r4 = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};

function roundMatrix(m: Readonly<Matrix>): Matrix {
  const r6 = (v: number) => {
    const r = Math.round(v * 1e6) / 1e6;
    return r === 0 ? 0 : r;
  };
  return [r6(m[0]), r6(m[1]), r6(m[2]), r6(m[3]), r4(m[4]), r4(m[5])];
}

function roundColor(c: Color): Color {
  return [r4(c[0]), r4(c[1]), r4(c[2])];
}

function transformCmds(cmds: readonly PathCommand[], m: Readonly<Matrix>): PathCommand[] {
  const out: PathCommand[] = new Array(cmds.length);
  const [a, b, c, d, e, f] = m;
  for (let i = 0; i < cmds.length; i++) {
    const k = cmds[i];
    switch (k[0]) {
      case "M":
      case "L":
        out[i] = [k[0], r4(a * k[1] + c * k[2] + e), r4(b * k[1] + d * k[2] + f)];
        break;
      case "C":
        out[i] = [
          "C",
          r4(a * k[1] + c * k[2] + e),
          r4(b * k[1] + d * k[2] + f),
          r4(a * k[3] + c * k[4] + e),
          r4(b * k[3] + d * k[4] + f),
          r4(a * k[5] + c * k[6] + e),
          r4(b * k[5] + d * k[6] + f),
        ];
        break;
      default:
        out[i] = ["Z"];
    }
  }
  return out;
}

function rectPath(x: number, y: number, w: number, h: number, m: Readonly<Matrix>): PathCommand[] {
  return transformCmds([["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]], m);
}

function hrefOf(el: XmlElement): string | undefined {
  const h = el.attrs.get("href") ?? el.attrs.get("xlink:href");
  return h === undefined ? undefined : h.trim();
}

function isAncestor(a: XmlElement, el: XmlElement): boolean {
  for (let p: XmlElement | undefined = el; p; p = p.parent) if (p === a) return true;
  return false;
}

/** Rotates a dash pattern by an offset (the PDF ops carry no dash phase). */
function offsetDash(arr: number[], offset: number, buttCaps: boolean): number[] {
  const period = arr.reduce((s, v) => s + v, 0);
  if (!(period > 0)) return arr;
  const o = ((offset % period) + period) % period;
  if (o < 1e-9) return arr;
  let acc = 0;
  let i = 0;
  for (; i < arr.length; i++) {
    if (o < acc + arr[i]) break;
    acc += arr[i];
  }
  if (i >= arr.length) return arr;
  const t = o - acc;
  const rest = [...arr.slice(i + 1), ...arr.slice(0, i)];
  if (i % 2 === 0) return [arr[i] - t, ...rest, t, 0]; // inside a dash: zero gap joins its two halves
  if (buttCaps) return [0, arr[i] - t, ...rest, t]; // inside a gap: a zero-length dash is invisible with butt caps
  return [...arr.slice(i + 1), ...arr.slice(0, i + 1)]; // round/square caps: start at the next dash
}

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const MARKABLE = new Set(["path", "line", "polyline", "polygon"]);

interface Ctx {
  /** User space to figure space. */
  m: Matrix;
  /** Computed style of the parent, for inheritance. */
  parent: Style;
  /** Nearest viewport, for percentages. */
  vp: Viewport;
  /** Opacity still to apply to every paint (an element's opacity put on its one paint, a pattern's fill-opacity). */
  alpha: number;
  /** Elements being instantiated (use targets, markers), for cycle detection. */
  refs: XmlElement[];
  /** Resolved context-fill / context-stroke for marker contents (in figure space). */
  ctxFill?: Resolved;
  ctxStroke?: Resolved;
}

/**
 * A paint resolved for one element: a colour, or a gradient whose matrix
 * takes gradient space to the element's user space (to figure space when
 * `figure` is set).
 */
interface Resolved {
  paint: Color | Gradient;
  /** Opacity, 0..1. */
  alpha: number;
  /** The opacity of each stop of a gradient whose stops differ in it (drawn through a soft mask). */
  stopAlphas?: { offset: number; a: number }[];
  figure?: boolean;
}

/** A gradient's attributes (inherited through href) and stops. */
interface GradientSpec {
  kind: "linear" | "radial";
  attrs: Map<string, string>;
  stops: { offset: number; color: Color; a: number }[];
}

interface TChar {
  s: string;
  cp: number;
  style: Style;
  x?: number;
  y?: number;
  dx: number;
  dy: number;
}

/** A shaped run positioned in user space (baseline start). */
interface LaidRun {
  font: Font;
  size: number;
  gids: number[];
  advances: number[];
  text: string[];
  width: number;
  x: number;
  y: number;
  style: Style;
}

// ---------------------------------------------------------------- renderer

class Renderer {
  private out: DrawOp[] = [];
  private readonly ids = new Map<string, XmlElement>();
  private readonly cascade: Cascade;
  private readonly treeStyles = new Map<XmlElement, Style>();
  private readonly gradientSpecs = new Map<XmlElement, GradientSpec>();
  private nodes = 0;
  private pathCommands = 0;
  private glyphs = 0;
  private filterPixels = 0;
  private groupDepth = 0;
  private exhausted = false;
  /** Figure points per px at the root (for non-scaling strokes). */
  private k = PX_TO_PT;
  private rootVp: Viewport = { w: 300, h: 150 };

  constructor(
    private readonly root: XmlElement,
    private readonly opts: SvgOptions,
    private readonly report: Reporter,
  ) {
    const rules: Rule[] = [];
    let unsupported = 0;
    const stack: XmlElement[] = [root];
    // Document order: ids (first wins) and <style> sheets.
    const order: XmlElement[] = [];
    while (stack.length) {
      const el = stack.pop() as XmlElement;
      order.push(el);
      for (let i = el.children.length - 1; i >= 0; i--) {
        const c = el.children[i];
        if (c.type === "element") stack.push(c);
      }
    }
    for (const el of order) {
      const id = el.attrs.get("id");
      if (id !== undefined && !this.ids.has(id)) this.ids.set(id, el);
      if (el.name === "style") {
        const type = (el.attrs.get("type") ?? "text/css").trim().toLowerCase();
        if (type === "text/css" || type === "") {
          const sheet = parseStylesheet(textContent(el), rules.length, 10_000 - rules.length);
          rules.push(...sheet.rules);
          unsupported += sheet.unsupported;
        }
      }
    }
    if (unsupported) {
      report.warn("css-selectors", `SVG style sheet: ${unsupported} selector${unsupported === 1 ? "" : "s"} use unsupported syntax and were ignored`, "Supported: type, .class, #id, attribute tests, structural pseudo-classes, :not(), :is() and every combinator");
    }
    this.cascade = new Cascade(rules);
  }

  // ------------------------------------------------------------ budgets

  private tick(): boolean {
    if (this.exhausted) return false;
    if (++this.nodes > SVG_LIMITS.nodes) {
      this.stop(`more than ${SVG_LIMITS.nodes} elements to draw`);
      return false;
    }
    return true;
  }

  private stop(why: string): void {
    this.exhausted = true;
    this.report.warn("budget", `SVG is too complex: drawing stopped (${why}); the figure is incomplete`, "Simplify the figure or export it as PNG");
  }

  private chargeCommands(n: number): boolean {
    this.pathCommands += n;
    if (this.pathCommands > SVG_LIMITS.pathCommands) {
      this.stop(`more than ${SVG_LIMITS.pathCommands} path commands`);
      return false;
    }
    return true;
  }

  private emit(op: DrawOp): void {
    this.out.push(op);
  }

  private capture(fn: () => void): DrawOp[] {
    const saved = this.out;
    const tmp: DrawOp[] = [];
    this.out = tmp;
    try {
      fn();
    } finally {
      this.out = saved;
    }
    return tmp;
  }

  private append(ops: DrawOp[]): void {
    for (const op of ops) this.out.push(op);
  }

  /** Appends captured ops, clipped to a rectangle (given in the space of `m`) when they reach outside it. */
  private appendClipped(ops: DrawOp[], m: Readonly<Matrix>, x: number, y: number, w: number, h: number): void {
    if (ops.length === 0) return;
    const inv = invert(m);
    const b = inv ? opsBounds(ops, inv, { strokes: true, clips: true }) : undefined;
    // Rounding of figure coordinates (1e-4 pt) must not trigger a clip.
    const tol = 1e-3 * Math.max(w, h) + 2e-4 / Math.max(scaleOf(m), 1e-12);
    if (b && b.x0 >= x - tol && b.y0 >= y - tol && b.x1 <= x + w + tol && b.y1 <= y + h + tol) {
      this.append(ops);
      return;
    }
    this.emit({ op: "save" });
    this.emit({ op: "clip", d: rectPath(x, y, w, h, m) });
    this.append(ops);
    this.emit({ op: "restore" });
  }

  // ------------------------------------------------------------ styles

  /** Computed style of an element in its place in the document tree (markers, gradients, clip paths). */
  private treeStyle(el: XmlElement): Style {
    const c = this.treeStyles.get(el);
    if (c) return c;
    const parent = el.parent ? this.treeStyle(el.parent) : initialStyle();
    const s = computeStyle(el, parent, this.cascade, this.rootVp);
    this.treeStyles.set(el, s);
    return s;
  }

  /**
   * A paint for an element: a colour or a gradient (gradient space to user
   * space), with the paint's own opacity. `bbox` gives the element's
   * bounding box, for objectBoundingBox gradients. Undefined paints nothing.
   */
  private resolvePaint(p: Paint, style: Style, ctx: Ctx, bbox: () => Box | undefined, depth = 0): Resolved | undefined {
    switch (p.kind) {
      case "none":
        return undefined;
      case "color":
        return p.c.a <= 0 ? undefined : { paint: roundColor([p.c.r, p.c.g, p.c.b]), alpha: p.c.a };
      case "current":
        return style.color.a <= 0 ? undefined : { paint: roundColor([style.color.r, style.color.g, style.color.b]), alpha: style.color.a };
      case "context-fill":
        return ctx.ctxFill;
      case "context-stroke":
        return ctx.ctxStroke;
      case "url": {
        const el = p.id ? this.ids.get(p.id) : undefined;
        if (el && (el.name === "linearGradient" || el.name === "radialGradient")) return this.gradientPaint(el, bbox, ctx.vp);
        if (el && el.name === "pattern") {
          this.report.warn(`pattern`, `SVG patterns on strokes and text are drawn in one average colour (first one: #${p.id})`, "Fill shapes with the pattern instead, or use a solid colour");
          return { paint: this.patternColor(el), alpha: 1 };
        }
        if (p.fallback && depth < 2) return this.resolvePaint(p.fallback, style, ctx, bbox, depth + 1);
        if (!p.id) this.report.warn("paint-external", "SVG paint refers to another file; it was left unpainted", "Only references inside the same SVG (url(#id)) are followed");
        else this.report.warn(`paint-missing:${p.id}`, `SVG paint refers to #${p.id}, which is not a gradient or pattern in the file; it was left unpainted`);
        return undefined;
      }
    }
  }

  /** A fill or stroke paint with its opacity (fill-opacity or stroke-opacity, and any pending element opacity) applied. */
  private paintOf(p: Paint, opacity: number, style: Style, ctx: Ctx, bbox: () => Box | undefined): Resolved | undefined {
    const r = this.resolvePaint(p, style, ctx, bbox);
    if (!r) return undefined;
    const a = r.alpha * opacity * ctx.alpha;
    return a > 0 ? { ...r, alpha: a } : undefined;
  }

  /** A gradient's stops and attributes, each attribute from the first gradient in the href chain that has it. */
  private gradientSpec(el: XmlElement): GradientSpec {
    const cached = this.gradientSpecs.get(el);
    if (cached) return cached;
    const attrs = new Map<string, string>();
    let stopsEl: XmlElement | undefined;
    let g: XmlElement | undefined = el;
    const seen = new Set<XmlElement>();
    for (let hops = 0; g && hops < 16 && !seen.has(g); hops++) {
      seen.add(g);
      for (const [k, v] of g.attrs) if (!attrs.has(k) && k !== "id" && k !== "href" && k !== "xlink:href") attrs.set(k, v);
      if (!stopsEl && g.children.some((c) => c.type === "element" && c.name === "stop")) stopsEl = g;
      const h = hrefOf(g);
      const next = h && h.startsWith("#") ? this.ids.get(h.slice(1)) : undefined;
      g = next && (next.name === "linearGradient" || next.name === "radialGradient") ? next : undefined;
    }
    const stops: GradientSpec["stops"] = [];
    let last = 0;
    if (stopsEl) {
      for (const st of stopsEl.children) {
        if (st.type !== "element" || st.name !== "stop") continue;
        if (stops.length >= 1000) break;
        const ss = this.treeStyle(st);
        const raw = (st.attrs.get("offset") ?? "0").trim();
        let o = parseFloat(raw);
        if (!Number.isFinite(o)) o = 0;
        if (raw.endsWith("%")) o /= 100;
        o = Math.min(1, Math.max(last, o));
        last = o;
        stops.push({ offset: o, color: roundColor([ss.stopColor.r, ss.stopColor.g, ss.stopColor.b]), a: r4(ss.stopOpacity * ss.stopColor.a) });
      }
    }
    const spec: GradientSpec = { kind: el.name === "radialGradient" ? "radial" : "linear", attrs, stops };
    this.gradientSpecs.set(el, spec);
    return spec;
  }

  /** A gradient paint in user space; a colour when it has one stop or no extent; undefined when it paints nothing. */
  private gradientPaint(el: XmlElement, bbox: () => Box | undefined, vp: Viewport): Resolved | undefined {
    const { kind, attrs, stops } = this.gradientSpec(el);
    if (!stops.length) return undefined;
    const lastStop = stops[stops.length - 1];
    const solid = (st: { color: Color; a: number }): Resolved | undefined => (st.a > 0 ? { paint: st.color, alpha: st.a } : undefined);
    if (stops.length === 1) return solid(stops[0]);
    const bboxUnits = attrs.get("gradientUnits")?.trim() !== "userSpaceOnUse";
    let base: Matrix = [1, 0, 0, 1, 0, 0];
    if (bboxUnits) {
      const b = bbox();
      // A gradient sized by a box with no width or height paints nothing.
      if (!b || !(b.x1 - b.x0 > 0) || !(b.y1 - b.y0 > 0)) return undefined;
      base = [b.x1 - b.x0, 0, 0, b.y1 - b.y0, b.x0, b.y0];
    }
    const coord = (name: string, axis: "x" | "y" | "other", dflt: string): number => {
      const len = parseLength(attrs.get(name) ?? dflt) ?? (parseLength(dflt) as { v: number; unit: string });
      if (bboxUnits) return len.unit === "%" ? len.v / 100 : len.v;
      return resolveLength(len, axis, 16, vp);
    };
    const t = parseTransform(attrs.get("gradientTransform") ?? "") ?? ([1, 0, 0, 1, 0, 0] as Matrix);
    const matrix = roundMatrix(multiply(base, t));
    let coords: number[];
    if (kind === "linear") {
      coords = [coord("x1", "x", "0%"), coord("y1", "y", "0%"), coord("x2", "x", "100%"), coord("y2", "y", "0%")];
      // A gradient whose ends coincide paints its last stop.
      if (coords[0] === coords[2] && coords[1] === coords[3]) return solid(lastStop);
    } else {
      const cx = coord("cx", "x", "50%");
      const cy = coord("cy", "y", "50%");
      const r = coord("r", "other", "50%");
      if (!(r > 0)) return solid(lastStop);
      const fx = attrs.has("fx") ? coord("fx", "x", "50%") : cx;
      const fy = attrs.has("fy") ? coord("fy", "y", "50%") : cy;
      const fr = Math.max(0, Math.min(r, coord("fr", "other", "0%")));
      coords = [fx, fy, fr, cx, cy, r];
    }
    const spreadRaw = attrs.get("spreadMethod")?.trim();
    const spread: Gradient["spread"] = spreadRaw === "reflect" || spreadRaw === "repeat" ? spreadRaw : "pad";
    const gradient: Gradient = { kind, coords: coords.map(r4), matrix, stops: stops.map((st) => ({ offset: st.offset, color: st.color })), spread };
    const a0 = stops[0].a;
    if (stops.every((st) => st.a === a0)) return a0 > 0 ? { paint: gradient, alpha: a0 } : undefined;
    return { paint: gradient, alpha: 1, stopAlphas: stops.map((st) => ({ offset: st.offset, a: st.a })) };
  }

  /** The paint as drawn in the space `toFigure` maps to figure space: a gradient's matrix then takes gradient space there. */
  private paintIn(r: Resolved, userToFigure: Readonly<Matrix>, inFigure: boolean): DrawPaint {
    if (!isGradient(r.paint)) return r.paint;
    let m: Matrix = r.paint.matrix;
    if (r.figure && !inFigure) {
      const inv = invert(userToFigure);
      if (inv) m = multiply(inv, m);
    } else if (!r.figure && inFigure) m = multiply(userToFigure, m);
    return { ...r.paint, matrix: roundMatrix(m) };
  }

  /** A context paint for marker contents: the paint moved into figure space. */
  private toFigurePaint(r: Resolved | undefined, m: Readonly<Matrix>): Resolved | undefined {
    if (!r || r.figure || !isGradient(r.paint)) return r;
    return { ...r, paint: { ...r.paint, matrix: roundMatrix(multiply(m, r.paint.matrix)) }, figure: true };
  }

  /** The pattern element a fill refers to, if it is one. */
  private patternOf(p: Paint): XmlElement | undefined {
    if (p.kind !== "url" || !p.id) return undefined;
    const el = this.ids.get(p.id);
    return el && el.name === "pattern" ? el : undefined;
  }

  /** A pattern's attributes and content, following href to the patterns it inherits from. */
  private patternSpec(el: XmlElement): { attrs: Map<string, string>; content: XmlElement } {
    const attrs = new Map<string, string>();
    let content: XmlElement | undefined;
    let p: XmlElement | undefined = el;
    for (let hops = 0; p && hops < 16; hops++) {
      for (const [k, v] of p.attrs) if (!attrs.has(k)) attrs.set(k, v);
      if (!content && p.children.some((c) => c.type === "element")) content = p;
      const h = hrefOf(p);
      const next = h && h.startsWith("#") ? this.ids.get(h.slice(1)) : undefined;
      p = next && next.name === "pattern" && next !== el ? next : undefined;
    }
    return { attrs, content: content ?? el };
  }

  /**
   * Fills a shape with a pattern: the tile is drawn once, then repeated
   * (translated) over the shape's bounding box inside a clip to the shape.
   * False when it cannot be done (a cycle, too many tiles); the caller then
   * falls back to the pattern's average colour.
   */
  private fillPattern(cmds: PathCommand[], style: Style, ctx: Ctx, pat: XmlElement): boolean {
    if (ctx.refs.includes(pat) || ctx.refs.length >= SVG_LIMITS.refDepth) return false;
    if (!this.tick()) return true;
    const { attrs, content } = this.patternSpec(pat);
    const bbox = pathBounds(cmds);
    if (!bbox) return true;
    const bw = bbox.x1 - bbox.x0;
    const bh = bbox.y1 - bbox.y0;
    const bboxUnits = attrs.get("patternUnits")?.trim() !== "userSpaceOnUse";
    const num = (name: string, axis: "x" | "y"): number => {
      const raw = attrs.get(name)?.trim();
      if (!raw) return 0;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return 0;
      if (raw.endsWith("%")) return (v / 100) * (bboxUnits ? 1 : axis === "x" ? ctx.vp.w : ctx.vp.h);
      return v;
    };
    let x = num("x", "x");
    let y = num("y", "y");
    let w = num("width", "x");
    let h = num("height", "y");
    if (bboxUnits) {
      x = bbox.x0 + x * bw;
      y = bbox.y0 + y * bh;
      w *= bw;
      h *= bh;
    }
    // A zero-sized tile disables the fill.
    if (!(w > 0 && h > 0)) return true;
    const pt = parseTransform(attrs.get("patternTransform") ?? "") ?? IDENTITY;
    const inv = invert(pt);
    const pb = inv ? pathBounds(cmds, inv) : undefined;
    if (!pb) return true;
    const i0 = Math.floor((pb.x0 - x) / w);
    const i1 = Math.ceil((pb.x1 - x) / w);
    const j0 = Math.floor((pb.y0 - y) / h);
    const j1 = Math.ceil((pb.y1 - y) / h);
    const tiles = (i1 - i0) * (j1 - j0);
    if (!(tiles > 0) || tiles > 10_000) return false;
    const vb = parseViewBox(attrs.get("viewBox"));
    if (vb && (vb.w === 0 || vb.h === 0)) return true;
    const contentM: Matrix = vb
      ? viewBoxTransform(vb, 0, 0, w, h, parseAspectRatio(attrs.get("preserveAspectRatio")))
      : attrs.get("patternContentUnits")?.trim() === "objectBoundingBox"
        ? scale(bw, bh)
        : ([1, 0, 0, 1, 0, 0] as Matrix);
    // The tile at (x, y), drawn once in figure space and clipped to the tile unless overflow is visible.
    const M = multiply(ctx.m, pt);
    const base = multiply(M, translate(x, y));
    const pStyle = this.treeStyle(content);
    const sub: Ctx = { m: multiply(base, contentM), parent: pStyle, vp: vb ? { w: vb.w, h: vb.h } : { w, h }, alpha: ctx.alpha * style.fillOpacity, refs: [...ctx.refs, pat] };
    const tile = this.capture(() => {
      const ops = this.capture(() => this.renderChildren(content, sub));
      if (pStyle.overflowVisible === true) this.append(ops);
      else this.appendClipped(ops, base, 0, 0, w, h);
    });
    if (!tile.length) return true;
    const perTile = tile.reduce((n, op) => n + ("d" in op && Array.isArray(op.d) ? op.d.length : 1), 0);
    this.emit({ op: "save" });
    this.emit({ op: "clip", d: transformCmds(cmds, ctx.m), ...(style.fillRule === "evenodd" ? { evenOdd: true } : {}) });
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        if (!this.chargeCommands(perTile)) break;
        // Moving by whole tiles in pattern space is a translation in figure space.
        const dx = M[0] * i * w + M[2] * j * h;
        const dy = M[1] * i * w + M[3] * j * h;
        this.emit({ op: "save" });
        this.emit({ op: "transform", m: roundMatrix([1, 0, 0, 1, dx, dy]) });
        this.append(tile);
        this.emit({ op: "restore" });
      }
    }
    this.emit({ op: "restore" });
    return true;
  }

  /** Average fill colour of the shapes inside a pattern (grey when it has none). */
  private patternColor(el: XmlElement): Color {
    let p: XmlElement | undefined = el;
    for (let hops = 0; p && hops < 16; hops++) {
      if (p.children.some((c) => c.type === "element")) break;
      const h = hrefOf(p);
      const next = h && h.startsWith("#") ? this.ids.get(h.slice(1)) : undefined;
      p = next && next.name === "pattern" && next !== el ? next : undefined;
    }
    const acc: Color = [0, 0, 0];
    let n = 0;
    const walk = (e: XmlElement, depth: number) => {
      for (const c of e.children) {
        if (c.type !== "element" || n >= 1000 || depth > 32) continue;
        if (SHAPES.has(c.name) || c.name === "text") {
          const s = this.treeStyle(c);
          const f = s.fill.kind === "color" && s.fill.c.a > 0 ? s.fill.c : s.fill.kind === "current" ? s.color : undefined;
          if (f) {
            acc[0] += f.r;
            acc[1] += f.g;
            acc[2] += f.b;
            n++;
          }
        } else walk(c, depth + 1);
      }
    };
    if (p) walk(p, 0);
    return n ? roundColor([acc[0] / n, acc[1] / n, acc[2] / n]) : [0.5, 0.5, 0.5];
  }

  // ------------------------------------------------------------ entry

  run(): Drawing {
    const root = this.root;
    const rootStyle0 = computeStyle(root, initialStyle(), this.cascade, this.rootVp);
    const fs = rootStyle0.fontSize;
    const vb = parseViewBox(root.attrs.get("viewBox"));
    const par = parseAspectRatio(root.attrs.get("preserveAspectRatio"));
    const dim = (name: string, ref: number | undefined): number | undefined => {
      const raw = root.attrs.get(name);
      if (raw === undefined || raw.trim() === "auto") return undefined;
      const len = parseLength(raw);
      if (!len) return undefined;
      if (len.unit === "%") return ref === undefined ? undefined : (len.v * ref) / 100;
      return resolveLength(len, "other", fs, { w: 0, h: 0 });
    };
    let w = dim("width", vb?.w);
    let h = dim("height", vb?.h);
    if (vb && vb.w > 0 && vb.h > 0) {
      if (w === undefined && h === undefined) {
        w = vb.w;
        h = vb.h;
      } else if (w === undefined && h !== undefined) w = (h * vb.w) / vb.h;
      else if (h === undefined && w !== undefined) h = (w * vb.h) / vb.w;
    }
    if (w === undefined || h === undefined) {
      // No viewBox and no size: measure the content (in px) and use its extent.
      const mw = w ?? 300;
      const mh = h ?? 150;
      this.rootVp = { w: mw, h: mh };
      const ops = this.capture(() => this.renderRootContent(root, IDENTITY as Matrix, undefined, par, mw, mh));
      const b = opsBounds(ops, IDENTITY, { strokes: true });
      w ??= b ? Math.max(1, Math.ceil(b.x1)) : 300;
      h ??= b ? Math.max(1, Math.ceil(b.y1)) : 150;
      this.nodes = 0;
      this.pathCommands = 0;
      this.glyphs = 0;
      this.filterPixels = 0;
      this.exhausted = false;
    }
    if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
      this.report.warn("size", "SVG has zero or negative width or height; nothing was drawn");
      return { t: "drawing", ops: [], width: 0, height: 0, depth: 0 };
    }
    // Scale to the requested size.
    let u = 1;
    const wantW = this.opts.widthPt;
    const wantH = this.opts.heightPt;
    const natW = w * PX_TO_PT;
    const natH = h * PX_TO_PT;
    const okW = wantW !== undefined && Number.isFinite(wantW) && wantW > 0;
    const okH = wantH !== undefined && Number.isFinite(wantH) && wantH > 0;
    if (okW && okH) u = Math.min((wantW as number) / natW, (wantH as number) / natH);
    else if (okW) u = (wantW as number) / natW;
    else if (okH) u = (wantH as number) / natH;
    this.k = PX_TO_PT * u;
    const outW = natW * u;
    const outH = natH * u;
    const R: Matrix = [this.k, 0, 0, -this.k, 0, outH];
    this.rootVp = vb && vb.w > 0 && vb.h > 0 ? { w: vb.w, h: vb.h } : { w, h };
    this.treeStyles.clear();
    const ops = this.capture(() => this.renderRootContent(root, R, vb, par, w as number, h as number));
    // Clip to the figure only when something reaches outside it.
    const b = opsBounds(ops, IDENTITY, { strokes: true, clips: true });
    const tol = 0.01;
    if (b && (b.x0 < -tol || b.y0 < -tol || b.x1 > outW + tol || b.y1 > outH + tol)) {
      ops.unshift({ op: "save" }, { op: "clip", d: [["M", 0, 0], ["L", r4(outW), 0], ["L", r4(outW), r4(outH)], ["L", 0, r4(outH)], ["Z"]] });
      ops.push({ op: "restore" });
    }
    return { t: "drawing", ops, width: outW, height: outH, depth: 0 };
  }

  private renderRootContent(root: XmlElement, R: Matrix, vb: ViewBox | undefined, par: AspectRatio, w: number, h: number): void {
    const ctx: Ctx = { m: R, parent: initialStyle(), vp: { w, h }, alpha: 1, refs: [] };
    this.withElement(root, ctx, (_style, inner) => {
      if (vb && (vb.w === 0 || vb.h === 0)) return; // a zero-size viewBox disables rendering
      const m = vb ? multiply(inner.m, viewBoxTransform(vb, 0, 0, w, h, par)) : inner.m;
      const vp = vb ? { w: vb.w, h: vb.h } : { w, h };
      this.renderChildren(root, { ...inner, m, vp });
    });
  }

  // ------------------------------------------------------------ structure

  /**
   * The common part of rendering any element: computed style, display,
   * transform, and the effects SVG applies in this order: filter, clip-path,
   * mask, then opacity and mix-blend-mode. `body` gets the element's style
   * and the context for its own drawing and its children.
   */
  private withElement(el: XmlElement, ctx: Ctx, body: (style: Style, inner: Ctx) => void): void {
    if (!this.tick()) return;
    const style = computeStyle(el, ctx.parent, this.cascade, ctx.vp);
    if (!style.display) return;
    let m = ctx.m;
    const tr = el.attrs.get("transform");
    if (tr !== undefined) {
      const t = parseTransform(tr);
      if (t) m = multiply(ctx.m, t);
      else this.report.warn(`transform:${tr.slice(0, 40)}`, `SVG transform "${tr.slice(0, 60)}" is malformed and was ignored`);
    }
    if (style.opacity <= 0) return;
    // Opacity on an element that paints once is that paint's opacity; otherwise the element is a group.
    const fold = style.opacity < 1 && this.foldsOpacity(el, style);
    const inner: Ctx = { ...ctx, m, parent: style, alpha: fold ? ctx.alpha * style.opacity : ctx.alpha };
    let clip: DrawOp[] | undefined;
    if (style.clipPath) {
      const c = this.clipOps(style.clipPath, el, style, inner, 0);
      if (c === "hidden") return;
      clip = c;
    }
    const opacity = fold ? 1 : style.opacity;
    const effects = !!style.filter || !!style.mask || !!style.blend || opacity < 1;
    if (effects && this.groupDepth >= SVG_LIMITS.groupDepth) {
      this.report.warn("group-depth", `SVG groups with opacity, masks, filters or blend modes nest more than ${SVG_LIMITS.groupDepth} deep; the deeper ones are drawn without them`);
    }
    if (!effects || this.groupDepth >= SVG_LIMITS.groupDepth) {
      if (clip) {
        this.emit({ op: "save" });
        for (const c of clip) this.emit(c);
      }
      body(style, inner);
      if (clip) this.emit({ op: "restore" });
      return;
    }
    this.groupDepth++;
    let ops: DrawOp[];
    try {
      ops = this.capture(() => body(style, inner));
    } finally {
      this.groupDepth--;
    }
    if (style.filter) ops = this.applyFilter(style.filter, el, style, inner, ops);
    if (clip && ops.length) ops = [{ op: "save" }, ...clip, ...ops, { op: "restore" }];
    let mask: { ops: DrawOp[]; luminance: boolean } | undefined;
    if (style.mask) {
      const mk = this.maskOps(style.mask, el, style, inner);
      if (mk === "hidden") return;
      mask = mk;
    }
    if (!mask && !style.blend && opacity >= 1) {
      this.append(ops);
      return;
    }
    const bbox = this.groupBox(ops);
    if (!bbox) return;
    this.emit({ op: "group", ops, bbox, ...(opacity < 1 ? { opacity: r4(opacity) } : {}), ...(style.blend ? { blend: style.blend } : {}), ...(mask ? { mask } : {}) });
  }

  /**
   * The element's ops with its filter applied: each filter of the list in
   * turn draws what it gets into an image (filter.ts). A reference to
   * something that is not a filter leaves the element unfiltered.
   */
  private applyFilter(value: string, el: XmlElement, style: Style, ctx: Ctx, ops: DrawOp[]): DrawOp[] {
    if (!ops.length) return ops;
    const items = parseFilterList(value);
    if (!items) {
      this.report.warn(`filter-syntax:${value.slice(0, 40)}`, `SVG filter "${value.slice(0, 60)}" could not be read; the element was drawn without it`);
      return ops;
    }
    for (const item of items) {
      let spec: FilterSpec | "hidden" | undefined;
      if (item.url !== undefined) spec = this.filterSpec(item.url, el, style, ctx);
      else spec = this.functionFilter(item.name, item.args, ops, ctx);
      if (spec === "hidden") return [];
      if (!spec) continue;
      const k = FILTER_PX_PER_PT * scaleOf(ctx.m);
      const cost = Math.min(FILTER_MAX_PIXELS, spec.width * spec.height * k * k);
      if (this.filterPixels + cost > SVG_LIMITS.filterPixels) {
        this.report.warn("filter-budget", `SVG filters would draw more than ${SVG_LIMITS.filterPixels / 1e6} million pixels; the rest of the figure is drawn without them`);
        return ops;
      }
      this.filterPixels += cost;
      const r = runFilter(spec, ops, ctx.m);
      for (const t of r.unsupported) this.report.warn(`filter-primitive:${t}`, `SVG filter primitive <${t}> is not supported; it passes its input through unchanged`);
      if (r.droppedImages) this.report.warn("filter-images", "Images from files inside a filtered SVG element are left out of the filter's result", "Embed the image as a data: URL");
      ops = r.ops;
      if (!ops.length) break;
    }
    return ops;
  }

  /** A <filter> element as a FilterSpec for an element; "hidden" when its region is empty. */
  private filterSpec(id: string, el: XmlElement, style: Style, ctx: Ctx): FilterSpec | "hidden" | undefined {
    const f = id ? this.ids.get(id) : undefined;
    if (!f || f.name !== "filter") {
      this.report.warn(`filter-missing:${id}`, `SVG filter refers to ${id ? `#${id}` : "another file"}, which is not a filter in the file; the element was drawn without it`);
      return undefined;
    }
    const fStyle = this.treeStyle(f);
    const bboxUnits = f.attrs.get("filterUnits")?.trim() !== "userSpaceOnUse";
    const primBox = f.attrs.get("primitiveUnits")?.trim() === "objectBoundingBox";
    let bb: Box | undefined;
    if (bboxUnits || primBox) {
      bb = this.bbox(el, style, ctx.vp, 0);
      if (!bb || !(bb.x1 > bb.x0 && bb.y1 > bb.y0)) return "hidden";
    }
    const len = (name: string, axis: "x" | "y", dflt: string): number => {
      const l = parseLength(f.attrs.get(name) ?? dflt) ?? (parseLength(dflt) as { v: number; unit: string });
      if (bboxUnits && bb) {
        const frac = l.unit === "%" ? l.v / 100 : l.v;
        return axis === "x" ? (name === "x" ? bb.x0 : 0) + frac * (bb.x1 - bb.x0) : (name === "y" ? bb.y0 : 0) + frac * (bb.y1 - bb.y0);
      }
      return resolveLength(l, axis, fStyle.fontSize, ctx.vp);
    };
    const spec: FilterSpec = {
      x: len("x", "x", "-10%"),
      y: len("y", "y", "-10%"),
      width: len("width", "x", "120%"),
      height: len("height", "y", "120%"),
      unitX: primBox && bb ? bb.x1 - bb.x0 : 1,
      unitY: primBox && bb ? bb.y1 - bb.y0 : 1,
      primitives: [],
    };
    if (!(spec.width > 0 && spec.height > 0)) return "hidden";
    const linearOf = (e: XmlElement): boolean => {
      for (let p: XmlElement | undefined = e; p; p = p.parent) {
        const v = this.cascade.specified(p).get("color-interpolation-filters")?.trim().toLowerCase();
        if (v === "srgb") return false;
        if (v === "linearrgb") return true;
        if (v === "auto") return false;
      }
      return true;
    };
    for (const c of f.children) {
      if (c.type !== "element" || !c.name.startsWith("fe")) continue;
      if (spec.primitives.length >= 64) break;
      const p: FilterPrimitive = { type: c.name, attrs: c.attrs, linear: linearOf(c) };
      const a = (n: string) => c.attrs.get(n)?.trim();
      p.in = a("in");
      p.in2 = a("in2");
      p.result = a("result");
      if (c.name === "feFlood" || c.name === "feDropShadow") {
        const spec2 = this.cascade.specified(c);
        const raw = spec2.get("flood-color");
        const parsed = raw === undefined ? undefined : parseColor(raw);
        const col = parsed === "currentColor" ? this.treeStyle(c).color : (parsed ?? { r: 0, g: 0, b: 0, a: 1 });
        const op = spec2.get("flood-opacity");
        const o = op === undefined ? 1 : (parseOpacity(op) ?? 1);
        p.flood = [col.r, col.g, col.b, col.a * o];
      }
      if (c.name === "feMerge") p.merge = c.children.filter((n): n is XmlElement => n.type === "element" && n.name === "feMergeNode").map((n) => n.attrs.get("in")?.trim());
      if (c.name === "feComponentTransfer") {
        p.funcs = {};
        for (const fn of c.children) {
          if (fn.type !== "element") continue;
          const m = /^feFunc([RGBA])$/.exec(fn.name);
          if (!m) continue;
          const nums = (n: string, d: number) => {
            const v = Number(fn.attrs.get(n)?.trim());
            return Number.isFinite(v) ? v : d;
          };
          const type = (fn.attrs.get("type") ?? "identity").trim();
          p.funcs[m[1] as "R" | "G" | "B" | "A"] = {
            type: type === "table" || type === "discrete" || type === "linear" || type === "gamma" ? type : "identity",
            values: (fn.attrs.get("tableValues") ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite),
            slope: nums("slope", 1),
            intercept: nums("intercept", 0),
            amplitude: nums("amplitude", 1),
            exponent: nums("exponent", 1),
            offset: nums("offset", 0),
          };
        }
      }
      spec.primitives.push(p);
    }
    // A filter without primitives makes the element transparent.
    if (!spec.primitives.length) return "hidden";
    return spec;
  }

  /** A CSS filter function (blur(), drop-shadow(), grayscale(), ...) as a filter over the drawn ops. */
  private functionFilter(name: string, args: string, ops: DrawOp[], ctx: Ctx): FilterSpec | undefined {
    const inv = invert(ctx.m);
    const b = inv ? opsBounds(ops, inv, { strokes: true, clips: true, joins: true }) : undefined;
    if (!b) return undefined;
    const vp = ctx.vp;
    const lengthOf = (t: string | undefined, dflt = 0) => {
      const l = t ? parseLength(t) : undefined;
      return l ? resolveLength(l, "other", 16, vp) : dflt;
    };
    const amount = (t: string, dflt: number) => {
      const v = t.trim();
      if (!v) return dflt;
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return dflt;
      return v.endsWith("%") ? n / 100 : n;
    };
    const attrs = (o: Record<string, string>) => new Map(Object.entries(o));
    const prim = (type: string, a: Record<string, string>, extra: Partial<FilterPrimitive> = {}): FilterPrimitive => ({ type, attrs: attrs(a), linear: false, ...extra });
    const fn = (t: TransferFunction["type"], o: Partial<TransferFunction>): TransferFunction => ({ type: t, values: [], slope: 1, intercept: 0, amplitude: 1, exponent: 1, offset: 0, ...o });
    let margin = 0;
    let primitives: FilterPrimitive[];
    switch (name) {
      case "blur": {
        const s = lengthOf(args.trim(), 0);
        margin = 3 * s;
        primitives = [prim("feGaussianBlur", { stdDeviation: String(s) })];
        break;
      }
      case "drop-shadow": {
        // Lengths and a colour in any order: offset-x offset-y [blur radius].
        const parts = splitTopLevel(args.trim().replace(/\s+/g, " "), " ").filter(Boolean);
        const lens: number[] = [];
        let color: [number, number, number, number] = [0, 0, 0, 1];
        for (const part of parts) {
          const l = parseLength(part);
          if (l) lens.push(resolveLength(l, "other", 16, vp));
          else {
            const c = parseColor(part);
            if (c && c !== "currentColor") color = [c.r, c.g, c.b, c.a];
          }
        }
        const [dx = 0, dy = 0, radius = 0] = lens;
        margin = 1.5 * radius + Math.max(Math.abs(dx), Math.abs(dy));
        primitives = [prim("feDropShadow", { dx: String(dx), dy: String(dy), stdDeviation: String(radius / 2) }, { flood: color })];
        break;
      }
      case "grayscale":
        primitives = [prim("feColorMatrix", { type: "saturate", values: String(1 - Math.min(1, amount(args, 1))) })];
        break;
      case "saturate":
        primitives = [prim("feColorMatrix", { type: "saturate", values: String(amount(args, 1)) })];
        break;
      case "hue-rotate": {
        const m = /^\s*([+-]?[\d.]+)(deg|rad|turn|grad)?\s*$/.exec(args);
        const v = m ? Number(m[1]) : 0;
        const deg = m?.[2] === "rad" ? (v * 180) / Math.PI : m?.[2] === "turn" ? v * 360 : m?.[2] === "grad" ? v * 0.9 : v;
        primitives = [prim("feColorMatrix", { type: "hueRotate", values: String(deg) })];
        break;
      }
      case "sepia": {
        const a = 1 - Math.min(1, amount(args, 1));
        const v = [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0, 0, 0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0, 0, 0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0, 0, 0, 0, 0, 1, 0];
        primitives = [prim("feColorMatrix", { type: "matrix", values: v.join(" ") })];
        break;
      }
      case "invert": {
        const a = Math.min(1, amount(args, 1));
        const f = fn("table", { values: [a, 1 - a] });
        primitives = [prim("feComponentTransfer", {}, { funcs: { R: f, G: f, B: f } })];
        break;
      }
      case "opacity":
        primitives = [prim("feComponentTransfer", {}, { funcs: { A: fn("table", { values: [0, Math.min(1, amount(args, 1))] }) } })];
        break;
      case "brightness": {
        const f = fn("linear", { slope: amount(args, 1) });
        primitives = [prim("feComponentTransfer", {}, { funcs: { R: f, G: f, B: f } })];
        break;
      }
      case "contrast": {
        const c = amount(args, 1);
        const f = fn("linear", { slope: c, intercept: 0.5 - 0.5 * c });
        primitives = [prim("feComponentTransfer", {}, { funcs: { R: f, G: f, B: f } })];
        break;
      }
      default:
        this.report.warn(`filter-fn:${name}`, `SVG filter function ${name}() is not supported; the element was drawn without it`);
        return undefined;
    }
    const pad = margin + 2 / Math.max(scaleOf(ctx.m), 1e-9);
    return { x: b.x0 - pad, y: b.y0 - pad, width: b.x1 - b.x0 + 2 * pad, height: b.y1 - b.y0 + 2 * pad, unitX: 1, unitY: 1, primitives };
  }

  /** True when an element with opacity paints exactly once, so the opacity can go on that paint. */
  private foldsOpacity(el: XmlElement, style: Style): boolean {
    if (style.filter || style.mask || style.blend) return false;
    if (el.name === "image") return true;
    const fill = style.fill.kind !== "none";
    const stroke = style.stroke.kind !== "none" && style.strokeWidth > 0;
    if (SHAPES.has(el.name)) {
      if (MARKABLE.has(el.name) && (style.markerStart || style.markerMid || style.markerEnd)) return false;
      if (el.name === "line") return true;
      if (fill && this.patternOf(style.fill)) return false;
      return !(fill && stroke);
    }
    if (el.name === "text") return !stroke && !el.children.some((c) => c.type === "element");
    return false;
  }

  /** The box a group of ops covers (strokes, joins and a pixel of anti-aliasing included), [x0, y0, x1, y1]. */
  private groupBox(ops: DrawOp[]): [number, number, number, number] | undefined {
    const b = opsBounds(ops, IDENTITY, { strokes: true, clips: true, joins: true });
    if (!b || !(b.x1 >= b.x0 && b.y1 >= b.y0)) return undefined;
    const pad = 1;
    return [r4(b.x0 - pad), r4(b.y0 - pad), r4(b.x1 + pad), r4(b.y1 + pad)];
  }

  /** The content of `mask: url(#id)` for an element, as soft mask ops; "hidden" when the mask hides everything. */
  private maskOps(id: string, el: XmlElement, style: Style, ctx: Ctx): { ops: DrawOp[]; luminance: boolean } | "hidden" | undefined {
    const mk = this.ids.get(id);
    if (!mk || mk.name !== "mask") {
      this.report.warn(`mask-missing:${id}`, `SVG mask refers to #${id}, which is not a mask in the file; the element was drawn unmasked`);
      return undefined;
    }
    if (ctx.refs.includes(mk) || ctx.refs.length >= SVG_LIMITS.refDepth) return undefined;
    const mStyle = this.treeStyle(mk);
    const bboxUnits = mk.attrs.get("maskUnits")?.trim() !== "userSpaceOnUse";
    const contentBox = mk.attrs.get("maskContentUnits")?.trim() === "objectBoundingBox";
    let bb: Box | undefined;
    if (bboxUnits || contentBox) {
      bb = this.bbox(el, style, ctx.vp, 0);
      if (!bb || !(bb.x1 > bb.x0 && bb.y1 > bb.y0)) return "hidden";
    }
    const len = (name: string, axis: "x" | "y", dflt: string): number => {
      const l = parseLength(mk.attrs.get(name) ?? dflt) ?? (parseLength(dflt) as { v: number; unit: string });
      if (bboxUnits && bb) {
        const f = l.unit === "%" ? l.v / 100 : l.v;
        return axis === "x" ? (name === "x" ? bb.x0 : 0) + f * (bb.x1 - bb.x0) : (name === "y" ? bb.y0 : 0) + f * (bb.y1 - bb.y0);
      }
      return resolveLength(l, axis, mStyle.fontSize, ctx.vp);
    };
    const x = len("x", "x", "-10%");
    const y = len("y", "y", "-10%");
    const w = len("width", "x", "120%");
    const h = len("height", "y", "120%");
    if (!(w > 0 && h > 0)) return "hidden";
    const cm = contentBox && bb ? multiply(ctx.m, [bb.x1 - bb.x0, 0, 0, bb.y1 - bb.y0, bb.x0, bb.y0]) : ctx.m;
    const sub: Ctx = { m: cm, parent: mStyle, vp: ctx.vp, alpha: 1, refs: [...ctx.refs, mk] };
    const ops = this.capture(() => {
      const content = this.capture(() => this.renderChildren(mk, sub));
      this.appendClipped(content, ctx.m, x, y, w, h);
    });
    return { ops, luminance: mStyle.maskType !== "alpha" };
  }

  private renderChildren(el: XmlElement, ctx: Ctx): void {
    for (const c of el.children) {
      if (this.exhausted) return;
      if (c.type === "element") this.renderNode(c, ctx);
    }
  }

  private renderNode(el: XmlElement, ctx: Ctx): void {
    switch (el.name) {
      case "g":
      case "a":
        this.withElement(el, ctx, (_s, inner) => this.renderChildren(el, inner));
        return;
      case "svg":
        this.renderViewport(el, ctx, undefined, undefined);
        return;
      case "switch":
        this.withElement(el, ctx, (_s, inner) => {
          for (const c of el.children) {
            if (c.type === "element" && this.switchAccepts(c)) {
              this.renderNode(c, inner);
              break;
            }
          }
        });
        return;
      case "use":
        this.renderUse(el, ctx);
        return;
      case "path":
      case "rect":
      case "circle":
      case "ellipse":
      case "line":
      case "polyline":
      case "polygon":
        this.renderShape(el, ctx);
        return;
      case "text":
        this.renderText(el, ctx);
        return;
      case "image":
        this.renderImage(el, ctx);
        return;
      case "foreignObject":
        this.renderForeignObject(el, ctx);
        return;
      default:
        return; // defs, symbol, marker, clipPath, mask, gradients, pattern, style, title, desc, metadata, script, ...
    }
  }

  private switchAccepts(el: XmlElement): boolean {
    if (el.name === "foreignObject" || el.name === "title" || el.name === "desc" || el.name === "metadata") return false;
    const ext = el.attrs.get("requiredExtensions");
    if (ext !== undefined && ext.trim() !== "") return false;
    const feat = el.attrs.get("requiredFeatures");
    if (feat !== undefined && /extensibility/i.test(feat)) return false;
    const lang = el.attrs.get("systemLanguage");
    if (lang !== undefined && !lang.split(",").some((l) => /^\s*en\b/i.test(l))) return false;
    return true;
  }

  /** A nested <svg> (or a <symbol> instantiated by <use>) with its own viewport. */
  private renderViewport(el: XmlElement, ctx: Ctx, wOverride: number | undefined, hOverride: number | undefined): void {
    this.withElement(el, ctx, (style, inner) => {
      const fs = style.fontSize;
      const isSymbol = el.name === "symbol";
      const x = isSymbol ? 0 : lengthAttr(el, "x", "x", fs, ctx.vp, 0);
      const y = isSymbol ? 0 : lengthAttr(el, "y", "y", fs, ctx.vp, 0);
      const w = wOverride ?? lengthAttr(el, "width", "x", fs, ctx.vp, ctx.vp.w);
      const h = hOverride ?? lengthAttr(el, "height", "y", fs, ctx.vp, ctx.vp.h);
      if (!(w > 0 && h > 0)) return;
      const vb = parseViewBox(el.attrs.get("viewBox"));
      if (vb && (vb.w === 0 || vb.h === 0)) return;
      const par = parseAspectRatio(el.attrs.get("preserveAspectRatio"));
      const base = multiply(inner.m, translate(x, y));
      const m = vb ? multiply(base, viewBoxTransform(vb, 0, 0, w, h, par)) : base;
      const sub: Ctx = { ...inner, m, vp: vb ? { w: vb.w, h: vb.h } : { w, h } };
      if (style.overflowVisible === true) {
        this.renderChildren(el, sub);
        return;
      }
      const ops = this.capture(() => this.renderChildren(el, sub));
      this.appendClipped(ops, base, 0, 0, w, h);
    });
  }

  private renderUse(el: XmlElement, ctx: Ctx): void {
    const href = hrefOf(el);
    if (!href) return;
    if (!href.startsWith("#")) {
      this.report.warn("use-external", `SVG <use> refers to another file (${href.slice(0, 80)}); it was left out`, "Only references inside the same SVG (#id) are followed");
      return;
    }
    const target = this.ids.get(href.slice(1));
    if (!target) {
      this.report.warn(`use-missing:${href}`, `SVG <use> refers to ${href.slice(0, 80)}, which is not in the file`);
      return;
    }
    if (ctx.refs.length >= SVG_LIMITS.refDepth || ctx.refs.includes(target) || isAncestor(target, el)) {
      this.report.warn("use-cycle", `SVG <use> elements refer to each other in a cycle or nest too deeply; the repeated part was left out`);
      return;
    }
    this.withElement(el, ctx, (style, inner) => {
      const fs = style.fontSize;
      const x = lengthAttr(el, "x", "x", fs, ctx.vp, 0);
      const y = lengthAttr(el, "y", "y", fs, ctx.vp, 0);
      const sub: Ctx = { ...inner, m: multiply(inner.m, translate(x, y)), refs: [...inner.refs, target] };
      if (target.name === "symbol" || target.name === "svg") {
        const w = lengthAttr(el, "width", "x", fs, ctx.vp);
        const h = lengthAttr(el, "height", "y", fs, ctx.vp);
        if (target.name === "symbol") {
          const tw = w ?? lengthAttr(target, "width", "x", fs, ctx.vp, ctx.vp.w);
          const th = h ?? lengthAttr(target, "height", "y", fs, ctx.vp, ctx.vp.h);
          this.renderViewport(target, sub, tw, th);
        } else this.renderViewport(target, sub, w, h);
      } else this.renderNode(target, sub);
    });
  }

  // ------------------------------------------------------------ clip paths

  /** Clip operations for `clip-path: url(#id)` on an element, "hidden" when the clip region is empty. */
  private clipOps(id: string, el: XmlElement, elStyle: Style, ctx: Ctx, depth: number): DrawOp[] | "hidden" | undefined {
    const cp = this.ids.get(id);
    if (!cp || cp.name !== "clipPath") {
      this.report.warn(`clip-missing:${id}`, `SVG clip-path refers to #${id}, which is not a clipPath in the file; the element was drawn unclipped`);
      return undefined;
    }
    if (depth > 8 || ctx.refs.includes(cp)) return undefined;
    const cpStyle = this.treeStyle(cp);
    let base = ctx.m;
    if (cp.attrs.get("clipPathUnits")?.trim() === "objectBoundingBox") {
      const bb = this.bbox(el, elStyle, ctx.vp, 0);
      if (!bb || bb.x1 <= bb.x0 || bb.y1 <= bb.y0) return "hidden";
      base = multiply(base, [bb.x1 - bb.x0, 0, 0, bb.y1 - bb.y0, bb.x0, bb.y0]);
    }
    const tr = cp.attrs.get("transform");
    if (tr) {
      const t = parseTransform(tr);
      if (t) base = multiply(base, t);
    }
    const shapes: { d: PathCommand[]; evenOdd: boolean }[] = [];
    const add = (child: XmlElement, parentStyle: Style, m: Matrix, level: number) => {
      if (!this.tick()) return;
      const s = computeStyle(child, parentStyle, this.cascade, ctx.vp);
      if (!s.display || !s.visible) return;
      let mm = m;
      const ctr = child.attrs.get("transform");
      if (ctr) {
        const t = parseTransform(ctr);
        if (t) mm = multiply(m, t);
      }
      if (SHAPES.has(child.name)) {
        const geo = this.geometry(child, s, ctx.vp, false);
        if (geo && this.chargeCommands(geo.cmds.length)) shapes.push({ d: transformCmds(geo.cmds, mm), evenOdd: s.clipRule === "evenodd" });
      } else if (child.name === "use" && level === 0) {
        const href = hrefOf(child);
        const target = href && href.startsWith("#") ? this.ids.get(href.slice(1)) : undefined;
        if (target && target !== cp && !isAncestor(target, child)) {
          const x = lengthAttr(child, "x", "x", s.fontSize, ctx.vp, 0);
          const y = lengthAttr(child, "y", "y", s.fontSize, ctx.vp, 0);
          add(target, s, multiply(mm, translate(x, y)), 1);
        }
      } else if (child.name === "text") {
        // Text clips with its glyph outlines.
        for (const r of this.layoutText(child, s, ctx.vp, false)) {
          if (!r.style.visible || !r.gids.length) continue;
          const o = this.runOutline(r);
          if (o.length && this.chargeCommands(o.length)) shapes.push({ d: transformCmds(o, mm), evenOdd: false });
        }
      }
    };
    for (const c of cp.children) if (c.type === "element") add(c, cpStyle, base, 0);
    if (shapes.length === 0) return "hidden";
    const ops: DrawOp[] = [];
    if (cpStyle.clipPath) {
      const inner = this.clipOps(cpStyle.clipPath, el, elStyle, { ...ctx, refs: [...ctx.refs, cp] }, depth + 1);
      if (inner === "hidden") return "hidden";
      if (inner) ops.push(...inner);
    }
    if (shapes.length === 1) ops.push({ op: "clip", d: shapes[0].d, ...(shapes[0].evenOdd ? { evenOdd: true } : {}) });
    else {
      // Several shapes: their union, approximated by one nonzero path.
      const d: PathCommand[] = [];
      for (const s of shapes) for (const c of s.d) d.push(c);
      ops.push({ op: "clip", d });
    }
    return ops;
  }

  /** Object bounding box of an element in its own user space (for objectBoundingBox units). */
  private bbox(el: XmlElement, style: Style, vp: Viewport, depth: number): Box | undefined {
    if (depth > 32) return undefined;
    if (SHAPES.has(el.name)) {
      const geo = this.geometry(el, style, vp, false);
      return geo ? pathBounds(geo.cmds) : undefined;
    }
    if (el.name === "text") return runsBox(this.layoutText(el, style, vp, false));
    if (el.name === "image") {
      const x = lengthAttr(el, "x", "x", style.fontSize, vp, 0);
      const y = lengthAttr(el, "y", "y", style.fontSize, vp, 0);
      const w = lengthAttr(el, "width", "x", style.fontSize, vp, 0);
      const h = lengthAttr(el, "height", "y", style.fontSize, vp, 0);
      return { x0: x, y0: y, x1: x + w, y1: y + h };
    }
    if (el.name === "g" || el.name === "a" || el.name === "svg" || el.name === "switch" || el.name === "use") {
      let kids: { el: XmlElement; m: Matrix }[] = [];
      if (el.name === "use") {
        const href = hrefOf(el);
        const t = href && href.startsWith("#") ? this.ids.get(href.slice(1)) : undefined;
        if (!t || isAncestor(t, el)) return undefined;
        const x = lengthAttr(el, "x", "x", style.fontSize, vp, 0);
        const y = lengthAttr(el, "y", "y", style.fontSize, vp, 0);
        kids = [{ el: t, m: translate(x, y) }];
      } else {
        for (const c of el.children) if (c.type === "element") kids.push({ el: c, m: [1, 0, 0, 1, 0, 0] });
      }
      let b: Box | undefined;
      for (const k of kids.slice(0, 10_000)) {
        const s = computeStyle(k.el, style, this.cascade, vp);
        if (!s.display) continue;
        let m = k.m;
        const tr = k.el.attrs.get("transform");
        if (tr) {
          const t = parseTransform(tr);
          if (t) m = multiply(m, t);
        }
        const kb = this.bbox(k.el, s, vp, depth + 1);
        if (!kb) continue;
        for (const [x, y] of [
          [kb.x0, kb.y0],
          [kb.x1, kb.y0],
          [kb.x0, kb.y1],
          [kb.x1, kb.y1],
        ]) {
          const p = apply(m, x, y);
          b = union(b, { x0: p[0], y0: p[1], x1: p[0], y1: p[1] });
        }
      }
      return b;
    }
    return undefined;
  }

  // ------------------------------------------------------------ shapes

  /** Geometry of a basic shape or path in user space; undefined when it draws nothing. */
  private geometry(el: XmlElement, style: Style, vp: Viewport, wantVertices: boolean): { cmds: PathCommand[]; vertices?: PathVertex[] } | undefined {
    const fs = style.fontSize;
    const L = (name: string, axis: "x" | "y" | "other") => lengthAttr(el, name, axis, fs, vp, 0);
    const budget = Math.max(0, SVG_LIMITS.pathCommands - this.pathCommands);
    switch (el.name) {
      case "path": {
        const d = el.attrs.get("d");
        if (!d) return undefined;
        const p = parsePath(d, { vertices: wantVertices, maxCommands: budget });
        if (p.error) this.report.warn("path-error", `SVG path data has an error (${p.error}); the path was drawn up to it`);
        if (p.truncated) this.stop(`more than ${SVG_LIMITS.pathCommands} path commands`);
        return p.cmds.length ? { cmds: p.cmds, vertices: p.vertices } : undefined;
      }
      case "rect": {
        const w = L("width", "x");
        const h = L("height", "y");
        if (!(w > 0 && h > 0)) return undefined;
        let rx = lengthAttr(el, "rx", "x", fs, vp);
        let ry = lengthAttr(el, "ry", "y", fs, vp);
        if (rx !== undefined && rx < 0) rx = undefined;
        if (ry !== undefined && ry < 0) ry = undefined;
        if (rx === undefined) rx = ry ?? 0;
        if (ry === undefined) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        return { cmds: rectCommands(L("x", "x"), L("y", "y"), w, h, rx, ry) };
      }
      case "circle": {
        const r = L("r", "other");
        if (!(r > 0)) return undefined;
        return { cmds: ellipseCommands(L("cx", "x"), L("cy", "y"), r, r) };
      }
      case "ellipse": {
        let rx = lengthAttr(el, "rx", "x", fs, vp);
        let ry = lengthAttr(el, "ry", "y", fs, vp);
        if (rx === undefined) rx = ry;
        if (ry === undefined) ry = rx;
        if (!(rx !== undefined && ry !== undefined && rx > 0 && ry > 0)) return undefined;
        return { cmds: ellipseCommands(L("cx", "x"), L("cy", "y"), rx, ry) };
      }
      case "line": {
        const d = `M${L("x1", "x")},${L("y1", "y")}L${L("x2", "x")},${L("y2", "y")}`;
        const p = parsePath(d, { vertices: wantVertices });
        return { cmds: p.cmds, vertices: p.vertices };
      }
      case "polyline":
      case "polygon": {
        const pts = parsePoints(el.attrs.get("points") ?? "", 2 * (budget + 1));
        if (pts.length < 2) return undefined;
        const parts: string[] = [`M${pts[0]},${pts[1]}`];
        for (let i = 2; i < pts.length; i += 2) parts.push(`L${pts[i]},${pts[i + 1]}`);
        if (el.name === "polygon") parts.push("Z");
        const p = parsePath(parts.join(""), { vertices: wantVertices, maxCommands: budget });
        if (p.truncated) this.stop(`more than ${SVG_LIMITS.pathCommands} path commands`);
        return { cmds: p.cmds, vertices: p.vertices };
      }
    }
    return undefined;
  }

  private renderShape(el: XmlElement, ctx: Ctx): void {
    this.withElement(el, ctx, (style, inner) => {
      const markers = MARKABLE.has(el.name) && !!(style.markerStart || style.markerMid || style.markerEnd);
      const geo = this.geometry(el, style, inner.vp, markers);
      if (!geo) return;
      let box: Box | undefined | null = null;
      const bbox = () => (box === null ? (box = pathBounds(geo.cmds)) : box);
      const pattern = el.name === "line" ? undefined : this.patternOf(style.fill);
      // A pattern fill is drawn tile by tile; only when that is not possible does it fall back to a colour.
      const tiled = !!pattern && style.visible && this.fillPattern(geo.cmds, style, inner, pattern);
      const fill = tiled ? undefined : this.paintOf(style.fill, style.fillOpacity, style, inner, bbox);
      const stroke = style.strokeWidth > 0 ? this.paintOf(style.stroke, style.strokeOpacity, style, inner, bbox) : undefined;
      if (style.visible) this.paintPath(geo.cmds, style, inner, el.name === "line" ? undefined : fill, stroke);
      if (markers && geo.vertices) {
        // Context paints are the shape's paints as such, without its opacities.
        const ctxFill = el.name === "line" ? undefined : this.resolvePaint(style.fill, style, inner, bbox);
        const ctxStroke = this.resolvePaint(style.stroke, style, inner, bbox);
        this.renderMarkers(geo.vertices, style, inner, this.toFigurePaint(ctxFill, inner.m), this.toFigurePaint(ctxStroke, inner.m));
      }
    });
  }

  private dashFor(style: Style, s: number): number[] | undefined {
    if (!style.dashArray) return undefined;
    let arr = style.dashArray.map((v) => v * s);
    if (style.dashOffset) arr = offsetDash(arr, style.dashOffset * s, style.lineCap === 0);
    if (!(arr.reduce((a, v) => a + v, 0) > 0)) return undefined;
    return arr.map(r4);
  }

  private paintPath(cmds: PathCommand[], style: Style, ctx: Ctx, fill: Resolved | undefined, stroke: Resolved | undefined): void {
    if (!fill && !stroke) return;
    if (!this.chargeCommands(cmds.length)) return;
    const evenOdd = style.fillRule === "evenodd";
    const m = ctx.m;
    const exact = !!stroke && !style.nonScalingStroke && !isSimilarity(m);
    const s = exact ? 1 : style.nonScalingStroke ? this.k : scaleOf(m);
    const d = exact ? cmds : transformCmds(cmds, m);
    const op = (f: Resolved | undefined, st: Resolved | undefined): Extract<DrawOp, { op: "path" }> => {
      const o: Extract<DrawOp, { op: "path" }> = { op: "path", d };
      if (f) {
        o.fill = this.paintIn(f, m, !exact);
        if (f.alpha < 1) o.fillAlpha = r4(f.alpha);
        if (evenOdd) o.evenOdd = true;
      }
      if (st) {
        o.stroke = this.paintIn(st, m, !exact);
        if (st.alpha < 1) o.strokeAlpha = r4(st.alpha);
        o.lineWidth = exact ? style.strokeWidth : r4(style.strokeWidth * s);
        o.lineCap = style.lineCap;
        o.lineJoin = style.lineJoin;
        if (style.lineJoin === 0) o.miterLimit = style.miterLimit;
        const dash = this.dashFor(style, s);
        if (dash) o.dash = dash;
      }
      return o;
    };
    if (exact) {
      this.emit({ op: "save" });
      this.emit({ op: "transform", m: roundMatrix(m) });
    }
    if ((fill?.stopAlphas || stroke?.stopAlphas) && fill && stroke) {
      // Each through its own mask.
      const parts: [Resolved | undefined, Resolved | undefined][] = style.strokeFirst ? [[undefined, stroke], [fill, undefined]] : [[fill, undefined], [undefined, stroke]];
      for (const [f, st] of parts) this.emitMasked(op(f, st), (f ?? st) as Resolved, m, !exact);
    } else if (fill?.stopAlphas || stroke?.stopAlphas) {
      this.emitMasked(op(fill, stroke), (fill ?? stroke) as Resolved, m, !exact);
    } else if (style.strokeFirst && fill && stroke) {
      this.emit(op(undefined, stroke));
      this.emit(op(fill, undefined));
    } else this.emit(op(fill, stroke));
    if (exact) this.emit({ op: "restore" });
  }

  /**
   * A path painted with a gradient whose stops differ in opacity: drawn in
   * a group whose soft mask is the same gradient in grey, the stop
   * opacities as its levels.
   */
  private emitMasked(o: Extract<DrawOp, { op: "path" }>, r: Resolved, m: Readonly<Matrix>, inFigure: boolean): void {
    const bbox = this.groupBox([o]);
    const g = this.paintIn(r, m, inFigure);
    if (!bbox || !isGradient(g) || !r.stopAlphas) {
      this.emit(o);
      return;
    }
    const grey: Gradient = { ...g, stops: r.stopAlphas.map((st) => ({ offset: st.offset, color: [st.a, st.a, st.a] as Color })) };
    const [x0, y0, x1, y1] = bbox;
    const rect: PathCommand[] = [["M", x0, y0], ["L", x1, y0], ["L", x1, y1], ["L", x0, y1], ["Z"]];
    this.emit({ op: "group", ops: [o], bbox, mask: { ops: [{ op: "path", d: rect, fill: grey }], luminance: true } });
  }

  // ------------------------------------------------------------ markers

  private renderMarkers(vs: PathVertex[], style: Style, ctx: Ctx, fill: Resolved | undefined, stroke: Resolved | undefined): void {
    const n = vs.length;
    const sub: Ctx = { ...ctx, ctxFill: fill, ctxStroke: stroke };
    for (let i = 0; i < n; i++) {
      if (this.exhausted) return;
      const v = vs[i];
      if (i === 0 && style.markerStart) this.renderMarker(style.markerStart, v, true, style.strokeWidth, sub);
      if (i > 0 && i < n - 1 && style.markerMid) this.renderMarker(style.markerMid, v, false, style.strokeWidth, sub);
      if (i === n - 1 && style.markerEnd) this.renderMarker(style.markerEnd, v, false, style.strokeWidth, sub);
    }
  }

  private renderMarker(id: string, v: PathVertex, isStart: boolean, strokeWidth: number, ctx: Ctx): void {
    const mk = this.ids.get(id);
    if (!mk || mk.name !== "marker") {
      this.report.warn(`marker-missing:${id}`, `SVG marker reference #${id} is not a marker in the file; it was left out`);
      return;
    }
    if (ctx.refs.includes(mk) || ctx.refs.length >= SVG_LIMITS.refDepth) return;
    if (!this.tick()) return;
    const mStyle = this.treeStyle(mk);
    const fs = mStyle.fontSize;
    const mw = lengthAttr(mk, "markerWidth", "x", fs, ctx.vp, 3);
    const mh = lengthAttr(mk, "markerHeight", "y", fs, ctx.vp, 3);
    if (!(mw > 0 && mh > 0)) return;
    const vb = parseViewBox(mk.attrs.get("viewBox"));
    if (vb && (vb.w === 0 || vb.h === 0)) return;
    const par = parseAspectRatio(mk.attrs.get("preserveAspectRatio"));
    const VB = vb ? viewBoxTransform(vb, 0, 0, mw, mh, par) : ([1, 0, 0, 1, 0, 0] as Matrix);
    const refCoord = (name: string, axis: "x" | "y"): number => {
      const raw = (mk.attrs.get(name) ?? "0").trim();
      const lo = axis === "x" ? (vb?.x ?? 0) : (vb?.y ?? 0);
      const size = axis === "x" ? (vb?.w ?? mw) : (vb?.h ?? mh);
      if (raw === "left" || raw === "top") return lo;
      if (raw === "center") return lo + size / 2;
      if (raw === "right" || raw === "bottom") return lo + size;
      const len = parseLength(raw);
      return len ? resolveLength(len, axis, fs, vb ? { w: vb.w, h: vb.h } : { w: mw, h: mh }) : 0;
    };
    const [rx, ry] = apply(VB, refCoord("refX", "x"), refCoord("refY", "y"));
    // Orientation.
    const orient = (mk.attrs.get("orient") ?? "0").trim();
    let angle: number;
    if (orient === "auto" || orient === "auto-start-reverse") {
      const a1 = v.inDir ? Math.atan2(v.inDir[1], v.inDir[0]) : undefined;
      const a2 = v.outDir ? Math.atan2(v.outDir[1], v.outDir[0]) : undefined;
      let a: number;
      if (a1 !== undefined && a2 !== undefined) {
        const sx = Math.cos(a1) + Math.cos(a2);
        const sy = Math.sin(a1) + Math.sin(a2);
        a = Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12 ? a1 : Math.atan2(sy, sx);
      } else a = a1 ?? a2 ?? 0;
      angle = (a * 180) / Math.PI;
      if (orient === "auto-start-reverse" && isStart) angle += 180;
    } else {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(deg|rad|grad|turn)?$/.exec(orient);
      const val = m ? Number(m[1]) : 0;
      const unit = m?.[2];
      angle = unit === "rad" ? (val * 180) / Math.PI : unit === "grad" ? val * 0.9 : unit === "turn" ? val * 360 : val;
    }
    const units = mk.attrs.get("markerUnits")?.trim() === "userSpaceOnUse" ? 1 : strokeWidth;
    if (!(units > 0)) return;
    let base = multiply(ctx.m, translate(v.x, v.y));
    if (angle) base = multiply(base, rotate(angle));
    base = multiply(base, scale(units));
    base = multiply(base, translate(-rx, -ry));
    const sub: Ctx = {
      m: multiply(base, VB),
      parent: mStyle,
      vp: vb ? { w: vb.w, h: vb.h } : { w: mw, h: mh },
      alpha: ctx.alpha,
      refs: [...ctx.refs, mk],
      ctxFill: ctx.ctxFill,
      ctxStroke: ctx.ctxStroke,
    };
    if (mStyle.overflowVisible === true) {
      this.renderChildren(mk, sub);
      return;
    }
    const ops = this.capture(() => this.renderChildren(mk, sub));
    this.appendClipped(ops, base, 0, 0, mw, mh);
  }

  // ------------------------------------------------------------ images

  private renderImage(el: XmlElement, ctx: Ctx): void {
    this.withElement(el, ctx, (style, inner) => {
      if (!style.visible) return;
      const href = hrefOf(el);
      if (!href) return;
      let ref: ImageRef | undefined;
      if (this.opts.resolveImage) {
        try {
          ref = this.opts.resolveImage(href);
        } catch {
          ref = undefined;
        }
      }
      if (!ref && /^data:/i.test(href)) ref = embeddedImage(href);
      if (!ref) {
        const what = /^data:/i.test(href) ? "a data: URL that is not a PNG or JPEG image" : href.slice(0, 80);
        this.report.warn(`image:${what}`, `SVG <image> (${what}) could not be loaded and was left out`, "Embed PNG or JPEG images as data: URLs, or reference image files next to the document");
        return;
      }
      const pw = ref.pixelWidth;
      const ph = ref.pixelHeight;
      if (!(pw > 0 && ph > 0)) return;
      const fs = style.fontSize;
      let w = lengthAttr(el, "width", "x", fs, ctx.vp);
      let h = lengthAttr(el, "height", "y", fs, ctx.vp);
      if (w === undefined && h === undefined) {
        w = pw;
        h = ph;
      } else if (w === undefined) w = ((h as number) * pw) / ph;
      else if (h === undefined) h = (w * ph) / pw;
      if (!((w as number) > 0 && (h as number) > 0)) return;
      const W = w as number;
      const H = h as number;
      const x = lengthAttr(el, "x", "x", fs, ctx.vp, 0);
      const y = lengthAttr(el, "y", "y", fs, ctx.vp, 0);
      const par = parseAspectRatio(el.attrs.get("preserveAspectRatio"));
      const fit = viewBoxTransform({ x: 0, y: 0, w: pw, h: ph }, x, y, W, H, par);
      const ix = fit[4];
      const iy = fit[5];
      const iw = pw * fit[0];
      const ih = ph * fit[3];
      const needClip = iw > W + 1e-9 || ih > H + 1e-9;
      const m = inner.m;
      if (needClip) {
        this.emit({ op: "save" });
        this.emit({ op: "clip", d: rectPath(x, y, W, H, m) });
      }
      const N = multiply(m, [1, 0, 0, -1, ix, iy + ih]);
      const alpha = { ...(inner.alpha < 1 ? { alpha: r4(inner.alpha) } : {}), ...(style.pixelated ? { pixelated: true } : {}) };
      if (Math.abs(N[1]) < 1e-12 && Math.abs(N[2]) < 1e-12 && N[0] > 0 && N[3] > 0) {
        this.emit({ op: "image", x: r4(N[4]), y: r4(N[5]), width: r4(iw * N[0]), height: r4(ih * N[3]), image: ref, ...alpha });
      } else {
        this.emit({ op: "save" });
        this.emit({ op: "transform", m: roundMatrix(N) });
        this.emit({ op: "image", x: 0, y: 0, width: iw, height: ih, image: ref, ...alpha });
        this.emit({ op: "restore" });
      }
      if (needClip) this.emit({ op: "restore" });
    });
  }

  // ------------------------------------------------------------ text

  private renderText(el: XmlElement, ctx: Ctx): void {
    this.withElement(el, ctx, (style, inner) => {
      const runs = this.layoutText(el, style, inner.vp, true);
      let box: Box | undefined | null = null;
      const bbox = () => (box === null ? (box = runsBox(runs)) : box);
      for (const r of runs) {
        if (!r.style.visible || r.gids.length === 0) continue;
        const fill = this.paintOf(r.style.fill, r.style.fillOpacity, r.style, inner, bbox);
        const stroke = r.style.strokeWidth > 0 ? this.paintOf(r.style.stroke, r.style.strokeOpacity, r.style, inner, bbox) : undefined;
        const deco = r.style.decoration;
        // Underlines and overlines go under the text, line-through over it.
        if (deco.underline) this.decorate(r, "underline", inner, fill, stroke);
        if (deco.overline) this.decorate(r, "overline", inner, fill, stroke);
        this.paintRun(r, inner, fill, stroke);
        if (deco.lineThrough) this.decorate(r, "lineThrough", inner, fill, stroke);
      }
      for (const c of el.children) if (c.type === "element" && c.name === "textPath") this.renderTextPath(c, style, inner);
    });
  }

  /**
   * Text along a path: each glyph is placed with the middle of its advance
   * on the path, turned to the path's direction there; glyphs whose middle
   * falls off the path are not drawn.
   */
  private renderTextPath(tp: XmlElement, parent: Style, ctx: Ctx): void {
    if (!this.tick()) return;
    const style = computeStyle(tp, parent, this.cascade, ctx.vp);
    if (!style.display) return;
    let cmds: PathCommand[] | undefined;
    const inline = tp.attrs.get("path");
    if (inline !== undefined) cmds = parsePath(inline).cmds;
    else {
      const href = hrefOf(tp);
      const target = href && href.startsWith("#") ? this.ids.get(href.slice(1)) : undefined;
      if (!target || !SHAPES.has(target.name)) {
        this.report.warn(`textpath-missing:${href ?? ""}`, `SVG textPath refers to ${href ? href.slice(0, 80) : "nothing"}, which is not a path in the file; its text was left out`);
        return;
      }
      const geo = this.geometry(target, this.treeStyle(target), ctx.vp, false);
      if (!geo) return;
      cmds = geo.cmds;
      const tr = target.attrs.get("transform");
      const t = tr ? parseTransform(tr) : undefined;
      if (t) cmds = transformCmds(cmds, t);
    }
    const path = measurePath(cmds);
    if (!(path.total > 0)) return;
    const runs = this.layoutText(tp, style, ctx.vp, true);
    let start = 0;
    const so = tp.attrs.get("startOffset");
    const len = so !== undefined ? parseLength(so) : undefined;
    if (len) start = len.unit === "%" ? (len.v / 100) * path.total : resolveLength(len, "x", style.fontSize, ctx.vp);
    let box: Box | undefined | null = null;
    const bbox = () => (box === null ? (box = runsBox(runs)) : box);
    for (const r of runs) {
      if (!r.style.visible || !r.gids.length) continue;
      const fill = this.paintOf(r.style.fill, r.style.fillOpacity, r.style, ctx, bbox);
      const stroke = r.style.strokeWidth > 0 ? this.paintOf(r.style.stroke, r.style.strokeOpacity, r.style, ctx, bbox) : undefined;
      if (!fill && !stroke) continue;
      let x = r.x;
      for (let i = 0; i < r.gids.length; i++) {
        const adv = r.advances[i];
        const mid = start + x + adv / 2;
        x += adv;
        if (mid < 0 || mid > path.total) continue;
        const [px, py, angle] = path.at(mid);
        const m = multiply(ctx.m, multiply(translate(px, py), multiply(rotate(angle), translate(-adv / 2, r.y))));
        const glyph: LaidRun = { ...r, gids: [r.gids[i]], advances: [adv], text: [r.text[i] ?? ""], width: adv, x: 0, y: 0 };
        this.paintRun(glyph, { ...ctx, m }, fill, stroke);
      }
    }
  }

  // ------------------------------------------------------------ HTML labels

  /**
   * HTML inside foreignObject, as diagram tools write it for labels: the
   * text, with its fonts, colours, line breaks and block boundaries, wrapped
   * to the width it has and aligned in the box as text-align, flex centring
   * or table-cell vertical-align put it. Inline backgrounds are drawn behind
   * their words. Anything else in the HTML is not drawn.
   */
  private renderForeignObject(el: XmlElement, ctx: Ctx): void {
    this.withElement(el, ctx, (style, inner) => {
      const fs = style.fontSize;
      const x = lengthAttr(el, "x", "x", fs, ctx.vp, 0);
      const y = lengthAttr(el, "y", "y", fs, ctx.vp, 0);
      const w = lengthAttr(el, "width", "x", fs, ctx.vp, 0);
      const h = lengthAttr(el, "height", "y", fs, ctx.vp, 0);
      if (!(w > 0 && h > 0)) return;
      // The words, breaks and the box they sit in.
      const items: HtmlItem[] = [];
      const box = { left: x, top: y, width: w, height: h, vCenter: false, hCenter: false, nowrap: false, set: false };
      const px = (v: string | undefined, axis: "x" | "y", base: number): number | undefined => {
        const l = v ? parseLength(v.trim().split(/\s+/)[0]) : undefined;
        return l ? (l.unit === "%" ? (l.v / 100) * base : resolveLength(l, axis, fs, ctx.vp)) : undefined;
      };
      const walk = (node: XmlElement, st: Style, depth: number, bg: [number, number, number, number] | undefined) => {
        for (const child of node.children) {
          if (child.type === "text") {
            const text = st.preserveSpace ? child.value : child.value.replace(/\s+/g, " ");
            if (text) items.push({ kind: "text", text, style: st, bg });
            continue;
          }
          if (child.type !== "element" || depth > 64 || !this.tick()) continue;
          const name = child.name.toLowerCase().replace(/^.*:/, "");
          if (name === "br") {
            items.push({ kind: "break" });
            continue;
          }
          if (name === "style" || name === "script" || name === "title") continue;
          const spec = this.cascade.specified(child);
          const cs = computeStyle(child, st, this.cascade, ctx.vp);
          if (!cs.display) continue;
          // The defaults browsers give these elements.
          if ((name === "b" || name === "strong" || /^h[1-6]$/.test(name) || name === "th") && !spec.has("font-weight")) cs.bold = true;
          if ((name === "i" || name === "em" || name === "cite") && !spec.has("font-style")) cs.italic = true;
          if ((name === "code" || name === "pre" || name === "kbd" || name === "tt" || name === "samp") && !spec.has("font-family")) cs.fontFamily = "monospace";
          if (name === "small" && !spec.has("font-size")) cs.fontSize = st.fontSize * 0.833;
          if (name === "pre") cs.preserveSpace = true;
          const disp = (spec.get("display") ?? "").trim().toLowerCase();
          const block = disp ? /^(block|flex|grid|table|table-cell|table-row|list-item)$/.test(disp) : /^(div|p|li|ul|ol|h[1-6]|table|tr|section|header|footer|blockquote|pre|center)$/.test(name);
          // The first block with layout properties sets the box the text sits in.
          if (block && !box.set) {
            const ai = (spec.get("align-items") ?? "").toLowerCase();
            const jc = (spec.get("justify-content") ?? "").toLowerCase();
            const va = (spec.get("vertical-align") ?? "").toLowerCase();
            const ml = px(spec.get("margin-left"), "x", w) ?? 0;
            const pl = px(spec.get("padding-left") ?? spec.get("padding"), "x", w) ?? 0;
            const mt = px(spec.get("margin-top"), "y", h) ?? 0;
            const pt = px(spec.get("padding-top") ?? spec.get("padding"), "y", h) ?? 0;
            const cw = px(spec.get("width"), "x", w);
            const ch = px(spec.get("height"), "y", h);
            box.left = x + ml + pl;
            box.top = y + mt + pt;
            box.width = cw ?? Math.max(0, w - ml - pl);
            box.height = ch ?? Math.max(0, h - mt - pt);
            box.vCenter = (disp === "flex" && ai.includes("center")) || (disp === "table-cell" && va === "middle");
            box.hCenter = disp === "flex" && jc.includes("center");
            box.nowrap = /nowrap|pre\b/.test(spec.get("white-space") ?? "");
            box.set = true;
          }
          let childBg = bg;
          const bgRaw = spec.get("background-color") ?? spec.get("background");
          const bgc = bgRaw ? parseColor(bgRaw.trim().split(/\s+/)[0]) : undefined;
          if (bgc && bgc !== "currentColor" && bgc.a > 0 && !block) childBg = [bgc.r, bgc.g, bgc.b, bgc.a];
          if (block) items.push({ kind: "break" });
          walk(child, cs, depth + 1, childBg);
          if (block) items.push({ kind: "break" });
        }
      };
      walk(el, style, 0, undefined);
      this.layoutHtml(items, box, inner);
    });
  }

  /** Lays out the words of an HTML label in lines and draws them. */
  private layoutHtml(items: HtmlItem[], box: { left: number; top: number; width: number; height: number; vCenter: boolean; hCenter: boolean; nowrap: boolean }, ctx: Ctx): void {
    type Piece = { run: LaidRun; space: number; bg?: [number, number, number, number] };
    const lines: { pieces: Piece[]; width: number; ascent: number; height: number; align: Style["textAlign"] }[] = [];
    let line: Piece[] = [];
    let lineW = 0;
    let pendingSpace = 0;
    let lastStyle: Style | undefined;
    const lineHeightOf = (st: Style, font: Font) => (st.lineHeight !== undefined ? st.lineHeight * st.fontSize : ((font.ascent - font.descent + font.lineGap) / font.unitsPerEm) * st.fontSize);
    const finish = () => {
      if (!line.length && !lastStyle) return;
      let ascent = 0;
      let height = 0;
      for (const p of line) {
        const f = p.run.font;
        const lh = lineHeightOf(p.run.style, f);
        const content = ((f.ascent - f.descent) / f.unitsPerEm) * p.run.size;
        // The baseline sits half the leading below the line box's top, then the ascent.
        ascent = Math.max(ascent, (lh - content) / 2 + (f.ascent / f.unitsPerEm) * p.run.size);
        height = Math.max(height, lh);
      }
      if (!line.length && lastStyle) {
        const face = resolveFace(lastStyle.fontFamily, lastStyle.bold, lastStyle.italic);
        height = lineHeightOf(lastStyle, face.font);
      }
      lines.push({ pieces: line, width: lineW, ascent, height, align: line[0]?.run.style.textAlign ?? lastStyle?.textAlign ?? "start" });
      line = [];
      lineW = 0;
      pendingSpace = 0;
    };
    const maxW = box.nowrap ? Infinity : box.width + 0.5;
    let sawText = false;
    for (const it of items) {
      if (it.kind === "break") {
        if (line.length) finish();
        continue;
      }
      lastStyle = it.style;
      const parts = it.text.split(/( )/);
      for (const part of parts) {
        if (part === "") continue;
        if (part === " ") {
          if (line.length) pendingSpace = this.htmlRuns(" ", it.style).reduce((s, r) => s + r.width, 0);
          continue;
        }
        sawText = true;
        const runs = this.htmlRuns(part, it.style);
        const wordW = runs.reduce((s, r) => s + r.width, 0);
        if (line.length && lineW + pendingSpace + wordW > maxW) finish();
        let space = line.length ? pendingSpace : 0;
        for (const r of runs) {
          line.push({ run: r, space, bg: it.bg });
          lineW += space + r.width;
          space = 0;
        }
        pendingSpace = 0;
      }
    }
    if (line.length) finish();
    if (!sawText) return;
    const total = lines.reduce((s, l) => s + l.height, 0);
    let top = box.vCenter ? box.top + (box.height - total) / 2 : box.top;
    const blockW = Math.max(...lines.map((l) => l.width));
    const blockLeft = box.hCenter ? box.left + (box.width - blockW) / 2 : box.left;
    const areaW = box.hCenter ? blockW : box.width;
    for (const l of lines) {
      const free = areaW - l.width;
      const shift = l.align === "center" ? free / 2 : l.align === "right" || l.align === "end" ? free : 0;
      let pen = blockLeft + shift;
      const baseline = top + l.ascent;
      for (const p of l.pieces) {
        pen += p.space;
        const r = { ...p.run, x: pen, y: baseline };
        if (p.bg) {
          const bgPaint: Resolved = { paint: roundColor([p.bg[0], p.bg[1], p.bg[2]]), alpha: p.bg[3] * ctx.alpha };
          this.paintPath(rectCommands(pen - p.space, top, p.space + r.width, l.height, 0, 0), r.style, ctx, bgPaint, undefined);
        }
        const c = r.style.color;
        if (r.style.visible && c.a > 0) {
          const fill: Resolved = { paint: roundColor([c.r, c.g, c.b]), alpha: c.a * ctx.alpha };
          this.paintRun(r, ctx, fill, undefined);
        }
        pen += r.width;
      }
      top += l.height;
    }
  }

  /** Shaped runs of a piece of HTML text in one style (several when characters need fallback fonts). */
  private htmlRuns(text: string, st: Style): LaidRun[] {
    const face = resolveFace(st.fontFamily, st.bold, st.italic);
    const out: LaidRun[] = [];
    const chars = [...text];
    const choice = chars.map((c) => glyphFor(face, c.codePointAt(0) as number));
    let i = 0;
    while (i < chars.length) {
      const font = choice[i].font;
      let j = i + 1;
      while (j < chars.length && choice[j].font === font) j++;
      const shaped = shapeRun(
        font,
        st.fontSize,
        choice.slice(i, j).map((g) => g.gid),
        chars.slice(i, j),
        st.letterSpacing,
        st.wordSpacing,
      );
      out.push({ font, size: st.fontSize, gids: shaped.gids, advances: shaped.advances, text: shaped.text, width: shaped.width, x: 0, y: 0, style: st });
      if (this.glyphs + out.length > SVG_LIMITS.glyphs) break;
      i = j;
    }
    return out;
  }

  /**
   * A run's fill, as glyphs when it is a flat colour, as outlines otherwise,
   * and its stroke as outlines, in paint-order.
   */
  private paintRun(r: LaidRun, ctx: Ctx, fill: Resolved | undefined, stroke: Resolved | undefined): void {
    let outline: PathCommand[] | undefined;
    const outlines = () => (outline ??= this.runOutline(r));
    const doFill = () => {
      if (!fill) return;
      if (!isGradient(fill.paint) && !fill.stopAlphas) this.emitRun(r, ctx.m, fill.paint, fill.alpha);
      else this.paintPath(outlines(), { ...r.style, fillRule: "nonzero" }, ctx, fill, undefined);
    };
    const doStroke = () => {
      if (stroke) this.paintPath(outlines(), r.style, ctx, undefined, stroke);
    };
    if (r.style.strokeFirst) {
      doStroke();
      doFill();
    } else {
      doFill();
      doStroke();
    }
  }

  /** A text decoration line across a run, at the font's underline or strikeout position and thickness. */
  private decorate(r: LaidRun, kind: "underline" | "overline" | "lineThrough", ctx: Ctx, fill: Resolved | undefined, stroke: Resolved | undefined): void {
    if (!r.width) return;
    const f = r.font;
    const k = r.size / f.unitsPerEm;
    const thick = Math.max(f.unitsPerEm / 40, kind === "lineThrough" ? f.strikeoutSize || f.underlineThickness : f.underlineThickness) * k;
    const pos = kind === "underline" ? f.underlinePosition : kind === "overline" ? f.ascent : f.strikeoutPosition || f.xHeight / 2;
    const y = r.y - pos * k;
    this.paintPath(rectCommands(r.x, y - thick / 2, r.width, thick, 0, 0), { ...r.style, fillRule: "nonzero", dashArray: null }, ctx, fill, stroke);
  }

  /** The outlines of a run's glyphs in user space (y down). */
  private runOutline(r: LaidRun): PathCommand[] {
    const out: PathCommand[] = [];
    const k = r.size / r.font.unitsPerEm;
    let x = r.x;
    for (let i = 0; i < r.gids.length; i++) {
      let o: PathCommand[] | undefined;
      try {
        o = r.font.outline(r.gids[i]);
      } catch {
        o = undefined;
      }
      if (o) {
        for (const c of o) {
          if (c[0] === "Z") out.push(["Z"]);
          else if (c[0] === "C") out.push(["C", x + c[1] * k, r.y - c[2] * k, x + c[3] * k, r.y - c[4] * k, x + c[5] * k, r.y - c[6] * k]);
          else out.push([c[0], x + c[1] * k, r.y - c[2] * k]);
        }
      }
      x += r.advances[i];
    }
    return out;
  }

  private emitRun(r: LaidRun, m: Readonly<Matrix>, color: Color, alpha = 1): void {
    this.glyphs += r.gids.length;
    if (this.glyphs > SVG_LIMITS.glyphs) {
      this.stop(`more than ${SVG_LIMITS.glyphs} characters of text`);
      return;
    }
    const N = multiply(m, [1, 0, 0, -1, r.x, r.y]);
    const upright = Math.abs(N[1]) < 1e-9 * Math.abs(N[0]) && Math.abs(N[2]) < 1e-9 * Math.abs(N[0]) && N[0] > 0 && Math.abs(N[0] - N[3]) <= 1e-9 * N[0];
    const s = upright ? N[0] : 1;
    const em = r.font.unitsPerEm;
    const run: Glyphs = {
      t: "glyphs",
      font: r.font,
      size: r4(r.size * s),
      gids: r.gids,
      advances: r.advances.map((a) => r4(a * s)),
      text: r.text,
      width: r4(r.width * s),
      height: r4(((r.font.ascent * r.size) / em) * s),
      depth: r4(((-r.font.descent * r.size) / em) * s),
      color,
    };
    const a = alpha < 1 ? { alpha: r4(alpha) } : {};
    if (upright) {
      this.emit({ op: "glyphs", x: r4(N[4]), y: r4(N[5]), run, ...a });
    } else {
      this.emit({ op: "save" });
      this.emit({ op: "transform", m: roundMatrix(N) });
      this.emit({ op: "glyphs", x: 0, y: 0, run, ...a });
      this.emit({ op: "restore" });
    }
  }

  /**
   * Lays out a <text> element: white space handling, per-character x/y/dx/dy,
   * fonts and fallback, shaping into runs, and text-anchor per text chunk.
   * Positions are in user space (y down), baselines included.
   */
  private layoutText(el: XmlElement, style: Style, vp: Viewport, report: boolean): LaidRun[] {
    const chars: TChar[] = [];
    const ranges: { start: number; end: number; el: XmlElement; style: Style }[] = [];
    let lastSpace = true;
    const walk = (e: XmlElement, st: Style, depth: number) => {
      const entry = { start: chars.length, end: chars.length, el: e, style: st };
      ranges.push(entry);
      for (const child of e.children) {
        if (child.type === "text") {
          for (const ch of child.value) {
            let c = ch;
            if (c === "\n" || c === "\r" || c === "\t") c = " ";
            const cp = c.codePointAt(0) as number;
            if (isInvisible(cp)) continue;
            if (c === " " && !st.preserveSpace) {
              if (lastSpace) continue;
              lastSpace = true;
            } else lastSpace = false;
            if (chars.length >= SVG_LIMITS.glyphs) break;
            chars.push({ s: c, cp, style: st, dx: 0, dy: 0 });
          }
        } else if ((child.name === "tspan" || child.name === "a") && depth < 64) {
          if (!this.tick()) break;
          const cs = computeStyle(child, st, this.cascade, vp);
          if (cs.display) walk(child, cs, depth + 1);
        }
      }
      entry.end = chars.length;
    };
    walk(el, style, 0);
    const lastChar = chars[chars.length - 1];
    if (lastChar && lastChar.s === " " && !lastChar.style.preserveSpace) chars.pop();
    if (chars.length === 0) return [];
    // Per-character positions; descendants override ancestors (ranges are in pre-order).
    for (const r of ranges) {
      const end = Math.min(r.end, chars.length);
      if (end <= r.start) continue;
      const fs = r.style.fontSize;
      for (const [attr, axis] of [
        ["x", "x"],
        ["y", "y"],
        ["dx", "x"],
        ["dy", "y"],
      ] as const) {
        const raw = r.el.attrs.get(attr);
        if (raw === undefined) continue;
        const list = lengthList(raw, axis, fs, vp, end - r.start);
        for (let k = 0; k < list.length; k++) chars[r.start + k][attr] = list[k];
      }
    }
    // Fonts per character.
    const faces = new Map<Style, Face>();
    const choice = chars.map((c) => {
      let face = faces.get(c.style);
      if (!face) {
        face = resolveFace(c.style.fontFamily, c.style.bold, c.style.italic);
        faces.set(c.style, face);
      }
      const g = glyphFor(face, c.cp);
      if (g.missing && report) {
        const hex = c.cp.toString(16).toUpperCase().padStart(4, "0");
        this.report.warn(`glyph:${c.cp}`, `SVG text: no available font has a glyph for U+${hex} ('${c.s}'); it is drawn as a blank box`);
      }
      return g;
    });
    // Runs, chunks and anchoring.
    const out: LaidRun[] = [];
    let penX = 0;
    let penY = 0;
    let chunk: LaidRun[] = [];
    let chunkStart = 0;
    let anchor: Style["textAnchor"] = "start";
    const flush = () => {
      if (!chunk.length) return;
      const width = penX - chunkStart;
      const shift = anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0;
      if (shift) for (const r of chunk) r.x += shift;
      chunk = [];
    };
    let i = 0;
    while (i < chars.length) {
      const c0 = chars[i];
      const newChunk = i === 0 || c0.x !== undefined || c0.y !== undefined;
      if (newChunk) {
        flush();
        if (c0.x !== undefined) penX = c0.x;
        if (c0.y !== undefined) penY = c0.y;
      }
      penX += c0.dx;
      penY += c0.dy;
      if (newChunk) {
        chunkStart = penX;
        anchor = c0.style.textAnchor;
      }
      const font = choice[i].font;
      let j = i + 1;
      while (j < chars.length) {
        const c = chars[j];
        if (c.x !== undefined || c.y !== undefined || c.dx || c.dy || c.style !== c0.style || choice[j].font !== font) break;
        j++;
      }
      const st = c0.style;
      const shaped = shapeRun(
        font,
        st.fontSize,
        choice.slice(i, j).map((g) => g.gid),
        chars.slice(i, j).map((c) => c.s),
        st.letterSpacing,
        st.wordSpacing,
      );
      const run: LaidRun = {
        font,
        size: st.fontSize,
        gids: shaped.gids,
        advances: shaped.advances,
        text: shaped.text,
        width: shaped.width,
        x: penX,
        // sub and super move by half the font's height, as browsers do.
        y: penY + baselineOffset(st, font) - (st.shift ? ((st.shift === "super" ? 1 : -1) * ((font.ascent - font.descent) / font.unitsPerEm) * st.fontSize) / 2 : st.baselineShift),
        style: st,
      };
      penX += shaped.width;
      out.push(run);
      chunk.push(run);
      i = j;
    }
    flush();
    return out;
  }
}

/** Distance (user units, down) from the requested y to the alphabetic baseline for dominant/alignment-baseline. */
function baselineOffset(st: Style, font: Font): number {
  // text-top and text-bottom are alignment-baseline values only; as a dominant-baseline browsers ignore them.
  const aligned = st.alignmentBaseline && st.alignmentBaseline !== "auto" && st.alignmentBaseline !== "baseline";
  const b = aligned ? st.alignmentBaseline : st.dominantBaseline === "text-top" || st.dominantBaseline === "text-bottom" ? "auto" : st.dominantBaseline;
  const k = st.fontSize / font.unitsPerEm;
  switch (b) {
    case "middle":
      return (font.xHeight * k) / 2;
    case "central":
      return ((font.ascent + font.descent) * k) / 2;
    case "mathematical":
      return 0.25 * st.fontSize;
    case "hanging":
      return 0.8 * font.ascent * k;
    case "text-before-edge":
    case "before-edge":
    case "text-top":
      return font.ascent * k;
    case "text-after-edge":
    case "after-edge":
    case "text-bottom":
    case "ideographic":
      return font.descent * k;
    default:
      return 0;
  }
}

/** What an HTML label is made of: text in a style (with the background of its inline element), and line breaks. */
type HtmlItem = { kind: "text"; text: string; style: Style; bg?: [number, number, number, number] } | { kind: "break" };

/** A path flattened for measuring: its length, and the point and direction (degrees) at a distance along it. */
function measurePath(cmds: PathCommand[]): { total: number; at(d: number): [number, number, number] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const acc: number[] = [];
  /** Segments that start a new subpath: the jump to them has no length and no direction. */
  const jump: boolean[] = [];
  let total = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const lineTo = (x: number, y: number, isJump = false) => {
    if (xs.length) total += isJump ? 0 : Math.hypot(x - cx, y - cy);
    xs.push(x);
    ys.push(y);
    acc.push(total);
    jump.push(isJump);
    cx = x;
    cy = y;
  };
  for (const c of cmds) {
    if (c[0] === "M") {
      lineTo(c[1], c[2], true);
      sx = c[1];
      sy = c[2];
    } else if (c[0] === "L") lineTo(c[1], c[2]);
    else if (c[0] === "C") {
      const x0 = cx;
      const y0 = cy;
      const n = Math.min(64, Math.max(8, Math.ceil(Math.hypot(c[5] - x0, c[6] - y0) / 4)));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        lineTo(u * u * u * x0 + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5], u * u * u * y0 + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]);
      }
    } else lineTo(sx, sy);
  }
  return {
    total,
    at(d: number): [number, number, number] {
      let lo = 1;
      let hi = acc.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (acc[mid] < d) lo = mid + 1;
        else hi = mid;
      }
      let i = Math.max(1, lo);
      while (i < acc.length - 1 && (jump[i] || acc[i] - acc[i - 1] <= 0) && acc[i] <= d) i++;
      const seg = acc[i] - acc[i - 1];
      const t = seg > 0 ? (d - acc[i - 1]) / seg : 0;
      const dx = xs[i] - xs[i - 1];
      const dy = ys[i] - ys[i - 1];
      return [xs[i - 1] + dx * t, ys[i - 1] + dy * t, (Math.atan2(dy, dx) * 180) / Math.PI];
    },
  };
}

/** A `filter` value as its list of url(#id) references and filter functions; undefined when malformed. */
function parseFilterList(value: string): ({ url: string; name?: undefined; args?: undefined } | { url?: undefined; name: string; args: string })[] | undefined {
  const out: ({ url: string } | { name: string; args: string })[] = [];
  let rest = value.trim();
  while (rest) {
    const m = /^([a-z-]+)\(/i.exec(rest);
    if (!m) return undefined;
    let depth = 0;
    let end = -1;
    for (let i = m[1].length; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return undefined;
    const name = m[1].toLowerCase();
    const args = rest.slice(m[1].length + 1, end);
    if (name === "url") {
      const ref = args.trim().replace(/^["']|["']$/g, "").trim();
      out.push({ url: ref.startsWith("#") ? ref.slice(1) : "" });
    } else out.push({ name, args });
    rest = rest.slice(end + 1).trim();
    if (out.length > 16) break;
  }
  return out.length ? (out as ReturnType<typeof parseFilterList>) : undefined;
}

/** The box around laid-out text runs (ascent to descent of each run's font). */
function runsBox(runs: LaidRun[]): Box | undefined {
  let b: Box | undefined;
  for (const r of runs) {
    const up = (r.font.ascent / r.font.unitsPerEm) * r.size;
    const down = (-r.font.descent / r.font.unitsPerEm) * r.size;
    b = union(b, { x0: r.x, y0: r.y - up, x1: r.x + r.width, y1: r.y + down });
  }
  return b;
}

function union(a: Box | undefined, b: Box): Box {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

// ---------------------------------------------------------------- public entry

/**
 * Converts an SVG document to a vector Drawing in points (origin at the
 * figure's bottom-left, y up). Never throws: unreadable input gives an
 * IMG001 error and an empty drawing; unsupported features give IMG001
 * warnings and are approximated or left out.
 */
export function svgToDrawing(svg: string, opts: SvgOptions = {}): Drawing {
  const report = new Reporter(opts.diagnostics, opts.pos);
  const size = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);
  const empty = (): Drawing => ({ t: "drawing", ops: [], width: size(opts.widthPt), height: size(opts.heightPt), depth: 0 });
  const hint = "Check that the file is well-formed SVG (XML), for example by opening it in a browser";
  if (typeof svg !== "string") {
    report.error("The SVG could not be read: no text was given", hint);
    return empty();
  }
  const parsed = parseXml(svg);
  if (parsed.error || !parsed.root) {
    const e = parsed.error;
    report.error(`The SVG could not be read: ${e ? `${e.message} (line ${e.line}, column ${e.col})` : "no root element"}`, hint);
    return empty();
  }
  if (parsed.unexpandedEntities.length) {
    const names = parsed.unexpandedEntities.slice(0, 5).map((n) => `&${n};`).join(", ");
    report.warn(
      "entities",
      `SVG uses entity reference${parsed.unexpandedEntities.length === 1 ? "" : "s"} ${names}${parsed.unexpandedEntities.length > 5 ? ", ..." : ""} that ${parsed.unexpandedEntities.length === 1 ? "was" : "were"} not expanded; DOCTYPE entity definitions are ignored for safety`,
      "Write the characters directly or as numeric references like &#160;",
    );
  }
  const root = parsed.root;
  if (root.name !== "svg") {
    report.error(`The SVG could not be read: the root element is <${root.name}>, not <svg>`, hint);
    return empty();
  }
  try {
    return new Renderer(root, opts, report).run();
  } catch (e) {
    if (e instanceof RangeError) report.error("The SVG could not be read: it is nested too deeply to draw", hint);
    else report.internal(`Internal error while drawing an SVG figure: ${e instanceof Error ? e.message : String(e)}`);
    return empty();
  }
}
