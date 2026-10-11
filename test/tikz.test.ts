import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Block, Inline } from "../src/ast.js";
import { Diagnostics } from "../src/diagnostics.js";
import { memoryContext } from "../src/parse/context.js";
import { parseLatex } from "../src/parse/latex.js";
import { parseMarkdown } from "../src/parse/markdown.js";
import { parseArrowSpec } from "../src/tikz/arrows.js";
import { parseColor } from "../src/tikz/color.js";
import { ExprError, UNITS, evaluate, length } from "../src/tikz/expr.js";
import { lineCol, picturePreamble, renderTikz } from "../src/tikz/index.js";
import { Interp, anchorPoint } from "../src/tikz/interp.js";
import { expandList } from "../src/tikz/options.js";
import { renderAxis, tickLabel, ticksFor } from "../src/tikz/pgfplots.js";
import { parseOptions, splitTop } from "../src/tikz/scan.js";
import { initialState } from "../src/tikz/state.js";
import { renderDocumentTikz } from "../src/transform/tikz.js";

const CM = UNITS.cm;
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

/** Runs picture statements and returns the interpreter, to look at nodes and messages. */
function run(body: string, opts = ""): Interp {
  const it = new Interp({}, "t");
  it.axisHandler = renderAxis;
  const g = initialState();
  const r = `${opts ? `\\begin{scope}[${opts}]` : ""}${body}${opts ? "\\end{scope}" : ""}`;
  it.run(r, 0, true, g);
  return it;
}

const svgOf = (src: string) => Buffer.from(renderTikz(src).svg ?? "", "utf8").toString("utf8");

describe("pgfmath expressions", () => {
  test("arithmetic, functions in degrees, constants", () => {
    near(evaluate("2*cos(60)").v, 1);
    near(evaluate("sqrt(16) + 2^3").v, 12);
    near(evaluate("-2^2").v, -4);
    near(evaluate("sin(pi r)").v, 0);
    near(evaluate("atan2(1,1)").v, 45);
    near(evaluate("max(1, 5, 3) - min(2, 4)").v, 3);
    near(evaluate("3 > 2 ? 10 : 20").v, 10);
    near(evaluate("\\x * 2", { x: 4 }).v, 8);
    near(evaluate("x^2", { x: 3 }).v, 9);
  });

  test("units make lengths in points; unitless values stay numbers", () => {
    const a = evaluate("2cm");
    assert.equal(a.dim, true);
    near(a.v, 2 * CM);
    assert.equal(evaluate("1.5").dim, false);
    near(length("1in") ?? 0, 72.27);
    near(length("2", CM) ?? 0, 2 * CM);
    near(evaluate("1cm / 1mm").v, 10);
    assert.equal(evaluate("1cm / 1mm").dim, false);
    near(evaluate("0.5\\textwidth").v, 172.5);
  });

  test("radians on request (trig format=rad)", () => {
    near(evaluate("sin(x)", { x: Math.PI / 2 }, true).v, 1);
  });

  test("bad expressions throw ExprError", () => {
    assert.throws(() => evaluate("2 +"), ExprError);
    assert.throws(() => evaluate("foo(1)"), ExprError);
    assert.throws(() => evaluate("(1"), ExprError);
    assert.throws(() => evaluate("rnd"), ExprError);
  });
});

describe("option lists, foreach lists and colours", () => {
  test("options split at top-level commas, values lose their braces", () => {
    assert.deepEqual(parseOptions("draw, fill=red!20, label={[blue]above:$a,b$}, ->"), [
      { key: "draw", value: undefined },
      { key: "fill", value: "red!20" },
      { key: "label", value: "[blue]above:$a,b$" },
      { key: "->", value: undefined },
    ]);
    assert.deepEqual(splitTop("(1,2), {3,4}, 5"), ["(1,2)", " {3,4}", " 5"]);
  });

  test("foreach lists with ranges, steps, letters and pairs", () => {
    assert.deepEqual(expandList("1,...,5"), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(expandList("0,0.5,...,2"), ["0", "0.5", "1", "1.5", "2"]);
    assert.deepEqual(expandList("10,8,...,2"), ["10", "8", "6", "4", "2"]);
    assert.deepEqual(expandList("a,...,e"), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(expandList("1/a, 2/b"), ["1/a", "2/b"]);
    assert.equal(expandList("1,...,1000000", 100).length, 100);
  });

  test("xcolor names and mixes", () => {
    const c = (s: string) => parseColor(s, new Map(), undefined, "#000000");
    assert.equal(c("red"), "#ff0000");
    assert.equal(c("red!50!blue"), "#800080");
    assert.equal(c("black!20"), "#cccccc");
    assert.equal(c("blue!30!white"), "#b3b3ff");
    assert.equal(c("-red"), "#00ffff");
    assert.equal(c("ForestGreen"), "#009b55");
    assert.equal(c("nosuchcolour"), undefined);
    assert.equal(parseColor("brand", new Map(), (n) => (n === "brand" ? "#123456" : undefined), "#000000"), "#123456");
  });

  test("arrow specs", () => {
    const a = parseArrowSpec("->");
    assert.equal(a?.end[0].kind, "default");
    assert.deepEqual(a?.start, []);
    assert.equal(parseArrowSpec("<->")?.start.length, 1);
    const s = parseArrowSpec("-{Stealth[length=3mm, open]}");
    assert.equal(s?.end[0].kind, "stealth");
    near(s?.end[0].length ?? 0, 3 * UNITS.mm);
    assert.equal(s?.end[0].open, true);
    assert.equal(parseArrowSpec("|-latex")?.start[0].kind, "bar");
    assert.equal(parseArrowSpec("->>")?.end.length, 2);
    assert.equal(parseArrowSpec("thick"), undefined);
    assert.equal(parseArrowSpec("near-start"), undefined);
  });
});

describe("coordinates", () => {
  test("cartesian, polar, units and transformations", () => {
    const it = run("");
    const g = initialState();
    assert.deepEqual(it.coord("1,2", g)?.p.map((v) => +v.toFixed(3)), [+CM.toFixed(3), +(2 * CM).toFixed(3)]);
    const p = it.coord("90:2", g)?.p ?? [9, 9];
    near(p[0], 0);
    near(p[1], 2 * CM);
    const q = it.coord("1cm,10pt", g)?.p ?? [0, 0];
    near(q[0], CM);
    near(q[1], 10);
    const r = it.coord("{2*cos(60)},{sqrt(4)}", g)?.p ?? [0, 0];
    near(r[0], CM);
    near(r[1], 2 * CM);
  });

  test("named nodes, anchors, calc and perpendicular coordinates", () => {
    const it = run("\\coordinate (a) at (0,0); \\coordinate (b) at (2,4); \\node[draw, minimum width=2cm, minimum height=1cm, inner sep=0pt] (n) at (5,0) {};");
    const g = initialState();
    const mid = it.coord("$(a)!0.5!(b)$", g)?.p ?? [0, 0];
    near(mid[0], CM);
    near(mid[1], 2 * CM);
    const plus = it.coord("$(b)+(1,0)$", g)?.p ?? [0, 0];
    near(plus[0], 3 * CM);
    const perp = it.coord("a |- b", g)?.p ?? [9, 9];
    near(perp[0], 0);
    near(perp[1], 4 * CM);
    const ne = it.coord("n.north east", g)?.p ?? [0, 0];
    // Half the minimum size plus half the line width (outer sep).
    near(ne[0], 6 * CM + 0.2, 0.05);
    near(ne[1], 0.5 * CM + 0.2, 0.05);
    const ang = it.coord("n.0", g)?.p ?? [0, 0];
    near(ang[0], 6 * CM + 0.2, 0.05);
    near(ang[1], 0);
    assert.equal(it.coord("nowhere", g), undefined);
    assert.ok(it.messages.some((m) => /nowhere/.test(m.message)));
  });

  test("relative coordinates move the current point with ++ only", () => {
    const it = run("\\draw (1,1) ++(1,0) coordinate (p) ++(0,1) coordinate (q) +(5,5) coordinate (r) +(0,-1) coordinate (s);");
    const at = (n: string) => it.nodes.get(n)?.center ?? [NaN, NaN];
    near(at("p")[0], 2 * CM);
    near(at("q")[1], 2 * CM);
    near(at("r")[0], 7 * CM);
    near(at("s")[0], 2 * CM);
    near(at("s")[1], CM);
  });

  test("scale and shift in scopes", () => {
    const it = run("\\begin{scope}[shift={(1,0)}, scale=2] \\coordinate (p) at (1,1); \\end{scope}");
    const p = it.nodes.get("p")?.center ?? [0, 0];
    near(p[0], 3 * CM);
    near(p[1], 2 * CM);
  });
});

describe("paths and nodes", () => {
  test("a rectangle, a circle and an arc produce paths with the right extent", () => {
    const r = renderTikz("\\draw (0,0) rectangle (2,1);");
    near(r.width, 2 * CM + 0.4, 0.05);
    near(r.height, CM + 0.4, 0.05);
    const c = renderTikz("\\draw (0,0) circle (1);");
    near(c.width, 2 * CM + 0.4, 0.05);
    const a = renderTikz("\\draw (1,0) arc (0:90:1);");
    near(a.width, CM + 0.4, 0.05);
    near(a.height, CM + 0.4, 0.05);
  });

  test("line widths, dashes, colours and opacity reach the SVG", () => {
    const s = svgOf("\\draw[very thick, dashed, red, fill=blue!20, fill opacity=0.5] (0,0) -- (1,0) -- (1,1) -- cycle;");
    assert.match(s, /stroke="#ff0000"/);
    assert.match(s, /stroke-width="1.2"/);
    assert.match(s, /stroke-dasharray="3 3"/);
    assert.match(s, /fill="#ccccff"/);
    assert.match(s, /fill-opacity="0.5"/);
  });

  test("arrow tips are drawn and the line is shortened under them", () => {
    const plain = svgOf("\\draw (0,0) -- (2,0);");
    const arrow = svgOf("\\draw[-stealth] (0,0) -- (2,0);");
    assert.equal((plain.match(/<path/g) ?? []).length, 1);
    assert.equal((arrow.match(/<path/g) ?? []).length, 2);
    assert.match(arrow, /M0 0L5\d\.\d+ 0/);
  });

  test("lines between nodes stop at their borders", () => {
    const it = run("\\node[draw, circle, minimum size=1cm, inner sep=0pt] (a) at (0,0) {}; \\node[draw, minimum size=1cm, inner sep=0pt] (b) at (3,0) {}; \\draw (a) -- (b);");
    const svg = it.scene.svg() ?? "";
    // From the circle's right edge (0.5cm + outer sep) to the square's left edge.
    assert.match(svg, /M14\.\d+ 0L70\.\d+ 0/);
  });

  test("positioning: right=of puts borders a node distance apart", () => {
    const it = run("\\node[draw, minimum width=1cm, inner sep=0pt] (a) {}; \\node[draw, minimum width=1cm, inner sep=0pt, right=of a] (b) {}; \\node[below=5mm of a, draw, minimum size=1cm, inner sep=0pt] (c) {};");
    const a = it.nodes.get("a")!;
    const b = it.nodes.get("b")!;
    near(anchorPoint(b, "west")[0] - anchorPoint(a, "east")[0], CM, 0.05);
    near(b.center[1], a.center[1]);
    const c = it.nodes.get("c")!;
    near(anchorPoint(a, "south")[1] - anchorPoint(c, "north")[1], 5 * UNITS.mm, 0.05);
  });

  test("above, below left and anchor place a node relative to its point", () => {
    const it = run("\\node[above, inner sep=0pt, minimum size=1cm] (a) at (0,0) {}; \\node[anchor=north west, inner sep=0pt, minimum size=1cm] (b) at (0,0) {};");
    near(it.nodes.get("a")!.center[1], 0.5 * CM, 0.05);
    near(it.nodes.get("b")!.center[0], 0.5 * CM, 0.05);
    near(it.nodes.get("b")!.center[1], -0.5 * CM, 0.05);
  });

  test("nodes on a path: midway, pos, and the default for nodes before the target", () => {
    const it = run("\\draw (0,0) -- node[coordinate] (m) {} (4,0) node[pos=0.25, coordinate] (q) {} -- (4,4) node[coordinate] (e) {};");
    near(it.nodes.get("m")!.center[0], 2 * CM);
    // pos refers to the segment before the node, (0,0) -- (4,0).
    near(it.nodes.get("q")!.center[0], CM);
    near(it.nodes.get("q")!.center[1], 0);
    near(it.nodes.get("e")!.center[1], 4 * CM);
  });

  test("node text is typeset: math, bold and line breaks", () => {
    const one = renderTikz("\\node {x};");
    const two = renderTikz("\\node[align=center] {x\\\\y};");
    assert.ok(two.height > one.height * 1.5);
    const math = svgOf("\\node {$\\alpha^2$};");
    assert.match(math, /<use href="#/);
  });

  test("foreach with pairs, nested loops, count and evaluate", () => {
    const it = run("\\foreach \\x/\\n in {1/a, 2/b, 3/c} \\coordinate (\\n) at (\\x,0); \\foreach \\i in {1,2} \\foreach \\j in {1,2} \\coordinate (p\\i\\j) at (\\i,\\j); \\foreach \\x [count=\\k, evaluate=\\x as \\y using \\x*2] in {5,6} \\coordinate (c\\k) at (\\y,0);");
    near(it.nodes.get("c")!.center[0], 3 * CM);
    near(it.nodes.get("p21")!.center[0], 2 * CM);
    near(it.nodes.get("p12")!.center[1], 2 * CM);
    near(it.nodes.get("c2")!.center[0], 12 * CM);
  });

  test("styles: /.style, arguments, \\tikzset, \\tikzstyle and every node", () => {
    const s = svgOf("\\tikzset{hl/.style={draw=#1, thick}, hl/.default=red} \\tikzstyle{boxed}=[draw, fill=yellow] \\node[hl] {a}; \\node[hl=blue] at (1,0) {b}; \\node[boxed] at (2,0) {c};");
    assert.match(s, /stroke="#ff0000"/);
    assert.match(s, /stroke="#0000ff"/);
    assert.match(s, /fill="#ffff00"/);
    const t = renderTikz("\\begin{tikzpicture}[every node/.style={draw}]\\node {a};\\end{tikzpicture}");
    assert.match(t.svg ?? "", /stroke="#000000"/);
  });

  test("macros: \\def, \\pgfmathsetmacro and \\newcommand in coordinates", () => {
    const it = run("\\def\\w{3} \\pgfmathsetmacro{\\h}{\\w/2} \\newcommand{\\pt}[2]{(#1,#2)} \\coordinate (a) at (\\w,\\h); \\coordinate (b) at \\pt{1}{2};");
    near(it.nodes.get("a")!.center[1], 1.5 * CM);
    near(it.nodes.get("b")!.center[1], 2 * CM);
  });

  test("plots of functions and coordinates", () => {
    const r = renderTikz("\\draw[domain=0:2, samples=21] plot (\\x, {\\x*\\x});");
    near(r.height, 4 * CM + 0.4, 0.2);
    const c = renderTikz("\\draw plot[smooth] coordinates {(0,0) (1,1) (2,0)};");
    assert.match(c.svg ?? "", /C/);
  });

  test("to paths bend and loop", () => {
    const s = svgOf("\\node (a) {a}; \\node (b) at (2,0) {b}; \\draw (a) to[bend left] (b); \\draw (a) edge[loop above] (a);");
    assert.equal((s.match(/<path d="M[^"]*C/g) ?? []).length >= 2, true);
  });

  test("matrix of nodes names its cells", () => {
    const it = run("\\matrix (m) [matrix of nodes, column sep=1cm] { a & b \\\\ c & d \\\\ };");
    assert.ok(it.nodes.has("m-1-1"));
    assert.ok(it.nodes.get("m-1-2")!.center[0] > it.nodes.get("m-1-1")!.center[0]);
    assert.ok(it.nodes.get("m-2-1")!.center[1] < it.nodes.get("m-1-1")!.center[1]);
  });
});

describe("pgfplots", () => {
  test("nice ticks", () => {
    assert.deepEqual(ticksFor(0, 2.5, 160, false), [0, 0.5, 1, 1.5, 2, 2.5]);
    assert.deepEqual(ticksFor(0, 100, 200, false), [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(ticksFor(-1, 3, 200, true), [-1, 0, 1, 2, 3]);
    assert.equal(tickLabel(1000, 0), "$1{,}000$");
    assert.equal(tickLabel(-0.25, 0), "$-0.25$");
  });

  test("an axis with two series and a legend", () => {
    const r = renderTikz("\\begin{tikzpicture}\\begin{axis}[xlabel=x, legend pos=north west]\\addplot coordinates {(0,0) (1,1) (2,4)}; \\addplot {x}; \\legend{a, b}\\end{axis}\\end{tikzpicture}");
    assert.ok(r.svg);
    assert.equal(r.messages.length, 0, JSON.stringify(r.messages));
    // Palette colours for plots without options.
    assert.match(r.svg!, /#4e79a7/);
    assert.match(r.svg!, /#e8a33d/);
  });

  test("bar charts with symbolic coordinates", () => {
    const r = renderTikz("\\begin{axis}[ybar, symbolic x coords={a,b,c}, xtick=data]\\addplot coordinates {(a,1) (b,3) (c,2)};\\end{axis}");
    assert.ok(r.svg);
    assert.equal(r.messages.length, 0, JSON.stringify(r.messages));
  });

  test("inline tables, axis cs nodes and log axes", () => {
    const r = renderTikz("\\begin{axis}[ymode=log]\\addplot table {x y\n1 10\n2 100\n3 1000\n}; \\node at (axis cs:2,100) {here};\\end{axis}");
    assert.ok(r.svg);
    assert.equal(r.messages.length, 0, JSON.stringify(r.messages));
  });
});

describe("errors and limits", () => {
  test("unknown options and commands are reported once and skipped", () => {
    const r = renderTikz("\\draw[frobnicate] (0,0) -- (1,1); \\draw[frobnicate] (0,0) -- (1,0); \\frob{x}; \\draw (0,0) -- (1,1);");
    assert.ok(r.svg);
    assert.equal(r.messages.filter((m) => /frobnicate/.test(m.message)).length, 1);
    assert.equal(r.messages.filter((m) => /frob is not supported/.test(m.message)).length, 1);
  });

  test("message offsets point into the source", () => {
    const src = "\\draw (0,0) -- (1,1);\n\\draw[bogus key] (0,0) -- (1,0);";
    const r = renderTikz(src);
    const m = r.messages.find((x) => /bogus/.test(x.message))!;
    assert.deepEqual(lineCol(src, m.offset), { line: 2, col: 1 });
  });

  test("a picture with nothing drawable has no SVG", () => {
    assert.equal(renderTikz("\\begin{tikzpicture}\\end{tikzpicture}").svg, undefined);
    assert.equal(renderTikz("\\frob").svg, undefined);
  });

  test("hostile input stays fast and never throws", () => {
    for (const src of [
      "\\foreach \\i in {1,...,100000} \\draw (\\i,0) -- (\\i,1);",
      "\\def\\a{\\a\\a}\\draw (0,0) -- (\\a,1);",
      "\\tikzset{a/.style={b,b}, b/.style={a,a}}\\draw[a] (0,0) -- (1,1);",
      "\\draw[domain=0:1, samples=100000000] plot (\\x, {\\x});",
      `\\draw (0,0${"(".repeat(5000)}`,
      "\\begin{scope}".repeat(2000),
    ]) {
      const t = Date.now();
      renderTikz(src);
      assert.ok(Date.now() - t < 2500, `too slow: ${src.slice(0, 40)}`);
    }
  });
});

describe("in documents", () => {
  const find = (blocks: Block[], t: string): Block[] => blocks.flatMap((b) => [...(b.t === t ? [b] : []), ...("blocks" in b && Array.isArray(b.blocks) ? find(b.blocks as Block[], t) : []), ...(b.t === "Figure" ? find(b.content, t) : [])]);

  test("a tikzpicture in a figure becomes a diagram image; no LTX004", () => {
    const ctx = memoryContext({}, "main.tex");
    const doc = parseLatex("\\begin{figure}\n\\centering\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\draw[bogus] (0,0) -- (1,0);\n\\end{tikzpicture}\n\\caption{Drawn}\\label{fig:d}\n\\end{figure}", ctx);
    const fig = doc.blocks[0] as Extract<Block, { t: "Figure" }>;
    assert.equal(fig.t, "Figure");
    assert.equal(fig.label, "fig:d");
    const plain = fig.content[0] as Extract<Block, { t: "Plain" }>;
    const img = plain.content.find((i) => i.t === "Image") as Extract<Inline, { t: "Image" }>;
    assert.ok(img.src.startsWith("data:image/svg+xml;base64,"));
    assert.ok(img.attr?.classes?.includes("tw-diagram"));
    const codes = ctx.diagnostics.items.map((d) => `${d.code}@${d.line}`);
    assert.deepEqual(codes, ["TIKZ001@5"]);
  });

  test("\\tikz inline draws; PSTricks keeps LTX004", () => {
    const ctx = memoryContext({}, "main.tex");
    const doc = parseLatex("A \\tikz \\fill (0,0) circle (2pt); dot.\n\n\\begin{pspicture}(0,0)(1,1)\\end{pspicture}", ctx);
    const para = doc.blocks[0] as Extract<Block, { t: "Para" }>;
    assert.ok(para.content.some((i) => i.t === "Image"));
    assert.deepEqual(ctx.diagnostics.items.map((d) => d.code), ["LTX004"]);
  });

  test("preamble styles apply to pictures", () => {
    const src = "\\tikzset{mine/.style={draw=red}}\n\\tikzstyle{other}=[fill=blue]\n\\begin{document}";
    assert.match(picturePreamble(src), /mine\/\.style/);
    assert.match(picturePreamble(src), /tikzstyle\{other\}/);
    const ctx = memoryContext({}, "main.tex");
    const doc = parseLatex(`\\documentclass{article}\n${src}\n\\begin{tikzpicture}\\node[mine] {x};\\end{tikzpicture}\n\\end{document}`, ctx);
    const img = find(doc.blocks, "Para").flatMap((p) => (p as Extract<Block, { t: "Para" }>).content).find((i) => i.t === "Image") as Extract<Inline, { t: "Image" }>;
    assert.match(Buffer.from(img.src.split(",")[1], "base64").toString("utf8"), /stroke="#ff0000"/);
    assert.deepEqual(ctx.diagnostics.items.filter((d) => d.code === "TIKZ001"), []);
  });

  test("siunitx and mhchem commands in node text are set as math", () => {
    const ctx = memoryContext({}, "main.tex");
    parseLatex("\\begin{tikzpicture}\\node {Temperature (\\si{\\celsius})}; \\node at (0,1) {\\SI{9.81}{\\meter\\per\\second\\squared}, \\num{12345}, \\ce{H2O}};\\end{tikzpicture}", ctx);
    assert.deepEqual(ctx.diagnostics.items.filter((d) => d.code === "TIKZ001"), []);
  });

  test("```tikz blocks in Markdown become figures", () => {
    const ctx = memoryContext({}, "doc.md");
    const doc = parseMarkdown('```{.tikz #fig:t caption="T"}\n\\draw (0,0) -- (1,1);\n\\draw[bogus] (0,0) -- (1,0);\n```\n', ctx);
    const d = new Diagnostics();
    renderDocumentTikz(doc, d, "doc.md");
    const fig = doc.blocks[0] as Extract<Block, { t: "Figure" }>;
    assert.equal(fig.t, "Figure");
    assert.equal(fig.label, "fig:t");
    assert.deepEqual(d.items.map((x) => `${x.code}@${x.line}`), ["TIKZ001@3"]);
    const bad = parseMarkdown("```tikz\nnot tikz\n```\n", ctx);
    const d2 = new Diagnostics();
    renderDocumentTikz(bad, d2, "doc.md");
    assert.equal(bad.blocks[0].t, "CodeBlock");
    assert.equal(d2.items[0].severity, "error");
  });
});
