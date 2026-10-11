/**
 * The block phase (CommonMark spec, appendix "A parsing strategy", phase 1).
 *
 * Lines are consumed one at a time. For each line the parser first walks
 * down the open blocks and checks which of them the line continues (a block
 * quote needs its `>`, a list item its indentation, a fenced div its range),
 * then looks for new block starts, and finally adds what is left of the line
 * to the open leaf or starts a paragraph. Lines a paragraph continues
 * without the markers of its containers are "lazy" continuation lines.
 *
 * texwright's blocks take part in the same loop: fenced divs (`:::`),
 * footnote definitions, definition lists, display math (`$$`, `\[`, math
 * environments), raw LaTeX environments and special lines (`\newpage`,
 * `[[toc]]`), table captions and GFM tables. Display math and LaTeX
 * environments may span lines a container does not mark (as paragraphs
 * may), so where they end is found ahead of time by scanning the source.
 */
import { BNode, type LinkDef, type Mark, type RangeMode } from "./blocktree.js";
import { htmlBlockEnds, htmlBlockStart } from "./html.js";
import { LineCursor, isBlankText, trimEndBlank, type Seg } from "./lines.js";
import { matchLinkDef, normalizeLabel, scanLinkDef } from "./linkparts.js";
import { ScanIndex, isMathEnv, parseAttrBody, readAttrAt, type AttrSpec } from "./scan.js";
import { normalizeLink, validateLink } from "./url.js";

/** Result of checking whether a line continues an open block. */
const enum Cont {
  Matched,
  NotMatched,
  /** The line was used up (a closing code fence, a div's closing line). */
  Consumed,
}

/** A block-level problem found while parsing (reported at the start of line `line`). */
export interface BlockIssue {
  line: number;
  message: string;
  hint: string;
  /** The diagnostic code; MD001 when absent. */
  code?: "TBL001";
}

const SPECIAL_LINES: Record<string, Mark> = {
  "\\newpage": "PageBreak",
  "\\pagebreak": "PageBreak",
  "\\clearpage": "PageBreak",
  "[[toc]]": "TOC",
  "[TOC]": "TOC",
  "\\tableofcontents": "TOC",
  "\\printbibliography": "Bibliography",
  "[[bibliography]]": "Bibliography",
};

/** Kinds of block start, for deciding what a lazy line may start. */
type StartKind = "quote" | "heading" | "fence" | "div" | "math" | "env" | "mark" | "html" | "hr" | "note" | "caption" | "list" | "definition";

/**
 * A line that lacks the marker of a block quote around an open paragraph
 * continues the paragraph unless it starts one of these (judged outside
 * the quote); one inside list items or footnotes only lacking their
 * indentation, unless it starts one of PARA_INTERRUPTERS. Kinds in
 * NEED_INDENT must also be inside the indentation of the context they are
 * judged in. (These are the rules of the reader texwright had before.)
 */
const QUOTE_INTERRUPTERS = new Set<StartKind>(["quote", "heading", "fence", "div", "math", "env", "mark", "html", "hr", "list", "caption"]);
const PARA_INTERRUPTERS = new Set<StartKind>(["quote", "heading", "fence", "div", "math", "env", "mark", "html", "hr", "list", "caption", "note"]);
const NEED_INDENT = new Set<StartKind>(["env"]);

/** The kind of block a line would start, by its look (for deciding what a lazy line may start). */
function lineKind(rest: string): StartKind {
  const c = rest[0];
  if (c === ">") return "quote";
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return "heading";
  if (/^(?:`{3,}|~{3,})/.test(rest)) return "fence";
  if (rest.startsWith(":::")) return "div";
  if (rest.startsWith("$$") || rest.startsWith("\\[")) return "math";
  if (rest.startsWith("\\begin")) return "env";
  if (/^[*+-](?:[ \t]|$)/.test(rest) || /^\d{1,9}[.)](?:[ \t]|$)/.test(rest)) return THEMATIC_RE.test(rest.trimEnd()) ? "hr" : "list";
  if (THEMATIC_RE.test(rest.trimEnd())) return "hr";
  if (c === "<") return "html";
  if (FOOTNOTE_DEF_RE.test(rest)) return "note";
  if (/^[Tt]able:/.test(rest)) return "caption";
  if (/^[:~](?:[ \t]|$)/.test(rest)) return "definition";
  return SPECIAL_LINES[rest.trimEnd()] ? "mark" : ("text" as StartKind);
}

/**
 * How deep containers may nest. A container whose content would be deeper
 * is kept, empty: the lines it would hold are dropped (DESIGN.md, "Limits").
 */
const MAX_DEPTH = 100;

/** A thematic break (spec 4.1), blank space at the end included. */
const THEMATIC_RE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A fenced div's closing line. */
const DIV_CLOSE_RE = /^[ \t]*:{3,}[ \t]*$/;
/** A footnote definition's start; its label holds no spaces (tabs it may). */
const FOOTNOTE_DEF_RE = /^\[\^([^\] ]+)\]:/;
const CAPTION_RE = /^[Tt]able:/;
/** A list item marker, indented less than four columns (spec 5.2). */
const LIST_MARKER_RE = /^[ \t]{0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;

export class BlockParser {
  readonly root = new BNode("doc", 0);
  /** The text parsed: the source with U+0000 replaced (spec section 2.3, "Insecure characters"). */
  readonly text: string;
  readonly lines: string[];
  /** The source lines as written, where positions are looked up (see Assembler.sourceMap). */
  readonly sourceLines: string[];
  /** Offset of each line in `text`. */
  readonly starts: number[];
  readonly refs = new Map<string, LinkDef>();
  /** Footnote definitions by label; a later definition replaces an earlier one. */
  readonly notes = new Map<string, BNode>();
  /** Every footnote definition, replaced ones included, in document order. */
  readonly allNotes: BNode[] = [];
  readonly issues: BlockIssue[] = [];
  /** Header lines whose table shape was already reported. */
  private readonly shapeReported = new Set<number>();
  private tip: BNode = this.root;
  /** Set by a block start that took the whole line (a fence, a div opener, display math). */
  private lineUsed = false;
  /** While a lazy line is tried for block starts: which kinds it may start. */
  private gate: ((kind: StartKind) => boolean) | null = null;
  /** While a lazy line is tried: the container display math opened on it must stay inside. */
  private lazyContext: BNode | null = null;
  /** While a lazy line is tried: a block quote decides (see lazyRules). */
  private lazyQuote = false;
  /** The last line that was blank once its containers' markers were read. */
  private lastBlank = -2;
  /** The last answer of setextAhead, which holds for the lines it looked at. */
  private setextMemo: { holder: BNode; from: number; until: number; result: boolean } | null = null;
  /** A container nested too deeply, and the last line it swallows. */
  private swallow: { node: BNode; until: number } | null = null;
  /** Closing lines divEnd found for the div openers inside a div it searched (see divEnd). */
  private readonly divClosers = new Map<number, { holder: BNode; closer: number }>();
  /** The last line when no line ending follows it, else -1 (see line). */
  private readonly openLast: number;
  private readonly index: ScanIndex;

  constructor(source: string) {
    const text = source.includes("\0") ? source.replace(/\0/g, "\ufffd") : source;
    this.text = text;
    this.lines = text.split("\n");
    this.sourceLines = text === source ? this.lines : source.split("\n");
    // A final line ending ends the last line; it does not start an empty one. A last line of only
    // blank space is dropped the same way (the old reader did so).
    const dropLast = this.lines.length > 1 && isBlankText(this.lines[this.lines.length - 1]);
    if (dropLast) this.lines.pop();
    this.openLast = dropLast ? -1 : this.lines.length - 1;
    this.starts = new Array<number>(this.lines.length);
    let at = 0;
    for (let k = 0; k < this.lines.length; k++) {
      this.starts[k] = at;
      at += this.lines[k].length + 1;
    }
    this.index = new ScanIndex(text);
  }

  parse(): BNode {
    for (let n = 0; n < this.lines.length; n++) this.line(n);
    while (this.tip !== this.root) this.close(this.tip, this.lines.length - 1);
    this.close(this.root, this.lines.length - 1);
    return this.root;
  }

  // ---------------------------------------------------------------- the line loop

  private line(n: number): void {
    if (this.swallow) {
      if (n <= this.swallow.until) return;
      this.closeBelow(this.swallow.node.parent!, n - 1);
      this.swallow = null;
    }
    const cur = new LineCursor(this.lines[n], n);
    // 1. Which open blocks does this line continue?
    let node = this.root;
    let unmatched: BNode | null = null;
    /** The cursor just after the last block quote marker the line has: where a lazy line's text starts. */
    let afterQuote: LineCursor | null = null;
    for (;;) {
      const child = node.last;
      if (!child || !child.open) break;
      const r = this.continues(child, cur, n);
      if (r === Cont.Matched) {
        node = child;
        child.matchLine = n;
        child.matchCol = cur.col;
        if (child.kind === "quote") afterQuote = cur.clone();
      } else if (r === Cont.Consumed) return;
      else {
        unmatched = child;
        break;
      }
    }
    // An unended last line adds nothing when nothing is left of it once the markers of the open
    // blocks are read (the old reader dropped it too): `> ```` then `> a` then `>` is the code "a".
    if (n === this.openLast && !unmatched && node !== this.root && cur.rawSeg().text === "") return;
    let lastMatched = node;
    if (cur.blank()) this.lastBlank = n;
    // A paragraph that is a link reference definition ends with it; the next line is read afresh.
    const para = this.tip;
    if (para.kind === "para" && para.defsEnd === n - 1) {
      this.close(para, n - 1);
      if (lastMatched === para) lastMatched = para.parent!;
    }
    const tipBefore = this.tip;

    // A leaf that spans a known range of lines takes them whether or not the containers match.
    if ((tipBefore.kind === "math" || tipBefore.kind === "rawtex") && n <= tipBefore.endLine && unmatched) {
      this.addSpanLine(tipBefore, this.lazySeg(n, afterQuote, tipBefore), n);
      return;
    }

    // 2. New block starts (not on a line that a link reference definition goes on over).
    let container: BNode = lastMatched;
    let started = false;
    const inDefinition = tipBefore.kind === "para" && tipBefore.defsEnd >= n;
    const lazyLeaf = unmatched && (tipBefore.kind === "para" || tipBefore.kind === "caption") && !this.divBetween(tipBefore, unmatched) ? tipBefore : null;
    if (!this.takesLines(container) && !inDefinition) {
      if (lazyLeaf) this.lazyRules(unmatched!, lazyLeaf);
      ({ container, started } = this.startBlocks(cur, container, n, unmatched ? lastMatched : null));
    }

    // 3. Lazy paragraph continuation.
    if (!started && lazyLeaf && !cur.blank()) {
      if (inDefinition || !this.endsLazily(unmatched!, lazyLeaf, cur, lastMatched, n)) {
        lazyLeaf.segs.push(this.lazySeg(n, afterQuote, lazyLeaf));
        return;
      }
      this.closeBelow(lastMatched, n - 1);
      ({ container, started } = this.startBlocks(cur, lastMatched, n, null));
    } else if (!started && unmatched) this.closeBelow(lastMatched, n - 1);

    // 4. Add the rest of the line.
    const blank = cur.blank();
    this.markBlank(container, blank, n);
    if (this.lineUsed) {
      this.lineUsed = false;
      return;
    }
    if (!container.open) return;
    switch (container.kind) {
      case "para":
      case "caption":
        if (!blank) container.segs.push(cur.rawSeg());
        else this.close(container, n - 1);
        return;
      case "table":
        if (!blank) container.rows.push(cur.segAfterBlank());
        return;
      case "code":
        container.segs.push(cur.seg());
        return;
      case "fence":
        container.segs.push(cur.rawSeg());
        return;
      case "html":
        container.segs.push(cur.rawSeg());
        if (htmlBlockEnds(container.htmlType, cur.rest())) this.close(container, n);
        return;
      case "math":
      case "rawtex":
        this.addSpanLine(container, cur.rawSeg(), n);
        return;
      case "heading":
      case "hr":
      case "mark":
        return;
      default:
        if (!blank) this.openPara(cur, n);
    }
  }

  /** Start a paragraph with the rest of line `n` (a `literal` one: see BNode.literal). */
  private openPara(cur: LineCursor, n: number, literal = false): BNode {
    const p = this.addChild(new BNode("para", n), n);
    p.segs.push(cur.segAfterBlank());
    p.literal = literal;
    if (!literal && p.segs[0].text.startsWith("[")) p.defsEnd = this.definitionEnd(p, n);
    return p;
  }

  /**
   * The last line of the link reference definition that the paragraph
   * `para`, opened at line `n`, starts with; -1 when it starts with none.
   * The old reader read a definition before any paragraph, so the line
   * after one starts afresh (`[a]: /u` then `    code` is a code block);
   * where it ends must be known before that line is read. A definition
   * can run over the lines the paragraph would take, so those are read
   * ahead, more each time, until more could not change the answer.
   */
  private definitionEnd(para: BNode, n: number): number {
    const chain = this.containers(para.parent!);
    const gate = this.gate;
    const lazyContext = this.lazyContext;
    const lazyQuote = this.lazyQuote;
    try {
      return this.definitionEndIn(para, chain, n);
    } finally {
      this.gate = gate;
      this.lazyContext = lazyContext;
      this.lazyQuote = lazyQuote;
    }
  }

  private definitionEndIn(para: BNode, chain: BNode[], n: number): number {
    let text = para.segs[0].text;
    let k = n + 1;
    let ended = false;
    for (let want = 1; ; want *= 2) {
      const { found, ranOut } = matchLinkDef(text, validateLink);
      if (!ranOut || ended) {
        if (!found) return -1;
        let last = n;
        for (let i = 0; i < found.end - 1; i++) if (text.charCodeAt(i) === 10) last++;
        return last;
      }
      for (let got = 0; got < want; got++, k++) {
        const line = k < this.lines.length ? this.paraLineAhead(para, chain, k) : null;
        if (line === null) {
          ended = true;
          break;
        }
        text += "\n" + line;
      }
    }
  }

  /**
   * The text line `k` would add to a link reference definition in the
   * paragraph `para` inside the containers `chain`, without its leading
   * blank space (as definitions read it), or null when the definition
   * would end before it: at a blank line, a div's closing line, or a line
   * that starts one of the blocks that end a definition. A line the
   * containers do not hold must also pass a block quote's lazyRules.
   */
  private paraLineAhead(para: BNode, chain: BNode[], k: number): string | null {
    const cur = new LineCursor(this.lines[k], k);
    let unmatched: BNode | null = null;
    let lastMatched = this.root;
    for (const b of chain) {
      if (b.kind === "div" && b.endLine === k) return null;
      if (!unmatched && this.continuesQuietly(b, cur) !== Cont.Matched) unmatched = b;
      if (!unmatched) lastMatched = b;
    }
    if (cur.blank() || isBlankText(this.lines[k])) return null;
    const at = cur.firstNonBlank();
    const rest = trimEndBlank(cur.text.slice(at));
    if (unmatched) this.lazyRules(unmatched, para);
    if (unmatched && this.lazyQuote) {
      // A block quote's lazy line is judged by the quote only; indented four columns or more, as
      // the quotes inside it judge it (see endsLazily).
      if (cur.indent() < 4 ? this.lazyStart(rest, cur, at, k, unmatched.parent!) : this.endsLazily(unmatched, para, cur, lastMatched, k)) return null;
    } else if ((unmatched || cur.indent() < 4) && this.endsDefinition(rest, cur, at, k, para.parent!)) {
      // Indented four columns or more, a held line goes on lazily; a lazy line is judged inside.
      return null;
    } else if (unmatched && lineKind(rest) === "definition" && this.gate?.("definition")) {
      // A lazy `:` or `~` line, even a bare one, starts the next definition of a list the
      // paragraph is in (see colonEnds).
      return null;
    }
    return cur.rest().replace(/^[ \t]+/, "");
  }

  /**
   * True when `rest` starts a block that ends a link reference definition
   * running over lines (the old reader's list): a block quote, heading,
   * code fence, thematic break, any list item, an HTML block of the first
   * six kinds, a div, display math or an environment that closes, a special
   * line, a footnote definition, a definition line or a caption with text.
   */
  private endsDefinition(rest: string, cur: LineCursor, at: number, n: number, container: BNode): boolean {
    if (/^[:~][ \t]+\S/.test(rest) || /^[Tt]able:[ \t]+\S/.test(rest) || /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return true;
    const kind = lineKind(rest);
    if (kind === "caption" || kind === "definition" || kind === "list") return false;
    return QUOTE_INTERRUPTERS.has(kind) || kind === "note" ? this.startsHere(kind, rest, cur, at, n, container) : false;
  }

  /** The containers from the outermost down to `b` (the document left out). */
  private containers(b: BNode): BNode[] {
    const chain: BNode[] = [];
    for (let c: BNode | null = b; c; c = c.parent) if (c.isContainer() && c.kind !== "doc") chain.unshift(c);
    return chain;
  }

  /**
   * True when a fenced div lies between `leaf` and the open block `unmatched`
   * that a line lacks: the div's content ends with the lines that block
   * holds, so the line cannot continue the leaf lazily.
   */
  private divBetween(leaf: BNode, unmatched: BNode): boolean {
    for (let b = leaf.parent; b && b !== unmatched.parent; b = b.parent) if (b.kind === "div") return true;
    return false;
  }

  /**
   * Open the blocks that start at the cursor, one inside the other, within
   * `container`. Returns the innermost block the line reached.
   */
  private startBlocks(cur: LineCursor, container: BNode, n: number, unmatchedBelow: BNode | null): { container: BNode; started: boolean } {
    let started = false;
    for (;;) {
      const opened = this.start(cur, container, n, started ? null : unmatchedBelow);
      this.gate = null;
      this.lazyContext = null;
      this.lazyQuote = false;
      if (!opened) break;
      started = true;
      container = opened;
      if (!opened.isContainer() || this.lineUsed) break;
    }
    return { container, started };
  }

  /**
   * Whether a line the rules of lazyRules let continue `leaf` lazily ends it
   * after all, the old reader judging it once more with its indentation
   * ignored. That happens in the block quotes nested in the outermost one
   * the line lacks, and inside the list items or footnote whose
   * indentation the line lacks. When the line starts a block there, the
   * open blocks it lacks close and it is read afresh outside them: `>>a`
   * then `    # b` is a code block, as is `   - a` then a tab and `<pre>`.
   */
  private endsLazily(unmatched: BNode, leaf: BNode, cur: LineCursor, lastMatched: BNode, n: number): boolean {
    let deciding: BNode | null = null;
    let inner = false;
    for (let b = leaf.parent; b && b !== unmatched.parent; b = b.parent) {
      if (b.kind !== "quote") continue;
      if (deciding) inner = true;
      deciding = b;
    }
    const at = cur.firstNonBlank();
    const rest = trimEndBlank(cur.text.slice(at));
    const kind = lineKind(rest);
    // Where the line is judged: outside the deciding block quote, or in the paragraph's container.
    const context = deciding ? deciding.parent! : leaf.parent!;
    // An environment needs the indentation of what it would start in. Without it, it still ends the
    // paragraph when its other lines are held by the paragraph's container, and starts outside.
    if (kind === "env") return cur.indent() < 4 && this.startsHere(kind, rest, cur, at, n, context);
    // A ": ..." line with a table after it where the paragraph is ends the paragraph, even when read
    // afresh where the line is it is no caption.
    if (cur.indent() < 4 && /^:[ \t]+\S/.test(rest) && this.captionAllowed(context, n)) return true;
    if (deciding) {
      // The quotes nested in the deciding one judge the line inside it; inside list items the line
      // lacks the indentation of, the line's own indentation is no indentation either.
      if (inner) {
        if (kind === "definition") return this.colonEnds(unmatched, leaf);
        return QUOTE_INTERRUPTERS.has(kind) && this.startsHere(kind, rest, cur, at, n, deciding);
      }
      const outdented = cur.indent() >= 4 && !this.isOpen(deciding.parent!, lastMatched);
      return outdented && QUOTE_INTERRUPTERS.has(kind) && this.startsHere(kind, rest, cur, at, n, context);
    }
    // Indented less than four columns, the line was tried for block starts already; but for a table
    // header whose delimiter row is on a line the paragraph's container holds.
    if (cur.indent() < 4) return rest.includes("|") && this.delimiterBelow(context, n, rest) !== null;
    if (kind === "definition") return this.colonEnds(unmatched, leaf);
    return PARA_INTERRUPTERS.has(kind) && this.startsHere(kind, rest, cur, at, n, context);
  }

  /** True when `rest`, on a lazy line, starts a block the rules of lazyRules allow. */
  private lazyStart(rest: string, cur: LineCursor, at: number, n: number, container: BNode): boolean {
    const kind = lineKind(rest);
    return !!this.gate && this.gate(kind) && this.startsHere(kind, rest, cur, at, n, container);
  }

  /** True when `b` is `lastMatched` or one of the blocks around it (a block the line continues). */
  private isOpen(b: BNode, lastMatched: BNode): boolean {
    for (let c: BNode | null = lastMatched; c; c = c.parent) if (c === b) return true;
    return false;
  }

  /** True when `rest`, which looks like a block start of `kind`, is a valid one inside `container`. */
  private startsHere(kind: StartKind, rest: string, cur: LineCursor, at: number, n: number, container: BNode): boolean {
    switch (kind) {
      case "math":
        return this.mathSpan(at, n, container, rest.startsWith("$$") ? "$$" : "\\[") !== null;
      case "env":
        return !this.inOpenDisplay() && !!this.envSpan(cur, at, n, container);
      case "fence": {
        const m = /^(`{3,}|~{3,})(.*)$/.exec(rest);
        return !!m && !(m[1][0] === "`" && m[2].includes("`"));
      }
      case "div":
        return divAttr(rest) !== null;
      case "html": {
        const html = htmlBlockStart(rest);
        return html !== 0 && html !== 7;
      }
      case "list":
        return !this.listTooDeep(cur, n, container);
      default:
        return true;
    }
  }

  /**
   * Set the rules for a line that could continue `para` lazily, where
   * `unmatched` is the outermost open block the line does not continue.
   * The outermost block quote the line lacks decides, judging the line
   * outside itself; without one, the paragraph decides, judging it inside
   * the list items or footnote that it lacks the indentation of.
   */
  private lazyRules(unmatched: BNode, para: BNode): void {
    let quote: BNode | null = null;
    for (let b: BNode | null = para.parent; b && b !== unmatched.parent; b = b.parent) if (b.kind === "quote") quote = b;
    const inDefinition = this.colonEnds(unmatched, para);
    this.lazyQuote = quote !== null;
    if (quote) {
      const outsideHeld = quote === unmatched;
      this.gate = (k) => (QUOTE_INTERRUPTERS.has(k) && (outsideHeld || !NEED_INDENT.has(k))) || (k === "definition" && inDefinition);
      this.lazyContext = quote.parent;
    } else {
      this.gate = (k) => (PARA_INTERRUPTERS.has(k) && !NEED_INDENT.has(k)) || (k === "definition" && inDefinition);
      this.lazyContext = para.parent;
    }
  }

  /**
   * Whether a `:` line that `para` would take lazily, lacking the markers
   * of the open blocks from `unmatched` down, ends it as the next definition
   * would (so it does inside a definition only). A block quote the line
   * lacks keeps it as lazy text, as the old reader did, when that quote is
   * the only one the line lacks and the line has what holds it.
   */
  private colonEnds(unmatched: BNode, para: BNode): boolean {
    let quote: BNode | null = null;
    let quotes = 0;
    for (let b: BNode | null = para.parent; b && b !== unmatched.parent; b = b.parent) {
      if (b.kind === "quote") {
        quote = b;
        quotes++;
      }
    }
    if (quote && quote === unmatched && quotes === 1) return false;
    for (let b: BNode | null = para.parent; b; b = b.parent) if (b.kind === "defitem") return true;
    return false;
  }

  /** True for open leaves that take every line given to them, so no block can start inside them. */
  private takesLines(b: BNode): boolean {
    return b.kind === "fence" || b.kind === "code" || b.kind === "html" || b.kind === "math" || b.kind === "rawtex";
  }

  /**
   * The text of a lazy line: it starts after the block quote markers the
   * line does have, less up to as much blank space as the leaf's list items
   * (or footnote) indent their content within the nearest block quote.
   */
  private lazySeg(n: number, afterQuote: LineCursor | null, leaf: BNode): Seg {
    const c = afterQuote ? afterQuote.clone() : new LineCursor(this.lines[n], n);
    c.advanceCols(this.contentIndent(leaf.parent!));
    return c.rawSeg();
  }

  /** A line of display math or a raw LaTeX environment; the block closes at its last line. */
  private addSpanLine(b: BNode, seg: Seg, n: number): void {
    b.segs.push(seg);
    if (n >= b.endLine) this.close(b, n);
  }

  // ---------------------------------------------------------------- continuation

  private continues(b: BNode, cur: LineCursor, n: number): Cont {
    switch (b.kind) {
      case "quote": {
        // On the lines after the first, the marker may be indented any amount (as in the old reader).
        if (cur.peek() !== ">") return Cont.NotMatched;
        cur.skipBlank();
        cur.advanceChars(1);
        cur.quoteSpace();
        return Cont.Matched;
      }
      case "list":
      case "deflist":
        return Cont.Matched;
      case "item":
      case "defitem": {
        const need = b.markerOffset + b.padding;
        if (cur.blank()) {
          if (b.kind === "item" && b.emptyStart && b.children.length === 0) return Cont.NotMatched;
          cur.advanceCols(need);
          return Cont.Matched;
        }
        if (cur.indent() >= need) {
          cur.advanceCols(need);
          return Cont.Matched;
        }
        return Cont.NotMatched;
      }
      case "note": {
        if (cur.blank()) {
          cur.advanceCols(4);
          return Cont.Matched;
        }
        if (cur.indent() >= 4) {
          cur.advanceCols(4);
          return Cont.Matched;
        }
        return Cont.NotMatched;
      }
      case "div":
        if (n === b.endLine) {
          this.closeBelow(b, n - 1);
          this.close(b, n);
          // Blank lines inside the div do not separate it from what follows (as with a closing fence).
          for (let x: BNode | null = b; x; x = x.parent) x.lastLineBlank = false;
          return Cont.Consumed;
        }
        return Cont.Matched;
      case "para":
      case "caption":
        return cur.blank() ? Cont.NotMatched : Cont.Matched;
      case "table":
        if (n === b.delimiter) return Cont.Consumed;
        return cur.blank() || cur.indent() >= 4 ? Cont.NotMatched : Cont.Matched;
      case "fence": {
        const indent = cur.indent();
        if (indent <= 3) {
          const at = cur.firstNonBlank();
          const rest = cur.text.slice(at);
          let k = 0;
          while (rest[k] === b.fenceChar) k++;
          if (k >= b.fenceLength && isBlankText(rest.slice(k))) {
            // The closing fence ends the block: a blank line before it is inside.
            for (let x: BNode | null = b; x; x = x.parent) x.lastLineBlank = false;
            this.close(b, n);
            return Cont.Consumed;
          }
        }
        cur.advanceCols(Math.min(indent, b.fenceIndent));
        return Cont.Matched;
      }
      case "code":
        if (cur.indent() >= 4) {
          cur.advanceCols(4);
          return Cont.Matched;
        }
        if (cur.blank()) {
          cur.skipBlank();
          return Cont.Matched;
        }
        return Cont.NotMatched;
      case "html":
        return cur.blank() && (b.htmlType === 6 || b.htmlType === 7) ? Cont.NotMatched : Cont.Matched;
      case "math":
      case "rawtex":
        return Cont.Matched;
      default:
        return Cont.NotMatched;
    }
  }

  // ---------------------------------------------------------------- block starts

  /**
   * Try every kind of block start at the cursor. Returns the new block, or
   * null. `unmatchedBelow`, when set, is the deepest block the line matched:
   * open blocks below it are closed before a new block is added.
   */
  private start(cur: LineCursor, container: BNode, n: number, unmatchedBelow: BNode | null): BNode | null {
    const allowed = (kind: StartKind): boolean => !this.gate || this.gate(kind);
    const indent = cur.indent();
    const para = container.kind === "para" ? container : null;
    if (indent >= 4) {
      if (para || container.kind === "caption" || this.gate || cur.blank()) return null;
      this.prepare(unmatchedBelow, n);
      cur.advanceCols(4);
      return this.addChild(new BNode("code", n), n);
    }
    const at = cur.firstNonBlank();
    const text = cur.text;
    const rest = text.slice(at);
    const c = rest[0];
    if (c === undefined) return null;

    // In a definition list, a line followed by a `:` line is the next term, whatever it looks like
    // (unless the paragraph above takes it lazily).
    if (container.kind === "deflist" && !/^[:~](?:[ \t]|$)/.test(rest) && this.termFollows(container, n) && (!this.gate || this.lazyStart(rest, cur, at, n, container))) {
      this.prepare(unmatchedBelow, n);
      const p = this.openPara(cur, n, true);
      this.lineUsed = true;
      return p;
    }

    // Table caption ("Table: ...").
    if ((c === "T" || c === "t") && CAPTION_RE.test(rest) && allowed("caption")) {
      this.prepare(unmatchedBelow, n);
      return this.addChild(new BNode("caption", n), n);
    }

    // Fenced div.
    if (c === ":" && rest.startsWith(":::") && allowed("div")) {
      const attr = divAttr(rest);
      if (attr) {
        this.prepare(unmatchedBelow, n);
        const d = this.addChild(new BNode("div", n), n);
        d.attr = attr;
        d.endLine = this.divEnd(d, n);
        this.lineUsed = true;
        return d;
      }
    }

    // Display math and LaTeX environments that stand on their own lines.
    if (c === "$" && rest.startsWith("$$") && allowed("math")) {
      const m = this.displayMath(cur, at, n, container, "$$", unmatchedBelow);
      if (m) return m;
    }
    if (c === "\\") {
      if (rest.startsWith("\\[") && allowed("math")) {
        const m = this.displayMath(cur, at, n, container, "\\[", unmatchedBelow);
        if (m) return m;
      }
      if (rest.startsWith("\\begin") && allowed("env") && !this.inOpenDisplay()) {
        const m = this.environment(cur, at, n, container, unmatchedBelow);
        if (m) return m;
      }
    }

    // Special lines: \newpage, [[toc]] and friends.
    if ((c === "\\" || c === "[") && allowed("mark")) {
      const mark = SPECIAL_LINES[rest.trimEnd()];
      if (mark) {
        this.prepare(unmatchedBelow, n);
        const b = this.addChild(new BNode("mark", n), n);
        b.mark = mark;
        this.close(b, n);
        return b;
      }
    }

    // GFM table: this line is the header row and the next one, in the same containers, the delimiter
    // row. Tables come before most other blocks (`- a|b` over `-|-` is a table, as in the old reader),
    // but not before a definition or a caption.
    if (
      rest.includes("|") &&
      (!this.gate || this.lazyStart(rest, cur, at, n, container)) &&
      !this.continuesList(container, rest) &&
      !(allowed("definition") && this.definitionFirst(rest, container, n, unmatchedBelow))
    ) {
      const aligns = this.delimiterBelow(container, n, rest);
      if (aligns) {
        this.prepare(unmatchedBelow, n);
        const t = this.addChild(new BNode("table", n), n);
        t.segs = [cur.segAfterBlank()];
        t.aligns = aligns;
        t.delimiter = n + 1;
        this.lineUsed = true;
        return t;
      }
    }

    // Block quote.
    if (c === ">" && allowed("quote")) {
      this.prepare(unmatchedBelow, n);
      cur.skipBlank();
      cur.advanceChars(1);
      cur.quoteSpace();
      return this.addChild(new BNode("quote", n), n, cur);
    }

    // ATX heading.
    if (c === "#" && allowed("heading")) {
      const m = /^(#{1,6})(?:[ \t]+|$)/.exec(rest);
      if (m) {
        this.prepare(unmatchedBelow, n);
        const h = this.addChild(new BNode("heading", n), n);
        h.level = m[1].length;
        // A closing run of #s after a space is not content.
        let content = trimEndBlank(rest.slice(m[0].length));
        let hashes = content.length;
        while (hashes > 0 && content[hashes - 1] === "#") hashes--;
        if (hashes < content.length && (hashes === 0 || content[hashes - 1] === " " || content[hashes - 1] === "\t")) content = trimEndBlank(content.slice(0, hashes));
        h.segs.push({ text: content, line: n, col: at + m[0].length });
        this.close(h, n);
        return h;
      }
    }

    // Fenced code.
    if ((c === "`" || c === "~") && allowed("fence")) {
      const m = /^(`{3,}|~{3,})(.*)$/.exec(rest);
      if (m && !(c === "`" && m[2].includes("`"))) {
        this.prepare(unmatchedBelow, n);
        const f = this.addChild(new BNode("fence", n), n);
        f.fenceChar = c;
        f.fenceLength = m[1].length;
        f.fenceIndent = indent;
        f.info = m[2].trim();
        this.lineUsed = true;
        return f;
      }
    }

    // HTML block (the seventh kind cannot interrupt a paragraph).
    if (c === "<" && allowed("html")) {
      const kind = htmlBlockStart(rest);
      if (kind && (kind !== 7 || !(para || container.kind === "caption" || this.gate))) {
        this.prepare(unmatchedBelow, n);
        const h = this.addChild(new BNode("html", n), n);
        h.htmlType = kind;
        return h;
      }
    }

    // Setext heading underline.
    if (para && (c === "=" || c === "-") && /^(?:=+|-+)[ \t]*$/.test(rest)) {
      const h = new BNode("heading", para.line);
      h.level = c === "=" ? 1 : 2;
      h.segs = para.segs;
      this.replace(para, h);
      this.close(h, n);
      return h;
    }

    // Thematic break.
    if ((c === "*" || c === "-" || c === "_") && THEMATIC_RE.test(rest) && allowed("hr")) {
      this.prepare(unmatchedBelow, n);
      const b = this.addChild(new BNode("hr", n), n);
      this.close(b, n);
      this.lineUsed = true;
      return b;
    }

    // Footnote definition (in a table it is a row).
    if (c === "[" && rest.startsWith("[^") && allowed("note") && container.kind !== "table") {
      const m = FOOTNOTE_DEF_RE.exec(rest);
      if (m) {
        this.prepare(unmatchedBelow, n);
        const f = this.addChild(new BNode("note", n), n);
        f.label = m[1];
        this.notes.set(f.label, f);
        this.allNotes.push(f);
        cur.skipBlank();
        cur.advanceChars(m[0].length);
        this.noteContentStart(f, cur);
        return f;
      }
    }

    // On a line a paragraph would take lazily, a ": ..." caption with a table after it, judged both
    // where the paragraph is and where the line is (see endsLazily for the first alone).
    if (this.gate && c === ":" && /^:[ \t]+\S/.test(rest) && this.captionAllowed(this.lazyContext ?? container, n) && this.captionAllowed(container, n)) {
      this.prepare(unmatchedBelow, n);
      return this.addChild(new BNode("caption", n), n);
    }

    // Definition list item, or a ": ..." caption right after a table.
    if ((c === ":" || c === "~") && /^[:~](?:[ \t]|$)/.test(rest) && allowed("definition")) {
      const d = this.definition(cur, container, n, unmatchedBelow);
      if (d) return d;
      // A `:` line still ends a definition's paragraph; outside the list it is a paragraph of its own.
      if (this.gate) {
        this.prepare(unmatchedBelow, n);
        const p = this.openPara(cur, n);
        this.lineUsed = true;
        return p;
      }
      if (c === ":" && /^:[ \t]+\S/.test(rest) && this.captionAllowed(container, n)) {
        this.prepare(unmatchedBelow, n);
        return this.addChild(new BNode("caption", n), n);
      }
    }

    // List item.
    if (allowed("list")) {
      const item = this.listItem(cur, container, n, unmatchedBelow);
      if (item) return item;
    }

    return null;
  }

  /**
   * Move the cursor to where the content of footnote `note` starts, after
   * its `[^label]:`. The old reader measured the blank space there (`w`
   * columns) against the indentation footnote content needs, `need`: the
   * content's own indentation is `w` when `w < need`, else `w - need`. From
   * four columns on, the line is indented code, whose text starts after up
   * to `need + 4` columns. With less, it took the text to start at column
   * `need + w`, which tabs further on the line are measured from.
   */
  private noteContentStart(note: BNode, cur: LineCursor): void {
    const w = cur.indent();
    const need = this.contentIndent(note);
    if (w >= need) cur.advanceCols(need);
    else if (w >= 4) cur.advanceCols(w - 4);
    else cur.skipBlankKeepingIndent(need + w);
  }

  /**
   * Columns of indentation the content of `b` needs within the nearest block
   * quote (or the document): what list items and definitions indent their
   * content by, and four for each footnote, `b` included.
   */
  private contentIndent(b: BNode): number {
    let indent = 0;
    for (let c: BNode | null = b; c && c.kind !== "quote" && c.kind !== "doc"; c = c.parent) {
      if (c.kind === "item" || c.kind === "defitem") indent += c.markerOffset + c.padding;
      else if (c.kind === "note") indent += 4;
    }
    return indent;
  }

  /** Close the open blocks below `lastMatched` before a new block starts. */
  private prepare(lastMatched: BNode | null, n: number): void {
    if (lastMatched) this.closeBelow(lastMatched, n - 1);
  }

  // ---------------------------------------------------------------- lists

  private listItem(cur: LineCursor, container: BNode, n: number, unmatchedBelow: BNode | null): BNode | null {
    const at = cur.firstNonBlank();
    const text = cur.text;
    const rest = text.slice(at);
    let ordered = false;
    let bullet = "";
    let start = 1;
    let markerLength = 0;
    let m = /^[*+-]/.exec(rest);
    if (m) {
      bullet = m[0];
      markerLength = 1;
    } else if ((m = /^(\d{1,9})([.)])/.exec(rest))) {
      ordered = true;
      bullet = m[2];
      start = parseInt(m[1], 10);
      markerLength = m[0].length;
    } else return null;
    const after = text.charCodeAt(at + markerLength);
    if (!(Number.isNaN(after) || after === 32 || after === 9)) return null;
    const afterBlank = isBlankText(text.slice(at + markerLength));
    // Interrupting a paragraph: the item must not be empty, and an ordered one must start at 1.
    if (container.kind === "para" && (afterBlank || (ordered && start !== 1))) return null;
    if (this.gate && this.listTooDeep(cur, n, this.lazyContext ?? this.tip.parent!)) return null;

    // Offsets are in columns, relative to where the containers above left the cursor.
    const markerOffset = cur.indent();
    const probe = cur.clone();
    probe.skipBlank();
    const markerStart = probe.col;
    probe.advanceChars(markerLength);
    const markerEnd = probe.col;
    // Content padding: 1-4 columns of blank space after the marker; 5 or more means indented code, so 1.
    const spaceCols = probe.indent();
    let padding: number;
    if (afterBlank) {
      padding = markerEnd - markerStart + 1;
      probe.skipBlank();
    } else if (spaceCols >= 5) {
      padding = markerEnd - markerStart + 1;
      probe.advanceCols(1);
    } else {
      padding = markerEnd - markerStart + spaceCols;
      probe.advanceCols(spaceCols);
    }
    this.prepare(unmatchedBelow, n);
    // Join the open list of the same type, or start one. After an item that stayed empty, two blank
    // lines end the list (as in the old reader).
    let list = this.openChild(container, "list");
    const prev = list?.last;
    const afterEmpty = !!prev && prev.emptyStart && prev.children.length === 0;
    if (list && afterEmpty && this.lastBlank === n - 1 && n - 2 > prev!.line && this.blankFor(list, n - 2)) {
      this.close(list, n - 1);
      list = null;
    }
    if (!list || list.ordered !== ordered || list.bullet !== bullet) {
      list = this.addChild(new BNode("list", n), n);
      list.ordered = ordered;
      list.bullet = bullet;
      list.start = start;
    } else if (this.lastBlank === n - 1 && this.blankFor(list, n - 1)) list.gapLoose = true;
    const item = this.addChild(new BNode("item", n), n);
    item.markerOffset = markerOffset;
    item.padding = padding;
    item.emptyStart = afterBlank;
    cur.sync(probe);
    return item;
  }

  /**
   * True when a lazy line is indented four columns or more past the
   * container of the innermost list around `context` (where the line is
   * judged): then it is no item of that list (spec 5.2) and continues the
   * paragraph. A block quote in between starts the count afresh.
   */
  private listTooDeep(cur: LineCursor, n: number, context: BNode): boolean {
    // Only where the line lacks the indentation of the context.
    if (context.kind === "doc" || context.matchLine === n) return false;
    let list: BNode | null = context;
    while (list && list.kind !== "list" && list.kind !== "quote") list = list.parent;
    if (!list || list.kind === "quote") return false;
    const holder = list.parent!;
    const base = holder.kind === "doc" ? 0 : holder.matchLine === n ? holder.matchCol : -1;
    return base >= 0 && cur.col + cur.indent() - base >= 4;
  }

  /** True when `rest` is an item of the same kind as the open list in `container`, which it continues. */
  private continuesList(container: BNode, rest: string): boolean {
    const list = this.openChild(container, "list");
    if (!list) return false;
    const m = /^(?:([*+-])|\d{1,9}([.)]))(?:[ \t]|$)/.exec(rest);
    return !!m && (list.ordered ? m[2] === list.bullet : m[1] === list.bullet);
  }

  /** The open child of `container` (or the container itself) when it is of `kind`. */
  private openChild(container: BNode, kind: "list" | "deflist"): BNode | null {
    if (container.kind === kind && container.open) return container;
    const last = container.last;
    return last && last.open && last.kind === kind ? last : null;
  }

  // ---------------------------------------------------------------- definition lists

  /**
   * True when the line `rest` would start a definition (see definition) or
   * a caption (a `:` line with a table next to it), which come before a
   * table the line would head.
   */
  private definitionFirst(rest: string, container: BNode, n: number, unmatchedBelow: BNode | null): boolean {
    if (!/^[:~](?:[ \t]|$)/.test(rest)) return false;
    if (container.kind === "para") return !unmatchedBelow && container.segs.length === 1 && !this.setextAhead(container, n);
    const last = container.last;
    if (last && last.kind === "para" && !last.open && last.segs.length === 1 && last.endLine === n - 2 && this.lastBlank === n - 1) return true;
    if (this.openChild(container, "deflist")?.last) return true;
    return !this.gate && /^:[ \t]+\S/.test(rest) && this.captionAllowed(container, n);
  }

  /**
   * A `:` or `~` definition line. Its term is the one-line paragraph right
   * above it (at most one blank line between); without one, it is another
   * definition of the last term of an open definition list. A term that
   * directly follows a definition list joins that list.
   */
  private definition(cur: LineCursor, container: BNode, n: number, unmatchedBelow: BNode | null): BNode | null {
    let term: BNode | null = null;
    let loose = false;
    if (container.kind === "para") {
      if (unmatchedBelow || container.segs.length !== 1) return null;
      // A setext underline further down makes the paragraph, this line included, a heading.
      if (this.setextAhead(container, n)) return null;
      term = container;
    } else {
      const last = container.last;
      // A term, then a line blank inside the containers (`>` alone in a block quote too).
      if (last && last.kind === "para" && !last.open && last.segs.length === 1 && last.endLine === n - 2 && this.lastBlank === n - 1) {
        term = last;
        loose = true;
      }
    }
    let list: BNode | null = null;
    let termSegs: Seg[];
    if (term) {
      this.close(term, n - 1);
      const parent = term.parent!;
      if (parent.last !== term) return null;
      parent.children.pop();
      const before = parent.last;
      if (before && before.kind === "deflist") {
        list = before;
        list.open = true;
      } else {
        list = parent.add(new BNode("deflist", term.line));
        list.depth = parent.depth + 1;
      }
      this.tip = list;
      termSegs = term.segs;
    } else {
      list = this.openChild(container, "deflist");
      if (!list || !list.last) return null;
      this.prepare(unmatchedBelow, n);
      termSegs = list.last.term;
      loose = list.last.looseTerm;
    }
    // The content starts two columns after the marker, whatever blank space follows it (the old
    // reader's rule; more blank space is the content's own indentation).
    const markerOffset = cur.indent();
    const probe = cur.clone();
    probe.skipBlank();
    probe.advanceChars(1);
    const afterBlank = probe.blank();
    if (afterBlank) probe.skipBlank();
    else probe.advanceCols(1);
    const item = list.add(new BNode("defitem", n));
    item.depth = list.depth + 1;
    item.term = termSegs;
    item.looseTerm = loose;
    item.markerOffset = markerOffset;
    item.padding = 2;
    item.emptyStart = afterBlank;
    this.tip = item;
    cur.sync(probe);
    // Nesting counts definition lists as it counts lists (see addChild).
    if (item.depth >= MAX_DEPTH) this.capDepth(item, n);
    return item;
  }

  /**
   * True when line `k` is blank for `list`: once the markers of the
   * containers around the list are read (markers of blocks inside the list,
   * such as a block quote in an item, do not count).
   */
  private blankFor(list: BNode, k: number): boolean {
    const cur = new LineCursor(this.lines[k], k);
    for (const c of this.containers(list.parent!)) if (this.continuesQuietly(c, cur) !== Cont.Matched) return false;
    return cur.blank();
  }

  /**
   * True when the paragraph `para`, continued from line `n` on, meets a
   * setext underline before a blank line or the start of another block.
   */
  private setextAhead(para: BNode, n: number): boolean {
    // The answer depends only on the lines and the blocks around the paragraph, so it holds for any
    // paragraph in the same block over the lines the last search looked at.
    const memo = this.setextMemo;
    if (memo && memo.holder === para.parent && n >= memo.from && n <= memo.until) return memo.result;
    const chain = this.containers(para.parent!);
    let result = false;
    let k = n + 1;
    for (; k < this.lines.length; k++) {
      const cur = new LineCursor(this.lines[k], k);
      let held = true;
      for (const b of chain) {
        if (this.continuesQuietly(b, cur) !== Cont.Matched) {
          held = false;
          break;
        }
      }
      if (isBlankText(this.lines[k]) || (held && cur.blank())) break;
      const rest = cur.text.slice(cur.firstNonBlank());
      if (held && cur.indent() < 4 && /^(?:=+|-+)[ \t]*$/.test(rest)) {
        result = true;
        break;
      }
      if (cur.indent() < 4 && this.startsBlock(held ? rest : this.lines[k])) break;
    }
    this.setextMemo = { holder: para.parent!, from: n, until: k, result };
    return result;
  }

  /** True when line `n + 1` (or `n + 2`, after a blank line) is a definition line for the list `list`. */
  private termFollows(list: BNode, n: number): boolean {
    const chain = this.containers(list.parent!);
    const marker = (k: number): boolean | null => {
      if (k >= this.lines.length) return false;
      const cur = new LineCursor(this.lines[k], k);
      for (const b of chain) if (this.continuesQuietly(b, cur) !== Cont.Matched) return false;
      if (cur.blank()) return null;
      return cur.indent() < 4 && /^[:~](?:[ \t]|$)/.test(cur.text.slice(cur.firstNonBlank()));
    };
    const next = marker(n + 1);
    return next === true || (next === null && marker(n + 2) === true);
  }

  // ---------------------------------------------------------------- captions and tables

  /** A bare `: caption` line is a caption only directly after a table, or right before one. */
  private captionAllowed(container: BNode, n: number): boolean {
    const last = container.kind === "table" ? container : container.kind === "para" ? null : container.last;
    if (last && last.kind === "table") return true;
    // The caption goes on until a table interrupts it, or until blank lines or another block (a
    // definition line too), where something that looks like a table must follow. A line is judged
    // after the containers' markers it has.
    const chain = this.containers(container);
    for (let k = n + 1; k < this.lines.length; k++) {
      if (this.tableInterruptsAt(container, k)) return true;
      if (this.blankIn(container, k)) {
        while (k + 1 < this.lines.length && this.blankIn(container, k + 1)) k++;
        return this.tableStartsAt(container, k + 1);
      }
      // A blank line without a block quote's marker ends the quote, and with it the caption.
      if (isBlankText(this.lines[k])) return false;
      const { cur } = this.matchChain(chain, k);
      const line = cur.rest();
      // A definition line with text takes the line; no table starts there.
      if (/^[ \t]{0,3}[:~][ \t]+\S/.test(line)) return false;
      if (this.startsBlock(line) || LIST_MARKER_RE.test(line) || this.mathStartsAt(container, k, cur)) return this.tableStartsAt(container, k);
    }
    return false;
  }

  /**
   * True when line `k` is blank inside the containers around `container`:
   * blank once their markers are read (`>` alone in a block quote). A blank
   * line without a quote's marker ends the quote instead.
   */
  private blankIn(container: BNode, k: number): boolean {
    const { cur, ok } = this.matchChain(this.containers(container), k);
    return ok && cur.blank();
  }

  /** True when line `k`, from the cursor on, starts display math or an environment that closes, inside `container`. */
  private mathStartsAt(container: BNode, k: number, cur = new LineCursor(this.lines[k], k)): boolean {
    if (cur.indent() >= 4) return false;
    const at = cur.firstNonBlank();
    const rest = this.lines[k].slice(at);
    if (rest.startsWith("$$") || rest.startsWith("\\[")) return this.mathSpan(at, k, container, rest.startsWith("$$") ? "$$" : "\\[") !== null;
    return rest.startsWith("\\begin") && !this.inOpenDisplay() && this.envSpan(cur, at, k, container) !== null;
  }

  /** True when lines `k` and `k + 1`, inside the containers around `container`, are a table's header and delimiter rows. */
  private tableInterruptsAt(container: BNode, k: number): boolean {
    if (k + 1 >= this.lines.length) return false;
    const chain = this.containers(container);
    const rows: string[] = [];
    for (const line of [k, k + 1]) {
      // The header may be a lazy line lacking only list items' or footnotes' indentation (judged
      // after the markers it has); the delimiter row is held.
      const { cur, ok, lacking } = this.matchChain(chain, line);
      if ((!ok && (line > k || lacking.some((b) => b.kind === "quote"))) || cur.indent() >= 4) return false;
      rows.push(trimEndBlank(cur.text.slice(cur.firstNonBlank())));
    }
    const aligns = delimiterAligns(rows[1]);
    return !!aligns && rows[0].includes("|") && rowCells(rows[0]).length === aligns.length;
  }

  /**
   * True when lines `k` and `k + 1` look like a table's header and
   * delimiter rows, the header inside the innermost block quote around
   * `container` (and what holds it). Only the look counts here, as in the
   * old reader: a pipe in the first line and a row of dashes (with colons
   * and pipes) in the second, whatever its indentation; and the header
   * need not have the indentation of list items inside that quote.
   */
  private tableStartsAt(container: BNode, k: number): boolean {
    if (k + 1 >= this.lines.length) return false;
    const all = this.containers(container);
    let quote = -1;
    for (let i = 0; i < all.length; i++) if (all[i].kind === "quote") quote = i;
    const chain = all.slice(0, quote + 1);
    const head = this.matchChain(chain, k);
    if (!head.ok || head.cur.indent() - this.contentIndent(container) >= 4) return false;
    return head.cur.rest().includes("|") && looksLikeDelimiterRow(this.matchChain(chain, k + 1).cur.rest());
  }

  /**
   * The column alignments of a table whose header row is `header` (line
   * `n`), when the next line, held by the containers around `container`,
   * is a delimiter row with as many columns as the header has cells.
   */
  private delimiterBelow(container: BNode, n: number, header: string): ("left" | "center" | "right" | null)[] | null {
    if (n + 1 >= this.lines.length) return null;
    const cur = new LineCursor(this.lines[n + 1], n + 1);
    for (const b of this.containers(container)) if (this.continuesQuietly(b, cur) !== Cont.Matched) return null;
    if (cur.indent() >= 4) return null;
    const aligns = delimiterAligns(cur.text.slice(cur.firstNonBlank()));
    if (!aligns) return null;
    const cells = rowCells(header).length;
    if (cells && cells !== aligns.length && !this.shapeReported.has(n)) {
      // A header and a delimiter row that disagree make no table at all: the rows become a
      // paragraph of pipes. GFM allows that silently; an agent should hear about it.
      this.shapeReported.add(n);
      this.issues.push({
        line: n,
        code: "TBL001",
        message: `Not read as a table: the header row has ${cells} cells but the delimiter row has ${aligns.length}`,
        hint: "Give the delimiter row (|---|---|) one entry per header cell",
      });
    }
    return cells && cells === aligns.length ? aligns : null;
  }

  // ---------------------------------------------------------------- display math and environments

  /**
   * `$$` or `\[` at the start of a line opens a display math block when its
   * closer ends a line (only an attribute list may follow). Otherwise the
   * line is left to the paragraph, whose inline parser splits it.
   */
  private displayMath(cur: LineCursor, at: number, n: number, container: BNode, opener: "$$" | "\\[", unmatchedBelow: BNode | null): BNode | null {
    const span = this.mathSpan(at, n, this.lazyContext ?? container, opener);
    if (!span) return null;
    this.prepare(unmatchedBelow, n);
    const b = this.addChild(new BNode("math", n), n);
    b.endLine = span.lastLine;
    b.closeLine = span.closeLine;
    b.closeAt = span.close - this.starts[span.closeLine];
    b.attr = span.attr;
    cur.skipBlank();
    cur.advanceChars(2);
    this.addSpanLine(b, cur.seg(), n);
    this.lineUsed = true;
    return b;
  }

  /**
   * Where display math opened at offset `at` of line `n` inside `container`
   * closes: on a line the containers hold, before a blank line, with
   * something between, and nothing after the closer but an attribute list.
   * A quoted value in that list may run on over the next lines the
   * containers hold (the old reader's rule); the block then ends with the
   * list, on `lastLine`.
   */
  private mathSpan(at: number, n: number, container: BNode, opener: "$$" | "\\["): { close: number; closeLine: number; lastLine: number; attr: AttrSpec | null } | null {
    const from = this.starts[n] + at + 2;
    const max = this.rangeLimit(container, n, "math");
    const close = opener === "$$" ? this.index.findDisplayDollarClose(from, max) : this.index.findBackslashClose(from, max, "]");
    if (close < 0 || !this.hasContent(container, n, from, close)) return null;
    const closeLine = this.lineOf(close);
    let lineEnd = this.starts[closeLine] + this.lines[closeLine].length;
    let lastLine = closeLine;
    let a = readAttrAt(this.text, close + 2, lineEnd);
    if (!a) {
      const wide = readAttrAt(this.text, close + 2, max);
      if (wide && wide.end > lineEnd) {
        a = wide;
        lastLine = this.lineOf(wide.end - 1);
        lineEnd = this.starts[lastLine] + this.lines[lastLine].length;
      }
    }
    if (/\S/.test(this.text.slice(a ? a.end : close + 2, lineEnd))) return null;
    return { close, closeLine, lastLine, attr: a ? a.attr : null };
  }

  /**
   * True when offsets `from` to `to` (from line `n` on) hold something
   * besides blank space and the markers of the containers around
   * `container`.
   */
  private hasContent(container: BNode, n: number, from: number, to: number): boolean {
    const last = this.lineOf(to);
    const firstEnd = Math.min(to, this.starts[n] + this.lines[n].length);
    if (/\S/.test(this.text.slice(from, firstEnd))) return true;
    const chain = this.containers(container);
    for (let k = n + 1; k <= last; k++) {
      const cur = new LineCursor(this.lines[k], k);
      for (const b of chain) this.continuesQuietly(b, cur);
      const end = k === last ? to - this.starts[k] : this.lines[k].length;
      if (/\S/.test(this.lines[k].slice(cur.firstNonBlank(), end))) return true;
    }
    return false;
  }

  /**
   * True when the open paragraph has opened display math with `$$` and not
   * closed it: a `\begin{bmatrix}` line is then part of the formula (a list
   * item's text, then `$$` on the next lines), not a block of its own.
   */
  private inOpenDisplay(): boolean {
    const para = this.tip;
    if (para.kind !== "para") return false;
    // Counted as the paragraph grows, so a paragraph of thousands of lines is not rescanned each time.
    let tally = this.dollarTally.get(para);
    if (!tally) this.dollarTally.set(para, (tally = { segs: 0, count: 0 }));
    for (; tally.segs < para.segs.length; tally.segs++) tally.count += (para.segs[tally.segs]!.text.replace(/\\./g, "").match(/\$\$/g) ?? []).length;
    return tally.count % 2 === 1;
  }

  /** `$$` seen so far in a paragraph, and in how many of its segments. */
  private readonly dollarTally = new WeakMap<BNode, { segs: number; count: number }>();

  /** `\begin{name}` at the start of a line: a math environment or a raw LaTeX block, up to its `\end`. */
  private environment(cur: LineCursor, at: number, n: number, container: BNode, unmatchedBelow: BNode | null): BNode | null {
    const span = this.envSpan(cur, at, n, container);
    if (!span) return null;
    this.prepare(unmatchedBelow, n);
    const b = this.addChild(new BNode(span.math ? "math" : "rawtex", n), n);
    b.endLine = span.closeLine;
    if (span.math) {
      b.closeLine = span.closeLine;
      b.closeAt = span.bodyEnd - this.starts[span.closeLine];
      b.env = span.name;
      b.envHead = span.head;
    }
    cur.skipBlank();
    this.addSpanLine(b, cur.seg(), n);
    this.lineUsed = true;
    return b;
  }

  /**
   * The extent of an environment whose `\begin{name}` is at offset `at` of
   * line `n`, when it can be a block inside `container`: all its lines must
   * be held by the containers (otherwise the lines are a paragraph, whose
   * inline parser finds the environment). A math environment must end its
   * line; another kind needs an `\end{name}` spelled exactly somewhere
   * after it, and takes its whole last line.
   */
  private envSpan(cur: LineCursor, at: number, n: number, container: BNode): { head: string; name: string; math: boolean; closeLine: number; bodyEnd: number } | null {
    const m = /^\\begin\s*\{([^{}]*)\}/.exec(cur.text.slice(at));
    if (!m) return null;
    const name = m[1].trim();
    const bodyStart = this.starts[n] + at + m[0].length;
    const math = isMathEnv(name);
    const limit = this.rangeLimit(container, n, "held");
    const end = this.index.findEnvEnd(bodyStart, name, limit);
    if (!end) return null;
    const closeLine = this.lineOf(end.end - 1);
    // Any \end{name} closes an environment (spaces inside the braces too), but the old reader took
    // a raw one as a block only with an \end{name} spelled exactly on its closing line or a later
    // line its containers hold; otherwise it is left to the paragraph.
    if (!math) {
      const exact = this.index.exactEnd(name, this.starts[closeLine]);
      if (exact < 0 || exact >= limit) return null;
    }
    const lineEnd = this.starts[closeLine] + this.lines[closeLine].length;
    if (math && /\S/.test(this.text.slice(end.end, lineEnd))) return null;
    return { head: m[0], name, math, closeLine, bodyEnd: end.bodyEnd };
  }

  /**
   * The offset in `text` up to which a block opened at line `n` inside
   * `container` may extend: the end of the last line of the range `mode`
   * describes (see RangeMode).
   */
  private rangeLimit(container: BNode, n: number, mode: RangeMode): number {
    const last = this.rangeLastLine(container, n, mode);
    return this.starts[last] + this.lines[last].length;
  }

  /**
   * The last line of the range described at rangeLimit. Lines are asked
   * about in increasing order, so each container remembers the range it
   * found last time: a later question from inside it has the same answer.
   */
  private rangeLastLine(container: BNode, n: number, mode: RangeMode, firstBlank?: boolean): number {
    const chain = this.containers(container);
    const holder = chain.length ? chain[chain.length - 1] : this.root;
    const memo = holder.ranges?.[mode];
    if (memo && n >= memo.from && n <= memo.last) return memo.last;
    const last = this.scanRange(chain, n, mode, firstBlank);
    (holder.ranges ??= {})[mode] = { from: n, last };
    return last;
  }

  /**
   * See rangeLimit. `firstBlank` tells whether line `n` has no text inside
   * the containers, when the caller knows (their markers on the line they
   * open on are not continuation markers).
   */
  private scanRange(chain: BNode[], n: number, mode: RangeMode, firstBlank?: boolean): number {
    const stopAtBlank = mode === "math";
    let last = n;
    // Whether the last line was blank once the containers' markers were read: a lazy line needs text
    // before it. Unless the caller knows, the first line counts as it is when the containers do not
    // match it.
    const first = this.matchChain(chain, n);
    let blankBefore = firstBlank ?? (first.ok ? first.cur.blank() : isBlankText(this.lines[n]));
    for (let k = n + 1; k < this.lines.length; k++) {
      // A div ends at its closing line.
      if (chain.some((b) => b.kind === "div" && b.endLine >= 0 && k >= b.endLine)) break;
      const lineText = this.lines[k];
      if (stopAtBlank && isBlankText(lineText)) break;
      if (!chain.length) {
        last = k;
        continue;
      }
      const { cur, ok, context, lacking } = this.matchChain(chain, k);
      if (ok) {
        if (stopAtBlank && cur.blank()) break;
        last = k;
        blankBefore = cur.blank();
        continue;
      }
      // A lazy line: not blank, after a line with text, and not the start of another block.
      if (mode !== "lazy" || isBlankText(lineText) || blankBefore || this.endsLazyRange(cur, k, context, lacking)) break;
      last = k;
    }
    return last;
  }

  /**
   * Whether line `k`, lacking the markers of the blocks `lacking`, starts a
   * block that ends a lazy range: judged as a block quote judges its lazy
   * lines, after the markers the line has, in the block those reach. As in
   * endsLazily, the line's own indentation does not count (but for
   * environments) when a block quote nested in the outermost one it lacks
   * judges it, inside that one, or when that one is inside a block the line
   * lacks too, around it.
   */
  private endsLazyRange(cur: LineCursor, k: number, context: BNode, lacking: BNode[]): boolean {
    if (cur.indent() < 4) return this.startsBlock(cur.rest(), true) || this.mathStartsAt(context, k, cur);
    const quotes = lacking.filter((b) => b.kind === "quote");
    let judge: BNode;
    if (quotes.length >= 2) judge = quotes[0];
    else if (quotes.length === 1 && quotes[0] !== lacking[0]) judge = quotes[0].parent!;
    else return false;
    const at = cur.clone();
    at.skipBlank();
    const rest = at.rest();
    return this.startsBlock(rest, true) || ((rest.startsWith("$$") || rest.startsWith("\\[")) && this.mathStartsAt(judge, k, at));
  }

  /**
   * A cursor on line `k` after the markers of `chain` it has, whether it
   * has them all, the innermost block of the chain they reach, and the
   * blocks whose markers it lacks.
   */
  private matchChain(chain: BNode[], k: number): { cur: LineCursor; ok: boolean; context: BNode; lacking: BNode[] } {
    const cur = new LineCursor(this.lines[k], k);
    let context = chain.length ? chain[0].parent! : this.root;
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i];
      if (b.kind !== "list" && b.kind !== "deflist" && b.kind !== "div" && this.continuesQuietly(b, cur) !== Cont.Matched) return { cur, ok: false, context, lacking: chain.slice(i) };
      context = b;
    }
    return { cur, ok: true, context, lacking: [] };
  }

  /** Container continuation without side effects on the tree (for looking ahead). */
  private continuesQuietly(b: BNode, cur: LineCursor): Cont {
    switch (b.kind) {
      case "quote":
      case "item":
      case "defitem":
      case "note":
        return this.continues(b, cur, -1);
      default:
        return Cont.Matched;
    }
  }

  /**
   * True when `line` would start a block that interrupts a paragraph; with
   * `quote`, one that ends a block quote's lazy paragraph instead: any list
   * item does, empty or not and whatever its number, and a footnote
   * definition does not.
   */
  private startsBlock(line: string, quote = false): boolean {
    const cur = new LineCursor(line, -1);
    if (cur.indent() >= 4) return false;
    const rest = line.slice(cur.firstNonBlank());
    const c = rest[0];
    if (c === ">" || c === "#" && /^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
    if (/^(?:`{3,}|~{3,})/.test(rest)) return true;
    if (THEMATIC_RE.test(rest)) return true;
    if (/^[*+-](?:[ \t]+\S)/.test(rest) || /^1[.)](?:[ \t]+\S)/.test(rest) || (quote && LIST_MARKER_RE.test(rest))) return true;
    const kind = htmlBlockStart(rest);
    if (kind && kind !== 7) return true;
    if (divAttr(rest)) return true;
    if (SPECIAL_LINES[rest.trimEnd()]) return true;
    if (!quote && FOOTNOTE_DEF_RE.test(rest)) return true;
    if (CAPTION_RE.test(rest)) return true;
    return false;
  }

  /** The line containing offset `at` of `text`. */
  private lineOf(at: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ---------------------------------------------------------------- fenced divs

  /**
   * The line that closes a div opened at line `n`: the first line of only
   * colons (three or more) that is not inside a code fence and not taken by
   * a nested div, all at any indentation. -1 when the div is never closed.
   *
   * The search pairs the openers and closers of the divs inside, so it
   * records where each of those closes; a div that later opens at one of
   * those lines, inside the same blocks other than divs, takes the answer
   * instead of searching again (else unclosed divs, one in another, would
   * each search the rest of the document).
   */
  private divEnd(div: BNode, n: number): number {
    let holder = div.parent!;
    while (holder.kind === "div") holder = holder.parent!;
    const known = this.divClosers.get(n);
    if (known && known.holder === holder) return known.closer;
    const opened: number[] = [];
    const unclosed = (): number => {
      for (const line of opened) this.divClosers.set(line, { holder, closer: -1 });
      return -1;
    };
    const chain = this.containers(div.parent!);
    let fence: { char: string; length: number } | null = null;
    for (let k = n + 1; k < this.lines.length; k++) {
      const cur = new LineCursor(this.lines[k], k);
      let ok = true;
      for (const b of chain) {
        if (b.kind === "list" || b.kind === "deflist") continue;
        if (b.kind === "div") {
          if (b.endLine >= 0 && k >= b.endLine) return unclosed();
          continue;
        }
        if (this.continuesQuietly(b, cur) !== Cont.Matched) {
          ok = false;
          break;
        }
      }
      // The div ends with the lines its containers hold.
      if (!ok) return unclosed();
      // (The old reader's scan took any run of backticks or tildes for a fence, info string or not, and
      // fences and div openers at any indentation.)
      const rest = cur.rest();
      const body = rest.replace(/^[ \t]+/, "");
      if (fence) {
        let j = 0;
        while (body[j] === fence.char) j++;
        if (j >= fence.length && isBlankText(body.slice(j))) fence = null;
        continue;
      }
      const f = /^(`{3,}|~{3,})/.exec(body);
      if (f) {
        fence = { char: f[1][0], length: f[1].length };
        continue;
      }
      if (DIV_CLOSE_RE.test(rest)) {
        if (!opened.length) return k;
        this.divClosers.set(opened.pop()!, { holder, closer: k });
        continue;
      }
      if (divAttr(body)) opened.push(k);
    }
    return unclosed();
  }

  // ---------------------------------------------------------------- tree upkeep

  /**
   * Add `b` under the deepest open block that can hold it, closing leaves
   * that cannot. `cur` is the line's cursor after a block quote's marker.
   */
  private addChild(b: BNode, n: number, cur?: LineCursor): BNode {
    while (!this.tip.isContainer() || (this.tip.kind === "list" && b.kind !== "item") || (this.tip.kind === "deflist" && b.kind !== "defitem")) {
      this.close(this.tip, n - 1);
    }
    this.tip.add(b);
    this.tip = b;
    if (b.isContainer()) {
      b.depth = b.parent!.depth + 1;
      if (b.depth >= MAX_DEPTH && b.kind !== "list" && b.kind !== "deflist") this.capDepth(b, n, cur);
    }
    return b;
  }

  /**
   * `b` is nested too deeply: it keeps no content, and the lines it would
   * hold are swallowed. A block quote holds its own lines (lazy ones only
   * after text: `cur` shows whether its first line has any); a list item or
   * footnote holds what its nearest enclosing block quote or div (or the
   * document) holds; a div up to its closing line.
   */
  private capDepth(b: BNode, n: number, cur?: LineCursor): void {
    let until: number;
    if (b.kind === "quote") until = this.rangeLastLine(b, n, "lazy", cur?.blank());
    else if (b.kind === "div" && b.endLine >= 0) until = b.endLine;
    else {
      let holder: BNode | null = b.parent;
      while (holder && holder.kind !== "quote" && holder.kind !== "div" && holder.kind !== "doc") holder = holder.parent;
      if (!holder || holder.kind === "doc") until = this.lines.length - 1;
      else if (holder.kind === "div") until = holder.endLine >= 0 ? holder.endLine - 1 : this.lines.length - 1;
      else until = this.rangeLastLine(holder, n, "lazy");
    }
    this.swallow = { node: b, until };
    this.lineUsed = true;
  }

  /** Replace an open leaf by another (a paragraph that turned out to be a setext heading). */
  private replace(old: BNode, b: BNode): void {
    const parent = old.parent!;
    parent.children[parent.children.length - 1] = b;
    b.parent = parent;
    old.open = false;
    this.tip = b;
  }

  /** Close every open block below `b`. */
  private closeBelow(b: BNode, lastLine: number): void {
    while (this.tip !== b && this.tip !== this.root) this.close(this.tip, lastLine);
  }

  /**
   * Record whether this line was blank, for list tightness: on the deepest
   * block the line reached and its ancestors, and on the block that just
   * ended before a blank line (spec 5.3: blocks "separated by blank lines").
   */
  private markBlank(container: BNode, blank: boolean, n: number): void {
    const opened = container.children.length === 0 && container.line === n;
    const last = blank && !(container.kind === "quote" || ((container.kind === "item" || container.kind === "defitem" || container.kind === "note") && opened));
    for (let b: BNode | null = container; b; b = b.parent) b.lastLineBlank = last;
    if (blank && container.isContainer() && container.last && !container.last.open) container.last.lastLineBlank = true;
  }

  /** Finish a block: it takes no more lines. */
  private close(b: BNode, lastLine: number): void {
    if (!b.open) return;
    b.open = false;
    b.endLine = b.kind === "div" || b.kind === "math" || b.kind === "rawtex" ? b.endLine : lastLine;
    switch (b.kind) {
      case "para":
        this.extractLinkDefs(b);
        if (!b.segs.length) {
          const parent = b.parent!;
          const mark = new BNode("linkdefs", b.line);
          mark.open = false;
          mark.lastLineBlank = b.lastLineBlank;
          mark.parent = parent;
          // The paragraph is the last child, or close to it: search from the end.
          parent.children[parent.children.lastIndexOf(b)] = mark;
        } else b.line = b.segs[0].line;
        break;
      case "code":
        while (b.segs.length && isBlankText(b.segs[b.segs.length - 1].text)) b.segs.pop();
        break;
      case "list":
        // Tightness shows only on paragraphs, so a list without any directly in its items is tight.
        b.tight = listTight(b) || !b.children.some((item) => item.children.some((c) => c.kind === "para"));
        break;
      case "div":
        if (b.endLine < 0) this.issues.push({ line: b.line, message: "Fenced div is never closed", hint: "Add a line of three colons (:::) after the div's content." });
        break;
    }
    if (this.tip === b) this.tip = b.parent ?? this.root;
  }

  /**
   * Move the link reference definition a paragraph starts with into `refs`
   * (spec 4.7). There is one at most: the one definitionEnd found when the
   * paragraph opened (the paragraph ends with it).
   */
  private extractLinkDefs(p: BNode): void {
    if (p.defsEnd < 0) return;
    // Definitions read the lines without their leading blank space.
    const text = p.segs.map((s) => s.text.replace(/^[ \t]+/, "")).join("\n");
    const d = scanLinkDef(text, validateLink);
    if (!d) return;
    const key = normalizeLabel(d.label);
    if (key && !this.refs.has(key)) this.refs.set(key, { url: normalizeLink(d.def.url), ...(d.def.title !== undefined ? { title: d.def.title } : {}) });
    let used = 0;
    for (let i = 0; i < d.end - 1; i++) if (text.charCodeAt(i) === 10) used++;
    p.segs = d.end >= text.length ? [] : p.segs.slice(used + 1);
    if (p.segs.length) p.line = p.segs[0].line;
  }
}

/**
 * The attributes of a fenced div opened by `line` (`::: name` or
 * `::: {attributes}`, then optionally more colons), or null when it opens
 * none. The attributes are what lies between the first `{` and the last
 * `}`, braces inside included.
 */
function divAttr(line: string): AttrSpec | null {
  let i = 0;
  while (line[i] === ":") i++;
  if (i < 3) return null;
  while (line[i] === " " || line[i] === "\t") i++;
  let attr: AttrSpec | null;
  let tail: string;
  if (line[i] === "{") {
    const close = line.lastIndexOf("}");
    if (close <= i) return null;
    attr = parseAttrBody(line.slice(i + 1, close));
    tail = line.slice(close + 1);
  } else {
    if (i >= line.length || /[\s:{]/.test(line[i])) return null;
    let j = i;
    while (j < line.length && !/\s/.test(line[j])) j++;
    attr = { classes: [line.slice(i, j)], attrs: {} };
    tail = line.slice(j);
  }
  return /^[ \t]*:*[ \t]*$/.test(tail) ? attr : null;
}

/**
 * True when `text` looks like a table's delimiter row (for deciding whether
 * a `: caption` line has a table after it): cells of dashes, each perhaps
 * with a colon at either end, between pipes, with pipes at the ends optional.
 */
function looksLikeDelimiterRow(text: string): boolean {
  let row = trimEndBlank(text).replace(/^[ \t]+/, "");
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell));
}

/**
 * The column alignments a table delimiter row gives (`|:--|:-:|--:|`), or
 * null when it is not one: it holds only pipes, dashes, colons and blanks,
 * at least two characters, and does not start like a list item (`- `).
 */
function delimiterAligns(text: string): ("left" | "center" | "right" | null)[] | null {
  const row = trimEndBlank(text);
  if (!/^[|:-][|:\- \t]+$/.test(row) || /^-[ \t]/.test(row)) return null;
  const parts = splitCells(row);
  const aligns: ("left" | "center" | "right" | null)[] = [];
  for (let k = 0; k < parts.length; k++) {
    const s = parts[k].trim();
    if (!s) {
      if (k === 0 || k === parts.length - 1) continue;
      return null;
    }
    if (!/^:?-+:?$/.test(s)) return null;
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    aligns.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return aligns;
}

/**
 * A table row split at its pipes. A pipe after a backslash is part of the
 * cell (the backslash goes); an empty first and last cell (from pipes at
 * the ends of the row) are dropped.
 */
export function rowCells(text: string): string[] {
  const cells = splitCells(text.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** Split at pipes not preceded by a backslash, dropping the backslash of an escaped one. */
function splitCells(s: string): string[] {
  const out: string[] = [];
  let current = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 124) continue;
    if (i > 0 && s.charCodeAt(i - 1) === 92) {
      current += s.slice(from, i - 1);
      from = i;
    } else {
      out.push(current + s.slice(from, i));
      current = "";
      from = i + 1;
    }
  }
  out.push(current + s.slice(from));
  return out;
}

/**
 * A list is loose when a blank line comes right before one of its items, or
 * when blocks in an item are separated by one (spec 5.3). A blank line at the
 * end of an item counts even inside a code block, as it did in the old reader.
 */
function listTight(list: BNode): boolean {
  if (list.gapLoose) return false;
  const endsWithBlank = (b: BNode | undefined): boolean => {
    while (b) {
      if (b.lastLineBlank) return true;
      if (b.kind === "list" || b.kind === "item" || b.kind === "deflist" || b.kind === "defitem") b = b.last;
      else break;
    }
    return false;
  };
  for (const item of list.children) {
    for (let j = 0; j < item.children.length - 1; j++) if (endsWithBlank(item.children[j])) return false;
  }
  return true;
}
