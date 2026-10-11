/**
 * Drawing helpers shared by the class, state and entity-relationship
 * diagrams, which all lay out boxes and connectors with layered.ts: an edge
 * cut where it leaves and enters its boxes and finished with end markers,
 * labels on a quiet background, texts beside an edge's end (cardinalities),
 * self loops, subgraph boxes, and a running bounding box so whatever hangs
 * outside the layout (a loop, a cardinality) still fits the picture.
 */

import { type Cubic, type EndKind, bez, endInset, endSvg, exitT, labelSvg, n, pathData, type Pt, reverse, smoothPath, splitCubic } from "./svg.js";
import { type Label, layoutLabel, textWidth } from "./text.js";
import type { Theme } from "./theme.js";

/** The colour that hollow markers and label backgrounds are filled with. */
export const paper = (t: Theme): string => (t.background === "transparent" ? "#ffffff" : t.background);

/** A single line of literal text as a Label (no markup is read, so `List<int>` stays as written). */
export function plainLabel(text: string, size: number, style: { bold?: boolean; italic?: boolean } = {}): Label {
  const base = layoutLabel("M", size);
  const piece = { text, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}) };
  return {
    lines: text ? [[piece]] : [],
    width: text ? textWidth(text, size, !!style.bold, !!style.italic) : 0,
    height: text ? base.lineHeight : 0,
    size,
    lineHeight: base.lineHeight,
    ascent: base.ascent,
  };
}

/** Grows to cover everything drawn. */
export class Bounds {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add(x0: number, y0: number, x1: number, y1: number): void {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    this.x0 = Math.min(this.x0, x0, x1);
    this.y0 = Math.min(this.y0, y0, y1);
    this.x1 = Math.max(this.x1, x0, x1);
    this.y1 = Math.max(this.y1, y0, y1);
  }
  box(cx: number, cy: number, w: number, h: number): void {
    this.add(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
  }
}

export type Inside = (p: Pt) => boolean;

/** Inside test for an axis-aligned box given by its centre. */
export const inBox =
  (cx: number, cy: number, w: number, h: number): Inside =>
  (p) =>
    Math.abs(p[0] - cx) <= w / 2 && Math.abs(p[1] - cy) <= h / 2;

/** Mermaid's style lists: `fill:#f9f,stroke:#333,stroke-width:2px`. */
export function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/[,;](?![^(]*\))/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/\s*!important$/, "");
  }
  return out;
}

export interface EdgeSpec {
  /** From the source through the bends to the target, as the layout gave them. */
  points: Pt[];
  vertical: boolean;
  from?: Inside;
  to?: Inside;
  start: EndKind;
  end: EndKind;
  color: string;
  lw: number;
  dash?: string;
  bg: string;
}

export interface DrawnEdge {
  svg: string;
  /** Where the line meets the source and target outlines. */
  startTip: Pt;
  endTip: Pt;
  /** Unit vectors pointing into the source and into the target at those tips. */
  startDir: Pt;
  endDir: Pt;
}

const unit = (a: Pt, b: Pt): Pt => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
};

/** Shortens a curve at one end by `inset` px of straight-line distance, so a marker sits on its end without the line showing through. */
function trim(c: Cubic, inset: number, atEnd: boolean): Cubic {
  if (inset <= 0) return c;
  const cc = atEnd ? c : reverse(c);
  const tip = cc[3];
  let tt = 1;
  for (let s = 1; s <= 40; s++) {
    const p = bez(cc, 1 - s / 40);
    if (Math.hypot(p[0] - tip[0], p[1] - tip[1]) >= inset) {
      tt = 1 - s / 40;
      break;
    }
  }
  const cut = splitCubic(cc, tt, true);
  return atEnd ? cut : reverse(cut);
}

const lineCubic = (a: Pt, b: Pt): Cubic => [a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3], b];

/**
 * The curve of an edge between two boxes that meets each box square on: a
 * short straight stub leaves the side facing the rest of the edge, at the
 * edge's port, and the smooth curve runs between the stubs. Markers then sit
 * on straight ends instead of on a slanting corner.
 */
function stubbed(points: Pt[], vertical: boolean, a: Rect, b: Rect, stub: number): Cubic[] {
  const k = points.length;
  const side = (box: Rect, p: Pt, toward: Pt): [Pt, Pt] => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (vertical) {
      const s = toward[1] >= cy ? 1 : -1;
      const x = Math.min(box.x + box.width - 10, Math.max(box.x + 10, p[0]));
      const y = cy + (s * box.height) / 2;
      return [
        [x, y],
        [x, y + s * stub],
      ];
    }
    const s = toward[0] >= cx ? 1 : -1;
    const y = Math.min(box.y + box.height - 8, Math.max(box.y + 8, p[1]));
    const x = cx + (s * box.width) / 2;
    return [
      [x, y],
      [x + s * stub, y],
    ];
  };
  const [s0, s1] = side(a, points[0], points[Math.min(1, k - 1)]);
  const [e0, e1] = side(b, points[k - 1], points[Math.max(0, k - 2)]);
  const mid = [s1, ...points.slice(1, -1), e1];
  return [lineCubic(s0, s1), ...smoothPath(mid, vertical), lineCubic(e1, e0)];
}

/** An edge as a smooth curve, cut at both outlines (or meeting both boxes square on, with `boxes`), with its end markers. */
export function drawEdge(e: EdgeSpec & { boxes?: { from: Rect; to: Rect; stub: number } }): DrawnEdge {
  const cs: Cubic[] = e.boxes && e.points.length >= 2 ? stubbed(e.points, e.vertical, e.boxes.from, e.boxes.to, e.boxes.stub) : smoothPath(e.points, e.vertical);
  if (e.boxes) {
    e = { ...e, from: undefined, to: undefined };
  }
  if (!cs.length) {
    const p = e.points[0] ?? [0, 0];
    return { svg: "", startTip: p, endTip: p, startDir: [0, -1], endDir: [0, 1] };
  }
  if (e.from) {
    while (cs.length > 1 && e.from(cs[0][3])) cs.shift();
    cs[0] = splitCubic(cs[0], exitT(cs[0], e.from));
  }
  if (e.to) {
    while (cs.length > 1 && e.to(cs[cs.length - 1][0])) cs.pop();
    const last = reverse(cs[cs.length - 1]);
    cs[cs.length - 1] = reverse(splitCubic(last, exitT(last, e.to)));
  }
  const startTip = cs[0][0];
  const endTip = cs[cs.length - 1][3];
  // Directions from a little way in, so a curve's last bend sets the marker's angle.
  const startFrom = bez(cs[0], 0.12);
  const endFrom = bez(cs[cs.length - 1], 0.88);
  const startDir = unit(startFrom, startTip);
  const endDir = unit(endFrom, endTip);
  cs[cs.length - 1] = trim(cs[cs.length - 1], endInset(e.end, e.lw) - e.lw * 0.5, true);
  cs[0] = trim(cs[0], endInset(e.start, e.lw) - e.lw * 0.5, false);
  const parts = [`<path d="${pathData(cs)}" fill="none" stroke="${e.color}" stroke-width="${n(e.lw)}"${e.dash ? ` stroke-dasharray="${e.dash}"` : ""} stroke-linecap="round"/>`];
  const mlw = Math.max(1, e.lw * 0.9);
  if (e.end !== "none") parts.push(endSvg(e.end, endTip, [endTip[0] - endDir[0] * 10, endTip[1] - endDir[1] * 10], e.color, mlw, e.bg));
  if (e.start !== "none") parts.push(endSvg(e.start, startTip, [startTip[0] - startDir[0] * 10, startTip[1] - startDir[1] * 10], e.color, mlw, e.bg));
  return { svg: parts.join(""), startTip, endTip, startDir, endDir };
}

/** How far an end marker reaches back from the outline, for placing text clear of it. */
export function markerLength(kind: EndKind): number {
  switch (kind) {
    case "arrow":
    case "open":
      return 10;
    case "triangle":
      return 12;
    case "diamond":
    case "diamond-filled":
      return 16;
    case "circle":
      return 8;
    case "one":
      return 10;
    case "one-many":
      return 13;
    case "zero-one":
      return 18;
    case "zero-many":
      return 20;
    case "many":
      return 10;
    default:
      return 2;
  }
}

/** A label on a quiet rounded background, centred on (x, y). Returns the SVG and the box it covers. */
export function edgeLabelSvg(lab: Label, x: number, y: number, t: Theme, color: string, bounds?: Bounds): string {
  if (!lab.lines.length) return "";
  const w = lab.width + 10;
  const h = lab.height + 4;
  bounds?.box(x, y, w, h);
  return `<rect x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="3" fill="${t.edgeLabelBg}" fill-opacity="0.92"/>` + labelSvg(lab, x, y, color);
}

/**
 * A short text beside an edge's end, such as a multiplicity: set back from
 * the outline past the marker, and to the side of the line that faces away
 * from the box's centre, so the texts of neighbouring edges spread apart.
 */
export function endTextSvg(lab: Label, tip: Pt, dir: Pt, centre: Pt, marker: number, color: string, bounds?: Bounds): string {
  if (!lab.lines.length) return "";
  const p: Pt = [-dir[1], dir[0]];
  const away = p[0] * (tip[0] - centre[0]) + p[1] * (tip[1] - centre[1]);
  const s = away < -0.5 ? -1 : 1;
  const ext = (v: Pt) => (Math.abs(v[0]) * lab.width) / 2 + (Math.abs(v[1]) * lab.height) / 2;
  const back = marker + 3 + ext(dir);
  const side = 4 + ext(p);
  const x = tip[0] - dir[0] * back + p[0] * s * side;
  const y = tip[1] - dir[1] * back + p[1] * s * side;
  bounds?.box(x, y, lab.width, lab.height);
  return labelSvg(lab, x, y, color);
}

/** How far a box's self loops reach out from its side, with their labels (`along` is the label extent away from the box). */
export function loopRoom(count: number, labelAlong: number): number {
  if (!count) return 0;
  return (30 + (count - 1) * 16) * 0.78 + (labelAlong > 0 ? labelAlong + 14 : 4);
}

/**
 * A loop from a box back to itself, out of its right side (or its bottom,
 * in sideways layouts where edges use the left and right). `k` counts the
 * loops already on that box, so several nest. The label goes beyond the loop.
 */
export function selfLoopSvg(
  cx: number,
  cy: number,
  w: number,
  h: number,
  k: number,
  e: { start: EndKind; end: EndKind; color: string; lw: number; dash?: string; bg: string },
  lab: Label | undefined,
  t: Theme,
  labelColor: string,
  bounds: Bounds,
  side: "right" | "bottom" = "right",
): string {
  // Work in a frame where the loop leaves along +u from the side at distance `edge`, spread along v.
  const right = side === "right";
  const edge = right ? w / 2 : h / 2;
  const half = right ? h / 2 : w / 2;
  const at = (u: number, v: number): Pt => (right ? [cx + u, cy + v] : [cx + v, cy + u]);
  const dv = Math.min(half - 3, 9 + k * 4);
  const reach = 30 + k * 16;
  const c: Cubic = [at(edge, -dv), at(edge + reach, -dv - reach * 0.55), at(edge + reach, dv + reach * 0.55), at(edge, dv)];
  let cc = c;
  cc = trim(cc, endInset(e.end, e.lw) - e.lw * 0.5, true);
  cc = trim(cc, endInset(e.start, e.lw) - e.lw * 0.5, false);
  const out = [`<path d="${pathData([cc])}" fill="none" stroke="${e.color}" stroke-width="${n(e.lw)}"${e.dash ? ` stroke-dasharray="${e.dash}"` : ""} stroke-linecap="round"/>`];
  const mlw = Math.max(1, e.lw * 0.9);
  if (e.end !== "none") out.push(endSvg(e.end, c[3], bez(c, 0.85), e.color, mlw, e.bg));
  if (e.start !== "none") out.push(endSvg(e.start, c[0], bez(c, 0.15), e.color, mlw, e.bg));
  const far = edge + reach * 0.78;
  const a = at(edge, -dv - reach * 0.45);
  const b = at(far, dv + reach * 0.45);
  bounds.add(a[0], a[1], b[0], b[1]);
  if (lab && lab.lines.length) {
    const along = right ? lab.width : lab.height;
    const p = at(far + 4 + along / 2 + (right ? 5 : 2), 0);
    out.push(edgeLabelSvg(lab, p[0], p[1], t, labelColor, bounds));
  }
  return out.join("");
}

/** A subgraph box: tinted or plain by depth, title at the top left. */
export function clusterSvg(b: { x: number; y: number; width: number; height: number }, title: Label | undefined, depth: number, t: Theme, opts: { radius?: number; dash?: string; fill?: string; stroke?: string } = {}): string {
  const fill = opts.fill ?? (depth % 2 ? paper(t) : t.clusterFill);
  let s = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(opts.radius ?? t.radius + 2)}" fill="${fill}" stroke="${opts.stroke ?? t.clusterStroke}" stroke-width="1"${opts.dash ? ` stroke-dasharray="${opts.dash}"` : ""}/>`;
  if (title && title.lines.length) s += labelSvg(title, b.x + 10, b.y + 5 + title.height / 2, t.clusterText, { align: "start", weight: "bold" });
  return s;
}

/** A box given by its centre and size, as the layout places nodes, as a Rect. */
export const rectOf = (p: { x: number; y: number; width: number; height: number }): Rect => ({ x: p.x - p.width / 2, y: p.y - p.height / 2, width: p.width, height: p.height });

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Subgraph boxes fitted tightly around what they hold: their members' boxes
 * and inner subgraphs, plus padding and a title band on top. The layout's
 * own boxes follow its border nodes, which may stray wider than the
 * members need; this keeps every box snug.
 */
export function tightClusters(
  clusters: { id: string; parent?: string; padding: number; titleWidth: number; titleHeight: number }[],
  members: { cluster?: string; x: number; y: number; width: number; height: number }[],
): Map<string, Rect> {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const depth = (id: string) => {
    let d = 0;
    const seen = new Set<string>();
    for (let k = byId.get(id)?.parent; k && !seen.has(k); k = byId.get(k)?.parent) {
      seen.add(k);
      d++;
    }
    return d;
  };
  const out = new Map<string, Rect>();
  for (const c of [...clusters].sort((a, b) => depth(b.id) - depth(a.id))) {
    const b = new Bounds();
    for (const m of members) if (m.cluster === c.id) b.box(m.x, m.y, m.width, m.height);
    for (const k of clusters) {
      const r = out.get(k.id);
      if (k.parent === c.id && r) b.add(r.x, r.y, r.x + r.width, r.y + r.height);
    }
    if (!Number.isFinite(b.x0)) continue;
    let x0 = b.x0 - c.padding;
    let x1 = b.x1 + c.padding;
    const need = c.titleWidth + 20;
    if (x1 - x0 < need) {
      const d = (need - (x1 - x0)) / 2;
      x0 -= d;
      x1 += d;
    }
    const y0 = b.y0 - c.padding - c.titleHeight;
    out.set(c.id, { x: x0, y: y0, width: x1 - x0, height: b.y1 + c.padding - y0 });
  }
  return out;
}

/** The innermost cluster holding both a and b (each given as its own innermost cluster), if any. */
export function commonCluster(a: string | undefined, b: string | undefined, parentOf: (c: string) => string | undefined): string | undefined {
  const chain = (c: string | undefined) => {
    const out: string[] = [];
    for (let k = c; k && !out.includes(k); k = parentOf(k)) out.push(k);
    return out;
  };
  const cb = new Set(chain(b));
  return chain(a).find((k) => cb.has(k));
}

/** Wraps drawn content so its bounding box starts at (margin, margin); returns the SVG body and its size. */
export function frame(body: string, b: Bounds, margin: number): { body: string; width: number; height: number } {
  if (!Number.isFinite(b.x0)) return { body, width: 2 * margin, height: 2 * margin };
  const dx = margin - b.x0;
  const dy = margin - b.y0;
  const moved = Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01;
  return { body: moved ? `<g transform="translate(${n(dx)} ${n(dy)})">${body}</g>` : body, width: b.x1 - b.x0 + 2 * margin, height: b.y1 - b.y0 + 2 * margin };
}

/** Column of the first non-space character. */
export const indentOf = (s: string): number => s.length - s.trimStart().length;
