/**
 * Delimiters, radical signs, horizontal braces and stretchy arrows.
 *
 * A delimiter is chosen as TeX's var_delimiter does: try the normal glyph,
 * then the larger Size1..Size4 variants, and past the largest variant build
 * the delimiter from extensible pieces (top, middle, bottom and a repeated
 * piece, from the Size4/Size1 fonts), adding repeats until the required
 * size is reached. Sizes are measured from the glyph outlines.
 */

import type { Color, HBox, HNode, VBox } from "../layout/types.js";
import { boxWith, glyphNode, hpack, kernNode, ruleNode, shifted, vstack, type VPlaced } from "./boxes.js";
import { glyphMetrics } from "./metrics.js";
import { type ArrowDef, DELIMS, type ExtRecipe, type Fam, type SymDef } from "./symbols.js";

const SIZE_FAMS: readonly Fam[] = ["size1", "size2", "size3", "size4"];
/** Overlap between the pieces of an assembled delimiter, em (hides seams). */
const PIECE_OVERLAP = 0.01;

export interface DelimResult {
  /** The delimiter with its glyph baseline (an assembly has its baseline at the bottom). */
  box: HBox | VBox;
  /** Ink top and bottom relative to the box baseline, points. */
  top: number;
  bottom: number;
}

function glyphBox(fam: Fam, cp: number, size: number, text: string, color?: Color): DelimResult {
  const g = glyphNode(fam, cp, size, text, color);
  return { box: hpack([g.node]), top: g.m.yMax * size, bottom: g.m.yMin * size };
}

function variants(sym: SymDef): { fam: Fam; cp: number }[] {
  const d = DELIMS.get(sym.cp);
  const out: { fam: Fam; cp: number }[] = [{ fam: sym.fam, cp: sym.cp }];
  if (d && sym.fam === "main") for (let k = 0; k < d.sizes; k++) out.push({ fam: SIZE_FAMS[k]!, cp: sym.cp });
  return out;
}

function inkTotal(fam: Fam, cp: number): number {
  const m = glyphMetrics(fam, cp);
  return m ? m.yMax - m.yMin : 0;
}

/** Build a delimiter from extensible pieces, at least `need` points tall. Baseline at the bottom. */
function assemble(ext: ExtRecipe, need: number, size: number, text: string, color?: Color): DelimResult {
  const piece = (cp: number | undefined) => (cp === undefined ? 0 : inkTotal(ext.fam, cp) * size);
  const ov = PIECE_OVERLAP * size;
  const fixedPieces = [ext.top, ext.mid, ext.bot].filter((p): p is number => p !== undefined);
  const fixed = fixedPieces.reduce((s, p) => s + piece(p), 0);
  const rep = piece(ext.rep);
  const per = ext.mid !== undefined ? 2 : 1;
  const totalFor = (k: number) => {
    const count = fixedPieces.length + k * per;
    return fixed + k * per * rep - Math.max(0, count - 1) * ov;
  };
  const minN = fixedPieces.length ? 0 : 1;
  let n = minN;
  // Enough repeats to reach the size (capped, so a huge request still stops).
  if (rep > ov && need > totalFor(minN)) n = Math.min(2000, minN + Math.ceil((need - totalFor(minN)) / (per * (rep - ov))));
  const order: number[] = [];
  if (ext.top !== undefined) order.push(ext.top);
  for (let k = 0; k < n; k++) order.push(ext.rep);
  if (ext.mid !== undefined) {
    order.push(ext.mid);
    for (let k = 0; k < n; k++) order.push(ext.rep);
  }
  if (ext.bot !== undefined) order.push(ext.bot);
  const total = totalFor(n);
  const items: VPlaced[] = [];
  let top = total;
  order.forEach((cp, k) => {
    const g = glyphNode(ext.fam, cp, size, k === 0 ? text : "", color);
    const b = hpack([g.node]);
    const h = g.m.yMax * size;
    const d = -g.m.yMin * size;
    items.push({ node: boxWith(b.children, b.width, h, d), base: top - h });
    top = top - (h + d) + ov;
  });
  const v = vstack(items);
  return { box: v, top: total, bottom: 0 };
}

/**
 * A delimiter at least `need` points tall (height plus depth), not yet
 * centred. Returns null for the null delimiter.
 */
export function sizedDelim(sym: SymDef | null, need: number, size: number, color?: Color): DelimResult | null {
  if (!sym) return null;
  const vs = variants(sym);
  let best: { fam: Fam; cp: number } | null = null;
  for (const v of vs) {
    const t = inkTotal(v.fam, v.cp) * size;
    if (t <= 0) continue;
    best = v;
    if (t >= need) return glyphBox(v.fam, v.cp, size, sym.text, color);
  }
  const d = sym.fam === "main" ? DELIMS.get(sym.cp) : undefined;
  if (d?.ext) return assemble(d.ext, need, size, sym.text, color);
  const v = best ?? vs[0]!;
  return glyphBox(v.fam, v.cp, size, sym.text, color);
}

/** A delimiter centred on the math axis, or a null-delimiter space when sym is null. */
export function axisDelim(sym: SymDef | null, need: number, size: number, axis: number, nullSpace: number, color?: Color): HBox {
  const r = sizedDelim(sym, need, size, color);
  if (!r) return boxWith([kernNode(nullSpace)], nullSpace, 0, 0);
  // Centre the ink on the axis: move down by (top + bottom)/2 - axis.
  const s = (r.top + r.bottom) / 2 - axis;
  const b = r.box.t === "hbox" ? r.box : hpack([r.box]);
  return hpack([shifted(b, s)]);
}

/** The radical sign for a body needing `need` points of height+depth (ink). */
export function radicalSign(need: number, size: number, color?: Color): DelimResult {
  const sym: SymDef = { cls: "ord", fam: "main", cp: 0x221a, text: "√", mml: "mo" };
  return sizedDelim(sym, need, size, color)!;
}

// ---------------------------------------------------------------- horizontal braces

/** \overbrace / \underbrace brace of at least `width` points. */
export function horizontalBrace(width: number, over: boolean, size: number, color?: Color): HBox {
  const ld = 0xe150;
  const rd = 0xe151;
  const lu = 0xe152;
  const ru = 0xe153;
  const bar = glyphMetrics("size4", 0xe154);
  const pw = (glyphMetrics("size4", ld)?.width ?? 0.45) * size;
  const top = (bar?.yMax ?? 0.12) * size;
  const bottom = (bar?.yMin ?? 0) * size;
  const total = Math.max(width, 4 * pw);
  const r = (total - 4 * pw) / 2;
  const seq = over ? [ld, -1, ru, lu, -1, rd] : [lu, -1, rd, ld, -1, ru];
  const nodes: HNode[] = [];
  seq.forEach((cp, k) => {
    if (cp < 0) nodes.push(ruleNode(r, top, -bottom, color));
    else nodes.push(glyphNode("size4", cp, size, k === 2 ? (over ? "⏞" : "⏟") : "", color).node);
  });
  return hpack(nodes);
}

// ---------------------------------------------------------------- stretchy arrows

/** A horizontal arrow (\xrightarrow, \overrightarrow, ...) at least `width` points wide. */
export function stretchArrow(def: ArrowDef, width: number, size: number, color?: Color): HBox {
  const minus = glyphMetrics("main", 0x2212)!;
  const t = (minus.yMax - minus.yMin) * size;
  const left = def.left ? glyphMetrics("main", def.left) : null;
  const right = def.right ? glyphMetrics("main", def.right) : null;
  const ov = 0.02 * size;
  // Ink extents the shaft must join.
  const leftInkEnd = left ? left.xMax * size : 0;
  const leftAdv = left ? left.width * size : 0;
  const rightInkStart = right ? right.xMin * size : 0;
  const rightAdv = right ? right.width * size : 0;
  const bearing = (right ?? left ?? minus).xMin * size;
  const natural = Math.max(leftAdv + rightAdv, (left ?? right)!.width * size) + (def.bar ? 0.1 * size : 0);
  const total = Math.max(width, natural);
  const nodes: HNode[] = [];
  let x = 0;
  // shaft geometry
  const shafts: [number, number][] = def.double
    ? (() => {
        const eq = glyphMetrics("main", 0x3d)!;
        return [
          [eq.yMin * size, eq.yMin * size + t],
          [eq.yMax * size - t, eq.yMax * size],
        ];
      })()
    : [[minus.yMin * size, minus.yMax * size]];
  const shaftStart = left ? leftInkEnd - ov : bearing;
  const shaftEnd = right ? total - rightAdv + rightInkStart + ov : total - bearing;
  if (left) {
    nodes.push(glyphNode("main", def.left, size, def.text, color).node);
    x = leftAdv;
  } else if (def.bar) {
    // the |-> bar of \xmapsto
    const ar = glyphMetrics("main", 0x2192)!;
    nodes.push(kernNode(bearing));
    nodes.push(ruleNode(t, ar.yMax * size * 0.95, -ar.yMin * size * 0.95 + 0, color));
    x = bearing + t;
  }
  const len = Math.max(0, shaftEnd - shaftStart);
  if (len > 0) {
    nodes.push(kernNode(shaftStart - x));
    for (let k = 0; k < shafts.length; k++) {
      const [lo, hi] = shafts[k]!;
      nodes.push(ruleNode(len, hi, -lo, color));
      if (k < shafts.length - 1) nodes.push(kernNode(-len));
    }
    x = shaftStart + len;
  }
  if (right) {
    nodes.push(kernNode(total - rightAdv - x));
    nodes.push(glyphNode("main", def.right, size, left ? "" : def.text, color).node);
    x = total;
  } else {
    nodes.push(kernNode(total - x));
    x = total;
  }
  return hpack(nodes);
}
