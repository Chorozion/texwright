/**
 * Hostile and malformed input must never throw: every problem has to come
 * back as a diagnostic. Also checks that large documents stay fast.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check } from "../src/index.js";

/** Deterministic pseudo-random generator so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MD_PIECES = [
  "# ", "## ", "\n", "\n\n", "$", "$$", "\\(", "\\)", "\\[", "\\]", "{", "}", "[", "]", "(", ")", "@", "@fig:", "@sec:x", "[@", "; @k", "]",
  "::: note", ":::", "```", "~~~", "|", "|---|", "> ", "- ", "1. ", "* ", "_", "**", "`", "<", ">", "<script>", "</div>", "<img src=x>",
  "\\begin{align}", "\\end{align}", "\\begin{figure}", "\\end{figure}", "\\label{", "\\ref{", "\\cite{", "\\newcommand{\\x}{", "\\frac{",
  "^[", "[^1]", "[^1]: ", "{#", "{.", "}", "![", "](a.png)", "---\n", "title: x\n", "...\n", "\\newpage", "[[toc]]", "\t", "\u0000", "￿",
  "é", "😀", "\r\n", "&amp;", "&#x0;", "\\", "x", "word ", "%", "#1", "^", "_", "\\\\", "&",
];

const TEX_PIECES = [
  "\\section{", "\\subsection*{", "}", "{", "\\begin{itemize}", "\\item ", "\\end{itemize}", "\\begin{equation}", "\\end{equation}",
  "\\begin{align}", "\\\\", "&", "\\end{align}", "$", "$$", "\\[", "\\]", "\\label{a}", "\\ref{a}", "\\cite{k}", "\\footnote{", "\\textbf{",
  "\\newcommand{\\foo}[1]{#1#1}", "\\foo{", "\\def\\bar{\\bar}", "\\bar", "\\begin{table}", "\\begin{tabular}{lc}", "\\hline", "\\end{tabular}",
  "\\end{table}", "\\caption{", "\\input{missing}", "\\verb|", "|", "%", "\n", "\n\n", "\\begin{tikzpicture}", "\\end{tikzpicture}",
  "\\multicolumn{2}{c}{", "\\begin{theorem}[", "]", "\\end{theorem}", "~", "--", "``", "''", "\\'e", "\\unknown", "\\end{document}", "x ",
];

function randomDoc(pieces: string[], seed: number, length: number): string {
  const r = rng(seed);
  let s = "";
  for (let i = 0; i < length; i++) s += pieces[Math.floor(r() * pieces.length)];
  return s;
}

function mustNotThrow(source: string, from: "markdown" | "latex" | "json"): void {
  try {
    const res = check({ source, from });
    assert.ok(Array.isArray(res.diagnostics));
  } catch (e) {
    const preview = JSON.stringify(source.slice(0, 300));
    assert.fail(`check() threw on ${from} input ${preview}...\n${(e as Error).stack}`);
  }
}

describe("malformed input never throws", () => {
  test("random Markdown soup", () => {
    for (let seed = 1; seed <= 300; seed++) mustNotThrow(randomDoc(MD_PIECES, seed, 80), "markdown");
  });

  test("random LaTeX soup", () => {
    for (let seed = 1; seed <= 300; seed++) mustNotThrow(randomDoc(TEX_PIECES, seed, 80), "latex");
  });

  test("random JSON-ish input", () => {
    const pieces = ['{"t":"Para","content":[', '{"t":"Text","text":"x"}', '{"t":"Math","tex":"\\\\frac{"}', "]", "}", ",", '"blocks":[', '{"texwright":1,', "null", "[", '"meta":{"title":5}'];
    for (let seed = 1; seed <= 200; seed++) mustNotThrow(randomDoc(pieces, seed, 30), "json");
  });

  test("pathological structures", () => {
    const cases: [string, "markdown" | "latex"][] = [
      ["> ".repeat(2000) + "deep quote", "markdown"],
      ["- ".repeat(500) + "deep list", "markdown"],
      ["[".repeat(5000) + "]".repeat(5000), "markdown"],
      ["$".repeat(10000), "markdown"],
      ["{".repeat(5000) + "x", "latex"],
      ["\\begin{itemize}".repeat(300) + "\\item x", "latex"],
      ["\\newcommand{\\a}{\\a}\\a", "latex"],
      ["\\def\\x{\\x\\x}\\x", "latex"],
      ["::: note\n".repeat(500), "markdown"],
      ["---\n" + "k: [".repeat(200) + "\n---\n", "markdown"],
      ["", "markdown"],
      ["", "latex"],
      ["﻿\u0000\u0001\u0002", "markdown"],
      ["$" + "\\left(".repeat(3000) + "$", "markdown"],
      ["@" + "x".repeat(50000), "markdown"],
    ];
    for (const [src, from] of cases) mustNotThrow(src, from);
    // Deep JSON: 5,000 nested block quotes.
    let deep = '{"t":"Para","content":[]}';
    for (let k = 0; k < 5000; k++) deep = `{"t":"BlockQuote","blocks":[${deep}]}`;
    mustNotThrow(`{"texwright":1,"meta":{},"blocks":[${deep}]}`, "json");
  });

  test("deep nesting is reported, not crashed on", () => {
    const res = check({ source: "{".repeat(20000) + "x", from: "latex" });
    assert.ok(res.diagnostics.some((d) => d.code === "LTX003"));
  });

  test("macro expansion bombs are stopped and reported", () => {
    const res = check({ source: "\\newcommand{\\a}{\\a\\a}\n\\a\n", from: "latex" });
    assert.ok(res.diagnostics.length > 0);
  });
});

describe("regressions from the security review", () => {
  const quick = (source: string, from: "markdown" | "latex" = "markdown") => {
    const started = Date.now();
    const res = check({ source, from });
    return { res, ms: Date.now() - started };
  };

  test("an unclosed optional argument in a math \\newcommand does not hang", () => {
    for (const src of ["${x}\\newcommand\\a[$", "$\\newcommand{\\b}[2][$", "${a}{b}\\renewcommand\\c[1][x$"]) {
      const { res, ms } = quick(src);
      assert.ok(ms < 2000, `${src} took ${ms} ms`);
      assert.ok(res.diagnostics.length >= 0);
    }
  });

  test("image names with a bare % are reported, not thrown", () => {
    for (const src of ["![x](100%.png)\n", '<img src="50%.png">\n', "![x](%E0%A4%A.png)\n"]) {
      const { res } = quick(src);
      assert.ok(res.diagnostics.some((d) => d.code === "IMG001"), src);
    }
  });

  test("network (UNC) image and include paths are refused before any file access", () => {
    const img = quick("![x](//attacker-host/share/x.png)\n").res;
    assert.ok(img.diagnostics.some((d) => d.code === "IMG001" && /outside/.test(d.message)));
    const inc = quick("\\input{//attacker-host/share/file}", "latex").res;
    assert.ok(inc.diagnostics.some((d) => d.code === "IO002" && /outside/.test(d.message)));
  });

  test("metadata overrides given as plain strings are converted, bad ones reported", () => {
    const res = check({ source: "# Hi\n\n\\textbf{x}\n", meta: { title: "T" as never, subtitle: "S" as never, author: "A" as never, toc: "maybe" as never, extra: undefined } as never });
    assert.deepEqual(res.document.meta.title, [{ t: "Text", text: "T" }]);
    assert.deepEqual(res.document.meta.subtitle, [{ t: "Text", text: "S" }]);
    assert.deepEqual(res.document.meta.author, [[{ t: "Text", text: "A" }]]);
    assert.ok(res.diagnostics.some((d) => d.code === "OPT001" && /toc/.test(d.message)));
  });

  test("a macro used thousands of times cannot blow up math typesetting", () => {
    const body = "x".repeat(2000);
    const src = `---\nmacros:\n  big: '${body}'\n---\n\n$${"\\big ".repeat(1000).trimEnd()}$\n`;
    const { res, ms } = quick(src);
    assert.ok(ms < 3000, `took ${ms} ms`);
    assert.ok(res.diagnostics.some((d) => d.code === "MATH001" && /expands/.test(d.message)));
  });
});

describe("speed", () => {
  test("a 2,000-paragraph Markdown document with math and references checks in under 10 s", () => {
    const parts = ["---\nnumber-sections: true\n---\n"];
    for (let k = 0; k < 200; k++) {
      parts.push(`# Section ${k} {#sec:s${k}}\n`);
      for (let j = 0; j < 10; j++) parts.push(`Paragraph ${j} with $x_${j}^2 + y$ and a reference to @sec:s${Math.max(0, k - 1)}.\n`);
      parts.push(`$$ \\sum_{i=1}^{${k + 1}} i = \\frac{n(n+1)}{2} $$ {#eq:e${k}}\n`);
    }
    const started = Date.now();
    const res = check({ source: parts.join("\n") });
    const ms = Date.now() - started;
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics.slice(0, 3)));
    assert.ok(ms < 10_000, `took ${ms} ms`);
  });
});
