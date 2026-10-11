/**
 * Page building (The TeXbook ch. 15; tex.web §980-§1028), with LaTeX-style
 * float placement.
 *
 * The builder moves items from a vertical list onto the current page. Glue,
 * kerns and penalties at the top of a page are discarded, and the first box
 * gets \topskip glue so its baseline lands at a fixed distance from the top.
 * At every legal breakpoint it computes TeX's page cost from the page's
 * badness and the penalty there, remembers the cheapest break so far, and
 * when the page overflows (or a penalty forces a break) it ends the page at
 * that best break and starts over from there.
 *
 * Footnotes (Mark "footnote" inside a line) shrink the page as their line is
 * added, as TeX's \insert does: the content goes to the foot of that page,
 * below a skip and a short rule; a footnote that does not fit is split, and
 * if it cannot be split the line and its note move on together.
 *
 * Floats (Mark "float") are placed "here" when they fit on the current page,
 * else at the top of a later page, keeping document order.
 *
 * Because the builder knows where everything lands, it returns a map from
 * every anchor to its page and position.
 */

import { paragraphPenalties } from "./linebreak.js";
import { AWFUL_BAD, INF_BAD, badness, vpack } from "./pack.js";
import type { Color, Drawing, Glue, HBox, Image, Mark, Rule, VBox, VNode } from "./types.js";
import { EJECT_PENALTY, INF_PENALTY } from "./types.js";
import { Walker } from "./walk.js";

/** TeX's ignore_depth: no interline glue before the next box. */
export const IGNORE_DEPTH = -1000;
const DEPLORABLE = 100000;
const EPS = 1e-6;

export type GlueSpec = Glue | number;
type FloatMark = Extract<Mark, { t: "float" }>;
type FootnoteMark = Extract<Mark, { t: "footnote" }>;
type OutlineMark = Extract<Mark, { t: "outline" }>;

export function toGlue(g: GlueSpec | undefined, fallback = 0): Glue {
  if (g === undefined) return { t: "glue", width: fallback, stretch: 0, stretchOrder: 0, shrink: 0, shrinkOrder: 0 };
  if (typeof g === "number") return { t: "glue", width: g, stretch: 0, stretchOrder: 0, shrink: 0, shrinkOrder: 0 };
  return g;
}

// ---------------------------------------------------------- interline glue

export interface InterlineOptions {
  /** Distance between baselines (\baselineskip). */
  baselineSkip: GlueSpec;
  /** Glue used when lines would come closer than lineSkipLimit (\lineskip). Default 1pt. */
  lineSkip?: GlueSpec;
  /** \lineskiplimit. Default 0. */
  lineSkipLimit?: number;
}

/** TeX's interline glue before a box of height `height` after a box of depth `prevDepth` (§679). */
export function interlineGlue(prevDepth: number, height: number, o: InterlineOptions): Glue | null {
  if (prevDepth <= IGNORE_DEPTH) return null;
  const bs = toGlue(o.baselineSkip);
  const d = bs.width - prevDepth - height;
  if (d < (o.lineSkipLimit ?? 0)) return { ...toGlue(o.lineSkip, 1) };
  return { ...bs, width: d };
}

type BoxLike = HBox | VBox | Image | Drawing;

function isBoxLike(n: VNode | undefined): n is BoxLike | Rule {
  return !!n && (n.t === "hbox" || n.t === "vbox" || n.t === "image" || n.t === "drawing" || n.t === "rule");
}

function dims(n: VNode): [number, number] {
  switch (n.t) {
    case "hbox":
    case "vbox":
    case "drawing":
      return [n.height, n.depth];
    case "image":
      return [n.height, 0];
    case "rule":
      return [n.height ?? 0, n.depth ?? 0];
    default:
      return [0, 0];
  }
}

/** Lines that VListBuilder.paragraph laid down: which line of how many (for the widow and orphan lint). */
const PARAGRAPH_LINES = new WeakMap<object, { index: number; count: number }>();

/** The page a float's content was met on in the text (where its source is), before it was placed. */
const FLOAT_SOURCE = new WeakMap<object, number>();

/** The page whose text holds a float's source, for the float placement lint. */
export function floatSourcePage(content: object): number | undefined {
  return FLOAT_SOURCE.get(content);
}

/** Which line of its paragraph a box is, when it is a paragraph's line. */
export function paragraphLine(n: object): { index: number; count: number } | undefined {
  return PARAGRAPH_LINES.get(n);
}

/** Builds a vertical list with interline glue, like TeX in vertical mode. */
export class VListBuilder {
  readonly list: VNode[] = [];
  /** Depth of the last box (TeX's \prevdepth); IGNORE_DEPTH suppresses the next interline glue. */
  prevDepth = IGNORE_DEPTH;

  constructor(private readonly o: InterlineOptions) {}

  box(b: BoxLike): this {
    const g = interlineGlue(this.prevDepth, dims(b)[0], this.o);
    if (g) this.list.push(g);
    this.list.push(b);
    this.prevDepth = dims(b)[1];
    return this;
  }

  rule(r: Rule): this {
    this.list.push(r);
    this.prevDepth = IGNORE_DEPTH;
    return this;
  }

  glue(g: GlueSpec): this {
    this.list.push(toGlue(g));
    return this;
  }

  kern(width: number): this {
    this.list.push({ t: "kern", width });
    return this;
  }

  penalty(p: number): this {
    this.list.push({ t: "penalty", penalty: p });
    return this;
  }

  mark(m: Mark): this {
    this.list.push(m);
    return this;
  }

  /** \nointerlineskip: no interline glue before the next box. */
  noInterline(): this {
    this.prevDepth = IGNORE_DEPTH;
    return this;
  }

  /** The lines of a broken paragraph, with club, widow, broken and interline penalties between them. */
  paragraph(
    result: Parameters<typeof paragraphPenalties>[0],
    penalties?: Parameters<typeof paragraphPenalties>[1],
  ): this {
    const nodes = paragraphPenalties(result, penalties);
    const count = nodes.filter((n) => n.t !== "penalty").length;
    let index = 0;
    for (const n of nodes) {
      if (n.t === "penalty") this.list.push(n);
      else {
        PARAGRAPH_LINES.set(n, { index: index++, count });
        this.box(n);
      }
    }
    return this;
  }
}

/** Inserts interline glue before every box of a vertical list (rules reset it, as in TeX). */
export function stackVList(list: readonly VNode[], o: InterlineOptions): VNode[] {
  const b = new VListBuilder(o);
  for (const n of list) {
    if (n.t === "hbox" || n.t === "vbox" || n.t === "image" || n.t === "drawing") b.box(n);
    else if (n.t === "rule") b.rule(n);
    else b.list.push(n);
  }
  return b.list;
}

// ------------------------------------------------------------------ vsplit

function precedesBreak(n: VNode | undefined): boolean {
  return !!n && n.t !== "glue" && n.t !== "kern" && n.t !== "penalty";
}

/** TeX's page/split cost for content of natural height `total` against `goal` (§974, §1005). */
function cost(total: number, goal: number, stretch: number[], shrink: number, pi: number, insertPenalties: number): { b: number; c: number } {
  let b: number;
  if (total < goal - EPS) b = stretch[1] || stretch[2] || stretch[3] ? 0 : badness(goal - total, stretch[0]);
  else if (total - goal > shrink + EPS) b = AWFUL_BAD;
  else b = badness(total - goal, shrink);
  let c: number;
  if (b < AWFUL_BAD) {
    if (pi <= EJECT_PENALTY) c = pi;
    else if (b < INF_BAD) c = b + pi + insertPenalties;
    else c = DEPLORABLE;
  } else c = b;
  if (insertPenalties >= 10000) c = AWFUL_BAD;
  return { b, c };
}

/**
 * Splits a VBox so the first part is at most `height` tall (TeX's \vsplit
 * with vert_break's costs). Returns null when no legal break fits.
 */
export function vsplit(box: VBox, height: number, maxDepth = Infinity): { first: VBox; rest: VBox | null } | null {
  const list = box.children;
  let total = 0;
  let depth = 0;
  const stretch = [0, 0, 0, 0];
  let shrink = 0;
  let best = -1;
  let least = AWFUL_BAD;
  let seenBox = false;
  let ended = false;
  for (let i = 0; i < list.length && !ended; i++) {
    const n = list[i];
    let pi: number | undefined;
    if (n.t === "glue") pi = precedesBreak(list[i - 1]) ? 0 : undefined;
    else if (n.t === "kern") pi = list[i + 1]?.t === "glue" ? 0 : undefined;
    else if (n.t === "penalty") pi = n.penalty;
    if (pi !== undefined && pi < INF_PENALTY && seenBox) {
      const { c } = cost(total, height, stretch, shrink, pi, 0);
      if (c <= least) {
        best = i;
        least = c;
      }
      if (c === AWFUL_BAD || pi <= EJECT_PENALTY) ended = true;
      if (ended) break;
    }
    if (n.t === "glue") {
      total += depth + n.width;
      depth = 0;
      stretch[n.stretchOrder] += n.stretch;
      shrink += n.shrink;
    } else if (n.t === "kern") {
      total += depth + n.width;
      depth = 0;
    } else if (isBoxLike(n)) {
      const [h, d] = dims(n);
      total += depth + h;
      depth = d;
      seenBox = true;
    }
    if (depth > maxDepth) {
      total += depth - maxDepth;
      depth = maxDepth;
    }
  }
  if (!ended) {
    // Everything fits.
    if (total <= height + EPS) return { first: box, rest: null };
  }
  if (best <= 0) return null;
  const firstList = list.slice(0, best);
  let k = best;
  while (k < list.length && (list[k].t === "glue" || list[k].t === "kern" || list[k].t === "penalty")) k++;
  const restList = list.slice(k);
  const first = vpack(firstList, { additional: 0 }, { maxDepth }).box;
  first.width = box.width;
  let rest: VBox | null = null;
  if (restList.some(isBoxLike)) {
    rest = vpack(restList, { additional: 0 }, { maxDepth }).box;
    rest.width = box.width;
  }
  return { first, rest };
}

/** Distance from a VBox's top to its first baseline (its height when it has no box inside). */
export function firstBaseline(box: VBox): number {
  let y = 0;
  for (const c of box.children) {
    if (c.t === "glue" || c.t === "kern") y += c.width;
    else if (c.t === "hbox" || c.t === "image" || c.t === "drawing" || c.t === "rule") return y + dims(c)[0];
    else if (c.t === "vbox") return y + firstBaseline(c);
  }
  return box.height;
}

// ------------------------------------------------------------ page builder

export interface FloatOptions {
  /** Between two floats (LaTeX \floatsep). Default 12pt plus 2pt minus 2pt. */
  floatSep?: GlueSpec;
  /** Between top or bottom floats and the text (\textfloatsep). Default 20pt plus 2pt minus 4pt. */
  textFloatSep?: GlueSpec;
  /** Above and below a float placed "here" (\intextsep). Default 12pt plus 2pt minus 2pt. */
  inTextSep?: GlueSpec;
  /** Largest share of the page top floats may take (\topfraction); taller floats get a page of their own. Default 0.7. */
  topFraction?: number;
}

export interface FootnoteOptions {
  /** Space above the footnote rule (TeX's \skip\footins). Default 12pt plus 4pt minus 4pt. */
  skip?: GlueSpec;
  /** Footnote rule length; default 40% of the text width. 0 for no rule. */
  ruleWidth?: number;
  ruleThickness?: number;
  ruleColor?: Color;
  /** How far the rule sits above the first footnote's top (LaTeX: 3pt). */
  ruleRaise?: number;
  /** Baseline distance between consecutive footnotes; defaults to the page's interline settings, else none. */
  baselineSkip?: GlueSpec;
  lineSkip?: GlueSpec;
  lineSkipLimit?: number;
  /** Added to the page cost when a footnote has to be split. Default 100. */
  splitPenalty?: number;
  /** Most of the page footnotes may take (TeX's \dimen\footins). Default the text height. */
  maxHeight?: number;
}

export interface PageMarks {
  /** Every mark on the page, in reading order. */
  all: Mark[];
  /** The last outline mark before this page (TeX's \topmark). */
  top?: OutlineMark;
  /** The first outline mark on the page, else top (\firstmark). */
  first?: OutlineMark;
  /** The last outline mark on the page, else top (\botmark). */
  bot?: OutlineMark;
}

export type RunningBox = (page: number, marks: PageMarks) => HBox | undefined;

export interface PageBuilderOptions {
  /** Height of the text area (\vsize). */
  textHeight: number;
  /** Width of the text area (\hsize): the page box's width, and the footnote rule's reference. */
  textWidth: number;
  /** Distance from the top of the text area to the first baseline, at least (\topskip). Default 10pt. */
  topSkip?: GlueSpec;
  /** Deepest the last box may hang below the text area (\maxdepth). Default 4pt. */
  maxDepth?: number;
  /** When given, interline glue is inserted between the list's boxes first (see stackVList). */
  baselineSkip?: GlueSpec;
  lineSkip?: GlueSpec;
  lineSkipLimit?: number;
  /** Let pages run short instead of stretching their glue (\raggedbottom). */
  raggedBottom?: boolean;
  floats?: FloatOptions;
  footnotes?: FootnoteOptions;
  /** Builds the running header for a page (page number counts from firstPageNumber). */
  header?: RunningBox;
  footer?: RunningBox;
  /** Distance from the header's baseline up from the text area's top. Default 25pt. */
  headerSep?: number;
  /** Distance from the text area's bottom down to the footer's baseline (\footskip). Default 30pt. */
  footerSep?: number;
  firstPageNumber?: number;
  /** Overfull pages smaller than this are not reported (\vfuzz). Default 0.1pt. */
  vfuzz?: number;
}

export interface AnchorInfo {
  /** Page number (counting from firstPageNumber). */
  page: number;
  /** 0-based index of the page. */
  index: number;
  /** Position relative to the text area's top-left corner, y down: the top of the line holding the anchor. */
  x: number;
  y: number;
}

export interface Page {
  number: number;
  index: number;
  /** The whole page: header above, footer below; its top-left corner is the text area's top-left. */
  box: VBox;
  /** The text area: top floats, text, bottom floats and footnotes, packed to textHeight. */
  body: VBox;
  /** The text alone (TeX's \box255) within `body`; absent on a page of floats. */
  text?: VBox;
  header?: HBox;
  footer?: HBox;
  /** Badness of the text's glue setting on this page (TeX's page badness). */
  badness: number;
  overfull: number;
  floats: number;
  footnotes: number;
  marks: PageMarks;
  /** A page holding only floats. */
  floatPage: boolean;
}

export interface PageBuildResult {
  pages: Page[];
  anchors: Map<string, AnchorInfo>;
  overfull: { page: number; amount: number }[];
  /** Floats or footnote parts that could not be placed without overflowing a page. */
  warnings: string[];
}

interface FloatEntry {
  mark: FloatMark;
  box: VBox;
  h: number;
}

interface Snapshot {
  index: number;
  contentLen: number;
  goal: number;
  topLen: number;
  bottomLen: number;
  footLen: number;
  carryLen: number;
  deferred: FloatEntry[];
}

class PageState {
  content: VNode[] = [];
  total = 0;
  depth = 0;
  stretch = [0, 0, 0, 0];
  shrink = 0;
  hasBox = false;
  top: FloatEntry[] = [];
  topH = 0;
  bottom: FloatEntry[] = [];
  foot: VBox[] = [];
  footH = 0;
  carryOut: VBox[] = [];
  insertPenalties = 0;
  best: Snapshot | null = null;
  least = AWFUL_BAD;
  constructor(
    public goal: number,
    public deferred: FloatEntry[],
  ) {}
}

const insertCache = new WeakMap<object, (FloatMark | FootnoteMark)[]>();

/** Footnote and float marks inside a box, in reading order (they migrate out of lines, like TeX's inserts). */
function insertsIn(n: VNode): (FloatMark | FootnoteMark)[] {
  if (n.t !== "hbox" && n.t !== "vbox") return [];
  let found = insertCache.get(n);
  if (found) return found;
  found = [];
  const stack: { box: HBox | VBox; i: number }[] = [{ box: n, i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.box.children.length) {
      stack.pop();
      continue;
    }
    const c = top.box.children[top.i++];
    if (c.t === "footnote" || c.t === "float") found.push(c);
    else if (c.t === "hbox" || c.t === "vbox") stack.push({ box: c, i: 0 });
  }
  insertCache.set(n, found);
  return found;
}

/**
 * Breaks a vertical list into pages. The list holds lines (HBoxes), display
 * material, glue, kerns, penalties and marks; widow, club and heading
 * penalties are the caller's (see VListBuilder.paragraph). Interline glue is
 * added first when `baselineSkip` is given.
 */
export function buildPages(input: readonly VNode[], o: PageBuilderOptions): PageBuildResult {
  const items: VNode[] =
    o.baselineSkip !== undefined ? stackVList(input, { baselineSkip: o.baselineSkip, lineSkip: o.lineSkip, lineSkipLimit: o.lineSkipLimit }) : input.slice();
  const H = o.textHeight;
  const topSkip = toGlue(o.topSkip, 10);
  const maxDepth = o.maxDepth ?? 4;
  const fo = o.floats ?? {};
  const floatSep = toGlue(fo.floatSep ?? { t: "glue", width: 12, stretch: 2, stretchOrder: 0, shrink: 2, shrinkOrder: 0 });
  const textFloatSep = toGlue(fo.textFloatSep ?? { t: "glue", width: 20, stretch: 2, stretchOrder: 0, shrink: 4, shrinkOrder: 0 });
  const inTextSep = toGlue(fo.inTextSep ?? { t: "glue", width: 12, stretch: 2, stretchOrder: 0, shrink: 2, shrinkOrder: 0 });
  const topFraction = fo.topFraction ?? 0.7;
  const fn = o.footnotes ?? {};
  const footSkip = toGlue(fn.skip ?? { t: "glue", width: 12, stretch: 4, stretchOrder: 0, shrink: 4, shrinkOrder: 0 });
  const ruleWidth = fn.ruleWidth ?? 0.4 * o.textWidth;
  const ruleThickness = fn.ruleThickness ?? 0.4;
  const ruleRaise = fn.ruleRaise ?? 3;
  const fnInterline: InterlineOptions | undefined =
    fn.baselineSkip !== undefined
      ? { baselineSkip: fn.baselineSkip, lineSkip: fn.lineSkip, lineSkipLimit: fn.lineSkipLimit }
      : o.baselineSkip !== undefined
        ? { baselineSkip: o.baselineSkip, lineSkip: o.lineSkip, lineSkipLimit: o.lineSkipLimit }
        : undefined;
  const splitPenalty = fn.splitPenalty ?? 100;
  const maxFoot = fn.maxHeight ?? H;
  const vfuzz = o.vfuzz ?? 0.1;
  const warnings: string[] = [];

  const footGap = (prev: VBox, next: VBox): number => {
    if (!fnInterline) return 0;
    const g = interlineGlue(prev.depth, firstBaseline(next), fnInterline);
    return g ? g.width : 0;
  };

  const entry = (m: FloatMark): FloatEntry => ({ mark: m, box: m.content, h: m.content.height + m.content.depth });

  interface Built {
    body: VBox;
    text?: VBox;
    badness: number;
    overfull: number;
    floats: number;
    footnotes: number;
    floatPage: boolean;
  }
  const built: Built[] = [];

  // ---- page assembly
  const assemble = (box255: VBox | null, top: FloatEntry[], bottom: FloatEntry[], foot: VBox[], footBorrow = 0): VBox => {
    const ch: VNode[] = [];
    top.forEach((f, k) => {
      if (k > 0) ch.push(floatSep);
      ch.push(f.box);
    });
    if (top.length && box255) ch.push(textFloatSep);
    let depthAbove = top.length ? top[top.length - 1].box.depth : 0;
    if (box255) {
      ch.push(box255);
      depthAbove = box255.depth;
    }
    if (bottom.length) {
      ch.push({ ...textFloatSep, width: textFloatSep.width - depthAbove });
      bottom.forEach((f, k) => {
        if (k > 0) ch.push(floatSep);
        ch.push(f.box);
      });
      depthAbove = bottom[bottom.length - 1].box.depth;
    }
    if (foot.length) {
      ch.push({ ...footSkip, width: footSkip.width - depthAbove - footBorrow, shrink: footSkip.shrink - footBorrow });
      if (ruleWidth > 0 && ruleThickness > 0) {
        ch.push({ t: "kern", width: -ruleRaise }, { t: "rule", width: ruleWidth, height: ruleThickness, depth: 0, color: fn.ruleColor }, { t: "kern", width: ruleRaise - ruleThickness });
      }
      foot.forEach((f, k) => {
        if (k > 0) {
          const g = footGap(foot[k - 1], f);
          if (g) ch.push({ t: "kern", width: g });
        }
        ch.push(f);
      });
    }
    if (!box255) ch.push({ t: "glue", width: 0, stretch: 1, stretchOrder: 2, shrink: 0, shrinkOrder: 0 });
    const body = vpack(ch, { height: H }, { maxDepth }).box;
    body.width = o.textWidth;
    return body;
  };

  // ---- the builder proper
  let deferred: FloatEntry[] = [];
  let carry: VBox[] = [];
  let i = 0;
  let page!: PageState;

  const snapshot = (index: number): Snapshot => ({
    index,
    contentLen: page.content.length,
    goal: page.goal,
    topLen: page.top.length,
    bottomLen: page.bottom.length,
    footLen: page.foot.length,
    carryLen: page.carryOut.length,
    deferred: page.deferred.slice(),
  });

  /** Evaluates a break before the current item; true when the page must end now. */
  const tryBreak = (pi: number, index: number): boolean => {
    const { c } = cost(page.total, page.goal, page.stretch, page.shrink, pi, page.insertPenalties);
    if (c <= page.least) {
      page.best = snapshot(index);
      page.least = c;
    }
    return c === AWFUL_BAD || pi <= EJECT_PENALTY;
  };

  /** Adds one item to the page (TeX §1000-§1010); true when the page must end before it. */
  const contribute = (n: VNode, index: number, canBreak: boolean, next: VNode | undefined): boolean => {
    if (!page.hasBox) {
      if (n.t === "glue" || n.t === "kern" || n.t === "penalty") return false;
      if (!isBoxLike(n)) {
        page.content.push(n);
        return false;
      }
      const ts = { ...topSkip, width: Math.max(0, topSkip.width - dims(n)[0]) };
      page.content.push(ts);
      page.total += ts.width;
      page.stretch[ts.stretchOrder] += ts.stretch;
      page.shrink += ts.shrink;
      page.hasBox = true;
    }
    if (canBreak) {
      let pi: number | undefined;
      if (n.t === "glue") pi = precedesBreak(page.content[page.content.length - 1]) ? 0 : undefined;
      else if (n.t === "kern") pi = next?.t === "glue" ? 0 : undefined;
      else if (n.t === "penalty") pi = n.penalty;
      if (pi !== undefined && pi < INF_PENALTY && tryBreak(pi, index)) return true;
    }
    if (n.t === "glue") {
      page.total += page.depth + n.width;
      page.depth = 0;
      page.stretch[n.stretchOrder] += n.stretch;
      page.shrink += n.shrink;
    } else if (n.t === "kern") {
      page.total += page.depth + n.width;
      page.depth = 0;
    } else if (isBoxLike(n)) {
      const [h, d] = dims(n);
      page.total += page.depth + h;
      page.depth = d;
    }
    page.content.push(n);
    if (page.depth > maxDepth) {
      page.total += page.depth - maxDepth;
      page.depth = maxDepth;
    }
    return false;
  };

  const placeFootnote = (box: VBox) => {
    const first = page.foot.length === 0;
    if (first) {
      page.goal -= footSkip.width;
      page.stretch[footSkip.stretchOrder] += footSkip.stretch;
      page.shrink += footSkip.shrink;
    }
    const gap = first ? 0 : footGap(page.foot[page.foot.length - 1], box);
    const h = box.height + box.depth;
    const room = Math.min(page.goal - page.total - page.depth + page.shrink, maxFoot - page.footH);
    if (h + gap <= room + EPS) {
      page.foot.push(box);
      page.goal -= h + gap;
      page.footH += h + gap;
      return;
    }
    const avail = Math.min(page.goal - page.total - page.depth, maxFoot - page.footH) - gap;
    const parts = avail > 0 ? vsplit(box, avail, maxDepth) : null;
    if (parts && parts.rest) {
      const fh = parts.first.height + parts.first.depth;
      page.foot.push(parts.first);
      page.goal -= fh + gap;
      page.footH += fh + gap;
      page.carryOut.push(parts.rest);
      page.insertPenalties += splitPenalty;
      return;
    }
    // Cannot split: place it whole. If the page now overflows, it ends before
    // this footnote's line, and line and note move on together.
    page.foot.push(box);
    page.goal -= h + gap;
    page.footH += h + gap;
  };

  /** A float met in the text; true when the page must end. */
  const placeFloat = (f: FloatEntry, index: number, inLine: boolean, next: VNode | undefined): boolean => {
    const p = f.mark.placement;
    if (p !== "page" && page.deferred.length === 0) {
      if (p === "here") {
        const need = 2 * inTextSep.width + f.h;
        if (page.total + page.depth + need <= page.goal + EPS) {
          // In the flow: breakable before it only when it stands in the vertical list itself.
          if (contribute(inTextSep, index, !inLine, f.box)) return true;
          if (contribute(f.box, index, false, undefined)) return true;
          return contribute(inTextSep, index + 1, true, next);
        }
      } else {
        const sep = p === "top" ? (page.top.length ? floatSep.width : textFloatSep.width) : page.bottom.length ? floatSep.width : textFloatSep.width;
        const need = f.h + sep;
        const fits = page.total + page.depth + need <= page.goal + EPS;
        if (p === "top" && fits && page.topH + need <= topFraction * H + EPS) {
          page.top.push(f);
          page.topH += need;
          page.goal -= need;
          return false;
        }
        if (p === "bottom" && fits) {
          page.bottom.push(f);
          page.goal -= need;
          return false;
        }
      }
    }
    page.deferred.push(f);
    return false;
  };

  /** Moves waiting floats to the top of a new page; returns a float page when the first one needs a page to itself. */
  const startPage = (flush: boolean): Built | null => {
    page = new PageState(H, deferred);
    deferred = [];
    const carried = carry;
    carry = [];
    for (const c of carried) placeFootnote(c);
    if (page.foot.length === 0 && page.deferred.length) {
      const head = page.deferred[0];
      if (flush || head.mark.placement === "page" || head.h + textFloatSep.width > topFraction * H) {
        // A float page: the first waiting float plus those after it that fit, top-aligned.
        const fl: FloatEntry[] = [page.deferred.shift()!];
        let used = fl[0].h;
        if (used > H + EPS) warnings.push(`float taller than the text area by ${(used - H).toFixed(2)}pt`);
        while (page.deferred.length) {
          const f = page.deferred[0];
          const small = f.mark.placement !== "page" && f.h + textFloatSep.width <= topFraction * H;
          if ((!flush && small) || used + floatSep.width + f.h > H + EPS) break;
          fl.push(page.deferred.shift()!);
          used += floatSep.width + f.h;
        }
        deferred = page.deferred;
        const body = assemble(null, fl, [], []);
        return { body, badness: 0, overfull: 0, floats: fl.length, footnotes: 0, floatPage: true };
      }
    }
    while (page.deferred.length) {
      const f = page.deferred[0];
      if (f.mark.placement === "page") break;
      const need = f.h + (page.top.length ? floatSep.width : textFloatSep.width);
      if (page.topH + need > topFraction * H + EPS || need > page.goal + EPS) break;
      page.top.push(f);
      page.topH += need;
      page.goal -= need;
      page.deferred.shift();
    }
    return null;
  };

  const finish = (best: Snapshot | null) => {
    const content = best ? page.content.slice(0, best.contentLen) : page.content.slice();
    const top = best ? page.top.slice(0, best.topLen) : page.top;
    const bottom = best ? page.bottom.slice(0, best.bottomLen) : page.bottom;
    const foot = best ? page.foot.slice(0, best.footLen) : page.foot;
    carry = best ? page.carryOut.slice(0, best.carryLen) : page.carryOut;
    deferred = best ? best.deferred : page.deferred;
    const goal = best ? best.goal : page.goal;
    const fill = !best || o.raggedBottom;
    // Fill glue after the last line would make that line's depth count as height, which the page total
    // (like TeX's \pagetotal) leaves out; pack with room for it and keep it below the box as depth.
    let lastDepth = 0;
    if (fill) {
      for (let k = content.length - 1; k >= 0; k--) {
        const n = content[k];
        if (isBoxLike(n)) {
          lastDepth = Math.min(Math.max(0, dims(n)[1]), maxDepth);
          break;
        }
        if (n.t !== "glue" && n.t !== "kern" && n.t !== "penalty") continue; // marks
        break;
      }
      content.push({ t: "glue", width: 0, stretch: 1, stretchOrder: 2, shrink: 0, shrinkOrder: 0 });
    }
    let packed = vpack(content, { height: goal + lastDepth }, { maxDepth });
    // The page total counted the footnote skip's shrink (as TeX's \pagetotal counts \skip\footins), but that
    // glue sits outside the text box. LaTeX's output routine unboxes \box255 into one list with the notes,
    // so the text may use it; here the text box borrows what it needs and the skip shrinks by as much.
    let borrow = 0;
    if (packed.overfull > 0 && foot.length && footSkip.shrink > 0 && footSkip.shrinkOrder === 0) {
      borrow = Math.min(packed.overfull, footSkip.shrink);
      packed = vpack(content, { height: goal + lastDepth + borrow }, { maxDepth });
    }
    if (lastDepth) {
      packed.box.height -= lastDepth;
      packed.box.depth += lastDepth;
    }
    packed.box.width = o.textWidth;
    const body = assemble(packed.box, top, bottom, foot, borrow);
    built.push({
      body,
      text: packed.box,
      badness: packed.badness === 1000000 ? INF_BAD : packed.badness,
      overfull: packed.overfull,
      floats: top.length + bottom.length,
      footnotes: foot.length,
      floatPage: false,
    });
  };

  let guard = 0;
  const guardLimit = 4 * items.length + 1000;
  while (i < items.length || deferred.length || carry.length) {
    if (++guard > guardLimit) throw new Error("page builder made no progress (internal error)");
    const fp = startPage(i >= items.length);
    if (fp) {
      built.push(fp);
      continue;
    }
    const start = i;
    let fired = false;
    for (let j = i; j < items.length && !fired; j++) {
      const n = items[j];
      const next = items[j + 1];
      if (n.t === "float") {
        if (!FLOAT_SOURCE.has(n.content)) FLOAT_SOURCE.set(n.content, built.length + (o.firstPageNumber ?? 1));
        fired = placeFloat(entry(n), j, false, next);
        continue;
      }
      if (n.t === "footnote") {
        placeFootnote(n.content);
        continue;
      }
      if (contribute(n, j, true, next)) {
        fired = true;
        break;
      }
      for (const m of insertsIn(n)) {
        if (m.t === "footnote") placeFootnote(m.content);
      }
      for (const m of insertsIn(n)) {
        if (m.t === "float" && !FLOAT_SOURCE.has(m.content)) FLOAT_SOURCE.set(m.content, built.length + (o.firstPageNumber ?? 1));
        if (m.t === "float" && placeFloat(entry(m), j, true, next)) {
          fired = true;
          break;
        }
      }
    }
    // End of the list on a page that no longer fits: TeX's \end supplies \vfill\penalty-10000, a forced
    // break that is awful_bad here, so the page goes back to its best earlier break like any other.
    const overfullAtEnd = !fired && page.hasBox && page.best !== null && page.total - page.goal > page.shrink + EPS;
    if ((fired || overfullAtEnd) && page.best) {
      const best = page.best;
      finish(best);
      // A break always lies after the page's first box, so this moves forward; the guard is belt and braces.
      i = best.index > start ? best.index : start + 1;
    } else {
      // End of the list: the last page is filled with fill, as TeX's \end does.
      const empty = !page.hasBox && !page.top.length && !page.bottom.length && !page.foot.length;
      if (!empty || (page.content.length && !built.length)) finish(null);
      else {
        // Nothing to print: trailing marks stay on the last page; waiting floats get pages of their own.
        if (page.content.length) built[built.length - 1].body.children.push(...page.content);
        deferred = page.deferred;
        carry = page.carryOut;
      }
      i = items.length;
    }
  }

  // ---- running heads, page boxes, marks and anchors
  const first = o.firstPageNumber ?? 1;
  const headerSep = o.headerSep ?? 25;
  const footerSep = o.footerSep ?? 30;
  const pages: Page[] = [];
  const anchors = new Map<string, AnchorInfo>();
  const overfull: PageBuildResult["overfull"] = [];
  let lastOutline: OutlineMark | undefined;
  built.forEach((b, index) => {
    const number = first + index;
    const all: Mark[] = [];
    new Walker({ mark: (m) => all.push(m) }).vbox(b.body, 0, 0);
    const outlines = all.filter((m): m is OutlineMark => m.t === "outline");
    const marks: PageMarks = { all, top: lastOutline, first: outlines[0] ?? lastOutline, bot: outlines[outlines.length - 1] ?? lastOutline };
    if (outlines.length) lastOutline = outlines[outlines.length - 1];
    const header = o.header?.(number, marks);
    const footer = o.footer?.(number, marks);
    const ch: VNode[] = [];
    if (header) ch.push({ t: "kern", width: -(headerSep + header.height) }, header, { t: "kern", width: headerSep - header.depth });
    ch.push(b.body);
    if (footer) ch.push({ t: "kern", width: footerSep - b.body.depth - footer.height }, footer);
    const box = vpack(ch).box;
    box.width = o.textWidth;
    new Walker({
      anchor: (id, x, y) => {
        if (!anchors.has(id)) anchors.set(id, { page: number, index, x, y });
      },
    }).vbox(box, 0, 0);
    if (b.overfull > vfuzz) overfull.push({ page: number, amount: b.overfull });
    pages.push({
      number,
      index,
      box,
      body: b.body,
      ...(b.text ? { text: b.text } : {}),
      header,
      footer,
      badness: b.badness,
      overfull: b.overfull,
      floats: b.floats,
      footnotes: b.footnotes,
      marks,
      floatPage: b.floatPage,
    });
  });
  return { pages, anchors, overfull, warnings };
}

// -------------------------------------------------------------- iteration

function samePages(a: ReadonlyMap<string, AnchorInfo>, b: ReadonlyMap<string, AnchorInfo>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, info] of a) if (b.get(id)?.page !== info.page) return false;
  return true;
}

/**
 * Runs a layout until its anchor map stops changing, for documents whose
 * content depends on page numbers (a table of contents can change length and
 * push everything after it). `build` receives the previous pass's anchors
 * (undefined on the first pass) and must return a result with `anchors`.
 */
export function layoutUntilStable<R extends { anchors: ReadonlyMap<string, AnchorInfo> }>(
  build: (previous: ReadonlyMap<string, AnchorInfo> | undefined, pass: number) => R,
  maxPasses = 4,
): { result: R; passes: number; stable: boolean } {
  let prev: ReadonlyMap<string, AnchorInfo> | undefined;
  let result = build(undefined, 1);
  for (let pass = 2; pass <= Math.max(2, maxPasses); pass++) {
    prev = result.anchors;
    result = build(prev, pass);
    if (samePages(prev, result.anchors)) return { result, passes: pass, stable: true };
  }
  return { result, passes: Math.max(2, maxPasses), stable: false };
}
