import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Block, Inline } from "../src/ast.js";
import { memoryContext } from "../src/parse/context.js";
import { parseLatex } from "../src/parse/latex.js";
import { renderTikz } from "../src/tikz/index.js";
import { Interp, type NodeInfo } from "../src/tikz/interp.js";
import { renderAxis } from "../src/tikz/pgfplots.js";
import { drawForest, parseBrackets } from "../src/tikz/forest.js";
import { drawGraph, parseGroup } from "../src/tikz/graphs.js";
import { drawTree, treeKey } from "../src/tikz/trees.js";
import { CM, initialState } from "../src/tikz/state.js";

const near = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

/** An interpreter wired the way renderTikz wires it. */
function interp(): Interp {
  const it = new Interp({}, "t");
  it.axisHandler = renderAxis;
  it.treeHandler = drawTree;
  it.graphHandler = drawGraph;
  it.extra = (k, v, g) => treeKey(it, k, v, g);
  return it;
}

function run(body: string): Interp {
  const it = interp();
  it.run(body, 0, true, initialState());
  return it;
}

function forest(body: string): Interp {
  const it = interp();
  drawForest(it, body, initialState());
  return it;
}

const at = (it: Interp, name: string): NodeInfo => {
  const n = it.nodes.get(name);
  assert.ok(n, `no node ${name}`);
  return n;
};

/** Every forest node box, phantoms left out (they draw nothing). */
function forestBoxes(it: Interp): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const [name, n] of it.nodes) {
    if (!name.startsWith("tw@f") || n.shape === "coordinate") continue;
    out.push([n.center[0] - n.hw, n.center[1] - n.hh, n.center[0] + n.hw, n.center[1] + n.hh]);
  }
  return out;
}

function overlaps(boxes: [number, number, number, number][]): number {
  let bad = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a[0] < b[2] - 0.01 && b[0] < a[2] - 0.01 && a[1] < b[3] - 0.01 && b[1] < a[3] - 0.01) bad++;
    }
  return bad;
}

/** A small deterministic random generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomTree(r: () => number, depth: number): string {
  const words = ["a", "NP", "VP", "longer label", "$x_1$", "Det", "the", "W", "{a, b}"];
  const kids = depth > 0 ? Math.floor(r() * 4) : 0;
  let s = `[${words[Math.floor(r() * words.length)]}`;
  for (let k = 0; k < kids; k++) s += ` ${randomTree(r, depth - 1 - Math.floor(r() * 2))}`;
  return `${s}]`;
}

describe("TikZ trees (child)", () => {
  test("children spread sibling distance apart, level distance below, first on the left", () => {
    const it = run("\\node (r) {r} child {node (a) {a}} child {node (b) {b}};");
    assert.deepEqual(it.messages, []);
    near(at(it, "a").center[0], -0.75 * CM);
    near(at(it, "a").center[1], -1.5 * CM);
    near(at(it, "b").center[0], 0.75 * CM);
  });

  test("grow=right puts the first child below, grow'=right above", () => {
    const a = run("\\node {r} [grow=right] child {node (a) {a}} child {node (b) {b}};");
    assert.ok(at(a, "a").center[1] < at(a, "b").center[1]);
    near(at(a, "a").center[0], 1.5 * CM);
    const b = run("\\node {r} [grow'=right] child {node (a) {a}} child {node (b) {b}};");
    assert.ok(at(b, "a").center[1] > at(b, "b").center[1]);
  });

  test("level styles with #1, level n styles, child[missing] keeps its slot", () => {
    const it = run("\\begin{scope}[level/.style={sibling distance=40mm/#1}, level 2/.style={level distance=1cm}]\\node {r} child {node (a) {a} child {node (c) {c}} child[missing]} child {node (b) {b}};\\end{scope}");
    near(at(it, "a").center[0], -2 * CM);
    near(at(it, "c").center[0] - at(it, "a").center[0], -1 * CM);
    near(at(it, "c").center[1] - at(it, "a").center[1], -1 * CM);
  });

  test("named children can be used after the tree; child foreach makes one child per item", () => {
    const it = run("\\node {r} child foreach \\x in {1,2,3} {node (n\\x) {\\x}}; \\draw (n1) -- (n3);");
    assert.deepEqual(it.messages, []);
    near(at(it, "n2").center[0], 0);
    near(at(it, "n3").center[0] - at(it, "n1").center[0], 3 * CM);
  });

  test("edge from parent labels sit on the edge; edge from parent path and fork down draw", () => {
    const it = run("\\node (r) {r} child {node (a) {a} edge from parent node (lbl) {x}};");
    const l = at(it, "lbl").center;
    near(l[0], -0, 1);
    assert.ok(l[1] < 0 && l[1] > -1.5 * CM);
    const svg = renderTikz("\\begin{tikzpicture}[edge from parent fork down]\\node {r} child {node {a}} child {node {b}};\\end{tikzpicture}").svg ?? "";
    assert.match(svg, /<path d="M[^"]*L[^"]*L[^"]*"/);
  });

  test("grow cyclic and counterclockwise from place children around the parent", () => {
    const it = run("\\node {r} [counterclockwise from=0, sibling angle=90, level distance=1cm] child {node (a) {a}} child {node (b) {b}};");
    near(at(it, "a").center[0], CM);
    near(at(it, "b").center[1], CM);
    const c = run("\\node {r} [grow cyclic, sibling angle=120, level distance=1cm] child {node (a) {a}} child {node (b) {b}} child {node (c) {c}};");
    near(Math.hypot(...at(c, "a").center), CM);
    near(at(c, "b").center[0], CM);
  });

  test("a mind map draws concept circles joined by shaded bars", () => {
    const r = renderTikz("\\begin{tikzpicture}[mindmap, concept color=blue!30]\\node[concept] {Root} child[concept color=red!30] {node[concept] {A}} child {node[concept] {B}};\\end{tikzpicture}");
    assert.deepEqual(r.messages, []);
    assert.match(r.svg ?? "", /linearGradient/);
  });

  test("nodes are drawn over the edges", () => {
    const svg = renderTikz("\\begin{tikzpicture}\\node[draw, fill=white] {root} child {node[draw, fill=white] {a}};\\end{tikzpicture}").svg ?? "";
    const firstFill = svg.indexOf('fill="#ffffff"');
    const edge = svg.indexOf('fill="none" stroke');
    assert.ok(edge >= 0 && edge < firstFill);
  });
});

describe("forest", () => {
  test("bracket parsing: content, options, children; commas in braces and math stay in the content", () => {
    const s = "[S, draw [NP [{a, b}] [$f(x,y)$, red]] [VP]]";
    const { root, end } = parseBrackets(s, 0);
    assert.ok(root);
    assert.equal(end, s.length);
    assert.equal(root.content, "S");
    assert.equal(root.opts, "draw");
    assert.equal(root.children.length, 2);
    assert.equal(root.children[0].children[0].content, "a, b");
    assert.equal(root.children[0].children[1].content, "$f(x,y)$");
    assert.equal(root.children[0].children[1].opts, "red");
  });

  test("subtrees pack close but never overlap", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const tree = randomTree(r, 5);
      const it = forest(`for tree={draw}${seed % 3 ? ", s sep=2pt" : ""}${seed % 4 === 0 ? ", grow'=0" : ""} ${tree}`);
      const boxes = forestBoxes(it);
      assert.equal(overlaps(boxes), 0, `overlap in ${tree}`);
    }
  });

  test("a parent sits over the midpoint of its first and last child", () => {
    const it = forest("[r, name=r [a, name=a] [b] [c, name=c [d] [e]]]");
    near(at(it, "r").center[0], (at(it, "a").center[0] + at(it, "c").center[0]) / 2, 0.01);
    assert.ok(at(it, "a").center[1] < at(it, "r").center[1]);
  });

  test("packing is tight: a small subtree tucks under a wide neighbour's gap", () => {
    const it = forest("[r [a, name=a [x] [y]] [b, name=b]]");
    const gap = at(it, "b").center[0] - at(it, "a").center[0];
    assert.ok(gap < 40, `siblings ${gap}pt apart`);
  });

  test("tier lines nodes up; grow'=0 grows right with the first child on top", () => {
    const it = forest("where n children=0{tier=word}{} [S [a, name=a] [VP [b, name=b]]]");
    near(at(it, "a").center[1], at(it, "b").center[1], 0.01);
    const g = forest("for tree={grow'=0} [r, name=r [a, name=a] [b, name=b]]");
    assert.ok(at(g, "a").center[0] > at(g, "r").center[0]);
    assert.ok(at(g, "a").center[1] > at(g, "b").center[1]);
  });

  test("edges, edge labels, roofs, forked edges, folders and code after the tree draw without complaint", () => {
    for (const body of [
      "for tree={edge={->}} [a [b, edge label={node[midway,left]{x}}] [c, no edge]]",
      "[DP [the old man, roof]]",
      "forked edges, for tree={draw} [a [b] [c] [d]]",
      "for tree={folder, grow'=0} [docs [a] [b [c]]]",
      "[a, name=top [b, name=bot]] \\draw[->] (bot) to[bend left] (!r);",
      "[a, phantom [b] [c]]",
    ]) {
      const r = renderTikz(`\\begin{forest}${body}\\end{forest}`);
      assert.deepEqual(r.messages, [], body);
      assert.ok(r.svg && !/NaN|Infinity/.test(r.svg), body);
    }
  });

  test("the dirtree recipe: before typesetting nodes, insert before, edge path with forestoption, l set before computing xy", () => {
    const src =
      "\\begin{forest} for tree={grow'=0, child anchor=west, parent anchor=south, anchor=west, calign=first, edge path={\\noexpand\\path [draw, \\forestoption{edge}] (!u.south west) +(7.5pt,0) |- node[fill,inner sep=1.25pt] {} (.child anchor)\\forestoption{edge label};}, before typesetting nodes={if n=1{insert before={[,phantom]}}{}}, fit=band, before computing xy={l=15pt}} [root [a [b] [c]] [d]] \\end{forest}";
    const r = renderTikz(src);
    assert.deepEqual(r.messages, []);
    assert.ok(r.height > r.width * 0.8, "the listing runs down");
  });
});

describe("\\graph", () => {
  test("syntax: chains, groups, quoted names, text after a slash, options", () => {
    const g = parseGroup('a -> {b, c} -> d; "x y"/"$x$" [red] <-[bend left] e; f -!- g; subgraph K_n [n=3]');
    assert.equal(g.length, 4);
    assert.equal(g[0].elems.length, 3);
    assert.equal(g[0].elems[1].t, "group");
    const n = g[1].elems[0];
    assert.ok(n.t === "node" && n.name === "x y" && n.text === "$x$" && n.opts === "red");
    assert.equal(g[1].ops[0].kind, "<-");
    assert.equal(g[1].ops[0].opts, "bend left");
    assert.equal(g[2].ops[0].kind, "-!-");
    assert.equal(g[3].elems[0].t, "sub");
  });

  test("default placement: chains to the right, group members down", () => {
    const it = run("\\graph { a -> {b, c} -> d; a -> d; };");
    assert.deepEqual(it.messages, []);
    near(at(it, "a").center[0], 0);
    near(at(it, "b").center[0], CM);
    near(at(it, "c").center[1], -CM);
    near(at(it, "d").center[0], 2 * CM);
  });

  test("layered layout puts each node below what points to it", () => {
    const it = run("\\graph[layered layout] { a -> b -> c; a -> c; d -> c };");
    assert.ok(at(it, "a").center[1] > at(it, "b").center[1]);
    assert.ok(at(it, "b").center[1] > at(it, "c").center[1]);
  });

  test("circular placement puts K_n on a circle; spring layout spreads nodes apart", () => {
    const it = run("\\graph[circular placement, radius=2cm] { subgraph K_n [n=6] };");
    for (let k = 1; k <= 6; k++) near(Math.hypot(...at(it, String(k)).center), 2 * CM);
    const s = run("\\graph[spring layout] { a -- b -- c -- d -- a; a -- c };");
    const pts = ["a", "b", "c", "d"].map((x) => at(s, x).center);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert.ok(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) > 10);
  });

  test("edge kinds become arrow tips; quoted labels are drawn", () => {
    const r = renderTikz('\\tikz \\graph { a ->["go"] b <-> c -- d };');
    assert.deepEqual(r.messages, []);
    assert.ok(r.svg && r.drawn >= 5);
  });
});

describe("caps and hostile input", () => {
  const budget = (src: string, ms = 2500) => {
    const t = Date.now();
    const r = renderTikz(src);
    assert.ok(Date.now() - t < ms, `too slow: ${src.slice(0, 50)}`);
    assert.ok(!/NaN|Infinity/.test(r.svg ?? ""));
    return r;
  };

  test("10k-deep child nesting", () => {
    const deep = `\\begin{tikzpicture}\\node {r} ${"child {node {x} ".repeat(10000)}${"}".repeat(10000)};\\end{tikzpicture}`;
    const r = budget(deep);
    assert.ok(r.messages.some((m) => /nests more than/.test(m.message)));
  });

  test("10k-deep forest brackets and very wide forests", () => {
    const r = budget(`\\begin{forest}${"[x ".repeat(10000)}${"]".repeat(10000)}\\end{forest}`);
    assert.ok(r.messages.some((m) => /nests more than/.test(m.message)));
    budget(`\\begin{forest}[r ${"[a] ".repeat(3000)}]\\end{forest}`, 4000);
  });

  test("huge and broken graphs", () => {
    budget(`\\tikz \\graph { ${Array.from({ length: 3000 }, (_, i) => `n${i}`).join(" -> ")} };`, 4000);
    budget("\\tikz \\graph [layered layout] { subgraph K_n [n=200] };", 4000);
    budget("\\tikz \\graph { a -> -> ; {{{ ; } -!- [;");
    budget("\\tikz \\graph [spring layout] { subgraph C_n [n=200] };", 4000);
  });

  test("broken trees and runaway loops end with a message, never a throw", () => {
    for (const src of [
      "\\tikz \\node {a} child {node {b} child { child [[[ ;",
      "\\tikz \\node {a} child foreach \\x in {1,...,100000} {node {\\x}};",
      "\\begin{forest}[a [b [c\\end{forest}",
      "\\begin{forest} for tree={l=-5cm, s sep=-1cm, grow=NaN} [a [b] [c]]\\end{forest}",
      "\\begin{forest}\\end{forest}",
      "\\tikz \\path child {node {orphan}};",
    ])
      budget(src);
  });

  test("the same picture twice gives the same SVG", () => {
    for (const src of [
      "\\begin{forest}[S [NP [D [the]] [N [cat]]] [VP [V [sat]]]]\\end{forest}",
      "\\tikz \\graph[spring layout] { a -- b -- c -- a; c -- d };",
      "\\tikz \\graph[layered layout] { a -> {b, c} -> d };",
      "\\begin{tikzpicture}[mindmap, grow cyclic]\\node[concept] {r} child {node[concept] {a}} child {node[concept] {b}};\\end{tikzpicture}",
    ])
      assert.equal(renderTikz(src).svg, renderTikz(src).svg);
  });
});

describe("the trees corpus", () => {
  const dir = join("test", "tikz-suite-trees");
  const images = (blocks: Block[]): Inline[] =>
    blocks.flatMap((b) => [
      ...("content" in b && Array.isArray(b.content) ? (b.content as (Inline | Block)[]).filter((i): i is Inline => (i as Inline).t === "Image") : []),
      ...("content" in b && Array.isArray(b.content) && b.t === "Figure" ? images(b.content as Block[]) : []),
      ...("blocks" in b && Array.isArray(b.blocks) ? images(b.blocks as Block[]) : []),
    ]);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tex"))) {
    test(f, () => {
      const ctx = memoryContext({}, f);
      const doc = parseLatex(readFileSync(join(dir, f), "utf8"), ctx);
      assert.deepEqual(
        ctx.diagnostics.items.map((d) => `${d.code} ${d.message}`),
        [],
        f,
      );
      const imgs = images(doc.blocks);
      assert.ok(imgs.length >= 1, `${f}: no picture`);
      for (const img of imgs) {
        const svg = Buffer.from((img as Extract<Inline, { t: "Image" }>).src.split(",")[1], "base64").toString("utf8");
        assert.ok(!/NaN|Infinity/.test(svg), f);
      }
    });
  }
});
