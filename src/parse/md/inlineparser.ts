/**
 * The inline phase (CommonMark spec section 6 and appendix "A parsing
 * strategy", phase 2), for one leaf block's text.
 *
 * A scanner walks the text and recognises, at each special character, the
 * construct that starts there: code spans, escapes, character references,
 * autolinks, raw HTML, links and images, and texwright's own math, LaTeX
 * commands, citations, cross-references and notes. Everything else is
 * plain text. Runs of `*`, `_` and `~~` go into a delimiter list and are
 * matched up afterwards by the spec's "process emphasis" procedure.
 *
 * Links are decided at their `[`: the label's end is found by skipping over
 * whole constructs (so a `]` inside code or math does not count), and a
 * construct that itself starts with `[` (a link, a citation, a footnote
 * reference) inside a link label means the outer brackets are not a link.
 * Deciding there, rather than at `]`, is what lets a bracketed citation lose
 * to a link (`[@a](u)`) but win over brackets that are not one.
 */
import type { Block, Inline, Pos } from "../../ast.js";
import type { FixSpec } from "../../diagnostics.js";
import type { LinkDef } from "./blocktree.js";
import { MarkerTable, htmlLengthAt } from "./inlinehtml.js";
import { ItemList, type Delim, type DisplayMath, type Item } from "./items.js";
import { linkAtStart } from "./linkify.js";
import { entityAt, isAsciiPunct, normalizeLabel, scanDestination, scanTitle, unescapeText } from "./linkparts.js";
import { crefGroup } from "../../ast.js";
import { ScanIndex, crossRefLabel, isMathEnv, isWordChar, readAttrAt, splitLocator, type AttrSpec } from "./scan.js";
import { normalizeLink, normalizeLinkText, validateLink } from "./url.js";

/** What the inline phase needs from the document around it. */
export interface InlineHost {
  refs: Map<string, LinkDef>;
  /** True when a footnote with this label is defined. */
  hasNote(label: string): boolean;
  /** The content of the footnote `label`, referenced at `pos` (empty in a cycle). */
  noteBlocks(label: string, pos: Pos): Block[];
  /** Number an inline note as it starts (see Assembler.openInlineNote). */
  openInlineNote(): number;
  /** Blocks for the content of the inline note numbered `id` (`raw` is its source text). */
  closeInlineNote(id: number, items: ItemList, raw: string): Block[];
  warn(message: string, pos: Pos, hint: string, extra?: { code?: "MD002"; fix?: FixSpec }): void;
  /** Label placeholders created by `\label{}`. */
  labelSpans: Set<Inline>;
}

/** Where a piece of inline text came from: offset `at` in the text is at (line, col) of the source. */
export interface SourceMap {
  pos(at: number): Pos;
  /** Where `text` is placed in the source line `line` lines below the leaf's first line (0-based). */
  find(line: number, text: string): number;
  /** The position of 0-based column `col` of the source line `line` lines below the leaf's first line. */
  at(line: number, col: number): Pos;
}

/** Deepest nesting of links, images and notes the scanner follows; deeper text is left as it is. */
const MAX_NESTING = 100;

const enum Ch {
  Tab = 9,
  Newline = 10,
  Space = 32,
  Bang = 33,
  Quote = 34,
  Dollar = 36,
  Amp = 38,
  Star = 42,
  Colon = 58,
  Lt = 60,
  At = 64,
  LBracket = 91,
  Backslash = 92,
  RBracket = 93,
  Caret = 94,
  Underscore = 95,
  Backtick = 96,
  LBrace = 123,
  Tilde = 126,
}

/** Characters at which some construct may start; anything else is plain text. */
const SPECIAL = new Uint8Array(128);
for (const c of "\n\\`*_~[]!<&$@^{:") SPECIAL[c.charCodeAt(0)] = 1;

const isSpaceCode = (c: number): boolean => c === Ch.Space || c === Ch.Tab;

/** Unicode whitespace as CommonMark defines it (spec 2.1). */
function isWhitespace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
/**
 * Unicode punctuation as CommonMark defines it (spec 2.1): ASCII punctuation
 * and the P and S categories. A lone surrogate counts too, as it did for
 * the old reader's emphasis.
 */
function isPunct(code: number): boolean {
  if (code < 128) return isAsciiPunct(code);
  if (code >= 0xd800 && code <= 0xdfff) return true;
  return PUNCT_RE.test(String.fromCodePoint(code));
}

/** The code point that ends just before `at` (a surrogate pair read as one). */
function codePointBefore(s: string, at: number, floor: number): number {
  const c = s.charCodeAt(at - 1);
  if (c >= 0xdc00 && c <= 0xdfff && at - 2 >= floor) {
    const h = s.charCodeAt(at - 2);
    if (h >= 0xd800 && h <= 0xdbff) return (h - 0xd800) * 0x400 + (c - 0xdc00) + 0x10000;
  }
  return c;
}

/** The code point that starts at `at` (a surrogate pair read as one). */
function codePointAt(s: string, at: number, to: number): number {
  const c = s.charCodeAt(at);
  if (c >= 0xd800 && c <= 0xdbff && at + 1 < to) {
    const l = s.charCodeAt(at + 1);
    if (l >= 0xdc00 && l <= 0xdfff) return (c - 0xd800) * 0x400 + (l - 0xdc00) + 0x10000;
  }
  return c;
}

/** Options for one run of inline text. */
export interface InlineOptions {
  /** Headings and captions: a final `{...}` attribute list is taken off the text. */
  trailingAttrs?: boolean;
}

/** The output of parsing one leaf's text. */
export interface InlineResult {
  items: ItemList;
  attr: AttrSpec | null;
}

/** Inline parser for one leaf block's text. */
export class InlineParser {
  private readonly index: ScanIndex;
  /** End of each construct by start offset, for skipping over constructs while looking for a link label's end. */
  private skipMemo = new Map<number, number>();
  /** Results of labelEnd by its arguments (end of text, nesting rule) and then by the `[`. */
  private labelMemo = new Map<string, Map<number, number>>();
  /** Start of the text being read as its own (see ScanState.floor). */
  private floor = 0;
  /** The depth of the outermost scan of the text being read as its own (0 for the whole text). */
  private ownDepth = 0;
  /** Length of the plain text before the bracket whose label is being scanned (see linkifyAt). */
  private textBeforeLabel = 0;
  /** Start offsets of backtick runs by length, for finding code span closers in O(log n). */
  private ticks?: Map<number, number[]>;
  private attr: AttrSpec | null = null;
  private readonly markers: MarkerTable;
  /**
   * Links being parsed around the current position, plus raw `<a>` tags not
   * yet closed by `</a>`: while there are any, bare URLs are left to the
   * later pass over the whole run (as in the old reader, which counted both
   * the same way, so an `<a>` inside link text still counts after the link).
   */
  private linkDepth = 0;
  /** Ranges of the image descriptions and inline notes being parsed around the current position. */
  private readonly nested: { from: number; to: number }[] = [];
  /** Offsets of the line breaks in the text, built on first use. */
  private newlines?: number[];
  /**
   * Where each line piece of a nested text was placed (see posAt), by its
   * line count and offsets: placing a piece searches its source line, so
   * each is placed once however many positions it holds.
   */
  private readonly placed = new Map<string, number>();

  constructor(
    readonly src: string,
    private readonly map: SourceMap,
    private readonly host: InlineHost,
    private readonly opts: InlineOptions = {},
  ) {
    this.index = new ScanIndex(src);
    this.markers = new MarkerTable(src);
  }

  parse(): InlineResult {
    const items = this.tokenize(0, this.src.length, 0);
    return { items, attr: this.attr };
  }

  /**
   * The source position of offset `p`. Inside an image description or an
   * inline note, lines are counted within the description or note, as the
   * old reader did (it parsed them as texts of their own).
   */
  private posAt(p: number): Pos {
    const range = this.nested[this.nested.length - 1];
    if (!range) return this.map.pos(p);
    const nl = (this.newlines ??= [...this.src.matchAll(/\n/g)].map((m) => m.index!));
    const before = (x: number): number => {
      let lo = 0;
      let hi = nl.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (nl[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const k = before(p);
    const lines = k - before(range.from);
    const lineStart = lines === 0 ? range.from : nl[k - 1] + 1;
    const lineEnd = k < nl.length && nl[k] < range.to ? nl[k] : range.to;
    const key = `${lines}:${lineStart}:${lineEnd}`;
    let start = this.placed.get(key);
    if (start === undefined) this.placed.set(key, (start = this.map.find(lines, this.src.slice(lineStart, lineEnd))));
    return this.map.at(lines, start + p - lineStart);
  }

  // ---------------------------------------------------------------- the scan

  /** Scan `src[from, to)` into items, then resolve emphasis. `depth` counts enclosing links, images and notes. */
  tokenize(from: number, to: number, depth: number): ItemList {
    const out = new ItemList();
    const st: ScanState = { out, textStart: from, delims: null, lastDelim: null, floor: this.floor };
    let pos = from;
    while (pos < to) {
      const c = this.src.charCodeAt(pos);
      if (c >= 128 || !SPECIAL[c] || depth >= MAX_NESTING) {
        pos++;
        continue;
      }
      const end = this.construct(pos, to, depth, st);
      if (end > pos) pos = end;
      else pos++;
    }
    this.flushText(st, to);
    processEmphasis(out, st.delims ? firstDelim(st.lastDelim) : null);
    return out;
  }

  /**
   * An image description or an inline note: the old reader parsed these as
   * texts of their own, so they start and end like a text (for emphasis),
   * keep their own record of constructs, and count lines from their start.
   */
  private ownText(from: number, to: number, depth: number): ItemList {
    const saved = { memo: this.skipMemo, labels: this.labelMemo, floor: this.floor, links: this.linkDepth, own: this.ownDepth };
    this.skipMemo = new Map();
    this.labelMemo = new Map();
    this.floor = from;
    this.linkDepth = 0;
    this.ownDepth = depth;
    this.nested.push({ from, to });
    const out = this.tokenize(from, to, depth);
    this.nested.pop();
    this.skipMemo = saved.memo;
    this.labelMemo = saved.labels;
    this.floor = saved.floor;
    this.linkDepth = saved.links;
    this.ownDepth = saved.own;
    return out;
  }

  /** Text accumulated since the last item becomes a Text item. */
  private flushText(st: ScanState, upTo: number): void {
    if (upTo > st.textStart) st.out.push({ t: "Text", text: this.src.slice(st.textStart, upTo) });
    st.textStart = upTo;
  }

  private push(st: ScanState, start: number, end: number, node: Inline | DisplayMath | null, extra?: Partial<Item>): Item {
    this.flushText(st, start);
    const it = st.out.push(node, { raw: this.src.slice(start, end), ...extra });
    st.textStart = end;
    return it;
  }

  /**
   * Try every construct that can start at `pos` (in `src[.., to)`), pushing
   * what it finds. Returns the end of what was consumed, or `pos` when
   * nothing started there.
   */
  private construct(pos: number, to: number, depth: number, st: ScanState): number {
    const s = this.src;
    switch (s.charCodeAt(pos)) {
      case Ch.Newline:
        return this.newline(pos, to, st);
      case Ch.Backslash:
        return this.backslash(pos, to, st);
      case Ch.Backtick:
        return this.codeSpan(pos, to, st);
      case Ch.Star:
      case Ch.Underscore:
        return this.emphasisRun(pos, to, st);
      case Ch.Tilde: {
        const end = this.tildeRun(pos, to, st);
        return end > pos ? end : this.scriptSpan(pos, to, depth, st);
      }
      case Ch.LBracket:
        return this.bracket(pos, to, depth, st, false);
      case Ch.Bang:
        return s.charCodeAt(pos + 1) === Ch.LBracket ? this.bracket(pos + 1, to, depth, st, true) : pos;
      case Ch.Lt:
        return this.angle(pos, to, st);
      case Ch.Amp: {
        const e = entityAt(s, pos);
        if (!e || pos + e.length > to) return pos;
        this.push(st, pos, pos + e.length, { t: "Text", text: e.text }, { special: true });
        return pos + e.length;
      }
      case Ch.Dollar:
        return this.dollar(pos, to, st);
      case Ch.At:
        return this.citeInText(pos, to, st);
      case Ch.Caret: {
        const end = this.inlineNote(pos, to, depth, st);
        return end > pos ? end : this.scriptSpan(pos, to, depth, st);
      }
      case Ch.LBrace:
        return this.trailingAttr(pos, to, depth, st);
      case Ch.Colon:
        return this.linkifyAt(pos, to, st);
      default:
        return pos;
    }
  }

  /**
   * The end of the construct at `pos` without producing anything, or
   * `pos + 1` when there is none: how a link label scan steps over code
   * spans, math and nested brackets.
   */
  private skip(pos: number, to: number, depth: number): number {
    const known = this.skipMemo.get(pos);
    if (known !== undefined) return known;
    let end: number;
    if (depth >= MAX_NESTING) end = to + 1;
    else {
      const c = this.src.charCodeAt(pos);
      if (c < 128 && SPECIAL[c]) {
        const st: ScanState = { out: new ItemList(), textStart: pos, delims: null, lastDelim: null, silent: true, floor: this.floor };
        end = this.construct(pos, to, depth + 1, st);
        if (end <= pos) end = pos + 1;
      } else end = pos + 1;
    }
    this.skipMemo.set(pos, end);
    return end;
  }

  // ---------------------------------------------------------------- line breaks and escapes

  private newline(pos: number, to: number, st: ScanState): number {
    // Trailing spaces before the line ending: two or more make a hard break; they are never kept.
    let k = pos;
    while (k > st.textStart && this.src.charCodeAt(k - 1) === Ch.Space) k--;
    const hard = pos - k >= 2;
    this.flushText(st, k);
    this.push(st, k, pos + 1, { t: hard ? "LineBreak" : "SoftBreak" });
    let next = pos + 1;
    while (next < to && isSpaceCode(this.src.charCodeAt(next))) next++;
    st.textStart = next;
    return next;
  }

  private backslash(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    const next = s.charCodeAt(pos + 1);
    if (pos + 1 < to) {
      // Math and LaTeX first: \( \[ are also escapes, and \begin{...} would otherwise be text.
      if (next === 40 /* ( */) {
        const close = this.index.findBackslashClose(pos + 2, to, ")");
        if (close >= 0) {
          if (!st.silent) this.push(st, pos, close + 2, { t: "Math", tex: s.slice(pos + 2, close), pos: this.posAt(pos) });
          return close + 2;
        }
      } else if (next === Ch.LBracket) {
        const close = this.index.findBackslashClose(pos + 2, to, "]");
        if (close >= 0) return this.display(pos, close + 2, s.slice(pos + 2, close), undefined, to, st);
      } else if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122)) {
        const end = this.latex(pos, to, st);
        if (end > pos) return end;
      }
    }
    if (pos + 1 < to && next === Ch.Newline) {
      this.push(st, pos, pos + 2, { t: "LineBreak" });
      let k = pos + 2;
      while (k < to && isSpaceCode(s.charCodeAt(k))) k++;
      st.textStart = k;
      return k;
    }
    if (pos + 1 < to && isAsciiPunct(next)) {
      // "-18\,°C", "5\,km": after a digit, \, is LaTeX's thin space, not an escaped comma.
      const thin = next === 0x2c && pos > 0 && /\d/.test(s[pos - 1]!) && pos + 2 < to && !/[\s\d]/.test(s[pos + 2]!);
      this.push(st, pos, pos + 2, { t: "Text", text: thin ? " " : s[pos + 1] }, { special: true });
      return pos + 2;
    }
    // Before any other character but a space the backslash stays, but the two are an item of their
    // own (bare links end there, as in the old reader).
    if (pos + 1 < to && next !== Ch.Space) {
      const end = pos + (next >= 0xd800 && next <= 0xdbff && pos + 2 < to ? 3 : 2);
      this.push(st, pos, end, { t: "Text", text: s.slice(pos, end) }, { special: true });
      return end;
    }
    return pos;
  }

  // ---------------------------------------------------------------- code spans

  private codeSpan(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    let n = 0;
    while (s.charCodeAt(pos + n) === Ch.Backtick) n++;
    // A run that is part of a longer run is only reached at its start.
    const close = this.closingTicks(pos + n, n, to);
    if (close < 0) {
      // No closer: the whole run is literal text.
      return pos + n;
    }
    if (!st.silent) {
      let text = s.slice(pos + n, close).replace(/\n/g, " ");
      if (text.length > 1 && text[0] === " " && text[text.length - 1] === " " && /[^ ]/.test(text)) text = text.slice(1, -1);
      this.push(st, pos, close + n, { t: "Code", text });
    }
    return close + n;
  }

  /** Start of the next run of exactly `n` backticks at or after `from` and before `to`, or -1. */
  private closingTicks(from: number, n: number, to: number): number {
    if (!this.ticks) {
      this.ticks = new Map();
      const s = this.src;
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) !== Ch.Backtick) continue;
        let m = 1;
        while (s.charCodeAt(i + m) === Ch.Backtick) m++;
        let list = this.ticks.get(m);
        if (!list) this.ticks.set(m, (list = []));
        list.push(i);
        i += m - 1;
      }
    }
    const list = this.ticks.get(n);
    if (!list) return -1;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo] + n <= to ? list[lo] : -1;
  }

  // ---------------------------------------------------------------- emphasis delimiters

  /** Flanking per spec 6.2: what is before and after a delimiter run. */
  private flanking(start: number, end: number, to: number, floor: number): { left: boolean; right: boolean; prevPunct: boolean; nextPunct: boolean } {
    const prev = start > floor ? codePointBefore(this.src, start, floor) : Ch.Space;
    const next = end < to ? codePointAt(this.src, end, to) : Ch.Space;
    const prevWs = isWhitespace(prev);
    const nextWs = isWhitespace(next);
    const prevPunct = isPunct(prev);
    const nextPunct = isPunct(next);
    const left = !nextWs && (!nextPunct || prevWs || prevPunct);
    const right = !prevWs && (!prevPunct || nextWs || nextPunct);
    return { left, right, prevPunct, nextPunct };
  }

  private emphasisRun(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    const ch = s[pos] as "*" | "_";
    let end = pos;
    while (end < to && s[end] === ch) end++;
    if (st.silent) return end;
    const f = this.flanking(pos, end, to, st.floor);
    const canOpen = ch === "*" ? f.left : f.left && (!f.right || f.prevPunct);
    const canClose = ch === "*" ? f.right : f.right && (!f.left || f.nextPunct);
    const it = this.push(st, pos, end, { t: "Text", text: s.slice(pos, end) });
    if (canOpen || canClose) addDelim(st, it, ch, end - pos, end - pos, canOpen, canClose, pos);
    return end;
  }

  /**
   * pandoc's `^superscript^` and `~subscript~` (H~2~O, 2^10^, Smith^1^): the
   * text between the marks may not hold an unescaped space or be empty, so a
   * stray ^ or ~ in prose stays text.
   */
  private scriptSpan(pos: number, to: number, depth: number, st: ScanState): number {
    const s = this.src;
    const mark = s.charCodeAt(pos);
    let k = pos + 1;
    for (; k < to; k++) {
      const c = s.charCodeAt(k);
      if (c === Ch.Backslash) {
        k++;
        continue;
      }
      if (c === mark) break;
      if (c === 32 || c === 9 || c === 10 || c === 13) return pos;
    }
    if (k >= to || k === pos + 1) return pos;
    if (!st.silent) {
      const content = this.tokenize(pos + 1, k, depth + 1);
      this.push(st, pos, k + 1, mark === Ch.Caret ? { t: "Superscript", content: [] } : { t: "Subscript", content: [] }, { kids: content });
    }
    return k + 1;
  }

  /** `~~` strikethrough: runs of two or more; an odd run leaves one `~` at its start as text. */
  private tildeRun(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    let end = pos;
    while (end < to && s.charCodeAt(end) === Ch.Tilde) end++;
    const n = end - pos;
    if (n < 2) return pos;
    if (st.silent) return end;
    const f = this.flanking(pos, end, to, st.floor);
    let at = pos;
    if (n % 2) {
      this.push(st, at, at + 1, { t: "Text", text: "~" }, { lone: true });
      at++;
    }
    for (; at < end; at += 2) {
      const it = this.push(st, at, at + 2, { t: "Text", text: "~~" });
      if (f.left || f.right) addDelim(st, it, "~", 1, 0, f.left, f.right, pos);
    }
    return end;
  }

  // ---------------------------------------------------------------- links, images, footnotes, bracketed citations

  /**
   * The `]` that ends a link label opened at `open`, stepping over whole
   * constructs; -1 when there is none. With `noNested`, a construct starting
   * with `[` inside (a link, citation or footnote reference) means no label.
   */
  labelEnd(open: number, to: number, depth: number, noNested: boolean): number {
    const key = `${to}:${noNested}`;
    let memo = this.labelMemo.get(key);
    if (!memo) this.labelMemo.set(key, (memo = new Map()));
    const known = memo.get(open);
    if (known !== undefined) return known;
    // The brackets met on the way are still open; they end at the `]` that ends the level they open,
    // or nowhere when this one ends nowhere. Remembering that keeps many unclosed `[` linear.
    const s = this.src;
    const open_: number[] = [open];
    let pos = open + 1;
    while (pos < to) {
      const c = s.charCodeAt(pos);
      if (c === Ch.RBracket) {
        const o = open_.pop()!;
        memo.set(o, pos);
        if (o === open) return pos;
      }
      const prev = pos;
      pos = this.skip(pos, to, depth);
      if (c === Ch.LBracket) {
        if (prev !== pos - 1) {
          if (noNested) break;
          continue;
        }
        // A bracket whose end is known already: jump over it, or stop when it has none.
        const end = memo.get(prev);
        if (end === undefined) open_.push(prev);
        else if (end < 0) break;
        else pos = end + 1;
      }
    }
    for (const o of open_) memo.set(o, -1);
    return -1;
  }

  /** `[` (or the `[` of `![`): a link or image, a footnote reference, a bracketed citation, or literal text. */
  private bracket(open: number, to: number, depth: number, st: ScanState, image: boolean): number {
    const s = this.src;
    const start = image ? open - 1 : open;
    if (!st.silent) this.textBeforeLabel = start - st.textStart;
    // A bracketed citation comes first; it gives way to a link by not being followed by ( or [.
    if (!image) {
      const cite = this.bracketCite(open, to, st);
      if (cite > open) return cite;
    }
    // Links and images.
    const link = this.linkAt(open, to, depth, image);
    if (link) {
      if (!st.silent) {
        let content: ItemList;
        if (image) content = this.ownText(open + 1, link.labelEnd, depth + 1);
        else {
          this.linkDepth++;
          content = this.tokenize(open + 1, link.labelEnd, depth + 1);
          this.linkDepth--;
        }
        if (image) {
          const node: Extract<Inline, { t: "Image" }> = { t: "Image", src: decodePath(link.url), alt: [], pos: this.posAt(start) };
          if (link.title !== undefined) node.title = link.title;
          let end = link.end;
          const a = s.charCodeAt(end) === Ch.LBrace && end < to ? readAttrAt(s, end, to) : null;
          if (a && a.end <= to) end = a.end;
          this.push(st, start, end, node, { kids: content, attr: a?.attr ?? null, raw: s.slice(open + 1, link.labelEnd) });
          return end;
        }
        const node: Extract<Inline, { t: "Link" }> = { t: "Link", url: link.url, content: [] };
        if (link.title !== undefined) node.title = link.title;
        this.push(st, start, link.end, node, { kids: content });
        return link.end;
      }
      return link.end;
    }
    if (image) return start;
    // Footnote reference [^label].
    if (s.charCodeAt(open + 1) === Ch.Caret) {
      const m = /^\[\^([^\]\s]+)\]/.exec(s.slice(open, Math.min(to, open + 1002)));
      if (m && open + m[0].length <= to) {
        const end = open + m[0].length;
        if (this.host.hasNote(m[1])) {
          if (!st.silent) {
            const pos = this.posAt(open);
            const blocks = this.host.noteBlocks(m[1], pos);
            this.push(st, open, end, { t: "Note", blocks, pos });
          }
          return end;
        }
        // An undefined footnote stays as written, all of it.
        if (!st.silent) this.host.warn(`Footnote [^${m[1]}] has no definition`, this.posAt(open), `Add a line "[^${m[1]}]: text" to define it.`);
        return end;
      }
    }
    return open;
  }

  /** An inline link `[text](url "title")` or a reference link, with the label ending at `labelEnd`. */
  private linkAt(open: number, to: number, depth: number, image: boolean): { labelEnd: number; end: number; url: string; title?: string } | null {
    const s = this.src;
    const labelEnd = this.labelEnd(open, to, depth, !image);
    if (labelEnd < 0) return null;
    let pos = labelEnd + 1;
    if (pos < to && s.charCodeAt(pos) === 40) {
      // A `(` that ends the text leaves no link at all, not even a reference link (the old reader's rule).
      if (pos + 1 >= to) return null;
      const r = this.inlineLinkTail(pos, to);
      if (r) return { labelEnd, ...r };
    }
    // A reference link: full [text][label], collapsed [text][] or shortcut [text].
    let label: string | null = null;
    if (pos < to && s.charCodeAt(pos) === Ch.LBracket) {
      const end = this.labelEnd(pos, to, depth, false);
      if (end >= 0) {
        label = s.slice(pos + 1, end);
        pos = end + 1;
      } else pos = labelEnd + 1;
    }
    if (!label) label = s.slice(open + 1, labelEnd);
    if (label.length > 999) return null;
    const def = this.host.refs.get(normalizeLabel(label));
    if (!def) return null;
    return { labelEnd, end: pos, url: def.url, ...(def.title !== undefined ? { title: def.title } : {}) };
  }

  /** `(destination "title")` after a link label; null when it is not one. */
  private inlineLinkTail(paren: number, to: number): { end: number; url: string; title?: string } | null {
    const s = this.src;
    let pos = paren + 1;
    while (pos < to && isWhitespaceOrNewline(s.charCodeAt(pos))) pos++;
    if (pos >= to) return null;
    let url = "";
    let title: string | undefined;
    const start = pos;
    const dest = scanDestination(s, pos, to);
    if (dest) {
      url = normalizeLink(unescapeText(dest.raw));
      if (validateLink(url)) pos = dest.end;
      else if (dest.raw !== "") return null;
      else url = "";
    }
    const afterDest = pos;
    while (pos < to && isWhitespaceOrNewline(s.charCodeAt(pos))) pos++;
    // A title needs blank space before it, unless there is no destination.
    if (pos < to && (pos > afterDest || afterDest === start)) {
      const t = scanTitle(s, pos, to);
      if (t) {
        title = unescapeText(t.raw);
        pos = t.end;
        while (pos < to && isWhitespaceOrNewline(s.charCodeAt(pos))) pos++;
      }
    }
    if (pos >= to || s.charCodeAt(pos) !== 41) return null;
    return title !== undefined ? { end: pos + 1, url, title } : { end: pos + 1, url };
  }

  /** `[prefix @key, locator; ...]`: citations and cross-references in brackets. */
  private bracketCite(open: number, to: number, st: ScanState): number {
    const s = this.src;
    if (s.charCodeAt(open + 1) === Ch.Caret) return open;
    const close = this.index.matchBracket(open, to);
    if (close < 0) return open;
    const after = s.charCodeAt(close + 1);
    if (close + 1 < to && (after === Ch.LBracket || after === 40)) return open;
    // Split at top-level semicolons; every part must name a key.
    const parts: { a: number; b: number }[] = [];
    let a = open + 1;
    for (;;) {
      const semi = this.index.nextTopSemicolon(open, a, close);
      if (semi < 0) {
        parts.push({ a, b: close });
        break;
      }
      parts.push({ a, b: semi });
      a = semi + 1;
    }
    const parsed: CitePart[] = [];
    for (const p of parts) {
      const part = this.citePart(p.a, p.b);
      if (!part) return open;
      parsed.push(part);
    }
    if (st.silent) return close + 1;
    // Consecutive ordinary citations make one Cite; a year-only citation or a
    // cross-reference (which keeps the text around it as text) stands alone.
    // The groups are separated by ", ".
    const pos = this.posAt(open);
    const groups: Inline[][] = [];
    let cite: Extract<Inline, { t: "Cite" }> | null = null;
    for (const part of parsed) {
      const label = crossRefLabel(part.key);
      if (label) {
        const g: Inline[] = [];
        if (part.prefix) g.push({ t: "Text", text: part.prefix + " " });
        g.push({ t: "Ref", label, style: "auto", pos });
        if (part.rest.trimEnd()) g.push({ t: "Text", text: part.rest.trimEnd() });
        groups.push(g);
        cite = null;
      } else if (part.year) {
        groups.push([{ t: "Cite", items: [citeItem(part)], mode: "year", pos }]);
        cite = null;
      } else if (cite) cite.items.push(citeItem(part));
      else {
        cite = { t: "Cite", items: [citeItem(part)], mode: "paren", pos };
        groups.push([cite]);
      }
    }
    this.flushText(st, open);
    const raw = s.slice(open, close + 1);
    // The text around citations here is not typographed or linked.
    groups.forEach((g, k) => {
      if (k > 0) st.out.push({ t: "Text", text: ", " }, { opaque: true });
      for (const node of g) st.out.push(node, node.t === "Text" ? { opaque: true } : { raw });
    });
    st.textStart = close + 1;
    return close + 1;
  }

  /** One part of a bracketed citation, `prefix @key rest`, in `src[a, b)`; null when it names no key. */
  private citePart(a: number, b: number): CitePart | null {
    const s = this.src;
    let at = this.index.citeAt(a, b);
    // Leading blank space before the @ counts as "after whitespace".
    if (at < 0) {
      let k = a;
      while (k < b && /\s/.test(s[k])) k++;
      if (k < b && k > a && (s[k] === "@" || (s[k] === "-" && s[k + 1] === "@"))) at = k;
      else return null;
    }
    const year = s[at] === "-";
    const keyAt = at + (year ? 2 : 1);
    const keyEnd = this.index.citeKeyEnd(keyAt);
    if (keyEnd < 0 || keyEnd > b) return null;
    const key = s[keyAt] === "{" ? s.slice(keyAt + 1, keyEnd - 1).trim() : s.slice(keyAt, keyEnd);
    const prefix = s.slice(a, at).trim();
    const rest = s.slice(keyEnd, b);
    return { prefix, key, rest, year };
  }

  // ---------------------------------------------------------------- citations in running text

  /** `@key` (or `@fig:x`) in running text, with an optional ` [locator]` after a citation. */
  private citeInText(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    if (pos > 0 && isWordChar(s[pos - 1])) return pos;
    const keyEnd = this.index.citeKeyEnd(pos + 1);
    if (keyEnd < 0 || keyEnd > to) return pos;
    const key = s[pos + 1] === "{" ? s.slice(pos + 2, keyEnd - 1).trim() : s.slice(pos + 1, keyEnd);
    const label = crossRefLabel(key);
    if (label) {
      if (!st.silent) this.push(st, pos, keyEnd, { t: "Ref", label, style: "auto", pos: this.posAt(pos) });
      return keyEnd;
    }
    let end = keyEnd;
    let item: Extract<Inline, { t: "Cite" }>["items"][number] = { key };
    if (s.charCodeAt(keyEnd) === Ch.Space && s.charCodeAt(keyEnd + 1) === Ch.LBracket) {
      // A locator in brackets right after the key: up to the first ], with no [ or @ in it.
      const m = /^[^[\]@]*\]/.exec(s.slice(keyEnd + 2, Math.min(to, keyEnd + 2 + 1000)));
      const close = m ? keyEnd + 1 + m[0].length : -1;
      const after = s.charCodeAt(close + 1);
      // Followed by ( [ : or { the brackets are a link, a definition's label or a span, not a locator.
      const followed = close + 1 < to && (after === Ch.LBracket || after === 40 || after === Ch.Colon || after === Ch.LBrace);
      if (close > 0 && !followed && s.slice(keyEnd + 2, close).trim()) {
        const loc = splitLocator(s.slice(keyEnd + 2, close));
        item = { key, ...loc };
        end = close + 1;
      }
    }
    if (!st.silent) this.push(st, pos, end, { t: "Cite", items: [item], mode: "text", pos: this.posAt(pos) });
    return end;
  }

  // ---------------------------------------------------------------- notes

  private inlineNote(pos: number, to: number, depth: number, st: ScanState): number {
    if (this.src.charCodeAt(pos + 1) !== Ch.LBracket) return pos;
    if (!st.silent) this.textBeforeLabel = pos - st.textStart;
    const close = this.labelEnd(pos + 1, to, depth, false);
    if (close < 0) return pos;
    if (!st.silent) {
      const where = this.posAt(pos);
      const id = this.host.openInlineNote();
      const content = this.ownText(pos + 2, close, depth + 1);
      const blocks = this.host.closeInlineNote(id, content, this.src.slice(pos + 2, close));
      this.push(st, pos, close + 1, { t: "Note", blocks, pos: where });
    }
    return close + 1;
  }

  // ---------------------------------------------------------------- autolinks and raw HTML

  private angle(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    // An autolink holds no blank space and no `<`; the closing `>` is looked up, not searched for.
    const close = this.markers.next(">", pos + 1);
    const stop = Math.min(...[" ", "\n", "<"].map((m) => this.markers.next(m, pos + 1)).filter((k) => k >= 0), to);
    if (close > 0 && close < stop) {
      const inner = s.slice(pos + 1, close);
      if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*$/.test(inner)) {
        const url = normalizeLink(inner);
        if (validateLink(url)) {
          if (!st.silent) this.push(st, pos, close + 1, { t: "Link", url, content: [] }, { kids: textList(normalizeLinkText(inner)), auto: true });
          return close + 1;
        }
      } else if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(inner)) {
        const url = normalizeLink("mailto:" + inner);
        if (validateLink(url)) {
          if (!st.silent) this.push(st, pos, close + 1, { t: "Link", url, content: [] }, { kids: textList(normalizeLinkText(inner)), auto: true });
          return close + 1;
        }
      }
    }
    const n = htmlLengthAt(s, pos, to, this.markers);
    if (n > 0) {
      if (!st.silent) {
        const html = s.slice(pos, pos + n);
        this.push(st, pos, pos + n, { t: "RawInline", format: "html", text: html, pos: this.posAt(pos) });
        if (/^<a[>\s]/i.test(html)) this.linkDepth++;
        else if (/^<\/a\s*>/i.test(html)) this.linkDepth--;
      }
      return pos + n;
    }
    return pos;
  }

  /** A bare URL whose schema ends at this `:` (the schema is the end of the text run before it). */
  private linkifyAt(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    // Only `scheme://` here; e-mail addresses and `mailto:` are found later, in whole text runs.
    if (this.linkDepth > 0 || pos + 3 > to || s.charCodeAt(pos + 1) !== 47 || s.charCodeAt(pos + 2) !== 47) return pos;
    // The scheme is the run of scheme characters that ends the plain text before the colon. While a
    // label is scanned there is no such text; the old reader then required the text before the
    // label to be at least as long as the scheme.
    let start = pos;
    while (start > (st.silent ? this.floor : st.textStart) && /[a-z0-9.+-]/i.test(s[start - 1])) start--;
    if (start === pos || !/[a-z]/i.test(s[start])) return pos;
    if (st.silent && this.textBeforeLabel < pos - start) return pos;
    // A link is at most about 10,000 characters long; looking further is wasted work.
    const found = linkAtStart(s.slice(start, Math.min(to, start + 20_000)));
    if (!found || found.index !== 0) return pos;
    if (found.url.length <= pos - start) return pos;
    // Asterisks at the end belong to emphasis.
    let urlEnd = found.url.length;
    while (urlEnd > 0 && found.url[urlEnd - 1] === "*") urlEnd--;
    const url = found.url.slice(0, urlEnd);
    const href = normalizeLink(url);
    if (!validateLink(href)) return pos;
    if (!st.silent) this.push(st, start, start + url.length, { t: "Link", url: href, content: [] }, { kids: textList(normalizeLinkText(url)), auto: true });
    return start + url.length;
  }

  // ---------------------------------------------------------------- math

  private dollar(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    if (s.charCodeAt(pos + 1) === Ch.Dollar) {
      const close = this.index.findDisplayDollarClose(pos + 2, to);
      if (close < 0) {
        if (!st.silent) this.host.warn("Display math opened with $$ is never closed", this.posAt(pos), "Close it with $$. Display math cannot contain a blank line.");
        return pos + 2;
      }
      const tex = s.slice(pos + 2, close);
      if (!tex.trim()) return close + 2;
      return this.display(pos, close + 2, tex, undefined, to, st);
    }
    const close = this.index.findInlineDollarClose(pos, to);
    if (close < 0) {
      if (!st.silent) this.unclosedDollar(pos, to);
      return pos;
    }
    const tex = s.slice(pos + 1, close);
    // "$3.78 per visitor versus $3.41": money, not a formula, though pandoc's rule would pair the signs.
    if (looksLikeMoney(tex)) return pos;
    if (!st.silent) this.push(st, pos, close + 1, { t: "Math", tex, pos: this.posAt(pos) });
    return close + 1;
  }

  /**
   * A $ that never closes stays text, as in pandoc; when what follows it is plainly a formula
   * ("$x = 1 and ..."), the closing $ was forgotten: MD002, with an (unsafe) fix closing it where the
   * formula seems to end, before the first word of prose. Money ("$5") never gets here.
   */
  private unclosedDollar(pos: number, to: number): void {
    const s = this.src;
    if (!/[A-Za-z\\]/.test(s[pos + 1] ?? "")) return;
    // The formula runs to the first word of two or more letters that is not a command's name, or the line's end.
    let end = pos + 1;
    let i = pos + 1;
    while (i < to && s[i] !== "\n" && s[i] !== "$") {
      if (s[i] === "\\") {
        i++;
        while (i < to && /[A-Za-z]/.test(s[i]!)) i++;
        end = i;
        continue;
      }
      if (/[A-Za-z]/.test(s[i]!) && /[A-Za-z]/.test(s[i + 1] ?? "")) break;
      i++;
      if (!/\s/.test(s[i - 1]!)) end = i;
    }
    while (end > pos + 1 && /[,.;:]/.test(s[end - 1]!)) end--;
    const formula = s.slice(pos, end);
    // Only something that is unmistakably math: a command, a script or an operator.
    if (!/[\\^_=+<>{}]/.test(formula.slice(1))) return;
    // "$x = 1 $": the closing $ is there, but a space before it keeps it from closing.
    const spaced = s[i] === "$" && !s.slice(end, i).trim();
    const old = spaced ? s.slice(pos, i + 1) : formula;
    this.host.warn(`Unclosed $: "${formula.length > 40 ? `${formula.slice(0, 39)}…` : formula}" is shown as text, not math`, this.posAt(pos), spaced ? "A closing $ must follow the formula directly, with no space before it" : "Close the formula with a $ (a $ followed by a digit, as in $5, stays text)", {
      code: "MD002",
      fix: { old, new: `${formula}$`, safe: false },
    });
  }

  /** Display math inside the text, with an optional `{#eq:x}` after it. */
  private display(pos: number, end: number, tex: string, env: string | undefined, to: number, st: ScanState): number {
    let stop = end;
    let attr: AttrSpec | undefined;
    if (env === undefined) {
      const a = readAttrAt(this.src, end, to);
      if (a) {
        attr = a.attr;
        stop = a.end;
      }
    }
    if (!st.silent) {
      const d: DisplayMath = { t: "$display", tex, pos: this.posAt(pos) };
      if (env !== undefined) d.env = env;
      if (attr) d.attr = attr;
      this.push(st, pos, stop, d);
    }
    return stop;
  }

  // ---------------------------------------------------------------- LaTeX commands

  /** `\name` with its arguments: references, citations, labels, environments, or raw LaTeX. */
  private latex(pos: number, to: number, st: ScanState): number {
    const s = this.src;
    let k = pos + 1;
    while (k < to && /[A-Za-z]/.test(s[k])) k++;
    const name = s.slice(pos + 1, k);
    if (name === "begin") {
      const end = this.environment(pos, k, to, st);
      if (end > pos) return end;
    }
    const ref = REF_STYLES[name];
    if (ref && s.charCodeAt(k) === Ch.LBrace) {
      const close = this.index.matchBracket(k, to);
      if (close > 0) {
        const labels = (name === "cref" || name === "Cref" ? s.slice(k + 1, close).split(",") : [s.slice(k + 1, close)]).map((l) => l.trim()).filter(Boolean);
        if (labels.length) {
          if (!st.silent) {
            const p = this.posAt(pos);
            const raw = s.slice(pos, close + 1);
            this.flushText(st, pos);
            if (name === "cref" || name === "Cref") st.out.push(crefGroup(labels, name === "Cref", p), { raw });
            else
              labels.forEach((label, i) => {
                if (i) st.out.push({ t: "Text", text: ", " }, { opaque: true });
                st.out.push({ t: "Ref", label, style: ref, pos: p }, { raw });
              });
            st.textStart = close + 1;
          }
          return close + 1;
        }
      }
    }
    const mode = CITE_MODES[name];
    if (mode) {
      const end = this.citeCommand(pos, k, to, mode, st);
      if (end > pos) return end;
    }
    if (name === "label" && s.charCodeAt(k) === Ch.LBrace) {
      const close = this.index.matchBracket(k, to);
      const id = close > 0 ? s.slice(k + 1, close).trim() : "";
      if (id) {
        if (!st.silent) {
          const span: Inline = { t: "Span", attr: { id }, content: [], pos: this.posAt(pos) };
          this.host.labelSpans.add(span);
          this.push(st, pos, close + 1, span);
        }
        return close + 1;
      }
    }
    // Any other command: raw LaTeX, with a star and the arguments that follow directly.
    let end = k;
    if (s[end] === "*") end++;
    for (;;) {
      const c = s.charCodeAt(end);
      if (end >= to || (c !== Ch.LBrace && c !== Ch.LBracket)) break;
      const close = this.index.matchBracket(end, to);
      if (close < 0) break;
      end = close + 1;
    }
    // \tikz \draw ...; without braces: the picture runs to its semicolon (outside braces).
    if (name === "tikz" && s[end - 1] !== "}") {
      let depth = 0;
      for (let e = end; e < to; e++) {
        const c = s[e];
        if (c === "\\") e++;
        else if (c === "{") depth++;
        else if (c === "}") depth = Math.max(0, depth - 1);
        else if (c === ";" && depth === 0) {
          end = e + 1;
          break;
        } else if (c === "\n" && s[e + 1] === "\n") break;
      }
    }
    if (!st.silent) this.push(st, pos, end, { t: "RawInline", format: "latex", text: s.slice(pos, end), pos: this.posAt(pos) });
    return end;
  }

  /** `\cite[pre][post]{a,b}` and friends. */
  private citeCommand(pos: number, k: number, to: number, mode: Extract<Inline, { t: "Cite" }>["mode"], st: ScanState): number {
    const s = this.src;
    const opts: string[] = [];
    let at = k;
    while (opts.length < 2 && s.charCodeAt(at) === Ch.LBracket) {
      const close = this.index.matchBracket(at, to);
      if (close < 0) return pos;
      opts.push(s.slice(at + 1, close));
      at = close + 1;
    }
    if (s.charCodeAt(at) !== Ch.LBrace) return pos;
    const close = this.index.matchBracket(at, to);
    if (close < 0) return pos;
    const keys = s.slice(at + 1, close).split(",").map((x) => x.trim()).filter(Boolean);
    if (!keys.length) return pos;
    if (!st.silent) {
      const items = keys.map((key) => ({ key }) as Extract<Inline, { t: "Cite" }>["items"][number]);
      const tilde = (x: string) => x.replace(/~/g, " ").trim();
      if (opts.length === 1 && opts[0].trim()) Object.assign(items[items.length - 1], splitLocator(tilde(opts[0])));
      if (opts.length === 2) {
        if (opts[0].trim()) items[0].prefix = tilde(opts[0]);
        if (opts[1].trim()) Object.assign(items[items.length - 1], splitLocator(tilde(opts[1])));
      }
      this.push(st, pos, close + 1, { t: "Cite", items, mode, pos: this.posAt(pos) });
    }
    return close + 1;
  }

  /** `\begin{name}...\end{name}` inside text: display math for math environments, raw LaTeX otherwise. */
  private environment(pos: number, k: number, to: number, st: ScanState): number {
    const s = this.src;
    // The name is everything inside balanced braces (a name with braces never finds its \end).
    let open = k;
    while (open < to && /\s/.test(s[open])) open++;
    if (s.charCodeAt(open) !== Ch.LBrace) return pos;
    const close = this.index.matchBracket(open, to);
    if (close < 0) return pos;
    const name = s.slice(open + 1, close).trim();
    const bodyStart = close + 1;
    const end = this.index.findEnvEnd(bodyStart, name, to);
    if (!end) {
      if (!st.silent) this.host.warn(`\\begin{${name}} has no matching \\end{${name}}`, this.posAt(pos), `Add \\end{${name}} to close the environment.`);
      return bodyStart;
    }
    if (isMathEnv(name)) return this.display(pos, end.end, s.slice(bodyStart, end.bodyEnd), name, to, st);
    if (!st.silent) this.push(st, pos, end.end, { t: "RawInline", format: "latex", text: s.slice(pos, end.end), pos: this.posAt(pos) });
    return end.end;
  }

  // ---------------------------------------------------------------- attributes

  /** In headings and captions, a `{...}` attribute list that ends the text. */
  private trailingAttr(pos: number, to: number, depth: number, st: ScanState): number {
    // Only at the end of a text of its own: not in link text. In an image description or an inline
    // note, the list is read and dropped, as in the old reader, which parsed those on their own.
    if (!this.opts.trailingAttrs || st.silent || depth !== this.ownDepth) return pos;
    const a = readAttrAt(this.src, pos, to);
    if (!a || /\S/.test(this.src.slice(a.end, to))) return pos;
    // Right after an image, the list is the image's (replacing what it had).
    const last = st.out.tail;
    if (st.textStart === pos && last?.node?.t === "Image") last.tailAttr = a.attr;
    else if (this.ownDepth === 0) this.attr = a.attr;
    // Blank space before the list stays text (typography sees it); the run is trimmed later.
    this.flushText(st, pos);
    st.textStart = to;
    return to;
  }
}

interface ScanState {
  out: ItemList;
  /** Start of the text as its own (an image description or a note is read like a separate text). */
  floor: number;
  /** Start of the plain text not yet pushed. */
  textStart: number;
  delims: Delim | null;
  lastDelim: Delim | null;
  /** Only measuring how far a construct reaches (no items, no diagnostics). */
  silent?: boolean;
}

interface CitePart {
  prefix: string;
  key: string;
  rest: string;
  year: boolean;
}

function citeItem(part: CitePart): Extract<Inline, { t: "Cite" }>["items"][number] {
  const item: Extract<Inline, { t: "Cite" }>["items"][number] = { key: part.key };
  if (part.prefix) item.prefix = part.prefix;
  Object.assign(item, splitLocator(part.rest));
  return item;
}

const REF_STYLES: Record<string, Extract<Inline, { t: "Ref" }>["style"]> = Object.assign(Object.create(null), {
  ref: "number",
  eqref: "eq",
  pageref: "page",
  autoref: "auto",
  cref: "auto",
  Cref: "auto",
});

const CITE_MODES: Record<string, Extract<Inline, { t: "Cite" }>["mode"]> = Object.assign(Object.create(null), {
  cite: "paren",
  citep: "paren",
  parencite: "paren",
  autocite: "paren",
  citealp: "paren",
  citet: "text",
  citealt: "text",
  textcite: "text",
  citeauthor: "author",
  citeyear: "year",
  citeyearpar: "year",
  nocite: "nocite",
});

const isWhitespaceOrNewline = (c: number): boolean => c === Ch.Space || c === Ch.Tab || c === Ch.Newline;

/** An image source is a path more often than a URL: percent escapes are decoded where that is safe. */
function decodePath(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function textList(text: string): ItemList {
  const l = new ItemList();
  l.push({ t: "Text", text });
  return l;
}

function addDelim(st: ScanState, item: Item, char: "*" | "_" | "~", count: number, orig: number, canOpen: boolean, canClose: boolean, run: number): void {
  const d: Delim = { char, count, origCount: orig, canOpen, canClose, prev: st.lastDelim, next: null, item, active: true, run };
  if (st.lastDelim) st.lastDelim.next = d;
  st.lastDelim = d;
  if (!st.delims) st.delims = d;
  item.delim = d;
}

function firstDelim(last: Delim | null): Delim | null {
  let d = last;
  while (d && d.prev) d = d.prev;
  return d;
}

/**
 * The spec's "process emphasis" (section 6.2, appendix): match closers with
 * the nearest compatible opener, wrap what is between them, and turn
 * leftover delimiters into text. A strong pair takes two characters from
 * each run; the two left behind as empty text keep the output the same as
 * a character-by-character matcher would produce.
 */
function processEmphasis(list: ItemList, first: Delim | null): void {
  // Lowest opener to consider, per closer kind, so that failing searches are not repeated.
  const openersBottom = new Map<string, Delim | null>();
  let closer: Delim | null = first;
  while (closer) {
    if (!closer.canClose) {
      closer = closer.next;
      continue;
    }
    const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.origCount % 3}`;
    const floor = openersBottom.has(key) ? openersBottom.get(key)! : null;
    let opener = closer.prev;
    let found = false;
    while (opener && opener !== floor) {
      if (opener.char === closer.char && opener.canOpen && opener.run !== closer.run) {
        const odd = (opener.canClose || closer.canOpen) && (opener.origCount + closer.origCount) % 3 === 0 && !(opener.origCount % 3 === 0 && closer.origCount % 3 === 0);
        if (!odd || closer.char === "~") {
          found = true;
          break;
        }
      }
      opener = opener.prev;
    }
    if (!found || !opener) {
      openersBottom.set(key, closer.prev);
      const next: Delim | null = closer.next;
      if (!closer.canOpen) unlinkDelim(closer);
      closer = next;
      continue;
    }
    // Wrap the items between opener and closer.
    const strike = closer.char === "~";
    const strong = !strike && opener.count >= 2 && closer.count >= 2;
    const use = strike ? 1 : strong ? 2 : 1;
    const inner = list.takeBetween(opener.item, closer.item);
    const kids = new ItemList();
    for (const it of inner) {
      it.prev = it.next = null;
      if (it.delim) {
        it.delim.active = false;
        it.delim = null;
      }
      reattach(kids, it);
    }
    const node: Inline = strike ? { t: "Strike", content: [] } : strong ? { t: "Strong", content: [] } : { t: "Emph", content: [] };
    const wrap: Item = { node, delim: null, prev: null, next: null, kids };
    list.insertAfter(opener.item, wrap);
    // Delimiters between opener and closer are gone from the stack.
    opener.next = closer;
    closer.prev = opener;
    opener.count -= use;
    closer.count -= use;
    setDelimText(opener);
    setDelimText(closer);
    if (strong) {
      list.insertBefore(wrap, { node: { t: "Text", text: "" }, delim: null, prev: null, next: null });
      list.insertAfter(wrap, { node: { t: "Text", text: "" }, delim: null, prev: null, next: null });
    }
    // A lone `~` left over from the closing run belongs after the strikethrough.
    if (strike) {
      const lastKid = kids.tail;
      if (lastKid && lastKid.lone) {
        kids.remove(lastKid);
        list.insertAfter(wrap, lastKid);
      }
    }
    if (opener.count === 0) {
      list.remove(opener.item);
      unlinkDelim(opener);
    }
    if (closer.count === 0) {
      const next: Delim | null = closer.next;
      list.remove(closer.item);
      unlinkDelim(closer);
      closer = next;
    }
  }
}

function reattach(kids: ItemList, it: Item): void {
  it.prev = kids.tail;
  it.next = null;
  if (kids.tail) kids.tail.next = it;
  else kids.head = it;
  kids.tail = it;
}

function setDelimText(d: Delim): void {
  const node = d.item.node;
  if (node && node.t === "Text") node.text = d.char === "~" ? "~~".repeat(d.count) : d.char.repeat(d.count);
}

function unlinkDelim(d: Delim): void {
  if (d.prev) d.prev.next = d.next;
  if (d.next) d.next.prev = d.prev;
  d.item.delim = null;
  d.prev = d.next = null;
}

/**
 * Whether what lies between two dollar signs is prose with amounts of money
 * rather than a formula: it starts with a number and holds two plain words in
 * a row ("per visitor"), outside any \text{...}. Formulas spell words with
 * commands (\leq, \sin) or \text, so they are not caught.
 */
function looksLikeMoney(tex: string): boolean {
  if (!/^\d/.test(tex)) return false;
  const bare = tex.replace(/\\(?:text|mathrm|textrm|mbox|operatorname)\s*\{[^{}]*\}/g, " ").replace(/\\[A-Za-z]+/g, " ");
  return /(?:^|[^A-Za-z\\])[A-Za-z]{2,}\s+[A-Za-z]{2,}(?![A-Za-z])/.test(bare);
}
