/**
 * The Font object: metadata, character mapping, metrics, outlines,
 * kerning, ligatures, glyph names and subsetting over one TrueType/OpenType
 * font.
 *
 * Opening a font reads the table directory and the small fixed tables
 * (head, hhea, maxp, OS/2, post header, name records, cmap header). Glyph
 * outlines, layout tables and glyph names are read on first use, so even a
 * 20 MB CJK collection opens in well under a millisecond of parsing.
 */

import type { PathCommand } from "../layout/types.js";
import { type CffOutlines, parseCff } from "./cff.js";
import { type Cmap, parseCmap } from "./cmap.js";
import { FontError } from "./errors.js";
import { GlyfTable } from "./glyf.js";
import { GposKerning, GsubLigatures, KernTable, type LigatureResult } from "./layout.js";
import { GlyphNames } from "./post.js";
import { Reader } from "./reader.js";
import { FLAVOR_OTTO, buildSfnt, readDirectory, type SfntDirectory, type TableData } from "./sfnt.js";
import { subsetOpenTypeCff, subsetTrueType } from "./subset.js";
import { isWebFont, webFontToSfnt } from "./webfont.js";
import {
  fontNames,
  fsTypeAllowsEmbedding,
  type Head,
  type Hhea,
  NameTable,
  type Os2,
  type PostHeader,
  parseHead,
  parseHhea,
  parseMaxpNumGlyphs,
  parseOs2,
  parsePostHeader,
  styleFlags,
} from "./tables.js";

/** A box in font units. */
export interface Bounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface Font {
  readonly postscriptName: string;
  readonly familyName: string;
  readonly subfamilyName: string;
  readonly fullName: string;
  readonly unitsPerEm: number;
  /** hhea metrics; descent is negative. */
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  /** OS/2 values, estimated from the 'H' and 'x' glyphs when missing. */
  readonly capHeight: number;
  readonly xHeight: number;
  readonly italicAngle: number;
  readonly isFixedPitch: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly bbox: Bounds;
  readonly glyphCount: number;
  readonly outlines: "truetype" | "cff";
  /** False when OS/2.fsType forbids embedding (restricted licence or bitmap-only). */
  readonly embeddingAllowed: boolean;
  /**
   * Glyph id for a code point, 0 (.notdef) when unmapped. For a symbol font
   * ((3,0) cmap) a code below U+0100 also tries U+F000 + code, as Windows does.
   */
  glyphForCodePoint(cp: number): number;
  /** Mapped code points in increasing order, each once. */
  codePoints(): Iterable<number>;
  /** Advance width in font units (hmtx); 0 for an invalid glyph id. */
  advance(gid: number): number;
  /**
   * Ink box in font units: the glyf header box for TrueType, the exact
   * outline box from the charstring for CFF; a zero box for empty glyphs and
   * invalid ids. Throws FontError when the glyph's data is corrupt.
   */
  bounds(gid: number): Bounds;
  /**
   * The glyph's outline in font units, y up: M, L, C and Z commands, every
   * contour closed. TrueType quadratics become the exact equivalent cubics
   * and composite glyphs are assembled. Empty for an empty glyph, an invalid
   * id and a CFF font with Type 1 charstrings. Throws FontError when the
   * glyph's data is corrupt.
   */
  outline(gid: number): PathCommand[];
  /**
   * Horizontal pair adjustment in font units (negative pulls the pair
   * together): GPOS 'kern' lookups when the font has them, else the legacy
   * kern table. Never throws; a corrupt table reads as no kerning.
   */
  kerning(left: number, right: number): number;
  /** Standard ligatures (GSUB 'liga') applied to a run; identity when the font has none. */
  ligatures(gids: number[]): number[];
  /** Glyph name from post format 1.0/2.0/2.5; undefined otherwise (post 3.0 and CFF fonts). */
  glyphName(gid: number): string | undefined;
  /** Glyph id for a post table name, or 0. */
  glyphForName(name: string): number;
  /**
   * A font keeping .notdef, `gids` and (TrueType) every composite component,
   * with the original glyph ids (Identity CIDs): TrueType for glyf fonts,
   * OpenType with a subset CFF table for CFF fonts. Throws FontError for CFF2
   * fonts and for glyph ids out of range.
   */
  subset(gids: Iterable<number>): Uint8Array;
  /** The font's own file bytes; for a collection member, a standalone font. Do not modify. */
  readonly bytes: Uint8Array;

  // Extras beyond the core contract.

  /** OS/2 usWeightClass (400 when there is no OS/2 table). */
  readonly weight: number;
  /** False when OS/2.fsType sets the no-subsetting bit. */
  readonly subsettingAllowed: boolean;
  /** True when the character map is a Windows Symbol (3,0) subtable. */
  readonly symbolic: boolean;
  /** Index of this font in its collection (0 for single fonts). */
  readonly collectionIndex: number;
  /** post underline metrics and OS/2 strikeout metrics, font units. */
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly strikeoutSize: number;
  /** PANOSE serif classification: true serif, false sans, undefined unknown. */
  readonly serif: boolean | undefined;
  /** Problems in optional tables that were ignored (for example a corrupt GPOS). */
  readonly warnings: readonly string[];
  /** Ligatures plus, for each output glyph, how many input glyphs it replaced. */
  ligatureClusters(gids: readonly number[]): LigatureResult;
  /** Raw bytes of a table, or undefined when absent. */
  table(tag: string): Uint8Array | undefined;
}

const KERN_CACHE_LIMIT = 16384;

class SfntFont implements Font {
  readonly postscriptName: string;
  readonly familyName: string;
  readonly subfamilyName: string;
  readonly fullName: string;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly italicAngle: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly bbox: Bounds;
  readonly glyphCount: number;
  readonly outlines: "truetype" | "cff";
  readonly embeddingAllowed: boolean;
  readonly subsettingAllowed: boolean;
  readonly weight: number;
  readonly symbolic: boolean;
  readonly collectionIndex: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly strikeoutSize: number;
  readonly serif: boolean | undefined;
  readonly warnings: string[] = [];

  /** @internal */ readonly file: Reader;
  /** @internal */ readonly dir: SfntDirectory;
  /** @internal */ readonly head: Head;
  /** @internal */ readonly hhea: Hhea;
  /** @internal */ readonly os2: Os2 | undefined;
  /** @internal */ readonly post: PostHeader | undefined;
  /** @internal */ readonly numberOfHMetrics: number;
  private readonly hmtx: Reader;
  private readonly cmap: Cmap | undefined;
  private readonly isCollection: boolean;
  private glyfTable?: GlyfTable;
  private cff?: CffOutlines | null;
  private cffBoxes = new Map<number, Bounds>();
  private names?: GlyphNames | null;
  private kernSource?: GposKerning | KernTable | null;
  private kernCache = new Map<number, number>();
  private liga?: GsubLigatures | null;
  private ownBytes?: Uint8Array;
  private capHeightValue?: number;
  private fixedPitchValue?: boolean;
  private xHeightValue?: number;

  constructor(bytes: Uint8Array, collectionIndex: number) {
    this.file = new Reader(bytes, "font");
    this.dir = readDirectory(this.file, collectionIndex);
    this.collectionIndex = collectionIndex;
    this.isCollection = this.file.u32(0) === 0x74746366;

    this.head = parseHead(this.required("head"));
    this.glyphCount = parseMaxpNumGlyphs(this.required("maxp"));
    this.hhea = parseHhea(this.required("hhea"));
    this.hmtx = this.required("hmtx");
    let nhm = this.hhea.numberOfHMetrics;
    if (nhm < 1) this.hmtx.fail("hhea.numberOfHMetrics is 0");
    nhm = Math.min(nhm, this.glyphCount);
    if (this.hmtx.length < 4 * nhm) this.hmtx.fail(`hmtx is ${this.hmtx.length} bytes but must hold ${nhm} metrics`);
    this.numberOfHMetrics = nhm;

    const hasGlyf = this.dir.tables.has("glyf") && this.dir.tables.has("loca");
    const hasCff = this.dir.tables.has("CFF ") || this.dir.tables.has("CFF2");
    if (hasCff && (this.dir.flavor === FLAVOR_OTTO || !hasGlyf)) this.outlines = "cff";
    else if (hasGlyf) this.outlines = "truetype";
    else this.file.fail("font has no outlines (no glyf/loca or CFF table); bitmap-only fonts are not supported");
    if (this.outlines === "truetype") {
      this.glyfTable = new GlyfTable(this.required("loca"), this.required("glyf"), this.head.indexToLocFormat, this.glyphCount);
    }

    const os2 = this.optional("OS/2", parseOs2);
    this.os2 = os2;
    const post = this.optional("post", parsePostHeader);
    this.post = post;
    const nameTable = this.optional("name", (r) => new NameTable(r));
    const names = fontNames(nameTable);
    this.familyName = names.familyName;
    this.subfamilyName = names.subfamilyName;
    this.fullName = names.fullName;
    this.postscriptName = names.postscriptName;

    const cmapTable = this.tableReader("cmap");
    this.cmap = cmapTable ? parseCmap(cmapTable, this.glyphCount) : undefined;
    this.symbolic = this.cmap?.symbol ?? false;

    this.unitsPerEm = this.head.unitsPerEm;
    let ascent = this.hhea.ascender;
    let descent = this.hhea.descender;
    let lineGap = this.hhea.lineGap;
    if (ascent === 0 && descent === 0 && os2) {
      ascent = os2.typoAscender ?? os2.winAscent ?? 0;
      descent = os2.typoDescender ?? -(os2.winDescent ?? 0);
      lineGap = os2.typoLineGap ?? 0;
    }
    this.ascent = ascent;
    this.descent = descent === 0 ? 0 : -Math.abs(descent);
    this.lineGap = lineGap;
    this.italicAngle = post?.italicAngle ?? 0;
    const style = styleFlags(os2, this.head.macStyle, this.subfamilyName, this.italicAngle);
    this.bold = style.bold;
    this.italic = style.italic;
    this.weight = style.weight;
    this.bbox = { xMin: this.head.xMin, yMin: this.head.yMin, xMax: this.head.xMax, yMax: this.head.yMax };
    this.embeddingAllowed = os2 ? fsTypeAllowsEmbedding(os2.fsType) : true;
    this.subsettingAllowed = os2 ? (os2.fsType & 0x0100) === 0 : true;
    this.underlinePosition = post?.underlinePosition ?? -Math.round(this.unitsPerEm * 0.1);
    this.underlineThickness = post?.underlineThickness || Math.round(this.unitsPerEm * 0.05);
    this.strikeoutSize = os2?.yStrikeoutSize || this.underlineThickness;
    this.strikeoutPosition = os2?.yStrikeoutPosition || Math.round(this.unitsPerEm * 0.25);
    if (os2 && os2.panoseFamily === 2 && os2.panoseSerif >= 2 && os2.panoseSerif <= 15) {
      this.serif = os2.panoseSerif <= 10;
    } else {
      this.serif = undefined;
    }
  }

  /** @internal A Reader over a table, or undefined when absent. */
  tableReader(tag: string): Reader | undefined {
    const rec = this.dir.tables.get(tag);
    return rec ? this.file.sub(rec.offset, rec.length, `table '${tag}'`) : undefined;
  }

  private required(tag: string): Reader {
    const r = this.tableReader(tag);
    if (!r) this.file.fail(`required table '${tag}' is missing`);
    return r;
  }

  /** Parses an optional table; a corrupt one is ignored with a warning. */
  private optional<T>(tag: string, parse: (r: Reader) => T): T | undefined {
    const r = this.tableReader(tag);
    if (!r) return undefined;
    try {
      return parse(r);
    } catch (e) {
      if (!(e instanceof FontError)) throw e;
      this.warnings.push(`ignored ${tag}: ${e.message}`);
      return undefined;
    }
  }

  /** @internal */
  get glyf(): GlyfTable | undefined {
    return this.glyfTable;
  }

  /**
   * post.isFixedPitch or PANOSE monospaced, or else all printable ASCII
   * characters the font maps share one advance (some fonts, KaTeX_Typewriter
   * among them, leave both flags unset).
   */
  get isFixedPitch(): boolean {
    if (this.fixedPitchValue === undefined) {
      if (this.post?.isFixedPitch || (this.os2?.panoseFamily === 2 && this.os2.panoseProportion === 9)) {
        this.fixedPitchValue = true;
      } else {
        let width = -1;
        let count = 0;
        let fixed = true;
        for (let c = 0x21; c < 0x7f && fixed; c++) {
          const gid = this.glyphForCodePoint(c);
          if (!gid) continue;
          const w = this.advance(gid);
          if (width < 0) width = w;
          fixed = w === width;
          count++;
        }
        this.fixedPitchValue = fixed && count >= 10 && width > 0;
      }
    }
    return this.fixedPitchValue;
  }

  get capHeight(): number {
    if (this.capHeightValue === undefined) {
      this.capHeightValue = this.os2?.capHeight || this.glyphHeight([0x48, 0x49], 0.7);
    }
    return this.capHeightValue;
  }

  get xHeight(): number {
    if (this.xHeightValue === undefined) {
      this.xHeightValue = this.os2?.xHeight || this.glyphHeight([0x78, 0x76, 0x7a], 0.5);
    }
    return this.xHeightValue;
  }

  /** Top of the first of these characters that has an outline, else a fraction of the em. */
  private glyphHeight(cps: number[], fraction: number): number {
    for (const cp of cps) {
      const gid = this.glyphForCodePoint(cp);
      if (!gid) continue;
      try {
        const box = this.bounds(gid);
        if (box.yMax > 0 && box.yMax < this.unitsPerEm * 2) return box.yMax;
      } catch (e) {
        if (!(e instanceof FontError)) throw e;
      }
    }
    return Math.round(this.unitsPerEm * fraction);
  }

  get bytes(): Uint8Array {
    if (!this.ownBytes) {
      if (!this.isCollection) this.ownBytes = this.file.bytes;
      else {
        const tables: TableData[] = [];
        for (const rec of this.dir.tables.values()) {
          // A digital signature cannot survive re-packing the tables.
          if (rec.tag === "DSIG") continue;
          tables.push({ tag: rec.tag, data: this.file.bytes.subarray(rec.offset, rec.offset + rec.length) });
        }
        this.ownBytes = buildSfnt(tables, this.dir.flavor);
      }
    }
    return this.ownBytes;
  }

  table(tag: string): Uint8Array | undefined {
    return this.tableReader(tag)?.bytes;
  }

  glyphForCodePoint(cp: number): number {
    return this.cmap ? this.cmap.lookup(cp) : 0;
  }

  *codePoints(): Generator<number> {
    if (this.cmap) yield* this.cmap.codePoints();
  }

  advance(gid: number): number {
    if (!(gid >= 0 && gid < this.glyphCount) || !Number.isInteger(gid)) return 0;
    const i = gid < this.numberOfHMetrics ? gid : this.numberOfHMetrics - 1;
    return this.hmtx.u16(4 * i);
  }

  /** @internal Left side bearing from hmtx (0 when the table omits it). */
  leftSideBearing(gid: number): number {
    if (gid < this.numberOfHMetrics) return this.hmtx.i16(4 * gid + 2);
    const p = 4 * this.numberOfHMetrics + 2 * (gid - this.numberOfHMetrics);
    return this.hmtx.has(p, 2) ? this.hmtx.i16(p) : 0;
  }

  bounds(gid: number): Bounds {
    if (!(gid >= 0 && gid < this.glyphCount) || !Number.isInteger(gid)) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    if (this.outlines === "cff") return this.cffBounds(gid);
    const box = this.glyfTable!.box(gid);
    return box ? { ...box } : { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  }

  outline(gid: number): PathCommand[] {
    if (!(gid >= 0 && gid < this.glyphCount) || !Number.isInteger(gid)) return [];
    if (this.outlines === "cff") return this.cffTable()?.outline(gid) ?? [];
    return this.glyfTable!.outline(gid, (g) => this.leftSideBearing(g));
  }

  /** The parsed CFF table, or null when its charstrings are Type 1. */
  private cffTable(): CffOutlines | null {
    if (this.cff === undefined) {
      const cff2 = !this.dir.tables.has("CFF ");
      const cff = parseCff(this.required(cff2 ? "CFF2" : "CFF "), cff2, this.unitsPerEm);
      this.cff = cff.supported ? cff : null;
    }
    return this.cff;
  }

  /** CFF glyph bounds from its charstring; the font bbox for Type 1 charstrings. */
  private cffBounds(gid: number): Bounds {
    const cff = this.cffTable();
    if (!cff || gid >= cff.glyphCount) return cff ? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 } : { ...this.bbox };
    let box = this.cffBoxes.get(gid);
    if (!box) {
      box = cff.box(gid) ?? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
      if (this.cffBoxes.size >= 4096) this.cffBoxes.clear();
      this.cffBoxes.set(gid, box);
    }
    return { ...box };
  }

  kerning(left: number, right: number): number {
    if (!(left >= 0 && left < this.glyphCount && right >= 0 && right < this.glyphCount)) return 0;
    if (!Number.isInteger(left) || !Number.isInteger(right)) return 0;
    if (this.kernSource === undefined) this.kernSource = this.loadKerning();
    if (!this.kernSource) return 0;
    const key = left * 65536 + right;
    const cached = this.kernCache.get(key);
    if (cached !== undefined) return cached;
    let value = 0;
    try {
      value = this.kernSource.kern(left, right);
    } catch (e) {
      if (!(e instanceof FontError)) throw e;
      this.warnings.push(`kerning disabled: ${e.message}`);
      this.kernSource = null;
      return 0;
    }
    if (this.kernCache.size >= KERN_CACHE_LIMIT) this.kernCache.clear();
    this.kernCache.set(key, value);
    return value;
  }

  /** GPOS 'kern' lookups when the font has them, else the legacy kern table. */
  private loadKerning(): GposKerning | KernTable | null {
    const gpos = this.optional("GPOS", (r) => new GposKerning(r));
    if (gpos && !gpos.empty) return gpos;
    const kern = this.optional("kern", (r) => new KernTable(r));
    if (kern && !kern.empty) return kern;
    return null;
  }

  ligatures(gids: number[]): number[] {
    return this.ligatureClusters(gids).glyphs;
  }

  ligatureClusters(gids: readonly number[]): LigatureResult {
    if (this.liga === undefined) {
      const liga = this.optional("GSUB", (r) => new GsubLigatures(r, this.glyphCount));
      this.liga = liga && !liga.empty ? liga : null;
    }
    if (this.liga) {
      try {
        return this.liga.apply(gids);
      } catch (e) {
        if (!(e instanceof FontError)) throw e;
        this.warnings.push(`ligatures disabled: ${e.message}`);
        this.liga = null;
      }
    }
    return { glyphs: [...gids], counts: gids.map(() => 1) };
  }

  private glyphNames(): GlyphNames | null {
    if (this.names === undefined) {
      const names = this.post ? this.optional("post", (r) => new GlyphNames(r, this.glyphCount)) : undefined;
      this.names = names && names.hasNames ? names : null;
    }
    return this.names;
  }

  glyphName(gid: number): string | undefined {
    return this.glyphNames()?.name(gid);
  }

  glyphForName(name: string): number {
    return this.glyphNames()?.glyph(name) ?? 0;
  }

  subset(gids: Iterable<number>): Uint8Array {
    if (this.outlines === "cff") {
      if (!this.dir.tables.has("CFF ")) throw new FontError("CFF2 subsetting is not supported");
      return subsetOpenTypeCff(this, gids);
    }
    return subsetTrueType(this, gids);
  }
}

export type { SfntFont };

/**
 * Opens a TrueType or OpenType font. For a collection (.ttc), `collectionIndex`
 * picks the font. Throws FontError for anything that is not a usable font.
 */
export function parseFont(bytes: Uint8Array, collectionIndex = 0): Font {
  if (!(bytes instanceof Uint8Array)) throw new FontError("font data must be a Uint8Array");
  // A Node Buffer is viewed as a plain Uint8Array so slice() always copies.
  const plain = Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // WOFF and WOFF2 are unwrapped to the sfnt they carry.
  return new SfntFont(isWebFont(plain) ? webFontToSfnt(plain) : plain, collectionIndex);
}

/** @internal Type guard for the concrete font class (used by the subsetter). */
export function isSfntFont(font: Font): font is SfntFont {
  return font instanceof SfntFont;
}
