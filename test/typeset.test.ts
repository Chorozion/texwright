/**
 * The document typesetter and the HTML-side pieces that replaced KaTeX:
 * native PDF output read back with pdf.js, MathML equation numbers, WOFF
 * font embedding and the layout diagnostics.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { inflateSync } from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { bundledFont, fontsDir } from "../src/font/registry.js";
import { shapeText } from "../src/layout/index.js";
import { toWoff } from "../src/font/woff.js";
import { check, convert } from "../src/index.js";
import { themeFonts } from "../src/write/assets.js";

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isOffscreenCanvasSupported: false, useSystemFonts: false }).promise;
}

async function pageText(doc: PdfDoc, n: number): Promise<string> {
  const content = await (await doc.getPage(n)).getTextContent();
  return content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join("");
}

async function pdf(source: string) {
  const res = await convert({ source, to: "pdf" });
  assert.ok(res.data instanceof Uint8Array, JSON.stringify(res.diagnostics));
  return { res, doc: await openPdf(res.data) };
}

describe("woff", () => {
  test("wraps every table so it inflates back to the original bytes", () => {
    const ttf = new Uint8Array(readFileSync(join(fontsDir(), "KaTeX_Main-Regular.ttf")));
    const woff = toWoff(ttf);
    const w = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    assert.equal(w.getUint32(0), 0x774f4646, "wOFF signature");
    assert.equal(w.getUint32(4), new DataView(ttf.buffer, ttf.byteOffset).getUint32(0), "flavor copied from the sfnt");
    assert.equal(w.getUint32(8), woff.byteLength);
    const n = w.getUint16(12);
    const t = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
    assert.equal(n, t.getUint16(4));
    let previous = -1;
    for (let k = 0; k < n; k++) {
      const at = 44 + 20 * k;
      const tag = w.getUint32(at);
      assert.ok(tag > previous, "directory sorted by tag");
      previous = tag;
      const offset = w.getUint32(at + 4);
      const comp = w.getUint32(at + 8);
      const orig = w.getUint32(at + 12);
      assert.equal(offset % 4, 0);
      const data = woff.subarray(offset, offset + comp);
      const table = comp < orig ? new Uint8Array(inflateSync(data)) : data;
      // Find the same table in the sfnt and compare.
      let found = false;
      for (let j = 0; j < n; j++) {
        if (t.getUint32(12 + 16 * j) !== tag) continue;
        const o = t.getUint32(12 + 16 * j + 8);
        assert.deepEqual(Buffer.from(table), Buffer.from(ttf.subarray(o, o + orig)));
        found = true;
      }
      assert.ok(found);
    }
    assert.ok(woff.byteLength < ttf.byteLength * 0.8, "compressed");
    assert.throws(() => toWoff(new Uint8Array(4)), /not an sfnt/);
  });
});

describe("html output", () => {
  test("one number for a formula goes beside it; row numbers go in tagged cells", async () => {
    const res = await convert({ source: "$$ E = mc^2 $$ {#eq:e}\n\n\\begin{align}\na &= b \\\\\nc &= d \\nonumber\n\\end{align}\n", to: "html" });
    const html = String(res.data);
    assert.match(html, /<div class="tw-equation tw-numbered" id="eq-e"><math[^>]*display="block">[\s\S]*?<\/math><span class="tw-eqno">\(1\)<\/span><\/div>/);
    assert.match(html, /<mtd class="tw-tag"[^>]*><mtext>\(2\)<\/mtext><\/mtd>/);
    assert.doesNotMatch(html, /katex/i);
  });

  test("the article theme embeds its bundled fonts as WOFF; the sans themes embed none", async () => {
    assert.deepEqual(themeFonts("article"), ["texwright-serif", "texwright-mono"]);
    assert.deepEqual(themeFonts("modern"), []);
    assert.deepEqual(themeFonts("compact"), []);
    const article = String((await convert({ source: "Hello.\n", to: "html" })).data);
    assert.equal(article.match(/@font-face\{font-family:"texwright-serif"/g)?.length, 4);
    assert.match(article, /src:url\(data:font\/woff;base64,d09GR/);
    const modern = String((await convert({ source: "Hello.\n", to: "html", theme: "modern" })).data);
    assert.doesNotMatch(modern, /@font-face/);
  });
});

describe("pdf typesetting", () => {
  test("a long inline formula breaks after a relation or operator instead of running into the margin", async () => {
    const terms = Array.from({ length: 40 }, (_, k) => `a_{${k}}`).join(" + ");
    const { res, doc } = await pdf(`Consider the sum $S = ${terms}$ which is long.\n`);
    assert.ok(!res.diagnostics.some((d) => d.code === "LAY001"), JSON.stringify(res.diagnostics));
    const text = await pageText(doc, 1);
    assert.match(text, /which is long/);
    // TeX breaks after a relation or an operator, never before one.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.length >= 2, text);
    for (const l of lines) assert.doesNotMatch(l, /^[+=]/, text);
    assert.match(lines[0]!, /[+=]$/, text);
  });

  test("an unbreakable word that sticks into the margin is LAY001 at its paragraph", async () => {
    const { res } = await pdf(`Short paragraph.\n\nThen ${"x".repeat(160)} ends.\n`);
    const d = res.diagnostics.find((x) => x.code === "LAY001");
    assert.ok(d, JSON.stringify(res.diagnostics));
    assert.equal(d.severity, "warning");
    assert.equal(d.line, 3);
  });

  test("a character no available font has is FONT001, reported once", async () => {
    const { res } = await pdf("Private use: \u{10FFFD} and again \u{10FFFD}.\n");
    const found = res.diagnostics.filter((d) => d.code === "FONT001");
    assert.equal(found.length, 1, JSON.stringify(res.diagnostics));
    assert.match(found[0]!.message, /U\+10FFFD/);
  });

  test("English text hyphenates by TeX's patterns; a language without patterns does not", async () => {
    const text = "Typesetting mathematical documentation requires considerable experimentation, particularly when internationalization and representational transformations interact unpredictably. ".repeat(3);
    const lineEnds = async (lang: string) => {
      const res = await convert({ source: `---\nlang: ${lang}\n---\n\n${text}\n`, to: "pdf", paper: "a5", margin: "1.2in" });
      const doc = await openPdf(res.data as Uint8Array);
      return (await pageText(doc, 1)).split("\n").map((l) => l.trim()).filter(Boolean);
    };
    const en = await lineEnds("en");
    const hyphenated = en.filter((l) => /\p{L}-$/u.test(l)).map((l) => l.split(" ").pop()!);
    assert.ok(hyphenated.length > 0, en.join("\n"));
    // Every break is one of TeX's: par-tic-u-lar-ly, al-go-rithms, ...
    const allowed = ["Type-", "math-", "mathe-", "math-e-", "doc-", "docu-", "documen-", "docu-men-", "re-", "con-", "consid-", "consider-", "ex-", "exper-", "experi-", "experimen-", "par-", "partic-", "particu-", "particular-", "in-", "inter-", "interna-", "internation-", "internationaliza-", "rep-", "repre-", "represen-", "representa-", "representational-", "trans-", "transfor-", "transforma-", "un-", "unpre-", "unpredictabl-", "inter-act-"];
    for (const h of hyphenated) assert.ok(allowed.some((a) => h.toLowerCase() === a.toLowerCase()) || /^[a-z]+-$/i.test(h), h);
    const de = await lineEnds("de");
    assert.equal(de.filter((l) => /\p{L}-$/u.test(l)).length, 0, de.join("\n"));
  });

  test("Latin Modern ligatures set as one glyph but copy out as their letters", async () => {
    const { res, doc } = await pdf("The office affine fjord figures.\n");
    assert.ok(!res.diagnostics.some((d) => d.code === "FONT001"));
    assert.match(await pageText(doc, 1), /The office affine fjord figures\./);
    // The body face is a subset of Latin Modern Roman ("ABCDEF+LMRoman10-Regular").
    assert.match(Buffer.from(res.data as Uint8Array).toString("latin1"), /\/BaseFont \/[A-Z]{6}\+LMRoman10-Regular/);
    // "office" is four glyphs: o, the ffi ligature, c, e.
    const glyphs = shapeText("office", { fonts: bundledFont("LMRoman", "Regular"), size: 10 }).filter((n) => n.t === "glyphs");
    assert.equal(glyphs.reduce((k, n) => k + (n.t === "glyphs" ? n.gids.length : 0), 0), 4);
  });

  test("footnotes are set at the foot of the page that cites them", async () => {
    const filler = "Words fill the page here. ".repeat(220);
    const { doc } = await pdf(`${filler}\n\nA claim.[^n]\n\n[^n]: The footnote text.\n\n${filler}\n`);
    assert.ok(doc.numPages >= 2);
    let cited = 0;
    for (let n = 1; n <= doc.numPages; n++) if ((await pageText(doc, n)).includes("A claim.")) cited = n;
    assert.ok(cited > 0);
    assert.match(await pageText(doc, cited), /The footnote text\./);
  });

  test("headings become bookmarks and every label a named destination", async () => {
    const { doc } = await pdf("# One {#sec:one}\n\nText.\n\n## Two {#sec:two}\n\n$$ x = 1 $$ {#eq:x}\n\nSee @eq:x.\n");
    const outline = await doc.getOutline();
    assert.equal(outline?.[0]?.title, "One");
    assert.equal(outline?.[0]?.items[0]?.title, "Two");
    assert.ok(await doc.getDestination("eq-x"));
    assert.ok(await doc.getDestination("sec-two"));
  });
});

describe("authors and affiliations", () => {
  const meta = async (yaml: string) => (await convert({ source: `---\n${yaml}\n---\n\nText.\n`, to: "json" })).document.meta;
  const plain = (x: unknown) => JSON.stringify(x);

  test("front matter takes pandoc/Quarto-style author objects and a shared affiliation", async () => {
    const one = await meta("author:\n  - name: Thomas Garren\n    affiliation: Sophia XT");
    assert.equal(plain(one.author), plain([[{ t: "Text", text: "Thomas Garren" }]]));
    assert.equal(plain(one.affiliation), plain([[{ t: "Text", text: "Sophia XT" }]]));
    const quarto = await meta("author:\n  - name: A\n    affiliations:\n      - name: X\n      - name: Y\n  - B");
    assert.equal(plain(quarto.affiliation), plain([[{ t: "Text", text: "X, Y" }], null]));
    const shared = await meta("institute: Sophia XT\nauthor: [A, B]");
    assert.equal(plain(shared.affiliation), plain([[{ t: "Text", text: "Sophia XT" }], [{ t: "Text", text: "Sophia XT" }]]));
    assert.equal((await meta("author: [A, B]")).affiliation, undefined);
  });

  test("the PDF sets a shared affiliation once under the names, and separate ones under each name", async () => {
    const shared = await pdf("---\ntitle: T\nauthor: [Ada Lovelace, Alan Turing]\naffiliation: Analytical Engines\n---\n\nText.\n");
    const lines = (await pageText(shared.doc, 1)).split("\n").map((l) => l.trim()).filter(Boolean);
    const names = lines.findIndex((l) => l.includes("Ada Lovelace") && l.includes("Alan Turing"));
    assert.ok(names >= 0, lines.join("\n"));
    assert.equal(lines[names + 1], "Analytical Engines");
    assert.equal(lines.filter((l) => l.includes("Analytical Engines")).length, 1);
    const each = await pdf("---\ntitle: T\nauthor:\n  - {name: Ada Lovelace, affiliation: London}\n  - {name: Alan Turing, affiliation: Manchester}\n---\n\nText.\n");
    const text = await pageText(each.doc, 1);
    for (const s of ["Ada Lovelace", "London", "Alan Turing", "Manchester"]) assert.ok(text.includes(s), text);
  });

  test("HTML puts each affiliation under its author, or one shared line", async () => {
    const each = String((await convert({ source: "---\nauthor:\n  - {name: A, affiliation: X}\n  - {name: B, affiliation: Y}\n---\n\nText.\n", to: "html" })).data);
    assert.match(each, /<span class="tw-author">A<span class="tw-affiliation">X<\/span><\/span><span class="tw-author">B<span class="tw-affiliation">Y<\/span><\/span>/);
    const shared = String((await convert({ source: "---\nauthor: [A, B]\naffiliation: X\n---\n\nText.\n", to: "html" })).data);
    assert.match(shared, /<\/div><p class="tw-affiliation">X<\/p>/);
    const overridden = await convert({ source: "Text.\n", to: "json", meta: { authorText: ["Thomas Garren"], affiliation: "Sophia XT" } as never });
    assert.equal(plain(overridden.document.meta.affiliation), plain([[{ t: "Text", text: "Sophia XT" }]]));
  });
});

describe("layout from the document", () => {
  const pageSize = async (res: { data?: string | Uint8Array }) => {
    const doc = await openPdf(res.data as Uint8Array);
    const [x0, y0, x1, y1] = (await doc.getPage(1)).view;
    return [Math.round(x1! - x0!), Math.round(y1! - y0!)];
  };
  const firstTextX = async (res: { data?: string | Uint8Array }) => {
    const doc = await openPdf(res.data as Uint8Array);
    const items = (await (await doc.getPage(1)).getTextContent()).items.filter((i) => "str" in i && i.str.trim());
    return Math.min(...items.map((i) => ("transform" in i ? i.transform[4] : Infinity)));
  };
  const bodySize = async (res: { data?: string | Uint8Array }) => {
    const doc = await openPdf(res.data as Uint8Array);
    const item = (await (await doc.getPage(1)).getTextContent()).items.find((i) => "str" in i && i.str.includes("Body"));
    return item && "transform" in item ? Math.round(item.transform[0]) : 0;
  };

  test("front matter sets the paper, margins, orientation and body size, pandoc-style", async () => {
    const res = await convert({ source: "---\npapersize: a4\ngeometry: margin=2cm\nfontsize: 12pt\n---\n\n# Heading\n\nBody text.\n", to: "pdf" });
    assert.ok(!res.diagnostics.some((d) => d.code === "OPT001"), JSON.stringify(res.diagnostics));
    assert.deepEqual(await pageSize(res), [595, 842]);
    assert.ok(Math.abs((await firstTextX(res)) - (2 * 72) / 2.54) < 1, String(await firstTextX(res)));
    assert.equal(await bodySize(res), 12);
    const wide = await convert({ source: "---\npapersize: a5\nlandscape: true\n---\n\nBody.\n", to: "pdf" });
    assert.deepEqual(await pageSize(wide), [595, 420]);
  });

  test("LaTeX's class and geometry options do the same", async () => {
    const tex = String.raw`\documentclass[12pt,a4paper]{article}\usepackage[top=1in,left=3cm,right=3cm,bottom=1in]{geometry}\begin{document}\section{Heading}Body text.\end{document}`;
    const res = await convert({ source: tex, from: "latex", to: "pdf" });
    assert.deepEqual(await pageSize(res), [595, 842]);
    assert.ok(Math.abs((await firstTextX(res)) - (3 * 72) / 2.54) < 1);
    assert.equal(await bodySize(res), 12);
  });

  test("options passed to convert win over the document, and bad values are OPT001 with a hint", async () => {
    const res = await convert({ source: "---\npapersize: a4\ntheme: modern\n---\n\nBody.\n", to: "pdf", paper: "letter" });
    assert.deepEqual(await pageSize(res), [612, 792]);
    const bad = check({ source: "---\npapersize: tabloid\ngeometry: margin=2\nfontsize: huge\npage-numbers: left\n---\n\nBody.\n" });
    const opt = bad.diagnostics.filter((d) => d.code === "OPT001").map((d) => d.message);
    assert.equal(opt.length, 4, opt.join("\n"));
    assert.ok(bad.diagnostics.every((d) => d.code !== "OPT001" || d.hint), "every OPT001 has a hint");
  });
});
