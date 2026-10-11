/**
 * Static data: the Mac OS Roman character set (for platform 1 cmap
 * subtables and name records) and the 258 standard Macintosh glyph names
 * that post table formats 1.0, 2.0 and 2.5 refer to by index.
 */

/** Unicode values of Mac OS Roman bytes 0x80..0xFF. */
const MAC_ROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3, 0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab, 0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

let macRomanReverse: Map<number, number> | undefined;

/** Unicode code point of a Mac OS Roman byte. */
export function macRomanToUnicode(byte: number): number {
  return byte < 0x80 ? byte : MAC_ROMAN_HIGH[byte - 0x80] ?? 0xfffd;
}

/** Mac OS Roman byte for a code point, or -1 when it has none. */
export function unicodeToMacRoman(cp: number): number {
  if (cp < 0x80) return cp;
  if (!macRomanReverse) {
    macRomanReverse = new Map();
    MAC_ROMAN_HIGH.forEach((u, i) => macRomanReverse!.set(u, 0x80 + i));
  }
  return macRomanReverse.get(cp) ?? -1;
}

/** Decodes Mac OS Roman bytes. */
export function decodeMacRoman(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(macRomanToUnicode(b));
  return s;
}

/** Decodes UTF-16BE bytes (an odd trailing byte is dropped). */
export function decodeUtf16be(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

/** The standard Macintosh glyph order (post table formats 1.0 and 2.0). */
export const STANDARD_GLYPH_NAMES: readonly string[] = (
  ".notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle " +
  "parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven " +
  "eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V " +
  "W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o " +
  "p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde " +
  "Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave " +
  "ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis " +
  "otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph " +
  "germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus " +
  "lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine " +
  "Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft " +
  "guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash quotedblleft " +
  "quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency " +
  "guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand " +
  "Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute " +
  "Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent " +
  "ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron brokenbar Eth eth " +
  "Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter " +
  "threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat"
).split(" ");
