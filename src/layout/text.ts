/**
 * Text shaping: a string becomes a horizontal list of Glyphs runs, interword
 * glue and break penalties, ready for the line breaker.
 *
 * - Fonts are tried in stack order (primary first); a resolver callback can
 *   supply a font (system fallback) for code points no font in the stack covers.
 * - Each run holds glyphs of one font; ligatures (GSUB liga) and pair kerning
 *   are folded into the glyph ids and advances.
 * - Spaces become interword glue sized from the font (TeX's fontdimens 2-4,7:
 *   space, space/2 stretch, space/3 shrink, space/3 extra after a sentence)
 *   and scaled by TeX's space factor unless frenchSpacing is set.
 * - A letter with diacritics that the font lacks precomposed is built the way
 *   TeX's \accent primitive builds it (tex.web §1123-§1125): the base glyph,
 *   plus a spacing accent glyph raised by (base height - x-height) and centred
 *   over the base, corrected for slant. Composition keeps text in one font;
 *   only when it is impossible does shaping fall back to another font.
 */

import { type Font, FontError } from "../font/index.js";
import type { Color, Glue, Glyphs, HNode, Kern, Penalty } from "./types.js";
import { INF_PENALTY } from "./types.js";

/** Supplies a font for a code point that no font in the stack covers (e.g. system fallback). */
export type FontResolver = (codePoint: number) => Font | undefined;

export interface TextStyle {
  /** The font stack: primary first, then fallbacks. */
  fonts: Font | readonly Font[];
  /** Font size in points. */
  size: number;
  color?: Color;
  /** Called (once per code point and call) when no font in the stack covers a character. */
  resolve?: FontResolver;
  /** Called for characters no font could draw; they are set as .notdef of the primary font. */
  onMissing?: (codePoint: number) => void;
  /** Uniform interword spaces (TeX's \frenchspacing). Default false: sentence ends get extra space. */
  frenchSpacing?: boolean;
  /** Apply the font's standard ligatures. Default true. */
  ligatures?: boolean;
  /** Apply the font's pair kerning. Default true. */
  kerning?: boolean;
  /** Slant (tan of the slant angle) used to place accents; defaults from the font's italic angle. */
  slant?: number;
  /** Penalty at soft hyphens (TeX's \hyphenpenalty). Default 50. */
  hyphenPenalty?: number;
  /** Penalty after explicit hyphens and dashes (TeX's \exhyphenpenalty). Default 50. */
  exHyphenPenalty?: number;
  /** Code point drawn at soft-hyphen and pattern breaks. Default U+002D. */
  hyphenChar?: number;
  /** Collapse runs of ordinary white space into one interword glue. Default true. */
  collapseSpaces?: boolean;
}

/** Carries TeX's space factor across calls, so a sentence ending in one call widens the space at the start of the next. */
export interface ShapeState {
  spaceFactor: number;
}

/** A Penalty that is a hyphenation point: "explicit" from soft hyphens and dashes, "auto" from patterns. */
export interface Discretionary extends Penalty {
  hyphenation?: "auto" | "explicit";
}

// ----------------------------------------------------------------- metrics

const extentCache = new WeakMap<Font, Map<number, [number, number]>>();

/** [yMax, yMin] of a glyph in font units, cached; a corrupt glyph reads as the font's ascent/descent. */
export function glyphExtent(font: Font, gid: number): [number, number] {
  let m = extentCache.get(font);
  if (!m) {
    m = new Map();
    extentCache.set(font, m);
  }
  let e = m.get(gid);
  if (!e) {
    try {
      const b = font.bounds(gid);
      e = b.xMin === 0 && b.xMax === 0 && b.yMin === 0 && b.yMax === 0 ? [0, 0] : [b.yMax, b.yMin];
    } catch (err) {
      if (!(err instanceof FontError)) throw err;
      e = [font.ascent, font.descent];
    }
    if (m.size > 65536) m.clear();
    m.set(gid, e);
  }
  return e;
}

/** Kerning (points) folded into each glyph's advance, between it and the next glyph; read by hyphenateList. */
const runKerns = new WeakMap<Glyphs, number[]>();

/** Builds a Glyphs node; advances are in points. */
export function makeGlyphs(font: Font, size: number, gids: number[], advances: number[], text: string[], yOffsets?: number[], color?: Color): Glyphs {
  const scale = size / font.unitsPerEm;
  let width = 0;
  let height = 0;
  let depth = 0;
  for (let i = 0; i < gids.length; i++) {
    width += advances[i];
    const [top, bottom] = glyphExtent(font, gids[i]);
    const dy = yOffsets ? yOffsets[i] : 0;
    const h = top * scale + dy;
    const d = -bottom * scale - dy;
    if (h > height) height = h;
    if (d > depth) depth = d;
  }
  const g: Glyphs = { t: "glyphs", font, size, gids, advances, text, width, height, depth };
  if (yOffsets && yOffsets.some((y) => y !== 0)) g.yOffsets = yOffsets;
  if (color) g.color = color;
  return g;
}

/** Interword glue for a font (TeX: space, stretch space/2, shrink space/3, extra space/3 after sentences). */
export function interwordGlue(font: Font, size: number, spaceFactor = 1000, frenchSpacing = false): Glue {
  const gid = font.glyphForCodePoint(0x20);
  const adv = gid ? font.advance(gid) : 0;
  const space = (adv > 0 ? adv / font.unitsPerEm : 1 / 3) * size;
  let width = space;
  let stretch = space / 2;
  let shrink = space / 3;
  if (!frenchSpacing && spaceFactor !== 1000 && spaceFactor > 0) {
    if (spaceFactor >= 2000) width += space / 3;
    stretch = (stretch * spaceFactor) / 1000;
    shrink = (shrink * 1000) / spaceFactor;
  }
  return { t: "glue", width, stretch, stretchOrder: 0, shrink, shrinkOrder: 0 };
}

/** A discretionary break that shows a hyphen when taken; undefined when the font has no hyphen. */
export function hyphenDiscretionary(
  font: Font,
  size: number,
  penalty = 50,
  opts: { hyphenChar?: number; color?: Color; hyphenation?: "auto" | "explicit" } = {},
): Discretionary | undefined {
  const want = opts.hyphenChar ?? 0x2d;
  let gid = font.glyphForCodePoint(want);
  let cp = want;
  if (!gid && want === 0x2d) {
    gid = font.glyphForCodePoint(0x2010);
    cp = 0x2010;
  }
  if (!gid) return undefined;
  const run = makeGlyphs(font, size, [gid], [(font.advance(gid) * size) / font.unitsPerEm], [String.fromCodePoint(cp)], undefined, opts.color);
  return { t: "penalty", penalty, flagged: true, width: run.width, preBreak: [run], hyphenation: opts.hyphenation ?? "explicit" };
}

/** Slant used for accent placement: from the italic angle, else 0.25 (Computer Modern italic) for italic fonts. */
export function fontSlant(font: Font): number {
  if (font.italicAngle) return Math.tan((-font.italicAngle * Math.PI) / 180);
  return font.italic ? 0.25 : 0;
}

// ----------------------------------------------------------- composition

/** Combining mark -> spacing accent characters to build it from (in preference order). */
const ACCENTS: ReadonlyMap<number, { spacing: readonly number[]; below?: boolean }> = new Map([
  [0x0300, { spacing: [0x0060, 0x02cb] }], // grave
  [0x0301, { spacing: [0x00b4, 0x02ca] }], // acute
  [0x0302, { spacing: [0x02c6] }], // circumflex
  [0x0303, { spacing: [0x02dc] }], // tilde
  [0x0304, { spacing: [0x00af, 0x02c9] }], // macron
  [0x0306, { spacing: [0x02d8] }], // breve
  [0x0307, { spacing: [0x02d9] }], // dot above
  [0x0308, { spacing: [0x00a8] }], // diaeresis
  [0x030a, { spacing: [0x02da] }], // ring above
  [0x030b, { spacing: [0x02dd] }], // double acute
  [0x030c, { spacing: [0x02c7] }], // caron
  [0x0327, { spacing: [0x00b8], below: true }], // cedilla
  [0x0328, { spacing: [0x02db], below: true }], // ogonek
]);

type Piece =
  /** A plain glyph: takes part in ligatures and kerning. */
  | { kind: "glyph"; gid: number; text: string }
  /** A built cluster (accented letter, base plus marks): font units, no kerning across it (as TeX's \accent). */
  | { kind: "cluster"; gids: number[]; adv: number[]; yOff: number[]; text: string[] };

function cps(s: string): number[] {
  const out: number[] = [];
  for (const c of s) out.push(c.codePointAt(0)!);
  return out;
}

/** TeX's \accent applied to code points base + marks; undefined when the font lacks a needed glyph. */
function compose(font: Font, d: number[], text: string, slant: number): Piece | undefined {
  const marks = d.slice(1);
  for (const m of marks) if (!ACCENTS.has(m)) return undefined;
  let base = d[0];
  const above = marks.some((m) => !ACCENTS.get(m)!.below);
  if (above && (base === 0x69 || base === 0x6a)) {
    const dotless = base === 0x69 ? 0x131 : 0x237;
    if (font.glyphForCodePoint(dotless)) base = dotless;
  }
  const bg = font.glyphForCodePoint(base);
  if (!bg) return undefined;
  const w = font.advance(bg);
  let h = glyphExtent(font, bg)[0];
  const xh = font.xHeight;
  const snap = 0.03 * font.unitsPerEm; // overshoot of round letters is not height
  const gids = [bg];
  const xs = [0];
  const ys = [0];
  for (const m of marks) {
    const spec = ACCENTS.get(m)!;
    let ag = 0;
    for (const c of spec.spacing) {
      ag = font.glyphForCodePoint(c);
      if (ag) break;
    }
    if (!ag) return undefined;
    const a = font.advance(ag);
    let raise = 0;
    if (!spec.below) {
      raise = h - xh;
      if (Math.abs(raise) <= snap) raise = 0;
    }
    gids.push(ag);
    xs.push((w - a) / 2 + raise * slant);
    ys.push(raise);
    if (!spec.below) h = Math.max(h, glyphExtent(font, ag)[0] + raise);
  }
  const adv = xs.map((x, i) => (i + 1 < xs.length ? xs[i + 1] : w) - x);
  return { kind: "cluster", gids, adv, yOff: ys, text: [text, ...marks.map(() => "")] };
}

/** How a font draws a cluster: precomposed, composed TeX-style, or base plus the font's own mark glyphs. */
function cover(font: Font, cluster: string, slant: number): Piece | undefined {
  // Fast path: one code point the font maps directly (most text) needs no normalization.
  const first = cluster.codePointAt(0)!;
  if (cluster.length === (first > 0xffff ? 2 : 1)) {
    const g = font.glyphForCodePoint(first);
    if (g) return { kind: "glyph", gid: g, text: cluster };
  }
  const nfc = cluster.normalize("NFC");
  const c = cps(nfc);
  if (c.length === 1) {
    const g = font.glyphForCodePoint(c[0]);
    if (g) return { kind: "glyph", gid: g, text: nfc };
  }
  const d = cps(cluster.normalize("NFD"));
  if (d.length > 1) {
    const built = compose(font, d, nfc, slant);
    if (built) return built;
  }
  if (c.length > 1) {
    const gids = c.map((cp) => font.glyphForCodePoint(cp));
    if (gids.every((g) => g !== 0)) {
      return { kind: "cluster", gids, adv: gids.map((g) => font.advance(g)), yOff: gids.map(() => 0), text: [nfc, ...gids.slice(1).map(() => "")] };
    }
  }
  return undefined;
}

// ----------------------------------------------------------------- shaping

const CLUSTER = /\P{M}\p{M}*|\p{M}+/gsu;
const VARIATION = /[︀-️\u{E0100}-\u{E01EF}]/gu;
const COLLAPSIBLE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x0b]);
const DASHES = new Set([0x2d, 0x2010, 0x2013, 0x2014]);
/** Fixed spaces: em fraction (negative: special measure), and whether a break is allowed. */
const FIXED_SPACES: ReadonlyMap<number, { em: number; breakable: boolean }> = new Map([
  [0x1680, { em: -1, breakable: true }],
  [0x2000, { em: 0.5, breakable: true }],
  [0x2001, { em: 1, breakable: true }],
  [0x2002, { em: 0.5, breakable: true }],
  [0x2003, { em: 1, breakable: true }],
  [0x2004, { em: 1 / 3, breakable: true }],
  [0x2005, { em: 1 / 4, breakable: true }],
  [0x2006, { em: 1 / 6, breakable: true }],
  [0x2007, { em: -2, breakable: false }], // figure space: width of a digit
  [0x2008, { em: -3, breakable: true }], // punctuation space: width of a period
  [0x2009, { em: 1 / 6, breakable: true }],
  [0x200a, { em: 1 / 12, breakable: true }],
  [0x202f, { em: 1 / 6, breakable: false }],
  [0x205f, { em: 4 / 18, breakable: true }],
  [0x3000, { em: 1, breakable: true }],
]);
const IGNORED = new Set([0x200d, 0x2060, 0xfeff]);

/** TeX's \sfcode under \nonfrenchspacing (plain.tex), with 0 meaning "leave the space factor alone". */
function sfCode(cp: number): number {
  switch (cp) {
    case 0x2e: // .
    case 0x3f: // ?
    case 0x21: // !
      return 3000;
    case 0x3a: // :
      return 2000;
    case 0x3b: // ;
      return 1500;
    case 0x2c: // ,
      return 1250;
    case 0x29: // )
    case 0x5d: // ]
    case 0x27: // '
    case 0x22: // "
    case 0x2019: // ’
    case 0x201d: // ”
    case 0xbb: // »
    case 0x203a: // ›
      return 0;
    default:
      if (cp < 0x80) return cp >= 0x41 && cp <= 0x5a ? 999 : 1000;
      return /\p{Lu}/u.test(String.fromCodePoint(cp)) ? 999 : 1000;
  }
}

function isSpaceCluster(cp: number): boolean {
  return COLLAPSIBLE.has(cp) || cp === 0xa0 || FIXED_SPACES.has(cp);
}

/**
 * Shapes text into a horizontal list: Glyphs runs, interword Glue, and
 * Penalties at break opportunities (soft hyphens, explicit hyphens and
 * dashes, zero-width spaces; an infinite penalty before a no-break space).
 */
export function shapeText(text: string, style: TextStyle, state: ShapeState = { spaceFactor: 1000 }): HNode[] {
  const stack: Font[] = Array.isArray(style.fonts) ? [...(style.fonts as readonly Font[])] : [style.fonts as Font];
  if (stack.length === 0) throw new Error("shapeText: the font stack is empty");
  const primary = stack[0];
  const size = style.size;
  const french = style.frenchSpacing ?? false;
  const useLiga = style.ligatures ?? true;
  const useKern = style.kerning ?? true;
  const collapse = style.collapseSpaces ?? true;
  const resolved = new Map<number, Font | null>();
  const slants = new Map<Font, number>();
  const slantOf = (f: Font) => {
    let s = slants.get(f);
    if (s === undefined) {
      s = style.slant ?? fontSlant(f);
      slants.set(f, s);
    }
    return s;
  };

  const out: HNode[] = [];
  let run: { font: Font; pieces: Piece[] } | null = null;
  let lastFont = primary;
  let pendingSpace = false;

  const flush = () => {
    if (run && run.pieces.length) out.push(buildRun(run.font, size, run.pieces, useLiga, useKern, style.color));
    run = null;
  };

  const clusters: string[] = [];
  for (const m of text.replace(VARIATION, "").matchAll(CLUSTER)) clusters.push(m[0]);

  for (let k = 0; k < clusters.length; k++) {
    const cluster = clusters[k];
    const cp = cluster.codePointAt(0)!;

    if (COLLAPSIBLE.has(cp)) {
      flush();
      if (!collapse || !pendingSpace) {
        out.push(interwordGlue(lastFont, size, state.spaceFactor, french));
        pendingSpace = true;
      }
      continue;
    }
    pendingSpace = false;

    if (cp === 0xa0) {
      flush();
      out.push({ t: "penalty", penalty: INF_PENALTY }, interwordGlue(lastFont, size, state.spaceFactor, french));
      continue;
    }
    const fixed = FIXED_SPACES.get(cp);
    if (fixed) {
      flush();
      let w = fixed.em * size;
      if (fixed.em === -1) w = interwordGlue(lastFont, size).width;
      else if (fixed.em === -2) w = charWidth(lastFont, 0x30, size, 0.5);
      else if (fixed.em === -3) w = charWidth(lastFont, 0x2e, size, 0.25);
      if (!fixed.breakable) out.push({ t: "penalty", penalty: INF_PENALTY });
      out.push({ t: "glue", width: w, stretch: 0, stretchOrder: 0, shrink: 0, shrinkOrder: 0 });
      continue;
    }
    if (cp === 0x200b) {
      flush();
      out.push({ t: "penalty", penalty: 0 });
      continue;
    }
    if (cp === 0x200c) {
      flush(); // zero-width non-joiner: no ligature or kerning across it
      continue;
    }
    if (cp === 0xad) {
      flush();
      const prev = out[out.length - 1];
      const next = clusters[k + 1];
      if (prev && prev.t === "glyphs" && next !== undefined && !isSpaceCluster(next.codePointAt(0)!)) {
        const disc = hyphenDiscretionary(prev.font, size, style.hyphenPenalty ?? 50, { hyphenChar: style.hyphenChar, color: style.color });
        if (disc) out.push(disc);
      }
      continue;
    }
    if (IGNORED.has(cp) || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;

    // A visible character: find the first font that can draw it.
    let font: Font | undefined;
    let piece: Piece | undefined;
    for (const f of stack) {
      piece = cover(f, cluster, slantOf(f));
      if (piece) {
        font = f;
        break;
      }
    }
    if (!piece && style.resolve) {
      let f = resolved.get(cp);
      if (f === undefined) {
        f = style.resolve(cp) ?? null;
        resolved.set(cp, f);
      }
      if (f) {
        piece = cover(f, cluster, slantOf(f));
        if (piece) {
          font = f;
          if (!stack.includes(f)) stack.push(f);
        }
      }
    }
    if (!piece || !font) {
      style.onMissing?.(cp);
      font = primary;
      piece = { kind: "glyph", gid: 0, text: cluster.normalize("NFC") };
    }
    if (run && run.font !== font) flush();
    if (!run) run = { font, pieces: [] };
    run.pieces.push(piece);
    lastFont = font;

    const sf = sfCode(cp);
    if (sf !== 0) state.spaceFactor = sf > 1000 && state.spaceFactor < 1000 ? 1000 : sf;

    // A break is allowed after a hyphen or dash inside a word.
    if (DASHES.has(cp) && k > 0 && k + 1 < clusters.length) {
      const before = clusters[k - 1].codePointAt(0)!;
      const after = clusters[k + 1].codePointAt(0)!;
      if (!isSpaceCluster(before) && !isSpaceCluster(after) && !DASHES.has(after) && after !== 0xad) {
        flush();
        const p: Discretionary = { t: "penalty", penalty: style.exHyphenPenalty ?? 50, flagged: true, hyphenation: "explicit" };
        out.push(p);
      }
    }
  }
  flush();
  return out;
}

function charWidth(font: Font, cp: number, size: number, fallbackEm: number): number {
  const g = font.glyphForCodePoint(cp);
  return g ? (font.advance(g) * size) / font.unitsPerEm : fallbackEm * size;
}

/** Turns a run's pieces into one Glyphs node: ligatures and kerning across plain glyphs, built clusters as they are. */
function buildRun(font: Font, size: number, pieces: Piece[], useLiga: boolean, useKern: boolean, color?: Color): Glyphs {
  const scale = size / font.unitsPerEm;
  const gids: number[] = [];
  const adv: number[] = [];
  const yOff: number[] = [];
  const text: string[] = [];
  const kerns: number[] = [];
  let i = 0;
  while (i < pieces.length) {
    const p = pieces[i];
    if (p.kind === "cluster") {
      for (let j = 0; j < p.gids.length; j++) {
        gids.push(p.gids[j]);
        adv.push(p.adv[j]);
        yOff.push(p.yOff[j]);
        text.push(p.text[j]);
        kerns.push(0);
      }
      i++;
      continue;
    }
    let j = i;
    while (j < pieces.length && pieces[j].kind === "glyph") j++;
    const seq = pieces.slice(i, j) as Extract<Piece, { kind: "glyph" }>[];
    let g = seq.map((s) => s.gid);
    let t = seq.map((s) => s.text);
    if (useLiga && g.length > 1 && !g.includes(0)) {
      const lr = font.ligatureClusters(g);
      if (lr.glyphs.length !== g.length) {
        const merged: string[] = [];
        let at = 0;
        for (const n of lr.counts) {
          merged.push(t.slice(at, at + n).join(""));
          at += n;
        }
        g = lr.glyphs;
        t = merged;
      }
    }
    for (let k = 0; k < g.length; k++) {
      gids.push(g[k]);
      adv.push(font.advance(g[k]));
      yOff.push(0);
      text.push(t[k]);
      kerns.push(0);
      if (useKern && k > 0) {
        const kv = font.kerning(g[k - 1], g[k]);
        if (kv) {
          adv[adv.length - 2] += kv;
          kerns[kerns.length - 2] = kv * scale;
        }
      }
    }
    i = j;
  }
  const offsets = yOff.map((y) => y * scale);
  const node = makeGlyphs(font, size, gids, adv.map((a) => a * scale), text, offsets, color);
  // Runs holding a built cluster always carry yOffsets, even when every accent sits at offset 0.
  if (!node.yOffsets && pieces.some((p) => p.kind === "cluster")) node.yOffsets = offsets;
  runKerns.set(node, kerns);
  return node;
}

// ------------------------------------------------------------- hyphenation

export interface HyphenateListOptions {
  /** Penalty at pattern hyphenation points (TeX's \hyphenpenalty). Default 50. */
  hyphenPenalty?: number;
  hyphenChar?: number;
  /** TeX's \lefthyphenmin and \righthyphenmin. Defaults 2 and 3. */
  leftMin?: number;
  rightMin?: number;
}

const LETTER = /^[\p{L}\p{M}]+$/u;

/** Whether a node next to a run means the word continues across the run boundary. */
function joins(n: HNode | undefined): boolean {
  return !!n && (n.t === "glyphs" || (n.t === "penalty" && !!n.flagged));
}

/**
 * Inserts discretionary hyphens (marked hyphenation: "auto") into the words
 * of a shaped list, at the positions the callback returns (the number of
 * characters before each break). A word is a run of letters inside one Glyphs
 * node; words that continue into a neighbouring run, and break points inside
 * a ligature, are skipped. The kern between the two glyphs at a break moves
 * into a Kern node after the discretionary, so it vanishes when the line
 * breaks there (TeX's discretionary reconstitution, simplified).
 */
export function hyphenateList(list: readonly HNode[], hyphenate: (word: string) => readonly number[], opts: HyphenateListOptions = {}): HNode[] {
  const leftMin = opts.leftMin ?? 2;
  const rightMin = opts.rightMin ?? 3;
  const out: HNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.t !== "glyphs" || n.gids.length < leftMin + rightMin) {
      out.push(n);
      continue;
    }
    const cuts = cutPoints(n, hyphenate, leftMin, rightMin, joins(list[i - 1]), joins(list[i + 1]));
    if (!cuts.length) {
      out.push(n);
      continue;
    }
    const disc = hyphenDiscretionary(n.font, n.size, opts.hyphenPenalty ?? 50, { hyphenChar: opts.hyphenChar, color: n.color, hyphenation: "auto" });
    if (!disc) {
      out.push(n);
      continue;
    }
    const kerns = runKerns.get(n);
    const scale = n.size / n.font.unitsPerEm;
    let from = 0;
    for (const at of [...cuts, n.gids.length]) {
      const adv = n.advances.slice(from, at);
      let kern = 0;
      if (at < n.gids.length) {
        kern = kerns ? kerns[at - 1] : n.font.kerning(n.gids[at - 1], n.gids[at]) * scale;
        adv[adv.length - 1] -= kern;
      }
      out.push(makeGlyphs(n.font, n.size, n.gids.slice(from, at), adv, n.text.slice(from, at), n.yOffsets?.slice(from, at), n.color));
      if (at < n.gids.length) {
        out.push({ ...disc });
        if (kern) out.push({ t: "kern", width: kern } satisfies Kern);
      }
      from = at;
    }
  }
  return out;
}

/** Glyph indices before which a run may be hyphenated. */
function cutPoints(
  n: Glyphs,
  hyphenate: (word: string) => readonly number[],
  leftMin: number,
  rightMin: number,
  joinedBefore: boolean,
  joinedAfter: boolean,
): number[] {
  const cuts: number[] = [];
  const g = n.gids.length;
  let i = 0;
  while (i < g) {
    if (!n.text[i] || !LETTER.test(n.text[i])) {
      i++;
      continue;
    }
    // A word: glyphs with letter text, plus empty-text glyphs (placed accents) inside it.
    let j = i;
    while (j < g && (n.text[j] === "" || LETTER.test(n.text[j]))) j++;
    const touchesStart = i === 0;
    const touchesEnd = j === g;
    if (!(touchesStart && joinedBefore) && !(touchesEnd && joinedAfter)) {
      // Character offset of each glyph within the word.
      const starts = new Map<number, number>();
      let word = "";
      let count = 0;
      for (let k = i; k < j; k++) {
        if (n.text[k] !== "" && !starts.has(count)) starts.set(count, k);
        word += n.text[k];
        count += [...n.text[k]].length;
      }
      if (count >= leftMin + rightMin) {
        for (const p of hyphenate(word)) {
          if (p < leftMin || count - p < rightMin) continue;
          const at = starts.get(p);
          if (at !== undefined && at > i) cuts.push(at);
        }
      }
    }
    i = j;
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}
