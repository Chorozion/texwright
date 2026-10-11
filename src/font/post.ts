/**
 * Glyph names from the post table: format 1.0 (the standard Macintosh
 * order), 2.0 (indices into the standard names plus Pascal strings) and the
 * deprecated 2.5 (offsets into the standard order). Format 3.0 has no names.
 */

import { STANDARD_GLYPH_NAMES } from "./encodings.js";
import { Reader } from "./reader.js";

export class GlyphNames {
  private readonly r: Reader;
  private readonly version: number;
  private readonly numGlyphs: number;
  private custom?: string[];
  private byName?: Map<string, number>;

  constructor(r: Reader, numGlyphs: number) {
    this.r = r;
    this.version = r.u32(0);
    this.numGlyphs = numGlyphs;
    if (this.version === 0x00020000) {
      const n = r.u16(32);
      r.check(34, 2 * n);
    } else if (this.version === 0x00025000) {
      const n = r.u16(32);
      r.check(34, n);
    }
  }

  get hasNames(): boolean {
    return this.version === 0x00010000 || this.version === 0x00020000 || this.version === 0x00025000;
  }

  name(gid: number): string | undefined {
    if (!(gid >= 0 && gid < this.numGlyphs) || !Number.isInteger(gid)) return undefined;
    const r = this.r;
    switch (this.version) {
      case 0x00010000:
        return STANDARD_GLYPH_NAMES[gid];
      case 0x00020000: {
        if (gid >= r.u16(32)) return undefined;
        const index = r.u16(34 + 2 * gid);
        if (index < 258) return STANDARD_GLYPH_NAMES[index];
        return this.customNames()[index - 258];
      }
      case 0x00025000: {
        if (gid >= r.u16(32)) return undefined;
        return STANDARD_GLYPH_NAMES[gid + r.i8(34 + gid)];
      }
      default:
        return undefined;
    }
  }

  /** Glyph id for a name (the lowest when several glyphs share it), or 0. */
  glyph(name: string): number {
    if (!this.byName) {
      this.byName = new Map();
      if (this.hasNames) {
        for (let gid = this.numGlyphs - 1; gid >= 0; gid--) {
          const n = this.name(gid);
          if (n !== undefined) this.byName.set(n, gid);
        }
      }
    }
    return this.byName.get(name) ?? 0;
  }

  /** The Pascal strings after the index array of a format 2.0 table. */
  private customNames(): string[] {
    if (!this.custom) {
      const r = this.r;
      const names: string[] = [];
      let p = 34 + 2 * r.u16(32);
      while (p < r.length) {
        const len = r.u8(p);
        if (!r.has(p + 1, len)) break;
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(r.bytes[p + 1 + i]);
        names.push(s);
        p += 1 + len;
      }
      this.custom = names;
    }
    return this.custom;
  }
}
