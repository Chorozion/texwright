/**
 * The graphs library: \graph [options] { a -> b -> c; a -> {d, e}; }.
 *
 * Read: chains of nodes joined by ->, <-, --, <-> and -!- (each with
 * [options], quoted labels included), groups in braces (an edge to a group
 * reaches every member), quoted names, a/"text" and a/text, node options,
 * x= and y= positions, and subgraph I_n, K_n, C_n, P_n, K_nm and I_nm with
 * n=, m=, V= and W=.
 *
 * Placed: by default as TikZ's graphs library does, chains along one axis
 * and group members along the other (grow right/down/left/up, branch
 * right/down/..., their sep forms, chain shift and group shift); with
 * circular placement, clockwise or counterclockwise (and simple necklace
 * layout) on a circle; with layered layout or tree layout by the layered
 * (Sugiyama) layout of src/diagram/layered.ts, edges routed through its
 * bends; with spring layout (spring electrical layout, force) by a small
 * deterministic force-directed layout.
 */

import { layoutGraph } from "../diagram/layered.js";
import { length, num } from "./expr.js";
import { type Pt, add, apply, dir, scale, sub } from "./geom.js";
import type { Interp } from "./interp.js";
import { applyOptions } from "./options.js";
import { Scanner, matchClose, parseOptions, splitTop, unbrace } from "./scan.js";
import { CM, type GS, cloneGS } from "./state.js";
import { type Placed, commitNodes, coordNode, moveNode, nodeSpec, placeNode } from "./trees.js";

const MAX_NODES = 1500;
const MAX_EDGES = 12_000;
/** Beyond these the layered layout would take seconds. */
const LAYERED_NODES = 300;
const LAYERED_EDGES = 300;

type Elem =
  | { t: "node"; name: string; text?: string; opts: string }
  | { t: "group"; opts: string; items: Chain[] }
  | { t: "sub"; kind: string; opts: string };

interface Chain {
  elems: Elem[];
  ops: { kind: string; opts: string }[];
}

interface GNode {
  name: string;
  text: string;
  opts: string;
  placed?: Placed;
  /** Cartesian placement: column along chains, row across groups. */
  col?: number;
  row?: number;
  fixed?: Pt;
  pos: Pt;
  index: number;
}

interface GEdge {
  from: GNode;
  to: GNode;
  kind: string;
  opts: string;
}

interface Graph {
  nodes: Map<string, GNode>;
  order: GNode[];
  edges: GEdge[];
  full: boolean;
}

// ---------------------------------------------------------------- parsing

const OPS = ["<->", "-!-", "->", "<-", "--"];

function readOp(sc: Scanner): string | undefined {
  sc.ws();
  for (const op of OPS) if (sc.s.startsWith(op, sc.i)) {
    sc.i += op.length;
    return op;
  }
  return undefined;
}

/** A group's members: chains separated by , or ; (to the end of the text). */
export function parseGroup(text: string, depth = 0): Chain[] {
  const out: Chain[] = [];
  if (depth > 30) return out;
  const sc = new Scanner(text);
  for (let guard = 0; guard < 100_000; guard++) {
    sc.ws();
    if (sc.i >= sc.s.length) break;
    if (sc.s[sc.i] === "," || sc.s[sc.i] === ";") {
      sc.i++;
      continue;
    }
    const before = sc.i;
    const chain = parseChain(sc, depth);
    if (chain.elems.length) out.push(chain);
    if (sc.i === before) sc.i++;
  }
  return out;
}

function parseChain(sc: Scanner, depth: number): Chain {
  const chain: Chain = { elems: [], ops: [] };
  const first = parseElem(sc, depth);
  if (!first) return chain;
  chain.elems.push(first);
  for (;;) {
    const save = sc.i;
    const op = readOp(sc);
    if (!op) {
      sc.i = save;
      break;
    }
    let opts = "";
    sc.ws();
    if (sc.s[sc.i] === "[") opts = sc.options() ?? "";
    const next = parseElem(sc, depth);
    if (!next) break;
    chain.ops.push({ kind: op, opts });
    chain.elems.push(next);
  }
  return chain;
}

function parseElem(sc: Scanner, depth: number): Elem | undefined {
  sc.ws();
  const c = sc.s[sc.i];
  if (c === undefined || c === "," || c === ";") return undefined;
  if (c === "{") {
    let inner = sc.group("{") ?? "";
    let opts = "";
    const t = inner.trimStart();
    if (t.startsWith("[")) {
      const e = matchClose(t, 0);
      if (e > 0) {
        opts = t.slice(1, e);
        inner = t.slice(e + 1);
      }
    }
    sc.ws();
    if (sc.s[sc.i] === "[") opts += `,${sc.options() ?? ""}`;
    return { t: "group", opts, items: parseGroup(inner, depth + 1) };
  }
  if (/^subgraph(?![A-Za-z])/.test(sc.s.slice(sc.i, sc.i + 9))) {
    sc.i += 8;
    sc.ws();
    const m = /^[A-Za-z_]+/.exec(sc.s.slice(sc.i, sc.i + 40));
    const kind = m ? m[0] : "";
    sc.i += kind.length;
    sc.ws();
    const opts = sc.s[sc.i] === "[" ? (sc.options() ?? "") : "";
    return { t: "sub", kind, opts };
  }
  let name: string;
  let text: string | undefined;
  if (c === '"') {
    const e = sc.s.indexOf('"', sc.i + 1);
    name = sc.s.slice(sc.i + 1, e < 0 ? sc.s.length : e);
    sc.i = e < 0 ? sc.s.length : e + 1;
    text = name;
  } else {
    name = readName(sc);
    if (!name) return undefined;
  }
  sc.ws();
  if (sc.s[sc.i] === "/") {
    sc.i++;
    sc.ws();
    if (sc.s[sc.i] === '"') {
      const e = sc.s.indexOf('"', sc.i + 1);
      text = sc.s.slice(sc.i + 1, e < 0 ? sc.s.length : e);
      sc.i = e < 0 ? sc.s.length : e + 1;
    } else text = readName(sc);
  }
  sc.ws();
  let opts = "";
  while (sc.s[sc.i] === "[") {
    opts += `${opts ? "," : ""}${sc.options() ?? ""}`;
    sc.ws();
  }
  return { t: "node", name, ...(text !== undefined ? { text } : {}), opts };
}

/** An unquoted name: up to [ / , ; { } or an edge operator (spaces inside are kept). */
function readName(sc: Scanner): string {
  const s = sc.s;
  let k = sc.i;
  let depth = 0;
  while (k < s.length) {
    const c = s[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "$") {
      const e = s.indexOf("$", k + 1);
      k = e < 0 ? s.length : e + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "[" || c === "/" || c === "," || c === ";" || c === '"')) break;
    else if (depth === 0 && OPS.some((op) => s.startsWith(op, k))) break;
    k++;
  }
  const name = s.slice(sc.i, k).trim();
  sc.i = k;
  return name;
}

// ---------------------------------------------------------------- building

function subgraphNames(kind: string, opts: string): { a: string[]; b: string[] } {
  const kv = new Map(parseOptions(opts).map((o) => [o.key, o.value ?? ""]));
  const list = (key: string, count: string | undefined, start: number): string[] => {
    const v = kv.get(key);
    if (v) return splitTop(unbrace(v), ",").map((x) => x.trim()).filter(Boolean);
    const n = Math.max(0, Math.min(200, Math.round(num(count ?? "") ?? 0)));
    return Array.from({ length: n }, (_, i) => String(start + i));
  };
  const n = kv.get("n");
  const a = list("V", n, 1);
  const b = /nm$/.test(kind) ? list("W", kv.get("m"), a.length + 1) : [];
  return { a, b };
}

function build(chains: Chain[], it: Interp): Graph {
  const gr: Graph = { nodes: new Map(), order: [], edges: [], full: false };
  const node = (name: string, text: string | undefined, opts: string): GNode | undefined => {
    let n = gr.nodes.get(name);
    if (n) {
      if (opts) n.opts += `,${opts}`;
      if (text !== undefined) n.text = text;
      return n;
    }
    if (gr.order.length >= MAX_NODES) {
      if (!gr.full) it.warn(`the graph has more than ${MAX_NODES} nodes; the rest were left out`);
      gr.full = true;
      return undefined;
    }
    n = { name, text: text ?? name, opts, pos: [0, 0], index: gr.order.length };
    gr.nodes.set(name, n);
    gr.order.push(n);
    return n;
  };
  const edge = (from: GNode, to: GNode, kind: string, opts: string) => {
    if (kind === "-!-") {
      gr.edges = gr.edges.filter((e) => !((e.from === from && e.to === to) || (e.from === to && e.to === from)));
      return;
    }
    if (gr.edges.length >= MAX_EDGES) return;
    gr.edges.push({ from, to, kind, opts });
  };
  /** Builds an element; returns the nodes edges enter and leave it by. */
  const elem = (e: Elem, groupOpts: string): { entry: GNode[]; exit: GNode[] } => {
    it.tick();
    if (e.t === "node") {
      const n = node(e.name, e.text, [groupOpts, e.opts].filter(Boolean).join(","));
      return n ? { entry: [n], exit: [n] } : { entry: [], exit: [] };
    }
    if (e.t === "group") {
      const entry: GNode[] = [];
      const exit: GNode[] = [];
      for (const ch of e.items) {
        const r = chain(ch, [groupOpts, e.opts].filter(Boolean).join(","));
        entry.push(...r.entry);
        exit.push(...r.exit);
      }
      return { entry, exit };
    }
    const { a, b } = subgraphNames(e.kind, e.opts);
    const A = a.map((x) => node(x, undefined, groupOpts)).filter((x): x is GNode => !!x);
    const B = b.map((x) => node(x, undefined, groupOpts)).filter((x): x is GNode => !!x);
    switch (e.kind) {
      case "K_n":
        for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) edge(A[i], A[j], "--", "");
        break;
      case "C_n":
        for (let i = 0; i < A.length && A.length > 2; i++) edge(A[i], A[(i + 1) % A.length], "--", "");
        break;
      case "P_n":
        for (let i = 0; i + 1 < A.length; i++) edge(A[i], A[i + 1], "--", "");
        break;
      case "K_nm":
        for (const x of A) for (const y of B) edge(x, y, "--", "");
        break;
      case "I_n":
      case "I_nm":
        break;
      default:
        it.warnOnce(`subgraph:${e.kind}`, `subgraph ${e.kind} is drawn as its nodes only`);
    }
    return { entry: [...A, ...B], exit: [...A, ...B] };
  };
  const chain = (ch: Chain, groupOpts: string): { entry: GNode[]; exit: GNode[] } => {
    let first: { entry: GNode[]; exit: GNode[] } | undefined;
    let prev: { entry: GNode[]; exit: GNode[] } | undefined;
    ch.elems.forEach((e, k) => {
      const r = elem(e, groupOpts);
      if (prev && k > 0) {
        const op = ch.ops[k - 1];
        for (const x of prev.exit) for (const y of r.entry) edge(x, y, op.kind, op.opts);
      }
      first ??= r;
      prev = r;
    });
    return { entry: first?.entry ?? [], exit: prev?.exit ?? [] };
  };
  for (const ch of chains) chain(ch, "");
  return gr;
}

/** Columns and rows of the graphs library's default placement. */
function cartesian(chains: Chain[], gr: Graph): void {
  const placeElem = (e: Elem, col: number, row: number): { rows: number; col: number } => {
    if (e.t === "node") {
      const n = gr.nodes.get(e.name);
      if (!n) return { rows: 0, col };
      if (n.col !== undefined) return { rows: 0, col: n.col };
      n.col = col;
      n.row = row;
      return { rows: 1, col };
    }
    if (e.t === "group") {
      let r = row;
      for (const ch of e.items) r += placeChain(ch, col, r);
      return { rows: r - row, col };
    }
    const { a, b } = subgraphNames(e.kind, e.opts);
    let r = row;
    for (const name of [...a, ...b]) {
      const n = gr.nodes.get(name);
      if (n && n.col === undefined) {
        n.col = col;
        n.row = r++;
      }
    }
    return { rows: r - row, col };
  };
  const placeChain = (ch: Chain, col0: number, row: number): number => {
    let rows = 0;
    let col = col0;
    ch.elems.forEach((e, k) => {
      const r = placeElem(e, k === 0 ? col0 : col + 1, row);
      rows = Math.max(rows, r.rows);
      col = r.col;
    });
    return rows;
  };
  let row = 0;
  for (const ch of chains) row += placeChain(ch, 0, row);
}

// ---------------------------------------------------------------- layouts

interface Settings {
  layout: "cartesian" | "layered" | "circle" | "spring";
  chain: Pt;
  group: Pt;
  chainSep?: { dir: Pt; sep: number };
  groupSep?: { dir: Pt; sep: number };
  clockwise: boolean;
  radius?: number;
  phase: number;
  rankdir: "TB" | "BT" | "LR" | "RL";
  levelDist?: number;
  siblingDist?: number;
  levelSep?: number;
  siblingSep?: number;
  nodeDist?: number;
  nodes: string[];
  edges: string[];
  empty: boolean;
  math: boolean;
  existing: boolean;
}

const DIRS: Record<string, Pt> = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] };

/** Reads the graph's own keys; the rest go to the TikZ state of the graph. */
function settings(opts: string, g: GS, it: Interp): Settings {
  const st: Settings = { layout: "cartesian", chain: [CM, 0], group: [0, -CM], clockwise: true, phase: 90, rankdir: "TB", nodes: [], edges: [], empty: false, math: false, existing: false };
  const rest: string[] = [];
  for (const { key, value } of parseOptions(opts)) {
    const k = key.replace(/^\/(tikz|graph drawing|graphs)\//, "").trim();
    const len = (dflt: number) => length(value ?? "", CM) ?? dflt;
    const gs = /^(grow|branch) (right|left|up|down)( sep)?$/.exec(k);
    if (gs) {
      const d = DIRS[gs[2]];
      if (gs[3]) {
        const sep = { dir: d, sep: value === undefined ? 10 : len(10) };
        if (gs[1] === "grow") st.chainSep = sep;
        else st.groupSep = sep;
      } else {
        const v = scale(d, value === undefined ? CM : len(CM));
        if (gs[1] === "grow") {
          st.chain = v;
          st.chainSep = undefined;
        } else {
          st.group = v;
          st.groupSep = undefined;
        }
      }
      if (gs[1] === "grow") st.rankdir = gs[2] === "right" ? "LR" : gs[2] === "left" ? "RL" : gs[2] === "up" ? "BT" : "TB";
      continue;
    }
    switch (k) {
      case "layered layout":
      case "tree layout":
      case "binary tree layout":
      case "layered drawing":
        st.layout = "layered";
        continue;
      case "spring layout":
      case "spring electrical layout":
      case "spring electrical layout'":
      case "spring electrical Walshaw 2000 layout":
      case "force":
        st.layout = "spring";
        continue;
      case "circular placement":
      case "simple necklace layout":
      case "clockwise":
      case "counterclockwise":
        st.layout = "circle";
        st.clockwise = k !== "counterclockwise";
        continue;
      case "grow": {
        const a = { down: "TB", south: "TB", up: "BT", north: "BT", right: "LR", east: "LR", left: "RL", west: "RL" }[(value ?? "").trim()];
        if (a) st.rankdir = a as Settings["rankdir"];
        continue;
      }
      case "chain shift":
      case "group shift": {
        const p = it.coordOffset(unbrace(value ?? "").replace(/^\(|\)$/g, ""), g);
        if (p) {
          if (k === "chain shift") st.chain = p;
          else st.group = p;
        }
        continue;
      }
      case "radius":
        st.radius = len(CM);
        continue;
      case "phase":
        st.phase = num(value ?? "90") ?? 90;
        continue;
      case "level distance":
      case "layer distance":
        st.levelDist = len(CM);
        continue;
      case "sibling distance":
        st.siblingDist = len(CM);
        continue;
      case "level sep":
      case "layer sep":
        st.levelSep = len(10);
        continue;
      case "sibling sep":
        st.siblingSep = len(10);
        continue;
      case "node distance":
        st.nodeDist = len(CM);
        rest.push(`${key}=${value ?? ""}`);
        continue;
      case "nodes":
        if (value) st.nodes.push(value);
        continue;
      case "edges":
      case "edge":
        if (value) st.edges.push(value);
        continue;
      case "empty nodes":
        st.empty = true;
        continue;
      case "math nodes":
        st.math = true;
        continue;
      case "use existing nodes":
        st.existing = true;
        continue;
      case "n":
      case "m":
      case "V":
      case "W":
      case "fresh nodes":
      case "number nodes":
      case "simple":
      case "multi":
      case "no placement":
      case "cartesian placement":
      case "typeset":
      case "edge quotes":
      case "edge quotes center":
      case "edge quotes mid":
      case "component direction":
      case "components go right":
      case "components go down":
      case "components go left":
      case "components go up":
      case "orient":
      case "orient'":
      case "horizontal":
      case "vertical":
      case "random seed":
      case "iterations":
      case "convergence tolerance":
      case "spring constant":
      case "electric charge":
      case "coarsen":
      case "minimum number of children":
      case "significant sep":
      case "level pre sep":
      case "level post sep":
      case "sibling pre sep":
      case "sibling post sep":
      case "missing nodes get space":
      case "nodes behind edges":
      case "operator":
        continue;
    }
    rest.push(value === undefined ? key : `${key}={${value}}`);
  }
  if (rest.length) applyOptions(g, rest.join(","), "scope", it);
  return st;
}

function placeCircle(gr: Graph, st: Settings, maxW: number): void {
  const n = gr.order.length;
  const r = st.radius ?? Math.max(CM, (n * (maxW + 8)) / (2 * Math.PI));
  gr.order.forEach((x, k) => {
    const a = st.phase + (st.clockwise ? -1 : 1) * (360 * k) / Math.max(1, n);
    x.pos = scale(dir(a), r);
  });
}

function placeSpring(gr: Graph, st: Settings, maxW: number, it: Interp): void {
  const n = gr.order.length;
  if (n > 250) {
    it.warnOnce("spring big", "spring layout of more than 250 nodes is placed on a circle");
    placeCircle(gr, st, maxW);
    return;
  }
  const k = st.nodeDist ?? Math.max(1.5 * CM, maxW * 1.6);
  const P: Pt[] = gr.order.map((_, i) => scale(dir(90 - (360 * i) / Math.max(1, n)), k * Math.max(1, n / 4)));
  const iters = 250;
  let temp = k * 2;
  for (let t = 0; t < iters; t++) {
    it.tick();
    const D: Pt[] = P.map(() => [0, 0]);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const d = sub(P[i], P[j]);
        const l = Math.max(1e-3, Math.hypot(d[0], d[1]));
        const f = (k * k) / l;
        const u = scale(d, f / l);
        D[i] = add(D[i], u);
        D[j] = sub(D[j], u);
      }
    for (const e of gr.edges) {
      const i = e.from.index;
      const j = e.to.index;
      if (i === j) continue;
      const d = sub(P[i], P[j]);
      const l = Math.max(1e-3, Math.hypot(d[0], d[1]));
      const u = scale(d, l / k);
      D[i] = sub(D[i], u);
      D[j] = add(D[j], u);
    }
    for (let i = 0; i < n; i++) {
      const l = Math.max(1e-9, Math.hypot(D[i][0], D[i][1]));
      P[i] = add(P[i], scale(D[i], Math.min(l, temp) / l));
    }
    temp = Math.max(k * 0.01, temp * 0.97);
  }
  gr.order.forEach((x, i) => (x.pos = P[i]));
}

/** Layered layout: positions, and the bends of edges that cross ranks. */
function placeLayered(gr: Graph, st: Settings, it: Interp): Map<GEdge, Pt[]> {
  const bends = new Map<GEdge, Pt[]>();
  const vertical = st.rankdir === "TB" || st.rankdir === "BT";
  const sizes = gr.order.map((x) => [2 * (x.placed?.info.hw ?? 0), 2 * (x.placed?.info.hh ?? 0)] as Pt);
  const along = (s: Pt) => (vertical ? s[1] : s[0]);
  const across = (s: Pt) => (vertical ? s[0] : s[1]);
  const maxAlong = Math.max(0, ...sizes.map(along));
  const avgAcross = sizes.length ? sizes.reduce((a, s) => a + across(s), 0) / sizes.length : 0;
  const ranksep = Math.max(st.levelSep ?? 8, (st.levelDist ?? CM) - maxAlong);
  const nodesep = Math.max(st.siblingSep ?? 6, (st.siblingDist ?? CM) - avgAcross);
  const real = gr.edges.filter((e) => e.from !== e.to);
  try {
    const res = layoutGraph(
      gr.order.map((_, i) => ({ id: String(i), width: sizes[i][0], height: sizes[i][1] })),
      real.map((e, i) => ({ id: i, from: String(e.from.index), to: String(e.to.index) })),
      [],
      // layered.ts puts an empty label rank between node ranks; the two half gaps make one ranksep.
      { rankdir: st.rankdir, nodesep, ranksep, edgesep: 6 },
    );
    gr.order.forEach((x, i) => {
      const p = res.nodes.get(String(i));
      if (p) x.pos = [p.x, -p.y];
    });
    real.forEach((e, i) => {
      const pe = res.edges.get(i);
      if (!pe || pe.points.length <= 2) return;
      // Bends in line with their neighbours add nothing: an edge between adjacent ranks stays straight.
      const pts = pe.points.map((p) => [p[0], -p[1]] as Pt);
      const keep = pts.filter((p, k) => k > 0 && k < pts.length - 1 && offLine(pts[k - 1], p, pts[k + 1]) > 1);
      if (keep.length) bends.set(e, keep);
    });
  } catch (err) {
    it.warn(`layered layout failed (${(err as Error).message}); the nodes were placed in a row`);
    gr.order.forEach((x, i) => (x.pos = [i * CM * 1.5, 0]));
  }
  return bends;
}

/** Distance of `p` from the line through `a` and `b`. */
function offLine(a: Pt, p: Pt, b: Pt): number {
  const d = sub(b, a);
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / l;
}

// ---------------------------------------------------------------- drawing

/** Runs a \graph statement (the text after \graph). Never throws except to stop on the interpreter's caps. */
export function drawGraph(it: Interp, stmt: string, g0: GS): void {
  const g = cloneGS(g0);
  const sc = new Scanner(stmt);
  let opts = "";
  for (;;) {
    sc.ws();
    if (sc.s[sc.i] !== "[") break;
    opts += `${opts ? "," : ""}${sc.options() ?? ""}`;
  }
  sc.ws();
  const body = sc.group("{");
  if (body === undefined) {
    it.warnOnce("graph body", "\\graph needs its body in braces, as in \\graph { a -> b };");
    return;
  }
  const st = settings(opts, g, it);
  const chains = parseGroup(body);
  const gr = build(chains, it);
  if (!gr.order.length) return;
  // Typeset the nodes at the origin.
  const ng = cloneGS(g);
  ng.nodesOpts = [...ng.nodesOpts, ...st.nodes];
  const placed: Placed[] = [];
  try {
    for (const x of gr.order) {
      it.tick();
      if (st.existing && it.nodes.has(x.name)) {
        const info = it.nodes.get(x.name)!;
        x.placed = { info, items: [], name: x.name };
        x.fixed = info.center;
        continue;
      }
      const own: string[] = [];
      for (const { key, value } of parseOptions(x.opts)) {
        if ((key === "x" || key === "y") && value !== undefined) {
          const v = length(value, CM) ?? 0;
          x.fixed = key === "x" ? [v, x.fixed?.[1] ?? 0] : [x.fixed?.[0] ?? 0, v];
        } else if (key === "as") x.text = value ?? "";
        else own.push(value === undefined ? key : `${key}={${value}}`);
      }
      let text = st.empty ? "" : x.text;
      // Names such as x_1 would stop TeX; they read as the formula they look like.
      if ((st.math || /[_^]/.test(text)) && text && !text.includes("$") && !text.includes("\\")) text = `$${text}$`;
      const pn = nodeSpec(it, ng, `[${own.join(",")}] {${text}}`);
      const p = pn ? placeNode(it, pn, { point: [0, 0] }, ng, "g") : undefined;
      if (p) {
        x.placed = p;
        placed.push(p);
        it.nodes.set(x.name, p.info);
      }
    }
    const maxW = Math.max(0, ...gr.order.map((x) => 2 * Math.max(x.placed?.info.hw ?? 0, x.placed?.info.hh ?? 0)));
    let bends = new Map<GEdge, Pt[]>();
    if (st.layout === "layered" && (gr.order.length > LAYERED_NODES || gr.edges.length > LAYERED_EDGES)) {
      it.warnOnce("layered big", `layered layout of more than ${LAYERED_NODES} nodes or ${LAYERED_EDGES} edges is placed on a circle`);
      placeCircle(gr, st, Math.max(0, ...gr.order.map((x) => 2 * Math.max(x.placed?.info.hw ?? 0, x.placed?.info.hh ?? 0))));
    } else if (st.layout === "layered") bends = placeLayered(gr, st, it);
    else if (st.layout === "circle") placeCircle(gr, st, maxW);
    else if (st.layout === "spring") placeSpring(gr, st, maxW, it);
    else {
      cartesian(chains, gr);
      const maxH = Math.max(0, ...gr.order.map((x) => 2 * (x.placed?.info.hh ?? 0)));
      const maxWd = Math.max(0, ...gr.order.map((x) => 2 * (x.placed?.info.hw ?? 0)));
      const sepShift = (s: { dir: Pt; sep: number }): Pt => scale(s.dir, s.sep + (s.dir[0] ? maxWd : maxH));
      const chain = st.chainSep ? sepShift(st.chainSep) : st.chain;
      const group = st.groupSep ? sepShift(st.groupSep) : st.group;
      for (const x of gr.order) x.pos = add(scale(chain, x.col ?? 0), scale(group, x.row ?? 0));
    }
    // Into the picture: layouts other than the default start with the first node at the origin, as drawn.
    const origin = st.layout === "layered" || st.layout === "spring" ? gr.order[0].pos : ([0, 0] as Pt);
    for (const x of gr.order) {
      // Nodes that existed before the graph stay where they are.
      if (!x.placed || !placed.includes(x.placed)) continue;
      x.pos = apply(g.T, x.fixed ?? sub(x.pos, origin));
      moveNode(x.placed, sub(x.pos, x.placed.info.center));
    }
    // Edges under the nodes.
    for (const e of gr.edges) {
      it.tick();
      if (!e.from.placed || !e.to.placed) continue;
      const arrow = e.kind === "->" ? "->" : e.kind === "<-" ? "<-" : e.kind === "<->" ? "<->" : "-";
      const eo = [arrow, ...st.edges, e.opts].filter((o) => o.trim()).join(", ");
      const a = e.from.placed.name;
      const b = e.to.placed.name;
      const pg = cloneGS(g);
      pg.doDraw = false;
      pg.nodesOpts = [];
      const bend = bends.get(e);
      if (e.from === e.to) {
        it.path("path", `(${a}) edge[${eo}${/loop/.test(eo) ? "" : ", loop above"}] (${a})`, pg);
      } else if (bend?.length && !/"|bend|in=|out=/.test(eo)) {
        const pts = bend.map((p) => `(${coordNode(it, apply(g.T, sub(p, origin)))})`).join(" -- ");
        it.path("draw", `[${eo}] (${a}) -- ${pts} -- (${b})`, pg);
      } else it.path("path", `(${a}) edge[${eo}] (${b})`, pg);
    }
  } finally {
    commitNodes(it, placed);
  }
}
