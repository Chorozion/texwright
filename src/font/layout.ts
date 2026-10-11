/**
 * The parts of OpenType layout a typesetter needs for Latin text: pair
 * kerning (GPOS lookup type 2 under the 'kern' feature, or the legacy 'kern'
 * table) and standard ligatures (GSUB lookup type 4 under 'liga').
 *
 * Script and language: DFLT, then 'latn', then the font's first script,
 * taking the first that has the feature; within it the default language
 * system, else the first one listed. Lookups are located once; each query
 * reads coverage and pair data in place.
 */

import { Reader } from "./reader.js";

// ---------------------------------------------------------------------------
// Common tables

/** Coverage index of a glyph, or -1. */
export function coverageIndex(r: Reader, off: number, gid: number): number {
  const format = r.u16(off);
  if (format === 1) {
    const count = r.u16(off + 2);
    r.check(off + 4, 2 * count);
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const g = r.u16(off + 4 + 2 * mid);
      if (g < gid) lo = mid + 1;
      else if (g > gid) hi = mid - 1;
      else return mid;
    }
    return -1;
  }
  if (format === 2) {
    const count = r.u16(off + 2);
    r.check(off + 4, 6 * count);
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const rec = off + 4 + 6 * mid;
      if (gid < r.u16(rec)) hi = mid - 1;
      else if (gid > r.u16(rec + 2)) lo = mid + 1;
      else return r.u16(rec + 4) + gid - r.u16(rec);
    }
    return -1;
  }
  return r.fail(`unknown coverage format ${format} at offset ${off}`);
}

/** Class of a glyph in a ClassDef table (0 when unlisted). */
export function glyphClass(r: Reader, off: number, gid: number): number {
  const format = r.u16(off);
  if (format === 1) {
    const start = r.u16(off + 2);
    const count = r.u16(off + 4);
    const i = gid - start;
    return i >= 0 && i < count ? r.u16(off + 6 + 2 * i) : 0;
  }
  if (format === 2) {
    const count = r.u16(off + 2);
    r.check(off + 4, 6 * count);
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const rec = off + 4 + 6 * mid;
      if (gid < r.u16(rec)) hi = mid - 1;
      else if (gid > r.u16(rec + 2)) lo = mid + 1;
      else return r.u16(rec + 4);
    }
    return 0;
  }
  return r.fail(`unknown class definition format ${format} at offset ${off}`);
}

function popcount(n: number): number {
  let c = 0;
  for (let v = n & 0xffff; v; v &= v - 1) c++;
  return c;
}

/** Size in bytes of a GPOS ValueRecord. */
function valueSize(format: number): number {
  return 2 * popcount(format & 0xff);
}

/** XAdvance from a ValueRecord at `off`, or 0 when the format has none. */
function xAdvance(r: Reader, off: number, format: number): number {
  if (!(format & 0x0004)) return 0;
  return r.i16(off + 2 * popcount(format & 0x0003));
}

/** A lookup's subtables, with extension subtables resolved. */
export interface Lookup {
  readonly type: number;
  readonly flag: number;
  /** Absolute offsets of the subtables within the GSUB/GPOS table. */
  readonly subtables: readonly number[];
}

/**
 * Lookups of one feature, in lookup list order, keeping only those whose
 * (resolved) type is `wantType`. Scripts are tried in the order DFLT, latn,
 * then the font's first script, and the first that has the feature wins;
 * within a script, the default language system, else the first one listed.
 */
export function featureLookups(r: Reader, featureTag: string, wantType: number, extensionType: number): Lookup[] {
  if (r.length < 10) r.fail("table header too short");
  const major = r.u16(0);
  if (major !== 1) r.fail(`unsupported version ${major}.${r.u16(2)}`);
  const scriptList = r.u16(4);
  const featureList = r.u16(6);
  const lookupList = r.u16(8);
  if (!scriptList || !featureList || !lookupList) return [];

  const scriptCount = r.u16(scriptList);
  r.check(scriptList + 2, 6 * scriptCount);
  const tags: string[] = [];
  for (let i = 0; i < scriptCount; i++) tags.push(r.tag(scriptList + 2 + 6 * i));
  const order: number[] = [];
  for (const want of ["DFLT", "latn"]) {
    const i = tags.indexOf(want);
    if (i >= 0) order.push(i);
  }
  if (scriptCount > 0 && !order.includes(0)) order.push(0);
  for (const script of order) {
    const indices = scriptLookupIndices(r, scriptList, featureList, script, featureTag);
    if (indices.size) return resolveLookups(r, lookupList, indices, wantType, extensionType);
  }
  return [];
}

/** Lookup indices of a feature under one script's language system. */
function scriptLookupIndices(r: Reader, scriptList: number, featureList: number, script: number, featureTag: string): Set<number> {
  const lookupIndices = new Set<number>();
  const scriptOff = scriptList + r.u16(scriptList + 2 + 6 * script + 4);
  let langSys = r.u16(scriptOff);
  if (langSys) langSys += scriptOff;
  else {
    const langCount = r.u16(scriptOff + 2);
    if (langCount === 0) return lookupIndices;
    langSys = scriptOff + r.u16(scriptOff + 4 + 4);
  }
  const featureCount = r.u16(featureList);
  r.check(featureList + 2, 6 * featureCount);
  const featureIndexCount = r.u16(langSys + 4);
  r.check(langSys + 6, 2 * featureIndexCount);
  for (let i = 0; i < featureIndexCount; i++) {
    const fi = r.u16(langSys + 6 + 2 * i);
    if (fi >= featureCount) continue;
    const rec = featureList + 2 + 6 * fi;
    if (r.tag(rec) !== featureTag) continue;
    const feature = featureList + r.u16(rec + 4);
    const n = r.u16(feature + 2);
    r.check(feature + 4, 2 * n);
    for (let k = 0; k < n; k++) lookupIndices.add(r.u16(feature + 4 + 2 * k));
  }
  return lookupIndices;
}

function resolveLookups(r: Reader, lookupList: number, indices: Set<number>, wantType: number, extensionType: number): Lookup[] {
  const lookupCount = r.u16(lookupList);
  r.check(lookupList + 2, 2 * lookupCount);
  const out: Lookup[] = [];
  for (const li of [...indices].sort((a, b) => a - b)) {
    if (li >= lookupCount) continue;
    const lookup = lookupList + r.u16(lookupList + 2 + 2 * li);
    let type = r.u16(lookup);
    const flag = r.u16(lookup + 2);
    const subCount = r.u16(lookup + 4);
    r.check(lookup + 6, 2 * subCount);
    const subtables: number[] = [];
    for (let s = 0; s < subCount; s++) {
      let sub = lookup + r.u16(lookup + 6 + 2 * s);
      if (type === extensionType) {
        // Extension: format, real lookup type, 32-bit offset.
        if (r.u16(sub) !== 1) continue;
        const realType = r.u16(sub + 2);
        if (realType !== wantType) continue;
        sub += r.u32(sub + 4);
        r.check(sub, 2);
        subtables.push(sub);
      } else if (type === wantType) {
        subtables.push(sub);
      }
    }
    if (type === extensionType) type = wantType;
    if (type === wantType && subtables.length) out.push({ type, flag, subtables });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GPOS pair kerning

/**
 * Horizontal advance adjustment from one PairPos subtable, or undefined when
 * the subtable does not apply to the pair (so the next subtable is tried).
 */
function pairAdjustment(r: Reader, sub: number, left: number, right: number): number | undefined {
  const format = r.u16(sub);
  const cov = coverageIndex(r, sub + r.u16(sub + 2), left);
  if (cov < 0) return undefined;
  const vf1 = r.u16(sub + 4);
  const vf2 = r.u16(sub + 6);
  const size1 = valueSize(vf1);
  const size2 = valueSize(vf2);
  if (format === 1) {
    const setCount = r.u16(sub + 8);
    if (cov >= setCount) return undefined;
    const set = sub + r.u16(sub + 10 + 2 * cov);
    const count = r.u16(set);
    const recSize = 2 + size1 + size2;
    r.check(set + 2, recSize * count);
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const rec = set + 2 + recSize * mid;
      const g = r.u16(rec);
      if (g < right) lo = mid + 1;
      else if (g > right) hi = mid - 1;
      else return xAdvance(r, rec + 2, vf1);
    }
    return undefined;
  }
  if (format === 2) {
    const class1Count = r.u16(sub + 12);
    const class2Count = r.u16(sub + 14);
    const c1 = glyphClass(r, sub + r.u16(sub + 8), left);
    const c2 = glyphClass(r, sub + r.u16(sub + 10), right);
    if (c1 >= class1Count || c2 >= class2Count) return undefined;
    const rec = sub + 16 + (c1 * class2Count + c2) * (size1 + size2);
    return xAdvance(r, rec, vf1);
  }
  return undefined;
}

export class GposKerning {
  private readonly r: Reader;
  readonly lookups: Lookup[];

  constructor(r: Reader) {
    this.r = r;
    this.lookups = featureLookups(r, "kern", 2, 9);
  }

  get empty(): boolean {
    return this.lookups.length === 0;
  }

  /** Sum over lookups; within a lookup the first subtable that applies wins. */
  kern(left: number, right: number): number {
    let total = 0;
    for (const lookup of this.lookups) {
      for (const sub of lookup.subtables) {
        const v = pairAdjustment(this.r, sub, left, right);
        if (v !== undefined) {
          total += v;
          break;
        }
      }
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Legacy 'kern' table (Microsoft version 0 and Apple version 1, format 0)

interface KernSubtable {
  /** Offset of the first pair. */
  readonly pairs: number;
  readonly count: number;
  readonly override: boolean;
}

export class KernTable {
  private readonly r: Reader;
  private readonly subtables: KernSubtable[] = [];

  constructor(r: Reader) {
    this.r = r;
    if (r.length < 4) return;
    const apple = r.u16(0) === 1 && r.u16(2) === 0;
    const nTables = apple ? r.u32(4) : r.u16(2);
    let p = apple ? 8 : 4;
    for (let t = 0; t < nTables && p < r.length; t++) {
      let length: number;
      let format: number;
      let horizontal: boolean;
      let usable: boolean;
      let override = false;
      let body: number;
      if (apple) {
        length = r.u32(p);
        const coverage = r.u16(p + 4);
        format = coverage & 0xff;
        horizontal = !(coverage & 0x8000);
        usable = horizontal && !(coverage & 0x4000) && !(coverage & 0x2000);
        body = p + 8;
      } else {
        length = r.u16(p + 2);
        const coverage = r.u16(p + 4);
        format = coverage >> 8;
        horizontal = (coverage & 1) !== 0;
        usable = horizontal && !(coverage & 2) && !(coverage & 4);
        override = (coverage & 8) !== 0;
        body = p + 6;
      }
      if (format === 0) {
        const count = r.u16(body);
        r.check(body + 8, 6 * count);
        if (usable) this.subtables.push({ pairs: body + 8, count, override });
        // The 16-bit length overflows for big subtables; trust the pair count.
        p = body + 8 + 6 * count;
      } else {
        if (length < 6) break;
        p += length;
      }
    }
  }

  get empty(): boolean {
    return this.subtables.length === 0;
  }

  kern(left: number, right: number): number {
    const key = left * 65536 + right;
    let total = 0;
    for (const s of this.subtables) {
      let lo = 0;
      let hi = s.count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const rec = s.pairs + 6 * mid;
        const k = this.r.u32(rec);
        if (k < key) lo = mid + 1;
        else if (k > key) hi = mid - 1;
        else {
          const v = this.r.i16(rec + 4);
          total = s.override ? v : total + v;
          break;
        }
      }
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// GSUB ligatures

export interface LigatureResult {
  /** Glyphs after substitution. */
  readonly glyphs: number[];
  /** For each output glyph, how many input glyphs it replaces (1 for unchanged glyphs). */
  readonly counts: number[];
}

export class GsubLigatures {
  private readonly r: Reader;
  private readonly numGlyphs: number;
  private budget = 0;
  readonly lookups: Lookup[];

  constructor(r: Reader, numGlyphs: number, feature = "liga") {
    this.r = r;
    this.numGlyphs = numGlyphs;
    this.lookups = featureLookups(r, feature, 4, 7);
  }

  get empty(): boolean {
    return this.lookups.length === 0;
  }

  apply(input: readonly number[]): LigatureResult {
    let glyphs = [...input];
    let counts = glyphs.map(() => 1);
    // A hostile GSUB could make every position try thousands of long
    // ligatures; past this budget the table is treated as broken.
    this.budget = 1_000_000 + 2_000 * glyphs.length;
    for (const lookup of this.lookups) {
      const outGlyphs: number[] = [];
      const outCounts: number[] = [];
      let i = 0;
      while (i < glyphs.length) {
        const match = this.matchAt(lookup, glyphs, i);
        if (match) {
          outGlyphs.push(match.glyph);
          let c = 0;
          for (let k = 0; k < match.length; k++) c += counts[i + k];
          outCounts.push(c);
          i += match.length;
        } else {
          outGlyphs.push(glyphs[i]);
          outCounts.push(counts[i]);
          i++;
        }
      }
      glyphs = outGlyphs;
      counts = outCounts;
    }
    return { glyphs, counts };
  }

  /** First ligature in the first applicable subtable starting at position i. */
  private matchAt(lookup: Lookup, glyphs: readonly number[], i: number): { glyph: number; length: number } | undefined {
    const r = this.r;
    for (const sub of lookup.subtables) {
      if (r.u16(sub) !== 1) continue;
      const cov = coverageIndex(r, sub + r.u16(sub + 2), glyphs[i]);
      if (cov < 0) continue;
      const setCount = r.u16(sub + 4);
      if (cov >= setCount) continue;
      const set = sub + r.u16(sub + 6 + 2 * cov);
      const ligCount = r.u16(set);
      r.check(set + 2, 2 * ligCount);
      for (let k = 0; k < ligCount; k++) {
        const lig = set + r.u16(set + 2 + 2 * k);
        const glyph = r.u16(lig);
        const compCount = r.u16(lig + 2);
        if (compCount < 1 || i + compCount > glyphs.length || glyph >= this.numGlyphs) continue;
        r.check(lig + 4, 2 * (compCount - 1));
        this.budget -= compCount;
        if (this.budget < 0) r.fail("ligature lookups exceed the work budget");
        let ok = true;
        for (let j = 1; j < compCount && ok; j++) ok = r.u16(lig + 4 + 2 * (j - 1)) === glyphs[i + j];
        if (ok) return { glyph, length: compCount };
      }
    }
    return undefined;
  }
}
