/**
 * Walks boxes the way TeX's hlist_out and vlist_out do (tex.web §619-§640),
 * computing the absolute position of everything inside: glue takes the size
 * its box's glue setting gives it, boxes in an hlist are shifted down by
 * their shift, boxes in a vlist right by theirs, running rule dimensions
 * take the enclosing box's size, and leaders repeat their box aligned to the
 * enclosing box's edge.
 *
 * Coordinates are top-down (y grows downward) relative to whatever origin the
 * caller starts from; the shipper converts them to PDF's bottom-left origin.
 * Links are tracked here so every consumer gets the same rectangles: one per
 * line segment, from the first to the last material inside the link on that
 * line, as tall as the line box.
 */

import { glueSize } from "./pack.js";
import type { Color, Drawing, Glue, Glyphs, HBox, Image, Mark, VBox } from "./types.js";

export type LinkTarget = { url: string } | { dest: string };

export interface WalkVisitor {
  glyphs?(run: Glyphs, x: number, baseline: number): void;
  /** A filled rectangle, top-left corner (x, top), extending right and down. */
  rule?(x: number, top: number, width: number, height: number, color: Color | undefined): void;
  image?(node: Image, x: number, baseline: number): void;
  drawing?(node: Drawing, x: number, baseline: number): void;
  /** A link destination; (x, y) is the top-left of the view: the top of the line it sits in. */
  anchor?(id: string, x: number, y: number): void;
  /** A clickable rectangle, top-left corner (x, top). */
  link?(target: LinkTarget, x: number, top: number, width: number, height: number): void;
  outline?(title: string, level: number, dest: string): void;
  /** Every mark, with its position (baseline in an hlist, current top in a vlist). */
  mark?(mark: Mark, x: number, y: number): void;
}

interface LineCtx {
  top: number;
  bottom: number;
}

interface Segment {
  x0: number;
  x1: number;
  ctx: LineCtx;
}

export class Walker {
  private ctx: LineCtx = { top: 0, bottom: 0 };
  private link: { target: LinkTarget; seg: Segment | null } | null = null;

  constructor(private readonly v: WalkVisitor) {}

  /** Walks a VBox whose top-left corner is at (x, top). */
  vbox(box: VBox, x: number, top: number): void {
    this.vlist(box, x, top);
  }

  /** Walks an HBox with its baseline's left end at (x, baseline), as one line. */
  hbox(box: HBox, x: number, baseline: number): void {
    this.line(box, x, baseline);
  }

  /** Ends a page: an open link's current segment is emitted; the link continues on the next page. */
  endPage(): void {
    this.flush();
    if (this.link) this.link.seg = null;
  }

  /** Ends the document: closes any open link. */
  finish(): void {
    this.flush();
    this.link = null;
  }

  private flush(): void {
    const l = this.link;
    if (!l || !l.seg) return;
    const s = l.seg;
    if (s.x1 > s.x0 && this.v.link) this.v.link(l.target, s.x0, s.ctx.top, s.x1 - s.x0, s.ctx.bottom - s.ctx.top);
    l.seg = null;
  }

  /** Material drawn between x0 and x1 in the current line: grows the open link's segment. */
  private material(x0: number, x1: number): void {
    const l = this.link;
    if (!l) return;
    if (l.seg && l.seg.ctx === this.ctx) {
      if (x0 < l.seg.x0) l.seg.x0 = x0;
      if (x1 > l.seg.x1) l.seg.x1 = x1;
      return;
    }
    this.flush();
    l.seg = { x0, x1, ctx: this.ctx };
  }

  private markAt(m: Mark, x: number, y: number, anchorY: number): void {
    this.v.mark?.(m, x, y);
    switch (m.t) {
      case "anchor":
        this.v.anchor?.(m.id, x, anchorY);
        break;
      case "link-start":
        this.flush();
        this.link = { target: m.target, seg: null };
        break;
      case "link-end":
        this.flush();
        this.link = null;
        break;
      case "outline":
        this.v.outline?.(m.title, m.level, m.dest);
        break;
      default:
        break;
    }
  }

  /** An HBox that forms a line of its own (inside a vlist, or at the top level). */
  private line(box: HBox, x: number, baseline: number): void {
    const saved = this.ctx;
    const ctx = { top: baseline - box.height, bottom: baseline + box.depth };
    this.ctx = ctx;
    this.hlist(box, x, baseline);
    if (this.link?.seg?.ctx === ctx) this.flush();
    this.ctx = saved;
  }

  private hlist(box: HBox, left: number, baseline: number): void {
    let h = left;
    for (const c of box.children) {
      switch (c.t) {
        case "glyphs":
          if (c.gids.length) {
            this.v.glyphs?.(c, h, baseline);
            this.material(h, h + c.width);
          }
          h += c.width;
          break;
        case "hbox":
          if (c.children.length) this.hlist(c, h, baseline + (c.shift ?? 0));
          h += c.width;
          break;
        case "vbox":
          if (c.children.length) this.vlist(c, h, baseline + (c.shift ?? 0) - c.height);
          h += c.width;
          break;
        case "rule": {
          const w = c.width ?? 0;
          const ht = c.height ?? box.height;
          const dp = c.depth ?? box.depth;
          if (w > 0 && ht + dp > 0) {
            this.v.rule?.(h, baseline - ht, w, ht + dp, c.color);
            this.material(h, h + w);
          }
          h += w;
          break;
        }
        case "image":
          this.v.image?.(c, h, baseline);
          this.material(h, h + c.width);
          h += c.width;
          break;
        case "drawing":
          this.v.drawing?.(c, h, baseline);
          this.material(h, h + c.width);
          h += c.width;
          break;
        case "glue": {
          const size = glueSize(c, box.glueSet);
          if (c.leader && size > 0) this.hleaders(c, box, left, h, size, baseline);
          h += size;
          break;
        }
        case "kern":
          h += c.width;
          break;
        case "penalty":
          break;
        default:
          this.markAt(c, h, baseline, this.ctx.top);
          break;
      }
    }
  }

  private hleaders(g: Glue, box: HBox, left: number, h: number, size: number, baseline: number): void {
    const leader = g.leader!;
    if (leader.t === "rule") {
      const ht = leader.height ?? box.height;
      const dp = leader.depth ?? box.depth;
      if (ht + dp > 0) {
        this.v.rule?.(h, baseline - ht, size, ht + dp, leader.color);
        this.material(h, h + size);
      }
      return;
    }
    const lw = leader.width;
    if (!(lw > 0)) return;
    // Aligned leaders: copies sit at multiples of the leader width from the enclosing box's left edge.
    let x = left + lw * Math.ceil((h - left) / lw - 1e-9);
    const end = h + size + 1e-9;
    let guard = 0;
    while (x + lw <= end && guard++ < 100000) {
      if (leader.t === "hbox") this.hlist(leader, x, baseline + (leader.shift ?? 0));
      else this.vlist(leader, x, baseline + (leader.shift ?? 0) - leader.height);
      x += lw;
    }
  }

  private vlist(box: VBox, left: number, top: number): void {
    let v = top;
    for (const c of box.children) {
      switch (c.t) {
        case "hbox":
          v += c.height;
          if (c.children.length) this.line(c, left + (c.shift ?? 0), v);
          v += c.depth;
          break;
        case "vbox":
          if (c.children.length) this.vlist(c, left + (c.shift ?? 0), v);
          v += c.height + c.depth;
          break;
        case "rule": {
          const w = c.width ?? box.width;
          const ht = (c.height ?? 0) + (c.depth ?? 0);
          if (w > 0 && ht > 0) this.vmaterial(left, v, w, ht, () => this.v.rule?.(left, v, w, ht, c.color));
          v += ht;
          break;
        }
        case "image": {
          const y = v;
          this.vmaterial(left, y, c.width, c.height, () => this.v.image?.(c, left, y + c.height));
          v += c.height;
          break;
        }
        case "drawing": {
          const y = v;
          this.vmaterial(left, y, c.width, c.height + c.depth, () => this.v.drawing?.(c, left, y + c.height));
          v += c.height + c.depth;
          break;
        }
        case "glue": {
          const size = glueSize(c, box.glueSet);
          if (c.leader && size > 0) this.vleaders(c, box, left, top, v, size);
          v += size;
          break;
        }
        case "kern":
          v += c.width;
          break;
        case "penalty":
          break;
        default:
          this.markAt(c, left, v, v);
          break;
      }
    }
  }

  /** Material placed directly in a vlist forms its own line for link purposes. */
  private vmaterial(x: number, top: number, w: number, h: number, draw: () => void): void {
    const saved = this.ctx;
    const ctx = { top, bottom: top + h };
    this.ctx = ctx;
    draw();
    this.material(x, x + w);
    if (this.link?.seg?.ctx === ctx) this.flush();
    this.ctx = saved;
  }

  private vleaders(g: Glue, box: VBox, left: number, top: number, v: number, size: number): void {
    const leader = g.leader!;
    if (leader.t === "rule") {
      const w = leader.width ?? box.width;
      if (w > 0) this.vmaterial(left, v, w, size, () => this.v.rule?.(left, v, w, size, leader.color));
      return;
    }
    const lh = leader.height + leader.depth;
    if (!(lh > 0)) return;
    let y = top + lh * Math.ceil((v - top) / lh - 1e-9);
    const end = v + size + 1e-9;
    let guard = 0;
    while (y + lh <= end && guard++ < 100000) {
      if (leader.t === "hbox") this.line(leader, left + (leader.shift ?? 0), y + leader.height);
      else this.vlist(leader, left + (leader.shift ?? 0), y);
      y += lh;
    }
  }
}

/** Every anchor in a box with its position (top-down, relative to the box's top-left corner). */
export function collectAnchors(box: VBox): { id: string; x: number; y: number }[] {
  const out: { id: string; x: number; y: number }[] = [];
  new Walker({ anchor: (id, x, y) => out.push({ id, x, y }) }).vbox(box, 0, 0);
  return out;
}

/** Every mark in a box, in reading order. */
export function collectMarks(box: VBox | HBox): Mark[] {
  const out: Mark[] = [];
  const w = new Walker({ mark: (m) => out.push(m) });
  if (box.t === "vbox") w.vbox(box, 0, 0);
  else w.hbox(box, 0, 0);
  return out;
}
