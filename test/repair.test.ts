/**
 * The repair loop: fixes for the mistakes agents make most (unclosed braces, \left without
 * \right, environments never ended or ended by the wrong name, broken front matter, misspelt
 * option values, extra table cells, an unclosed $), `texwright repair` and the lint codes.
 * The fuzz test injects mistakes into the benchmark documents and checks that the safe fixes
 * never leave a document worse, and restore it exactly where the mistake can be undone.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { Diagnostic } from "../src/diagnostics.js";
import { applyFixes, insertionEdit } from "../src/fixes.js";
import { check, convert, fixDocument } from "../src/index.js";
import { contrast } from "../src/lint.js";

const cli = process.env.TEXWRIGHT_CLI ?? fileURLToPath(new URL("../src/cli.js", import.meta.url));
const corpus = fileURLToPath(new URL("../../bench/corpus/", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "texwright-repair-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const B = "\\";
const latex = (body: string) => `${B}documentclass{article}\n${B}begin{document}\n${body}\n${B}end{document}\n`;
const BIB = "@book{knuth1984, author = {Knuth, Donald E.}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1984}}\n";

let n = 0;
/** Write `text` to a fresh folder (with any extra files) and return the document's path. */
function file(name: string, text: string, extra: Record<string, string> = {}): string {
  const dir = join(tmp, `d${++n}`);
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(dir, k), v);
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));

const problems = (ds: Diagnostic[]) => ds.filter((d) => d.severity !== "info");
const fixFor = (ds: Diagnostic[], code: string) => ds.find((d) => d.code === code && d.fix)?.fix;

/** The document checks with `code` and a fix of the given safety; fixing it gives `want` and a clean check. */
function repairs(name: string, broken: string, code: string, safe: boolean, want: string, extra: Record<string, string> = {}): void {
  const p = file(name, broken, extra);
  const before = check({ input: p }).diagnostics;
  const fix = fixFor(before, code);
  assert.ok(fix, `${code} with a fix expected: ${JSON.stringify(before)}`);
  assert.equal(fix.safe, safe, JSON.stringify(fix));
  if (safe) {
    const res = fixDocument({ input: p });
    assert.deepEqual(problems(res.diagnostics), [], JSON.stringify(res.diagnostics));
  } else {
    // An unsafe fix is for the agent to apply after a look: check --fix leaves it alone.
    assert.ok(!fixDocument({ input: p }).applied.some((f) => f.old === fix.old), "unsafe fix applied");
    const text = readFileSync(p, "utf8");
    writeFileSync(p, applyFixes(text, [fix]).text);
    assert.deepEqual(problems(check({ input: p }).diagnostics), [], readFileSync(p, "utf8"));
  }
  assert.equal(readFileSync(p, "utf8"), want);
}

describe("insertion edits", () => {
  test("anchor on the text before the point, or after it at the start of a line", () => {
    assert.deepEqual(insertionEdit("a = \\frac{1}{2", 14, "}"), { start: 0, old: "a = \\frac{1}{2", new: "a = \\frac{1}{2}" });
    assert.deepEqual(insertionEdit("x\n  y", 2, "!"), { start: 2, old: "  y", new: "!  y" });
  });

  test("applyFixes places an edit exactly at its column, and writes \\r\\n into files that use it", () => {
    assert.equal(applyFixes("ab{c ab{c", [{ line: 1, col: 6, old: "ab{c", new: "ab{c}", safe: true }]).text, "ab{c ab{c}");
    const crlf = "| A |\r\n|---|\r\n| 1 | 2 |\r\n";
    const res = applyFixes(crlf, [{ line: 1, col: 1, old: "| A |\n|---|", new: "| A |  |\n|---| --- |", safe: false }]);
    assert.equal(res.text, "| A |  |\r\n|---| --- |\r\n| 1 | 2 |\r\n");
  });
});

describe("fixes for unbalanced math", () => {
  test("a { never closed gets its } at the formula's end: safe for a single term, offered otherwise", () => {
    repairs("a.md", "Half is $\\frac{1}{2$ here.\n", "MATH001", true, "Half is $\\frac{1}{2}$ here.\n");
    repairs("b.md", "Root $\\sqrt{x + 1$ here.\n", "MATH001", false, "Root $\\sqrt{x + 1}$ here.\n");
    repairs("c.md", "$$ \\mathbb{R $$\n", "MATH001", true, "$$ \\mathbb{R} $$\n");
  });

  test("a { left open before \\end or \\right is closed there, in LaTeX too", () => {
    repairs("d.tex", latex("\\begin{equation}\n  a = \\frac{1}{2\n\\end{equation}"), "MATH001", true, latex("\\begin{equation}\n  a = \\frac{1}{2}\n\\end{equation}"));
    repairs("e.md", "$$ \\left( \\frac{a}{b \\right) $$\n", "MATH001", true, "$$ \\left( \\frac{a}{b} \\right) $$\n");
  });

  test("\\left without \\right gets \\right. at the end of its group, \\right without \\left gets \\left.", () => {
    repairs("f.md", "$$ \\left( \\frac{a}{b} $$\n", "MATH001", true, "$$ \\left( \\frac{a}{b} \\right. $$\n");
    repairs("g.md", "Then $x = \\frac{a}{b}\\right)$.\n", "MATH001", true, "Then $\\left. x = \\frac{a}{b}\\right)$.\n");
    repairs("h.tex", latex("\\begin{equation}\n  \\left[ x + y\n\\end{equation}"), "MATH001", true, latex("\\begin{equation}\n  \\left[ x + y \\right.\n\\end{equation}"));
  });

  test("a balanced group with a misplaced \\\\ still blames the \\\\", () => {
    const d = check({ source: "$\\frac{a \\\\ b}{c}$\n" }).diagnostics;
    assert.match(d[0]!.message, /Misplaced \\\\/);
  });
});

describe("fixes for LaTeX structure", () => {
  test("a heading's { never closed is closed at the end of its line", () => {
    repairs("a.tex", latex("\\section{Results\nText."), "LTX003", true, latex("\\section{Results}\nText."));
  });

  test("a bold argument running on is closed before the paragraph ends, unsafe", () => {
    repairs("b.tex", latex("Some \\textbf{bold text and more.\n\nNext."), "LTX003", false, latex("Some \\textbf{bold text and more.}\n\nNext."));
  });

  test("an environment never ended is ended before the next \\section, or at the end", () => {
    repairs("c.tex", latex("\\begin{itemize}\n\\item a\n\\item b\n\n\\section{Next}\nText."), "LTX003", true, latex("\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}\n\n\\section{Next}\nText."));
    repairs("d.tex", "\\documentclass{article}\n\\begin{document}\nHello.\n", "LTX003", true, "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n");
    // Two environments open at the end take two rounds, inner one first.
    repairs("e.tex", "\\documentclass{article}\n\\begin{document}\n\\begin{equation}\nx=1\n", "LTX003", true, "\\documentclass{article}\n\\begin{document}\n\\begin{equation}\nx=1\n\\end{equation}\n\\end{document}\n");
  });

  test("an \\end naming the wrong environment is renamed; with & rows the \\begin is", () => {
    repairs("f.tex", latex("\\begin{equation}\na = b\n\\end{align}"), "LTX003", true, latex("\\begin{equation}\na = b\n\\end{equation}"));
    repairs("g.tex", latex("\\begin{equation}\na &= b \\\\\nc &= d\n\\end{align}"), "LTX003", true, latex("\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}"));
    repairs("h.tex", latex("\\begin{itemize}\n\\item a\n\\end{enumerate}\nText."), "LTX003", true, latex("\\begin{itemize}\n\\item a\n\\end{itemize}\nText."));
  });

  test("a stray \\end is deleted, unless a \\begin nearby is the likelier typo", () => {
    repairs("i.tex", latex("Text.\n\\end{itemize}\nMore."), "LTX003", true, latex("Text.\nMore."));
    const near = check({ source: latex("\\begin{itemze}\n\\item a\n\\end{itemze}\n\\end{itemize}"), from: "latex" }).diagnostics;
    const stray = near.find((d) => d.code === "LTX003" && /without a matching/.test(d.message));
    assert.equal(stray?.fix?.safe, false, JSON.stringify(near));
  });

  test("an extra cell offers a wider column spec, unsafe", () => {
    repairs("j.tex", latex("\\begin{tabular}{|l|l|}\na & b & c \\\\\n\\end{tabular}"), "TBL001", false, latex("\\begin{tabular}{|l|l|l|}\na & b & c \\\\\n\\end{tabular}"));
  });

  test("a misspelt citation command and a misspelt key are both fixed (\citp is as near \cite as \citep, so it gets none)", () => {
    const p = file("k.tex", latex("See \\ciitep{knuth198}.\n\\bibliography{refs}"), { "refs.bib": BIB });
    const res = fixDocument({ input: p });
    assert.deepEqual(problems(res.diagnostics), [], JSON.stringify(res.diagnostics));
    assert.match(readFileSync(p, "utf8"), /\\citep\{knuth1984\}/);
  });
});

describe("fixes for Markdown and front matter", () => {
  test("an extra table cell offers a header and delimiter row one column wider, unsafe", () => {
    repairs("a.md", "| A | B |\n|---|---|\n| 1 | 2 | 3 |\n", "TBL001", false, "| A | B |    |\n|---|---| --- |\n| 1 | 2 | 3 |\n");
  });

  test("a value with a colon is quoted; tab indentation becomes spaces; an unclosed block is closed", () => {
    repairs("b.md", "---\ntitle: Results: a study\n---\n\nText.\n", "YAML001", true, '---\ntitle: "Results: a study"\n---\n\nText.\n');
    repairs("c.md", '---\ntitle: Say "hi": now\n---\n\nText.\n', "YAML001", true, "---\ntitle: 'Say \"hi\": now'\n---\n\nText.\n");
    repairs("d.md", "---\ntitle: X\nauthor:\n\t- A\n\t- B\n---\n\nText.\n", "YAML001", true, "---\ntitle: X\nauthor:\n  - A\n  - B\n---\n\nText.\n");
    repairs("e.md", "---\ntitle: X\nauthor: Me\n\n# Intro\n\nText.\n", "MD001", true, "---\ntitle: X\nauthor: Me\n---\n\n# Intro\n\nText.\n");
  });

  test("misspelt option values get the accepted value", () => {
    repairs("f.md", "---\ntheme: modren\n---\n\nText.\n", "OPT001", true, "---\ntheme: modern\n---\n\nText.\n");
    repairs("g.md", "---\npapersize: leter\n---\n\nText.\n", "OPT001", true, "---\npapersize: letter\n---\n\nText.\n");
    repairs("h.md", "---\npage-numbers: centre\n---\n\nText.\n", "OPT001", true, "---\npage-numbers: center\n---\n\nText.\n");
    repairs("i.md", "---\ncitation-style: numerical\n---\n\nText.\n", "OPT001", true, "---\ncitation-style: numeric\n---\n\nText.\n");
    // Upper-case paper names were always fine.
    assert.deepEqual(check({ source: "---\npapersize: A4\n---\n\nx\n" }).diagnostics, []);
  });

  test("an image name differing in case or extension is fixed", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    // On a file system that ignores case (Windows, macOS) plot.SVG simply is plot.svg.
    const probe = file("probe.svg", svg);
    if (!existsSync(probe.replace(/svg$/, "SVG"))) repairs("j.md", "![A plot.](plot.SVG)\n", "IMG001", true, "![A plot.](plot.svg)\n", { "plot.svg": svg });
    repairs("k.md", "![A plot.](chart.png)\n", "IMG001", true, "![A plot.](chart.svg)\n", { "chart.svg": svg });
  });

  test("an unclosed $ before a formula is reported with a fix; money is left alone", () => {
    repairs("l.md", "Let $x = 1 and go on.\n", "MD002", false, "Let $x = 1$ and go on.\n");
    repairs("m.md", "So $W^+ = $ the sum.\n", "MD002", false, "So $W^+ =$ the sum.\n");
    for (const ok of ["It costs $5 and $10.\n", "Pay $3.78 per visitor versus $3.41 before.\n", "A lone $ sign.\n", "Buy $AAPL today.\n"]) {
      assert.deepEqual(check({ source: ok }).diagnostics, [], ok);
    }
  });
});

describe("fixing never makes a document worse", () => {
  test("a round of fixes that adds problems is taken back", () => {
    // The near-miss key is fixed; the bibliography it names then fails to load, an error for a warning,
    // but one problem for two is still fewer, so it stands.
    const p = file("a.md", "---\nbibliograpy: refs.bib\nnumber-section: true\n---\n\nText.\n");
    const res = fixDocument({ input: p });
    assert.equal(res.applied.length, 2);
    assert.deepEqual(res.reverted, []);
  });

  /** A seeded generator, so a failure names a reproducible case. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  /** Mistakes that check --fix can undo exactly, and ones it should only improve. */
  type Injection = { name: string; exact: boolean; apply(text: string, pick: (k: number) => number): string | undefined };
  const at = (text: string, re: RegExp, pick: (k: number) => number) => {
    const all = [...text.matchAll(re)];
    return all.length ? all[pick(all.length)] : undefined;
  };
  const splice = (text: string, from: number, to: number, put: string) => text.slice(0, from) + put + text.slice(to);
  const INJECTIONS: Injection[] = [
    {
      name: "math command typo",
      exact: true,
      apply(t, pick) {
        const m = at(t, /\\(alpha|gamma|lambda|sigma|epsilon|infty|partial|mathbb|mathbf|sqrt|frac|cdot|left|right|sum|leq|geq)(?![A-Za-z])/g, pick);
        if (!m) return undefined;
        const w = m[1]!;
        return splice(t, m.index! + 1, m.index! + 1 + w.length, w[0] + w[2] + w[1] + w.slice(3));
      },
    },
    {
      name: "unclosed brace at a formula's end",
      exact: true,
      apply(t, pick) {
        const m = at(t, /\{[A-Za-z0-9]+\}(?=\$)/g, pick);
        return m && splice(t, m.index! + m[0].length - 1, m.index! + m[0].length, "");
      },
    },
    {
      name: "reference label typo",
      exact: true,
      apply(t, pick) {
        const m = at(t, /(?:@|\\(?:ref|eqref|Cref|cref)\{)((?:sec|fig|tbl|eq|thm):[A-Za-z0-9-]{4,})/g, pick);
        if (!m) return undefined;
        const end = m.index! + m[0].length;
        return splice(t, end - 1, end, "");
      },
    },
    {
      name: "citation key typo",
      exact: true,
      apply(t, pick) {
        const m = at(t, /(?:\[@|\\cite[pt]?\{)([A-Za-z][A-Za-z0-9]{5,})/g, pick);
        if (!m) return undefined;
        const end = m.index! + m[0].length;
        return splice(t, end - 1, end, "");
      },
    },
    {
      name: "mermaid fence typo",
      exact: true,
      apply: (t) => (t.includes("```mermaid") ? t.replace("```mermaid", "```mermiad") : undefined),
    },
    {
      name: "wrong \\end name",
      exact: true,
      apply(t, pick) {
        const m = at(t, /\\begin\{equation\}((?:(?!\\end)[^&])*?)\\end\{equation\}/g, pick);
        if (!m) return undefined;
        const end = m.index! + m[0].length;
        return splice(t, end - "equation}".length, end - 1, "align");
      },
    },
    {
      name: "\\right dropped",
      exact: false,
      apply(t, pick) {
        const m = at(t, /\\right[)\]|.]/g, pick);
        return m && splice(t, m.index!, m.index! + m[0].length, "");
      },
    },
    {
      name: "\\end{itemize} dropped",
      exact: false,
      apply(t, pick) {
        const m = at(t, /\\end\{(itemize|enumerate)\}/g, pick);
        return m && splice(t, m.index!, m.index! + m[0].length, "");
      },
    },
  ];

  test("fuzz: injected mistakes in the benchmark documents are repaired, and never made worse", { timeout: 300_000 }, (t) => {
    if (!existsSync(corpus)) return;
    const sets = ["a", "c"];
    let tried = 0;
    let exact = 0;
    let exactTried = 0;
    const misses: string[] = [];
    const random = rng(20261009);
    for (const set of sets) {
      const manifest = JSON.parse(readFileSync(join(corpus, set, "manifest.json"), "utf8")) as { file: string; assets?: string[] }[];
      for (const entry of manifest) {
        const source = readFileSync(join(corpus, set, entry.file), "utf8");
        for (const inj of INJECTIONS) {
          const broken = inj.apply(source, (k) => Math.floor(random() * k));
          if (broken === undefined || broken === source) continue;
          const dir = join(tmp, `fuzz-${set}-${++n}`);
          mkdirSync(dir, { recursive: true });
          for (const a of entry.assets ?? []) copyFileSync(join(corpus, set, a), join(dir, a));
          const p = join(dir, entry.file);
          writeFileSync(p, broken);
          const before = problems(check({ input: p }).diagnostics).length;
          const res = fixDocument({ input: p });
          const afterCount = problems(res.diagnostics).length;
          const label = `${set}/${entry.file} ${inj.name}`;
          tried++;
          assert.ok(afterCount <= before, `${label}: ${before} problems before, ${afterCount} after`);
          assert.ok(before > 0, `${label}: the injected mistake was not detected`);
          if (inj.exact) {
            exactTried++;
            if (readFileSync(p, "utf8") === source) exact++;
            else {
              misses.push(label);
              assert.ok(afterCount > 0, `${label}: fixed to a clean document that differs from the original`);
            }
          }
        }
      }
    }
    t.diagnostic(`${tried} injections, never worse; ${exact} of ${exactTried} undoable ones restored exactly; not restored: ${misses.join("; ")}`);
    assert.ok(tried >= 60, `only ${tried} injections`);
    // Exact restoration where the mistake can be undone; the rest must at least not be fixed wrongly.
    assert.ok(exact / exactTried >= 0.9, `restored ${exact} of ${exactTried}`);
  });
});

describe("texwright repair", () => {
  test("fixes, renders and reports in a few lines; JSON with --diagnostics json", () => {
    const p = file("doc.md", "---\ntitle: Heat: flow\nbibliography: refs.bib\n---\n\n# Results {#sec:results}\n\nSee @sec:reslts and [@knuth198]; $\\alpah = \\frac{1}{2$.\n\n| A | B |\n|---|---|\n| 1 | 2 | 3 |\n", { "refs.bib": BIB });
    const run = spawnSync(process.execPath, [cli, "repair", p], { encoding: "utf8", cwd: dirOf(p) });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.ok(lines.filter((l) => l.startsWith("fixed ")).length >= 5, run.stdout);
    assert.ok(lines.some((l) => /^left .* W TBL001 .*\(check, then apply\)$/.test(l)), run.stdout);
    assert.ok(lines.some((l) => /^ok doc\.pdf \(1 page\): \d+ fixed, 0 errors and 1 warning left$/.test(l)), run.stdout);
    assert.match(lines.at(-1)!, /^ {2}p1: Results, Table$/);
    assert.ok(existsSync(join(dirOf(p), "doc.pdf")));
    const again = spawnSync(process.execPath, [cli, "repair", p, "--diagnostics", "json"], { encoding: "utf8" });
    const report = JSON.parse(again.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.fixed, []);
    assert.equal(report.remaining[0].code, "TBL001");
    assert.equal(report.pages, 1);
  });

  test("leaves a document with errors it cannot fix unrendered, and keeps to its budget", () => {
    const body = Array.from({ length: 40 }, (_, k) => `See @sec:nothere${k}.`).join("\n\n");
    const p = file("doc.md", `# A\n\n${body}\n`);
    const run = spawnSync(process.execPath, [cli, "repair", p, "--budget", "600"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.ok(run.stdout.length <= 800, `${run.stdout.length} characters`);
    assert.match(run.stdout, /\.\.\. \d+ more not listed/);
    assert.match(run.stdout, /not rendered: 0 fixed, 40 errors and 0 warnings left/);
    assert.ok(!existsSync(join(dirOf(p), "doc.pdf")));
  });
});

describe("repair_document (MCP)", () => {
  test("repairs a file in the workspace, reports in short lines, and refuses paths outside it", async () => {
    const { createMcpServer } = await import("../src/mcp.js");
    const p = file("doc.md", "# Intro {#sec:intro}\n\nSee @sec:intr and $\\frac{1}{2$.\n");
    const root = dirOf(p);
    const server = createMcpServer({ root, timeoutMs: 60_000 });
    const call = async (args: Record<string, unknown>) =>
      (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repair_document", arguments: args } })) as { result: { content: { text: string }[]; isError: boolean } };
    const res = await call({ path: "doc.md" });
    assert.equal(res.result.isError, false, res.result.content[0]!.text);
    const text = res.result.content[0]!.text;
    assert.match(text, /^fixed .*doc\.md:3:\d+ "sec:intr" -> "sec:intro"$/m);
    assert.match(text, /"\\frac\{1\}\{2" -> "\\frac\{1\}\{2\}"/);
    assert.match(text, /^ok .*doc\.pdf \(1 page\): 2 fixed, 0 errors and 0 warnings left$/m);
    assert.equal(readFileSync(p, "utf8"), "# Intro {#sec:intro}\n\nSee @sec:intro and $\\frac{1}{2}$.\n");
    const json = JSON.parse((await call({ path: "doc.md", compact: false, to: "html" })).result.content[0]!.text);
    assert.equal(json.ok, true);
    assert.match(json.output, /doc\.html$/);
    const outside = await call({ path: "../elsewhere.md" });
    assert.equal(outside.result.isError, true);
    assert.match(outside.result.content[0]!.text, /PATH001/);
  });
});

describe("lint", () => {
  test("A11Y001: an image with no alt text and no caption; A11Y002: low-contrast coloured text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    const p = file("a.md", "![](i.svg)\n\nInline ![](i.svg) and ![An icon](i.svg).\n\n![Captioned.](i.svg)\n\n::: warning\nSee \\textcolor{orange}{this}.\n:::\n\n\\textcolor{blue!60!black}{Fine} and \\textcolor{yellow}{faint}.\n", { "i.svg": svg });
    const ds = check({ input: p }).diagnostics;
    assert.deepEqual(ds.filter((d) => d.code === "A11Y001").map((d) => d.line), [1, 3]);
    assert.deepEqual(ds.filter((d) => d.code === "A11Y002").map((d) => d.line), [8, 11]);
    assert.ok(contrast([1, 1, 1], [0, 0, 0]) > 20.9 && Math.abs(contrast([1, 0, 0], [1, 1, 1]) - 4) < 0.01);
  });

  test("LAY006: a display, table or code line wider than the column; LAY004 and LAY005 stay quiet on ordinary pages", async () => {
    const cols = Array.from({ length: 30 }, (_, k) => `x_{${k}}`).join(" & ");
    const code = `\`\`\`\n${"let value = compute(alpha, beta, gamma); ".repeat(4)}\n\`\`\`\n`;
    const res = await convert({ source: `# A\n\n$$ \\begin{pmatrix} ${cols} \\end{pmatrix} $$\n\n${code}\nText.\n`, to: "pdf" });
    const wide = res.diagnostics.filter((d) => d.code === "LAY006");
    // The 30-column matrix is far too wide to shrink, so it is reported; the long code line wraps at its spaces instead.
    assert.deepEqual(wide.map((d) => [d.line, /formula|code block/.exec(d.message)?.[0]]), [[3, "formula"]]);
    const plain = await convert({ source: `# A\n\n${"Words of an ordinary paragraph. ".repeat(400)}\n`, to: "pdf" });
    assert.deepEqual(plain.diagnostics.filter((d) => d.severity !== "info"), []);
  });

  test("LAY004: a figure pushed more than two pages past its first reference", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>';
    const tall = Array.from({ length: 5 }, (_, k) => `![Tall ${k}.](t.svg){#fig:t${k} width=100%}`).join("\n\n");
    const p = file("f.md", `# A\n\nSee @fig:t0 to @fig:t4.\n\n${tall}\n\n${"More text here. ".repeat(900)}\n`, { "t.svg": svg });
    const res = await convert({ input: p, to: "pdf", output: join(dirOf(p), "f.pdf") });
    const late = res.diagnostics.filter((d) => d.code === "LAY004");
    for (const d of late) assert.match(d.message, /^Figure \d is on page \d+, \d+ pages after its first reference on page 1$/);
    // Floats keep order, so the last of five full-page figures lands at least four pages on.
    assert.ok(late.length >= 1, JSON.stringify(res.placement));
  });
});
