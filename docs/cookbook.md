---
title: "The texwright visual cookbook"
subtitle: "Working mathematics, diagrams, and cross-references"
author: [Sophia, Xe5, Thomas Garren]
date: "Version 0.3.4"
theme: article
papersize: a4
page-numbers: right
geometry: margin=2cm
fontsize: 11pt
number-sections: true
header: "texwright / Visual cookbook"
footer: "Every figure on these pages is rendered by texwright"
diagram-theme: neutral
---

# Mathematics with a reference {#sec:math}

For the illustrative sequence $a_n = 2^{-n}$, the first $N$ terms satisfy

$$ \sum_{n=1}^{N} 2^{-n} = 1 - 2^{-N}. $$ {#eq:sum}

Equation \eqref{eq:sum} approaches one as $N$ increases. References remain correct if another numbered equation is inserted earlier.

| Terms $N$ | Partial sum | Remaining gap |
|--:|--:|--:|
| 1 | 0.5000 | 0.5000 |
| 2 | 0.7500 | 0.2500 |
| 3 | 0.8750 | 0.1250 |
| 4 | 0.9375 | 0.0625 |

Table: Exact values from the geometric series, rounded to four places. {#tbl:sums}

## Plot the same relationship

The plot in @fig:series is authored as TikZ and pgfplots text. There is no external chart image or TeX process.

~~~{.tikz #fig:series caption="Partial sums approach one."}
\begin{tikzpicture}
\begin{axis}[width=11cm,height=5cm,xlabel={Terms},ylabel={Partial sum},xmin=1,xmax=6,ymin=0,ymax=1]
\addplot[blue,thick,mark=*] coordinates {(1,0.5) (2,0.75) (3,0.875) (4,0.9375) (5,0.96875) (6,0.984375)};
\end{axis}
\end{tikzpicture}
~~~

These numbers are mathematical examples, not performance measurements. Open this document's Markdown source to copy the formula, table, and plot.

\newpage

# Diagrams from readable source {#sec:diagrams}

A diagram can live beside the prose that explains it. @fig:sequence describes the calls an agent makes when producing a document.

~~~{.mermaid #fig:sequence caption="An agent requests a check, a render, and a page preview."}
sequenceDiagram
  participant Agent
  participant texwright
  Agent->>texwright: check_document
  texwright-->>Agent: diagnostics and fixes
  Agent->>texwright: render_document
  texwright-->>Agent: output path and placement
  Agent->>texwright: preview_page
  texwright-->>Agent: page images
~~~

## A useful delivery checklist

1. Keep the Markdown or LaTeX source with the PDF.
2. Include the referenced figures and bibliography.
3. Check diagnostics after the final edit.
4. Inspect the pages containing tables, mathematics, and figures.
5. Deliver an HTML version when searchable web text is useful.

::: tip
This cookbook is its own example. Run the commands below from a built repository to reproduce the PDF and inspect page two.
:::

~~~sh
node dist/cli.mjs check docs/cookbook.md --diagnostics compact
node dist/cli.mjs docs/cookbook.md -o docs/cookbook.pdf
node dist/cli.mjs preview docs/cookbook.md --page 2
~~~

For citations and theorem environments, continue with the [research showcase](https://github.com/Chorozion/texwright/blob/main/examples/showcase/showcase.md). For a larger drawing collection, see the [diagram examples](https://github.com/Chorozion/texwright/blob/main/examples/diagrams/diagrams.md).

All three guides, their HTML editions, reference schemas, and selected page images can be regenerated together with npm run docs.
