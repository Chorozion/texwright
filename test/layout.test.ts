import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Font, bundledFont, parseFont } from "../src/font/index.js";
import type { PdfDocumentWriter, PdfInfo, PdfPage } from "../src/pdf/api.js";
import {
  type AnchorInfo,
  type Color,
  type Discretionary,
  type Glue,
  type GlueOrder,
  type Glyphs,
  type HBox,
  type HNode,
  type ImageRef,
  type PathCommand,
  type VBox,
  type VNode,
  Hyphenator,
  INF_BAD,
  VListBuilder,
  badness,
  breakParagraph,
  buildPages,
  collectAnchors,
  firstBaseline,
  glue,
  glueSize,
  hpack,
  hyphenateList,
  interlineGlue,
  interwordGlue,
  kern,
  layoutUntilStable,
  loadHyphenator,
  paragraphPenalties,
  parsePattern,
  penalty,
  shapeText,
  shipout,
  stackVList,
  vpack,
  vsplit,
} from "../src/layout/index.js";

// ---------------------------------------------------------------- helpers

const main = bundledFont("Main");
const ams = bundledFont("AMS");
const S = 10 / main.unitsPerEm; // KaTeX_Main at 10pt: font units -> points

function near(actual: number, expected: number, eps = 1e-6, msg?: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg ? msg + ": " : ""}${actual} is not within ${eps} of ${expected}`);
}

const box = (w: number, h = 0, d = 0, children: HNode[] = []): HBox => ({ t: "hbox", width: w, height: h, depth: d, children });
const g = (w: number, st = 0, sh = 0, so: GlueOrder = 0, sho: GlueOrder = 0): Glue => glue(w, st, sh, so, sho);
const cp = (c: string) => c.codePointAt(0)!;
const gid = (f: Font, c: string) => f.glyphForCodePoint(cp(c));

function words(widths: number[], space: () => Glue): HNode[] {
  const out: HNode[] = [];
  widths.forEach((w, i) => {
    if (i) out.push(space());
    out.push(box(w));
  });
  return out;
}

/** Number of word boxes on each line. */
const wordsPerLine = (lines: HBox[]) => lines.map((l) => l.children.filter((c) => c.t === "hbox").length);

const glyphRuns = (nodes: HNode[]) => nodes.filter((n): n is Glyphs => n.t === "glyphs");
const runText = (nodes: HNode[]) => glyphRuns(nodes).map((r) => r.text.join(""));
const lineText = (l: HBox) =>
  l.children
    .map((c) => (c.t === "glyphs" ? c.text.join("") : c.t === "glue" && c.width > 0 && c.stretchOrder === 0 ? " " : ""))
    .join("")
    .trim();

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Brute force: least total demerits over every way to break a list of boxes (TeX's demerits, no hyphens). */
function bruteForce(widths: number[], L: number, space: Glue, tolerance: number, linePenalty = 10, adj = 10000): number {
  const n = widths.length;
  let best = Infinity;
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const lines: number[][] = [];
    let cur = [widths[0]];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) {
        lines.push(cur);
        cur = [];
      }
      cur.push(widths[i]);
    }
    lines.push(cur);
    let total = 0;
    let prevFit = 1;
    let ok = true;
    lines.forEach((ln, j) => {
      const last = j === lines.length - 1;
      const gaps = ln.length - 1;
      const nat = ln.reduce((a, b) => a + b, 0) + space.width * gaps;
      const short = L - nat;
      let b: number;
      let fit: number;
      if (short > 0) {
        if (last) {
          b = 0;
          fit = 1;
        } else {
          b = badness(short, space.stretch * gaps);
          fit = b > 12 ? (b > 99 ? 3 : 2) : 1;
        }
      } else {
        b = -short > space.shrink * gaps ? INF_BAD + 1 : badness(-short, space.shrink * gaps);
        fit = b > 12 ? 0 : 1;
      }
      if (b > tolerance) ok = false;
      let d = linePenalty + b >= 10000 ? 1e8 : (linePenalty + b) ** 2;
      if (Math.abs(fit - prevFit) > 1) d += adj;
      total += d;
      prevFit = fit;
    });
    if (ok && total < best) best = total;
  }
  return best;
}

// ------------------------------------------------------------ mock writer

type Call = { op: string; [k: string]: unknown };

class MockPage implements PdfPage {
  calls: Call[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  glyphs(font: Font, size: number, x: number, y: number, gids: number[], advances: number[], text: string[], color?: Color, yOffsets?: number[]): void {
    this.calls.push({ op: "glyphs", font, size, x, y, gids, advances, text, color, yOffsets });
  }
  path(d: PathCommand[], style: object): void {
    this.calls.push({ op: "path", d, style });
  }
  rect(x: number, y: number, width: number, height: number, fill: Color): void {
    this.calls.push({ op: "rect", x, y, width, height, fill });
  }
  image(image: ImageRef, x: number, y: number, width: number, height: number): void {
    this.calls.push({ op: "image", image, x, y, width, height });
  }
  group(opts: object, draw: () => void): void {
    this.calls.push({ op: "group", opts });
    draw();
  }
  save(): void {
    this.calls.push({ op: "save" });
  }
  restore(): void {
    this.calls.push({ op: "restore" });
  }
  transform(m: [number, number, number, number, number, number]): void {
    this.calls.push({ op: "transform", m });
  }
  clip(d: PathCommand[], evenOdd?: boolean): void {
    this.calls.push({ op: "clip", d, evenOdd });
  }
  link(x: number, y: number, width: number, height: number, target: { url: string } | { dest: string }): void {
    this.calls.push({ op: "link", x, y, width, height, target });
  }
  destination(name: string, x: number, y: number): void {
    this.calls.push({ op: "destination", name, x, y });
  }
  of(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }
}

class MockWriter implements PdfDocumentWriter {
  pages: MockPage[] = [];
  outlines: { title: string; level: number; dest: string }[] = [];
  addImage(): ImageRef {
    return { id: "img", pixelWidth: 1, pixelHeight: 1 };
  }
  addPage(width: number, height: number): PdfPage {
    const p = new MockPage(width, height);
    this.pages.push(p);
    return p;
  }
  outline(title: string, level: number, dest: string): void {
    this.outlines.push({ title, level, dest });
  }
  setInfo(_info: PdfInfo): void {}
  finish(): Uint8Array {
    return new Uint8Array();
  }
}

// ==================================================================== pack

describe("pack: hpack and vpack", () => {
  const list = (): HNode[] => [box(10, 5, 2), g(5, 3, 1), box(20, 8, 1)];

  it("measures the natural size of a horizontal list", () => {
    const r = hpack(list());
    assert.equal(r.box.width, 35);
    assert.equal(r.box.height, 8);
    assert.equal(r.box.depth, 2);
    assert.equal(r.box.glueSet, undefined);
    assert.equal(r.badness, 0);
    assert.equal(r.natural, 35);
  });

  it("stretches finite glue and reports badness 100 r^3", () => {
    const r = hpack(list(), { width: 41 });
    assert.deepEqual(r.box.glueSet, { ratio: 2, order: 0, sign: "stretch" });
    assert.equal(r.badness, 800);
    assert.equal(r.underfull, false);
    const loose = hpack(list(), { width: 44 });
    assert.equal(loose.badness, 2700);
    assert.equal(loose.underfull, true, "badness above \\hbadness 1000 is underfull");
  });

  it("shrinks, and reports an overfull box with its overflow", () => {
    const r = hpack(list(), { width: 34 });
    assert.deepEqual(r.box.glueSet, { ratio: 1, order: 0, sign: "shrink" });
    assert.equal(r.badness, 100);
    assert.equal(r.overfull, 0);
    const over = hpack(list(), { width: 33 });
    assert.equal(over.overfull, 1);
    assert.equal(over.badness, 1000000);
    assert.deepEqual(over.box.glueSet, { ratio: 1, order: 0, sign: "shrink" });
  });

  it("packs to natural width plus an additional amount", () => {
    const r = hpack(list(), { additional: 4 });
    assert.equal(r.box.width, 39);
    near(r.box.glueSet!.ratio, 4 / 3);
  });

  it("uses only the highest order of infinity present, for each order", () => {
    for (const o of [1, 2, 3] as GlueOrder[]) {
      const st = hpack([box(10), g(0, 2, 0, o), g(5, 1, 0, 0)], { width: 25 });
      assert.deepEqual(st.box.glueSet, { ratio: 5, order: o, sign: "stretch" }, `stretch order ${o}`);
      assert.equal(st.badness, 0);
      // The finite glue keeps its natural width; the infinite glue takes it all.
      assert.equal(glueSize(st.box.children[2] as Glue, st.box.glueSet), 5);
      assert.equal(glueSize(st.box.children[1] as Glue, st.box.glueSet), 10);
      const sh = hpack([box(10), g(0, 0, 2, 0, o), g(5, 0, 1)], { width: 5 });
      assert.deepEqual(sh.box.glueSet, { ratio: 5, order: o, sign: "shrink" }, `shrink order ${o}`);
      assert.equal(sh.overfull, 0);
      assert.equal(glueSize(sh.box.children[1] as Glue, sh.box.glueSet), -10);
    }
    // fil, fill and filll together: filll wins.
    const mixed = hpack([g(0, 1, 0, 1), g(0, 1, 0, 2), g(0, 4, 0, 3)], { width: 8 });
    assert.deepEqual(mixed.box.glueSet, { ratio: 2, order: 3, sign: "stretch" });
  });

  it("takes box heights with shifts, rule heights and leader heights into account", () => {
    const shifted = box(5, 6, 1);
    shifted.shift = 3; // down
    const r = hpack([shifted, { t: "rule", width: 1, height: 9, depth: 0 }, { ...g(4), leader: { t: "rule", height: 2, depth: 5 } }]);
    assert.equal(r.box.height, 9);
    assert.equal(r.box.depth, 5);
    assert.equal(r.box.width, 10);
  });

  it("stacks a vertical list: height to the last baseline, depth of the last box, maxDepth", () => {
    const v = (): VNode[] => [box(50, 8, 2), g(4, 2, 1), box(60, 8, 3)];
    const r = vpack(v());
    assert.equal(r.box.height, 22);
    assert.equal(r.box.depth, 3);
    assert.equal(r.box.width, 60);
    const capped = vpack(v(), { additional: 0 }, { maxDepth: 1 });
    assert.equal(capped.box.height, 24);
    assert.equal(capped.box.depth, 1);
    const tall = vpack(v(), { height: 26 });
    assert.deepEqual(tall.box.glueSet, { ratio: 2, order: 0, sign: "stretch" });
    assert.equal(tall.badness, 800);
    const kerned = vpack([box(10, 8, 2), kern(3), box(10, 8, 2)]);
    assert.equal(kerned.box.height, 21);
    const shifted = box(50, 1, 0);
    shifted.shift = 20;
    assert.equal(vpack([shifted]).box.width, 70);
  });

  it("computes TeX badness", () => {
    assert.equal(badness(0, 0), 0);
    assert.equal(badness(1, 0), 10000);
    assert.equal(badness(1, 1), 100);
    assert.equal(badness(1, 2), 13);
    assert.equal(badness(3, 1), 2700);
    assert.equal(badness(4.6, 1), 9734);
    assert.equal(badness(5, 1), 10000);
    assert.equal(badness(1000, 1), 10000);
  });
});

// ==================================================================== text

describe("text: shaping", () => {
  const style = { fonts: main, size: 10 };
  const space = main.advance(gid(main, " ")) * S;

  it("turns words into Glyphs runs and spaces into TeX interword glue", () => {
    const nodes = shapeText("Hello   world", style);
    assert.deepEqual(
      nodes.map((n) => n.t),
      ["glyphs", "glue", "glyphs"],
    );
    const [hello, sp, world] = nodes as [Glyphs, Glue, Glyphs];
    assert.deepEqual(hello.text, ["H", "e", "l", "l", "o"]);
    assert.equal(hello.font, main);
    near(hello.width, [..."Hello"].reduce((a, c) => a + main.advance(gid(main, c)) * S, 0));
    near(sp.width, space);
    near(sp.stretch, space / 2);
    near(sp.shrink, space / 3);
    assert.ok(hello.height > 6 && hello.height < 7.5, `H is about cap height: ${hello.height}`);
    assert.equal(world.text.join(""), "world");
  });

  it("falls back to a third of an em when the font has no space", () => {
    const gl = interwordGlue({ ...main, glyphForCodePoint: () => 0, advance: main.advance.bind(main), unitsPerEm: 1000 } as Font, 12);
    near(gl.width, 4);
  });

  it("adds sentence space by TeX's space factor, unless frenchSpacing", () => {
    const sentence = shapeText("end. Next", style)[1] as Glue;
    near(sentence.width, space + space / 3);
    near(sentence.stretch, (space / 2) * 3);
    near(sentence.shrink, space / 3 / 3);
    const french = shapeText("end. Next", { ...style, frenchSpacing: true })[1] as Glue;
    near(french.width, space);
    // After a capital letter a period is an abbreviation (space factor 999 -> 1000).
    const abbrev = shapeText("U.S. Army", style)[1] as Glue;
    near(abbrev.width, space);
    near(abbrev.stretch, space / 2);
    // A closing parenthesis is transparent; a comma has space factor 1250.
    near((shapeText("end.) Next", style)[1] as Glue).width, space + space / 3);
    const comma = shapeText("a, b", style)[1] as Glue;
    near(comma.width, space);
    near(comma.stretch, (space / 2) * 1.25);
    // The space factor carries across calls through the state.
    const state = { spaceFactor: 1000 };
    shapeText("end.", style, state);
    near((shapeText(" Next", style, state)[0] as Glue).width, space + space / 3);
  });

  it("makes a no-break space glue behind an infinite penalty", () => {
    const nodes = shapeText("a\u00a0b", style);
    assert.deepEqual(
      nodes.map((n) => n.t),
      ["glyphs", "penalty", "glue", "glyphs"],
    );
    assert.equal((nodes[1] as Discretionary).penalty, 10000);
  });

  it("makes a soft hyphen a flagged discretionary showing a hyphen", () => {
    const nodes = shapeText("hy\u00adphen", style);
    assert.deepEqual(runText(nodes), ["hy", "phen"]);
    const d = nodes[1] as Discretionary;
    assert.equal(d.t, "penalty");
    assert.equal(d.penalty, 50);
    assert.equal(d.flagged, true);
    assert.equal(d.hyphenation, "explicit");
    near(d.width!, main.advance(gid(main, "-")) * S);
    assert.deepEqual((d.preBreak![0] as Glyphs).gids, [gid(main, "-")]);
  });

  it("allows breaks after explicit hyphens and dashes inside words", () => {
    const nodes = shapeText("well-known 1\u20132 a\u2014b", style);
    assert.deepEqual(runText(nodes), ["well-", "known", "1\u2013", "2", "a\u2014", "b"]);
    const pens = nodes.filter((n) => n.t === "penalty") as Discretionary[];
    assert.equal(pens.length, 3);
    for (const p of pens) {
      assert.equal(p.penalty, 50);
      assert.equal(p.flagged, true);
      assert.equal(p.preBreak, undefined);
    }
    // Not after a leading dash, not between two dashes.
    assert.equal(shapeText("a -b c--d", style).filter((n) => n.t === "penalty").length, 1);
  });

  it("makes a zero-width space a free break", () => {
    const nodes = shapeText("a\u200bb", style);
    assert.deepEqual(
      nodes.map((n) => (n.t === "penalty" ? n.penalty : n.t)),
      ["glyphs", 0, "glyphs"],
    );
  });

  it("splits runs where the covering font changes, through the stack and the resolver", () => {
    const viaStack = shapeText("a\u2136b", { fonts: [main, ams], size: 10 });
    assert.deepEqual(
      glyphRuns(viaStack).map((r) => r.font),
      [main, ams, main],
    );
    const asked: number[] = [];
    const viaResolver = shapeText("a\u2136\u2136b", {
      fonts: [main],
      size: 10,
      resolve: (c) => {
        asked.push(c);
        return c === 0x2136 ? ams : undefined;
      },
    });
    assert.deepEqual(
      glyphRuns(viaResolver).map((r) => [r.font, r.text.join("")]),
      [
        [main, "a"],
        [ams, "\u2136\u2136"],
        [main, "b"],
      ],
    );
    assert.deepEqual(asked, [0x2136], "the resolver is asked once per code point");
    const missing: number[] = [];
    const nodes = shapeText("x\u4e2d", { fonts: main, size: 10, onMissing: (c) => missing.push(c) });
    assert.deepEqual(missing, [0x4e2d]);
    assert.deepEqual((nodes[0] as Glyphs).gids.slice(-1), [0]);
  });

  it("composes accented letters TeX-style in KaTeX_Main: one font, raised and centred accents", () => {
    const nodes = shapeText("caf\u00e9 na\u00efve \u00c5ngstr\u00f6m", style);
    const runs = glyphRuns(nodes);
    assert.equal(runs.length, 3);
    for (const r of runs) assert.equal(r.font, main, "no fallback font");
    assert.deepEqual(runs.map((r) => r.text.join("")), ["caf\u00e9", "na\u00efve", "\u00c5ngstr\u00f6m"]);
    assert.ok(runs.every((r) => !r.gids.includes(0)));
    const expected: Record<string, [string, string]> = {
      "\u00e9": ["e", "\u02ca"],
      "\u00ef": ["\u0131", "\u00a8"],
      "\u00c5": ["A", "\u02da"],
      "\u00f6": ["o", "\u00a8"],
    };
    let clusters = 0;
    for (const r of runs) {
      assert.ok(r.yOffsets, "composed runs carry yOffsets");
      let x = 0;
      for (let i = 0; i < r.gids.length; i++) {
        const t = r.text[i];
        if (expected[t]) {
          clusters++;
          const [base, accent] = expected[t];
          assert.equal(r.gids[i], gid(main, base));
          assert.equal(r.gids[i + 1], gid(main, accent));
          assert.equal(r.text[i + 1], "", "the accent carries no text of its own");
          assert.ok(r.yOffsets![i] === 0 && r.yOffsets![i + 1] >= 0, "accents are never lowered");
          // The accent's advance box is centred over the base's.
          const baseW = main.advance(r.gids[i]) * S;
          const accW = main.advance(r.gids[i + 1]) * S;
          const accX = x + r.advances[i];
          near(accX + accW / 2, x + baseW / 2, 1e-9, `${t} centred`);
          // The cluster advances by exactly the base width.
          near(r.advances[i] + r.advances[i + 1], baseW, 1e-9);
          if (t === "\u00c5") {
            // Raised by the base height minus the x-height, as TeX's \accent.
            const raise = (main.bounds(gid(main, "A")).yMax - main.xHeight) * S;
            assert.ok(raise > 2);
            near(r.yOffsets![i + 1], raise, 1e-9);
          } else {
            assert.equal(r.yOffsets![i + 1], 0, "x-height letters need no raise");
          }
          // The accent's ink sits above the base's ink.
          const baseTop = main.bounds(r.gids[i]).yMax * S;
          const accBottom = main.bounds(r.gids[i + 1]).yMin * S + r.yOffsets![i + 1];
          assert.ok(accBottom > baseTop, `${t}: accent above base`);
        }
        x += r.advances[i];
      }
      near(x, r.width, 1e-9);
    }
    assert.equal(clusters, 4);
    // Height of the run with \u00c5 includes the raised ring.
    const ring = main.bounds(gid(main, "\u02da")).yMax * S + (main.bounds(gid(main, "A")).yMax - main.xHeight) * S;
    near(runs[2].height, ring, 1e-9);
  });

  it("composes from decomposed input, stacks accents, and slants accents in italic", () => {
    const nfd = glyphRuns(shapeText("e\u0301", style))[0];
    assert.deepEqual(nfd.gids, [gid(main, "e"), gid(main, "\u02ca")]);
    assert.deepEqual(nfd.text, ["\u00e9", ""]);
    // u + diaeresis + acute: the acute goes above the diaeresis.
    const stacked = glyphRuns(shapeText("\u01d8", style))[0];
    assert.equal(stacked.gids.length, 3);
    assert.ok(stacked.yOffsets![2] > stacked.yOffsets![1]);
    // Italic: an accent raised by r moves right by r * slant (KaTeX italic: slant 0.25).
    const it = bundledFont("Main", "Italic");
    const s = 10 / it.unitsPerEm;
    const run = glyphRuns(shapeText("\u00c9", { fonts: it, size: 10 }))[0];
    const raise = run.yOffsets![1];
    assert.ok(raise > 0);
    const centred = ((it.advance(run.gids[0]) - it.advance(run.gids[1])) / 2) * s;
    near(run.advances[0], centred + raise * 0.25, 1e-9);
  });

  it("applies kerning and ligatures of a real font (Windows Calibri, when installed)", (t) => {
    const path = "C:/Windows/Fonts/calibri.ttf";
    if (!existsSync(path)) return t.skip("Calibri not installed");
    const b = readFileSync(path);
    const cal = parseFont(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    const sc = 10 / cal.unitsPerEm;
    const av = glyphRuns(shapeText("AV", { fonts: cal, size: 10 }))[0];
    const kAV = cal.kerning(gid(cal, "A"), gid(cal, "V"));
    assert.ok(kAV < 0, "Calibri kerns AV");
    near(av.advances[0], (cal.advance(gid(cal, "A")) + kAV) * sc);
    const fi = glyphRuns(shapeText("fi", { fonts: cal, size: 10 }))[0];
    assert.equal(fi.gids.length, 1, "fi ligature");
    assert.deepEqual(fi.text, ["fi"]);
    assert.equal(fi.gids[0], cal.ligatures([gid(cal, "f"), gid(cal, "i")])[0]);
    const noLiga = glyphRuns(shapeText("fi", { fonts: cal, size: 10, ligatures: false }))[0];
    assert.equal(noLiga.gids.length, 2);
    // Hyphenation never breaks inside a ligature...
    const office = shapeText("office", { fonts: cal, size: 10 });
    assert.equal(hyphenateList(office, () => [2]).length, 1);
    // ...and moves the kern at a break into a Kern node that disappears when the line breaks there.
    const toto = shapeText("TOTO", { fonts: cal, size: 10 });
    const kOT = cal.kerning(gid(cal, "O"), gid(cal, "T")) * sc;
    const split = hyphenateList(toto, () => [2], { leftMin: 2, rightMin: 2 });
    assert.deepEqual(
      split.map((n) => n.t),
      kOT ? ["glyphs", "penalty", "kern", "glyphs"] : ["glyphs", "penalty", "glyphs"],
    );
    const total = split.reduce((a, n) => a + (n.t === "glyphs" || n.t === "kern" ? n.width : 0), 0);
    near(total, (toto[0] as Glyphs).width, 1e-9);
  });
});

// ============================================================= hyphenation

describe("hyphenate: Liang's algorithm", () => {
  const texbook = ["hy3ph", "he2n", "hena4", "hen5at", "1na", "n2at", "1tio", "2io"];

  it("parses patterns into letters and inter-letter values", () => {
    assert.deepEqual(parsePattern("hy3ph"), { letters: ["h", "y", "p", "h"], values: [0, 0, 3, 0, 0] });
    assert.deepEqual(parsePattern(".ab4"), { letters: [".", "a", "b"], values: [0, 0, 0, 4] });
  });

  it("hyphenates 'hyphenation' as hy-phen-ation with the TeXbook's patterns", () => {
    const h = new Hyphenator({ patterns: texbook });
    assert.equal(h.size, 8);
    assert.deepEqual(h.points("hyphenation"), [2, 6]);
    assert.equal(h.hyphenate("hyphenation"), "hy-phen-ation");
    assert.equal(h.hyphenate("Hyphenation"), "Hy-phen-ation", "case-insensitive");
  });

  it("keeps the largest value per gap: odd allows, even forbids", () => {
    assert.deepEqual(new Hyphenator({ patterns: ["a1"] }).points("aaaaaaa"), [2, 3, 4], "lefthyphenmin 2, righthyphenmin 3");
    assert.deepEqual(new Hyphenator({ patterns: ["a1", "a2a"] }).points("aaaaaaa"), []);
    assert.deepEqual(new Hyphenator({ patterns: ["a1", "a2a", "a3aa"] }).points("aaaaaaa"), [2, 3, 4]);
    const edges = new Hyphenator({ patterns: [".ab1", "1yz."], leftMin: 1, rightMin: 1 });
    assert.equal(edges.hyphenate("abcxyz"), "ab-cx-yz");
    assert.equal(edges.hyphenate("cabxyzc"), "cabxyzc", "dot patterns only match at word edges");
  });

  it("honours exceptions over patterns", () => {
    const h = new Hyphenator({ patterns: texbook, exceptions: ["ta-ble", "hyphenation", "pro-ject"] });
    assert.deepEqual(h.points("table"), [2]);
    assert.deepEqual(h.points("hyphenation"), [], "an exception without hyphens forbids every break");
    assert.deepEqual(h.points("project"), [3]);
    h.addException("ex-cep-tion");
    assert.equal(h.hyphenate("exception"), "ex-cep-tion");
  });

  it("loads patterns from <dir>/<lang>.json, and works without a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-hyph-"));
    try {
      writeFileSync(join(dir, "xx.json"), JSON.stringify({ patterns: texbook, exceptions: ["ta-ble"] }));
      const h = loadHyphenator("xx", { dir, exceptions: ["pro-ject"] });
      assert.equal(h.hyphenate("hyphenation"), "hy-phen-ation");
      assert.deepEqual(h.points("table"), [2]);
      assert.deepEqual(h.points("project"), [3]);
      const none = loadHyphenator("yy", { dir, exceptions: ["ta-ble"] });
      assert.equal(none.size, 0);
      assert.deepEqual(none.points("table"), [2]);
      assert.deepEqual(none.points("hyphenation"), []);
      writeFileSync(join(dir, "bad.json"), "{ not json");
      assert.throws(() => loadHyphenator("bad", { dir }), /not JSON/);
      writeFileSync(join(dir, "shape.json"), JSON.stringify({ patterns: [1, 2] }));
      assert.throws(() => loadHyphenator("shape", { dir }), /patterns/);
      assert.throws(() => loadHyphenator("../evil", { dir }), /invalid/);
      // The package ships no pattern data, so the default folder yields an exceptions-only hyphenator.
      assert.deepEqual(loadHyphenator("en-us", { exceptions: ["ta-ble"] }).points("table"), [2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inserts automatic discretionaries into shaped text", () => {
    const h = new Hyphenator({ patterns: texbook });
    const shaped = shapeText("hyphenation", { fonts: main, size: 10 });
    const out = hyphenateList(shaped, (w) => h.points(w));
    assert.deepEqual(runText(out), ["hy", "phen", "ation"]);
    const discs = out.filter((n) => n.t === "penalty") as Discretionary[];
    assert.equal(discs.length, 2);
    for (const d of discs) {
      assert.equal(d.hyphenation, "auto");
      assert.equal(d.flagged, true);
      assert.deepEqual((d.preBreak![0] as Glyphs).text, ["-"]);
    }
    near(
      glyphRuns(out).reduce((a, r) => a + r.width, 0),
      (shaped[0] as Glyphs).width,
      1e-9,
    );
    // Words continuing into another run, and short words, are left alone.
    assert.equal(hyphenateList([...shaped, ...shapeText("x", { fonts: ams, size: 10 })], (w) => h.points(w)).length, 2);
  });
});

// ============================================================ line breaking

describe("linebreak: Knuth-Plass", () => {
  const sp = () => g(10, 10, 5);

  it("finds the optimum where greedy first-fit fails (hand-checked)", () => {
    // Width 100, words 30 10 50 20 10, glue 10 plus 10 minus 5.
    // First fit at natural width: "30 10" (50 wide: badness 10000) / "50 20 10".
    // Optimal: "30 10 50" (110, shrinks by its whole 10: badness 100) / "20 10".
    const r = breakParagraph(words([30, 10, 50, 20, 10], sp), { lineWidth: 100 });
    assert.deepEqual(wordsPerLine(r.lines), [3, 2]);
    assert.deepEqual(r.badness, [100, 0]);
    assert.equal(r.info[0].fitness, "tight");
    assert.equal(r.demerits, (10 + 100) ** 2 + (10 + 0) ** 2);
    assert.equal(r.pass, 1, "feasible within pretolerance 100");
    assert.deepEqual(r.overfull, []);
    for (const l of r.lines) assert.equal(l.width, 100);
  });

  it("matches a brute-force search over all breaks", () => {
    const rand = rng(42);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = 4 + Math.floor(rand() * 8);
      const ws = Array.from({ length: n }, () => 5 + Math.floor(rand() * 60));
      const L = 80 + Math.floor(rand() * 60);
      const space = sp();
      const want = bruteForce(ws, L, space, 1000);
      if (!Number.isFinite(want)) continue;
      const r = breakParagraph(words(ws, sp), { lineWidth: L, pretolerance: -1, tolerance: 1000 });
      assert.equal(r.demerits, want, `widths ${ws.join(",")} at ${L}`);
      checked++;
    }
    assert.ok(checked > 100, `checked ${checked}`);
  });

  it("honours looseness", () => {
    // 12 words of 20 with glue 10 plus 30 minus 4: 3 words a line is best (badness 4),
    // 4 words fit by shrinking (badness 58), 2 words stretch to badness 463.
    const list = words(Array(12).fill(20), () => g(10, 30, 4));
    const opts = { lineWidth: 100, tolerance: 1000 };
    const best = breakParagraph(list, opts);
    assert.deepEqual(wordsPerLine(best.lines), [3, 3, 3, 3]);
    const looser = breakParagraph(list, { ...opts, looseness: 1 });
    assert.equal(looser.lines.length, 5);
    assert.equal(looser.looseness, 1);
    const tighter = breakParagraph(list, { ...opts, looseness: -1 });
    assert.deepEqual(wordsPerLine(tighter.lines), [4, 4, 4]);
    assert.equal(tighter.looseness, -1);
    // Asking for the impossible gives the closest: 2 lines would need 6 words a line.
    const impossible = breakParagraph(list, { ...opts, looseness: -2 });
    assert.equal(impossible.lines.length, 3);
    assert.equal(impossible.looseness, -1);
  });

  it("sets ragged right with rigid spaces and penalizes short lines through badness", () => {
    const text =
      "Ragged right setting keeps every interword space at its natural width and lets the right edge of the column vary, while the line breaker still weighs how short each line is so that no line ends far too early.";
    const list = shapeText(text, { fonts: main, size: 10 });
    const r = breakParagraph(list, { lineWidth: 150, raggedRight: true });
    assert.ok(r.lines.length >= 5);
    const naturals: number[] = [];
    r.lines.forEach((l, j) => {
      const last = j === r.lines.length - 1;
      for (const c of l.children) if (c.t === "glue" && c.stretchOrder === 0 && c.width > 0) near(glueSize(c, l.glueSet), c.width, 1e-9, "rigid space");
      const nat = hpack(l.children).natural;
      naturals.push(nat);
      assert.ok(nat <= 150 + 1e-9, "no line sticks out");
      // Badness <= 200 with 2em (20pt) of stretch: shortfall at most 20 * cuberoot(2).
      if (!last) assert.ok(150 - nat <= 20 * Math.cbrt(2) + 1e-9, `line ${j} short by ${150 - nat}`);
    });
    assert.ok(Math.max(...naturals.slice(0, -1)) - Math.min(...naturals.slice(0, -1)) > 1, "the right edge varies");
    // Justified, the same lines would stretch their spaces.
    const just = breakParagraph(list, { lineWidth: 150 });
    assert.ok(just.lines.slice(0, -1).some((l) => l.glueSet?.sign === "stretch" && l.glueSet.order === 0));
  });

  it("produces overfull reports instead of failing on an impossible paragraph", () => {
    const r = breakParagraph([box(40), sp(), box(200), sp(), box(40)], { lineWidth: 100 });
    assert.ok(r.lines.length >= 1);
    assert.equal(r.overfull.length, 1);
    near(r.overfull[0].amount, 100);
    assert.equal(r.lines[r.overfull[0].line].width, 100);
    // One unbreakable word, no glue at all.
    const one = breakParagraph([box(150)], { lineWidth: 100 });
    assert.deepEqual(one.overfull, [{ line: 0, amount: 50 }]);
    // TeX's own last resort breaks where the line first overflows.
    const narrow = shapeText("We saw hyphenation at work in hyphenation tests", { fonts: main, size: 10 });
    const tex = breakParagraph(narrow, { lineWidth: 110, lastResort: "tex" });
    assert.ok(tex.overfull.length > 0);
    const sloppy = breakParagraph(narrow, { lineWidth: 110 });
    assert.equal(sloppy.overfull.length, 0, "the default prefers loose lines to lines that stick out");
    assert.equal(sloppy.pass, 4);
  });

  it("supports variable line widths and shifts (hanging indents, text beside a float)", () => {
    const list = words(Array(20).fill(20), () => g(10, 10, 4));
    const r = breakParagraph(list, { lineWidth: [50, 50, 110], lineShift: [60, 60, 0] });
    assert.deepEqual(
      r.lines.map((l) => l.width),
      [50, 50, ...Array(r.lines.length - 2).fill(110)],
    );
    assert.deepEqual(r.lines.map((l) => l.shift ?? 0).slice(0, 3), [60, 60, 0]);
    assert.deepEqual(wordsPerLine(r.lines).slice(0, 3), [2, 2, 4]);
    // The same through a function of the line number.
    const f = breakParagraph(list, { lineWidth: (n) => (n < 2 ? 50 : 110) });
    assert.deepEqual(f.breaks, r.breaks);
  });

  it("takes forced breaks and never breaks at an infinite penalty", () => {
    const list: HNode[] = [box(20), g(10, 10, 5), box(20), penalty(-10000), box(20), penalty(10000), g(10, 10, 5), box(20)];
    const r = breakParagraph(list, { lineWidth: 100 });
    assert.deepEqual(wordsPerLine(r.lines), [2, 2]);
  });

  it("uses emergency stretch in a third pass", () => {
    const list = words([40, 40, 40, 40, 40], () => g(5, 1, 1));
    const r = breakParagraph(list, { lineWidth: 100, emergencyStretch: 30 });
    assert.equal(r.pass, 3);
    assert.deepEqual(r.overfull, []);
  });

  it("hyphenates in the second pass when the first fails", () => {
    const h = new Hyphenator({ patterns: ["hy3ph", "he2n", "hena4", "hen5at", "1na", "n2at", "1tio", "2io"] });
    const text = "Our tests of hyphenation show that a line which ends in hyphenation can be set, and that the hyphenation of a long word helps a narrow column of text to look even and tidy.";
    const list = shapeText(text, { fonts: main, size: 10 });
    const without = breakParagraph(list, { lineWidth: 130 });
    assert.equal(without.pass, 4, "no feasible breaks without hyphens");
    const r = breakParagraph(list, { lineWidth: 130, hyphenate: h });
    assert.equal(r.pass, 2);
    assert.deepEqual(r.overfull, []);
    const hy = r.info.filter((i) => i.hyphenated);
    assert.ok(hy.length >= 1);
    for (const i of hy) assert.ok(lineText(i.box).endsWith("-"), lineText(i.box));
    assert.ok(r.badness.every((b) => b <= 200));
    // A paragraph that fits without hyphens is never hyphenated (first pass).
    const easy = breakParagraph(list, { lineWidth: 300, hyphenate: h });
    assert.equal(easy.pass, 1);
    assert.ok(easy.info.every((i) => !i.hyphenated));
  });

  it("charges double-hyphen demerits", () => {
    // Words 20 55-45 35-10 20 45 ("-": a discretionary of width 5, penalty 50), width 100.
    // Line 1 is "20 55-" either way: badness 100, very loose, two classes from the
    // initial "decent" node, so 110^2 + 50^2 + 10000 (djdemerits) = 24600.
    // Then hyphens on lines 1 and 2: "45 35-" (b 13, loose), "10 20 45": 24600 + 23^2 + 50^2 + 10^2 = 27729.
    // Or line 2 "45 35-10" (b 0, decent: +10000 adjdemerits), "20 45": 24600 + 10^2 + 10000 + 10^2 = 34800,
    // which wins once \doublehyphendemerits adds 10000 to the first (37729).
    const disc = (): HNode => ({ t: "penalty", penalty: 50, flagged: true, width: 5, preBreak: [box(5)] });
    const list: HNode[] = [box(20), sp(), box(55), disc(), box(45), sp(), box(35), disc(), box(10), sp(), box(20), sp(), box(45)];
    const opts = { lineWidth: 100, pretolerance: -1, finalHyphenDemerits: 0 };
    const free = breakParagraph(list, { ...opts, doubleHyphenDemerits: 0 });
    const strict = breakParagraph(list, { ...opts, doubleHyphenDemerits: 10000 });
    const hy = (r: typeof free) => r.info.map((i) => (i.hyphenated ? 1 : 0)).join("");
    assert.equal(hy(free), "110");
    assert.equal(free.demerits, 27729);
    assert.equal(hy(strict), "100");
    assert.equal(strict.demerits, 34800);
  });

  it("charges final-hyphen demerits when the second-last line ends with a hyphen", () => {
    const list: HNode[] = [box(45), { t: "penalty", penalty: 50, flagged: true, width: 5, preBreak: [box(5)] }, box(45)];
    // "45-" (badness 0, penalty 50): 10^2 + 50^2; last line: 10^2 + inalhyphendemerits.
    assert.equal(breakParagraph(list, { lineWidth: 50 }).demerits, 100 + 2500 + 100 + 5000);
    assert.equal(breakParagraph(list, { lineWidth: 50, finalHyphenDemerits: 0 }).demerits, 2700);
  });

  it("is not thrown off by rounding when lines fill exactly", () => {
    // 0.1 + 0.2 != 0.3 in floating point; rigid lines that fill exactly must still be perfect.
    assert.notEqual(0.1 + 0.2, 0.3);
    const list: HNode[] = [box(0.1), box(0.2), g(5), box(0.3)];
    const r = breakParagraph(list, { lineWidth: 0.3, parFillSkip: g(0) });
    assert.deepEqual(wordsPerLine(r.lines), [2, 1]);
    assert.deepEqual(r.badness, [0, 0]);
    assert.equal(r.pass, 1);
    assert.equal(hpack([box(0.1), box(0.2)], { width: 0.3 }).overfull, 0);
  });

  it("keeps marks, drops discardable items after breaks, and adds the pre-break hyphen", () => {
    const list: HNode[] = [box(40), g(10, 10, 5), { t: "anchor", id: "a" }, box(40), g(10, 10, 5), box(40), g(10, 10, 5), box(40)];
    const r = breakParagraph(list, { lineWidth: 90 });
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[1].children[0].t, "hbox", "the second line starts with a box, not the glue");
    assert.ok(r.lines[0].children.some((c) => c.t === "anchor"), "the anchor stays with its word");
    const h = breakParagraph([box(45), { t: "penalty", penalty: 0, flagged: true, width: 5, preBreak: [box(5)] }, box(45)], { lineWidth: 50, tolerance: 10000 });
    assert.equal(h.lines.length, 2);
    assert.equal(h.lines[0].children.length, 2);
    assert.equal((h.lines[0].children[1] as HBox).width, 5);
    assert.ok(h.info[0].hyphenated);
  });

  it("adds club, widow and broken penalties between lines", () => {
    const list = words(Array(16).fill(20), () => g(10, 10, 4));
    const r = breakParagraph(list, { lineWidth: 110 });
    const v = paragraphPenalties(r, { clubPenalty: 150, widowPenalty: 150, interlinePenalty: 1 });
    const pens = v.filter((n) => n.t === "penalty").map((n) => (n as Discretionary).penalty);
    assert.equal(pens.length, r.lines.length - 1);
    assert.equal(pens[0], 151);
    assert.equal(pens[pens.length - 1], 151);
    assert.ok(pens.slice(1, -1).every((p) => p === 1));
  });

  it("breaks a 5,000-word paragraph quickly with a small active list", (t) => {
    const vocab = "the of and to in is that for it as was with be by on not he this are or his from at which but have an they you were her she there would their we him been has when who will more no if out so said what up its about into than them can only other new some could time these two may then do first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three".split(
      " ",
    );
    const rand = rng(7);
    const text = Array.from({ length: 5000 }, () => vocab[Math.floor(rand() * vocab.length)]).join(" ");
    let t0 = performance.now();
    const list = shapeText(text, { fonts: main, size: 10 });
    const shapeMs = performance.now() - t0;
    t0 = performance.now();
    const cold = breakParagraph(list, { lineWidth: 345 });
    const coldMs = performance.now() - t0;
    // The best of three warm runs: one run under a busy parallel suite measures the machine, not the code.
    let r = breakParagraph(list, { lineWidth: 345 });
    let warmMs = Infinity;
    for (let k = 0; k < 3; k++) {
      t0 = performance.now();
      r = breakParagraph(list, { lineWidth: 345 });
      warmMs = Math.min(warmMs, performance.now() - t0);
    }
    const h = new Hyphenator({ patterns: ["1th", "e1r", "o1u", "a1t", "i1o", "1st", "n1t"] });
    t0 = performance.now();
    const hy = breakParagraph(list, { lineWidth: 345, pretolerance: -1, hyphenate: h });
    const hyMs = performance.now() - t0;
    t.diagnostic(
      `5000 words: shape ${shapeMs.toFixed(1)} ms; break ${coldMs.toFixed(1)} ms cold, ${warmMs.toFixed(1)} ms warm, ${hyMs.toFixed(1)} ms with hyphenation; ${r.lines.length} lines, max active ${r.maxActive}`,
    );
    assert.equal(r.overfull.length, 0);
    assert.ok(r.lines.length > 300);
    // The warm time is the regression signal; a cold run includes JIT compilation and, with the
    // suites running in parallel, CPU contention, so it only guards against a blow-up.
    assert.ok(warmMs < 150, `warm break took ${warmMs} ms`);
    assert.ok(coldMs < 1000, `cold break took ${coldMs} ms`);
    assert.ok(warmMs < 200, `warm break took ${warmMs} ms`);
    assert.ok(hyMs < 400, `break with hyphenation took ${hyMs} ms`);
    assert.ok(cold.maxActive < 40 && hy.maxActive < 60, `active list stayed small: ${cold.maxActive}, ${hy.maxActive}`);
  });
});

// ============================================================ page building

describe("pagebuilder", () => {
  /** A 100pt line, height 8, depth 2, carrying an anchor and optional marks. */
  const line = (id: string, extra: HNode[] = []): HBox => ({ t: "hbox", width: 100, height: 8, depth: 2, children: [{ t: "anchor", id }, ...extra] });
  const base = { textWidth: 100, topSkip: 10, baselineSkip: 12, maxDepth: 4 };
  // 5 lines: first baseline at 10, then every 12pt: 10 + 4 * 12 = 58.
  const five = { ...base, textHeight: 58 };
  const pagesOf = (anchors: Map<string, AnchorInfo>, prefix = "L") => {
    const by = new Map<number, string[]>();
    for (const [id, a] of anchors) if (id.startsWith(prefix)) by.set(a.page, [...(by.get(a.page) ?? []), id]);
    return by;
  };

  it("inserts TeX interline glue (baselineskip, lineskip, lineskiplimit)", () => {
    assert.equal(interlineGlue(2, 8, { baselineSkip: 12 })!.width, 2);
    assert.equal(interlineGlue(5, 9, { baselineSkip: 12, lineSkip: 1 })!.width, 1, "too close: lineskip");
    assert.equal(interlineGlue(-1000, 8, { baselineSkip: 12 }), null);
    const v = stackVList([box(10, 8, 2), penalty(0), box(10, 8, 2), { t: "rule", height: 1 }, box(10, 8, 2)], { baselineSkip: 12 });
    assert.deepEqual(
      v.map((n) => n.t),
      ["hbox", "penalty", "glue", "hbox", "rule", "hbox"],
    );
    const b = new VListBuilder({ baselineSkip: 12 }).box(box(10, 8, 2)).noInterline().box(box(10, 8, 2));
    assert.equal(b.list.length, 2);
  });

  it("fills pages with exactly the lines that fit: N lines, 5 per page", () => {
    const lines = Array.from({ length: 23 }, (_, i) => line(`L${i}`));
    const r = buildPages(lines, five);
    assert.equal(r.pages.length, 5);
    const by = pagesOf(r.anchors);
    assert.deepEqual(
      [...by.values()].map((v) => v.length),
      [5, 5, 5, 5, 3],
    );
    assert.equal(r.anchors.get("L5")!.page, 2);
    // \topskip: the first baseline of every page is 10pt down, so the line's top is at 2.
    for (const p of [0, 5, 10, 15, 20]) near(r.anchors.get(`L${p}`)!.y, 2);
    near(r.anchors.get("L4")!.y, 2 + 4 * 12);
    for (const p of r.pages) {
      assert.equal(p.body.height, 58);
      assert.equal(p.box.width, 100);
    }
    assert.deepEqual(r.overfull, []);
    // 25 lines: exactly 5 pages, no empty sixth.
    assert.equal(buildPages(Array.from({ length: 25 }, (_, i) => line(`L${i}`)), five).pages.length, 5);
  });

  it("lets the text use the footnote skip's shrink instead of overflowing onto the notes", () => {
    // A 2pt note leaves a goal of 58 - 12 - 2 = 44; four lines need 46, which fits only by shrinking
    // the 12pt-minus-4pt skip above the notes, as TeX's page builder counts it.
    const note: VBox = { t: "vbox", width: 100, height: 2, depth: 0, children: [] };
    const lines = Array.from({ length: 6 }, (_, i) => line(`L${i}`, i === 0 ? [{ t: "footnote", content: note }] : []));
    const r = buildPages(lines, five);
    assert.deepEqual(r.overfull, []);
    assert.equal(r.anchors.get("L3")!.page, 1);
    assert.equal(r.anchors.get("L4")!.page, 2);
    assert.equal(r.pages[0]!.body.height + r.pages[0]!.body.depth, 58);
  });

  it("keeps the last line's depth below an exactly full page with a ragged bottom", () => {
    const r = buildPages(Array.from({ length: 10 }, (_, i) => line(`L${i}`)), { ...five, raggedBottom: true });
    assert.equal(r.pages.length, 2);
    assert.deepEqual(r.overfull, []);
    for (const p of r.pages) {
      assert.equal(p.body.height, 58);
      assert.equal(p.body.depth, 2, "the last line's depth hangs below the text area, as in TeX");
    }
    near(r.anchors.get("L4")!.y, 2 + 4 * 12);
  });

  it("breaks before material after the last breakpoint that would overfill the last page", () => {
    // Six lines: the sixth follows the list's last legal break, and must still go to a page of its own.
    const r = buildPages(Array.from({ length: 6 }, (_, i) => line(`L${i}`)), five);
    assert.deepEqual(r.overfull, []);
    assert.deepEqual(
      [...pagesOf(r.anchors).values()].map((v) => v.length),
      [5, 1],
    );
  });

  it("never leaves a heading at the bottom of a page", () => {
    const list: VNode[] = [];
    for (let i = 0; i < 4; i++) list.push(line(`L${i}`));
    list.push(penalty(-300), line("H"), penalty(10000), g(6));
    for (let i = 4; i < 12; i++) list.push(line(`L${i}`));
    const r = buildPages(list, five);
    assert.equal(r.anchors.get("H")!.page, 2, "the heading moves to the next page");
    assert.equal(r.anchors.get("L4")!.page, 2, "with its first line");
    assert.equal(r.anchors.get("L3")!.page, 1);
    near(r.anchors.get("H")!.y, 2, 1e-9, "the heading tops the page");
  });

  it("moves a float that does not fit to the top of the next page, text continuing", () => {
    const H = 10 + 12 * 19; // 20 lines a page
    const fig: VBox = { t: "vbox", width: 100, height: 100, depth: 0, children: [{ t: "anchor", id: "fig" }] };
    const list: VNode[] = [];
    for (let i = 0; i < 40; i++) {
      list.push(line(`L${i}`));
      if (i === 14) list.push({ t: "float", content: fig, placement: "here" });
    }
    const r = buildPages(list, { ...base, textHeight: H });
    const by = pagesOf(r.anchors);
    assert.equal(by.get(1)!.length, 20, "page 1 stays full of text");
    assert.equal(r.anchors.get("fig")!.page, 2);
    near(r.anchors.get("fig")!.y, 0, 1e-9, "at the very top");
    assert.equal(r.pages[1].floats, 1);
    assert.equal(r.pages[1].body.children[0], fig, "the float comes first on the page");
    // 100pt float + 20pt textfloatsep leave 118pt: 10 lines.
    assert.equal(by.get(2)!.length, 10);
    assert.ok(r.anchors.get("L20")!.y > 100, "text follows the float");
  });

  it("places a float here when it fits, and keeps floats in order", () => {
    const H = 10 + 12 * 19;
    const small = (id: string): VBox => ({ t: "vbox", width: 100, height: 30, depth: 0, children: [{ t: "anchor", id }] });
    const big: VBox = { t: "vbox", width: 100, height: 100, depth: 0, children: [{ t: "anchor", id: "big" }] };
    const list: VNode[] = [];
    for (let i = 0; i < 30; i++) {
      list.push(line(`L${i}`));
      if (i === 2) list.push({ t: "float", content: small("f1"), placement: "here" });
      if (i === 8) list.push({ t: "float", content: big, placement: "here" });
      if (i === 9) list.push({ t: "float", content: small("f3"), placement: "here" });
    }
    const r = buildPages(list, { ...base, textHeight: H });
    const f1 = r.anchors.get("f1")!;
    assert.equal(f1.page, 1);
    assert.ok(f1.y > r.anchors.get("L2")!.y && f1.y < r.anchors.get("L3")!.y, "between its lines");
    assert.equal(r.anchors.get("big")!.page, 2);
    assert.equal(r.anchors.get("f3")!.page, 2, "a later float waits behind an earlier one");
    assert.ok(r.anchors.get("f3")!.y > r.anchors.get("big")!.y);
    assert.equal(r.pages[1].floats, 2);
    // A float taller than 	opfraction of the page gets a page of its own; the text flows around it.
    const huge: VBox = { t: "vbox", width: 100, height: 200, depth: 0, children: [{ t: "anchor", id: "huge" }] };
    const list2: VNode[] = [];
    for (let i = 0; i < 40; i++) {
      list2.push(line(`L${i}`));
      if (i === 5) list2.push({ t: "float", content: huge, placement: "here" });
    }
    const r2 = buildPages(list2, { ...base, textHeight: H });
    assert.equal(r2.anchors.get("huge")!.page, 2);
    assert.equal(r2.pages[1].floatPage, true);
    assert.equal(r2.anchors.get("L19")!.page, 1);
    assert.equal(r2.anchors.get("L20")!.page, 3);
    assert.equal(r2.pages.length, 3);
  });

  it("places top, bottom and page floats", () => {
    const H = 10 + 12 * 19;
    const fl = (id: string, placement: "top" | "bottom" | "page"): VNode => ({
      t: "float",
      placement,
      content: { t: "vbox", width: 100, height: 40, depth: 0, children: [{ t: "anchor", id }] },
    });
    const build = (p: "top" | "bottom" | "page") => {
      const list: VNode[] = [];
      for (let i = 0; i < 40; i++) {
        list.push(line(`L${i}`));
        if (i === 3) list.push(fl("f", p));
      }
      return buildPages(list, { ...base, textHeight: H });
    };
    // 40pt + 20pt 	extfloatsep leave 178pt: 15 lines.
    const top = build("top");
    assert.equal(top.anchors.get("f")!.page, 1);
    near(top.anchors.get("f")!.y, 0, 1e-9);
    near(top.anchors.get("L0")!.y, 60 + 2, 1e-9, "the text starts below the float");
    assert.equal(pagesOf(top.anchors).get(1)!.length, 15);
    const bottom = build("bottom");
    assert.equal(bottom.anchors.get("f")!.page, 1);
    near(bottom.anchors.get("f")!.y, H - 40, 1e-9, "flush with the bottom of the text area");
    assert.equal(pagesOf(bottom.anchors).get(1)!.length, 15);
    const page = build("page");
    assert.equal(page.anchors.get("f")!.page, 2);
    assert.equal(page.pages[1].floatPage, true);
    assert.equal(pagesOf(page.anchors).get(1)!.length, 20);
    assert.equal(page.anchors.get("L20")!.page, 3);
  });

  it("puts footnotes at the foot of their line's page and shrinks the text area", () => {
    const H = 10 + 12 * 19;
    const note = (id: string, n = 2): VBox => {
      const v = new VListBuilder({ baselineSkip: 10 });
      for (let i = 0; i < n; i++) v.box({ t: "hbox", width: 100, height: 7, depth: 2, children: i === 0 ? [{ t: "anchor", id }] : [] });
      return vpack(v.list).box;
    };
    const list: VNode[] = [];
    for (let i = 0; i < 60; i++) {
      const extra: HNode[] = i === 5 ? [{ t: "footnote", content: note("n1") }] : i === 25 ? [{ t: "footnote", content: note("n2") }] : [];
      list.push(line(`L${i}`, extra));
    }
    const r = buildPages(list, { ...base, textHeight: H });
    assert.equal(r.anchors.get("n1")!.page, r.anchors.get("L5")!.page);
    assert.equal(r.anchors.get("n2")!.page, r.anchors.get("L25")!.page);
    const by = pagesOf(r.anchors);
    // 12pt skip + two 9pt note lines one 10pt baseline apart (19pt) take 31pt: 3 lines fewer.
    assert.equal(by.get(1)!.length, 17);
    assert.equal(r.pages[0].footnotes, 1);
    const n1 = r.anchors.get("n1")!;
    assert.ok(n1.y > r.anchors.get(by.get(1)!.at(-1)!)!.y, "below the text");
    // As in TeX's \pagebody, the last footnote baseline sits on the bottom of the text area.
    near(n1.y + 7 + 10, H, 1e-6, "the note's last baseline is the text area's bottom");
    // A footnote rule is drawn above the note.
    assert.ok(r.pages[0].body.children.some((c) => c.t === "rule"));
  });

  it("moves a line whose footnote cannot fit or split to the next page with its note", () => {
    const H = 10 + 12 * 19;
    const tall: VBox = { t: "vbox", width: 100, height: 60, depth: 0, children: [{ t: "anchor", id: "n" }] };
    const list: VNode[] = [];
    for (let i = 0; i < 40; i++) list.push(line(`L${i}`, i === 17 ? [{ t: "footnote", content: tall }] : []));
    const r = buildPages(list, { ...base, textHeight: H });
    assert.equal(r.anchors.get("L17")!.page, 2);
    assert.equal(r.anchors.get("n")!.page, 2);
    assert.equal(pagesOf(r.anchors).get(1)!.length, 17);
  });

  it("splits a long footnote across pages", () => {
    const H = 10 + 12 * 19;
    const v = new VListBuilder({ baselineSkip: 10 });
    for (let i = 0; i < 20; i++) v.box({ t: "hbox", width: 100, height: 7, depth: 2, children: [{ t: "anchor", id: `N${i}` }] });
    const long = vpack(v.list).box;
    const list: VNode[] = [];
    for (let i = 0; i < 40; i++) list.push(line(`L${i}`, i === 10 ? [{ t: "footnote", content: long }] : []));
    const r = buildPages(list, { ...base, textHeight: H });
    assert.equal(r.anchors.get("L10")!.page, 1);
    assert.equal(r.anchors.get("N0")!.page, 1);
    assert.equal(r.anchors.get("N19")!.page, 2, "the rest is held over");
    const firstPart = pagesOf(r.anchors, "N").get(1)!.length;
    assert.ok(firstPart > 0 && firstPart < 20);
    const split = vsplit(long, 35);
    assert.ok(split && split.rest);
    assert.equal(collectAnchors(split.first).length, 3, "three 10pt lines fit in 35pt");
    assert.equal(firstBaseline(split.rest!), 7);
    assert.equal(vsplit(long, 1000)!.rest, null);
  });

  it("calls running header and footer builders with the page's marks", () => {
    const list: VNode[] = [];
    for (let i = 0; i < 12; i++) list.push(line(`L${i}`, i === 0 || i === 7 ? [{ t: "outline", title: `S${i}`, level: 1, dest: `L${i}` }] : []));
    const seen: string[] = [];
    const r = buildPages(list, {
      ...five,
      header: (n, m) => {
        seen.push(`${n}:${m.top?.title ?? "-"}/${m.first?.title ?? "-"}/${m.bot?.title ?? "-"}`);
        return { t: "hbox", width: 100, height: 7, depth: 2, children: [{ t: "anchor", id: `head${n}` }] };
      },
      footer: (n) => ({ t: "hbox", width: 100, height: 7, depth: 2, children: [{ t: "anchor", id: `foot${n}` }] }),
    });
    assert.deepEqual(seen, ["1:-/S0/S0", "2:S0/S7/S7", "3:S7/S7/S7"]);
    near(r.anchors.get("head1")!.y, -25 - 7, 1e-9, "header baseline 25pt above the text");
    near(r.anchors.get("foot2")!.y, 58 + 30 - 7, 1e-9, "footer baseline 30pt below the text");
    assert.equal(r.anchors.get("foot2")!.page, 2);
  });

  it("forced breaks end pages; leading discardables vanish", () => {
    const list: VNode[] = [line("L0"), penalty(-10000), penalty(-10000), g(20), line("L1")];
    const r = buildPages(list, five);
    assert.equal(r.pages.length, 2);
    near(r.anchors.get("L1")!.y, 2, 1e-9);
  });

  it("iterates a layout until page references settle (a TOC that grows)", () => {
    const run = layoutUntilStable((prev) => {
      const tocLines = prev ? prev.get("end")!.page : 1;
      const list: VNode[] = [];
      for (let i = 0; i < tocLines; i++) list.push(box(100, 8, 2));
      for (let i = 0; i < 40; i++) list.push(line(i === 39 ? "end" : `L${i}`));
      return buildPages(list, five);
    });
    // Pass 1 puts "end" on page 9, pass 2 (9 TOC lines) on page 10, pass 3 (10 TOC lines) moves
    // every other anchor one line on, and pass 4 confirms nothing moves any more.
    assert.equal(run.stable, true);
    assert.equal(run.passes, 4);
    assert.equal(run.result.anchors.get("end")!.page, 10);
  });

  it("builds 20,000 lines quickly", (t) => {
    const lines = Array.from({ length: 20000 }, (_, i) => line(`L${i}`, i % 50 === 0 ? [{ t: "footnote", content: vpack([box(100, 7, 2)]).box }] : []));
    const t0 = performance.now();
    const r = buildPages(lines, { ...base, textHeight: 10 + 12 * 44 });
    const ms = performance.now() - t0;
    t.diagnostic(`20,000 lines -> ${r.pages.length} pages in ${ms.toFixed(1)} ms`);
    assert.ok(ms < 1500, `${ms} ms`);
    let prev = 1;
    for (let i = 0; i < 20000; i++) {
      const a = r.anchors.get(`L${i}`)!;
      assert.ok(a.page === prev || a.page === prev + 1, `line ${i} on page ${a.page}`);
      prev = a.page;
    }
    assert.deepEqual(r.overfull, []);
  });
});

// ================================================================ shipout

describe("shipout", () => {
  const opts = { pageWidth: 612, pageHeight: 792, margins: { top: 72, left: 72 } };

  it("draws glyphs at the converted coordinates", () => {
    const text = shapeText("Hello world", { fonts: main, size: 10 });
    const para = breakParagraph(text, { lineWidth: 200 });
    const r = buildPages(para.lines, { textHeight: 600, textWidth: 200, topSkip: 10, baselineSkip: 12 });
    const w = new MockWriter();
    shipout(w, r.pages, opts);
    assert.equal(w.pages.length, 1);
    const [hello, world] = w.pages[0].of("glyphs");
    assert.equal(hello.x, 72);
    near(hello.y as number, 792 - 72 - 10, 1e-9, "first baseline at \\topskip");
    assert.deepEqual(hello.text, ["H", "e", "l", "l", "o"]);
    const line = para.lines[0];
    const gap = glueSize(line.children[1] as Glue, line.glueSet);
    near(world.x as number, 72 + (text[0] as Glyphs).width + gap, 1e-9);
    assert.equal(world.y, hello.y);
    assert.equal(world.size, 10);
  });

  it("emits one link rectangle per line segment across a line break", () => {
    const st = { fonts: main, size: 10 };
    const [A, B, C, D, E] = ["aaa", "bbb", "ccc", "ddd", "eee"].map((s) => shapeText(s, st)[0] as Glyphs);
    const sp = () => interwordGlue(main, 10);
    const url = { url: "https://example.org" };
    const l1 = hpack([A, sp(), { t: "link-start", target: url }, B, sp(), C, sp()]).box;
    const l2 = hpack([D, { t: "link-end" }, sp(), E]).box;
    const page = vpack(stackVList([l1, l2], { baselineSkip: 12 })).box;
    const w = new MockWriter();
    shipout(w, [page], opts);
    const links = w.pages[0].of("link");
    assert.equal(links.length, 2);
    const s = interwordGlue(main, 10).width;
    // Line 1: from B to the end of C (the trailing space is not part of the link).
    near(links[0].x as number, 72 + A.width + s, 1e-9);
    near(links[0].width as number, B.width + s + C.width, 1e-9);
    near(links[0].y as number, 792 - 72 - (l1.height + l1.depth), 1e-9);
    near(links[0].height as number, l1.height + l1.depth, 1e-9);
    // Line 2: from the line start to the end of D.
    const top2 = l1.height + l1.depth + (12 - l1.depth - l2.height);
    near(links[1].x as number, 72, 1e-9);
    near(links[1].width as number, D.width, 1e-9);
    near(links[1].y as number, 792 - 72 - (top2 + l2.height + l2.depth), 1e-9);
    assert.deepEqual(links[1].target, url);
  });

  it("continues a link onto the next page", () => {
    const st = { fonts: main, size: 10 };
    const x = shapeText("x", st)[0] as Glyphs;
    const p1 = vpack([hpack([{ t: "link-start", target: { dest: "d" } }, x]).box]).box;
    const p2 = vpack([hpack([x, { t: "link-end" }]).box]).box;
    const w = new MockWriter();
    shipout(w, [p1, p2], opts);
    assert.equal(w.pages[0].of("link").length, 1);
    assert.equal(w.pages[1].of("link").length, 1);
    assert.deepEqual(w.pages[1].of("link")[0].target, { dest: "d" });
  });

  it("draws rules, images and drawings, and emits destinations and outlines", () => {
    const img: ImageRef = { id: "pic", pixelWidth: 10, pixelHeight: 5 };
    const drawing = { t: "drawing" as const, width: 20, height: 10, depth: 0, ops: [{ op: "path" as const, d: [["M", 0, 0], ["L", 20, 10]] as PathCommand[], stroke: [1, 0, 0] as Color }] };
    const lineBox = hpack([{ t: "rule", width: 10, height: 5, depth: 1, color: [0, 0, 1] }, { t: "kern", width: 5 }, { t: "anchor", id: "inline" }, { t: "rule", width: 3 }]).box;
    const page = vpack([
      { t: "anchor", id: "top" },
      { t: "outline", title: "Intro", level: 1, dest: "top" },
      lineBox,
      { t: "image", image: img, width: 40, height: 20, depth: 0 },
      drawing,
      { t: "rule", height: 2 },
    ]).box;
    const w = new MockWriter();
    shipout(w, [page], opts);
    const p = w.pages[0];
    assert.deepEqual(p.of("destination")[0], { op: "destination", name: "top", x: 72, y: 720 });
    assert.deepEqual(w.outlines, [{ title: "Intro", level: 1, dest: "top" }]);
    const rects = p.of("rect");
    // The first rule: 10 wide, height 5 + depth 1, bottom at baseline 5 + 1 below the top.
    assert.deepEqual(rects[0], { op: "rect", x: 72, y: 720 - 6, width: 10, height: 6, fill: [0, 0, 1] });
    // A running-height rule takes the line's height and depth.
    assert.deepEqual(rects[1], { op: "rect", x: 87, y: 720 - 6, width: 3, height: 6, fill: [0, 0, 0] });
    assert.deepEqual(p.of("destination")[1], { op: "destination", name: "inline", x: 87, y: 720 });
    assert.deepEqual(p.of("image")[0], { op: "image", image: img, x: 72, y: 720 - 6 - 20, width: 40, height: 20 });
    // The drawing: saved, translated to its baseline, restored.
    const ops = p.calls.map((c) => c.op);
    const i = ops.indexOf("transform");
    assert.deepEqual(ops.slice(i - 1, i + 3), ["save", "transform", "path", "restore"]);
    assert.deepEqual(p.calls[i].m, [1, 0, 0, 1, 72, 720 - 6 - 20 - 10]);
    // A running-width rule spans the box (as wide as its widest item, the image).
    assert.deepEqual(rects[2], { op: "rect", x: 72, y: 720 - 6 - 20 - 10 - 2, width: 40, height: 2, fill: [0, 0, 0] });
  });

  it("honours glue settings, shifts and leaders", () => {
    const x = shapeText("x", { fonts: main, size: 10 })[0] as Glyphs;
    const inner = hpack([x]).box;
    inner.shift = 3;
    const line = hpack([x, g(10, 10, 0), inner, { ...g(0, 1, 0, 1), leader: { t: "rule", height: 0.5 } }, x], { width: 200 }).box;
    const shifted = { ...hpack([x]).box, shift: 15 };
    const page = vpack([line, g(10), shifted]).box;
    const w = new MockWriter();
    shipout(w, [page], opts);
    const gl = w.pages[0].of("glyphs");
    const base = 792 - 72 - line.height;
    near(gl[0].x as number, 72);
    near(gl[1].x as number, 72 + x.width + 10, 1e-9, "finite glue keeps natural width beside fil glue");
    near(gl[1].y as number, base - 3, 1e-9, "a shifted box moves down");
    near(gl[2].x as number, 72 + 200 - x.width, 1e-9, "the fil leader fills the rest");
    const leader = w.pages[0].of("rect")[0];
    near(leader.width as number, 200 - 3 * x.width - 10, 1e-9);
    near(gl[3].x as number, 72 + 15, 1e-9, "a shifted box in a vlist moves right");
  });

  it("ships page-builder pages with their headers in the top margin", () => {
    const st = { fonts: main, size: 10 };
    const header = hpack(shapeText("Header", st)).box;
    const body = breakParagraph(shapeText("Some text on the page.", st), { lineWidth: 300 }).lines;
    const r = buildPages(body, { textHeight: 600, textWidth: 300, topSkip: 10, baselineSkip: 12, header: () => header });
    const w = new MockWriter();
    shipout(w, r.pages, opts);
    const gl = w.pages[0].of("glyphs");
    near(gl[0].y as number, 792 - 72 + 25, 1e-9, "header baseline 25pt above the text area");
    near(gl[1].y as number, 792 - 72 - 10, 1e-9);
  });
});
