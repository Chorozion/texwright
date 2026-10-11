/**
 * pst-tree: \pstree{root}{successors} with the tree nodes \Tcircle,
 * \TCircle, \TR, \Tr, \Toval, \Tdia, \Ttri, \TC, \Tdot, \Tp, \Tn, \Tf and
 * \Tfan, nested trees, edge labels (\naput, \nbput, \tlput, \trput ...)
 * and terminal labels (~{...}). Trees grow down (treemode=D), up, right or
 * left; levels are levelsep apart and neighbouring subtrees treesep apart.
 */

import type { NodeInfo } from "../tikz/interp.js";
import { type Mat, type Pt, apply, applyLinear, mul } from "../tikz/geom.js";
import { Scanner } from "../tikz/scan.js";
import { type PBox, type PstInterp, box, ellipseSegs, polySegs } from "./interp.js";
import { type Where, connectNodes, labelConn } from "./nodes.js";
import { cmd } from "./registry.js";
import { type PState, CM, cloneState } from "./state.js";

const TREE_NODES = new Set(["Tcircle", "TCircle", "TR", "Tr", "Toval", "Tdia", "Ttri", "TC", "Tdot", "Tp", "Tn", "Tf", "Tfan", "Tc"]);
const MAX_TREE_NODES = 2_000;

interface TNode {
  box: PBox;
  /** How the node's own outline is drawn when it is not a box (TC, Tdot, Tf, Tfan). */
  shape?: "circle" | "dot" | "frame" | "fan" | "point";
  size: number;
  st: PState;
  name?: string;
  isNull: boolean;
  children: TNode[];
  /** Options of the \pstree whose successor this node is: the edge is drawn with them. */
  edgeSt?: PState;
  labels: { where: Where; text: string; opts?: string; star: boolean }[];
  terminal?: { text: string; opts?: string };
  // layout
  x: number;
  y: number;
  /** Extent along the breadth axis, relative to this node's centre. */
  lo: number;
  hi: number;
}

/** Reads one tree node command at the scanner (after the backslash and name). */
function treeNode(it: PstInterp, sc: Scanner, name: string, star: boolean, st0: PState, base: number): TNode {
  const opts = sc.options();
  const st = cloneState(st0);
  it.set(st, opts);
  const nm = st.kv.get("name")?.trim();
  st.kv.delete("name");
  let text = "";
  if (["Tcircle", "TCircle", "TR", "Tr", "Toval", "Tdia", "Ttri", "Tc"].includes(name)) text = it.arg(sc) ?? "";
  const node: TNode = { box: emptyBox(), size: 0, st, isNull: name === "Tn", children: [], labels: [], x: 0, y: 0, lo: 0, hi: 0, ...(nm ? { name: nm } : {}) };
  const inner = () => it.makeBox(text, st, base, false);
  switch (name) {
    case "Tcircle":
    case "TCircle":
    case "Tc":
      node.box = it.frameBox("pscirclebox", inner(), st, star);
      break;
    case "Toval":
      node.box = it.frameBox("psovalbox", inner(), st, star);
      break;
    case "Tdia":
      node.box = it.frameBox("psdiabox", inner(), st, star);
      break;
    case "Ttri":
      node.box = it.frameBox("pstribox", inner(), st, star);
      break;
    case "TR":
    case "Tr":
      node.box = inner();
      if (star) node.box = it.frameBox("psframebox", node.box, st, true);
      break;
    case "TC": {
      const r = it.len(st.kv.get("radius") ?? st.kv.get("Tcradius"), st.runit, st) ?? 0.25 * CM;
      node.shape = "circle";
      node.size = r;
      node.box = sized(2 * r + st.lw, "circle");
      if (star) {
        st.fillstyle = "solid";
        st.fc = st.lc;
      }
      break;
    }
    case "Tdot": {
      const d = st.dotsize[0] + st.dotsize[1] * st.lw;
      node.shape = "dot";
      node.box = sized(d, "circle");
      break;
    }
    case "Tf": {
      const fs = it.len(st.kv.get("framesize"), st.xunit, st) ?? 10;
      node.shape = "frame";
      node.size = fs;
      node.box = sized(fs + st.lw, "rectangle");
      break;
    }
    case "Tfan":
      node.shape = "fan";
      node.box = sized(0, "coordinate");
      break;
    default:
      // \Tp, \Tn: points.
      node.shape = "point";
      node.box = sized(0, "coordinate");
  }
  return node;
}

function emptyBox(): PBox {
  return { w: 0, h: 0, d: 0, shape: "coordinate", hw: 0, hh: 0, draw: () => {} };
}

/** A box of a given size centred on the baseline's middle, drawn by the tree itself. */
function sized(s: number, shape: string): PBox {
  return { w: s, h: s / 2, d: s / 2, shape, hw: s / 2, hh: s / 2, draw: () => {} };
}

/** Reads \pstree[opts]{root}{successors} (after the name) into a tree. */
function readTree(it: PstInterp, sc: Scanner, st0: PState, base: number, count: { n: number }): TNode | undefined {
  const opts = sc.options();
  const st = cloneState(st0);
  it.set(st, opts);
  const rootText = it.arg(sc) ?? "";
  const succText = it.arg(sc) ?? "";
  const roots = readItems(it, rootText, st, base, count, undefined);
  const root = roots[0] ?? { box: emptyBox(), shape: "point" as const, size: 0, st, isNull: true, children: [], labels: [], x: 0, y: 0, lo: 0, hi: 0 };
  root.children = readItems(it, succText, st, base, count, st);
  return root;
}

/** The tree nodes and subtrees in `text`, each with its labels. */
function readItems(it: PstInterp, text: string, st: PState, base: number, count: { n: number }, edgeSt: PState | undefined): TNode[] {
  const out: TNode[] = [];
  const sc = new Scanner(text);
  while (!sc.done) {
    if (++count.n > MAX_TREE_NODES) {
      it.warnOnce("tree-size", "The tree has too many nodes; the rest were left out");
      break;
    }
    it.tick();
    const m = /^\\([A-Za-z]+)(\*?)/.exec(sc.s.slice(sc.i, sc.i + 40));
    if (!m) {
      const ch = sc.s[sc.i];
      if (ch === "~" || ch === "^") {
        sc.i++;
        const o = sc.peek() === "[" ? sc.options() : undefined;
        const t = it.arg(sc) ?? "";
        const last = out[out.length - 1];
        if (last && ch === "~") last.terminal = { text: t, ...(o ? { opts: o } : {}) };
        continue;
      }
      if (ch === "{") {
        // A group of successors.
        const inner = sc.group("{") ?? "";
        out.push(...readItems(it, inner, st, base, count, edgeSt));
        continue;
      }
      sc.i++;
      continue;
    }
    sc.i += m[0].length;
    const name = m[1];
    const star = m[2] === "*";
    if (name === "pstree") {
      const t = readTree(it, sc, st, base, count);
      if (t) {
        if (edgeSt) t.edgeSt = edgeSt;
        out.push(t);
      }
      continue;
    }
    if (TREE_NODES.has(name)) {
      const n = treeNode(it, sc, name, star, st, base);
      if (edgeSt) n.edgeSt = edgeSt;
      out.push(n);
      continue;
    }
    const where: Record<string, Where> = { naput: "above", taput: "above", nbput: "below", tbput: "below", ncput: "on", tvput: "on", thput: "on", tlput: "left", trput: "right" };
    if (Object.hasOwn(where, name)) {
      const o = sc.options();
      const t = it.arg(sc) ?? "";
      const last = out[out.length - 1];
      if (last) last.labels.push({ where: where[name], text: t, star, ...(o ? { opts: o } : {}) });
      continue;
    }
    if (name === "psset") {
      it.set(st, it.arg(sc));
      continue;
    }
    if (name === "skiplevel" || name === "skiplevels") {
      sc.options();
      if (name === "skiplevels") it.arg(sc);
      const inner = it.arg(sc) ?? "";
      out.push(...readItems(it, inner, st, base, count, edgeSt));
      continue;
    }
    // Any other box (\rnode, \psframebox, text) as a node.
    const tmp = new Scanner(sc.s);
    tmp.i = sc.i;
    tmp.options();
    let k = 0;
    // Node boxes (an rnode with its name and text) take two groups, other boxes one.
    const groups = /^(rnode|Rnode|circlenode|ovalnode|dianode|trinode)$/.test(name) ? 2 : 1;
    while (k < groups && tmp.peek() === "{") {
      tmp.group("{");
      k++;
    }
    const piece = `\\${name}${star ? "*" : ""}${sc.s.slice(sc.i, tmp.i)}`;
    sc.i = tmp.i;
    const bx = it.makeBox(piece, st, base, false);
    out.push({ box: bx, size: 0, st, isNull: false, children: [], labels: [], x: 0, y: 0, lo: 0, hi: 0, ...(edgeSt ? { edgeSt } : {}) });
  }
  return out;
}

interface Mode {
  /** Unit vector of growth (depth) and of breadth, in the page. */
  depth: Pt;
  breadth: Pt;
}

function modeOf(m: string): Mode {
  switch (m.trim()) {
    case "U":
      return { depth: [0, 1], breadth: [1, 0] };
    case "R":
      return { depth: [1, 0], breadth: [0, -1] };
    case "L":
      return { depth: [-1, 0], breadth: [0, -1] };
    default:
      return { depth: [0, -1], breadth: [1, 0] };
  }
}

/** Size of a node across the tree (breadth) and along it (depth). */
function extent(n: TNode, mode: Mode): { b: number; d: number } {
  const w = 2 * n.box.hw || n.box.w;
  const h = 2 * n.box.hh || n.box.h + n.box.d;
  return mode.breadth[0] !== 0 ? { b: w, d: h } : { b: h, d: w };
}

/** Lays out a subtree: children positions relative to the node (breadth x, depth y down the tree). */
function layout(it: PstInterp, n: TNode, mode: Mode, depthLevel: number): void {
  it.tick();
  if (depthLevel > 60) return;
  const kids = n.children;
  const st = n.st;
  const sepRaw = (st.kv.get("thislevelsep") ?? st.kv.get("levelsep") ?? "2cm").trim();
  const starred = sepRaw.startsWith("*");
  const levelsep = it.len(sepRaw.replace(/^\*/, ""), st.xunit, st) ?? 2 * CM;
  const treesep = it.len(st.kv.get("thistreesep") ?? st.kv.get("treesep") ?? "0.75cm", st.xunit, st) ?? 0.75 * CM;
  const me = extent(n, mode);
  n.lo = -me.b / 2;
  n.hi = me.b / 2;
  if (!kids.length) return;
  let cursor = 0;
  const centers: number[] = [];
  kids.forEach((k, i) => {
    layout(it, k, mode, depthLevel + 1);
    const shift = i === 0 ? -k.lo : cursor + treesep - k.lo;
    centers.push(shift);
    cursor = shift + k.hi;
  });
  const mid = (centers[0] + centers[centers.length - 1]) / 2;
  let lo = n.lo;
  let hi = n.hi;
  kids.forEach((k, i) => {
    k.x = centers[i] - mid;
    const kd = extent(k, mode).d;
    k.y = starred ? me.d / 2 + levelsep + kd / 2 : levelsep;
    lo = Math.min(lo, k.x + k.lo);
    hi = Math.max(hi, k.x + k.hi);
  });
  n.lo = lo;
  n.hi = hi;
}

interface Placed {
  n: TNode;
  /** Centre in tree box coordinates (pt, y up). */
  c: Pt;
  parent?: Placed;
}

function flatten(n: TNode, mode: Mode, at: Pt, parent: Placed | undefined, out: Placed[]): void {
  const p: Placed = { n, c: at, ...(parent ? { parent } : {}) };
  out.push(p);
  for (const k of n.children) {
    const c: Pt = [at[0] + mode.breadth[0] * k.x + mode.depth[0] * k.y, at[1] + mode.breadth[1] * k.x + mode.depth[1] * k.y];
    flatten(k, mode, c, p, out);
  }
}

/** The tree as a box: its root's centre is where the layout put it inside the box. */
function treeBox(it: PstInterp, root: TNode, st: PState, base: number): PBox {
  const mode = modeOf(root.st.kv.get("treemode") ?? st.kv.get("treemode") ?? "D");
  layout(it, root, mode, 0);
  const placed: Placed[] = [];
  flatten(root, mode, [0, 0], undefined, placed);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of placed) {
    const hw = p.n.box.hw || p.n.box.w / 2;
    const hh = p.n.box.hh || (p.n.box.h + p.n.box.d) / 2;
    x0 = Math.min(x0, p.c[0] - hw);
    x1 = Math.max(x1, p.c[0] + hw);
    y0 = Math.min(y0, p.c[1] - hh);
    y1 = Math.max(y1, p.c[1] + hh);
  }
  if (!Number.isFinite(x0)) x0 = y0 = x1 = y1 = 0;
  const W = x1 - x0;
  const H = y1 - y0;
  return {
    w: W,
    h: H,
    d: 0,
    shape: "rectangle",
    hw: W / 2,
    hh: H / 2,
    draw: (M) => {
      // Tree coordinates: the box's left end of baseline is (x0, y0).
      const T: Mat = mul(M, [1, 0, 0, 1, -x0, -y0]);
      const infos = new Map<Placed, NodeInfo>();
      for (const p of placed) infos.set(p, drawNode(it, p, T));
      for (const p of placed) {
        if (!p.parent || p.n.isNull) continue;
        const a = infos.get(p.parent)!;
        const b = infos.get(p)!;
        const es = cloneState(p.n.edgeSt ?? p.parent.n.st);
        es.fillstyle = "none";
        es.shadow = false;
        const edge = (es.kv.get("edge") ?? "\\ncline").trim();
        if (/^(none|\\relax)$/.test(edge)) continue;
        const em = /^\\nc([a-z]+)\s*(?:\[([^\]]*)\])?/.exec(edge);
        if (em?.[2]) it.set(es, em[2]);
        const kind = { line: "line", arc: "arc", curve: "curve", angle: "angle", angles: "angles", bar: "bar", diag: "diag", diagg: "diagg", loop: "loop" }[em?.[1] ?? "line"] ?? "line";
        connectNodes(it, kind, a, b, es);
        for (const l of p.n.labels) {
          const ls = cloneState(es);
          it.set(ls, l.opts);
          labelConn(it, l.where, it.makeBox(l.text, ls, base, false), ls, l.star);
        }
      }
      // Terminal labels beyond each leaf.
      for (const p of placed) {
        const t = p.n.terminal;
        if (!t) continue;
        const ls = cloneState(p.n.st);
        it.set(ls, t.opts);
        const bx = it.makeBox(t.text, ls, base, false);
        const info = infos.get(p)!;
        const dv = applyLinear(T, mode.depth);
        const k = Math.hypot(dv[0], dv[1]) || 1;
        const u: Pt = [dv[0] / k, dv[1] / k];
        const reach = Math.abs(u[0]) > 0.5 ? info.hw : info.hh;
        const sep = it.len(ls.kv.get("tnsep"), ls.xunit, ls) ?? 3;
        const Q: Pt = [info.center[0] + u[0] * (reach + sep), info.center[1] + u[1] * (reach + sep)];
        const ref: Pt = u[1] < -0.5 ? [bx.w / 2, bx.h] : u[1] > 0.5 ? [bx.w / 2, -bx.d] : u[0] > 0 ? [0, (bx.h - bx.d) / 2] : [bx.w, (bx.h - bx.d) / 2];
        it.place(bx, Q, ref, 0, { ...ls, T: [1, 0, 0, 1, 0, 0] });
      }
    },
  };
}

/** Draws one tree node centred at its place and returns it as a node for edges. */
function drawNode(it: PstInterp, p: Placed, T: Mat): NodeInfo {
  const n = p.n;
  const center = apply(T, p.c);
  const ax = applyLinear(T, [1, 0]);
  const k = Math.hypot(ax[0], ax[1]) || 1;
  const rot = (Math.atan2(ax[1], ax[0]) * 180) / Math.PI;
  const st = n.st;
  let info: NodeInfo = { name: n.name ?? "", center, shape: n.box.shape, hw: n.box.hw * k, hh: n.box.hh * k, rot, baseDy: 0 };
  switch (n.shape) {
    case "circle": {
      const r = n.size * k;
      it.drawPath(ellipseSegs(center, [r, 0], [0, r]), st, { closed: true });
      info = { ...info, shape: "circle", hw: r + st.lw / 2, hh: r + st.lw / 2 };
      break;
    }
    case "dot":
      it.dot(center, st);
      break;
    case "frame": {
      const h = (n.size * k) / 2;
      it.drawPath(polySegs([[center[0] - h, center[1] - h], [center[0] + h, center[1] - h], [center[0] + h, center[1] + h], [center[0] - h, center[1] + h]], true), st, { closed: true });
      info = { ...info, shape: "rectangle", hw: h, hh: h };
      break;
    }
    case "fan":
    case "point":
      info = { ...info, shape: "coordinate", hw: 0, hh: 0 };
      break;
    default: {
      // The box with its centre at the place.
      const b = n.box;
      const ref: Pt = [b.w / 2, (b.h - b.d) / 2];
      b.draw(mul(T, mul([1, 0, 0, 1, p.c[0], p.c[1]], [1, 0, 0, 1, -ref[0], -ref[1]])));
    }
  }
  if (n.name) it.addNode(n.name, { ...info, name: n.name });
  return info;
}

box("pstree", (it, sc, st, _star, base) => {
  const root = readTree(it, sc, st, base, { n: 0 });
  return root ? treeBox(it, root, st, base) : undefined;
});

/** A \pstree in the picture's flow sits with its lower left corner at the origin. */
cmd("pstree", ({ it, sc, st, base }) => {
  const root = readTree(it, sc, st, base, { n: 0 });
  if (!root) return;
  const bx = treeBox(it, root, st, base);
  it.place(bx, apply(st.T, [0, 0]), [0, 0], 0, st);
});

// Tree nodes outside a tree: drawn as their node boxes at the origin.
cmd("Tcircle TCircle TR Tr Toval Tdia Ttri TC Tdot Tp Tn Tf Tfan", ({ it, sc, st, name, star, base }) => {
  const n = treeNode(it, sc, name, star, st, base);
  const p: Placed = { n, c: [0, 0] };
  drawNode(it, p, st.T);
});
