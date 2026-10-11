/**
 * What a picture draws, collected before it becomes SVG: paths with their
 * paint, text blocks, clip regions and the bounding box. Coordinates are
 * TeX points with y up, as TikZ has them; the SVG is written with y down.
 */

import type { Pt, Seg } from "./geom.js";
import { GlyphDefs, n2 } from "./text.js";

export type Box = [number, number, number, number];

export interface Shade {
  kind: "linear" | "radial" | "ball";
  /** Linear: angle the colours run along (0 = left to right). */
  angle: number;
  stops: [number, string][];
}

export interface PaintStyle {
  stroke?: string;
  fill?: string;
  shade?: Shade;
  lineWidth: number;
  dash?: number[];
  dashOffset?: number;
  strokeOpacity?: number;
  fillOpacity?: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  evenOdd?: boolean;
}

interface Item {
  svg: string;
  box: Box;
  clips: string[];
  layer: number;
}

export function emptyBox(): Box {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function growBox(b: Box, p: Pt, pad = 0): void {
  b[0] = Math.min(b[0], p[0] - pad);
  b[1] = Math.min(b[1], p[1] - pad);
  b[2] = Math.max(b[2], p[0] + pad);
  b[3] = Math.max(b[3], p[1] + pad);
}

export function boxOK(b: Box): boolean {
  return b[0] <= b[2] && b[1] <= b[3];
}

export function segsBox(segs: Seg[], pad = 0): Box {
  const b = emptyBox();
  for (const s of segs) {
    if (s.t === "Z") continue;
    growBox(b, s.p, pad);
    if (s.t === "C") {
      growBox(b, s.c1, pad);
      growBox(b, s.c2, pad);
    }
  }
  return b;
}

/** SVG path data, y flipped. */
export function pathData(segs: Seg[]): string {
  let d = "";
  for (const s of segs) {
    if (s.t === "M") d += `M${n2(s.p[0])} ${n2(-s.p[1])}`;
    else if (s.t === "L") d += `L${n2(s.p[0])} ${n2(-s.p[1])}`;
    else if (s.t === "C") d += `C${n2(s.c1[0])} ${n2(-s.c1[1])} ${n2(s.c2[0])} ${n2(-s.c2[1])} ${n2(s.p[0])} ${n2(-s.p[1])}`;
    else d += "Z";
  }
  return d;
}

/**
 * The most SVG one picture may produce. A loop or hatching that runs to its iteration cap can
 * otherwise write megabytes, which then cost seconds to draw into the PDF.
 */
export const MAX_SCENE_BYTES = 1_000_000;

export class Scene {
  readonly items: Item[] = [];
  readonly defs: string[] = [];
  readonly glyphs: GlyphDefs;
  /** A box fixed by `use as bounding box`. */
  fixedBox: Box | undefined;
  private ids = 0;

  constructor(readonly prefix: string) {
    this.glyphs = new GlyphDefs(`${prefix}g`);
  }

  newId(kind: string): string {
    return `${this.prefix}${kind}${this.ids++}`;
  }

  get count(): number {
    return this.items.length;
  }

  /** Set once the picture's SVG passes MAX_SCENE_BYTES; later items are dropped. */
  full = false;
  private bytes = 0;

  add(svg: string, box: Box, clips: string[], layer = 0): void {
    if (!svg || this.full) return;
    this.bytes += svg.length;
    if (this.bytes > MAX_SCENE_BYTES) {
      this.full = true;
      return;
    }
    this.items.push({ svg, box, clips, layer });
  }

  /** A path painted with `style`. Returns false when it paints nothing. */
  path(segs: Seg[], style: PaintStyle, clips: string[], layer = 0): boolean {
    if (!segs.length) return false;
    if (!style.stroke && !style.fill && !style.shade) return false;
    let fill = "none";
    if (style.shade) fill = `url(#${this.gradient(style.shade)})`;
    else if (style.fill) fill = style.fill;
    const a: string[] = [`d="${pathData(segs)}"`, `fill="${fill}"`];
    if (style.fill || style.shade) {
      if (style.fillOpacity !== undefined && style.fillOpacity < 1) a.push(`fill-opacity="${n2(style.fillOpacity)}"`);
      if (style.evenOdd) a.push(`fill-rule="evenodd"`);
    }
    if (style.stroke) {
      a.push(`stroke="${style.stroke}"`, `stroke-width="${n2(style.lineWidth)}"`);
      if (style.dash?.length) a.push(`stroke-dasharray="${style.dash.map(n2).join(" ")}"`);
      if (style.dashOffset) a.push(`stroke-dashoffset="${n2(style.dashOffset)}"`);
      if (style.cap && style.cap !== "butt") a.push(`stroke-linecap="${style.cap}"`);
      if (style.join && style.join !== "miter") a.push(`stroke-linejoin="${style.join}"`);
      if (style.strokeOpacity !== undefined && style.strokeOpacity < 1) a.push(`stroke-opacity="${n2(style.strokeOpacity)}"`);
    }
    this.add(`<path ${a.join(" ")}/>`, segsBox(segs, style.stroke ? style.lineWidth / 2 : 0), clips, layer);
    return true;
  }

  gradient(sh: Shade): string {
    const id = this.newId("s");
    const stops = sh.stops.map(([o, c]) => `<stop offset="${n2(o)}" stop-color="${c}"/>`).join("");
    if (sh.kind === "linear") {
      const r = (sh.angle * Math.PI) / 180;
      const dx = Math.cos(r) / 2;
      const dy = -Math.sin(r) / 2;
      this.defs.push(`<linearGradient id="${id}" x1="${n2(0.5 - dx)}" y1="${n2(0.5 - dy)}" x2="${n2(0.5 + dx)}" y2="${n2(0.5 + dy)}">${stops}</linearGradient>`);
    } else if (sh.kind === "ball") {
      this.defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5" fx="0.35" fy="0.3">${stops}</radialGradient>`);
    } else this.defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`);
    return id;
  }

  clipPath(segs: Seg[]): string {
    const id = this.newId("c");
    this.defs.push(`<clipPath id="${id}"><path d="${pathData(segs)}"/></clipPath>`);
    this.clipBoxes.set(id, segsBox(segs));
    return id;
  }

  readonly clipBoxes = new Map<string, Box>();

  /** The bounding box of everything drawn (clipped parts left out). */
  box(): Box {
    if (this.fixedBox) return this.fixedBox;
    const b = emptyBox();
    for (const it of this.items) {
      let ib: Box = [...it.box];
      for (const c of it.clips) {
        const cb = this.clipBoxes.get(c);
        if (cb) ib = [Math.max(ib[0], cb[0]), Math.max(ib[1], cb[1]), Math.min(ib[2], cb[2]), Math.min(ib[3], cb[3])];
      }
      if (!boxOK(ib)) continue;
      growBox(b, [ib[0], ib[1]]);
      growBox(b, [ib[2], ib[3]]);
    }
    return b;
  }

  /** The SVG document; sizes in px so that one TeX point of the picture is one point on the page. */
  svg(title?: string): string | undefined {
    const b = this.box();
    if (!boxOK(b) || !this.items.length) return undefined;
    const pad = 0.5;
    const x0 = b[0] - pad;
    const y0 = b[1] - pad;
    const w = Math.max(1, b[2] - b[0] + 2 * pad);
    const h = Math.max(1, b[3] - b[1] + 2 * pad);
    // TeX points to CSS px: 72/72.27 bp per pt, 0.75 bp per px.
    const k = 72 / 72.27 / 0.75;
    const ordered = [...this.items].sort((a, c) => a.layer - c.layer);
    const body: string[] = [];
    for (const it of ordered) {
      let s = it.svg;
      for (let i = it.clips.length - 1; i >= 0; i--) s = `<g clip-path="url(#${it.clips[i]})">${s}</g>`;
      body.push(s);
    }
    const defs = this.defs.join("") + this.glyphs.markup();
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(w * k)}" height="${n2(h * k)}" viewBox="${n2(x0)} ${n2(-(y0 + h))} ${n2(w)} ${n2(h)}" role="img"${title ? ` aria-label="${title.replace(/[<>&"]/g, "")}"` : ""}>` +
      (defs ? `<defs>${defs}</defs>` : "") +
      body.join("") +
      `</svg>`
    );
  }
}
