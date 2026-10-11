/**
 * Unicode Mathematical Alphanumeric Symbols: the code points for bold,
 * italic, script, fraktur, double-struck, sans-serif and monospace letters,
 * digits and Greek, with the holes the block leaves for characters encoded
 * earlier (the Letterlike Symbols block).
 */

type Variant = "bold" | "italic" | "bold-italic" | "script" | "bold-script" | "fraktur" | "double-struck" | "sans-serif" | "monospace" | "bold-fraktur" | "sans-serif-bold";

const LATIN: Record<Variant, [number, number] | null> = {
  bold: [0x1d400, 0x1d41a],
  italic: [0x1d434, 0x1d44e],
  "bold-italic": [0x1d468, 0x1d482],
  script: [0x1d49c, 0x1d4b6],
  "bold-script": [0x1d4d0, 0x1d4ea],
  fraktur: [0x1d504, 0x1d51e],
  "double-struck": [0x1d538, 0x1d552],
  "bold-fraktur": [0x1d56c, 0x1d586],
  "sans-serif": [0x1d5a0, 0x1d5ba],
  "sans-serif-bold": [0x1d5d4, 0x1d5ee],
  monospace: [0x1d670, 0x1d68a],
};

const DIGITS: Partial<Record<Variant, number>> = {
  bold: 0x1d7ce,
  "double-struck": 0x1d7d8,
  "sans-serif": 0x1d7e2,
  "sans-serif-bold": 0x1d7ec,
  monospace: 0x1d7f6,
};

/** Greek: [capitals start, lower-case start]. */
const GREEK: Partial<Record<Variant, [number, number]>> = {
  bold: [0x1d6a8, 0x1d6c2],
  italic: [0x1d6e2, 0x1d6fc],
  "bold-italic": [0x1d71c, 0x1d736],
  "sans-serif-bold": [0x1d756, 0x1d770],
};

const HOLES: Record<string, number> = {
  "italic:h": 0x210e,
  "script:B": 0x212c,
  "script:E": 0x2130,
  "script:F": 0x2131,
  "script:H": 0x210b,
  "script:I": 0x2110,
  "script:L": 0x2112,
  "script:M": 0x2133,
  "script:R": 0x211b,
  "script:e": 0x212f,
  "script:g": 0x210a,
  "script:o": 0x2134,
  "fraktur:C": 0x212d,
  "fraktur:H": 0x210c,
  "fraktur:I": 0x2111,
  "fraktur:R": 0x211c,
  "fraktur:Z": 0x2128,
  "double-struck:C": 0x2102,
  "double-struck:H": 0x210d,
  "double-struck:N": 0x2115,
  "double-struck:P": 0x2119,
  "double-struck:Q": 0x211a,
  "double-struck:R": 0x211d,
  "double-struck:Z": 0x2124,
};

const GREEK_LOWER_EXTRA: Record<number, number> = { 0x2202: 25, 0x3f5: 26, 0x3d1: 27, 0x3f0: 28, 0x3d5: 29, 0x3f1: 30, 0x3d6: 31 };

/** The styled character for `ch` in a math variant, or `ch` itself when the block has none. */
export function styledChar(ch: string, variant: Variant): string {
  const hole = HOLES[`${variant}:${ch}`];
  if (hole) return String.fromCodePoint(hole);
  const c = ch.codePointAt(0)!;
  const latin = LATIN[variant];
  if (latin) {
    if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(latin[0] + c - 0x41);
    if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(latin[1] + c - 0x61);
  }
  const dig = DIGITS[variant];
  if (dig !== undefined && c >= 0x30 && c <= 0x39) return String.fromCodePoint(dig + c - 0x30);
  const greek = GREEK[variant];
  if (greek) {
    if (c >= 0x391 && c <= 0x3a9 && c !== 0x3a2) return String.fromCodePoint(greek[0] + c - 0x391);
    if (c === 0x3f4) return String.fromCodePoint(greek[0] + 17);
    if (c === 0x2207) return String.fromCodePoint(greek[0] + 25);
    if (c >= 0x3b1 && c <= 0x3c9) return String.fromCodePoint(greek[1] + c - 0x3b1);
    const extra = GREEK_LOWER_EXTRA[c];
    if (extra !== undefined) return String.fromCodePoint(greek[1] + extra);
  }
  return ch;
}

export type { Variant as MathVariant };
