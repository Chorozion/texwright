/**
 * The sfnt container: font collections, the table directory, table
 * checksums, and writing a new font file from a set of tables.
 */

import { FontError } from "./errors.js";
import { Reader } from "./reader.js";

export const TAG_TTCF = 0x74746366; // 'ttcf'
export const FLAVOR_TRUETYPE = 0x00010000;
export const FLAVOR_OTTO = 0x4f54544f; // 'OTTO'
export const FLAVOR_TRUE = 0x74727565; // 'true' (Apple TrueType)

export interface TableRecord {
  readonly tag: string;
  readonly checksum: number;
  /** Offset from the start of the file (collections share one file). */
  readonly offset: number;
  readonly length: number;
}

export interface SfntDirectory {
  /** sfntVersion: 0x00010000, 'OTTO' or 'true'. */
  readonly flavor: number;
  readonly tables: ReadonlyMap<string, TableRecord>;
}

/** Number of fonts in a collection, or 1 for a single font. */
export function collectionSize(bytes: Uint8Array): number {
  const file = new Reader(bytes, "font file");
  if (file.length < 4) file.fail("too short to be a font (need at least 12 bytes)");
  if (file.u32(0) !== TAG_TTCF) return 1;
  return readCollectionOffsets(file).length;
}

function readCollectionOffsets(file: Reader): number[] {
  if (file.length < 12) file.fail("truncated collection header");
  const major = file.u16(4);
  if (major !== 1 && major !== 2) file.fail(`unsupported collection version ${major}`);
  const numFonts = file.u32(8);
  if (numFonts < 1) file.fail("collection holds no fonts");
  if (12 + 4 * numFonts > file.length) file.fail(`collection declares ${numFonts} fonts but the header is truncated`);
  const offsets: number[] = [];
  for (let i = 0; i < numFonts; i++) offsets.push(file.u32(12 + 4 * i));
  return offsets;
}

function flavorName(flavor: number): string {
  const s = String.fromCharCode((flavor >>> 24) & 255, (flavor >>> 16) & 255, (flavor >>> 8) & 255, flavor & 255);
  return /^[\x20-\x7e]{4}$/.test(s) ? `'${s}'` : `0x${flavor.toString(16).padStart(8, "0")}`;
}

/**
 * Reads the table directory of one font. For a collection, `index` picks the
 * font; table offsets stay relative to the start of the file.
 */
export function readDirectory(file: Reader, index = 0): SfntDirectory {
  if (file.length < 12) file.fail("too short to be a font (need at least 12 bytes)");
  let start = 0;
  const first = file.u32(0);
  if (first === TAG_TTCF) {
    const offsets = readCollectionOffsets(file);
    if (!Number.isInteger(index) || index < 0 || index >= offsets.length) {
      throw new FontError(`font file: collection index ${index} out of range (the collection holds ${offsets.length} fonts)`);
    }
    start = offsets[index];
  } else if (index !== 0) {
    throw new FontError(`font file: collection index ${index} requested but the file is a single font`);
  }
  if (!file.has(start, 12)) file.fail(`font header at offset ${start} lies outside the file`);
  const flavor = file.u32(start);
  if (flavor === 0x774f4646 || flavor === 0x774f4632) {
    file.fail("WOFF/WOFF2 web fonts are not supported; use the TTF or OTF file");
  }
  if (flavor !== FLAVOR_TRUETYPE && flavor !== FLAVOR_OTTO && flavor !== FLAVOR_TRUE) {
    file.fail(`not a TrueType/OpenType font (sfnt version ${flavorName(flavor)})`);
  }
  const numTables = file.u16(start + 4);
  if (numTables === 0) file.fail("font has no tables");
  if (!file.has(start + 12, 16 * numTables)) {
    file.fail(`table directory declares ${numTables} tables but the file is truncated`);
  }
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const rec = start + 12 + 16 * i;
    const tag = file.tag(rec);
    const checksum = file.u32(rec + 4);
    const offset = file.u32(rec + 8);
    let length = file.u32(rec + 12);
    if (offset > file.length || offset + length > file.length) {
      // Tolerate a final table whose declared length runs into missing
      // padding (a few real fonts do this); anything more is truncation.
      if (offset <= file.length && offset + length - file.length <= 3) length = file.length - offset;
      else file.fail(`table '${tag}' (offset ${offset}, length ${length}) lies outside the ${file.length}-byte file`);
    }
    if (!tables.has(tag)) tables.set(tag, { tag, checksum, offset, length });
  }
  return { flavor, tables };
}

/** The OpenType table checksum: the sum of big-endian uint32 words, zero padded. */
export function tableChecksum(bytes: Uint8Array, offset = 0, length = bytes.length - offset): number {
  let sum = 0;
  const end = offset + length;
  let i = offset;
  for (; i + 4 <= end; i += 4) {
    sum = (sum + (((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0)) >>> 0;
  }
  if (i < end) {
    let word = 0;
    for (let k = 0; k < 4; k++) word = (word << 8) | (i + k < end ? bytes[i + k] : 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

export interface TableData {
  readonly tag: string;
  readonly data: Uint8Array;
}

/**
 * Writes a font file: a table directory sorted by tag, every table 4-byte
 * aligned, every checksum recomputed, and head.checkSumAdjustment set so the
 * whole file sums to 0xB1B0AFBA.
 */
export function buildSfnt(tables: readonly TableData[], flavor = FLAVOR_TRUETYPE): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].tag === sorted[i - 1].tag) throw new FontError(`duplicate table '${sorted[i].tag}'`);
  }
  const n = sorted.length;
  const headerSize = 12 + 16 * n;
  let size = headerSize;
  for (const t of sorted) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= n) entrySelector++;
  const searchRange = n > 0 ? 16 << entrySelector : 0;
  view.setUint32(0, flavor);
  view.setUint16(4, n);
  view.setUint16(6, searchRange);
  view.setUint16(8, n > 0 ? entrySelector : 0);
  view.setUint16(10, n * 16 - searchRange);
  let offset = headerSize;
  let headOffset = -1;
  sorted.forEach((t, i) => {
    if (t.tag.length !== 4) throw new FontError(`invalid table tag '${t.tag}'`);
    out.set(t.data, offset);
    if (t.tag === "head") {
      if (t.data.length < 12) throw new FontError("head table too short");
      headOffset = offset;
      view.setUint32(offset + 8, 0); // checkSumAdjustment is computed below
    }
    const rec = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[rec + k] = t.tag.charCodeAt(k) & 255;
    view.setUint32(rec + 4, tableChecksum(out, offset, t.data.length));
    view.setUint32(rec + 8, offset);
    view.setUint32(rec + 12, t.data.length);
    offset += (t.data.length + 3) & ~3;
  });
  if (headOffset >= 0) {
    const total = tableChecksum(out, 0, out.length);
    view.setUint32(headOffset + 8, (0xb1b0afba - total) >>> 0);
  }
  return out;
}
