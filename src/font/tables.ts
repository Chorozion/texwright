/**
 * The small fixed-layout tables: head, hhea, maxp, OS/2, post (header) and
 * name. Each parser takes a Reader over just that table.
 */

import { decodeMacRoman, decodeUtf16be } from "./encodings.js";
import { Reader } from "./reader.js";

export interface Head {
  readonly unitsPerEm: number;
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
  readonly macStyle: number;
  /** 0 = short loca offsets, 1 = long. */
  readonly indexToLocFormat: number;
}

export function parseHead(r: Reader): Head {
  if (r.length < 54) r.fail(`head table is ${r.length} bytes, expected 54`);
  if (r.u32(12) !== 0x5f0f3cf5) r.fail("bad head.magicNumber");
  const unitsPerEm = r.u16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) r.fail(`head.unitsPerEm ${unitsPerEm} is outside 16..16384`);
  const indexToLocFormat = r.i16(50);
  return {
    unitsPerEm,
    xMin: r.i16(36),
    yMin: r.i16(38),
    xMax: r.i16(40),
    yMax: r.i16(42),
    macStyle: r.u16(44),
    indexToLocFormat,
  };
}

export interface Hhea {
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly numberOfHMetrics: number;
}

export function parseHhea(r: Reader): Hhea {
  if (r.length < 36) r.fail(`hhea table is ${r.length} bytes, expected 36`);
  return {
    ascender: r.i16(4),
    descender: r.i16(6),
    lineGap: r.i16(8),
    numberOfHMetrics: r.u16(34),
  };
}

export function parseMaxpNumGlyphs(r: Reader): number {
  if (r.length < 6) r.fail(`maxp table is ${r.length} bytes, expected at least 6`);
  const version = r.u32(0);
  if (version !== 0x00005000 && version !== 0x00010000) r.fail(`unsupported maxp version 0x${version.toString(16)}`);
  const n = r.u16(4);
  if (n < 1) r.fail("maxp.numGlyphs is 0; a font needs at least the .notdef glyph");
  return n;
}

/** Fields of OS/2 that the font module uses; undefined when the table is too old or short. */
export interface Os2 {
  readonly version: number;
  readonly weightClass: number;
  readonly fsType: number;
  readonly fsSelection: number;
  readonly yStrikeoutSize: number;
  readonly yStrikeoutPosition: number;
  /** PANOSE bFamilyType and bSerifStyle. */
  readonly panoseFamily: number;
  readonly panoseSerif: number;
  readonly panoseProportion: number;
  readonly typoAscender?: number;
  readonly typoDescender?: number;
  readonly typoLineGap?: number;
  readonly winAscent?: number;
  readonly winDescent?: number;
  readonly xHeight?: number;
  readonly capHeight?: number;
}

export function parseOs2(r: Reader): Os2 {
  if (r.length < 68) r.fail(`OS/2 table is ${r.length} bytes, expected at least 68`);
  const version = r.u16(0);
  const has = (off: number) => r.has(off, 2);
  return {
    version,
    weightClass: r.u16(4),
    fsType: r.u16(8),
    fsSelection: r.u16(62),
    yStrikeoutSize: r.i16(26),
    yStrikeoutPosition: r.i16(28),
    panoseFamily: r.u8(32),
    panoseSerif: r.u8(33),
    panoseProportion: r.u8(35),
    typoAscender: has(68) ? r.i16(68) : undefined,
    typoDescender: has(70) ? r.i16(70) : undefined,
    typoLineGap: has(72) ? r.i16(72) : undefined,
    winAscent: has(74) ? r.u16(74) : undefined,
    winDescent: has(76) ? r.u16(76) : undefined,
    xHeight: version >= 2 && has(86) ? r.i16(86) : undefined,
    capHeight: version >= 2 && has(88) ? r.i16(88) : undefined,
  };
}

/**
 * Whether OS/2.fsType permits embedding the outlines in a document. Bits 1-3
 * are mutually exclusive and the least restrictive one wins when several are
 * set; bit 9 (bitmap embedding only) rules out outline embedding.
 */
export function fsTypeAllowsEmbedding(fsType: number): boolean {
  const restricted = (fsType & 0x000e) === 0x0002;
  const bitmapOnly = (fsType & 0x0200) !== 0;
  return !restricted && !bitmapOnly;
}

export interface PostHeader {
  readonly version: number;
  readonly italicAngle: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly isFixedPitch: boolean;
}

export function parsePostHeader(r: Reader): PostHeader {
  if (r.length < 32) r.fail(`post table is ${r.length} bytes, expected at least 32`);
  return {
    version: r.u32(0),
    italicAngle: r.fixed(4),
    underlinePosition: r.i16(8),
    underlineThickness: r.i16(10),
    isFixedPitch: r.u32(12) !== 0,
  };
}

export interface NameRecord {
  readonly platformID: number;
  readonly encodingID: number;
  readonly languageID: number;
  readonly nameID: number;
  readonly offset: number;
  readonly length: number;
}

/** Name table access: records are read once, strings decoded on request. */
export class NameTable {
  private readonly r: Reader;
  private readonly records: NameRecord[] = [];

  constructor(r: Reader) {
    this.r = r;
    if (r.length < 6) r.fail("name table too short");
    const count = r.u16(2);
    const storage = r.u16(4);
    if (!r.has(6, 12 * count)) r.fail(`name table declares ${count} records but is truncated`);
    for (let i = 0; i < count; i++) {
      const p = 6 + 12 * i;
      const length = r.u16(p + 8);
      const offset = storage + r.u16(p + 10);
      if (!r.has(offset, length)) continue; // skip a broken record rather than lose the font
      this.records.push({
        platformID: r.u16(p),
        encodingID: r.u16(p + 2),
        languageID: r.u16(p + 4),
        nameID: r.u16(p + 6),
        offset,
        length,
      });
    }
  }

  /** Best available string for a name ID, preferring Windows English. */
  get(nameID: number): string | undefined {
    let best: NameRecord | undefined;
    let bestScore = 0;
    for (const rec of this.records) {
      if (rec.nameID !== nameID) continue;
      const score = recordScore(rec);
      if (score > bestScore) {
        best = rec;
        bestScore = score;
      }
    }
    if (!best) return undefined;
    const raw = this.r.bytes.subarray(best.offset, best.offset + best.length);
    const text = best.platformID === 1 ? decodeMacRoman(raw) : decodeUtf16be(raw);
    // Some fonts pad names with NULs.
    return text.replace(/\0+$/, "");
  }
}

function recordScore(rec: NameRecord): number {
  const { platformID: p, encodingID: e, languageID: l } = rec;
  if (p === 3 && (e === 1 || e === 10)) return l === 0x409 ? 10 : 7;
  if (p === 0) return 8;
  if (p === 3 && e === 0) return l === 0x409 ? 6 : 4;
  if (p === 1 && e === 0) return l === 0 ? 5 : 2;
  return 0;
}

export interface StyleFlags {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly weight: number;
}

/**
 * Bold, italic and weight from OS/2.fsSelection, head.macStyle,
 * OS/2.usWeightClass, the italic angle and the style name. Some fonts (the
 * KaTeX ones among them) mark every face Regular in fsSelection and macStyle,
 * so a weight of 700 or more, a non-zero italic angle, or "Italic"/"Oblique"
 * in the style name also count.
 */
export function styleFlags(os2: Os2 | undefined, macStyle: number, subfamily: string, italicAngle: number): StyleFlags {
  const fsSelection = os2?.fsSelection ?? 0;
  const flaggedBold = (fsSelection & 0x20) !== 0 || (macStyle & 1) !== 0;
  const weight = os2?.weightClass || (flaggedBold ? 700 : 400);
  const bold = flaggedBold || weight >= 700;
  const italic =
    (fsSelection & 0x201) !== 0 || (macStyle & 2) !== 0 || italicAngle !== 0 || /italic|oblique|kursiv/i.test(subfamily);
  return { bold, italic, weight };
}

export interface FontNames {
  readonly familyName: string;
  /** Name ID 1, the family within a family of four styles. */
  readonly legacyFamily: string;
  readonly subfamilyName: string;
  readonly fullName: string;
  readonly postscriptName: string;
}

/**
 * Family and style names. The typographic family (name IDs 16/17) is used
 * when present, so "Segoe UI Semibold" reads as family "Segoe UI", style
 * "Semibold".
 */
export function fontNames(names: NameTable | undefined): FontNames {
  const legacyFamily = (names?.get(1) || "").trim();
  const familyName = (names?.get(16) || legacyFamily).trim();
  const subfamilyName = (names?.get(17) || names?.get(2) || "Regular").trim();
  const fullName = (names?.get(4) || [familyName, subfamilyName].filter(Boolean).join(" ")).trim();
  let postscriptName = (names?.get(6) || "").trim();
  if (!postscriptName) {
    postscriptName = (fullName || "Untitled").replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, "");
    if (!postscriptName) postscriptName = "Untitled";
  }
  return { familyName, legacyFamily, subfamilyName, fullName, postscriptName };
}
