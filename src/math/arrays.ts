/**
 * Arrays and alignments: matrix environments, array, cases, aligned,
 * gathered, split, alignedat, smallmatrix, \substack, and the rows of the
 * display environments (align, gather, eqnarray, ...).
 *
 * Rows of arrays and matrices carry LaTeX's strut (0.7 and 0.3 of the
 * baseline skip, times \arraystretch) and touch; columns are separated by
 * 2\arraycolsep. Rows of the amsmath alignments are spaced by the baseline
 * skip opened up by \jot. The finished table is centred on the math axis
 * unless [t] or [b] asks for the first or last row's baseline.
 */

import type { HBox, HNode } from "../layout/types.js";
import type { ArrayNode, ColSpec, MathList } from "./ast.js";
import { alignIn, boxWith, kernNode, ruleNode, shifted, vstack, type VPlaced } from "./boxes.js";
import { type Ctx, axisOf, layoutList, muOf, sizeOf, styleOf, toPt } from "./layout.js";
import { D, type Style, T } from "./style.js";
import { PLAIN, SIGMA, XI } from "./metrics.js";

export interface TableRow {
  /** The row at the table's full width, baseline at the row baseline. */
  box: HBox;
  /** Extra space after the row (\\[dim]). */
  gapAfter: number;
  hlinesAbove: number;
  /** Offsets of the content's left and right ink edges (for tag placement). */
  contentLeft: number;
  contentRight: number;
}

export interface Table {
  rows: TableRow[];
  width: number;
  /** Interline rule: rows touch (struts) or are separated by baseline skip. */
  baselineSkip: number;
  lineSkip: number;
  lineSkipLimit: number;
  touch: boolean;
  hlinesBelow: number;
  ruleWidth: number;
  /** Space between double rules. */
  ruleSep: number;
}

interface Column {
  align: "l" | "c" | "r";
  style: Style;
}

export interface TableOptions {
  /** Space between column pairs of align-like tables (default \minalignsep). */
  pairGap?: number;
  /** Override all inter-column gaps (flalign spreads pairs to the margins). */
  gaps?: number[];
}

function columnsFor(node: ArrayNode, ncols: number): Column[] {
  // Cells are new formulas in the environment's style, at full size (as in TeX).
  const cs = styleOf(node.style);
  const cols: Column[] = [];
  for (let j = 0; j < ncols; j++) {
    switch (node.kind) {
      case "array":
      case "subarray":
      case "matrix":
        cols.push({ align: node.cols?.[j]?.align ?? "c", style: cs });
        break;
      case "cases":
        cols.push({ align: "l", style: cs });
        break;
      case "aligned":
        cols.push({ align: j % 2 === 0 ? "r" : "l", style: D });
        break;
      case "gathered":
      case "multline":
        cols.push({ align: "c", style: D });
        break;
      case "eqnarray":
        cols.push({ align: j === 0 ? "r" : j === 1 ? "c" : "l", style: j === 1 ? T : D });
        break;
      default:
        cols.push({ align: "c", style: cs });
    }
  }
  return cols;
}

/** Gaps before each column and after the last (length ncols + 1), plus vertical rule positions. */
function columnGaps(node: ArrayNode, ncols: number, ctx: Ctx, opts: TableOptions): { gaps: number[]; material: (HBox | null)[]; lines: number[] } {
  const sep = PLAIN.arrayColSep * ctx.base;
  const gaps: number[] = new Array<number>(ncols + 1).fill(0);
  const material: (HBox | null)[] = new Array<HBox | null>(ncols + 1).fill(null);
  const lines: number[] = new Array<number>(ncols + 1).fill(0);
  const specs: ColSpec[] | undefined = node.cols;
  for (let j = 0; j <= ncols; j++) {
    const before = j > 0 ? specs?.[j - 1] : undefined;
    const after = j < ncols ? specs?.[j] : undefined;
    lines[j] = j < ncols ? (specs?.[j]?.lines ?? 0) : (node.trailingLines ?? 0);
    const outer = j === 0 || j === ncols;
    switch (node.kind) {
      case "array": {
        const at = before?.post ?? after?.pre;
        if (at) {
          material[j] = layoutList(at, T, ctx).box;
          gaps[j] = material[j]!.width;
        } else gaps[j] = outer ? (node.outerSep ? sep : 0) : 2 * sep;
        break;
      }
      case "matrix":
        gaps[j] = outer ? 0 : 2 * sep;
        break;
      case "smallmatrix":
        gaps[j] = outer ? 0 : 5 * muOf(T, ctx);
        break;
      case "cases":
        gaps[j] = outer ? 0 : ctx.base;
        break;
      case "aligned":
        gaps[j] = outer || j % 2 === 1 ? 0 : (opts.pairGap ?? PLAIN.minAlignSep * ctx.base);
        if (node.pairs) gaps[j] = outer || j % 2 === 1 ? 0 : 0;
        break;
      case "eqnarray":
        gaps[j] = outer ? 0 : 2 * sep;
        break;
      default:
        gaps[j] = 0;
    }
  }
  if (opts.gaps) for (let j = 0; j <= ncols && j < opts.gaps.length; j++) gaps[j] = opts.gaps[j]!;
  return { gaps, material, lines };
}

/** Lay out the cells and rows of a table (without stacking them). */
export function layoutTable(node: ArrayNode, style: Style, ctx: Ctx, opts: TableOptions = {}): Table {
  const ncols = Math.max(1, ...node.rows.map((r) => r.cells.length), node.cols?.length ?? 0);
  const cols = columnsFor(node, ncols);
  const boxes: HBox[][] = [];
  const widths = new Array<number>(ncols).fill(0);
  for (const row of node.rows) {
    const cells: HBox[] = [];
    for (let j = 0; j < ncols; j++) {
      let list: MathList = row.cells[j] ?? [];
      if (node.kind === "aligned" && j % 2 === 1 && list.length) list = [{ type: "group", body: [], pos: 0 }, ...list];
      else if (node.kind === "aligned" && j % 2 === 1) list = [];
      const b = layoutList(list, cols[j]!.style, ctx).box;
      cells.push(b);
      if (b.width > widths[j]!) widths[j] = b.width;
    }
    boxes.push(cells);
  }
  const { gaps, material, lines } = columnGaps(node, ncols, ctx, opts);
  const rw = PLAIN.arrayRuleWidth * ctx.base;
  const dsep = PLAIN.doubleRuleSep * ctx.base;
  const lineWidth = (n: number) => (n > 0 ? n * rw + (n - 1) * dsep : 0);
  let width = 0;
  for (let j = 0; j <= ncols; j++) width += gaps[j]! + lineWidth(lines[j]!) + (j < ncols ? widths[j]! : 0);
  // Row metrics
  const touch = node.kind === "array" || node.kind === "matrix" || node.kind === "cases";
  const stretch = node.arrayStretch;
  const strutH = touch ? PLAIN.strutHeight * ctx.base * stretch : node.kind === "aligned" || node.kind === "gathered" || node.kind === "eqnarray" || node.kind === "multline" ? PLAIN.strutHeight * ctx.base : 0;
  const strutD = touch ? PLAIN.strutDepth * ctx.base * stretch : strutH ? PLAIN.strutDepth * ctx.base : 0;
  const rows: TableRow[] = [];
  node.rows.forEach((row, i) => {
    const cells = boxes[i]!;
    let h = strutH;
    let d = strutD;
    for (const c of cells) {
      if (c.height > h) h = c.height;
      if (c.depth > d) d = c.depth;
    }
    const kids: HNode[] = [];
    let x = 0;
    let contentLeft = Infinity;
    let contentRight = 0;
    for (let j = 0; j <= ncols; j++) {
      // gap j: [material or space] with rules in the middle
      const g = gaps[j]!;
      const nl = lines[j]!;
      if (material[j]) {
        kids.push(material[j]!);
      } else if (nl) {
        const half = j === 0 || j === ncols ? (j === 0 ? 0 : g) : g / 2;
        if (half) kids.push(kernNode(half));
        for (let k = 0; k < nl; k++) {
          if (k) kids.push(kernNode(dsep));
          kids.push(ruleNode(rw, h, d));
        }
        if (g - half) kids.push(kernNode(g - half));
      } else if (g) kids.push(kernNode(g));
      x += g + lineWidth(nl);
      if (j < ncols) {
        const cell = cells[j]!;
        const placed = alignIn(cell, widths[j]!, cols[j]!.align);
        if (cell.width > 0) {
          const off = cols[j]!.align === "l" ? 0 : cols[j]!.align === "r" ? widths[j]! - cell.width : (widths[j]! - cell.width) / 2;
          contentLeft = Math.min(contentLeft, x + off);
          contentRight = Math.max(contentRight, x + off + cell.width);
        }
        kids.push(placed);
        x += widths[j]!;
      }
    }
    const box = boxWith(kids, width, h, d);
    const gapAfter = row.gap ? toPt(row.gap, style, ctx) : 0;
    rows.push({ box, gapAfter, hlinesAbove: row.hlines, contentLeft: contentLeft === Infinity ? 0 : contentLeft, contentRight });
  });
  let baselineSkip = 0;
  let lineSkip = 0;
  let lineSkipLimit = 0;
  if (!touch) {
    if (node.kind === "subarray") {
      const ss = sizeOf(4 as Style, ctx);
      baselineSkip = (SIGMA.num3 + SIGMA.denom2) * ss;
      lineSkip = 3 * XI.ruleThickness * ss;
      lineSkipLimit = lineSkip;
    } else if (node.kind === "smallmatrix") {
      baselineSkip = 0.6 * ctx.base;
      lineSkip = 0.15 * ctx.base;
      lineSkipLimit = lineSkip;
    } else {
      baselineSkip = (PLAIN.baselineSkip + PLAIN.jot) * ctx.base;
      lineSkip = (PLAIN.lineSkip + PLAIN.jot) * ctx.base;
      lineSkipLimit = (PLAIN.lineSkipLimit + PLAIN.jot) * ctx.base;
    }
  }
  return { rows, width, baselineSkip, lineSkip, lineSkipLimit, touch, hlinesBelow: node.hlinesBelow, ruleWidth: rw, ruleSep: dsep };
}

/** Interline space between two rows (TeX's baselineskip / lineskip rule). */
export function interline(t: Pick<Table, "baselineSkip" | "lineSkip" | "lineSkipLimit" | "touch">, prevDepth: number, nextHeight: number): number {
  if (t.touch) return 0;
  const g = t.baselineSkip - prevDepth - nextHeight;
  return g < t.lineSkipLimit ? t.lineSkip : g;
}

/** Stack the rows of a table; the first row's baseline is at 0. */
export function stackTable(t: Table): { items: VPlaced[]; lastBase: number } {
  const items: VPlaced[] = [];
  const rulesHeight = (n: number) => (n > 0 ? n * t.ruleWidth + (n - 1) * t.ruleSep : 0);
  const rules = (n: number, edge: number): number => {
    for (let k = 0; k < n; k++) {
      if (k) edge -= t.ruleSep;
      items.push({ node: ruleNode(t.width, t.ruleWidth, 0), base: edge - t.ruleWidth });
      edge -= t.ruleWidth;
    }
    return edge;
  };
  let lastBase = 0;
  let cur = 0;
  t.rows.forEach((row, i) => {
    const b = row.box;
    if (i === 0) cur = b.height + rulesHeight(row.hlinesAbove);
    if (row.hlinesAbove) cur = rules(row.hlinesAbove, cur);
    else if (i > 0) {
      const prev = t.rows[i - 1]!;
      cur -= interline(t, prev.box.depth, b.height);
    }
    const base = cur - b.height;
    items.push({ node: b, base });
    lastBase = base;
    cur = base - b.depth - row.gapAfter;
  });
  if (t.hlinesBelow) cur = rules(t.hlinesBelow, cur);
  const last = t.rows[t.rows.length - 1];
  if (last && (last.gapAfter || t.hlinesBelow)) items.push({ node: boxWith([], 0, 0, 0), base: cur });
  return { items, lastBase };
}

/** A complete inner table (matrix, aligned, cases, ...) as a list of nodes in the formula. */
export function buildArray(node: ArrayNode, style: Style, ctx: Ctx): HNode[] {
  if (!node.rows.length) return [];
  const t = layoutTable(node, style, ctx);
  const st = stackTable(t);
  const v = vstack(st.items);
  // vstack puts the baseline where items say: first row baseline at 0.
  let shift: number;
  if (node.vpos === "t") shift = 0;
  else if (node.vpos === "b") shift = st.lastBase;
  else {
    const total = v.height + v.depth;
    const a = axisOf(style, ctx);
    shift = v.height - (total / 2 + a);
  }
  return [shifted(v, shift)];
}

export function columnCount(node: ArrayNode): number {
  return Math.max(1, ...node.rows.map((r) => r.cells.length), node.cols?.length ?? 0);
}
