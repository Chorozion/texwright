import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDiagram } from "../src/diagram/index.js";
import { parseFlowchart } from "../src/diagram/flowchart.js";
import { layoutGraph } from "../src/diagram/layered.js";
import { layoutLabel, parseLabel } from "../src/diagram/text.js";
import type { DiagramError } from "../src/diagram/types.js";
import { check, convert } from "../src/index.js";

const parse = (src: string) => {
  const errors: DiagramError[] = [];
  return { fc: parseFlowchart(src, errors), errors };
};

describe("flowchart parsing", () => {
  it("reads directions, shapes, labels and every link kind", () => {
    const { fc, errors } = parse(`flowchart LR
  a[Box] --> b(Round) --- c([Stadium])
  c -.-> d[[Sub]] ==> e[(DB)]
  e --o f((Circle)) --x g{Decision}
  g <--> h{{Hex}} ~~~ i[/Lean/]
  i ---> j>Flag]
  j -- with text --> k
  k -->|piped| l
  l -. dotted text .-> m
  m == thick text ==> n`);
    assert.deepEqual(errors, []);
    assert.equal(fc.direction, "LR");
    const shape = (id: string) => fc.nodes.get(id)!.shape;
    assert.deepEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(shape), ["rect", "round", "stadium", "subroutine", "cylinder", "circle", "diamond", "hexagon", "parallelogram", "asymmetric"]);
    const e = (from: string, to: string) => fc.edges.find((x) => x.from === from && x.to === to)!;
    assert.deepEqual([e("a", "b").line, e("a", "b").end], ["solid", "arrow"]);
    assert.deepEqual([e("b", "c").line, e("b", "c").end], ["solid", "none"]);
    assert.equal(e("c", "d").line, "dotted");
    assert.equal(e("d", "e").line, "thick");
    assert.equal(e("e", "f").end, "circle");
    assert.equal(e("f", "g").end, "cross");
    assert.deepEqual([e("g", "h").start, e("g", "h").end], ["arrow", "arrow"]);
    assert.equal(e("h", "i").line, "invisible");
    assert.equal(e("i", "j").minlen, 2, "a longer link spans more ranks");
    assert.equal(e("j", "k").label, "with text");
    assert.equal(e("k", "l").label, "piped");
    assert.deepEqual([e("l", "m").label, e("l", "m").line], ["dotted text", "dotted"]);
    assert.deepEqual([e("m", "n").label, e("m", "n").line], ["thick text", "thick"]);
  });

  it("expands & groups and chains, and reads classes, styles and comments", () => {
    const { fc, errors } = parse(`graph TD
  %% a comment
  a & b --> c & d --> e:::hot
  classDef hot fill:#f99,stroke:#900
  class a hot
  style b fill:#eef; c --> a`);
    assert.deepEqual(errors, []);
    assert.equal(fc.edges.length, 7);
    assert.deepEqual(fc.nodes.get("e")!.classes, ["hot"]);
    assert.deepEqual(fc.nodes.get("a")!.classes, ["hot"]);
    assert.equal(fc.classDefs.get("hot")!.fill, "#f99");
    assert.equal(fc.nodes.get("b")!.style.fill, "#eef");
  });

  it("assigns nodes to subgraphs the way Mermaid does (first claim, inner before outer)", () => {
    const { fc, errors } = parse(`flowchart TB
  top --> a2
  subgraph outer [Outer box]
    x --> y
    subgraph inner [Inner]
      a1 --> a2
    end
    y --> a1
  end`);
    assert.deepEqual(errors, []);
    assert.equal(fc.nodes.get("a2")!.cluster, "inner");
    assert.equal(fc.nodes.get("a1")!.cluster, "inner");
    assert.equal(fc.nodes.get("x")!.cluster, "outer");
    assert.equal(fc.nodes.get("top")!.cluster, undefined);
    assert.equal(fc.clusters.get("inner")!.parent, "outer");
    assert.equal(fc.clusters.get("outer")!.title, "Outer box");
  });

  it("reads the @{ shape } form and multi-line Markdown labels", () => {
    const { fc, errors } = parse('flowchart TD\n  a@{ shape: cyl, label: "Store" }\n  b["`**Bold**\n  second line`"] --> a');
    assert.deepEqual(errors, []);
    assert.deepEqual([fc.nodes.get("a")!.shape, fc.nodes.get("a")!.label], ["cylinder", "Store"]);
    const lab = parseLabel(fc.nodes.get("b")!.label);
    assert.equal(lab.lines.length, 2);
    assert.deepEqual(lab.lines[0], [{ text: "Bold", bold: true }]);
  });

  it("reports errors with positions and hints, and keeps the rest", () => {
    const { fc, errors } = parse("flowchart TD\n  a --> b[unclosed\n  c ==> \n  d --> e\n  end");
    assert.equal(errors.length, 3);
    assert.deepEqual([errors[0].line, errors[0].col], [1, 9]);
    assert.match(errors[0].hint!, /\]/);
    assert.match(errors[1].message, /no node after it/);
    assert.match(errors[2].message, /without a subgraph/);
    assert.ok(fc.edges.some((e) => e.from === "d" && e.to === "e"), "the good statement is still read");
  });
});

describe("labels", () => {
  it("parses breaks, emphasis and entities, and wraps long text", () => {
    const p = parseLabel("one<br/>two <b>bold</b> &amp; #quot;q#quot;");
    assert.equal(p.lines.length, 2);
    assert.deepEqual(p.lines[1], [{ text: "two " }, { text: "bold", bold: true }, { text: ' & "q"' }]);
    const long = layoutLabel("a fairly long label that certainly needs more than one line at this width", 14, 120);
    assert.ok(long.lines.length >= 3);
    assert.ok(long.width <= 140);
  });
});

describe("layered layout", () => {
  it("puts edges downward, keeps nodes apart and clusters around their members", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, width: 60, height: 30, cluster: id === "c" || id === "d" ? "k" : undefined }));
    const r = layoutGraph(
      nodes,
      [
        { id: 0, from: "a", to: "b" },
        { id: 1, from: "a", to: "c" },
        { id: 2, from: "c", to: "d", label: { width: 40, height: 16 } },
        { id: 3, from: "d", to: "a" },
      ],
      [{ id: "k", padding: 10, titleWidth: 30, titleHeight: 14 }],
      { rankdir: "TB", nodesep: 30, ranksep: 40, edgesep: 10 },
    );
    const p = (id: string) => r.nodes.get(id)!;
    assert.ok(p("b").y > p("a").y && p("d").y > p("c").y);
    for (const x of ["a", "b", "c", "d"])
      for (const y of ["a", "b", "c", "d"]) {
        if (x >= y) continue;
        const A = p(x);
        const B = p(y);
        const apart = Math.abs(A.x - B.x) >= (A.width + B.width) / 2 || Math.abs(A.y - B.y) >= (A.height + B.height) / 2;
        assert.ok(apart, `${x} and ${y} overlap`);
      }
    const box = r.clusters.get("k")!;
    for (const id of ["c", "d"]) {
      const n = p(id);
      assert.ok(n.x - n.width / 2 >= box.x && n.x + n.width / 2 <= box.x + box.width && n.y - n.height / 2 >= box.y && n.y + n.height / 2 <= box.y + box.height);
    }
    assert.ok(r.edges.get(3)!.reversed, "the cycle is broken by reversing one edge");
    assert.ok(r.edges.get(2)!.label, "a labelled edge gets a label position");
  });
});

describe("diagrams in documents", () => {
  it("renders a well-formed SVG and reports unknown types with the supported list", () => {
    const r = renderDiagram("flowchart LR\n  a[Hello] --> b[World]");
    assert.equal(r.kind, "flowchart");
    assert.match(r.svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    assert.ok(r.svg.includes(">Hello<") && r.svg.includes(">World<"));
    assert.ok(!r.svg.includes("NaN"));
    const bad = renderDiagram("flowchat TD\n a --> b");
    assert.equal(bad.svg, "");
    assert.match(bad.errors[0].hint!, /flowchart/);
    assert.deepEqual(bad.errors[0].fix, { old: "flowchat", new: "flowchart" });
  });

  it("takes the theme from front matter and init directives", () => {
    const fm = renderDiagram("---\ntitle: T\nconfig:\n  theme: neutral\n---\nflowchart LR\n  a --> b");
    assert.equal(fm.title, "T");
    assert.ok(fm.svg.includes("#f2f2f2"), "neutral node fill");
    const init = renderDiagram("%%{init: {'theme': 'forest', 'themeVariables': {'primaryColor': '#123456'}}}%%\nflowchart LR\n  a --> b");
    assert.ok(init.svg.includes("#123456"));
  });

  it("turns a mermaid block into a numbered figure that references resolve to", async () => {
    const md = 'See @fig:f.\n\n```{.mermaid #fig:f caption="The flow"}\nflowchart LR\n  a --> b\n```\n';
    const res = check({ source: md, from: "markdown" });
    assert.ok(res.ok, JSON.stringify(res.diagnostics));
    const html = (await convert({ source: md, from: "markdown", to: "html" })).data as string;
    assert.match(html, /Figure 1/);
    assert.match(html, /<span class="tw-diagram"><svg /);
    assert.match(html, /font-family:"KaTeX_SansSerif"/, "the diagram font is embedded");
  });

  it("reports diagram errors at their document line", () => {
    const md = "# Title\n\n```mermaid\nflowchart TD\n  a --> b[oops\n```\n";
    const res = check({ source: md, from: "markdown" });
    const d = res.diagnostics.find((x) => x.code === "DIAG001")!;
    assert.ok(d, "DIAG001 reported");
    assert.equal(d.line, 5);
  });

  it("is fast", () => {
    const lines = ["flowchart TD"];
    for (let i = 0; i < 150; i++) lines.push(`  n${i}[Node ${i}] --> n${(i * 7 + 3) % 150}[Node ${(i * 7 + 3) % 150}]`);
    const t = performance.now();
    const r = renderDiagram(lines.join("\n"));
    const ms = performance.now() - t;
    assert.equal(r.errors.length, 0);
    assert.ok(ms < 3000, `${ms} ms`);
  });
});
