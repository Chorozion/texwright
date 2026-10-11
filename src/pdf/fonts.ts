/**
 * Embedding fonts as composite (Type0) fonts with Identity-H encoding.
 *
 * Every Font object drawn with becomes one Type0 font whose two-byte codes
 * are CIDs. TrueType outlines become a CIDFontType2 with CIDToGIDMap
 * /Identity (CID = glyph id) and a subset that keeps the original glyph ids;
 * CFF outlines become a CIDFontType0 embedding the whole OpenType file
 * (FontFile3 /OpenType), with CIDs from the CFF charset when it is CID-keyed.
 */

import { createHash } from "node:crypto";
import type { Font } from "../font/index.js";
import { cffGlyphCids } from "./cff.js";
import { PdfError } from "./errors.js";
import { type ObjectTable, hex4, num, pdfName, ref, round4, sanitizeFontName } from "./serialize.js";
import { toUnicodeCMap } from "./tounicode.js";
import { Lru, idOf } from "../util/lru.js";

export class FontEntry {
  /** Per glyph id: the text it was first drawn with ("" while none), undefined when unused. */
  private readonly texts: (string | undefined)[];
  /** Per glyph id: width in thousandths of an em (NaN until computed). */
  private readonly widths: Float64Array;
  /** Per glyph id: the four hex digits of its code in content streams. */
  private readonly hexCodes: (string | undefined)[];
  private readonly scale: number;
  private readonly cids: Uint16Array | undefined;

  constructor(
    readonly font: Font,
    /** Resource name without the slash, e.g. "F1". */
    readonly resName: string,
    readonly warnings: string[],
  ) {
    if (!font.embeddingAllowed) {
      throw new PdfError(`font ${font.postscriptName || font.fullName} does not allow embedding (OS/2 fsType)`);
    }
    if (!(font.unitsPerEm > 0)) throw new PdfError(`font ${font.postscriptName} has unitsPerEm ${font.unitsPerEm}`);
    this.scale = 1000 / font.unitsPerEm;
    // Glyph ids are at most 65535, so per-glyph arrays stay small and are
    // much faster than maps on the hot path of glyphs().
    this.texts = new Array(font.glyphCount);
    this.widths = new Float64Array(font.glyphCount).fill(NaN);
    this.hexCodes = new Array(font.glyphCount);
    if (font.outlines === "cff") {
      const cff = font.table("CFF ");
      if (cff) {
        try {
          this.cids = cffGlyphCids(cff);
        } catch (e) {
          throw new PdfError(`font ${font.postscriptName}: ${(e as Error).message}`);
        }
      } else {
        warnings.push(`font ${font.postscriptName} has CFF2 outlines, which older PDF readers cannot show`);
      }
    }
  }

  /** The code (CID) a glyph id is drawn with. */
  code(gid: number): number {
    if (!this.cids) return gid;
    return gid < this.cids.length ? this.cids[gid] : 0;
  }

  /** The code as four hex digits. */
  hex(gid: number): string {
    return (this.hexCodes[gid] ??= hex4(this.code(gid)));
  }

  /** Glyph width in thousandths of an em, as written to /W. */
  width(gid: number): number {
    let w = this.widths[gid];
    if (w !== w) w = this.widths[gid] = round4(this.font.advance(gid) * this.scale);
    return w;
  }

  /** Records a glyph (a valid id) and the text it stands for; the first non-empty text wins. */
  use(gid: number, text: string): void {
    const prev = this.texts[gid];
    if (prev === undefined || (prev === "" && text !== "")) this.texts[gid] = text;
  }

  /** Glyph ids drawn so far, ascending. */
  usedGlyphs(): number[] {
    const out: number[] = [];
    for (let g = 0; g < this.texts.length; g++) if (this.texts[g] !== undefined) out.push(g);
    return out;
  }

  /** Writes the font's objects into `table` at `self` (the Type0 font) and returns nothing. */
  write(table: ObjectTable, self: number): void {
    const font = this.font;
    const gids = this.usedGlyphs();
    const cid = table.alloc();
    const descriptor = table.alloc();
    const file = table.alloc();
    const toUnicode = table.alloc();

    const truetype = font.outlines === "truetype";
    let subsetting = font.subsettingAllowed && (truetype || font.table("CFF ") !== undefined);
    let fontBytes: Uint8Array;
    try {
      fontBytes = subsetting ? subsetOf(font, gids) : font.bytes;
    } catch (e) {
      if (truetype) throw new PdfError(`cannot embed font ${font.postscriptName}: ${(e as Error).message}`);
      // A CFF font the subsetter cannot handle is still embedded, whole.
      this.warnings.push(`font ${font.postscriptName} embedded whole: ${(e as Error).message}`);
      subsetting = false;
      fontBytes = font.bytes;
    }
    const baseName = sanitizeFontName(font.postscriptName);
    const fontName = subsetting ? `${subsetTag(font, gids)}+${baseName}` : baseName;

    // Codes -> widths and text; for CFF fonts codes are CIDs from the charset.
    const widths = new Map<number, number>();
    const unicode = new Map<number, string>();
    for (const g of gids) {
      const c = this.code(g);
      if (!widths.has(c)) widths.set(c, this.width(g));
      const t = this.texts[g]!;
      if (t && !unicode.has(c)) unicode.set(c, t);
    }

    table.set(
      self,
      `<< /Type /Font /Subtype /Type0 /BaseFont ${pdfName(fontName)} /Encoding /Identity-H /DescendantFonts [${ref(cid)}] /ToUnicode ${ref(toUnicode)} >>`,
    );
    table.set(
      cid,
      `<< /Type /Font /Subtype /${truetype ? "CIDFontType2" : "CIDFontType0"} /BaseFont ${pdfName(fontName)}` +
        ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>` +
        ` /FontDescriptor ${ref(descriptor)} /W ${widthArray(widths)}${truetype ? " /CIDToGIDMap /Identity" : ""} >>`,
    );
    table.set(descriptor, this.descriptor(fontName, truetype ? "FontFile2" : "FontFile3", file));
    if (truetype) table.stream(file, `/Length1 ${fontBytes.length}`, fontBytes);
    else table.stream(file, "/Subtype /OpenType", fontBytes);
    table.stream(toUnicode, "", Buffer.from(toUnicodeCMap(unicode), "latin1"));
  }

  private descriptor(fontName: string, fileKey: string, file: number): string {
    const f = this.font;
    const s = this.scale;
    let flags = 0;
    if (f.isFixedPitch) flags |= 1;
    if (f.serif === true) flags |= 2;
    if (isSymbolic(f)) flags |= 4;
    else flags |= 32;
    if (f.italic || f.italicAngle !== 0) flags |= 64;
    const bb = f.bbox;
    const box =
      bb.xMax > bb.xMin && bb.yMax > bb.yMin
        ? [bb.xMin, bb.yMin, bb.xMax, bb.yMax].map((v) => Math.round(v * s))
        : [0, Math.round(f.descent * s), 1000, Math.round(f.ascent * s)];
    const ascent = f.ascent ? Math.round(f.ascent * s) : box[3];
    const descent = f.descent ? Math.round(f.descent * s) : box[1];
    const stemV = Math.round(50 + (f.weight / 65) ** 2);
    return (
      `<< /Type /FontDescriptor /FontName ${pdfName(fontName)} /Flags ${flags} /FontBBox [${box.join(" ")}]` +
      ` /ItalicAngle ${num(round4(f.italicAngle))} /Ascent ${ascent} /Descent ${descent}` +
      ` /CapHeight ${Math.round(f.capHeight * s)} /XHeight ${Math.round(f.xHeight * s)} /StemV ${stemV} /${fileKey} ${ref(file)} >>`
    );
  }
}

/**
 * Symbolic unless the font maps the basic Latin letters (the Nonsymbolic
 * flag promises the standard Latin character set).
 */
function isSymbolic(f: Font): boolean {
  if (f.symbolic) return true;
  for (const c of "AZaz") if (!f.glyphForCodePoint(c.charCodeAt(0))) return true;
  return false;
}

/**
 * Six capital letters from a hash of the font (name, glyph count and head
 * table, which holds its checksum and dates) and the glyph set: the same
 * subset always gets the same tag, other fonts or glyph sets another one.
 */
/** Font subsets by font and glyph set, for documents rendered again (watch, a warm server). */
const subsets = new Lru<Uint8Array>("subset", 128, 32 * 1024 * 1024);

function subsetOf(font: Font, gids: number[]): Uint8Array {
  const key = createHash("sha256").update(`${idOf(font)}:${gids.join(",")}`).digest("base64");
  let out = subsets.get(key);
  if (!out) {
    out = font.subset(gids);
    subsets.set(key, out, out.length + 64);
  }
  return out;
}

function subsetTag(font: Font, gids: number[]): string {
  const md5 = createHash("md5").update(`${font.postscriptName}\0${font.glyphCount}\0${gids.join(",")}\0`);
  const head = font.table("head");
  if (head) md5.update(head);
  const h = md5.digest();
  let tag = "";
  for (let i = 0; i < 6; i++) tag += String.fromCharCode(65 + (h[i] % 26));
  return tag;
}

/**
 * The /W array in compact form: runs of three or more equal widths as
 * `first last w`, other consecutive codes as `first [w1 w2 ...]`.
 */
export function widthArray(widths: ReadonlyMap<number, number>): string {
  const codes = [...widths.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < codes.length) {
    // A block of consecutive codes.
    let j = i + 1;
    while (j < codes.length && codes[j] === codes[j - 1] + 1) j++;
    let k = i;
    let list: string[] = [];
    let listStart = codes[i];
    while (k < j) {
      const w = widths.get(codes[k])!;
      let r = k + 1;
      while (r < j && widths.get(codes[r]) === w) r++;
      if (r - k >= 3) {
        if (list.length) parts.push(`${listStart} [${list.join(" ")}]`);
        list = [];
        parts.push(`${codes[k]} ${codes[r - 1]} ${num(w)}`);
        listStart = codes[r] ?? 0;
        k = r;
      } else {
        if (!list.length) listStart = codes[k];
        for (; k < r; k++) list.push(num(w));
      }
    }
    if (list.length) parts.push(`${listStart} [${list.join(" ")}]`);
    i = j;
  }
  return `[${parts.join(" ")}]`;
}
