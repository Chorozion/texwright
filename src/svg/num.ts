/**
 * Number scanning shared by the path, transform, points and length parsers.
 * Hand-written so every list is read in one forward pass.
 */

export function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

export function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
}

/**
 * Reads an SVG/CSS number at `i` (sign, digits, fraction, exponent).
 * Returns the end offset, or -1 when there is no number at `i`.
 */
export function scanNumber(s: string, i: number): number {
  const n = s.length;
  let k = i;
  let c = s.charCodeAt(k);
  if (c === 0x2b || c === 0x2d) c = s.charCodeAt(++k);
  let digits = 0;
  while (k < n && isDigit(c)) {
    digits++;
    c = s.charCodeAt(++k);
  }
  if (c === 0x2e /* . */) {
    c = s.charCodeAt(++k);
    while (k < n && isDigit(c)) {
      digits++;
      c = s.charCodeAt(++k);
    }
  }
  if (digits === 0) return -1;
  if (c === 0x65 || c === 0x45) {
    // exponent only if digits follow (so "1em" stays a number plus a unit)
    let e = k + 1;
    let d = s.charCodeAt(e);
    if (d === 0x2b || d === 0x2d) d = s.charCodeAt(++e);
    if (isDigit(d)) {
      while (e < n && isDigit(s.charCodeAt(e))) e++;
      k = e;
    }
  }
  return k;
}

/** A cursor over a string of numbers separated by whitespace and/or one comma. */
export class NumberReader {
  i = 0;
  constructor(readonly s: string) {}

  /** Skips whitespace and at most one comma. */
  skipSep(): void {
    const s = this.s;
    while (this.i < s.length && isSpace(s.charCodeAt(this.i))) this.i++;
    if (s.charCodeAt(this.i) === 0x2c) {
      this.i++;
      while (this.i < s.length && isSpace(s.charCodeAt(this.i))) this.i++;
    }
  }

  skipSpace(): void {
    const s = this.s;
    while (this.i < s.length && isSpace(s.charCodeAt(this.i))) this.i++;
  }

  atEnd(): boolean {
    return this.i >= this.s.length;
  }

  /** The next number, or undefined (cursor unchanged) when none is there. */
  number(): number | undefined {
    const end = scanNumber(this.s, this.i);
    if (end < 0) return undefined;
    const v = Number(this.s.slice(this.i, end));
    if (!Number.isFinite(v)) return undefined;
    this.i = end;
    return v;
  }
}

/** All numbers in a whitespace/comma separated list; stops at the first thing that is not a number. */
export function parseNumberList(s: string, max = Infinity): number[] {
  const r = new NumberReader(s);
  const out: number[] = [];
  r.skipSpace();
  while (!r.atEnd() && out.length < max) {
    const v = r.number();
    if (v === undefined) break;
    out.push(v);
    r.skipSep();
  }
  return out;
}
