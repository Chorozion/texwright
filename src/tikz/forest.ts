/**
 * The forest package: trees written as brackets,
 *
 *   \begin{forest} for tree={draw} [root [a [b] [c]] [d]] \end{forest}
 *
 * Each node is `[content, options children]`. Options are forest's (for
 * tree, for children, for descendants, where/if with n children, level, n
 * and n', grow and grow', reversed, l, l sep, s sep, calign, tier, edge,
 * edge label, edge path, no edge, phantom, name, anchor, parent anchor,
 * child anchor, roof, folder, forked edges, fork sep, tikz, the before ...
 * stages, delay, insert before/after, append, prepend, /.style) and
 * otherwise TikZ node options.
 *
 * Layout is forest's: subtrees are packed as close as `s sep` allows by
 * comparing their contours level by level (Reingold and Tilford's method;
 * a subtree's contour is the extent of its nodes at each depth), so they
 * never overlap, and a parent sits over the midpoint of its first and last
 * child (calign). Siblings share one level line, at least `l` from their
 * parent and `l sep` clear of it; nodes with the same tier share a line.
 */

import { type Pt, add, dir, scale, sub } from "./geom.js";
import { type Interp, anchorPoint } from "./interp.js";
import { length, num } from "./expr.js";
import { type KV, Scanner, matchClose, parseOptions, splitTop, unbrace } from "./scan.js";
import { type GS, cloneGS } from "./state.js";
import { type Placed, commitNodes, coordNode, moveNode, nodeSpec, placeNode } from "./trees.js";

const EM = 10;
const EX = 4.305;
/** Deeper nesting is left out (and reported). */
const MAX_DEPTH = 200;
/** Nodes in one forest. */
const MAX_NODES = 4000;

interface FNode {
  content: string;
  opts: string;
  children: FNode[];
  parent?: FNode;
  level: number;
  tikzOpts: string[];
  edge: string[];
  edgeLabel: string;
  edgePath?: string;
  grow: number;
  rev: boolean;
  l: number;
  lsep: number;
  ssep: number;
  calign: string;
  calignChild: number;
  tier?: string;
  phantom: boolean;
  noEdge: boolean;
  name?: string;
  anchor: string;
  parentAnchor: string;
  childAnchor: string;
  roof: boolean;
  /** fit=band: the subtree claims its whole width at every depth below it. */
  band: boolean;
  folder: boolean;
  forked: boolean;
  forkSep?: number;
  tikz: string[];
  /** Set by `l=` and `s=` after packing (before computing xy). */
  lFixed?: number;
  sFixed?: number;
  // layout
  placed?: Placed;
  /** Extent around the anchor: x0, y0, x1, y1. */
  ext: [number, number, number, number];
  /** Offset of the anchor from the parent's anchor. */
  off: Pt;
  pos: Pt;
  lpos: number;
  spos: number;
}

type Stage = "given" | "typeset" | "pack" | "xy" | "draw";

interface Ctx {
  it: Interp;
  g: GS;
  styles: Map<string, string>;
  stage: Stage;
  queue: Map<Stage, { node: FNode; body: string }[]>;
  count: number;
  root?: FNode;
}

function newNode(content: string, opts: string, parent: FNode | undefined): FNode {
  return {
    content,
    opts,
    children: [],
    ...(parent ? { parent } : {}),
    level: parent ? parent.level + 1 : 0,
    tikzOpts: [],
    edge: [],
    edgeLabel: "",
    grow: parent?.grow ?? 270,
    rev: parent?.rev ?? false,
    l: 6 * EX,
    lsep: EX,
    ssep: 0.6666 * EM,
    calign: "midpoint",
    calignChild: 1,
    phantom: false,
    noEdge: false,
    anchor: "base",
    parentAnchor: "",
    childAnchor: "",
    roof: false,
    band: false,
    folder: false,
    forked: false,
    tikz: [],
    ext: [0, 0, 0, 0],
    off: [0, 0],
    pos: [0, 0],
    lpos: 0,
    spos: 0,
  };
}

// ---------------------------------------------------------------- reading

/** Index of the first `[` outside braces, or -1. */
function firstBracket(s: string): number {
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "[" && depth === 0) return k;
  }
  return -1;
}

/**
 * Reads the bracket tree starting at s[i] === "[". Returns the root and the
 * index after its closing bracket. Iterative, so deep nesting cannot
 * exhaust the stack; nodes deeper than MAX_DEPTH are dropped.
 */
export function parseBrackets(s: string, i: number, onTooDeep?: () => void, maxNodes = MAX_NODES): { root?: FNode; end: number; count: number } {
  let k = i;
  let root: FNode | undefined;
  const stack: FNode[] = [];
  let skipDepth = 0;
  let count = 0;
  while (k < s.length) {
    const c = s[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "]") {
      k++;
      if (skipDepth > 0) skipDepth--;
      else stack.pop();
      if (!stack.length && !skipDepth) return { root, end: k, count };
      continue;
    }
    if (c === "[") {
      if (skipDepth > 0 || stack.length >= MAX_DEPTH || count >= maxNodes) {
        if (skipDepth === 0) onTooDeep?.();
        skipDepth++;
        k++;
        // Skip this node's own text up to its next bracket.
        k = scanContent(s, k).end;
        continue;
      }
      const r = scanContent(s, k + 1);
      const parent = stack[stack.length - 1];
      const node = newNode(r.content, r.opts, parent);
      count++;
      if (parent) parent.children.push(node);
      else if (!root) root = node;
      else {
        // A second top-level tree: forest draws only one per environment.
        onTooDeep?.();
      }
      stack.push(node);
      k = r.end;
      continue;
    }
    k++;
  }
  return { root, end: s.length, count };
}

/** The content and options of a node, from after its `[` up to its first child `[` or its `]`. */
function scanContent(s: string, from: number): { content: string; opts: string; end: number } {
  let depth = 0;
  let math = false;
  let comma = -1;
  let k = from;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === "$" && comma < 0) math = !math;
      else if (!math && (c === "[" || c === "]")) break;
      else if (!math && c === "," && comma < 0) comma = k;
    }
  }
  const content = (comma < 0 ? s.slice(from, k) : s.slice(from, comma)).trim();
  const opts = comma < 0 ? "" : s.slice(comma + 1, k).trim();
  return { content: unbrace(content), opts, end: k };
}

// ---------------------------------------------------------------- options

function walk(n: FNode, f: (x: FNode) => void): void {
  const stack: FNode[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    f(x);
    for (let k = x.children.length - 1; k >= 0; k--) stack.push(x.children[k]);
  }
}

function descendants(n: FNode): FNode[] {
  const out: FNode[] = [];
  walk(n, (x) => {
    if (x !== n) out.push(x);
  });
  return out;
}

function nAttr(n: FNode, attr: string): string {
  const sibs = n.parent?.children ?? [n];
  const idx = sibs.indexOf(n);
  switch (attr) {
    case "n children":
      return String(n.children.length);
    case "level":
      return String(n.level);
    case "n":
      return String(idx + 1);
    case "n'":
      return String(sibs.length - idx);
    case "content":
      return n.content;
    case "name":
      return n.name ?? "";
    case "tier":
      return n.tier ?? "";
    case "phantom":
      return n.phantom ? "1" : "0";
  }
  return "";
}

/** A `where`/`if` condition value: `0{true}{false}` or `{0}{true}{false}`. */
function condParts(v: string): { value: string; yes: string; no: string } | undefined {
  const t = v.trim();
  let k = 0;
  let value: string;
  if (t[0] === "{") {
    const e = matchClose(t, 0);
    if (e < 0) return undefined;
    value = t.slice(1, e);
    k = e + 1;
  } else {
    const b = t.indexOf("{");
    if (b < 0) return { value: t, yes: "", no: "" };
    value = t.slice(0, b);
    k = b;
  }
  const sc = new Scanner(t.slice(k));
  const yes = sc.group("{") ?? "";
  const no = sc.group("{") ?? "";
  return { value: value.trim(), yes, no };
}

const FOREST_QUIET = new Set([
  "baseline",
  "content format",
  "math content",
  "text options",
  "node options",
  "draw tree",
  "typeset node",
  "stages",
  "sort",
  "sort by",
  "for tree'",
  "parent anchor'",
  "s",
  "x",
  "y",
  "label",
  "edges",
  "GP1",
  "nice empty nodes",
  "sn edges",
  "default preamble",
  "begin draw",
  "end draw",
  "split option",
  "TeX",
  "TeX'",
  "TeX''",
  "afterthought",
  "alias",
  "outer xsep",
  "outer ysep",
  "fork sep'",
]);

function lengthValue(v: string | undefined, current: number, op: string): number | undefined {
  const x = length(v ?? "", EM);
  if (x === undefined || !Number.isFinite(x)) return undefined;
  if (op === "+") return current + x;
  if (op === "-") return current - x;
  if (op === "*") return current * (num(v ?? "") ?? 1);
  return x;
}

/** Applies an option list to node `n`. */
function apply(ctx: Ctx, n: FNode, opts: string, depth = 0): void {
  if (!opts.trim() || depth > 20) return;
  for (const kv of parseOptions(opts)) {
    ctx.it.tick();
    applyKey(ctx, n, kv, depth);
  }
}

function applyKey(ctx: Ctx, n: FNode, { key: rawKey, value }: KV, depth: number): void {
  const key = rawKey.replace(/^\/forest\//, "").trim();
  // Style definitions and uses.
  const def = /^(.*?)\/\.(style|append style|prefix style|code)$/.exec(key);
  if (def) {
    const name = def[1].trim();
    const old = ctx.styles.get(name);
    const v = value ?? "";
    ctx.styles.set(name, def[2] === "append style" && old ? `${old}, ${v}` : def[2] === "prefix style" && old ? `${v}, ${old}` : v);
    return;
  }
  const st = ctx.styles.get(key);
  if (st !== undefined) {
    apply(ctx, n, st.replace(/#1/g, value ?? ""), depth + 1);
    return;
  }
  // l+=, s sep*=, ...
  const arith = /^(.*?)([+\-*])$/.exec(key);
  const base = arith ? arith[1].trim() : key;
  const op = arith ? arith[2] : "";
  const v = value;
  switch (base) {
    case "for tree":
      if (v) walk(n, (x) => apply(ctx, x, v, depth + 1));
      return;
    case "for children":
      if (v) for (const c of [...n.children]) apply(ctx, c, v, depth + 1);
      return;
    case "for descendants":
      if (v) for (const c of descendants(n)) apply(ctx, c, v, depth + 1);
      return;
    case "for parent":
    case "for !u":
      if (v && n.parent) apply(ctx, n.parent, v, depth + 1);
      return;
    case "for root":
    case "for root'":
      if (v && ctx.root) apply(ctx, ctx.root, v, depth + 1);
      return;
    case "for leaves":
      if (v) walk(n, (x) => !x.children.length && apply(ctx, x, v, depth + 1));
      return;
    case "for first":
    case "for 1":
      if (v && n.children[0]) apply(ctx, n.children[0], v, depth + 1);
      return;
    case "for last":
      if (v && n.children.length) apply(ctx, n.children[n.children.length - 1], v, depth + 1);
      return;
    case "delay":
      if (v) ctx.queue.get("typeset")!.push({ node: n, body: v });
      return;
    case "before typesetting nodes":
      if (v) ctx.queue.get("typeset")!.push({ node: n, body: v });
      return;
    case "before packing":
    case "before computing xy":
    case "before drawing tree": {
      if (!v) return;
      const stage: Stage = base === "before packing" ? "pack" : base === "before computing xy" ? "xy" : "draw";
      // A stage already passed runs its body at once.
      if (STAGES.indexOf(stage) <= STAGES.indexOf(ctx.stage)) apply(ctx, n, v, depth + 1);
      else ctx.queue.get(stage)!.push({ node: n, body: v });
      return;
    }
    case "insert before":
    case "insert after":
    case "append":
    case "prepend": {
      if (!v) return;
      const added = parseBrackets(v.trim(), Math.max(0, firstBracket(v.trim())), undefined, Math.max(0, MAX_NODES - ctx.count));
      if (!added.root) return;
      ctx.count += added.count;
      const target = base === "append" || base === "prepend" ? n : n.parent;
      if (!target) return;
      added.root.parent = target;
      walk(added.root, (x) => {
        x.level = (x.parent?.level ?? 0) + 1;
        x.grow = x.parent?.grow ?? x.grow;
        x.rev = x.parent?.rev ?? x.rev;
      });
      const at = target.children.indexOf(n);
      if (base === "append") target.children.push(added.root);
      else if (base === "prepend") target.children.unshift(added.root);
      else target.children.splice(base === "insert before" ? at : at + 1, 0, added.root);
      walk(added.root, (x) => apply(ctx, x, x.opts, depth + 1));
      return;
    }
    case "content":
      n.content = unbrace(v ?? "");
      return;
    case "math content":
      n.content = `$${n.content}$`;
      return;
    case "grow":
    case "grow'": {
      const a = growDeg(v);
      if (a !== undefined) {
        n.grow = a;
        n.rev = base === "grow'";
      }
      return;
    }
    case "reversed":
      n.rev = v === undefined || v === "true";
      return;
    case "l":
    case "l'": {
      const x = lengthValue(v, n.lFixed ?? n.l, op);
      if (x === undefined) return;
      if (ctx.stage === "xy" || ctx.stage === "draw") n.lFixed = x;
      else n.l = x;
      return;
    }
    case "s":
    case "s'": {
      if (ctx.stage !== "xy") return;
      const x = lengthValue(v, n.sFixed ?? n.spos, op);
      if (x !== undefined) n.sFixed = x;
      return;
    }
    case "l sep":
    case "l sep'": {
      const x = lengthValue(v, n.lsep, op);
      if (x !== undefined) n.lsep = Math.max(0, x);
      return;
    }
    case "s sep":
    case "s sep'": {
      const x = lengthValue(v, n.ssep, op);
      if (x !== undefined) n.ssep = Math.max(0, x);
      return;
    }
    case "calign": {
      const c = (v ?? "").trim();
      n.calign = c;
      return;
    }
    case "calign child":
    case "calign primary child":
      n.calignChild = Math.max(1, Math.round(num(v ?? "1") ?? 1));
      return;
    case "tier":
      n.tier = (v ?? "").trim();
      return;
    case "phantom":
      n.phantom = v === undefined || v === "true";
      return;
    case "no edge":
      n.noEdge = true;
      return;
    case "name":
      n.name = (v ?? "").trim();
      return;
    case "anchor":
      n.anchor = (v ?? "").trim();
      return;
    case "parent anchor":
      n.parentAnchor = (v ?? "").trim();
      return;
    case "child anchor":
      n.childAnchor = (v ?? "").trim();
      return;
    case "edge":
      if (op === "+") n.edge.push(v ?? "");
      else n.edge = v === undefined || v === "" ? [] : [v];
      if ((v ?? "").trim() === "none") {
        n.edge = [];
        n.noEdge = true;
      }
      return;
    case "edge label":
      n.edgeLabel = op === "+" ? `${n.edgeLabel} ${v ?? ""}` : (v ?? "");
      return;
    case "edge path":
      n.edgePath = v ?? "";
      return;
    case "edge path'":
      n.edgePath = `\\path[draw, \\forestoption{edge}] ${v ?? ""};`;
      return;
    case "roof":
      n.roof = v === undefined || v === "true";
      return;
    case "folder":
      walk(n, (x) => {
        if (x.children.length) x.folder = true;
      });
      n.folder = true;
      return;
    case "forked edges":
      walk(n, (x) => {
        x.forked = true;
      });
      return;
    case "forked edge":
      n.forked = true;
      return;
    case "fork sep": {
      const x = lengthValue(v, n.forkSep ?? 0.5 * EM, op);
      if (x !== undefined) n.forkSep = Math.max(0, x);
      return;
    }
    case "folder indent":
    case "folder sep":
      return;
    case "tikz":
      if (v) n.tikz.push(v);
      return;
    case "where":
    case "if":
      ctx.it.warnOnce("forest where", `forest condition "${key}" without a node attribute is not supported; it was skipped`);
      return;
    case "draw tree stage":
      return;
    case "fit":
      n.band = (v ?? "").trim() === "band";
      return;
  }
  // where n children=0{...}{...}, if level=1{...}{...}
  const cond = /^(where|if)\s+(.+)$/.exec(base);
  if (cond) {
    const parts = condParts(v ?? "");
    if (!parts) return;
    const attr = cond[2].trim();
    const test = (x: FNode) => nAttr(x, attr) === parts.value;
    const targets = cond[1] === "where" ? (() => {
      const all: FNode[] = [];
      walk(n, (x) => all.push(x));
      return all;
    })() : [n];
    for (const x of targets) apply(ctx, x, test(x) ? parts.yes : parts.no, depth + 1);
    return;
  }
  if (FOREST_QUIET.has(base) || base.startsWith("before ") || base.startsWith("after ") || base.startsWith("for ")) {
    if (base.startsWith("for ") || base.startsWith("after ")) ctx.it.warnOnce(`forest:${base}`, `forest option "${base}" is not supported and was ignored`);
    return;
  }
  // Anything else is a TikZ option of the node.
  n.tikzOpts.push(v === undefined ? rawKey : `${rawKey}={${v}}`);
}

const STAGES: Stage[] = ["given", "typeset", "pack", "xy", "draw"];

function growDeg(v: string | undefined): number | undefined {
  const t = (v ?? "").trim();
  const named: Record<string, number> = { south: 270, down: 270, north: 90, up: 90, east: 0, right: 0, west: 180, left: 180 };
  if (Object.hasOwn(named, t)) return named[t];
  const a = num(t);
  return a !== undefined && Number.isFinite(a) ? a : undefined;
}

function runQueue(ctx: Ctx, stage: Stage): void {
  ctx.stage = stage;
  const q = ctx.queue.get(stage)!;
  // Bodies may queue more work for the same stage; run until it is empty.
  for (let k = 0; k < q.length && k < 10_000; k++) apply(ctx, q[k].node, q[k].body);
  q.length = 0;
}

// ---------------------------------------------------------------- layout

/** The axes children of `n` grow along: l away from the parent, s across, in sibling order. */
function axes(n: FNode): { lv: Pt; sv: Pt } {
  return { lv: dir(n.grow), sv: dir(n.rev ? n.grow - 90 : n.grow + 90) };
}

const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** The extent of a node box (relative to its anchor at `at`) along `v`. */
function extentAlong(n: FNode, at: Pt, v: Pt): [number, number] {
  const e = n.ext;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of [
    [e[0], e[1]],
    [e[2], e[1]],
    [e[0], e[3]],
    [e[2], e[3]],
  ] as Pt[]) {
    const x = dot(add(at, c), v);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return [lo, hi];
}

/** One line of a subtree's outline: the nodes whose anchors share an l position, with their l and s ranges. */
interface Row {
  l0: number;
  l1: number;
  s0: number;
  s1: number;
}

/**
 * A subtree's outline in its parent's frame, row by row: l from the
 * parent's anchor, s from the subtree root's anchor.
 */
function outline(c: FNode, lv: Pt, sv: Pt): Map<number, Row> {
  const rows = new Map<number, Row>();
  const stack: { x: FNode; at: Pt }[] = [{ x: c, at: [0, 0] }];
  while (stack.length) {
    const { x, at } = stack.pop()!;
    const [l0, l1] = extentAlong(x, at, lv);
    const [s0, s1] = extentAlong(x, at, sv);
    const key = Math.round((c.lpos + dot(at, lv)) * 2) / 2;
    const r = rows.get(key);
    if (r) {
      r.l0 = Math.min(r.l0, c.lpos + l0);
      r.l1 = Math.max(r.l1, c.lpos + l1);
      r.s0 = Math.min(r.s0, s0);
      r.s1 = Math.max(r.s1, s1);
    } else rows.set(key, { l0: c.lpos + l0, l1: c.lpos + l1, s0, s1 });
    for (const k of x.children) stack.push({ x: k, at: add(at, k.off) });
  }
  return rows;
}

/** l of every child from its parent: siblings share one line, at least l away and l sep clear; then tiers line up. */
function levels(root: FNode): void {
  walk(root, (p) => {
    if (!p.children.length || p.folder) return;
    const { lv } = axes(p);
    const [, pHi] = extentAlong(p, [0, 0], lv);
    let lpos = 0;
    for (const c of p.children) {
      const [cLo] = extentAlong(c, [0, 0], lv);
      lpos = Math.max(lpos, c.l, pHi + p.lsep - cLo);
    }
    for (const c of p.children) c.lpos = lpos;
  });
  // Tiers: each node of a tier moves out to the line of the one farthest from the root.
  const tiers = new Map<string, FNode[]>();
  walk(root, (x) => {
    if (x.tier && x.parent && !x.parent.folder) tiers.set(x.tier, [...(tiers.get(x.tier) ?? []), x]);
  });
  for (const list of tiers.values()) {
    const depthOf = new Map<FNode, number>();
    walk(root, (x) => depthOf.set(x, x.parent ? depthOf.get(x.parent)! + x.lpos : 0));
    const far = Math.max(...list.map((x) => depthOf.get(x)!));
    for (const x of list) x.lpos += far - depthOf.get(x)!;
  }
}

/**
 * Packs the children of every node, deepest first, and sets each child's
 * offset from its parent: each subtree goes as close to the ones before it
 * as s sep allows wherever their outlines share l, then the parent is
 * centred by calign.
 */
function pack(ctx: Ctx, root: FNode): void {
  levels(root);
  const order: FNode[] = [];
  walk(root, (x) => order.push(x));
  for (let k = order.length - 1; k >= 0; k--) {
    ctx.it.tick();
    const p = order[k];
    if (!p.children.length) continue;
    if (p.folder) {
      packFolder(p);
      continue;
    }
    const { lv, sv } = axes(p);
    const placedRows: Row[] = [];
    const spos: number[] = [];
    // The far edge of earlier fit=band subtrees, which holds at every l beyond them.
    let bandRight = -Infinity;
    p.children.forEach((c, i) => {
      ctx.it.tick();
      const rows = [...outline(c, lv, sv).values()];
      const lowest = Math.min(...rows.map((r) => r.s0));
      let s = 0;
      if (i > 0) {
        s = -Infinity;
        for (const r of rows)
          for (const q of placedRows) {
            if (c.band || (r.l0 < q.l1 && q.l0 < r.l1)) s = Math.max(s, q.s1 - (c.band ? lowest : r.s0) + p.ssep);
          }
        if (bandRight > -Infinity) s = Math.max(s, bandRight - lowest + p.ssep);
        if (s === -Infinity) s = spos[i - 1];
      }
      spos.push(s);
      for (const r of rows) placedRows.push({ l0: r.l0, l1: r.l1, s0: r.s0 + s, s1: r.s1 + s });
      if (c.band) bandRight = Math.max(bandRight, Math.max(...rows.map((r) => r.s1)) + s);
      // Keep the list short: rows at one l merge.
      if (placedRows.length > 400) mergeRows(placedRows);
    });
    const first = spos[0];
    const last = spos[spos.length - 1];
    let mid: number;
    switch (p.calign) {
      case "first":
        mid = first;
        break;
      case "last":
        mid = last;
        break;
      case "child":
      case "child edge":
        mid = spos[Math.min(spos.length, p.calignChild) - 1];
        break;
      default:
        mid = (first + last) / 2;
    }
    p.children.forEach((c, i) => {
      c.spos = spos[i] - mid;
      c.off = add(scale(lv, c.lpos), scale(sv, c.spos));
    });
  }
}

/** Merges rows with the same l range into one (their s ranges joined). */
function mergeRows(rows: Row[]): void {
  const by = new Map<string, Row>();
  for (const r of rows) {
    const key = `${Math.round(r.l0)}:${Math.round(r.l1)}`;
    const o = by.get(key);
    if (o) {
      o.s0 = Math.min(o.s0, r.s0);
      o.s1 = Math.max(o.s1, r.s1);
      o.l0 = Math.min(o.l0, r.l0);
      o.l1 = Math.max(o.l1, r.l1);
    } else by.set(key, { ...r });
  }
  rows.length = 0;
  rows.push(...by.values());
}

/** The folder style: children listed under the parent, indented, each below the subtree before it. */
function packFolder(p: FNode): void {
  const indent = 1.2 * EM;
  const gap = 0.35 * EM;
  // Global axes: down and right, whatever grow says.
  let y = p.ext[1] - gap;
  for (const c of p.children) {
    const box = subtreeBox(c);
    const x = p.ext[0] + indent - c.ext[0];
    const top = box[3];
    c.off = [x, y - top];
    c.lpos = x;
    c.spos = -(y - top);
    y = y - top + box[1] - gap;
  }
}

/** Bounding box of a subtree relative to its root's anchor (offsets already set). */
function subtreeBox(n: FNode): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const stack: { x: FNode; at: Pt }[] = [{ x: n, at: [0, 0] }];
  while (stack.length) {
    const { x, at } = stack.pop()!;
    b[0] = Math.min(b[0], at[0] + x.ext[0]);
    b[1] = Math.min(b[1], at[1] + x.ext[1]);
    b[2] = Math.max(b[2], at[0] + x.ext[2]);
    b[3] = Math.max(b[3], at[1] + x.ext[3]);
    for (const c of x.children) stack.push({ x: c, at: add(at, c.off) });
  }
  return b;
}

/** Final positions, with `l=` and `s=` set after packing. */
function positions(root: FNode): void {
  walk(root, (x) => {
    if (!x.parent) {
      x.pos = [0, 0];
      return;
    }
    if ((x.lFixed !== undefined || x.sFixed !== undefined) && !x.parent.folder) {
      const { lv, sv } = axes(x.parent);
      x.off = add(scale(lv, x.lFixed ?? x.lpos), scale(sv, x.sFixed ?? x.spos));
    } else if (x.lFixed !== undefined && x.parent.folder) x.off = [x.lFixed, x.off[1]];
    x.pos = add(x.parent.pos, x.off);
  });
}

// ---------------------------------------------------------------- drawing

const COMPASS8 = ["east", "north east", "north", "north west", "west", "south west", "south", "south east"];

function compassOf(deg: number): string {
  return COMPASS8[((Math.round(deg / 45) % 8) + 8) % 8];
}

/** A forest anchor (parent, children, first, last, ...) as a TikZ anchor of node `n`, or "" for the border. */
function anchorName(n: FNode, a: string): string {
  const t = a.trim();
  if (!t) return "";
  const parentGrow = n.parent?.grow ?? 270;
  const own = axes(n);
  const pAxes = n.parent ? axes(n.parent) : own;
  const ang = (v: Pt) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  switch (t) {
    case "children":
      return compassOf(n.grow);
    case "parent":
      return compassOf(parentGrow + 180);
    case "children first":
      return compassOf(ang(add(own.lv, scale(own.sv, -1))));
    case "children last":
      return compassOf(ang(add(own.lv, own.sv)));
    case "parent first":
      return compassOf(ang(add(scale(pAxes.lv, -1), scale(pAxes.sv, -1))));
    case "parent last":
      return compassOf(ang(add(scale(pAxes.lv, -1), pAxes.sv)));
    case "first":
      return compassOf(ang(scale(pAxes.sv, -1)));
    case "last":
      return compassOf(ang(pAxes.sv));
  }
  return t;
}

function ref(n: FNode, anchor: string): string {
  const name = n.placed?.name ?? "";
  const a = anchorName(n, anchor);
  return a ? `${name}.${a}` : name;
}

/** Forest's relative node names in TikZ code: (!u), (!r.east), (.child anchor), (!1), ... */
function resolveRefs(code: string, self: FNode, ctx: Ctx): string {
  return code.replace(/\(\s*(?:!([A-Za-z0-9']+)|(?=\.(?![0-9])))(\.[^()]*)?\)/g, (m, steps: string | undefined, rest: string | undefined) => {
    let target: FNode | undefined = self;
    if (steps) target = step(self, steps, ctx);
    if (!target?.placed) return m;
    const r = (rest ?? "").slice(1).trim();
    if (r === "parent anchor") return `(${ref(target, target.parentAnchor)})`;
    if (r === "child anchor") return `(${ref(target, target.childAnchor)})`;
    if (r === "anchor") return `(${ref(target, target.anchor === "base" ? "" : target.anchor)})`;
    return `(${ref(target, r)})`;
  });
}

function step(self: FNode, steps: string, ctx: Ctx): FNode | undefined {
  let x: FNode | undefined = self;
  for (let k = 0; k < steps.length && x; k++) {
    const c = steps[k];
    if (c === "u") x = x.parent;
    else if (c === "r") x = ctx.root;
    else if (c === "p" || c === "n") {
      const sibs: FNode[] = x.parent?.children ?? [];
      x = sibs[sibs.indexOf(x) + (c === "p" ? -1 : 1)];
    } else if (c === "l") x = x.children[x.children.length - 1];
    else if (c === "F") x = x.children[0];
    else if (/[1-9]/.test(c)) x = x.children[Number(c) - 1];
    else if (c === "'") continue;
    else return undefined;
  }
  return x;
}

function edgeCode(n: FNode, p: FNode, ctx: Ctx): string | undefined {
  const opts = ["draw", ...n.edge].filter((o) => o.trim()).join(", ");
  if (n.edgePath !== undefined) {
    const code = n.edgePath
      .replace(/\\noexpand(?![A-Za-z])/g, "")
      .replace(/\\forestoption\s*\{\s*edge\s*\}/g, n.edge.join(", "))
      .replace(/\\forestoption\s*\{\s*edge label\s*\}/g, n.edgeLabel)
      .replace(/\\forestoption\s*\{[^}]*\}/g, "")
      .replace(/\\forestove\s*\{[^}]*\}/g, "");
    return resolveRefs(code, n, ctx);
  }
  if (n.roof) {
    const pa = ref(p, p.parentAnchor || compassOf(p.grow));
    const first = anchorName(n, "parent first") || "north west";
    const last = anchorName(n, "parent last") || "north east";
    return `\\path[${opts}] (${ref(n, first)}) -- (${pa}) -- (${ref(n, last)}) -- cycle;`;
  }
  if (p.folder) {
    // Down from under the parent, then across into the child.
    const x = p.pos[0] + p.ext[0] + 0.6 * EM;
    const top = coordNode(ctx.it, [x, p.pos[1] + p.ext[1]]);
    return `\\path[${opts}] (${top}) |- (${ref(n, n.childAnchor || "west")})${n.edgeLabel};`;
  }
  if (p.forked || n.forked) {
    const { lv } = axes(p);
    const pa = p.parentAnchor || compassOf(p.grow);
    const start = anchorPoint(p.placed!.info, anchorName(p, pa));
    const cAnchor = n.childAnchor || compassOf(p.grow + 180);
    const end = anchorPoint(n.placed!.info, anchorName(n, cAnchor));
    const gap = dot(sub(end, start), lv);
    const sep = Math.max(0, Math.min(p.forkSep ?? n.forkSep ?? 0.5 * EM, gap / 2));
    const mid = coordNode(ctx.it, add(start, scale(lv, sep)));
    const vertical = Math.abs(lv[1]) >= Math.abs(lv[0]);
    return `\\path[${opts}] (${ref(p, pa)}) -- (${mid}) ${vertical ? "-|" : "|-"} (${ref(n, cAnchor)})${n.edgeLabel};`;
  }
  return `\\path[${opts}] (${ref(p, p.parentAnchor)}) -- (${ref(n, n.childAnchor)})${n.edgeLabel};`;
}

/**
 * Draws a forest environment's body. `styles` holds \forestset styles from
 * the preamble. Never throws except to stop on the interpreter's caps.
 */
export function drawForest(it: Interp, body: string, g0: GS, forestset = ""): void {
  const ctx: Ctx = {
    it,
    g: cloneGS(g0),
    styles: new Map(),
    stage: "given",
    queue: new Map(STAGES.map((s) => [s, []])),
    count: 0,
  };
  // \forestset{...} in the document, and inside the environment.
  for (const m of forestset.matchAll(/\\forestset\s*/g)) {
    const sc = new Scanner(forestset);
    sc.i = (m.index ?? 0) + m[0].length;
    const v = sc.group("{");
    if (v) for (const kv of parseOptions(v)) defineStyle(ctx, kv);
  }
  let src = body;
  const inner = /\\forestset\s*\{/g;
  for (let m = inner.exec(src); m; m = inner.exec(src)) {
    const e = matchClose(src, m.index + m[0].length - 1);
    if (e < 0) break;
    for (const kv of parseOptions(src.slice(m.index + m[0].length, e))) defineStyle(ctx, kv);
    src = src.slice(0, m.index) + " ".repeat(e + 1 - m.index) + src.slice(e + 1);
  }
  const b = firstBracket(src);
  if (b < 0) {
    it.warn("this forest has no [bracketed] tree; nothing was drawn");
    return;
  }
  const preamble = splitTop(src.slice(0, b), ",")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
  let warnedDepth = false;
  const parsed = parseBrackets(src, b, () => {
    if (warnedDepth) return;
    warnedDepth = true;
    it.warn(`the forest nests more than ${MAX_DEPTH} levels, holds more than ${MAX_NODES} nodes or several trees; the rest was left out`);
  });
  const root = parsed.root;
  if (!root) return;
  ctx.root = root;
  ctx.count = parsed.count;
  const trailing = src.slice(parsed.end);
  // Given options: the preamble applies to the root first, then each node's own, in tree order.
  apply(ctx, root, preamble);
  const order: FNode[] = [];
  walk(root, (x) => order.push(x));
  for (const x of order) apply(ctx, x, x.opts);
  runQueue(ctx, "typeset");
  // Roof on a node with one child means the child's roof.
  walk(root, (x) => {
    if (x.roof && x.children.length === 1 && !x.children[0].roof) {
      x.roof = false;
      x.children[0].roof = true;
    }
    if (x.roof && !x.parent) x.roof = false;
  });
  const placed: Placed[] = [];
  try {
    // Typeset every node at the origin, then move it into place.
    walk(root, (x) => {
      it.tick();
      const opts = [...x.tikzOpts];
      if (x.anchor) opts.unshift(`anchor=${anchorName(x, x.anchor) || "center"}`);
      if (/\\\\/.test(x.content) && !opts.some((o) => /^\s*(align|text width)\b/.test(o))) opts.push("align=center");
      const pn = nodeSpec(it, ctx.g, `[${opts.join(", ")}] {${x.content}}`);
      const p = pn ? placeNode(it, pn, { point: [0, 0] }, ctx.g, "f") : undefined;
      if (!p) {
        x.placed = { info: { name: "", center: [0, 0], shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 }, items: [], name: coordNode(it, [0, 0]) };
        it.nodes.set(x.placed.name, x.placed.info);
      } else x.placed = p;
      const info = x.placed.info;
      x.ext = [info.center[0] - info.hw, info.center[1] - info.hh, info.center[0] + info.hw, info.center[1] + info.hh];
      if (x.phantom) x.placed.items = [];
      else placed.push(x.placed);
      if (x.name) it.nodes.set(x.name, info);
    });
    runQueue(ctx, "pack");
    pack(ctx, root);
    runQueue(ctx, "xy");
    positions(root);
    walk(root, (x) => moveNode(x.placed!, x.pos));
    runQueue(ctx, "draw");
    // Edges under the nodes.
    walk(root, (x) => {
      const p = x.parent;
      if (!p || x.phantom || p.phantom || x.noEdge) return;
      it.tick();
      const code = edgeCode(x, p, ctx);
      if (code) it.run(code, 0, false, cloneGS(ctx.g));
    });
  } finally {
    commitNodes(it, placed);
  }
  // tikz= options and the TikZ code after the tree.
  walk(root, (x) => {
    for (const t of x.tikz) it.run(resolveRefs(t, x, ctx), 0, false, cloneGS(ctx.g));
  });
  if (trailing.trim()) it.run(resolveRefs(trailing, root, ctx), 0, false, cloneGS(ctx.g));
}

function defineStyle(ctx: Ctx, kv: KV): void {
  const m = /^(.*?)\/\.(style|append style|prefix style)$/.exec(kv.key.replace(/^\/forest\//, "").trim());
  if (!m) return;
  const name = m[1].trim();
  const old = ctx.styles.get(name);
  const v = kv.value ?? "";
  ctx.styles.set(name, m[2] === "append style" && old ? `${old}, ${v}` : m[2] === "prefix style" && old ? `${v}, ${old}` : v);
}
