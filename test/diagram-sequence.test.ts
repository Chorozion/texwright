import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDiagram } from "../src/diagram/index.js";
import { parseSequence } from "../src/diagram/sequence.js";
import type { DiagramError } from "../src/diagram/types.js";

const parse = (src: string) => {
  const errors: DiagramError[] = [];
  const sd = parseSequence(src, errors);
  return { sd, errors };
};

const wellFormed = (svg: string) => {
  assert.ok(svg.startsWith("<svg"), "starts with <svg");
  assert.ok(svg.endsWith("</svg>"), "ends with </svg>");
  assert.ok(!/NaN|Infinity|undefined/.test(svg), "no NaN, Infinity or undefined in the SVG");
};

test("participants, actors, aliases and implicit participants", () => {
  const { sd, errors } = parse(`sequenceDiagram
    participant A as Alice
    actor B as "Bob the Builder"
    participant DB@{ "type": "database" }
    A->>C: hi
    C-->>A: hello`);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    sd.participants.map((p) => [p.id, p.label, p.kind]),
    [
      ["A", "Alice", "participant"],
      ["B", "Bob the Builder", "actor"],
      ["DB", "DB", "database"],
      ["C", "C", "participant"],
    ],
  );
});

test("every message arrow", () => {
  const { sd, errors } = parse(`sequenceDiagram
    A->B: a
    A-->B: b
    A->>B: c
    A-->>B: d
    A-xB: e
    A--xB: f
    A-)B: g
    A--)B: h
    A<<->>B: i
    A<<-->>B: j`);
  assert.deepEqual(errors, []);
  const msgs = sd.events.filter((e) => e.t === "msg");
  assert.deepEqual(
    msgs.map((m) => (m.t === "msg" ? `${m.text}:${m.dotted ? "dot" : "sol"}:${m.start}:${m.end}` : "")),
    ["a:sol:none:none", "b:dot:none:none", "c:sol:none:arrow", "d:dot:none:arrow", "e:sol:none:cross", "f:dot:none:cross", "g:sol:none:open", "h:dot:none:open", "i:sol:arrow:arrow", "j:dot:arrow:arrow"],
  );
});

test("names with spaces and hyphens, and text with colons", () => {
  const { sd, errors } = parse("sequenceDiagram\n  web-api->>John Doe: time is 10:30\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(sd.participants.map((p) => p.id), ["web-api", "John Doe"]);
  const m = sd.events[0];
  assert.ok(m.t === "msg" && m.text === "time is 10:30");
});

test("activations: explicit and the +/- shorthand", () => {
  const { sd, errors } = parse(`sequenceDiagram
    A->>+B: request
    B-->>-A: response
    activate A
    deactivate A`);
  assert.deepEqual(errors, []);
  const [m1, m2, a1, a2] = sd.events;
  assert.ok(m1.t === "msg" && m1.activate && !m1.deactivate);
  assert.ok(m2.t === "msg" && m2.deactivate && !m2.activate);
  assert.ok(a1.t === "activate" && a1.on && a2.t === "activate" && !a2.on);
});

test("blocks, separators and notes", () => {
  const { sd, errors } = parse(`sequenceDiagram
    participant A
    participant B
    alt ok
      A->>B: x
    else not ok
      loop retry
        A->>B: y
      end
    end
    par one
      A->>B: p
    and two
      B->>A: q
    end
    Note right of A: r
    Note left of B: l
    Note over A,B: both<br>lines
    rect rgb(200, 220, 255)
      A->>B: z
    end`);
  assert.deepEqual(errors, []);
  const kinds = sd.events.map((e) => (e.t === "open" ? `open:${e.kind}:${e.label}` : e.t === "sep" ? `sep:${e.kind}:${e.label}` : e.t === "note" ? `note:${e.pos}:${e.a}-${e.b}` : e.t));
  assert.deepEqual(kinds, [
    "open:alt:ok", "msg", "sep:else:not ok", "open:loop:retry", "msg", "close", "close",
    "open:par:one", "msg", "sep:and:two", "msg", "close",
    "note:right:0-0", "note:left:1-1", "note:over:0-1",
    "open:rect:", "msg", "close",
  ]);
});

test("autonumber, boxes, title, create and destroy", () => {
  const { sd, errors } = parse(`sequenceDiagram
    title Hello
    box Aqua Front
      participant A
    end
    autonumber 10 5
    A->>B: one
    A->>B: two
    autonumber off
    A->>B: three
    create participant C
    A->>C: hi
    destroy C
    A-xC: bye`);
  assert.deepEqual(errors, []);
  assert.equal(sd.title, "Hello");
  assert.deepEqual(sd.boxes, [{ label: "Front", color: "Aqua", members: [0] }]);
  const nums = sd.events.filter((e) => e.t === "msg").map((e) => (e.t === "msg" ? e.num : -1));
  assert.deepEqual(nums, [10, 15, undefined, undefined, undefined]);
  assert.ok(sd.participants[2].created && sd.participants[2].destroyed);
});

test("errors carry positions, hints and fixes", () => {
  const { errors } = parse(`sequenceDiagram
    participant Alice
    participant Bob
    partcipant Carl
    Alice->>Bob: hi
    Note right of Alise: typo
    end
    loop forever
    Alice->>Bob hello`);
  const byLine = errors.map((e) => [e.line, e.col, e.message]);
  assert.deepEqual(byLine, [
    [3, 4, 'Unknown statement "partcipant"'],
    [5, 18, 'Unknown participant "Alise"'],
    [6, 4, '"end" without a block to close'],
    [7, 0, "loop block is never closed"],
    [8, 15, "Expected a colon before the message text"],
  ]);
  assert.deepEqual(errors[0].fix, { old: "partcipant", new: "participant" });
  assert.deepEqual(errors[1].fix, { old: "Alise", new: "Alice" });
  assert.ok(errors[2].hint);
  assert.deepEqual(errors[4].fix, { old: " ", new: ": " });
});

test("a separator in the wrong block is fixed to the right one", () => {
  const { errors } = parse("sequenceDiagram\n  par a\n    A->>B: x\n  else b\n    A->>B: y\n  end");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.deepEqual(errors[0].fix, { old: "else", new: "and" });
});

test("renders well-formed SVG with every text", () => {
  const r = renderDiagram(`sequenceDiagram
    title Login & more
    actor U as User
    participant S as Server
    autonumber
    U->>+S: POST /login
    alt valid
      S-->>U: 200 <b>OK</b>
    else invalid
      S--xU: 401
    end
    S->>S: audit
    deactivate S
    Note over U,S: done`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.kind, "sequence");
  wellFormed(r.svg);
  for (const s of ["User", "Server", "POST /login", "OK", "401", "audit", "done", "[valid]", "[invalid]", "alt", "Login &amp; more"]) assert.ok(r.svg.includes(s), `contains ${s}`);
  assert.ok(r.width > 100 && r.height > 100);
});

test("participants are spread so a long label fits between them", () => {
  const short = renderDiagram("sequenceDiagram\n  A->>B: x");
  const long = renderDiagram("sequenceDiagram\n  A->>B: a considerably longer label than the default gap allows");
  assert.ok(long.width > short.width + 150, `${long.width} vs ${short.width}`);
});

test("broken input still draws and never throws", () => {
  for (const src of ["sequenceDiagram", "sequenceDiagram\n  end\n  else\n  ->>: x", "sequenceDiagram\n  A->>", "sequenceDiagram\n  loop\n  loop\n  A->>A: x", "sequenceDiagram\n  deactivate A\n  A->>B: x\n  deactivate B"]) {
    const r = renderDiagram(src);
    if (r.svg) wellFormed(r.svg);
    assert.equal(r.kind, "sequence");
  }
});

test("a thousand messages render quickly", () => {
  const lines = ["sequenceDiagram", "  autonumber"];
  for (let i = 0; i < 1000; i++) lines.push(`  P${i % 7}->>P${(i * 3 + 1) % 7}: message ${i}`);
  const t0 = performance.now();
  const r = renderDiagram(lines.join("\n"));
  const ms = performance.now() - t0;
  assert.deepEqual(r.errors, []);
  wellFormed(r.svg);
  assert.ok(ms < 2000, `${ms} ms`);
});
