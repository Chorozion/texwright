/**
 * Microtypography: character protrusion and font expansion in justified
 * paragraphs (src/layout/microtype.ts), drawn with PDF's Tz and by the
 * preview rasterizer, and switched by front matter or LaTeX's microtype options.
 */

import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { describe, test } from "node:test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { bundledFont } from "../src/font/index.js";
import { type ConvertOptions, check, convert, preview } from "../src/index.js";
import {
  type Glyphs,
  type HBox,
  type HNode,
  type LineBreakResult,
  breakParagraph,
  expandGlyphs,
  lineExpansion,
  loadHyphenator,
  microtypeSettings,
  parseMicrotype,
  protrusionFactors,
  shapeText,
} from "../src/layout/index.js";
import { createPdfWriter } from "../src/pdf/writer.js";

const roman = bundledFont("LMRoman", "Regular");
const bold = bundledFont("LMRoman", "Bold");
const hyph = loadHyphenator("en-us", { leftMin: 2, rightMin: 3 });

const TEXT =
  "The church was Methodist, which meant plain glass and plain benches, and the stone remained, and the steps. " +
  "She climbed the four front steps and stood where the doors had been. Inside there was nothing. A floor of mud, " +
  "a few charred joists, and light coming in through the window frames in long bars. “You got married here,” Theo said. " +
  "She considered the question for a while, then said it had been hot, and that the organist played too slowly, " +
  "and that her sister cried so hard during the vows that the minister had to stop. Down the side street toward the river " +
  "there was a rectangle of foundation stones where the Grange hall had stood, and a dog that used to lie in the road.";

function para(text = TEXT, font = roman): HNode[] {
  return [{ t: "hbox", width: 15, height: 0, depth: 0, children: [] }, ...shapeText(text, { fonts: [font], size: 10 })];
}

function lines(res: LineBreakResult): HBox[] {
  return res.lines;
}

function marginKerns(box: HBox): number[] {
  return box.children.filter((c) => c.t === "kern" && c.subtype === "margin").map((c) => (c as { width: number }).width);
}

const MT = { protrusion: true, expansion: true };
const opts = (microtype?: typeof MT | false) => ({ lineWidth: 300, hyphenate: hyph, emergencyStretch: 20, microtype });

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isOffscreenCanvasSupported: false, useSystemFonts: false }).promise;
}

async function allText(bytes: Uint8Array): Promise<string> {
  const doc = await openPdf(bytes);
  let out = "";
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    out += content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "")).join("");
  }
  return out;
}

/** Decompressed content streams of a PDF, joined. */
function contentStreams(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const end = s.indexOf("endstream", m.index);
    const raw = Buffer.from(s.slice(m.index + m[0].length, end), "latin1");
    try {
      out += inflateSync(raw).toString("latin1") + "\n";
    } catch {
      // not a Flate stream (images, fonts in other encodings)
    }
  }
  return out;
}

/** Metadata switching microtype off (stored with the other layout keys). */
const OFF = { microtype: false } as unknown as ConvertOptions["meta"];

const LONG = Array.from({ length: 14 }, () => TEXT).join("\n\n");

describe("microtype: protrusion", () => {
  test("microtype's default factors", () => {
    assert.deepEqual(protrusionFactors("."), [0, 700]);
    assert.deepEqual(protrusionFactors(","), [0, 500]);
    assert.deepEqual(protrusionFactors("-"), [400, 500]);
    assert.deepEqual(protrusionFactors("\u201c"), [500, 0]);
    assert.deepEqual(protrusionFactors("\u2019"), [0, 700]);
    assert.deepEqual(protrusionFactors("T"), [50, 50]);
    assert.deepEqual(protrusionFactors("a"), [0, 0]);
  });

  test("margin kerns sit only at the ends of lines, sized by the character", () => {
    const res = breakParagraph(para(), opts(MT));
    let hung = 0;
    res.lines.forEach((box, j) => {
      const kids = box.children;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i]!;
        if (c.t !== "kern" || c.subtype !== "margin") continue;
        // Only glue (the skips) may come between a margin kern and the line's end.
        const before = kids.slice(0, i).every((x) => x.t !== "glyphs");
        const after = kids.slice(i + 1).every((x) => x.t !== "glyphs");
        assert.ok(before || after, `margin kern inside line ${j}`);
        assert.ok(c.width < 0);
        hung++;
      }
      const [lp, rp] = res.info[j]!.protrusion!;
      const ks = marginKerns(box);
      assert.equal(ks.length, (lp ? 1 : 0) + (rp ? 1 : 0));
    });
    assert.ok(hung > 0, "some line ends with punctuation");
    // A line ending in a period hangs 0.7 of the period's width.
    const dot = (roman.advance(roman.glyphForCodePoint(0x2e)!) * 10) / roman.unitsPerEm;
    const endsWithDot = res.lines.findIndex((b, j) => j < res.lines.length - 1 && /\.$/.test(lastText(b)));
    if (endsWithDot >= 0) assert.ok(Math.abs(res.info[endsWithDot]!.protrusion![1] - 0.7 * dot) < 1e-9);
    // The first line starts with the paragraph indent: nothing hangs on its left; the last line ends with \parfillskip.
    assert.equal(res.info[0]!.protrusion![0], 0);
    assert.equal(res.info[res.info.length - 1]!.protrusion![1], 0);
  });

  test("a hyphen at a line break hangs half its width", () => {
    const res = breakParagraph(para(), { ...opts(MT), lineWidth: 140 });
    const j = res.info.findIndex((l) => l.hyphenated);
    assert.ok(j >= 0, "some line is hyphenated");
    const hy = (roman.advance(roman.glyphForCodePoint(0x2d)!) * 10) / roman.unitsPerEm;
    assert.ok(Math.abs(res.info[j]!.protrusion![1] - 0.5 * hy) < 1e-9);
  });

  test("ragged, centred and bold text is left alone", () => {
    const ragged = breakParagraph(para(), { ...opts(MT), raggedRight: true });
    assert.ok(ragged.lines.every((b) => marginKerns(b).length === 0 && b.children.every((c) => c.t !== "glyphs" || !c.hscale)));
    assert.equal(ragged.info[0]!.protrusion, undefined);
    const centred = breakParagraph(para(), {
      ...opts(MT),
      leftSkip: { t: "glue", width: 0, stretch: 1, stretchOrder: 1, shrink: 0, shrinkOrder: 0 },
      rightSkip: { t: "glue", width: 0, stretch: 1, stretchOrder: 1, shrink: 0, shrinkOrder: 0 },
    });
    assert.ok(centred.lines.every((b) => marginKerns(b).length === 0));
    const heavy = breakParagraph(para(TEXT, bold), opts(MT));
    assert.ok(heavy.lines.every((b) => marginKerns(b).length === 0 && b.children.every((c) => c.t !== "glyphs" || !c.hscale)));
  });
});

function lastText(box: HBox): string {
  for (let i = box.children.length - 1; i >= 0; i--) {
    const c = box.children[i]!;
    if (c.t === "glyphs") return c.text.join("");
  }
  return "";
}

describe("microtype: expansion", () => {
  test("expansion stays within 2% in whole steps, the same for the whole line", () => {
    const res = breakParagraph(para(LONG), opts(MT));
    let expanded = 0;
    res.lines.forEach((box, j) => {
      const e = res.info[j]!.expansion!;
      assert.ok(Number.isInteger(e) && e >= -20 && e <= 20, `line ${j}: ${e}`);
      if (e) expanded++;
      for (const c of box.children) {
        if (c.t !== "glyphs") continue;
        assert.ok(Math.abs((c.hscale ?? 1) - (1 + e / 1000)) < 1e-12, `line ${j}`);
      }
    });
    assert.ok(expanded > res.lines.length / 2, `${expanded} of ${res.lines.length} lines expanded`);
    // The last line ends with infinite glue and is never expanded.
    assert.equal(res.info[res.info.length - 1]!.expansion, 0);
  });

  test("lineExpansion absorbs what the glyphs can, rounded to steps", () => {
    const m = microtypeSettings({ stretch: 20, shrink: 20, step: 1 })!;
    assert.equal(lineExpansion(1, 1000, m), 1); // 1pt over 1000pt of glyphs: 0.1%
    assert.equal(lineExpansion(100, 1000, m), 20); // more than they can: the limit
    assert.equal(lineExpansion(-100, 1000, m), -20);
    assert.equal(lineExpansion(0, 1000, m), 0);
    const coarse = microtypeSettings({ stretch: 20, shrink: 20, step: 5 })!;
    assert.equal(lineExpansion(8, 1000, coarse), 10);
    const run = shapeText("abc", { fonts: [roman], size: 10 })[0] as Glyphs;
    const wide = expandGlyphs(run, 20);
    assert.ok(Math.abs(wide.width - run.width * 1.02) < 1e-9);
    assert.equal(wide.hscale, 1.02);
    assert.deepEqual(wide.gids, run.gids);
  });

  test("lines are evener with microtype, and the result is deterministic", () => {
    const spaces = (res: LineBreakResult) =>
      res.lines.slice(0, -1).map((b) => {
        const set = b.glueSet;
        return !set ? 0 : set.sign === "stretch" ? set.ratio : set.sign === "shrink" ? -set.ratio : 0;
      });
    const off = breakParagraph(para(LONG), opts());
    const on = breakParagraph(para(LONG), opts(MT));
    const spread = (v: number[]) => Math.max(...v.map(Math.abs));
    assert.ok(spread(spaces(on)) <= spread(spaces(off)), `${spread(spaces(on))} vs ${spread(spaces(off))}`);
    const again = breakParagraph(para(LONG), opts(MT));
    assert.deepEqual(again.breaks, on.breaks);
    assert.deepEqual(
      again.info.map((l) => [l.expansion, l.protrusion]),
      on.info.map((l) => [l.expansion, l.protrusion]),
    );
    assert.ok(on.info.filter((l) => l.hyphenated).length <= off.info.filter((l) => l.hyphenated).length);
  });

  test("microtype off breaks exactly as before", () => {
    const plain = breakParagraph(para(LONG), { lineWidth: 300, hyphenate: hyph, emergencyStretch: 20 });
    const off = breakParagraph(para(LONG), opts(false));
    assert.deepEqual(off.breaks, plain.breaks);
    assert.deepEqual(lines(off).map((b) => b.glueSet), lines(plain).map((b) => b.glueSet));
    assert.equal(off.info[0]!.expansion, undefined);
  });
});

describe("microtype: settings", () => {
  test("front matter and LaTeX option forms", () => {
    assert.equal(parseMicrotype(false, undefined), false);
    assert.deepEqual(parseMicrotype(true, undefined), { protrusion: true, expansion: true });
    assert.deepEqual(parseMicrotype({ expansion: false }, undefined), { protrusion: true, expansion: false });
    assert.deepEqual(parseMicrotype("protrusion=false, expansion=true", undefined), { protrusion: false, expansion: true });
    assert.deepEqual(parseMicrotype("protrusion=true,expansion,stretch=10,shrink=10,step=2", undefined), {
      protrusion: true,
      expansion: true,
      stretch: 10,
      shrink: 10,
      step: 2,
    });
    assert.equal(parseMicrotype("disable", undefined), false);
    assert.equal(parseMicrotype("protrusion=maybe", undefined), undefined);
    assert.equal(microtypeSettings({ protrusion: false, expansion: false }), undefined);
    assert.equal(microtypeSettings({ stretch: 500 })!.stretch, 100);
  });

  test("the front-matter key is known and bad values are OPT001", () => {
    const ok = check({ source: "---\nmicrotype: false\n---\n\nText.\n" });
    assert.ok(!ok.diagnostics.some((d) => d.code === "OPT002" || d.code === "OPT001"), JSON.stringify(ok.diagnostics));
    const bad = check({ source: "---\nmicrotype: sometimes\n---\n\nText.\n" });
    assert.ok(bad.diagnostics.some((d) => d.code === "OPT001"), JSON.stringify(bad.diagnostics));
  });

  test("LaTeX's \\usepackage[...]{microtype} and \\microtypesetup are read, not reported", async () => {
    const tex = (pre: string) => `\\documentclass{article}\n${pre}\n\\begin{document}\n${LONG.replace(/[“”’]/g, '"')}\n\\end{document}\n`;
    const on = await convert({ source: tex("\\usepackage{microtype}"), from: "latex", to: "pdf" });
    const off = await convert({ source: tex("\\usepackage[protrusion=true]{microtype}\n\\microtypesetup{protrusion=false,expansion=false}\n\\SetProtrusion{encoding=T1}{A={50,50}}"), from: "latex", to: "pdf" });
    for (const r of [on, off]) assert.ok(!r.diagnostics.some((d) => d.severity !== "info"), JSON.stringify(r.diagnostics));
    assert.match(contentStreams(on.data as Uint8Array), / Tz\n/);
    assert.doesNotMatch(contentStreams(off.data as Uint8Array), / Tz\n/);
    const disabled = await convert({ source: tex("\\usepackage[disable]{microtype}"), from: "latex", to: "pdf" });
    assert.doesNotMatch(contentStreams(disabled.data as Uint8Array), / Tz\n/);
  });
});

describe("microtype: output", () => {
  test("Tz is set for expanded runs and reset before unscaled text and forms", () => {
    const w = createPdfWriter({ compress: false });
    const page = w.addPage(200, 200);
    const run = shapeText("word", { fonts: [roman], size: 10 })[0] as Glyphs;
    const wide = expandGlyphs(run, 13);
    page.glyphs(roman, 10, 10, 100, wide.gids, wide.advances, wide.text, undefined, undefined, undefined, wide.hscale);
    page.glyphs(roman, 10, 10, 80, run.gids, run.advances, run.text);
    page.glyphs(roman, 10, 10, 60, wide.gids, wide.advances, wide.text, undefined, undefined, undefined, wide.hscale);
    page.group({ bbox: [0, 0, 50, 50], opacity: 0.5 }, () => page.glyphs(roman, 10, 0, 0, run.gids, run.advances, run.text));
    const s = Buffer.from(w.finish()).toString("latin1");
    const ops = s.match(/[\d.]+ Tz/g) ?? [];
    assert.deepEqual(ops, ["101.3 Tz", "100 Tz", "101.3 Tz", "100 Tz"]);
    // The reset comes before the form is painted.
    assert.ok(s.indexOf("100 Tz", s.lastIndexOf("101.3 Tz")) < s.indexOf(" Do Q"));
  });

  test("a document reads back as the same text with or without microtype", async () => {
    const md = `---\ntitle: Low water\n---\n\n${LONG}\n`;
    const on = await convert({ source: md, to: "pdf" });
    const off = await convert({ source: md, to: "pdf", meta: OFF });
    assert.ok(on.ok && off.ok);
    // Page numbers fall between different words when the pages break differently.
    const norm = (t: string) => t.replace(/[\s\u00ad\d-]+/g, "");
    const a = await allText(on.data as Uint8Array);
    const b = await allText(off.data as Uint8Array);
    assert.equal(norm(a), norm(b));
    for (const w of ["Methodist", "foundation", "“You got married here,” Theo said."]) assert.ok(a.replace(/\s+/g, " ").includes(w), w);
    assert.ok((on.stats.pages ?? 0) <= (off.stats.pages ?? 0), `${on.stats.pages} pages vs ${off.stats.pages}`);
    assert.match(contentStreams(on.data as Uint8Array), /\d+(\.\d+)? Tz\n/);
    assert.doesNotMatch(contentStreams(off.data as Uint8Array), / Tz\n/);
  });

  test("microtype: false gives the same bytes as a theme without it", async () => {
    const saved = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = "1767225600";
    try {
      const a = await convert({ source: `---\nmicrotype: false\n---\n\n${LONG}\n`, to: "pdf" });
      const b = await convert({ source: `---\nmicrotype: {protrusion: false, expansion: false}\n---\n\n${LONG}\n`, to: "pdf" });
      const c = await convert({ source: `${LONG}\n`, to: "pdf", meta: OFF });
      assert.deepEqual(Buffer.from(a.data as Uint8Array), Buffer.from(b.data as Uint8Array));
      assert.deepEqual(Buffer.from(a.data as Uint8Array), Buffer.from(c.data as Uint8Array));
    } finally {
      if (saved === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = saved;
    }
  });

  test("the preview draws expanded lines", () => {
    const on = preview({ source: LONG, pages: [1], dpi: 72 });
    const off = preview({ source: LONG, pages: [1], dpi: 72, meta: OFF });
    assert.ok(on.ok && off.ok);
    assert.notDeepEqual(Buffer.from(on.pages[0]!.png), Buffer.from(off.pages[0]!.png));
  });
});
