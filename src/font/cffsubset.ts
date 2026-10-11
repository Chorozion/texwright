/**
 * CFF (version 1) subsetting for PDF embedding, keeping glyph ids.
 *
 * Every glyph slot stays, so CIDs and glyph ids in the PDF are unchanged. A
 * glyph the document does not use becomes a one-byte `endchar`, and a
 * subroutine none of the kept glyphs calls becomes a one-byte `return`, so
 * subroutine numbering is untouched too. Which subroutines are called is found
 * by tracing the Type 2 charstrings of the kept glyphs. A charstring that
 * computes a subroutine number with arithmetic (allowed, never seen in
 * practice) makes the tracer give up, and then every subroutine is kept.
 *
 * Name-keyed and CID-keyed fonts are both handled. The Encoding is dropped
 * (OpenType and PDF CIDFonts select glyphs by id, never by the CFF encoding);
 * charset and FDSelect are copied as they are.
 */

import { FontError } from "./errors.js";

const ENDCHAR = new Uint8Array([14]);
const RETURN = new Uint8Array([11]);

// Top DICT, Font DICT and Private DICT operators that hold offsets.
const OP_CHARSET = 15;
const OP_ENCODING = 16;
const OP_CHARSTRINGS = 17;
const OP_PRIVATE = 18;
const OP_SUBRS = 19;
const OP_ROS = 0x0c1e;
const OP_CHARSTRING_TYPE = 0x0c06;
const OP_FDARRAY = 0x0c24;
const OP_FDSELECT = 0x0c25;

/** Most charstring bytes the tracer will interpret per glyph (subroutines included). */
const TRACE_BUDGET = 1 << 20;

class Reader {
  constructor(readonly b: Uint8Array) {}
  u8(p: number): number {
    if (p < 0 || p >= this.b.length) throw new FontError(`CFF: offset ${p} is outside the table`);
    return this.b[p]!;
  }
  u16(p: number): number {
    return (this.u8(p) << 8) | this.u8(p + 1);
  }
  off(p: number, size: number): number {
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + this.u8(p + k);
    return v;
  }
}

interface Index {
  start: number;
  end: number;
  items: Uint8Array[];
}

function readIndex(r: Reader, pos: number): Index {
  const count = r.u16(pos);
  if (count === 0) return { start: pos, end: pos + 2, items: [] };
  const offSize = r.u8(pos + 2);
  if (offSize < 1 || offSize > 4) throw new FontError(`CFF: INDEX offSize ${offSize} at ${pos}`);
  const offsetsAt = pos + 3;
  const dataBase = offsetsAt + (count + 1) * offSize - 1;
  const items: Uint8Array[] = [];
  let prev = r.off(offsetsAt, offSize);
  if (prev !== 1) throw new FontError(`CFF: INDEX at ${pos} does not start at offset 1`);
  for (let i = 1; i <= count; i++) {
    const next = r.off(offsetsAt + i * offSize, offSize);
    if (next < prev || dataBase + next > r.b.length) throw new FontError(`CFF: INDEX at ${pos} has a bad offset`);
    items.push(r.b.subarray(dataBase + prev, dataBase + next));
    prev = next;
  }
  return { start: pos, end: dataBase + prev, items };
}

function writeIndex(items: readonly Uint8Array[]): Uint8Array {
  if (!items.length) return new Uint8Array(2);
  let total = 1;
  for (const it of items) total += it.length;
  const offSize = total <= 0xff ? 1 : total <= 0xffff ? 2 : total <= 0xffffff ? 3 : 4;
  const out = new Uint8Array(3 + (items.length + 1) * offSize + total - 1);
  out[0] = items.length >> 8;
  out[1] = items.length & 0xff;
  out[2] = offSize;
  let off = 1;
  let p = 3;
  const put = (v: number) => {
    for (let k = offSize - 1; k >= 0; k--) out[p + k] = Math.floor(v / 256 ** (offSize - 1 - k)) & 0xff;
    p += offSize;
  };
  put(off);
  for (const it of items) {
    off += it.length;
    put(off);
  }
  for (const it of items) {
    out.set(it, p);
    p += it.length;
  }
  return out;
}

interface DictEntry {
  op: number;
  /** Operand values (reals are parsed only roughly; offsets are always integers). */
  operands: number[];
  /** The entry's original bytes, operands and operator. */
  raw: Uint8Array;
}

function readDict(b: Uint8Array): DictEntry[] {
  const r = new Reader(b);
  const out: DictEntry[] = [];
  let operands: number[] = [];
  let start = 0;
  let p = 0;
  while (p < b.length) {
    const b0 = r.u8(p);
    if (b0 <= 21) {
      let op = b0;
      p++;
      if (b0 === 12) {
        op = 0x0c00 | r.u8(p);
        p++;
      }
      out.push({ op, operands, raw: b.subarray(start, p) });
      operands = [];
      start = p;
    } else if (b0 === 28) {
      operands.push(((r.u16(p + 1) << 16) >> 16));
      p += 3;
    } else if (b0 === 29) {
      operands.push((r.u16(p + 1) << 16) | r.u16(p + 3));
      p += 5;
    } else if (b0 === 30) {
      // Real number: nibbles up to an 0xf terminator. The value is not needed.
      p++;
      for (;;) {
        const v = r.u8(p++);
        if ((v & 0x0f) === 0x0f || (v & 0xf0) === 0xf0) break;
      }
      operands.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + r.u8(p + 1) + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - r.u8(p + 1) - 108);
      p += 2;
    } else {
      throw new FontError(`CFF: reserved DICT byte ${b0}`);
    }
  }
  return out;
}

function int5(v: number): number[] {
  return [29, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function opBytes(op: number): number[] {
  return op > 0xff ? [12, op & 0xff] : [op];
}

/** A DICT with some operators replaced by fixed-size integer operands; others copied as they were. */
function writeDict(entries: readonly DictEntry[], replace: ReadonlyMap<number, readonly number[]>, drop: ReadonlySet<number> = new Set()): Uint8Array {
  const bytes: number[] = [];
  // ROS must stay first in a CID font's Top DICT.
  for (const e of entries) {
    if (drop.has(e.op)) continue;
    const values = replace.get(e.op);
    if (values) {
      for (const v of values) bytes.push(...int5(v));
      bytes.push(...opBytes(e.op));
    } else {
      for (const x of e.raw) bytes.push(x);
    }
  }
  return new Uint8Array(bytes);
}

function subrBias(count: number): number {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

/** Records the subroutines a charstring calls; false when it cannot tell. */
function trace(cs: Uint8Array, local: readonly Uint8Array[], global: readonly Uint8Array[], usedLocal: Set<number>, usedGlobal: Set<number>): boolean {
  const stack: number[] = [];
  let stems = 0;
  let budget = TRACE_BUDGET;
  let ended = false;
  const run = (code: Uint8Array, depth: number): boolean => {
    if (depth > 10) return false;
    let p = 0;
    while (p < code.length) {
      if (--budget < 0) return false;
      const b0 = code[p]!;
      if (b0 >= 32) {
        if (b0 <= 246) {
          stack.push(b0 - 139);
          p++;
        } else if (b0 <= 250) {
          stack.push((b0 - 247) * 256 + (code[p + 1] ?? 0) + 108);
          p += 2;
        } else if (b0 <= 254) {
          stack.push(-(b0 - 251) * 256 - (code[p + 1] ?? 0) - 108);
          p += 2;
        } else {
          stack.push(0); // 16.16 fixed: never a subroutine number
          p += 5;
        }
        continue;
      }
      if (b0 === 28) {
        stack.push((((code[p + 1] ?? 0) << 24) | ((code[p + 2] ?? 0) << 16)) >> 16);
        p += 3;
        continue;
      }
      p++;
      switch (b0) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          stems += stack.length >> 1;
          stack.length = 0;
          break;
        case 19: // hintmask
        case 20: // cntrmask
          stems += stack.length >> 1;
          stack.length = 0;
          p += (stems + 7) >> 3;
          break;
        case 10: // callsubr
        case 29: {
          // callgsubr
          const subrs = b0 === 10 ? local : global;
          const raw = stack.pop();
          if (raw === undefined || !Number.isInteger(raw)) return false;
          const i = raw + subrBias(subrs.length);
          if (i < 0 || i >= subrs.length) return false;
          (b0 === 10 ? usedLocal : usedGlobal).add(i);
          if (!run(subrs[i]!, depth + 1)) return false;
          if (ended) return true;
          break;
        }
        case 11: // return
          return true;
        case 14: // endchar
          ended = true;
          return true;
        case 12: {
          const b1 = code[p++] ?? 0;
          // Flex operators (34-37) draw; dotsection (0) is a no-op. Anything else is arithmetic or storage,
          // which could compute a subroutine number this tracer cannot follow.
          if (b1 === 0 || (b1 >= 34 && b1 <= 37)) stack.length = 0;
          else return false;
          break;
        }
        default:
          // Path construction, width and the other drawing operators clear the stack.
          stack.length = 0;
      }
    }
    return true;
  };
  return run(cs, 0);
}

function charsetLength(r: Reader, at: number, glyphs: number): number {
  const format = r.u8(at);
  if (format === 0) return 1 + 2 * (glyphs - 1);
  let p = at + 1;
  let covered = 1;
  while (covered < glyphs) {
    const left = format === 1 ? r.u8(p + 2) : r.u16(p + 2);
    p += format === 1 ? 3 : 4;
    covered += left + 1;
    if (format !== 1 && format !== 2) throw new FontError(`CFF: charset format ${format}`);
  }
  return p - at;
}

function fdSelectLength(r: Reader, at: number, glyphs: number): number {
  const format = r.u8(at);
  if (format === 0) return 1 + glyphs;
  if (format === 3) return 1 + 2 + 3 * r.u16(at + 1) + 2;
  throw new FontError(`CFF: FDSelect format ${format}`);
}

function fdOf(r: Reader, at: number, glyphs: number, gid: number): number {
  const format = r.u8(at);
  if (format === 0) return r.u8(at + 1 + gid);
  const n = r.u16(at + 1);
  for (let k = 0; k < n; k++) {
    const first = r.u16(at + 3 + 3 * k);
    const next = k + 1 < n ? r.u16(at + 3 + 3 * (k + 1)) : r.u16(at + 3 + 3 * n);
    if (gid >= first && gid < next) return r.u8(at + 3 + 3 * k + 2);
  }
  if (gid >= glyphs) throw new FontError(`CFF: glyph ${gid} has no FDSelect entry`);
  return 0;
}

interface PrivateInfo {
  entries: DictEntry[];
  subrs: Uint8Array[];
  usedSubrs: Set<number>;
}

function readPrivate(r: Reader, top: DictEntry[]): PrivateInfo | undefined {
  const priv = top.find((e) => e.op === OP_PRIVATE);
  if (!priv || priv.operands.length < 2) return undefined;
  const [size, offset] = priv.operands as [number, number];
  if (offset < 0 || size < 0 || offset + size > r.b.length) throw new FontError("CFF: Private DICT outside the table");
  const entries = readDict(r.b.subarray(offset, offset + size));
  const subrsEntry = entries.find((e) => e.op === OP_SUBRS);
  const subrs = subrsEntry ? readIndex(r, offset + subrsEntry.operands[0]!).items : [];
  return { entries, subrs, usedSubrs: new Set() };
}

/** Subset a CFF table to the given glyph ids (glyph 0 is always kept). */
export function subsetCff(cff: Uint8Array, gids: Iterable<number>): Uint8Array {
  const r = new Reader(cff);
  const major = r.u8(0);
  if (major !== 1) throw new FontError(`CFF: version ${major} is not CFF 1`);
  const hdrSize = r.u8(2);
  const names = readIndex(r, hdrSize);
  const topIndex = readIndex(r, names.end);
  if (topIndex.items.length !== 1) throw new FontError("CFF: only single-font CFF tables are supported");
  const strings = readIndex(r, topIndex.end);
  const gsubrs = readIndex(r, strings.end);
  const top = readDict(topIndex.items[0]!);
  const get = (op: number) => top.find((e) => e.op === op);
  const csType = get(OP_CHARSTRING_TYPE)?.operands[0] ?? 2;
  if (csType !== 2) throw new FontError(`CFF: charstring type ${csType} is not supported`);
  const csEntry = get(OP_CHARSTRINGS);
  if (!csEntry) throw new FontError("CFF: no CharStrings");
  const charStrings = readIndex(r, csEntry.operands[0]!);
  const glyphs = charStrings.items.length;

  const keep = new Set<number>([0]);
  for (const g of gids) {
    if (!Number.isInteger(g) || g < 0 || g >= glyphs) throw new FontError(`subset: glyph id ${g} is out of range (font has ${glyphs} glyphs)`);
    keep.add(g);
  }

  const cid = !!get(OP_ROS);
  let privates: PrivateInfo[];
  let fdEntries: DictEntry[][] = [];
  let fdSelectAt = -1;
  if (cid) {
    const fdArray = get(OP_FDARRAY);
    const fdSelect = get(OP_FDSELECT);
    if (!fdArray || !fdSelect) throw new FontError("CFF: CID font without FDArray or FDSelect");
    fdEntries = readIndex(r, fdArray.operands[0]!).items.map((d) => readDict(d));
    privates = fdEntries.map((d) => readPrivate(r, d) ?? { entries: [], subrs: [], usedSubrs: new Set() });
    fdSelectAt = fdSelect.operands[0]!;
  } else {
    privates = [readPrivate(r, top) ?? { entries: [], subrs: [], usedSubrs: new Set() }];
  }

  // Which subroutines the kept glyphs call.
  const usedGlobal = new Set<number>();
  let traced = true;
  for (const g of keep) {
    const fd = cid ? fdOf(r, fdSelectAt, glyphs, g) : 0;
    const priv = privates[fd];
    if (!priv) throw new FontError(`CFF: glyph ${g} selects missing Font DICT ${fd}`);
    if (!trace(charStrings.items[g]!, priv.subrs, gsubrs.items, priv.usedSubrs, usedGlobal)) traced = false;
  }
  const pruneSubrs = (subrs: readonly Uint8Array[], used: ReadonlySet<number>) => (traced ? subrs.map((s, i) => (used.has(i) ? s : RETURN)) : [...subrs]);

  // Pieces in output order.
  const header = new Uint8Array([1, 0, 4, 4]);
  const nameIndex = cff.subarray(names.start, names.end);
  const stringIndex = cff.subarray(strings.start, strings.end);
  const gsubrIndex = writeIndex(pruneSubrs(gsubrs.items, usedGlobal));
  const charsetEntry = get(OP_CHARSET);
  const charsetAt = charsetEntry?.operands[0] ?? 0;
  const charset = charsetAt > 2 ? cff.subarray(charsetAt, charsetAt + charsetLength(r, charsetAt, glyphs)) : undefined;
  const fdSelect = cid ? cff.subarray(fdSelectAt, fdSelectAt + fdSelectLength(r, fdSelectAt, glyphs)) : undefined;
  const charStringIndex = writeIndex(charStrings.items.map((cs, g) => (keep.has(g) ? cs : ENDCHAR)));
  const privateBlocks = privates.map((p) => {
    const subrs = p.subrs.length ? writeIndex(pruneSubrs(p.subrs, p.usedSubrs)) : undefined;
    // With fixed-size operands the DICT's size does not depend on the offset it holds.
    const sized = (subrsOffset: number) => writeDict(p.entries, subrs ? new Map([[OP_SUBRS, [subrsOffset]]]) : new Map());
    const dict = sized(sized(0).length);
    return { dict, subrs };
  });

  // Top DICT with placeholder offsets, to learn its size.
  const topReplace = (offs: { charset?: number; charStrings: number; priv?: [number, number]; fdArray?: number; fdSelect?: number }) => {
    const m = new Map<number, number[]>();
    if (offs.charset !== undefined) m.set(OP_CHARSET, [offs.charset]);
    m.set(OP_CHARSTRINGS, [offs.charStrings]);
    if (offs.priv) m.set(OP_PRIVATE, offs.priv);
    if (offs.fdArray !== undefined) m.set(OP_FDARRAY, [offs.fdArray]);
    if (offs.fdSelect !== undefined) m.set(OP_FDSELECT, [offs.fdSelect]);
    return writeDict(top, m, new Set([OP_ENCODING]));
  };
  const placeholder = {
    charset: charset ? 0 : undefined,
    charStrings: 0,
    priv: cid ? undefined : ([0, 0] as [number, number]),
    fdArray: cid ? 0 : undefined,
    fdSelect: cid ? 0 : undefined,
  };
  const topSize = writeIndex([topReplace(placeholder)]).length;

  let pos = header.length + nameIndex.length + topSize + stringIndex.length + gsubrIndex.length;
  const charsetPos = charset ? pos : undefined;
  if (charset) pos += charset.length;
  const fdSelectPos = fdSelect ? pos : undefined;
  if (fdSelect) pos += fdSelect.length;
  const charStringsPos = pos;
  pos += charStringIndex.length;

  // CID fonts: an FDArray of Font DICTs pointing at their Private DICTs, which follow it.
  let fdArrayIndex: Uint8Array | undefined;
  let fdArrayPos: number | undefined;
  const privatePos: number[] = [];
  if (cid) {
    fdArrayPos = pos;
    const fdDicts = (positions: number[]) =>
      fdEntries.map((d, k) => writeDict(d, new Map([[OP_PRIVATE, [privateBlocks[k]!.dict.length, positions[k] ?? 0]]])));
    const fdSize = writeIndex(fdDicts(privateBlocks.map(() => 0))).length;
    let pp = fdArrayPos + fdSize;
    for (const b of privateBlocks) {
      privatePos.push(pp);
      pp += b.dict.length + (b.subrs?.length ?? 0);
    }
    fdArrayIndex = writeIndex(fdDicts(privatePos));
    pos = pp;
  } else {
    privatePos.push(pos);
    pos += privateBlocks[0]!.dict.length + (privateBlocks[0]!.subrs?.length ?? 0);
  }

  const topDict = topReplace({
    charset: charsetPos,
    charStrings: charStringsPos,
    priv: cid ? undefined : [privateBlocks[0]!.dict.length, privatePos[0]!],
    fdArray: fdArrayPos,
    fdSelect: fdSelectPos,
  });
  const topIndexOut = writeIndex([topDict]);
  if (topIndexOut.length !== topSize) throw new FontError("CFF: Top DICT changed size while laying out (internal error)");

  const out = new Uint8Array(pos);
  let w = 0;
  const put = (b: Uint8Array | undefined) => {
    if (!b) return;
    out.set(b, w);
    w += b.length;
  };
  put(header);
  put(nameIndex);
  put(topIndexOut);
  put(stringIndex);
  put(gsubrIndex);
  put(charset);
  put(fdSelect);
  put(charStringIndex);
  put(fdArrayIndex);
  for (const b of privateBlocks) {
    put(b.dict);
    put(b.subrs);
  }
  if (w !== out.length) throw new FontError("CFF: subset size mismatch (internal error)");
  return out;
}
