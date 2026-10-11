/**
 * Just enough of a CFF reader to map glyph ids to CIDs.
 *
 * A PDF CIDFontType0 font selects glyphs by CID. When the embedded CFF is
 * CID-keyed (its Top DICT has ROS), the viewer turns a CID into a glyph id
 * through the font's charset, so the writer must use the charset's CID for
 * each glyph instead of the glyph id. A CFF that is not CID-keyed uses the
 * CID as the glyph id directly.
 */

const OP_CHARSET = 15;
const OP_CHARSTRINGS = 17;
const OP_ROS = 1230;

class CffReadError extends Error {}

interface Index {
  count: number;
  /** Absolute [start, end) of entry i. */
  entry(i: number): [number, number];
  end: number;
}

function u8(b: Uint8Array, p: number): number {
  if (p < 0 || p >= b.length) throw new CffReadError(`offset ${p} is outside the CFF table`);
  return b[p];
}

function u16(b: Uint8Array, p: number): number {
  return (u8(b, p) << 8) | u8(b, p + 1);
}

function offsetAt(b: Uint8Array, p: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + u8(b, p + i);
  return v;
}

function readIndex(b: Uint8Array, p: number): Index {
  const count = u16(b, p);
  if (count === 0) return { count, entry: () => [p + 2, p + 2], end: p + 2 };
  const offSize = u8(b, p + 2);
  if (offSize < 1 || offSize > 4) throw new CffReadError(`INDEX offSize ${offSize}`);
  const base = p + 3 + (count + 1) * offSize - 1;
  const last = offsetAt(b, p + 3 + count * offSize, offSize);
  const end = base + last;
  if (end > b.length) throw new CffReadError("INDEX runs past the table");
  return {
    count,
    end,
    entry(i: number): [number, number] {
      const s = base + offsetAt(b, p + 3 + i * offSize, offSize);
      const e = base + offsetAt(b, p + 3 + (i + 1) * offSize, offSize);
      if (s > e || e > end) throw new CffReadError("INDEX offsets out of order");
      return [s, e];
    },
  };
}

/** Top DICT operators to their operand lists. */
function readDict(b: Uint8Array, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let operands: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = u8(b, p);
    if (b0 <= 21) {
      let op = b0;
      p++;
      if (b0 === 12) {
        op = 1200 + u8(b, p);
        p++;
      }
      out.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      const v = u16(b, p + 1);
      operands.push(v >= 0x8000 ? v - 0x10000 : v);
      p += 3;
    } else if (b0 === 29) {
      operands.push((u16(b, p + 1) << 16) | u16(b, p + 3));
      p += 5;
    } else if (b0 === 30) {
      // Real number: nibbles up to an 0xf terminator; its value is not needed here.
      p++;
      for (;;) {
        const v = u8(b, p++);
        if ((v & 0x0f) === 0x0f || (v & 0xf0) === 0xf0) break;
      }
      operands.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + u8(b, p + 1) + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - u8(b, p + 1) - 108);
      p += 2;
    } else {
      throw new CffReadError(`reserved DICT byte ${b0}`);
    }
    if (operands.length > 48) throw new CffReadError("too many DICT operands");
  }
  return out;
}

/**
 * For a CID-keyed 'CFF ' table, the CID of every glyph (index = glyph id).
 * Undefined when the font is not CID-keyed (CIDs equal glyph ids). Throws
 * an Error with a message when the table is malformed.
 */
export function cffGlyphCids(cff: Uint8Array): Uint16Array | undefined {
  try {
    if (u8(cff, 0) !== 1) throw new CffReadError(`CFF major version ${cff[0]}`);
    const hdrSize = u8(cff, 2);
    const names = readIndex(cff, hdrSize);
    const tops = readIndex(cff, names.end);
    if (tops.count < 1) throw new CffReadError("no Top DICT");
    const [ts, te] = tops.entry(0);
    const top = readDict(cff, ts, te);
    if (!top.has(OP_ROS)) return undefined;
    const csOffset = top.get(OP_CHARSTRINGS)?.[0];
    if (csOffset === undefined) throw new CffReadError("no CharStrings");
    const nGlyphs = readIndex(cff, csOffset).count;
    const charset = top.get(OP_CHARSET)?.[0] ?? 0;
    const cids = new Uint16Array(nGlyphs);
    if (charset <= 2) {
      // A predefined charset in a CID font is invalid; treat CIDs as glyph ids.
      for (let g = 0; g < nGlyphs; g++) cids[g] = g;
      return cids;
    }
    const format = u8(cff, charset);
    let p = charset + 1;
    let g = 1;
    if (format === 0) {
      for (; g < nGlyphs; g++, p += 2) cids[g] = u16(cff, p);
    } else if (format === 1 || format === 2) {
      while (g < nGlyphs) {
        const first = u16(cff, p);
        const left = format === 1 ? u8(cff, p + 2) : u16(cff, p + 2);
        p += format === 1 ? 3 : 4;
        for (let k = 0; k <= left && g < nGlyphs; k++, g++) cids[g] = (first + k) & 0xffff;
      }
    } else {
      throw new CffReadError(`charset format ${format}`);
    }
    return cids;
  } catch (e) {
    if (e instanceof CffReadError) throw new Error(`malformed CFF table: ${e.message}`);
    throw e;
  }
}
