/**
 * Page geometry, fonts and typographic parameters for the native PDF engine.
 *
 * The article theme follows LaTeX's article class at 11pt (sizes, skips,
 * indents and penalties), set in the bundled Latin Modern faces (LaTeX's own
 * Computer Modern, with ligatures, kerning and accented letters). The
 * modern and compact themes use an installed sans-serif face when one is
 * available, falling back to the bundled fonts.
 */

import { type Font, bundledFont, fallbackFor, findSystemFont } from "../font/index.js";
import type { FontResolver, MicrotypeOptions, TextStyle } from "../layout/index.js";
import type { Color } from "../layout/types.js";

export const PAPER: Record<string, [number, number]> = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  legal: [612, 1008],
  b5: [498.9, 708.66],
};

/** A CSS-style length in points: "1in", "2.5cm", "20mm", "72pt", "96px". */
export function lengthPt(spec: string, fallback: number): number {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(in|cm|mm|pt|px|pc)?\s*$/i.exec(spec);
  if (!m) return fallback;
  const v = Number(m[1]);
  switch ((m[2] ?? "pt").toLowerCase()) {
    case "in":
      return v * 72;
    case "cm":
      return (v * 72) / 2.54;
    case "mm":
      return (v * 72) / 25.4;
    case "px":
      return v * 0.75;
    case "pc":
      return v * 12;
    default:
      return v;
  }
}

export interface Geometry {
  pageWidth: number;
  pageHeight: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  textWidth: number;
  textHeight: number;
}

export function geometry(paper: string, landscape: boolean, margin: string): Geometry {
  let [w, h] = PAPER[paper] ?? PAPER.letter!;
  if (landscape) [w, h] = [h, w];
  const parts = margin.split(/[,\s]+/).filter(Boolean).map((p) => lengthPt(p, 72));
  const [top, right = top!, bottom = top!, left = right] = parts.length === 2 ? [parts[0]!, parts[1]!, parts[0]!, parts[1]!] : parts.length ? parts : [72];
  return { pageWidth: w, pageHeight: h, top: top!, right, bottom, left, textWidth: w - left - right, textHeight: h - top! - bottom };
}

/** One family's faces. */
export interface Family {
  regular: Font;
  bold: Font;
  italic: Font;
  boldItalic: Font;
}

export interface Theme {
  name: string;
  serif: Family;
  sans: Family;
  mono: Font;
  /** Body size and leading. */
  size: number;
  baselineSkip: number;
  parIndent: number;
  parSkip: { width: number; stretch: number };
  /** Heading sizes by level (1 = section), and spacing above/below. */
  headingSize: number[];
  headingAbove: number[];
  headingBelow: number[];
  headingBold: boolean;
  headingColor?: Color;
  titleSize: number;
  smallSize: number;
  footnoteSize: number;
  codeSize: number;
  captionSize: number;
  displaySkip: number;
  listIndent: number;
  itemSep: number;
  linkColor: Color;
  ruleColor: Color;
  codeBackground?: Color;
  calloutBackground: Color;
  calloutRule: Color;
  /** Body text uses the sans family (modern, compact). */
  bodySans: boolean;
  justify: boolean;
  /** Page number position in the footer. */
  pageNumbers: "center" | "right" | "none";
  emergencyStretch: number;
  /** Character protrusion and font expansion in justified paragraphs (layout/microtype.ts); off when absent. */
  microtype?: MicrotypeOptions | false;
}

function bundledFamily(): Family {
  return {
    regular: bundledFont("LMRoman", "Regular"),
    bold: bundledFont("LMRoman", "Bold"),
    italic: bundledFont("LMRoman", "Italic"),
    boldItalic: bundledFont("LMRoman", "BoldItalic"),
  };
}

function bundledSans(): Family {
  const regular = bundledFont("SansSerif", "Regular");
  const bold = bundledFont("SansSerif", "Bold");
  return { regular, bold, italic: bundledFont("SansSerif", "Italic"), boldItalic: bold };
}

/** An installed sans family by preference, else the bundled sans. */
function systemSans(): Family {
  for (const name of ["Segoe UI", "Helvetica Neue", "Helvetica", "Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans"]) {
    const regular = findSystemFont(name);
    if (!regular || !regular.embeddingAllowed) continue;
    const bold = findSystemFont(name, { bold: true }) ?? regular;
    const italic = findSystemFont(name, { italic: true }) ?? regular;
    const boldItalic = findSystemFont(name, { bold: true, italic: true }) ?? bold;
    return { regular, bold, italic, boldItalic };
  }
  return bundledSans();
}

function systemMono(): Font {
  for (const name of ["Cascadia Mono", "Consolas", "Menlo", "DejaVu Sans Mono", "Liberation Mono", "Courier New"]) {
    const f = findSystemFont(name);
    if (f?.embeddingAllowed) return f;
  }
  return bundledFont("LMMono", "Regular");
}

const DARK_BLUE: Color = [0.102, 0.247, 0.545];

/**
 * A theme, optionally at another body size (LaTeX's 10pt, 11pt, 12pt class options): every size, skip
 * and indent scales with it, so the proportions of the page stay the same.
 */
export function theme(name: string, fontSize?: number): Theme {
  const t = baseTheme(name);
  if (!fontSize || !(fontSize > 0) || Math.abs(fontSize - t.size) < 0.01) return t;
  const k = fontSize / t.size;
  const s = (v: number) => v * k;
  return {
    ...t,
    size: fontSize,
    baselineSkip: s(t.baselineSkip),
    parIndent: s(t.parIndent),
    parSkip: { width: s(t.parSkip.width), stretch: s(t.parSkip.stretch) },
    headingSize: t.headingSize.map(s),
    headingAbove: t.headingAbove.map(s),
    headingBelow: t.headingBelow.map(s),
    titleSize: s(t.titleSize),
    smallSize: s(t.smallSize),
    footnoteSize: s(t.footnoteSize),
    codeSize: s(t.codeSize),
    captionSize: s(t.captionSize),
    displaySkip: s(t.displaySkip),
    listIndent: s(t.listIndent),
    itemSep: s(t.itemSep),
    emergencyStretch: s(t.emergencyStretch),
  };
}

function baseTheme(name: string): Theme {
  const serif = bundledFamily();
  if (name === "modern" || name === "compact") {
    const compact = name === "compact";
    const size = compact ? 9.5 : 10.5;
    return {
      name,
      serif,
      sans: systemSans(),
      mono: systemMono(),
      size,
      baselineSkip: size * (compact ? 1.42 : 1.5),
      parIndent: 0,
      parSkip: { width: size * (compact ? 0.5 : 0.7), stretch: 1 },
      headingSize: compact ? [13, 11, 10, 9.5, 9.5, 9.5] : [16, 12.5, 11, 10.5, 10.5, 10.5],
      headingAbove: compact ? [13, 11, 10, 8, 8, 8] : [18, 14, 12, 10, 10, 10],
      headingBelow: compact ? [5, 4, 3, 3, 3, 3] : [7, 5, 4, 4, 4, 4],
      headingBold: true,
      headingColor: [0.122, 0.227, 0.373],
      titleSize: compact ? 18 : 24,
      smallSize: size * 0.95,
      footnoteSize: size * 0.85,
      codeSize: size * 0.85,
      captionSize: size * 0.92,
      displaySkip: compact ? 6 : 9,
      listIndent: size * 1.8,
      itemSep: compact ? 1 : 2,
      linkColor: [0.043, 0.341, 0.816],
      ruleColor: [0.83, 0.85, 0.87],
      codeBackground: [0.957, 0.965, 0.973],
      calloutBackground: [0.933, 0.949, 0.969],
      calloutRule: [0.478, 0.549, 0.647],
      bodySans: true,
      justify: false,
      pageNumbers: "right",
      emergencyStretch: size * 2,
    };
  }
  // article: LaTeX article class, 11pt.
  return {
    name: "article",
    serif,
    sans: bundledSans(),
    mono: bundledFont("LMMono", "Regular"),
    size: 11,
    baselineSkip: 13.6,
    parIndent: 16.5,
    parSkip: { width: 0, stretch: 1 },
    headingSize: [14.4, 12, 11, 11, 11, 11],
    headingAbove: [16.5, 15, 15, 12, 12, 12],
    headingBelow: [10.9, 7, 7, 0, 0, 0],
    headingBold: true,
    titleSize: 17.28,
    smallSize: 10,
    footnoteSize: 9,
    codeSize: 9,
    captionSize: 10,
    displaySkip: 11,
    listIndent: 27.5,
    itemSep: 4.5,
    linkColor: DARK_BLUE,
    ruleColor: [0.13, 0.13, 0.13],
    codeBackground: [0.965, 0.965, 0.953],
    calloutBackground: [0.933, 0.949, 0.969],
    calloutRule: [0.478, 0.549, 0.647],
    bodySans: false,
    justify: true,
    pageNumbers: "center",
    emergencyStretch: 22,
    microtype: { protrusion: true, expansion: true },
  };
}

/** Text-style switches inside a paragraph. */
export interface InlineState {
  bold: boolean;
  italic: boolean;
  mono: boolean;
  sans: boolean;
  size: number;
  color?: Color;
  smallCaps: boolean;
}

const fallbackCache = new Map<string, Font | null>();

/** System-font fallback for characters the chosen face lacks, cached per style. */
export function resolver(state: Pick<InlineState, "bold" | "italic" | "sans">): FontResolver {
  return (cp: number) => {
    const key = `${cp}|${state.bold}|${state.italic}|${state.sans}`;
    let f = fallbackCache.get(key);
    if (f === undefined) {
      f = fallbackFor(cp, { bold: state.bold, italic: state.italic, serif: !state.sans }) ?? null;
      if (f && !f.embeddingAllowed) f = null;
      fallbackCache.set(key, f);
    }
    return f ?? undefined;
  };
}

/** The font stack and TextStyle for a state. Math italic and the other bundled faces back up missing symbols. */
export function textStyle(t: Theme, s: InlineState): TextStyle {
  let primary: Font;
  if (s.mono) primary = t.mono;
  else {
    const fam = s.sans || t.bodySans ? t.sans : t.serif;
    primary = s.bold ? (s.italic ? fam.boldItalic : fam.bold) : s.italic ? fam.italic : fam.regular;
  }
  const stack = [primary, s.bold ? t.serif.bold : t.serif.regular, bundledFont("Main", s.bold ? "Bold" : "Regular"), bundledFont("AMS", "Regular")];
  return {
    fonts: stack,
    size: s.size,
    color: s.color,
    resolve: resolver({ bold: s.bold, italic: s.italic, sans: s.sans || t.bodySans }),
    frenchSpacing: t.bodySans,
  };
}
