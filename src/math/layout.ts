/**
 * Math list to box list: TeX's mlist_to_hlist (The TeXbook, Appendix G).
 *
 * Styles are numbered as in TeX: D=0, D'=1, T=2, T'=3, S=4, S'=5, SS=6,
 * SS'=7 (odd = cramped). Script styles are set at 70% and scriptscript at
 * 50% of the body size, and the cmsy10/cmex10 parameters (metrics.ts) scale
 * with the size of the current style.
 *
 * The first pass turns each noad into boxes (rules 1-18: fractions,
 * radicals, accents, operators with limits, scripts); the second pass
 * converts misplaced binary operators to ordinary atoms, inserts the
 * inter-atom glue of TeX's spacing table (thin, medium and thick spaces,
 * suppressed in script styles) and, at the outer level of inline math, the
 * \binoppenalty and \relpenalty break points.
 */

import type { Color, HBox, HNode } from "../layout/types.js";
import type {
  AccentNode,
  BoxedNode,
  Dim,
  FracNode,
  MathList,
  MathNode,
  MiddleNode,
  OpNode,
  SqrtNode,
  StyleName,
  SymNode,
  TextFont,
  TextItem,
} from "./ast.js";
import { buildArray } from "./arrays.js";
import { alignIn, boxWith, centerIn, glueNode, glyphNode, hpack, kernNode, ruleNode, shifted, vstack } from "./boxes.js";
import { axisDelim, horizontalBrace, radicalSign, stretchArrow } from "./delims.js";
import { PLAIN, SIGMA, XI, glyphMetrics } from "./metrics.js";
import type { Cls, Fam, SymDef } from "./symbols.js";
import { styledChar } from "./unicode.js";

import { D, S, SS, type Style, T } from "./style.js";

export { D, S, SS, type Style, T } from "./style.js";

const SCALE = [1, 1, 1, 1, 0.7, 0.7, 0.5, 0.5] as const;
const SUP: readonly Style[] = [4, 5, 4, 5, 6, 7, 6, 7];
const NUM: readonly Style[] = [2, 3, 4, 5, 6, 7, 6, 7];

export const supStyle = (s: Style): Style => SUP[s]!;
export const subStyle = (s: Style): Style => (SUP[s]! | 1) as Style;
export const numStyle = (s: Style): Style => NUM[s]!;
export const denStyle = (s: Style): Style => (NUM[s]! | 1) as Style;
export const cramp = (s: Style): Style => (s | 1) as Style;
export const isDisplay = (s: Style): boolean => s < 2;
export const isScript = (s: Style): boolean => s >= 4;
export const isCramped = (s: Style): boolean => (s & 1) === 1;

export function styleOf(name: StyleName): Style {
  return name === "display" ? D : name === "text" ? T : name === "script" ? S : SS;
}

export interface Ctx {
  /** Body font size in points. */
  base: number;
  color?: Color;
}

export function sizeOf(style: Style, ctx: Ctx): number {
  return ctx.base * SCALE[style];
}

const sigma = (k: keyof typeof SIGMA, style: Style, ctx: Ctx) => SIGMA[k] * sizeOf(style, ctx);
const xi = (k: keyof typeof XI, style: Style, ctx: Ctx) => XI[k] * sizeOf(style, ctx);
export const axisOf = (style: Style, ctx: Ctx) => sigma("axisHeight", style, ctx);
/** One math unit (1/18 of the quad of the current size). */
export const muOf = (style: Style, ctx: Ctx) => sizeOf(style, ctx) / 18;

/** A length in points: em and ex refer to the body font (as in TeX), mu to the current style. */
export function toPt(d: Dim, style: Style, ctx: Ctx): number {
  switch (d.u) {
    case "pt":
      return d.v;
    case "em":
      return d.v * ctx.base;
    case "ex":
      return d.v * SIGMA.xHeight * ctx.base;
    case "mu":
      return d.v * muOf(style, ctx);
  }
}

const colorOf = (n: { color?: Color }, ctx: Ctx): Color | undefined => n.color ?? ctx.color;
const withColor = (ctx: Ctx, c: Color | undefined): Ctx => (c === ctx.color ? ctx : { ...ctx, color: c });

// ---------------------------------------------------------------- fonts

/** The face and code point that draw a symbol under a math alphabet. */
export function symFace(sym: SymDef, font: SymNode["font"]): { fam: Fam; cp: number; text: string } {
  const { cp } = sym;
  if (!font) return { fam: sym.fam, cp, text: sym.text };
  const upper = cp >= 0x41 && cp <= 0x5a;
  const lower = cp >= 0x61 && cp <= 0x7a;
  const digit = cp >= 0x30 && cp <= 0x39;
  const latin = (upper || lower) && sym.text.length === 1 && sym.text.codePointAt(0) === cp;
  const v = sym.variable;
  switch (font) {
    case "rm":
      return v ? { fam: "main", cp, text: sym.text } : { fam: sym.fam, cp, text: sym.text };
    case "it":
      return v ? { fam: "mainI", cp, text: sym.text } : { fam: sym.fam, cp, text: sym.text };
    case "bf":
      return v ? { fam: "mainB", cp, text: sym.text } : { fam: sym.fam, cp, text: sym.text };
    case "sf":
      return v ? { fam: "sf", cp, text: sym.text } : { fam: sym.fam, cp, text: sym.text };
    case "tt":
      return v ? { fam: "tt", cp, text: sym.text } : { fam: sym.fam, cp, text: sym.text };
    case "cal":
      return latin && upper ? { fam: "cal", cp, text: styledChar(sym.text, "script") } : { fam: sym.fam, cp, text: sym.text };
    case "scr":
      return latin && upper ? { fam: "script", cp, text: styledChar(sym.text, "script") } : { fam: sym.fam, cp, text: sym.text };
    case "frak":
      return latin || (digit && v) ? { fam: "frak", cp, text: styledChar(sym.text, "fraktur") } : { fam: sym.fam, cp, text: sym.text };
    case "bb":
      if (latin && upper) return { fam: "ams", cp, text: styledChar(sym.text, "double-struck") };
      if (latin && cp === 0x6b) return { fam: "ams", cp, text: styledChar(sym.text, "double-struck") };
      return v ? { fam: "mainB", cp, text: styledChar(sym.text, "double-struck") } : { fam: sym.fam, cp, text: sym.text };
    case "bsym":
      if (sym.fam === "mathI") return { fam: "mathBI", cp, text: sym.text };
      if (sym.fam === "main" && glyphMetrics("mainB", cp)) return { fam: "mainB", cp, text: sym.text };
      if (sym.fam === "mainI") return { fam: "mainBI", cp, text: sym.text };
      return { fam: sym.fam, cp, text: sym.text };
  }
}

// ---------------------------------------------------------------- spacing

type Sp = 0 | 1 | 2 | 3 | -1 | -2 | -3; // negative: only in display and text styles

const SPACING: Readonly<Record<Cls, Readonly<Record<Cls, Sp>>>> = {
  ord: { ord: 0, op: 1, bin: -2, rel: -3, open: 0, close: 0, punct: 0, inner: -1 },
  op: { ord: 1, op: 1, bin: 0, rel: -3, open: 0, close: 0, punct: 0, inner: -1 },
  bin: { ord: -2, op: -2, bin: 0, rel: 0, open: -2, close: 0, punct: 0, inner: -2 },
  rel: { ord: -3, op: -3, bin: 0, rel: 0, open: -3, close: 0, punct: 0, inner: -3 },
  open: { ord: 0, op: 0, bin: 0, rel: 0, open: 0, close: 0, punct: 0, inner: 0 },
  close: { ord: 0, op: 1, bin: -2, rel: -3, open: 0, close: 0, punct: 0, inner: -1 },
  punct: { ord: -1, op: -1, bin: 0, rel: -1, open: -1, close: -1, punct: -1, inner: -1 },
  inner: { ord: -1, op: 1, bin: -2, rel: -3, open: -1, close: 0, punct: -1, inner: -1 },
};

/** The glue TeX puts between two atoms, or null. */
export function interAtomGlue(left: Cls, right: Cls, style: Style, ctx: Ctx): HNode | null {
  const sp = SPACING[left][right];
  if (sp === 0) return null;
  if (sp < 0 && isScript(style)) return null;
  const mu = muOf(style, ctx);
  switch (Math.abs(sp)) {
    case 1:
      return glueNode(3 * mu);
    case 2:
      return glueNode(4 * mu, 2 * mu, 4 * mu);
    default:
      return glueNode(5 * mu, 5 * mu, 0);
  }
}

// ---------------------------------------------------------------- lists

interface AtomItem {
  k: "atom";
  cls: Cls;
  /** Class seen from the left and from the right (differ for \middle). */
  lcls?: Cls;
  rcls?: Cls;
  nodes: HNode[];
  style: Style;
  middle?: MiddleNode;
}

type Item = AtomItem | { k: "glue"; nodes: HNode[] } | { k: "penalty"; value: number };

export interface ListResult {
  box: HBox;
  /** Height and depth of the list without its \middle delimiters (for \left...\right). */
  h: number;
  d: number;
}

export interface ListOptions {
  /** Insert \binoppenalty / \relpenalty break points (outer level of inline math). */
  penalties?: boolean;
}

export function layoutList(list: MathList, style0: Style, ctx: Ctx, opts: ListOptions = {}): ListResult {
  const items: Item[] = [];
  let style = style0;
  let h = 0;
  let d = 0;
  let middles = false;
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    switch (n.type) {
      case "style":
        style = styleOf(n.style);
        continue;
      case "space":
        items.push({ k: "glue", nodes: [spaceNode(n, style, ctx)] });
        continue;
      case "penalty":
        items.push({ k: "penalty", value: n.value });
        continue;
      case "middle":
        middles = true;
        items.push({ k: "atom", cls: "open", lcls: "close", rcls: "open", nodes: [], style, middle: n });
        continue;
    }
    // Inside a word of a text font (\mathrm{diff}), TeX drops the italic correction.
    const a = n.type === "sym" && midWord(n, list[i + 1]) ? { cls: n.cls, nodes: charNucleus(n, style, ctx).nodes } : buildAtom(n, style, ctx);
    const box = hpack(a.nodes);
    if (box.height > h) h = box.height;
    if (box.depth > d) d = box.depth;
    items.push({ k: "atom", cls: a.cls, nodes: a.nodes, style });
  }
  if (middles) {
    for (const it of items) {
      if (it.k === "atom" && it.middle) {
        const st = it.style;
        const need = delimNeed(h, d, st, ctx);
        it.nodes = [axisDelim(it.middle.delim, need, sizeOf(st, ctx), axisOf(st, ctx), PLAIN.nullDelimiterSpace * ctx.base, colorOf(it.middle, ctx))];
      }
    }
  }
  // Rules 5 and 6: a binary operator with nothing to operate on becomes ordinary.
  let prev: AtomItem | null = null;
  for (const it of items) {
    if (it.k !== "atom") continue;
    const left = it.lcls ?? it.cls;
    if (it.cls === "bin" && (!prev || ["bin", "op", "rel", "open", "punct"].includes(prev.rcls ?? prev.cls))) it.cls = "ord";
    if ((left === "rel" || left === "close" || left === "punct") && prev && prev.cls === "bin") prev.cls = "ord";
    prev = it;
  }
  if (prev && prev.cls === "bin") prev.cls = "ord";
  // Second pass: spacing and penalties.
  const out: HNode[] = [];
  let last: AtomItem | null = null;
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    if (it.k === "glue") {
      out.push(...it.nodes);
      continue;
    }
    if (it.k === "penalty") {
      out.push({ t: "penalty", penalty: it.value });
      continue;
    }
    if (last) {
      const g = interAtomGlue(last.rcls ?? last.cls, it.lcls ?? it.cls, it.style, ctx);
      if (g) out.push(g);
    }
    out.push(...it.nodes);
    last = it;
    if (opts.penalties && (it.cls === "bin" || it.cls === "rel")) {
      const next = items[k + 1];
      if (next && next.k !== "penalty" && !(it.cls === "rel" && next.k === "atom" && (next.lcls ?? next.cls) === "rel")) {
        out.push({ t: "penalty", penalty: it.cls === "bin" ? 700 : 500 });
      }
    }
  }
  return { box: hpack(out), h, d };
}

/** Lay out a list and return just the box. */
export function listBox(list: MathList, style: Style, ctx: Ctx): HBox {
  return layoutList(list, style, ctx).box;
}

function spaceNode(n: Extract<MathNode, { type: "space" }>, style: Style, ctx: Ctx): HNode {
  const w = toPt(n.dim, style, ctx);
  if (n.kern) return kernNode(w, n.dim.u === "mu" ? "math" : undefined);
  const stretch = n.stretch ? (n.fil ? n.stretch.v : toPt(n.stretch, style, ctx)) : 0;
  const shrink = n.shrink ? toPt(n.shrink, style, ctx) : 0;
  return glueNode(w, stretch, shrink, n.fil ?? 0);
}

/** Rule 19: the size a \left...\right delimiter must reach to cover height h and depth d. */
export function delimNeed(h: number, d: number, style: Style, ctx: Ctx): number {
  const a = axisOf(style, ctx);
  const delta = Math.max(h - a, d + a);
  return Math.max(2 * delta * PLAIN.delimiterFactor, 2 * delta - PLAIN.delimiterShortfall * ctx.base);
}

// ---------------------------------------------------------------- atoms

interface Built {
  cls: Cls;
  nodes: HNode[];
}

/** A translated nucleus, before its scripts are attached. */
interface Nucleus {
  nodes: HNode[];
  w: number;
  h: number;
  d: number;
  /** Italic correction (points). */
  italic: number;
  /** The nucleus was a single character (Rule 18a uses u = v = 0). */
  isChar: boolean;
  /** Append the italic correction as a kern when there is no subscript. */
  kernItalic: boolean;
  cls: Cls;
  /** Operator with limits above and below (Rule 13a). */
  limits?: boolean;
}

function nucleusFromBox(box: HBox, cls: Cls): Nucleus {
  return { nodes: [box], w: box.width, h: box.height - (box.shift ?? 0), d: box.depth + (box.shift ?? 0), italic: 0, isChar: false, kernItalic: false, cls };
}

function finish(n: Nucleus): Built {
  const nodes = n.kernItalic && n.italic > 0 ? [...n.nodes, kernNode(n.italic, "italic")] : n.nodes;
  return { cls: n.cls, nodes };
}

/** A {...} group holding a single ordinary character is that character (TeX's simplification in math_group). */
function simpleChar(n: MathNode): SymNode | null {
  if (n.type === "sym") return n;
  if (n.type === "group" && (!n.cls || n.cls === "ord") && n.body.length === 1) {
    const only = n.body[0]!;
    if (only.type === "sym" && only.cls === "ord") return n.color && !only.color ? { ...only, color: n.color } : only;
    if (only.type === "group") return simpleChar(only);
  }
  return null;
}

/** Faces with an interword space (TeX's "text fonts"), where letters inside a word get no italic correction. */
const TEXT_FAMS: ReadonlySet<Fam> = new Set<Fam>(["main", "mainB", "mainI", "mainBI", "sf", "sfB", "sfI", "tt"]);

function midWord(n: SymNode, next: MathNode | undefined): boolean {
  if (!next || next.type !== "sym" || n.cls !== "ord" || next.cls !== "ord") return false;
  const a = symFace(n.sym, n.font).fam;
  return TEXT_FAMS.has(a) && symFace(next.sym, next.font).fam === a;
}

function charNucleus(n: SymNode, style: Style, ctx: Ctx, cls: Cls = n.cls): Nucleus {
  const size = sizeOf(style, ctx);
  const face = symFace(n.sym, n.font);
  const g = glyphNode(face.fam, face.cp, size, face.text, colorOf(n, ctx));
  return { nodes: [g.node], w: g.node.width, h: g.node.height, d: g.node.depth, italic: g.m.italic * size, isChar: true, kernItalic: true, cls };
}

function opNucleus(n: OpNode, style: Style, ctx: Ctx): Nucleus {
  const size = sizeOf(style, ctx);
  const color = colorOf(n, ctx);
  const limits = n.limits === "limits" || (n.limits === "display" && isDisplay(style));
  if (n.sym) {
    const face = n.sym.big ? { fam: (isDisplay(style) ? "size2" : "size1") as Fam, cp: n.sym.cp, text: n.sym.text } : symFace(n.sym, n.font);
    const g = glyphNode(face.fam, face.cp, size, face.text, color);
    const box = hpack([g.node]);
    // Centre on the axis (Rule 13).
    const shift = (box.height - box.depth) / 2 - axisOf(style, ctx);
    const placed = shifted(box, shift);
    return { nodes: [placed], w: box.width, h: box.height - shift, d: box.depth + shift, italic: g.m.italic * size, isChar: false, kernItalic: true, cls: "op", limits };
  }
  let box: HBox;
  if (n.name !== undefined) box = nameBox(n.name, size, color);
  else box = listBox(n.body ?? [], style, withColor(ctx, color));
  return { ...nucleusFromBox(box, "op"), limits };
}

/** An operator name (sin, lim inf) in roman; U+2009 marks a thin space. */
function nameBox(name: string, size: number, color?: Color): HBox {
  const nodes: HNode[] = [];
  for (const ch of name) {
    if (ch === " ") nodes.push(kernNode((3 / 18) * size));
    else nodes.push(glyphNode("main", ch.codePointAt(0)!, size, ch, color).node);
  }
  return hpack(nodes);
}

function nucleusOf(n: MathNode, style: Style, ctx: Ctx): Nucleus {
  const ch = simpleChar(n);
  if (ch) return charNucleus(ch, style, ctx, n.type === "sym" ? n.cls : "ord");
  if (n.type === "op") return opNucleus(n, style, ctx);
  const b = buildAtom(n, style, ctx);
  const box = hpack(b.nodes);
  const nuc = nucleusFromBox(box, b.cls);
  if (n.type === "brace" || n.type === "stack" || n.type === "xarrow") nuc.limits = true;
  return nuc;
}

export function buildAtom(n: MathNode, style: Style, ctx: Ctx): Built {
  const color = colorOf(n, ctx);
  const c = withColor(ctx, color);
  switch (n.type) {
    case "sym":
      return finish(charNucleus(n, style, ctx));
    case "group": {
      const ch = simpleChar(n);
      if (ch) return finish(charNucleus(ch, style, ctx, n.cls ?? "ord"));
      return { cls: n.cls ?? "ord", nodes: [listBox(n.body, style, c)] };
    }
    case "op":
      return finish(opNucleus(n, style, ctx));
    case "supsub":
      return scripts(n, style, ctx);
    case "frac":
      return fraction(n, style, c);
    case "sqrt":
      return radical(n, style, c);
    case "accent":
      return accent(n, style, c, null, null);
    case "overline": {
      const x = listBox(n.body, cramp(style), c);
      const t = xi("ruleThickness", style, ctx);
      const v = vstack([
        { node: ruleNode(x.width, t, 0, color), base: x.height + 3 * t },
        { node: x, base: 0 },
      ]);
      v.children.unshift(kernNode(t));
      v.height += t;
      return { cls: "ord", nodes: [v] };
    }
    case "underline": {
      const x = listBox(n.body, style, c);
      const t = xi("ruleThickness", style, ctx);
      const v = vstack([
        { node: x, base: 0 },
        { node: ruleNode(x.width, t, 0, color), base: -(x.depth + 3 * t + t) },
      ]);
      v.children.push(kernNode(t));
      v.depth += t;
      return { cls: "ord", nodes: [v] };
    }
    case "brace": {
      const x = listBox(n.body, D, c);
      const size = sizeOf(style, ctx);
      const br = horizontalBrace(x.width, n.over, size, color);
      const w = Math.max(x.width, br.width);
      const gap = 0.3 * ctx.base;
      const xc = centerIn(x, w);
      const bc = centerIn(br, w);
      const v = n.over
        ? vstack([
            { node: bc, base: x.height + gap + br.depth },
            { node: xc, base: 0 },
          ])
        : vstack([
            { node: xc, base: 0 },
            { node: bc, base: -(x.depth + gap + br.height) },
          ]);
      if (n.over) {
        v.children.unshift(kernNode(gap));
        v.height += gap;
      } else {
        v.children.push(kernNode(gap));
        v.depth += gap;
      }
      return { cls: "op", nodes: [v] };
    }
    case "arrowacc": {
      const x = listBox(n.body, style, c);
      const size = sizeOf(style, ctx);
      const ar = stretchArrow(n.arrow, x.width, size, color);
      const w = Math.max(x.width, ar.width);
      const xc = centerIn(x, w);
      const v = n.over
        ? vstack([
            { node: ar, base: x.height - 0.1 * ctx.base + ar.depth },
            { node: xc, base: 0 },
          ])
        : vstack([
            { node: xc, base: 0 },
            { node: ar, base: -(x.depth + ar.height) },
          ]);
      return { cls: "ord", nodes: [v] };
    }
    case "leftright": {
      const inner = layoutList(n.body, style, c);
      const size = sizeOf(style, ctx);
      const need = delimNeed(inner.h, inner.d, style, ctx);
      const nds = PLAIN.nullDelimiterSpace * ctx.base;
      const a = axisOf(style, ctx);
      return {
        cls: "inner",
        nodes: [axisDelim(n.left, need, size, a, nds, color), inner.box, axisDelim(n.right, need, size, a, nds, color)],
      };
    }
    case "middle":
      return { cls: "ord", nodes: [] };
    case "big": {
      const size = sizeOf(style, ctx);
      const h = [0.85, 1.15, 1.45, 1.75][n.size - 1]! * size;
      const need = delimNeed(h, 0, style, ctx);
      const b = axisDelim(n.delim, need, size, axisOf(style, ctx), 0, color);
      return { cls: n.cls, nodes: [b] };
    }
    case "text": {
      const size = n.fixedSize ? ctx.base : sizeOf(style, ctx);
      return { cls: "ord", nodes: [textBox(n.body, size, c)] };
    }
    case "phantom": {
      const x = listBox(n.body, style, c);
      return { cls: "ord", nodes: [boxWith([], n.h ? x.width : 0, n.v ? x.height : 0, n.v ? x.depth : 0)] };
    }
    case "smash": {
      const x = listBox(n.body, style, c);
      return { cls: "ord", nodes: [boxWith([x], x.width, n.top ? 0 : x.height, n.bottom ? 0 : x.depth)] };
    }
    case "lap": {
      const x = listBox(n.body, style, c);
      const w = x.width;
      const kids: HNode[] = n.align === "l" ? [kernNode(-w), x] : n.align === "r" ? [x, kernNode(-w)] : [kernNode(-w / 2), x, kernNode(-w / 2)];
      return { cls: "ord", nodes: [boxWith(kids, 0, x.height, x.depth)] };
    }
    case "cancel":
      return { cls: "ord", nodes: [cancelled(n, style, c)] };
    case "boxed":
      return { cls: "ord", nodes: [framed(n, style, c)] };
    case "array":
      return { cls: "ord", nodes: buildArray(n, style, c) };
    case "not":
      return negation(n, style, c);
    case "xarrow":
      return xarrow(n, style, c);
    case "stack": {
      const base = listBox(n.base, style, c);
      const nuc = nucleusFromBox(base, n.cls);
      return { cls: n.cls, nodes: limitsBox(nuc, n.over, n.under, style, c) };
    }
    case "rule": {
      const w = toPt(n.width, style, ctx);
      const h = toPt(n.height, style, ctx);
      const r = n.raise ? toPt(n.raise, style, ctx) : 0;
      const rule = ruleNode(w, h, 0, color);
      return { cls: "ord", nodes: [r ? shifted(hpack([rule]), -r) : hpack([rule])] };
    }
    case "raise": {
      const x = listBox(n.body, style, c);
      return { cls: "ord", nodes: [shifted(x, -toPt(n.dim, style, ctx))] };
    }
    case "style":
    case "space":
    case "penalty":
      return { cls: "ord", nodes: [] };
  }
}

// ---------------------------------------------------------------- scripts (Rules 13a, 18)

function scripts(n: Extract<MathNode, { type: "supsub" }>, style: Style, ctx: Ctx): Built {
  if (n.base && n.base.type === "accent") {
    // Rule 12's special case: scripts on an accented character go on the character.
    const ch = simpleBody(n.base.body);
    if (ch) return accent(n.base, style, withColor(ctx, colorOf(n.base, ctx)), n.sup, n.sub);
  }
  const nuc: Nucleus = n.base ? nucleusOf(n.base, style, ctx) : { nodes: [], w: 0, h: 0, d: 0, italic: 0, isChar: false, kernItalic: false, cls: "ord" };
  if (nuc.limits) return { cls: nuc.cls, nodes: limitsBox(nuc, n.sup, n.sub, style, ctx) };
  return { cls: nuc.cls, nodes: attachScripts(nuc, n.sup, n.sub, style, ctx) };
}

function simpleBody(list: MathList): SymNode | null {
  if (list.length !== 1) return null;
  return simpleChar(list[0]!);
}

/** Rule 18: superscripts and subscripts beside a nucleus. */
function attachScripts(nuc: Nucleus, sup: MathList | null, sub: MathList | null, style: Style, ctx: Ctx): HNode[] {
  const sizeC = sizeOf(style, ctx);
  const scriptSpace = PLAIN.scriptSpace * ctx.base;
  const xh = SIGMA.xHeight * sizeC;
  const supSt = supStyle(style);
  const subSt = subStyle(style);
  let u = 0;
  let v = 0;
  if (!nuc.isChar) {
    u = nuc.h - SIGMA.supDrop * sizeOf(supSt, ctx);
    v = nuc.d + SIGMA.subDrop * sizeOf(subSt, ctx);
  }
  const delta = nuc.italic;
  if (!sup && !sub) return finish(nuc).nodes;
  if (!sup) {
    // 18b: subscript only; no italic correction.
    const x = listBox(sub!, subSt, ctx);
    const xb = boxWith([...x.children], x.width + scriptSpace, x.height, x.depth);
    v = Math.max(v, SIGMA.sub1 * sizeC, x.height - (4 / 5) * xh);
    return [...nuc.nodes, shifted(xb, v)];
  }
  // 18c
  const x = listBox(sup, supSt, ctx);
  const xb = boxWith([...x.children], x.width + scriptSpace, x.height, x.depth);
  const p = isDisplay(style) && !isCramped(style) ? SIGMA.sup1 : isCramped(style) ? SIGMA.sup3 : SIGMA.sup2;
  u = Math.max(u, p * sizeC, x.depth + xh / 4);
  if (!sub) {
    // 18d: the italic correction stays in the nucleus.
    return [...finish(nuc).nodes, shifted(xb, -u)];
  }
  // 18e
  const y = listBox(sub, subSt, ctx);
  const yb = boxWith([...y.children], y.width + scriptSpace, y.height, y.depth);
  v = Math.max(v, SIGMA.sub2 * sizeC);
  const theta = xi("ruleThickness", style, ctx);
  if (u - x.depth - (y.height - v) < 4 * theta) {
    v = 4 * theta - u + x.depth + y.height;
    const psi = (4 / 5) * xh - (u - x.depth);
    if (psi > 0) {
      u += psi;
      v -= psi;
    }
  }
  // 18f: superscript shifted right by the italic correction.
  const vb = vstack([
    { node: shifted(xb, delta), base: u },
    { node: yb, base: -v },
  ]);
  return [...nuc.nodes, vb];
}

/** Rule 13a: limits above and below an operator. */
function limitsBox(nuc: Nucleus, sup: MathList | null, sub: MathList | null, style: Style, ctx: Ctx): HNode[] {
  if (!sup && !sub) return finish(nuc).nodes;
  const x = sup ? listBox(sup, supStyle(style), ctx) : null;
  const z = sub ? listBox(sub, subStyle(style), ctx) : null;
  return limitsFromBoxes(nuc, x, z, style, ctx);
}

// ---------------------------------------------------------------- fractions (Rule 15)

const INFIX = new Set(["\\over", "\\atop", "\\choose", "\\brace", "\\brack", "\\above", "\\overwithdelims", "\\atopwithdelims", "\\abovewithdelims"]);

function fraction(n: FracNode, style0: Style, ctx: Ctx): Built {
  const C = n.style ? styleOf(n.style) : style0;
  const size = sizeOf(C, ctx);
  const color = ctx.color;
  const theta = n.thickness === null ? XI.ruleThickness * size : toPt(n.thickness, C, ctx);
  let x = listBox(n.num, numStyle(C), ctx);
  const z = listBox(n.den, denStyle(C), ctx);
  if (n.cfrac) {
    // \cfrac: a strut in the numerator
    x = boxWith(x.children, x.width, Math.max(x.height, PLAIN.strutHeight * ctx.base), Math.max(x.depth, PLAIN.strutDepth * ctx.base));
  }
  let u: number;
  let v: number;
  if (isDisplay(C)) {
    u = SIGMA.num1 * size;
    v = SIGMA.denom1 * size;
  } else {
    u = (theta !== 0 ? SIGMA.num2 : SIGMA.num3) * size;
    v = SIGMA.denom2 * size;
  }
  const a = SIGMA.axisHeight * size;
  if (theta === 0) {
    const phi = (isDisplay(C) ? 7 : 3) * XI.ruleThickness * size;
    const psi = u - x.depth - (z.height - v);
    if (psi < phi) {
      u += (phi - psi) / 2;
      v += (phi - psi) / 2;
    }
  } else {
    const phi = isDisplay(C) ? 3 * theta : theta;
    const c1 = u - x.depth - (a + theta / 2);
    if (c1 < phi) u += phi - c1;
    const c2 = a - theta / 2 - (z.height - v);
    if (c2 < phi) v += phi - c2;
  }
  const w = Math.max(x.width, z.width);
  const xc = n.cfrac ? alignIn(x, w, n.cfrac) : centerIn(x, w);
  const zc = centerIn(z, w);
  const items: { node: HBox | ReturnType<typeof ruleNode>; base: number }[] = [{ node: xc, base: u }];
  if (theta !== 0) items.push({ node: ruleNode(w, theta, 0, color), base: a - theta / 2 });
  items.push({ node: zc, base: -v });
  const frac = vstack(items);
  const need = (isDisplay(C) ? SIGMA.delim1 : SIGMA.delim2) * size;
  const nds = PLAIN.nullDelimiterSpace * ctx.base;
  const nodes: HNode[] = [axisDelim(n.left, need, size, a, nds, color), frac, axisDelim(n.right, need, size, a, nds, color)];
  if (n.cfrac) nodes.push(kernNode(-nds));
  return { cls: INFIX.has(n.cmd) ? "inner" : "ord", nodes };
}

// ---------------------------------------------------------------- radicals (Rule 11)

function radical(n: SqrtNode, style: Style, ctx: Ctx): Built {
  const size = sizeOf(style, ctx);
  const color = ctx.color;
  const x = listBox(n.body, cramp(style), ctx);
  const theta = XI.ruleThickness * size;
  let clr = isDisplay(style) ? theta + (SIGMA.xHeight * size) / 4 : theta + theta / 4;
  const sign = radicalSign(x.height + x.depth + clr + theta, size, color);
  const ink = sign.top - sign.bottom;
  const excess = ink - theta - (x.height + x.depth + clr);
  if (excess > 0) clr += excess / 2;
  // The sign's ink top meets the top of the rule.
  const signShift = -(x.height + clr + theta - sign.top);
  const body = vstack([
    { node: ruleNode(x.width, theta, 0, color), base: x.height + clr },
    { node: x, base: 0 },
  ]);
  body.children.unshift(kernNode(theta));
  body.height += theta;
  let nodes: HNode[] = [shifted(sign.box, signShift), body];
  if (n.index && n.index.length) {
    const r = hpack(nodes);
    const idx = listBox(n.index, SS, ctx);
    const mu = muOf(style, ctx);
    const raise = 0.6 * (r.height - r.depth);
    nodes = [kernNode(5 * mu), shifted(idx, -raise), kernNode(-10 * mu), r];
  }
  return { cls: "ord", nodes };
}

// ---------------------------------------------------------------- accents (Rule 12)

function accent(n: AccentNode, style: Style, ctx: Ctx, sup: MathList | null, sub: MathList | null): Built {
  const size = sizeOf(style, ctx);
  const color = ctx.color;
  const ch = simpleBody(n.body);
  let x: HBox;
  let skew = 0;
  let charH = 0;
  if (ch) {
    const nuc = charNucleus(ch, cramp(style), ctx, "ord");
    const face = symFace(ch.sym, ch.font);
    skew = (glyphMetrics(face.fam, face.cp)?.skew ?? 0) * size;
    charH = nuc.h;
    // With scripts, TeX boxes the character and its scripts in the current (uncramped) style.
    x = hpack(sup || sub ? attachScripts(charNucleus(ch, style, ctx, "ord"), sup, sub, style, ctx) : finish(nuc).nodes);
  } else {
    x = listBox(n.body, cramp(style), ctx);
    charH = x.height;
  }
  const w = ch ? hpack(charNucleus(ch, cramp(style), ctx, "ord").nodes).width : x.width;
  // Choose the accent glyph: wide accents take the largest variant no wider than the base.
  let fam: Fam = "main";
  if (n.accent.wide) {
    fam = "size1";
    for (const f of ["size1", "size2", "size3", "size4"] as const) {
      const m = glyphMetrics(f, n.accent.cp);
      if (m && m.width * size <= w) fam = f;
    }
  }
  const g = glyphNode(fam, n.accent.cp, size, String.fromCodePoint(n.accent.cp), color);
  const delta = Math.min(charH, SIGMA.xHeight * size);
  const inkCenter = ((g.m.xMin + g.m.xMax) / 2) * size;
  const offset = skew + w / 2 - inkCenter;
  const accRow = boxWith([kernNode(offset), g.node], Math.max(0, x.width), g.node.height, g.node.depth);
  // The accent's baseline sits delta below the top of the base.
  // The accent's baseline sits delta below the top of the base character.
  const v = vstack([
    { node: accRow, base: charH - delta + g.node.depth },
    { node: x, base: 0 },
  ]);
  v.width = x.width;
  if (v.height < x.height) {
    // keep the full height of the base (a kern on top, as TeX does)
    v.children.unshift(kernNode(x.height - v.height));
    v.height = x.height;
  }
  return { cls: "ord", nodes: [v] };
}

// ---------------------------------------------------------------- negation, arrows, frames

function negation(n: Extract<MathNode, { type: "not" }>, style: Style, ctx: Ctx): Built {
  const size = sizeOf(style, ctx);
  const color = ctx.color;
  const slash = glyphNode("main", 0xe020, size, "̸", color);
  if (!n.body) return { cls: "rel", nodes: [slash.node] };
  const b = buildAtom(n.body, style, ctx);
  const box = hpack(b.nodes);
  const inkCenter = ((slash.m.xMin + slash.m.xMax) / 2) * size;
  const back = box.width / 2 - inkCenter - box.width;
  const nodes: HNode[] = [box, kernNode(back), slash.node, kernNode(-(back + slash.node.width))];
  return { cls: b.cls === "ord" && n.body.type !== "sym" ? "ord" : b.cls === "ord" ? "rel" : b.cls, nodes: [hpack(nodes)] };
}

function xarrow(n: Extract<MathNode, { type: "xarrow" }>, style: Style, ctx: Ctx): Built {
  const size = sizeOf(style, ctx);
  const color = ctx.color;
  const smu = muOf(supStyle(style), ctx);
  const leftward = n.arrow.left !== 0 && n.arrow.right === 0;
  const padL = (leftward ? 9 : 5) * smu;
  const padR = (leftward ? 5 : 9) * smu;
  const above = n.above ? listBox(n.above, supStyle(style), ctx) : null;
  const below = n.below ? listBox(n.below, subStyle(style), ctx) : null;
  const need = Math.max(above ? padL + above.width + padR : 0, below ? padL + below.width + padR : 0);
  const arrow = stretchArrow(n.arrow, need, size, color);
  const nuc = nucleusFromBox(arrow, "rel");
  // amsmath sets the labels as limits with a 3mu kern on the side away from the arrowhead.
  const pad = (b: HBox | null): HBox | null => (b ? hpack(leftward ? [kernNode(3 * smu), b] : [b, kernNode(3 * smu)]) : null);
  return { cls: "rel", nodes: limitsFromBoxes(nuc, pad(above), pad(below), style, ctx) };
}

/** Rule 13a with prebuilt limit boxes; the limits are skewed by the operator's italic correction. */
function limitsFromBoxes(nuc: Nucleus, x: HBox | null, z: HBox | null, style: Style, ctx: Ctx): HNode[] {
  const delta = nuc.italic;
  const y = hpack(finish(nuc).nodes);
  const w = Math.max(y.width, x?.width ?? 0, z?.width ?? 0);
  const items: { node: HBox; base: number }[] = [];
  const sp5 = xi("bigOpSpacing5", style, ctx);
  if (x) items.push({ node: shifted(centerIn(x, w), delta / 2), base: y.height + Math.max(xi("bigOpSpacing1", style, ctx), xi("bigOpSpacing3", style, ctx) - x.depth) + x.depth });
  items.push({ node: centerIn(y, w), base: 0 });
  if (z) items.push({ node: shifted(centerIn(z, w), -delta / 2), base: -(y.depth + Math.max(xi("bigOpSpacing2", style, ctx), xi("bigOpSpacing4", style, ctx) - z.height) + z.height) });
  const v = vstack(items);
  if (x) {
    v.children.unshift(kernNode(sp5));
    v.height += sp5;
  }
  if (z) {
    v.children.push(kernNode(sp5));
    v.depth += sp5;
  }
  return [v];
}

/**
 * \cancel and friends: the body with a diagonal stroke across it. The stroke is
 * drawn as a staircase of thin rules, each a fraction of a point wide.
 */
function cancelled(n: Extract<MathNode, { type: "cancel" }>, style: Style, ctx: Ctx): HBox {
  const x = listBox(n.body, style, ctx);
  const w = x.width;
  if (w <= 0) return x;
  const t = PLAIN.fboxRule * ctx.base;
  const pad = 0.15 * ctx.base;
  const top = x.height + pad;
  const bottom = -(x.depth + pad);
  const steps = Math.min(400, Math.max(4, Math.ceil(w / (0.05 * ctx.base))));
  const dx = w / steps;
  const kids: HNode[] = [x];
  const stroke = (up: boolean) => {
    kids.push(kernNode(-w));
    for (let i = 0; i < steps; i++) {
      const f0 = i / steps;
      const f1 = (i + 1) / steps;
      const y0 = up ? bottom + (top - bottom) * f0 : top - (top - bottom) * f0;
      const y1 = up ? bottom + (top - bottom) * f1 : top - (top - bottom) * f1;
      kids.push(ruleNode(dx, Math.max(y0, y1) + t / 2, -(Math.min(y0, y1) - t / 2), ctx.color));
    }
  };
  if (n.strike !== "\\") stroke(true);
  if (n.strike !== "/") stroke(false);
  return hpack(kids);
}

function framed(n: BoxedNode, style: Style, ctx: Ctx): HBox {
  const x = listBox(n.body, style, { ...ctx, color: n.frameless ? ctx.color : ctx.color });
  const sep = PLAIN.fboxSep * ctx.base;
  const rw = n.frameless ? 0 : PLAIN.fboxRule * ctx.base;
  const color = ctx.color;
  const innerW = x.width + 2 * sep;
  const H = x.height + sep + rw;
  const Dp = x.depth + sep + rw;
  const kids: HNode[] = [];
  if (n.fill) {
    // background first, then step back over it
    kids.push(ruleNode(innerW + 2 * rw, H, Dp, n.fill), kernNode(-(innerW + 2 * rw)));
  }
  if (rw) kids.push(ruleNode(rw, H, Dp, color));
  const middle = vstack([
    ...(rw ? [{ node: ruleNode(innerW, rw, 0, color), base: x.height + sep }] : []),
    { node: boxWith([kernNode(sep), x, kernNode(sep)], innerW, x.height, x.depth), base: 0 },
    ...(rw ? [{ node: ruleNode(innerW, rw, 0, color), base: -(x.depth + sep + rw) }] : []),
  ]);
  if (!rw) {
    middle.height = H;
    middle.depth = Dp;
  }
  kids.push(middle);
  if (rw) kids.push(ruleNode(rw, H, Dp, color));
  return hpack(kids);
}

// ---------------------------------------------------------------- text

const TEXT_FACES: Record<string, Fam> = {
  "rm.0.0": "main",
  "rm.1.0": "mainB",
  "rm.0.1": "mainI",
  "rm.1.1": "mainBI",
  "sf.0.0": "sf",
  "sf.1.0": "sfB",
  "sf.0.1": "sfI",
  "sf.1.1": "sfB",
  "tt.0.0": "tt",
  "tt.1.0": "tt",
  "tt.0.1": "tt",
  "tt.1.1": "tt",
};

export function textFace(f: TextFont): Fam {
  return TEXT_FACES[`${f.family}.${f.bold ? 1 : 0}.${f.italic ? 1 : 0}`]!;
}

/** Text-mode material (\text, tags) at the given size. */
export function textBox(items: readonly TextItem[], size: number, ctx: Ctx): HBox {
  const nodes: HNode[] = [];
  for (const it of items) {
    const color = it.color ?? ctx.color;
    switch (it.k) {
      case "chars": {
        const fam = textFace(it.font);
        for (const ch of it.s) {
          if (ch === " ") {
            nodes.push(glueNode(PLAIN.interwordSpace * size));
            continue;
          }
          nodes.push(glyphNode(fam, ch.codePointAt(0)!, size, ch, color).node);
        }
        break;
      }
      case "space":
        if (it.dim) nodes.push(glueNode(it.dim.u === "em" ? it.dim.v * size : it.dim.u === "ex" ? it.dim.v * SIGMA.xHeight * size : it.dim.u === "mu" ? (it.dim.v * size) / 18 : it.dim.v));
        else nodes.push(glueNode(PLAIN.interwordSpace * size, PLAIN.interwordStretch * size, PLAIN.interwordShrink * size));
        break;
      case "math":
        nodes.push(listBox(it.body, T, { base: size, color }));
        break;
      case "accent": {
        const fam = textFace(it.font);
        const base = glyphNode(fam, it.base ? it.base.codePointAt(0)! : 0x20, size, (it.base + it.mark).normalize("NFC"), color);
        const acc = glyphNode("main", it.cp, size, "", color);
        const raise = it.below ? 0 : Math.max(0, base.m.height - SIGMA.xHeight) * size;
        const slant = fam === "mainI" || fam === "mainBI" || fam === "sfI" ? 0.25 * raise : 0;
        const accCenter = ((acc.m.xMin + acc.m.xMax) / 2) * size;
        const before = -base.node.width + base.node.width / 2 - accCenter + slant;
        const node = { ...acc.node, yOffsets: [raise], height: acc.node.height + raise };
        nodes.push(base.node, kernNode(before), node, kernNode(-(before + acc.node.width)));
        break;
      }
    }
  }
  return hpack(nodes);
}
