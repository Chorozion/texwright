import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Block, Document, Inline } from "../src/ast.js";
import type { Diagnostic } from "../src/diagnostics.js";
import { convert } from "../src/index.js";
import { memoryContext } from "../src/parse/context.js";
import { parseMarkdown } from "../src/parse/markdown.js";

interface Parsed {
  doc: Document;
  blocks: Block[];
  diags: Diagnostic[];
}

function parse(src: string, opts: { file?: string; lineOffset?: number } = {}): Parsed {
  const ctx = memoryContext({}, opts.file);
  if (opts.lineOffset !== undefined) ctx.lineOffset = opts.lineOffset;
  const doc = parseMarkdown(src, ctx);
  return { doc, blocks: doc.blocks, diags: ctx.diagnostics.items };
}

/** Deep copy without `pos`, for structural comparisons. */
function noPos<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === "pos" ? undefined : v)));
}

type B<K extends Block["t"]> = Extract<Block, { t: K }>;
type I<K extends Inline["t"]> = Extract<Inline, { t: K }>;

function block<K extends Block["t"]>(b: Block | undefined, t: K): B<K> {
  assert.ok(b, `expected a ${t} block`);
  assert.equal(b.t, t);
  return b as B<K>;
}

/** Inlines of the only paragraph (Para or Plain) in `src`. */
function inlines(src: string): Inline[] {
  const { blocks } = parse(src);
  assert.equal(blocks.length, 1, `expected one block, got ${JSON.stringify(noPos(blocks))}`);
  const b = blocks[0];
  assert.ok(b.t === "Para" || b.t === "Plain", `expected a paragraph, got ${b.t}`);
  return b.content;
}

function find<K extends Inline["t"]>(list: Inline[], t: K): I<K>[] {
  return list.filter((n): n is I<K> => n.t === t);
}

describe("front matter", () => {
  it("maps known keys onto meta and keeps unknown ones in extra", () => {
    const src = [
      "---",
      "title: A **bold** title",
      "subtitle: Sub",
      "date: 2026-10-06",
      "author:",
      "  - Ann Lee",
      "  - name: Bob Roe",
      "    affiliation: Uni",
      "keywords: alpha, beta",
      "lang: en-GB",
      "bibliography: refs.bib",
      "citation-style: author-year",
      "macros:",
      "  R: \\mathbb{R}",
      "  \\N: \\mathbb{N}",
      "toc: true",
      "toc-depth: 2",
      "number-sections: false",
      "number-within: section",
      "custom: 42",
      "---",
      "Body.",
    ].join("\n");
    const { doc, diags } = parse(src);
    assert.deepEqual(diags, []);
    const m = noPos(doc.meta);
    assert.deepEqual(m.title, [{ t: "Text", text: "A " }, { t: "Strong", content: [{ t: "Text", text: "bold" }] }, { t: "Text", text: " title" }]);
    assert.deepEqual(m.subtitle, [{ t: "Text", text: "Sub" }]);
    assert.deepEqual(m.date, [{ t: "Text", text: "2026-10-06" }]);
    assert.deepEqual(m.author, [[{ t: "Text", text: "Ann Lee" }], [{ t: "Text", text: "Bob Roe" }]]);
    assert.deepEqual(m.keywords, ["alpha", "beta"]);
    assert.equal(m.lang, "en-GB");
    assert.deepEqual(m.bibliography, ["refs.bib"]);
    assert.equal(m.citationStyle, "author-year");
    assert.deepEqual(m.macros, { "\\R": "\\mathbb{R}", "\\N": "\\mathbb{N}" });
    assert.equal(m.toc, true);
    assert.equal(m.tocDepth, 2);
    assert.equal(m.numberSections, false);
    assert.equal(m.numberWithin, 1);
    assert.deepEqual(m.extra, { custom: 42 });
    assert.deepEqual(noPos(doc.blocks), [{ t: "Para", content: [{ t: "Text", text: "Body." }] }]);
  });

  it("parses the abstract as Markdown blocks and accepts a single author string", () => {
    const { doc } = parse("---\nauthor: Solo Author\nabstract: |\n  We show $x$.\n\n  Second paragraph.\n---\n");
    assert.deepEqual(noPos(doc.meta.author), [[{ t: "Text", text: "Solo Author" }]]);
    const abstract = doc.meta.abstract ?? [];
    assert.equal(abstract.length, 2);
    const first = block(abstract[0], "Para");
    assert.equal(find(first.content, "Math")[0].tex, "x");
  });

  it("reports bad YAML as YAML001 at the right line and still parses the body", () => {
    const src = "---\ntitle: ok\n  bad: indentation\n---\n# Body\n";
    const { doc, blocks, diags } = parse(src, { file: "doc.md" });
    assert.equal(diags.length, 1);
    assert.equal(diags[0].code, "YAML001");
    assert.equal(diags[0].severity, "error");
    assert.equal(diags[0].line, 3);
    assert.equal(diags[0].file, "doc.md");
    assert.deepEqual(doc.meta, {});
    const h = block(blocks[0], "Heading");
    assert.equal(h.pos?.line, 5);
  });

  it("warns about invalid option values without failing", () => {
    const { doc, diags } = parse("---\ncitation-style: chicago\ntoc: maybe\n---\nText\n");
    assert.deepEqual(diags.map((d) => [d.code, d.severity, d.line]), [
      ["OPT001", "warning", 2],
      ["OPT001", "warning", 3],
    ]);
    assert.equal(doc.meta.citationStyle, undefined);
    assert.equal(doc.meta.toc, undefined);
  });

  it("keeps a __proto__ key as data", () => {
    const extra = parse("---\n__proto__: {polluted: 1}\n---\n").doc.meta.extra ?? {};
    assert.deepEqual(Object.keys(extra), ["__proto__"]);
    assert.equal(Object.getPrototypeOf(extra), Object.prototype);
  });

  it("warns when front matter is never closed", () => {
    const { diags } = parse("---\ntitle: x\n\nBody\n");
    assert.equal(diags[0]?.code, "MD001");
  });
});

describe("math", () => {
  it("recognises $...$ and \\(...\\) inline", () => {
    const content = inlines(String.raw`Let $x^2$ and \(y_1\) be.`);
    assert.deepEqual(find(content, "Math").map((m) => m.tex), ["x^2", "y_1"]);
  });

  it("leaves dollar amounts alone", () => {
    assert.deepEqual(noPos(inlines("It costs $5 and $10 today.")), [{ t: "Text", text: "It costs $5 and $10 today." }]);
    assert.deepEqual(noPos(inlines("Then $x$5 is not math.")), [{ t: "Text", text: "Then $x$5 is not math." }]);
  });

  it("treats \\$ as a literal dollar, inside and outside math", () => {
    const content = inlines(String.raw`Pay \$3 for $a\$b$.`);
    assert.equal((content[0] as I<"Text">).text, "Pay $3 for ");
    assert.equal(find(content, "Math")[0].tex, String.raw`a\$b`);
  });

  it("does not let emphasis or typography touch math", () => {
    const content = inlines("Here $a_1 * b_2 * c_3 -- d$ is fine.");
    assert.equal(find(content, "Math")[0].tex, "a_1 * b_2 * c_3 -- d");
    assert.equal(find(content, "Emph").length, 0);
  });

  it("never finds math inside inline code", () => {
    const content = inlines("Use `$$x$$` and `$y$` literally.");
    assert.deepEqual(find(content, "Code").map((c) => c.text), ["$$x$$", "$y$"]);
    assert.equal(find(content, "Math").length, 0);
  });

  it("parses $$ display math on its own lines with a label", () => {
    const { blocks } = parse("Before\n$$\nE = mc^2\n$$ {#eq:energy}\nafter.");
    assert.deepEqual(noPos(blocks), [
      { t: "Para", content: [{ t: "Text", text: "Before" }] },
      { t: "MathBlock", tex: "\nE = mc^2\n", numbered: true, label: "eq:energy", id: "eq-energy" },
      { t: "Para", content: [{ t: "Text", text: "after." }] },
    ]);
  });

  it("splits a paragraph around display math written inline", () => {
    const { blocks } = parse(String.raw`Text $$a+b$$ middle \[c\] end.`);
    assert.deepEqual(
      noPos(blocks).map((b) => (b.t === "MathBlock" ? `math:${b.tex}` : b.t === "Para" ? `para:${(b.content[0] as I<"Text">).text}` : b.t)),
      ["para:Text", "math:a+b", "para:middle", "math:c", "para:end."],
    );
    assert.equal(block(blocks[1], "MathBlock").numbered, false);
  });

  it("numbers \\[ \\] and $$ only when labelled", () => {
    const { blocks } = parse(String.raw`$$ x \label{eq:in} $$` + "\n\n" + String.raw`\[ y \]`);
    const [a, b] = [block(blocks[0], "MathBlock"), block(blocks[1], "MathBlock")];
    assert.equal(a.numbered, true);
    assert.equal(a.label, "eq:in");
    assert.equal(b.numbered, false);
    assert.equal(b.env, undefined);
  });

  it("recognises math environments and keeps every \\label in the body", () => {
    const src = String.raw`\begin{align}
a &= b \label{eq:first}\\
c &= d \label{eq:second}
\end{align}`;
    const m = block(parse(src).blocks[0], "MathBlock");
    assert.equal(m.env, "align");
    assert.equal(m.numbered, true);
    assert.equal(m.label, "eq:first");
    assert.ok(m.tex.includes(String.raw`\label{eq:first}`) && m.tex.includes(String.raw`\label{eq:second}`));
    assert.equal(m.tex, "\n" + String.raw`a &= b \label{eq:first}\\` + "\n" + String.raw`c &= d \label{eq:second}` + "\n");
  });

  it("leaves starred environments unnumbered and splits paragraphs around environments", () => {
    const { blocks } = parse(String.raw`We have
\begin{gather*}
x = 1
\end{gather*}
where x is one.`);
    assert.deepEqual(blocks.map((b) => b.t), ["Para", "MathBlock", "Para"]);
    const m = block(blocks[1], "MathBlock");
    assert.equal(m.env, "gather*");
    assert.equal(m.numbered, false);
  });

  it("keeps block-level syntax inside display math", () => {
    const m = block(parse("$$\n- a + b\n# not a heading\n$$").blocks[0], "MathBlock");
    assert.equal(m.tex, "\n- a + b\n# not a heading\n");
  });

  it("warns about unclosed $$ and environments, keeping the text", () => {
    const { blocks, diags } = parse("Start $$ never closed\n\n" + String.raw`\begin{equation}` + "\nx = 1\n", { file: "m.md" });
    assert.deepEqual(diags.map((d) => [d.code, d.line, d.col]), [
      ["MD001", 1, 7],
      ["MD001", 3, 1],
    ]);
    assert.equal((block(blocks[0], "Para").content[0] as I<"Text">).text, "Start $$ never closed");
    assert.equal((block(blocks[1], "Para").content[0] as I<"Text">).text, String.raw`\begin{equation}`);
  });

  it("labels display math written inside a paragraph", () => {
    const m = block(parse("Text $$x$$ {#eq:a} more.").blocks[1], "MathBlock");
    assert.equal(m.label, "eq:a");
    assert.equal(m.numbered, true);
  });

  it("keeps an empty $$ $$ pair as text without a warning", () => {
    const { blocks, diags } = parse("a $$ $$ b");
    assert.deepEqual(noPos(blocks), [{ t: "Para", content: [{ t: "Text", text: "a $$ $$ b" }] }]);
    assert.deepEqual(diags, []);
  });

  it("does not pair a stray $$ with one inside inline code", () => {
    const { blocks, diags } = parse("Stray $$ and `$$` code.");
    assert.equal(diags.length, 1);
    assert.deepEqual(find(block(blocks[0], "Para").content, "Code").map((c) => c.text), ["$$"]);
  });
});

describe("cross-references", () => {
  it("turns @prefix:label into Ref and stops before sentence punctuation", () => {
    const content = inlines("See @fig:plot. Then @tbl:a, @tab:b; @eq:c-d and @sec:intro! Also @lst:x @thm:y @lem:z @def:w @cor:v @prop:u @app:t.");
    assert.deepEqual(
      find(content, "Ref").map((r) => r.label),
      ["fig:plot", "tbl:a", "tab:b", "eq:c-d", "sec:intro", "lst:x", "thm:y", "lem:z", "def:w", "cor:v", "prop:u", "app:t"],
    );
    assert.ok(find(content, "Ref").every((r) => r.style === "auto"));
    assert.equal((content[content.length - 1] as I<"Text">).text, ".");
  });

  it("handles bracketed references as refs separated by text", () => {
    assert.deepEqual(noPos(inlines("In [@fig:a; @fig:b].")), [
      { t: "Text", text: "In " },
      { t: "Ref", label: "fig:a", style: "auto" },
      { t: "Text", text: ", " },
      { t: "Ref", label: "fig:b", style: "auto" },
      { t: "Text", text: "." },
    ]);
  });

  it("maps the LaTeX \\ref family to styles", () => {
    const content = inlines(String.raw`\ref{a} \eqref{b} \pageref{c} \autoref{d} \cref{e} \Cref{f}`);
    assert.deepEqual(
      find(content, "Ref").map((r) => [r.label, r.style]),
      [["a", "number"], ["b", "eq"], ["c", "page"], ["d", "auto"]],
    );
    // \cref and \Cref become cleveref groups, written out after numbering.
    const groups = find(content, "Span").filter((s) => s.attr.classes?.includes("tw-cref"));
    assert.deepEqual(
      groups.map((g) => [g.attr.classes?.includes("tw-cref-cap"), g.content.map((r) => (r.t === "Ref" ? r.label : ""))]),
      [
        [false, ["e"]],
        [true, ["f"]],
      ],
    );
  });

  it("writes \\cref groups the way cleveref does", async () => {
    const src = String.raw`See \cref{eq:b,eq:a}, \cref{eq:a}, \Cref{eq:a,eq:b,eq:c} and \cref{fig:x,eq:c,fig:y}.

$$a$$ {#eq:a}

$$b$$ {#eq:b}

$$c$$ {#eq:c}

![X](x.png){#fig:x}

![Y](y.png){#fig:y}
`;
    const html = (await convert({ source: src, from: "markdown", to: "html" })).data as string;
    const text = /See (.*?)<\/p>/s.exec(html)![1]!.replace(/<[^>]+>/g, "").replace(/ /g, " ");
    assert.equal(text, "eqs. (1) and (2), eq. (1), Equations (1) to (3) and figs. 1 and 2 and eq. (3).");
  });

  it("accepts a capitalized pandoc-crossref prefix", () => {
    assert.equal(find(inlines("@Fig:plot shows it."), "Ref")[0].label, "fig:plot");
  });
});

describe("citations", () => {
  it("parses bracketed citations with prefixes, locators and suffixes", () => {
    const [cite] = find(inlines("As shown [see @doe2020, p. 4; also @roe2019, ch. 2, and elsewhere]."), "Cite");
    assert.equal(cite.mode, "paren");
    assert.deepEqual(cite.items, [
      { key: "doe2020", prefix: "see", locator: "p. 4" },
      { key: "roe2019", prefix: "also", locator: "ch. 2", suffix: "and elsewhere" },
    ]);
  });

  it("supports year-only, in-text and multi-key forms", () => {
    const content = inlines("[-@doe2020] and @roe2019 [pp. 3-5] and [@a; @b].");
    const cites = find(content, "Cite");
    assert.deepEqual(noPos(cites), [
      { t: "Cite", items: [{ key: "doe2020" }], mode: "year" },
      { t: "Cite", items: [{ key: "roe2019", locator: "pp. 3-5" }], mode: "text" },
      { t: "Cite", items: [{ key: "a" }, { key: "b" }], mode: "paren" },
    ]);
  });

  it("does not treat email addresses or links as citations", () => {
    const content = inlines("Mail doe@example.com or [me](mailto:me@x.org).");
    assert.equal(find(content, "Cite").length, 0);
    assert.deepEqual(find(content, "Link").map((l) => l.url), ["mailto:doe@example.com", "mailto:me@x.org"]);
  });

  it("maps the LaTeX \\cite family, with optional notes", () => {
    const content = inlines(String.raw`\cite{a,b} \citep[p.~4]{c} \citep[see][ch.~2]{d} \citet{e} \citeauthor{f} \citeyear{g} \nocite{h}`);
    assert.deepEqual(noPos(find(content, "Cite")), [
      { t: "Cite", items: [{ key: "a" }, { key: "b" }], mode: "paren" },
      { t: "Cite", items: [{ key: "c", locator: "p. 4" }], mode: "paren" },
      { t: "Cite", items: [{ key: "d", prefix: "see", locator: "ch. 2" }], mode: "paren" },
      { t: "Cite", items: [{ key: "e" }], mode: "text" },
      { t: "Cite", items: [{ key: "f" }], mode: "author" },
      { t: "Cite", items: [{ key: "g" }], mode: "year" },
      { t: "Cite", items: [{ key: "h" }], mode: "nocite" },
    ]);
  });
});

describe("labels", () => {
  it("attaches \\label to the enclosing heading, theorem, figure or table", () => {
    const src = [
      String.raw`# Intro \label{sec:intro}`,
      "",
      "::: lemma",
      String.raw`Statement. \label{lem:x}`,
      ":::",
      "",
      String.raw`![Cap](a.png)\label{fig:viaLabel}`,
      "",
      String.raw`| a \label{tbl:cell} |`,
      "|---|",
      "| 1 |",
    ].join("\n");
    const { blocks } = parse(src);
    const h = block(blocks[0], "Heading");
    assert.equal(h.label, "sec:intro");
    assert.equal(h.id, "sec-intro");
    assert.deepEqual(noPos(h.content), [{ t: "Text", text: "Intro" }]);
    const thm = block(blocks[1], "Theorem");
    assert.equal(thm.label, "lem:x");
    assert.deepEqual(noPos(thm.blocks), [{ t: "Para", content: [{ t: "Text", text: "Statement." }] }]);
    assert.equal(block(blocks[2], "Figure").label, "fig:viaLabel");
    assert.equal(block(blocks[3], "Table").label, "tbl:cell");
  });

  it("keeps a label with nothing to attach to as an empty Span", () => {
    const content = inlines(String.raw`Loose \label{here} text.`);
    assert.deepEqual(noPos(content), [
      { t: "Text", text: "Loose " },
      { t: "Span", attr: { id: "here" }, content: [] },
      { t: "Text", text: " text." },
    ]);
  });
});

describe("attributes and headings", () => {
  it("reads a label from {#sec:intro}", () => {
    const h = block(parse("# Introduction {#sec:intro}").blocks[0], "Heading");
    assert.deepEqual(noPos(h), { t: "Heading", level: 1, content: [{ t: "Text", text: "Introduction" }], numbered: true, label: "sec:intro", id: "sec-intro" });
  });

  it("handles {-}, .unnumbered, plain ids and other attributes", () => {
    const { blocks } = parse('## A {-}\n\n### B {.unnumbered .wide key="two words"}\n\n# C {#custom}');
    const [a, b, c] = blocks.map((x) => block(x, "Heading"));
    assert.equal(a.numbered, false);
    assert.equal(b.numbered, false);
    assert.deepEqual(b.attr, { classes: ["unnumbered", "wide"], attrs: { key: "two words" } });
    assert.equal(c.id, "custom");
    assert.equal(c.label, undefined);
  });

  it("gives duplicate headings unique ids", () => {
    const { blocks } = parse("# Results\n\n## Results\n\n# Other {#results-2}\n\n# Results");
    assert.deepEqual(blocks.map((b) => block(b, "Heading").id), ["results", "results-1", "results-2", "results-3"]);
  });

  it("does not treat braces in heading text as attributes", () => {
    const h = block(parse("# The set {a, b}").blocks[0], "Heading");
    assert.deepEqual(noPos(h.content), [{ t: "Text", text: "The set {a, b}" }]);
  });
});

describe("images and figures", () => {
  it("makes a lone image a numbered figure captioned by its alt text", () => {
    const fig = block(parse('![Energy *vs* time](plot.png "Plot"){width=60% height=4cm #fig:plot .wide}').blocks[0], "Figure");
    assert.equal(fig.label, "fig:plot");
    assert.equal(fig.id, "fig-plot");
    assert.equal(fig.numbered, true);
    assert.deepEqual(noPos(fig.caption), [{ t: "Text", text: "Energy " }, { t: "Emph", content: [{ t: "Text", text: "vs" }] }, { t: "Text", text: " time" }]);
    const img = block(fig.content[0], "Plain").content[0] as I<"Image">;
    assert.equal(img.src, "plot.png");
    assert.equal(img.title, "Plot");
    assert.equal(img.width, "60%");
    assert.equal(img.height, "4cm");
    assert.deepEqual(img.attr, { classes: ["wide"] });
  });

  it("leaves figures without a caption or with .unnumbered unnumbered", () => {
    const { blocks } = parse("![](a.png){#fig:nocap}\n\n![Cap](b.png){.unnumbered}");
    assert.equal(block(blocks[0], "Figure").numbered, false);
    assert.equal(block(blocks[1], "Figure").numbered, false);
  });

  it("keeps an image among text inline", () => {
    const content = inlines("See ![icon](i.png){width=1em} here.");
    const img = find(content, "Image")[0];
    assert.equal(img.width, "1em");
    assert.equal(content.length, 3);
  });
});

describe("tables", () => {
  it("reads alignment, head and body", () => {
    const table = block(parse("| a | b | c |\n|:--|:-:|--:|\n| 1 | *2* | 3 |").blocks[0], "Table");
    assert.deepEqual(table.align, ["left", "center", "right"]);
    assert.deepEqual(noPos(table.head), [[{ content: [{ t: "Text", text: "a" }] }, { content: [{ t: "Text", text: "b" }] }, { content: [{ t: "Text", text: "c" }] }]]);
    assert.deepEqual(noPos(table.body[0][1].content), [{ t: "Emph", content: [{ t: "Text", text: "2" }] }]);
  });

  it("takes a caption from the paragraph after the table", () => {
    const { blocks } = parse("| a |\n|---|\n| 1 |\n\nTable: Results by year {#tbl:results}");
    assert.equal(blocks.length, 1);
    const table = block(blocks[0], "Table");
    assert.deepEqual(noPos(table.caption), [{ t: "Text", text: "Results by year" }]);
    assert.equal(table.label, "tbl:results");
    assert.equal(table.id, "tbl-results");
  });

  it("takes a caption from a bare-colon paragraph before the table", () => {
    const { blocks } = parse(": Before *it* {#tbl:b}\n\n| a |\n|---|\n| 1 |\n\nText.");
    assert.deepEqual(blocks.map((b) => b.t), ["Table", "Para"]);
    const table = block(blocks[0], "Table");
    assert.equal(table.label, "tbl:b");
    assert.equal(find(table.caption ?? [], "Emph").length, 1);
  });

  it("takes a caption line that directly follows the last row", () => {
    const table = block(parse("| a |\n|---|\n| 1 |\nTable: Tight").blocks[0], "Table");
    assert.equal(table.body.length, 1);
    assert.deepEqual(noPos(table.caption), [{ t: "Text", text: "Tight" }]);
  });

  it("keeps a stray caption as text and warns", () => {
    const { blocks, diags } = parse("Table: lonely\n\nText.");
    assert.deepEqual(noPos(blocks[0]), { t: "Para", content: [{ t: "Text", text: "Table: lonely" }] });
    assert.equal(diags[0]?.code, "MD001");
  });
});

describe("fenced divs", () => {
  it("makes callouts and other classes into Divs", () => {
    const { blocks } = parse("::: note\nRemember.\n:::\n\n::: {.warning #w1 data-x=1}\nCareful.\n:::");
    assert.deepEqual(noPos(blocks), [
      { t: "Div", attr: { classes: ["note"] }, blocks: [{ t: "Para", content: [{ t: "Text", text: "Remember." }] }] },
      { t: "Div", attr: { id: "w1", classes: ["warning"], attrs: { "data-x": "1" } }, blocks: [{ t: "Para", content: [{ t: "Text", text: "Careful." }] }] },
    ]);
  });

  it("nests divs and theorem blocks", () => {
    const src = '::: {.theorem #thm:main title="Main *result*"}\nEvery $x$ works.\n\n::: proof\nTrivial.\n:::\n:::\n\n::: {.lemma .unnumbered}\nSmall.\n:::';
    const { blocks } = parse(src);
    const thm = block(blocks[0], "Theorem");
    assert.equal(thm.kind, "theorem");
    assert.equal(thm.name, "Theorem");
    assert.equal(thm.numbered, true);
    assert.equal(thm.label, "thm:main");
    assert.equal(thm.id, "thm-main");
    assert.deepEqual(noPos(thm.title), [{ t: "Text", text: "Main " }, { t: "Emph", content: [{ t: "Text", text: "result" }] }]);
    const proof = block(thm.blocks[1], "Theorem");
    assert.equal(proof.kind, "proof");
    assert.equal(proof.numbered, false);
    assert.equal(block(blocks[1], "Theorem").numbered, false);
  });

  it("nests plain divs and ignores ::: inside code", () => {
    const { blocks } = parse("::: outer\n::: inner\nText\n:::\n```\n:::\n```\n:::\nafter");
    const outer = block(blocks[0], "Div");
    assert.equal(block(outer.blocks[0], "Div").attr.classes?.[0], "inner");
    assert.equal(block(outer.blocks[1], "CodeBlock").text, ":::");
    assert.equal(block(blocks[1], "Para").t, "Para");
  });

  it("moves an abstract div into meta and turns #refs into a Bibliography", () => {
    const { doc } = parse("::: abstract\nWe find things.\n:::\n\nBody.\n\n::: {#refs}\n:::");
    assert.deepEqual(noPos(doc.meta.abstract), [{ t: "Para", content: [{ t: "Text", text: "We find things." }] }]);
    assert.deepEqual(noPos(doc.blocks), [{ t: "Para", content: [{ t: "Text", text: "Body." }] }, { t: "Bibliography" }]);
  });

  it("warns about an unclosed div and closes it at the end", () => {
    const { blocks, diags } = parse("Intro\n\n::: note\nInside.");
    assert.equal(block(blocks[1], "Div").blocks.length, 1);
    assert.deepEqual(diags.map((d) => [d.code, d.line]), [["MD001", 3]]);
  });
});

describe("footnotes", () => {
  it("places note bodies at their references", () => {
    const content = inlines("Claim[^1] and inline^[Quick *note*.].\n\n[^1]: The source, see $x$.");
    const notes = find(content, "Note");
    assert.equal(notes.length, 2);
    const first = block(notes[0].blocks[0], "Para");
    assert.equal(find(first.content, "Math")[0].tex, "x");
    assert.equal(find(block(notes[1].blocks[0], "Para").content, "Emph").length, 1);
  });

  it("works inside list items", () => {
    const list = block(parse("- Item with note[^n].\n- Other\n\n[^n]: In a list.").blocks[0], "List");
    const notes = find(block(list.items[0][0], "Plain").content, "Note");
    assert.deepEqual(noPos(notes[0].blocks), [{ t: "Para", content: [{ t: "Text", text: "In a list." }] }]);
  });

  it("repeats a note referenced twice and drops unused definitions", () => {
    const { blocks } = parse("A[^a] and B[^a].\n\n[^a]: Same note.\n\n[^b]: Never used.");
    assert.equal(blocks.length, 1);
    const notes = find(block(blocks[0], "Para").content, "Note");
    assert.equal(notes.length, 2);
    assert.deepEqual(noPos(notes[0].blocks), noPos(notes[1].blocks));
    assert.notEqual(notes[0].blocks, notes[1].blocks);
  });

  it("warns about a missing footnote and keeps the text", () => {
    const { blocks, diags } = parse("Text[^gone] here.");
    assert.deepEqual(noPos(blocks), [{ t: "Para", content: [{ t: "Text", text: "Text[^gone] here." }] }]);
    assert.equal(diags[0].code, "MD001");
    assert.equal(diags[0].col, 5);
  });
});

describe("lists", () => {
  it("reads task lists, start numbers and tightness", () => {
    const { blocks } = parse("- [ ] todo\n- [x] done\n- plain\n\n3. three\n4. four\n\n- loose\n\n- list");
    const tasks = block(blocks[0], "List");
    assert.deepEqual(tasks.task, [false, true, null]);
    assert.deepEqual(noPos(tasks.items[0]), [{ t: "Plain", content: [{ t: "Text", text: "todo" }] }]);
    assert.equal(tasks.tight, true);
    const ordered = block(blocks[1], "List");
    assert.equal(ordered.ordered, true);
    assert.equal(ordered.start, 3);
    const loose = block(blocks[2], "List");
    assert.equal(loose.tight, false);
    assert.equal(loose.items[0][0].t, "Para");
  });

  it("reads definition lists", () => {
    const dl = block(parse("Term\n: Definition one\n\nOther *term*\n: Two").blocks[0], "DefList");
    assert.equal(dl.items.length, 2);
    assert.deepEqual(noPos(dl.items[0]), { term: [{ t: "Text", text: "Term" }], defs: [[{ t: "Plain", content: [{ t: "Text", text: "Definition one" }] }]] });
  });
});

describe("special lines", () => {
  it("recognises page breaks, table of contents and bibliography markers", () => {
    const src = ["\\newpage", "\\pagebreak", "\\clearpage", "[[toc]]", "[TOC]", "\\tableofcontents", "\\printbibliography", "[[bibliography]]"].join("\n\n");
    assert.deepEqual(parse(src).blocks.map((b) => b.t), ["PageBreak", "PageBreak", "PageBreak", "TOC", "TOC", "TOC", "Bibliography", "Bibliography"]);
  });

  it("interrupts a paragraph", () => {
    assert.deepEqual(parse("One\n\\newpage\nTwo").blocks.map((b) => b.t), ["Para", "PageBreak", "Para"]);
  });
});

describe("raw LaTeX", () => {
  it("keeps a whole environment as one RawBlock, counting nested ones", () => {
    const src = String.raw`\begin{figure}
\begin{center}
\includegraphics{x.png}
\end{center}
\end{figure}
After.`;
    const { blocks } = parse(src);
    assert.deepEqual(noPos(blocks), [
      { t: "RawBlock", format: "latex", text: String.raw`\begin{figure}` + "\n" + String.raw`\begin{center}` + "\n" + String.raw`\includegraphics{x.png}` + "\n" + String.raw`\end{center}` + "\n" + String.raw`\end{figure}` },
      { t: "Para", content: [{ t: "Text", text: "After." }] },
    ]);
  });

  it("captures inline commands with their arguments", () => {
    const content = inlines(String.raw`Some \textbf{bold {nested}} and \SI{3}{\metre}, \LaTeX\ and \section*{x}.`);
    assert.deepEqual(find(content, "RawInline").map((r) => r.text), [String.raw`\textbf{bold {nested}}`, String.raw`\SI{3}{\metre}`, String.raw`\LaTeX`, String.raw`\section*{x}`]);
    assert.ok(find(content, "RawInline").every((r) => r.format === "latex"));
  });

  it("treats command names that collide with Object properties as raw LaTeX", () => {
    const raw = find(inlines(String.raw`\constructor{x} and \toString.`), "RawInline");
    assert.deepEqual(raw.map((r) => r.text), [String.raw`\constructor{x}`, String.raw`\toString`]);
  });

  it("keeps CommonMark escapes", () => {
    assert.deepEqual(noPos(inlines(String.raw`\*a\* \_b\_ \# \\ \[c`)), [{ t: "Text", text: String.raw`*a* _b_ # \ [c` }]);
  });

  it("turns a paragraph of only LaTeX commands into a RawBlock", () => {
    assert.deepEqual(noPos(parse(String.raw`\section{Intro}\label{sec:i}`).blocks), [{ t: "RawBlock", format: "latex", text: String.raw`\section{Intro}\label{sec:i}` }]);
  });
});

describe("raw HTML, code and inline text", () => {
  it("keeps HTML blocks and inline HTML raw", () => {
    const { blocks } = parse("<div class=\"x\">\nhi\n</div>\n\nA <b>bold</b> word.");
    assert.deepEqual(noPos(blocks[0]), { t: "RawBlock", format: "html", text: '<div class="x">\nhi\n</div>' });
    assert.deepEqual(find(block(blocks[1], "Para").content, "RawInline").map((r) => [r.format, r.text]), [["html", "<b>"], ["html", "</b>"]]);
  });

  it("reads code blocks with languages and attributes, and never parses inside code", () => {
    const src = "```{.python #lst:code .numberLines}\nprint('$x$ @fig:a \\ref{b}')\n```\n\n```js {#lst:two}\nx\n```\n\n    indented $x$";
    const { blocks } = parse(src);
    assert.deepEqual(noPos(blocks), [
      { t: "CodeBlock", text: "print('$x$ @fig:a \\ref{b}')", lang: "python", attr: { id: "lst:code", classes: ["numberLines"] } },
      { t: "CodeBlock", text: "x", lang: "js", attr: { id: "lst:two" } },
      { t: "CodeBlock", text: "indented $x$" },
    ]);
    assert.deepEqual(noPos(inlines("Run `\\cite{x} @doe $y$` now.")), [{ t: "Text", text: "Run " }, { t: "Code", text: "\\cite{x} @doe $y$" }, { t: "Text", text: " now." }]);
  });

  it("applies typography, decodes entities, merges text and keeps breaks", () => {
    assert.deepEqual(noPos(inlines('"Quoted" -- and... &amp; &copy;  \nnext\nline ~~gone~~')), [
      { t: "Text", text: "\u201cQuoted\u201d \u2013 and\u2026 & \u00a9" },
      { t: "LineBreak" },
      { t: "Text", text: "next" },
      { t: "SoftBreak" },
      { t: "Text", text: "line " },
      { t: "Strike", content: [{ t: "Text", text: "gone" }] },
    ]);
  });

  it("reads links and autolinks", () => {
    const links = find(inlines('[site](https://x.org "Title") and <https://auto.org>'), "Link");
    assert.deepEqual(noPos(links), [
      { t: "Link", url: "https://x.org", title: "Title", content: [{ t: "Text", text: "site" }] },
      { t: "Link", url: "https://auto.org", content: [{ t: "Text", text: "https://auto.org" }] },
    ]);
  });
});

describe("positions", () => {
  const src = "---\ntitle: T\n---\n\n# Heading\n\nText with $x$.\n\n$$\ny\n$$\n\nBad [^none].\n";

  it("counts front matter lines for blocks, inlines and diagnostics", () => {
    const { blocks, diags } = parse(src, { file: "p.md" });
    assert.deepEqual(blocks[0].pos, { line: 5, col: 1, file: "p.md" });
    const para = block(blocks[1], "Para");
    assert.deepEqual(find(para.content, "Math")[0].pos, { line: 7, col: 11, file: "p.md" });
    assert.equal(block(blocks[2], "MathBlock").pos?.line, 9);
    assert.deepEqual(diags.map((d) => [d.line, d.col, d.file]), [[13, 5, "p.md"]]);
  });

  it("adds ctx.lineOffset", () => {
    const { blocks, diags } = parse(src, { lineOffset: 100 });
    assert.equal(blocks[0].pos?.line, 105);
    assert.equal(block(blocks[2], "MathBlock").pos?.line, 109);
    assert.equal(diags[0].line, 113);
  });

  it("finds inline positions inside lists and quotes", () => {
    const { blocks } = parse("> quoted\n> more $q$\n\n- item\n  next $r$");
    const quote = block(block(blocks[0], "BlockQuote").blocks[0], "Para");
    assert.deepEqual(find(quote.content, "Math")[0].pos, { line: 2, col: 8 });
    const item = block(block(blocks[1], "List").items[0][0], "Plain");
    assert.deepEqual(find(item.content, "Math")[0].pos, { line: 5, col: 8 });
  });

  it("keeps positions in inline notes and their paragraph apart", () => {
    const { blocks } = parse("Text ^[note $a$] and $b$.");
    const para = block(blocks[0], "Para");
    assert.deepEqual(find(para.content, "Math")[0].pos, { line: 1, col: 22 });
  });
});

// The block and inline scanners answer from indexes built once per string;
// these pin down the cases where the old line-by-line scans had quirks.
describe("scanner edge cases", () => {
  it("ends a block environment only at a line that spells \\end{name} exactly", () => {
    const spaced = parse("\\begin{foo}\nx\n\\end{ foo }\n").blocks;
    assert.deepEqual(noPos(spaced), [{ t: "RawBlock", format: "latex", text: "\\begin{foo}\nx\n\\end{ foo }" }]);
    // A later exact \end{foo} lets the block rule take the environment up to its matching end.
    const later = parse("\\begin{foo}\nx\n\\end{ foo }\ny\n\\end{foo}\n").blocks;
    assert.equal(later.length, 2);
    assert.equal(block(later[0], "RawBlock").text, "\\begin{foo}\nx\n\\end{ foo }");
    assert.deepEqual(find(block(later[1], "Para").content, "RawInline").map((r) => r.text), ["\\end{foo}"]);
  });

  it("keeps an environment inside its list item or quote", () => {
    const item = block(parse("- \\begin{foo}\n  x\n  \\end{foo}\n").blocks[0], "List");
    assert.equal(block(item.items[0][0], "RawBlock").text, "\\begin{foo}\nx\n\\end{foo}");
    const outdented = parse("- \\begin{foo}\n  x\n\\end{foo}\n").blocks;
    assert.equal(outdented[0].t, "List");
    const lazy = block(parse("> \\begin{foo}\nx\n\\end{foo}\n").blocks[0], "BlockQuote");
    assert.equal(block(lazy.blocks[0], "RawBlock").text, "\\begin{foo}\nx\n\\end{foo}");
  });

  it("reads display math that spans lines of a list item, and attributes whose value runs on", () => {
    const item = block(parse("- $$ x\n  y $$\n").blocks[0], "List");
    assert.equal(block(item.items[0][0], "MathBlock").tex, " x\ny ");
    const labelled = block(parse('$$x$$ {#eq:a title="a\nb"}\n').blocks[0], "MathBlock");
    assert.equal(labelled.label, "eq:a");
    const split = parse("$$ x\n$$ y\n").blocks;
    assert.deepEqual(split.map((b) => b.t), ["MathBlock", "Para"]);
  });

  it("reads div openers with trailing colons, and only those", () => {
    const div = block(parse("::: {.note}::::\nx\n:::\n").blocks[0], "Div");
    assert.deepEqual(div.attr.classes, ["note"]);
    assert.deepEqual(block(parse("::: warning ::::\nx\n:::\n").blocks[0], "Div").attr.classes, ["warning"]);
    assert.equal(parse(`::: a${":".repeat(50)} b\n`).blocks[0].t, "Para");
    assert.equal(parse(":::  :::\nx\n").blocks[0].t, "Para");
  });

  it("lets a run of bare caption lines stay a definition list unless a table follows each", () => {
    const blocks = parse(": cap\n: cap2\n\n| a |\n|---|\n| 1 |\n").blocks;
    assert.deepEqual(blocks.map((b) => b.t), ["DefList", "Table"]);
    const captioned = parse("Table: a\nTable: b\n\n| a |\n|---|\n").blocks;
    const table = block(captioned[captioned.length - 1], "Table");
    assert.deepEqual(table.caption, [{ t: "Text", text: "b" }]);
  });

  it("does not let blank lines inside a div loosen the list item holding it", () => {
    const list = block(parse("- ::: a\n\n\n   :::\n   x\n").blocks[0], "List");
    assert.equal(list.tight, true);
    assert.equal(block(parse("- ::: a\n\n   :::\n\n   x\n").blocks[0], "List").tight, false);
  });

  it("reads captions, terms and display math inside block quotes as at the top level", () => {
    // A `>` line is a blank line inside the quote: before a table, after a term.
    const captioned = block(block(parse("> : Cap\n>\n> | a |\n> |---|\n").blocks[0], "BlockQuote").blocks[0], "Table");
    assert.deepEqual(captioned.caption, [{ t: "Text", text: "Cap" }]);
    const defs = block(block(parse("> term\n>\n> : def\n").blocks[0], "BlockQuote").blocks[0], "DefList");
    assert.deepEqual(noPos(defs.items[0].term), [{ t: "Text", text: "term" }]);
    // An attribute value that runs on over the quote's next line still makes a display math block.
    const quote = block(parse('> $$x$$ {#eq:a title="a\n> b"}\n> c\n').blocks[0], "BlockQuote");
    assert.deepEqual(quote.blocks.map((b) => b.t), ["MathBlock", "Para"]);
    assert.equal(block(quote.blocks[0], "MathBlock").label, "eq:a");
    assert.equal(quote.blocks[1].pos?.line, 3);
    // A table on a definition's first line belongs to the definition.
    const deflist = block(parse("w\n: a | b\n  --|--\n").blocks[0], "DefList");
    assert.equal(deflist.items[0].defs[0][0].t, "Table");
  });

  it("splits bracketed citations only at top-level semicolons", () => {
    const cite = find(inlines("[see [x; y] @a, p. 4; -@b]"), "Cite");
    assert.deepEqual(noPos(cite[0].items), [{ key: "a", prefix: "see [x; y]", locator: "p. 4" }]);
    assert.equal(cite[1].mode, "year");
    // A part without a key makes the bracket text; the key inside is then an in-text citation.
    assert.deepEqual(find(inlines("[@a; x]"), "Cite").map((c) => c.mode), ["text"]);
  });
});

/** An ordinary document of about `size` characters: sections with paragraphs, lists, a table, code, math, citations and notes. */
function ordinaryDocument(size: number): string {
  const parts = ["---\ntitle: A long report\nauthor: [A. Author, B. Author]\n---\n"];
  let length = parts[0].length;
  for (let k = 0; length < size; k++) {
    const section = [
      `# Section ${k} {#sec:s${k}}\n\n`,
      `This is paragraph one of section ${k}. It has *emphasis*, **strong text**, \`inline code\`, math $x_${k}^2 + y^2 = z^2$ and a citation [@doe2020, p. ${k}].\n`,
      `It continues on a second line with a reference to @sec:s${Math.max(0, k - 1)} and to @fig:f${k}, see also @roe2019.\n\n`,
      `A second paragraph mentions "quoted words" -- with dashes... and a [link](https://example.org/page/${k}) plus a footnote.[^n${k}]\n\n`,
      `[^n${k}]: The note for section ${k}, with $a+b$.\n\n`,
      `- first item with $\\alpha$\n- second item with **bold**\n  continued line\n- third item [@a; @b]\n\n1. one\n2. two\n3. three\n\n`,
      `| Name | Value | Unit |\n|:-----|------:|:----:|\n| a${k} | ${k}.5 | m |\n| b${k} | ${2 * k} | s |\n\nTable: Values for section ${k}. {#tbl:t${k}}\n\n`,
      "```python\ndef f(x):\n    return x * " + k + "\n```\n\n",
      `$$\n\\int_0^1 f(x)\\,dx = ${k}\n$$ {#eq:e${k}}\n\n`,
      `![Figure ${k} caption](fig${k}.png){#fig:f${k} width=50%}\n\n`,
      `> A quote with _emphasis_ and \\cite{knuth1984}.\n\n`,
    ].join("");
    parts.push(section);
    length += section.length;
  }
  return parts.join("");
}

describe("limits and performance", () => {
  it("parses a 1 MB ordinary document in under a second", () => {
    parse(ordinaryDocument(64 * 1024)); // let the JIT see the code paths first, as a long-running host would
    const src = ordinaryDocument(1 << 20);
    // The better of two runs, so that a pause from another process does not decide the result.
    let best = Infinity;
    let parsed: Parsed | undefined;
    for (let attempt = 0; attempt < 2 && best >= 1000; attempt++) {
      const started = performance.now();
      parsed = parse(src);
      best = Math.min(best, performance.now() - started);
    }
    assert.ok(best < 1000, `parsing ${src.length} characters took ${Math.round(best)} ms`);
    const { blocks, diags } = parsed!;
    assert.deepEqual(diags, []);
    assert.ok(blocks.filter((b) => b.t === "Table").every((t) => block(t, "Table").label?.startsWith("tbl:")));
    assert.ok(blocks.length > 10_000);
  });

  it("caps nesting depth instead of recursing without bound", () => {
    const depth = (b: Block | undefined): number => (b && b.t === "BlockQuote" ? 1 + depth(b.blocks[0]) : 0);
    const quotes = parse("> ".repeat(5000) + "deep").blocks;
    assert.ok(depth(quotes[0]) <= 100);
    const listDepth = (b: Block | undefined): number => (b && b.t === "List" ? 1 + listDepth(b.items[0]?.[0]) : 0);
    assert.ok(listDepth(parse("- ".repeat(5000) + "deep").blocks[0]) <= 50);
  });

  it("stays linear on many unclosed raw HTML openers and brackets in one paragraph", () => {
    for (const opener of ["<!-- ", "<? ", "<!A ", "<![CDATA[ ", "[a ", "![a ", "`a`` "]) {
      const src = "x " + opener.repeat(20_000);
      const started = performance.now();
      const { blocks } = parse(src);
      const ms = performance.now() - started;
      assert.ok(ms < 1500, `${JSON.stringify(opener)} x 20,000 took ${Math.round(ms)} ms`);
      assert.equal(block(blocks[0], "Para").content.length > 0, true);
    }
  });

  it("stays linear on many link definitions, unclosed divs, and positioned nodes on one line", () => {
    const sources: Record<string, string> = {
      "80,000 link definitions": Array.from({ length: 80_000 }, (_, i) => `[l${i}]: /u${i} "t"`).join("\n"),
      "40,000 unclosed divs": "::: a\nx\n".repeat(40_000),
      "40,000 citations on one line": "[@a; @b] ".repeat(40_000),
      "40,000 inline notes on one line": Array.from({ length: 40_000 }, (_, i) => `^[n${i} *e*]`).join(" "),
      "40,000 images on one line": Array.from({ length: 40_000 }, (_, i) => `![a${i} *b*](u)`).join(" "),
    };
    for (const [name, src] of Object.entries(sources)) {
      const started = performance.now();
      parse(src);
      const ms = performance.now() - started;
      assert.ok(ms < 3000, `${name} took ${Math.round(ms)} ms`);
    }
  });
});
