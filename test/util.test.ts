/**
 * The dependency-free utilities: YAML parser, syntax highlighter, HTML
 * sanitizer, JSON Schema validator and the document schema built on it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diagnosticJsonSchema, documentJsonSchema, validateDocument } from "../src/schema.js";
import { type Token, highlight, languageName, supportedLanguages, tokenClass, tokenize } from "../src/util/highlight.js";
import { ALLOWED_TAGS, HtmlSanitizer, decodeAttribute, namedReferences, sanitizeHtml } from "../src/util/sanitize.js";
import { type JsonSchema, childPath, validate } from "../src/util/validate.js";
import { parseYaml, resolvePlainScalar } from "../src/util/yaml.js";

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function timed<T>(label: string, fn: () => T, limitMs = 1500): T {
  const start = performance.now();
  const value = fn();
  const ms = performance.now() - start;
  assert.ok(ms < limitMs, `${label} took ${ms.toFixed(0)} ms (limit ${limitMs} ms)`);
  return value;
}

// ====================================================================== YAML

function yaml(text: string): unknown {
  const r = parseYaml(text);
  assert.equal(r.error, undefined, `${JSON.stringify(text)}: ${JSON.stringify(r.error)}`);
  return r.value;
}

function yamlError(text: string): { message: string; line: number; col: number } {
  const r = parseYaml(text);
  assert.ok(r.error, `expected an error for ${JSON.stringify(text)}, got ${JSON.stringify(r.value)}`);
  assert.equal(r.value, undefined);
  return r.error;
}

describe("yaml: block collections", () => {
  test("mappings nest by indentation", () => {
    assert.deepEqual(yaml("a: 1\nb:\n  c: x\n  d:\n    e: y\nf: z"), { a: 1, b: { c: "x", d: { e: "y" } }, f: "z" });
  });

  test("sequences, nested sequences and compact mappings in entries", () => {
    assert.deepEqual(yaml("- a\n- b\n-\n  - c\n  - d\n- - e\n  - f"), ["a", "b", ["c", "d"], ["e", "f"]]);
    assert.deepEqual(yaml("- name: A\n  age: 3\n- name: B\n-   x: 1\n    y: 2"), [{ name: "A", age: 3 }, { name: "B" }, { x: 1, y: 2 }]);
    assert.deepEqual(yaml("- \"q\": 1\n  r: 2"), [{ q: 1, r: 2 }]);
  });

  test("a sequence may sit at its key's indentation", () => {
    assert.deepEqual(yaml("a:\n- 1\n- 2\nb: 3"), { a: [1, 2], b: 3 });
    assert.deepEqual(yaml("a:\n  b:\n  - 1\n  - 2\n  c: 3"), { a: { b: [1, 2], c: 3 } });
  });

  test("empty values are null", () => {
    assert.deepEqual(yaml("a:\nb:\n  \nc: 1\nd:"), { a: null, b: null, c: 1, d: null });
    assert.deepEqual(yaml("- \n-\n- x"), [null, null, "x"]);
  });

  test("keys are the text as written, quoted keys may hold anything", () => {
    assert.deepEqual(yaml('1: a\ntrue: b\n"quoted: key": c\n\'it\'\'s\': d\nkey with spaces  : e\nnull: f'), {
      "1": "a",
      true: "b",
      "quoted: key": "c",
      "it's": "d",
      "key with spaces": "e",
      null: "f",
    });
  });

  test("a __proto__ key stays data", () => {
    const v = yaml("__proto__: {polluted: 1}\nconstructor: x") as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    assert.deepEqual(Object.keys(v), ["__proto__", "constructor"]);
    assert.deepEqual(v.__proto__, { polluted: 1 });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test("front matter as texwright sees it", () => {
    const src = [
      "title: A **bold** title",
      "subtitle: Sub",
      "date: 2026-10-06",
      "author:",
      "  - Ann Lee",
      "  - name: Bob Roe",
      "    affiliation: Uni",
      "keywords: alpha, beta",
      "bibliography: refs.bib",
      "citation-style: author-year",
      "macros:",
      "  R: \\mathbb{R}",
      "  \\N: \\mathbb{N}",
      "toc: true",
      "toc-depth: 2",
      "number-sections: false",
      "abstract: |",
      "  We show $x$.",
      "",
      "  Second paragraph.",
      "custom: 42",
    ].join("\n");
    assert.deepEqual(yaml(src), {
      title: "A **bold** title",
      subtitle: "Sub",
      date: "2026-10-06",
      author: ["Ann Lee", { name: "Bob Roe", affiliation: "Uni" }],
      keywords: "alpha, beta",
      bibliography: "refs.bib",
      "citation-style": "author-year",
      macros: { R: "\\mathbb{R}", "\\N": "\\mathbb{N}" },
      toc: true,
      "toc-depth": 2,
      "number-sections": false,
      abstract: "We show $x$.\n\nSecond paragraph.\n",
      custom: 42,
    });
  });
});

describe("yaml: flow collections", () => {
  test("sequences and mappings, nested, across lines, with trailing commas", () => {
    assert.deepEqual(yaml("a: [1, b, {c: d, e: [f, g]}]\nh: {}\ni: []"), { a: [1, "b", { c: "d", e: ["f", "g"] }], h: {}, i: [] });
    assert.deepEqual(yaml("k: [\n  a,   # first\n  b,\n]\nm: {x: 1,\n  y: 2,}"), { k: ["a", "b"], m: { x: 1, y: 2 } });
    assert.deepEqual(yaml("[a b, c\n  d]"), ["a b", "c d"]);
  });

  test("keys without values, quoted keys, single pairs in sequences", () => {
    assert.deepEqual(yaml('{a, b: c, "d": e, \'f\':g}'), { a: null, b: "c", d: "e", f: "g" });
    assert.deepEqual(yaml("[a: 1, b, c: ]"), [{ a: 1 }, "b", { c: null }]);
  });

  test("plain scalars in flow stop at indicators but keep colons inside words", () => {
    assert.deepEqual(yaml("[http://x.org/a, a:b, 'c, d']"), ["http://x.org/a", "a:b", "c, d"]);
    assert.deepEqual(yaml("{a:1}"), { "a:1": null });
  });
});

describe("yaml: scalars", () => {
  test("core schema resolution of plain scalars", () => {
    const v = yaml("[~, null, Null, NULL, true, True, FALSE, yes, no, on, 0, -3, +12, 0x1F, 0o17, 012, 1.5, .5, 5., -1e3, 1E+2, .inf, -.Inf, +.INF, 1_000, 0b11, 1.10, 2026-10-06, 12:30]") as unknown[];
    assert.deepEqual(v.slice(0, 14), [null, null, null, null, true, true, false, "yes", "no", "on", 0, -3, 12, 31]);
    assert.deepEqual(v.slice(14, 21), [15, 12, 1.5, 0.5, 5, -1000, 100]);
    assert.deepEqual(v.slice(21, 24), [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]);
    assert.deepEqual(v.slice(24), ["1_000", "0b11", 1.1, "2026-10-06", "12:30"]);
    assert.ok(Number.isNaN(resolvePlainScalar(".nan")));
    assert.ok(Number.isNaN(resolvePlainScalar(".NaN")));
    assert.equal(resolvePlainScalar("-"), "-");
    assert.equal(resolvePlainScalar("1.2.3"), "1.2.3");
  });

  test("quoted scalars are always strings", () => {
    assert.deepEqual(yaml("a: '1'\nb: \"true\"\nc: ''\nd: \"\""), { a: "1", b: "true", c: "", d: "" });
  });

  test("single quotes: doubled quote escapes, nothing else does", () => {
    assert.equal(yaml("'it''s \\n here'"), "it's \\n here");
  });

  test("double quotes: every YAML escape", () => {
    assert.equal(yaml('"\\0\\a\\b\\t\\\t\\n\\v\\f\\r\\e\\ \\"\\/\\\\\\N\\_\\L\\P"'), "\0\x07\b\t\t\n\v\f\r\x1b \"/\\\x85\xa0\u2028\u2029");
    assert.equal(yaml('"\\x41\\u00e9\\U0001F600\\ud83d\\ude00"'), "Aé😀😀");
  });

  test("line folding in quoted and plain scalars", () => {
    assert.deepEqual(yaml('k: "one\n  two\n\n  three"\n'), { k: "one two\nthree" });
    assert.deepEqual(yaml("k: 'a\n\n\n  b'"), { k: "a\n\nb" });
    assert.deepEqual(yaml('k: "trailing   \n  space"'), { k: "trailing space" });
    assert.deepEqual(yaml('k: "escaped tab\\t\n  kept"'), { k: "escaped tab\t kept" });
    assert.deepEqual(yaml('k: "joined\\\n    here"'), { k: "joinedhere" });
    assert.deepEqual(yaml("k: a plain\n  value over\n\n  lines\nnext: 1"), { k: "a plain value over\nlines", next: 1 });
    assert.deepEqual(yaml("k: b\n  - c"), { k: "b - c" });
  });

  test("literal block scalars and chomping", () => {
    assert.deepEqual(yaml("a: |\n  one\n    two\n\n  three\nb: x"), { a: "one\n  two\n\nthree\n", b: "x" });
    assert.deepEqual(yaml("a: |-\n  x\n\nb: 1"), { a: "x", b: 1 });
    assert.deepEqual(yaml("a: |+\n  x\n\n\nb: 1"), { a: "x\n\n\n", b: 1 });
    assert.deepEqual(yaml("a: |\n\n  x\n"), { a: "\nx\n" });
    assert.deepEqual(yaml("a: |\n  # not a comment\n  x\n# a comment\nb: 1"), { a: "# not a comment\nx\n", b: 1 });
    // At the very end of the input there is no final line break to keep.
    assert.deepEqual(yaml("a: |\n  x"), { a: "x" });
    assert.deepEqual(yaml("a: |\nb: 1"), { a: "", b: 1 });
  });

  test("folded block scalars", () => {
    assert.deepEqual(yaml("a: >\n  folded\n  text\n\n  para\n    more\n  back\n"), { a: "folded text\npara\n  more\nback\n" });
    assert.deepEqual(yaml("a: >-\n  x\n  y\n"), { a: "x y" });
    assert.deepEqual(yaml("a: >+\n  x\n\n"), { a: "x\n\n" });
  });

  test("explicit indentation indicators", () => {
    assert.deepEqual(yaml("a: |2\n    indented\n  base\n"), { a: "  indented\nbase\n" });
    assert.deepEqual(yaml("a: >2-\n   x\n  y\n"), { a: " x\ny" });
    assert.deepEqual(yaml("a: |-1\n  x\n"), { a: " x" });
    assert.deepEqual(yaml("- |\n  lit\n- >\n  fold\n  ed\n"), ["lit\n", "fold ed\n"]);
  });
});

describe("yaml: comments", () => {
  test("a # after whitespace starts a comment; inside a word it doesn't", () => {
    assert.deepEqual(yaml("a: x # comment\nb: a#b\nc: http://x.org/p#frag\nd: 'q' # c\ne: [1, 2] # c\n# whole line\nf: |  # c\n  t\n"), {
      a: "x",
      b: "a#b",
      c: "http://x.org/p#frag",
      d: "q",
      e: [1, 2],
      f: "t\n",
    });
  });

  test("as in YAML, a macro's \"#1\" after a space is cut off as a comment", () => {
    assert.deepEqual(yaml("macros:\n  norm: \\lVert #1 \\rVert"), { macros: { norm: "\\lVert" } });
  });

  test("comment-only and empty input is null", () => {
    assert.equal(yaml(""), null);
    assert.equal(yaml("   \n\n"), null);
    assert.equal(yaml("# only\n  # comments\n"), null);
  });
});

describe("yaml: documents", () => {
  test("an optional --- start, a ... end, a BOM and CRLF line ends", () => {
    assert.deepEqual(yaml("---\nk: v"), { k: "v" });
    assert.deepEqual(yaml("--- # c\nk: v\n...\n# trailing comment\n"), { k: "v" });
    assert.equal(yaml("--- |\n  root text\n"), "root text\n");
    assert.equal(yaml("--- plain root"), "plain root");
    assert.deepEqual(yaml("\ufeffa: 1\r\nb:\r\n  - 2\r\n"), { a: 1, b: [2] });
  });

  test("a bare value is a document too (as -M key=value gives)", () => {
    assert.equal(yaml("true"), true);
    assert.equal(yaml("3"), 3);
    assert.equal(yaml("hello world"), "hello world");
    assert.deepEqual(yaml("[a, b]"), ["a", "b"]);
    assert.deepEqual(yaml("a: b"), { a: "b" });
    assert.equal(yaml("C:\\docs\\refs.bib"), "C:\\docs\\refs.bib");
  });
});

describe("yaml: rejected features and errors", () => {
  test("anchors, aliases, tags, merge keys, explicit and complex keys are refused", () => {
    assert.match(yamlError("a: &x 1\nb: 2").message, /anchors/);
    assert.match(yamlError("a: 1\nb: *x").message, /aliases/);
    assert.match(yamlError("- *x").message, /aliases/);
    assert.match(yamlError("a: !!str 1").message, /tags/);
    assert.match(yamlError("a: [!x 1]").message, /tags/);
    assert.match(yamlError("<<: {a: 1}").message, /Merge keys/);
    assert.match(yamlError("b: {<<: {a: 1}}").message, /Merge keys/);
    assert.match(yamlError("? a\n: b").message, /Explicit/);
    assert.match(yamlError("[a]: b").message, /Collections can't be used as mapping keys/);
    assert.match(yamlError("{[a]: b}").message, /Collections can't be used as mapping keys/);
    assert.match(yamlError("%YAML 1.2\n---\na: 1").message, /directives/);
    assert.match(yamlError("a: 1\n---\nb: 2").message, /one YAML document/);
    assert.match(yamlError("a: 1\n...\nb: 2").message, /one YAML document/);
  });

  test("an alias bomb can't even be written", () => {
    let src = 'l0: &l0 "lol"\n';
    for (let k = 1; k <= 9; k++) src += `l${k}: &l${k} [${Array(10).fill(`*l${k - 1}`).join(", ")}]\n`;
    const e = yamlError(src);
    assert.equal(e.line, 1);
    assert.match(e.message, /anchors/);
  });

  test("duplicate keys are errors, wherever they are", () => {
    assert.deepEqual(yamlError("a: 1\nb: 2\na: 3"), { message: 'Duplicate key "a"', line: 3, col: 1 });
    assert.deepEqual(yamlError("x:\n  k: 1\n  'k': 2"), { message: 'Duplicate key "k"', line: 3, col: 3 });
    assert.equal(yamlError("{a: 1, a: 2}").col, 8);
    assert.match(yamlError("- {a, a}").message, /Duplicate/);
  });

  test("errors carry the exact line and column", () => {
    // A key line indented under a plain value: the value runs on, then ':' can't follow.
    assert.deepEqual(yamlError("title: ok\n  bad: indentation").line, 2);
    assert.equal(yamlError("title: ok\n  bad: indentation").col, 6);
    assert.deepEqual(yamlError("a:\n  b:\n    c: 1\n   d: 2"), { message: "Bad indentation: this line is indented more than the keys above it", line: 4, col: 4 });
    // A deeper line under a plain value continues the value, so it is the colon that fails.
    assert.equal(yamlError("a:\n  b: 1\n   c: 2").col, 5);
    assert.deepEqual(yamlError('a: "unclosed\nb: 2'), { message: "Unclosed double-quoted string", line: 1, col: 4 });
    assert.deepEqual(yamlError("a: 'x"), { message: "Unclosed single-quoted string", line: 1, col: 4 });
    assert.deepEqual(yamlError("a: [1, 2\nb: 3"), { message: "Unclosed '['", line: 1, col: 4 });
    assert.deepEqual(yamlError("a: [1, 2 3}"), { message: "Expected ',' or ']'", line: 1, col: 11 });
    assert.deepEqual(yamlError("a: [1, 2"), { message: "Unclosed '['", line: 1, col: 4 });
    assert.deepEqual(yamlError("a:\n  b: 1\n\tc: 2"), { message: "Tabs can't be used for indentation in YAML; use spaces", line: 3, col: 1 });
    assert.deepEqual(yamlError('a: "\\q"').col, 5);
    assert.match(yamlError('a: "\\x4"').message, /hexadecimal/);
    assert.equal(yamlError("a: b: c").col, 5);
    assert.equal(yamlError('a: "b" c').col, 8);
    assert.match(yamlError("a: - b").message, /sequence can't start on the same line/);
    assert.match(yamlError("- a\nb: c").message, /check the indentation/);
    assert.match(yamlError("a: 1\n- b").message, /not a sequence entry/);
    assert.match(yamlError("a: 1\nb").message, /Expected a key/);
    assert.match(yamlError("a: |0\n  x").message, /1 to 9/);
    assert.match(yamlError("a: | x\n  y").message, /block scalar indicator/);
    assert.match(yamlError("a: [a, , b]").message, /Missing value/);
    assert.match(yamlError("a: %x").message, /quote the value/);
    assert.match(yamlError("a: @x").message, /reserved/);
    assert.match(yamlError('a: "x"#c').message, /space before '#'/);
  });

  test("nesting depth and length limits", () => {
    assert.deepEqual(yaml(`${"[".repeat(100)}${"]".repeat(100)}`), JSON.parse(`${"[".repeat(100)}${"]".repeat(100)}`));
    assert.match(yamlError(`${"[".repeat(101)}${"]".repeat(101)}`).message, /deeper than 100/);
    let deep = "";
    for (let k = 0; k < 150; k++) deep += `${" ".repeat(k)}k:\n`;
    assert.match(yamlError(deep).message, /deeper than 100/);
    assert.match(parseYaml("a: [[[1]]]", { maxDepth: 2 }).error!.message, /deeper than 2/);
    assert.match(parseYaml("a: 1234", { maxLength: 5 }).error!.message, /longer than 5/);
  });
});

describe("yaml: hostile input runs in linear time", () => {
  const cases: [string, string][] = [
    ["many keys", Array.from({ length: 50_000 }, (_, k) => `key${k}: value ${k}`).join("\n")],
    ["one long plain line", `a: ${"word ".repeat(300_000)}`],
    ["a long multi-line plain scalar", `a: x\n${"  continued line\n".repeat(50_000)}`],
    ["a long double-quoted string full of escapes", `a: "${"\\u00e9\\n\\\\ ".repeat(50_000)}"`],
    ["a long folded scalar", `a: >\n${"  folded words here\n\n".repeat(50_000)}`],
    ["unclosed brackets", "[".repeat(500_000)],
    ["unclosed quote", `a: "${"x".repeat(500_000)}`],
    ["many blank and comment lines", `${"\n# c\n   \n".repeat(100_000)}a: 1`],
    ["a long flow list", `[${Array.from({ length: 100_000 }, (_, k) => k).join(", ")}]`],
    ["colons without spaces", `a: ${"x:y".repeat(200_000)}`],
    ["dashes", "- ".repeat(300_000)],
    ["a deep sequence line", `${"- ".repeat(90)}x`],
  ];
  for (const [label, src] of cases) {
    test(label, () => {
      const r = timed(label, () => parseYaml(src));
      assert.ok(r.error || r.value !== undefined);
    });
  }

  test("random soups never throw", () => {
    const next = rng(7);
    const atoms = ["a", ": ", "-", " ", "\n", "  ", "'", '"', "[", "]", "{", "}", ",", "#", "|", ">", "\\", "\t", "&", "*", "!", "?", "...", "---", "1", ".5", "~", "%"];
    for (let k = 0; k < 2000; k++) {
      let s = "";
      const n = Math.floor(next() * 40);
      for (let j = 0; j < n; j++) s += atoms[Math.floor(next() * atoms.length)];
      const r = parseYaml(s);
      assert.ok(r.error === undefined || (r.error.line >= 1 && r.error.col >= 1), s);
    }
  });
});

// ====================================================================== highlighting

const LANGS: Record<string, string> = {
  python: "@dec\ndef f(a, b=1):\n    \"\"\"doc\"\"\"\n    return self.x + 0x1F + 1.5e3 if True else None  # c\nclass A(B): pass\nprint(f'x{y}', r'\\d', b'x', a @ b)\n",
  javascript: "// c\nconst x = /ab+c/gi.test(s) ? `t ${a}` : 'b';\nfunction f(a) { return this.y + 1n / 2; }\nclass A extends B {}\nconsole.log(null, undefined);\n",
  typescript: "interface A { x: number; y?: string }\ntype B = A | null;\nexport async function g<T>(a: T): Promise<void> {}\nenum E { A }\n",
  json: '{"a": 1, "b": [true, null, "s"], "c": -1.5e3} // c\n',
  bash: "#!/bin/bash\n# c\nif [ -f $FILE ]; then echo \"hi $USER ${HOME}\" 'x'; fi\nexport A=1 a#b\nfunction f() { local x=$1; return 0; }\n",
  c: '#include <stdio.h>\n#define N 10\nint main(void) { char c = \'x\'; printf("%d\\n", N); return 0; } /* c */\n',
  cpp: "#include <vector>\ntemplate<typename T> class A { public: virtual ~A() = default; };\nstd::vector<int> v{1, 2}; auto x = nullptr; // c\n",
  csharp: 'using System;\nnamespace N { public class A { public static void M(string s) { var x = @"verb""atim"; var y = $"i {s}"; } } }\n',
  java: '@Override\npublic static void main(String[] args) { int x = 0x1F; char c = \'\\n\'; System.out.println("hi"); }\n',
  go: 'package main\nimport "fmt"\nfunc main() { x := `raw`; var y int = 3; r := \'a\'; fmt.Println(x, y, nil, len(x)) }\n',
  rust: '#[derive(Debug)]\nfn main() { let mut x: i32 = 5; println!("{}", x); let s = r#"raw"#; let c = \'a\'; }\nimpl<\'a> Foo<\'a> {} /* a /* nested */ b */\n',
  sql: "SELECT a, COUNT(*) FROM t WHERE b = 'it''s' AND c IS NULL -- c\nCREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(10));\n",
  html: '<!DOCTYPE html>\n<!-- c -->\n<div class="a" id=\'b\' data-x=y>&amp; text</div>\n<script>let x = 1;</script><style>.a { color: red }</style>\n',
  xml: '<?xml version="1.0"?>\n<root a="1"><![CDATA[<x>]]><child/></root>\n',
  css: '@media screen { .a > #b:hover, div::before { color: #fff; margin: 0 1px !important; font-family: "x"; } }\n/* c */\n',
  yaml: "# c\nkey: value\nn: 12\nflag: true\nlist:\n  - 'a'\nref: *x\ntag: !!str 5\nblock: |\n  text\n---\n",
  latex: "% comment\n\\documentclass{article}\n\\begin{document}\n$x^2$ and \\textbf{b} \\\\ 50\\%\n\\end{document}\n",
  markdown: "# Title\n\nSome *em* and **strong** and `code`.\n\n- item\n1. one\n\n> quote\n\n[link](http://x.com)\n\n```js\nlet x = 1;\n```\n",
  r: "# c\nf <- function(x) { if (x > 1) TRUE else NULL }\nprint(c(1, 2L, NA))\n",
  julia: "# c\n#= block =#\nfunction f(x::Int64)\n  @time x' + 1\nend\ns = \"a $x\"; nothing\n",
  matlab: "% c\nfunction y = f(x)\n  y = x' + 1; s = 'str'; t = \"str\";\nend\n",
  ruby: "# c\ndef f(x)\n  @a = :sym; puts \"hi #{x}\" if x.nil?\nend\nclass A < B; end\n",
  php: '<?php\n// c\n$x = 1; echo "hi $x"; function f($a) { return null; }\n?>\n',
  kotlin: '@JvmStatic\nfun main(args: Array<String>) { val x: Int = 1; println("$x") }\n',
  swift: 'import UIKit\n@objc func f(x: Int) -> String { let s = "a"; return s }\n',
  diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n",
};

/** [kind, text] pairs each language's sample must produce. */
const EXPECT: Record<string, [string, string][]> = {
  python: [["meta", "@dec"], ["keyword", "def"], ["title.function", "f"], ["string", '"""doc"""'], ["variable.language", "self"], ["number", "0x1F"], ["literal", "True"], ["literal", "None"], ["comment", "# c"], ["title.class", "A"], ["built_in", "print"], ["string", "f'x{y}'"], ["string", "r'\\d'"], ["string", "b'x'"]],
  javascript: [["comment", "// c"], ["keyword", "const"], ["regexp", "/ab+c/gi"], ["string", "`t ${a}`"], ["title.function", "f"], ["variable.language", "this"], ["number", "1n"], ["title.class", "A"], ["title.class", "B"], ["literal", "null"]],
  typescript: [["keyword", "interface"], ["title.class", "A"], ["built_in", "number"], ["keyword", "type"], ["keyword", "async"], ["title.function", "g"], ["keyword", "enum"]],
  json: [["attr", '"a"'], ["number", "1"], ["literal", "true"], ["literal", "null"], ["string", '"s"'], ["number", "-1.5e3"], ["comment", "// c"]],
  bash: [["meta", "#!/bin/bash"], ["comment", "# c"], ["keyword", "if"], ["variable", "$FILE"], ["built_in", "echo"], ["variable", "$USER"], ["variable", "${HOME}"], ["string", "'x'"], ["title.function", "f"], ["variable", "$1"]],
  c: [["meta", "#"], ["keyword", "include"], ["string", "<stdio.h>"], ["type", "int"], ["title.function", "main"], ["string", "'x'"], ["built_in", "printf"], ["string", '"%d\\n"'], ["keyword", "return"], ["comment", "/* c */"]],
  cpp: [["keyword", "template"], ["title.class", "A"], ["keyword", "virtual"], ["literal", "nullptr"], ["comment", "// c"]],
  csharp: [["keyword", "namespace"], ["title.class", "A"], ["title.function", "M"], ["string", '@"verb""atim"'], ["string", '$"i {s}"']],
  java: [["meta", "@Override"], ["type", "void"], ["title.function", "main"], ["number", "0x1F"], ["string", "'\\n'"], ["string", '"hi"']],
  go: [["keyword", "package"], ["keyword", "func"], ["title.function", "main"], ["string", "`raw`"], ["type", "int"], ["string", "'a'"], ["literal", "nil"], ["built_in", "len"]],
  rust: [["meta", "#[derive(Debug)]"], ["keyword", "fn"], ["title.function", "main"], ["type", "i32"], ["built_in", "println!"], ["string", 'r#"raw"#'], ["string", "'a'"], ["symbol", "'a"], ["comment", "/* a /* nested */ b */"]],
  sql: [["keyword", "SELECT"], ["built_in", "COUNT"], ["string", "'it''s'"], ["keyword", "NULL"], ["comment", "-- c"], ["type", "INT"], ["type", "VARCHAR"], ["number", "10"]],
  html: [["meta", "<!DOCTYPE html>"], ["comment", "<!-- c -->"], ["tag", "<"], ["name", "div"], ["attr", "class"], ["string", '"a"'], ["string", "'b'"], ["string", "y"], ["symbol", "&amp;"], ["keyword", "let"], ["selector-class", ".a"], ["attribute", "color"]],
  xml: [["meta", '<?xml version="1.0"?>'], ["name", "root"], ["attr", "a"], ["meta", "<![CDATA[<x>]]>"], ["name", "child"]],
  css: [["keyword", "@media"], ["selector-class", ".a"], ["selector-id", "#b"], ["selector-pseudo", ":hover"], ["selector-tag", "div"], ["selector-pseudo", "::before"], ["attribute", "color"], ["number", "#fff"], ["number", "1px"], ["meta", "!important"], ["string", '"x"'], ["comment", "/* c */"]],
  yaml: [["comment", "# c"], ["attr", "key:"], ["string", "value"], ["number", "12"], ["literal", "true"], ["bullet", "-"], ["string", "'a'"], ["meta", "*x"], ["type", "!!str"], ["string", "|"], ["string", "  text\n"], ["meta", "---"]],
  latex: [["comment", "% comment"], ["keyword", "\\documentclass"], ["keyword", "\\begin"], ["title.class", "document"], ["built_in", "$"], ["keyword", "\\textbf"], ["keyword", "\\\\"], ["keyword", "\\%"]],
  markdown: [["section", "# Title"], ["emphasis", "*em*"], ["strong", "**strong**"], ["code", "`code`"], ["bullet", "-"], ["bullet", "1."], ["quote", "> quote"], ["string", "link"], ["link", "http://x.com"], ["code", "```js\nlet x = 1;\n```\n"]],
  r: [["comment", "# c"], ["keyword", "function"], ["literal", "TRUE"], ["literal", "NULL"], ["built_in", "print"], ["number", "2L"], ["literal", "NA"]],
  julia: [["comment", "#= block =#"], ["keyword", "function"], ["title.function", "f"], ["built_in", "Int64"], ["meta", "@time"], ["keyword", "end"], ["string", '"a $x"'], ["literal", "nothing"]],
  matlab: [["comment", "% c"], ["keyword", "function"], ["string", "'str'"], ["string", '"str"'], ["keyword", "end"]],
  ruby: [["keyword", "def"], ["title.function", "f"], ["variable", "@a"], ["symbol", ":sym"], ["built_in", "puts"], ["string", '"hi #{x}"'], ["title.class", "A"]],
  php: [["meta", "<?php"], ["comment", "// c"], ["variable", "$x"], ["keyword", "echo"], ["title.function", "f"], ["literal", "null"], ["meta", "?>"]],
  kotlin: [["meta", "@JvmStatic"], ["keyword", "fun"], ["title.function", "main"], ["type", "Array"], ["keyword", "val"], ["built_in", "println"]],
  swift: [["keyword", "import"], ["keyword", "@objc"], ["keyword", "func"], ["title.function", "f"], ["type", "Int"], ["keyword", "let"]],
  diff: [["comment", "diff --git a/x b/x"], ["comment", "--- a/x"], ["comment", "+++ b/x"], ["meta", "@@ -1,2 +1,2 @@"], ["deletion", "-old"], ["addition", "+new"]],
};

function hasToken(tokens: Token[], kind: string, text: string): boolean {
  return tokens.some((t) => t.kind === kind && (t.text === text || t.text.trim() === text));
}

describe("highlighting", () => {
  test("every language the old highlighter was asked for, with aliases", () => {
    assert.deepEqual(
      supportedLanguages(),
      ["bash", "c", "cpp", "csharp", "css", "diff", "go", "html", "java", "javascript", "json", "julia", "kotlin", "latex", "markdown", "matlab", "php", "python", "r", "ruby", "rust", "sql", "swift", "typescript", "xml", "yaml"],
    );
    for (const [alias, name] of Object.entries({ py: "python", js: "javascript", ts: "typescript", sh: "bash", shell: "bash", "c++": "cpp", cs: "csharp", yml: "yaml", tex: "latex", md: "markdown", golang: "go", rs: "rust", jl: "julia", rb: "ruby", kt: "kotlin", patch: "diff", PY: "python", " JSON ": "json" })) {
      assert.equal(languageName(alias), name, alias);
    }
    assert.equal(languageName("cobol"), undefined);
    assert.equal(languageName("constructor"), undefined);
    assert.equal(languageName("__proto__"), undefined);
  });

  test("unknown languages: highlight gives undefined, tokenize one plain token", () => {
    assert.equal(highlight("x < y", "cobol"), undefined);
    assert.deepEqual(tokenize("x < y", "cobol"), [{ text: "x < y", kind: "" }]);
    assert.deepEqual(tokenize("", "python"), []);
  });

  for (const [lang, code] of Object.entries(LANGS)) {
    test(`${lang}: the tokens a theme colors`, () => {
      const tokens = tokenize(code, lang);
      assert.equal(tokens.map((t) => t.text).join(""), code, "tokens must reproduce the input");
      for (const [kind, text] of EXPECT[lang] ?? []) {
        assert.ok(hasToken(tokens, kind, text), `${lang}: expected ${kind} ${JSON.stringify(text)} in ${JSON.stringify(tokens.filter((t) => t.kind))}`);
      }
    });
  }

  test("class names are highlight.js's", () => {
    assert.equal(tokenClass("keyword"), "hljs-keyword");
    assert.equal(tokenClass("built_in"), "hljs-built_in");
    assert.equal(tokenClass("title.function"), "hljs-title function_");
    assert.equal(tokenClass("title.class"), "hljs-title class_");
    assert.equal(tokenClass("variable.language"), "hljs-variable language_");
    assert.equal(tokenClass(""), "");
    assert.equal(highlight("x = 1 # c", "python"), 'x = <span class="hljs-number">1</span> <span class="hljs-comment"># c</span>');
    assert.equal(highlight("def f(): pass", "py"), '<span class="hljs-keyword">def</span> <span class="hljs-title function_">f</span>(): <span class="hljs-keyword">pass</span>');
  });

  test("all text is HTML-escaped; only our spans are markup", () => {
    const evil = `"<script>alert('x')</script>" & <img src=x onerror=y> '</span><b>'`;
    for (const lang of supportedLanguages()) {
      const html = highlight(`${evil}\n// ${evil}\n# ${evil}\n${evil}`, lang)!;
      const stripped = html.replace(/<span class="hljs-[a-z_-]+(?: [a-z]+_)?">|<\/span>/g, "");
      assert.doesNotMatch(stripped, /[<>"']/, `${lang}: ${html}`);
      assert.match(stripped, /&lt;script&gt;/);
      assert.match(stripped, /&quot;/);
      assert.match(stripped, /&#x27;/);
      assert.match(stripped, /&amp; /);
    }
  });

  test("random soups: lossless and never throws", () => {
    const next = rng(11);
    const atoms = ["a", "1", " ", "\n", "\t", '"', "'", "`", "/", "*", "#", "<", ">", "&", "$", "{", "}", "[", "]", "(", ")", "\\", "@", "%", "-", "=", ":", ".", "!", "?", "<!--", "-->", "/*", "*/", "'''", '"""', "${", "r#", "|", "_"];
    for (const lang of supportedLanguages()) {
      for (let k = 0; k < 150; k++) {
        let s = "";
        const n = Math.floor(next() * 60);
        for (let j = 0; j < n; j++) s += atoms[Math.floor(next() * atoms.length)];
        assert.equal(
          tokenize(s, lang)
            .map((t) => t.text)
            .join(""),
          s,
          `${lang}: ${JSON.stringify(s)}`,
        );
      }
    }
  });

  test("hostile input highlights in linear time in every language", () => {
    const hostile = [
      "/*".repeat(10_000),
      '"'.repeat(20_000),
      "'".repeat(20_000),
      "`".repeat(20_000),
      "${".repeat(10_000),
      `"${"${".repeat(10_000)}"`,
      "<a".repeat(10_000),
      "<!--".repeat(5_000),
      "[".repeat(20_000),
      "**".repeat(10_000),
      "*a_".repeat(7_000),
      "= /[/ ".repeat(4_000),
      "#".repeat(20_000),
      "\\begin{".repeat(4_000),
      `${" ".repeat(10_000)}#`,
      "@".repeat(20_000),
      "#[".repeat(10_000),
      "r#".repeat(10_000),
      "<x:".repeat(7_000),
      "a: [".repeat(5_000),
    ];
    for (const lang of supportedLanguages()) {
      timed(lang, () => {
        for (const h of hostile) tokenize(h, lang);
      }, 2500);
    }
  });
});

// ====================================================================== sanitizing

const SAFE_ATTRS: Record<string, string[]> = {
  "*": ["id", "class", "title", "lang", "dir", "aria-label", "colspan", "rowspan", "align"],
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  abbr: ["title"],
};

/**
 * Structural check of sanitizer output: every "<" opens an allowed tag with
 * only allowed, double-quoted, escaped attributes; text holds no markup; no
 * URL attribute carries a dangerous scheme; tags balance.
 */
function assertSafe(html: string, input: string): void {
  const where = `input ${JSON.stringify(input)} gave ${JSON.stringify(html)}`;
  const stack: string[] = [];
  const re = /<(\/?)([a-z][a-z0-9]*)((?: [a-z-]+="[^"<>]*")*)>/y;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const text = html.slice(i, lt < 0 ? html.length : lt);
    assert.doesNotMatch(text, /[<>]/, where);
    if (lt < 0) break;
    re.lastIndex = lt;
    const m = re.exec(html);
    assert.ok(m, `unexpected markup at ${lt}: ${where}`);
    const [, close, name, attrs] = m;
    assert.ok(ALLOWED_TAGS.has(name!), `tag <${name}> not allowed: ${where}`);
    if (close) {
      assert.equal(stack.pop(), name, `unbalanced </${name}>: ${where}`);
    } else {
      for (const a of attrs!.matchAll(/ ([a-z-]+)="([^"]*)"/g)) {
        const [, attr, raw] = a;
        assert.ok(SAFE_ATTRS["*"]!.includes(attr!) || SAFE_ATTRS[name!]?.includes(attr!), `attribute ${attr} on <${name}>: ${where}`);
        assert.doesNotMatch(attr!, /^on/i, where);
        const value = raw!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        if (attr === "href" || attr === "src") {
          const squeezed = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase();
          assert.doesNotMatch(squeezed, /^(?:javascript|vbscript|livescript|jscript):/, where);
          assert.ok(!squeezed.startsWith("data:") || squeezed.startsWith("data:image/"), where);
          assert.doesNotMatch(squeezed, /^[\\/]{2}/, where);
        }
      }
      if (!["img", "br", "hr", "col", "wbr"].includes(name!)) stack.push(name!);
    }
    i = lt + m[0].length;
  }
  assert.deepEqual(stack, [], `unclosed tags: ${where}`);
}

/** The XSS corpus: classic vectors, each must come out harmless and be reported. */
const XSS: string[] = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  '<img src=x onerror="alert(1)">',
  "<img src=x onerror=alert(1)//",
  '<img src="x" onerror="alert(1)"',
  "<IMG SRC=JaVaScRiPt:alert(1)>",
  "<img src=javascript:alert(1)>",
  '<img src="jav\tascript:alert(1)">',
  '<img src="jav&#x09;ascript:alert(1)">',
  '<img """><script>alert(1)</script>">',
  "<img src=`x` onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  "<svg><animate onbegin=alert(1) attributeName=x dur=1s>",
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JAVASCRIPT:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="jav&#9;ascript:alert(1)">x</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
  '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="java&Tab;script:alert(1)">x</a>',
  '<a href="java&NewLine;script:alert(1)">x</a>',
  '<a href="java\u0000script:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="//evil.example">x</a>',
  '<a href="\\\\evil.example">x</a>',
  "<a href=javascript:alert(1)>x</a>",
  '<a/href="javascript:alert(1)">x</a>',
  '<a href="javascript:alert(1)" href="https://ok.example">x</a>',
  '<a onmouseover="alert(1)" href="#">x</a>',
  '<a href="#" ONCLICK="alert(1)">x</a>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)">x</object>',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '<button formaction="javascript:alert(1)">x</button>',
  '<input onfocus=alert(1) autofocus>',
  '<details open ontoggle="alert(1)"><summary>x</summary></details>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<div style="width: expression(alert(1))">x</div>',
  "<style>body{background:url(javascript:alert(1))}</style>",
  '<link rel=stylesheet href="javascript:alert(1)">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  "<body onload=alert(1)>",
  "<video><source onerror=alert(1)></video>",
  "<audio src=x onerror=alert(1)>",
  '<marquee onstart="alert(1)">x</marquee>',
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<<script>alert(1)//<</script>",
  "<script\n>alert(1)</script\n>",
  "<script/xss src=//evil.example/x.js></script>",
  "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
  "<template><img src=x onerror=alert(1)></template>",
  "<textarea><script>alert(1)</script></textarea>",
  "<title><script>alert(1)</script></title>",
  "<xmp><script>alert(1)</script></xmp>",
  "<!--<img src=x onerror=alert(1)>-->",
  "<!-- <!-- nested --> <img src=x onerror=alert(1)> -->",
  "<![CDATA[<script>alert(1)</script>]]>",
  "<p title='x' onclick=alert(1) >y</p>",
  '<p title="a"onclick="alert(1)">x</p>',
  "<div =onclick=alert(1)>x</div>",
  '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" onload="alert(1)">',
  "<img src='data:text/html,<script>alert(1)</script>'>",
  "<isindex type=image src=1 onerror=alert(1)>",
  "<plaintext><script>alert(1)</script>",
  "<a href=\"&#x26;#x6A;avascript:alert(1)\">x</a>",
];

/** Vectors that hold nothing to remove: comments vanish quietly, and the rest is plain text after one decoding. */
const QUIET = new Set(["<!--<img src=x onerror=alert(1)>-->", "<![CDATA[<script>alert(1)</script>]]>", "<a href=\"&#x26;#x6A;avascript:alert(1)\">x</a>"]);

describe("sanitizing: XSS corpus", () => {
  test(`${XSS.length} classic vectors come out harmless and reported`, () => {
    assert.ok(XSS.length >= 40);
    for (const input of XSS) {
      const res = sanitizeHtml(input, { imageSrc: (src) => src });
      assertSafe(res.html, input);
      assert.doesNotMatch(res.html, /<script|<iframe|<svg|<math|<style|<object|<embed|<form|<input|<meta|<link|<base|onerror|onload|javascript:/i, input);
      if (!QUIET.has(input)) assert.equal(res.removed, true, `${input} should be reported`);
    }
  });

  test("script and other dropped elements lose their content too", () => {
    for (const input of ["<script>alert(1)</script>", "<style>x{}</style>", "<iframe>frame</iframe>", "<template>tpl</template>", "<textarea>t</textarea>", "<title>t</title>", "<noscript>n</noscript>", "<object>o</object>", "<select><option>o</option></select>"]) {
      const res = sanitizeHtml(`before${input}after`);
      assert.equal(res.html, "beforeafter", input);
    }
    assert.equal(sanitizeHtml("<template><template>x</template>y</template>z").html, "z");
    assert.equal(sanitizeHtml("<template><style></template></style>hidden</template>shown").html, "shown");
  });

  test("unknown elements lose their tags but keep their text", () => {
    const res = sanitizeHtml("<font color=red>red</font> <svg><text>t</text></svg> <custom-el>c</custom-el>");
    assert.equal(res.html, "red t c");
    assert.deepEqual(res.removals, ["<font> tag", "<svg> tag", "<text> tag", "<custom-el> tag"]);
  });
});

describe("sanitizing: policy", () => {
  test("allowed elements and attributes pass through unchanged", () => {
    const html =
      '<p id="p1" class="lead" title="t" lang="en" dir="ltr" aria-label="intro">A <a href="https://example.com/x?a=1&amp;b=2" name="n" target="_blank" rel="noopener">link</a>, <abbr title="HyperText">HTML</abbr>, <kbd>k</kbd>, <mark>m</mark>, <del>d</del>, <ins>i</ins>, <small>s</small>, <u>u</u>, <s>s</s>, <sup>1</sup><sub>2</sub>.</p>';
    const res = sanitizeHtml(html);
    assert.equal(res.html, html);
    assert.equal(res.removed, false);
    const table = '<table><thead><tr><th colspan="2" align="left">h</th></tr></thead><tbody><tr><td rowspan="2">a</td><td>b</td></tr></tbody></table>';
    assert.equal(sanitizeHtml(table).html, table);
    const details = "<details><summary>More</summary><figure><img src=\"https://x.org/a.png\" alt=\"\" width=\"10\" height=\"5\"><figcaption>c</figcaption></figure></details>";
    assert.equal(sanitizeHtml(details).html, details);
  });

  test("attributes outside the allowlist are dropped and named", () => {
    const res = sanitizeHtml('<div style="color:red" onclick="x()" data-x="1" href="https://x" width="5" class="ok">t</div><img srcset="a.png 2x" loading=lazy src="https://x/a.png">');
    assert.equal(res.html, '<div class="ok">t</div><img src="https://x/a.png">');
    assert.deepEqual(res.removals, ["style attribute", "onclick attribute", "data-x attribute", "href attribute", "width attribute", "srcset attribute", "loading attribute"]);
  });

  test("link and image URL schemes", () => {
    const links = (href: string) => sanitizeHtml(`<a href="${href}">x</a>`).html;
    for (const ok of ["https://x.org", "http://x.org", "mailto:a@b.org", "#frag", "rel/path.html", "../up", "/abs", "?q=1", "a/b:c", "HTTPS://X.ORG"]) assert.equal(links(ok), `<a href="${ok}">x</a>`, ok);
    for (const bad of ["javascript:x", "ftp://x.org", "tel:123", "file:///etc/passwd", "data:text/html,x", "//x.org", "/\\x.org", "a:b", "about:blank"]) assert.equal(links(bad), "<a>x</a>", bad);
    const img = (src: string, imageSrc?: (s: string) => string | undefined) => sanitizeHtml(`<img src="${src}">`, imageSrc ? { imageSrc } : {}).html;
    assert.equal(img("data:image/png;base64,AAAA"), '<img src="data:image/png;base64,AAAA">');
    assert.equal(img("data:text/plain,hi"), "<img>");
    assert.equal(img("file:///x.png"), "<img>", "file: images need a resolver");
    assert.equal(img("file:///x.png", (s) => s), '<img src="file:///x.png">');
  });

  test("the image callback sees decoded sources and decides", () => {
    const seen: string[] = [];
    const res = sanitizeHtml('<img src="a&amp;b.png"><img src="drop.png"><img src="javascript:alert(1)">', {
      imageSrc: (src) => {
        seen.push(src);
        return src === "drop.png" ? undefined : `file:///base/${src}`;
      },
    });
    assert.deepEqual(seen, ["a&b.png", "drop.png"], "never called for an unsafe scheme");
    assert.equal(res.html, '<img src="file:///base/a&amp;b.png"><img><img>');
    assert.deepEqual(res.removals, ["javascript: URL"], "dropping by the callback is not a sanitizer removal");
    assert.equal(sanitizeHtml('<img src="x.png">', { imageSrc: () => "javascript:alert(1)" }).html, "<img>", "callback results are checked too");
  });

  test("empty attributes are dropped except alt", () => {
    assert.equal(sanitizeHtml('<img alt="" src="" title>').html, '<img alt="">');
    assert.equal(sanitizeHtml('<a href="">x</a>').html, "<a>x</a>");
  });

  test("output is well formed: open elements close, stray end tags go", () => {
    assert.equal(sanitizeHtml("<b>bold <i>both</b> tail</i>").html, "<b>bold <i>both</i></b> tail");
    assert.equal(sanitizeHtml("</div><p>x</span></p></p>").html, "<p>x</p>");
    assert.equal(sanitizeHtml("<p>one<p>two<div>three</div>").html, "<p>one</p><p>two</p><div>three</div>");
    assert.equal(sanitizeHtml("<ul><li>a<li>b<ul><li>c</ul></ul>").html, "<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>");
    assert.equal(sanitizeHtml("<table><tr><td>1<td>2<tr><th>3</table>").html, "<table><tr><td>1</td><td>2</td></tr><tr><th>3</th></tr></table>");
    assert.equal(sanitizeHtml("<dl><dt>t<dd>d<dt>u</dl>").html, "<dl><dt>t</dt><dd>d</dd><dt>u</dt></dl>");
    assert.equal(sanitizeHtml("<br/><hr /><img src=a.png/><wbr></br>").html, '<br><hr><img src="a.png/"><wbr>');
    assert.equal(sanitizeHtml("<div/>x").html, "<div>x</div>", "HTML ignores the slash on non-void elements");
  });

  test("tags nested past the limit are dropped, their text kept", () => {
    const res = sanitizeHtml(`${"<div>".repeat(5)}x${"</div>".repeat(5)}`, { maxDepth: 3 });
    assert.equal(res.html, "<div><div><div>x</div></div></div>");
    assert.deepEqual(res.removals, ["tags nested too deeply"]);
  });

  test("comments, doctypes, CDATA and processing instructions vanish quietly", () => {
    const res = sanitizeHtml("<!DOCTYPE html><!-- c --><?xml x?><![CDATA[d]]>a<!-->b<!--->c<!-- x --!>d</>e</ x>f");
    assert.equal(res.html, "abcdef");
    assert.equal(res.removed, false);
  });

  test("a lone < is text; text is re-escaped", () => {
    assert.equal(sanitizeHtml("1 < 2 > 0 & a <3 <= x < /").html, "1 &lt; 2 &gt; 0 &amp; a &lt;3 &lt;= x &lt; /");
  });
});

describe("sanitizing: character references", () => {
  test("text references are decoded and re-escaped; unknown names pass through", () => {
    assert.equal(sanitizeHtml("&lt;b&gt; &amp;amp; &copy; &copy &hellip; &mdash; &NotSubset; &bogus &#65;&#x42;&#X43 &#0; &#xD800; &#x110000; &#128; &#x9F;").html, "&lt;b&gt; &amp;amp; © © … — &NotSubset; &amp;bogus ABC \ufffd \ufffd \ufffd € Ÿ");
    assert.equal(sanitizeHtml("&notit; &notin; &ampx").html, "¬it; ∉ &amp;x");
    assert.equal(sanitizeHtml("a\u0000b\r\nc").html, "a\ufffdb\nc");
  });

  test("attribute values decode with the legacy-reference rule", () => {
    assert.equal(decodeAttribute("?a=1&copy=2&amp;b"), "?a=1&copy=2&b");
    assert.equal(decodeAttribute("&copy;&copy &notit &ampx &#106;&colon;&Tab;"), "©© &notit &ampx j:\t");
    assert.equal(sanitizeHtml('<p title="&quot;&gt;&lt;script&gt;">x</p>').html, '<p title="&quot;&gt;&lt;script&gt;">x</p>');
  });

  test("the named-reference table holds the HTML 4 set and common HTML 5 names", () => {
    const names = namedReferences();
    assert.ok(names.size >= 390, String(names.size));
    const spot: Record<string, number> = { nbsp: 160, yuml: 255, Agrave: 192, hellip: 8230, mdash: 8212, rarr: 8594, lang: 10216, euro: 8364, Omega: 937, Tab: 9, NewLine: 10, colon: 58, lpar: 40, apos: 39, cdot: 267, centerdot: 183 };
    for (const [name, code] of Object.entries(spot)) assert.equal(names.get(name), String.fromCodePoint(code), name);
  });
});

describe("sanitizing: sessions over fragments", () => {
  test("inline HTML fed tag by tag keeps its structure", () => {
    const s = new HtmlSanitizer();
    let out = "";
    for (const piece of ["<b>", "bold", "</b>", " and ", "<script>", "alert(2)", "</script>", " end ", "<i>", "open"]) {
      if (piece.startsWith("<")) out += s.feed(piece).html;
      else if (!s.dropping) out += piece;
    }
    out += s.close();
    assert.equal(out, "<b>bold</b> and  end <i>open</i>");
  });

  test("raw text and dropped elements carry across fragments", () => {
    const s = new HtmlSanitizer();
    assert.equal(s.feed("<style>a{").html, "");
    assert.equal(s.dropping, true);
    assert.equal(s.feed("}</sty").html, "");
    assert.equal(s.feed("le><p>").html, "", "the end tag must come whole in one fragment");
    const t = new HtmlSanitizer();
    t.feed("<template>");
    assert.equal(t.dropping, true);
    assert.equal(t.feed("x</template>y").html, "y");
    assert.equal(t.dropping, false);
  });

  test("each fragment reports its own removals", () => {
    const s = new HtmlSanitizer();
    assert.deepEqual(s.feed("<b onclick=x>").removals, ["onclick attribute"]);
    assert.equal(s.feed("</b>").removed, false);
  });
});

describe("sanitizing: hostile input runs in linear time", () => {
  const cases: [string, string][] = [
    ["unclosed tags", "<a ".repeat(200_000)],
    ["unclosed comments", "<!--".repeat(200_000)],
    ["comments", "<!-- x -->".repeat(100_000)],
    ["ampersands", "&".repeat(500_000)],
    ["references", "&amp;&#x41;&notin;&bogus;".repeat(50_000)],
    ["scripts", "<script>x</script>".repeat(50_000)],
    ["an unclosed script", `<script>${"</scrip".repeat(100_000)}`],
    ["deep nesting", "<div>".repeat(100_000)],
    ["attributes", `<p ${'title="x" '.repeat(100_000)}>`],
    ["bogus comments", "<!x".repeat(200_000)],
    ["lone brackets", "<".repeat(500_000)],
  ];
  for (const [label, input] of cases) {
    test(label, () => {
      const res = timed(label, () => sanitizeHtml(input));
      assert.equal(typeof res.html, "string");
    });
  }

  test("random soups always come out safe", () => {
    const next = rng(3);
    const atoms = ["<", ">", "</", "/>", "a", "b", "p", "script", "img", " ", "=", '"', "'", "src=", "href=", "onerror=", "javascript:", "&#", "&", ";", "x", "<!--", "-->", "\n", "style", "div", "svg", "<a href=", "<img src=", "&colon;", "&Tab;"];
    for (let k = 0; k < 3000; k++) {
      let s = "";
      const n = Math.floor(next() * 30);
      for (let j = 0; j < n; j++) s += atoms[Math.floor(next() * atoms.length)];
      assertSafe(sanitizeHtml(s, { imageSrc: (x) => x }).html, s);
    }
  });
});

// ====================================================================== JSON Schema validation

describe("validation", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      tags: { type: "array", items: { type: "string" }, minItems: 1 },
      kind: { enum: ["a", "b", null] },
      version: { const: 1 },
      nullable: { type: ["string", "null"] },
      record: { type: "object", additionalProperties: { type: "number" } },
      shape: { $ref: "#/$defs/Shape" },
      either: { anyOf: [{ type: "string" }, { type: "number" }] },
      one: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "number", minimum: 100 }] },
    },
    required: ["name"],
    additionalProperties: false,
    $defs: {
      Shape: {
        oneOf: [
          { type: "object", properties: { t: { const: "circle" }, r: { type: "number" } }, required: ["t", "r"], additionalProperties: false },
          { type: "object", properties: { t: { const: "square" }, side: { type: "number" } }, required: ["t", "side"], additionalProperties: false },
        ],
      },
    },
  };
  const check = (value: unknown) => validate(value, schema).map((i) => `${i.path}: ${i.message}`);

  test("a valid value has no issues", () => {
    assert.deepEqual(check({ name: "x", age: 3, tags: ["a"], kind: null, version: 1, nullable: null, record: { a: 1 }, shape: { t: "circle", r: 2 }, either: 4, one: 7 }), []);
  });

  test("each keyword reports with a JSON path", () => {
    assert.deepEqual(check({}), ["name: required property is missing"]);
    assert.deepEqual(check([]), [": expected an object, got an array"]);
    assert.deepEqual(check({ name: "" }), ["name: must not be empty"]);
    assert.deepEqual(check({ name: "x", age: 1.5 }), ["age: expected a whole number, got the number 1.5"]);
    assert.deepEqual(check({ name: "x", age: -1 }), ["age: must be at least 0, got -1"]);
    assert.deepEqual(check({ name: "x", age: 200 }), ["age: must be at most 150, got 200"]);
    assert.deepEqual(check({ name: "x", tags: [] }), ["tags: must have at least 1 item"]);
    assert.deepEqual(check({ name: "x", tags: ["a", 2] }), ["tags[1]: expected a string, got the number 2"]);
    assert.deepEqual(check({ name: "x", kind: "c" }), ['kind: must be one of "a", "b", null; got "c"']);
    assert.deepEqual(check({ name: "x", version: 2 }), ["version: must be 1, got 2"]);
    assert.deepEqual(check({ name: "x", nullable: 3 }), ["nullable: expected a string or a null, got the number 3"]);
    assert.deepEqual(check({ name: "x", record: { a: "1" } }), ["record.a: expected a number, got the string \"1\""]);
    assert.deepEqual(check({ name: "x", extra: 1 }), [
      "extra: unknown property; allowed: name, age, tags, kind, version, nullable, record, shape, either, one",
    ]);
    assert.deepEqual(check({ name: "x", either: true }), ["either: doesn't match any allowed form (expected a string, got true)"]);
  });

  test("oneOf with a constant discriminator looks the branch up", () => {
    assert.deepEqual(check({ name: "x", shape: { r: 1 } }), ["shape.t: required property is missing; one of circle, square"]);
    assert.deepEqual(check({ name: "x", shape: { t: "hexagon" } }), ['shape.t: unknown type "hexagon"; expected one of circle, square']);
    assert.deepEqual(check({ name: "x", shape: { t: "square", r: 1 } }), ["shape.side: required property is missing", "shape.r: unknown property; allowed: t, side"]);
    assert.deepEqual(check({ name: "x", shape: "circle" }), ["shape: expected an object, got the string \"circle\""]);
  });

  test("plain oneOf needs exactly one match", () => {
    assert.deepEqual(check({ name: "x", one: "s" }), []);
    assert.deepEqual(check({ name: "x", one: 150 }), ["one: matches more than one of the allowed forms"]);
    assert.deepEqual(check({ name: "x", one: 1.5 }), ["one: doesn't match any allowed form (expected a string, got the number 1.5)"]);
  });

  test("keys that look like prototype members are ordinary keys", () => {
    assert.deepEqual(check(JSON.parse('{"name": "x", "__proto__": 1, "constructor": 2}')), [
      "__proto__: unknown property; allowed: name, age, tags, kind, version, nullable, record, shape, either, one",
      "constructor: unknown property; allowed: name, age, tags, kind, version, nullable, record, shape, either, one",
    ]);
    assert.deepEqual(validate(JSON.parse('{"toString": 1}'), { type: "object", properties: {}, additionalProperties: false }).length, 1);
  });

  test("paths quote odd keys; issues stop at the limit", () => {
    assert.equal(childPath("", "a"), "a");
    assert.equal(childPath("a", "b-c"), "a.b-c");
    assert.equal(childPath("m", "\\R"), 'm["\\\\R"]');
    assert.equal(childPath("m", "a b"), 'm["a b"]');
    const many = { name: "x", tags: Array.from({ length: 100 }, () => 1) };
    assert.equal(validate(many, schema).length, 25);
    assert.equal(validate(many, schema, { maxIssues: 3 }).length, 3);
  });
});

// ====================================================================== the document schema

const INLINE_TYPES = ["Text", "SoftBreak", "LineBreak", "Emph", "Strong", "Underline", "Strike", "SmallCaps", "Superscript", "Subscript", "Code", "Math", "Link", "Image", "Ref", "Cite", "Note", "Span", "RawInline"];
const BLOCK_TYPES = ["Heading", "Para", "Plain", "CodeBlock", "MathBlock", "BlockQuote", "List", "DefList", "Table", "Figure", "Div", "RawBlock", "HorizontalRule", "PageBreak", "TOC", "Bibliography", "Theorem"];

describe("document schema", () => {
  test("shape: title, $defs Inline and Block, one branch per node type", () => {
    const s = documentJsonSchema();
    assert.equal(s.title, "texwright document");
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(Object.keys(s.$defs!), ["Inline", "Block"]);
    const types = (def: JsonSchema) => def.oneOf!.map((b) => b.properties!.t!.const);
    assert.deepEqual(types(s.$defs!.Inline!), INLINE_TYPES);
    assert.deepEqual(types(s.$defs!.Block!), BLOCK_TYPES);
    for (const branch of [...s.$defs!.Inline!.oneOf!, ...s.$defs!.Block!.oneOf!]) {
      assert.equal(branch.additionalProperties, false);
      assert.equal(branch.required![0], "t");
      assert.ok(branch.description, String(branch.properties!.t!.const));
      assert.ok(branch.properties!.pos, "every node may carry a position");
    }
    assert.deepEqual(s.required, ["texwright", "meta", "blocks"]);
  });

  test("each call returns a fresh copy", () => {
    const a = documentJsonSchema();
    a.title = "changed";
    assert.equal(documentJsonSchema().title, "texwright document");
  });

  test("a document using every node type validates", () => {
    const T = (text: string) => ({ t: "Text", text });
    const pos = { file: "a.md", line: 1, col: 1, endLine: 1, endCol: 3 };
    const doc = {
      texwright: 1,
      meta: {
        title: [T("t")],
        subtitle: [T("s")],
        author: [[T("a")]],
        date: [T("d")],
        abstract: [{ t: "Para", content: [T("x")] }],
        keywords: ["k"],
        lang: "en",
        bibliography: ["refs.bib"],
        citationStyle: "author-year",
        macros: { "\\R": "\\mathbb{R}" },
        toc: true,
        tocDepth: 2,
        numberSections: true,
        numberWithin: 1,
        extra: { anything: [1, { x: null }] },
      },
      blocks: [
        { t: "Heading", level: 1, content: [T("h")], numbered: true, label: "sec:a", id: "sec-a", number: "1", attr: { id: "x", classes: ["c"], attrs: { k: "v" } }, pos },
        {
          t: "Para",
          content: [
            T("x"),
            { t: "SoftBreak" },
            { t: "LineBreak" },
            ...["Emph", "Strong", "Underline", "Strike", "SmallCaps", "Superscript", "Subscript"].map((t) => ({ t, content: [T("y")] })),
            { t: "Code", text: "c" },
            { t: "Math", tex: "x^2" },
            { t: "Link", url: "https://x", title: "t", content: [T("l")] },
            { t: "Image", src: "a.png", alt: [T("a")], title: "t", width: "50%", height: "2cm", attr: { classes: ["i"] } },
            { t: "Ref", label: "sec:a", style: "auto" },
            { t: "Cite", items: [{ key: "doe", prefix: "see", locator: "p. 4", suffix: "x" }], mode: "paren" },
            { t: "Note", blocks: [{ t: "Plain", content: [T("n")] }] },
            { t: "Span", attr: {}, content: [T("s")] },
            { t: "RawInline", format: "html", text: "<b>" },
          ],
        },
        { t: "Plain", content: [] },
        { t: "CodeBlock", text: "x", lang: "python", attr: { attrs: { caption: "c" } } },
        { t: "MathBlock", tex: "a\\\\b", env: "align", numbered: true, lineLabels: ["eq:a", null], lineNumbers: ["1", null] },
        { t: "BlockQuote", blocks: [] },
        { t: "List", ordered: true, start: 3, style: "lower-roman", tight: true, items: [[{ t: "Plain", content: [T("i")] }]], task: [true, null] },
        { t: "DefList", items: [{ term: [T("t")], defs: [[{ t: "Para", content: [T("d")] }]] }] },
        {
          t: "Table",
          caption: [T("c")],
          label: "tbl:x",
          align: ["left", null],
          widths: [0.5, null],
          head: [[{ content: [T("h")], colspan: 2, align: "center" }]],
          body: [[{ content: [] }, { content: [], rowspan: 1, align: null }]],
          foot: [],
          attr: {},
        },
        { t: "Figure", content: [{ t: "Plain", content: [] }], caption: [T("c")], numbered: false },
        { t: "Div", attr: { classes: ["note"] }, blocks: [] },
        { t: "RawBlock", format: "latex", text: "\\x" },
        { t: "HorizontalRule" },
        { t: "PageBreak" },
        { t: "TOC" },
        { t: "Bibliography" },
        { t: "Theorem", kind: "lemma", name: "Lemma", counter: "theorem", withinSection: true, title: [T("x")], blocks: [], numbered: true, label: "lem:a" },
      ],
    };
    const v = validateDocument(doc);
    assert.deepEqual(v.issues, []);
    assert.equal(v.ok, true);
  });

  test("invalid documents get issues with JSON paths", () => {
    const issues = (doc: unknown) => validateDocument(doc).issues.map((i) => `${i.path}: ${i.message}`);
    const wrap = (blocks: unknown[], meta: unknown = {}) => ({ texwright: 1, meta, blocks });
    assert.deepEqual(issues(wrap([{ t: "Nope" }])), [`blocks[0].t: unknown type "Nope"; expected one of ${BLOCK_TYPES.join(", ")}`]);
    assert.deepEqual(issues(wrap([{ t: "Para", content: [{ t: "Bold", content: [] }] }]))[0], `blocks[0].content[0].t: unknown type "Bold"; expected one of ${INLINE_TYPES.join(", ")}`);
    assert.deepEqual(issues(wrap([{ t: "Heading", level: 7, content: [], numbered: true }])), ["blocks[0].level: must be at most 6, got 7"]);
    assert.deepEqual(issues(wrap([{ t: "Heading", level: 1, content: [] }])), ["blocks[0].numbered: required property is missing"]);
    assert.deepEqual(issues(wrap([{ t: "Para", content: [], id: "x" }])), ["blocks[0].id: unknown property; allowed: t, content, pos"]);
    assert.deepEqual(issues(wrap([{ t: "Para", content: [{ t: "Cite", items: [], mode: "paren" }] }])), ["blocks[0].content[0].items: must have at least 1 item"]);
    assert.deepEqual(issues(wrap([{ t: "Para", content: [{ t: "Cite", items: [{ key: "" }], mode: "bad" }] }])), [
      "blocks[0].content[0].items[0].key: must not be empty",
      'blocks[0].content[0].mode: must be one of "paren", "text", "author", "year", "nocite"; got "bad"',
    ]);
    assert.deepEqual(issues(wrap([{ t: "Table", align: ["middle"], head: [], body: [] }])), ['blocks[0].align[0]: must be one of "left", "center", "right", null; got "middle"']);
    assert.deepEqual(issues(wrap([{ t: "Para", content: [{ t: "Text", text: "x", pos: { line: 0, col: 1 } }] }])), ["blocks[0].content[0].pos.line: must be at least 1, got 0"]);
    assert.deepEqual(issues(wrap([], { numberWithin: 2, tocDepth: "2", nope: 1 })), [
      "meta.numberWithin: must be one of 0, 1; got 2",
      'meta.tocDepth: expected a whole number, got the string "2"',
      "meta.nope: unknown property; allowed: title, subtitle, author, affiliation, date, abstract, keywords, lang, bibliography, citationStyle, macros, toc, tocDepth, numberSections, numberWithin, extra",
    ]);
    assert.deepEqual(issues({ texwright: 2, meta: {}, blocks: [] }), ["texwright: must be 1, got 2"]);
    assert.deepEqual(issues({ texwright: 1 }), ["meta: required property is missing", "blocks: required property is missing"]);
    assert.deepEqual(issues(null), [": expected an object, got null"]);
  });

  test("the diagnostics schema describes the CLI's JSON report", () => {
    const s = diagnosticJsonSchema();
    assert.deepEqual(Object.keys(s.$defs!), ["Diagnostic", "Fix"]);
    const fix = { file: "a.md", line: 3, col: 4, old: "\\alpah", new: "\\alpha", safe: true };
    const report = { ok: false, output: "a.pdf", errors: 1, warnings: 0, diagnostics: [{ code: "MATH001", severity: "error", message: "m", file: "a.md", line: 3, col: 4, hint: "h", excerpt: "x", fix }], stats: { pages: 2 } };
    assert.deepEqual(validate(report, s), []);
    assert.deepEqual(validate({ errors: 0, warnings: 0, diagnostics: [], fixed: [fix], unplaced: [] }, s), [], "check --fix reports");
    assert.equal(validate({ ...report, diagnostics: [{ code: "X", severity: "error", message: "m", fix: { old: "a" } }] }, s).length > 0, true, "a fix needs its fields");
    assert.equal(validate({ ...report, diagnostics: [{ code: "X", severity: "fatal", message: "m" }] }, s).length, 1);
  });
});
