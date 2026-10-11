/**
 * ToUnicode CMaps: from the two-byte codes a Type0 font draws with back to
 * the text each glyph stood for, so copy-paste and search work.
 */

import { hex4, wellFormed } from "./serialize.js";

/** At most this many UTF-16 code units per glyph (the CMap limit is 512 bytes). */
const MAX_UNITS = 256;
/** Entries per beginbfchar/beginbfrange block (a PDF limit). */
const BLOCK = 100;

function utf16Hex(text: string): string {
  let s = wellFormed(text);
  if (s.length > MAX_UNITS) {
    let cut = MAX_UNITS;
    const c = s.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--; // do not split a surrogate pair
    s = s.slice(0, cut);
  }
  let out = "";
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i));
  return out;
}

/**
 * A ToUnicode CMap for `map` (code -> text). Runs of three or more codes whose
 * text is one BMP character, increasing by one with the code and staying in
 * one 256-code row on both sides, become bfrange entries; the rest bfchar.
 */
export function toUnicodeCMap(map: ReadonlyMap<number, string>): string {
  const codes = [...map.keys()].filter((c) => (map.get(c) ?? "") !== "").sort((a, b) => a - b);
  const singles: string[] = [];
  const ranges: string[] = [];
  const unit = (code: number): number => {
    const t = map.get(code)!;
    if (t.length !== 1) return -1;
    const u = t.charCodeAt(0);
    return u >= 0xd800 && u <= 0xdfff ? -1 : u;
  };
  let i = 0;
  while (i < codes.length) {
    const c0 = codes[i];
    const u0 = unit(c0);
    let j = i + 1;
    if (u0 >= 0) {
      while (
        j < codes.length &&
        codes[j] === c0 + (j - i) &&
        codes[j] >> 8 === c0 >> 8 &&
        unit(codes[j]) === u0 + (j - i) &&
        (u0 + (j - i)) >> 8 === u0 >> 8
      ) {
        j++;
      }
    }
    if (j - i >= 3) {
      ranges.push(`<${hex4(c0)}> <${hex4(codes[j - 1])}> <${hex4(u0)}>`);
      i = j;
    } else {
      singles.push(`<${hex4(c0)}> <${utf16Hex(map.get(c0)!)}>`);
      i++;
    }
  }
  let body = "";
  for (let k = 0; k < singles.length; k += BLOCK) {
    const part = singles.slice(k, k + BLOCK);
    body += `${part.length} beginbfchar\n${part.join("\n")}\nendbfchar\n`;
  }
  for (let k = 0; k < ranges.length; k += BLOCK) {
    const part = ranges.slice(k, k + BLOCK);
    body += `${part.length} beginbfrange\n${part.join("\n")}\nendbfrange\n`;
  }
  return (
    "/CIDInit /ProcSet findresource begin\n" +
    "12 dict begin\n" +
    "begincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n" +
    "/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    body +
    "endcmap\n" +
    "CMapName currentdict /CMap defineresource pop\n" +
    "end\n" +
    "end\n"
  );
}
