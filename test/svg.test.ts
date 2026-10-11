import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { Diagnostics } from "../src/diagnostics.js";
import { findSystemFont, fontsDir } from "../src/font/index.js";
import type { DrawOp, Drawing, Gradient, ImageRef, PathCommand } from "../src/layout/types.js";
import { opsBounds } from "../src/svg/bounds.js";
import { NAMED_COLOR_COUNT, parseColor } from "../src/svg/color.js";
import { parseDeclarations, parseSelector, parseStylesheet } from "../src/svg/css.js";
import { isEmbeddedImage } from "../src/svg/image.js";
import { apply, parseTransform } from "../src/svg/matrix.js";
import { arcToCubics, parsePath } from "../src/svg/path.js";
import { parseAspectRatio, parseViewBox, SVG_LIMITS, svgToDrawing, viewBoxTransform } from "../src/svg/render.js";
import { parseXml, type XmlElement } from "../src/svg/xml.js";

// ---------------------------------------------------------------------------
// Helpers

const ROOT = dirname(fontsDir());

type PathOp = Extract<DrawOp, { op: "path" }>;
type GlyphOp = Extract<DrawOp, { op: "glyphs" }>;

function convert(svg: string, opts: Parameters<typeof svgToDrawing>[1] = {}): { d: Drawing; diags: Diagnostics } {
  const diags = new Diagnostics();
  const d = svgToDrawing(svg, { ...opts, diagnostics: diags });
  return { d, diags };
}

/** A 100x100 px figure (75 x 75 pt) around some content. */
function fig(content: string, attrs = 'width="100" height="100"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${content}</svg>`;
}

const paths = (d: Drawing) => d.ops.filter((o): o is PathOp => o.op === "path");
const runs = (d: Drawing) => d.ops.filter((o): o is GlyphOp => o.op === "glyphs");

/** px (y down, 100 px tall figure) to pt (y up). */
const pt = (x: number, y: number, h = 100): [number, number] => [x * 0.75, (h - y) * 0.75];

function close(a: number, b: number, tol = 1e-3, msg?: string): void {
  assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} != ${b} (tol ${tol})`);
}

function closePt(p: [number, number] | number[], q: [number, number] | number[], tol = 1e-3): void {
  close(p[0], q[0], tol, `x ${p[0]} != ${q[0]}`);
  close(p[1], q[1], tol, `y ${p[1]} != ${q[1]}`);
}

/** Points of a path (end points of every command). */
function points(d: PathCommand[]): [number, number][] {
  const out: [number, number][] = [];
  for (const c of d) {
    if (c[0] === "M" || c[0] === "L") out.push([c[1], c[2]]);
    else if (c[0] === "C") out.push([c[5], c[6]]);
  }
  return out;
}

function bbox(d: PathCommand[]): { x0: number; y0: number; x1: number; y1: number } {
  const p = points(d);
  return {
    x0: Math.min(...p.map((q) => q[0])),
    y0: Math.min(...p.map((q) => q[1])),
    x1: Math.max(...p.map((q) => q[0])),
    y1: Math.max(...p.map((q) => q[1])),
  };
}

function cubicPoint(p0: number[], c: number[], t: number): [number, number] {
  const u = 1 - t;
  const f = (a: number, b: number, cc: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * cc + t * t * t * d;
  return [f(p0[0], c[0], c[2], c[4]), f(p0[1], c[1], c[3], c[5])];
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

function errors(diags: Diagnostics) {
  return diags.items.filter((d) => d.severity === "error");
}

function warnings(diags: Diagnostics) {
  return diags.items.filter((d) => d.severity === "warning");
}

// ---------------------------------------------------------------------------
// XML parser

describe("svg xml parser", () => {
  it("reads elements, attributes, text, CDATA, comments and processing instructions", () => {
    const r = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- comment -->
<svg a="1" b='two'><g id="x"/><text>Hi <!-- not text -->there<![CDATA[ <raw> & ]]></text><?pi stuff?></svg>`);
    assert.equal(r.error, undefined);
    const root = r.root as XmlElement;
    assert.equal(root.name, "svg");
    assert.equal(root.attrs.get("a"), "1");
    assert.equal(root.attrs.get("b"), "two");
    const kids = root.children.filter((c) => c.type === "element") as XmlElement[];
    assert.deepEqual(
      kids.map((k) => k.name),
      ["g", "text"],
    );
    assert.equal(kids[0].parent, root);
    const text = kids[1].children.map((c) => (c.type === "text" ? c.value : "")).join("");
    assert.equal(text, "Hi there <raw> & ");
  });

  it("decodes the predefined entities and character references", () => {
    const r = parseXml(`<svg t="&lt;&gt;&amp;&quot;&apos;"><text>&#65;&#x42;&#x1F600;&#0;&#xD800;</text></svg>`);
    const root = r.root as XmlElement;
    assert.equal(root.attrs.get("t"), `<>&"'`);
    const t = (root.children[0] as XmlElement).children[0];
    assert.equal(t.type === "text" && t.value, "AB\u{1F600}��");
  });

  it("normalizes whitespace in attribute values and keeps a bare & as text", () => {
    const r = parseXml(`<svg d="M0\t0\nL1 1&#10;" x="AT&T"/>`);
    const root = r.root as XmlElement;
    assert.equal(root.attrs.get("d"), "M0 0 L1 1\n");
    assert.equal(root.attrs.get("x"), "AT&T");
  });

  it("strips an svg: prefix from element names", () => {
    const r = parseXml(`<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:rect/></svg:svg>`);
    assert.equal(r.root?.name, "svg");
    assert.equal((r.root?.children[0] as XmlElement).name, "rect");
  });

  it("reports malformed input with a position instead of throwing", () => {
    const bad = [
      "<svg><g></svg>",
      "<svg>",
      "<svg a=1/>",
      '<svg a="1" a="2"/>',
      '<svg a="1/>',
      "plain text",
      "",
      "<svg></g>",
      "<svg><!-- open",
      "<svg><![CDATA[ x",
      "<svg><?pi",
      "<svg><1/></svg>",
      "<svg><g a></g></svg>",
      "<!DOCTYPE svg [ <!ENTITY a 'b'>",
    ];
    for (const s of bad) {
      const r = parseXml(s);
      assert.ok(r.error, `expected an error for ${JSON.stringify(s)}`);
      assert.ok(r.error.line >= 1 && r.error.col >= 1);
    }
    const r = parseXml("<svg>\n  <g>\n  </h>\n</svg>");
    assert.equal(r.error?.line, 3);
    assert.match(r.error?.message ?? "", /does not match/);
  });

  it("skips a DOCTYPE and never expands its entities (billion laughs)", () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY lol "lol">
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!-- a comment with ] and > inside -->
]>
<svg xmlns="http://www.w3.org/2000/svg"><text>&lol9;&xxe;ok</text></svg>`;
    const r = parseXml(bomb);
    assert.equal(r.error, undefined);
    assert.equal(r.doctype, true);
    assert.deepEqual(r.unexpandedEntities, ["lol9", "xxe"]);
    const text = ((r.root as XmlElement).children[0] as XmlElement).children[0];
    assert.equal(text.type === "text" && text.value, "ok");
  });

  it("enforces depth, element and size limits", () => {
    assert.match(parseXml("<svg>" + "<g>".repeat(300) + "</g>".repeat(300) + "</svg>").error?.message ?? "", /nested more than 256/);
    assert.match(parseXml("<svg>" + "<g/>".repeat(20) + "</svg>", { maxElements: 10 }).error?.message ?? "", /more than 10 elements/);
    assert.match(parseXml("<svg/>", { maxLength: 3 }).error?.message ?? "", /larger than/);
  });
});

describe("svgToDrawing on unreadable input", () => {
  it("returns an empty drawing with an IMG001 error and never throws", () => {
    for (const s of ["<svg><g></svg>", "not xml at all", "<html><body/></html>", "\u0000\u0001\u0002", ""]) {
      const { d, diags } = convert(s, { widthPt: 100 });
      assert.equal(d.t, "drawing");
      assert.equal(d.ops.length, 0);
      assert.equal(d.width, 100);
      const e = errors(diags);
      assert.equal(e.length, 1, s);
      assert.equal(e[0].code, "IMG001");
      assert.match(e[0].message, /SVG could not be read/);
    }
    // Not even a string.
    const { d } = convert(undefined as unknown as string);
    assert.equal(d.ops.length, 0);
  });

  it("uses the document position given in opts.pos", () => {
    const diags = new Diagnostics();
    svgToDrawing("<svg>", { diagnostics: diags, pos: { file: "doc.md", line: 7, col: 3 } });
    assert.equal(diags.items[0].file, "doc.md");
    assert.equal(diags.items[0].line, 7);
  });

  it("warns about entity references it did not expand", () => {
    const { d, diags } = convert(`<!DOCTYPE svg [<!ENTITY a "x">]>` + fig(`<rect width="10" height="10"/><text>&a;</text>`));
    assert.equal(paths(d).length, 1);
    const w = warnings(diags);
    assert.equal(w.length, 1);
    assert.match(w[0].message, /&a;/);
  });
});

// ---------------------------------------------------------------------------
// Path data

describe("svg path data", () => {
  it("reads every command in absolute form", () => {
    const p = parsePath("M10 20 L30 40 H50 V60 C1 2 3 4 5 6 S7 8 9 10 Q11 12 13 14 T15 16 A5 5 0 0 1 25 16 Z");
    assert.equal(p.error, undefined);
    const c = p.cmds;
    assert.deepEqual(c[0], ["M", 10, 20]);
    assert.deepEqual(c[1], ["L", 30, 40]);
    assert.deepEqual(c[2], ["L", 50, 40]);
    assert.deepEqual(c[3], ["L", 50, 60]);
    assert.deepEqual(c[4], ["C", 1, 2, 3, 4, 5, 6]);
    // S reflects the previous second control point (3,4) about (5,6).
    assert.deepEqual(c[5], ["C", 7, 8, 7, 8, 9, 10]);
    // Q from (9,10) with control (11,12) to (13,14), as an exact cubic.
    const q = c[6] as number[];
    closePt([q[1], q[2]], [9 + (2 / 3) * 2, 10 + (2 / 3) * 2]);
    closePt([q[3], q[4]], [13 + (2 / 3) * -2, 14 + (2 / 3) * -2]);
    // T reflects the quadratic control (11,12) about (13,14) -> (15,16).
    const t = c[7] as number[];
    closePt([t[1], t[2]], [13 + (2 / 3) * 2, 14 + (2 / 3) * 2]);
    closePt([t[5], t[6]], [15, 16]);
    // The arc ends exactly at (25,16), then closes.
    const last = c[c.length - 2] as number[];
    assert.deepEqual([last[5], last[6]], [25, 16]);
    assert.deepEqual(c[c.length - 1], ["Z"]);
  });

  it("reads relative commands to the same absolute path", () => {
    const abs = parsePath("M10 20 L30 40 H50 V60 C51 62 53 64 55 66 S57 68 59 70 Q61 72 63 74 T65 76 A5 5 0 0 1 75 76 Z M100 100 L110 100");
    const rel = parsePath("m10 20 l20 20 h20 v20 c1 2 3 4 5 6 s2 2 4 4 q2 2 4 4 t2 2 a5 5 0 0 1 10 0 z m90 80 l10 0");
    assert.equal(rel.cmds.length, abs.cmds.length);
    for (let i = 0; i < abs.cmds.length; i++) {
      const a = abs.cmds[i];
      const r = rel.cmds[i];
      assert.equal(r[0], a[0]);
      for (let k = 1; k < a.length; k++) close(r[k] as number, a[k] as number, 1e-9);
    }
  });

  it("handles implicit commands, compact numbers and closepath followed by drawing", () => {
    assert.deepEqual(parsePath("M0 0 10 10 20 0").cmds, [
      ["M", 0, 0],
      ["L", 10, 10],
      ["L", 20, 0],
    ]);
    assert.deepEqual(parsePath("m5 5 10 0").cmds, [
      ["M", 5, 5],
      ["L", 15, 5],
    ]);
    assert.deepEqual(parsePath("M.5.5L1-2e1").cmds, [
      ["M", 0.5, 0.5],
      ["L", 1, -20],
    ]);
    assert.deepEqual(parsePath("M0 0L10 0ZL5 5").cmds, [["M", 0, 0], ["L", 10, 0], ["Z"], ["M", 0, 0], ["L", 5, 5]]);
    // Compact arc flags.
    const a = parsePath("M0 0a5 5 0 0010 0");
    assert.equal(a.error, undefined);
    assert.deepEqual((a.cmds[a.cmds.length - 1] as number[]).slice(5), [10, 0]);
  });

  it("keeps the path up to the first error", () => {
    const p = parsePath("M0 0 L10 10 L20");
    assert.deepEqual(p.cmds, [
      ["M", 0, 0],
      ["L", 10, 10],
    ]);
    assert.ok(p.error);
    assert.ok(parsePath("L10 10").error);
    assert.ok(parsePath("M0 0 X 1").error);
    const { d, diags } = convert(fig(`<path d="M0 0 L10 10 L20" stroke="black"/>`));
    assert.equal(paths(d).length, 1);
    assert.match(warnings(diags)[0].message, /path data has an error/);
  });

  it("converts arcs to cubics that lie on the analytic ellipse, for all four flag combinations", () => {
    const cx = 100;
    const cy = 50;
    const rx = 40;
    const ry = 20;
    const phi = (30 * Math.PI) / 180;
    const P = (deg: number, c = [cx, cy]): [number, number] => {
      const t = (deg * Math.PI) / 180;
      const x = rx * Math.cos(t);
      const y = ry * Math.sin(t);
      return [c[0] + Math.cos(phi) * x - Math.sin(phi) * y, c[1] + Math.sin(phi) * x + Math.cos(phi) * y];
    };
    const p1 = P(10);
    const p2 = P(250);
    const other = [p1[0] + p2[0] - cx, p1[1] + p2[1] - cy]; // the second candidate centre
    const onEllipse = (q: [number, number], c: number[]) => {
      const dx = q[0] - c[0];
      const dy = q[1] - c[1];
      const x = Math.cos(phi) * dx + Math.sin(phi) * dy;
      const y = -Math.sin(phi) * dx + Math.cos(phi) * dy;
      return (x / rx) ** 2 + (y / ry) ** 2;
    };
    const cases: { large: boolean; sweep: boolean; centre: number[]; through: [number, number] }[] = [
      { large: true, sweep: true, centre: [cx, cy], through: P(130) }, // 10 -> 250 increasing
      { large: false, sweep: false, centre: [cx, cy], through: P(310) }, // 10 -> -110 decreasing
      { large: false, sweep: true, centre: other, through: [0, 0] },
      { large: true, sweep: false, centre: other, through: [0, 0] },
    ];
    for (const k of cases) {
      const cubics = arcToCubics(p1[0], p1[1], rx, ry, 30, k.large, k.sweep, p2[0], p2[1]);
      assert.ok(cubics.length >= 2 && cubics.length <= 4);
      let start: number[] = p1;
      const samples: [number, number][] = [];
      for (const c of cubics) {
        for (let i = 0; i <= 16; i++) {
          const q = cubicPoint(start, c, i / 16);
          samples.push(q);
          close(onEllipse(q, k.centre), 1, 2e-3);
        }
        start = [c[4], c[5]];
      }
      closePt(start, p2, 1e-9);
      if (k.through[0] !== 0) {
        const nearest = Math.min(...samples.map((q) => Math.hypot(q[0] - k.through[0], q[1] - k.through[1])));
        assert.ok(nearest < 1.5, `arc should pass near the expected midpoint (${nearest})`);
      }
    }
    // Small and large arcs on the same side sum to the whole ellipse: their lengths differ.
    const small = arcToCubics(p1[0], p1[1], rx, ry, 30, false, false, p2[0], p2[1]).length;
    const large = arcToCubics(p1[0], p1[1], rx, ry, 30, true, true, p2[0], p2[1]).length;
    assert.ok(large > small);
  });

  it("scales radii that are too small and treats zero radii as a line", () => {
    const cubics = arcToCubics(0, 0, 1, 1, 0, false, true, 10, 0);
    let start = [0, 0];
    let maxDev = 0;
    for (const c of cubics) {
      for (let i = 0; i <= 8; i++) {
        const q = cubicPoint(start, c, i / 8);
        close(Math.hypot(q[0] - 5, q[1]), 5, 0.01);
        maxDev = Math.max(maxDev, Math.abs(q[1]));
      }
      start = [c[4], c[5]];
    }
    close(maxDev, 5, 0.01);
    assert.deepEqual(arcToCubics(0, 0, 0, 5, 0, false, true, 10, 0), []);
    assert.deepEqual(parsePath("M0 0 A0 5 0 0 1 10 0").cmds, [
      ["M", 0, 0],
      ["L", 10, 0],
    ]);
    // An arc to its own start point is omitted.
    assert.deepEqual(parsePath("M3 3 A5 5 0 0 1 3 3").cmds, [["M", 3, 3]]);
  });

  it("draws basic shapes", () => {
    const { d } = convert(
      fig(`<rect x="10" y="10" width="20" height="10"/><rect x="10" y="10" width="20" height="10" rx="5"/>
<circle cx="50" cy="50" r="10"/><ellipse cx="50" cy="50" rx="20" ry="10"/><line x1="0" y1="0" x2="10" y2="10" stroke="black"/>
<polyline points="0,0 10,10 20,0" fill="none" stroke="black"/><polygon points="0 0 10 10 20 0 5"/>
<rect width="0" height="10"/><circle r="-1"/>`),
    );
    const ps = paths(d);
    assert.equal(ps.length, 7);
    assert.deepEqual(bbox(ps[0].d), { x0: 7.5, y0: 60, x1: 22.5, y1: 67.5 });
    assert.equal(ps[1].d.filter((c) => c[0] === "C").length, 4);
    const circle = bbox(ps[2].d);
    closePt([circle.x0, circle.x1], [30, 45]);
    assert.equal(ps[4].fill, undefined, "lines are never filled");
    assert.deepEqual(ps[6].d[ps[6].d.length - 1], ["Z"]);
  });
});

// ---------------------------------------------------------------------------
// Transforms and viewports

describe("svg transforms", () => {
  it("parses every transform function", () => {
    closePt(apply(parseTransform("translate(10,20)")!, 1, 1), [11, 21]);
    closePt(apply(parseTransform("translate(10)")!, 1, 1), [11, 1]);
    closePt(apply(parseTransform("scale(2)")!, 1, 3), [2, 6]);
    closePt(apply(parseTransform("scale(2 3)")!, 1, 1), [2, 3]);
    closePt(apply(parseTransform("rotate(90)")!, 1, 0), [0, 1]);
    closePt(apply(parseTransform("rotate(90 10 10)")!, 20, 10), [10, 20]);
    closePt(apply(parseTransform("skewX(45)")!, 0, 1), [1, 1]);
    closePt(apply(parseTransform("skewY(45)")!, 1, 0), [1, 1]);
    closePt(apply(parseTransform("matrix(1 2 3 4 5 6)")!, 1, 1), [9, 12]);
    closePt(apply(parseTransform("rotate(0.25turn)")!, 1, 0), [0, 1]);
    closePt(apply(parseTransform("translate(3px, 4px)")!, 0, 0), [3, 4]);
    assert.deepEqual(parseTransform(""), [1, 0, 0, 1, 0, 0]);
    for (const bad of ["translate(1,2,3)", "foo(1)", "rotate(1 2)", "scale()", "translate(1", "matrix(1 2 3 4 5)", "translate(1em)"]) {
      assert.equal(parseTransform(bad), undefined, bad);
    }
  });

  it("composes a list left to right (the rightmost applies first)", () => {
    closePt(apply(parseTransform("translate(10,20) scale(2)")!, 1, 1), [12, 22]);
    closePt(apply(parseTransform("scale(2) translate(10,20)")!, 1, 1), [22, 42]);
    closePt(apply(parseTransform("translate(10 0), rotate(90)")!, 1, 0), [10, 1]);
    closePt(apply(parseTransform("rotate(90) translate(10 0)")!, 1, 0), [0, 11]);
  });

  it("nests element transforms inside their parents'", () => {
    const { d } = convert(fig(`<g transform="translate(10 0)"><g transform="scale(2)"><rect x="1" y="1" width="5" height="5" transform="translate(1 1)"/></g></g>`));
    // rect corner (1,1) -> translate(1,1) -> (2,2) -> scale 2 -> (4,4) -> translate 10 -> (14,4)
    const b = bbox(paths(d)[0].d);
    closePt([b.x0, b.y1], pt(14, 4));
    closePt([b.x1, b.y0], pt(24, 14));
  });

  it("ignores a malformed transform with a warning", () => {
    const { d, diags } = convert(fig(`<rect width="10" height="10" transform="rotate(oops)"/>`));
    assert.deepEqual(bbox(paths(d)[0].d), { x0: 0, y0: 67.5, x1: 7.5, y1: 75 });
    assert.match(warnings(diags)[0].message, /transform/);
  });

  it("strokes exactly under non-uniform scaling and scales line widths under uniform scaling", () => {
    const { d } = convert(fig(`<g transform="scale(2)"><rect width="10" height="10" fill="none" stroke="black" stroke-width="3"/></g>`));
    assert.equal(paths(d)[0].lineWidth, 4.5); // 3 px * 2 * 0.75
    const { d: d2 } = convert(fig(`<g transform="scale(2 1)"><rect x="10" y="10" width="10" height="10" fill="none" stroke="black" stroke-width="3"/></g>`));
    assert.deepEqual(
      d2.ops.map((o) => o.op),
      ["save", "transform", "path", "restore"],
    );
    const tr = d2.ops[1] as Extract<DrawOp, { op: "transform" }>;
    assert.deepEqual(tr.m, [1.5, 0, 0, -0.75, 0, 75]);
    assert.equal((d2.ops[2] as PathOp).lineWidth, 3);
    const { d: d3 } = convert(fig(`<g transform="scale(2 1)"><rect x="10" y="10" width="10" height="10" fill="none" stroke="black" stroke-width="3" vector-effect="non-scaling-stroke"/></g>`));
    assert.equal(paths(d3)[0].lineWidth, 2.25);
  });
});

describe("svg viewBox and preserveAspectRatio", () => {
  const vb = { x: 0, y: 0, w: 100, h: 50 };
  it("computes meet, slice, alignments and none", () => {
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio(undefined)), [2, 0, 0, 2, 0, 50]);
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio("xMidYMid slice")), [4, 0, 0, 4, -100, 0]);
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio("xMinYMin meet")), [2, 0, 0, 2, 0, 0]);
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio("xMaxYMax")), [2, 0, 0, 2, 0, 100]);
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio("xMinYMax slice")), [4, 0, 0, 4, 0, 0]);
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio("xMaxYMin slice")), [4, 0, 0, 4, -200, 0]);
    assert.deepEqual(viewBoxTransform(vb, 0, 0, 200, 200, parseAspectRatio("none")), [2, 0, 0, 4, 0, 0]);
    assert.deepEqual(viewBoxTransform({ x: 10, y: 20, w: 100, h: 100 }, 5, 5, 50, 50, parseAspectRatio("defer xMidYMid")), [0.5, 0, 0, 0.5, 0, -5]);
    assert.deepEqual(parseAspectRatio("bogus"), { align: [0.5, 0.5], slice: false });
    assert.deepEqual(parseViewBox("0,0 10 20"), { x: 0, y: 0, w: 10, h: 20 });
    assert.equal(parseViewBox("0 0 -1 5"), undefined);
    assert.equal(parseViewBox("0 0 1"), undefined);
  });

  it("sizes the figure from width/height units and the viewBox", () => {
    const size = (attrs: string) => {
      const { d } = convert(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="1" height="1"/></svg>`);
      return [d.width, d.height];
    };
    assert.deepEqual(size('width="2in" height="1in" viewBox="0 0 10 5"'), [144, 72]);
    assert.deepEqual(size('width="100" height="50"'), [75, 37.5]);
    assert.deepEqual(size('width="40pt" height="20pt"'), [40, 20]);
    const mm = size('width="10mm" height="1cm"');
    close(mm[0], (10 / 25.4) * 72, 1e-9);
    close(mm[1], (10 / 25.4) * 72, 1e-9);
    assert.deepEqual(size('width="2em" height="1em"'), [24, 12]);
    assert.deepEqual(size('viewBox="0 0 200 100"'), [150, 75]);
    assert.deepEqual(size('width="100%" height="50%" viewBox="0 0 200 100"'), [150, 37.5]);
    assert.deepEqual(size('width="400" viewBox="0 0 200 100"'), [300, 150]);
    // No size and no viewBox: the content's extent.
    const { d } = convert(`<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="30" height="20"/></svg>`);
    assert.deepEqual([d.width, d.height], [30, 22.5]);
  });

  it("scales to opts.widthPt / heightPt keeping the aspect ratio", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>`;
    let { d } = convert(svg, { widthPt: 300 });
    assert.deepEqual([d.width, d.height], [300, 150]);
    assert.deepEqual(bbox(paths(d)[0].d), { x0: 0, y0: 0, x1: 300, y1: 150 });
    ({ d } = convert(svg, { heightPt: 50 }));
    assert.deepEqual([d.width, d.height], [100, 50]);
    ({ d } = convert(svg, { widthPt: 100, heightPt: 100 }));
    assert.deepEqual([d.width, d.height], [100, 50]);
    ({ d } = convert(svg, { widthPt: -5 }));
    assert.deepEqual([d.width, d.height], [150, 75]);
  });

  it("maps the viewBox into the root viewport with preserveAspectRatio", () => {
    const { d } = convert(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`);
    assert.deepEqual(bbox(paths(d)[0].d), { x0: 37.5, y0: 0, x1: 112.5, y1: 75 });
    const { d: d2 } = convert(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMinYMid"><rect width="100" height="100"/></svg>`);
    assert.deepEqual(bbox(paths(d2)[0].d), { x0: 0, y0: 0, x1: 75, y1: 75 });
  });

  it("gives nested svg elements their own viewport and clips overflow", () => {
    const { d } = convert(fig(`<svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10"><rect width="10" height="10"/><rect x="5" y="5" width="10" height="10"/></svg>`));
    assert.deepEqual(
      d.ops.map((o) => o.op),
      ["save", "clip", "path", "path", "restore"],
    );
    closePt([bbox(paths(d)[0].d).x0, bbox(paths(d)[0].d).x1], [7.5, 22.5]);
    const { d: d2 } = convert(fig(`<svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10" overflow="visible"><rect x="5" y="5" width="10" height="10"/></svg>`));
    assert.deepEqual(
      d2.ops.map((o) => o.op),
      ["path"],
    );
  });

  it("clips content that leaves the figure and leaves fitting figures unclipped", () => {
    const { d } = convert(fig(`<rect x="-10" width="50" height="50"/>`));
    assert.deepEqual(
      d.ops.map((o) => o.op),
      ["save", "clip", "path", "restore"],
    );
    const { d: d2 } = convert(fig(`<rect width="100" height="100"/>`));
    assert.deepEqual(
      d2.ops.map((o) => o.op),
      ["path"],
    );
  });
});

// ---------------------------------------------------------------------------
// Colours and styles

describe("svg colours", () => {
  it("parses every colour syntax", () => {
    assert.equal(NAMED_COLOR_COUNT, 148);
    assert.deepEqual(parseColor("red"), { r: 1, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseColor("RebeccaPurple"), { r: 0x66 / 255, g: 0x33 / 255, b: 0x99 / 255, a: 1 });
    assert.deepEqual(parseColor("#f00"), { r: 1, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseColor("#00ff0080"), { r: 0, g: 1, b: 0, a: 128 / 255 });
    assert.deepEqual(parseColor("#0000"), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(parseColor("rgb(255, 0, 0)"), { r: 1, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseColor("rgb(100%, 50%, 0%)"), { r: 1, g: 0.5, b: 0, a: 1 });
    assert.deepEqual(parseColor("rgba(0,0,255,0.5)"), { r: 0, g: 0, b: 1, a: 0.5 });
    assert.deepEqual(parseColor("rgb(0 0 255 / 50%)"), { r: 0, g: 0, b: 1, a: 0.5 });
    const h = parseColor("hsl(120, 100%, 25%)");
    assert.ok(h && h !== "currentColor");
    closePt([h.r, h.g], [0, 0.5]);
    assert.equal(parseColor("currentColor"), "currentColor");
    assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
    for (const bad of ["none", "#12", "#12345", "rgb(1,2)", "notacolor", "url(#x)", "#ggg"]) assert.equal(parseColor(bad), undefined, bad);
  });

  it("fills black by default, honours none, currentColor and invisible alpha", () => {
    const { d } = convert(
      fig(`<rect width="1" height="1"/><rect width="1" height="1" fill="none" stroke="blue"/><g color="#00ff00"><rect width="1" height="1" fill="currentColor"/></g>
<rect width="1" height="1" fill="#f000"/><rect width="1" height="1" fill="transparent"/><rect width="1" height="1" fill="rgba(255,0,0,0.5)"/>`),
    );
    const ps = paths(d);
    assert.equal(ps.length, 4);
    assert.deepEqual(ps[0].fill, [0, 0, 0]);
    assert.equal(ps[1].fill, undefined);
    assert.deepEqual(ps[1].stroke, [0, 0, 1]);
    assert.deepEqual(ps[2].fill, [0, 1, 0]);
    assert.deepEqual(ps[3].fill, [1, 0, 0]);
    assert.equal(ps[3].fillAlpha, 0.5, "a colour's alpha is the fill's opacity");
  });

  it("puts opacity on the one paint of an element, and draws other elements as groups", () => {
    const { d } = convert(
      fig(`<rect width="1" height="1" fill="black" fill-opacity="0.25"/><g opacity="0.5"><rect width="1" height="1" fill="red"/><g opacity="50%"><rect width="1" height="1" fill="blue" stroke="black" stroke-opacity="0.5"/></g></g><rect width="1" height="1" opacity="0"/>
<rect width="1" height="1" fill="green" opacity="0.4"/><rect x="2" y="2" width="1" height="1" fill="green" stroke="red" opacity="0.4"/>`),
    );
    // (The stroke at the origin reaches outside the figure, which adds a clip around everything.)
    const ops = d.ops.filter((o) => o.op !== "save" && o.op !== "clip" && o.op !== "restore");
    assert.deepEqual(ops.map((o) => o.op), ["path", "group", "path", "group"]);
    const p0 = ops[0] as PathOp;
    assert.deepEqual([p0.fill, p0.fillAlpha], [[0, 0, 0], 0.25]);
    const g = ops[1] as Extract<DrawOp, { op: "group" }>;
    assert.equal(g.opacity, 0.5);
    assert.deepEqual(g.ops.map((o) => o.op), ["path", "group"]);
    const inner = g.ops[1] as Extract<DrawOp, { op: "group" }>;
    assert.equal(inner.opacity, 0.5);
    const p = inner.ops[0] as PathOp;
    assert.deepEqual([p.fill, p.fillAlpha, p.stroke, p.strokeAlpha], [[0, 0, 1], undefined, [0, 0, 0], 0.5]);
    // One fill: the opacity goes on it. A fill and a stroke overlap, so they are a group.
    const p2 = ops[2] as PathOp;
    assert.equal(p2.fillAlpha, 0.4);
    assert.equal((ops[3] as Extract<DrawOp, { op: "group" }>).opacity, 0.4);
    assert.ok(g.bbox[0] < 0 && g.bbox[2] > 0.75, "the group box holds its content with room for anti-aliasing");
  });

  it("fills with linear and radial gradients, following href and units", () => {
    const { d, diags } = convert(
      fig(`<defs><linearGradient id="g"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient>
<linearGradient id="h" xlink:href="#g" spreadMethod="reflect"/>
<radialGradient id="r"><stop offset="50%" style="stop-color:#ff0000"/></radialGradient>
<radialGradient id="u" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="20" fx="40" gradientTransform="translate(10 0)"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue" stop-opacity="0.5"/></radialGradient>
<pattern id="p"><rect width="1" height="1" fill="#0000ff"/></pattern></defs>
<rect width="10" height="20" fill="url(#g)"/><rect width="10" height="20" fill="url(#h)"/><rect width="1" height="1" fill="url('#r')"/><rect width="1" height="1" fill="url(#p)"/>
<rect width="1" height="1" fill="url(#missing) green"/><rect width="1" height="1" fill="url(#missing)"/><rect width="100" height="100" fill="url(#u)"/>`),
    );
    const ops = d.ops;
    const ps = paths(d);
    const g0 = ps[0].fill as Gradient;
    assert.equal(g0.kind, "linear");
    assert.deepEqual(g0.coords, [0, 0, 1, 0]);
    // objectBoundingBox: (0, 0) is the box's top left, (1, 1) its bottom right, in figure points (y up).
    closePt(apply(g0.matrix, 0, 0), pt(0, 0));
    closePt(apply(g0.matrix, 1, 1), pt(10, 20));
    assert.deepEqual(g0.stops, [
      { offset: 0, color: [0, 0, 0] },
      { offset: 1, color: [1, 1, 1] },
    ]);
    const g1 = ps[1].fill as Gradient;
    assert.deepEqual([g1.stops, g1.spread], [g0.stops, "reflect"], "stops come through href");
    assert.deepEqual(ps[2].fill, [1, 0, 0], "one stop paints its colour");
    assert.deepEqual(ps[3].fill, [0, 0.502, 0], "the fallback colour after a missing reference");
    // Stops that differ in opacity: a group whose mask is the gradient in grey.
    const masked = ops[ops.length - 1] as Extract<DrawOp, { op: "group" }>;
    assert.equal(masked.op, "group");
    const u = (masked.ops[0] as PathOp).fill as Gradient;
    assert.deepEqual(u.coords, [40, 50, 0, 50, 50, 20]);
    closePt(apply(u.matrix, 50, 50), pt(60, 50));
    const grey = (masked.mask!.ops[0] as PathOp).fill as Gradient;
    assert.deepEqual(
      grey.stops.map((s) => s.color),
      [
        [1, 1, 1],
        [0.5, 0.5, 0.5],
      ],
    );
    assert.equal(masked.mask!.luminance, true);
    const msgs = warnings(diags).map((w) => w.message);
    assert.ok(!msgs.some((m) => /average colour/.test(m)));
    assert.ok(msgs.some((m) => /#missing/.test(m)));
  });

  it("fills with a pattern by repeating its tile inside a clip to the shape", () => {
    const { d, diags } = convert(
      fig(`<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#0000ff"/></pattern>
<pattern id="half" width="0.5" height="0.5"><rect width="1" height="1" fill="red"/></pattern></defs>
<rect width="8" height="8" fill="url(#hatch)" stroke="black"/>
<rect x="20" y="20" width="10" height="10" fill="url(#half)"/>`),
    );
    assert.deepEqual(warnings(diags), []);
    const ops = d.ops.map((o) => o.op);
    // Clip to the shape, then four translated copies of the tile, then the stroke.
    assert.equal(ops.filter((o) => o === "clip").length >= 2, true);
    const blue = paths(d).filter((p) => p.fill && String(p.fill) === "0,0,1");
    const red = paths(d).filter((p) => p.fill && String(p.fill) === "1,0,0");
    assert.equal(blue.length, 4, "an 8x8 shape holds four 4x4 tiles");
    assert.equal(red.length, 4, "objectBoundingBox tiles: half the shape each way");
    assert.ok(paths(d).some((p) => p.stroke && !p.fill), "the stroke is drawn after the pattern");
  });

  it("maps stroke properties", () => {
    const { d } = convert(fig(`<path d="M0 0L10 10" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="4 2 1" stroke-miterlimit="10"/>`));
    const p = paths(d)[0];
    assert.equal(p.lineWidth, 1.5);
    assert.equal(p.lineCap, 1);
    assert.equal(p.lineJoin, 2);
    assert.deepEqual(p.dash, [3, 1.5, 0.75, 3, 1.5, 0.75]);
    const { d: d2 } = convert(fig(`<path d="M0 0L10 10" stroke="black" stroke-dasharray="4 2" stroke-dashoffset="5"/>`));
    assert.deepEqual(paths(d2)[0].dash, [0, 0.75, 3, 0.75]);
    const { d: d3 } = convert(fig(`<path d="M0 0L10 10" stroke="black" stroke-dasharray="4 2" stroke-dashoffset="1"/>`));
    assert.deepEqual(paths(d3)[0].dash, [2.25, 1.5, 0.75, 0]);
    const { d: d4 } = convert(fig(`<path d="M0 0L10 10" stroke="black" stroke-dasharray="0 0"/><path d="M0 0L10 10Z" fill="red" fill-rule="evenodd"/>`));
    assert.equal(paths(d4)[0].dash, undefined);
    assert.equal(paths(d4)[1].evenOdd, true);
  });
});

describe("svg styles", () => {
  it("parses declarations and selectors", () => {
    assert.deepEqual(parseDeclarations("fill: red; stroke:url(data:a;b) ; font-family: 'A;B', serif !important"), [
      { name: "fill", value: "red", important: false },
      { name: "stroke", value: "url(data:a;b)", important: false },
      { name: "font-family", value: "'A;B', serif", important: true },
    ]);
    assert.equal(parseSelector("rect")?.specificity, 1);
    assert.equal(parseSelector(".a.b")?.specificity, 2000);
    assert.equal(parseSelector("g > rect#x.y")?.specificity, 1_001_002);
    assert.equal(parseSelector("[x]")?.specificity, 1000);
    assert.equal(parseSelector("rect:nth-child(2n+1) + circle ~ *:not(.a)")?.specificity, 2002);
    assert.ok(parseSelector("a:hover"), "interaction pseudo-classes parse and never match");
    assert.equal(parseSelector("p::before"), undefined);
    assert.equal(parseSelector("a:unknown-thing"), undefined);
    const sheet = parseStylesheet("/* c */ @media print { rect { fill: red } } rect, .a::after { fill: blue } @import 'x.css'; .b{stroke:red}");
    assert.equal(sheet.rules.length, 2);
    assert.equal(sheet.unsupported, 1);
  });

  it("applies presentation attributes < selectors by specificity < style attribute < !important", () => {
    const { d } = convert(
      fig(`<style><![CDATA[
  rect { fill: blue }
  .a { fill: green }
  #b { fill: yellow }
  .imp { fill: #00ffff !important }
  g .deep { fill: #ff00ff }
  g > .child { stroke: red }
  circle, .list { fill: #808080 }
]]></style>
<rect width="1" height="1" fill="red"/>
<rect width="1" height="1" class="a" fill="red"/>
<rect width="1" height="1" class="a" id="b"/>
<rect width="1" height="1" id="b" style="fill: purple"/>
<rect width="1" height="1" class="imp" style="fill: purple"/>
<g><g><rect width="1" height="1" class="deep"/></g></g>
<g><rect width="1" height="1" class="child"/></g>
<g><a><rect width="1" height="1" class="child"/></a></g>
<path d="M0 0H1V1Z" class="list"/>`),
    );
    const fills = paths(d).map((p) => p.fill);
    const strokes = paths(d).map((p) => p.stroke);
    assert.deepEqual(fills, [
      [0, 0, 1],
      [0, 0.502, 0],
      [1, 1, 0],
      [0.502, 0, 0.502],
      [0, 1, 1],
      [1, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
      [0.502, 0.502, 0.502],
    ]);
    assert.deepEqual(strokes[6], [1, 0, 0]);
    assert.equal(strokes[7], undefined, "child combinator needs a direct parent");
  });

  it("inherits fill, stroke, font and visibility; display none hides a subtree", () => {
    const { d } = convert(
      fig(`<g fill="red" stroke="blue" stroke-width="4"><rect width="1" height="1"/><g fill="inherit"><rect width="1" height="1" stroke="inherit"/></g></g>
<g display="none"><rect width="1" height="1"/></g><rect width="1" height="1" style="display:none"/>
<g visibility="hidden"><rect width="1" height="1"/><rect width="1" height="1" fill="green" visibility="visible"/></g>
<g opacity="inherit" fill="unset"><rect width="1" height="1"/></g>`),
    );
    const ps = paths(d);
    assert.equal(ps.length, 4);
    assert.deepEqual(ps[0].fill, [1, 0, 0]);
    assert.deepEqual(ps[0].stroke, [0, 0, 1]);
    assert.equal(ps[0].lineWidth, 3);
    assert.deepEqual(ps[1].fill, [1, 0, 0]);
    assert.deepEqual(ps[2].fill, [0, 0.502, 0]);
    assert.deepEqual(ps[3].fill, [0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Markers

describe("svg markers", () => {
  const arrow = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1f3a4d"/></marker></defs>`;

  /** Tip of the arrowhead path (its second point) and the direction from the base midpoint to it. */
  function arrowOf(p: PathOp): { tip: [number, number]; dir: [number, number] } {
    const pts = points(p.d);
    const tip = pts[1];
    const base: [number, number] = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2];
    const len = Math.hypot(tip[0] - base[0], tip[1] - base[1]);
    return { tip, dir: [(tip[0] - base[0]) / len, (tip[1] - base[1]) / len] };
  }

  it("puts an arrowhead at the end of a line, pointing along it", () => {
    const { d, diags } = convert(fig(`${arrow}<line x1="10" y1="10" x2="50" y2="40" stroke="black" stroke-width="1.4" marker-end="url(#a)"/>`));
    assert.equal(diags.items.length, 0);
    const ps = paths(d);
    assert.equal(ps.length, 2);
    const { tip, dir } = arrowOf(ps[1]);
    // The tip lies 1 viewBox unit past refX: 1 * (7/10) * 1.4 px beyond the end, along (0.8, 0.6).
    const ext = 0.7 * 1.4;
    closePt(tip, pt(50 + 0.8 * ext, 40 + 0.6 * ext));
    closePt(dir, [0.8, -0.6]); // y flips in figure space
    // Width of the head: 10 units * 0.7 * 1.4 px.
    const pts = points(ps[1].d);
    close(Math.hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]), 7 * 1.4 * 0.75);
    assert.deepEqual(ps[1].fill, [0.1216, 0.2275, 0.302]);
  });

  it("reverses the start marker for auto-start-reverse and honours fixed angles and userSpaceOnUse", () => {
    const { d } = convert(fig(`${arrow}<line x1="10" y1="50" x2="60" y2="50" stroke="black" stroke-width="2" marker-start="url(#a)"/>`));
    const s = arrowOf(paths(d)[1]);
    closePt(s.dir, [-1, 0]);
    closePt(s.tip, pt(10 - 1.4, 50));
    const { d: d2 } = convert(
      fig(`<defs><marker id="m" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="90"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
<line x1="10" y1="50" x2="60" y2="50" stroke="black" stroke-width="5" marker-end="url(#m)"/>`),
    );
    const e = arrowOf(paths(d2)[1]);
    closePt(e.dir, [0, -1]); // 90 degrees: down the page
    closePt(e.tip, pt(60, 60));
  });

  it("places start, mid and end markers on polyline and path vertices with bisected angles", () => {
    const { d } = convert(
      fig(`<defs><marker id="dot" markerWidth="2" markerHeight="2" refX="1" refY="1" markerUnits="userSpaceOnUse"><rect width="2" height="2" fill="red"/></marker></defs>
<polyline points="10,10 20,10 30,20 40,20" fill="none" stroke="black" marker-start="url(#dot)" marker-mid="url(#dot)" marker-end="url(#dot)"/>
<path d="M50 50 L60 50 M70 70 L80 80" stroke="black" style="marker: url(#dot)"/>`),
    );
    const dots = paths(d).filter((p) => Array.isArray(p.fill) && p.fill[0] === 1);
    assert.equal(dots.length, 8);
    const centres = dots.map((p) => {
      const b = bbox(p.d);
      return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    });
    closePt(centres[0], pt(10, 10));
    closePt(centres[1], pt(20, 10));
    closePt(centres[3], pt(40, 20));
    closePt(centres[6], pt(70, 70));
    const { d: d2 } = convert(fig(`${arrow.replace("auto-start-reverse", "auto")}<polyline points="10,10 50,10 50,50" fill="none" stroke="black" stroke-width="1" marker-mid="url(#a)"/>`));
    const mid = arrowOf(paths(d2)[1]);
    closePt(mid.dir, [Math.SQRT1_2, -Math.SQRT1_2]); // bisector of east and south (south is -y in figure space)
  });

  it("resolves context-stroke in marker contents and ignores missing markers", () => {
    const { d, diags } = convert(
      fig(`<defs><marker id="c" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L4 2L0 4Z" fill="context-stroke"/></marker></defs>
<line x1="0" y1="0" x2="10" y2="0" stroke="#ff0000" marker-end="url(#c)"/><line x1="0" y1="0" x2="10" y2="0" stroke="red" marker-end="url(#nope)"/>`),
    );
    assert.deepEqual(paths(d)[1].fill, [1, 0, 0]);
    assert.match(warnings(diags)[0].message, /#nope/);
  });
});

// ---------------------------------------------------------------------------
// Text

describe("svg text", () => {
  it("anchors text at start, middle and end", () => {
    const { d } = convert(fig(`<text x="50" y="50">Hello</text><text x="50" y="60" text-anchor="middle">Hello</text><text x="50" y="70" text-anchor="end">Hello</text>`));
    const rs = runs(d);
    assert.equal(rs.length, 3);
    const w = rs[0].run.width;
    assert.ok(w > 20 && w < 40);
    close(rs[0].x, 37.5);
    close(rs[1].x, 37.5 - w / 2);
    close(rs[2].x, 37.5 - w);
    close(rs[0].y, 37.5);
    close(rs[2].y, 22.5);
    // Width is the sum of the advances, and the advances come from the font.
    const r = rs[0].run;
    close(
      r.advances.reduce((a, b) => a + b, 0),
      w,
    );
    assert.equal(r.size, 12); // 16 px default * 0.75
    assert.deepEqual(r.text, ["H", "e", "l", "l", "o"]);
    assert.equal(r.gids.length, 5);
    assert.ok(r.gids.every((g) => g > 0));
    const ownWidth = r.gids.reduce((s, g, i) => s + r.font.advance(g) + (i + 1 < r.gids.length ? r.font.kerning(g, r.gids[i + 1]) : 0), 0) * (12 / r.font.unitsPerEm);
    close(ownWidth, w);
    close(r.height, (r.font.ascent / r.font.unitsPerEm) * 12);
  });

  it("chooses fonts by family, weight and style", () => {
    const { d } = convert(
      fig(`<text font-family="serif">a</text><text font-family="'Computer Modern'" font-weight="bold">a</text><text font-style="italic">a</text>
<text font-weight="700" font-style="italic">a</text><text font-family="KaTeX_SansSerif">a</text><text font-family="sans-serif">a</text><text font-family="monospace">a</text>
<text font-family="NoSuchFont, Helvetica">a</text><text style="font: italic bold 20px serif">a</text><text font-family="Georgia, serif">a</text><text font-family="NoSuchSerif, serif">a</text>`),
    );
    const names = runs(d).map((r) => r.run.font.postscriptName);
    assert.deepEqual(names.slice(0, 5), ["KaTeX_Main-Regular", "KaTeX_Main-Bold", "KaTeX_Main-Italic", "KaTeX_Main-BoldItalic", "KaTeX_SansSerif-Regular"]);
    assert.ok(!names[5].startsWith("KaTeX_Main"), `sans-serif uses a sans face, got ${names[5]}`);
    assert.ok(!names[6].startsWith("KaTeX_Main"), `monospace uses a monospace face, got ${names[6]}`);
    assert.ok(!names[7].startsWith("KaTeX_Main"), `a Helvetica list leans sans, got ${names[7]}`);
    assert.equal(names[8], "KaTeX_Main-BoldItalic");
    assert.equal(runs(d)[8].run.size, 15);
    // A named serif family is the installed font when there is one, the bundled serif otherwise.
    assert.equal(names[9], findSystemFont("Georgia") ? "Georgia" : "KaTeX_Main-Regular");
    assert.equal(names[10], "KaTeX_Main-Regular");
  });

  it("continues text across tspans and applies x, y, dx and dy", () => {
    const { d } = convert(fig(`<text x="10" y="20">a<tspan font-style="italic">b</tspan>c<tspan dx="5" dy="-2">d</tspan><tspan x="80 90" y="30">ef</tspan></text>`));
    const rs = runs(d);
    assert.deepEqual(
      rs.map((r) => r.run.text.join("")),
      ["a", "b", "c", "d", "e", "f"],
    );
    close(rs[1].x, rs[0].x + rs[0].run.width);
    close(rs[2].x, rs[1].x + rs[1].run.width);
    close(rs[3].x, rs[2].x + rs[2].run.width + 3.75);
    close(rs[3].y, rs[0].y + 1.5);
    closePt([rs[4].x, rs[4].y], pt(80, 30));
    closePt([rs[5].x, rs[5].y], pt(90, 30));
  });

  it("collapses white space by default and keeps it with xml:space=preserve", () => {
    const { d } = convert(fig(`<text x="0" y="10">  a \n  b\t<tspan> c </tspan> </text><text x="0" y="30" xml:space="preserve"> a  b </text>`));
    const rs = runs(d);
    assert.equal(rs.map((r) => r.run.text.join("")).join("|"), "a b |c| a  b ");
  });

  it("anchors a chunk made of several runs as a whole", () => {
    const { d } = convert(fig(`<text x="50" y="50" text-anchor="end">ab<tspan font-weight="bold">cd</tspan></text>`));
    const rs = runs(d);
    close(rs[1].x + rs[1].run.width, 37.5);
  });

  it("draws rotated text under a transform and scales text with the figure", () => {
    const { d } = convert(fig(`<text x="15" y="50" transform="rotate(-90 15 50)">up</text>`));
    assert.deepEqual(
      d.ops.map((o) => o.op),
      ["save", "transform", "glyphs", "restore"],
    );
    const t = d.ops[1] as Extract<DrawOp, { op: "transform" }>;
    closePt([t.m[0], t.m[1], t.m[2], t.m[3]], [0, 0.75], 1e-9);
    closePt([t.m[2], t.m[3]], [-0.75, 0], 1e-9);
    closePt([t.m[4], t.m[5]], pt(15, 50));
    const { d: d2 } = convert(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200"><text y="10" font-size="10">x</text></svg>`);
    assert.equal(runs(d2)[0].run.size, 15);
  });

  it("falls back to other fonts for characters the face lacks", () => {
    const { d, diags } = convert(fig(`<text font-style="italic">a→b·c</text>`));
    const rs = runs(d);
    assert.equal(rs.map((r) => r.run.text.join("")).join(""), "a→b·c");
    assert.ok(rs.every((r) => r.run.gids.every((g) => g > 0)));
    assert.ok(rs.some((r) => r.run.font.postscriptName === "KaTeX_Main-Regular"), "the arrow comes from the upright face");
    assert.equal(diags.items.length, 0);
  });

  it("applies dominant-baseline and baseline-shift", () => {
    const { d } = convert(fig(`<text y="50">x</text><text y="50" dominant-baseline="central">x</text><text y="50" dominant-baseline="hanging">x</text><text y="50"><tspan baseline-shift="super">x</tspan></text>`));
    const rs = runs(d);
    assert.ok(rs[1].y < rs[0].y && rs[2].y < rs[1].y, "central and hanging move the baseline down the page");
    // super: up by half the font's height (ascent plus descent), as browsers do.
    const f = rs[3].run.font;
    close(rs[3].y - rs[0].y, (((f.ascent - f.descent) / f.unitsPerEm) * 12) / 2);
  });
});

// ---------------------------------------------------------------------------
// use, defs, symbol, switch

describe("svg use and defs", () => {
  it("instantiates referenced elements with x/y, href and xlink:href", () => {
    const { d } = convert(
      fig(`<defs><rect id="r" width="10" height="10"/><g id="grp" fill="red"><circle cx="5" cy="5" r="5"/></g></defs>
<use href="#r" x="20" y="30"/><use xlink:href="#r" transform="translate(50 0)" fill="blue"/><use href="#grp" x="70" y="70"/>`),
    );
    const ps = paths(d);
    assert.equal(ps.length, 3);
    assert.deepEqual(bbox(ps[0].d), { x0: 15, y0: 45, x1: 22.5, y1: 52.5 });
    assert.deepEqual(ps[1].fill, [0, 0, 1], "use-instantiated content inherits from <use>");
    assert.deepEqual(ps[2].fill, [1, 0, 0]);
    closePt([bbox(ps[2].d).x0, bbox(ps[2].d).y1], pt(70, 70));
  });

  it("instantiates symbols with their viewBox", () => {
    const { d } = convert(fig(`<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><use href="#s" x="10" y="10" width="20" height="20"/>`));
    assert.deepEqual(bbox(paths(d)[0].d), { x0: 7.5, y0: 52.5, x1: 22.5, y1: 67.5 });
  });

  it("ignores external references and survives reference cycles", () => {
    const { d, diags } = convert(
      fig(`<use href="other.svg#x"/><use href="#nope"/>
<g id="a"><rect width="1" height="1"/><use href="#a"/></g>
<g id="p"><use href="#q"/></g><g id="q"><use href="#p"/></g>`),
    );
    assert.ok(paths(d).length >= 1);
    const msgs = warnings(diags).map((w) => w.message);
    assert.ok(msgs.some((m) => /another file/.test(m)));
    assert.ok(msgs.some((m) => /#nope/.test(m)));
    assert.ok(msgs.some((m) => /cycle/.test(m)));
  });

  it("does not draw defs, symbols, markers or clip paths directly; picks one switch child", () => {
    const { d } = convert(
      fig(`<defs><rect width="1" height="1"/></defs><symbol><rect width="1" height="1"/></symbol><clipPath><rect width="1" height="1"/></clipPath>
<switch><foreignObject width="10" height="10"/><g requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility"><rect width="1" height="1"/></g><text y="10">fallback</text><text>second</text></switch>`),
    );
    assert.equal(paths(d).length, 0);
    assert.deepEqual(
      runs(d).map((r) => r.run.text.join("")),
      ["fallback"],
    );
  });
});

// ---------------------------------------------------------------------------
// Clip paths and images

describe("svg clip paths", () => {
  it("wraps clipped elements in save/clip/restore", () => {
    const { d } = convert(fig(`<clipPath id="c"><rect width="50" height="50"/></clipPath><rect width="100" height="100" clip-path="url(#c)" fill="red"/><rect width="10" height="10"/>`));
    assert.deepEqual(
      d.ops.map((o) => o.op),
      ["save", "clip", "path", "restore", "path"],
    );
    const clip = d.ops[1] as Extract<DrawOp, { op: "clip" }>;
    assert.deepEqual(bbox(clip.d), { x0: 0, y0: 37.5, x1: 37.5, y1: 75 });
    assert.equal(clip.evenOdd, undefined);
  });

  it("honours clip-rule, transforms, objectBoundingBox units and nested clip paths", () => {
    const { d } = convert(
      fig(`<clipPath id="e" transform="translate(10 0)"><path d="M0 0H20V20H0Z M5 5H15V15H5Z" clip-rule="evenodd"/></clipPath>
<g transform="translate(0 10)"><rect width="50" height="50" clip-path="url(#e)"/></g>`),
    );
    const clip = d.ops[1] as Extract<DrawOp, { op: "clip" }>;
    assert.equal(clip.evenOdd, true);
    closePt([bbox(clip.d).x0, bbox(clip.d).y1], pt(10, 10));
    const { d: d2 } = convert(fig(`<clipPath id="o" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath><rect x="10" y="20" width="40" height="40" clip-path="url(#o)"/>`));
    const c2 = d2.ops[1] as Extract<DrawOp, { op: "clip" }>;
    const b = bbox(c2.d);
    closePt([b.x0, b.x1], [7.5, 22.5]);
    const { d: d3 } = convert(
      fig(`<clipPath id="inner"><rect width="30" height="30"/></clipPath><clipPath id="outer" clip-path="url(#inner)"><circle cx="20" cy="20" r="20"/></clipPath><rect width="100" height="100" clip-path="url(#outer)"/>`),
    );
    assert.equal(d3.ops.filter((o) => o.op === "clip").length, 2);
  });

  it("hides elements clipped by an empty clip path and draws unclipped for a missing one", () => {
    const { d, diags } = convert(fig(`<clipPath id="empty"/><rect width="10" height="10" clip-path="url(#empty)"/><rect width="10" height="10" clip-path="url(#none)"/>`));
    assert.deepEqual(
      d.ops.map((o) => o.op),
      ["path"],
    );
    assert.match(warnings(diags)[0].message, /#none/);
  });
});

describe("svg images", () => {
  function png(w: number, h: number): string {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const v = new DataView(b.buffer);
    v.setUint32(16, w);
    v.setUint32(20, h);
    b[24] = 8;
    b[25] = 6;
    return "data:image/png;base64," + Buffer.from(b).toString("base64");
  }

  it("embeds PNG data URLs with their bytes and fits them with preserveAspectRatio", () => {
    const { d, diags } = convert(fig(`<image href="${png(20, 10)}" x="10" y="10" width="40" height="40"/>`));
    assert.equal(diags.items.length, 0);
    const img = d.ops.find((o) => o.op === "image") as Extract<DrawOp, { op: "image" }>;
    assert.ok(isEmbeddedImage(img.image));
    assert.equal(img.image.pixelWidth, 20);
    assert.equal(img.image.pixelHeight, 10);
    // 40x20 centred in the 40x40 box: y from 20 to 40 px.
    assert.deepEqual([img.x, img.y, img.width, img.height], [7.5, 45, 30, 15]);
    const { d: d2 } = convert(fig(`<image href="${png(20, 10)}" width="40" height="40" preserveAspectRatio="xMidYMid slice"/>`));
    assert.deepEqual(
      d2.ops.map((o) => o.op),
      ["save", "clip", "image", "restore"],
    );
  });

  it("passes other hrefs to resolveImage and ignores what it cannot load", () => {
    const seen: string[] = [];
    const ref: ImageRef = { id: "pic", pixelWidth: 100, pixelHeight: 50 };
    const { d, diags } = convert(fig(`<image xlink:href="pic.png" width="10"/><image href="missing.png" width="10"/><image href="data:image/gif;base64,R0lGODlh" width="10"/>`), {
      resolveImage: (h) => {
        seen.push(h);
        return h === "pic.png" ? ref : undefined;
      },
    });
    assert.deepEqual(seen, ["pic.png", "missing.png", "data:image/gif;base64,R0lGODlh"]);
    const imgs = d.ops.filter((o) => o.op === "image");
    assert.equal(imgs.length, 1);
    assert.equal((imgs[0] as Extract<DrawOp, { op: "image" }>).image, ref);
    assert.equal((imgs[0] as Extract<DrawOp, { op: "image" }>).height, 3.75);
    assert.equal(warnings(diags).length, 2);
  });
});

// ---------------------------------------------------------------------------
// The real figures

describe("svg effects", () => {
  const groups = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { op: "group" }> => o.op === "group");
  const images = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { op: "image" }> => o.op === "image");

  it("draws masked elements as groups with a soft mask, in object or user units", () => {
    const { d, diags } = convert(
      fig(`<defs><mask id="m"><rect width="100" height="50" fill="white"/></mask>
<mask id="b" maskContentUnits="objectBoundingBox" style="mask-type: alpha"><rect width="0.5" height="1" fill="black"/></mask></defs>
<rect width="100" height="100" fill="red" mask="url(#m)"/><rect x="20" y="20" width="40" height="40" fill="blue" mask="url(#b)"/>`),
    );
    assert.deepEqual(warnings(diags), []);
    const [g1, g2] = groups(d.ops);
    assert.equal(g1.mask!.luminance, true);
    assert.deepEqual((g1.mask!.ops.find((o) => o.op === "path") as PathOp).fill, [1, 1, 1]);
    assert.equal(g2.mask!.luminance, false, "mask-type: alpha");
    // Content in bounding-box units: half the 40-unit box is 20 units (15 pt) wide.
    const mp = paths({ ...d, ops: g2.mask!.ops })[0];
    const b = bbox(mp.d);
    close(b.x1 - b.x0, 15);
  });

  it("draws mix-blend-mode as a group's blend mode", () => {
    const { d } = convert(fig(`<rect width="50" height="50" fill="red"/><circle cx="50" cy="50" r="20" fill="blue" style="mix-blend-mode: multiply"/>`));
    const [g] = groups(d.ops);
    assert.equal(g.blend, "multiply");
  });

  it("draws filters into an image with alpha over the filter region", () => {
    const { d, diags } = convert(fig(`<defs><filter id="f"><feGaussianBlur stdDeviation="3"/></filter></defs><rect x="20" y="20" width="40" height="40" fill="green" filter="url(#f)"/>`));
    assert.deepEqual(warnings(diags), []);
    const [im] = images(d.ops);
    assert.ok(im && isEmbeddedImage(im.image), "an embedded PNG");
    assert.equal(paths(d).length, 0, "the shape is in the image");
    // The region: the box grown by 10% each way, 48 x 48 units from (16, 16).
    closePt([im.x, im.y], pt(16, 64), 0.01);
    close(im.width, 36, 0.01);
    const png = im.image as ReturnType<typeof Object>;
    assert.ok((png as { pixelWidth: number }).pixelWidth >= 100, "drawn finer than the page");
  });

  it("keeps an element as vectors over its drop shadow, and reads CSS filter functions", () => {
    const { d, diags } = convert(
      fig(`<defs><filter id="s"><feDropShadow dx="2" dy="2" stdDeviation="2"/></filter></defs>
<rect x="10" y="10" width="40" height="20" fill="gold" filter="url(#s)"/><text x="10" y="80" style="filter: blur(2px)">Hi</text>`),
    );
    assert.deepEqual(warnings(diags), []);
    const kinds = d.ops.map((o) => o.op);
    assert.equal(kinds[0], "image", "the shadow first");
    assert.equal(kinds[1], "path", "then the shape itself");
    assert.equal(images(d.ops).length, 2, "blur() draws the text into an image");
    assert.equal(runs(d).length, 0);
  });

  it("warns about missing filters and primitives it passes through", () => {
    const { d, diags } = convert(fig(`<defs><filter id="t"><feTurbulence baseFrequency="0.05"/></filter></defs><rect width="10" height="10" filter="url(#nope)"/><rect width="10" height="10" filter="url(#t)"/>`));
    const msgs = warnings(diags).map((w) => w.message);
    assert.ok(msgs.some((m) => /#nope/.test(m)));
    assert.ok(msgs.some((m) => /feTurbulence/.test(m)));
    assert.equal(paths(d).length, 1, "the element with a missing filter is drawn as it is");
  });

  it("lays text along a path, turning each glyph with it", () => {
    const { d, diags } = convert(
      fig(`<defs><path id="p" d="M10 50 L60 50 L60 0"/></defs><text font-size="10"><textPath href="#p">abcdefghijklmnopqrstuvwxyzabcdefghijklmnop</textPath></text>`),
    );
    assert.deepEqual(warnings(diags), []);
    const transforms = d.ops.filter((o): o is Extract<DrawOp, { op: "transform" }> => o.op === "transform");
    const glyphs = d.ops.filter((o) => o.op === "glyphs");
    assert.ok(glyphs.length > 10 && glyphs.length < 42, `glyphs past the end are dropped (${glyphs.length})`);
    // Along the first leg the glyphs are upright (placed directly); up the second they are turned a quarter turn.
    const angles = transforms.map((t) => Math.round((Math.atan2(t.m[1], t.m[0]) * 180) / Math.PI));
    assert.ok(angles.length > 0 && angles.every((a) => a === 90), angles.join(","));
    assert.ok(glyphs.length > angles.length, "upright glyphs on the level leg");
  });

  it("lays out HTML labels in foreignObject: wrapped, centred, with inline styles", () => {
    const { d, diags } = convert(
      fig(
        `<foreignObject x="0" y="0" width="100" height="60"><div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: center; justify-content: center; width: 100px; height: 60px; text-align: center; font-family: sans-serif; font-size: 10px; color: #ff0000">One <b>two</b><br/>three</div></foreignObject>`,
      ),
    );
    assert.deepEqual(warnings(diags), []);
    const rs = runs(d);
    assert.deepEqual(rs.map((r) => r.run.text.join("")), ["One", "two", "three"]);
    assert.deepEqual(rs[0].run.color, [1, 0, 0]);
    assert.ok(rs[1].run.font.bold, "<b> is bold");
    assert.ok(rs[2].y < rs[0].y, "three is on the second line");
    // Centred in the 100-unit (75 pt) box.
    const mid = rs[2].x + rs[2].run.width / 2;
    close(mid, 37.5, 0.5);
  });

  it("matches attribute selectors, structural pseudo-classes, sibling combinators and :not()", () => {
    const { d } = convert(
      fig(`<style>rect[data-k="a"] { fill: red } g > rect:first-child { stroke: blue } rect + circle { fill: green } circle ~ ellipse:not(.x) { fill: purple }</style>
<g><rect width="1" height="1" data-k="a"/><rect width="1" height="1"/><circle r="1"/><ellipse rx="1" ry="1"/><ellipse class="x" rx="1" ry="1"/></g>`),
    );
    const ps = paths(d);
    assert.deepEqual(ps[0].fill, [1, 0, 0]);
    assert.deepEqual(ps[0].stroke, [0, 0, 1]);
    assert.equal(ps[1].stroke, undefined);
    assert.deepEqual(ps[2].fill, [0, 0.502, 0]);
    assert.deepEqual(ps[3].fill, [0.502, 0, 0.502]);
    assert.deepEqual(ps[4].fill, [0, 0, 0]);
  });

  it("strokes text along its outlines, fills it with gradients, underlines it and clips with it", () => {
    const { d } = convert(
      fig(`<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><clipPath id="c"><text x="0" y="50" font-size="40">C</text></clipPath></defs>
<text x="0" y="20" stroke="black" stroke-width="1" paint-order="stroke">A</text><text x="30" y="20" fill="url(#g)">B</text>
<text x="60" y="20" text-decoration="underline">u</text><rect width="100" height="100" clip-path="url(#c)"/>`),
    );
    const ps = paths(d);
    const strokeIdx = d.ops.findIndex((o) => o.op === "path" && !!o.stroke && !o.fill);
    const glyphIdx = d.ops.findIndex((o) => o.op === "glyphs");
    assert.ok(strokeIdx >= 0 && strokeIdx < glyphIdx, "paint-order: the outline stroke first, then the glyphs");
    assert.ok(ps.some((p) => p.fill && !Array.isArray(p.fill)), "gradient text is filled outlines");
    const glyphRuns = runs(d).map((r) => r.run.text.join(""));
    assert.deepEqual(glyphRuns, ["A", "u"]);
    const underline = ps.find((p) => p.fill && Array.isArray(p.fill) && p.d.length === 5 && bbox(p.d).y1 - bbox(p.d).y0 < 1.5);
    assert.ok(underline, "an underline under u");
    assert.ok(d.ops.some((o) => o.op === "clip" && o.d.length > 5), "a clip from the glyph outline of C");
  });

  it("keeps hostile filters and nesting within budget", () => {
    const many = Array.from({ length: 400 }, (_, i) => `<rect x="${i % 20}" y="${Math.floor(i / 20)}" width="80" height="80" filter="url(#b)"/>`).join("");
    const nested = `${'<g opacity="0.9">'.repeat(40)}<rect width="10" height="10"/>${"</g>".repeat(40)}`;
    const { value, ms } = timed(() =>
      convert(
        fig(
          `<defs><filter id="b" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="50"/></filter><filter id="m"><feMorphology operator="dilate" radius="100000"/></filter></defs>${many}${nested}<rect width="90" height="90" filter="url(#m)"/>`,
          'width="1000" height="1000"',
        ),
      ),
    );
    const msgs = warnings(value.diags).map((w) => w.message);
    assert.ok(msgs.some((m) => /million pixels/.test(m)), msgs.join(" | "));
    assert.ok(msgs.some((m) => /nest more than/.test(m)));
    assert.ok(ms < 20000, `took ${ms} ms`);
  });

  it("shifts sub and super by half the font's height, and keeps image-rendering", () => {
    const { d } = convert(fig(`<text x="0" y="50" font-size="20">x<tspan baseline-shift="super">2</tspan><tspan baseline-shift="sub">3</tspan></text>
<image width="10" height="10" style="image-rendering: pixelated" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg=="/>`));
    const rs = runs(d);
    const f = rs[1].run.font;
    const half = (((f.ascent - f.descent) / f.unitsPerEm) * 20 * 0.75) / 2;
    close(rs[1].y - rs[0].y, half, 0.01);
    close(rs[0].y - rs[2].y, half, 0.01);
    assert.equal(images(d.ops)[0].pixelated, true);
  });
});

describe("svg real figures", () => {
  const cases = [
    { file: "paper/fig-pipeline.svg", width: 582, height: 187.5, paths: 34, runs: 19, markers: 11 },
    { file: "paper/fig-passes.svg", width: 570, height: 127.5, paths: 13, runs: 12, markers: 4 },
    { file: "paper/fig-loop.svg", width: 540, height: 161.25, paths: 16, runs: 11, markers: 5 },
    { file: "examples/showcase/heat.svg", width: 510, height: 270, paths: 16, runs: 20, markers: 0 },
  ];
  for (const c of cases) {
    it(`converts ${c.file}`, () => {
      const src = readFileSync(join(ROOT, c.file), "utf8");
      const { value, ms } = timed(() => convert(src));
      const { d, diags } = value;
      assert.deepEqual(diags.items, [], "no diagnostics");
      assert.ok(ms < 2000, `took ${ms} ms`);
      close(d.width, c.width);
      close(d.height, c.height);
      assert.equal(d.depth, 0);
      const ps = paths(d);
      assert.equal(ps.length, c.paths);
      const rs = runs(d);
      assert.equal(rs.length, c.runs);
      // Arrowheads: filled, unstroked triangles.
      const heads = ps.filter((p) => p.fill && !p.stroke && p.d.length === 4 && p.d[3][0] === "Z");
      assert.equal(heads.length, c.markers);
      // Every glyph found in the bundled Computer Modern faces; text searchable.
      for (const r of rs) {
        assert.match(r.run.font.postscriptName, /^KaTeX_Main-/);
        assert.ok(r.run.gids.every((g) => g > 0));
        assert.equal(r.run.text.length, r.run.gids.length);
      }
      // Everything visible lies inside the figure.
      const b = opsBounds(d.ops, undefined, { clips: true });
      assert.ok(b);
      assert.ok(b.x0 >= -0.01 && b.y0 >= -0.01 && b.x1 <= d.width + 0.01 && b.y1 <= d.height + 0.01, JSON.stringify(b));
      // Balanced save/restore.
      let depth = 0;
      for (const op of d.ops) {
        if (op.op === "save") depth++;
        if (op.op === "restore") depth--;
        assert.ok(depth >= 0);
      }
      assert.equal(depth, 0);
    });
  }

  it("places the pipeline's labels and arrowheads where the SVG puts them", () => {
    const src = readFileSync(join(ROOT, "paper/fig-pipeline.svg"), "utf8");
    const { d } = convert(src);
    const label = runs(d).find((r) => r.run.text.join("") === "Markdown");
    assert.ok(label);
    // x=70 middle-anchored, y=38 in a 250-high viewBox.
    close(label.x + label.run.width / 2, 70 * 0.75);
    close(label.y, (250 - 38) * 0.75);
    assert.equal(label.run.size, 9.75);
    // The first arrow ends at (175,108); its head points along (45,66).
    const heads = paths(d).filter((p) => p.fill && !p.stroke && p.d.length === 4);
    const pts = points(heads[0].d);
    const base = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2];
    const len = Math.hypot(45, 66);
    const dir = [(pts[1][0] - base[0]) / Math.hypot(pts[1][0] - base[0], pts[1][1] - base[1]), (pts[1][1] - base[1]) / Math.hypot(pts[1][0] - base[0], pts[1][1] - base[1])];
    closePt(dir, [45 / len, -66 / len]);
    closePt(pts[1], [(175 + (45 / len) * 0.98) * 0.75, (250 - 108 - (66 / len) * 0.98) * 0.75]);
    // Dashed connectors.
    assert.equal(paths(d).filter((p) => p.dash).length, 4);
    assert.deepEqual(paths(d).find((p) => p.dash)?.dash, [3, 2.25]);
  });
});

// ---------------------------------------------------------------------------
// Hostile input

describe("svg hostile input", () => {
  it("cuts huge path data short with a diagnostic", () => {
    const svg = fig(`<path stroke="black" d="M0 0${" L1 1".repeat(SVG_LIMITS.pathCommands + 200_000)}"/>`);
    const { value, ms } = timed(() => convert(svg));
    assert.ok(ms < 5000, `took ${ms} ms`);
    assert.ok(paths(value.d)[0].d.length <= SVG_LIMITS.pathCommands + 1);
    assert.match(warnings(value.diags)[0].message, /too complex/);
  });

  it("refuses deep nesting quickly", () => {
    const svg = fig("<g>".repeat(100_000) + "</g>".repeat(100_000));
    const { value, ms } = timed(() => convert(svg));
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.equal(value.d.ops.length, 0);
    assert.match(errors(value.diags)[0].message, /nested more than/);
  });

  it("refuses a million-element file quickly", () => {
    const svg = fig('<rect width="1" height="1"/>'.repeat(1_000_000));
    const { value, ms } = timed(() => convert(svg));
    assert.ok(ms < 5000, `took ${ms} ms`);
    assert.equal(value.d.ops.length, 0);
    assert.match(errors(value.diags)[0].message, /more than 250000 elements/);
  });

  it("ignores entity bombs", () => {
    let defs = '<!ENTITY a0 "dha">';
    for (let i = 1; i < 30; i++) defs += `<!ENTITY a${i} "${`&a${i - 1};`.repeat(10)}">`;
    const svg = `<!DOCTYPE svg [${defs}]>` + fig(`<text>&a29;</text><rect width="1" height="1"/>`);
    const { value, ms } = timed(() => convert(svg));
    assert.ok(ms < 1000, `took ${ms} ms`);
    assert.equal(paths(value.d).length, 1);
    assert.match(warnings(value.diags)[0].message, /&a29;/);
  });

  it("bounds exponential <use> fan-out", () => {
    let defs = `<g id="u0"><rect width="1" height="1"/></g>`;
    for (let i = 1; i <= 9; i++) defs += `<g id="u${i}">${`<use href="#u${i - 1}"/>`.repeat(10)}</g>`;
    const svg = fig(`<defs>${defs}</defs><use href="#u9"/>`);
    const { value, ms } = timed(() => convert(svg));
    assert.ok(ms < 10_000, `took ${ms} ms`);
    assert.match(warnings(value.diags)[0].message, /too complex/);
  });

  it("stays linear on pathological text and markup", () => {
    const inputs = [
      fig(`<text>${"&".repeat(2_000_000)}</text>`),
      fig(`<text>${"&amp".repeat(500_000)}</text>`),
      fig(`<text>${"x ".repeat(400_000)}</text>`),
      `<svg>${"<!--".repeat(500_000)}`,
      fig(`<path d="${"M".repeat(2_000_000)}"/>`),
      fig(`<polyline points="${"1,".repeat(1_000_000)}"/>`),
      fig(`<style>${"a ".repeat(200_000)}{fill:red}</style><rect width="1" height="1"/>`),
      fig(`<rect width="1" height="1" transform="${"translate(1) ".repeat(200_000)}"/>`),
    ];
    for (const s of inputs) {
      const { ms } = timed(() => convert(s));
      assert.ok(ms < 5000, `took ${ms} ms on ${s.slice(0, 60)}`);
    }
  });

  it("never throws on random soup", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const atoms = ["<svg>", "</svg>", "<g>", "</g>", '<rect width="5" height="5"/>', '<path d="M0 0L', "1 1", 'A5 5 0 1 1', "<text>", "</text>", "&amp;", "&#x", '<use href="#a"/>', '<g id="a">', 'clip-path="url(#a)"', '"', "<", ">", "<![CDATA[", "]]>", '<marker id="m">', 'marker-end="url(#m)"', "<tspan dx='1 2'>", "<style>*{fill:red}</style>"];
    for (let i = 0; i < 300; i++) {
      let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';
      const n = Math.floor(rnd() * 40);
      for (let k = 0; k < n; k++) s += atoms[Math.floor(rnd() * atoms.length)];
      if (rnd() < 0.7) s += "</svg>";
      const { d } = convert(s);
      assert.equal(d.t, "drawing");
    }
  });
});
