import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Block, Inline } from "../src/ast.js";
import { Diagnostics } from "../src/diagnostics.js";
import { memoryContext } from "../src/parse/context.js";
import { parseLatex } from "../src/parse/latex.js";
import { parseMarkdown } from "../src/parse/markdown.js";
import { CIRCUIT, circuitKey, toOptions } from "../src/tikz/circuit.js";
import { UNITS } from "../src/tikz/expr.js";
import { picturePreamble, renderTikz } from "../src/tikz/index.js";
import { Interp, anchorPoint } from "../src/tikz/interp.js";
import { initialState } from "../src/tikz/state.js";
import { renderDocumentTikz } from "../src/transform/tikz.js";

const CM = UNITS.cm;
const near = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

/** An interpreter with the circuitikz hooks, as renderTikz sets it up. */
function interp(): Interp {
  const it = new Interp({}, "t");
  it.circuit = CIRCUIT;
  it.extra = (k, v, g) => circuitKey(k, v, g);
  return it;
}

function run(body: string): Interp {
  const it = interp();
  it.run(body, 0, true, initialState());
  return it;
}

const circuit = (body: string, opts = "") => renderTikz(`\\begin{circuitikz}${opts ? `[${opts}]` : ""}\n${body}\n\\end{circuitikz}`);
const paths = (svg: string | undefined) => [...(svg ?? "").matchAll(/<path d="([^"]*)"[^>]*>/g)].map((m) => m[0]);

describe("circuitikz: to[...] options", () => {
  test("a component with its label, current, poles and name", () => {
    const it = interp();
    const r = toOptions(it, "R=$R_1$, i>^=$i$, *-o, name=R1", initialState());
    assert.ok(r.bipole);
    assert.equal(r.bipole.name, "R");
    assert.deepEqual(r.bipole.l, { text: "$R_1$", side: 1 });
    assert.deepEqual(r.bipole.i, { text: "$i$", side: 1, back: false, before: true });
    assert.deepEqual(r.bipole.poles, ["*", "o"]);
    assert.equal(r.bipole.id, "R1");
    assert.equal(r.rest, "");
  });

  test("label sides and arrow directions", () => {
    const it = interp();
    const b = toOptions(it, "C, l_=$C$, a=$1\\,\\mu F$, v<=$v$, i_<=$i$, f^>=$f$", initialState()).bipole!;
    assert.equal(b.l?.side, -1);
    assert.equal(b.a?.side, -1);
    assert.deepEqual(b.v, { text: "$v$", side: -1, back: true, before: false });
    assert.deepEqual(b.i, { text: "$i$", side: -1, back: true, before: false });
    assert.deepEqual(b.f, { text: "$f$", side: 1, back: false, before: false });
    const v2 = toOptions(it, "R, v^>=x", initialState()).bipole!.v;
    assert.equal(v2?.side, 1);
    assert.equal(v2?.back, false);
  });

  test("TikZ keys pass through; a plain to has no bipole", () => {
    const it = interp();
    assert.deepEqual(toOptions(it, "out=30, in=150", initialState()), { rest: "out=30, in=150" });
    const r = toOptions(it, "R, color=red, thick", initialState());
    assert.equal(r.bipole?.name, "R");
    assert.match(r.rest, /color=\{red\}/);
    assert.match(r.rest, /thick/);
  });

  test("invert, mirror, t= and the siunitx shorthand", () => {
    const b = toOptions(interp(), "D*, invert, mirror, l=1<\\kilo\\ohm>", initialState()).bipole!;
    assert.equal(b.invert, true);
    assert.equal(b.mirror, true);
    assert.equal(b.l?.text, "$\\SI{1}{\\kilo\\ohm}$");
    assert.equal(toOptions(interp(), "twoport, t=$H$", initialState()).bipole?.t, "$H$");
  });

  test("an unknown component in a circuit is a labelled box with a warning; the wire stays", () => {
    const r = circuit("\\draw (0,0) to[squid=$X$] (3,0);");
    assert.ok(r.svg);
    assert.ok(r.messages.some((m) => /component "squid" is not supported/.test(m.message)));
    assert.ok(paths(r.svg).some((p) => /Z"/.test(p)), "a box is drawn");
    assert.ok(paths(r.svg).some((p) => /^<path d="M0 0L/.test(p)), "the wire is drawn");
  });

  test("an unknown key in a plain TikZ picture stays a TikZ warning", () => {
    const r = renderTikz("\\begin{tikzpicture}\\draw (0,0) to[squiggly] (1,0);\\end{tikzpicture}");
    assert.ok(r.messages.some((m) => /option "squiggly"/.test(m.message)));
    assert.ok(!r.messages.some((m) => /component/.test(m.message)));
  });
});

describe("circuitikz: bipoles", () => {
  test("a resistor: leads to the ends, a thick zigzag 0.8 of 1.4cm in the middle", () => {
    const r = circuit("\\draw (0,0) to[R] (4,0);");
    const ps = paths(r.svg);
    const lead = ps.find((p) => /stroke-width="0.4"/.test(p) && /M0 0L/.test(p))!;
    assert.ok(lead, "leads in one path");
    const zig = ps.find((p) => /stroke-width="0.8"/.test(p))!;
    const xs = [...zig.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
    near(Math.max(...xs) - Math.min(...xs), 0.8 * 1.4 * CM, 0.1);
    near((Math.max(...xs) + Math.min(...xs)) / 2, 2 * CM, 0.1);
    assert.equal(xs.length, 8, "six peaks between the two ends");
  });

  test("bipoles/length and resistors/scale size the components", () => {
    const width = (src: string) => {
      const zig = paths(circuit(src).svg).find((p) => /stroke-width="0.8"/.test(p))!;
      const xs = [...zig.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
      return Math.max(...xs) - Math.min(...xs);
    };
    near(width("\\ctikzset{bipoles/length=1cm}\\draw (0,0) to[R] (4,0);"), 0.8 * CM, 0.1);
    near(width("\\ctikzset{resistors/scale=0.5}\\draw (0,0) to[R] (4,0);"), 0.4 * 1.4 * CM, 0.1);
  });

  test("styles: european resistors are boxes; the american option draws + and - for v=", () => {
    const eu = circuit("\\draw (0,0) to[R] (3,0);", "european");
    assert.ok(paths(eu.svg).some((p) => /stroke-width="0.8"/.test(p) && /Z"/.test(p)));
    const am = circuit("\\draw (0,0) to[R, v=$v$] (3,0);", "american");
    const eur = circuit("\\draw (0,0) to[R, v=$v$] (3,0);", "european");
    // american: two signs and the label as text; european: an arrow with a filled head.
    assert.ok((am.svg?.match(/<use /g) ?? []).length >= 3);
    assert.ok(paths(eur.svg).some((p) => /fill="#000000"/.test(p)));
  });

  test("poles: * is a filled dot, o an open one, at the path's ends", () => {
    const ps = paths(circuit("\\draw (0,0) to[short, *-o] (2,0);").svg);
    assert.ok(ps.some((p) => /fill="#000000"/.test(p) && /C/.test(p)));
    assert.ok(ps.some((p) => /fill="#ffffff"/.test(p)));
  });

  test("open draws no wire; short draws one", () => {
    const open = circuit("\\draw (0,0) to[open, v=$v$] (0,2);");
    assert.ok(!paths(open.svg).some((p) => /M0 0L0 -/.test(p)));
    const short = circuit("\\draw (0,0) to[short] (0,2);");
    assert.ok(paths(short.svg).some((p) => /M0 0L0 -56.9/.test(p)));
  });

  test("a closed loop of components: -- cycle does not jump back across a gap", () => {
    const ps = paths(circuit("\\draw (0,0) to[V] (0,3) to[R] (3,3) to[C] (3,0) -- cycle;").svg);
    const wire = ps.find((p) => /stroke-width="0.4"/.test(p) && /M0 0L/.test(p))!;
    assert.ok(wire);
    assert.ok(!/Z/.test(wire.slice(0, wire.indexOf('" '))));
  });

  test("named bipoles have anchors", () => {
    const it = run("\\draw (0,0) to[R, name=R1] (4,0);");
    const n = it.nodes.get("R1")!;
    near(n.center[0], 2 * CM);
    near(anchorPoint(n, "left")[0], 2 * CM - 0.4 * 1.4 * CM, 0.1);
    near(anchorPoint(n, "right")[0], 2 * CM + 0.4 * 1.4 * CM, 0.1);
  });

  test("every listed component draws, with no NaN", () => {
    const names = [
      "R", "european resistor", "L", "cute inductor", "american inductor", "european inductor", "C", "eC", "pC", "V", "I", "american voltage source",
      "sV", "sI", "cV", "cI", "battery", "battery1", "battery2", "D", "D*", "led", "zD", "sD", "short", "open", "switch", "nos", "ncs", "spst", "cspst",
      "ospst", "lamp", "bulb", "fuse", "ammeter", "voltmeter", "ohmmeter", "generic", "tgeneric", "twoport", "pR", "vR", "thermistor", "varistor",
      "crystal", "memristor", "dcvsource", "sqV", "push button", "pD", "tD", "VC", "rmeter", "oscope",
    ];
    for (const name of names) {
      const r = circuit(`\\draw (0,0) to[${name}, l=$x$, v=$v$, i=$i$, f=$f$, *-o] (2,1);`);
      assert.ok(r.svg, name);
      assert.ok(!/NaN|Infinity/.test(r.svg), name);
      assert.ok(!r.messages.some((m) => /not supported/.test(m.message)), `${name}: ${r.messages.map((m) => m.message).join("; ")}`);
    }
  });

  test("a zero-length bipole and huge sizes stay finite", () => {
    for (const src of ["\\draw (0,0) to[R=$R$] (0,0);", "\\ctikzset{bipoles/length=100cm}\\draw (0,0) to[C] (1,0);", "\\draw (0,0) to[R, v=$v$, i=$i$] (0.01,0);"]) {
      const r = circuit(src);
      assert.ok(!/NaN|Infinity/.test(r.svg ?? ""), src);
    }
  });
});

describe("circuitikz: nodes and anchors", () => {
  test("op amp anchors, and noinv input up", () => {
    const it = run("\\node[op amp] (oa) at (0,0) {};\\node[op amp, noinv input up] (ob) at (5,0) {};");
    const oa = it.nodes.get("oa")!;
    near(anchorPoint(oa, "out")[0], 1.19 * CM, 0.1);
    near(anchorPoint(oa, "out")[1], 0);
    assert.ok(anchorPoint(oa, "-")[1] > 0 && anchorPoint(oa, "+")[1] < 0);
    near(anchorPoint(oa, "-")[0], -1.19 * CM, 0.1);
    const ob = it.nodes.get("ob")!;
    assert.ok(anchorPoint(ob, "+")[1] > 0 && anchorPoint(ob, "-")[1] < 0);
  });

  test("anchors of a node can be used later in the same path", () => {
    const r = circuit("\\draw (0,0) node[op amp] (oa) {} (oa.out) -- ++(1,0);");
    const x = Math.round(1.19 * CM * 100) / 100;
    assert.ok(paths(r.svg).some((p) => new RegExp(`M${Math.floor(x)}\\.\\d+ 0L`).test(p)));
  });

  test("transistors: B C E, G D S; pmos has its source up; anchor=D places by the drain", () => {
    const it = run("\\node[npn] (q) at (0,0) {};\\node[nmos] (n) at (3,0) {};\\node[pmos] (p) at (6,0) {};\\draw (9,0) node[nmos, anchor=D] (m) {};");
    const q = it.nodes.get("q")!;
    assert.ok(anchorPoint(q, "C")[1] > 0 && anchorPoint(q, "E")[1] < 0 && anchorPoint(q, "B")[0] < 0);
    const n = it.nodes.get("n")!;
    assert.ok(anchorPoint(n, "D")[1] > 0 && anchorPoint(n, "S")[1] < 0 && anchorPoint(n, "G")[0] < 3 * CM);
    const p = it.nodes.get("p")!;
    assert.ok(anchorPoint(p, "S")[1] > 0 && anchorPoint(p, "D")[1] < 0);
    const m = it.nodes.get("m")!;
    near(anchorPoint(m, "D")[0], 9 * CM);
    near(anchorPoint(m, "D")[1], 0);
    near(anchorPoint(m, "drain")[1], 0);
  });

  test("xscale=-1 and yscale=-1 flip a node and its anchors", () => {
    const it = run("\\node[npn, xscale=-1] (q) at (0,0) {};\\node[op amp, yscale=-1] (o) at (4,0) {};");
    assert.ok(anchorPoint(it.nodes.get("q")!, "B")[0] > 0);
    assert.ok(anchorPoint(it.nodes.get("o")!, "-")[1] < 0);
  });

  test("logic ports: in 1, in 2, out; number inputs; european ports", () => {
    const it = run("\\node[and port] (a) at (0,0) {};\\node[nor port, number inputs=3] (b) at (0,3) {};");
    const a = it.nodes.get("a")!;
    assert.ok(anchorPoint(a, "in 1")[1] > anchorPoint(a, "in 2")[1]);
    assert.ok(anchorPoint(a, "out")[0] > 0 && anchorPoint(a, "in 1")[0] < 0);
    assert.ok(it.nodes.get("b")!.anchors?.has("in 3"));
    const eu = circuit("\\node[and port] at (0,0) {};", "european ports");
    assert.ok((eu.svg?.match(/<use /g) ?? []).length >= 1, "the & sign");
    for (const s of ["or port", "xor port", "nand port", "xnor port", "not port", "buffer port", "and IEEE port", "american or port", "flipflop D", "flipflop JK", "twoportshape"]) {
      const r = circuit(`\\node[${s}] (x) at (0,0) {};`);
      assert.ok(r.svg && !/NaN/.test(r.svg), s);
      assert.deepEqual(r.messages, [], s);
    }
  });

  test("transformer anchors, grounds, supplies and dots draw", () => {
    const it = run("\\node[transformer core] (T) at (0,0) {};");
    const T = it.nodes.get("T")!;
    assert.ok(anchorPoint(T, "A1")[0] < 0 && anchorPoint(T, "A1")[1] > 0);
    assert.ok(anchorPoint(T, "B2")[0] > 0 && anchorPoint(T, "B2")[1] < 0);
    for (const s of ["ground", "rground", "sground", "tground", "cground", "vcc", "vdd", "vee", "vss", "circ", "ocirc", "antenna", "loudspeaker"]) {
      const r = circuit(`\\draw (0,0) -- (1,0) node[${s}] {};`);
      assert.ok(r.svg && !/NaN/.test(r.svg), s);
      assert.deepEqual(r.messages, [], s);
    }
  });

  test("node labels (label=) and text on circuit nodes", () => {
    const r = circuit("\\node[circ, label=above:$A$] at (0,0) {};\\node[npn] at (2,0) {$Q_1$};");
    assert.ok((r.svg?.match(/<use /g) ?? []).length >= 3);
    assert.deepEqual(r.messages, []);
  });
});

describe("circuitikz: documents", () => {
  test("a circuitikz environment in LaTeX becomes a diagram image; no LTX004", () => {
    const ctx = memoryContext({}, "main.tex");
    const doc = parseLatex(
      "\\documentclass{article}\n\\usepackage[american]{circuitikz}\n\\begin{document}\n\\begin{circuitikz}\n\\draw (0,0) to[R=$R$] (2,0);\n\\end{circuitikz}\n\\end{document}",
      ctx,
    );
    const para = doc.blocks.find((b) => b.t === "Para") as Extract<Block, { t: "Para" }>;
    const img = para.content.find((i) => i.t === "Image") as Extract<Inline, { t: "Image" }>;
    assert.ok(img.attr?.classes?.includes("tw-diagram"));
    assert.deepEqual(ctx.diagnostics.items.map((d) => d.code), []);
  });

  test("package options reach the picture as \\ctikzset", () => {
    assert.match(picturePreamble("\\usepackage[european, siunitx]{circuitikz}\n\\begin{document}"), /\\ctikzset\{european, siunitx\}/);
    assert.equal(picturePreamble("\\usepackage{tikz}"), "");
    const eu = renderTikz("\\begin{circuitikz}\\draw (0,0) to[R] (3,0);\\end{circuitikz}", { preamble: "\\ctikzset{european}" });
    assert.ok(paths(eu.svg).some((p) => /stroke-width="0.8"/.test(p) && /Z"/.test(p)));
  });

  test("a ```tikz block in Markdown can hold a circuit", () => {
    const ctx = memoryContext({}, "doc.md");
    const doc = parseMarkdown("```tikz\n\\begin{circuitikz}\\draw (0,0) to[C=$C$] (2,0);\\end{circuitikz}\n```\n", ctx);
    const d = new Diagnostics();
    renderDocumentTikz(doc, d, "doc.md");
    assert.equal(doc.blocks[0].t, "Figure");
    assert.deepEqual(d.items, []);
  });

  test("deterministic, never throws, stays within its budget", () => {
    const src = "\\draw (0,0) to[V=$V$] (0,3) to[R=$R$, i=$i$] (3,3) to[L=$L$, v=$v$] (3,0) to[C, *-*] (0,0);\\node[op amp] (o) at (6,0) {};\\draw (o.out) to[short, -o] ++(1,0);";
    assert.equal(circuit(src).svg, circuit(src).svg);
    const pieces = ["to[R=$x$]", "to[", "(1,2)", "node[op amp]", "(o.out)", "--", "[american]", "to[C, *-o]", "node[ground]{}", "\\ctikzset{", "}", ";", "\\draw", "to[squid]", "v^<=", "(", "{"];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 150; k++) {
      let s = "\\draw (0,0) ";
      for (let j = 0; j < 12; j++) s += `${pieces[Math.floor(rnd() * pieces.length)]} `;
      assert.doesNotThrow(() => circuit(s));
    }
    const t0 = Date.now();
    const many = circuit("\\foreach \\i in {1,...,300} { \\draw (\\i,0) to[R=$R_{\\i}$, v=$v$, i=$i$, *-o] ++(1,1) node[ground]{}; }");
    assert.ok(many.svg);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  });
});
