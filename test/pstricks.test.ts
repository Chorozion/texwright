import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Block, Inline } from "../src/ast.js";
import { memoryContext } from "../src/parse/context.js";
import { parseLatex } from "../src/parse/latex.js";
import { pstricksPreambleCommands, renderPstricks } from "../src/pstricks/index.js";
import { PstInterp } from "../src/pstricks/interp.js";
import { RpnError, compileAlgebraic, compileRpn, texNumber } from "../src/pstricks/rpn.js";
import { CM, dimen, initialState, parseArrows, psset } from "../src/pstricks/state.js";

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);
const rpn = (code: string, x = 0) => compileRpn(code)({ x });
const alg = (code: string, x = 0) => compileAlgebraic(code)({ x });

/** Runs a picture body and returns the interpreter, to look at nodes, the scene and messages. */
function run(body: string): PstInterp {
  const it = new PstInterp({}, "t");
  it.run(body, 0, initialState());
  return it;
}

function svgText(src: string): string {
  return renderPstricks(src).svg ?? "";
}

function find(blocks: Block[], t: string): Block[] {
  const out: Block[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === t) out.push(b);
      if ("blocks" in b && Array.isArray(b.blocks)) walk(b.blocks as Block[]);
      if (b.t === "Figure") walk(b.content);
    }
  };
  walk(blocks);
  return out;
}

describe("PostScript (RPN) functions", () => {
  test("arithmetic and stack operators", () => {
    assert.deepEqual(rpn("x 2 exp", 3), [9]);
    assert.deepEqual(rpn("x dup mul 1 sub", 2), [3]);
    assert.deepEqual(rpn("2 3 exch sub"), [1]);
    assert.deepEqual(rpn("1 2 3 3 1 roll"), [3, 1, 2]);
    assert.deepEqual(rpn("5 2 idiv 7 3 mod"), [2, 1]);
    assert.deepEqual(rpn("1 2 3 2 copy"), [1, 2, 3, 2, 3]);
    assert.deepEqual(rpn("4 sqrt neg abs"), [2]);
  });

  test("trigonometry is in degrees, as in PostScript", () => {
    near(rpn("x sin", 30)[0], 0.5);
    near(rpn("x cos", 60)[0], 0.5);
    near(rpn("1 1 atan")[0], 45);
    near(rpn("x RadtoDeg sin", Math.PI / 2)[0], 1);
    near(rpn("x 57.2958 mul sin", Math.PI / 6)[0], 0.5, 1e-4);
    near(rpn("2.71828 x exp", 1)[0], 2.71828);
    near(rpn("x ln", Math.E)[0], 1);
    near(rpn("100 log")[0], 2);
  });

  test("def, if and ifelse", () => {
    assert.deepEqual(rpn("/a 3 def a a mul"), [9]);
    assert.deepEqual(rpn("x 0 lt { x neg } { x } ifelse", -4), [4]);
    assert.deepEqual(rpn("x 0 gt { 1 } if", 2), [1]);
  });

  test("errors are RpnError, and runaway code is capped", () => {
    assert.throws(() => rpn("x foo"), RpnError);
    assert.throws(() => rpn("add"), RpnError);
    assert.throws(() => rpn("/f { f } def f"), RpnError);
    assert.throws(() => rpn("/f { 1 f f } def f"), RpnError);
    assert.throws(() => compileRpn("x".repeat(5000)), RpnError);
  });
});

describe("algebraic functions", () => {
  test("infix with radians", () => {
    near(alg("sin(x)", Math.PI / 2), 1);
    near(alg("x^2+2*x+1", 2), 9);
    near(alg("-x^2", 3), -9);
    near(alg("2x", 3), 6);
    near(alg("Pi/2"), Math.PI / 2);
    near(alg("sqrt(abs(x))", -16), 4);
    near(alg("log(100)+ln(E)"), 3);
    near(alg("exp(-x^2/2)", 0), 1);
    near(compileAlgebraic("t/(3*Pi)*cos(t)")({ t: 0 }), 0);
  });

  test("errors", () => {
    assert.throws(() => alg("sin("), RpnError);
    assert.throws(() => alg("x +* 2"), RpnError);
    assert.throws(() => alg("y + 1"), RpnError);
    assert.throws(() => alg("(".repeat(300) + "x" + ")".repeat(300)), RpnError);
  });

  test("numbers in arguments", () => {
    near(texNumber("2*Pi")!, 2 * Math.PI);
    near(texNumber("Pi 2 mul")!, 2 * Math.PI);
    assert.equal(texNumber("-3.14"), -3.14);
    assert.equal(texNumber("\\psPi"), Math.PI);
    assert.equal(texNumber("bogus"), undefined);
  });
});

describe("parameters", () => {
  const host = { unknown: () => {}, colors: { local: new Map() }, styles: new Map<string, string>() };

  test("a bare length is in units, as \\pssetlength reads it", () => {
    const st = initialState();
    psset(st, "unit=0.5, linewidth=0.1", host);
    near(st.xunit, 0.5 * CM);
    near(st.lw, 0.05 * CM);
    psset(st, "linewidth=2pt, dash=4pt 2pt, framearc=0.3", host);
    assert.equal(st.lw, 2);
    assert.deepEqual(st.dash, [4, 2]);
    assert.equal(st.framearc, 0.3);
    near(dimen("1cm", 1, st)!, CM);
  });

  test("colours, styles and fill styles", () => {
    const st = initialState();
    const h = { ...host, styles: new Map([["thick", "linewidth=3pt,linecolor=blue"]]) };
    psset(st, "style=thick, fillstyle=solid, fillcolor=red!50", h);
    assert.equal(st.lw, 3);
    assert.equal(st.lc, "#0000ff");
    assert.equal(st.fc, "#ff8080");
    assert.equal(st.fillstyle, "solid");
  });

  test("arrow specs", () => {
    const st = initialState();
    assert.deepEqual(parseArrows("-", st), { shortenS: 0, shortenE: 0 });
    const a = parseArrows("->", st)!;
    assert.equal(a.spec?.end[0].kind, "stealth");
    assert.equal(a.spec?.start.length, 0);
    // A PSTricks arrowhead on a 0.8pt line: width 2pt + 3 * 0.8pt, length 1.4 times that.
    near(a.spec!.end[0].width!, 4.4);
    near(a.spec!.end[0].length!, 6.16);
    const b = parseArrows("<->", st)!;
    assert.equal(b.spec?.start[0].kind, "stealth");
    const c = parseArrows("*-o", st)!;
    assert.equal(c.spec?.start[0].kind, "circle");
    assert.ok(c.shortenS < 0, "dots are centred on the end point");
    assert.equal(parseArrows("|-|", st)?.spec?.end[0].kind, "bar");
    assert.equal(parseArrows("<<->>", st)?.spec?.end.length, 2);
    assert.equal(parseArrows("c-c", st)?.cap, "round");
    assert.equal(parseArrows("hello", st), undefined);
  });
});

describe("coordinates", () => {
  test("cartesian, units, polar, PostScript, nodes and (a|b)", () => {
    const it = run("\\psset{unit=2cm}\\pnode(1,1){A}\\pnode(3,0){B}");
    const st = initialState();
    st.xunit = st.yunit = 2 * CM;
    const p = it.coord("1,2", st)!;
    near(p[0], 2 * CM);
    near(p[1], 4 * CM);
    const q = it.coord("1cm,2pt", st)!;
    near(q[0], CM);
    near(q[1], 2);
    const r = it.coord("1;90", st)!;
    near(r[0], 0);
    near(r[1], 2 * CM);
    const s = it.coord("!1 2 add 3", st)!;
    near(s[0], 6 * CM);
    near(s[1], 6 * CM);
    const a = it.coord("A", st)!;
    near(a[0], 2 * CM);
    const ab = it.coord("A|B", st)!;
    near(ab[0], 2 * CM);
    near(ab[1], 0);
    assert.equal(it.coord("nowhere", st), undefined);
    assert.ok(it.messages.some((m) => /Unknown node/.test(m.message)));
  });

  test("\\multido variables", () => {
    const it = run("\\multido{\\i=0+1,\\r=0.5+0.5,\\n=1.0+0.5}{3}{\\pnode(\\r,\\n){p\\i}}");
    near(it.nodes.get("p2")!.center[0], 1.5 * CM);
    near(it.nodes.get("p2")!.center[1], 2 * CM);
  });

  test("macros in coordinates and \\rput's frame", () => {
    const it = run("\\def\\a{2}\\newcommand{\\pt}[2]{\\pnode(#1,#2){m}}\\pt{\\a}{1}\\rput{90}(1,0){\\pnode(1,0){r}}");
    near(it.nodes.get("m")!.center[0], 2 * CM);
    const r = it.nodes.get("r")!.center;
    near(r[0], CM);
    near(r[1], CM);
  });
});

describe("drawing", () => {
  test("a picture is an SVG that keeps its declared box", () => {
    const r = renderPstricks("\\begin{pspicture}(-1,-1)(3,2)\\psline{->}(0,0)(1,1)\\end{pspicture}");
    assert.ok(r.svg?.startsWith("<svg"));
    assert.ok(r.drawn > 0);
    near(r.width, 4 * CM, 1);
    near(r.height, 3 * CM, 1);
    assert.deepEqual(r.messages, []);
  });

  test("defaults: 0.8pt black lines, filled dots, solid fills", () => {
    const s = svgText("\\begin{pspicture}(2,2)\\psline(0,0)(1,1)\\psdot(1,1)\\psframe[fillstyle=solid,fillcolor=yellow](0,0)(1,1)\\end{pspicture}");
    assert.match(s, /stroke="#000000" stroke-width="0.8"/);
    assert.match(s, /fill="#ffff00"/);
  });

  test("dashed, dotted, double lines, shadows, hatching and gradients", () => {
    const s = svgText(
      "\\begin{pspicture}(4,4)\\psline[linestyle=dashed](0,0)(1,0)\\psline[linestyle=dotted](0,1)(1,1)\\psline[doubleline=true](0,2)(1,2)\\psframe[shadow=true](2,0)(3,1)\\psframe[fillstyle=crosshatch](2,2)(3,3)\\pscircle[fillstyle=gradient,gradbegin=red,gradend=blue](1,3){0.5}\\end{pspicture}",
    );
    assert.match(s, /stroke-dasharray="5 3"/);
    assert.match(s, /stroke-linecap="round"/);
    assert.match(s, /stroke="#ffffff"/);
    assert.match(s, /fill="#404040"/);
    assert.match(s, /clip-path=/);
    assert.match(s, /<linearGradient/);
  });

  test("pspicture* clips to its box", () => {
    const r = renderPstricks("\\begin{pspicture*}(0,0)(1,1)\\pscircle(0,0){2}\\end{pspicture*}");
    assert.match(r.svg!, /clipPath/);
    near(r.width, CM, 1);
  });

  test("plots draw finite points only", () => {
    const s = svgText("\\begin{pspicture}(-2,-2)(2,2)\\psplot{-1}{1}{1 x div}\\psplot[algebraic]{-2}{2}{tan(x)}\\psplot{0}{10}{x ln}\\end{pspicture}");
    assert.ok(s.length > 0);
    assert.doesNotMatch(s, /NaN|Infinity/);
  });

  test("psaxes draws ticks and labels; labels=none leaves the labels out", () => {
    const full = renderPstricks("\\begin{pspicture}(-1,-1)(3,3)\\psaxes{->}(0,0)(-1,-1)(3,3)\\end{pspicture}").svg!;
    const bare = renderPstricks("\\begin{pspicture}(-1,-1)(3,3)\\psaxes[labels=none]{->}(0,0)(-1,-1)(3,3)\\end{pspicture}").svg!;
    const uses = (s: string) => (s.match(/<use /g) ?? []).length;
    // -1, 1, 2, 3 on each axis (the origin is skipped where the axes cross).
    assert.ok(uses(full) >= 8, `${uses(full)} glyphs`);
    assert.equal(uses(bare), 0);
  });

  test("node connections end on the node outline, nodesep further out", () => {
    const it = run("\\cnode(0,0){0.5}{A}\\cnode(3,0){0.5}{B}\\ncline[nodesep=2pt]{->}{A}{B}\\naput{x}");
    const c = it.lastConn!;
    near(c.pts[0][0], 0.5 * CM + 0.4 + 2, 0.05);
    near(c.pts[1][0], 2.5 * CM - 0.4 - 2, 0.05);
    assert.equal(it.messages.length, 0);
  });

  test("trees: children below their parent, names registered", () => {
    const it = run("\\pstree[levelsep=1cm]{\\Tcircle[name=r]{a}}{\\TR[name=b]{b} \\TR[name=c]{c}}");
    const r = it.nodes.get("r")!.center;
    const b = it.nodes.get("b")!.center;
    const c = it.nodes.get("c")!.center;
    near(r[1] - b[1], CM);
    assert.ok(b[0] < r[0] && r[0] < c[0]);
    near(r[0] - b[0], c[0] - r[0]);
  });

  test("pst-eucl constructions", () => {
    const it = run("\\pstGeonode(0,0){A}(4,0){B}(1,3){C}\\pstProjection{A}{B}{C}[H]\\pstMiddleAB{A}{B}{M}\\pstInterLL{A}{C}{B}{M}{X}");
    near(it.nodes.get("H")!.center[0], CM);
    near(it.nodes.get("H")!.center[1], 0);
    near(it.nodes.get("M")!.center[0], 2 * CM);
    assert.ok(it.nodes.has("X"));
  });

  test("pst-3dplot projects with Alpha=45, Beta=30", () => {
    const it = run("\\pstThreeDNode(1,1,0){P}\\pstThreeDNode(0,0,1){Z}");
    near(it.nodes.get("P")!.center[0], 0);
    near(it.nodes.get("Z")!.center[1], Math.cos(Math.PI / 6) * CM);
  });

  test("unknown commands warn and drawing goes on", () => {
    const r = renderPstricks("\\begin{pspicture}(2,2)\\psfancything[a=1](0,0){x}\\psline(0,0)(1,1)\\end{pspicture}");
    assert.ok(r.svg);
    assert.ok(r.messages.some((m) => /\\psfancything/.test(m.message)));
  });

  test("text colour switches and origin=", () => {
    const s = svgText("\\begin{pspicture}(2,2)\\rput(1,1){\\color{red}$x$}\\rput(0,0){{\\blue A}}\\rput(1,0){\\textcolor{green}{B}}\\end{pspicture}");
    assert.match(s, /fill="#ff0000"/);
    assert.match(s, /fill="#0000ff"/);
    assert.match(s, /fill="#00ff00"/);
    const it = run("\\psset{origin={1,1}}\\pnode(1,0){A}");
    near(it.nodes.get("A")!.center[0], 2 * CM);
    near(it.nodes.get("A")!.center[1], CM);
  });

  test("plain TeX \\pspicture ... \\endpspicture", () => {
    const r = renderPstricks("\\pspicture(0,0)(2,1)\\psline(0,0)(2,1)\\endpspicture");
    assert.ok(r.svg);
    near(r.width, 2 * CM, 1);
  });

  test("the same picture draws the same SVG", () => {
    const src = "\\begin{pspicture}(3,3)\\psplot[plotpoints=100]{0}{3}{x sin}\\rput(1,1){$x^2$}\\pscircle*(2,2){0.3}\\end{pspicture}";
    assert.equal(svgText(src), svgText(src));
  });
});

describe("limits and hostile input", () => {
  const timed = (src: string) => {
    const t0 = Date.now();
    const r = renderPstricks(src);
    return { r, ms: Date.now() - t0 };
  };

  test("huge loops are capped", () => {
    const { r, ms } = timed("\\begin{pspicture}(2,2)\\multido{\\i=0+1}{100000000}{\\psline(0,0)(1,\\i)}\\end{pspicture}");
    assert.ok(ms < 3000, `${ms} ms`);
    assert.ok(r.messages.length > 0);
  });

  test("nested loops are capped by the total", () => {
    const { r, ms } = timed("\\begin{pspicture}(2,2)\\multido{\\i=0+1}{5000}{\\multido{\\j=0+1}{5000}{\\psdot(0,0)}}\\end{pspicture}");
    assert.ok(ms < 3000, `${ms} ms`);
    assert.ok(r.messages.some((m) => /too many|too long|too large/.test(m.message)));
  });

  test("recursive macros stop", () => {
    const { r, ms } = timed("\\begin{pspicture}(2,2)\\def\\a{\\a\\a}\\a\\end{pspicture}");
    assert.ok(ms < 3000, `${ms} ms`);
    assert.ok(r.messages.length > 0);
  });

  test("garbage never throws and never writes NaN", () => {
    const pieces = ["\\psline", "\\pscircle", "\\rput", "\\psplot", "(", ")", "{", "}", "[", "]", "1,2", "x", "\\psset{unit=0}", "\\ncline{a}{b}", "\\pstree", "\\psaxes", "->", "*", "\\multido", "!", ";", "|", "\\naput", "\\psframebox", "1e400", "-0", "\\psgrid", "\\pscustom", "\\psclip", "\\endpsclip"];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let k = 0; k < 200; k++) {
      let body = "";
      for (let j = 0; j < 30; j++) body += pieces[Math.floor(rand() * pieces.length)];
      const r = renderPstricks(`\\begin{pspicture}(-2,-2)(2,2)${body}\\end{pspicture}`, { budgetMs: 300 });
      assert.doesNotMatch(r.svg ?? "", /NaN|Infinity/, body);
    }
  });

  test("deeply nested boxes and groups stop cleanly", () => {
    const boxes = timed(`\\begin{pspicture}(2,2)\\rput(1,1){${"\\psframebox{".repeat(500)}x${"}".repeat(500)}}\\end{pspicture}`);
    assert.ok(boxes.ms < 3000, `${boxes.ms} ms`);
    assert.ok(boxes.r.messages.some((m) => /nest too deeply/.test(m.message)));
    const groups = timed(`\\begin{pspicture}(2,2)${"{".repeat(5000)}\\psline(0,0)(1,1)${"}".repeat(5000)}\\end{pspicture}`);
    assert.ok(groups.ms < 3000, `${groups.ms} ms`);
    const tree = timed(`\\pstree{\\TR{a}}{${"\\pstree{\\TR{a}}{".repeat(300)}\\TR{b}${"}".repeat(300)}}`);
    assert.ok(tree.ms < 3000, `${tree.ms} ms`);
  });

  test("a huge grid or plot does not hang", () => {
    const { ms } = timed("\\begin{pspicture}(2,2)\\psgrid[subgriddiv=50](0,0)(400,400)\\psplot[plotpoints=1000000]{0}{1}{x}\\end{pspicture}");
    assert.ok(ms < 3000, `${ms} ms`);
  });
});

describe("the LaTeX bridge", () => {
  test("a pspicture in a figure is an image with its caption and label; problems are PST001 at their line", () => {
    const ctx = memoryContext({}, "main.tex");
    const doc = parseLatex("\\begin{figure}\n\\centering\n\\begin{pspicture}(0,0)(2,2)\n\\psline(0,0)(1,1)\n\\psbogus(0,0)\n\\end{pspicture}\n\\caption{Drawn}\\label{fig:d}\n\\end{figure}", ctx);
    const fig = doc.blocks[0] as Extract<Block, { t: "Figure" }>;
    assert.equal(fig.t, "Figure");
    assert.equal(fig.label, "fig:d");
    const plain = fig.content[0] as Extract<Block, { t: "Plain" }>;
    const img = plain.content.find((i) => i.t === "Image") as Extract<Inline, { t: "Image" }>;
    assert.ok(img.src.startsWith("data:image/svg+xml;base64,"));
    assert.deepEqual(img.attr?.classes, ["tw-diagram", "pstricks"]);
    assert.deepEqual(ctx.diagnostics.items.map((d) => `${d.code}@${d.line}`), ["PST001@5"]);
  });

  test("settings before the picture apply to it; \\pstree outside a picture is drawn", () => {
    const src = "\\documentclass{article}\n\\newrgbcolor{myred}{1 0 0}\n\\begin{document}\n\\psset{linecolor=myred}\n\\begin{pspicture}(1,1)\\psline(0,0)(1,1)\\end{pspicture}\n\n\\pstree{\\TR{a}}{\\TR{b} \\TR{c}}\n\\end{document}";
    assert.equal(pstricksPreambleCommands(src).length, 2);
    const ctx = memoryContext({}, "main.tex");
    const doc = parseLatex(src, ctx);
    const imgs = find(doc.blocks, "Para").flatMap((p) => (p as Extract<Block, { t: "Para" }>).content).filter((i) => i.t === "Image") as Extract<Inline, { t: "Image" }>[];
    assert.equal(imgs.length, 2);
    assert.match(Buffer.from(imgs[0].src.split(",")[1], "base64").toString("utf8"), /stroke="#ff0000"/);
    assert.deepEqual(ctx.diagnostics.items.filter((d) => d.severity !== "info"), []);
  });

  test("a pspicture with nothing to draw keeps LTX004", () => {
    const ctx = memoryContext({}, "main.tex");
    parseLatex("\\begin{pspicture}(0,0)(1,1)\\end{pspicture}", ctx);
    assert.deepEqual(ctx.diagnostics.items.map((d) => d.code), ["LTX004"]);
  });
});
