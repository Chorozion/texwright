/**
 * End-to-end tests: whole documents through parse, transform and write.
 * PDF output is checked by reading it back with pdf.js (a test-only dependency).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { check, convert } from "../src/index.js";
import { validateDocument } from "../src/schema.js";

const BIB = `
@article{doe2020,
  author = {Doe, Jane and Roe, Richard},
  title = {Heat flow in thin plates},
  journal = {Journal of Plates},
  year = {2020}, volume = {3}, number = {2}, pages = {10--20},
  doi = {10.1000/plates.2020}
}
@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The {\\TeX}book},
  publisher = {Addison-Wesley}, address = {Reading, MA}, year = {1984}
}`;

const MD = `---
title: Heat flow
author: [Ada Lovelace]
date: 2026-10-06
bibliography: refs.bib
number-sections: true
macros:
  R: \\mathbb{R}
---

# Introduction {#sec:intro}

We work in $\\R^n$ and cite [@doe2020] and @knuth1984.

$$ \\int_0^1 f(x)\\,dx $$ {#eq:int}

\\begin{align}
a &= b \\label{eq:a} \\\\
c &= d \\nonumber \\\\
e &= f \\label{eq:e}
\\end{align}

# Results

See @eq:int, \\eqref{eq:a}, \\eqref{eq:e} and @sec:intro.

| x | y |
|---|--:|
| 1 | 2 |

Table: Numbers. {#tbl:nums}

Table @tbl:nums is small.
`;

const tmp = mkdtempSync(join(tmpdir(), "texwright-test-"));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function files() {
  return { "refs.bib": BIB };
}

describe("markdown to html", () => {
  test("numbers sections, equations and tables, and resolves refs and citations", async () => {
    const res = await convert({ source: MD, files: files(), to: "html" });
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
    const html = String(res.data);
    assert.match(html, /<span class="tw-secnum">1<\/span> Introduction/);
    assert.match(html, /<span class="tw-secnum">2<\/span> Results/);
    // $$ labelled -> (1); align rows a and e -> (2), (3); the middle row is unnumbered.
    assert.match(html, />Equation \(1\)</);
    assert.match(html, />\(2\)</);
    assert.match(html, />\(3\)</);
    assert.match(html, />Section\u00a01</);
    assert.match(html, />Table\u00a01</);
    assert.match(html, /tw-bibliography/);
    assert.match(html, /Heat flow in thin plates/);
    assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML" display="inline">/);
    assert.doesNotMatch(html, /<script/i);
  });

  test("the transformed document still validates against the schema", async () => {
    const res = await convert({ source: MD, files: files(), to: "json" });
    const parsed = JSON.parse(String(res.data));
    const v = validateDocument(parsed);
    assert.ok(v.ok, JSON.stringify(v.issues.slice(0, 3)));
  });
});

describe("diagnostics", () => {
  test("undefined reference, bad math and unknown citation are reported with positions and hints", () => {
    const src = `# A {#sec:a}\n\nSee @sec:aa and $\\frac{1}{$ and [@nobody].\n`;
    const res = check({ source: src, files: { "refs.bib": BIB }, meta: { bibliography: ["refs.bib"] } });
    const codes = res.diagnostics.map((d) => d.code).sort();
    assert.ok(codes.includes("REF001"), codes.join());
    assert.ok(codes.includes("MATH001"), codes.join());
    assert.ok(codes.includes("CITE001"), codes.join());
    const ref = res.diagnostics.find((d) => d.code === "REF001")!;
    assert.equal(ref.line, 3);
    assert.match(ref.hint ?? "", /sec:a/);
    assert.equal(res.ok, false);
  });

  test("citations without a bibliography give CITE002", () => {
    const res = check({ source: "Text [@x].\n" });
    assert.ok(res.diagnostics.some((d) => d.code === "CITE002"));
  });

  test("strict mode fails on warnings", () => {
    const src = "Some \\unknowncommand{x} text.\n";
    assert.equal(check({ source: src }).ok, true);
    assert.equal(check({ source: src, strict: true }).ok, false);
  });
});

describe("latex to html", () => {
  test("a small article", async () => {
    const tex = String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\vect}[1]{\mathbf{#1}}
\title{A Note}
\author{A. Author \and B. Author}
\begin{document}
\maketitle
\begin{abstract}Short.\end{abstract}
\section{Intro}\label{sec:intro}
Force $\vect{F} = m\vect{a}$, see Equation~\eqref{eq:newton} and Section~\ref{sec:intro}.
\begin{equation}\label{eq:newton}
  \vect{F} = \frac{d\vect{p}}{dt}
\end{equation}
\begin{theorem}[Main]\label{thm:main} Every bounded sequence has a convergent subsequence.\end{theorem}
\begin{proof} Standard. \end{proof}
By Theorem~\ref{thm:main}.
\end{document}`;
    const res = await convert({ source: tex, from: "latex", to: "html" });
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
    const html = String(res.data);
    assert.match(html, /A Note/);
    assert.match(html, /tw-secnum">1</);
    assert.match(html, />\(1\)</);
    assert.match(html, /Theorem\u00a01/);
    assert.match(html, /tw-qed/);
  });
});

describe("LaTeX mixed into Markdown", () => {
  test("macros, tables, text commands and \\bibliography all work inside a Markdown file", async () => {
    const src = String.raw`# Setup {#sec:setup}

\newcommand{\proj}{texwright}
\newcommand{\vect}[1]{\mathbf{#1}}

We use \proj{} with \textbf{bold} text and $\vect{x} \in \mathbb{R}^n$, see Table~\ref{tab:x} and @sec:setup.

\begin{table}
\centering
\caption{Values.}\label{tab:x}
\begin{tabular}{lr}
\toprule
Name & Value \\
\midrule
a & 1 \\
\bottomrule
\end{tabular}
\end{table}

As shown by [@doe2020].

\bibliography{refs}
`;
    const res = await convert({ source: src, files: files(), to: "html" });
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
    const html = String(res.data);
    assert.match(html, /We use texwright/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<mi>\u{1D431}<\/mi>/u, "the \\vect macro made x bold");
    assert.match(html, /Table 1:/);
    assert.match(html, /href="#tab-x">1</);
    assert.match(html, /Heat flow in thin plates/);
    assert.equal(res.document.meta.bibliography?.[0], "refs.bib");
  });
});

describe("json input", () => {
  test("a document emitted as JSON renders", async () => {
    const doc = {
      texwright: 1,
      meta: { title: [{ t: "Text", text: "From JSON" }] },
      blocks: [
        { t: "Heading", level: 1, numbered: true, content: [{ t: "Text", text: "Result" }], label: "sec:r" },
        { t: "MathBlock", tex: "e^{i\\pi}+1=0", numbered: true, label: "eq:euler" },
        { t: "Para", content: [{ t: "Text", text: "By " }, { t: "Ref", label: "eq:euler", style: "eq" }] },
      ],
    };
    const res = await convert({ source: JSON.stringify(doc), from: "json", to: "html" });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.match(String(res.data), />\(1\)</);
  });

  test("invalid JSON documents are rejected with a path", () => {
    const res = check({ source: '{"texwright":1,"meta":{},"blocks":[{"t":"Nope"}]}', from: "json" });
    assert.equal(res.ok, false);
    assert.match(res.diagnostics[0]!.message, /blocks\[0\]/);
  });
});

describe("security defaults", () => {
  test("raw HTML scripts are removed and reported", async () => {
    const res = await convert({ source: 'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>\n', to: "html" });
    const html = String(res.data);
    assert.doesNotMatch(html, /onerror|alert\(2\)/);
    assert.ok(res.diagnostics.some((d) => d.code === "HTML001"));
  });

  test("images outside the document folder are not read", async () => {
    const dir = mkdtempSync(join(tmp, "doc-"));
    const res = await convert({ source: "![x](../../outside.png)\n", baseDir: dir, to: "html" });
    assert.ok(res.diagnostics.some((d) => d.code === "IMG001"));
  });

  test("\\input and bibliography paths cannot leave the document folder", async () => {
    const root = mkdtempSync(join(tmp, "escape-"));
    const doc = join(root, "doc");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(doc);
    writeFileSync(join(root, "secret.txt"), "SECRET-CONTENT-12345");
    writeFileSync(join(doc, "inside.tex"), "Inside text.");
    const tex = String.raw`\documentclass{article}\begin{document}\input{inside}\input{../secret.txt}\input{${join(root, "secret.txt").replace(/\\/g, "/")}}\end{document}`;
    const res = await convert({ source: tex, from: "latex", baseDir: doc, to: "html" });
    const html = String(res.data);
    assert.match(html, /Inside text\./);
    assert.doesNotMatch(html, /SECRET-CONTENT/);
    assert.ok(res.diagnostics.some((d) => d.code === "IO002" && /outside the document folder/.test(d.message)));
    const bib = check({ source: "---\nbibliography: ../secret.txt\n---\n[@x]\n", baseDir: doc });
    assert.ok(bib.diagnostics.some((d) => d.code === "IO002"));
    // --allow-path opens the folder up again.
    const allowed = await convert({ source: tex, from: "latex", baseDir: doc, to: "html", allowPaths: [root] });
    assert.match(String(allowed.data), /SECRET-CONTENT/);
  });

  test("remote images are blocked unless allowed", () => {
    const res = check({ source: "![x](https://example.com/a.png)\n" });
    assert.ok(res.diagnostics.some((d) => d.code === "IMG002"));
  });
});

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isOffscreenCanvasSupported: false, useSystemFonts: false }).promise;
}

async function pageText(doc: PdfDoc, n: number): Promise<string> {
  const content = await (await doc.getPage(n)).getTextContent();
  return content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join("");
}

/** 1-based page that a named destination points at. */
async function destPage(doc: PdfDoc, name: string): Promise<number> {
  const dest = await doc.getDestination(name);
  if (!dest) return 0;
  return (await doc.getPageIndex(dest[0] as { num: number; gen: number })) + 1;
}

describe("pdf", () => {
  test("a table of contents and \\pageref carry the pages their targets land on", async () => {
    const parts = ["---\ntitle: Long\ntoc: true\nnumber-sections: true\n---\n"];
    for (let k = 1; k <= 4; k++) parts.push(`# Chapter ${k} {#sec:c${k}}\n\n${"Lorem ipsum dolor sit amet. ".repeat(160)}\n\n\\newpage\n`);
    parts.push("Back to @sec:c3 on page \\pageref{sec:c3}.\n");
    const res = await convert({ source: parts.join("\n"), to: "pdf" });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.ok((res.stats.pages ?? 0) >= 5);
    assert.ok((res.stats.passes ?? 0) >= 2, "page numbers need more than one pass");
    const doc = await openPdf(res.data as Uint8Array);
    const order: number[] = [];
    for (let k = 1; k <= 4; k++) order.push(await destPage(doc, `sec-c${k}`));
    assert.ok(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1]!)), order.join(","));
    const toc = await pageText(doc, 1);
    for (let k = 1; k <= 4; k++) assert.match(toc, new RegExp(`Chapter ${k}[ .]*${order[k - 1]}`), toc);
    const last = await pageText(doc, doc.numPages);
    assert.match(last, new RegExp(`on page ${order[2]}`), last);
  });

  test("math, tables, citations and cross-references come out as text", async () => {
    const res = await convert({ source: MD, files: { "refs.bib": BIB }, to: "pdf" });
    assert.equal(res.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(res.diagnostics));
    const doc = await openPdf(res.data as Uint8Array);
    const text = await pageText(doc, 1);
    for (const s of ["Heat flow", "Introduction", "Table 1", "(1)", "References", "Knuth"]) assert.ok(text.includes(s), `${s} missing from:\n${text}`);
    const outline = await doc.getOutline();
    assert.deepEqual(outline?.map((o) => o.title), ["1 Introduction", "2 Results", "References"]);
  });

  test("the same input gives the same bytes", async () => {
    const saved = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    try {
      const a = await convert({ source: MD, files: { "refs.bib": BIB }, to: "pdf" });
      const b = await convert({ source: MD, files: { "refs.bib": BIB }, to: "pdf" });
      assert.deepEqual(Buffer.from(a.data as Uint8Array), Buffer.from(b.data as Uint8Array));
    } finally {
      if (saved === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = saved;
    }
  });

  test("SVG figures are drawn as vectors and PDF figures get a clear warning", async () => {
    const dir = mkdtempSync(join(tmp, "fig-"));
    writeFileSync(join(dir, "a.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="10" y="10" width="180" height="80" fill="#36c"/><text x="100" y="60" text-anchor="middle" font-family="serif" font-size="20">vector</text></svg>');
    writeFileSync(join(dir, "b.pdf"), "%PDF-1.4\n%%EOF\n");
    const res = await convert({ source: "![An SVG.](a.svg)\n\n![A PDF.](b.pdf)\n", baseDir: dir, to: "pdf" });
    assert.ok(res.data, JSON.stringify(res.diagnostics));
    assert.ok(res.diagnostics.some((d) => d.code === "IMG003"), JSON.stringify(res.diagnostics));
    assert.ok(!res.diagnostics.some((d) => d.code === "SVG001" || d.code === "IMG001"), JSON.stringify(res.diagnostics));
    const doc = await openPdf(res.data as Uint8Array);
    assert.match(await pageText(doc, 1), /vector/);
  });

  test("remote images are never fetched", async () => {
    const dir = mkdtempSync(join(tmp, "net-"));
    writeFileSync(join(dir, "doc.md"), "![x](https://example.com/x.png)\n");
    const res = await convert({ input: join(dir, "doc.md"), to: "pdf", output: join(dir, "doc.pdf") });
    assert.ok(res.output);
    assert.ok(res.diagnostics.some((d) => d.code === "IMG002"));
  });
});
