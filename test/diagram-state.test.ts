import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDiagram } from "../src/diagram/index.js";
import { parseStateDiagram } from "../src/diagram/state.js";
import type { DiagramError } from "../src/diagram/types.js";

const parse = (src: string) => {
  const errors: DiagramError[] = [];
  return { sd: parseStateDiagram(src, errors), errors };
};

const texts = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"));

describe("state diagrams: parsing", () => {
  it("reads states, names, descriptions and transitions with labels", () => {
    const { sd, errors } = parse(`stateDiagram-v2
  state "Waiting for coin" as Idle
  Idle : first line
  Idle : second line
  [*] --> Idle
  Idle --> Busy : coin
  Busy --> [*]`);
    assert.deepEqual(errors, []);
    const idle = sd.nodes.get("Idle")!;
    assert.equal(idle.label, "Waiting for coin");
    assert.deepEqual(idle.descs, ["first line", "second line"]);
    assert.equal(sd.transitions.length, 3);
    assert.equal(sd.transitions[1].label, "coin");
    assert.equal(sd.nodes.get(sd.transitions[0].from)!.kind, "start");
    assert.equal(sd.nodes.get(sd.transitions[2].to)!.kind, "end");
  });

  it("gives each composite its own start and end, nested", () => {
    const { sd, errors } = parse(`stateDiagram-v2
  [*] --> Outer
  state Outer {
    [*] --> A
    state Inner {
      [*] --> B
      B --> [*]
    }
    A --> Inner
  }
  Outer --> [*]`);
    assert.deepEqual(errors, []);
    const starts = [...sd.nodes.values()].filter((nd) => nd.kind === "start");
    assert.equal(starts.length, 3);
    assert.equal(sd.clusters.get("Inner")!.parent, "Outer");
    assert.equal(sd.nodes.get("B")!.cluster, "Inner");
    assert.equal(sd.nodes.get("A")!.cluster, "Outer");
  });

  it("reads choice, fork and join, concurrent regions and notes", () => {
    const { sd, errors } = parse(`stateDiagram-v2
  state c <<choice>>
  state f <<fork>>
  state j <<join>>
  state Both {
    [*] --> X
    --
    [*] --> Y
  }
  note right of c : decide
  note left of f
    two lines
    here
  end note`);
    assert.deepEqual(errors, []);
    assert.equal(sd.nodes.get("c")!.kind, "choice");
    assert.equal(sd.nodes.get("f")!.kind, "fork");
    assert.equal(sd.nodes.get("j")!.kind, "join");
    assert.equal(sd.clusters.get("Both")!.regions.length, 2);
    assert.notEqual(sd.nodes.get("X")!.cluster, sd.nodes.get("Y")!.cluster);
    assert.deepEqual(sd.nodes.get("c")!.notes, [{ side: "right", text: "decide" }]);
    assert.equal(sd.nodes.get("f")!.notes[0].text, "two lines\nhere");
  });

  it("reports bad arrows and unclosed composites with positions", () => {
    const r = renderDiagram("stateDiagram-v2\n  A -> B\n  state C {\n    D --> E");
    assert.equal(r.errors.length, 2);
    assert.deepEqual([r.errors[0].line, r.errors[0].col], [1, 4]);
    assert.deepEqual(r.errors[0].fix, { old: "->", new: "-->" });
    assert.equal(r.errors[1].line, 2);
    assert.ok(texts(r.svg).includes("D"));
  });

  it("reports unknown state types", () => {
    const { errors } = parse("stateDiagram-v2\n  state x <<decision>>");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 1);
    assert.match(errors[0].hint ?? "", /choice/);
  });
});

describe("state diagrams: drawing", () => {
  it("draws states, labels, composites and notes as well-formed SVG", () => {
    const r = renderDiagram(`stateDiagram-v2
  direction LR
  [*] --> Still
  Still --> Moving : push
  Moving --> Still : stop
  Still --> Still : wait
  state Moving {
    [*] --> Slow
    Slow --> Fast
  }
  note right of Still : at rest`);
    assert.deepEqual(r.errors, []);
    assert.equal(r.kind, "state");
    assert.ok(!r.svg.includes("NaN"));
    const ts = texts(r.svg);
    for (const want of ["Still", "Moving", "push", "stop", "wait", "Slow", "Fast", "at rest"]) assert.ok(ts.includes(want), `missing ${want}`);
  });

  it("draws a dashed divider between concurrent regions", () => {
    const r = renderDiagram("stateDiagram-v2\n  state P {\n    [*] --> A\n    --\n    [*] --> B\n  }");
    assert.deepEqual(r.errors, []);
    assert.match(r.svg, /stroke-dasharray="5 4"/);
  });
});
