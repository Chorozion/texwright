/**
 * Font dimensions and glyph metrics.
 *
 * The bundled fonts carry no TeX metric data (no TFM, no OpenType MATH
 * table), so the Appendix G parameters come from Computer Modern itself:
 * the sigma parameters of cmsy10 (font family 2) and the xi parameters of
 * cmex10 (family 3), in em units. They are used at every math size, scaled
 * by the size of the current style.
 *
 * Glyph heights and depths are read from the glyph outlines' bounding boxes.
 * Italic corrections, which TeX keeps in the TFM file, are derived from how
 * far the ink sticks out past the advance width; the accent skew of slanted
 * letters is derived from the slant and the glyph height.
 */

import { type Fam, SLANTED, famFont } from "./symbols.js";

/** cmsy10 font dimensions (sigma 5..22), em. */
export const SIGMA = {
  xHeight: 0.430555, // sigma5
  quad: 1.0, // sigma6
  num1: 0.676508, // sigma8
  num2: 0.393732, // sigma9
  num3: 0.443731, // sigma10
  denom1: 0.685951, // sigma11
  denom2: 0.344841, // sigma12
  sup1: 0.412892, // sigma13
  sup2: 0.362892, // sigma14
  sup3: 0.288889, // sigma15
  sub1: 0.15, // sigma16
  sub2: 0.247217, // sigma17
  supDrop: 0.386108, // sigma18
  subDrop: 0.05, // sigma19
  delim1: 2.39, // sigma20
  delim2: 1.01, // sigma21
  axisHeight: 0.25, // sigma22
} as const;

/** cmex10 font dimensions (xi 8..13), em. */
export const XI = {
  ruleThickness: 0.04, // xi8
  bigOpSpacing1: 0.111112, // xi9
  bigOpSpacing2: 0.166667, // xi10
  bigOpSpacing3: 0.2, // xi11
  bigOpSpacing4: 0.6, // xi12
  bigOpSpacing5: 0.1, // xi13
} as const;

/** Plain TeX / LaTeX dimensions, as fractions of the 10pt body size (em of \normalsize). */
export const PLAIN = {
  scriptSpace: 0.05, // \scriptspace 0.5pt
  nullDelimiterSpace: 0.12, // \nulldelimiterspace 1.2pt
  delimiterShortfall: 0.5, // \delimitershortfall 5pt
  delimiterFactor: 0.901, // \delimiterfactor 901
  baselineSkip: 1.2, // \baselineskip 12pt
  lineSkip: 0.1, // \lineskip 1pt
  lineSkipLimit: 0, // \lineskiplimit 0pt
  jot: 0.3, // \jot 3pt
  arrayColSep: 0.5, // \arraycolsep 5pt
  arrayRuleWidth: 0.04, // \arrayrulewidth 0.4pt
  doubleRuleSep: 0.2, // \doublerulesep 2pt
  strutHeight: 0.84, // 0.7 \baselineskip
  strutDepth: 0.36, // 0.3 \baselineskip
  fboxSep: 0.3, // \fboxsep 3pt
  fboxRule: 0.04, // \fboxrule 0.4pt
  minAlignSep: 1.0, // \minalignsep 10pt
  multlineGap: 1.0, // \multlinegap 10pt
  multlineTagGap: 1.0, // \multlinetaggap 10pt
  interwordSpace: 0.333333, // cmr10 space
  interwordStretch: 0.166666,
  interwordShrink: 0.111111,
} as const;

/** Slant of the italic faces (tan of the slant angle, as in cmmi10 and cmti10). */
const SLANT = 0.25;
/** Added to the ink overhang of a slanted glyph to approximate TeX's italic correction. */
const ITALIC_PAD = 0.03;

export interface GlyphMetrics {
  gid: number;
  /** Advance width, em. */
  width: number;
  /** Ink height above and depth below the baseline, em (never negative). */
  height: number;
  depth: number;
  /** Italic correction, em. */
  italic: number;
  /** Ink box, em. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Horizontal offset for accents over this glyph, em. */
  skew: number;
}

const famIndex = new Map<Fam, number>();
const cache = new Map<number, GlyphMetrics | null>();

/** Metrics of one glyph in em, or null when the face has no glyph for the code point. */
export function glyphMetrics(fam: Fam, cp: number): GlyphMetrics | null {
  let fi = famIndex.get(fam);
  if (fi === undefined) {
    fi = famIndex.size + 1;
    famIndex.set(fam, fi);
  }
  const key = fi * 0x200000 + cp;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const font = famFont(fam);
  const gid = font.glyphForCodePoint(cp);
  if (gid === 0) {
    cache.set(key, null);
    return null;
  }
  const upm = font.unitsPerEm;
  const b = font.bounds(gid);
  const width = font.advance(gid) / upm;
  const empty = b.xMin === 0 && b.xMax === 0 && b.yMin === 0 && b.yMax === 0;
  const xMin = b.xMin / upm;
  const xMax = empty ? width : b.xMax / upm;
  const yMin = b.yMin / upm;
  const yMax = b.yMax / upm;
  const height = Math.max(0, yMax);
  const depth = Math.max(0, -yMin);
  const overhang = xMax - width;
  const slanted = SLANTED.has(fam);
  let italic = 0;
  // Slanted letters and the large integral signs lean past their advance;
  // TeX's italic correction is the overhang plus a little air.
  if (overhang > 0.005 && width > 0) italic = overhang + (slanted || fam.startsWith("size") ? ITALIC_PAD : 0);
  const skew = slanted ? (SLANT * height) / 2 : 0;
  const m: GlyphMetrics = { gid, width, height, depth, italic, xMin, xMax, yMin, yMax, skew };
  cache.set(key, m);
  return m;
}

/** Metrics of the .notdef glyph of a face (for characters no face can draw). */
export function notdefMetrics(fam: Fam): GlyphMetrics {
  const font = famFont(fam);
  const upm = font.unitsPerEm;
  const b = font.bounds(0);
  const width = font.advance(0) / upm;
  return {
    gid: 0,
    width,
    height: Math.max(0, b.yMax / upm),
    depth: Math.max(0, -b.yMin / upm),
    italic: 0,
    xMin: b.xMin / upm,
    xMax: b.xMax / upm,
    yMin: b.yMin / upm,
    yMax: b.yMax / upm,
    skew: 0,
  };
}
