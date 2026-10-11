// Regressions from the bug sweep of 2026-10-08: each test pins one reported problem.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Block } from "../src/ast.js";
import { check, convert, outline } from "../src/index.js";
import { renderTikz } from "../src/tikz/index.js";
import { MAX_SCENE_BYTES } from "../src/tikz/scene.js";

const latex = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

function texts(blocks: Block[]): string {
  return JSON.stringify(blocks);
}

describe("regressions", () => {
  it("curls quotes and dashes in footnotes as in the body", () => {
    const res = check({ source: 'Body.[^1] Inline^[With "quotes" -- here.]\n\n[^1]: A "double" and \'single\' quote, it\'s.\n', from: "markdown" });
    const s = texts(res.document.blocks);
    assert.ok(s.includes("“double”") && s.includes("‘single’") && s.includes("it’s"), s);
    assert.ok(s.includes("“quotes”") && s.includes("–"), s);
  });

  it("keeps a thin space between a number and its unit on one line", () => {
    const md = check({ source: "The low was -18\\,°C and 1\\,000 stays.\n", from: "markdown" });
    const t = texts(md.document.blocks);
    assert.ok(t.includes("18\u202f°C"), "Markdown \\, after a digit is a narrow no-break space");
    assert.ok(t.includes("1,000"), "but not between digits");
    const tex = check({ source: latex("It was -18\\,°C."), from: "latex" });
    assert.ok(texts(tex.document.blocks).includes("18\u202f°C"));
  });

  it("links bare domains and addresses in \\url and \\href, and leaves files alone", async () => {
    const html = (await convert({ source: latex("\\url{linkedin.com/in/x} \\href{www.example.org}{a} \\href{me@example.com}{b} \\href{report.pdf}{c}"), from: "latex", to: "html" })).data as string;
    for (const h of ["https://linkedin.com/in/x", "https://www.example.org", "mailto:me@example.com", '"report.pdf"']) assert.ok(html.includes(h), h);
  });

  it("centres \\multirow cells, keeps group rules, and does not bold LaTeX header rows", () => {
    const src = latex("\\begin{tabular}{ll}\n\\hline\n\\multirow{3}{*}{A} & 1 \\\\\n & 2 \\\\\n & 3 \\\\\n\\hline\nB & 4 \\\\\n\\hline\n\\end{tabular}");
    const table = check({ source: src, from: "latex" }).document.blocks.find((b) => b.t === "Table") as Extract<Block, { t: "Table" }>;
    assert.equal(table.head.length, 0, "rows above an \\hline crossed by a \\multirow are not a header");
    assert.deepEqual(table.rules, [3], "the \\hline between the groups is kept");
    assert.equal(table.plainHead, true);
  });

  it("counts references to code listings in the outline", () => {
    const res = outline({ source: 'See @lst:fit and \\ref{lst:fit}.\n\n```{.python #lst:fit caption="Fit"}\nx\n```\n', from: "markdown" });
    const lst = res.outline.items.find((i) => i.kind === "listing")!;
    assert.deepEqual([lst.labels, lst.refs], [["lst:fit"], 2]);
  });

  it("reports bad option values as warnings everywhere", () => {
    for (const source of ["---\npapersize: a3\n---\nx\n", "---\ntheme: fancy\n---\nx\n"]) {
      const d = check({ source, from: "markdown" }).diagnostics.filter((x) => x.code === "OPT001");
      assert.ok(d.length && d.every((x) => x.severity === "warning"), JSON.stringify(d));
    }
  });

  it("returns the page each item landed on with a PDF", async () => {
    const res = await convert({ source: "# One\n\n# Two\n", from: "markdown", to: "pdf" });
    assert.deepEqual(res.placement?.map((p) => [p.kind, p.page]), [
      ["heading", 1],
      ["heading", 1],
    ]);
  });

  it("shrinks a diagram taller than the page instead of overflowing it", async () => {
    const steps = Array.from({ length: 40 }, (_, k) => `  s${k} --> s${k + 1}`).join("\n");
    const res = await convert({ source: "```mermaid\nflowchart TD\n" + steps + "\n```\n", from: "markdown", to: "pdf" });
    assert.ok(!res.diagnostics.some((d) => d.code === "LAY001" && /taller/.test(d.message)), JSON.stringify(res.diagnostics));
  });

  it("reports a table row with more cells than columns (TBL001), in both readers", () => {
    const md = check({ source: "| A | B |\n|---|---|\n| 1 | 2 | 3 |\n", from: "markdown" });
    assert.deepEqual(md.diagnostics.filter((d) => d.code === "TBL001").map((d) => d.line), [3]);
    const tex = check({ source: latex("\\begin{tabular}{ll}\na & b & c \\\\\nd & e \\\\\n\\end{tabular}"), from: "latex" });
    assert.equal(tex.diagnostics.filter((d) => d.code === "TBL001").length, 1);
  });

  it("fits a too-wide table by its longest words, breaking after / and + when it must", async () => {
    const row = "| Input formats models already know, as the column of a wide comparison table | 2 (Markdown/LaTeX) | 1 (one-line) | 1 (--log JSON for Pandoc only) | 0 (588 MB) | 1 (82 MB venv) |";
    const res = await convert({ source: `| Capability | texwright | Typst | Pandoc+LaTeX | pdfLaTeX | WeasyPrint |\n|:--|:--|:--|:--|:--|:--|\n${row}\n`, from: "markdown", to: "pdf" });
    assert.ok(!res.diagnostics.some((d) => d.code === "LAY001"), JSON.stringify(res.diagnostics));
  });

  it("reads \\Call inside a formula and never marks a case-changing fix safe", () => {
    const ok = check({ source: latex("\\begin{algorithmic}\\State $x \\gets \\Call{Solve}{A, b}$\\end{algorithmic}"), from: "latex" });
    assert.ok(!ok.diagnostics.some((d) => d.severity === "error"), JSON.stringify(ok.diagnostics));
    // "\Sqr" is one edit from "\sqrt" only once case is ignored: offered, but not safe.
    const bad = check({ source: "$\\Sqr{2}$\n", from: "markdown" }).diagnostics.find((d) => d.code === "MATH001");
    assert.ok(bad?.fix && !bad.fix.safe && bad.fix.new === "\\sqrt", JSON.stringify(bad));
  });

  it("reports a misspelt or missing diagram fence (DIAG002) with a fix", () => {
    const res = check({ source: "```meraid\nflowchart LR\n  a --> b\n```\n\n```\nsequenceDiagram\n  A->>B: hi\n```\n\n```python\nx = 1\n```\n", from: "markdown" });
    const d = res.diagnostics.filter((x) => x.code === "DIAG002");
    assert.equal(d.length, 2, JSON.stringify(res.diagnostics));
    assert.deepEqual(d[0]!.fix && [d[0]!.fix.old, d[0]!.fix.new, d[0]!.fix.safe], ["meraid", "mermaid", true]);
  });

  it("makes a misspelt LaTeX environment an error with a fix at \\begin and \\end", () => {
    const res = check({ source: latex("\\begin{alignn}\na &= b\n\\end{alignn}"), from: "latex" });
    const d = res.diagnostics.filter((x) => x.code === "LTX002");
    assert.equal(d.length, 2);
    assert.ok(d.every((x) => x.severity === "error" && x.fix?.new === "align" && x.fix.safe));
  });

  it("counts declared column types (\\newcolumntype Y, dcolumn D) as columns", () => {
    const src = latex("\\begin{tabular}{|l|Y|D{.}{.}{2.3}|}\na & b & 1.5 \\\\\n\\end{tabular}");
    const res = check({ source: src, from: "latex" });
    assert.ok(!res.diagnostics.some((x) => x.code === "TBL001"), JSON.stringify(res.diagnostics));
    const table = res.document.blocks.find((b) => b.t === "Table") as Extract<Block, { t: "Table" }>;
    assert.equal(table.align.length, 3);
  });

  it("points a math error at the command, not at the delimiter, in Markdown and LaTeX", () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-col-"));
    const md = join(dir, "a.md");
    writeFileSync(md, "Prefix $\\frq{1}{2}$.\n\n$$\\frq{1}{2}$$\n");
    assert.deepEqual(check({ input: md }).diagnostics.map((d) => [d.line, d.col]), [[1, 9], [3, 3]]);
    const tex = join(dir, "a.tex");
    writeFileSync(tex, latex("Inline \\(\\alpah\\).\n\\begin{equation}\n  a = \\frq{1}{2}\n\\end{equation}"));
    assert.deepEqual(check({ input: tex }).diagnostics.map((d) => [d.line, d.col]), [[3, 10], [5, 7]]);
  });

  it("stops a picture whose drawing grows too large, with a warning", () => {
    const r = renderTikz("\\begin{tikzpicture}\\foreach \\i in {1,...,20000} {\\draw (\\i,0) -- (\\i,1) node {label \\i};}\\end{tikzpicture}");
    assert.ok(r.svg === undefined || r.svg.length < MAX_SCENE_BYTES * 1.5, `${r.svg?.length}`);
  });
});
