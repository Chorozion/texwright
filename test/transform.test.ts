import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Block, Document, Inline } from "../src/ast.js";
import { Diagnostics } from "../src/diagnostics.js";
import { mathml, typesetMath } from "../src/math/index.js";
import { displaySource, extractLabels, liftMacros, parseRows, splitRows } from "../src/transform/math.js";
import { numberDocument, refText } from "../src/transform/numbering.js";

const text = (s: string): Inline[] => [{ t: "Text", text: s }];
const h = (level: 1 | 2 | 3, s: string, extra: Partial<Extract<Block, { t: "Heading" }>> = {}): Block => ({
  t: "Heading",
  level,
  content: text(s),
  numbered: true,
  ...extra,
});
const doc = (blocks: Block[], meta: Document["meta"] = {}): Document => ({ texwright: 1, meta, blocks });

describe("math helpers", () => {
  test("splitRows splits at top-level \\\\ only", () => {
    assert.deepEqual(splitRows("a &= b \\\\ c &= \\begin{matrix} 1 \\\\ 2 \\end{matrix} \\\\[3pt] e"), [
      "a &= b ",
      " c &= \\begin{matrix} 1 \\\\ 2 \\end{matrix} ",
      " e",
    ]);
    assert.deepEqual(splitRows("x = {a \\\\ b}"), ["x = {a \\\\ b}"]);
    assert.deepEqual(splitRows("a \\\\ b \\\\"), ["a ", " b "]);
  });

  test("extractLabels removes labels and keeps the rest byte for byte", () => {
    const r = extractLabels("x^2 \\label{eq:a} + \\labelled{y} \\label { eq:b }");
    assert.deepEqual(r.labels, ["eq:a", "eq:b"]);
    assert.equal(r.tex, "x^2  + \\labelled{y} ");
  });

  test("parseRows reads \\nonumber, \\notag and per-row labels", () => {
    const rows = parseRows("a &= b \\label{x} \\\\ c &= d \\nonumber \\\\ e &= f \\notag \\\\ g");
    assert.deepEqual(rows.map((r) => [r.label ?? null, r.suppressed]), [
      ["x", false],
      [null, true],
      [null, true],
      [null, false],
    ]);
  });

  test("liftMacros moves definitions into the table, including names KaTeX predefines", () => {
    const macros: Record<string, string> = {};
    const out = liftMacros("\\newcommand{\\R}{\\mathbb{R}} \\DeclareMathOperator*{\\argmax}{arg\\,max} \\newcommand\\norm[1]{\\lVert #1\\rVert} x \\in \\R", macros);
    assert.equal(out.trim(), "x \\in \\R");
    assert.equal(macros["\\R"], "\\mathbb{R}");
    assert.equal(macros["\\argmax"], "\\operatorname*{arg\\,max}");
    assert.equal(macros["\\norm"], "\\lVert #1\\rVert");
    const d = new Diagnostics();
    assert.equal(typesetMath("\\norm{v} \\in \\R", { display: false, fontSize: 10, macros, diagnostics: d }).ok, true, JSON.stringify(d.items));
  });

  test("optional-argument macros bake in their default", () => {
    const macros: Record<string, string> = {};
    liftMacros("\\newcommand{\\pd}[2][x]{\\partial_{#1} #2}", macros);
    assert.equal(macros["\\pd"], "\\partial_{x} #1");
  });

  test("displaySource passes the environment through with the numbering pass's tags", () => {
    assert.deepEqual(displaySource({ number: "4" }, "a=b"), { tex: "a=b", tags: "4" });
    assert.deepEqual(displaySource({ env: "align", lineNumbers: ["2", null] }, "a&=b\\\\c&=d\\nonumber"), {
      tex: "\\begin{align}a&=b\\\\c&=d\\nonumber\\end{align}",
      tags: ["2", null],
    });
    assert.deepEqual(displaySource({ env: "align*" }, "a&=b"), { tex: "\\begin{align*}a&=b\\end{align*}", tags: undefined });
    const d = new Diagnostics();
    for (const [env, body] of [["align", "a&=b\\\\c&=d"], ["gather", "a\\\\b"], ["multline", "a\\\\b"], ["alignat", "{2} a&=b & c&=d"], ["eqnarray", "a &=& b \\\\ c &=& d"], ["flalign", "a&=b"]] as const) {
      const rows = env === "multline" || env === "flalign" ? undefined : ["1", "2"];
      const { tex, tags } = displaySource({ env, lineNumbers: rows, number: rows ? undefined : "1" }, body);
      const r = typesetMath(tex, { display: true, fontSize: 10, macros: {}, tags, lineWidth: 300, diagnostics: d });
      assert.equal(r.ok, true, `${env}: ${JSON.stringify(d.items.at(-1))}`);
      assert.match(mathml(tex, { display: true, macros: {}, tags, diagnostics: d }), /^<math[^>]*display="block"/);
    }
  });

  test("math errors report the line inside multi-line math", () => {
    const d = new Diagnostics();
    const r = typesetMath("a = b \\\\\n c = \\frac{1}{", { display: true, fontSize: 10, macros: {}, diagnostics: d, pos: { line: 10, col: 1, file: "x.md" } });
    assert.equal(r.ok, false);
    assert.equal(d.items[0]!.code, "MATH001");
    assert.equal(d.items[0]!.line, 11);
  });

  test("an undefined command gets a hint about macros", () => {
    const d = new Diagnostics();
    typesetMath("\\foo x", { display: false, fontSize: 10, macros: {}, diagnostics: d });
    assert.equal(d.items[0]!.code, "MATH001");
    assert.match(d.items[0]!.hint ?? "", /macro/i);
  });
});

describe("numbering", () => {
  test("sections number from the top level used, appendix uses letters", () => {
    const blocks: Block[] = [
      h(2, "Intro", { label: "sec:intro" }),
      h(3, "Sub"),
      h(2, "Body"),
      h(2, "Proofs", { attr: { classes: ["appendix"] }, label: "app:proofs" }),
      h(3, "Lemma"),
    ];
    const d = new Diagnostics();
    const n = numberDocument(doc(blocks, { numberSections: true }), d);
    assert.deepEqual(blocks.map((b) => (b as { number?: string }).number), ["1", "1.1", "2", "A", "A.1"]);
    assert.equal(n.labels.get("app:proofs")!.name, "Appendix");
    assert.equal(refText(n.labels.get("app:proofs"), "auto"), "Appendix A");
  });

  test("unnumbered sections are referenced by title", () => {
    const blocks: Block[] = [h(1, "Methods", { label: "sec:m" })];
    const n = numberDocument(doc(blocks), new Diagnostics());
    assert.equal(refText(n.labels.get("sec:m"), "auto"), "“Methods”");
    assert.equal(refText(n.labels.get("sec:m"), "number"), "Methods");
  });

  test("equations: align rows, starred, labelled $$ and numberWithin", () => {
    const blocks: Block[] = [
      h(1, "One"),
      { t: "MathBlock", tex: "a\\label{e1}", env: "equation", numbered: true },
      { t: "MathBlock", tex: "x&=y\\label{r1}\\\\z&=w\\nonumber\\\\p&=q\\label{r3}", env: "align", numbered: true },
      { t: "MathBlock", tex: "u", env: "equation*", numbered: false },
      h(1, "Two"),
      { t: "MathBlock", tex: "v", numbered: true, label: "dd" },
    ];
    const d = new Diagnostics();
    const n = numberDocument(doc(blocks, { numberSections: true, numberWithin: 1 }), d);
    assert.equal(n.labels.get("e1")!.number, "1.1");
    assert.equal(n.labels.get("r1")!.number, "1.2");
    assert.equal(n.labels.get("r3")!.number, "1.3");
    assert.deepEqual((blocks[2] as Extract<Block, { t: "MathBlock" }>).lineNumbers, ["1.2", null, "1.3"]);
    assert.equal((blocks[3] as Extract<Block, { t: "MathBlock" }>).number, undefined);
    assert.equal(n.labels.get("dd")!.number, "2.1");
    assert.equal(refText(n.labels.get("r3"), "eq"), "(1.3)");
    assert.deepEqual(d.items, []);
  });

  test("theorem counters are shared through `counter`", () => {
    const thm = (kind: string, counter?: string, label?: string): Block => ({ t: "Theorem", kind, counter, label, numbered: true, blocks: [] });
    const blocks: Block[] = [thm("theorem", undefined, "t1"), thm("lemma", "theorem", "l1"), thm("definition", undefined, "d1"), thm("theorem", undefined, "t2")];
    const n = numberDocument(doc(blocks), new Diagnostics());
    assert.deepEqual(["t1", "l1", "d1", "t2"].map((l) => n.labels.get(l)!.number), ["1", "2", "1", "3"]);
    assert.equal(refText(n.labels.get("l1"), "auto"), "Lemma 2");
  });

  test("figures, subfigures, tables and listings", () => {
    const img: Block = { t: "Plain", content: [{ t: "Image", src: "a.png", alt: [] }] };
    const blocks: Block[] = [
      {
        t: "Figure",
        numbered: true,
        caption: text("Both"),
        label: "fig:both",
        content: [
          { t: "Figure", numbered: true, caption: text("Left"), label: "fig:l", content: [img] },
          { t: "Figure", numbered: true, caption: text("Right"), label: "fig:r", content: [img] },
        ],
      },
      { t: "Table", caption: text("T"), label: "tbl:t", align: [null], head: [], body: [] },
      { t: "Table", align: [null], head: [], body: [] },
      { t: "CodeBlock", text: "x", attr: { id: "lst:x", attrs: { caption: "Code" } } },
    ];
    const n = numberDocument(doc(blocks), new Diagnostics());
    assert.equal(n.labels.get("fig:both")!.number, "1");
    assert.equal(n.labels.get("fig:l")!.number, "1a");
    assert.equal(n.labels.get("fig:r")!.number, "1b");
    assert.equal(n.labels.get("tbl:t")!.number, "1");
    assert.equal((blocks[2] as Extract<Block, { t: "Table" }>).number, undefined);
    assert.equal(refText(n.labels.get("lst:x"), "auto"), "Listing 1");
  });

  test("duplicate labels, undefined references with suggestions, and kind mismatches", () => {
    const ref = (label: string, style: "auto" | "number" = "auto"): Inline => ({ t: "Ref", label, style, pos: { line: 9, col: 3 } });
    const blocks: Block[] = [
      h(1, "A", { label: "sec:results" }),
      h(1, "B", { label: "sec:results" }),
      { t: "Table", caption: text("x"), label: "fig:oops", align: [], head: [], body: [] },
      { t: "Para", content: [ref("sec:result"), ref("fig:oops"), ref("nothing:near", "number")] },
    ];
    const d = new Diagnostics();
    numberDocument(doc(blocks, { numberSections: true }), d);
    const codes = d.items.map((x) => x.code);
    assert.ok(codes.includes("REF002"));
    assert.ok(codes.includes("REF003"));
    const missing = d.items.filter((x) => x.code === "REF001");
    assert.equal(missing.length, 2);
    assert.match(missing[0]!.hint ?? "", /sec:results/);
    assert.equal(missing[0]!.line, 9);
  });

  test("ids are unique even when labels and titles collide", () => {
    const blocks: Block[] = [h(1, "Intro"), h(1, "Intro"), h(1, "Other", { label: "intro" })];
    const n = numberDocument(doc(blocks), new Diagnostics());
    const ids = blocks.map((b) => (b as { id?: string }).id);
    assert.equal(new Set(ids).size, 3, ids.join());
    assert.equal(n.ids.size, 3);
  });

  test("a \\label in running text points at the current section", () => {
    const span: Inline = { t: "Span", attr: { id: "here" }, content: [] };
    const blocks: Block[] = [h(1, "One"), h(2, "Two"), { t: "Para", content: [span] }];
    const n = numberDocument(doc(blocks, { numberSections: true }), new Diagnostics());
    assert.equal(n.labels.get("here")!.number, "1.1");
  });
});
