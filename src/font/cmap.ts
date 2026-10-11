/**
 * Character-to-glyph mapping (the cmap table).
 *
 * One subtable is chosen when the font is opened. Lookups read the subtable
 * in place with a binary search; nothing is expanded up front, so opening a
 * CJK font with tens of thousands of mappings costs a few header reads.
 */

import { macRomanToUnicode, unicodeToMacRoman } from "./encodings.js";
import { Reader } from "./reader.js";

export interface Cmap {
  readonly platformID: number;
  readonly encodingID: number;
  readonly format: number;
  /** True for a Windows Symbol (3,0) subtable. */
  readonly symbol: boolean;
  lookup(cp: number): number;
  /** Mapped code points in increasing order, each once, glyph id never 0. */
  codePoints(): Generator<number>;
}

interface Raw {
  /** Glyph for a raw code in the subtable's own encoding. */
  get(code: number): number;
  /** [raw code, glyph] pairs in increasing code order. */
  each(): Generator<[number, number]>;
}

const SUPPORTED_FORMATS = new Set([0, 4, 6, 10, 12, 13]);

/**
 * Ranks an encoding record. Full-repertoire Unicode subtables first, then
 * BMP Unicode with Windows ahead of Unicode platform, then Windows Symbol,
 * then Mac Roman.
 */
function rank(platformID: number, encodingID: number): number {
  if (platformID === 3 && encodingID === 10) return 9;
  if (platformID === 0 && (encodingID === 4 || encodingID === 6)) return 8;
  if (platformID === 3 && encodingID === 1) return 7;
  if (platformID === 0 && encodingID <= 3) return 6;
  // A Windows Symbol subtable marks a symbol font: use it rather than the
  // Mac Roman one, so the font is recognisably symbolic.
  if (platformID === 3 && encodingID === 0) return 3;
  if (platformID === 1 && encodingID === 0) return 2;
  return 0;
}

/** Parses the cmap header and picks a subtable; undefined when none is usable. */
export function parseCmap(r: Reader, numGlyphs: number): Cmap | undefined {
  if (r.length < 4) r.fail("cmap table too short");
  const numTables = r.u16(2);
  if (!r.has(4, 8 * numTables)) r.fail(`cmap declares ${numTables} subtables but is truncated`);
  const candidates: { score: number; platformID: number; encodingID: number; offset: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const p = 4 + 8 * i;
    const platformID = r.u16(p);
    const encodingID = r.u16(p + 2);
    const offset = r.u32(p + 4);
    const score = rank(platformID, encodingID);
    if (score === 0 || !r.has(offset, 2)) continue;
    if (!SUPPORTED_FORMATS.has(r.u16(offset))) continue;
    candidates.push({ score, platformID, encodingID, offset });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return undefined;
  const sub = r.from(best.offset, `cmap subtable (${best.platformID},${best.encodingID})`);
  const format = sub.u16(0);
  const raw = makeRaw(sub, format, numGlyphs);
  const mac = best.platformID === 1;
  const symbol = best.platformID === 3 && best.encodingID === 0;
  return {
    platformID: best.platformID,
    encodingID: best.encodingID,
    format,
    symbol,
    lookup(cp: number): number {
      if (!(cp >= 0 && cp <= 0x10ffff) || !Number.isInteger(cp)) return 0;
      if (mac) {
        const code = unicodeToMacRoman(cp);
        return code < 0 ? 0 : raw.get(code);
      }
      const gid = raw.get(cp);
      // Symbol fonts put their glyphs at U+F020..U+F0FF; Windows maps
      // 8-bit codes there, and so does this lookup.
      if (gid === 0 && symbol && cp < 0x100) return raw.get(0xf000 + cp);
      return gid;
    },
    *codePoints(): Generator<number> {
      if (mac) {
        const seen: number[] = [];
        for (const [code] of raw.each()) seen.push(macRomanToUnicode(code));
        seen.sort((a, b) => a - b);
        let last = -1;
        for (const cp of seen) if (cp !== last) yield (last = cp);
        return;
      }
      for (const [code] of raw.each()) yield code;
    },
  };
}

function makeRaw(r: Reader, format: number, numGlyphs: number): Raw {
  const valid = (gid: number) => (gid > 0 && gid < numGlyphs ? gid : 0);
  switch (format) {
    case 0: {
      r.check(6, 256);
      return {
        get: (code) => (code >= 0 && code < 256 ? valid(r.u8(6 + code)) : 0),
        *each() {
          for (let c = 0; c < 256; c++) {
            const g = valid(r.u8(6 + c));
            if (g) yield [c, g];
          }
        },
      };
    }
    case 6: {
      const first = r.u16(6);
      const count = r.u16(8);
      r.check(10, 2 * count);
      const get = (code: number) => {
        const i = code - first;
        return i >= 0 && i < count ? valid(r.u16(10 + 2 * i)) : 0;
      };
      return {
        get,
        *each() {
          for (let i = 0; i < count && first + i <= 0xffff; i++) {
            const g = valid(r.u16(10 + 2 * i));
            if (g) yield [first + i, g];
          }
        },
      };
    }
    case 10: {
      const first = r.u32(12);
      const count = r.u32(16);
      r.check(20, 2 * count);
      const get = (code: number) => {
        const i = code - first;
        return i >= 0 && i < count ? valid(r.u16(20 + 2 * i)) : 0;
      };
      return {
        get,
        *each() {
          for (let i = 0; i < count && first + i <= 0x10ffff; i++) {
            const g = valid(r.u16(20 + 2 * i));
            if (g) yield [first + i, g];
          }
        },
      };
    }
    case 4:
      return format4(r, valid);
    case 12:
    case 13:
      return format12(r, valid, format === 13);
    default:
      return r.fail(`unsupported cmap format ${format}`);
  }
}

function format4(r: Reader, valid: (gid: number) => number): Raw {
  // The 16-bit length field overflows in large subtables, so bounds come from
  // the segment count and the end of the cmap table instead.
  const segCount = r.u16(6) >>> 1;
  if (segCount === 0) r.fail("format 4 subtable has no segments");
  const endBase = 14;
  const startBase = endBase + 2 * segCount + 2;
  const deltaBase = startBase + 2 * segCount;
  const rangeBase = deltaBase + 2 * segCount;
  r.check(endBase, rangeBase + 2 * segCount - endBase);

  const glyphAt = (i: number, code: number): number => {
    const rangeOffset = r.u16(rangeBase + 2 * i);
    const delta = r.u16(deltaBase + 2 * i);
    if (rangeOffset === 0) return valid((code + delta) & 0xffff);
    const addr = rangeBase + 2 * i + rangeOffset + 2 * (code - r.u16(startBase + 2 * i));
    if (!r.has(addr, 2)) return 0;
    const g = r.u16(addr);
    return g === 0 ? 0 : valid((g + delta) & 0xffff);
  };

  return {
    get(code: number): number {
      if (code < 0 || code > 0xffff) return 0;
      let lo = 0;
      let hi = segCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (r.u16(endBase + 2 * mid) < code) lo = mid + 1;
        else hi = mid;
      }
      if (r.u16(endBase + 2 * lo) < code || r.u16(startBase + 2 * lo) > code) return 0;
      return glyphAt(lo, code);
    },
    *each() {
      let next = 0;
      for (let i = 0; i < segCount; i++) {
        const end = r.u16(endBase + 2 * i);
        const start = Math.max(r.u16(startBase + 2 * i), next);
        for (let c = start; c <= end; c++) {
          const g = glyphAt(i, c);
          if (g) yield [c, g];
        }
        next = Math.max(next, end + 1);
      }
    },
  };
}

function format12(r: Reader, valid: (gid: number) => number, constant: boolean): Raw {
  const numGroups = r.u32(12);
  r.check(16, 12 * numGroups);
  const glyph = (i: number, code: number) => {
    const base = 16 + 12 * i;
    const g = r.u32(base + 8);
    return valid(constant ? g : g + (code - r.u32(base)));
  };
  return {
    get(code: number): number {
      let lo = 0;
      let hi = numGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const base = 16 + 12 * mid;
        if (code < r.u32(base)) hi = mid - 1;
        else if (code > r.u32(base + 4)) lo = mid + 1;
        else return glyph(mid, code);
      }
      return 0;
    },
    *each() {
      let next = 0;
      for (let i = 0; i < numGroups; i++) {
        const base = 16 + 12 * i;
        const end = Math.min(r.u32(base + 4), 0x10ffff);
        for (let c = Math.max(r.u32(base), next); c <= end; c++) {
          const g = glyph(i, c);
          if (g) yield [c, g];
        }
        next = Math.max(next, end + 1);
      }
    },
  };
}
