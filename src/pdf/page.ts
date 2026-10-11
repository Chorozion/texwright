/**
 * One page: builds the content stream and records the resources, links and
 * destinations it uses. Graphics state that PDF keeps between operators
 * (colours, opacity, line style, font, text rise, the transformation) is
 * tracked so each is only written when it changes; save()/restore() push
 * and pop that tracking with q/Q.
 *
 * Gradients become shading patterns, whose matrix is fixed when they are
 * used (gradient space to the page, through the transformation then in
 * force). Opacity goes into ExtGState entries. A group is drawn into a form
 * XObject marked as a transparency group and painted with its opacity,
 * blend mode and soft mask (itself a form) in one ExtGState.
 */

import type { Font } from "../font/index.js";
import { IDENTITY, type Matrix, flatColor, invert, multiply, tRange } from "../layout/paint.js";
import { type BlendMode, type Color, type Gradient, type ImageRef, type Paint, type PathCommand, isGradient } from "../layout/types.js";
import type { GroupOptions, PathStyle, PdfPage } from "./api.js";
import { PdfError } from "./errors.js";
import type { FontEntry } from "./fonts.js";
import type { ImageEntry } from "./images.js";
import { num, round2, round4 } from "./serialize.js";
import { patternDict } from "./shading.js";

/** An ExtGState: constant opacity for filling and stroking, a blend mode, a soft mask. */
export interface GraphicsStateDict {
  ca: number;
  CA: number;
  BM?: BlendMode;
  /** The mask's form and whether its luminance (or its alpha) masks. */
  smask?: { form: FormEntry; luminance: boolean };
}

/** A form XObject drawn on one page: a group, or the content of a soft mask. */
export interface FormEntry {
  name: string;
  bbox: [number, number, number, number];
  content: string;
  /** Painted with Do (listed in the page's XObjects); masks are only referenced from their ExtGState. */
  painted: boolean;
}

/** What a page needs from its document. */
export interface PageHost {
  readonly warnings: string[];
  checkOpen(): void;
  fontEntry(font: Font): FontEntry;
  imageEntry(image: ImageRef): ImageEntry;
  addDestination(name: string, page: number, x: number, y: number): void;
  /** The resource name of an ExtGState with these entries. */
  graphicsState(d: GraphicsStateDict): string;
  /** The resource name of a pattern with this dictionary. */
  pattern(dict: string): string;
  /** A fresh resource name for a form XObject. */
  formName(): string;
}

export type LinkTarget = { url: string } | { dest: string };

export interface PageLink {
  rect: [number, number, number, number];
  /** Percent-encoded ASCII URI, or a destination name. */
  uri?: string;
  dest?: string;
}

interface GState {
  /** "r g b", a gray level, or a pattern's resource name ("/P1"). */
  fill: string;
  stroke: string;
  ca: number;
  CA: number;
  ctm: Matrix;
  lineWidth: number;
  dash: string;
  cap: number;
  join: number;
  miter: number;
  font: FontEntry | undefined;
  size: number;
  rise: number;
  /** Horizontal scaling in percent (Tz); 100 wherever a form may be painted, so forms can assume it. */
  hscale: number;
}

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new PdfError(`${what} must be a finite number, got ${String(v)}`);
  return v;
}

/** "r g b" for a colour (components clamped to 0..1), or a single gray value. */
function colorKey(c: Color, what: string): string {
  if (!Array.isArray(c) || c.length !== 3) throw new PdfError(`${what} must be an [r, g, b] array`);
  const [r, g, b] = c.map((v) => Math.min(1, Math.max(0, finite(v, what))));
  return r === g && g === b ? num(round4(r)) : `${num(round4(r))} ${num(round4(g))} ${num(round4(b))}`;
}

/** Percent-encodes everything outside printable ASCII (URIs in PDF are 7-bit). */
function encodeUri(url: string): string {
  let out = "";
  for (const ch of url) {
    const c = ch.codePointAt(0)!;
    if (c > 0x20 && c < 0x7f) out += ch;
    else for (const b of Buffer.from(ch, "utf8")) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

const INITIAL: GState = { fill: "0", stroke: "0", ca: 1, CA: 1, ctm: IDENTITY, lineWidth: 1, dash: "[] 0", cap: 0, join: 0, miter: 10, font: undefined, size: 0, rise: 0, hscale: 100 };

/**
 * A form's content starts with the graphics state of wherever it is painted
 * (colours, line style, text rise), so in a form every parameter counts as
 * unknown and is written on first use. NaN equals nothing.
 */
const UNKNOWN: GState = { fill: "", stroke: "", ca: NaN, CA: NaN, ctm: IDENTITY, lineWidth: NaN, dash: "", cap: -1, join: -1, miter: NaN, font: undefined, size: 0, rise: NaN, hscale: 100 };

/** An opacity 0..1 (default 1), checked. */
function opacity(v: number | undefined, what: string): number {
  if (v === undefined) return 1;
  return round4(Math.min(1, Math.max(0, finite(v, what))));
}

const BLEND_NAMES: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn",
  "hard-light": "HardLight",
  "soft-light": "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

export function blendName(b: BlendMode): string {
  const name = Object.hasOwn(BLEND_NAMES, b) ? BLEND_NAMES[b] : undefined;
  if (!name) throw new PdfError(`unknown blend mode ${JSON.stringify(b)}`);
  return name;
}

/** Corners of the box around a path's points (control points included, so it is never too small), grown by `pad`. */
function pathCorners(d: PathCommand[], pad: number): number[] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of d) {
    for (let j = 1; j + 1 < c.length; j += 2) {
      const x = c[j] as number;
      const y = c[j + 1] as number;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!(x0 <= x1)) return [];
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

export class PageImpl implements PdfPage {
  readonly fonts = new Set<FontEntry>();
  readonly images = new Set<ImageEntry>();
  readonly links: PageLink[] = [];
  /** Resource names of the ExtGStates, patterns and forms the page uses. */
  readonly graphicsStates = new Set<string>();
  readonly patterns = new Set<string>();
  readonly forms: FormEntry[] = [];
  private ops: string[] = [];
  private gs: GState = { ...INITIAL };
  private stack: GState[] = [];
  private inText = false;
  /** Start of the current text line inside BT (what Td is relative to). */
  private tx = 0;
  private ty = 0;
  /** Glyphs were shown since the last Td: the pen is no longer at the line start. */
  private shown = false;

  constructor(
    private readonly host: PageHost,
    readonly index: number,
    readonly width: number,
    readonly height: number,
  ) {}

  // ---------------------------------------------------------------- state

  private beginText(): void {
    if (!this.inText) {
      this.ops.push("BT");
      this.inText = true;
      this.tx = 0;
      this.ty = 0;
      this.shown = false;
    }
  }

  private endText(): void {
    if (this.inText) {
      this.ops.push("ET");
      this.inText = false;
    }
  }

  private setFill(key: string): void {
    if (this.gs.fill !== key) {
      this.ops.push(key.startsWith("/") ? `/Pattern cs ${key} scn` : key.includes(" ") ? `${key} rg` : `${key} g`);
      this.gs.fill = key;
    }
  }

  private setStroke(key: string): void {
    if (this.gs.stroke !== key) {
      this.ops.push(key.startsWith("/") ? `/Pattern CS ${key} SCN` : key.includes(" ") ? `${key} RG` : `${key} G`);
      this.gs.stroke = key;
    }
  }

  /** Sets the constant opacity for filling (ca) and stroking (CA). */
  private setAlpha(ca: number, CA: number): void {
    const gs = this.gs;
    // An opacity not known yet (in a form) is taken as 1 when the other one is set.
    if (Number.isNaN(ca)) ca = 1;
    if (Number.isNaN(CA)) CA = 1;
    if (gs.ca === ca && gs.CA === CA) return;
    const name = this.host.graphicsState({ ca, CA });
    this.graphicsStates.add(name);
    this.ops.push(`/${name} gs`);
    gs.ca = ca;
    gs.CA = CA;
  }

  /**
   * The colour key for a paint: a colour, or a pattern drawing the gradient
   * across the box `corners` (user space) with the transformation in force.
   */
  private paintKey(p: Paint, what: string, corners: () => number[]): string {
    if (!isGradient(p)) return colorKey(p, what);
    checkGradient(p, what);
    const flat = flatColor(p);
    if (flat) return colorKey(flat, what);
    const inv = invert(p.matrix);
    if (!inv) return colorKey(p.stops[p.stops.length - 1].color, what);
    const range = p.spread === "pad" ? ([0, 1] as [number, number]) : tRange(p, inv, corners());
    const name = this.host.pattern(patternDict(p, multiply(p.matrix, this.gs.ctm), range));
    this.patterns.add(name);
    return "/" + name;
  }

  // ------------------------------------------------------------- PdfPage

  glyphs(font: Font, size: number, x: number, y: number, gids: number[], advances: number[], text: string[], color?: Color, yOffsets?: number[], alpha?: number, hscale?: number): void {
    this.host.checkOpen();
    if (!Array.isArray(gids) || !Array.isArray(advances)) throw new PdfError("glyphs(): gids and advances must be arrays");
    const n = gids.length;
    if (advances.length !== n) throw new PdfError(`glyphs(): ${n} glyph ids but ${advances.length} advances`);
    if (yOffsets && yOffsets.length !== n) throw new PdfError(`glyphs(): ${n} glyph ids but ${yOffsets.length} y offsets`);
    finite(x, "glyphs() x");
    finite(y, "glyphs() y");
    const sizeW = round4(finite(size, "font size"));
    const tz = hscale === undefined ? 100 : round4(finite(hscale, "glyph horizontal scale") * 100);
    if (!(tz > 0)) throw new PdfError(`glyph horizontal scale ${hscale} must be positive`);
    if (sizeW === 0) throw new PdfError(`font size ${size} is too small`);
    if (n === 0) return;
    const fill = colorKey(color ?? [0, 0, 0], "glyph colour");
    const ca = opacity(alpha, "glyph opacity");
    const entry = this.host.fontEntry(font);
    const count = font.glyphCount;
    for (let i = 0; i < n; i++) {
      const g = gids[i];
      if (!Number.isInteger(g) || g < 0 || g >= count || g > 0xffff) throw new PdfError(`glyph id ${g} is not in font ${font.postscriptName} (${count} glyphs)`);
      finite(advances[i], "glyph advance");
      if (yOffsets) finite(yOffsets[i], "glyph y offset");
    }
    for (let i = 0; i < n; i++) {
      const t = text?.[i];
      entry.use(gids[i], typeof t === "string" ? t : "");
    }
    this.fonts.add(entry);

    const ops = this.ops;
    this.beginText();
    this.setFill(fill);
    this.setAlpha(ca, this.gs.CA);
    const gs = this.gs;
    if (gs.font !== entry || gs.size !== sizeW) {
      ops.push(`/${entry.resName} ${num(sizeW)} Tf`);
      gs.font = entry;
      gs.size = sizeW;
    }
    // Expanded glyphs (microtype): Tz scales the outlines and the widths from /W.
    if (gs.hscale !== tz) {
      ops.push(`${num(tz)} Tz`);
      gs.hscale = tz;
    }
    // Td is relative to the start of the current line; the tracked position
    // is the rounded value the reader will see, so rounding never accumulates.
    const dx = round4(x - this.tx);
    const dy = round4(y - this.ty);
    // A run that starts where the last one started still needs "0 0 Td": showing
    // glyphs moved the pen on, and only Td brings it back (\not= overlays this way).
    if (dx !== 0 || dy !== 0 || this.shown) {
      ops.push(`${num(dx)} ${num(dy)} Td`);
      this.tx += dx;
      this.ty += dy;
      this.shown = false;
    }

    // Positions in thousandths of the font size from the run's origin: q is
    // where the reader's pen is (glyph widths from /W minus TJ adjustments),
    // p is where the caller wants it.
    // Differences below 0.001 pt (1/size in thousandths of an em) are not
    // worth an adjustment; they come from the four-decimal widths in /W.
    // Under Tz the pen moves by widths times the scale, so wanted positions are divided by it.
    const k = tz === 100 ? 1000 / sizeW : 100000 / (sizeW * tz);
    const tolerance = 1 / Math.abs(sizeW);
    let q = 0;
    let p = 0;
    let rise = gs.rise;
    let seg = "";
    let hex = "";
    let hasNumbers = false;
    const flushHex = () => {
      if (hex) {
        seg += `<${hex}>`;
        hex = "";
      }
    };
    const flushSeg = () => {
      flushHex();
      if (seg) {
        ops.push(hasNumbers ? `[${seg}] TJ` : `${seg} Tj`);
        this.shown = true;
      }
      seg = "";
      hasNumbers = false;
    };
    for (let i = 0; i < n; i++) {
      const r = yOffsets ? round4(yOffsets[i]) : 0;
      if (r !== rise) {
        flushSeg();
        ops.push(`${num(r)} Ts`);
        rise = r;
      }
      const g = gids[i];
      hex += entry.hex(g);
      q += entry.width(g);
      p += advances[i] * k;
      if (i < n - 1 && Math.abs(q - p) >= tolerance) {
        const adj = round2(q - p);
        if (adj !== 0) {
          flushHex();
          seg += num(adj);
          hasNumbers = true;
          q -= adj;
        }
      }
    }
    flushSeg();
    gs.rise = rise;
  }

  path(d: PathCommand[], style: PathStyle): void {
    this.host.checkOpen();
    const body = pathOps(d);
    const fillAlpha = opacity(style.fillAlpha, "fill opacity");
    const strokeAlpha = opacity(style.strokeAlpha, "stroke opacity");
    let lineWidth = 1;
    let dash = "[] 0";
    let cap = 0;
    let join = 0;
    let miter = 10;
    if (style.stroke) {
      lineWidth = round4(finite(style.lineWidth ?? 1, "line width"));
      if (lineWidth < 0) throw new PdfError(`line width ${style.lineWidth} is negative`);
      dash = dashKey(style.dash);
      cap = style.lineCap ?? 0;
      join = style.lineJoin ?? 0;
      if (cap !== 0 && cap !== 1 && cap !== 2) throw new PdfError(`line cap ${cap} is not 0, 1 or 2`);
      if (join !== 0 && join !== 1 && join !== 2) throw new PdfError(`line join ${join} is not 0, 1 or 2`);
      miter = Math.max(1, round4(finite(style.miterLimit ?? 10, "miter limit")));
    }
    if (!style.fill && !style.stroke) return;
    const fill = style.fill && fillAlpha > 0 ? this.paintKey(style.fill, "path fill", () => pathCorners(d, 0)) : undefined;
    const stroke = style.stroke && strokeAlpha > 0 ? this.paintKey(style.stroke, "path stroke", () => pathCorners(d, lineWidth * 2)) : undefined;
    if ((!fill && !stroke) || !body) return;
    this.endText();
    const gs = this.gs;
    this.setAlpha(fill ? fillAlpha : gs.ca, stroke ? strokeAlpha : gs.CA);
    if (fill) this.setFill(fill);
    if (stroke) {
      this.setStroke(stroke);
      if (gs.lineWidth !== lineWidth) this.ops.push(`${num(lineWidth)} w`), (gs.lineWidth = lineWidth);
      if (gs.dash !== dash) this.ops.push(`${dash} d`), (gs.dash = dash);
      if (gs.cap !== cap) this.ops.push(`${cap} J`), (gs.cap = cap);
      if (gs.join !== join) this.ops.push(`${join} j`), (gs.join = join);
      if (join === 0 && gs.miter !== miter) this.ops.push(`${num(miter)} M`), (gs.miter = miter);
    }
    const eo = style.evenOdd === true;
    this.ops.push(body, fill && stroke ? (eo ? "B*" : "B") : fill ? (eo ? "f*" : "f") : "S");
  }

  rect(x: number, y: number, width: number, height: number, fill: Color): void {
    this.host.checkOpen();
    const box = [x, y, width, height].map((v) => num(round4(finite(v, "rect() coordinate"))));
    const key = colorKey(fill, "rect fill");
    this.endText();
    this.setAlpha(1, this.gs.CA);
    this.setFill(key);
    this.ops.push(`${box.join(" ")} re f`);
  }

  image(image: ImageRef, x: number, y: number, width: number, height: number, alpha?: number): void {
    this.host.checkOpen();
    const m = [width, 0, 0, height, x, y].map((v) => num(round4(finite(v, "image() coordinate"))));
    const ca = opacity(alpha, "image opacity");
    const entry = this.host.imageEntry(image);
    if (ca === 0) return;
    this.images.add(entry);
    this.endText();
    this.setAlpha(ca, this.gs.CA);
    this.ops.push(`q ${m.join(" ")} cm /${entry.resName} Do Q`);
  }

  group(opts: GroupOptions, draw: () => void): void {
    this.host.checkOpen();
    if (!opts || !Array.isArray(opts.bbox) || opts.bbox.length !== 4) throw new PdfError("group() needs a bbox [x0, y0, x1, y1]");
    const bbox = opts.bbox.map((v) => round4(finite(v, "group() bbox"))) as [number, number, number, number];
    const ca = opacity(opts.opacity, "group opacity");
    if (opts.blend !== undefined) blendName(opts.blend);
    if (typeof draw !== "function") throw new PdfError("group() needs a function that draws its content");
    const form: FormEntry = { name: this.host.formName(), bbox, content: this.capture(draw), painted: true };
    let smask: GraphicsStateDict["smask"];
    if (opts.mask) {
      const m = opts.mask;
      if (typeof m.draw !== "function") throw new PdfError("group() mask needs a function that draws it");
      smask = { form: { name: this.host.formName(), bbox, content: this.capture(m.draw), painted: false }, luminance: m.luminance !== false };
    }
    if (ca === 0 || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return;
    if (smask) this.forms.push(smask.form);
    this.forms.push(form);
    const gsName = this.host.graphicsState({ ca, CA: ca, BM: opts.blend ?? "normal", smask });
    this.graphicsStates.add(gsName);
    this.endText();
    this.resetHScale();
    this.ops.push(`q /${gsName} gs /${form.name} Do Q`);
  }

  /**
   * Runs `draw` with the content going to a separate stream, as a form's
   * content: a form's space is the user space it is painted in, and its
   * other graphics state is whatever is in force there, so nothing is
   * assumed about it.
   */
  private capture(draw: () => void): string {
    this.endText();
    const saved = { ops: this.ops, gs: this.gs, stack: this.stack, tx: this.tx, ty: this.ty, shown: this.shown };
    this.ops = [];
    this.gs = { ...UNKNOWN };
    this.stack = [];
    try {
      draw();
      return this.content();
    } finally {
      this.ops = saved.ops;
      this.gs = saved.gs;
      this.stack = saved.stack;
      this.inText = false;
      this.tx = saved.tx;
      this.ty = saved.ty;
      this.shown = saved.shown;
    }
  }

  /** Back to unscaled text before painting a form, whose content assumes Tz 100. */
  private resetHScale(): void {
    if (this.gs.hscale !== 100) {
      this.ops.push("100 Tz");
      this.gs.hscale = 100;
    }
  }

  save(): void {
    this.host.checkOpen();
    this.endText();
    this.ops.push("q");
    this.stack.push({ ...this.gs });
  }

  restore(): void {
    this.host.checkOpen();
    const prev = this.stack.pop();
    if (!prev) {
      this.host.warnings.push(`page ${this.index + 1}: restore() without a matching save() ignored`);
      return;
    }
    this.endText();
    this.ops.push("Q");
    this.gs = prev;
  }

  transform(m: [number, number, number, number, number, number]): void {
    this.host.checkOpen();
    if (!Array.isArray(m) || m.length !== 6) throw new PdfError("transform() needs six numbers");
    const values = m.map((v) => round4(finite(v, "transform() entry"))) as Matrix;
    this.endText();
    this.ops.push(`${values.map(num).join(" ")} cm`);
    this.gs.ctm = multiply(values, this.gs.ctm);
  }

  clip(d: PathCommand[], evenOdd?: boolean): void {
    this.host.checkOpen();
    const body = pathOps(d) || "0 0 0 0 re"; // an empty clip path hides everything
    this.endText();
    this.ops.push(body, evenOdd ? "W* n" : "W n");
  }

  link(x: number, y: number, width: number, height: number, target: LinkTarget): void {
    this.host.checkOpen();
    const [x0, y0, w, h] = [x, y, width, height].map((v) => round4(finite(v, "link() coordinate")));
    const rect: [number, number, number, number] = [Math.min(x0, x0 + w), Math.min(y0, y0 + h), Math.max(x0, x0 + w), Math.max(y0, y0 + h)];
    if (target && typeof (target as { url?: unknown }).url === "string") {
      const url = (target as { url: string }).url.trim();
      const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1].toLowerCase();
      if (!scheme || !ALLOWED_SCHEMES.has(scheme)) {
        this.host.warnings.push(`page ${this.index + 1}: link to ${JSON.stringify(url.slice(0, 100))} ignored (only http, https and mailto URLs are allowed)`);
        return;
      }
      this.links.push({ rect, uri: encodeUri(url) });
    } else if (target && typeof (target as { dest?: unknown }).dest === "string") {
      this.links.push({ rect, dest: (target as { dest: string }).dest });
    } else {
      throw new PdfError("link() target must be { url } or { dest }");
    }
  }

  destination(name: string, x: number, y: number): void {
    this.host.checkOpen();
    if (typeof name !== "string") throw new PdfError("destination() name must be a string");
    this.host.addDestination(name, this.index, round4(finite(x, "destination() x")), round4(finite(y, "destination() y")));
  }

  // -------------------------------------------------------------- output

  /** The finished content stream: open text objects and unbalanced saves are closed. */
  content(): string {
    this.endText();
    let out = this.ops.join("\n");
    if (this.stack.length) out += "\nQ".repeat(this.stack.length);
    return out;
  }
}

/** Throws for a gradient the writer cannot use. */
function checkGradient(g: Gradient, what: string): void {
  if (g.kind !== "linear" && g.kind !== "radial") throw new PdfError(`${what}: unknown gradient kind ${JSON.stringify(g.kind)}`);
  const n = g.kind === "linear" ? 4 : 6;
  if (!Array.isArray(g.coords) || g.coords.length !== n) throw new PdfError(`${what}: a ${g.kind} gradient needs ${n} coordinates`);
  for (const v of g.coords) finite(v, `${what} gradient coordinate`);
  if (g.kind === "radial" && (g.coords[2] < 0 || g.coords[5] < 0)) throw new PdfError(`${what}: gradient radii must not be negative`);
  if (!Array.isArray(g.matrix) || g.matrix.length !== 6) throw new PdfError(`${what}: gradient matrix needs six numbers`);
  for (const v of g.matrix) finite(v, `${what} gradient matrix entry`);
  if (!Array.isArray(g.stops) || !g.stops.length) throw new PdfError(`${what}: a gradient needs at least one stop`);
  for (const s of g.stops) {
    finite(s.offset, `${what} gradient stop offset`);
    colorKey(s.color, `${what} gradient stop colour`);
  }
  if (g.spread !== "pad" && g.spread !== "reflect" && g.spread !== "repeat") throw new PdfError(`${what}: spread must be pad, reflect or repeat`);
}

/** Path construction operators for `d`, validated before anything is written; "" for an empty path. */
function pathOps(d: PathCommand[]): string {
  if (!Array.isArray(d)) throw new PdfError("path must be an array of commands");
  const parts: string[] = [];
  let current = false;
  const xy = (cmd: readonly unknown[], from: number, count: number): string => {
    if (cmd.length !== from + count) throw new PdfError(`path command ${String(cmd[0])} needs ${count} numbers`);
    let s = "";
    for (let i = from; i < from + count; i++) s += (i > from ? " " : "") + num(round4(finite(cmd[i], "path coordinate")));
    return s;
  };
  for (const cmd of d) {
    if (!Array.isArray(cmd)) throw new PdfError("path command must be an array");
    switch (cmd[0]) {
      case "M":
        parts.push(`${xy(cmd, 1, 2)} m`);
        current = true;
        break;
      case "L":
        if (!current) throw new PdfError("path must start with M");
        parts.push(`${xy(cmd, 1, 2)} l`);
        break;
      case "C":
        if (!current) throw new PdfError("path must start with M");
        parts.push(`${xy(cmd, 1, 6)} c`);
        break;
      case "Z":
        if (!current) throw new PdfError("path must start with M");
        parts.push("h");
        break;
      default:
        throw new PdfError(`unknown path command ${JSON.stringify(cmd[0])}`);
    }
  }
  return parts.join("\n");
}

/** The dash operand: "[a b] 0"; an empty or all-zero pattern is a solid line. */
function dashKey(dash: number[] | undefined): string {
  if (!dash || !dash.length) return "[] 0";
  const values = dash.map((v) => round4(finite(v, "dash length")));
  if (values.some((v) => v < 0)) throw new PdfError("dash lengths must not be negative");
  if (values.every((v) => v === 0)) return "[] 0";
  return `[${values.map(num).join(" ")}] 0`;
}
