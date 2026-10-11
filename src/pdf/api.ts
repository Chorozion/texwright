/**
 * The interface the page shipper uses to produce a PDF. Implemented by
 * src/pdf/writer.ts. Coordinates are PDF points with the origin at the
 * BOTTOM-LEFT of the page, y up (the shipper converts from TeX's top-down
 * layout).
 */

import type { Font } from "../font/index.js";
import type { BlendMode, Color, ImageRef, Paint, PathCommand } from "../layout/types.js";

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string; // application that created the source
  producer?: string; // defaults to "texwright"
  lang?: string; // BCP 47, written to /Lang
  /** Fixed creation date for reproducible output; defaults to now. */
  date?: Date;
}

export interface PdfPage {
  readonly width: number;
  readonly height: number;
  /**
   * Draw shaped glyphs with their baseline origin at (x, y). advances are in points; yOffsets (points, up) optional.
   * hscale (default 1) widens or narrows the outlines (font expansion); the advances already include it.
   */
  glyphs(font: Font, size: number, x: number, y: number, gids: number[], advances: number[], text: string[], color?: Color, yOffsets?: number[], alpha?: number, hscale?: number): void;
  /** Filled or stroked path; a paint is a colour or a gradient, with an opacity 0..1. */
  path(d: PathCommand[], style: PathStyle): void;
  rect(x: number, y: number, width: number, height: number, fill: Color): void;
  /** An image; `pixelated` asks for square pixels when it is scaled up (previews; PDF viewers choose for themselves). */
  image(image: ImageRef, x: number, y: number, width: number, height: number, alpha?: number, pixelated?: boolean): void;
  /**
   * Draws what `draw` draws as one layer, then composites it with an
   * opacity, a blend mode and an optional soft mask (what `mask.draw`
   * draws: its luminance, or its alpha). `bbox` bounds both in the
   * current space, [x0, y0, x1, y1].
   */
  group(opts: GroupOptions, draw: () => void): void;
  save(): void;
  restore(): void;
  transform(m: [number, number, number, number, number, number]): void;
  clip(d: PathCommand[], evenOdd?: boolean): void;
  /** A clickable area: an external URL or a named destination in this document. */
  link(x: number, y: number, width: number, height: number, target: { url: string } | { dest: string }): void;
  /** A named destination at (x, y) on this page (top-left of the target's view). */
  destination(name: string, x: number, y: number): void;
}

export interface PathStyle {
  fill?: Paint;
  stroke?: Paint;
  fillAlpha?: number;
  strokeAlpha?: number;
  lineWidth?: number;
  evenOdd?: boolean;
  dash?: number[];
  lineCap?: 0 | 1 | 2;
  lineJoin?: 0 | 1 | 2;
  /** At least 1; default 10. */
  miterLimit?: number;
}

export interface GroupOptions {
  bbox: [number, number, number, number];
  opacity?: number;
  blend?: BlendMode;
  mask?: { luminance: boolean; draw: () => void };
}

export interface PdfDocumentWriter {
  /** Register a decoded raster image (PNG or JPEG bytes) and get a reference to draw it with. */
  addImage(bytes: Uint8Array): ImageRef;
  addPage(width: number, height: number): PdfPage;
  /** A bookmark; level 1 is top level. dest must be a destination defined on some page. */
  outline(title: string, level: number, dest: string): void;
  /** Page labels such as roman numerals for front matter (optional). startPage is a 0-based page index. */
  pageLabels?(ranges: { startPage: number; style: "D" | "r" | "R" | "a" | "A"; prefix?: string; start?: number }[]): void;
  setInfo(info: PdfInfo): void;
  /** Problems that did not stop writing (dropped links, unknown destinations, ignored URL schemes). */
  readonly warnings?: string[];
  /** Serialize. Fonts are subset to the glyphs actually drawn. */
  finish(): Uint8Array;
}
