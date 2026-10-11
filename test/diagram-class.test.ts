import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDiagram } from "../src/diagram/index.js";
import { generics, parseClassDiagram } from "../src/diagram/classdiagram.js";
import type { DiagramError } from "../src/diagram/types.js";

const parse = (src: string) => {
  const errors: DiagramError[] = [];
  return { cd: parseClassDiagram(src, errors), errors };
};

/** Every text run in the SVG, in order. */
const texts = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));

describe("class diagrams: parsing", () => {
  it("reads member blocks, member lines, visibility, static and abstract", () => {
    const { cd, errors } = parse(`classDiagram
  class Shape {
    <<abstract>>
    #String name
    +area() double*
    +create(String kind)$ Shape
    +int count$
  }
  Shape : +describe() String`);
    assert.deepEqual(errors, []);
    const s = cd.classes.get("Shape")!;
    assert.deepEqual(s.annotations, ["abstract"]);
    assert.deepEqual(
      s.attrs.map((m) => m.text),
      ["#String name", "+int count"],
    );
    assert.equal(s.attrs[1].isStatic, true);
    assert.deepEqual(
      s.methods.map((m) => m.text),
      ["+area(): double", "+create(String kind): Shape", "+describe(): String"],
    );
    assert.equal(s.methods[0].isAbstract, true);
    assert.equal(s.methods[1].isStatic, true);
  });

  it("turns tilde generics into angle brackets, nested too", () => {
    assert.equal(generics("List~List~int~~"), "List<List<int>>");
    assert.equal(generics("Map~K, V~ m"), "Map<K, V> m");
    const { cd } = parse("classDiagram\n  class Box~T~ {\n    +get() T\n  }");
    assert.equal(cd.classes.get("Box")!.generic, "T");
  });

  it("reads every relation with its ends, line, cardinalities and label", () => {
    const { cd, errors } = parse(`classDiagram
  A <|-- B
  C "1" *-- "many" D : has
  E o-- F
  G --> H
  I -- J
  K ..> L
  M ..|> N
  O .. P
  Q <|--|> R`);
    assert.deepEqual(errors, []);
    const r = cd.relations.map((x) => `${x.a}:${x.atA}${x.dashed ? ".." : "--"}${x.atB}:${x.b}`);
    assert.deepEqual(r, [
      "A:triangle--none:B",
      "C:diamond-filled--none:D",
      "E:diamond--none:F",
      "G:none--open:H",
      "I:none--none:J",
      "K:none..open:L",
      "M:none..triangle:N",
      "O:none..none:P",
      "Q:triangle--triangle:R",
    ]);
    assert.equal(cd.relations[1].cardA, "1");
    assert.equal(cd.relations[1].cardB, "many");
    assert.equal(cd.relations[1].label, "has");
  });

  it("reads namespaces, direction, notes, annotations as statements and styles", () => {
    const { cd, errors } = parse(`classDiagram
  direction LR
  namespace Shop {
    class Cart
    class Item
  }
  <<interface>> Payable
  note for Cart "Holds items"
  note "Free note"
  classDef hot fill:#fdd
  cssClass "Cart" hot
  style Item stroke:#c00`);
    assert.deepEqual(errors, []);
    assert.equal(cd.direction, "LR");
    assert.equal(cd.classes.get("Cart")!.ns, "Shop");
    assert.deepEqual(cd.classes.get("Payable")!.annotations, ["interface"]);
    assert.equal(cd.notes.length, 2);
    assert.equal(cd.notes[0].for, "Cart");
    assert.deepEqual(cd.classes.get("Cart")!.classes, ["hot"]);
    assert.equal(cd.classes.get("Item")!.style.stroke, "#c00");
  });

  it("reports unreadable lines with positions and fixes, and keeps drawing", () => {
    const r = renderDiagram("classDiagram\n  A <|-- B\n  A -> C\n  ??? what");
    assert.equal(r.errors.length, 2);
    assert.equal(r.errors[0].line, 2);
    assert.equal(r.errors[0].col, 4);
    assert.deepEqual(r.errors[0].fix, { old: "->", new: "-->" });
    assert.equal(r.errors[1].line, 3);
    assert.ok(texts(r.svg).includes("A"));
  });

  it("reports an unclosed member block", () => {
    const r = renderDiagram("classDiagram\n  class A {\n    +x int");
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].line, 1);
    assert.match(r.errors[0].message, /never closed/);
  });
});

describe("class diagrams: drawing", () => {
  it("draws boxes, members, cardinalities and labels as well-formed SVG", () => {
    const r = renderDiagram(`classDiagram
  class Customer {
    +String name
    +orders() List~Order~
  }
  class Order
  Customer "1" --> "0..*" Order : places
  Order --> Order : next
  note for Order "A note"`);
    assert.deepEqual(r.errors, []);
    assert.equal(r.kind, "class");
    assert.ok(r.width > 100 && r.height > 100);
    assert.ok(!r.svg.includes("NaN"));
    assert.match(r.svg, /^<svg[^>]*>.*<\/svg>$/s);
    const ts = texts(r.svg);
    for (const want of ["Customer", "Order", "+String name", "+orders(): List<Order>", "1", "0..*", "places", "next", "A note"]) assert.ok(ts.includes(want), `missing ${want} in ${ts.join(" | ")}`);
  });

  it("draws an annotation above the name, and a generic name", () => {
    const r = renderDiagram("classDiagram\n  class Repo~T~ {\n    <<interface>>\n    +find(id) T\n  }");
    const ts = texts(r.svg);
    assert.ok(ts.indexOf("«interface»") >= 0);
    assert.ok(ts.indexOf("«interface»") < ts.indexOf("Repo<T>"));
  });

  it("stays fast on a large diagram", () => {
    const lines = ["classDiagram"];
    for (let i = 0; i < 60; i++) lines.push(`  class C${i} {\n    +int f${i}\n    +m${i}() void\n  }`);
    for (let i = 1; i < 60; i++) lines.push(`  C${Math.floor((i - 1) / 3)} <|-- C${i}`);
    const t0 = performance.now();
    const r = renderDiagram(lines.join("\n"));
    assert.deepEqual(r.errors, []);
    assert.ok(performance.now() - t0 < 2000);
    assert.ok(!r.svg.includes("NaN"));
  });
});
