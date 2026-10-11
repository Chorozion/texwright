# Changelog

## 0.3.4

Faster, steadier output, and a one-call repair loop.

- `texwright watch doc.md -o doc.pdf` renders again on every save in one warm process. It watches every file the last render read (included files, images, the bibliography, fonts, plot data) and redoes only the layout an edit touched: a text edit goes from save to PDF in about 100 ms, byte-identical to a fresh render. `--debounce` sets the quiet time in milliseconds.
- `texwright repair doc.md` (MCP `repair_document`) checks, applies safe fixes until none is left (taking back a round that makes things worse), renders when the document is clean, and answers in a few lines: what it fixed, what is left with its fix, and where things landed. `--budget` caps the answer's length in characters.
- Layout checks that a reader would notice: MD002 (a `$` that never closes), LAY004 (a float more than two pages after its first reference), LAY005 (a widow or orphan line, info), LAY006 (a table, image or display wider than the column), A11Y001 (an image with no alt text or caption) and A11Y002 (text contrast below 4.5:1).
- Microtypography as pdfTeX does it: characters hang into the margin (protrusion) and glyphs widen or narrow by up to 2% (expansion) before the spaces stretch. Across the benchmark, the spread of interword spaces halves (1.82 pt to 0.93 pt) and lines ending in a hyphen fall from 98 to 18. `microtype: false` in front matter (or `\usepackage[expansion=false]{microtype}`) turns it off, and the output is then byte-identical to 0.3.3.
- A long line in a code block wraps at spaces and after `/ . , ; : = & ?` instead of running into the margin. A display formula that is at most a quarter too wide is scaled down to fit.
- Startup: `--version` runs in about 100 ms instead of 195, `check` in about 165 instead of 290. The bundle is one classic script loaded lazily, with a V8 code cache kept per version in the user's cache folder.
- The MCP server's memory levels off around 220 MB instead of growing; `TEXWRIGHT_WORKER_MB` sets the worker limit.
- `texwright --version --json` hashes the code that actually runs (`dist/texwright-core.js`).

## 0.3.3

- A Markdown table whose header row and delimiter row disagree in length (`| A | B | C |` over `|---|---|`) is TBL001 instead of turning silently into a paragraph of pipes.
- `scripts/release-check.mjs` installs the exact tarball that will ship into an empty folder and checks every advertised diagnostic and feature through the installed CLI; a release ships only when it passes.
- A math error points at the offending command, not at the `$`, `$$`, `\(` or `\begin{equation}` around it: columns were one or two early inline, and an error inside a trimmed environment body landed on the line before.

## 0.3.2

Found while rebuilding the paper with every figure drawn by texwright (Mermaid, TikZ, pgfplots 3D, forest, circuitikz, PSTricks, algorithms).

- algpseudocode's `\Call{Name}{args}` and `\textproc` work inside `$...$`, as models write them in `\State` lines.
- A fix that changes letter case on top of another edit (`\Call` to `\cal`) is no longer marked safe, so `check --fix` cannot apply it unseen.
- `texwright preview --page` takes ranges: `--page 1-4,7`.
- pgfplots 3D: tick labels of two axes that meet at a front corner no longer print on top of each other ("00").
- Placement lists an algorithm as an algorithm, not as a figure.
- A table row with more cells than the table has columns is warning TBL001, in Markdown and LaTeX, instead of losing the extra cells quietly.
- A table too wide for the page is laid out as a browser lays out an automatic table: each column first gets its longest word, then the rest of the width is shared; a cell may break after / or + when it must. Text that still runs into the next column is LAY001.
- LTX004 no longer claims that TikZ, pgfplots and PSTricks are unsupported.
- The guide says that a render with errors still writes a PDF and exits 1, so success is judged by the exit code.
- A code block meant as a diagram but shown as code is warning DIAG002: a misspelt fence language (```meraid, ```tkiz) gets a safe fix, and an unlabelled block that is plainly Mermaid says so. Before, the diagram silently became source text.
- A misspelt LaTeX environment (`\begin{alignn}`) is an error with a safe fix at both `\begin` and `\end`, instead of a warning that kept the body.
- Column types a document declares (`\newcolumntype{Y}`, dcolumn's `D{.}{.}{2.3}`) count as columns.
- Brand fonts: `mainfont`, `sansfont` and `monofont` (and fontspec's `\setmainfont`, `\setsansfont`, `\setmonofont` with `Path=`, `BoldFont=`, `ItalicFont=`) set the PDF's and the HTML's faces from installed fonts or from font files next to the document, found by family name or file name, with bold and italic found beside them. New warning FONT002 when a face cannot be used.
- The paper is rebuilt: its pipeline and repair-loop figures are Mermaid, page resolution is TikZ with an algorithm beside it, the document tree is forest, line-breaking demerits are a pgfplots surface, and a new section covers the diagram and drawing interpreters with a circuit, a PSTricks plot and the 56-document drawing benchmark.

## 0.3.1

Fixes from a bug sweep (every test document rendered to PDF and HTML, mutation fuzzing) and from review.

- Inline math matches the body text: digits, upright letters, `+`, `=` and punctuation in math are set in Latin Modern, the body's face, as TeX takes them from cmr, instead of the heavier KaTeX faces.
- Quotes and dashes in footnotes curl like the body's.
- `\,` and `\thinspace` are a narrow no-break space, so `-18\,°C` never breaks across lines; in Markdown, `\,` after a digit is a thin space too.
- `\cref` and `\Cref` follow cleveref: "eq. (1)", "eqs. (1) and (2)", "Equations (1) to (3)", "fig. 1 and eq. (4)".
- `\multirow` text is centred across its rows; an `\hline` between groups of rows is drawn; LaTeX table headers are no longer bolded (the source decides), and rows above an `\hline` count as a header only when there are one or two.
- `\url{linkedin.com/in/x}` and `\href{www.example.org}{...}` link with https:// and a bare e-mail address with mailto:, instead of being dropped from the PDF.
- The outline counts references to code listings (it showed 0).
- OPT001 is a warning everywhere (the default is used), as the guide says.
- An image-name fix is marked safe when it is unambiguous and keeps the digits (`plto.png` for `plot.png`, `plot.png` for the only `plot.svg`), so `check --fix` applies it; `fig1` for `fig2` stays unsafe.
- The command line reports which page each heading, figure, table, numbered equation and theorem landed on, after "wrote" and as `placement` in `--diagnostics json`.
- A figure or diagram taller than the page is shrunk to fit with room for its caption.
- A TikZ or PSTricks picture that grows past 1 MB of drawing (a loop run to its cap) stops with a warning instead of taking seconds to draw.

## 0.3.0

Every drawing package models reach for is now drawn by texwright's own interpreters, each measured on a corpus of documents written the way models write them (`test/tikz-suite-3d`, `tikz-suite-trees`, `tikz-suite-circuits`, `pstricks-suite`; 56 documents, all clean).

- pgfplots 3D: `\addplot3` surfaces (surf, mesh, patch, `shader` flat, faceted or interp), 3D lines and parametric curves, scatter, quiver and contour plots, in a projected box like pgfplots' own (default view 25/30, back panes, grid, front tick edges) with depth-sorted patches. Colour maps (hot, jet, viridis, cool, plasma and more, or `colormap={name}{...}`), `colorbar` and `point meta`. Samples are capped at 100 x 100 per surface.
- pgfplots `fill between` with `soft clip`, between named plots or a `\path[name path=...]`; 2D axes with a colour bar or quiver plot drawn as pgfplots draws them.
- tikz-3dplot: `\tdplotsetmaincoords`, `tdplot_main_coords`, rotated coordinates, `\tdplotsetcoord` and `\tdplotdrawarc`.
- TikZ trees (`child`, `grow`, level styles, edge labels, fork edges) and mind maps; the forest package with a packed layout that never overlaps (`for tree`, `where`, `tier`, `roof`, `forked edges`, `folder`); the graphs library (`\graph` with layered, tree, spring and circular layouts).
- circuitikz with its sizes and conventions: `to[R=$R_1$, v=..., i>^=..., *-o]` bipoles (resistors, capacitors, inductors, diodes, sources, batteries, switches, meters, lamps, fuses), op amps, BJTs and MOSFETs with their anchors, transformers, grounds and supplies, logic ports and flip-flops, in American or European style. An unknown component is a labelled box with TIKZ001.
- PSTricks: `pspicture` with the pstricks objects, fill styles, shadows and arrows; pst-plot (`\psaxes`, `\psplot` with PostScript or algebraic functions, data plots), pst-node, pst-tree, and basic pst-eucl, pst-3dplot and pst-coil. New warning PST001.
- siunitx and mhchem commands (`\si`, `\SI`, `\num`, `\ce`) work in TikZ node text.
- `\tikzstyle{name}=[...]` in the document body no longer leaks its text, and inline `\tikz \draw ...;` works in Markdown.
- TikZ: `x={(..)}`, `y=` and `z=` vectors are no longer scaled twice by an earlier `scale`.

## 0.2.0

- Diagrams from Mermaid's syntax, drawn by texwright itself with no browser, in a few milliseconds each: flowcharts (layered layout with subgraphs, every node shape and link kind), sequence, class, state and ER diagrams, gantt, pie, xy and quadrant charts, timelines, mindmaps and user journeys. A ```` ```mermaid ```` block becomes a figure that can be captioned, labelled and referenced. Labels are set in Computer Modern Sans and measured with the real font; Mermaid themes and `themeVariables` apply, and `diagram-theme` sets them for the whole document. Mistakes are error DIAG001 with the document line, a hint and often a fix.
- TikZ and pgfplots drawn by texwright's own interpreter, in the common subset: paths, nodes and shapes, styles, `\foreach`, `positioning`, `calc`, `automata`, `angles`, `fit`, decorations and shading, and `axis` with `\addplot` from coordinates, expressions and tables, bars, legends and log axes. Node text uses the document's math. A `tikzpicture` in a `figure` takes its caption; ```` ```tikz ```` blocks work in Markdown. Features drawn approximately or skipped are warning TIKZ001.
- Wider LaTeX, measured on a stress corpus of 30 documents in the forms models write them (`test/latex-stress/`): `report`, `book`, `memoir`, moderncv, IEEEtran, revtex, amsart, elsarticle, llncs, KOMA-Script and authblk title pages, algorithm2e, cancel, mathtools' `cases*` and `\prescript`, braket, threeparttable, `\makecell`, glossaries and acronym, todonotes, mdframed, lipsum, xparse, `\ifthenelse` and many smaller commands; beamer and chemfig approximated with info LTX007. `\multirow` cells keep their column in PDF tables, `\noindent` is honoured, and centred text stays centred across `\\`.
- Faster to start: the package is one bundled file loaded with Node's compile cache, so a command starts in about 200 ms, and the MCP server keeps a warm worker so repeated tool calls take 15 to 20 ms.
- Fixed: an IEEEtran `	hanks` after `\` in the title put its mark on a line of its own.

## 0.1.0

First release.

- Markdown (CommonMark plus GitHub tables and pandoc extensions), a LaTeX article subset, and a JSON document tree as input; LaTeX and Markdown can be mixed in one file.
- PDF from texwright's own typesetting engine (no TeX, no browser, no runtime dependencies): Knuth–Plass line breaking, a TeX-style page builder with footnotes at the foot of the page and floating figures, subset fonts, links, bookmarks and reproducible output with `SOURCE_DATE_EPOCH`. Standalone HTML, and the numbered document tree as JSON.
- Math typeset by TeX's rules (Appendix G of *The TeXbook*) in PDF and as MathML in HTML, with LaTeX numbering: per-row numbers in `align` and `gather`, `\nonumber`, `\tag`, `multline`, `alignat`, `eqnarray`, `\newcommand` and `\DeclareMathOperator`.
- SVG figures drawn as vectors by texwright's own SVG renderer; PNG and JPEG embedded.
- Text in Latin Modern with ligatures and kerning, subset OpenType (CFF) embedding, and hyphenation with TeX's US English patterns.
- Layout from the document: `papersize`, `geometry`, `margin`, `fontsize`, `theme`, `landscape`, `page-numbers`, `header` and `footer` in front matter, or `\documentclass` and geometry options in LaTeX. Authors may carry affiliations (pandoc/Quarto-style author objects).
- Numbered sections (with appendix letters), figures and subfigures, tables, listings and theorems with shared counters and `\newtheorem[section]` numbering; `@fig:x`, `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`.
- Citations from BibTeX or CSL-JSON in numeric or author-year style.
- A table of contents and `\pageref` with exact page numbers from repeated layout passes.
- Structured diagnostics with stable codes, positions, excerpts and fix hints; `--diagnostics json` and `--diagnostics compact`; `texwright check` for validation in milliseconds.
- Machine-applicable fixes on diagnostics (`{line, col, old, new, safe}`) for undefined labels, unknown citation keys, misspelt math commands and near-miss image names; `texwright check --fix` applies the safe ones.
- `texwright outline`: headings, figures, tables, equations, theorems, listings and citations with lines, labels and reference counts.
- An MCP server with `render_document`, `check_document`, `fix_document`, `outline_document`, `get_schema`, `get_guide` and `new_document`.
- Templates (`texwright new paper|report|homework|notes|cv|letter|memo|proposal`), a one-page cheat sheet (`texwright guide --short`), and `max-pages`, which tightens margins and then the body size until a PDF fits.
- Written for what language models actually produce, measured on a benchmark of documents models wrote for a PDF (`npm run bench`):
  - siunitx, mhchem and physics commands, `\bm`, `\mathbbm` and `\nicefrac` without loading anything; conventional shorthands such as `\R` and `\argmax` read the usual way with an info note
  - `thebibliography`, `algorithm` and `algorithmic`, the `letter` and `exam` classes, `\qedhere`, `tikzcd` (approximate), `\includesvg`, counters, `\iffalse` and `\newif`, `\rule`, `\hrulefill`, size switches, `center` and `flushright`, `\DeclarePairedDelimiter`, `\texorpdfstring`, `\ref` inside formulas
  - pandoc habits: `header-includes` macros, `numbersections`, a closing `# References` heading
  - fixes for likely typos in front-matter keys (OPT002) and LaTeX command names (LTX001); a math command in running text is typeset as math (LTX006)
- Page previews: `texwright preview` and the MCP tool `preview_page` draw the PDF's pages as PNG with texwright's own rasterizer (glyph outlines from the fonts, vector figures, images), and a PDF render reports the page each heading, figure, table and equation landed on.
- More of what models write: tcolorbox boxes, `\DeclareSIUnit`, `\DeclarePairedDelimiterX`, `\hfill`, `\parindent`, colours, size switches, run-in `\paragraph` headings, siunitx `S` table columns, exam bonus questions, fontawesome icons (left out quietly), pandoc's `^sup^` and `~sub~`, money amounts beside `$` math, and bold-label lines in Markdown.
- Fixed: the slash of `\neq` and other overlays was drawn beside the symbol in PDF; tables with an X column beside a natural-width column ran into the margin.
- SVG figures drawn as a browser draws them: linear and radial gradients (every spread method, stop opacity) as PDF shadings, opacity on the paint or as a transparency group, masks as soft masks, `mix-blend-mode`, pattern fills tile by tile, stroked and gradient-filled text, text on a path, text decorations, HTML labels in `foreignObject` (Mermaid's, draw.io's), clip paths made of text, `image-rendering: pixelated`, and CSS attribute selectors, structural pseudo-classes, sibling combinators and `:not()`. Filters (blur, drop shadow, offset, flood, composite, merge, blend, colour matrix, component transfer, morphology, and the CSS filter functions) run on pixels from texwright's own rasterizer; a shadow becomes an image under the element, which stays vector. Named fonts such as Georgia or Arial Black use the installed font when there is one. Checked against Chrome on a suite of 30 figures (`scripts/svg-compare.mjs`, also through poppler for the PDF).
- Page previews draw gradients, opacity, groups, soft masks and blend modes, and can be transparent.
- Safe by default: sanitized raw HTML, nothing fetched from the network, images, `\input` files and bibliographies only from the document's folder (symlinks resolved, network paths refused before any file access).
- Hardened against hostile documents: linear-time parsers with caps on macro, math, YAML alias, footnote and BibTeX expansion; a fuzzing and performance test suite; per-request time limits and a workspace root for the MCP server.
- Three themes: article, modern, compact.
