/**
 * Assembly (the last phase): the intermediate block tree becomes texwright
 * blocks. Leaves get their inline content parsed here, and texwright's
 * block-level conventions are applied: a paragraph holding only an image is
 * a figure, a paragraph of only LaTeX commands is raw LaTeX, display math
 * splits the paragraph it sits in, captions join their tables, fenced divs
 * become callouts, theorems, the abstract or the bibliography, and footnote
 * references receive their notes.
 */
import { plainText, slugify, type Attr, type Block, type Inline, type Meta, type Pos, type TableCell } from "../../ast.js";
import type { FixSpec } from "../../diagnostics.js";
import { shiftPos, type ParseContext } from "../context.js";
import { BlockParser, rowCells } from "./blocks.js";
import { BNode, type LinkDef } from "./blocktree.js";
import { finishItems, type RunPart } from "./inlinefinish.js";
import { InlineParser, type InlineHost, type SourceMap } from "./inlineparser.js";
import type { DisplayMath, ItemList } from "./items.js";
import type { Seg } from "./lines.js";
import { unescapeText } from "./linkparts.js";
import { trimInlines } from "./runs.js";
import { findAttrEnd, firstLabel, hasClass, parseAttrBody, type AttrSpec } from "./scan.js";

/** Copies of repeated footnotes, in objects and arrays, before further repeats are left empty (DESIGN.md, "Limits"). */
const MAX_NOTE_COPIES = 200_000;

const THEOREMS: Record<string, string> = {
  theorem: "Theorem",
  lemma: "Lemma",
  proposition: "Proposition",
  corollary: "Corollary",
  definition: "Definition",
  example: "Example",
  remark: "Remark",
  conjecture: "Conjecture",
  proof: "Proof",
};

/** A warning held back (see DocState.flush). */
interface HeldWarning {
  late: boolean;
  line: number;
  message: string;
  pos: Pos;
  hint: string;
  extra?: WarnExtra;
}

/** A warning's own code (MD001 when absent) and fix. */
export interface WarnExtra {
  code?: "MD002";
  fix?: FixSpec;
}

/** State shared by every piece of one document (body, front matter). */
export class DocState {
  readonly labelSpans = new Set<Inline>();
  /** The document line where the block whose inline content is being parsed starts. */
  leafLine = 0;
  /** Text being read again on its own (stray captions, theorem titles): what it finds counts as late. */
  rereading = 0;
  private held: HeldWarning[] | null = null;

  constructor(
    readonly ctx: ParseContext,
    readonly meta: Meta,
  ) {}

  pos(line: number, col: number): Pos {
    return shiftPos(this.ctx, line, col);
  }

  /** Report a problem now, whether or not warnings are held. */
  warnNow(message: string, pos: Pos, hint: string, extra?: WarnExtra): void {
    this.ctx.diagnostics.add(extra?.code ?? "MD001", message, pos, { hint, fix: extra?.fix });
  }

  /** Report a problem found in inline text, or (`late`) while the document is built from the blocks. */
  warn(message: string, pos: Pos, hint: string, late = false, extra?: WarnExtra): void {
    if (this.held) this.held.push({ late: late || this.rereading > 0, line: this.leafLine, message, pos, hint, extra });
    else this.warnNow(message, pos, hint, extra);
  }

  /** Hold warnings back until flush. */
  hold(): void {
    this.held = [];
  }

  /**
   * Report the held warnings in the order the old reader found them. It
   * parsed the inline text of all blocks first, in document order
   * (footnote definitions where they stand), and only then built the
   * document; so problems in text come first, by the line where their
   * block starts, and the problems found while building come after. The
   * order shows where problems tie in place, and in which ones are listed
   * once a code has too many (Diagnostics keeps the first ones).
   */
  flush(): void {
    const held = this.held ?? [];
    this.held = null;
    const order = held.map((w, seq) => ({ w, seq }));
    order.sort((a, b) => Number(a.w.late) - Number(b.w.late) || (a.w.late ? 0 : a.w.line - b.w.line) || a.seq - b.seq);
    for (const { w } of order) this.warnNow(w.message, w.pos, w.hint, w.extra);
  }
}

/** Converts the block tree of one piece of text (whose first line is document line `lineBase + 1`). */
export class Assembler implements InlineHost {
  readonly refs: Map<string, LinkDef>;
  readonly labelSpans: Set<Inline>;
  /** Converted footnote bodies by label, made at the first reference and copied for later ones. */
  private readonly noteBodies = new Map<string, Block[]>();
  /** Footnote numbers by label (see openInlineNote). */
  private readonly noteIds = new Map<string, number>();
  private nextNoteId = 0;
  /** Inline notes' blocks by number. */
  private readonly inlineNotes = new Map<number, Block[]>();
  /** Numbers of the footnotes being converted: a reference to one of them is a cycle and stays empty. */
  private readonly activeIds = new Set<number>();
  private copied = 0;
  private copiesExhausted = false;
  /** Footnote bodies being converted: they get no bare-link or typography passes. */
  private inNoteBody = 0;
  /** Footnote definitions whose content has been parsed. */
  private readonly parsedNotes = new Set<BNode>();
  /** Parsing only for the diagnostics: footnote references inside stay empty. */
  private scanOnly = false;

  constructor(
    private readonly doc: DocState,
    private readonly parser: BlockParser,
    private readonly lineBase: number,
    /** Inline Markdown read as a text of its own, whose first line is document line `line + 1` (as front matter values are). */
    private readonly detached: (text: string, line: number) => Inline[],
  ) {
    this.refs = parser.refs;
    this.labelSpans = doc.labelSpans;
  }

  /** Report block-level problems found while parsing. */
  reportIssues(): void {
    for (const i of this.parser.issues) {
      if (i.code) this.doc.ctx.diagnostics.add(i.code, i.message, this.blockPos(i.line), { hint: i.hint });
      else this.doc.warnNow(i.message, this.blockPos(i.line), i.hint);
    }
  }

  /** The position of a block that starts on line `line` (blocks are placed at column 1). */
  blockPos(line: number): Pos {
    return this.doc.pos(this.lineBase + line + 1, 1);
  }

  // ---------------------------------------------------------------- InlineHost

  hasNote(label: string): boolean {
    return this.parser.notes.has(label);
  }

  noteBlocks(label: string, pos: Pos): Block[] {
    if (this.scanOnly) return [];
    let id = this.noteIds.get(label);
    if (id === undefined) {
      id = this.nextNoteId++;
      this.noteIds.set(label, id);
    }
    if (this.activeIds.has(id)) return [];
    const done = this.inlineNotes.get(id) ?? this.noteBodies.get(label);
    if (done) {
      if (this.copiesExhausted) return [];
      const copy = cloneCounting(done);
      if (this.copied + copy.count > MAX_NOTE_COPIES) {
        this.copiesExhausted = true;
        this.doc.warn(`Footnote [^${label}] is repeated too often; this and later repeated footnotes are left empty`, pos, "Each reference to a footnote copies it. Reference long notes once, or shorten them.", true);
        return [];
      }
      this.copied += copy.count;
      return copy.value;
    }
    this.activeIds.add(id);
    this.inNoteBody++;
    const def = this.parser.notes.get(label)!;
    this.parsedNotes.add(def);
    const blocks = this.children(def, false);
    this.inNoteBody--;
    this.activeIds.delete(id);
    this.noteBodies.set(label, blocks);
    return blocks;
  }

  /**
   * Number an inline note as it starts. The old reader numbered footnotes
   * in order, a label at its first reference and an inline note when it
   * starts, but stored an inline note only once it was read: a label first
   * referenced inside an inline note took the note's number, and from then
   * on stood for the note's text. A reference inside the note to its own
   * number is a cycle and stays empty, and so does an inline note inside
   * one with the same number (-1 here).
   */
  openInlineNote(): number {
    const id = this.nextNoteId;
    if (this.activeIds.has(id)) return -1;
    this.activeIds.add(id);
    return id;
  }

  closeInlineNote(id: number, items: ItemList, raw: string): Block[] {
    if (id < 0) return [];
    const blocks = this.inlineNoteBlocks(items, raw);
    this.activeIds.delete(id);
    this.inlineNotes.set(id, blocks);
    this.nextNoteId = Math.max(this.nextNoteId, id + 1);
    return blocks;
  }

  /**
   * Footnote definitions never referenced (or replaced by a later one with
   * the same label) are still read, so that their problems are reported.
   */
  reportUnusedNotes(): void {
    this.scanOnly = true;
    this.inNoteBody++;
    for (const def of this.parser.allNotes) if (!this.parsedNotes.has(def)) this.children(def, false);
    this.inNoteBody--;
    this.scanOnly = false;
  }

  /** An inline note's content, split around display math like a paragraph (its first paragraph has no position). */
  private inlineNoteBlocks(items: ItemList, raw: string): Block[] {
    const run = finishItems(items, this, true, raw, true);
    if (!run.some((p) => p.t === "$display")) {
      const content = trimInlines(run as Inline[]);
      return content.length ? [this.leafFromInlines("Para", content, undefined, raw)] : [];
    }
    const out: Block[] = [];
    let current: Inline[] = [];
    let currentPos: Pos | undefined;
    const flush = (): void => {
      const content = trimInlines(current);
      if (content.length) out.push(currentPos ? { t: "Para", content, pos: currentPos } : { t: "Para", content });
      current = [];
    };
    for (const part of run) {
      if (part.t === "$display") {
        flush();
        out.push(displayBlock(part));
        currentPos = part.pos;
      } else current.push(part);
    }
    flush();
    return out;
  }

  warn(message: string, pos: Pos, hint: string, extra?: WarnExtra): void {
    this.doc.warn(message, pos, hint, false, extra);
  }

  displayShownInline(pos: Pos): void {
    if (!this.scanOnly) this.doc.warn("Display math inside emphasis or a link is shown inline", pos, "Move the display math out of the emphasis or link.", true);
  }

  // ---------------------------------------------------------------- inline content

  /**
   * Positions in a leaf's inline text. A text line is placed where it
   * first occurs in its source line (the old reader's rule, which sees
   * through stripped container markers but can land on an earlier copy of
   * the same text); `line` counts from the leaf's first line. Each segment
   * is placed once: a search per position would make a long line with
   * many positioned nodes cost its length squared.
   */
  private sourceMap(segs: Seg[]): SourceMap {
    const base = segs[0]?.line ?? 0;
    const starts: number[] = [];
    let offset = 0;
    for (const s of segs) {
      starts.push(offset);
      offset += s.text.length + 1;
    }
    const placed: number[] = [];
    const find = (line: number, text: string): number => Math.max(0, this.parser.sourceLines[base + line]?.indexOf(text) ?? -1);
    const at = (line: number, col: number): Pos => this.doc.pos(this.lineBase + base + line + 1, col + 1);
    return {
      pos: (offset: number): Pos => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= offset) lo = mid;
          else hi = mid - 1;
        }
        const start = (placed[lo] ??= find(lo, segs[lo]?.text ?? ""));
        return at(lo, start + offset - (starts[lo] ?? 0));
      },
      find,
      at,
    };
  }

  /** Parse inline text; returns the run (display math included) and a trailing attribute list. */
  inline(segs: Seg[], trailingAttrs = false, warnDisplay = false): { run: RunPart[]; attr: AttrSpec | null } {
    segs = trimSegs(segs);
    const text = segs.map((s) => s.text).join("\n");
    const outer = this.doc.leafLine;
    this.doc.leafLine = this.lineBase + (segs[0]?.line ?? 0);
    const parser = new InlineParser(text, this.sourceMap(segs), this, { trailingAttrs });
    const { items, attr } = parser.parse();
    const run = finishItems(items, this, true, text, warnDisplay);
    this.doc.leafLine = outer;
    return { run, attr };
  }

  /** Inline content where display math may not split anything (headings, cells, captions): it stays inline. */
  private flatInline(segs: Seg[], trailingAttrs = false): { content: Inline[]; attr: AttrSpec | null } {
    const { run, attr } = this.inline(segs, trailingAttrs);
    const content: Inline[] = run.map((p) => (p.t === "$display" ? ({ t: "Math", tex: p.tex, pos: p.pos } as Inline) : p));
    return { content: trimInlines(content), attr };
  }

  // ---------------------------------------------------------------- blocks

  /**
   * The blocks of a container. Paragraphs directly inside become Plain when
   * `tight`. With `task`, a list item's first paragraph may start with a task
   * marker (`[ ]`, `[x]`); what it says is stored there.
   */
  children(node: BNode, tight: boolean, task?: { checked: boolean | null }): Block[] {
    const parts: (Block | Caption)[] = [];
    const kids = node.children;
    for (let k = 0; k < kids.length; k++) {
      const b = kids[k];
      if (task && k === 0 && b.kind === "para") parts.push(...this.paragraph(b, tight, task));
      else if (b.kind === "caption") parts.push({ t: "$caption", node: b, ...this.captionContent(b) });
      else parts.push(...this.block(b, tight));
    }
    return this.placeCaptions(parts);
  }

  /**
   * Join each caption to the table made right before it (unless that one
   * has a caption), or else to the one right after it. Blocks that made no
   * output (an abstract div) do not separate them. A caption without a
   * table is warned about and read again as a paragraph of its own text.
   */
  private placeCaptions(parts: (Block | Caption)[]): Block[] {
    const out: Block[] = [];
    const captioned = new Set<Block>();
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.t !== "$caption") {
        out.push(p);
        continue;
      }
      const prev = out[out.length - 1];
      const next = parts[i + 1];
      const table = prev?.t === "Table" && !captioned.has(prev) ? prev : next?.t === "Table" ? next : null;
      if (table) {
        applyCaption(table, p);
        captioned.add(table);
        continue;
      }
      // Footnotes never referenced are read only for the problems in their text.
      if (this.scanOnly) continue;
      const b = p.node;
      this.doc.warn("Table caption is not next to a table", this.blockPos(b.line), "Put the caption paragraph directly before or after the table, separated only by a blank line.", true);
      const content = this.detached(trimSegs(b.segs).map((s) => s.text).join("\n"), this.lineBase + b.line);
      if (content.length) out.push({ t: "Para", content, pos: this.blockPos(b.line) });
    }
    return out;
  }

  private block(b: BNode, tight: boolean): Block[] {
    const pos = this.blockPos(b.line);
    switch (b.kind) {
      case "para":
        return this.paragraph(b, tight);
      case "heading":
        return [this.heading(b)];
      case "fence":
        return [this.codeBlock(b, pos)];
      case "code":
        return [{ t: "CodeBlock", text: b.segs.map((s) => s.text).join("\n"), pos }];
      case "html":
        return [{ t: "RawBlock", format: "html", text: b.segs.map((s) => s.text).join("\n"), pos }];
      case "hr":
        return [{ t: "HorizontalRule", pos }];
      case "mark":
        return [{ t: b.mark, pos }];
      case "math":
        return [this.displayMathBlock(b, pos)];
      case "rawtex":
        return [{ t: "RawBlock", format: "latex", text: b.segs.map((s) => s.text).join("\n"), pos }];
      case "table":
        return [this.table(b)];
      case "quote":
        return [{ t: "BlockQuote", blocks: this.children(b, false), pos }];
      case "list":
        return [this.list(b, pos)];
      case "deflist":
        return [this.defList(b, pos)];
      case "div":
        return this.div(b, pos);
      default:
        // Footnote definitions and link reference definitions make no block where they stand.
        return [];
    }
  }

  private paragraph(b: BNode, tight: boolean, task?: { checked: boolean | null }): Block[] {
    const { run } = this.inline(b.segs, false, true);
    keepLabelLines(run);
    const pos = this.blockPos(b.line);
    // A task marker is looked for in the text as parsed (`\[x]` is one), followed by a space, a tab or the end
    // of the text. A task item's paragraph stays a paragraph: no figure, no raw LaTeX.
    const first = run[0];
    const marker = task && first?.t === "Text" ? /^\[([ xX])\](?:[ \t]|$)/.exec(first.text) : null;
    if (task && marker && first.t === "Text") {
      task.checked = marker[1] !== " ";
      run[0] = { t: "Text", text: first.text.slice(3) };
    }
    const kind = tight ? "Plain" : "Para";
    const out: Block[] = [];
    let current: Inline[] = [];
    let currentPos: Pos = pos;
    const flush = (): void => {
      const content = trimInlines(current);
      if (content.length) out.push(kind === "Para" ? { t: "Para", content, pos: currentPos } : { t: "Plain", content, pos: currentPos });
      current = [];
    };
    if (!run.some((p) => p.t === "$display")) {
      const content = trimInlines(run as Inline[]);
      if (!content.length) return [];
      if (marker) return [kind === "Para" ? { t: "Para", content, pos } : { t: "Plain", content, pos }];
      return [this.leafFromInlines(kind, content, pos, trimBlank(b.segs.map((s) => s.text).join("\n")))];
    }
    for (const part of run) {
      if (part.t === "$display") {
        flush();
        out.push(displayBlock(part));
        currentPos = part.pos;
        continue;
      }
      current.push(part);
    }
    flush();
    return out;
  }

  /**
   * A whole paragraph's content: a figure when it is only an image, raw
   * LaTeX (the source text `raw`) when only commands. Inline notes give no
   * position.
   */
  private leafFromInlines(kind: "Para" | "Plain", content: Inline[], pos: Pos | undefined, raw: string): Block {
    if (kind === "Para") {
      const fig = this.figure(content, pos);
      if (fig) return fig;
    }
    let block: Block;
    if (content.some((n) => n.t === "RawInline" && n.format === "latex") && content.every((n) => (n.t === "RawInline" && n.format === "latex") || (n.t === "Text" && !n.text.trim()) || n.t === "SoftBreak" || n.t === "LineBreak" || (n.t === "Span" && this.labelSpans.has(n)))) {
      block = { t: "RawBlock", format: "latex", text: raw };
    } else block = kind === "Para" ? { t: "Para", content } : { t: "Plain", content };
    if (pos) block.pos = pos;
    return block;
  }

  private figure(content: Inline[], pos: Pos | undefined): Block | null {
    const images = content.filter((n) => n.t === "Image");
    if (images.length !== 1) return null;
    if (!content.every((n) => n.t === "Image" || (n.t === "Span" && this.labelSpans.has(n)) || (n.t === "Text" && !n.text.trim()) || n.t === "SoftBreak")) return null;
    const img = images[0] as Extract<Inline, { t: "Image" }>;
    const caption = img.alt;
    const fig: Extract<Block, { t: "Figure" }> = { t: "Figure", content: [], numbered: caption.length > 0 && !img.attr?.classes?.includes("unnumbered") };
    const plain = plainText(caption).trim();
    const shown: Extract<Inline, { t: "Image" }> = { t: "Image", src: img.src, alt: plain ? [{ t: "Text", text: plain }] : [] };
    if (img.title !== undefined) shown.title = img.title;
    if (img.pos) shown.pos = img.pos;
    if (img.width !== undefined) shown.width = img.width;
    if (img.height !== undefined) shown.height = img.height;
    let label: string | undefined;
    if (img.attr) {
      const { id, ...rest } = img.attr;
      label = id;
      if (Object.keys(rest).length) shown.attr = rest;
    }
    // Without an id in the attributes, the first \label names the figure; label placeholders go either way.
    const span = content.find((n) => n.t === "Span");
    if (!label && span && span.t === "Span") label = span.attr.id;
    fig.content = [{ t: "Plain", content: [shown] }];
    if (caption.length) fig.caption = caption;
    if (label) {
      fig.label = label;
      fig.id = slugify(label);
    }
    if (pos) fig.pos = pos;
    return fig;
  }

  private heading(b: BNode): Block {
    const { content, attr } = this.flatInline(b.segs, true);
    const h: Extract<Block, { t: "Heading" }> = { t: "Heading", level: b.level as 1, content, numbered: !hasClass(attr, "unnumbered") };
    applyIdAndAttr(h, attr);
    h.pos = this.blockPos(b.line);
    return h;
  }

  private codeBlock(b: BNode, pos: Pos): Block {
    const text = b.segs.map((s) => s.text).join("\n");
    const out: Extract<Block, { t: "CodeBlock" }> = { t: "CodeBlock", text };
    const info = unescapeText(b.info).trim();
    if (info) {
      // The info string is a language, an attribute list right after its first word, or both:
      // `py`, `py {#lst:a}`, `{.py #lst:a}`. Anything after them is ignored. Without a whole
      // attribute list, a leading { is dropped and the first word is the language.
      const head = /^([^\s{]*)\s*/.exec(info)!;
      const brace = info[head[0].length] === "{" ? head[0].length : -1;
      const close = brace >= 0 ? findAttrEnd(info, brace) : -1;
      const spec = close > 0 ? parseAttrBody(info.slice(brace + 1, close), true) : null;
      let lang = head[1];
      if (!lang && spec && spec.classes.length) lang = spec.classes.shift()!;
      else if (!lang && !spec) lang = info.replace(/^\{/, "").split(/[\s}]/)[0];
      if (lang) out.lang = lang;
      if (spec) {
        const a: Attr = {};
        if (spec.id) a.id = spec.id;
        if (spec.classes.length) a.classes = spec.classes;
        if (Object.keys(spec.attrs).length) a.attrs = spec.attrs;
        if (Object.keys(a).length) out.attr = a;
      }
    }
    out.pos = pos;
    return out;
  }

  private displayMathBlock(b: BNode, pos: Pos): Block {
    // The closing line stops where the closing delimiter starts (lines after it hold the rest of
    // the attribute list); an environment's first line starts after \begin{name}.
    let k = b.segs.length - 1;
    while (k > 0 && b.segs[k].line > b.closeLine) k--;
    const lines = b.segs.slice(0, k + 1).map((s) => s.text);
    const last = b.segs[k];
    lines[k] = last.text.slice(0, Math.max(0, b.closeAt - last.col));
    let tex = lines.join("\n");
    if (b.env) tex = tex.slice(b.envHead.length);
    return mathBlock(tex, b.env, b.attr, pos);
  }

  /**
   * The header and delimiter rows of table `b` with `extra` more columns, as a fix: never safe, since
   * the extra cell may be the mistake instead. Needs the file's own lines (the rows as written).
   */
  private widerTable(b: BNode, extra: number): FixSpec | undefined {
    const file = this.doc.ctx.file;
    const lines = file ? this.doc.ctx.diagnostics.sourceLines(file) : undefined;
    const at = this.blockPos(b.line);
    const head = lines?.[at.line - 1];
    const delim = lines?.[at.line];
    if (head === undefined || delim === undefined || !/^[\s>]*\|?\s*:?-+/.test(delim.replace(/^[\s>]*/, ""))) return undefined;
    const widen = (line: string, cell: string) => {
      const t = line.replace(/\s+$/, "");
      return t.endsWith("|") ? t + ` ${cell} |`.repeat(extra) : t + ` | ${cell}`.repeat(extra);
    };
    return { old: `${head}\n${delim}`, new: `${widen(head, "  ")}\n${widen(delim, "---")}`, safe: false, line: at.line, col: 1 };
  }

  private table(b: BNode): Extract<Block, { t: "Table" }> {
    const cols = b.aligns.length;
    const cells = (seg: Seg): TableCell[] => {
      const parts = rowCells(seg.text);
      // GFM drops cells past the header's count; say so, since the data is lost.
      if (parts.length > cols && parts.slice(cols).some((p) => p.trim()))
        this.doc.ctx.diagnostics.add("TBL001", `Table row has ${parts.length} cells but the table has ${cols} columns`, this.blockPos(seg.line), {
          hint: `The cells after column ${cols} are left out. Add a column to the header and the delimiter row, or merge the cells.`,
          fix: this.widerTable(b, parts.length - cols),
        });
      const out: TableCell[] = [];
      for (let k = 0; k < cols; k++) {
        const text = (parts[k] ?? "").trim();
        if (!text) {
          out.push({ content: [] });
          continue;
        }
        // A cell's text is placed at its first occurrence in the row, as the old reader did.
        const at = Math.max(0, seg.text.indexOf(text));
        const { content } = this.flatInline([{ text, line: seg.line, col: seg.col + at }]);
        out.push({ content });
      }
      return out;
    };
    const t: Extract<Block, { t: "Table" }> = { t: "Table", align: b.aligns, head: [cells(b.segs[0])], body: b.rows.map(cells) };
    t.pos = this.blockPos(b.line);
    return t;
  }

  /** A caption's text after `Table:` or `:`, with the attribute list that may end it. */
  private captionContent(cap: BNode): { content: Inline[]; attr: AttrSpec | null } {
    const first = cap.segs[0];
    const m = /^[ \t]*(?:[Tt]able:|:)[ \t]*/.exec(first.text)!;
    const segs = trimSegs([{ text: first.text.slice(m[0].length), line: first.line, col: first.col + m[0].length }, ...cap.segs.slice(1)], /\s/);
    // The text's lines are counted from the caption's first line even when that line had only the
    // prefix (the old reader's rule, which then places the text by searching the wrong line).
    if (segs.length) segs[0] = { ...segs[0], line: first.line };
    return this.flatInline(segs, true);
  }

  private list(b: BNode, pos: Pos): Block {
    const tight = b.tight;
    const items: Block[][] = [];
    const task: (boolean | null)[] = [];
    let anyTask = false;
    for (const item of b.children) {
      const marker: { checked: boolean | null } = { checked: null };
      items.push(this.children(item, tight, marker));
      task.push(marker.checked);
      if (marker.checked !== null) anyTask = true;
    }
    const list: Extract<Block, { t: "List" }> = { t: "List", ordered: b.ordered, tight, items };
    if (b.ordered) list.start = b.start;
    if (anyTask) list.task = task;
    list.pos = pos;
    return list;
  }

  /**
   * Definitions are grouped under their terms. A definition is tight (its
   * paragraph Plain) when it is a single block and no blank line separates
   * its term from the definitions.
   */
  private defList(b: BNode, pos: Pos): Block {
    const items: { term: Inline[]; defs: Block[][] }[] = [];
    let current: { term: Inline[]; defs: Block[][] } | null = null;
    let lastTerm: Seg[] | null = null;
    for (const item of b.children) {
      if (!current || item.term !== lastTerm) {
        current = { term: this.flatInline(item.term).content, defs: [] };
        items.push(current);
        lastTerm = item.term;
      }
      const tight = !item.looseTerm && item.children.filter((c) => c.kind !== "note").length <= 1;
      current.defs.push(this.children(item, tight));
    }
    return { t: "DefList", items, pos };
  }

  private div(b: BNode, pos: Pos): Block[] {
    const attr = b.attr ?? { classes: [], attrs: {} };
    const blocks = this.children(b, false);
    if (attr.id === "refs") return [...blocks, { t: "Bibliography", pos }];
    if (attr.classes.includes("abstract") && !this.doc.meta.abstract && !this.scanOnly) {
      this.doc.meta.abstract = blocks;
      return [];
    }
    const kind = attr.classes.find((c) => THEOREMS[c]);
    if (kind) {
      const th: Extract<Block, { t: "Theorem" }> = { t: "Theorem", kind, name: THEOREMS[kind], numbered: kind !== "proof" && !attr.classes.includes("unnumbered"), blocks };
      if (attr.attrs.title !== undefined) th.title = this.detached(attr.attrs.title, this.lineBase + b.line);
      if (attr.id) {
        th.label = attr.id;
        th.id = slugify(attr.id);
      }
      th.pos = pos;
      return [th];
    }
    const a: Attr = {};
    if (attr.id) a.id = attr.id;
    if (attr.classes.length) a.classes = attr.classes;
    if (Object.keys(attr.attrs).length) a.attrs = attr.attrs;
    return [{ t: "Div", attr: a, blocks, pos }];
  }
}

/** Trim spaces, tabs and line endings (not other blank space) from both ends. */
function trimBlank(s: string): string {
  const blank = (c: number): boolean => c === 32 || c === 9 || c === 10;
  let start = 0;
  let end = s.length;
  while (start < end && blank(s.charCodeAt(start))) start++;
  while (end > start && blank(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** A caption block on its way to its table. */
interface Caption {
  t: "$caption";
  node: BNode;
  content: Inline[];
  attr: AttrSpec | null;
}

function applyCaption(t: Extract<Block, { t: "Table" }>, cap: Caption): void {
  const { content, attr } = cap;
  if (content.length) t.caption = content;
  if (attr?.id) {
    t.label = attr.id;
    t.id = slugify(attr.id);
  }
  if (attr && (attr.classes.length || Object.keys(attr.attrs).length)) {
    const a: Attr = {};
    if (attr.classes.length) a.classes = attr.classes;
    if (Object.keys(attr.attrs).length) a.attrs = attr.attrs;
    t.attr = a;
  }
}

/**
 * Inline text is trimmed of spaces and tabs (or what `blank` matches) at
 * both ends before it is parsed. Other blank space, such as a no-break
 * space, goes only from the finished run.
 */
function trimSegs(segs: Seg[], blank: RegExp = /[ \t]/): Seg[] {
  const isBlank = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) if (!blank.test(s[i])) return false;
    return true;
  };
  const out = segs.slice();
  // Blank space at the start may run over whole lines.
  while (out.length > 1 && isBlank(out[0].text)) out.shift();
  while (out.length > 1 && isBlank(out[out.length - 1].text)) out.pop();
  if (!out.length) return out;
  const first = out[0];
  let lead = 0;
  while (lead < first.text.length && blank.test(first.text[lead])) lead++;
  if (lead) out[0] = { text: first.text.slice(lead), line: first.line, col: first.col + lead };
  const k = out.length - 1;
  const last = out[k];
  let end = last.text.length;
  while (end > 0 && blank.test(last.text[end - 1])) end--;
  const trimmed = last.text.slice(0, end);
  if (trimmed !== last.text) out[k] = { text: trimmed, line: last.line, col: last.col };
  return out;
}

function displayBlock(d: DisplayMath): Block {
  return mathBlock(d.tex, d.env, d.attr, d.pos);
}

/**
 * A math block. It is numbered when it is an environment without a star,
 * or has a label (from its attribute list or a `\label`), unless the
 * attribute list says `.unnumbered`.
 */
function mathBlock(tex: string, env: string | undefined, attr: AttrSpec | null | undefined, pos: Pos): Block {
  const m: Extract<Block, { t: "MathBlock" }> = { t: "MathBlock", tex, numbered: false };
  const label = attr?.id ?? firstLabel(tex);
  m.numbered = !hasClass(attr, "unnumbered") && (env ? !env.endsWith("*") : !!label);
  if (env) m.env = env;
  if (label) {
    m.label = label;
    m.id = slugify(label);
  }
  m.pos = pos;
  return m;
}

/** `{#sec:x}` gives a label and its slug as id; `{#x}` an id only. Other attributes are kept. */
function applyIdAndAttr(h: Extract<Block, { t: "Heading" }>, attr: AttrSpec | null): void {
  if (!attr) return;
  if (attr.id) {
    if (attr.id.includes(":")) {
      h.label = attr.id;
      h.id = slugify(attr.id);
    } else h.id = attr.id;
  }
  const a: Attr = {};
  if (attr.classes.length) a.classes = attr.classes;
  if (Object.keys(attr.attrs).length) a.attrs = attr.attrs;
  if (Object.keys(a).length) h.attr = a;
}

/** A deep copy, with the number of objects and arrays it took. */
function cloneCounting<T>(value: T): { value: T; count: number } {
  let count = 0;
  const copy = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      count++;
      return v.map(copy);
    }
    if (v && typeof v === "object") {
      count++;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = copy(x);
      return out;
    }
    return v;
  };
  return { value: copy(value) as T, count };
}

/**
 * Lines that each start with a bold label ("**Date:** Tuesday" over
 * "**Time:** 10:00") are a list of fields, written one per line the way chat
 * interfaces show them: keep the lines apart instead of running them into one
 * paragraph. Only when every line of the paragraph starts that way.
 */
function keepLabelLines(run: { t: string }[]): void {
  const breaks: number[] = [];
  let lineStart = true;
  for (let i = 0; i < run.length; i++) {
    const n = run[i] as Inline;
    if (n.t === "SoftBreak") {
      breaks.push(i);
      lineStart = true;
      continue;
    }
    if (!lineStart) continue;
    if (n.t === "Text" && !n.text.trim()) continue;
    if (n.t !== "Strong") return;
    const label = plainText(n.content).trimEnd();
    const next = run[i + 1] as Inline | undefined;
    if (!label.endsWith(":") && !(next?.t === "Text" && next.text.startsWith(":"))) return;
    lineStart = false;
  }
  if (!breaks.length) return;
  for (const i of breaks) run[i] = { t: "LineBreak" };
}
