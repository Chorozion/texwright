---
title: "texwright"
subtitle: "Technical documents, from an agent's first draft to the finished page"
author: [Sophia, Xe5, Thomas Garren]
date: "Version 0.3.4"
theme: modern
papersize: a4
page-numbers: right
geometry: margin=2cm
fontsize: 11pt
number-sections: true
header: "texwright / Project overview"
footer: "SOPHIA XT LLC"
diagram-theme: neutral
---

# A document engine for AI workflows {#sec:purpose}

Write Markdown, LaTeX, or a structured JSON document. texwright resolves its equations, references, citations, figures, and footnotes, then writes a PDF or self-contained HTML file using its own typesetting engine.

The same program checks the draft, suggests precise edits, and draws page previews. An agent can inspect both the source and the finished layout.

~~~{.mermaid #fig:loop caption="The document workflow, rendered by texwright."}
flowchart LR
  draft[Write] --> check[Check and repair]
  check --> render[Render]
  render --> inspect[Inspect pages]
~~~

## Three ways to use it

**Command line.** Run checks, render files, or watch a document while editing.

**MCP server.** Give an agent nine tools for checking, repairing, rendering, inspecting, and creating documents.

**JavaScript library.** Call the conversion API from a Node.js application.

::: note
Node.js 20 or later is required. Rendering needs no TeX installation, browser, or runtime npm dependencies. Building from source uses development dependencies.
:::

\newpage

# What the engine handles {#sec:features}

| Document need | texwright support |
|:--|:--|
| Technical writing | Sections, theorem environments, proofs, footnotes |
| Mathematics | TeX-style math layout, aligned equations, matrices |
| Navigation | Numbered objects, cross-references, page references |
| Research | BibTeX or CSL-JSON; numeric or author-year citations |
| Figures | SVG, PNG, JPEG; diagrams authored as text |
| Drawing languages | Mermaid, TikZ, pgfplots, forest, circuitikz, PSTricks |
| Page design | Three themes, brand fonts, margins, running heads |
| Automation | CLI, JavaScript API, stdio MCP, structured diagnostics |

Table: Capabilities available in this source version. {#tbl:features}

## From meaning to pages

Readers build a shared document tree. Numbering and citation passes resolve relationships before the layout engine arranges paragraphs, mathematics, floats, and footnotes. The PDF writer embeds subset fonts; HTML carries MathML and embedded assets.

~~~{.mermaid #fig:engine caption="The shared document pipeline."}
flowchart TD
  inputs[Markdown / LaTeX / JSON] --> ast[Document tree]
  ast --> refs[Numbering and citations]
  refs --> layout[Typesetting and layout]
  layout --> pdf[PDF and page previews]
  refs --> html[HTML and JSON]
~~~

## Where it fits

Use texwright for research notes, engineering reports, educational handouts, proposals, and agent-produced technical documents. Its bounded interpreters support documented subsets of drawing languages; it is not a drop-in replacement for every LaTeX package.

\newpage

# Start from this repository {#sec:start}

Build the checked-out source with Node.js 20 or later:

~~~sh
git clone https://github.com/Chorozion/texwright.git
cd texwright
npm ci
npm run build
node dist/cli.mjs new report -o report.md
node dist/cli.mjs check report.md --diagnostics compact
node dist/cli.mjs report.md -o report.pdf
node dist/cli.mjs preview report.md --page 1
~~~

The repository is the installation source for this version. The unscoped npm package was not publicly available when these guides were prepared; do not assume an npm registry release exists.

## Use diagnostics as the contract

A successful check verifies the document before page layout. A render can still reveal an overflowing table, delayed figure, or missing glyph. Read the exit status and diagnostics, then inspect the page image. The presence of a PDF alone does not establish success.

## Known boundaries

- English hyphenation is bundled. Complex shaping and right-to-left scripts are not supported.
- PDF output is not yet tagged for screen readers.
- Remote images are not embedded in PDF. Keep SVG, PNG, or JPEG assets with the source.
- Unsupported drawing features may be approximated with diagnostics.
- Image and include access is restricted to the document folder unless explicitly widened.

## Read next

[Agent integration guide](https://github.com/Chorozion/texwright/blob/main/docs/agent-guide.md): MCP setup, tool selection, repair loops, and error handling.

[Visual cookbook](https://github.com/Chorozion/texwright/blob/main/docs/cookbook.md): equations, references, tables, Mermaid, and TikZ in working documents.

[Full writing reference](https://github.com/Chorozion/texwright/blob/main/AGENTS.md): supported syntax and diagnostic codes.

[Architecture](https://github.com/Chorozion/texwright/blob/main/DESIGN.md): implementation details and module boundaries.

**Contributors:** Sophia, Xe5, and Thomas Garren (SOPHIA XT LLC).
