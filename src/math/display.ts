/**
 * Display math: centring in the line, equation tags at the right margin,
 * and the row layouts of the display environments (align, gather,
 * multline, flalign, alignat, eqnarray).
 *
 * A single-line display follows TeX's rule for \eqno: the formula is
 * centred in the line; when the tag would come closer than a quad, the
 * formula is centred in the space left of the tag; when even that does not
 * fit, the tag goes on a line of its own below, flush right. Multi-row
 * environments centre the whole alignment, move it left if a tag needs the
 * room, and push a row's tag below the row when it still does not fit.
 */

import type { HBox, HNode, VBox } from "../layout/types.js";
import type { ArrayNode, Formula, MathList, TagSpec, TextItem } from "./ast.js";
import { type Table, interline, layoutTable } from "./arrays.js";
import { boxWith, hpack, kernNode, vstack, type VPlaced } from "./boxes.js";
import { type Ctx, D, layoutList, textBox } from "./layout.js";
import { PLAIN } from "./metrics.js";

export interface DisplayOptions {
  lineWidth?: number;
  tags?: (string | null)[] | string;
}

interface Line {
  box: HBox;
  /** Spacing rule to the previous line: table interline or plain baselineskip. */
  table?: Pick<Table, "baselineSkip" | "lineSkip" | "lineSkipLimit" | "touch">;
}

const TEXT_FONT = { family: "rm", bold: false, italic: false } as const;

function tagBox(tag: TagSpec | string, ctx: Ctx): HBox {
  if (typeof tag === "string") return textBox([{ k: "chars", s: `(${tag})`, font: TEXT_FONT }], ctx.base, ctx);
  const items: TextItem[] = tag.star ? tag.body : [{ k: "chars", s: "(", font: TEXT_FONT }, ...tag.body, { k: "chars", s: ")", font: TEXT_FONT }];
  return textBox(items, ctx.base, ctx);
}

/** The tag of row i: an explicit \tag wins, \notag removes the number, else the caller's tag. */
function rowTag(i: number, rows: number, explicit: TagSpec | undefined, notag: boolean | undefined, tags: DisplayOptions["tags"], lastGetsString: boolean): TagSpec | string | null {
  if (explicit) return explicit;
  if (notag) return null;
  if (Array.isArray(tags)) return tags[i] ?? null;
  if (typeof tags === "string") return !lastGetsString || i === rows - 1 ? tags : null;
  return null;
}

/** Is the formula one top-level display environment (align, gather, ...)? */
function displayEnv(f: Formula): ArrayNode | null {
  const items = f.body.filter((n) => !(n.type === "space" || n.type === "style"));
  if (items.length === 1 && items[0]!.type === "array" && items[0]!.display) return items[0]!;
  return null;
}

export function composeDisplay(f: Formula, ctx: Ctx, opts: DisplayOptions): HBox {
  const quad = ctx.base;
  const env = displayEnv(f);
  if (f.rows && f.rows.length > 1) {
    // \\ at the top level of display math: centred rows, like gather*.
    const node: ArrayNode = {
      type: "array",
      env: "gather*",
      kind: "gathered",
      rows: f.rows.map((r) => ({ cells: [r.body], hlines: 0, pos: r.pos, tag: r.tag, notag: r.notag })),
      hlinesBelow: 0,
      style: "display",
      vpos: "c",
      display: true,
      arrayStretch: 1,
      outerSep: false,
      pos: 0,
    };
    return tableDisplay(node, ctx, opts, quad);
  }
  if (env) return tableDisplay(env, ctx, opts, quad);
  // A single formula.
  const box = layoutList(f.body, D, ctx).box;
  const tag = rowTag(0, 1, f.tag, f.notag, Array.isArray(opts.tags) ? (opts.tags.find((t) => t !== null) ?? undefined) : opts.tags, false);
  return singleLine(box, tag ? tagBox(tag, ctx) : null, ctx, opts.lineWidth, quad);
}

function singleLine(box: HBox, tag: HBox | null, ctx: Ctx, lineWidth: number | undefined, quad: number): HBox {
  const w = box.width;
  const e = tag ? tag.width : 0;
  const q = tag ? e + quad : 0;
  const z = lineWidth ?? w + q;
  if (!tag) {
    const d = Math.max(0, (z - w) / 2);
    return lineOf([kernNode(d), box], z, box);
  }
  if (w + q <= z) {
    let d = (z - w) / 2;
    if (d < 2 * e) d = (z - w - e) / 2;
    const kids: HNode[] = [kernNode(d), box, kernNode(z - d - w - e), tag];
    return lineOf(kids, z, box, tag);
  }
  // The tag goes on its own line below, flush right.
  const d = Math.max(0, (z - w) / 2);
  const first = lineOf([kernNode(d), box], z, box);
  const second = lineOf([kernNode(Math.max(0, z - e)), tag], z, tag);
  return stackLines([{ box: first }, { box: second }], z, ctx);
}

function lineOf(kids: HNode[], z: number, ...boxes: HBox[]): HBox {
  const b = hpack(kids);
  let h = b.height;
  let d = b.depth;
  for (const x of boxes) {
    h = Math.max(h, x.height - (x.shift ?? 0));
    d = Math.max(d, x.depth + (x.shift ?? 0));
  }
  return boxWith(b.children, z, h, d);
}

/** Stack display lines; the result's baseline is the first line's. */
function stackLines(lines: Line[], z: number, ctx: Ctx): HBox {
  if (lines.length === 1) return lines[0]!.box;
  const plain = { baselineSkip: PLAIN.baselineSkip * ctx.base, lineSkip: PLAIN.lineSkip * ctx.base, lineSkipLimit: PLAIN.lineSkipLimit * ctx.base, touch: false };
  const items: VPlaced[] = [];
  let base = 0;
  lines.forEach((l, i) => {
    if (i > 0) {
      const prev = lines[i - 1]!.box;
      base = base - prev.depth - interline(l.table ?? plain, prev.depth, l.box.height) - l.box.height;
    }
    items.push({ node: l.box, base });
  });
  const v: VBox = vstack(items);
  return boxWith([v], z, v.height, v.depth);
}

function tableDisplay(node: ArrayNode, ctx: Ctx, opts: DisplayOptions, quad: number): HBox {
  const n = node.rows.length;
  const multline = node.kind === "multline";
  const tags = node.rows.map((r, i) => {
    const t = rowTag(i, n, r.tag, r.notag, opts.tags, true);
    return t ? tagBox(t, ctx) : null;
  });
  const maxTag = Math.max(0, ...tags.map((t) => t?.width ?? 0));
  if (multline) return multlineDisplay(node, tags, ctx, opts);
  const flalign = node.env.startsWith("flalign");
  // First pass at the default pair gap to learn the content width.
  let table = layoutTable(node, D, ctx);
  const z0 = opts.lineWidth;
  const ncols = Math.max(1, ...node.rows.map((r) => r.cells.length));
  const pairs = Math.ceil(ncols / 2);
  if (node.kind === "aligned" && !node.pairs && pairs > 1 && z0 !== undefined) {
    const gap = PLAIN.minAlignSep * ctx.base;
    const content = table.width - (pairs - 1) * gap;
    if (flalign) {
      // Pairs go to the margins; the tags keep their own room at the right.
      const room = z0 - (maxTag ? maxTag + quad : 0);
      const spread = Math.max(gap, (room - content) / (pairs - 1));
      const gaps = new Array<number>(ncols + 1).fill(0);
      for (let j = 2; j < ncols; j += 2) gaps[j] = spread;
      table = layoutTable(node, D, ctx, { gaps });
    } else {
      const spread = Math.max(gap, (z0 - maxTag - (maxTag ? quad : 0) - content) / (pairs + 1));
      table = layoutTable(node, D, ctx, { pairGap: spread });
    }
  }
  const B = table.width;
  const z = z0 ?? B + (maxTag ? quad + maxTag : 0);
  let L = flalign ? 0 : Math.max(0, (z - B) / 2);
  if (!flalign) {
    // Move the block left when a tag needs the room (never past the margin).
    for (let i = 0; i < n; i++) {
      const t = tags[i];
      if (!t) continue;
      const room = z - t.width - quad - table.rows[i]!.contentRight;
      if (room < L) L = Math.max(0, room);
    }
  }
  const lines: Line[] = [];
  table.rows.forEach((row, i) => {
    const r = node.rows[i]!;
    if (r.intertext) lines.push({ box: lineOf([textBox(r.intertext, ctx.base, ctx)], z) });
    const t = tags[i];
    const rowBox = row.box;
    const kids: HNode[] = [kernNode(L), rowBox];
    let below: HBox | null = null;
    if (t) {
      const fits = L + row.contentRight + quad <= z - t.width + 1e-6;
      if (fits) kids.push(kernNode(z - L - B - t.width), t);
      else below = lineOf([kernNode(Math.max(0, z - t.width)), t], z, t);
    }
    const line = lineOf(kids, z, rowBox, ...(t && !below ? [t] : []));
    // rows keep the table's interline rule (and \\[dim] gaps)
    const prevGap = i > 0 ? table.rows[i - 1]!.gapAfter : 0;
    lines.push({ box: prevGap ? boxWith(line.children, z, line.height + prevGap, line.depth) : line, table: i > 0 ? table : undefined });
    if (below) lines.push({ box: below });
  });
  return stackLines(lines, z, ctx);
}

function multlineDisplay(node: ArrayNode, tags: (HBox | null)[], ctx: Ctx, opts: DisplayOptions): HBox {
  const gap = PLAIN.multlineGap * ctx.base;
  const tagGap = PLAIN.multlineTagGap * ctx.base;
  const boxes = node.rows.map((r) => layoutList(r.cells[0] ?? ([] as MathList), D, ctx).box);
  const n = boxes.length;
  const lastTag = tags[n - 1] ?? null;
  const widest = Math.max(0, ...boxes.map((b) => b.width));
  const z = opts.lineWidth ?? widest + 2 * gap + (lastTag ? lastTag.width + tagGap : 0);
  const lines: Line[] = [];
  const table = { baselineSkip: (PLAIN.baselineSkip + PLAIN.jot) * ctx.base, lineSkip: (PLAIN.lineSkip + PLAIN.jot) * ctx.base, lineSkipLimit: PLAIN.jot * ctx.base, touch: false };
  boxes.forEach((b, i) => {
    let left: number;
    if (n === 1) left = Math.max(0, (z - b.width - (lastTag ? lastTag.width + tagGap : 0)) / 2);
    else if (i === 0) left = gap;
    else if (i === n - 1) left = z - b.width - (lastTag ? lastTag.width + tagGap : gap);
    else left = (z - b.width) / 2;
    left = Math.max(0, left);
    const kids: HNode[] = [kernNode(left), b];
    const t = i === n - 1 ? lastTag : (tags[i] ?? null);
    if (t) kids.push(kernNode(Math.max(0, z - left - b.width - t.width)), t);
    lines.push({ box: lineOf(kids, z, b, ...(t ? [t] : [])), table: i > 0 ? table : undefined });
  });
  return stackLines(lines, z, ctx);
}
