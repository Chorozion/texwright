/**
 * texwright library API.
 *
 *   const result = await convert({ input: "paper.md", to: "pdf", output: "paper.pdf" });
 *   if (!result.ok) console.error(result.diagnostics);
 *
 * Every function returns diagnostics instead of throwing for problems in the
 * document. Exceptions are reserved for programming errors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { type Document, type Inline, type Meta, type Pos, emptyDocument, plainText, walkBlocks } from "./ast.js";
import { type Diagnostic, Diagnostics, type Fix } from "./diagnostics.js";
import { applyFixes } from "./fixes.js";
import { type Outline, buildOutline } from "./outline.js";
import { type ParseContext, fileContext, memoryContext } from "./parse/context.js";
import { parseJsonDocument } from "./parse/json.js";
import { parseLatex } from "./parse/latex.js";
import { parseMarkdown } from "./parse/markdown.js";
import { processCitations } from "./transform/citations.js";
import { type Numbering, allInlines, numberDocument } from "./transform/numbering.js";
import { liftMacros } from "./transform/math.js";
import { convertRawLatex } from "./transform/rawlatex.js";
import { renderDocumentDiagrams } from "./transform/diagrams.js";
import { renderDocumentTikz } from "./transform/tikz.js";
import { isInside, listThemes, themeCss, withoutFontData } from "./write/assets.js";
import { type CitationOutput, type HtmlOptions, type WriteContext, writeHtml } from "./write/html.js";
import { type LayoutOptions, documentLayout, frontMatterLocator } from "./layoutopts.js";
import { type PdfInput, type PdfLayoutOptions, typesetPdf } from "./typeset/index.js";
import type { AnchorInfo } from "./layout/pagebuilder.js";
import { type RenderedPage, renderPages } from "./raster/index.js";
import { fitToPages } from "./fit.js";
import { lintDocument } from "./lint.js";
import { noteRead } from "./util/reads.js";

export type { Document, Block, Inline, Meta, Pos } from "./ast.js";
export type { Diagnostic, Severity } from "./diagnostics.js";
export { CODES, Diagnostics, type Fix, formatCompact } from "./diagnostics.js";
export { applyFixes } from "./fixes.js";
export type { RenderedPage } from "./raster/index.js";
export { type Outline, type OutlineItem, formatOutline } from "./outline.js";
export { documentJsonSchema, diagnosticJsonSchema } from "./schema.js";
export { listThemes };

export type InputFormat = "markdown" | "latex" | "json";
export type OutputFormat = "pdf" | "html" | "json";

export interface ConvertOptions {
  /** Input file path. Use `source` instead to pass text. */
  input?: string;
  /** Input text. Relative paths (images, \input, bibliography) resolve against `baseDir`. */
  source?: string;
  /** In-memory files for `source` input (path -> text), e.g. a .bib file. */
  files?: Record<string, string>;
  baseDir?: string;
  /** Detected from the file extension when omitted (default markdown). */
  from?: InputFormat;
  to: OutputFormat;
  /** Output path. When omitted the result carries the bytes or text. */
  output?: string;

  /** Metadata overrides (applied over front matter / \title etc.). */
  meta?: Partial<Meta> & { titleText?: string; authorText?: string[]; dateText?: string };
  theme?: string;
  /** Paths of extra stylesheets. */
  css?: string[];

  paper?: "letter" | "a4" | "a5" | "legal" | "b5";
  landscape?: boolean;
  margin?: string;
  /** Body size in points (LaTeX's 10pt, 11pt, 12pt); every size and skip of the theme scales with it. */
  fontSize?: number;
  /** Page limit: the layout is tightened (margins, then body size) until the PDF fits, within limits. */
  maxPages?: number;
  pageNumbers?: "center" | "right" | "none";
  header?: string;
  footer?: string;

  /** Allow remote images and stylesheets. Off by default. */
  allowNet?: boolean;
  /** Extra folders images may be read from. */
  allowPaths?: string[];
  /** Keep raw HTML unsanitized. Only for trusted input. */
  unsafeHtml?: boolean;
  /** Treat warnings as errors when deciding `ok`. */
  strict?: boolean;
}

/** Where a heading, figure, table, numbered equation or theorem landed in the PDF. */
export interface Placement {
  kind: "heading" | "figure" | "table" | "equation" | "theorem" | "algorithm";
  page: number;
  number?: string;
  label?: string;
  /** Heading text or the start of a caption. */
  text?: string;
  /** Source line. */
  line?: number;
}

export interface ConvertResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** PDF only: the page each heading, figure, table, numbered equation and theorem landed on. */
  placement?: Placement[];
  /** Path written, when `output` was given. */
  output?: string;
  /** The output itself when no path was given: string for html/json, bytes for pdf. */
  data?: string | Uint8Array;
  /** The transformed document (numbers filled in). */
  document: Document;
  stats: { pages?: number; passes?: number; ms: number };
}

export function detectFormat(path: string | undefined): InputFormat {
  const ext = extname(path ?? "").toLowerCase();
  if ([".tex", ".latex", ".ltx", ".sty"].includes(ext)) return "latex";
  if (ext === ".json") return "json";
  return "markdown";
}

function todayText(): string {
  // "October 8, 2026" in local time, as toLocaleDateString("en-US") writes it, by hand: that first starts up ICU, some 20 ms.
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const d = new Date();
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function textToInlines(s: string): Inline[] {
  return [{ t: "Text", text: s }];
}

interface Prepared {
  doc: Document;
  ctx: ParseContext;
  numbering: Numbering;
  citations: CitationOutput;
  diagnostics: Diagnostics;
  baseDir: string;
}

/** Parse and transform without writing anything. Shared by convert() and check(). */
function prepare(opts: Omit<ConvertOptions, "to"> & { to?: OutputFormat }): Prepared {
  const diagnostics = new Diagnostics();
  let text: string;
  let ctx: ParseContext;
  const fileName = opts.input && opts.input !== "-" ? opts.input : undefined;
  if (opts.source !== undefined) {
    text = opts.source;
    ctx = opts.files ? memoryContext(opts.files, fileName, diagnostics) : fileContext(undefined, diagnostics);
    ctx.baseDir = resolve(opts.baseDir ?? (fileName ? dirname(fileName) : process.cwd()));
    if (!opts.files) {
      const base = ctx.baseDir;
      ctx.readFile = (p) => {
        try {
          return readFileSync(resolve(base, p), "utf8");
        } catch {
          return undefined;
        }
      };
    }
  } else if (fileName) {
    ctx = fileContext(fileName, diagnostics);
    try {
      noteRead(fileName);
      text = readFileSync(fileName, "utf8");
    } catch {
      diagnostics.add("IO001", `Cannot read input file: ${fileName}`, { file: fileName });
      const doc = emptyDocument();
      return { doc, ctx, numbering: { labels: new Map(), ids: new Set() }, citations: { rendered: new WeakMap(), bibliography: [] }, diagnostics, baseDir: ctx.baseDir };
    }
  } else {
    throw new Error("convert(): give `input` (a path) or `source` (text)");
  }
  if (!opts.files) {
    // \input, \include and bibliography files: same folder rule as images.
    const roots = [ctx.baseDir, ...(opts.allowPaths ?? []).map((p) => resolve(p))];
    const read = ctx.readFile;
    const base = ctx.baseDir;
    const where = ctx.file ? { file: ctx.file } : undefined;
    ctx.readFile = (p) => {
      if (!isInside(resolve(base, p), roots)) {
        diagnostics.add("IO002", `Not reading "${p}": it is outside the document folder`, where, {
          hint: "Move the file next to the document, or pass --allow-path <folder>",
        });
        return undefined;
      }
      noteRead(resolve(base, p));
      return read(p);
    };
  }
  text = text.replace(/^﻿/, "");
  if (ctx.file) diagnostics.registerSource(ctx.file, text);

  const from = opts.from ?? detectFormat(fileName);
  const source = text;
  const doc = guardDepth(
    () => (from === "latex" ? parseLatex(source, ctx) : from === "json" ? parseJsonDocument(source, ctx) : parseMarkdown(source, ctx)),
    diagnostics,
    ctx.file,
  );

  applyMetaOverrides(doc, opts.meta, diagnostics);
  if (plainText(doc.meta.date).trim().toLowerCase() === "today") doc.meta.date = textToInlines(todayText());
  if (from === "latex") doc.meta.numberSections ??= true;
  doc.meta.macros = normalizeMacros(doc.meta.macros);
  liftHeaderIncludes(doc, diagnostics);

  guardDepth(() => convertRawLatex(doc, ctx), diagnostics, ctx.file);
  renderDocumentDiagrams(doc, diagnostics, ctx.file);
  renderDocumentTikz(doc, diagnostics, ctx.file, (path) => ctx.readFile(path));
  const numbering = numberDocument(doc, diagnostics);

  const bibNames = doc.meta.bibliography ?? [];
  const sources = bibNames.map((name) => ({ name, text: ctx.readFile(name) }));
  const citations = processCitations(doc, sources, diagnostics);
  lintDocument(doc, diagnostics);
  return { doc, ctx, numbering, citations, diagnostics, baseDir: ctx.baseDir };
}

/**
 * Run a parsing step; if the input nests so deeply that the parser runs out of
 * stack, report it instead of crashing and continue with an empty document.
 */
function guardDepth<T>(fn: () => T, diagnostics: Diagnostics, file: string | undefined): T {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    diagnostics.add("LTX003", "The document nests too deeply to parse (thousands of levels of braces, lists or environments)", file ? { file } : undefined, {
      hint: "Look for a long run of unclosed { or \\begin",
    });
    return emptyDocument() as T;
  }
}

/**
 * Apply metadata given on the command line or through the API. Values may
 * arrive as plain strings (-M title=x) or already in document form; each
 * field is converted to the shape the document model needs, and anything
 * that cannot be is reported (OPT001) instead of being stored as is.
 */
function applyMetaOverrides(doc: Document, meta: ConvertOptions["meta"], diagnostics: Diagnostics): void {
  if (!meta) return;
  const { titleText, authorText, dateText, ...rest } = meta;
  let affiliation: unknown;
  const m = doc.meta;
  const bad = (key: string, expected: string) => diagnostics.add("OPT001", `Metadata "${key}" ${expected}`);
  const inlines = (v: unknown): Inline[] | undefined =>
    typeof v === "string" || typeof v === "number" ? textToInlines(String(v)) : Array.isArray(v) && v.every((x) => x && typeof x === "object" && "t" in x) ? (v as Inline[]) : undefined;
  const strings = (v: unknown): string[] | undefined =>
    typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    switch (key) {
      case "title":
      case "subtitle":
      case "date": {
        const v = inlines(value);
        if (v) m[key] = v;
        else bad(key, "must be text");
        break;
      }
      case "author": {
        const list = Array.isArray(value) && value.every((x) => typeof x === "string") ? (value as string[]) : typeof value === "string" ? [value] : undefined;
        if (list) m.author = list.map(textToInlines);
        else if (Array.isArray(value) && value.every((x) => inlines(x))) m.author = value as Inline[][];
        else bad(key, "must be a name or a list of names");
        break;
      }
      case "abstract":
        if (typeof value === "string") m.abstract = [{ t: "Para", content: textToInlines(value) }];
        else if (Array.isArray(value)) m.abstract = value as Document["meta"]["abstract"];
        else bad(key, "must be text");
        break;
      case "keywords":
      case "bibliography": {
        const v = strings(value);
        if (v) m[key] = v;
        else bad(key, "must be a list of strings");
        break;
      }
      case "toc":
      case "numberSections":
        if (typeof value === "boolean") m[key] = value;
        else bad(key, "must be true or false");
        break;
      case "tocDepth":
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6) m.tocDepth = value;
        else bad(key, "must be a whole number from 1 to 6");
        break;
      case "numberWithin":
        if (value === 0 || value === 1) m.numberWithin = value;
        else bad(key, "must be 0 or 1");
        break;
      case "citationStyle":
        if (value === "numeric" || value === "author-year") m.citationStyle = value;
        else bad(key, 'must be "numeric" or "author-year"');
        break;
      case "lang":
        if (typeof value === "string") m.lang = value;
        else bad(key, "must be a language tag such as en");
        break;
      case "macros":
        if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((x) => typeof x === "string")) m.macros = { ...(m.macros ?? {}), ...(value as Record<string, string>) };
        else bad(key, "must map macro names to definitions");
        break;
      case "affiliation":
        affiliation = value;
        break;
      default:
        (m.extra ??= {})[key] = value;
    }
  }
  if (titleText !== undefined) m.title = textToInlines(titleText);
  if (authorText !== undefined) m.author = authorText.map(textToInlines);
  if (dateText !== undefined) m.date = textToInlines(dateText);
  // After the authors are final: one text for all of them, or one entry (or null) per author.
  if (affiliation !== undefined) {
    const authors = m.author ?? [];
    if (typeof affiliation === "string") m.affiliation = authors.map(() => textToInlines(affiliation as string));
    else if (Array.isArray(affiliation) && affiliation.every((a) => a === null || inlines(a))) {
      m.affiliation = authors.map((_, k) => {
        const a = (affiliation as unknown[])[k];
        return a === null || a === undefined ? null : inlines(a)!;
      });
    } else bad("affiliation", "must be text, or a list with one entry (or null) per author");
  }
}

/** Definitions in pandoc's header-includes (\newcommand, \DeclareMathOperator, ...) become document macros; the rest is ignored. */
function liftHeaderIncludes(doc: Document, diagnostics: Diagnostics): void {
  const raw = doc.meta.extra?.["header-includes"];
  const parts = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  for (const part of parts) if (typeof part === "string") liftMacros(part, (doc.meta.macros ??= {}), diagnostics);
}

function normalizeMacros(macros: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(macros ?? {})) out[k.startsWith("\\") ? k : `\\${k}`] = v;
  return out;
}

/** Layout given as options (CLI flags, MCP arguments); the document fills in the rest. */
function layoutOptions(opts: Omit<ConvertOptions, "to" | "output">): LayoutOptions {
  return {
    theme: opts.theme,
    paper: opts.paper,
    landscape: opts.landscape,
    margin: opts.margin,
    pageNumbers: opts.pageNumbers,
    header: opts.header,
    footer: opts.footer,
    fontSize: opts.fontSize,
    maxPages: opts.maxPages,
  };
}

function htmlOptions(opts: ConvertOptions, baseDir: string, diagnostics: Diagnostics): HtmlOptions {
  const theme = opts.theme ?? "article";
  if (!themeCss(theme)) {
    diagnostics.add("OPT001", `Unknown theme "${theme}"; using article`, undefined, { hint: `Themes: ${listThemes().join(", ")}` });
  }
  const extraCss: string[] = [];
  for (const path of opts.css ?? []) {
    try {
      noteRead(path);
      extraCss.push(readFileSync(resolve(path), "utf8"));
    } catch {
      diagnostics.add("IO001", `Stylesheet not found: ${path}`);
    }
  }
  return {
    theme: themeCss(theme) ? theme : "article",
    extraCss,
    images: { baseDir, allowPaths: opts.allowPaths ?? [], allowNet: !!opts.allowNet, embed: true },
    unsafeHtml: !!opts.unsafeHtml,
  };
}

/** Parse, transform and validate a document without producing output. */
/** What is where in a document: headings, figures, tables, equations, theorems, listings and citations, with lines. */
export function outline(opts: Omit<ConvertOptions, "to" | "output">): { ok: boolean; outline: Outline; diagnostics: Diagnostic[] } {
  const p = prepare(opts);
  return { ok: !p.diagnostics.hasErrors(opts.strict), outline: buildOutline(p.doc), diagnostics: p.diagnostics.sorted() };
}

export interface FixReport {
  ok: boolean;
  /** Fixes written to files, each with the file it changed. */
  applied: Fix[];
  /** Safe fixes that could not be placed (the text was not found where the diagnostic points), or that were taken back. */
  skipped: Fix[];
  /** Fixes taken back because the document checked worse with them (also listed in `skipped`). */
  reverted: Fix[];
  /** Diagnostics after fixing, from a fresh check. */
  diagnostics: Diagnostic[];
}

/** A report of broken structure: unbalanced braces, \left, environments, front matter. */
function isStructural(d: Diagnostic): boolean {
  if (d.code === "LTX003" || d.code === "YAML001" || d.code === "MD001" || d.code === "LTX002") return true;
  return d.code === "MATH001" && /Unclosed|no matching|without a matching|ended by/.test(d.message);
}

/** Errors and warnings in a check result. */
function badness(ds: readonly Diagnostic[]): [number, number] {
  let e = 0;
  let w = 0;
  for (const d of ds) {
    if (d.severity === "error") e++;
    else if (d.severity === "warning") w++;
  }
  return [e, w];
}

/**
 * Check a document file, apply every safe fix (typos in labels, citation keys, commands, image
 * names and option values; missing closers; broken front matter) to the files they point into, and
 * check again, until nothing more applies. A round of fixes after which the document has more
 * problems (errors and warnings together) than before is taken back, so fixing never makes a document
 * worse. Only the input file and files in its folder (or the allowed folders) are written.
 */
export function fixDocument(opts: Omit<ConvertOptions, "to" | "output">): FixReport {
  if (!opts.input) throw new Error("fixDocument needs an input file (fixes are written back to it)");
  const input = resolve(opts.input);
  const roots = [dirname(input), ...(opts.allowPaths ?? []).map((p) => resolve(p))];
  const applied: Fix[] = [];
  const reverted: Fix[] = [];
  let skipped: Fix[] = [];
  let report = check(opts);
  // Some problems are reported once per name (an unknown command used five times), and a fix can
  // uncover the next problem (an inner environment closed shows the outer one open): repeat while
  // safe fixes keep applying.
  for (let pass = 0; pass < 12; pass++) {
    const byFile = new Map<string, Fix[]>();
    // A missing closer or broken front matter skews everything after it (labels swallowed into a
    // formula look undefined), so while such fixes remain they go alone, and the near-miss fixes for
    // names wait for a check of the repaired structure.
    const structural = report.diagnostics.some((d) => d.fix?.safe && isStructural(d));
    for (const d of report.diagnostics) {
      if (!d.fix?.safe || (structural && !isStructural(d))) continue;
      // Positions name the input as it was given, and \input files as written (relative to the document's folder).
      const f = d.fix.file;
      const target = !f || resolve(f) === input ? input : resolve(dirname(input), f);
      byFile.set(target, [...(byFile.get(target) ?? []), d.fix]);
    }
    const written = new Map<string, string>();
    const round: Fix[] = [];
    skipped = [];
    for (const [file, fixes] of byFile) {
      if (file !== input && !isInside(file, roots)) {
        skipped.push(...fixes);
        continue;
      }
      const text = readFileSync(file, "utf8");
      const res = applyFixes(text, fixes);
      if (res.applied.length) {
        written.set(file, text);
        writeFileSync(file, res.text);
      }
      round.push(...res.applied.map((f) => ({ ...f, file })));
      skipped.push(...res.skipped);
    }
    if (!round.length) break;
    const next = check(opts);
    const [e0, w0] = badness(report.diagnostics);
    const [e1, w1] = badness(next.diagnostics);
    if (e1 + w1 > e0 + w0) {
      for (const [file, text] of written) writeFileSync(file, text);
      reverted.push(...round);
      skipped.push(...round);
      break;
    }
    applied.push(...round);
    report = next;
  }
  return { ok: report.ok, applied, skipped, reverted, diagnostics: report.diagnostics };
}

export function check(opts: Omit<ConvertOptions, "to" | "output">): { ok: boolean; diagnostics: Diagnostic[]; document: Document } {
  const p = prepare(opts);
  // Writing HTML once typesets every formula and resolves every image, which is where those errors surface.
  // The text is thrown away, so what only the output needs is left out: images are found and checked but
  // not read and encoded, and the bundled fonts are not converted to WOFF. Neither raises diagnostics.
  const wctx: WriteContext = { doc: p.doc, numbering: p.numbering, citations: p.citations, macros: p.doc.meta.macros ?? {}, diagnostics: p.diagnostics, mathCache: new WeakMap() };
  const layout = documentLayout(layoutOptions(opts), p.doc.meta, p.diagnostics, frontMatterLocator(p.diagnostics, p.ctx.file));
  const html = htmlOptions({ ...opts, theme: layout.theme, to: "html" }, p.baseDir, p.diagnostics);
  withoutFontData(() => writeHtml(wctx, { ...html, images: { ...html.images, embed: false } }));
  return { ok: !p.diagnostics.hasErrors(opts.strict), diagnostics: p.diagnostics.sorted(), document: p.doc };
}

export async function convert(opts: ConvertOptions): Promise<ConvertResult> {
  const started = Date.now();
  const p = prepare(opts);
  const { doc, diagnostics } = p;
  const stats: ConvertResult["stats"] = { ms: 0 };
  let data: string | Uint8Array | undefined;
  let placement: Placement[] | undefined;

  if (opts.to !== "pdf") {
    allInlines(doc, (i) => {
      if (i.t === "Ref" && i.style === "page") diagnostics.add("REF004", `Page reference to "${i.label}" has a number only in PDF output`, i.pos);
    });
  }
  if (opts.to === "json") {
    data = `${JSON.stringify(doc, null, 2)}\n`;
  } else {
    const wctx: WriteContext = { doc, numbering: p.numbering, citations: p.citations, macros: doc.meta.macros ?? {}, diagnostics, mathCache: new WeakMap() };
    const layout = documentLayout(layoutOptions(opts), doc.meta, diagnostics, frontMatterLocator(diagnostics, p.ctx.file));
    const base = htmlOptions({ ...opts, theme: layout.theme }, p.baseDir, diagnostics);
    if (opts.to === "html") {
      data = writeHtml(wctx, base);
    } else {
      try {
        const { input, pdfLayout } = pdfSetup(p, opts);
        const pdf = typesetPdf(input, pdfLayout);
        data = pdf.bytes;
        stats.pages = pdf.pageCount;
        stats.passes = pdf.passes;
        placement = placements(doc, pdf.anchors);
      } catch (e) {
        diagnostics.add("PDF001", `The PDF could not be written: ${(e as Error).message.split("\n")[0]}`, undefined, { hint: "Please report this with the input file" });
      }
    }
  }

  let output: string | undefined;
  if (data !== undefined && opts.output) {
    writeFileSync(opts.output, data);
    output = resolve(opts.output);
    data = undefined;
  }
  stats.ms = Date.now() - started;
  const ok = !diagnostics.hasErrors(opts.strict) && (opts.to !== "pdf" || output !== undefined || data !== undefined);
  return { ok, diagnostics: diagnostics.sorted(), output, data, document: doc, stats, ...(placement ? { placement } : {}) };
}

/** The typesetter's input and page layout for a prepared document, fitted to max-pages when asked. */
function pdfSetup(p: ReturnType<typeof prepare>, opts: Omit<ConvertOptions, "to" | "output">): { input: PdfInput; pdfLayout: PdfLayoutOptions } {
  const { doc, diagnostics } = p;
  const layout = documentLayout(layoutOptions(opts), doc.meta, diagnostics, frontMatterLocator(diagnostics, p.ctx.file));
  const base = htmlOptions({ ...opts, to: "pdf", theme: layout.theme }, p.baseDir, diagnostics);
  const input: PdfInput = { doc, numbering: p.numbering, citations: p.citations, macros: doc.meta.macros ?? {}, diagnostics };
  let pdfLayout: PdfLayoutOptions = {
    theme: base.theme,
    paper: layout.paper ?? "letter",
    landscape: !!layout.landscape,
    margin: layout.margin ?? "1in",
    pageNumbers: layout.pageNumbers,
    header: layout.header,
    footer: layout.footer,
    fontSize: layout.fontSize,
    images: { ...base.images, embed: false },
  };
  if (layout.maxPages) pdfLayout = fitToPages(input, pdfLayout, layout.maxPages, diagnostics);
  return { input, pdfLayout };
}

/** Where headings, figures, tables, numbered equations and theorems landed, in document order. */
function placements(doc: Document, anchors: ReadonlyMap<string, AnchorInfo>): Placement[] {
  const out: Placement[] = [];
  const add = (kind: Placement["kind"], b: { id?: string; number?: string; label?: string; pos?: Pos }, text?: Inline[]) => {
    const at = b.id ? anchors.get(b.id) : undefined;
    if (!at) return;
    const pl: Placement = { kind, page: at.page };
    if (b.number) pl.number = b.number;
    if (b.label) pl.label = b.label;
    const t = text ? plainText(text).trim() : "";
    if (t) pl.text = t.length > 60 ? `${t.slice(0, 59)}…` : t;
    if (b.pos?.line) pl.line = b.pos.line;
    out.push(pl);
  };
  walkBlocks(doc.blocks, (b) => {
    if (b.t === "Heading") add("heading", b, b.content);
    else if (b.t === "Figure") add(b.attr?.classes?.includes("algorithm") ? "algorithm" : "figure", b, b.caption);
    else if (b.t === "Table") add("table", b, b.caption);
    else if (b.t === "MathBlock" && b.number) add("equation", b);
    else if (b.t === "Theorem" && b.kind !== "proof") add("theorem", b, b.title);
  });
  return out;
}

export interface PreviewOptions extends Omit<ConvertOptions, "to" | "output"> {
  /** Pixels per inch (default 100). */
  dpi?: number;
  /** 1-based pages to draw (default all). */
  pages?: number[];
}

export interface PreviewResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  pageCount: number;
  /** The pages drawn, as PNG. */
  pages: RenderedPage[];
  /** The page each heading, figure, table, equation and theorem landed on. */
  placement: Placement[];
}

/**
 * The PDF's pages as PNG images, drawn by texwright's own rasterizer from
 * exactly the layout the PDF would have: for looking at the result.
 */
export function preview(opts: PreviewOptions): PreviewResult {
  const p = prepare(opts);
  const { doc, diagnostics } = p;
  let pageCount = 0;
  let pages: RenderedPage[] = [];
  let placement: Placement[] = [];
  try {
    const { input, pdfLayout } = pdfSetup(p, opts);
    const r = renderPages(input, pdfLayout, { dpi: opts.dpi, pages: opts.pages });
    pageCount = r.pageCount;
    pages = r.pages;
    placement = placements(doc, r.anchors);
    for (const w of r.warnings) diagnostics.add("PREV001", w);
  } catch (e) {
    if (e instanceof RangeError && /dpi/i.test(e.message)) diagnostics.add("OPT001", e.message);
    else diagnostics.add("PDF001", `The pages could not be drawn: ${(e as Error).message.split("\n")[0]}`, undefined, { hint: "Please report this with the input file" });
  }
  return { ok: !diagnostics.hasErrors(opts.strict) && pages.length > 0, diagnostics: diagnostics.sorted(), pageCount, pages, placement };
}

/** Default output path: the input name with the output extension. */
export function defaultOutput(input: string | undefined, to: OutputFormat): string {
  const ext = to === "pdf" ? ".pdf" : to === "html" ? ".html" : ".json";
  if (!input || input === "-") return `document${ext}`;
  const base = basename(input, extname(input));
  return resolve(dirname(input), base + ext);
}
