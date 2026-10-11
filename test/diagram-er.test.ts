import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDiagram } from "../src/diagram/index.js";
import { parseErDiagram } from "../src/diagram/er.js";
import type { DiagramError } from "../src/diagram/types.js";

const parse = (src: string) => {
  const errors: DiagramError[] = [];
  return { er: parseErDiagram(src, errors), errors };
};

const texts = (svg: string): string[] => [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

describe("er diagrams: parsing", () => {
  it("reads every cardinality marker on both sides, and both line kinds", () => {
    const { er, errors } = parse(`erDiagram
  A |o--o| B : r1
  C ||--|| D : r2
  E }o..o{ F : r3
  G }|--|{ H : "r 4"
  I o|..|o J : r5`);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      er.relations.map((r) => [r.atA, r.atB, r.identifying, r.label]),
      [
        ["zero-one", "zero-one", true, "r1"],
        ["one", "one", true, "r2"],
        ["zero-many", "zero-many", false, "r3"],
        ["one-many", "one-many", true, "r 4"],
        ["zero-one", "zero-one", false, "r5"],
      ],
    );
  });

  it("reads the word forms", () => {
    const { er, errors } = parse("erDiagram\n  CAR 1 to zero or more NAMED-DRIVER : allows\n  PERSON only one optionally to one or more CAR : owns");
    assert.deepEqual(errors, []);
    assert.deepEqual([er.relations[0].atA, er.relations[0].atB, er.relations[0].identifying], ["one", "zero-many", true]);
    assert.deepEqual([er.relations[1].atA, er.relations[1].atB, er.relations[1].identifying], ["one", "one-many", false]);
    assert.ok(er.entities.has("NAMED-DRIVER"));
  });

  it("reads attribute blocks with types, keys and comments, and aliases", () => {
    const { er, errors } = parse(`erDiagram
  p[Person] {
    int id PK
    int team_id FK "the team"
    decimal(10,2) salary
    string email UK, FK
  }
  t["Team name"]`);
    assert.deepEqual(errors, []);
    const p = er.entities.get("p")!;
    assert.equal(p.label, "Person");
    assert.deepEqual(p.attrs, [
      { type: "int", name: "id", keys: ["PK"] },
      { type: "int", name: "team_id", keys: ["FK"], comment: "the team" },
      { type: "decimal(10,2)", name: "salary", keys: [] },
      { type: "string", name: "email", keys: ["UK", "FK"] },
    ]);
    assert.equal(er.entities.get("t")!.label, "Team name");
  });

  it("reports a wrong marker with a fix, and a bad attribute, with positions", () => {
    const r = renderDiagram("erDiagram\n  A ||--|< B : has\n  A {\n    justaname\n  }");
    assert.equal(r.errors.length, 2);
    assert.deepEqual([r.errors[0].line, r.errors[0].col], [1, 8]);
    assert.deepEqual(r.errors[0].fix, { old: "|<", new: "|{" });
    assert.equal(r.errors[1].line, 3);
    assert.ok(texts(r.svg).includes("A"));
  });
});

describe("er diagrams: drawing", () => {
  it("draws entity tables, crow's feet and labels as well-formed SVG", () => {
    const r = renderDiagram(`erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE : contains
  ORDER |o..o| ORDER : "follows"
  CUSTOMER {
    string name
    int id PK "surrogate"
  }`);
    assert.deepEqual(r.errors, []);
    assert.equal(r.kind, "er");
    assert.ok(!r.svg.includes("NaN"));
    const ts = texts(r.svg);
    for (const want of ["CUSTOMER", "ORDER", "LINE", "places", "contains", "follows", "string", "name", "PK", "surrogate"]) assert.ok(ts.includes(want), `missing ${want}`);
    // The zero markers are hollow circles: one at ORDER from CUSTOMER, two on the self loop.
    assert.ok((r.svg.match(/<circle/g) ?? []).length >= 3);
  });
});
