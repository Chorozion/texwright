/**
 * The box-and-glue model shared by the math typesetter, the paragraph and
 * page builders and the PDF shipper. It follows TeX (The TeXbook, ch. 12):
 *
 * - Units are PostScript points (1/72 inch).
 * - Every box has a width, a height above its baseline and a depth below it.
 * - An HBox lays its children left to right on a common baseline; a VBox
 *   stacks them top to bottom, each child's baseline below the previous one
 *   by the child's height (plus whatever glue and kerns sit between them).
 * - Glue is space that can stretch and shrink; once a list is packed to a
 *   target size the box records how its glue was set (`glueSet`).
 * - Children of an HBox may be shifted down (`shift` > 0) relative to the
 *   baseline; children of a VBox may be shifted right.
 *
 * All nodes are plain objects so lists can be built, inspected and tested
 * without classes.
 */

import type { Font } from "../font/index.js";

export type GlueOrder = 0 | 1 | 2 | 3; // finite, fil, fill, filll

export interface Glue {
  t: "glue";
  width: number;
  stretch: number;
  stretchOrder: GlueOrder;
  shrink: number;
  shrinkOrder: GlueOrder;
  /** Leaders fill the glue's space with a repeated box or rule (dot leaders in a table of contents). */
  leader?: Box | Rule;
}

export interface Kern {
  t: "kern";
  width: number;
  /** "math" kerns from \mkern / italic corrections behave like ordinary kerns; kept for debugging. "margin" kerns hang a character into the margin (microtype's protrusion). */
  subtype?: "normal" | "math" | "italic" | "margin";
}

/** A breakpoint with a cost. 10000 forbids a break, -10000 forces one. */
export interface Penalty {
  t: "penalty";
  penalty: number;
  /** Width added at the break (e.g. a hyphen). */
  width?: number;
  /** A flagged penalty (hyphen); consecutive flagged breaks cost extra. */
  flagged?: boolean;
  /** Material shown at the end of the line if broken here (hyphen glyphs). */
  preBreak?: HNode[];
}

/** A solid rectangle. Undefined dimensions are "running" (take the size of the enclosing box). */
export interface Rule {
  t: "rule";
  width?: number;
  height?: number;
  depth?: number;
  color?: Color;
}

/** Glyphs of one font at one size, already shaped (ligatures applied, kerning folded into advances). */
export interface Glyphs {
  t: "glyphs";
  font: Font;
  size: number;
  /** Glyph ids in the font. */
  gids: number[];
  /** Horizontal advance of each glyph in points (kerning included). */
  advances: number[];
  /** Optional vertical offsets in points (positive = up), for placed accents. */
  yOffsets?: number[];
  /** The Unicode text these glyphs stand for, one entry per glyph (ligatures carry several characters), for copy-paste and search. */
  text: string[];
  width: number;
  height: number;
  depth: number;
  color?: Color;
  /** Horizontal scale of the outlines (font expansion, drawn with PDF's Tz); advances and width already include it. Default 1. */
  hscale?: number;
}

export interface ImageRef {
  /** Identifies the decoded image for the PDF writer; the same id is embedded once. */
  id: string;
  /** Natural size in pixels, for aspect ratio. */
  pixelWidth: number;
  pixelHeight: number;
}

export interface Image {
  t: "image";
  image: ImageRef;
  width: number;
  height: number;
  depth: 0;
}

/** Vector drawing (SVG figures, diagrams) in a box-local coordinate system, y up, origin at the box's left baseline. */
export interface Drawing {
  t: "drawing";
  ops: DrawOp[];
  width: number;
  height: number;
  depth: number;
}

export type DrawOp =
  | {
      op: "path";
      d: PathCommand[];
      fill?: Paint;
      stroke?: Paint;
      /** Opacity of the fill and of the stroke, 0..1 (default 1). */
      fillAlpha?: number;
      strokeAlpha?: number;
      lineWidth?: number;
      evenOdd?: boolean;
      dash?: number[];
      lineCap?: 0 | 1 | 2;
      lineJoin?: 0 | 1 | 2;
      /** Longest miter join as a multiple of the line width before it is bevelled (default 10, PDF's). */
      miterLimit?: number;
    }
  | { op: "glyphs"; x: number; y: number; run: Glyphs; alpha?: number }
  | {
      op: "image";
      x: number;
      y: number;
      width: number;
      height: number;
      image: ImageRef;
      alpha?: number;
      /** Scaled up as square pixels rather than smoothed (image-rendering: pixelated). */
      pixelated?: boolean;
    }
  | { op: "save" }
  | { op: "restore" }
  | { op: "transform"; m: [number, number, number, number, number, number] }
  | { op: "clip"; d: PathCommand[]; evenOdd?: boolean }
  | {
      /**
       * Drawn as one layer, then composited: with an opacity, a blend mode
       * and a soft mask (the mask's luminance, or its alpha). `bbox` bounds
       * the layer in the current space: [x0, y0, x1, y1].
       */
      op: "group";
      ops: DrawOp[];
      bbox: [number, number, number, number];
      opacity?: number;
      blend?: BlendMode;
      mask?: { ops: DrawOp[]; luminance: boolean };
    };

/** A gradient paint: colour varying across the shape it fills or strokes. */
export interface Gradient {
  kind: "linear" | "radial";
  /** Linear: [x1, y1, x2, y2]; radial: [fx, fy, fr, cx, cy, r] (focal circle, then end circle). In gradient space. */
  coords: number[];
  /** Gradient space to the space the shape is drawn in. */
  matrix: [number, number, number, number, number, number];
  /** Offsets 0..1, not decreasing; at least one stop. */
  stops: { offset: number; color: Color }[];
  /** What happens beyond the ends: the end colours (pad), repeated, or mirrored (reflect). */
  spread: "pad" | "reflect" | "repeat";
}

/** What a shape is filled or stroked with. */
export type Paint = Color | Gradient;

export function isGradient(p: Paint | undefined): p is Gradient {
  return !!p && !Array.isArray(p);
}

/** How a group's colours combine with what is under it (PDF's and CSS's blend modes). */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export type PathCommand =
  | ["M", number, number]
  | ["L", number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

/** RGB components 0..1. */
export type Color = [number, number, number];

/** Zero-size markers carried through layout to the shipper. */
export type Mark =
  | { t: "anchor"; id: string } // a link destination (PDF named destination)
  | { t: "link-start"; target: { url: string } | { dest: string } }
  | { t: "link-end" }
  | { t: "outline"; title: string; level: number; dest: string } // a PDF bookmark
  | { t: "footnote"; content: VBox } // inserted at the foot of the page that holds this mark
  | { t: "float"; content: VBox; placement: "here" | "top" | "bottom" | "page" } // figures/tables
  | { t: "struct"; tag: string; open: boolean }; // tagged-PDF structure, optional

export interface HBox {
  t: "hbox";
  width: number;
  height: number;
  depth: number;
  children: HNode[];
  /** How the glue was set when the box was packed to its width. */
  glueSet?: { ratio: number; order: GlueOrder; sign: "stretch" | "shrink" | "none" };
  /** Vertical shift (down) when inside an HBox; horizontal shift (right) when inside a VBox. */
  shift?: number;
}

export interface VBox {
  t: "vbox";
  width: number;
  height: number;
  depth: number;
  children: VNode[];
  glueSet?: { ratio: number; order: GlueOrder; sign: "stretch" | "shrink" | "none" };
  shift?: number;
}

export type Box = HBox | VBox;

/** What may appear in a horizontal list. */
export type HNode = Glyphs | Glue | Kern | Penalty | Rule | HBox | VBox | Image | Drawing | Mark;
/** What may appear in a vertical list. */
export type VNode = HBox | VBox | Glue | Kern | Penalty | Rule | Image | Drawing | Mark;

// ------------------------------------------------------------------ helpers

export function glue(width: number, stretch = 0, shrink = 0, stretchOrder: GlueOrder = 0, shrinkOrder: GlueOrder = 0): Glue {
  return { t: "glue", width, stretch, stretchOrder, shrink, shrinkOrder };
}

export function kern(width: number): Kern {
  return { t: "kern", width };
}

export function penalty(p: number, extra: Partial<Penalty> = {}): Penalty {
  return { t: "penalty", penalty: p, ...extra };
}

export const INF_PENALTY = 10000;
export const EJECT_PENALTY = -10000;
