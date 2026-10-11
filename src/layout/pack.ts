/**
 * Box packing (The TeXbook ch. 12; tex.web §644-679, hpack and vpackage).
 *
 * hpack and vpack measure a list, then set its glue so the box comes out at
 * the requested size: stretching or shrinking only the glue of the highest
 * order present, exactly as TeX does. They never throw on bad fits; they
 * report the badness and how far the content overflows so callers can warn.
 */

import type { Glue, GlueOrder, HBox, HNode, VBox, VNode } from "./types.js";

/** Badness of a glue setting that cannot be tolerated (TeX's inf_bad). */
export const INF_BAD = 10000;
/** Badness TeX records for an overfull box. */
export const OVERFULL_BAD = 1000000;
/** TeX's awful_bad: larger than any real cost. */
export const AWFUL_BAD = 0x3fffffff;
/** Differences below this many points are rounding noise (TeX works in exact scaled points). */
export const LENGTH_EPS = 1e-9;

/** Pack to an exact size, or to the natural size plus (or minus) an amount. */
export type HPackSpec = { width: number } | { additional: number };
export type VPackSpec = { height: number } | { additional: number };

export interface PackOptions {
  /** Report underfull/tight boxes above this badness (TeX's \hbadness / \vbadness). Default 1000. */
  badnessLimit?: number;
}

export interface VPackOptions extends PackOptions {
  /** TeX's \boxmaxdepth: depth beyond this moves into the height. Default unlimited. */
  maxDepth?: number;
}

export interface PackResult<B extends HBox | VBox> {
  box: B;
  /** 0..10000 from 100(t/s)^3, or 1000000 when the box is overfull (TeX's \badness). */
  badness: number;
  /** How far the content overflows even with all its glue shrunk (0 when it fits). */
  overfull: number;
  /** Stretched with finite glue to a badness above the limit (or with no stretch at all). */
  underfull: boolean;
  /** Shrunk to a badness above the limit without overflowing. */
  tight: boolean;
  /** Natural width (hpack) or height (vpack) of the content. */
  natural: number;
}

/**
 * TeX's badness: about 100 (t/s)^3, capped at 10000. t is the amount the glue
 * must stretch or shrink, s the total stretchability or shrinkability.
 */
export function badness(t: number, s: number): number {
  if (t <= 0) return 0;
  if (s <= 0) return INF_BAD;
  const r = t / s;
  if (r > 4.65) return INF_BAD; // 100 * 4.65^3 > 10000
  const b = Math.round(100 * r * r * r);
  return b > INF_BAD ? INF_BAD : b;
}

/** Width a glue takes inside a box with the given glue setting. */
export function glueSize(g: Glue, set: HBox["glueSet"]): number {
  if (!set || set.sign === "none" || set.ratio === 0) return g.width;
  if (set.sign === "stretch") return g.stretchOrder === set.order ? g.width + set.ratio * g.stretch : g.width;
  return g.shrinkOrder === set.order ? g.width - set.ratio * g.shrink : g.width;
}

function leaderHeight(leader: NonNullable<Glue["leader"]>): [number, number] {
  if (leader.t === "rule") return [leader.height ?? 0, leader.depth ?? 0];
  return [leader.height - (leader.shift ?? 0), leader.depth + (leader.shift ?? 0)];
}

interface GlueTotals {
  stretch: [number, number, number, number];
  shrink: [number, number, number, number];
}

/** Picks the glue order and ratio for a box whose content must change by x (TeX §658-§667). */
function setGlue(
  x: number,
  totals: GlueTotals,
  nonEmpty: boolean,
  limit: number,
): { glueSet: NonNullable<HBox["glueSet"]>; badness: number; overfull: number; underfull: boolean; tight: boolean } {
  const none = { ratio: 0, order: 0 as GlueOrder, sign: "none" as const };
  if (Math.abs(x) < LENGTH_EPS) return { glueSet: none, badness: 0, overfull: 0, underfull: false, tight: false };
  if (x > 0) {
    const o = highestOrder(totals.stretch);
    const s = totals.stretch[o];
    const glueSet = s !== 0 ? { ratio: x / s, order: o, sign: "stretch" as const } : none;
    if (o !== 0 || !nonEmpty) return { glueSet, badness: 0, overfull: 0, underfull: false, tight: false };
    const b = badness(x, s);
    return { glueSet, badness: b, overfull: 0, underfull: b > limit, tight: false };
  }
  const o = highestOrder(totals.shrink);
  const s = totals.shrink[o];
  if (o === 0 && nonEmpty && s < -x - LENGTH_EPS) {
    // Overfull: shrink everything as far as it goes (TeX sets glue_set to 1.0).
    const glueSet = s > 0 ? { ratio: 1, order: 0 as GlueOrder, sign: "shrink" as const } : none;
    return { glueSet, badness: OVERFULL_BAD, overfull: -x - s, underfull: false, tight: false };
  }
  const glueSet = s !== 0 ? { ratio: -x / s, order: o, sign: "shrink" as const } : none;
  if (o !== 0 || !nonEmpty) return { glueSet, badness: 0, overfull: 0, underfull: false, tight: false };
  const b = badness(-x, s);
  return { glueSet, badness: b, overfull: 0, underfull: false, tight: b > limit };
}

function highestOrder(t: readonly number[]): GlueOrder {
  if (t[3] !== 0) return 3;
  if (t[2] !== 0) return 2;
  if (t[1] !== 0) return 1;
  return 0;
}

/** Natural width, height and depth of a horizontal list plus its glue totals. */
export function measureH(list: readonly HNode[]): { width: number; height: number; depth: number } & GlueTotals {
  let w = 0;
  let h = 0;
  let d = 0;
  const stretch: [number, number, number, number] = [0, 0, 0, 0];
  const shrink: [number, number, number, number] = [0, 0, 0, 0];
  for (const n of list) {
    switch (n.t) {
      case "glyphs":
      case "drawing":
        w += n.width;
        if (n.height > h) h = n.height;
        if (n.depth > d) d = n.depth;
        break;
      case "image":
        w += n.width;
        if (n.height > h) h = n.height;
        break;
      case "hbox":
      case "vbox": {
        w += n.width;
        const s = n.shift ?? 0;
        if (n.height - s > h) h = n.height - s;
        if (n.depth + s > d) d = n.depth + s;
        break;
      }
      case "rule":
        w += n.width ?? 0;
        if (n.height !== undefined && n.height > h) h = n.height;
        if (n.depth !== undefined && n.depth > d) d = n.depth;
        break;
      case "glue":
        w += n.width;
        stretch[n.stretchOrder] += n.stretch;
        shrink[n.shrinkOrder] += n.shrink;
        if (n.leader) {
          const [lh, ld] = leaderHeight(n.leader);
          if (lh > h) h = lh;
          if (ld > d) d = ld;
        }
        break;
      case "kern":
        w += n.width;
        break;
      default:
        break; // penalties and marks take no space
    }
  }
  return { width: w, height: h, depth: d, stretch, shrink };
}

/** Packs a horizontal list into an HBox (TeX's hpack). */
export function hpack(list: HNode[], spec: HPackSpec = { additional: 0 }, opts: PackOptions = {}): PackResult<HBox> {
  const m = measureH(list);
  const width = "width" in spec ? spec.width : m.width + spec.additional;
  const r = setGlue(width - m.width, m, list.length > 0, opts.badnessLimit ?? 1000);
  const box: HBox = { t: "hbox", width, height: m.height, depth: m.depth, children: list };
  if (r.glueSet.sign !== "none") box.glueSet = r.glueSet;
  return { box, badness: r.badness, overfull: r.overfull, underfull: r.underfull, tight: r.tight, natural: m.width };
}

/** Height a vertical-list item adds above its own baseline, and its depth (rules: undefined = 0). */
function vDims(n: VNode): [number, number] {
  switch (n.t) {
    case "hbox":
    case "vbox":
    case "drawing":
      return [n.height, n.depth];
    case "image":
      return [n.height, 0];
    case "rule":
      return [n.height ?? 0, n.depth ?? 0];
    default:
      return [0, 0];
  }
}

/** Natural height (to the last baseline), depth, width and glue totals of a vertical list (TeX's vpackage). */
export function measureV(list: readonly VNode[], maxDepth = Infinity): { width: number; height: number; depth: number } & GlueTotals {
  let w = 0;
  let x = 0;
  let d = 0;
  const stretch: [number, number, number, number] = [0, 0, 0, 0];
  const shrink: [number, number, number, number] = [0, 0, 0, 0];
  for (const n of list) {
    switch (n.t) {
      case "hbox":
      case "vbox":
      case "rule":
      case "image":
      case "drawing": {
        const [h, dd] = vDims(n);
        x += d + h;
        d = dd;
        const s = n.t === "hbox" || n.t === "vbox" ? (n.shift ?? 0) : 0;
        const nw = n.width;
        if (nw !== undefined && nw + s > w) w = nw + s;
        break;
      }
      case "glue":
        x += d;
        d = 0;
        x += n.width;
        stretch[n.stretchOrder] += n.stretch;
        shrink[n.shrinkOrder] += n.shrink;
        if (n.leader && n.leader.width !== undefined && n.leader.width > w) w = n.leader.width;
        break;
      case "kern":
        x += d + n.width;
        d = 0;
        break;
      default:
        break;
    }
  }
  if (d > maxDepth) {
    x += d - maxDepth;
    d = maxDepth;
  }
  return { width: w, height: x, depth: d, stretch, shrink };
}

/** Packs a vertical list into a VBox (TeX's vpackage). */
export function vpack(list: VNode[], spec: VPackSpec = { additional: 0 }, opts: VPackOptions = {}): PackResult<VBox> {
  const m = measureV(list, opts.maxDepth ?? Infinity);
  const height = "height" in spec ? spec.height : m.height + spec.additional;
  const r = setGlue(height - m.height, m, list.length > 0, opts.badnessLimit ?? 1000);
  const box: VBox = { t: "vbox", width: m.width, height, depth: m.depth, children: list };
  if (r.glueSet.sign !== "none") box.glueSet = r.glueSet;
  return { box, badness: r.badness, overfull: r.overfull, underfull: r.underfull, tight: r.tight, natural: m.height };
}

/** An HBox at natural width. */
export function hbox(children: HNode[]): HBox {
  return hpack(children).box;
}

/** A VBox at natural height. */
export function vbox(children: VNode[], maxDepth?: number): VBox {
  return vpack(children, { additional: 0 }, { maxDepth }).box;
}
