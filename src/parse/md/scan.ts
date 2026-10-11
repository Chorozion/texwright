/**
 * Character-level scanners shared by the Markdown block and inline rules:
 * attribute lists, citation keys and locators, math delimiters and LaTeX
 * environments. Everything here works on plain strings and offsets.
 *
 * Rules call these at many positions of one string (every `[`, every
 * `\begin`), and a scan that runs to the end of the string each time is
 * quadratic on hostile input. `ScanIndex` answers the same questions for one
 * string from tables built once, so each call costs O(1) or O(log n).
 */

import { MinTree, lowerBound } from "../latex/search.js";

/** A parsed `{#id .class key=value}` list. `{-}` becomes the class "unnumbered". */
export interface AttrSpec {
  id?: string;
  classes: string[];
  attrs: Record<string, string>;
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

export function hasClass(attr: AttrSpec | null | undefined, name: string): boolean {
  return !!attr && attr.classes.includes(name);
}

/** Index of the `}` that closes the attribute list opened at `open`, or -1. Stays on one line. */
export function findAttrEnd(s: string, open: number, max = s.length): number {
  for (let i = open + 1; i < max; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = s.indexOf(c, i + 1);
      if (q < 0 || q >= max) return -1;
      i = q;
    } else if (c === "}") {
      return i;
    } else if (c === "{" || c === "\n") {
      return -1;
    }
  }
  return -1;
}

/**
 * Parse the inside of an attribute list. Returns null when the text is not
 * one (so `{a, b}` in prose stays prose). Bare words become classes only when
 * `bareWordsAsClasses` is set, as in code fence info strings like `{python}`.
 */
export function parseAttrBody(body: string, bareWordsAsClasses = false): AttrSpec | null {
  const spec: AttrSpec = { classes: [], attrs: {} };
  const n = body.length;
  let i = 0;
  let found = false;
  while (i < n) {
    const c = body[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    found = true;
    if (c === "#" || c === ".") {
      let j = i + 1;
      while (j < n && !isSpace(body[j])) j++;
      const word = body.slice(i + 1, j);
      if (!word) return null;
      if (c === "#") spec.id = word;
      else spec.classes.push(word);
      i = j;
      continue;
    }
    if (c === "-" && (i + 1 === n || isSpace(body[i + 1]))) {
      if (!spec.classes.includes("unnumbered")) spec.classes.push("unnumbered");
      i++;
      continue;
    }
    const key = /^[A-Za-z_][\w:.-]*/.exec(body.slice(i));
    if (!key) return null;
    let j = i + key[0].length;
    if (body[j] !== "=") {
      if (!bareWordsAsClasses || (j < n && !isSpace(body[j]))) return null;
      spec.classes.push(key[0]);
      i = j;
      continue;
    }
    j++;
    const quote = body[j];
    let value: string;
    if (quote === '"' || quote === "'") {
      const end = body.indexOf(quote, j + 1);
      if (end < 0) return null;
      value = body.slice(j + 1, end);
      j = end + 1;
    } else {
      let k = j;
      while (k < n && !isSpace(body[k])) k++;
      value = body.slice(j, k);
      j = k;
    }
    spec.attrs[key[0]] = value;
    i = j;
  }
  return found ? spec : null;
}

/** An attribute list after optional spaces (same line) at `at`, with the offset just past it. */
export function readAttrAt(s: string, at: number, max = s.length): { attr: AttrSpec; end: number } | null {
  let i = at;
  while (i < max && (s[i] === " " || s[i] === "\t")) i++;
  if (s[i] !== "{") return null;
  const close = findAttrEnd(s, i, max);
  if (close < 0) return null;
  const attr = parseAttrBody(s.slice(i + 1, close));
  return attr ? { attr, end: close + 1 } : null;
}

// ------------------------------------------------------------------ citation keys

// pandoc citation keys: start with a letter, digit or _, then alphanumerics and
// single internal punctuation, so a sentence-final period is not part of the key.
const KEY_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&+?<>~\/-](?=[\p{L}\p{N}_]))*/uy;
const XREF_RE = /^(fig|tbl|tab|eq|sec|lst|thm|lem|def|cor|prop|app):./i;

export function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/**
 * The label a key cross-references (`fig:x`, `eq:y`...), or null for a
 * citation key. A capitalized prefix (`Fig:x`, pandoc-crossref style) names the same label.
 */
export function crossRefLabel(key: string): string | null {
  const m = XREF_RE.exec(key);
  return m ? m[1].toLowerCase() + key.slice(m[1].length) : null;
}

/** A citation key at `at` (`doe2020` or `{any key}`), with the offset just past it. `idx`, if given, indexes `s`. */
export function readCiteKey(s: string, at: number, idx?: ScanIndex): { key: string; end: number } | null {
  if (s[at] === "{" && idx) {
    // As below, without scanning to the closing brace: many "@{" in front of one "}" would rescan the same text.
    const close = idx.next("}", at + 1);
    if (close < 0) return null;
    let from = at + 1;
    while (from < close && isSpace(s[from])) from++;
    if (from >= close) return null;
    const to = idx.trimEnd(close);
    const nl = idx.next("\n", from);
    return nl >= 0 && nl < to ? null : { key: s.slice(from, to), end: close + 1 };
  }
  if (s[at] === "{") {
    const close = s.indexOf("}", at + 1);
    const key = close > at ? s.slice(at + 1, close).trim() : "";
    return key && !key.includes("\n") ? { key, end: close + 1 } : null;
  }
  KEY_RE.lastIndex = at;
  const m = KEY_RE.exec(s);
  return m ? { key: m[0], end: at + m[0].length } : null;
}

const LOCATOR_TERMS = [
  "pages?", "pp?\\.", "chapters?", "chaps?\\.", "chs?\\.", "sections?", "secs?\\.", "§§?",
  "figures?", "figs?\\.", "volumes?", "vols?\\.", "numbers?", "nos?\\.", "paragraphs?", "paras?\\.",
  "lines?", "ll?\\.", "notes?", "nn?\\.", "parts?", "pts?\\.", "books?", "bks?\\.", "columns?", "cols?\\.",
  "folios?", "fols?\\.", "opus", "ops?\\.", "verses?", "vv?\\.", "issues?", "iss\\.", "s\\.\\s?v\\.", "sub verbo",
];
const LOCATOR_VALUE = "(?:\\d+[a-z]?|[ivxlcdm]+)";
const LOCATOR_RANGE = `${LOCATOR_VALUE}(?:\\s*[-\\u2013\\u2014]+\\s*${LOCATOR_VALUE})?`;
const LOCATOR_RE = new RegExp(
  `^(?:${LOCATOR_TERMS.join("|")})\\s*${LOCATOR_RANGE}(?:\\s*(?:,|&|and)\\s*${LOCATOR_RANGE})*(?![\\p{L}\\p{N}])`,
  "iu",
);

/**
 * Split what follows a citation key into a locator ("p. 4", "ch. 2-3") and a
 * free-text suffix. A leading comma is dropped from both.
 */
export function splitLocator(raw: string): { locator?: string; suffix?: string } {
  let rest = raw.trim().replace(/^,\s*/, "");
  const out: { locator?: string; suffix?: string } = {};
  const m = LOCATOR_RE.exec(rest);
  if (m) {
    out.locator = m[0].replace(/\s+/g, " ").trim();
    rest = rest.slice(m[0].length).trim().replace(/^,\s*/, "");
  }
  if (rest) out.suffix = rest;
  return out;
}

// ------------------------------------------------------------------ brackets and math

/** Index of the bracket closing the `{`, `[` or `(` at `open`, skipping backslash escapes; -1 if unbalanced. */
export function matchBracket(s: string, open: number, max = s.length): number {
  const o = s[open];
  const c = o === "{" ? "}" : o === "[" ? "]" : ")";
  let depth = 0;
  for (let i = open; i < max; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
    } else if (ch === o) {
      depth++;
    } else if (ch === c && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Split on `sep` outside braces and brackets. */
export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && depth > 0) depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

/** Index of the last backtick of the run closing a code span opened by the run at `i`, or -1. */
function codeSpanClose(s: string, i: number, max: number): number {
  let n = 0;
  while (s[i + n] === "`") n++;
  for (let j = i + n; j < max; j++) {
    if (s[j] !== "`") continue;
    let m = 0;
    while (s[j + m] === "`") m++;
    if (m === n) return j + m - 1;
    j += m - 1;
  }
  return -1;
}

/**
 * Inline code is opaque to math scanning, so a stray `$$` in prose never pairs
 * with one inside backticks. Returns the index of the last character of the
 * code span starting at `i`, or of the backtick run when it never closes.
 */
function skipCodeSpan(s: string, i: number, max: number): number {
  const close = codeSpanClose(s, i, max);
  if (close >= 0) return close;
  let n = 0;
  while (s[i + n] === "`") n++;
  return i + n - 1;
}

/** True when the text after a newline at `from` is a blank line (or the end). */
function blankLineAt(s: string, from: number, max: number): boolean {
  let i = from;
  while (i < max && (s[i] === " " || s[i] === "\t")) i++;
  return i >= max || s[i] === "\n";
}

/**
 * pandoc's rule for `$...$`: the opening `$` is followed by a non-space, the
 * closing `$` is preceded by a non-space and not followed by a digit, and the
 * first `$` after the opening decides. Returns the closing index or -1.
 */
export function findInlineDollarClose(s: string, open: number, max: number): number {
  const first = s[open + 1];
  if (open + 1 >= max || isSpace(first) || first === "$") return -1;
  for (let i = open + 1; i < max; i++) {
    const c = s[i];
    if (c === "\\") {
      // \text{...} may contain dollars; any other escape covers one character.
      if (s.startsWith("text{", i + 1)) {
        const close = matchBracket(s, i + 5, max);
        if (close < 0) return -1;
        i = close;
      } else {
        i++;
      }
    } else if (c === "`") {
      i = skipCodeSpan(s, i, max);
    } else if (c === "$") {
      if (isSpace(s[i - 1]) || /[0-9]/.test(s[i + 1] ?? "")) return -1;
      return i;
    } else if (c === "\n" && blankLineAt(s, i + 1, max)) {
      return -1;
    }
  }
  return -1;
}

/** Index of the `$$` closing display math whose body starts at `from`, or -1. No blank lines; the body may be empty. */
export function findDisplayDollarClose(s: string, from: number, max: number): number {
  for (let i = from; i < max; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
    } else if (c === "`") {
      i = skipCodeSpan(s, i, max);
    } else if (c === "$" && s[i + 1] === "$") {
      return i;
    } else if (c === "\n" && blankLineAt(s, i + 1, max)) {
      return -1;
    }
  }
  return -1;
}

/** Index of the backslash of `\)` or `\]` closing math whose body starts at `from`, or -1. */
export function findBackslashClose(s: string, from: number, max: number, closer: ")" | "]"): number {
  for (let i = from; i < max; i++) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === closer) return s.slice(from, i).trim() ? i : -1;
      i++;
    } else if (c === "`") {
      i = skipCodeSpan(s, i, max);
    } else if (c === "\n" && blankLineAt(s, i + 1, max)) {
      return -1;
    }
  }
  return -1;
}

const ENV_TOKEN = /\\(begin|end)\s*\{([^{}]*)\}/g;

/** The `\end{name}` matching an environment whose body starts at `from`, counting nested ones of the same name. */
export function findEnvEnd(s: string, from: number, name: string, max = s.length): { bodyEnd: number; end: number } | null {
  const re = new RegExp(ENV_TOKEN.source, "g");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m && m.index + m[0].length <= max; m = re.exec(s)) {
    if (m[2].trim() !== name) continue;
    if (m[1] === "begin") depth++;
    else if (--depth === 0) return { bodyEnd: m.index, end: m.index + m[0].length };
  }
  return null;
}

// ------------------------------------------------------------------ scan index

/** One name's `\begin{..}`/`\end{..}` tokens in source order. */
interface EnvGroup {
  start: number[];
  end: number[];
  begin: boolean[];
  /** For a \begin token, the index of the \end token that closes it; -1 when none does. */
  close: Int32Array;
  /** Token index by end offset, for \begin tokens. */
  beginByEnd: Map<number, number>;
  /** Start offsets of \end tokens spelled exactly `\end{name}` (blanks only before the brace, on one line). */
  exact: number[];
}

/** Kinds of math closer the memoized scan looks for. */
export type CloseKind = "inline$" | "display$" | ")" | "]";

/**
 * Precomputed tables for one string, so that the scanners above can be asked
 * about many positions of it in O(1) or O(log n) each. Every answer is the
 * one the plain function gives; each table is built on first use.
 *
 * Backslash escapes are paired from the start of the string. A scan that
 * starts at an unescaped bracket pairs them the same way from there on, so
 * the tables apply; at an escaped one the plain function is used instead.
 */
export class ScanIndex {
  /** 1 where the character is the second half of a backslash escape. */
  private skip?: Uint8Array;
  /** Index of the closing bracket for each `{`, `[` and `(` (each kind matched on its own), else -1. */
  private match?: Int32Array;
  /** Unescaped `;` offsets, with the innermost `{` or `[` still open at each (both kinds counted together), or -1. */
  private semis?: Int32Array;
  private semiTops?: MinTree;
  /** Offsets where `@` or `-@` follows whitespace (where a citation part may name its key). */
  private citeAts?: Int32Array;
  /** Offsets of single characters, by character. */
  private readonly chars = new Map<string, Int32Array>();
  /** Ends of citation keys, by offset. */
  private readonly keys = new Map<number, number>();
  private readonly trimmed = new Map<number, number>();
  private envs?: Map<string, EnvGroup>;
  /** Starts of maximal backtick runs, by run length. */
  private ticks?: Map<number, Int32Array>;
  /** Results of memoized closer scans, by kind and limit, keyed by the offset a scan passed through. */
  private readonly closes = new Map<string, Map<number, number>>();

  constructor(readonly s: string) {}

  private brackets(): void {
    if (this.match) return;
    const s = this.s;
    const n = s.length;
    const skip = new Uint8Array(n + 1);
    const match = new Int32Array(n).fill(-1);
    const curly: number[] = [];
    const square: number[] = [];
    const round: number[] = [];
    const mixed: number[] = [];
    const semis: number[] = [];
    const tops: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 92) {
        skip[i + 1] = 1;
        i++;
        continue;
      }
      switch (c) {
        case 123:
          curly.push(i);
          mixed.push(i);
          break;
        case 91:
          square.push(i);
          mixed.push(i);
          break;
        case 40:
          round.push(i);
          break;
        case 125: {
          const o = curly.pop();
          if (o !== undefined) match[o] = i;
          mixed.pop();
          break;
        }
        case 93: {
          const o = square.pop();
          if (o !== undefined) match[o] = i;
          mixed.pop();
          break;
        }
        case 41: {
          const o = round.pop();
          if (o !== undefined) match[o] = i;
          break;
        }
        case 59:
          semis.push(i);
          tops.push(mixed.length ? mixed[mixed.length - 1] : -1);
          break;
      }
    }
    // Citation parts name their key at "@" or "-@" after whitespace; escapes play no part in that test.
    const citeAts: number[] = [];
    for (let i = 1; i < n; i++) {
      const c = s.charCodeAt(i);
      if ((c === 64 || (c === 45 && s.charCodeAt(i + 1) === 64)) && isSpace(s[i - 1])) citeAts.push(i);
    }
    this.skip = skip;
    this.match = match;
    this.semis = Int32Array.from(semis);
    this.semiTops = new MinTree(tops.length, (k) => tops[k]);
    this.citeAts = Int32Array.from(citeAts);
  }

  /** s.indexOf(ch, from) for a one-character `ch`. */
  next(ch: string, from: number): number {
    let at = this.chars.get(ch);
    if (!at) {
      const list: number[] = [];
      for (let i = this.s.indexOf(ch); i >= 0; i = this.s.indexOf(ch, i + 1)) list.push(i);
      this.chars.set(ch, (at = Int32Array.from(list)));
    }
    const k = lowerBound(at, Math.max(0, from));
    return k < at.length ? at[k] : -1;
  }

  /** The offset just past the last non-blank character before `end`. */
  trimEnd(end: number): number {
    let to = this.trimmed.get(end);
    if (to === undefined) {
      to = end;
      while (to > 0 && isSpace(this.s[to - 1])) to--;
      this.trimmed.set(end, to);
    }
    return to;
  }

  /** The end of readCiteKey(s, at), or -1. */
  citeKeyEnd(at: number): number {
    let end = this.keys.get(at);
    if (end === undefined) {
      end = readCiteKey(this.s, at, this)?.end ?? -1;
      this.keys.set(at, end);
    }
    return end;
  }

  /** matchBracket(s, open, max). */
  matchBracket(open: number, max = this.s.length): number {
    const o = this.s[open];
    if (o !== "{" && o !== "[" && o !== "(") return matchBracket(this.s, open, max);
    this.brackets();
    if (this.skip![open]) return matchBracket(this.s, open, max);
    const m = this.match![open];
    return m >= 0 && m < max ? m : -1;
  }

  /**
   * Offsets of the `;` that split the inside of the bracket opened at `open`
   * (closing at `close`), as splitTopLevel cuts it: the first one after `from`, or -1.
   */
  nextTopSemicolon(open: number, from: number, close: number): number {
    this.brackets();
    const semis = this.semis!;
    const k = this.semiTops!.firstBelow(lowerBound(semis, from), open + 1);
    return k >= 0 && semis[k] < close ? semis[k] : -1;
  }

  /** Where parseCitePart would find the citation in the part s[a, b): the offset of its `@` (or `-@`), or -1. */
  citeAt(a: number, b: number): number {
    const s = this.s;
    if (a < b && (s[a] === "@" || (s[a] === "-" && s[a + 1] === "@" && a + 1 < b))) return a;
    this.brackets();
    const xs = this.citeAts!;
    for (let k = lowerBound(xs, a + 1); k < xs.length && xs[k] < b; k++) {
      // "-@" needs its "@" inside the part.
      if (s[xs[k]] === "@" || xs[k] + 1 < b) return xs[k];
    }
    return -1;
  }

  // ---------------------------------------------------------------- environments

  private envGroups(): Map<string, EnvGroup> {
    if (this.envs) return this.envs;
    const groups = new Map<string, EnvGroup>();
    const re = new RegExp(ENV_TOKEN.source, "g");
    for (let m = re.exec(this.s); m; m = re.exec(this.s)) {
      const name = m[2].trim();
      let g = groups.get(name);
      if (!g) groups.set(name, (g = { start: [], end: [], begin: [], close: new Int32Array(0), beginByEnd: new Map(), exact: [] }));
      const begin = m[1] === "begin";
      if (begin) g.beginByEnd.set(m.index + m[0].length, g.start.length);
      else if (m[2] === name && !m[0].includes("\n")) g.exact.push(m.index);
      g.start.push(m.index);
      g.end.push(m.index + m[0].length);
      g.begin.push(begin);
    }
    for (const g of groups.values()) {
      // The \end closing a \begin is the first one where the nesting count drops below it: a stack does that.
      g.close = new Int32Array(g.start.length).fill(-1);
      const open: number[] = [];
      for (let k = 0; k < g.start.length; k++) {
        if (g.begin[k]) open.push(k);
        else {
          const b = open.pop();
          if (b !== undefined) g.close[b] = k;
        }
      }
    }
    this.envs = groups;
    return groups;
  }

  /** findEnvEnd(s, from, name, max). */
  findEnvEnd(from: number, name: string, max = this.s.length): { bodyEnd: number; end: number } | null {
    // Token names never hold braces, so such a name never closes.
    if (/[{}]/.test(name)) return null;
    const g = this.envGroups().get(name);
    if (!g) return null;
    const k = g.beginByEnd.get(from);
    if (k === undefined) return findEnvEnd(this.s, from, name, max);
    const c = g.close[k];
    if (c < 0 || g.end[c] > max) return null;
    return { bodyEnd: g.start[c], end: g.end[c] };
  }

  /** The \end token closing the \begin{name} token that ends at `from`, in the whole string. */
  envClose(from: number, name: string): { start: number; end: number } | null {
    const g = this.envGroups().get(name);
    const k = g?.beginByEnd.get(from);
    if (!g || k === undefined) return null;
    const c = g.close[k];
    return c < 0 ? null : { start: g.start[c], end: g.end[c] };
  }

  /** Start of the first `\end{name}` spelled exactly (as a line test for it would see) at or after `from`, or -1. */
  exactEnd(name: string, from: number): number {
    const xs = this.envGroups().get(name)?.exact;
    if (!xs) return -1;
    const k = lowerBound(xs, from);
    return k < xs.length ? xs[k] : -1;
  }

  // ---------------------------------------------------------------- math closers

  /** codeSpanClose(s, i, max), from the backtick runs of the whole string. */
  private codeSpanClose(i: number, max: number): number {
    if (!this.ticks) {
      const runs = new Map<number, number[]>();
      const s = this.s;
      for (let j = 0; j < s.length; j++) {
        if (s.charCodeAt(j) !== 96) continue;
        let m = 1;
        while (s.charCodeAt(j + m) === 96) m++;
        let list = runs.get(m);
        if (!list) runs.set(m, (list = []));
        list.push(j);
        j += m - 1;
      }
      this.ticks = new Map([...runs].map(([m, list]) => [m, Int32Array.from(list)]));
    }
    let n = 0;
    while (this.s.charCodeAt(i + n) === 96) n++;
    const starts = this.ticks.get(n);
    if (!starts) return -1;
    const k = lowerBound(starts, i + n);
    return k < starts.length && starts[k] < max ? starts[k] + n - 1 : -1;
  }

  /**
   * The scan behind findInlineDollarClose (from the character after the
   * opening `$`), findDisplayDollarClose and findBackslashClose: the offset of
   * the closer, or -1. Scans are deterministic, so two that reach the same
   * offset end the same way; every special character a scan passes is
   * remembered with its outcome, and later scans stop when they reach one.
   */
  closeFrom(kind: CloseKind, from: number, max: number): number {
    const s = this.s;
    const key = `${kind}\u0000${max}`;
    let memo = this.closes.get(key);
    if (!memo) this.closes.set(key, (memo = new Map()));
    const path: number[] = [];
    let result = -1;
    let i = from;
    while (i < max) {
      const c = s.charCodeAt(i);
      if (c !== 92 && c !== 96 && c !== 36 && c !== 10) {
        i++;
        continue;
      }
      const known = memo.get(i);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(i);
      if (c === 92) {
        if (kind === "inline$") {
          // \text{...} may contain dollars; any other escape covers one character.
          if (s.startsWith("text{", i + 1)) {
            const close = this.matchBracket(i + 5, max);
            if (close < 0) break;
            i = close + 1;
          } else i += 2;
        } else if ((kind === ")" || kind === "]") && s[i + 1] === kind) {
          result = i;
          break;
        } else i += 2;
      } else if (c === 96) {
        const close = this.codeSpanClose(i, max);
        if (close >= 0) i = close + 1;
        else {
          let n = 1;
          while (s.charCodeAt(i + n) === 96) n++;
          i += n;
        }
      } else if (c === 36) {
        if (kind === "inline$") {
          result = isSpace(s[i - 1]) || /[0-9]/.test(s[i + 1] ?? "") ? -1 : i;
          break;
        }
        if (kind === "display$" && s[i + 1] === "$") {
          result = i;
          break;
        }
        i++;
      } else {
        if (blankLineAt(s, i + 1, max)) break;
        i++;
      }
    }
    for (const p of path) memo.set(p, result);
    return result;
  }

  /** findInlineDollarClose(s, open, max). */
  findInlineDollarClose(open: number, max: number): number {
    const first = this.s[open + 1];
    if (open + 1 >= max || isSpace(first) || first === "$") return -1;
    return this.closeFrom("inline$", open + 1, max);
  }

  /** findDisplayDollarClose(s, from, max). */
  findDisplayDollarClose(from: number, max: number): number {
    return this.closeFrom("display$", from, max);
  }

  /** findBackslashClose(s, from, max, closer). */
  findBackslashClose(from: number, max: number, closer: ")" | "]"): number {
    const close = this.closeFrom(closer, from, max);
    if (close < 0) return -1;
    for (let i = from; i < close; i++) if (!isSpace(this.s[i])) return close;
    return -1;
  }
}

const MATH_ENVS = new Set(["equation", "align", "gather", "multline", "alignat", "flalign"]);

/** Display math environments recognised directly in Markdown (starred forms included). */
export function isMathEnv(name: string): boolean {
  return MATH_ENVS.has(name.endsWith("*") ? name.slice(0, -1) : name);
}

/** The first `\label{...}` inside a TeX body. */
export function firstLabel(tex: string): string | undefined {
  const m = /\\label\s*\{([^{}]+)\}/.exec(tex);
  return m ? m[1].trim() : undefined;
}
