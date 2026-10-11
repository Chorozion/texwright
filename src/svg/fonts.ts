/**
 * Fonts for SVG text: mapping CSS font-family lists to the bundled Computer
 * Modern faces or installed system fonts, per-character fallback, and
 * shaping (ligatures, kerning, letter and word spacing).
 *
 * A named family (Georgia, Arial Black, Verdana, ...) uses that installed
 * font when there is one, as a browser would. Generic serif and the TeX
 * faces (serif, Computer Modern, Latin Modern, ...) map to the bundled
 * KaTeX_Main faces, so such figures match the document's text face on every
 * machine, and so does a serif family that is not installed. Sans-serif and
 * monospace names fall back to an installed sans or monospace font, then
 * to the bundled KaTeX_SansSerif / KaTeX_Typewriter faces. Only embeddable
 * TrueType-outline fonts are used, since the PDF writer subsets TrueType.
 */

import {
  type BundledFamily,
  type BundledStyle,
  BUNDLED_STYLES,
  bundledFont,
  fallbackFor,
  type Font,
  findSystemFont,
} from "../font/index.js";
import { familyList } from "./style.js";

export interface Face {
  font: Font;
  /** A bundled KaTeX face (deterministic everywhere). */
  bundled: boolean;
  bundledFamily?: BundledFamily;
  serif: boolean;
  bold: boolean;
  italic: boolean;
}

const SERIF_NAMES = new Set([
  "serif",
  "ui-serif",
  "math",
  "cursive",
  "fantasy",
  "georgia",
  "times",
  "times new roman",
  "times-roman",
  "timesnewroman",
  "tinos",
  "liberation serif",
  "dejavu serif",
  "noto serif",
  "free serif",
  "freeserif",
  "nimbus roman",
  "nimbus roman no9 l",
  "cambria",
  "constantia",
  "palatino",
  "palatino linotype",
  "book antiqua",
  "garamond",
  "eb garamond",
  "baskerville",
  "charter",
  "bitstream charter",
  "new york",
  "stix",
  "stix two text",
  "stixgeneral",
  "computer modern",
  "computer modern serif",
  "cmu serif",
  "latin modern",
  "latin modern roman",
  "lmroman10",
  "cmr10",
  "katex_main",
  "minion pro",
  "century schoolbook",
  "bookman",
  "didot",
  "bodoni",
  "hoefler text",
]);

const SANS_HINTS = /\b(sans|arial|helvetica|verdana|tahoma|segoe|calibri|trebuchet|roboto|inter|lato|futura|avenir|franklin|gill|system-ui|ui-sans-serif|-apple-system|blinkmacsystemfont|lucida grande)\b/;
const MONO_HINTS = /\b(mono|monospace|ui-monospace|courier|consolas|console|code|typewriter|menlo|monaco|fixed|fixedsys)\b/;

const SYSTEM_SANS = ["Arial", "Helvetica", "Liberation Sans", "Arimo", "DejaVu Sans", "Noto Sans", "FreeSans", "Segoe UI"];
const SYSTEM_MONO = ["Consolas", "Courier New", "Menlo", "DejaVu Sans Mono", "Liberation Mono", "Cousine", "Noto Sans Mono", "FreeMono"];

const KATEX_FAMILIES: Record<string, BundledFamily> = {
  katex_main: "Main",
  katex_math: "Math",
  katex_ams: "AMS",
  katex_caligraphic: "Caligraphic",
  katex_fraktur: "Fraktur",
  katex_sansserif: "SansSerif",
  katex_script: "Script",
  katex_typewriter: "Typewriter",
  katex_size1: "Size1",
  katex_size2: "Size2",
  katex_size3: "Size3",
  katex_size4: "Size4",
};

/** Serif names that mean the document's own face rather than an installed font. */
const BUNDLED_SERIF = new Set([
  "serif",
  "ui-serif",
  "math",
  "cursive",
  "fantasy",
  "computer modern",
  "computer modern serif",
  "cmu serif",
  "latin modern",
  "latin modern roman",
  "lmroman10",
  "cmr10",
  "katex_main",
]);

function classify(name: string): "serif" | "sans" | "mono" | "other" {
  const n = name.toLowerCase();
  if (SERIF_NAMES.has(n)) return "serif";
  if (MONO_HINTS.test(n)) return "mono";
  if (SANS_HINTS.test(n)) return "sans";
  if (n.includes("serif")) return "serif";
  return "other";
}

/** The closest shipped style of a bundled family. */
function bundledStyle(family: BundledFamily, bold: boolean, italic: boolean): BundledStyle {
  const have = BUNDLED_STYLES[family];
  const want: BundledStyle = bold && italic ? "BoldItalic" : bold ? "Bold" : italic ? "Italic" : "Regular";
  if (have.includes(want)) return want;
  const order: BundledStyle[] =
    want === "BoldItalic" ? ["Bold", "Italic", "Regular"] : want === "Bold" ? ["BoldItalic", "Regular"] : want === "Italic" ? ["BoldItalic", "Regular"] : ["Italic", "Bold"];
  for (const s of order) if (have.includes(s)) return s;
  return have[0];
}

function bundledFace(family: BundledFamily, bold: boolean, italic: boolean): Face {
  const style = bundledStyle(family, bold, italic);
  return {
    font: bundledFont(family, style),
    bundled: true,
    bundledFamily: family,
    serif: family !== "SansSerif" && family !== "Typewriter",
    bold: style.startsWith("Bold"),
    italic: style.endsWith("Italic"),
  };
}

/** A usable installed font: embeddable, TrueType outlines (the PDF writer subsets TrueType). */
function usable(f: Font | undefined): f is Font {
  return !!f && f.embeddingAllowed && f.outlines === "truetype";
}

function systemFace(name: string, bold: boolean, italic: boolean): Face | undefined {
  let f: Font | undefined;
  try {
    f = findSystemFont(name, { bold, italic });
  } catch {
    return undefined;
  }
  if (!usable(f)) return undefined;
  return { font: f, bundled: false, serif: f.serif ?? false, bold: f.bold, italic: f.italic };
}

const faceCache = new Map<string, Face>();

/** The primary face for a CSS font-family list and style. Never throws for system font trouble. */
export function resolveFace(family: string, bold: boolean, italic: boolean): Face {
  const key = `${family}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`;
  let face = faceCache.get(key);
  if (face) return face;
  face = resolveUncached(family, bold, italic);
  if (faceCache.size > 1000) faceCache.clear();
  faceCache.set(key, face);
  return face;
}

function resolveUncached(family: string, bold: boolean, italic: boolean): Face {
  let leaning: "serif" | "sans" | "mono" | undefined;
  for (const name of familyList(family).slice(0, 32)) {
    const lower = name.toLowerCase();
    const katex = KATEX_FAMILIES[lower];
    if (katex && Object.prototype.hasOwnProperty.call(KATEX_FAMILIES, lower)) return bundledFace(katex, bold, italic);
    const kind = classify(name);
    if (BUNDLED_SERIF.has(lower)) return bundledFace("Main", bold, italic);
    if (kind === "serif") return systemFace(name, bold, italic) ?? bundledFace("Main", bold, italic);
    if (lower === "sans-serif" || lower === "system-ui" || lower === "ui-sans-serif") return genericSans(bold, italic);
    if (lower === "monospace" || lower === "ui-monospace") return genericMono(bold, italic);
    const sys = systemFace(name, bold, italic);
    if (sys) return sys;
    if (!leaning && kind !== "other") leaning = kind;
  }
  if (leaning === "sans") return genericSans(bold, italic);
  if (leaning === "mono") return genericMono(bold, italic);
  return bundledFace("Main", bold, italic);
}

function genericSans(bold: boolean, italic: boolean): Face {
  for (const n of SYSTEM_SANS) {
    const f = systemFace(n, bold, italic);
    if (f) return f;
  }
  return bundledFace("SansSerif", bold, italic);
}

function genericMono(bold: boolean, italic: boolean): Face {
  for (const n of SYSTEM_MONO) {
    const f = systemFace(n, bold, italic);
    if (f) return f;
  }
  return bundledFace("Typewriter", bold, italic);
}

/** Look-alike code points tried when a font lacks a character. */
const SUBSTITUTES: Record<number, number[]> = {
  0x00b7: [0x22c5, 0x2219], // middle dot
  0x2022: [0x2219, 0x22c5], // bullet
  0x2010: [0x2d],
  0x2011: [0x2d],
  0x2012: [0x2013],
  0x2015: [0x2014],
  0x2212: [0x2d],
  0x00a0: [0x20],
  0x2002: [0x20],
  0x2003: [0x20],
  0x2004: [0x20],
  0x2005: [0x20],
  0x2006: [0x20],
  0x2007: [0x20],
  0x2008: [0x20],
  0x2009: [0x20],
  0x200a: [0x20],
  0x202f: [0x20],
  0x2024: [0x2e],
  0x2027: [0x22c5],
  0x02bc: [0x2019],
};

function glyphIn(font: Font, cp: number): number {
  const g = font.glyphForCodePoint(cp);
  if (g) return g;
  const subs = SUBSTITUTES[cp];
  if (subs) {
    for (const s of subs) {
      const h = font.glyphForCodePoint(s);
      if (h) return h;
    }
  }
  return 0;
}

const BUNDLED_FALLBACKS: [BundledFamily, BundledStyle][] = [
  ["Main", "Regular"],
  ["Main", "Italic"],
  ["Main", "Bold"],
  ["Math", "Italic"],
  ["AMS", "Regular"],
  ["Size1", "Regular"],
];

export interface GlyphChoice {
  font: Font;
  gid: number;
  /** True when no font had the character (gid is .notdef of the primary). */
  missing: boolean;
}

const glyphCache = new Map<string, GlyphChoice>();

/** A font and glyph for a character: the primary face, then look-alikes, other bundled faces, then installed fonts. */
export function glyphFor(face: Face, cp: number): GlyphChoice {
  const g = glyphIn(face.font, cp);
  if (g) return { font: face.font, gid: g, missing: false };
  const key = `${face.font.postscriptName}\u0000${face.font.collectionIndex}\u0000${cp}`;
  let c = glyphCache.get(key);
  if (c) return c;
  c = fallbackGlyph(face, cp);
  if (glyphCache.size > 20000) glyphCache.clear();
  glyphCache.set(key, c);
  return c;
}

function fallbackGlyph(face: Face, cp: number): GlyphChoice {
  const bundledChain = (): GlyphChoice | undefined => {
    if (face.bundledFamily) {
      for (const st of BUNDLED_STYLES[face.bundledFamily]) {
        const f = bundledFont(face.bundledFamily, st);
        const g = glyphIn(f, cp);
        if (g) return { font: f, gid: g, missing: false };
      }
    }
    // Prefer the closest style of the Main family first.
    const first = bundledFont("Main", bundledStyle("Main", face.bold, face.italic));
    const g0 = glyphIn(first, cp);
    if (g0) return { font: first, gid: g0, missing: false };
    for (const [fam, st] of BUNDLED_FALLBACKS) {
      const f = bundledFont(fam, st);
      const g = glyphIn(f, cp);
      if (g) return { font: f, gid: g, missing: false };
    }
    return undefined;
  };
  const systemChain = (): GlyphChoice | undefined => {
    let f: Font | undefined;
    try {
      f = fallbackFor(cp, { bold: face.bold, italic: face.italic, serif: face.serif });
    } catch {
      return undefined;
    }
    if (!usable(f)) return undefined;
    const g = f.glyphForCodePoint(cp);
    return g ? { font: f, gid: g, missing: false } : undefined;
  };
  const found = face.bundled ? (bundledChain() ?? systemChain()) : (systemChain() ?? bundledChain());
  return found ?? { font: face.font, gid: 0, missing: true };
}

/** Characters that take no glyph and no space (controls, zero-width marks, BOM). */
export function isInvisible(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff || cp === 0xad;
}

export interface Shaped {
  gids: number[];
  /** Advance per glyph in user units (kerning, letter and word spacing included). */
  advances: number[];
  /** Text per glyph; a ligature carries all its characters. */
  text: string[];
  width: number;
}

/**
 * Shapes a run of characters in one font: standard ligatures (unless
 * letter-spacing is set), pair kerning, letter-spacing after every glyph and
 * word-spacing after spaces. Sizes in user units.
 */
export function shapeRun(font: Font, size: number, gids: number[], chars: string[], letterSpacing: number, wordSpacing: number): Shaped {
  let outGids = gids;
  let text = chars;
  if (letterSpacing === 0 && gids.length > 1) {
    const lig = font.ligatureClusters(gids);
    if (lig.glyphs.length !== gids.length) {
      outGids = lig.glyphs;
      text = [];
      let k = 0;
      for (const n of lig.counts) {
        text.push(chars.slice(k, k + n).join(""));
        k += n;
      }
    }
  }
  const scale = size / font.unitsPerEm;
  const advances: number[] = new Array(outGids.length);
  let width = 0;
  for (let i = 0; i < outGids.length; i++) {
    let a = font.advance(outGids[i]) * scale;
    if (i + 1 < outGids.length) a += font.kerning(outGids[i], outGids[i + 1]) * scale;
    a += letterSpacing;
    if (wordSpacing && (text[i] === " " || text[i] === " ")) a += wordSpacing;
    advances[i] = a;
    width += a;
  }
  return { gids: outGids, advances, text, width };
}
