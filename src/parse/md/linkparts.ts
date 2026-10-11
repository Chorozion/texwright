/**
 * The pieces links are made of (CommonMark spec sections 6.3, "Links", and
 * 4.7, "Link reference definitions"): labels, destinations and titles, plus
 * backslash escapes and character references, which they decode.
 */
import { namedEntity } from "./entities.js";
import type { LinkDef } from "./blocktree.js";

/** ASCII punctuation: what a backslash can escape (spec section 2.4). */
export function isAsciiPunct(code: number): boolean {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

const ENTITY_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));/;

/**
 * A character reference at `at` (spec section 2.5): its text and length, or
 * null. A numeric reference to a code point that is not a character, or to
 * a control character other than tab, line feed, form feed and carriage
 * return, gives U+FFFD in text; with `strict` (destinations, titles, info
 * strings) it is no reference and stays as written, as in the old reader.
 */
export function entityAt(s: string, at: number, strict = false): { text: string; length: number } | null {
  const m = ENTITY_RE.exec(s.slice(at, at + 40));
  if (!m) return null;
  if (m[3] !== undefined) {
    const named = namedEntity(m[3]);
    return named === undefined ? null : { text: named, length: m[0].length };
  }
  const code = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
  if (isCharacter(code)) return { text: String.fromCodePoint(code), length: m[0].length };
  return strict ? null : { text: "\ufffd", length: m[0].length };
}

function isCharacter(code: number): boolean {
  return !(
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0xfdd0 && code <= 0xfdef) ||
    (code & 0xfffe) === 0xfffe ||
    code <= 0x08 ||
    code === 0x0b ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

/** Resolve backslash escapes and character references, as destinations and titles need. */
export function unescapeText(s: string): string {
  if (!s.includes("\\") && !s.includes("&")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else if (c === 38) {
      const e = entityAt(s, i, true);
      if (e) {
        out += e.text;
        i += e.length - 1;
      } else out += "&";
    } else out += s[i];
  }
  return out;
}

/** Fold a link label for matching (spec: case-insensitive, inner whitespace collapsed). */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/[ \t\r\n]+/g, " ").toLowerCase().toUpperCase();
}

const isSpaceOrTab = (c: number): boolean => c === 32 || c === 9;

/**
 * A link label starting at the `[` at `at`: no unescaped brackets inside, at
 * most 999 characters, not blank. Returns the index after `]`, or -1; -2
 * when the text ends inside a label that could still be closed.
 */
function scanLabel(s: string, at: number, max = s.length): number {
  let i = at + 1;
  let blank = true;
  for (; i < max; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < max && isAsciiPunct(s.charCodeAt(i + 1))) {
      i++;
      blank = false;
      continue;
    }
    if (c === 91) return -1;
    if (c === 93) break;
    if (!(c === 32 || c === 9 || c === 10)) blank = false;
  }
  if (i - at - 1 > 999) return -1;
  if (i >= max) return -2;
  return blank ? -1 : i + 1;
}

/**
 * A link destination at `at` (spec 6.3): the raw text and the index after
 * it. In a link reference definition (`inDefinition`) a backslash does not
 * take a line ending along.
 */
export function scanDestination(s: string, at: number, max = s.length, inDefinition = false): { raw: string; end: number } | null {
  if (s.charCodeAt(at) === 60) {
    for (let i = at + 1; i < max; i++) {
      const c = s.charCodeAt(i);
      if (c === 92 && i + 1 < max && isAsciiPunct(s.charCodeAt(i + 1))) {
        i++;
        continue;
      }
      if (c === 10 || c === 60) return null;
      if (c === 62) return { raw: s.slice(at + 1, i), end: i + 1 };
    }
    return null;
  }
  // In a bare destination a backslash takes the next character along, whatever it is but a space (the
  // old reader's rule; only before punctuation does it escape it).
  let depth = 0;
  let i = at;
  for (; i < max; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < max && s.charCodeAt(i + 1) !== 32 && !(inDefinition && s.charCodeAt(i + 1) === 10)) {
      i++;
      continue;
    }
    if (c <= 32 || c === 127) break;
    if (c === 40) {
      depth++;
      if (depth > 32) return null;
    } else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i === at || depth !== 0) return null;
  return { raw: s.slice(at, i), end: i };
}

/** A link title at `at` (spec 6.3): `"..."`, `'...'` or `(...)`. Returns the raw text and the index after it. */
export function scanTitle(s: string, at: number, max = s.length): { raw: string; end: number } | null {
  const t = titleAt(s, at, max);
  return t === "open" ? null : t;
}

/** As scanTitle, but "open" when the text ends before the title is closed. */
function titleAt(s: string, at: number, max: number): { raw: string; end: number } | "open" | null {
  const open = s.charCodeAt(at);
  const close = open === 34 ? 34 : open === 39 ? 39 : open === 40 ? 41 : 0;
  if (!close) return null;
  for (let i = at + 1; i < max; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < max && isAsciiPunct(s.charCodeAt(i + 1))) {
      i++;
      continue;
    }
    if (c === close) return { raw: s.slice(at + 1, i), end: i + 1 };
    if (open === 40 && c === 40) return null;
  }
  return "open";
}

/** Skip spaces and tabs, and at most one line ending among them. */
function skipSpaceAndOneNewline(s: string, i: number, max: number): { at: number; newlines: number } {
  let newlines = 0;
  for (; i < max; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      if (newlines) break;
      newlines++;
    } else if (!isSpaceOrTab(c)) break;
  }
  return { at: i, newlines };
}

/** A link reference definition found at the start of some text. */
export interface FoundLinkDef {
  label: string;
  def: LinkDef;
  /** The index after the definition's line ending (or the end of the text). */
  end: number;
}

/** One link reference definition at the start of `s` (spec 4.7), or null. */
export function scanLinkDef(s: string, validate: (url: string) => boolean): FoundLinkDef | null {
  return matchLinkDef(s, validate).found;
}

/**
 * As scanLinkDef, and also whether the answer could change if more lines
 * followed `s`: the text ended inside the label, before the destination,
 * or where a title could still begin or end. `s` holds whole lines.
 */
export function matchLinkDef(s: string, validate: (url: string) => boolean): { found: FoundLinkDef | null; ranOut: boolean } {
  const none = (ranOut: boolean): { found: null; ranOut: boolean } => ({ found: null, ranOut });
  if (s.charCodeAt(0) !== 91) return none(false);
  const labelEnd = scanLabel(s, 0);
  if (labelEnd === -2) return none(true);
  if (labelEnd < 0 || s.charCodeAt(labelEnd) !== 58) return none(false);
  const label = s.slice(1, labelEnd - 1);
  let { at } = skipSpaceAndOneNewline(s, labelEnd + 1, s.length);
  if (at >= s.length) return none(true);
  const dest = scanDestination(s, at, s.length, true);
  if (!dest) return none(false);
  const url = unescapeText(dest.raw);
  if (!validate(url)) return none(false);
  at = dest.end;
  const destEnd = at;
  // A title must be separated from the destination by blank space; it may start on the next line.
  const gap = skipSpaceAndOneNewline(s, at, s.length);
  let ranOut = gap.at >= s.length;
  const title = gap.at > destEnd && !ranOut ? titleAt(s, gap.at, s.length) : null;
  if (title === "open") ranOut = true;
  else if (title) {
    let i = title.end;
    while (i < s.length && isSpaceOrTab(s.charCodeAt(i))) i++;
    if (i >= s.length || s.charCodeAt(i) === 10) {
      return { found: { label, def: { url, title: unescapeText(title.raw) }, end: Math.min(i + 1, s.length) }, ranOut: false };
    }
  }
  // No title (or junk after it): the destination must end its line.
  let i = destEnd;
  while (i < s.length && isSpaceOrTab(s.charCodeAt(i))) i++;
  if (i < s.length && s.charCodeAt(i) !== 10) return none(ranOut);
  return { found: { label, def: { url }, end: Math.min(i + 1, s.length) }, ranOut };
}
