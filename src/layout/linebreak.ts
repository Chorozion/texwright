/**
 * Paragraph breaking: the Knuth-Plass total-fit algorithm ("Breaking
 * Paragraphs into Lines", 1981) as TeX implements it (tex.web §813-§890).
 *
 * The breaker walks the horizontal list once per pass, keeping an "active
 * list" of feasible breakpoints that may still start a line. At each legal
 * breakpoint it measures the line from every active node, computes its
 * badness and fitness class, and records the cheapest way to reach this
 * point per fitness class (demerits). Active nodes whose lines have become
 * too long are dropped, so the list stays small. Passes:
 *
 *   1. threshold = pretolerance, no pattern hyphenation (skipped if pretolerance < 0);
 *   2. threshold = tolerance, with pattern hyphenation (when a hyphenator is given);
 *   3. emergency stretch added to every line (only if emergencyStretch > 0).
 *
 * With microtype options (justified text only) the breaker works as pdfTeX
 * with \pdfprotrudechars=2 and \pdfadjustspacing=2: characters protruding
 * into the margins give their line more room, and glyph expansion absorbs
 * a shortfall or excess before the glue does (see microtype.ts).
 *
 * The final pass cannot fail: when nothing feasible remains it breaks where
 * the line first overflows, as TeX does. Unless lastResort is "tex", such a
 * paragraph then gets one more pass (4) that accepts any badness up to
 * 10000, so loose lines replace lines sticking into the margin; whatever
 * still overflows is reported as overfull.
 */

import { type Microtype, type MicrotypeOptions, expandGlyphs, expandableWidth, leftProtrusion, lineExpansion, microtypeSettings, rightProtrusion } from "./microtype.js";
import { AWFUL_BAD, INF_BAD, LENGTH_EPS, badness, hpack, measureH } from "./pack.js";
import type { Discretionary } from "./text.js";
import { hyphenateList } from "./text.js";
import type { Glue, Glyphs, HBox, HNode, Penalty } from "./types.js";
import { EJECT_PENALTY, INF_PENALTY } from "./types.js";

/** Fitness classes, in the order of the paper (adjacent classes differ by 1). */
export const TIGHT = 0;
export const DECENT = 1;
export const LOOSE = 2;
export const VERY_LOOSE = 3;
const FITNESS_NAMES = ["tight", "decent", "loose", "very loose"] as const;
export type Fitness = (typeof FITNESS_NAMES)[number];

/** A per-line quantity: one value for all lines, a list (the last entry repeats, like \parshape), or a function of the 0-based line index. */
export type PerLine = number | readonly number[] | ((line: number) => number);

export interface LineBreakOptions {
  /** Line widths (\hsize, \parshape). */
  lineWidth: PerLine;
  /** Left indentation of each line (hanging indents, lists, text beside a float): becomes the HBox shift. */
  lineShift?: PerLine;
  /** Badness limit for the second pass (\tolerance). Default 200. */
  tolerance?: number;
  /** Badness limit for the first pass, without hyphenation (\pretolerance). Default 100; below 0 skips the pass. */
  pretolerance?: number;
  /** Added to each line's badness before squaring (\linepenalty). Default 10. */
  linePenalty?: number;
  /** Demerits for adjacent lines whose fitness classes are not adjacent (\adjdemerits). Default 10000. */
  adjDemerits?: number;
  /** Demerits for two consecutive hyphenated lines (\doublehyphendemerits). Default 10000. */
  doubleHyphenDemerits?: number;
  /** Demerits for a hyphen ending the second-last line (\finalhyphendemerits). Default 5000. */
  finalHyphenDemerits?: number;
  /** Extra stretch assumed for every line in a third pass (\emergencystretch). Default 0 (no third pass). */
  emergencyStretch?: number;
  /** Lines to add (positive) or remove (negative) from the optimum (\looseness). Default 0. */
  looseness?: number;
  /** Glue that ends the last line (\parfillskip). Default 0pt plus 1fil. */
  parFillSkip?: Glue;
  /** Glue at the left and right of every line (\leftskip, \rightskip). */
  leftSkip?: Glue;
  rightSkip?: Glue;
  /**
   * Ragged-right setting (plain TeX's \raggedright): a right skip of
   * 0pt plus `stretch` (default 2em of the paragraph's first font size), so a
   * short line costs badness, and rigid interword spaces (unless rigidSpaces is false).
   */
  raggedRight?: boolean | { stretch?: number; rigidSpaces?: boolean };
  /** Pattern hyphenation for the second pass: a Hyphenator or a function returning break positions. */
  hyphenate?: { points(word: string): number[] } | ((word: string) => readonly number[]);
  /** \hyphenpenalty for pattern breaks. Default 50. */
  hyphenPenalty?: number;
  leftHyphenMin?: number;
  rightHyphenMin?: number;
  /** Overfull lines smaller than this are not reported (\hfuzz). Default 0.1pt. */
  hfuzz?: number;
  /** Underfull lines are reported above this badness (\hbadness). Default 1000. */
  hbadness?: number;
  /**
   * What to do when even the final pass finds no feasible breaks. "sloppy"
   * (default) runs one more pass accepting any badness up to 10000, so loose
   * lines replace lines that stick out; overfull lines remain only where
   * nothing else is possible. "tex" keeps TeX's behaviour: break where the
   * line first overflows.
   */
  lastResort?: "sloppy" | "tex";
  /**
   * Character protrusion and font expansion (microtype.ts). Applies only to
   * justified lines: ignored for ragged-right text and when the left or
   * right skip can stretch infinitely (centred, flush right). Default off.
   */
  microtype?: MicrotypeOptions | false;
}

export interface LineInfo {
  box: HBox;
  /** Index in `list` of the first item and of the breakpoint that ends the line. */
  start: number;
  end: number;
  width: number;
  shift: number;
  badness: number;
  fitness: Fitness;
  /** Amount the content overflows the line (0 if it fits). */
  overfull: number;
  underfull: boolean;
  /** The line ends at a discretionary (hyphen or dash). */
  hyphenated: boolean;
  /** How far the line's first and last characters hang into the margins (microtype), in points. */
  protrusion?: [number, number];
  /** Glyph expansion of the line in thousandths (microtype), negative when narrowed. */
  expansion?: number;
}

export interface LineBreakResult {
  lines: HBox[];
  info: LineInfo[];
  /** Index in `list` of each line's breakpoint (the last is the final forced break). */
  breaks: number[];
  /** Per-line badness of the packed lines. */
  badness: number[];
  /** Lines that stick out past their width by more than hfuzz. */
  overfull: { line: number; amount: number }[];
  underfull: { line: number; badness: number }[];
  /** The list actually broken: the input plus inserted hyphenation points and the final parfillskip. */
  list: HNode[];
  /** Which pass succeeded: 1 (pretolerance), 2 (tolerance), 3 (emergency stretch) or 4 (last resort, badness up to 10000). */
  pass: 1 | 2 | 3 | 4;
  /** Total demerits of the chosen breaks. */
  demerits: number;
  /** Lines added or removed relative to the optimum (equals looseness when it could be met). */
  looseness: number;
  /** Largest size the active list reached in any pass (a measure of the pruning). */
  maxActive: number;
}

interface Passive {
  pos: number;
  prev: Passive | null;
}

interface Active {
  pos: number;
  /** Number of the line that starts here (1-based). */
  line: number;
  fitness: number;
  hyphenated: boolean;
  demerits: number;
  passive: Passive | null;
  /** Totals of the list up to the first item kept after the break. */
  w: number;
  /** Expandable glyph width up to there, and how far the next line's first character protrudes (microtype). */
  e: number;
  lp: number;
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  z: number;
}

function perLine(v: PerLine | undefined, fallback: number): (line: number) => number {
  if (v === undefined) return () => fallback;
  if (typeof v === "number") return () => v;
  if (typeof v === "function") return v;
  const arr = v;
  if (!arr.length) return () => fallback;
  return (line) => arr[Math.min(line, arr.length - 1)];
}

/** Items after which nothing breaks and before which glue may break (TeX's precedes_break, without math). */
function isBoxLike(n: HNode | undefined): boolean {
  if (!n) return false;
  switch (n.t) {
    case "glue":
    case "kern":
    case "penalty":
      return false;
    default:
      return true;
  }
}

function isDiscardable(n: HNode): boolean {
  return n.t === "glue" || n.t === "kern" || n.t === "penalty";
}

const MARK_TYPES = new Set(["anchor", "link-start", "link-end", "outline", "footnote", "float", "struct"]);

function isMark(n: HNode): boolean {
  return MARK_TYPES.has(n.t);
}

function breakWidth(p: Penalty): number {
  if (p.width !== undefined) return p.width;
  let w = 0;
  for (const n of p.preBreak ?? []) w += "width" in n && typeof n.width === "number" ? n.width : 0;
  return w;
}

/** How far the character before a break at list[b] hangs into the right margin: the hyphen of a discretionary, else the last character of the line. */
function rightEdge(list: readonly HNode[], b: number, start = 0): number {
  const brk = list[b];
  if (brk.t === "penalty") {
    if (brk.preBreak && brk.preBreak.length) return rightProtrusion(brk.preBreak, brk.preBreak.length);
    if (brk.width) return 0;
  }
  return rightProtrusion(list, b, start);
}

/** Glue that can stretch or shrink infinitely. */
function infiniteGlue(g: Glue | undefined): boolean {
  return !!g && ((g.stretchOrder > 0 && g.stretch !== 0) || (g.shrinkOrder > 0 && g.shrink !== 0));
}

function firstFontSize(list: readonly HNode[]): number {
  for (const n of list) if (n.t === "glyphs") return n.size;
  return 10;
}

/**
 * Breaks a horizontal list into lines of the given widths. The list is not
 * modified. It should not end with the paragraph's own glue: as TeX does,
 * a trailing glue item is removed and \penalty10000 \parfillskip \penalty-10000
 * are appended.
 */
export function breakParagraph(input: readonly HNode[], options: LineBreakOptions): LineBreakResult {
  const tolerance = options.tolerance ?? 200;
  const pretolerance = options.pretolerance ?? 100;
  const linePenalty = options.linePenalty ?? 10;
  const adjDemerits = options.adjDemerits ?? 10000;
  const doubleHyphenDemerits = options.doubleHyphenDemerits ?? 10000;
  const finalHyphenDemerits = options.finalHyphenDemerits ?? 5000;
  const emergencyStretch = options.emergencyStretch ?? 0;
  const looseness = Math.trunc(options.looseness ?? 0);
  const widthOf = perLine(options.lineWidth, 0);
  const shiftOf = perLine(options.lineShift, 0);

  // ---- the working list
  let leftSkip = options.leftSkip;
  let rightSkip = options.rightSkip;
  let list: HNode[] = input.slice();
  const ragged = options.raggedRight;
  if (ragged) {
    const cfg = typeof ragged === "object" ? ragged : {};
    const stretch = cfg.stretch ?? 2 * firstFontSize(input);
    rightSkip = { t: "glue", width: rightSkip?.width ?? 0, stretch, stretchOrder: 0, shrink: 0, shrinkOrder: 0 };
    if (cfg.rigidSpaces ?? true) {
      list = list.map((n) =>
        n.t === "glue" && !n.leader && n.stretchOrder === 0 && n.shrinkOrder === 0 && (n.stretch !== 0 || n.shrink !== 0)
          ? { ...n, stretch: 0, shrink: 0 }
          : n,
      );
    }
  }
  // Microtype only in justified text: not ragged, not between infinitely stretchable skips.
  const mt: Microtype | undefined = ragged || infiniteGlue(leftSkip) || infiniteGlue(rightSkip) ? undefined : microtypeSettings(options.microtype);
  if (list.length && list[list.length - 1].t === "glue") list.pop();
  if (!list.length) {
    return { lines: [], info: [], breaks: [], badness: [], overfull: [], underfull: [], list: [], pass: 1, demerits: 0, looseness: 0, maxActive: 0 };
  }
  list.push({ t: "penalty", penalty: INF_PENALTY }, options.parFillSkip ?? { t: "glue", width: 0, stretch: 1, stretchOrder: 1, shrink: 0, shrinkOrder: 0 }, {
    t: "penalty",
    penalty: EJECT_PENALTY,
  });

  // Background: the skips present on every line.
  const bg = { w: 0, s: [0, 0, 0, 0], z: 0 };
  for (const g of [leftSkip, rightSkip]) {
    if (!g) continue;
    bg.w += g.width;
    bg.s[g.stretchOrder] += g.stretch;
    bg.z += g.shrink;
  }

  // Lines beyond easyLine all have the same width, so active nodes for them need not be told apart by line number.
  let easyLine: number;
  if (looseness !== 0 || typeof options.lineWidth === "function") easyLine = Infinity;
  else if (typeof options.lineWidth === "number") easyLine = 0;
  else easyLine = Math.max(0, options.lineWidth.length - 1);
  const lineWidth = (l: number) => widthOf(l - 1);

  const hyph = options.hyphenate;
  const hyphenFn = hyph ? (typeof hyph === "function" ? hyph : (w: string) => hyph.points(w)) : undefined;

  let threshold: number;
  let secondPass: boolean;
  let finalPass: boolean;
  if (pretolerance >= 0) {
    threshold = pretolerance;
    secondPass = false;
    finalPass = false;
  } else {
    threshold = tolerance;
    secondPass = true;
    finalPass = emergencyStretch <= 0;
  }
  let extraStretch = 0;
  let hyphenated = false;
  let passNo: 1 | 2 | 3 | 4 = secondPass ? 2 : 1;
  let chosen: { node: Active; actual: number } | null = null;
  const stats = { maxActive: 0, artificial: false };
  const sloppy = (options.lastResort ?? "sloppy") === "sloppy";

  for (;;) {
    if (threshold > INF_BAD) threshold = INF_BAD;
    if (secondPass && hyphenFn && !hyphenated) {
      list = hyphenateList(list, hyphenFn, {
        hyphenPenalty: options.hyphenPenalty,
        leftMin: options.leftHyphenMin,
        rightMin: options.rightHyphenMin,
      });
      hyphenated = true;
    }
    const best = runPass(list, {
      threshold,
      secondPass,
      finalPass,
      bgW: bg.w,
      bgS: [bg.s[0] + extraStretch, bg.s[1], bg.s[2], bg.s[3]],
      bgZ: bg.z,
      linePenalty,
      adjDemerits,
      doubleHyphenDemerits,
      finalHyphenDemerits,
      lineWidth,
      easyLine,
      stats,
      mt,
    });
    if (best) {
      const pick = chooseLooseness(best, looseness);
      if (looseness === 0 || pick.actual === looseness || finalPass) {
        chosen = pick;
        if (!(finalPass && stats.artificial && sloppy && threshold < INF_BAD)) break;
        // Last resort: accept loose lines rather than lines that stick out.
        stats.artificial = false;
        const retry = runPass(list, {
          threshold: INF_BAD,
          secondPass: true,
          finalPass: true,
          bgW: bg.w,
          bgS: [bg.s[0] + extraStretch, bg.s[1], bg.s[2], bg.s[3]],
          bgZ: bg.z,
          linePenalty,
          adjDemerits,
          doubleHyphenDemerits,
          finalHyphenDemerits,
          lineWidth,
          easyLine,
          stats,
          mt,
        });
        if (retry) {
          chosen = chooseLooseness(retry, looseness);
          passNo = 4;
        }
        break;
      }
    }
    if (!secondPass) {
      threshold = tolerance;
      secondPass = true;
      finalPass = emergencyStretch <= 0;
      passNo = 2;
    } else {
      extraStretch = emergencyStretch;
      finalPass = true;
      passNo = 3;
    }
  }

  // ---- post-line-break: pack the lines
  const breaks: number[] = [];
  for (let p = chosen.node.passive; p; p = p.prev) breaks.push(p.pos);
  breaks.reverse();
  const lines: HBox[] = [];
  const info: LineInfo[] = [];
  const overfull: LineBreakResult["overfull"] = [];
  const underfull: LineBreakResult["underfull"] = [];
  const hfuzz = options.hfuzz ?? 0.1;
  const hbadness = options.hbadness ?? 1000;
  let prev = -1;
  for (let j = 0; j < breaks.length; j++) {
    const b = breaks[j];
    const content: HNode[] = [];
    if (leftSkip) content.push(leftSkip);
    let k = prev + 1;
    if (j > 0) {
      // Discard glue, kerns and penalties after a break; marks among them stay.
      while (k < b && (isDiscardable(list[k]) || isMark(list[k]))) {
        if (isMark(list[k])) content.push(list[k]);
        k++;
      }
    }
    // Margin kerns: the first and last characters hang into the margins.
    const lp = mt?.protrusion ? leftProtrusion(list, k, b) : 0;
    const rp = mt?.protrusion ? rightEdge(list, b, k) : 0;
    if (lp) content.push({ t: "kern", width: -lp, subtype: "margin" });
    for (let m = k; m < b; m++) content.push(list[m]);
    const brk = list[b];
    let isHyphen = false;
    if (brk.t === "penalty") {
      if (brk.preBreak && brk.preBreak.length) content.push(...brk.preBreak);
      else if (brk.width) content.push({ t: "kern", width: brk.width });
      isHyphen = !!brk.flagged && j < breaks.length - 1;
    }
    if (rp) content.push({ t: "kern", width: -rp, subtype: "margin" });
    if (rightSkip) content.push(rightSkip);
    const width = widthOf(j);
    const shift = shiftOf(j);
    const e = mt?.expansion ? expandLine(content, width, mt) : 0;
    const packed = hpack(content, { width }, { badnessLimit: hbadness });
    if (shift) packed.box.shift = shift;
    lines.push(packed.box);
    const set = packed.box.glueSet;
    let fitness: number = DECENT;
    if (set && set.order === 0 && packed.badness > 12) fitness = set.sign === "shrink" ? TIGHT : packed.badness > 99 ? VERY_LOOSE : LOOSE;
    if (packed.overfull > 0) fitness = TIGHT;
    info.push({
      box: packed.box,
      start: prev + 1,
      end: b,
      width,
      shift,
      badness: packed.badness,
      fitness: FITNESS_NAMES[fitness],
      overfull: packed.overfull,
      underfull: packed.underfull,
      hyphenated: isHyphen,
    });
    if (mt) {
      info[info.length - 1].protrusion = [lp, rp];
      info[info.length - 1].expansion = e;
    }
    if (packed.overfull > hfuzz) overfull.push({ line: j, amount: packed.overfull });
    if (packed.underfull) underfull.push({ line: j, badness: packed.badness });
    prev = b;
  }
  return {
    lines,
    info,
    breaks,
    badness: info.map((l) => l.badness),
    overfull,
    underfull,
    list,
    pass: passNo,
    demerits: chosen.node.demerits,
    looseness: chosen.actual,
    maxActive: stats.maxActive,
  };
}

/**
 * Expands or narrows the glyphs of a line (in place in `content`) to absorb
 * as much as they can of the difference from `width`, as pdfTeX's hpack does
 * for a paragraph line; the glue takes the rest. Lines with infinitely
 * stretchable glue (the last line) are left alone. Returns the expansion.
 */
function expandLine(content: HNode[], width: number, mt: Microtype): number {
  const m = measureH(content);
  const excess = width - m.width;
  if (excess > 0 ? m.stretch[1] || m.stretch[2] || m.stretch[3] : m.shrink[1] || m.shrink[2] || m.shrink[3]) return 0;
  let expandable = 0;
  for (const n of content) expandable += expandableWidth(n);
  const e = lineExpansion(excess, expandable, mt);
  if (e) for (let i = 0; i < content.length; i++) if (expandableWidth(content[i])) content[i] = expandGlyphs(content[i] as Glyphs, e);
  return e;
}

interface PassParams {
  threshold: number;
  secondPass: boolean;
  finalPass: boolean;
  bgW: number;
  bgS: number[];
  bgZ: number;
  linePenalty: number;
  adjDemerits: number;
  doubleHyphenDemerits: number;
  finalHyphenDemerits: number;
  lineWidth: (line: number) => number;
  easyLine: number;
  stats: { maxActive: number; artificial: boolean };
  mt: Microtype | undefined;
}

/** TeX §875: the active node at the end with the fewest demerits, or the one closest to the requested looseness. */
function chooseLooseness(active: Active[], looseness: number): { node: Active; actual: number } {
  let best = active[0];
  for (const r of active) if (r.demerits < best.demerits) best = r;
  if (looseness === 0) return { node: best, actual: 0 };
  const bestLine = best.line;
  let actual = 0;
  let fewest = best.demerits;
  for (const r of active) {
    const diff = r.line - bestLine;
    if ((diff < actual && looseness <= diff) || (diff > actual && looseness >= diff)) {
      best = r;
      actual = diff;
      fewest = r.demerits;
    } else if (diff === actual && r.demerits < fewest) {
      best = r;
      fewest = r.demerits;
    }
  }
  return { node: best, actual };
}

/** One pass over the list; returns the active nodes at the final break, or null when the pass found no way through. */
function runPass(list: readonly HNode[], P: PassParams): Active[] | null {
  const n = list.length;
  // Prefix sums of width, stretch per order and shrink over list[0..i).
  const W = new Float64Array(n + 1);
  const S0 = new Float64Array(n + 1);
  const S1 = new Float64Array(n + 1);
  const S2 = new Float64Array(n + 1);
  const S3 = new Float64Array(n + 1);
  const Z = new Float64Array(n + 1);
  const mt = P.mt;
  // Expandable glyph width (microtype's font stretch and shrink are fractions of it).
  const E = mt?.expansion ? new Float64Array(n + 1) : null;
  for (let i = 0; i < n; i++) {
    const it = list[i];
    let w = 0;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let z = 0;
    switch (it.t) {
      case "glue":
        w = it.width;
        if (it.stretchOrder === 0) s0 = it.stretch;
        else if (it.stretchOrder === 1) s1 = it.stretch;
        else if (it.stretchOrder === 2) s2 = it.stretch;
        else s3 = it.stretch;
        z = it.shrink; // infinite shrink in a paragraph is treated as finite, as TeX does after its error
        break;
      case "penalty":
        break;
      case "rule":
        w = it.width ?? 0;
        break;
      case "anchor":
      case "link-start":
      case "link-end":
      case "outline":
      case "footnote":
      case "float":
      case "struct":
        break;
      default:
        w = it.width;
    }
    W[i + 1] = W[i] + w;
    S0[i + 1] = S0[i] + s0;
    S1[i + 1] = S1[i] + s1;
    S2[i + 1] = S2[i] + s2;
    S3[i + 1] = S3[i] + s3;
    Z[i + 1] = Z[i] + z;
    if (E) E[i + 1] = E[i] + expandableWidth(it);
  }

  const active: Active[] = [
    { pos: -1, line: 1, fitness: DECENT, hyphenated: false, demerits: 0, passive: null, w: 0, s0: 0, s1: 0, s2: 0, s3: 0, z: 0, e: 0, lp: mt?.protrusion ? leftProtrusion(list, 0) : 0 },
  ];
  const minimal = [AWFUL_BAD, AWFUL_BAD, AWFUL_BAD, AWFUL_BAD];
  const bestPlace: (Passive | null)[] = [null, null, null, null];
  const bestLine = [0, 0, 0, 0];
  const { threshold, finalPass, linePenalty, adjDemerits } = P;
  const [bgS0, bgS1, bgS2, bgS3] = P.bgS;

  const tryBreak = (b: number, pi: number, flagged: boolean, last: boolean) => {
    let minimum = AWFUL_BAD;
    const brk = list[b];
    const extra = brk.t === "penalty" ? breakWidth(brk) : 0;
    const curW = W[b] + extra + P.bgW;
    const curS0 = S0[b] + bgS0;
    const curS1 = S1[b] + bgS1;
    const curS2 = S2[b] + bgS2;
    const curS3 = S3[b] + bgS3;
    const curZ = Z[b] + P.bgZ;
    // Microtype: the protrusion of the line's last character, and the expandable width at the break (a hyphen counts).
    const rp = mt?.protrusion ? rightEdge(list, b) : 0;
    let curE = 0;
    if (E) {
      curE = E[b];
      if (brk.t === "penalty" && brk.preBreak) for (const x of brk.preBreak) curE += expandableWidth(x);
    }
    let oldL = 0;
    let lineW = 0;
    let after: Omit<Active, "line" | "fitness" | "hyphenated" | "demerits" | "passive"> | null = null;
    let k = 0;
    for (;;) {
      const r = k < active.length ? active[k] : null;
      const l = r ? r.line : Infinity;
      if (l > oldL) {
        if (minimum < AWFUL_BAD && (oldL !== P.easyLine || r === null)) {
          // Create new active nodes for the best feasible breaks just found (TeX §836).
          if (!after) after = afterBreak(b);
          minimum = adjDemerits >= AWFUL_BAD - minimum ? AWFUL_BAD - 1 : minimum + Math.abs(adjDemerits);
          for (let fit = VERY_LOOSE; fit >= TIGHT; fit--) {
            if (minimal[fit] <= minimum) {
              const passive: Passive = { pos: b, prev: bestPlace[fit] };
              active.splice(k, 0, { ...after, line: bestLine[fit] + 1, fitness: fit, hyphenated: flagged, demerits: minimal[fit], passive });
              k++;
            }
            minimal[fit] = AWFUL_BAD;
          }
          minimum = AWFUL_BAD;
        }
        if (r === null) return;
        if (l > P.easyLine) {
          lineW = P.lineWidth(l);
          oldL = Number.MAX_SAFE_INTEGER;
        } else {
          oldL = l;
          lineW = P.lineWidth(l);
        }
      }
      if (r === null) return; // unreachable: a null r always has a larger line number
      // Badness and fitness of the line from r to b (TeX §851-§853).
      let shortfall = lineW - (curW - r.w);
      if (mt) {
        // pdfTeX's try_break: protrusion gives the line more room; expansion absorbs the
        // shortfall first, leaving half a step when it can absorb all of it.
        shortfall += r.lp + rp;
        if (E && shortfall !== 0) {
          const ew = curE - r.e;
          if (shortfall > 0) {
            const fs = (ew * mt.stretch) / 1000;
            if (fs > 0) shortfall = fs > shortfall ? fs / (mt.stretch / mt.step) / 2 : shortfall - fs;
          } else {
            const fz = (ew * mt.shrink) / 1000;
            if (fz > 0) shortfall = fz > -shortfall ? -(fz / (mt.shrink / mt.step)) / 2 : shortfall + fz;
          }
        }
      }
      if (Math.abs(shortfall) < LENGTH_EPS) shortfall = 0;
      let bad: number;
      let fit: number;
      if (shortfall > 0) {
        if (curS1 - r.s1 !== 0 || curS2 - r.s2 !== 0 || curS3 - r.s3 !== 0) {
          bad = 0;
          fit = DECENT;
        } else {
          bad = badness(shortfall, curS0 - r.s0);
          fit = bad > 12 ? (bad > 99 ? VERY_LOOSE : LOOSE) : DECENT;
        }
      } else {
        const shrink = curZ - r.z;
        bad = -shortfall > shrink + LENGTH_EPS ? INF_BAD + 1 : badness(Math.min(-shortfall, shrink), shrink);
        fit = bad > 12 ? TIGHT : DECENT;
      }
      let artificial = false;
      let stays: boolean;
      if (bad > INF_BAD || pi <= EJECT_PENALTY) {
        // r can no longer start a line that reaches past b.
        // TeX sets artificial demerits whenever this is the last hope; doing it only for an
        // infeasible line picks the same breaks and keeps the reported demerits meaningful.
        if (finalPass && minimum === AWFUL_BAD && active.length === 1 && k === 0 && bad > threshold) artificial = true;
        else if (bad > threshold) {
          active.splice(k, 1);
          continue;
        }
        stays = false;
      } else {
        if (bad > threshold) {
          k++;
          continue;
        }
        stays = true;
      }
      // Record a feasible break (TeX §855, demerits §859).
      let d: number;
      if (artificial) {
        d = 0;
        P.stats.artificial = true;
      }
      else {
        d = linePenalty + bad;
        d = Math.abs(d) >= 10000 ? 100000000 : d * d;
        if (pi !== 0) {
          if (pi > 0) d += pi * pi;
          else if (pi > EJECT_PENALTY) d -= pi * pi;
        }
        if (flagged && r.hyphenated) d += last ? P.finalHyphenDemerits : P.doubleHyphenDemerits;
        if (Math.abs(fit - r.fitness) > 1) d += adjDemerits;
      }
      d += r.demerits;
      if (d <= minimal[fit]) {
        minimal[fit] = d;
        bestPlace[fit] = r.passive;
        bestLine[fit] = l;
        if (d < minimum) minimum = d;
      }
      if (stays) k++;
      else active.splice(k, 1);
    }
  };

  /** Totals at the first item that survives a break at b (glue, kerns and penalties after it are discarded; marks are skipped over). */
  const afterBreak = (b: number) => {
    let j = b + 1;
    while (j < n) {
      const t = list[j].t;
      if (t === "glue" || t === "kern" || t === "penalty" || MARK_TYPES.has(t)) j++;
      else break;
    }
    // Marks skipped above stay in the line but have no width.
    return { pos: b, w: W[j], s0: S0[j], s1: S1[j], s2: S2[j], s3: S3[j], z: Z[j], e: E ? E[j] : 0, lp: mt?.protrusion ? leftProtrusion(list, j) : 0 };
  };

  for (let i = 0; i < n; i++) {
    const it = list[i];
    if (it.t === "glue") {
      if (i > 0 && isBoxLike(list[i - 1])) tryBreak(i, 0, false, false);
    } else if (it.t === "kern") {
      if ((it.subtype === undefined || it.subtype === "normal") && list[i + 1]?.t === "glue") tryBreak(i, 0, false, false);
    } else if (it.t === "penalty") {
      if (it.penalty < INF_PENALTY && (P.secondPass || (it as Discretionary).hyphenation !== "auto")) {
        const last = i === n - 1;
        // The final break counts as hyphenated so \finalhyphendemerits applies (TeX §873).
        tryBreak(i, it.penalty, last || !!it.flagged, last);
      }
    }
    if (active.length > P.stats.maxActive) P.stats.maxActive = active.length;
    if (active.length === 0) return null;
  }
  return active.length ? active : null;
}

/**
 * The vertical list of a broken paragraph with TeX's inter-line penalties
 * (§890): \interlinepenalty after every line but the last, plus
 * \clubpenalty after the first, \widowpenalty after the second-last and
 * \brokenpenalty after a line that ends with a hyphen.
 */
export function paragraphPenalties(
  result: Pick<LineBreakResult, "lines" | "info">,
  opts: { interlinePenalty?: number; clubPenalty?: number; widowPenalty?: number; brokenPenalty?: number } = {},
): (HBox | Penalty)[] {
  const out: (HBox | Penalty)[] = [];
  const n = result.lines.length;
  for (let j = 0; j < n; j++) {
    out.push(result.lines[j]);
    if (j === n - 1) break;
    let pen = opts.interlinePenalty ?? 0;
    if (j === 0) pen += opts.clubPenalty ?? 150;
    if (j === n - 2) pen += opts.widowPenalty ?? 150;
    if (result.info[j]?.hyphenated) pen += opts.brokenPenalty ?? 100;
    if (pen !== 0) out.push({ t: "penalty", penalty: Math.min(pen, INF_PENALTY) });
  }
  return out;
}
