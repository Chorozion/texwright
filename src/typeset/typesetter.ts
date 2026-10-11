/**
 * The document typesetter: turns a numbered, cited document tree into TeX
 * lists (boxes, glue, penalties, marks) for the page builder.
 *
 * Paragraphs are shaped with the layout engine's text shaper and broken with
 * Knuth-Plass; mathematics comes from the native math engine; figures are
 * raster images (embedded by the PDF writer) or SVG drawn as vectors.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Block, type CiteNode, type Document, type Inline, type Pos, type TableCell, hasQedHere, listLabel, plainText } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import {
  type AnchorInfo,
  type Hyphenator,
  INF_PENALTY,
  loadHyphenator,
  type LineBreakResult,
  VListBuilder,
  breakParagraph,
  glue,
  hpack,
  kern,
  penalty,
  shapeText,
  vpack,
} from "../layout/index.js";
import { inkWidth } from "../lint.js";
import type { Color, DrawOp, Drawing, Glue, HBox, HNode, Mark, Rule, VBox, VNode } from "../layout/types.js";
import { typesetMath } from "../math/index.js";
import type { PdfDocumentWriter } from "../pdf/api.js";
import { isEmbeddedImage, svgToDrawing } from "../svg/index.js";
import { displaySource, liftMacros } from "../transform/math.js";
import { type LabelInfo, type Numbering, refText } from "../transform/numbering.js";
import { type Token, tokenize } from "../util/highlight.js";
import { type ImagePolicy, resolveImage } from "../write/assets.js";
import type { CitationOutput } from "../write/html.js";
import { type Geometry, type InlineState, type Theme, lengthPt, textStyle } from "./style.js";
import type { TextStyle } from "../layout/index.js";
import type { MathOptions, MathResult } from "../math/api.js";
import { type CacheEvent, Lru, type Recorder, cloneBoxes, fingerprint, keyOf, recorderFor, replayDiagnostics, shapeId } from "./cache.js";

const FIL = 1 as const;
const FILL = 2 as const;

const ITALIC_THEOREMS = new Set(["theorem", "lemma", "corollary", "proposition", "conjecture", "claim", "thm", "lem", "cor", "prop"]);
const ADMONITIONS = new Set(["note", "tip", "hint", "important", "warning", "caution", "danger", "info", "box"]);

const TOKEN_COLORS: Partial<Record<string, Color>> = {
  comment: [0.416, 0.451, 0.49],
  quote: [0.416, 0.451, 0.49],
  keyword: [0.478, 0.122, 0.42],
  built_in: [0.478, 0.122, 0.42],
  type: [0.478, 0.122, 0.42],
  "selector-tag": [0.478, 0.122, 0.42],
  string: [0.114, 0.42, 0.22],
  regexp: [0.114, 0.42, 0.22],
  number: [0.627, 0.271, 0],
  literal: [0.627, 0.271, 0],
  symbol: [0.627, 0.271, 0],
  title: [0.102, 0.247, 0.545],
  "title.function": [0.102, 0.247, 0.545],
  "title.class": [0.102, 0.247, 0.545],
  section: [0.102, 0.247, 0.545],
  attr: [0.353, 0.29, 0],
  attribute: [0.353, 0.29, 0],
  variable: [0.353, 0.29, 0],
  meta: [0.333, 0.333, 0.333],
  addition: [0.114, 0.42, 0.22],
  deletion: [0.7, 0.13, 0.13],
};

export interface TypesetContext {
  doc: Document;
  numbering: Numbering;
  citations: CitationOutput;
  macros: Record<string, string>;
  diagnostics: Diagnostics;
  theme: Theme;
  geometry: Geometry;
  images: ImagePolicy;
  writer: PdfDocumentWriter;
  /** Where anchors landed in the previous layout pass (page references, contents). */
  pages?: ReadonlyMap<string, AnchorInfo>;
  /** Image cache shared across passes. */
  imageCache: Map<string, HNode | null>;
}

interface Env {
  width: number;
  shift: number;
}

interface ParOptions {
  indent?: number;
  align?: "justify" | "center" | "ragged" | "right";
  /** Material put before the first line's text (list labels, run-in heads), taking no width. */
  prefix?: HNode[];
  hanging?: number;
  /** Extra width at the right end of every line (theorem QED, etc. are added to the content instead). */
  tail?: HNode[];
}

function blankState(t: Theme, size = t.size): InlineState {
  return { bold: false, italic: false, mono: false, sans: false, size, smallCaps: false };
}

export class Typesetter {
  private noteCounter = 0;
  private afterHeading = false;
  private readonly overfullReported = new Set<string>();

  private readonly missing = new Set<number>();
  private hyphenatorCache: { points(word: string): number[] } | null | undefined;

  /**
   * Patterns for the document's language: English (the default) has them; other languages are not hyphenated yet.
   * They load when a paragraph first needs them (most break well without), which saves some 15 ms on a short document.
   */
  private hyphenator(): { points(word: string): number[] } | undefined {
    if (this.hyphenatorCache === undefined) {
      const lang = (this.ctx.doc.meta.lang ?? "en").toLowerCase();
      this.hyphenatorCache = lang === "en" || lang.startsWith("en-") ? { points: (word) => englishHyphenator().points(word) } : null;
    }
    return this.hyphenatorCache ?? undefined;
  }

  constructor(private readonly ctx: TypesetContext) {
    this.recorder = recorderFor(ctx.diagnostics);
  }

  /** The text style for a state, reporting characters no font has (once each). */
  style(state: InlineState): TextStyle {
    return {
      ...textStyle(this.ctx.theme, state),
      onMissing: (cp) => this.missingChar(cp),
    };
  }

  private missingChar(cp: number): void {
    this.recorder.emit({ t: "missing", cp });
    if (this.missing.has(cp) || this.missing.size > 50) return;
    this.missing.add(cp);
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    this.ctx.diagnostics.add("FONT001", `No available font has the character U+${hex} (${String.fromCodePoint(cp)})`, undefined, {
      hint: "Install a font that covers it, or set mainfont/sansfont to one",
    });
  }

  // ---------------------------------------------------------------- caches (src/typeset/cache.ts)

  private readonly recorder: Recorder;
  private contextKey: string | undefined;
  private macroKeyMemo: string | undefined;

  /** What every cached paragraph depends on besides its own content: theme, language, document settings, text width. */
  private baseKey(): string {
    if (this.contextKey === undefined) {
      const m = this.ctx.doc.meta;
      // Everything in the metadata but what only the title block shows (and the macros, keyed where formulas use them).
      const { title, subtitle, author, affiliation, date, abstract, keywords, macros, ...rest } = m;
      void [title, subtitle, author, affiliation, date, abstract, keywords, macros];
      this.contextKey = `${shapeId(this.ctx.theme)}\u0001${keyOf(fingerprint(rest))}\u0001${this.ctx.geometry.textWidth}`;
    }
    return this.contextKey;
  }

  /** The macro table as a key; worked out again after a formula that may define a macro. */
  private macroKey(): string {
    this.macroKeyMemo ??= keyOf(fingerprint(this.ctx.macros));
    return this.macroKeyMemo;
  }

  /** Lifts macro definitions out of a formula (they change the macro table, so its key is worked out again). */
  private lift(tex: string, pos: Pos | undefined): string {
    if (MAY_DEFINE.test(tex)) this.macroKeyMemo = undefined;
    return liftMacros(tex, this.ctx.macros, this.ctx.diagnostics, pos);
  }

  /**
   * A cached value: on a hit, a copy, with its diagnostics raised again (moved as far as `pos`
   * moved); on a miss, `fn` runs and its value is kept unless `cachable` says otherwise afterwards.
   * Both copies are of the boxes (and drawing operations, which the SVG code rewrites for each
   * document's writer); the leaves, which layout never changes, are shared (cloneBoxes).
   */
  private cached<T>(cache: Lru<CacheEntry<T>>, key: string | undefined, pos: Pos | undefined, fn: () => T, cachable: () => boolean = () => true): T {
    if (key === undefined) return fn();
    const hit = cache.get(key);
    if (hit) {
      const moved = pos?.line !== undefined && hit.line !== undefined ? pos.line - hit.line : 0;
      replayDiagnostics(this.ctx.diagnostics, hit.events, moved, pos?.file, (cp) => this.missingChar(cp));
      return cloneBoxes(hit.value);
    }
    const run = this.recorder.capture(fn);
    if (run.complete && cachable()) {
      const size = { n: 0 };
      cache.set(key, { value: cloneBoxes(run.value, size), events: run.events, line: pos?.line }, size.n + 1);
    }
    return run.value;
  }

  /** shapeText through the cache. */
  private shape(text: string, state: InlineState): HNode[] {
    const key = keyOf(`${shapeId(this.ctx.theme)}\u0001${JSON.stringify(state)}\u0001${text}`);
    return this.cached(shapeCache, key, undefined, () => shapeText(text, this.style(state)));
  }

  /** typesetMath through the cache. */
  private math(tex: string, o: Omit<MathOptions, "macros" | "diagnostics">): MathResult {
    const key = keyOf(`${o.display ? 1 : 0}\u0001${o.fontSize}\u0001${o.lineWidth ?? ""}\u0001${fingerprint(o.tags ?? null)}\u0001${o.pos?.col ?? ""}\u0001${this.macroKey()}\u0001${tex}`);
    return this.cached(mathCache, key, o.pos, () => typesetMath(tex, { ...o, macros: this.ctx.macros, diagnostics: this.ctx.diagnostics }));
  }

  /**
   * The key of a paragraph: its content with what it shows from elsewhere (reference numbers,
   * pages, rendered citations, the macros its formulas use), and everything about how it is set.
   * Undefined when it holds something that cannot be cached (footnotes, images, macro definitions).
   */
  private paragraphKey(inlines: Inline[], state: InlineState, env: Env, opts: ParOptions, pos: Pos | undefined): string | undefined {
    const parts: unknown[] = [];
    const flags = { math: false };
    if (!this.inlineKey(inlines, pos?.line ?? 0, parts, flags, 0)) return undefined;
    const how = [JSON.stringify(state), env.width, env.shift, opts.indent ?? null, opts.align ?? null, this.blockAlign ?? null, opts.hanging ?? null, this.sizeOverride ?? null, pos?.col ?? null];
    const nodes = opts.prefix || opts.tail ? fingerprint([opts.prefix ?? null, opts.tail ?? null]) : "";
    return keyOf(`${this.baseKey()}\u0001${flags.math ? this.macroKey() : ""}\u0001${JSON.stringify(how)}\u0001${nodes}\u0001${JSON.stringify(parts)}`);
  }

  private inlineKey(inlines: Inline[], line: number, out: unknown[], flags: { math: boolean }, depth: number): boolean {
    if (depth > 50) return false;
    for (const i of inlines) {
      switch (i.t) {
        case "Text":
          out.push(i.text);
          break;
        case "SoftBreak":
        case "LineBreak":
          out.push(i.t === "SoftBreak" ? 0 : 1);
          break;
        case "Code":
          out.push(["c", i.text]);
          break;
        case "RawInline":
          out.push(["r", i.format, i.text]);
          break;
        case "Math":
          if (MAY_DEFINE.test(i.tex)) return false;
          flags.math = true;
          out.push(["m", i.tex, i.pos ? i.pos.line - line : null, i.pos?.col ?? null]);
          break;
        case "Ref": {
          const info = this.ctx.numbering.labels.get(i.label);
          let text = refText(info, i.style);
          if (text === null) {
            const page = info ? this.ctx.pages?.get(info.id)?.page : undefined;
            text = page !== undefined ? String(page) : "??";
          }
          out.push(["R", i.style ?? null, info?.id ?? null, text]);
          break;
        }
        case "Cite": {
          const rendered = this.ctx.citations.rendered.get(i as CiteNode);
          const sub: unknown[] = ["C"];
          if (rendered && i.mode !== "nocite" && !this.inlineKey(rendered, line, sub, flags, depth + 1)) return false;
          out.push(sub);
          break;
        }
        case "Emph":
        case "Strong":
        case "Underline":
        case "Strike":
        case "SmallCaps":
        case "Superscript":
        case "Subscript":
        case "Link":
        case "Span": {
          const sub: unknown[] = [i.t];
          if (i.t === "Link") sub.push(i.url);
          if (i.t === "Span") sub.push(i.attr, i.attr.classes?.includes("numpages") ? (this.ctx.pages?.get(LAST_PAGE)?.page ?? null) : null);
          if (!this.inlineKey(i.content, line, sub, flags, depth + 1)) return false;
          out.push(sub);
          break;
        }
        default:
          // Footnotes (numbered as they come), images (registered with the PDF writer) and anything new.
          return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- document

  /** The whole document as a vertical list. */
  document(): VNode[] {
    const t = this.ctx.theme;
    const vb = new VListBuilder({ baselineSkip: t.baselineSkip, lineSkip: 1, lineSkipLimit: 0 });
    const env: Env = { width: this.ctx.geometry.textWidth, shift: 0 };
    this.titleBlock(vb, env);
    const meta = this.ctx.doc.meta;
    const hasToc = this.ctx.doc.blocks.some((b) => b.t === "TOC");
    if (meta.toc && !hasToc) this.toc(vb, env);
    this.blocks(this.ctx.doc.blocks, vb, env);
    if (this.ctx.citations.bibliography.length && !this.bibliographyWritten) this.bibliography(vb, env, true);
    // Where the document ends, for "Page 3 of 7" (\numpages, \pageref{LastPage}).
    vb.mark({ t: "anchor", id: LAST_PAGE });
    return vb.list;
  }

  private bibliographyWritten = false;

  private titleBlock(vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const m = this.ctx.doc.meta;
    if (!m.title && !m.author?.length && !m.abstract?.length) return;
    const centered = (inl: Inline[], size: number, bold = false, sans = t.bodySans): void => {
      const res = this.paragraphLines(inl, { ...blankState(t, size), bold, sans }, env, { align: t.bodySans ? "ragged" : "center", indent: 0 });
      vb.paragraph(res);
    };
    if (m.title) {
      vb.glue(t.bodySans ? 0 : 24);
      centered(m.title, t.titleSize, t.bodySans);
      vb.glue(t.bodySans ? 6 : 14);
    }
    if (m.subtitle) {
      centered(m.subtitle, t.size * 1.18);
      vb.glue(8);
    }
    if (m.author?.length) {
      const nameSize = t.size * 1.09;
      const affs = m.author.map((_, k) => m.affiliation?.[k] ?? null);
      const distinct = new Set(affs.filter((a): a is Inline[] => !!a).map((a) => plainText(a)));
      if (distinct.size <= 1) {
        // One line of names, then the affiliation they share (if any).
        const joined: Inline[] = [];
        m.author.forEach((a, k) => {
          if (k) joined.push({ t: "Text", text: "\u2003\u2003" });
          joined.push(...a);
        });
        centered(joined, nameSize);
        const shared = affs.find((a) => a);
        if (shared) {
          vb.glue(2);
          centered(shared, t.size);
        }
      } else {
        // A column per author, name over affiliation, side by side (LaTeX's \and); stacked when too wide.
        const line = (inl: Inline[], size: number): HBox => {
          const out: HNode[] = [];
          this.inlines(inl, { ...blankState(t, size), sans: t.bodySans }, out);
          return hpack(out).box;
        };
        const columns = m.author.map((a, k) => {
          // An affiliation of several lines (IEEEtran's \IEEEauthorblockA) gives a row per line.
          const affLines: Inline[][] = [[]];
          for (const x of affs[k] ?? []) {
            if (x.t === "LineBreak") affLines.push([]);
            else affLines[affLines.length - 1]!.push(x);
          }
          const rows = [line(a, nameSize), ...affLines.filter((l) => l.length).map((l) => line(l, t.size))];
          const width = Math.max(...rows.map((r) => r.width));
          const col = new VListBuilder({ baselineSkip: t.baselineSkip * 1.05, lineSkip: 1, lineSkipLimit: 0 });
          for (const r of rows) col.box(hpack([glue(0, 1, 0, FIL), r, glue(0, 1, 0, FIL)], { width }).box);
          const box = vpack(col.list).box;
          const first = rows[0]!;
          // Baseline at the name's baseline, so columns line up by their first line.
          return { ...box, height: first.height, depth: box.height + box.depth - first.height };
        });
        const gap = t.size * 2;
        const natural = columns.reduce((s, c) => s + c.width, 0) + gap * (columns.length - 1);
        if (natural <= env.width) {
          const row: HNode[] = [glue(0, 1, 0, FIL)];
          columns.forEach((c, k) => {
            if (k) row.push(kern(gap));
            row.push(c);
          });
          row.push(glue(0, 1, 0, FIL));
          vb.box(this.shifted(hpack(row, { width: env.width }).box, env));
        } else {
          m.author.forEach((a, k) => {
            if (k) vb.glue(4);
            centered(a, nameSize);
            if (affs[k]) centered(affs[k]!, t.size);
          });
        }
      }
      vb.glue(6);
    }
    if (m.date) {
      centered(m.date, t.size * 1.09);
    }
    vb.glue(t.bodySans ? 10 : 18);
    if (m.abstract?.length) {
      const inner: Env = { width: env.width - 2 * t.listIndent * 0.9, shift: env.shift + t.listIndent * 0.9 };
      centered([{ t: "Text", text: "Abstract" }], t.smallSize, true);
      vb.glue(4);
      this.withSize(t.smallSize, () => this.blocks(m.abstract!, vb, inner, { noIndentFirst: true }));
      if (m.keywords?.length) {
        vb.glue(4);
        const res = this.paragraphLines(
          [{ t: "Strong", content: [{ t: "Text", text: "Keywords: " }] }, { t: "Text", text: m.keywords.join(", ") }],
          blankState(t, t.smallSize),
          inner,
          { indent: 0 },
        );
        vb.paragraph(res);
      }
      vb.glue(16);
    }
    this.afterHeading = true;
  }

  private sizeOverride: number | undefined;

  private withSize<T>(size: number, fn: () => T): T {
    const prev = this.sizeOverride;
    this.sizeOverride = size;
    try {
      return fn();
    } finally {
      this.sizeOverride = prev;
    }
  }

  private bodySize(): number {
    return this.sizeOverride ?? this.ctx.theme.size;
  }

  // ---------------------------------------------------------------- blocks

  blocks(blocks: Block[], vb: VListBuilder, env: Env, opts: { noIndentFirst?: boolean; state?: Partial<InlineState> } = {}): void {
    if (opts.noIndentFirst) this.afterHeading = true;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k]!;
      const next = blocks[k + 1];
      if (b.t === "Heading" && next?.t === "Para" && this.runsIn(b)) {
        this.runInHeading(b, next, vb, env);
        k++;
        continue;
      }
      this.block(b, vb, env, opts.state);
    }
  }

  /** Fourth-level headings and below run into their paragraph, as LaTeX's \paragraph does (article look only). */
  private runsIn(b: Extract<Block, { t: "Heading" }>): boolean {
    if (this.ctx.theme.name !== "article") return false;
    let top = 6;
    for (const x of this.ctx.doc.blocks) if (x.t === "Heading") top = Math.min(top, x.level);
    return b.level - top >= 3;
  }

  private runInHeading(b: Extract<Block, { t: "Heading" }>, para: Extract<Block, { t: "Para" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const size = this.bodySize();
    const state = blankState(t, size);
    const prefix: HNode[] = [];
    if (b.id) {
      prefix.push({ t: "anchor", id: b.id });
      const title = plainText(b.content);
      prefix.push({ t: "outline", title: b.number ? `${b.number} ${title}` : title, level: 4, dest: b.id });
    }
    const head: Inline[] = b.number ? [{ t: "Text", text: `${b.number} ` }, ...b.content] : [...b.content];
    this.inlines([{ t: "Strong", content: head }], state, prefix);
    prefix.push(kern(size));
    this.addPenalty(vb, -150);
    this.vspace(vb, glue(size * 1.1, 3, 1));
    this.afterHeading = false;
    vb.paragraph(this.paragraphLines(para.content, state, env, { indent: 0, prefix }, para.pos), { clubPenalty: 150, widowPenalty: 150 });
  }

  private block(b: Block, vb: VListBuilder, env: Env, stateOverride?: Partial<InlineState>): void {
    const t = this.ctx.theme;
    const state = { ...blankState(t, this.bodySize()), ...stateOverride };
    switch (b.t) {
      case "Para": {
        vb.glue(this.blockParagraphs ? glue(this.bodySize() * 0.7, 2) : glue(t.parSkip.width, t.parSkip.stretch));
        // \noindent at the start of a LaTeX paragraph arrives as an empty "noindent" span.
        const first = b.content[0];
        const noindent = first?.t === "Span" && !first.content.length && !!first.attr.classes?.includes("noindent");
        const indent = this.afterHeading || this.blockParagraphs || noindent ? 0 : t.parIndent;
        this.afterHeading = false;
        vb.paragraph(this.paragraphLines(b.content, state, env, { indent }, b.pos), { clubPenalty: 150, widowPenalty: 150 });
        return;
      }
      case "Plain":
        vb.paragraph(this.paragraphLines(b.content, state, env, { indent: 0 }, b.pos), { clubPenalty: 150, widowPenalty: 150 });
        this.afterHeading = false;
        return;
      case "Heading":
        this.heading(b, vb, env);
        return;
      case "MathBlock":
        this.displayMath(b, vb, env);
        return;
      case "CodeBlock":
        this.codeBlock(b, vb, env);
        return;
      case "BlockQuote": {
        const inner: Env = { width: env.width - 2 * t.listIndent, shift: env.shift + t.listIndent };
        this.vspace(vb, glue(6, 2));
        this.blocks(b.blocks, vb, inner, { noIndentFirst: true });
        this.vspace(vb, glue(6, 2));
        return;
      }
      case "List":
        this.list(b, vb, env);
        return;
      case "DefList":
        for (const it of b.items) {
          this.vspace(vb, glue(t.itemSep + 2, 1));
          vb.paragraph(this.paragraphLines(it.term, { ...state, bold: true }, env, { indent: 0, align: "ragged" }, b.pos), { interlinePenalty: INF_PENALTY });
          // A term never ends a page apart from its definition.
          vb.penalty(INF_PENALTY);
          for (const d of it.defs) this.blocks(d, vb, { width: env.width - t.listIndent, shift: env.shift + t.listIndent }, { noIndentFirst: true });
        }
        this.vspace(vb, glue(t.itemSep, 1));
        this.afterHeading = false;
        return;
      case "Table":
        this.table(b, vb, env);
        return;
      case "Figure":
        this.figure(b, vb, env);
        return;
      case "Div":
        this.div(b, vb, env);
        return;
      case "Theorem":
        this.theorem(b, vb, env);
        return;
      case "RawBlock": {
        const text = b.format === "html" ? b.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : b.text;
        if (!text) return;
        if (b.format === "latex") this.codeBlock({ t: "CodeBlock", text, pos: b.pos }, vb, env);
        else vb.paragraph(this.paragraphLines([{ t: "Text", text }], state, env, { indent: 0 }, b.pos));
        return;
      }
      case "HorizontalRule":
        this.vspace(vb, glue(8, 2));
        vb.box(this.shifted(hpack([glue(0, 1, 0, FIL), { t: "rule", width: env.width * 0.3, height: 0.4, depth: 0, color: t.ruleColor }, glue(0, 1, 0, FIL)], { width: env.width }).box, env));
        this.vspace(vb, glue(8, 2));
        return;
      case "PageBreak":
        vb.penalty(-INF_PENALTY);
        return;
      case "TOC":
        this.toc(vb, env);
        return;
      case "Bibliography":
        this.bibliography(vb, env, false);
        return;
    }
  }

  private readonly vspaces = new WeakSet<object>();
  /** Alignment of the enclosing center, flushright or flushleft block. */
  private blockAlign: "center" | "right" | "ragged" | undefined;
  /** Paragraphs without indent and with space between them (the letter class). */
  private blockParagraphs = false;

  /** LaTeX's \addvspace: space between blocks; next to other such space, the larger of the two wins. */
  private vspace(vb: VListBuilder, g: Glue): void {
    const last = vb.list[vb.list.length - 1];
    if (last && last.t === "glue" && this.vspaces.has(last)) {
      if (g.width > last.width) Object.assign(last, { width: g.width, stretch: g.stretch, shrink: g.shrink });
      return;
    }
    const node = { ...g };
    this.vspaces.add(node);
    vb.list.push(node);
  }

  /** LaTeX's \addpenalty: a break penalty placed before any block space already added, so that space can merge. */
  private addPenalty(vb: VListBuilder, p: number): void {
    const last = vb.list[vb.list.length - 1];
    if (last && last.t === "glue" && this.vspaces.has(last)) vb.list.splice(vb.list.length - 1, 0, penalty(p));
    else vb.penalty(p);
  }

  private shifted<B extends HBox | VBox>(box: B, env: Env): B {
    if (env.shift) box.shift = (box.shift ?? 0) + env.shift;
    return box;
  }

  private heading(b: Extract<Block, { t: "Heading" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    let top = 6;
    for (const x of this.ctx.doc.blocks) if (x.t === "Heading") top = Math.min(top, x.level);
    const level = Math.max(0, Math.min(5, b.level - top));
    const size = t.headingSize[level]!;
    const state: InlineState = { ...blankState(t, size), bold: t.headingBold, sans: t.bodySans, color: t.headingColor };
    const content: Inline[] = [...b.content];
    const prefix: HNode[] = [];
    if (b.id) prefix.push({ t: "anchor", id: b.id });
    const title = plainText(b.content);
    if (b.id) prefix.push({ t: "outline", title: b.number ? `${b.number} ${title}` : title, level: level + 1, dest: b.id });
    if (b.number) {
      const num = this.shape(b.number, state);
      prefix.push(...num, kern(size * (t.bodySans ? 0.5 : 0.8)));
    }
    this.addPenalty(vb, level === 0 ? -300 : -200);
    this.vspace(vb, glue(t.headingAbove[level]!, 3, 1));
    const res = this.paragraphLines(content, state, env, { indent: 0, align: "ragged", prefix, inlinePrefix: true } as ParOptions, b.pos);
    vb.paragraph(res, { interlinePenalty: INF_PENALTY, clubPenalty: INF_PENALTY, widowPenalty: INF_PENALTY });
    vb.penalty(INF_PENALTY);
    this.vspace(vb, glue(t.headingBelow[level]!, 1));
    this.afterHeading = true;
  }

  // ---------------------------------------------------------------- paragraphs

  /** Shape inlines and break them into lines. */
  paragraphLines(inlines: Inline[], state: InlineState, env: Env, opts: ParOptions & { inlinePrefix?: boolean } = {}, pos?: Pos): LineBreakResult {
    // `list` (the broken list itself) is left out: nothing reads it, and it would double what is cached.
    const res = this.cached(paragraphCache, this.paragraphKey(inlines, state, env, opts, pos), pos, () => ({ ...this.breakLines(inlines, state, env, opts), list: [] }));
    const worst = Math.max(0, ...res.overfull.map((o) => o.amount));
    if (worst > 1) {
      const key = `${pos?.line ?? ""}:${pos?.col ?? ""}`;
      if (!this.overfullReported.has(key)) {
        this.overfullReported.add(key);
        this.ctx.diagnostics.add("LAY001", `A line sticks out of the text area by ${worst.toFixed(1)}pt`, pos, {
          hint: "A long word, URL or formula that cannot be broken; allow a break (shorter link text, \\allowbreak) or rephrase",
        });
      }
    }
    return res;
  }

  private breakLines(inlines: Inline[], state: InlineState, env: Env, opts: ParOptions): LineBreakResult {
    const t = this.ctx.theme;
    const list: HNode[] = [];
    // Inside center or flushright, paragraphs follow the block's alignment and lose their indent.
    const blockAlign = opts.align ? undefined : this.blockAlign;
    if (opts.indent && !blockAlign) list.push({ t: "hbox", width: opts.indent, height: 0, depth: 0, children: [] });
    if (opts.prefix) list.push(...opts.prefix);
    this.inlines(inlines, state, list);
    if (opts.tail) list.push(...opts.tail);
    // Trailing spaces would make the last line's parfillskip fight a glue; drop them.
    // Glue that draws (\hrulefill at the end of a line) is content, not space.
    while (list.length && list[list.length - 1]!.t === "glue" && !(list[list.length - 1] as Glue).leader) list.pop();
    if (!list.length) list.push({ t: "hbox", width: 0, height: 0, depth: 0, children: [] });
    const align = opts.align ?? blockAlign ?? (t.justify ? "justify" : "ragged");
    // A forced line break (\\) ends its line with fill; in centred or right-aligned text that
    // fill would push the line off centre, so there the line's own skips do the work.
    if (align === "center" || align === "right") {
      for (let k = 0; k + 1 < list.length; k++) {
        const g = list[k]!;
        const next = list[k + 1]!;
        if (g.t === "glue" && !g.leader && g.stretchOrder > 0 && next.t === "penalty" && next.penalty <= -INF_PENALTY) list[k] = glue(0);
      }
    }
    const hanging = opts.hanging ?? 0;
    return breakParagraph(list, {
      lineWidth: hanging ? [env.width, env.width - hanging] : env.width,
      lineShift: hanging ? [env.shift, env.shift + hanging] : env.shift,
      emergencyStretch: t.emergencyStretch,
      raggedRight: align === "ragged",
      // Justified text hyphenates, as TeX's does; ragged and centred text (headings, captions) does not.
      hyphenate: align === "justify" ? this.hyphenator() : undefined,
      // Protrusion and expansion even out justified text, as microtype does for pdfLaTeX.
      microtype: align === "justify" ? t.microtype : undefined,
      ...(align === "center"
        ? { leftSkip: glue(0, 1, 0, FIL), rightSkip: glue(0, 1, 0, FIL), parFillSkip: glue(0) }
        : align === "right"
          ? { leftSkip: glue(0, 1, 0, FIL), parFillSkip: glue(0) }
          : {}),
    });
  }

  // ---------------------------------------------------------------- inlines

  inlines(inlines: Inline[], state: InlineState, out: HNode[]): void {
    let skipUntil: RegExp | null = null;
    for (const i of inlines) {
      if (skipUntil) {
        if (i.t === "RawInline" && skipUntil.test(i.text)) skipUntil = null;
        continue;
      }
      if (i.t === "RawInline" && i.format === "html") {
        const open = /^<(script|style|iframe|object|embed|noscript|template|textarea|title)\b/i.exec(i.text);
        if (open && !new RegExp(`</${open[1]}\\s*>`, "i").test(i.text)) {
          skipUntil = new RegExp(`</${open[1]}\\s*>`, "i");
          continue;
        }
      }
      this.inline(i, state, out);
    }
  }

  private text(text: string, state: InlineState, out: HNode[]): void {
    if (!text) return;
    if (state.smallCaps) {
      // Fake small capitals: lower-case letters as capitals at 80%.
      for (const m of text.matchAll(/(\p{Ll}+)|([^\p{Ll}]+)/gu)) {
        if (m[1]) out.push(...this.shape(m[1].toUpperCase(), { ...state, size: state.size * 0.8 }));
        else out.push(...this.shape(m[2]!, state));
      }
      return;
    }
    out.push(...this.shape(text, state));
  }

  private inline(i: Inline, state: InlineState, out: HNode[]): void {
    const t = this.ctx.theme;
    switch (i.t) {
      case "Text":
        this.text(i.text, state, out);
        return;
      case "SoftBreak":
        this.text(" ", state, out);
        return;
      case "LineBreak":
        out.push(glue(0, 1, 0, FIL), penalty(-INF_PENALTY));
        return;
      case "Emph":
        this.inlines(i.content, { ...state, italic: !state.italic }, out);
        return;
      case "Strong":
        this.inlines(i.content, { ...state, bold: true }, out);
        return;
      case "Underline":
      case "Strike": {
        const inner: HNode[] = [];
        this.inlines(i.content, state, inner);
        const box = hpack(inner).box;
        const y = i.t === "Underline" ? -state.size * 0.12 : state.size * 0.25;
        out.push(box, kern(-box.width), { t: "hbox", width: box.width, height: 0, depth: 0, shift: -y, children: [{ t: "rule", width: box.width, height: 0.5, depth: 0, color: state.color }] });
        return;
      }
      case "SmallCaps":
        this.inlines(i.content, { ...state, smallCaps: true }, out);
        return;
      case "Superscript":
      case "Subscript": {
        const inner: HNode[] = [];
        this.inlines(i.content, { ...state, size: state.size * 0.7 }, inner);
        const box = hpack(inner).box;
        box.shift = i.t === "Superscript" ? -state.size * 0.36 : state.size * 0.15;
        out.push(box);
        return;
      }
      case "Code":
        this.text(i.text, { ...state, mono: true, size: state.size * 0.92 }, out);
        return;
      case "Math": {
        const tex = this.lift(i.tex, i.pos);
        const res = this.math(tex, { display: false, fontSize: state.size, pos: i.pos });
        const box = res.box;
        // As in TeX, an inline formula joins the paragraph: its glue stretches with the line, and the
        // penalties after relations (500) and binary operators (700) are places the line may break.
        if (res.ok && !box.shift && !box.glueSet) {
          // Glue inside a formula is never a breakpoint in TeX (auto-breaking is off between the math nodes);
          // a penalty of 10000 in front of it says the same to the line breaker.
          for (const n of box.children) {
            if (n.t === "glue") out.push(penalty(INF_PENALTY));
            out.push(n);
          }
        } else out.push(box);
        return;
      }
      case "Link": {
        const url = i.url;
        const target = url.startsWith("#") ? { dest: url.slice(1) } : { url };
        out.push({ t: "link-start", target });
        this.inlines(i.content, { ...state, color: state.color ?? t.linkColor }, out);
        out.push({ t: "link-end" });
        return;
      }
      case "Image": {
        const box = this.image(i, this.ctx.geometry.textWidth);
        if (box) out.push(box);
        return;
      }
      case "Ref": {
        const info: LabelInfo | undefined = this.ctx.numbering.labels.get(i.label);
        let text = refText(info, i.style);
        if (text === null) {
          const page = info ? this.ctx.pages?.get(info.id)?.page : undefined;
          text = page !== undefined ? String(page) : "??";
        }
        if (!info) {
          this.text(text, state, out);
          return;
        }
        out.push({ t: "link-start", target: { dest: info.id } });
        this.text(text, { ...state, color: t.linkColor }, out);
        out.push({ t: "link-end" });
        return;
      }
      case "Cite": {
        const rendered = this.ctx.citations.rendered.get(i as CiteNode);
        if (rendered && i.mode !== "nocite") this.inlines(rendered, state, out);
        return;
      }
      case "Note": {
        const n = ++this.noteCounter;
        const mark: HNode[] = [];
        this.inlines([{ t: "Superscript", content: [{ t: "Text", text: String(n) }] }], { ...state, color: t.linkColor }, mark);
        out.push(...mark);
        out.push({ t: "footnote", content: this.footnote(n, i.blocks) });
        return;
      }
      case "Span":
        if (i.attr.id) out.push({ t: "anchor", id: i.attr.id });
        if (i.attr.classes?.includes("color") && /^#[0-9a-f]{6}$/i.test(i.attr.attrs?.color ?? "")) {
          const h = i.attr.attrs!.color!;
          const rgb: [number, number, number] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as [number, number, number];
          this.inlines(i.content, { ...state, color: rgb }, out);
          return;
        }
        const sized = i.attr.classes?.find((c) => c.startsWith("size-"));
        if (sized && Object.hasOwn(SIZE_FACTORS, sized.slice(5))) {
          this.inlines(i.content, { ...state, size: this.bodySize() * SIZE_FACTORS[sized.slice(5)]! }, out);
          return;
        }
        if (i.attr.classes?.includes("rule")) {
          // \rule{6cm}{0.4pt}: a box of ink, raised by the optional amount.
          const a = i.attr.attrs ?? {};
          const len = (v: string | undefined, dflt: number) => (v === undefined ? dflt : v.endsWith("%") ? (parseFloat(v) / 100) * this.ctx.geometry.textWidth : v.endsWith("em") ? parseFloat(v) * state.size : v.endsWith("ex") ? parseFloat(v) * state.size * 0.43 : lengthPt(v, dflt));
          const w = Math.max(0, len(a.width, 0));
          const h = len(a.height, 0.4);
          const r = len(a.raise, 0);
          out.push({ t: "rule", width: w, height: Math.max(0, r + h), depth: Math.max(0, -r) });
          return;
        }
        if (i.attr.classes?.includes("numpages")) {
          const last = this.ctx.pages?.get(LAST_PAGE)?.page;
          this.text(last !== undefined ? String(last) : "00", state, out);
          return;
        }
        if (i.attr.classes?.includes("hfill")) {
          // Stronger than the fil glue a line break or the paragraph's end adds, as \hfill is in TeX.
          out.push(glue(0, 1, 0, FILL));
          return;
        }
        if (i.attr.classes?.includes("hrulefill") || i.attr.classes?.includes("dotfill")) {
          // \hrulefill and \dotfill: glue that stretches to the end of the line, drawn as a rule or dots.
          const dot = hpack([glue(0, 1, 0, FIL), ...shapeText(".", this.style(state)), glue(0, 1, 0, FIL)], { width: state.size * 0.45 }).box;
          const leader = i.attr.classes.includes("dotfill") ? dot : { t: "rule" as const, width: 0, height: 0.4, depth: 0 };
          out.push({ ...glue(state.size, 1, 0, FIL), leader });
          return;
        }
        this.inlines(i.content, (i.attr.classes ?? []).includes("smallcaps") ? { ...state, smallCaps: true } : state, out);
        return;
      case "RawInline":
        if (i.format === "html") {
          if (/^<br\s*\/?>$/i.test(i.text)) out.push(glue(0, 1, 0, FIL), penalty(-INF_PENALTY));
          return;
        }
        this.text(i.text, { ...state, mono: true, size: state.size * 0.92, color: [0.54, 0.33, 0] }, out);
        return;
    }
  }

  private footnote(n: number, blocks: Block[]): VBox {
    const t = this.ctx.theme;
    const size = t.footnoteSize;
    const env: Env = { width: this.ctx.geometry.textWidth, shift: 0 };
    const vb = new VListBuilder({ baselineSkip: size * 1.22, lineSkip: 1, lineSkipLimit: 0 });
    const label: HNode[] = [];
    this.inlines([{ t: "Superscript", content: [{ t: "Text", text: String(n) }] }], blankState(t, size), label);
    const savedAfter = this.afterHeading;
    this.withSize(size, () => {
      blocks.forEach((b, k) => {
        if (k === 0 && (b.t === "Para" || b.t === "Plain")) {
          vb.paragraph(this.paragraphLines(b.content, blankState(t, size), env, { indent: size, prefix: [...label, kern(size * 0.25)] }));
        } else {
          this.block(b, vb, env, { size });
        }
      });
    });
    this.afterHeading = savedAfter;
    return vpack(vb.list).box;
  }

  // ---------------------------------------------------------------- display math

  private displayMath(b: Extract<Block, { t: "MathBlock" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const { tex: source, tags } = displaySource(b, this.lift(b.tex, b.pos));
    let res = this.math(source, {
      display: true,
      fontSize: this.bodySize(),
      pos: b.pos,
      tags,
      lineWidth: env.width,
    });
    // A display slightly wider than the column is set a little smaller to fit (down to 80%), as an
    // author would with \small; one far wider keeps its size and LAY006 reports it.
    // Measured as the layout lint measures it (ink included), so what is fixed here is not reported there.
    const excess = Math.max(overflowOf(res.box, env.width), inkWidth(res.box) - env.width);
    if (excess > 0.5 && excess <= env.width * 0.25) {
      const scale = Math.max(0.8, (env.width - 1) / (env.width + excess));
      res = this.math(source, { display: true, fontSize: this.bodySize() * scale, pos: b.pos, tags, lineWidth: env.width });
    }
    const anchors: Mark[] = [];
    if (b.id) anchors.push({ t: "anchor", id: b.id });
    for (const l of b.lineLabels ?? []) {
      const id = l ? this.ctx.numbering.labels.get(l)?.id : undefined;
      if (id && id !== b.id) anchors.push({ t: "anchor", id });
    }
    vb.penalty(INF_PENALTY);
    this.vspace(vb, glue(t.displaySkip, 3, 6));
    const box = res.box;
    box.children.unshift(...anchors);
    vb.box(this.shifted(box, env));
    this.vspace(vb, glue(t.displaySkip, 3, 6));
    this.afterHeading = true;
  }

  // ---------------------------------------------------------------- code

  private codeBlock(b: Extract<Block, { t: "CodeBlock" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const size = t.codeSize;
    const lead = size * 1.3;
    const pad = 6;
    const caption = b.attr?.attrs?.caption;
    const number = b.attr?.attrs?.number;
    this.vspace(vb, glue(6, 2));
    if (b.attr?.id) vb.mark({ t: "anchor", id: b.attr.id });
    if (caption) {
      const inl: Inline[] = [{ t: "Strong", content: [{ t: "Text", text: `Listing${number ? ` ${number}` : ""}: ` }] }, { t: "Text", text: caption }];
      vb.paragraph(this.paragraphLines(inl, blankState(t, t.captionSize), env, { indent: 0, align: "ragged" }), { interlinePenalty: INF_PENALTY });
      vb.penalty(INF_PENALTY);
      vb.glue(3);
    }
    const tokens: Token[] = b.lang ? highlighted(b.text.replace(/\n$/, ""), b.lang) : [{ text: b.text.replace(/\n$/, ""), kind: "" }];
    // Split the token stream into lines.
    const lines: Token[][] = [[]];
    for (const tok of tokens) {
      const parts = tok.text.split("\n");
      parts.forEach((p, k) => {
        if (k) lines.push([]);
        if (p) lines[lines.length - 1]!.push({ text: p, kind: tok.kind });
      });
    }
    const inner = env.width - 2 * pad;
    const bg = t.codeBackground;
    const lineBox = (content: HNode[], first: boolean, last: boolean): HBox => {
      const above = lead * 0.75 + (first ? pad : 0);
      const below = lead * 0.25 + (last ? pad : 0);
      const children: HNode[] = [];
      if (bg) children.push({ t: "rule", width: env.width, height: above, depth: below, color: bg }, kern(-env.width));
      children.push({ t: "rule", width: 1.5, height: above, depth: below, color: t.ruleColor }, kern(pad - 1.5), ...content);
      const box = hpack(children, { width: env.width }).box;
      box.height = above;
      box.depth = below;
      return this.shifted(box, env);
    };
    vb.noInterline();
    const style = blankState(t, size);
    lines.forEach((line, k) => {
      const content: HNode[] = [];
      for (const tok of line) {
        // Leading spaces matter in code: keep them as fixed-width glue.
        const color = TOKEN_COLORS[tok.kind];
        for (const m of tok.text.matchAll(/( +)|([^ ]+)/g)) {
          if (m[1]) content.push(kern(m[1].length * size * 0.525));
          else content.push(...this.shape(m[2]!, { ...style, mono: true, color }));
        }
      }
      content.push(glue(0, 1, 0, FIL));
      // Very long lines wrap rather than run off the page.
      const natural = hpack([...content]).box.width;
      if (natural > inner + 0.5) {
        // Spaces become fixed-width glue a line may break at, and long tokens (paths, URLs, chained
        // calls) may break after / . , ; : = & ? so nothing runs off the page.
        const breakable: HNode[] = [];
        for (const tok of line) {
          const color = TOKEN_COLORS[tok.kind];
          for (const m of tok.text.matchAll(/( +)|([^ ]+)/g)) {
            if (m[1]) breakable.push(glue(m[1].length * size * 0.525, 0, 0));
            else
              m[2]!.split(/(?<=[/.,;:=&?])/).forEach((piece, j) => {
                if (j) breakable.push(penalty(50));
                breakable.push(...this.shape(piece, { ...style, mono: true, color }));
              });
          }
        }
        const res = breakParagraph(breakable, { lineWidth: inner, raggedRight: true, emergencyStretch: inner });
        res.lines.forEach((l, j) => {
          vb.list.push(lineBox([l], k === 0 && j === 0, k === lines.length - 1 && j === res.lines.length - 1));
          if (j < res.lines.length - 1) vb.list.push(penalty(INF_PENALTY));
        });
      } else {
        vb.list.push(lineBox(content, k === 0, k === lines.length - 1));
      }
      // Keep the first two and last two lines together.
      if (k < lines.length - 1) vb.list.push(penalty(k === 0 || k === lines.length - 2 ? 500 : 0));
    });
    vb.prevDepth = lead * 0.25 + pad;
    this.vspace(vb, glue(6, 2));
    this.afterHeading = false;
  }

  // ---------------------------------------------------------------- lists

  private list(b: Extract<Block, { t: "List" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const indent = t.listIndent;
    const inner: Env = { width: env.width - indent, shift: env.shift + indent };
    const labelSep = this.bodySize() * 0.5;
    const style = blankState(t, this.bodySize());
    this.vspace(vb, glue(b.tight ? 3 : t.itemSep, 2));
    b.items.forEach((item, k) => {
      if (k) vb.glue(glue(b.tight ? 1 : t.itemSep, 1));
      const n = (b.start ?? 1) + k;
      let label: string;
      if (b.task && b.task[k] !== null && b.task[k] !== undefined) label = b.task[k] ? "☑" : "☐";
      else if (!b.ordered) label = "∙";
      else label = listLabel(n, b.style, b.delim);
      const labelNodes = this.shape(label, style);
      const labelBox = hpack([glue(0, 1, 0, FIL), ...labelNodes], { width: indent - labelSep }).box;
      const prefix: HNode[] = [kern(-indent), labelBox, kern(labelSep)];
      const first = item[0];
      if (first && (first.t === "Para" || first.t === "Plain")) {
        vb.paragraph(this.paragraphLines(first.content, style, inner, { indent: 0, prefix }, first.pos), { clubPenalty: 150, widowPenalty: 150 });
        this.afterHeading = true;
        this.blocks(item.slice(1), vb, inner);
      } else {
        // An item that starts with a nested block: put the label on a line of its own.
        vb.box(this.shifted(hpack([...prefix, glue(0, 1, 0, FIL)], { width: inner.width }).box, inner));
        this.blocks(item, vb, inner, { noIndentFirst: true });
      }
    });
    this.vspace(vb, glue(b.tight ? 3 : t.itemSep, 2));
    this.afterHeading = false;
  }

  // ---------------------------------------------------------------- tables

  private cellContent(c: TableCell, state: InlineState): HNode[] {
    const out: HNode[] = [];
    this.inlines(c.content, state, out);
    return out;
  }

  private table(b: Extract<Block, { t: "Table" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const size = this.ctx.theme.name === "article" ? t.size * 0.91 : t.size * 0.9;
    const sep = 6;
    const rows = [...b.head.map((r) => ({ r, head: true })), ...b.body.map((r) => ({ r, head: false })), ...(b.foot ?? []).map((r) => ({ r, head: false }))];
    // The column each cell starts in: a \multirow cell covers its column in the rows below, which leave it out.
    const starts: number[][] = [];
    const covered = new Map<number, number>();
    for (const { r } of rows) {
      const s: number[] = [];
      const added = new Map<number, number>();
      let col = 0;
      for (const c of r) {
        while ((covered.get(col) ?? 0) > 0) col++;
        s.push(col);
        const span = c.colspan ?? 1;
        if ((c.rowspan ?? 1) > 1) for (let k = 0; k < span; k++) added.set(col + k, c.rowspan! - 1);
        col += span;
      }
      for (const [k, n] of covered) covered.set(k, n - 1);
      for (const [k, n] of added) covered.set(k, n);
      starts.push(s);
    }
    const ncol = Math.max(b.align.length, ...rows.map(({ r }, i) => r.reduce((m, c, j) => Math.max(m, starts[i]![j]! + (c.colspan ?? 1)), 0)), 1);
    const state = (head: boolean): InlineState => ({ ...blankState(t, size), bold: head && !b.plainHead });
    // Natural widths of single-span cells.
    const natural = new Array<number>(ncol).fill(0);
    rows.forEach(({ r, head }, i) => {
      r.forEach((c, j) => {
        const col = starts[i]![j]!;
        if ((c.colspan ?? 1) === 1) natural[col] = Math.max(natural[col]!, hpack(this.cellContent(c, state(head))).box.width);
      });
    });
    const available = env.width - 2 * sep * ncol;
    let widths = natural.map((w) => Math.max(w, size));
    const total = widths.reduce((a, w) => a + w, 0);
    let relative: number[] | null = null;
    if (b.widths?.some((w) => w)) {
      const given = b.widths.slice(0, ncol);
      // Columns without a width (tabularx's l beside an X) keep their natural width; the
      // sized ones share what is left when they would not fit beside them.
      const natTotal = given.reduce((a: number, w, k) => a + (w ? 0 : widths[k]!), 0);
      const relTotal = given.reduce((a: number, w) => a + (w ?? 0), 0) * available;
      const room = Math.max(available - natTotal, available * 0.25);
      const scale = given.some((w) => !w) && relTotal > room ? room / relTotal : 1;
      relative = given.map((w, k) => (w ? w * available * scale : widths[k]!));
      while (relative.length < ncol) relative.push(widths[relative.length]!);
    }
    if (relative) widths = relative;
    else if (total > available) {
      // Too wide: as a browser lays out an automatic table, each column first gets its longest
      // unbreakable word (a break may follow / or +), then the rest of the width is shared in
      // proportion to how much more each column would like.
      // The widest piece of a cell, measured as it is set (code, bold, math): broken at every
      // opportunity, each line's overflow past a near-zero width is the width of that piece.
      const least = new Array<number>(ncol).fill(0);
      let measured = 0;
      rows.forEach(({ r, head }, i) => {
        r.forEach((c, j) => {
          if ((c.colspan ?? 1) !== 1 || measured++ > 2000) return;
          const col = starts[i]![j]!;
          const pieces = breakParagraph(this.cellContent({ ...c, content: allowSlashBreaks(c.content) }, state(head)), { lineWidth: 0.01, raggedRight: true });
          const widest = Math.max(0, ...pieces.overfull.map((o) => o.amount));
          least[col] = Math.max(least[col]!, widest);
        });
      });
      const floor = least.map((w, k) => Math.min(widths[k]!, Math.max(w + 0.5, size)));
      const spare = available - floor.reduce((a, w) => a + w, 0);
      const want = widths.map((w, k) => w - floor[k]!);
      const wantTotal = want.reduce((a, w) => a + w, 0);
      widths = spare > 0 && wantTotal > 0 ? floor.map((w, k) => w + (spare * want[k]!) / wantTotal) : floor;
    }
    const tableWidth = widths.reduce((a, w) => a + w, 0) + 2 * sep * ncol;
    let overflowReported = false;
    const cellBox = (c: TableCell, head: boolean, col: number): HBox => {
      const span = c.colspan ?? 1;
      const width = widths.slice(col, col + span).reduce((a, w) => a + w, 0) + 2 * sep * (span - 1);
      const align = c.align ?? b.align[col] ?? null;
      const content = this.cellContent(c, state(head));
      const nat = hpack([...content]).box.width;
      if (nat <= width + 0.01) {
        const left = align === "right" || align === "center" ? [glue(0, 1, 0, FIL)] : [];
        const right = align === "left" || align === null || align === "center" ? [glue(0, 1, 0, FIL)] : [];
        return hpack([...left, ...content, ...right], { width }).box;
      }
      // Wrap: a top-aligned paragraph (LaTeX's p{} column).
      let res = breakParagraph(content, { lineWidth: width, raggedRight: true, emergencyStretch: width });
      if (res.overfull.some((o) => o.amount > 1)) {
        // In a narrow column "Markdown/LaTeX" and "Pandoc+LaTeX" may break after the / or +.
        const breakable = { ...c, content: allowSlashBreaks(c.content) };
        const again = breakParagraph(this.cellContent(breakable, state(head)), { lineWidth: width, raggedRight: true, emergencyStretch: width });
        if (again.overfull.filter((o) => o.amount > 1).length <= res.overfull.filter((o) => o.amount > 1).length) res = again;
      }
      // A word wider than its column runs into the next one; LAY001 says so, as for the margin.
      const worst = Math.max(0, ...res.overfull.map((o) => o.amount));
      if (worst > 1 && !overflowReported) {
        overflowReported = true;
        const text = plainText(c.content).trim();
        const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text;
        this.ctx.diagnostics.add("LAY001", `Text in a table cell ("${shown}") is ${worst.toFixed(1)}pt wider than its column and runs into the next one`, b.pos, {
          hint: "Shorten the word, allow a break in it (a space, or \\allowbreak after a slash), or give the column more width",
        });
      }
      const inner = new VListBuilder({ baselineSkip: size * 1.2, lineSkip: 1, lineSkipLimit: 0 });
      for (const l of res.lines) inner.box(l);
      const v = vpack(inner.list).box;
      const firstH = (v.children.find((x) => x.t === "hbox") as HBox | undefined)?.height ?? 0;
      return hpack([{ ...v, height: firstH, depth: v.height + v.depth - firstH }], { width }).box;
    };
    const rowBox = (r: TableCell[], head: boolean, at: number[]): HBox => {
      const children: HNode[] = [];
      let col = 0;
      r.forEach((c, j) => {
        // Columns covered by a cell from a row above stay empty.
        for (; col < at[j]!; col++) children.push(kern(widths[col]! + 2 * sep));
        const cell = cellBox(c, head, col);
        const down = c.rowspan && c.rowspan > 1 ? ((c.rowspan - 1) / 2) * size * 1.25 : 0;
        if (down) {
          // \multirow: centred across the rows it spans, one baseline apart. Its height and
          // depth are moved with it so the row itself keeps its size.
          cell.shift = down;
          cell.height += down;
          cell.depth -= down;
        }
        children.push(kern(sep), cell, kern(sep));
        col += c.colspan ?? 1;
      });
      const box = hpack(children, { width: tableWidth }).box;
      box.height = Math.max(box.height, size * 0.75);
      box.depth = Math.max(box.depth, size * 0.3);
      return box;
    };
    const rule = (thick: number): Rule => ({ t: "rule", height: thick, depth: 0, color: t.ruleColor });
    const tv = new VListBuilder({ baselineSkip: size * 1.25, lineSkip: 2, lineSkipLimit: 0 });
    const isArticle = t.name === "article";
    tv.rule(rule(isArticle ? 0.88 : 0.6));
    tv.kern(size * 0.3);
    const ruled = new Set((b.rules ?? []).map((i) => i + b.head.length));
    rows.forEach(({ r, head }, k) => {
      if (ruled.has(k)) {
        tv.kern(size * 0.2);
        tv.rule(rule(isArticle ? 0.4 : 0.5));
        tv.kern(size * 0.4);
      }
      tv.box(rowBox(r, head, starts[k]!));
      const next = rows[k + 1];
      if (head && next && !next.head) {
        tv.kern(size * 0.3);
        tv.rule(rule(isArticle ? 0.55 : 0.8));
        tv.kern(size * 0.3);
      }
    });
    tv.kern(size * 0.35);
    tv.rule(rule(isArticle ? 0.88 : 0.6));
    const tableBox = vpack(tv.list).box;
    const centered = hpack([glue(0, 1, 0, FIL), tableBox, glue(0, 1, 0, FIL)], { width: env.width }).box;
    if (b.caption?.length) {
      // A captioned table floats, like LaTeX's table environment: caption and rules stay together, and a
      // table that does not fit where it is written goes to the top of the next page.
      const inner = new VListBuilder({ baselineSkip: t.captionSize * 1.25, lineSkip: 1, lineSkipLimit: 0 });
      if (b.id) inner.mark({ t: "anchor", id: b.id });
      const label: Inline[] = b.number ? [{ t: "Text", text: `Table\u00a0${b.number}: ` }] : [];
      const capWidth = env.width * 0.9;
      inner.paragraph(this.paragraphLines([...label, ...b.caption], blankState(t, t.captionSize), { width: capWidth, shift: (env.width - capWidth) / 2 }, { indent: 0, align: "center" }));
      inner.glue(5);
      inner.noInterline();
      inner.box(centered);
      vb.mark({ t: "float", content: vpack(inner.list).box, placement: "here" });
      return;
    }
    this.vspace(vb, glue(10, 3, 2));
    if (b.id) vb.mark({ t: "anchor", id: b.id });
    vb.noInterline();
    vb.box(this.shifted(centered, env));
    this.vspace(vb, glue(10, 3, 2));
    this.afterHeading = true;
  }

  // ---------------------------------------------------------------- figures and images

  private image(i: Extract<Inline, { t: "Image" }>, maxWidth: number): HNode | undefined {
    const key = `${i.src}|${i.width ?? ""}|${i.height ?? ""}|${maxWidth}`;
    const cached = this.ctx.imageCache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const box = this.loadImage(i, maxWidth);
    this.ctx.imageCache.set(key, box ?? null);
    return box;
  }

  private dimension(spec: string | undefined, relativeTo: number): number | undefined {
    if (!spec) return undefined;
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(spec.trim());
    if (pct) return (Number(pct[1]) / 100) * relativeTo;
    const m = /^(\d+(?:\.\d+)?)(px|pt|cm|mm|in|em)?$/.exec(spec.trim());
    if (!m) return undefined;
    const v = Number(m[1]);
    const unit = m[2] ?? "px";
    return unit === "pt" ? v : unit === "cm" ? (v * 72) / 2.54 : unit === "mm" ? (v * 72) / 25.4 : unit === "in" ? v * 72 : unit === "em" ? v * this.ctx.theme.size : v * 0.75;
  }

  private loadImage(i: Extract<Inline, { t: "Image" }>, maxWidth: number): HNode | undefined {
    const d = this.ctx.diagnostics;
    const res = resolveImage(i.src, this.ctx.images, d, i.pos);
    let bytes: Uint8Array | undefined;
    let mime = res.mime;
    if (/^data:/i.test(i.src)) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(i.src);
      try {
        if (m) {
          mime = m[1]!.toLowerCase();
          bytes = m[2] ? new Uint8Array(Buffer.from(m[3]!, "base64")) : new TextEncoder().encode(decodeURIComponent(m[3]!));
        }
      } catch {
        bytes = undefined;
      }
      if (!bytes) d.add("IMG001", "A data: image URL could not be decoded", i.pos);
    } else if (res.path) {
      try {
        bytes = new Uint8Array(readFileSync(res.path));
      } catch (e) {
        d.add("IMG001", `Image ${i.src} could not be read: ${(e as Error).message}`, i.pos);
      }
    } else if (/^https?:/i.test(i.src) && !res.blocked) {
      d.add("IMG003", `Remote image ${i.src} is not downloaded by the PDF engine`, i.pos, { hint: "Save the image next to the document and refer to the local file" });
    }
    if (!bytes) return this.missingImage(i, maxWidth);
    const wantW = this.dimension(i.width, maxWidth);
    const wantH = this.dimension(i.height, maxWidth);
    if (mime === "image/svg+xml") return this.svgImage(new TextDecoder().decode(bytes), res.path, i, wantW, wantH, maxWidth);
    if (mime === "application/pdf") {
      d.add("IMG003", `PDF figure ${i.src} can't be embedded by the native engine yet`, i.pos, { hint: "Export the figure as SVG (vector) or PNG" });
      return this.missingImage(i, maxWidth);
    }
    try {
      const ref = this.ctx.writer.addImage(bytes);
      let w = wantW ?? ref.pixelWidth * 0.75;
      let h = wantH ?? (w * ref.pixelHeight) / ref.pixelWidth;
      if (wantH && !wantW) w = (h * ref.pixelWidth) / ref.pixelHeight;
      if (w > maxWidth) {
        h = (h * maxWidth) / w;
        w = maxWidth;
      }
      const maxHeight = this.maxImageHeight();
      if (h > maxHeight) {
        w = (w * maxHeight) / h;
        h = maxHeight;
      }
      return { t: "image", image: ref, width: w, height: h, depth: 0 };
    } catch (e) {
      d.add("IMG001", `Image ${i.src} could not be read: ${(e as Error).message}`, i.pos);
      return this.missingImage(i, maxWidth);
    }
  }

  /** An SVG figure drawn as vectors. Images inside it obey the same folder rules, relative to the SVG file. */
  private svgImage(text: string, path: string | undefined, i: Extract<Inline, { t: "Image" }>, wantW: number | undefined, wantH: number | undefined, maxWidth: number): HNode {
    const d = this.ctx.diagnostics;
    const policy: ImagePolicy = path ? { ...this.ctx.images, baseDir: dirname(path) } : this.ctx.images;
    // Cached unless it refers to image files, which are registered with this document's writer.
    let external = false;
    const resolve = (href: string) => {
      external = true;
      const r = resolveImage(href, policy, d, i.pos);
      if (!r.path || r.mime === "image/svg+xml" || r.mime === "application/pdf") return undefined;
      try {
        return this.ctx.writer.addImage(new Uint8Array(readFileSync(r.path)));
      } catch {
        return undefined;
      }
    };
    const draw = (widthPt?: number, heightPt?: number) => svgToDrawing(text, { widthPt, heightPt, resolveImage: resolve, diagnostics: d, pos: i.pos });
    const key = keyOf(`${path ?? ""}\u0001${wantW ?? ""}\u0001${wantH ?? ""}\u0001${maxWidth}\u0001${this.maxImageHeight()}\u0001${i.pos?.col ?? ""}\u0001${text}`);
    const drawing = this.cached(
      svgCache,
      key,
      i.pos,
      () => {
        let dr = wantW || wantH ? draw(wantW && Math.min(wantW, maxWidth), wantH) : draw();
        // Too wide for the text, or too tall for the page with room for a caption: drawn again once,
        // at the largest size that fits both.
        const tall = dr.height + dr.depth;
        const fit = Math.min(1, maxWidth / dr.width, tall > 0 ? this.maxImageHeight() / tall : 1);
        if (fit < 0.9999 && dr.width > 0) dr = draw(dr.width * fit);
        return dr;
      },
      () => !external,
    );
    // data: images inside the SVG arrive decoded (filters arrive as images too); register them
    // with the writer, and leave out any it cannot read.
    const register = (ops: DrawOp[]): DrawOp[] =>
      ops.filter((op) => {
        if (op.op === "group") {
          op.ops = register(op.ops);
          if (op.mask) op.mask.ops = register(op.mask.ops);
        } else if (op.op === "image" && isEmbeddedImage(op.image)) {
          try {
            op.image = this.ctx.writer.addImage(op.image.bytes);
          } catch {
            d.add("IMG001", "An image inside an SVG figure could not be decoded", i.pos);
            return false;
          }
        }
        return true;
      });
    drawing.ops = register(drawing.ops);
    return drawing;
  }

  /** The tallest an image may be: the text area less room for a caption. */
  private maxImageHeight(): number {
    return this.ctx.geometry.textHeight * 0.85;
  }

  private missingImage(i: Extract<Inline, { t: "Image" }>, maxWidth: number): HNode {
    const t = this.ctx.theme;
    const out: HNode[] = [];
    this.text(`[image: ${i.src}]`, { ...blankState(t, t.smallSize), color: [0.69, 0, 0.13] }, out);
    const box = hpack(out).box;
    return box.width > maxWidth ? hpack(out, { width: maxWidth }).box : box;
  }

  private figure(b: Extract<Block, { t: "Figure" }>, vb: VListBuilder, env: Env): void {
    const fig = this.figureBox(b, env.width, false);
    vb.mark({ t: "float", content: fig, placement: "here" });
    this.afterHeading = false;
  }

  private figureBox(b: Extract<Block, { t: "Figure" }>, width: number, sub: boolean): VBox {
    const t = this.ctx.theme;
    const inner = new VListBuilder({ baselineSkip: t.captionSize * 1.25, lineSkip: 1, lineSkipLimit: 0 });
    if (b.id) inner.mark({ t: "anchor", id: b.id });
    // An algorithm float: caption on top between rules, as in the algorithm package's ruled style.
    const algorithm = b.attr?.classes?.includes("algorithm") ?? false;
    const rule = () => inner.box(hpack([{ t: "rule", width, height: 0.4, depth: 0, color: t.ruleColor }], { width }).box);
    if (algorithm) {
      rule();
      inner.glue(2);
      const label: Inline[] = [{ t: "Strong", content: [{ t: "Text", text: b.number ? `Algorithm ${b.number}` : "Algorithm" }] }, { t: "Text", text: " " }];
      inner.paragraph(this.paragraphLines([...label, ...(b.caption ?? [])], blankState(t, this.bodySize()), { width, shift: 0 }, { indent: 0, align: "ragged" }));
      inner.glue(2);
      rule();
      inner.glue(3);
    }
    const subs = b.content.filter((c): c is Extract<Block, { t: "Figure" }> => c.t === "Figure");
    if (subs.length) {
      const gap = 12;
      const each = (width - gap * (subs.length - 1)) / subs.length;
      const row: HNode[] = [glue(0, 1, 0, FIL)];
      subs.forEach((s, k) => {
        if (k) row.push(kern(gap));
        const box = this.figureBox(s, each, true);
        const fh = (box.children.find((x) => x.t === "hbox") as HBox | undefined)?.height ?? 0;
        row.push({ ...box, height: fh, depth: box.height + box.depth - fh });
      });
      row.push(glue(0, 1, 0, FIL));
      inner.box(hpack(row, { width }).box);
    } else {
      for (const c of b.content) {
        if (c.t !== "Plain" && c.t !== "Para") {
          this.block(c, inner, { width, shift: 0 });
          continue;
        }
        const parts: HNode[] = [glue(0, 1, 0, FIL)];
        for (const inl of c.content) {
          if (inl.t === "Image") {
            const img = this.image(inl, width);
            if (img) parts.push(img);
          } else if (inl.t !== "SoftBreak" && !(inl.t === "Text" && !inl.text.trim())) {
            this.inline(inl, blankState(t), parts);
          }
        }
        parts.push(glue(0, 1, 0, FIL));
        inner.box(hpack(parts, { width }).box);
      }
    }
    if (algorithm) {
      inner.glue(3);
      rule();
    }
    if (b.caption?.length && !algorithm) {
      inner.glue(sub ? 3 : 7);
      let label: Inline[] = [];
      if (b.number) label = sub ? [{ t: "Text", text: `(${b.number.replace(/^\d+(\.\d+)*/, "")}) ` }] : [{ t: "Text", text: `Figure ${b.number}: ` }];
      const capWidth = sub ? width : width * 0.9;
      const res = this.paragraphLines([...label, ...b.caption], blankState(t, t.captionSize), { width: capWidth, shift: (width - capWidth) / 2 }, { indent: 0, align: "center" });
      inner.paragraph(res);
    }
    return vpack(inner.list).box;
  }

  // ---------------------------------------------------------------- divs, theorems

  private div(b: Extract<Block, { t: "Div" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const classes = b.attr.classes ?? [];
    const kind = classes.find((c) => ADMONITIONS.has(c));
    if (b.attr.id) vb.mark({ t: "anchor", id: b.attr.id });
    if (classes.includes("algorithmic")) {
      this.algorithmic(b, vb, env);
      return;
    }
    if (classes.includes("hrule")) {
      vb.glue(glue(2, 1));
      vb.box(this.shifted(hpack([{ t: "rule", width: env.width, height: 0.4, depth: 0 }], { width: env.width }).box, env));
      vb.glue(glue(2, 1));
      return;
    }
    if (classes.includes("letter")) {
      // The letter class: paragraphs unindented, with space between them.
      const saved = this.blockParagraphs;
      this.blockParagraphs = true;
      this.blocks(b.blocks, vb, env);
      this.blockParagraphs = saved;
      return;
    }
    if (classes.includes("letter-from") || classes.includes("letter-closing")) {
      // The letter class sets the return address, date, closing and signature in the right half.
      if (classes.includes("letter-closing")) vb.glue(t.parSkip.width + 6);
      this.blocks(b.blocks, vb, { width: env.width / 2, shift: env.shift + env.width / 2 });
      vb.glue(classes.includes("letter-from") ? 18 : 6);
      return;
    }
    if (classes.includes("letter-to")) {
      this.blocks(b.blocks, vb, env);
      vb.glue(12);
      return;
    }
    const align = classes.includes("center") ? "center" : classes.includes("flushright") ? "right" : classes.includes("flushleft") ? "ragged" : undefined;
    if (align && !kind) {
      const saved = this.blockAlign;
      this.blockAlign = align;
      this.blocks(b.blocks, vb, env);
      this.blockAlign = saved;
      return;
    }
    if (!kind) {
      this.blocks(b.blocks, vb, env);
      return;
    }
    const pad = 8;
    const innerEnv: Env = { width: env.width - 2 * pad - 2, shift: 0 };
    const inner = new VListBuilder({ baselineSkip: t.baselineSkip, lineSkip: 1, lineSkipLimit: 0 });
    const title = b.attr.attrs?.title ?? kind.charAt(0).toUpperCase() + kind.slice(1);
    if (title) inner.paragraph(this.paragraphLines([{ t: "Text", text: title }], { ...blankState(t), bold: true }, innerEnv, { indent: 0, align: "ragged" }));
    this.blocks(b.blocks, inner, innerEnv, { noIndentFirst: true });
    const content = vpack(inner.list).box;
    const warn = kind === "warning" || kind === "caution" || kind === "danger";
    // A tcolorbox brings its own colours (colback, colframe).
    const hex = (h: string | undefined): Color | undefined => (h && /^#[0-9a-f]{6}$/i.test(h) ? ([1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as Color) : undefined);
    const bg: Color = hex(b.attr.attrs?.background) ?? (warn ? [0.984, 0.937, 0.914] : kind === "tip" ? [0.929, 0.965, 0.937] : t.calloutBackground);
    const accent: Color = hex(b.attr.attrs?.frame) ?? (warn ? [0.702, 0.329, 0.18] : kind === "tip" ? [0.247, 0.541, 0.333] : t.calloutRule);
    const h = content.height + pad;
    const dp = content.depth + pad;
    const box = hpack(
      [
        { t: "rule", width: env.width, height: h, depth: dp, color: bg },
        kern(-env.width),
        { t: "rule", width: 2, height: h, depth: dp, color: accent },
        kern(pad),
        content,
        glue(0, 1, 0, FIL),
      ],
      { width: env.width },
    ).box;
    this.vspace(vb, glue(10, 3, 2));
    vb.noInterline();
    vb.box(this.shifted(box, env));
    vb.prevDepth = dp;
    this.vspace(vb, glue(10, 3, 2));
    this.afterHeading = true;
  }

  /** Pseudocode: one line per Div, indented by depth, numbered every n lines when asked. */
  private algorithmic(b: Extract<Block, { t: "Div" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const size = this.bodySize();
    const every = Number(b.attr.attrs?.numbered ?? 0);
    const numWidth = every ? size * 2 : 0;
    const state = blankState(t, size);
    let n = 0;
    for (const line of b.blocks) {
      if (line.t !== "Div") {
        this.block(line, vb, env);
        continue;
      }
      const indent = numWidth + Number(line.attr.attrs?.level ?? 0) * size * 1.5;
      const content = line.blocks.flatMap((x) => (x.t === "Plain" || x.t === "Para" ? x.content : []));
      const prefix: HNode[] = [];
      if (every && !line.attr.classes?.includes("alg-nonum")) {
        n++;
        const label = n % every === 0 ? `${n}:` : "";
        prefix.push(kern(-indent), hpack([glue(0, 1, 0, FIL), ...shapeText(label, this.style(blankState(t, size * 0.8))), kern(size * 0.6)], { width: numWidth }).box, kern(indent - numWidth));
      }
      vb.paragraph(this.paragraphLines(content, state, { width: env.width - indent, shift: env.shift + indent }, { indent: 0, align: "ragged", prefix }));
    }
  }

  private theorem(b: Extract<Block, { t: "Theorem" }>, vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const isProof = b.kind === "proof";
    const italicBody = ITALIC_THEOREMS.has(b.kind) || ITALIC_THEOREMS.has(b.counter ?? "");
    const name = b.name ?? b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
    const head: Inline[] = [];
    const headText = `${name}${b.number ? ` ${b.number}` : ""}`;
    head.push(isProof ? { t: "Emph", content: [{ t: "Text", text: headText }] } : { t: "Strong", content: [{ t: "Text", text: headText }] });
    if (b.title?.length) head.push({ t: "Text", text: " (" }, ...b.title, { t: "Text", text: ")" });
    head.push({ t: "Text", text: ". " });
    this.vspace(vb, glue(8, 3, 2));
    if (b.id) vb.mark({ t: "anchor", id: b.id });
    const blocks = [...b.blocks];
    const bodyState: Partial<InlineState> = { italic: italicBody };
    const qed: HNode[] = isProof && !hasQedHere(b.blocks)
      ? [penalty(INF_PENALTY), glue(0, 1, 0, FILL), ...shapeText("□", this.style(blankState(t))), { t: "hbox", width: 0, height: 0, depth: 0, children: [] }]
      : [];
    const first = blocks[0];
    if (first && (first.t === "Para" || first.t === "Plain")) {
      blocks.shift();
      const headNodes: HNode[] = [];
      this.inlines(head, blankState(t), headNodes);
      const lastIsFirst = blocks.length === 0;
      vb.paragraph(
        this.paragraphLines(first.content, { ...blankState(t, this.bodySize()), ...bodyState }, env, { indent: 0, prefix: headNodes, tail: lastIsFirst ? qed : undefined }, first.pos),
        { clubPenalty: 150, widowPenalty: 150 },
      );
    } else {
      vb.paragraph(this.paragraphLines(head, blankState(t), env, { indent: 0 }));
    }
    blocks.forEach((blk, k) => {
      const last = k === blocks.length - 1;
      if (last && isProof && (blk.t === "Para" || blk.t === "Plain")) {
        vb.glue(glue(t.parSkip.width, t.parSkip.stretch));
        vb.paragraph(this.paragraphLines(blk.content, { ...blankState(t, this.bodySize()), ...bodyState }, env, { indent: t.parIndent, tail: qed }, blk.pos));
      } else {
        this.block(blk, vb, env, bodyState);
        // A proof ending in a display or a list: the box goes flush right on a line of its own.
        if (last && qed.length) vb.paragraph(this.paragraphLines([], blankState(t, this.bodySize()), env, { indent: 0, tail: qed }));
      }
    });
    this.vspace(vb, glue(8, 3, 2));
    this.afterHeading = true;
  }

  // ---------------------------------------------------------------- contents, bibliography

  private toc(vb: VListBuilder, env: Env): void {
    const t = this.ctx.theme;
    const doc = this.ctx.doc;
    const depth = doc.meta.tocDepth ?? 3;
    let top = 6;
    for (const b of doc.blocks) if (b.t === "Heading") top = Math.min(top, b.level);
    const titleState: InlineState = { ...blankState(t, t.headingSize[0]!), bold: true, sans: t.bodySans, color: t.headingColor };
    this.vspace(vb, glue(4, 2));
    vb.paragraph(this.paragraphLines([{ t: "Text", text: "Contents" }], titleState, env, { indent: 0, align: "ragged" }));
    vb.penalty(INF_PENALTY);
    vb.glue(8);
    const dot = hpack([glue(0, 1, 0, FIL), ...shapeText(".", this.style(blankState(t))), glue(0, 1, 0, FIL)], { width: t.size * 0.45 }).box;
    const entries = doc.blocks.filter(
      (b): b is Extract<Block, { t: "Heading" }> => b.t === "Heading" && b.level - top < depth && !(b.attr?.classes ?? []).includes("unlisted"),
    );
    entries.forEach((b, k) => {
      // Club and widow lines: the contents never leaves a single entry alone at either end of a page.
      if (k === 1 || (k > 0 && k === entries.length - 1)) vb.penalty(INF_PENALTY);
      const level = b.level - top;
      const state: InlineState = { ...blankState(t), bold: level === 0 };
      const numWidth = [t.size * 1.5, t.size * 2.3, t.size * 3.2][Math.min(level, 2)]!;
      const indent = [0, t.size * 1.5, t.size * 3.8][Math.min(level, 2)]!;
      const page = b.id ? this.ctx.pages?.get(b.id)?.page : undefined;
      const pageNodes = shapeText(page !== undefined ? String(page) : "000", this.style(state));
      const pageBox = hpack([glue(0, 1, 0, FIL), ...pageNodes], { width: t.size * 1.8 }).box;
      const numBox = hpack(b.number ? shapeText(b.number, this.style(state)) : [], { width: numWidth }).box;
      const leader: Glue = { ...glue(t.size, 1, 0, FILL), leader: level === 0 ? undefined : dot };
      const prefix: HNode[] = [];
      if (b.id) prefix.push({ t: "link-start", target: { dest: b.id } });
      prefix.push(numBox);
      const tail: HNode[] = [leader, pageBox];
      if (b.id) tail.push({ t: "link-end" });
      if (level === 0) vb.glue(glue(5, 1));
      const res = this.paragraphLines(b.content, state, { width: env.width - indent, shift: env.shift + indent }, { indent: 0, align: "ragged", prefix, tail, hanging: numWidth });
      vb.paragraph(res);
    });
    this.vspace(vb, glue(16, 4));
    this.afterHeading = false;
  }

  private bibliography(vb: VListBuilder, env: Env, addHeading: boolean): void {
    if (this.bibliographyWritten) return;
    this.bibliographyWritten = true;
    const t = this.ctx.theme;
    const items = this.ctx.citations.bibliography;
    if (!items.length) return;
    const extra = this.ctx.doc.meta.extra?.["reference-section-title"];
    const title = typeof extra === "string" ? extra : "References";
    const blocks = this.ctx.doc.blocks;
    const at = blocks.findIndex((b) => b.t === "Bibliography");
    const preceded = at > 0 && blocks[at - 1]!.t === "Heading";
    if (addHeading || !preceded) {
      this.heading({ t: "Heading", level: 1, content: [{ t: "Text", text: title }], numbered: false, id: "references" }, vb, env);
    }
    const size = this.ctx.theme.name === "article" ? t.size * 0.91 : t.smallSize;
    const numeric = items.some((i) => i.label);
    const labelWidth = numeric ? size * (items.length >= 10 ? 2.6 : 2.1) : 0;
    const state = blankState(t, size);
    for (const it of items) {
      vb.glue(glue(size * 0.35, 1));
      const prefix: HNode[] = [{ t: "anchor", id: it.id }];
      if (numeric && it.label) {
        prefix.push(kern(-labelWidth), hpack(shapeText(it.label, this.style(state)), { width: labelWidth }).box);
        vb.paragraph(this.paragraphLines(it.content, state, { width: env.width - labelWidth, shift: env.shift + labelWidth }, { indent: 0, prefix, align: "ragged" }));
      } else {
        vb.paragraph(this.paragraphLines(it.content, state, env, { indent: 0, prefix, hanging: size * 1.6, align: "ragged" }));
      }
    }
    this.afterHeading = false;
  }
}

/** LaTeX's size switches relative to the body size (its 10pt class: \large is 12pt, \Huge 24.88pt). */
const SIZE_FACTORS: Record<string, number> = { tiny: 0.5, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, large: 1.2, Large: 1.44, LARGE: 1.728, huge: 2.074, Huge: 2.488 };

/** Anchor at the end of the document; its page is the page count. */
const LAST_PAGE = "tw-last-page";

/** A cached value with the diagnostics it raised and the source line it was computed at. */
interface CacheEntry<T> {
  value: T;
  events: CacheEvent[];
  line?: number;
}

/** Formulas that may define macros: their effect on the macro table is not cached. */
const MAY_DEFINE = /command|Declare|\\def|\\let/;

// Sizes are in copied objects (about 100 bytes each): some 100 MB in all at the very most.
const shapeCache = new Lru<CacheEntry<HNode[]>>("shape", 30_000, 300_000);
const paragraphCache = new Lru<CacheEntry<LineBreakResult>>("paragraph", 10_000, 500_000);
const mathCache = new Lru<CacheEntry<MathResult>>("math", 5_000, 200_000);
const svgCache = new Lru<CacheEntry<Drawing>>("svg", 128, 300_000);
const tokenCache = new Lru<Token[]>("highlight", 500, 100_000);

/** Highlighted code, cached by language and text. */
function highlighted(text: string, lang: string): Token[] {
  const key = keyOf(`${lang}\u0001${text}`);
  let tokens = tokenCache.get(key);
  if (!tokens) {
    tokens = tokenize(text, lang);
    tokenCache.set(key, tokens, tokens.length + 1);
  }
  return tokens;
}

export type { Env };

let english: Hyphenator | undefined;

/** TeX's US English patterns, loaded once (left and right minimums 2 and 3, as in plain TeX). */
function englishHyphenator(): Hyphenator {
  english ??= loadHyphenator("en-us", { leftMin: 2, rightMin: 3 });
  return english;
}

/** Text with a break opportunity (a zero-width space) after each / and + inside a word. */
function allowSlashBreaks(content: Inline[]): Inline[] {
  return content.map((i): Inline => {
    if (i.t === "Text") return { ...i, text: i.text.replace(/([/+])(?=[^\s/+])/g, "$1\u200b") };
    if ((i.t === "Emph" || i.t === "Strong" || i.t === "Span" || i.t === "Underline" || i.t === "SmallCaps") && "content" in i) return { ...i, content: allowSlashBreaks(i.content) } as Inline;
    return i;
  });
}

/** How far a set box's content runs past `limit` (the column): an overfull row, or a row wider than the column. */
function overflowOf(box: HBox | VBox, limit: number): number {
  if (box.t === "vbox") return Math.max(0, ...box.children.map((c) => (c.t === "hbox" || c.t === "vbox" ? overflowOf(c, limit) : 0)));
  const natural = hpack([...box.children]).box.width;
  return Math.max(0, Math.max(natural, box.width) - limit);
}
