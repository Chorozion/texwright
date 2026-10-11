/**
 * Hostile input must not be able to make check() slow. Each case below used
 * to take from several seconds to minutes (or ran out of memory, or threw)
 * at the size given, because a scan was repeated from many positions or an
 * expansion multiplied. Each must now finish well inside LIMIT_MS and come
 * back with diagnostics instead of throwing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check } from "../src/index.js";

const LIMIT_MS = 3000;
const B = "\\";
const rep = (s: string, n: number): string => s.repeat(n);
const BIB_DOC = "---\nbibliography: refs.bib\n---\n\nSee [@a].\n";

type Result = ReturnType<typeof check>;

function timed(source: string, from: "markdown" | "latex" = "markdown", files?: Record<string, string>): Result {
  const started = Date.now();
  let res: Result;
  try {
    res = check({ source, from, baseDir: ".", ...(files ? { files } : {}) });
  } catch (e) {
    assert.fail(`check() threw on ${from} input ${JSON.stringify(source.slice(0, 80))}...: ${(e as Error).stack}`);
  }
  const ms = Date.now() - started;
  assert.ok(ms < LIMIT_MS, `check() took ${ms} ms on ${source.length + Object.values(files ?? {}).join("").length} characters of ${from}`);
  assert.ok(Array.isArray(res.diagnostics));
  return res;
}

const codes = (res: Result): Set<string> => new Set(res.diagnostics.map((d) => d.code));

describe("performance: Markdown environments and display math", () => {
  test("lines that open an environment also opened and closed inside them (1,000 lines)", () => {
    timed(`${B}begin{foo}\n` + rep(`${B}begin{foo}${B}begin{foo}${B}end{foo}\n`, 1000));
  });

  test("lines that open an environment never closed (8,000 lines)", () => {
    timed(rep(`${B}begin{foo}\n`, 8000));
  });

  test("unclosed \\begin{x} repeated inside one paragraph (100 KB)", () => {
    timed(`text ${rep(`${B}begin{x} `, 10000)}`);
  });

  test("an environment name with braces repeated inside one paragraph", () => {
    timed(rep(`${B}begin{a{b}} `, 10000));
  });

  test("math environments whose \\end lines have trailing text", () => {
    timed(rep(`${B}begin{equation}\n`, 5000) + rep(`${B}end{equation} x\n`, 5000));
  });

  test("environment lines in a list item that close only after it", () => {
    timed("- " + rep(`${B}begin{foo}\n  `, 4000) + "\n" + rep(`${B}end{foo}\n`, 4000));
  });

  test("environment lines in a block quote that close only after it", () => {
    timed(rep(`> ${B}begin{foo}\n`, 6000) + "\n" + rep(`${B}end{foo}\n`, 6000));
  });

  test("lines that open display math with $$ (20,000 lines)", () => {
    timed(rep("$$ a\n", 20000));
  });

  test("lines that open display math with \\[ and never close it (20,000 lines)", () => {
    timed(rep(`${B}[ a\n`, 20000));
  });
});

describe("performance: Markdown inline scanners", () => {
  test("unbalanced command arguments", () => {
    timed(`text ${rep(`${B}a{`, 20000)}`);
  });

  test("\\(...\\) and \\[...\\] that never close", () => {
    timed(rep(`${B}(a `, 25000));
    timed(rep(`${B}[a `, 25000));
  });

  test("$\\text{ that never closes", () => {
    timed(rep(`$${B}text{`, 15000));
  });

  test("unclosed citation brackets (100 KB)", () => {
    timed(rep("[@a; ", 20000));
  });

  test("deeply nested citation brackets", () => {
    timed(rep("[", 20000) + " @a" + rep(";x]", 20000));
    timed(rep("[", 40000) + "@a" + rep("]", 40000));
  });

  test("\\cite with an optional argument that never closes", () => {
    timed(rep(`${B}cite[`, 8000));
  });

  test("@{key with no closing brace", () => {
    timed(rep("@{a ", 25000) + "x\nx" + rep(" ", 1000) + "}");
  });

  test("code spans of many lengths inside math", () => {
    let src = "$a ";
    for (let k = 1; k <= 440; k++) src += rep("`", k) + " ";
    timed(src);
  });
});

describe("performance: Markdown block rules", () => {
  test("a fenced div opener with a long run of colons (100 KB)", () => {
    timed(`::: a${rep(":", 100000)} b\n`);
  });

  test("a table delimiter row with a long run of trailing blanks", () => {
    timed(": cap\n\n|\n-" + rep(" ", 100000) + "x\n");
  });

  test("consecutive Table: caption lines", () => {
    const res = timed(rep("Table: a\n", 10000));
    // These used to recurse once per line until the stack ran out, losing the whole document.
    assert.ok(!codes(res).has("LTX003"), "the document must not be dropped as too deeply nested");
  });

  test("consecutive bare ': caption' lines", () => {
    timed(rep(": a\n", 40));
  });

  test("many headings with the same text", () => {
    const res = timed(rep("# a\n\n", 20000));
    const ids = new Set(res.document.blocks.map((b) => (b.t === "Heading" ? b.id : undefined)));
    assert.equal(ids.size, 20000);
  });
});

describe("performance: Markdown footnotes and front matter", () => {
  test("one long footnote referenced thousands of times", () => {
    const res = timed(rep("[^1]", 8000) + "\n\n[^1]: " + rep("*w* ", 8000) + "\n");
    assert.ok(codes(res).has("MD001"));
  });

  test("footnotes that each reference the next one ten times", () => {
    let src = "Text[^n0].\n\n";
    for (let l = 0; l < 8; l++) src += `[^n${l}]: ` + rep(`x[^n${l + 1}] `, 10) + "\n\n";
    const res = timed(src + "[^n8]: end\n");
    assert.ok(codes(res).has("MD001"));
  });

  test("YAML aliases that expand a few hundred bytes into gigabytes", () => {
    let yaml = 'l0: &l0 "lol"\n';
    for (let k = 1; k <= 9; k++) yaml += `l${k}: &l${k} [${Array(10).fill(`*l${k - 1}`).join(", ")}]\n`;
    for (const key of ["title", "abstract", "author", "keywords", "extra"]) {
      const res = timed(`---\n${yaml}${key}: *l9\n---\n\nBody.\n`);
      // texwright's YAML reader refuses anchors and aliases outright, at the first one.
      const yamlDiags = res.diagnostics.filter((d) => d.code === "YAML001");
      assert.equal(yamlDiags.length, 1, key);
      assert.match(yamlDiags[0].message, /anchor|alias/i);
      assert.equal(res.document.meta.title, undefined);
      assert.equal(res.document.meta.extra, undefined);
    }
  });

  test("a YAML alias that refers to itself", () => {
    const res = timed("---\ntitle: &a [*a, *a]\n---\n\nBody.\n");
    assert.ok(codes(res).has("YAML001"));
  });

  test("YAML anchors are refused with the line and a clear message", () => {
    const res = timed("---\naffil: &u University\nauthor:\n  - name: A\n    affiliation: *u\ntitle: T\n---\n\nBody.\n");
    const d = res.diagnostics.find((x) => x.code === "YAML001");
    assert.ok(d);
    assert.equal(d.line, 2);
    assert.match(d.message, /anchor/i);
  });

  test("thousands of front matter keys", () => {
    let yaml = "";
    for (let k = 0; k < 10000; k++) yaml += `key${k}: v\n`;
    timed(`---\ntitle: T\n${yaml}---\n\nBody.\n`);
  });
});

describe("performance: LaTeX", () => {
  test("\\url{ that never closes", () => {
    timed(rep(`${B}url{`, 20000), "latex");
  });

  test("optional arguments that never close", () => {
    timed(rep(`${B}cite[`, 30000), "latex");
    timed(rep(`${B}foo[`, 40000), "latex");
    timed(`${B}begin{itemize}` + rep(`${B}item[`, 30000), "latex");
  });

  test("\\lstinline[ and lstlisting options that never close", () => {
    timed(rep(`${B}lstinline[`, 30000), "latex");
    timed(rep(`${B}begin{lstlisting}[\n${B}end{lstlisting}\n`, 9000), "latex");
  });

  test("unclosed arguments, one per paragraph", () => {
    timed(rep(`${B}label{\n\n`, 4000), "latex");
  });

  test("unclosed math and environments, one per paragraph", () => {
    timed(rep(`${B}[\n\n`, 6000), "latex");
    timed(rep(`${B}begin{equation}\n\n`, 4000), "latex");
    timed(rep(`${B}begin{tikzpicture}\n\n`, 3000), "latex");
  });

  test("a paragraph that starts with thousands of line breaks", () => {
    timed(rep(`${B}${B}`, 80000), "latex");
  });

  test("\\verb whose delimiter never comes back", () => {
    let src = "";
    for (let k = 0; k < 12000; k++) src += `${B}verb${String.fromCharCode(0x4e00 + k)}a\n`;
    timed(src, "latex");
  });

  test("nested column repeats", () => {
    // 100^6 columns used to overflow the stack and lose the whole document.
    const res = timed(`${B}begin{tabular}{${rep("*{100}{", 6)}l${rep("}", 6)}}a${B}end{tabular}`, "latex");
    assert.ok(!codes(res).has("LTX003"));
    assert.equal(res.document.blocks[0]?.t, "Table");
    timed(`${B}begin{tabular}{l}` + rep(`${B}multicolumn{1}{*{100}{*{100}{*{100}{l}}}}{a}${B}${B}`, 5) + `${B}end{tabular}`, "latex");
  });

  test("a macro that copies its argument, nested", () => {
    const res = timed(`${B}newcommand${B}a[1]{#1#1}` + rep(`${B}a{`, 15) + rep("x", 20000) + rep("}", 15), "latex");
    assert.ok(codes(res).has("LTX005"));
    // The same through raw LaTeX in Markdown.
    timed(`${B}newcommand${B}a[1]{#1#1}\n\n` + rep(`${B}a{`, 15) + rep("x", 20000) + rep("}", 15));
  });

  test("a macro body with thousands of parameters", () => {
    timed(`${B}newcommand${B}a[1]{${rep("#1", 50000)}}${B}a{x}`, "latex");
  });

  test("many sections with the same title", () => {
    timed(rep(`${B}section{a}\n`, 20000), "latex");
  });
});

describe("performance: BibTeX", () => {
  test("entries with an unclosed brace", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": rep("@a{k,t={", 8000) });
  });

  test("entries with an unclosed quote", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": rep('@a{k,t="', 8000) });
  });

  test("quoted values whose quotes all sit inside braces", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": '@a(k,t="' + rep('{@a(k,t="}', 8000) });
  });

  test("@comment{ that never closes", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": rep("@comment{", 10000) });
  });

  test("an author list with a long run of spaces", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": `@a{a,author={x${rep(" ", 100000)}y}}` });
  });

  test("deeply nested braces and font switches in a field", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": `@a{a,title={${rep("{", 30000)}x${rep("}", 30000)}}}` });
    timed(BIB_DOC, "markdown", { "refs.bib": `@a{a,title={${rep(`${B}em `, 20000)}x}}` });
    timed(BIB_DOC, "markdown", { "refs.bib": `@a{a,title={${rep(`${B}emph`, 20000)}x}}` });
  });

  test("@string macros that double at every step", () => {
    let bib = "@string{s0 = {lol}}\n";
    for (let k = 0; k < 40; k++) bib += `@string{s${k + 1} = s${k} # s${k}}\n`;
    const res = timed(BIB_DOC, "markdown", { "refs.bib": bib + "@a{a, title = s40}" });
    assert.ok(res.diagnostics.some((d) => d.code === "CITE003" && /@string/.test(d.message)));
  });

  test("a long @string referenced thousands of times", () => {
    timed(BIB_DOC, "markdown", { "refs.bib": `@string{s = {${rep("x", 10000)}}}\n@a{a, title = ` + Array(20000).fill("s").join("#") + "}" });
  });
});
