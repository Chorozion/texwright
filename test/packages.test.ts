/**
 * Package commands documents use without loading anything: siunitx, mhchem,
 * physics and a few smaller packages, plus the conventional shorthands
 * (\R, \argmax, ...) that are read with an info note.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Diagnostics } from "../src/diagnostics.js";
import { check } from "../src/index.js";
import { typesetMath } from "../src/math/index.js";
import { chem, formatNumber, formatUnit, packageCommandNames } from "../src/math/packages.js";
import { parseFormula } from "../src/math/parser.js";
import { MATH_SYMBOLS, NAMED_OPS } from "../src/math/symbols.js";

/** A formula's parse tree without source positions, for comparing two spellings. */
function tree(tex: string, macros: Record<string, string> = {}): string {
  const f = parseFormula(tex, macros, false, () => {});
  return JSON.stringify(f, (k, v) => (k === "pos" ? undefined : v));
}

function diagnose(tex: string, macros: Record<string, string> = {}) {
  const d = new Diagnostics();
  typesetMath(tex, { display: false, fontSize: 10, macros, diagnostics: d, pos: { line: 1, col: 1 } });
  return d.items;
}

describe("siunitx", () => {
  test("numbers: digit groups, exponents, uncertainty and products", () => {
    assert.equal(formatNumber("1234567.891"), "{1\\,234\\,567.891}");
    assert.equal(formatNumber("1234"), "{1234}");
    assert.equal(formatNumber("-12345"), "{-12\\,345}");
    assert.equal(formatNumber("1.5e-3"), "{1.5\\times 10^{-3}}");
    assert.equal(formatNumber("1e5"), "{10^{5}}");
    assert.equal(formatNumber("1,5"), "{1.5}");
    assert.equal(formatNumber("5 +- 0.2"), "{5\\pm 0.2}");
    assert.equal(formatNumber("2x3"), "{2\\times 3}");
    assert.equal(formatNumber("\\pi"), "{\\pi}", "not a number: kept as written");
  });

  test("units from macros, written out, and per modes", () => {
    assert.equal(formatUnit("\\kilo\\meter\\per\\second\\squared").tex, "\\mathrm{km}\\,\\mathrm{s}^{-2}");
    assert.equal(formatUnit("\\kilo\\meter\\per\\hour", "symbol").tex, "\\mathrm{km}/\\mathrm{h}");
    assert.equal(formatUnit("\\joule\\per\\mole\\per\\kelvin", "fraction").tex, "\\frac{\\mathrm{J}}{\\mathrm{mol}\\,\\mathrm{K}}");
    assert.equal(formatUnit("\\square\\metre").tex, "\\mathrm{m}^{2}");
    assert.equal(formatUnit("\\kg\\MHz").tex, "\\mathrm{kg}\\,\\mathrm{MHz}");
    assert.equal(formatUnit("m/s").tex, "\\mathrm{m}/\\mathrm{s}");
    assert.equal(formatUnit("kg.m^2").tex, "\\mathrm{kg}\\,\\mathrm{m}^{2}");
    assert.deepEqual(formatUnit("\\degree"), { tex: "{}^{\\circ}", attached: true });
  });

  test("\\SI, \\qty, \\ang, ranges and lists typeset cleanly", () => {
    for (const tex of [
      "\\SI{9.81}{\\meter\\per\\second\\squared}",
      "\\SI[per-mode=symbol]{5}{\\kilo\\meter\\per\\hour}",
      "\\SI{25}{\\celsius}",
      "\\SI{30}{\\degree}",
      "\\SI{2.5}{\\micro\\metre}",
      "\\SI{1.5}{\\angstrom}",
      "\\SI{5 \\pm 0.2}{\\newton}",
      "\\qty{1.2}{\\kg}",
      "\\qty{3}{kg.m^2/s^2}",
      "\\unit{\\MHz}",
      "\\si{\\ohm}",
      "\\ang{12;30;15}",
      "\\SIrange{1}{5}{\\milli\\second}",
      "\\numlist{1;2;3}",
      "\\num{6.022e23}",
    ]) {
      assert.deepEqual(diagnose(tex), [], tex);
    }
    assert.equal(tree("\\SI{30}{\\degree}"), tree("{{30}{}^{\\circ}}"));
  });
});

describe("mhchem", () => {
  test("formulas, charges, states, hydrates and coefficients", () => {
    assert.equal(chem("H2O"), "\\mathrm{H}_{2}\\mathrm{O}");
    assert.equal(chem("SO4^2-"), "\\mathrm{SO}_{4}^{2-}");
    assert.equal(chem("Fe^{3+}"), "\\mathrm{Fe}^{3+}");
    assert.equal(chem("NH4+"), "\\mathrm{NH}_{4}^{+}");
    assert.equal(chem("OH-"), "\\mathrm{OH}^{-}");
    assert.equal(chem("CO2(g)"), "\\mathrm{CO}_{2}\\,(\\mathrm{g})");
    assert.equal(chem("CuSO4*5H2O"), "\\mathrm{CuSO}_{4}\\cdot 5\\mathrm{H}_{2}\\mathrm{O}");
    assert.equal(chem("[Cu(NH3)4]^2+"), "[\\mathrm{Cu}(\\mathrm{NH}_{3})_{4}]^{2+}");
    assert.equal(chem("^{14}_{6}C"), "{}^{14}_{6}\\mathrm{C}");
  });

  test("reactions: operators, arrows with labels, gas and precipitate", () => {
    assert.equal(chem("2H2 + O2 -> 2H2O"), "2\\mathrm{H}_{2} + \\mathrm{O}_{2} \\longrightarrow 2\\mathrm{H}_{2}\\mathrm{O}");
    assert.match(chem("N2 + 3H2 <=> 2NH3"), /\\rightleftharpoons/);
    assert.match(chem("CaCO3 ->[\\Delta] CaO + CO2 ^"), /\\xrightarrow\[\]\{\\Delta\}.*\\uparrow$/);
    assert.match(chem("A ->[catalyst][heat] B"), /\\xrightarrow\[\\text\{heat\}\]\{\\text\{catalyst\}\}/);
    assert.match(chem("Ag+ + Cl- -> AgCl v"), /\\downarrow$/);
    for (const tex of ["\\ce{H+ + OH- -> H2O}", "\\ce{CH3-CH2-OH}", "\\ce{HC#CH}", "\\pu{25 kJ/mol}", "\\ce{$x$ H2O}"]) {
      assert.deepEqual(diagnose(tex), [], tex);
    }
  });
});

describe("physics and small packages", () => {
  test("derivatives", () => {
    assert.equal(tree("\\dv{f}{x}"), tree("\\frac{\\mathrm{d} f}{\\mathrm{d} x}"));
    assert.equal(tree("\\dv[2]{y}{t}"), tree("\\frac{\\mathrm{d}^{2} y}{\\mathrm{d} t^{2}}"));
    assert.equal(tree("\\dv{x}"), tree("\\frac{\\mathrm{d}}{\\mathrm{d} x}"));
    assert.equal(tree("\\pdv{f}{x}{y}"), tree("\\frac{\\partial^{2} f}{\\partial x\\,\\partial y}"));
  });

  test("brackets, bra-ket and matrices", () => {
    assert.equal(tree("\\abs{x}"), tree("\\left\\lvert x\\right\\rvert"));
    assert.equal(tree("\\norm{v}"), tree("\\left\\lVert v\\right\\rVert"));
    assert.equal(tree("\\qty(\\frac{a}{b})"), tree("\\left(\\frac{a}{b}\\right)"));
    assert.equal(tree("\\braket{a|b}"), tree("\\braket{a}{b}"));
    assert.equal(tree("\\mqty(a & b \\\\ c & d)"), tree("\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}"));
    assert.equal(tree("\\bm{x}"), tree("\\boldsymbol{x}"));
    assert.equal(tree("\\dyad{1}{2}"), tree("\\ketbra{1}{2}"));
    for (const tex of ["\\int f\\dd{x}", "\\ket{0}", "\\expval{H}", "\\mel{n}{H}{m}", "\\comm{A}{B}", "\\vu{x}", "\\curl\\vb{E}", "\\order{n^2}", "\\eval{x^2}_0^1", "\\ketbra{0}{1}", "\\nicefrac{1}{2}", "\\mathbbm{1}"]) {
      assert.deepEqual(diagnose(tex), [], tex);
    }
  });

  test("a document's own definitions win", () => {
    assert.equal(tree("\\abs{x}", { "\\abs": "ABS(#1)" }), tree("ABS(x)"));
    assert.equal(tree("\\newcommand{\\norm}[1]{\\|#1\\|}\\norm{z}"), tree("\\|z\\|"));
    assert.deepEqual(diagnose("\\newcommand{\\dv}[2]{#1/#2}\\dv{a}{b}"), [], "no redefinition warning");
  });

  test("no package name shadows an engine command", () => {
    for (const n of packageCommandNames()) assert.ok(!MATH_SYMBOLS.has(n) && !NAMED_OPS.has(n), n);
    assert.equal(tree("a\\div b"), tree("a \\div b"));
  });

  test("errors inside still point at the formula", () => {
    const ds = diagnose("\\abs{");
    assert.equal(ds[0]?.code, "MATH001");
  });
});

describe("shorthands", () => {
  test("read the usual way with one info note per document", () => {
    const res = check({ source: "$\\R^n$, $\\R$, $\\E[X]$ and $\\argmax_x f$.\n" });
    assert.ok(res.ok);
    const notes = res.diagnostics.filter((d) => d.code === "MATH003");
    assert.deepEqual(
      notes.map((d) => [d.severity, d.message]),
      [
        ["info", "\\R is not defined; read as \\mathbb{R}"],
        ["info", "\\E is not defined; read as \\mathbb{E}"],
        ["info", "\\argmax is not defined; read as \\operatorname*{arg\\,max}"],
      ],
    );
  });

  test("a definition removes the note", () => {
    const res = check({ source: "---\nmacros:\n  R: \\mathbb{R}\n---\n\n$\\R^n$\n" });
    assert.deepEqual(res.diagnostics, []);
  });
});

describe("in running text", () => {
  test("\\SI and \\ce outside math become formulas in LaTeX and Markdown", () => {
    const latex = check({ source: "\\documentclass{article}\\begin{document}The rod is \\SI{2}{\\meter} and \\ce{H2O}.\\end{document}\n", from: "latex" });
    assert.deepEqual(latex.diagnostics, []);
    const md = check({ source: "The rod is \\SI[per-mode=symbol]{2}{\\meter\\per\\second} long; water is \\ce{H2O}.\n" });
    assert.deepEqual(md.diagnostics, []);
    const maths: string[] = [];
    JSON.stringify(md.document, (_, v) => {
      if (v && typeof v === "object" && v.t === "Math") maths.push(v.tex);
      return v;
    });
    assert.deepEqual(maths, ["\\SI[per-mode=symbol]{2}{\\meter\\per\\second}", "\\ce{H2O}"]);
  });
});

describe("mathtools paired delimiters", () => {
  test("\\DeclarePairedDelimiter in LaTeX and in Markdown math, with star and size", () => {
    const tex = String.raw`\documentclass{article}\usepackage{mathtools}\DeclarePairedDelimiter\abs{\lvert}{\rvert}\DeclarePairedDelimiter{\norm}{\lVert}{\rVert}\begin{document}$\abs{x} + \abs*{\frac{a}{b}} + \norm[\big]{v}$\end{document}`;
    const res = check({ source: tex, from: "latex" });
    assert.deepEqual(res.diagnostics, []);
    assert.equal(res.document.meta.macros?.["\\abs"], String.raw`\twpaired{\lvert}{\rvert}`);
    const md = check({ source: String.raw`$\DeclarePairedDelimiter\ceil{\lceil}{\rceil}$ $\ceil*{x/2}$` });
    assert.deepEqual(md.diagnostics, []);
    const macros = { "\\abs": String.raw`\twpaired{\lvert}{\rvert}` };
    assert.equal(tree(String.raw`\abs*{x}`, macros), tree(String.raw`\left\lvert x\right\rvert`));
    assert.equal(tree(String.raw`\abs[\Big]{x}`, macros), tree(String.raw`\Bigl\lvert x\Bigr\rvert`));
  });
});

describe("documents as language models write them", () => {
  test("a closing References heading receives the bibliography instead of a second heading", async () => {
    const { convert } = await import("../src/index.js");
    const res = await convert({
      source: "---\nbibliography: refs.bib\n---\n\n# Intro\n\nSee [@k].\n\n# References\n",
      files: { "refs.bib": "@book{k, author = {A. Author}, title = {T}, year = {2020}, publisher = {P}}" },
      to: "html",
    });
    assert.deepEqual(res.diagnostics, []);
    const html = String(res.data);
    assert.equal(html.match(/>References</g)?.length, 1, "one References heading");
  });

  test("tikz-cd is drawn with a note; \\ref inside math gets its number", () => {
    const res = check({
      source: String.raw`$$\begin{tikzcd} A \arrow[r, "f"] & B \end{tikzcd}$$

# Intro {#sec:intro}

$$x = 1 \quad \text{by Section~\ref{sec:intro}}$$
`,
    });
    assert.ok(res.ok);
    assert.deepEqual(
      res.diagnostics.map((d) => d.code),
      ["MATH004"],
    );
    assert.match(JSON.stringify(res.document), /by Section~\\\\text\{Intro\}/, "an unnumbered section is referred to by its title");
  });
});

describe("Markdown habits of chat-trained writers", () => {
  const blocksOf = (source: string) => check({ source }).document.blocks;
  const T = (text: string) => ({ t: "Text", text });

  test("pandoc superscripts and subscripts, also in front matter", () => {
    const res = check({ source: "---\nauthor: [Ana^1^]\n---\n\nH~2~O and 2^10^; a ~ b ~ c stays.\n" });
    assert.deepEqual(res.diagnostics, []);
    assert.deepEqual(res.document.meta.author, [[T("Ana"), { t: "Superscript", content: [T("1")] }]]);
    assert.deepEqual(res.document.blocks[0], {
      t: "Para",
      content: [T("H"), { t: "Subscript", content: [T("2")] }, T("O and 2"), { t: "Superscript", content: [T("10")] }, T("; a ~ b ~ c stays.")],
      pos: { line: 5, col: 1 },
    });
  });

  test("money in prose is not read as math, while formulas between dollars still are", () => {
    const [para] = blocksOf("B earned $3.78 per visitor versus $3.41 for A, not significant ($p = 0.07$).\n");
    const maths = (para as { content: { t: string; tex?: string }[] }).content.filter((i) => i.t === "Math").map((i) => i.tex);
    assert.deepEqual(maths, ["p = 0.07"]);
    const [f] = blocksOf("Area $2 \\pi r^2$ and $3 \\text{ apples and } 4$.\n");
    assert.equal((f as { content: { t: string }[] }).content.filter((i) => i.t === "Math").length, 2);
  });

  test("lines that each start with a bold label keep their breaks; ordinary wrapped text does not", () => {
    const [fields] = blocksOf("**Date:** Tuesday\n**Time:** 10:00\n**Room**: 4B\n");
    assert.equal((fields as { content: { t: string }[] }).content.filter((i) => i.t === "LineBreak").length, 2);
    const [prose] = blocksOf("**Note:** this sentence wraps\nonto a second line.\n");
    assert.equal((prose as { content: { t: string }[] }).content.filter((i) => i.t === "LineBreak").length, 0);
  });
});

describe("what the held-out set D needed", () => {
  test("\\DeclarePairedDelimiterX, \\DeclareSIUnit, physics \\vdot and \\cross, quiet \\renewcommand and icons", () => {
    const tex = String.raw`\documentclass{article}
\usepackage{mathtools,siunitx,physics,fontawesome5}
\DeclarePairedDelimiterX{\inner}[2]{\langle}{\rangle}{#1, #2}
\DeclareSIUnit{\kNm}{\kilo\newton\metre}
\begin{document}
\faPhone\ 555-0142 \faEnvelope*
$\inner{x}{y} + \inner*{\frac{a}{b}}{c} + \inner[\big]{u}{v}$, $\vb{E} \vdot \vb{B}$, $\vb{a} \cross \vb{b}$,
$M = \qty{161.6}{\kNm}$.
\[ \renewcommand{\arraystretch}{1.2} \begin{array}{c} a \end{array} \]
\[ \renewcommand{\arraystretch}{1.5} \begin{array}{c} b \end{array} \]
\end{document}`;
    const res = check({ source: tex, from: "latex" });
    assert.deepEqual(res.diagnostics, []);
    assert.equal(tree(String.raw`\inner{x}{y}`, { "\\inner": String.raw`\twpairedx{2}{\langle}{\rangle}{##1, ##2}` }), tree(String.raw`\mathopen{\langle}x, y\mathclose{\rangle}`));
    assert.equal(tree(String.raw`\qty{2}{\kNm}`, { "\\kNm": String.raw`\kilo\newton\metre` }), tree(String.raw`\qty{2}{\kilo\newton\metre}`));
  });

  test("exam bonus questions count apart from the regular points", () => {
    const tex = String.raw`\documentclass{exam}
\begin{document}
\numquestions\ questions, \numpoints\ points plus \numbonuspoints\ bonus.
\begin{questions}
\question[4] One?
\bonusquestion[2] Extra?
\end{questions}
\end{document}`;
    const res = check({ source: tex, from: "latex" });
    assert.deepEqual(res.diagnostics, []);
    const text = JSON.stringify(res.document.blocks);
    assert.match(text, /2 questions, 4 points plus 2 bonus\./);
    assert.match(text, /\(2 bonus points\) Extra\?/);
  });

  test("display math in a list item's lazy lines may hold \\begin{bmatrix}", () => {
    const res = check({ source: "- Inverse:\n$$\n\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}^{-1}\n$$\n" });
    assert.deepEqual(res.diagnostics, []);
  });
});
