# Writing documents for texwright

texwright turns Markdown, LaTeX or a JSON document tree into PDF or HTML with its own TeX-style engine: equations, figures, tables, sections and theorems are numbered, references and citations are resolved, and footnotes go to the foot of their page. No TeX installation or browser is involved. This guide is for anyone writing documents for it, people and AI agents alike.

## The loop

1. Write the document (Markdown is usually easiest; LaTeX works too, and the two can be mixed).
2. Run `texwright check doc.md --diagnostics compact` (or the `check_document` MCP tool with `compact: true`). It runs every stage except page layout, in milliseconds, and prints one line per problem: `doc.md:3:5 E REF001 Reference to undefined label "sec:intr" | Did you mean "sec:intro"? | fix "sec:intr" -> "sec:intro" safe`. `--diagnostics json` gives the same as objects.
3. Many problems carry a fix: replace `old` with `new` at or after that line and column, which is exactly an edit. Fixes marked `safe` (unambiguous typos in labels, citation keys, math commands, image names) can be applied in one go: `texwright check doc.md --fix` (or `fix_document`). Fix the rest by hand and check again.
4. When `ok` is true, render: `texwright doc.md -o doc.pdf` (or `render_document`). The result says which page each heading, figure and table landed on.
5. Look at it: `texwright preview doc.md --page 2` writes `doc-p2.png` (or `preview_page`, which returns the images). Check what diagnostics cannot: a table that is too wide, a figure on the wrong page, text that runs together.

In a long document, `texwright outline doc.md` (or `outline_document`) lists headings, figures, tables, equations, theorems and listings with their numbers, labels, source lines and how often each is referenced, plus every cited key: read that instead of the whole file to find where to edit, or to spot a figure nobody references.

Errors stop a clean build; warnings don't (unless `--strict`). A render with errors still writes a best-effort PDF and exits 1, so judge success by the exit code (or `ok` in JSON), not by whether the file exists. Codes are stable, so you can act on them by code. `texwright codes` lists them all, and `texwright --version --json` shows exactly which build is running (install folder and code hash), which settles any doubt that an upgrade took effect.

## Watch and repair

`texwright watch doc.md -o doc.pdf` keeps one process warm and renders again whenever the document or any file it uses changes; an edit redoes only the layout it touched, so a save reaches the PDF in about a tenth of a second. `texwright repair doc.md` (or `repair_document`) is the loop above in one call: it applies safe fixes until none is left, renders when the document is clean, and returns a short report of what it fixed, what is left with each fix, and where things landed. Prefer it when you would otherwise call check, fix and render in turn.

A render also reports what a reader would notice: LAY004 (a float placed more than two pages after its first reference), LAY005 (a widow or orphan, info), LAY006 (a table, image or display wider than the column), A11Y001 (an image with neither alt text nor caption), A11Y002 (text contrast below 4.5:1) and MD002 (a `$` that never closes). Justified text uses microtype's protrusion and expansion by default; `microtype: false` turns them off.

## Markdown

```markdown
---
title: Heat flow in thin plates
author: [Ada Lovelace, Alan Turing]
date: today
abstract: |
  One paragraph of abstract. Markdown and $math$ work here.
bibliography: refs.bib
citation-style: numeric        # or author-year
number-sections: true
toc: true
macros:
  R: \mathbb{R}
  norm: '\left\lVert #1 \right\rVert'   # quote bodies with #: YAML reads " #" as a comment
---

# Introduction {#sec:intro}

Inline math $E = mc^2$ and display math:

$$ \int_0^1 f(x)\,dx = F(1) - F(0) $$ {#eq:ftc}

Numbered environments work as in LaTeX, one number per row:

\begin{align}
  a &= b + c \label{eq:first} \\
  d &= e     \nonumber \\
  f &= g     \label{eq:second}
\end{align}

See @eq:ftc, \eqref{eq:first}, @fig:plot, @tbl:data and @sec:intro.
Cite with [@doe2020], [@doe2020, p. 4; @roe2019], @doe2020 says..., or \cite{doe2020}.

![Temperature over time.](plot.png){#fig:plot width=70%}

| Year | Value |
|-----:|------:|
| 2024 | 1.5   |

Table: Measurements by year. {#tbl:data}

::: {.theorem #thm:main title="Uniqueness"}
The solution is unique.
:::

::: proof
Suppose two solutions exist...
:::

::: warning
Callouts: note, tip, important, warning, caution.
:::

A footnote.[^1]

[^1]: The note text.

\newpage
```

Rules worth knowing:

- A paragraph that is only an image becomes a numbered figure; its alt text is the caption.
- `$` needs a non-space right after it and right before the closing `$`, so "$5 and $10" stays text.
- Labels use prefixes: `sec:`, `fig:`, `tbl:`, `eq:`, `thm:`, `lst:`. `@fig:plot` prints "Figure 2"; `\ref{fig:plot}` prints "2"; `\eqref{eq:x}` prints "(3)"; `\pageref{x}` prints the page (PDF only).
- `{-}` or `{.unnumbered}` after a heading leaves it unnumbered.
- Code blocks are highlighted by language: ```` ```python ````. A caption: ```` ```{.python #lst:fit caption="Fitting"} ````.
- Raw LaTeX inside Markdown is converted: `\textbf{}`, `\begin{table}...\end{table}`, `\newcommand` and so on.
- Raw HTML is sanitized (no scripts or styles) unless `--unsafe-html`.
- pandoc habits work: `\newcommand` lines in `header-includes` become macros, `numbersections: true` numbers sections, a closing `# References` heading receives the bibliography, and `H~2~O` and `x^2^` are sub- and superscripts. Lines that each start with a bold label (`**Date:** ...` over `**Time:** ...`) keep their line breaks. Amounts of money such as "$3.78 per visitor versus $3.41" stay text. A front-matter key one or two letters away from a known one (`bibliograpy`) is warning OPT002 with a fix; keys of other tools pass quietly.

## Diagrams

A ```` ```mermaid ```` block is drawn by texwright itself, in milliseconds, with no browser: flowchart (and graph), sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, pie, xychart-beta, quadrantChart, timeline, mindmap and journey, in Mermaid's own syntax.

````markdown
```{.mermaid #fig:flow caption="Request handling"}
flowchart LR
  client([Client]) --> api[API] -->|query| db[(Database)]
```
````

With a caption or `#fig:` label it becomes a numbered figure (`@fig:flow`). The theme comes from the diagram's front matter or `%%{init: {"theme": "neutral"}}%%` (default, neutral, forest, dark, plus `themeVariables`); `diagram-theme: neutral` in the document's front matter sets every diagram. A mistake is error DIAG001 at its line in the document, with a hint and often a fix (`flowchat` -> `flowchart`, `3 days` -> `3d`). Diagram text is plain or Markdown-string labels, not math. For figures that need math in the labels, use TikZ.

## Layout and authors

Set layout in the document itself; there is no template to edit. The keys are pandoc's:

```yaml
---
author:
  - name: Thomas Garren
    affiliation: Sophia XT      # or a list; or one shared `affiliation:` / `institute:` key
papersize: a4                   # letter (default), a4, a5, legal, b5
geometry: margin=2cm            # or top=..., bottom=..., left=..., right=...; also `margin: 1in`
fontsize: 12pt                  # every size and skip of the theme scales with it
theme: modern                   # article (default, LaTeX look), modern, compact
landscape: false
page-numbers: right             # center, right, none
header: Draft                   # running head, top right
footer: Internal                # bottom left
mainfont: Inter                 # body face; sansfont and monofont likewise
---
```

In LaTeX, `\documentclass[12pt,a4paper]{article}` and `\usepackage[margin=2cm]{geometry}` do the same. Command-line flags and MCP arguments win over the document. Bad values are OPT001 with a hint.

Brand fonts: `mainfont` sets the body face, `sansfont` the sans face (headings in the modern theme, and its body when there is no `mainfont`), `monofont` code. A value is a family name, found first among font files next to the document or in a `fonts/` folder and then among installed fonts; a file (`mainfont: fonts/Brand-Regular.ttf`, whose `-Bold`, `-Italic` and `-BoldItalic` siblings are found by name); or `{regular: a.ttf, bold: b.ttf, italic: c.ttf, bolditalic: d.ttf}`. TrueType, OpenType, WOFF and WOFF2 files all work, so Google Fonts files can be used as downloaded. In LaTeX, fontspec's `\setmainfont{Brand}[Path=fonts/, BoldFont=Brand-Bold.ttf]`, `\setsansfont` and `\setmonofont` do the same. PDF and HTML both embed the faces. A font that cannot be found or read, lies outside the document's folder, or forbids embedding is FONT002, and the theme's face is kept.

## LaTeX

Write a normal article. Supported: `\documentclass` and `\usepackage` (ignored), `\title`, `\author` with `\and`, `\date`, `\maketitle`, `abstract`, `\tableofcontents`, `\section` to `\paragraph` and starred forms, `\appendix`, `\label`, `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`, `\cite`, `\citep`, `\citet`, `\citeauthor`, `\citeyear`, `\nocite`, `\footnote`, text styles, `\url`, `\href`, `itemize`, `enumerate`, `description`, `quote`, `verbatim`, `lstlisting`, `minted`, `figure` with `\includegraphics`, `\caption` and `subfigure`, `table` with `tabular` (booktabs rules, `\multicolumn`, `\multirow`), `equation`, `align`, `gather`, `multline`, `alignat` and starred forms, `\newcommand`, `\DeclareMathOperator`, `\newtheorem` and `proof`, `\input` and `\include`, `\bibliography` and `\printbibliography`, `thebibliography` with `\bibitem`, `algorithm` with `algorithmic` (algpseudocode's `\State`, `\If`, `\For`, `\Require` ... and the older `\STATE`, `\IF`), the `letter` class (`\address`, `\opening`, `\closing`, `\signature`, `\encl`), the `exam` class (`questions`, `parts`, `choices`, bonus questions, `solution` shown with `\printanswers`, `\gradetable`, `\numquestions`, `\numpoints`, `\numpages`), `tcolorbox` and `\newtcolorbox` (drawn as a coloured box with its title), `center` and `flushright`, `\hfill`, `\setlength{\parindent}`, colours (`\textcolor`, `\color`, `\definecolor`, `blue!60!black`), size switches (`\Large`), `\DeclareSIUnit`, `\DeclarePairedDelimiterX`, `\includesvg`, `\rule`, `\hrule`, `\hrulefill`, counters (`\newcounter`, `\stepcounter`, `\theX`, `\arabic`), `\iftrue`/`\iffalse`/`\newif` conditionals, `\DeclarePairedDelimiter`, `\texorpdfstring`, and siunitx and mhchem commands in running text. Classes and packages beyond the article: `report`, `book` and `memoir` (`\chapter`, `\part`, `\frontmatter` and `\mainmatter`), the title pages of IEEEtran (`\IEEEauthorblockN` and `\IEEEauthorblockA`), revtex and amsart (`\affiliation`, `\address`, `\email`), elsarticle, llncs (`\inst`, `\institute`) and authblk (`\author[1]`, `\affil`), moderncv (`\cventry`, `\cvitem`, `\makecvtitle`), KOMA-Script (`\minisec`, `labeling`), algorithm2e (`\KwIn`, `\For`, `\eIf`, `\;`, `\SetKwFunction` ...), threeparttable notes, `\makecell`, `\crefrange`, `\subref`, minted's `listing`, mdframed, framed and shaded boxes, todonotes, `\marginpar` and `\sidenote` (set as footnotes), `\epigraph`, `displayquote`, glossaries and acronym (`\gls`, `\ac`, `\printglossaries`), lipsum and blindtext, xparse's `\NewDocumentCommand`, `\ifthenelse`, `\ifdefined`, `\xspace`, `\MakeUppercase`, soul and ulem underlines, pifont's `\ding`, and enumitem's `resume`. Two are approximations reported once as info LTX007: beamer (each frame title becomes a heading and overlays show at once) and chemfig (a chain is set as its formula; a structure with rings is shown as source). titlesec, fancyhdr and similar styling commands are accepted and ignored.

Drawings are drawn by texwright itself, into vector figures; a picture in a `figure` takes its caption and label, and ```` ```tikz ```` blocks work in Markdown:

- TikZ: `\draw`, `\fill`, `\node`, `\coordinate`, `\foreach`, scopes and `/.style` styles, arrows, `positioning`, `calc`, shapes, `automata`, `angles`, `fit`, braces, decorations and shading. Node text uses the document's math, and `\si`, `\SI`, `\num` and `\ce` work in it.
- Trees and graphs: TikZ trees (`\node {root} child {node {a}} child[missing]` with `grow`, `level distance`, `sibling distance`, `level n/.style`, `edge from parent node[...]`, `edge from parent fork down`), mind maps (`mindmap`, `concept`, `concept color`), `\begin{forest} [S [NP] [VP]] \end{forest}` with forest's packed layout (`for tree`, `where n children=0`, `tier`, `edge label`, `roof`, `forked edges`, `folder`), and `\graph { a -> {b, c} -> d; }` with `layered layout`, `tree layout`, `spring layout`, `circular placement` and `subgraph K_n`.
- pgfplots: `axis` with `\addplot` from coordinates, expressions and tables, legends, bars, log axes and `fill between`; in 3D, `\addplot3` with `surf`, `mesh`, `scatter`, `quiver`, `patch` and `contour gnuplot`, `shader=flat|interp|faceted`, `view={az}{el}`, `colormap/viridis` (jet, hot, cool, plasma ...), `colorbar` and `point meta` (surfaces are capped at 100 x 100 samples). tikz-3dplot's `\tdplotsetmaincoords` and `tdplot_main_coords` work.
- circuitikz: `\begin{circuitikz} \draw (0,0) to[V, v=$V_s$] (0,3) to[R=$R_1$, i=$i$] (3,3) to[C=$C$, *-o] (3,0) -- (0,0); \end{circuitikz}` with circuitikz's sizes. Labels `l=`, `a=`, `v=`, `i=`, `f=` and their side and direction forms, poles `*-*` and `o-o`, `name=`, `invert`, `mirror`. Resistors, capacitors, inductors, diodes, sources, batteries, switches, lamps, fuses and meters; `op amp` (`.+ .- .out`), `npn`/`pnp` (`.B .C .E`), MOSFETs (`.G .D .S`), `transformer`, grounds, `vcc`/`vee`, logic ports (`.in 1 .out`) and flip-flops; american or european styles from `\ctikzset` or the package options. A component texwright doesn't know is drawn as a labelled box.
- PSTricks: `pspicture` with `\psset`, `\psline`, `\pspolygon`, `\psframe`, `\pscircle`, `\psarc`, `\psdots`, `\pscurve`, `\pscustom`, `\rput`, `\uput`, `\multido`, fill styles and arrows; pst-plot (`\psaxes`, `\psplot` with PostScript code such as `x 2 exp` or `[algebraic]`, `\psparametricplot`, `\listplot`, `\fileplot`), pst-node (`\rnode`, `\cnode`, `\ncline`, `\ncarc`, `\naput`), pst-tree (`\pstree`), and basic pst-eucl, pst-3dplot and pst-coil. Not `psmatrix`.

What a drawing package draws approximately or skips is warning TIKZ001 (PST001 for PSTricks), and the rest is still drawn; when nothing at all can be drawn the error is LTX004 (render the figure to SVG or PNG and include it). `tikzcd` diagrams are drawn approximately, as a grid with straight arrows (info MATH004). Unknown commands give warning LTX001, keep their text, and offer the nearest known command as a fix. A math command in running text (`\alpha` without `$`) is typeset as math with info LTX006.

## Math

texwright typesets math itself, by TeX's rules. Supported: what `amsmath` and `amssymb` provide, including `\frac`, `\dfrac`, `\binom`, `\sqrt[n]`, `\left`/`\middle`/`\right`, `\big` to `\Bigg`, accents and `\overbrace`/`\underbrace`, `\mathbb`, `\mathcal`, `\mathfrak`, `\mathscr`, `\boldsymbol` and `\bm`, `\text`, `\operatorname`, `\xrightarrow`, `\overset`/`\underset`/`\substack`, `\color`, `\boxed`, the matrix environments, `cases`, `array`, `aligned`, `gathered`, `split`, and the display environments `equation`, `align`, `gather`, `multline`, `alignat`, `flalign`, `eqnarray` with their starred forms (`\intertext` works in `align`).

Package commands work without loading anything: siunitx (`\SI`, `\si`, `\num`, `\qty`, `\unit`, `\ang`, `\SIrange`, `\SIlist`), mhchem (`\ce{2H2 + O2 -> 2H2O}`, `\pu`), physics (`\dv`, `\pdv`, `\dd`, `\abs`, `\norm`, `\qty`, `\bra`, `\ket`, `\braket`, `\ketbra`, `\expval`, `\mel`, `\comm`, `\vb`, `\vu`, `\grad`, `\curl`, `\order`, `\eval`, `\mqty`, `\pmqty`, `\imat`), amsthm's `\qedhere`, `\bm`, `\mathbbm`, `\nicefrac`, and `\ref`/`\eqref` inside formulas. Your own definitions always win. Conventional shorthands nobody defined (`\R`, `\N`, `\E`, `\Var`, `\argmax`, `\sgn` ...) are read the usual way with info MATH003; define them to choose otherwise.

Define macros in front matter (`macros:`) or with `\newcommand`, `\renewcommand`, `\def` or `\DeclareMathOperator`; optional arguments work. cancel's `\cancel`, `\bcancel`, `\xcancel` and `\cancelto`, mathtools' `cases*` and `\prescript`, the braket package and units' `\unitfrac` work too. Not supported: `\sideset`, `\multicolumn` inside arrays and `\verb`.

## JSON

Emit the document tree directly when that is easier than text: `texwright schema` prints the JSON Schema. Minimal example:

```json
{"texwright": 1, "meta": {"title": [{"t": "Text", "text": "Notes"}]},
 "blocks": [
   {"t": "Heading", "level": 1, "numbered": true, "content": [{"t": "Text", "text": "Result"}], "label": "sec:result"},
   {"t": "Para", "content": [{"t": "Text", "text": "We have "}, {"t": "Math", "tex": "a^2+b^2=c^2"}, {"t": "Text", "text": "."}]},
   {"t": "MathBlock", "tex": "e^{i\\pi}+1=0", "numbered": true, "label": "eq:euler"}
 ]}
```

`texwright doc.md -o doc.json` shows how any Markdown or LaTeX document maps to the tree.

## Diagnostics you will meet most

| Code | Meaning | Usual fix |
|---|---|---|
| MATH001 | Formula doesn't parse | Read the hint; balance braces; define unknown macros |
| REF001 | Reference to an undefined label | The hint lists the closest existing labels |
| REF002 | Label defined twice | Rename one |
| CITE001 | Citation key not in the bibliography | The hint lists the closest keys |
| CITE002 | Citations but no bibliography | Add `bibliography: refs.bib` |
| IMG001 | Image not found or outside the document folder | Fix the path, or `--allow-path` |
| IMG003 | PDF figure or remote image the PDF engine can't embed | Export the figure as SVG or PNG next to the document |
| LAY001 | A line sticks into the margin, or a table cell into the next column | Usually a long URL, word or formula: shorten it or allow a break |
| TBL001 | A table row has more cells than the table has columns | Remove the extra cell, or add the column to the spec or header |
| FONT001 | No available font has a character | Use another character, or install a font that has it |
| LTX001 | Unsupported LaTeX command | Rewrite it, or define it with `\newcommand` |
| LTX004 | A drawing texwright cannot draw at all | Pre-render the figure as an image |
| DIAG001 | A Mermaid diagram couldn't be read | Read the hint; apply the fix if one is offered |
| DIAG002 | A code block meant as a diagram is shown as code (fence language misspelt or missing) | Apply the fix, or write ```` ```mermaid ```` |
| TIKZ001 | TikZ, pgfplots, forest or circuitikz feature drawn approximately or skipped | Read the message; rewrite that part with supported commands |
| PST001 | PSTricks feature drawn approximately or left out | Rewrite that part with supported commands |
| OPT001 | A front matter or option value texwright can't use | The hint lists the accepted values |
| OPT002 | Unknown front-matter key that looks like a typo | Apply the fix |
| MATH003 | (info) An undefined shorthand such as `\R` was read the usual way | Nothing, or define it |

## Options that matter

`--to pdf|html|json`, `--theme article|modern|compact`, `--toc`, `-N`, `--paper a4`, `--bibliography refs.bib`, `--citation-style author-year`, `--diagnostics json`, `--strict`. Images load only from the document's folder. Nothing is fetched from the network: remote images are left out of PDF output, and kept as links in HTML only with `--allow-net`.
