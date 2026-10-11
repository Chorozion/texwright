/**
 * The native PDF writer: typesets the document, breaks it into pages until
 * page references settle, and serializes the result. No browser involved.
 */

import { type Document, type Inline, plainText } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import { type AnchorInfo, type HNode, type Page, type PageMarks, type ShipOptions, buildPages, glue, hpack, kern, layoutUntilStable, shapeText, shipout } from "../layout/index.js";
import type { HBox } from "../layout/types.js";
import type { PdfDocumentWriter } from "../pdf/api.js";
import { createPdfWriter } from "../pdf/writer.js";
import type { Numbering } from "../transform/numbering.js";
import type { ImagePolicy } from "../write/assets.js";
import type { CitationOutput } from "../write/html.js";
import { withDocumentFonts } from "./brandfonts.js";
import { type InlineState, type Theme, geometry, lengthPt, textStyle, theme as loadTheme } from "./style.js";
import { parseMicrotype } from "../layout/microtype.js";
import { Typesetter } from "./typesetter.js";
import { lintLayout } from "../lint.js";

export { PAPER, geometry, lengthPt, theme } from "./style.js";
export { Typesetter } from "./typesetter.js";

export interface PdfLayoutOptions {
  theme: string;
  paper: string;
  landscape: boolean;
  margin: string;
  pageNumbers?: "center" | "right" | "none";
  /** Text at the top right of every page (running head). */
  header?: string;
  /** Text at the bottom left of every page. */
  footer?: string;
  images: ImagePolicy;
  /** Upper bound on layout passes while page references settle. */
  maxPasses?: number;
  /** Body size in points; the theme scales to it. */
  fontSize?: number;
}

export interface PdfInput {
  doc: Document;
  numbering: Numbering;
  citations: CitationOutput;
  macros: Record<string, string>;
  diagnostics: Diagnostics;
}

export interface PdfResult {
  bytes: Uint8Array;
  pageCount: number;
  passes: number;
  /** Where every anchor (heading, figure, table, equation id) landed. */
  anchors: ReadonlyMap<string, AnchorInfo>;
}

/** The document's own paragraph indent and spacing (\setlength{\parindent}{0pt}, front matter `parindent`), over the theme's. */
function paragraphShape(t: Theme, extra: Record<string, unknown> | undefined): Theme {
  const len = (v: unknown): number => {
    if (typeof v !== "string" && typeof v !== "number") return Number.NaN;
    const s = String(v).trim();
    const em = /^(-?\d*\.?\d+)\s*(em|ex)$/.exec(s);
    if (em) return Number(em[1]) * t.size * (em[2] === "ex" ? 0.43 : 1);
    return /^-?\d*\.?\d+$/.test(s) && Number(s) === 0 ? 0 : lengthPt(s, Number.NaN);
  };
  const indent = len(extra?.parindent);
  const skip = len(extra?.parskip);
  let out = t;
  if (Number.isFinite(indent) && indent >= 0 && indent < 200) out = { ...out, parIndent: indent };
  if (Number.isFinite(skip) && skip >= 0 && skip < 100) out = { ...out, parSkip: { ...out.parSkip, width: skip } };
  return out;
}

/** The document's microtype setting (front matter `microtype`, LaTeX's microtype options) over the theme's; unusable values are OPT001 in layoutopts.ts. */
function withMicrotype(t: Theme, extra: Record<string, unknown> | undefined): Theme {
  if (extra?.microtype === undefined) return t;
  const m = parseMicrotype(extra.microtype, t.microtype);
  return m === undefined ? t : { ...t, microtype: m };
}

/** No pages known yet (the first layout pass), noting whether anything asked for one. */
class PageProbe extends Map<string, AnchorInfo> {
  constructor(private readonly onRead: () => void) {
    super();
  }

  override get(key: string): AnchorInfo | undefined {
    this.onRead();
    return super.get(key);
  }
}

/** Fixed creation date for reproducible builds (SOURCE_DATE_EPOCH, in seconds), else now. */
function buildDate(): Date {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
}

/** Pages laid out until their page references settle, ready to ship to a writer. */
export interface LaidOutPages {
  pages: Page[];
  /** Layout passes it took. */
  passes: number;
  /** Page size and margins for shipout(). */
  ship: ShipOptions;
  /** Where every anchor landed. */
  anchors: ReadonlyMap<string, AnchorInfo>;
}

/**
 * Typesets the document and breaks it into pages, repeating until page
 * references settle; layout problems go to the diagnostics. Images are
 * registered with `writer`, which the pages must then be shipped to.
 */
export function layoutPages(input: PdfInput, o: PdfLayoutOptions, writer: PdfDocumentWriter): LaidOutPages {
  const { doc, diagnostics } = input;
  const t = withMicrotype(paragraphShape(withDocumentFonts(loadTheme(o.theme, o.fontSize), doc.meta.extra, o.images, diagnostics), doc.meta.extra), doc.meta.extra);
  const g = geometry(o.paper, o.landscape, o.margin);
  const imageCache = new Map<string, HNode | null>();
  const small: InlineState = { bold: false, italic: false, mono: false, sans: false, size: t.smallSize, smallCaps: false };
  const muted: InlineState = { ...small, color: [0.4, 0.4, 0.4] };
  const pageNumbers = o.pageNumbers ?? t.pageNumbers;

  const line = (text: string, state: InlineState): HNode[] => shapeText(text, textStyle(t, state));
  const full = (children: HNode[]): HBox => hpack(children, { width: g.textWidth }).box;

  const header = o.header
    ? (): HBox => full([glue(0, 1, 0, 1), ...line(o.header!, muted)])
    : undefined;
  const footer = (n: number, _marks: PageMarks): HBox | undefined => {
    const left = o.footer ? hpack(line(o.footer, muted)).box : undefined;
    if (pageNumbers === "none" && !left) return undefined;
    const num = pageNumbers === "none" ? [] : line(String(n), { ...small, size: t.size });
    const children: HNode[] = [];
    if (left) children.push(left, kern(-left.width));
    if (pageNumbers === "center") children.push(glue(0, 1, 0, 1), ...num, glue(0, 1, 0, 1));
    else children.push(glue(0, 1, 0, 1), ...num);
    return full(children);
  };

  // A first pass that never looked up a page number (no \pageref, contents or page count) would be
  // typeset the same again: the second pass reuses it, so such documents are laid out once.
  let first: ReturnType<typeof buildPages> | undefined;
  let pagesRead = false;
  const build = (known: ReadonlyMap<string, AnchorInfo> | undefined, pass: number) => {
    if (pass === 2 && first && !pagesRead) return first;
    const pages = pass === 1 ? new PageProbe(() => (pagesRead = true)) : known;
    const ts = new Typesetter({
      doc,
      numbering: input.numbering,
      citations: input.citations,
      macros: input.macros,
      diagnostics,
      theme: t,
      geometry: g,
      images: o.images,
      writer,
      pages,
      imageCache,
    });
    const result = buildPages(ts.document(), {
      textHeight: g.textHeight,
      textWidth: g.textWidth,
      topSkip: t.size,
      maxDepth: t.size * 0.45,
      raggedBottom: true,
      footnotes: { ruleColor: t.ruleColor, baselineSkip: t.footnoteSize * 1.22, lineSkip: 1, lineSkipLimit: 0 },
      header,
      footer,
      headerSep: 25,
      footerSep: 30,
    });
    if (pass === 1) first = result;
    return result;
  };

  const { result, passes, stable } = layoutUntilStable(build, o.maxPasses ?? 4);
  if (!stable) diagnostics.add("PDF002", `Page numbers still changed after ${passes} layout passes`, undefined, { hint: "References near page breaks can flip between two pages; rewording nearby text usually settles them" });
  for (const p of result.overfull) {
    if (p.amount > 1) diagnostics.add("LAY001", `Page ${p.page} is ${p.amount.toFixed(1)}pt taller than the text area`, undefined, { hint: "Something that cannot be split (a table, figure or formula) is taller than a page" });
  }
  for (const w of result.warnings) diagnostics.add("LAY001", w);
  lintLayout(result.pages, result.anchors, input.doc, g.textWidth, diagnostics);
  return {
    pages: result.pages,
    passes,
    ship: { pageWidth: g.pageWidth, pageHeight: g.pageHeight, margins: { top: g.top, left: g.left, right: g.right, bottom: g.bottom } },
    anchors: result.anchors,
  };
}

export function typesetPdf(input: PdfInput, o: PdfLayoutOptions): PdfResult {
  const { doc, diagnostics } = input;
  const writer = createPdfWriter();
  const { pages, passes, ship, anchors } = layoutPages(input, o, writer);
  shipout(writer, pages, ship);
  const m = doc.meta;
  writer.setInfo({
    title: m.title ? plainText(m.title) : undefined,
    author: m.author?.length ? m.author.map((a: Inline[]) => plainText(a)).join(", ") : undefined,
    keywords: m.keywords?.join(", "),
    subject: m.subtitle ? plainText(m.subtitle) : undefined,
    lang: m.lang,
    creator: "texwright",
    date: buildDate(),
  });
  const bytes = writer.finish();
  for (const w of writer.warnings) diagnostics.add("PDF003", w);
  return { bytes, pageCount: pages.length, passes, anchors };
}
