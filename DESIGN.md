# texwright design

texwright turns Markdown, LaTeX or a JSON document tree into PDF, HTML or JSON. It needs no TeX installation, no browser and no runtime dependencies: the typesetting engine, the math layout, the SVG renderer, the font subsetter and the PDF encoder are its own, written on Node's standard library. The Markdown reader (`src/parse/md/`) was written from the CommonMark 0.31 and GFM specifications: a line-by-line block phase over a stack of open containers, then an inline phase with a delimiter list for emphasis, building the document tree directly. Everything it finds wrong comes back as a structured diagnostic with a stable code, a position and a hint, so a program (or an AI agent) can fix the source and try again.

## Pipeline

```
source ──parse──▶ Document ──transform──▶ Document ──write──▶ HTML   write/html.ts (MathML from src/math)
 .md  parse/markdown.ts      transform/rawlatex.ts            └──▶ PDF    typeset/ → layout/ → pdf/
 .tex parse/latex.ts         transform/numbering.ts
 .json parse/json.ts         transform/citations.ts
                             transform/math.ts
```

Every stage takes a `Diagnostics` object and adds to it instead of throwing. A stage only throws for programming errors. The CLI decides the exit code from the collected diagnostics.

The document model lives in `src/ast.ts` and is the contract between stages. Nodes are plain JSON with a `t` discriminant and an optional `pos` (file, line, col). Do not add fields without updating `src/schema.ts` (the hand-written JSON Schema and validator behind JSON input and `texwright schema`).

## Module contracts

`src/parse/markdown.ts`

```ts
export function parseMarkdown(text: string, ctx: ParseContext): Document
```

`src/parse/latex.ts`

```ts
export function parseLatex(text: string, ctx: ParseContext): Document      // whole .tex file
export function latexToBlocks(text: string, ctx: ParseContext): Block[]    // raw LaTeX block from Markdown
export function latexToInlines(text: string, ctx: ParseContext): Inline[]  // raw LaTeX inline from Markdown
```

`ParseContext` is defined in `src/parse/context.ts`:

```ts
interface ParseContext {
  file?: string;              // for positions and diagnostics
  baseDir: string;            // for \input, \include, images
  diagnostics: Diagnostics;
  readFile(path: string): string | undefined;   // injected so tests need no disk
  lineOffset?: number;        // added to every line number (raw LaTeX inside Markdown)
}
```

`src/cite/` (bibliographies and citation formatting)

```ts
export function parseBibtex(text: string, ctx: { file?: string; diagnostics: Diagnostics }): BibEntry[]
export function parseCslJson(text: string, ctx: { file?: string; diagnostics: Diagnostics }): BibEntry[]
export function createCiteProcessor(entries: BibEntry[], style: "numeric" | "author-year", diagnostics: Diagnostics): CiteProcessor
interface CiteProcessor {
  cite(node: CiteNode): Inline[];          // call in document order; numeric numbering follows first use
  bibliography(): BibItem[];               // entries actually cited (plus nocite), in style order
}
interface BibItem { key: string; id: string; label?: string; content: Inline[] }
```

`BibEntry` follows CSL-JSON field names (`id`, `type`, `title`, `author`, `issued`, `container-title`, ...).

## Markdown dialect

CommonMark plus GitHub tables, strikethrough, autolinks and task lists, plus these pandoc-style extensions:

- YAML front matter between `---` lines: title, subtitle, author (string or list), date, abstract, keywords, lang, bibliography, citation-style, macros, toc, toc-depth, number-sections, number-within.
- Math: `$inline$`, `$$display$$`, `\(inline\)`, `\[display\]`, and LaTeX math environments (`equation`, `align`, `gather`, `multline`, their starred forms) written directly in the text. A `\label{eq:x}` inside, or `{#eq:x}` after `$$...$$`, labels the equation. Pandoc's rule for `$`: the opening `$` must be followed by a non-space and the closing `$` preceded by a non-space and not followed by a digit, so "$5 and $10" stays text.
- Cross-references: `@fig:x`, `@tbl:x`, `@eq:x`, `@sec:x`, `@thm:x` (and `lem`, `def`, `cor`, `prop`, `lst`, `app`), plus `\ref{}`, `\eqref{}`, `\pageref{}`, `\autoref{}`, `\cref{}`.
- Citations: `[@doe2020; @roe2019, p. 4]`, `@doe2020` in running text, `[-@doe2020]` for the year only, `\cite{}`, `\citep{}`, `\citet{}`, `\nocite{}`.
- Attributes: `# Results {#sec:results}`, `{.unnumbered}` or `{-}`, `![Caption](plot.png){#fig:plot width=60%}`.
- Figures: a paragraph holding only an image becomes a numbered figure captioned with the alt text.
- Table captions: a paragraph `Table: Caption {#tbl:x}` (or `: Caption`) directly before or after a table.
- Fenced divs: `::: note` ... `:::`; classes note, tip, important, warning and caution render as callouts; abstract becomes the abstract; theorem, lemma, proposition, corollary, definition, example, remark and proof become numbered theorem blocks (`::: {.theorem #thm:main title="Main result"}`).
- Footnotes `[^1]` and inline `^[text]`, definition lists, `\newpage`, `\pagebreak`, `[[toc]]` or `\tableofcontents` on a line of their own.
- Any other LaTeX (`\textbf{}`, `\begin{table}...`) is passed to the LaTeX parser, so LaTeX and Markdown can be mixed in one file.

## LaTeX subset

Document structure (`\documentclass` and `\usepackage` are accepted and ignored; `\title`, `\author`, `\date`, `\maketitle`, `abstract`, `\tableofcontents`), sectioning to `\paragraph` with starred forms, `\label`, `\ref` family, `\cite` family, text styles (`\emph`, `\textbf`, `\textit`, `\texttt`, `\textsc`, `\underline`, `\sout`, size commands ignored), `\url`, `\href`, `\footnote`, lists (`itemize`, `enumerate`, `description`), `quote`, `quotation`, `verbatim`, `lstlisting`, `minted`, `figure` with `\includegraphics`, `\caption`, `\centering`, `table` with `tabular` (`l c r p{}` columns, `\hline`, `\toprule`/`\midrule`/`\bottomrule`, `\multicolumn`), math (`$`, `\(`, `\[`, `equation`, `align`, `gather`, `multline` and starred forms), `\newcommand`, `\renewcommand` and `\DeclareMathOperator` (passed to the math engine as macros), theorem environments declared with `\newtheorem`, `\input` and `\include`, `\newpage`, `\clearpage`, `\bibliography` and `\printbibliography`, accents and special characters. Unknown commands produce LTX001 and keep their text. TikZ and pgfplots produce LTX004.

## Diagnostics

`src/diagnostics.ts` holds the code catalogue. A diagnostic is `{code, severity, message, file, line, col, hint, excerpt, fix}`. A fix (`src/fixes.ts`) is `{line, col, old, new, safe}`: replace the first whole-word `old` at or after line:col with `new`, the shape an agent's edit tool takes. `safe` means one candidate is clearly nearest (by an edit distance that counts a swap of two letters as one typo) and at most two edits away, or differs only in case; `check --fix` applies only those, and only to the input and files in its folder. Undefined labels, unknown citation keys, undefined math commands and near-miss image names carry fixes today. `--diagnostics compact` prints one line per diagnostic. `src/outline.ts` builds the outline behind `texwright outline` and the `outline_document` tool. Exit status: 0 when there are no errors, 1 when there are errors (or warnings with `--strict`), 2 for usage errors.

## Page numbers

Page references are only known once the document is laid out, and printing them can move text, so the PDF writer lays out in passes, the way LaTeX reruns with its `.aux` file (`layoutUntilStable` in `src/layout/pagebuilder.ts`). The page builder records the page of every anchor. The first pass prints placeholders in the table of contents and in `\pageref`; each later pass prints the pages the previous one found. When two passes agree, the pages are shipped; after four passes without agreement the last one is shipped and PDF002 is reported. Nothing is written to disk between passes.

## PDF figures

`\includegraphics{figure.pdf}` needs a PDF page importer, which texwright doesn't have yet. Such figures are reported (IMG003) and shown as a placeholder; export them as SVG (drawn as vectors) or PNG.

## Raw LaTeX in Markdown

The Markdown parser captures LaTeX it doesn't handle itself as `RawBlock`/`RawInline` nodes. `transform/rawlatex.ts` hands each one to the LaTeX parser with a context whose `macros` and `meta` are the document's own, so `\newcommand` in one fragment works in later ones and `\bibliography{refs}` in a fragment reaches the citation step. The LaTeX parser's output is final and is never fed back to it.

## Limits that keep hostile input in check

Every parser is meant to run in roughly linear time on any input; `test/performance.test.ts` pins this with hostile inputs of 100 KB and more (unclosed delimiters, long runs of one character, deep nesting, repeated notes and headings) that must check in about a second. The caps that make it so:

- LaTeX macros: expansion depth 50, a total expansion budget, and at most 4,000,000 characters of expanded text per document (LTX005).
- Math: the engine caps macro expansions per formula and the size of the expanded text, and refuses a formula whose macros would expand past 200,000 characters (MATH001).
- SVG figures: at most 500,000 rendered nodes, 1,000,000 path commands, 500,000 glyphs and a reference depth of 24; the XML reader skips document type declarations and never expands custom entities.
- Fonts and images: every size read from a file is checked before anything is allocated from it; corrupt files give a diagnostic, never a crash.
- YAML front matter: texwright's own YAML reader refuses anchors, aliases and tags outright, so a value can never outgrow its text (YAML001); depth and length are capped.
- Footnotes: at most 200,000 copied nodes from notes referenced many times (MD001).
- BibTeX: `@string` text up to 1,000,000 characters per file; brace nesting past 200 levels is read as flat text.
- Table column specs: at most 1,000 columns.
- JSON input: at most 400 levels deep. Any parse that still exhausts the stack is reported as LTX003 instead of crashing.
- Diagnostics: the first 100 per code are listed, the rest summarized in one line.

`test/robustness.test.ts` fuzzes all three input formats with deterministic random soups and pathological structures; none may throw. Long-lived hosts (the MCP server, the CLI with `--timeout`) also run each request in a worker thread with a wall-clock limit (TIME001), and the MCP server confines every path to its workspace root (PATH001).

## The engine

Node's standard library is the only foundation, and the fonts are the only bundled third-party material (data, not code). The engine is a set of modules with narrow contracts:

| Module | Job | Contract |
|---|---|---|
| `src/typeset/` | Document tree to TeX lists: paragraphs, headings, lists, tables, figures, theorems, code, display math, contents, bibliography; themes as typographic parameters; page assembly and running footers | `typesetPdf` in `src/typeset/index.ts` |
| `src/font/` | Read TrueType/OpenType/collections; metrics, cmap, kerning (kern, GPOS), ligatures (GSUB); subset for PDF, WOFF for HTML; bundled and system font lookup | `Font` in `src/font/index.ts` |
| `src/math/` | LaTeX math to a math list, TeX Appendix G layout into boxes, MathML for HTML | `MathEngine` in `src/math/api.ts` |
| `src/layout/` | Box packing, text shaping with accent composition, Knuth–Plass line breaking, Liang hyphenation, page building with floats and footnotes, shipping boxes to the PDF writer | box model in `src/layout/types.ts` |
| `src/svg/` | SVG figures to vector drawings | `Drawing` in `src/layout/types.ts` |
| `src/pdf/` | Objects, cross-reference, Type0/CIDFontType2 fonts with ToUnicode, PNG/JPEG images, links, named destinations, bookmarks, metadata | `PdfDocumentWriter` in `src/pdf/api.ts` |

The layout model is TeX's: boxes with width, height and depth; glue with stretch and shrink of four orders; penalties; marks for anchors, links, bookmarks, footnotes and floats. Units are PostScript points. Spacing between blocks follows LaTeX's `\addvspace`: two block spaces in a row merge into the larger one, and a heading's break penalty goes before the space so the two can merge.

The `article` theme uses LaTeX's article-class values at 11pt (sizes, skips, indents, club and widow penalties) in the bundled Latin Modern faces; a `fontsize` from the document scales all of them together. Layout comes from the document (front matter keys or LaTeX class and geometry options, read by `src/layoutopts.ts`), and convert() options win over it. `modern` and `compact` use the first installed sans-serif face from a preference list, falling back to the bundled sans.

Fonts: text is set in Latin Modern (OpenType, CFF outlines, GUST Font License), which has ligatures, kerning and accented letters; mathematics uses KaTeX's Computer Modern derivatives (SIL Open Font License 1.1). Both are in `fonts/`. Where a face lacks an accented letter it is composed the way TeX's `\accent` does; characters the bundled fonts lack fall back to installed system fonts, skipping fonts whose license forbids embedding (FONT001 when none has the character). OpenType fonts are subset by `src/font/cffsubset.ts`: glyph ids stay, unused charstrings become `endchar`, and subroutines no kept glyph calls become `return`.

Hyphenation: justified paragraphs in English documents (the default language) hyphenate with TeX's US English patterns from `hyphenation/en-us.json`; other languages are not hyphenated.

## Security defaults

Documents are untrusted, since agents generate them. Nothing is fetched from the network: in PDF output a remote image is reported and left out, and in HTML output a remote image URL is kept only with `--allow-net` (the reader's browser fetches it, not texwright). Raw HTML is sanitized (no scripts, no event handlers, no iframes). Local files, including images referenced from inside SVG figures, are readable only under the input's directory unless `--allow-path` adds more.

## Tests

`node:test`, compiled by `tsc`. Each module has `test/<module>.test.ts`. Run everything with `npm test`.
