/**
 * Small constructors for the box-and-glue model of src/layout/types.ts.
 * All sizes are points. A VBox's height is the distance from its top to its
 * baseline; its children stack downward from the top (TeX's \vbox model).
 */

import { type Font, fallbackFor } from "../font/index.js";
import type { Color, Glue, GlueOrder, Glyphs, HBox, HNode, Kern, Rule, VBox, VNode } from "../layout/types.js";
import { type GlyphMetrics, glyphMetrics, notdefMetrics } from "./metrics.js";
import { type Fam, famFont } from "./symbols.js";

export function kernNode(width: number, subtype?: Kern["subtype"]): Kern {
  const k: Kern = { t: "kern", width };
  if (subtype) k.subtype = subtype;
  return k;
}

export function glueNode(width: number, stretch = 0, shrink = 0, stretchOrder: GlueOrder = 0): Glue {
  return { t: "glue", width, stretch, stretchOrder, shrink, shrinkOrder: 0 };
}

export function ruleNode(width: number, height: number, depth: number, color?: Color): Rule {
  const r: Rule = { t: "rule", width, height, depth };
  if (color) r.color = color;
  return r;
}

/** Width, height and depth of a node as it sits in a horizontal list. */
export function hdims(n: HNode): { w: number; h: number; d: number } {
  switch (n.t) {
    case "glyphs":
      return { w: n.width, h: n.height, d: n.depth };
    case "hbox":
    case "vbox": {
      const s = n.shift ?? 0;
      return { w: n.width, h: n.height - s, d: n.depth + s };
    }
    case "rule":
      return { w: n.width ?? 0, h: n.height ?? 0, d: n.depth ?? 0 };
    case "kern":
      return { w: n.width, h: 0, d: 0 };
    case "glue":
      return { w: n.width, h: 0, d: 0 };
    case "image":
    case "drawing":
      return { w: n.width, h: n.height, d: n.depth };
    case "penalty":
      return { w: 0, h: 0, d: 0 };
    default:
      return { w: 0, h: 0, d: 0 };
  }
}

function sameRun(a: Glyphs, b: Glyphs): boolean {
  if (a.font !== b.font || a.size !== b.size || a.yOffsets || b.yOffsets) return false;
  const ca = a.color;
  const cb = b.color;
  if (!ca || !cb) return ca === cb;
  return ca[0] === cb[0] && ca[1] === cb[1] && ca[2] === cb[2];
}

/**
 * Pack a horizontal list at its natural width. Adjacent glyph runs of the
 * same font, size and color are merged into one Glyphs node. Unshifted
 * HBoxes without glue setting are flattened into the list.
 */
export function hpack(children: readonly HNode[]): HBox {
  const out: HNode[] = [];
  let w = 0;
  let h = 0;
  let d = 0;
  // Runs merged in this call are copies we own and may extend in place (keeps packing linear).
  let owned: Glyphs | null = null;
  const add = (n: HNode) => {
    const last = out[out.length - 1];
    if (n.t === "glyphs" && last && last.t === "glyphs" && sameRun(last, n)) {
      let run = last;
      if (run !== owned) {
        run = { ...last, gids: [...last.gids], advances: [...last.advances], text: [...last.text] };
        out[out.length - 1] = run;
        owned = run;
      }
      for (let k = 0; k < n.gids.length; k++) {
        run.gids.push(n.gids[k]!);
        run.advances.push(n.advances[k]!);
        run.text.push(n.text[k]!);
      }
      run.width += n.width;
      if (n.height > run.height) run.height = n.height;
      if (n.depth > run.depth) run.depth = n.depth;
    } else out.push(n);
    const m = hdims(n);
    w += m.w;
    if (m.h > h) h = m.h;
    if (m.d > d) d = m.d;
  };
  for (const n of children) {
    if (n.t === "hbox" && !n.shift && !n.glueSet && Math.abs(n.width - sumWidth(n.children)) < 1e-9 && boxMatches(n)) {
      for (const c of n.children) add(c);
    } else add(n);
  }
  return { t: "hbox", width: w, height: h, depth: d, children: out };
}

function sumWidth(children: readonly HNode[]): number {
  let w = 0;
  for (const c of children) w += hdims(c).w;
  return w;
}

/** True when a box's declared height and depth equal what its children need (so flattening keeps them). */
function boxMatches(b: HBox): boolean {
  let h = 0;
  let d = 0;
  for (const c of b.children) {
    const m = hdims(c);
    if (m.h > h) h = m.h;
    if (m.d > d) d = m.d;
  }
  return Math.abs(h - b.height) < 1e-9 && Math.abs(d - b.depth) < 1e-9;
}

/** An HBox with explicit dimensions (the contents may stick out). */
export function boxWith(children: HNode[], width: number, height: number, depth: number): HBox {
  return { t: "hbox", width, height, depth, children };
}

/** A copy of a box moved down (positive) or up (negative) in an HBox, or right in a VBox. */
export function shifted<T extends HBox | VBox>(b: T, shift: number): T {
  if (Math.abs(shift) < 1e-12) return b;
  return { ...b, shift: (b.shift ?? 0) + shift };
}

/** Wrap any node in an HBox (so it can be shifted). */
export function boxOf(n: HNode): HBox {
  if (n.t === "hbox") return n;
  return hpack([n]);
}

/** Center a box horizontally in the given width. */
export function centerIn(b: HBox, width: number): HBox {
  if (Math.abs(b.width - width) < 1e-9) return b;
  const l = (width - b.width) / 2;
  return boxWith([kernNode(l), b, kernNode(width - b.width - l)], width, b.height - (b.shift ?? 0), b.depth + (b.shift ?? 0));
}

/** Align a box in the given width ("l", "c", "r"). */
export function alignIn(b: HBox, width: number, align: "l" | "c" | "r"): HBox {
  if (align === "c") return centerIn(b, width);
  const extra = width - b.width;
  if (Math.abs(extra) < 1e-9) return b;
  const children: HNode[] = align === "l" ? [b, kernNode(extra)] : [kernNode(extra), b];
  return boxWith(children, width, b.height - (b.shift ?? 0), b.depth + (b.shift ?? 0));
}

export interface VPlaced {
  node: HBox | VBox | Rule;
  /** Height of the item's baseline above the result's baseline (for a rule: of its bottom edge). */
  base: number;
}

/**
 * Stack items (given top to bottom) into a VBox so that each item's baseline
 * sits `base` above the result's baseline. The kerns between items are
 * computed; overlapping items get negative kerns.
 */
export function vstack(items: readonly VPlaced[]): VBox {
  const children: VNode[] = [];
  let width = 0;
  let prevBottom = 0;
  let height = 0;
  let depth = 0;
  items.forEach((it, k) => {
    const n = it.node;
    const h = n.t === "rule" ? (n.height ?? 0) : n.height;
    const d = n.t === "rule" ? (n.depth ?? 0) : n.depth;
    const top = it.base + h;
    if (k === 0) height = top;
    else {
      const gap = prevBottom - top;
      if (Math.abs(gap) > 1e-12) children.push(kernNode(gap));
    }
    children.push(n);
    prevBottom = it.base - d;
    const w = n.t === "rule" ? (n.width ?? 0) : n.width + (n.shift ?? 0);
    if (w > width) width = w;
  });
  depth = -prevBottom;
  return { t: "vbox", width, height, depth, children };
}

// ---------------------------------------------------------------- glyphs

/** The Latin Modern face that draws the upright characters of each KaTeX text face. */
const ROMAN_FAMS = { main: "lmr", mainB: "lmrB", mainI: "lmrI", mainBI: "lmrBI" } as const satisfies Partial<Record<Fam, Fam>>;

/** Characters Latin Modern draws in math: letters, digits and the punctuation and operators of cmr. */
function isRomanChar(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || "+=;:,.!?'*@&%#$".includes(String.fromCodePoint(cp));
}

/** Faces tried, in order, for a character the requested face lacks. */
const FALLBACK_FAMS: readonly Fam[] = ["main", "mathI", "ams", "mainI", "sf", "tt", "size1", "frak", "cal"];

interface ResolvedGlyph {
  font: Font;
  m: GlyphMetrics;
}

const systemCache = new Map<number, ResolvedGlyph | null>();

function systemGlyph(cp: number): ResolvedGlyph | null {
  let r = systemCache.get(cp);
  if (r !== undefined) return r;
  r = null;
  try {
    const font = fallbackFor(cp);
    if (font) {
      const gid = font.glyphForCodePoint(cp);
      if (gid) {
        const upm = font.unitsPerEm;
        const b = font.bounds(gid);
        const width = font.advance(gid) / upm;
        r = {
          font,
          m: {
            gid,
            width,
            height: Math.max(0, b.yMax / upm),
            depth: Math.max(0, -b.yMin / upm),
            italic: 0,
            xMin: b.xMin / upm,
            xMax: b.xMax / upm,
            yMin: b.yMin / upm,
            yMax: b.yMax / upm,
            skew: 0,
          },
        };
      }
    }
  } catch {
    r = null;
  }
  systemCache.set(cp, r);
  return r;
}

/** The face and metrics that will draw a character: the requested face, a bundled fallback, a system font, or .notdef. */
export function resolveGlyph(fam: Fam, cp: number): ResolvedGlyph & { fam: Fam | null } {
  // Upright text characters come from the body's Latin Modern, as TeX takes them from cmr;
  // the KaTeX faces draw the same shapes noticeably heavier. The family reported stays the
  // requested one, so spacing and MathML treat the character as before.
  const roman = ROMAN_FAMS[fam as keyof typeof ROMAN_FAMS];
  if (roman && isRomanChar(cp)) {
    const lm = glyphMetrics(roman, cp);
    if (lm) return { font: famFont(roman), m: lm, fam };
  }
  const m = glyphMetrics(fam, cp);
  if (m) return { font: famFont(fam), m, fam };
  for (const alt of FALLBACK_FAMS) {
    const ma = glyphMetrics(alt, cp);
    if (ma) return { font: famFont(alt), m: ma, fam: alt };
  }
  const sys = systemGlyph(cp);
  if (sys) return { ...sys, fam: null };
  return { font: famFont(fam), m: notdefMetrics(fam), fam };
}

/** One glyph as a Glyphs node, with its metrics (em). */
export function glyphNode(fam: Fam, cp: number, size: number, text: string, color?: Color): { node: Glyphs; m: GlyphMetrics; fam: Fam | null } {
  const r = resolveGlyph(fam, cp);
  const node: Glyphs = {
    t: "glyphs",
    font: r.font,
    size,
    gids: [r.m.gid],
    advances: [r.m.width * size],
    text: [text],
    width: r.m.width * size,
    height: r.m.height * size,
    depth: r.m.depth * size,
  };
  if (color) node.color = color;
  return { node, m: r.m, fam: r.fam };
}

/** A run of characters from one face as a single Glyphs node (operator names, text). */
export function glyphRun(fam: Fam, chars: readonly string[], size: number, color?: Color): HNode[] {
  const out: HNode[] = [];
  for (const ch of chars) {
    const { node } = glyphNode(fam, ch.codePointAt(0)!, size, ch, color);
    out.push(node);
  }
  return hpack(out).children;
}
