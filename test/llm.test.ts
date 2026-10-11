/**
 * Tools for agents: machine-applicable fixes, `check --fix`, compact
 * diagnostics and the document outline.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { type Diagnostic, formatCompact } from "../src/diagnostics.js";
import { applyFixes, closestFix } from "../src/fixes.js";
import { check, fixDocument, outline } from "../src/index.js";

/** The command line under test: dist/src/cli.js, or another entry (the bundle's dist/cli.mjs) named by TEXWRIGHT_CLI. */
const cli = process.env.TEXWRIGHT_CLI ?? fileURLToPath(new URL("../src/cli.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "texwright-llm-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const BIB = `@book{knuth1984, author = {Knuth, Donald E.}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1984}}
@article{lamport1986, author = {Lamport, Leslie}, title = {LaTeX}, journal = {J}, year = {1986}}`;

const fixOf = (ds: Diagnostic[], code: string) => ds.find((d) => d.code === code)?.fix;

describe("fixes", () => {
  test("closestFix picks a clear winner and marks small typos safe", () => {
    assert.deepEqual(closestFix("sec:intr", ["sec:intro", "sec:results"]), { replacement: "sec:intro", safe: true });
    assert.deepEqual(closestFix("Fig:Plot", ["fig:plot", "fig:plots"]), { replacement: "fig:plot", safe: true }, "case only");
    assert.equal(closestFix("eq:a", ["eq:b", "eq:c"]), undefined, "a tie has no winner");
    assert.equal(closestFix("xyz", ["sec:intro"]), undefined, "too far");
    assert.equal(closestFix("ab", ["ac"], 1)?.safe, false, "very short words are never safe");
  });

  test("applyFixes replaces whole words at or after the position, skipping what it cannot place", () => {
    const text = "See @sec:intr and @sec:intro.\nAlso [@knuth198].\n";
    const res = applyFixes(text, [
      { line: 1, col: 5, old: "sec:intr", new: "sec:intro", safe: true },
      { line: 2, col: 6, old: "knuth198", new: "knuth1984", safe: true },
      { line: 1, col: 1, old: "nothere", new: "x", safe: true },
    ]);
    assert.equal(res.text, "See @sec:intro and @sec:intro.\nAlso [@knuth1984].\n");
    assert.equal(res.applied.length, 2);
    assert.equal(res.skipped.length, 1);
    // "sec:intr" inside "sec:intro" is not a whole word, so only the real typo changes.
    assert.equal(applyFixes("@sec:intro @sec:intr", [{ line: 1, col: 1, old: "sec:intr", new: "sec:intro", safe: true }]).text, "@sec:intro @sec:intro");
    // A full stop after a label ends the sentence, not the label.
    assert.equal(applyFixes("See @sec:intr.", [{ line: 1, col: 5, old: "sec:intr", new: "sec:intro", safe: true }]).text, "See @sec:intro.");
    // A TeX command ends at the first non-letter.
    assert.equal(applyFixes("$\\alpah_1 + \\alpahx$", [{ line: 1, col: 2, old: "\\alpah", new: "\\alpha", safe: true }]).text, "$\\alpha_1 + \\alpahx$");
  });

  test("references, citation keys and math commands carry fixes at the right place", () => {
    const res = check({
      source: "---\nbibliography: refs.bib\n---\n\n# Intro {#sec:intro}\n\nSee @sec:intr, cite [@knuth198], and $\\alpah + \\Sigmaa$.\n",
      files: { "refs.bib": BIB },
    });
    const ref = fixOf(res.diagnostics, "REF001");
    assert.ok(ref, JSON.stringify(res.diagnostics));
    assert.deepEqual({ old: ref.old, new: ref.new, safe: ref.safe, line: ref.line }, { old: "sec:intr", new: "sec:intro", safe: true, line: 7 });
    const cite = fixOf(res.diagnostics, "CITE001");
    assert.deepEqual(cite && { old: cite.old, new: cite.new, safe: cite.safe }, { old: "knuth198", new: "knuth1984", safe: true });
    const math = res.diagnostics.filter((d) => d.code === "MATH001");
    assert.ok(math.length >= 1);
    assert.deepEqual(math[0]!.fix && { old: math[0]!.fix.old, new: math[0]!.fix.new }, { old: "\\alpah", new: "\\alpha" });
  });

  test("a missing image gets a near-miss file from its folder, never one from outside", () => {
    const dir = mkdtempSync(join(tmp, "img-"));
    writeFileSync(join(dir, "plot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const res = check({ source: "![A plot.](plto.png)\n", baseDir: dir });
    const fix = fixOf(res.diagnostics, "IMG001");
    assert.deepEqual(fix && { old: fix.old, new: fix.new, safe: fix.safe }, { old: "plto.png", new: "plot.png", safe: true });
    const outside = check({ source: "![x](../elsewhere/plto.png)\n", baseDir: dir });
    assert.equal(fixOf(outside.diagnostics, "IMG001"), undefined);
  });

  test("fixDocument writes the safe fixes back and checks again", () => {
    const dir = mkdtempSync(join(tmp, "fix-"));
    writeFileSync(join(dir, "refs.bib"), BIB);
    const file = join(dir, "doc.md");
    writeFileSync(file, "---\nbibliography: refs.bib\n---\n\n# Intro {#sec:intro}\n\nSee @sec:intr and [@lamport1968].\n\n$$ \\alpah $$\n");
    const res = fixDocument({ input: file });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.applied.length, 3);
    assert.match(readFileSync(file, "utf8"), /See @sec:intro and \[@lamport1986\]\.\n\n\$\$ \\alpha \$\$/);
    // Nothing left to fix: running it again changes nothing.
    assert.equal(fixDocument({ input: file }).applied.length, 0);
  });
});

describe("compact diagnostics", () => {
  test("one line per diagnostic: place, severity letter, code, message, hint and fix", () => {
    const res = check({ source: "# Intro {#sec:intro}\n\nSee @sec:intr.\n", file: "doc.md" } as never);
    const line = formatCompact(res.diagnostics.filter((d) => d.code === "REF001"));
    assert.match(line, /^.*:3:\d+ E REF001 Reference to undefined label "sec:intr" \| Did you mean "sec:intro"\? \| fix "sec:intr" -> "sec:intro" safe$/);
    assert.equal(line.split("\n").length, 1);
  });

  test("the CLI prints compact diagnostics on stdout and applies fixes with check --fix", () => {
    const dir = mkdtempSync(join(tmp, "cli-"));
    const file = join(dir, "doc.md");
    writeFileSync(file, "# Intro {#sec:intro}\n\nSee @sec:intr.\n");
    const compact = spawnSync(process.execPath, [cli, "check", file, "--diagnostics", "compact"], { encoding: "utf8" });
    assert.equal(compact.status, 1);
    const lines = compact.stdout.trim().split("\n");
    assert.match(lines[0]!, / E REF001 /);
    assert.equal(lines.at(-1), "failed 1 error");
    const fixed = spawnSync(process.execPath, [cli, "check", file, "--fix", "--diagnostics", "json"], { encoding: "utf8" });
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    const report = JSON.parse(fixed.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.fixed.length, 1);
    assert.equal(readFileSync(file, "utf8"), "# Intro {#sec:intro}\n\nSee @sec:intro.\n");
  });
});

describe("outline", () => {
  const DOC = `---
title: Outline test
bibliography: refs.bib
---

# Intro {#sec:intro}

Text citing [@knuth1984] and @knuth1984 again.[^1]

[^1]: A note.

## Setup

![A plot.](plot.svg){#fig:plot}

| a | b |
|---|---|
| 1 | 2 |

Table: Numbers. {#tbl:nums}

\\begin{align}
a &= b \\label{eq:a} \\\\
c &= d \\label{eq:c}
\\end{align}

::: {.theorem #thm:main title="Main"}
It holds.
:::

See @fig:plot and @eq:a.
`;

  test("lists headings, figures, tables, equations and theorems in order, with lines, labels and reference counts", () => {
    const dir = mkdtempSync(join(tmp, "outline-"));
    writeFileSync(join(dir, "plot.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    writeFileSync(join(dir, "refs.bib"), BIB);
    const file = join(dir, "doc.md");
    writeFileSync(file, DOC);
    const { outline: o } = outline({ input: file });
    assert.equal(o.title, "Outline test");
    assert.deepEqual(
      o.items.map((i) => [i.kind, i.number ?? "", (i.labels ?? []).join(","), i.line, i.refs]),
      [
        ["heading", "", "sec:intro", 6, undefined],
        ["heading", "", "", 12, undefined],
        ["figure", "1", "fig:plot", 14, 1],
        ["table", "1", "tbl:nums", 16, 0],
        ["equation", "1, 2", "eq:a,eq:c", 22, 1],
        ["theorem", "1", "thm:main", 27, 0],
      ],
    );
    assert.deepEqual(o.citations.map((c) => [c.key, c.count, c.line]), [["knuth1984", 2, 8]]);
    assert.equal(o.footnotes, 1);
    assert.ok(o.words > 5);
  });

  test("the CLI prints the outline as text, or JSON with --json", () => {
    const dir = mkdtempSync(join(tmp, "outline-cli-"));
    const file = join(dir, "doc.md");
    writeFileSync(file, "# One {#sec:one}\n\n## Two\n\nSee @sec:one.\n");
    const text = spawnSync(process.execPath, [cli, "outline", file], { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^L1 One \[sec:one\]\nL3 {3}Two\n/);
    const json = JSON.parse(spawnSync(process.execPath, [cli, "outline", file, "--json"], { encoding: "utf8" }).stdout);
    assert.equal(json.items.length, 2);
  });
});

describe("templates, page limits and the cheat sheet", () => {
  test("every template checks clean and renders, and the one-page kinds fit one page", async () => {
    const { TEMPLATES, template } = await import("../src/templates.js");
    const { convert } = await import("../src/index.js");
    assert.ok(TEMPLATES.length >= 8);
    for (const t of TEMPLATES) {
      const tpl = template(t.kind)!;
      const dir = mkdtempSync(join(tmp, `tpl-${t.kind}-`));
      writeFileSync(join(dir, `${t.kind}.md`), tpl.text);
      for (const [name, text] of Object.entries(tpl.assets)) writeFileSync(join(dir, name), text);
      const res = await convert({ input: join(dir, `${t.kind}.md`), to: "pdf" });
      const problems = res.diagnostics.filter((d) => d.severity !== "info");
      assert.deepEqual(problems, [], `${t.kind}: ${JSON.stringify(problems)}`);
      if (["cv", "letter"].includes(t.kind)) assert.equal(res.stats.pages, 1, t.kind);
    }
  });

  test("texwright new writes a template and its files, and never overwrites", () => {
    const dir = mkdtempSync(join(tmp, "new-"));
    const out = join(dir, "paper.md");
    const first = spawnSync(process.execPath, [cli, "new", "paper", "-o", out], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(out, "utf8"), /^---\ntitle:/);
    assert.match(readFileSync(join(dir, "refs.bib"), "utf8"), /@book\{knuth1984/);
    const again = spawnSync(process.execPath, [cli, "new", "paper", "-o", out], { encoding: "utf8" });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /exists; pass --force/);
    const list = spawnSync(process.execPath, [cli, "new"], { encoding: "utf8" });
    assert.match(list.stdout, /^paper +Research paper/m);
    const short = spawnSync(process.execPath, [cli, "guide", "--short"], { encoding: "utf8" });
    assert.match(short.stdout, /^# texwright cheat sheet/);
    assert.ok(short.stdout.length < 6000, `cheat sheet is ${short.stdout.length} characters`);
  });

  test("max-pages tightens the layout to fit, or says how far over it is", async () => {
    const { convert } = await import("../src/index.js");
    const para = "Work history line with enough words to fill the measure of a column in this test. ".repeat(6);
    const doc = (max: number, n: number) => `---\ntitle: CV\ntheme: compact\nmax-pages: ${max}\n---\n\n${Array.from({ length: n }, (_, k) => `## Role ${k}\n\n${para}\n`).join("\n")}`;
    const plain = await convert({ source: doc(99, 9), to: "pdf" });
    assert.equal(plain.stats.pages, 2, "the test document is two pages at the theme's sizes");
    const fitted = await convert({ source: doc(1, 9), to: "pdf" });
    assert.equal(fitted.stats.pages, 1);
    const note = fitted.diagnostics.find((d) => d.code === "LAY002");
    assert.ok(note && note.severity === "info" && /Fitted to 1 page \(it was 2\)/.test(note.message), JSON.stringify(fitted.diagnostics));
    const over = await convert({ source: doc(1, 40), to: "pdf" });
    const warn = over.diagnostics.find((d) => d.code === "LAY003");
    assert.ok(warn && /over its max-pages of 1/.test(warn.message) && /Cut roughly \d+%/.test(warn.hint ?? ""), JSON.stringify(over.diagnostics));
    assert.ok(check({ source: "---\nmax-pages: zero\n---\n\nx\n" }).diagnostics.some((d) => d.code === "OPT001"));
  });
});

describe("front matter written for other tools", () => {
  test("a near miss of a known key is flagged with a fix; other tools' keys pass quietly", () => {
    const dir = mkdtempSync(join(tmp, "fm-"));
    const file = join(dir, "doc.md");
    writeFileSync(file, "---\ntitle: T\nbibliograpy: refs.bib\nnumber-section: true\nlinestretch: 1.5\ndocumentclass: article\nfavourite: tea\n---\n\nText.\n");
    const res = check({ input: file });
    const typos = res.diagnostics.filter((d) => d.code === "OPT002");
    assert.deepEqual(
      typos.map((d) => [d.line, d.fix?.old, d.fix?.new, d.fix?.safe]),
      [
        [3, "bibliograpy", "bibliography", true],
        [4, "number-section", "number-sections", true],
      ],
    );
    assert.equal(res.diagnostics.length, 2, JSON.stringify(res.diagnostics));
    const fixed = fixDocument({ input: file });
    assert.deepEqual(fixed.diagnostics.filter((d) => d.code === "OPT002"), []);
    assert.match(readFileSync(file, "utf8"), /^bibliography: refs\.bib$/m);
  });

  test("pandoc's numbersections and header-includes definitions are read", () => {
    const res = check({
      source: String.raw`---
numbersections: true
header-includes: |
  \usepackage{amsmath}
  \newcommand{\Rn}{\mathbb{R}^n}
  \DeclareMathOperator{\Tr}{Tr}
---

# A

$x \in \Rn$, $\Tr A$
`,
    });
    assert.deepEqual(res.diagnostics, []);
    assert.equal(res.document.meta.numberSections, true);
    assert.equal(res.document.meta.macros?.["\\Rn"], "\\mathbb{R}^n");
  });
});

describe("fixing in passes", () => {
  test("a problem reported once per name is fixed at every occurrence", () => {
    const dir = mkdtempSync(join(tmp, "passes-"));
    const file = join(dir, "doc.tex");
    writeFileSync(file, String.raw`\documentclass{article}
\begin{document}
\secton{One} \textbff{a} and \textbff{b}.
\secton{Two} \textbff{c}.
\end{document}
`);
    const res = fixDocument({ input: file });
    assert.ok(res.ok);
    assert.equal(res.applied.length, 5);
    assert.deepEqual(res.diagnostics, []);
    assert.doesNotMatch(readFileSync(file, "utf8"), /secton|textbff/);
  });
});

describe("looking at the result", () => {
  test("texwright preview writes PNG pages; convert reports where things landed", async () => {
    const dir = mkdtempSync(join(tmp, "preview-"));
    const file = join(dir, "doc.md");
    writeFileSync(file, "# One {#sec:one}\n\nText.\n\n\\newpage\n\n# Two\n\n$$ x = 1 $$ {#eq:x}\n");
    const run = spawnSync(process.execPath, [cli, "preview", file, "--page", "1,2", "--dpi", "40", "-q"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    for (const n of [1, 2]) {
      const png = readFileSync(join(dir, `doc-p${n}.png`));
      assert.equal(png.toString("latin1", 1, 4), "PNG");
      assert.equal(png.readUInt32BE(16), 340, "letter width at 40 dpi");
    }
    const { convert } = await import("../src/index.js");
    const res = await convert({ input: file, to: "pdf", output: join(dir, "doc.pdf") });
    assert.deepEqual(
      res.placement?.map((p) => [p.kind, p.text ?? p.label, p.page]),
      [
        ["heading", "One", 1],
        ["heading", "Two", 2],
        ["equation", "eq:x", 2],
      ],
    );
    const bad = spawnSync(process.execPath, [cli, "preview", file, "--page", "0"], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
  });
});
