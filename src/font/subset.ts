/**
 * TrueType and OpenType (CFF) subsetting for PDF embedding.
 *
 * Glyph ids are kept: a glyph that is not needed becomes empty in glyf and
 * loca, so a PDF can use Identity CIDs equal to the original glyph ids.
 * Glyphs after the highest one kept are dropped altogether (maxp.numGlyphs
 * shrinks), which keeps loca and hmtx small for Latin text in big fonts.
 *
 * Output tables: head, hhea, maxp, hmtx, loca, glyf, cvt, fpgm, prep (when
 * the font has them), post (format 3) and a minimal name table.
 */

import { FontError } from "./errors.js";
import type { SfntFont } from "./font.js";
import { subsetCff } from "./cffsubset.js";
import { FLAVOR_OTTO, buildSfnt, type TableData } from "./sfnt.js";

/** Builds a name table with Windows Unicode English records. */
export function buildNameTable(entries: readonly [number, string][]): Uint8Array {
  const strings = entries.map(([, s]) => {
    const out = new Uint8Array(2 * s.length);
    for (let i = 0; i < s.length; i++) {
      out[2 * i] = s.charCodeAt(i) >> 8;
      out[2 * i + 1] = s.charCodeAt(i) & 255;
    }
    return out;
  });
  const count = entries.length;
  const storage = 6 + 12 * count;
  const total = storage + strings.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0);
  v.setUint16(2, count);
  v.setUint16(4, storage);
  let offset = 0;
  // Records must be sorted by platform, encoding, language, then name ID.
  const order = entries.map((_, i) => i).sort((a, b) => entries[a][0] - entries[b][0]);
  order.forEach((i, k) => {
    const p = 6 + 12 * k;
    v.setUint16(p, 3);
    v.setUint16(p + 2, 1);
    v.setUint16(p + 4, 0x409);
    v.setUint16(p + 6, entries[i][0]);
    v.setUint16(p + 8, strings[i].length);
    v.setUint16(p + 10, offset);
    out.set(strings[i], storage + offset);
    offset += strings[i].length;
  });
  return out;
}

export function subsetTrueType(font: SfntFont, gids: Iterable<number>): Uint8Array {
  const glyf = font.glyf;
  if (!glyf) throw new FontError("font has no glyf table to subset");
  const n = font.glyphCount;
  const wanted = new Set<number>([0]);
  for (const g of gids) {
    if (!Number.isInteger(g) || g < 0 || g >= n) {
      throw new FontError(`subset: glyph id ${g} is out of range (font has ${n} glyphs)`);
    }
    wanted.add(g);
  }
  const keep = glyf.closure(wanted);
  let last = 0;
  for (const g of keep) if (g > last) last = g;
  const numGlyphs = last + 1;

  // glyf and loca: kept glyphs copied verbatim (4-byte aligned), others empty.
  const pieces: Uint8Array[] = [];
  const offsets = new Uint32Array(numGlyphs + 1);
  let size = 0;
  for (let g = 0; g < numGlyphs; g++) {
    offsets[g] = size;
    if (!keep.has(g)) continue;
    const data = glyf.data(g);
    if (data.length === 0) continue;
    pieces.push(data);
    size += data.length;
    const pad = (4 - (data.length & 3)) & 3;
    if (pad) {
      pieces.push(new Uint8Array(pad));
      size += pad;
    }
  }
  offsets[numGlyphs] = size;
  const glyfData = new Uint8Array(size);
  let at = 0;
  for (const p of pieces) {
    glyfData.set(p, at);
    at += p.length;
  }
  const shortLoca = size <= 0x1fffe;
  const loca = new Uint8Array((numGlyphs + 1) * (shortLoca ? 2 : 4));
  const lv = new DataView(loca.buffer);
  for (let g = 0; g <= numGlyphs; g++) {
    if (shortLoca) lv.setUint16(2 * g, offsets[g] / 2);
    else lv.setUint32(4 * g, offsets[g]);
  }

  // hmtx: the original metrics for every remaining glyph id.
  const nhm = Math.min(font.numberOfHMetrics, numGlyphs);
  const hmtx = new Uint8Array(4 * nhm + 2 * (numGlyphs - nhm));
  const hv = new DataView(hmtx.buffer);
  for (let g = 0; g < numGlyphs; g++) {
    if (g < nhm) {
      hv.setUint16(4 * g, font.advance(g));
      hv.setInt16(4 * g + 2, font.leftSideBearing(g));
    } else {
      hv.setInt16(4 * nhm + 2 * (g - nhm), font.leftSideBearing(g));
    }
  }

  const head = copyTable(font, "head", 54);
  new DataView(head.buffer).setInt16(50, shortLoca ? 0 : 1);
  const hhea = copyTable(font, "hhea", 36);
  new DataView(hhea.buffer).setUint16(34, nhm);
  const maxpSrc = font.tableReader("maxp")!;
  const maxp = maxpSrc.copy(0, Math.min(maxpSrc.length, 32));
  new DataView(maxp.buffer).setUint16(4, numGlyphs);

  const post = new Uint8Array(32);
  const pv = new DataView(post.buffer);
  pv.setUint32(0, 0x00030000);
  pv.setInt32(4, Math.round(font.italicAngle * 65536));
  pv.setInt16(8, font.underlinePosition);
  pv.setInt16(10, font.underlineThickness);
  pv.setUint32(12, font.isFixedPitch ? 1 : 0);

  const name = buildNameTable([
    [1, font.familyName || font.postscriptName],
    [2, font.subfamilyName || "Regular"],
    [3, `${font.postscriptName};subset`],
    [4, font.fullName || font.postscriptName],
    [6, font.postscriptName],
  ]);

  const tables: TableData[] = [
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "maxp", data: maxp },
    { tag: "hmtx", data: hmtx },
    { tag: "loca", data: loca },
    { tag: "glyf", data: glyfData },
    { tag: "post", data: post },
    { tag: "name", data: name },
  ];
  for (const tag of ["cvt ", "fpgm", "prep"]) {
    const t = font.tableReader(tag);
    if (t && t.length) tables.push({ tag, data: t.bytes });
  }
  return buildSfnt(tables);
}

function copyTable(font: SfntFont, tag: string, length: number): Uint8Array {
  const r = font.tableReader(tag);
  if (!r) throw new FontError(`required table '${tag}' is missing`);
  return r.copy(0, length);
}

/**
 * OpenType (CFF outlines) subsetting for PDF embedding: the CFF table subset
 * by subsetCff (glyph ids kept), with the tables a reader needs to accept the
 * file. Layout tables (GSUB, GPOS, GDEF) are left out; the PDF has the glyphs
 * already chosen.
 */
export function subsetOpenTypeCff(font: SfntFont, gids: Iterable<number>): Uint8Array {
  const cff = font.tableReader("CFF ");
  if (!cff) throw new FontError("font has no CFF table to subset");
  const post = new Uint8Array(32);
  const pv = new DataView(post.buffer);
  pv.setUint32(0, 0x00030000);
  pv.setInt32(4, Math.round(font.italicAngle * 65536));
  pv.setInt16(8, font.underlinePosition);
  pv.setInt16(10, font.underlineThickness);
  pv.setUint32(12, font.isFixedPitch ? 1 : 0);
  const name = buildNameTable([
    [1, font.familyName || font.postscriptName],
    [2, font.subfamilyName || "Regular"],
    [3, `${font.postscriptName};subset`],
    [4, font.fullName || font.postscriptName],
    [6, font.postscriptName],
  ]);
  const tables: TableData[] = [
    { tag: "CFF ", data: subsetCff(cff.bytes, gids) },
    { tag: "head", data: copyTable(font, "head", 54) },
    { tag: "post", data: post },
    { tag: "name", data: name },
  ];
  for (const tag of ["hhea", "hmtx", "maxp", "OS/2", "cmap"]) {
    const t = font.tableReader(tag);
    if (t && t.length) tables.push({ tag, data: t.bytes });
  }
  return buildSfnt(tables, FLAVOR_OTTO);
}
