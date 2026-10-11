import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDiagram } from "../src/diagram/index.js";
import { parseJourney } from "../src/diagram/journey.js";
import { type MindmapNode, parseMindmap } from "../src/diagram/mindmap.js";
import type { DiagramError } from "../src/diagram/types.js";

const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));

function wellFormed(svg: string) {
  assert.ok(svg.startsWith("<svg"), "starts with <svg");
  assert.ok(svg.endsWith("</svg>"), "ends with </svg>");
  assert.ok(!/NaN|Infinity|undefined/.test(svg), "no NaN, Infinity or undefined");
  // Every opened element is closed.
  const open = (svg.match(/<(g|text|svg|tspan)\b/g) ?? []).length;
  const close = (svg.match(/<\/(g|text|svg|tspan)>/g) ?? []).length;
  assert.equal(open, close);
}

const shape = (nd: MindmapNode): string => `${nd.label}:${nd.shape}`;

describe("mindmap parsing", () => {
  it("builds the hierarchy from indentation", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n  root((Centre))\n    A\n      A1\n      A2\n    B\n      B1\n        B11\n    C", errors);
    assert.deepEqual(errors, []);
    assert.ok(root);
    assert.equal(root.label, "Centre");
    assert.deepEqual(root.children.map((c) => c.label), ["A", "B", "C"]);
    assert.deepEqual(root.children[0].children.map((c) => c.label), ["A1", "A2"]);
    assert.equal(root.children[1].children[0].children[0].label, "B11");
    assert.equal(root.children[1].children[0].children[0].depth, 3);
  });

  it("reads tabs as indentation", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n\tRoot\n\t\tA\n\t\t\tA1\n\t\tB", errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(root!.children.map((c) => c.children.length), [1, 0]);
  });

  it("reads every shape", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n  r[Root]\n    a(Rounded)\n    b((Circle))\n    c))Bang((\n    d)Cloud(\n    e{{Hex}}\n    Plain text\n    History (1990s)\n    f[\"Quoted [x]\"]", errors);
    assert.deepEqual(errors, []);
    assert.equal(shape(root!), "Root:square");
    assert.deepEqual(root!.children.map(shape), ["Rounded:rounded", "Circle:circle", "Bang:bang", "Cloud:cloud", "Hex:hexagon", "Plain text:default", "History (1990s):default", "Quoted [x]:square"]);
  });

  it("attaches icons and classes to the node above", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n  Root\n    A[Alpha] :::urgent\n    B\n    ::icon(fa fa-book)\n    :::large big", errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(root!.children[0].classes, ["urgent"]);
    assert.equal(root!.children[0].label, "Alpha");
    assert.equal(root!.children[1].icon, "fa fa-book");
    assert.deepEqual(root!.children[1].classes, ["large", "big"]);
  });

  it("joins Markdown strings over several lines", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap('mindmap\n  r["`**Bold** root\n  second line`"]\n    child', errors);
    assert.deepEqual(errors, []);
    assert.equal(root!.label, "`**Bold** root\nsecond line`");
    assert.equal(root!.children[0].label, "child");
    assert.equal(root!.children[0].line, 3);
  });
});

describe("mindmap errors", () => {
  it("reports inconsistent indentation with a fix", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n  Root\n      A\n    B\n      B1", errors);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 3);
    assert.equal(errors[0].col, 4);
    assert.match(errors[0].message, /Inconsistent indentation/);
    assert.deepEqual(errors[0].fix, { old: "    B", new: "      B" });
    // B is still drawn, under the root.
    assert.deepEqual(root!.children.map((c) => c.label), ["A", "B"]);
  });

  it("reports a second root", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n  Root\n    A\n  Other", errors);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 3);
    assert.match(errors[0].message, /one root/);
    assert.equal(errors[0].fix?.new, "    Other");
    assert.deepEqual(root!.children.map((c) => c.label), ["A", "Other"]);
  });

  it("reports an unclosed shape and keeps the node", () => {
    const errors: DiagramError[] = [];
    const root = parseMindmap("mindmap\n  Root\n    a((Circle", errors);
    assert.equal(errors.length, 1);
    assert.deepEqual([errors[0].line, errors[0].col], [2, 5]);
    assert.deepEqual(errors[0].fix, { old: "((Circle", new: "((Circle))" });
    assert.equal(shape(root!.children[0]), "Circle:circle");
  });

  it("reports an empty mindmap", () => {
    const r = renderDiagram("mindmap\n");
    assert.equal(r.svg, "");
    assert.match(r.errors[0].message, /no nodes/);
  });

  it("counts lines past front matter", () => {
    const r = renderDiagram("---\ntitle: T\n---\nmindmap\n  Root\n      A\n    B");
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].line, 6);
    assert.ok(r.svg.length > 0);
  });
});

describe("mindmap drawing", () => {
  it("draws every label, well formed, inside the canvas", () => {
    const src = "mindmap\n  root((Topic))\n    A[Alpha]\n      A1\n      A2\n    B(Beta)\n      B1))Bang((\n    C)Cloud(\n    D{{Delta}}\n      D1\n    E\n    F";
    const r = renderDiagram(src);
    assert.equal(r.kind, "mindmap");
    assert.deepEqual(r.errors, []);
    wellFormed(r.svg);
    const ts = texts(r.svg);
    for (const w of ["Topic", "Alpha", "A1", "A2", "Beta", "Bang", "Cloud", "Delta", "D1", "E", "F"]) assert.ok(ts.includes(w), w);
    // Every coordinate lies within the document.
    for (const m of r.svg.matchAll(/ (x|cx)="(-?[\d.]+)"/g)) assert.ok(Number(m[2]) >= 0 && Number(m[2]) <= r.width, `x ${m[2]}`);
    for (const m of r.svg.matchAll(/ (y|cy)="(-?[\d.]+)"/g)) assert.ok(Number(m[2]) >= 0 && Number(m[2]) <= r.height, `y ${m[2]}`);
  });

  it("splits branches between both sides of the root", () => {
    const r = renderDiagram("mindmap\n  Root\n    A\n    B\n    C\n    D");
    const xs = ["A", "B", "C", "D", "Root"].map((w) => Number(new RegExp(`<text x="([\\d.]+)"[^>]*>(?:<tspan[^>]*>)?${w}<`).exec(r.svg)![1]));
    const root = xs[4];
    assert.equal(xs.slice(0, 4).filter((x) => x > root).length, 2);
    assert.equal(xs.slice(0, 4).filter((x) => x < root).length, 2);
  });

  it("keeps siblings from overlapping", () => {
    const kids = Array.from({ length: 12 }, (_, i) => `      Leaf number ${i}`).join("\n");
    const r = renderDiagram(`mindmap\n  Root\n    Branch\n${kids}\n    Other\n${kids}`);
    const ys = [...r.svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>Leaf number/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.equal(ys.length, 24);
    for (let i = 0; i < ys.length; i++)
      for (let j = i + 1; j < ys.length; j++) if (Math.abs(ys[i][0] - ys[j][0]) < 1) assert.ok(Math.abs(ys[i][1] - ys[j][1]) >= 14, "leaves at least a line apart");
  });

  it("is fast and deterministic", () => {
    const lines = ["mindmap", "  Root"];
    for (let i = 0; i < 20; i++) {
      lines.push(`    Branch ${i}`);
      for (let k = 0; k < 10; k++) lines.push(`      Leaf ${i}.${k}`);
    }
    const src = lines.join("\n");
    renderDiagram(src);
    const t0 = performance.now();
    const a = renderDiagram(src);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${ms} ms`);
    assert.equal(renderDiagram(src).svg, a.svg);
  });
});

describe("journey parsing", () => {
  it("reads title, sections, tasks, scores and actors", () => {
    const errors: DiagramError[] = [];
    const j = parseJourney("journey\n  title My day\n  section Morning\n    Make tea: 5: Me\n    Do work: 1: Me, Cat\n  section Evening\n    Rest: 4", errors);
    assert.deepEqual(errors, []);
    assert.equal(j.title, "My day");
    assert.deepEqual(j.sections, ["Morning", "Evening"]);
    assert.deepEqual(
      j.tasks.map((t) => [t.name, t.score, t.actors, t.section]),
      [
        ["Make tea", 5, ["Me"], 0],
        ["Do work", 1, ["Me", "Cat"], 0],
        ["Rest", 4, [], 1],
      ],
    );
    assert.deepEqual(j.actors, ["Me", "Cat"]);
  });

  it("puts tasks before any section in an unnamed one", () => {
    const j = parseJourney("journey\n  Wake: 3: Me", []);
    assert.deepEqual(j.sections, [""]);
    assert.equal(j.tasks[0].section, 0);
  });

  it("reports a score outside 1 to 5 with its position and a fix", () => {
    const errors: DiagramError[] = [];
    const j = parseJourney("journey\n  section S\n    Commute: 7: Me", errors);
    assert.equal(errors.length, 1);
    assert.deepEqual([errors[0].line, errors[0].col], [2, 13]);
    assert.deepEqual(errors[0].fix, { old: "7", new: "5" });
    assert.equal(j.tasks[0].score, 5);
  });

  it("reports a score that is not a number and keeps the task", () => {
    const errors: DiagramError[] = [];
    const j = parseJourney("journey\n  Lunch: great: Me", errors);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /not a score/);
    assert.equal(j.tasks[0].score, undefined);
  });

  it("reports a line that is not a task", () => {
    const errors: DiagramError[] = [];
    parseJourney("journey\n  section S\n    just words", errors);
    assert.equal(errors.length, 1);
    assert.deepEqual([errors[0].line, errors[0].col], [2, 4]);
  });
});

describe("journey drawing", () => {
  it("draws tasks, sections, the legend and one face per scored task", () => {
    const r = renderDiagram("journey\n  title My working day\n  section Go to work\n    Make tea: 5: Me\n    Go upstairs: 3: Me\n    Do work: 1: Me, Cat\n  section Go home\n    Sit down: 2: Me\n    Oops: x: Me");
    assert.equal(r.kind, "journey");
    assert.equal(r.title, "My working day");
    assert.equal(r.errors.length, 1);
    wellFormed(r.svg);
    const ts = texts(r.svg);
    for (const w of ["My working day", "Go to work", "Go home", "Make tea", "Go upstairs", "Do work", "Sit down", "Oops", "Me", "Cat"]) assert.ok(ts.includes(w), w);
    // A face is a disc of radius 12; four tasks have scores.
    assert.equal((r.svg.match(/<circle [^>]*r="12"/g) ?? []).length, 4);
  });

  it("reports a journey with no tasks", () => {
    const r = renderDiagram("journey\n  title Empty");
    assert.equal(r.svg, "");
    assert.match(r.errors[0].message, /no tasks/);
  });
});
