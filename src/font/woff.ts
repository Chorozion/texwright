/**
 * WOFF 1.0 encoding (W3C, 2012) for fonts embedded in HTML: the sfnt's
 * tables, each zlib-compressed when that makes it smaller, behind a 44-byte
 * header and a 20-byte directory entry per table. Every browser reads it.
 */

import { deflateSync } from "node:zlib";

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Wrap a TrueType or OpenType font (not a collection) as WOFF. */
export function toWoff(sfnt: Uint8Array): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  if (sfnt.byteLength < 12) throw new Error("toWoff: not an sfnt font");
  const flavor = view.getUint32(0);
  const numTables = view.getUint16(4);
  if (12 + numTables * 16 > sfnt.byteLength) throw new Error("toWoff: table directory runs past the end of the font");
  const tables: { tag: number; checksum: number; orig: Uint8Array; data: Uint8Array }[] = [];
  for (let k = 0; k < numTables; k++) {
    const at = 12 + k * 16;
    const tag = view.getUint32(at);
    const checksum = view.getUint32(at + 4);
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > sfnt.byteLength) throw new Error("toWoff: a table runs past the end of the font");
    const orig = sfnt.subarray(offset, offset + length);
    const packed = new Uint8Array(deflateSync(orig, { level: 9 }));
    tables.push({ tag, checksum, orig, data: packed.byteLength < orig.byteLength ? packed : orig });
  }
  // The WOFF directory is sorted by tag, as the sfnt's should be.
  tables.sort((a, b) => a.tag - b.tag);
  const headerSize = 44 + 20 * tables.length;
  let size = headerSize;
  for (const t of tables) size = align4(size) + t.data.byteLength;
  const totalSfntSize = 12 + 16 * tables.length + tables.reduce((s, t) => s + align4(t.orig.byteLength), 0);
  const out = new Uint8Array(align4(size));
  const w = new DataView(out.buffer);
  w.setUint32(0, 0x774f4646); // "wOFF"
  w.setUint32(4, flavor);
  w.setUint32(8, out.byteLength);
  w.setUint16(12, tables.length);
  w.setUint16(14, 0);
  w.setUint32(16, totalSfntSize);
  // Version, metadata and private blocks: all zero.
  let offset = headerSize;
  tables.forEach((t, k) => {
    offset = align4(offset);
    const at = 44 + 20 * k;
    w.setUint32(at, t.tag);
    w.setUint32(at + 4, offset);
    w.setUint32(at + 8, t.data.byteLength);
    w.setUint32(at + 12, t.orig.byteLength);
    w.setUint32(at + 16, t.checksum);
    out.set(t.data, offset);
    offset += t.data.byteLength;
  });
  return out;
}
