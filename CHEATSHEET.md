# texwright cheat sheet

Markdown or LaTeX in, PDF or HTML out. Loop: write, `texwright check doc.md --diagnostics compact`, apply fixes (`--fix` does the safe ones), repeat until `ok`, then `texwright doc.md`. Start from a template: `texwright new paper|report|homework|notes|cv|letter|memo|proposal`.

```markdown
---
title: Title
author:
  - name: Your Name
    affiliation: Org
date: today
bibliography: refs.bib       # BibTeX or CSL-JSON
number-sections: true
toc: true
papersize: a4                # letter (default), a4, a5, legal, b5
geometry: margin=2cm
fontsize: 11pt
theme: article               # article, modern, compact
max-pages: 2                 # tighten the layout to fit
macros:
  R: \mathbb{R}
---

# Section {#sec:intro}

Inline $x^2$, display $$ E = mc^2 $$ {#eq:energy}, rows numbered in
\begin{align} a &= b \label{eq:a} \\ c &= d \nonumber \end{align}

Refs: @sec:intro, @eq:energy, \eqref{eq:a}, @fig:plot, @tbl:data, \pageref{sec:intro}.
Cite: [@key], [@a; @b, p. 4], @key says, \cite{key}.
Footnote.[^1]   [^1]: Text.

![Caption.](plot.svg){#fig:plot width=70%}

| a | b |
|---|--:|
| 1 | 2 |

Table: Caption. {#tbl:data}

::: {.theorem #thm:main title="Name"}
Statement.
:::
::: proof
Argument.
:::
::: note
Callout: note, tip, important, warning, caution.
:::
```

Labels: `sec:` `fig:` `tbl:` `eq:` `thm:` `lst:`. `{-}` after a heading leaves it unnumbered. Figures: SVG (vector) or PNG/JPEG next to the document; not PDF. Math: amsmath and amssymb, `\mathbb`, `\boldsymbol`, `\operatorname`, matrices, `cases`, `aligned`, plus siunitx (`\SI{9.8}{\meter\per\second\squared}`), mhchem (`\ce{H2O}`) and physics (`\dv{f}{x}`, `\abs{x}`, `\ket{0}`) without loading anything, and `\cancel`. TikZ, pgfplots (2D and 3D), forest, `\graph`, circuitikz and PSTricks pictures are drawn (TIKZ001 or PST001 for what is approximated), and ```` ```mermaid ```` blocks become figures (flowchart, sequence, class, state, ER, gantt, pie, xy, quadrant, timeline, mindmap, journey; errors are DIAG001). LaTeX can be mixed into Markdown; LaTeX files may use `thebibliography`, `algorithmic` or algorithm2e, the `report`, `book`, `letter`, `exam`, `moderncv`, IEEEtran, revtex, elsarticle and llncs classes, and boxes from tcolorbox, mdframed and todonotes; beamer and chemfig are approximated (info LTX007).

Diagnostics: `file:line:col E|W|I CODE message | hint | fix "old" -> "new" [safe]`. Apply a fix as an edit at that line. Common: REF001 undefined label, CITE001 unknown key, MATH001 bad formula, IMG001 missing image, LAY001 line too wide, LAY003 over max-pages, OPT001 bad option value. Long document: `texwright outline doc.md` lists sections, figures, tables and equations with line numbers. See the result: `texwright preview doc.md --page 1` writes a PNG of that page.
