/**
 * TikZ trees: the `child` operations after a node, as in
 *
 *   \node {root} child {node {a} child {node {b}}} child[missing] child {node {c}};
 *
 * Children are placed the way TikZ places them, with no packing: each child
 * sits `level distance` along the growth direction from its parent, and the
 * children of one parent are spread `sibling distance` apart across it (so
 * subtrees may overlap, as they do in TikZ). Supported: grow and grow' with
 * a direction or angle, grow cyclic, clockwise from and counterclockwise
 * from with sibling angle, level and level n styles, every child, every
 * child node, child[missing], child foreach, named children, edge from
 * parent with options and label nodes, edge from parent path, parent and
 * child anchor, edge from parent fork down/up/left/right, and mind maps
 * (mindmap, concept, concept color, level n concept, root concept) with
 * their circle connection bars approximated as tapered shaded bars.
 *
 * Nodes are laid out first and kept aside, the edges are drawn, then the
 * nodes go on top: the same layering TikZ produces. The helpers for that
 * (placeNode, moveNode, commitNodes) are shared with forest.ts and graphs.ts.
 */

import { parseColor } from "./color.js";
import { length, num } from "./expr.js";
import { type Pt, add, applyLinear, dir, scale, sub, unit } from "./geom.js";
import { type Interp, type NodeInfo, type PendingNode, readNodeSpec } from "./interp.js";
import { applyOptions } from "./options.js";
import { Scanner } from "./scan.js";
import { CM, type GS, cloneGS } from "./state.js";

/** What the scene keeps for one drawn thing. */
export type Items = Interp["scene"]["items"];

/** A laid-out node and what it drew, not yet in the scene. */
export interface Placed {
  info: NodeInfo;
  items: Items;
  /** The internal name it is registered under. */
  name: string;
}

const serials = new WeakMap<Interp, number>();

/** A fresh internal node name (letters and @ only, so `name.anchor` still parses). */
export function internalName(it: Interp, kind: string): string {
  const n = (serials.get(it) ?? 0) + 1;
  serials.set(it, n);
  return `tw@${kind}${toLetters(n)}`;
}

function toLetters(n: number): string {
  let s = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}

/** Lays out a node at `where` (or its own `at`) and takes what it drew out of the scene. Undefined when it cannot be placed. */
export function placeNode(it: Interp, pn: PendingNode, where: { point: Pt } | undefined, g: GS, kind = "n"): Placed | undefined {
  const k = it.scene.items.length;
  const info = it.node(pn, where, g);
  const items = it.scene.items.splice(k);
  if (!info) return undefined;
  const name = internalName(it, kind);
  it.nodes.set(name, info);
  return { info, items, name };
}

/** Registers a bare point as a coordinate node, for paths that must start or end there. */
export function coordNode(it: Interp, p: Pt, kind = "c"): string {
  const name = internalName(it, kind);
  it.nodes.set(name, { name, center: p, shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
  return name;
}

/** Moves a placed node (and what it drew) by `d`. */
export function moveNode(p: Placed, d: Pt): void {
  if (!Number.isFinite(d[0]) || !Number.isFinite(d[1]) || (Math.abs(d[0]) < 1e-9 && Math.abs(d[1]) < 1e-9)) return;
  p.info.center = add(p.info.center, d);
  const tr = `translate(${round(d[0])} ${round(-d[1])})`;
  for (const item of p.items) {
    item.svg = `<g transform="${tr}">${item.svg}</g>`;
    item.box = [item.box[0] + d[0], item.box[1] + d[1], item.box[2] + d[0], item.box[3] + d[1]];
  }
}

function round(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** Puts kept-aside node drawings into the scene, after everything drawn so far. */
export function commitNodes(it: Interp, placed: Placed[]): void {
  for (const p of placed) it.scene.items.push(...p.items);
  placed.length = 0;
}

/** Reads `[options] (name) {text}` after the word node against `g`. */
export function nodeSpec(it: Interp, g: GS, text: string, coordinate = false): PendingNode | undefined {
  return readNodeSpec(it, g, new Scanner(text), coordinate);
}

/** Skips `[opts] (name) at (p) {text}` after the word node, returning nothing. */
export function skipNodeSpec(sc: Scanner, coordinate = false): void {
  for (;;) {
    sc.ws();
    const c = sc.s[sc.i];
    if (c === "[") sc.options();
    else if (c === "(") sc.group("(");
    else if (sc.word("at")) sc.group("(");
    else break;
  }
  if (!coordinate) sc.group("{");
}

/** True (and consumed) when `sc` continues with the keyword `w` (not followed by a letter). */
export function keyword(sc: Scanner, w: string): boolean {
  sc.ws();
  if (!sc.s.startsWith(w, sc.i) || /[A-Za-z]/.test(sc.s[sc.i + w.length] ?? "")) return false;
  sc.i += w.length;
  return true;
}

/** Replaces \x by its value for each foreach variable. */
export function substVars(text: string, vars: Map<string, string>): string {
  let s = text;
  for (const [k, v] of vars) s = s.replace(new RegExp(`\\\\${k.replace(/[^A-Za-z@]/g, "")}(?![A-Za-z@])`, "g"), () => v);
  return s;
}

// ---------------------------------------------------------------- keys

const GROW: Record<string, number> = {
  down: -90,
  south: -90,
  up: 90,
  north: 90,
  left: 180,
  west: 180,
  right: 0,
  east: 0,
  "north east": 45,
  "north west": 135,
  "south east": -45,
  "south west": -135,
};

/** A direction name or an angle in degrees. */
export function growAngle(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (Object.hasOwn(GROW, t)) return GROW[t];
  return num(t);
}

function setKeys(g: GS, kv: Record<string, string>): void {
  g.tkeys = { ...(g.tkeys ?? {}), ...kv };
}

/** Mind map sizes by level: minimum size, text width, font, level distance, sibling angle. */
const CONCEPT: [string, string, string, string, string][] = [
  ["4cm", "3.5cm", "\\large", "5cm", "60"],
  ["2.5cm", "2.2cm", "\\small", "5cm", "60"],
  ["1.8cm", "1.6cm", "\\footnotesize", "3cm", "45"],
  ["1.4cm", "1.2cm", "\\scriptsize", "2.5cm", "30"],
  ["1.1cm", "1cm", "\\tiny", "2cm", "30"],
];

/**
 * Tree, mind map and graph keys (OptionHost.extra): stored on the state for
 * trees.ts and graphs.ts to read. Returns true when the key was one of them.
 */
export function treeKey(it: Interp, key: string, value: string | undefined, g: GS): boolean {
  switch (key) {
    case "level distance":
    case "sibling distance":
    case "sibling angle":
    case "level sep":
    case "sibling sep": {
      const v = key === "sibling angle" ? num(value ?? "") : length(value ?? "", CM);
      if (v !== undefined && Number.isFinite(v)) setKeys(g, { [key]: String(v) });
      return true;
    }
    case "grow":
    case "grow'": {
      const a = growAngle(value);
      if (a !== undefined && Number.isFinite(a)) setKeys(g, { grow: String(a), growRev: key === "grow'" ? "1" : "0", growMode: "linear" });
      return true;
    }
    case "grow cyclic":
      setKeys(g, { growMode: "cyclic" });
      return true;
    case "clockwise from":
    case "counterclockwise from": {
      const a = num(value ?? "0") ?? 0;
      setKeys(g, { growMode: key === "clockwise from" ? "cw" : "ccw", from: String(a) });
      return true;
    }
    case "missing":
      setKeys(g, { missing: "1" });
      return true;
    case "edge from parent path":
      if (value !== undefined) setKeys(g, { efp: value });
      return true;
    case "parent anchor":
    case "child anchor":
      setKeys(g, { [key]: (value ?? "").trim() });
      return true;
    case "edge from parent fork down":
    case "edge from parent fork up":
    case "edge from parent fork left":
    case "edge from parent fork right": {
      const side = key.slice("edge from parent fork ".length);
      const [pa, ca] = side === "down" ? ["south", "north"] : side === "up" ? ["north", "south"] : side === "left" ? ["west", "east"] : ["east", "west"];
      setKeys(g, { fork: side, "parent anchor": pa, "child anchor": ca });
      return true;
    }
    case "growth parent anchor":
    case "edge from parent macro":
      return true;
    // Mind maps.
    case "mindmap":
    case "small mindmap":
    case "large mindmap":
    case "huge mindmap": {
      setKeys(g, { mindmap: "1", growMode: g.tkeys?.growMode === "cw" || g.tkeys?.growMode === "ccw" ? g.tkeys.growMode : "cyclic", ...(key === "small mindmap" ? { mmscale: "0.6" } : key === "huge mindmap" ? { mmscale: "1.4" } : {}) });
      // level n follows level n concept, unless the picture says otherwise.
      const styles = new Map(g.styles);
      for (let l = 1; l <= 4; l++) if (!styles.has(`level ${l}`)) styles.set(`level ${l}`, { body: `level ${l} concept` });
      g.styles = styles;
      return true;
    }
    case "concept color":
      if (value) setKeys(g, { "concept color": value.trim() });
      return true;
    case "root concept":
    case "level 1 concept":
    case "level 2 concept":
    case "level 3 concept":
    case "level 4 concept": {
      const l = key === "root concept" ? 0 : Number(key.charAt(6));
      const c = CONCEPT[l];
      const k = Number(g.tkeys?.mmscale ?? "1");
      const ld = (length(c[3], CM) ?? 0) * k;
      setKeys(g, { clevel: String(l), ...(l > 0 ? { "level distance": String(ld), "sibling angle": c[4] } : {}) });
      if (key === "root concept") concept(it, g);
      return true;
    }
    case "concept":
    case "extra concept":
      concept(it, g);
      return true;
    case "circle connection bar":
    case "concept connection":
    case "circle connection bar switch color":
    case "every concept":
    case "every annotation":
      return true;
    case "annotation":
      applyOptions(g, "rectangle, align=left, font=\\footnotesize, text width=3cm, fill=white, draw=none", "node", it);
      return true;
  }
  return false;
}

/** The concept style: a filled circle in the concept colour, sized by level. */
function concept(it: Interp, g: GS): void {
  const lvl = Math.min(4, Math.max(0, Number(g.tkeys?.clevel ?? g.tkeys?.level ?? "0") || 0));
  const [ms, tw, font] = CONCEPT[lvl];
  const k = Number(g.tkeys?.mmscale ?? "1");
  const color = g.tkeys?.["concept color"] ?? "black!25";
  const size = (length(ms, CM) ?? 40) * k;
  const width = (length(tw, CM) ?? 30) * k;
  applyOptions(g, `circle, fill={${color}}, minimum size=${size}pt, text width=${width}pt, align=center, inner sep=0pt, font=${font}`, "node", it);
  g.drawColor = null;
  g.doDraw = false;
}

// ---------------------------------------------------------------- trees

interface ChildSpec {
  opts: string;
  body: string;
}

interface TNode {
  /** Where its children are measured from. */
  origin: Pt;
  /** Direction of growth that led to it (for grow cyclic). */
  angle: number;
  name: string;
  info?: NodeInfo;
  g: GS;
  level: number;
}

const MAX_LEVELS = 60;
const TEN_MM = 15 * (CM / 10);

/**
 * Draws a tree: `root` is the node before the first `child` (or the current
 * point), `sc` sits at the first `child`. Reads the children, lays them out,
 * draws edges and then the nodes. Never throws except to stop on the
 * interpreter's work caps.
 */
export function drawTree(it: Interp, root: { pn?: PendingNode; where?: { point: Pt } }, sc: Scanner, g0: GS): void {
  const placed: Placed[] = [];
  const g = cloneGS(g0);
  try {
    let top: TNode;
    if (root.pn) {
      const p = placeNode(it, root.pn, root.where, g, "t");
      if (p) {
        placed.push(p);
        const origin = root.pn.at ? root.pn.at.p : root.pn.g.place || !root.where ? p.info.center : root.where.point;
        top = { origin, angle: 0, name: p.name, info: p.info, g: root.pn.g, level: 0 };
      } else {
        const pt = root.where?.point ?? [0, 0];
        top = { origin: pt, angle: 0, name: coordNode(it, pt), g, level: 0 };
      }
    } else {
      const pt = root.where?.point ?? [0, 0];
      top = { origin: pt, angle: 0, name: coordNode(it, pt), g, level: 0 };
    }
    const specs = readChildren(it, sc, g);
    children(it, top, specs, g, placed);
  } finally {
    commitNodes(it, placed);
  }
}

/** Reads `child [opts] {body}` (and `child foreach`) operations; options between them apply to `g`. */
function readChildren(it: Interp, sc: Scanner, g: GS): ChildSpec[] {
  const out: ChildSpec[] = [];
  for (;;) {
    sc.ws();
    if (sc.s[sc.i] === "[") {
      applyOptions(g, sc.options() ?? "", "path", it);
      continue;
    }
    if (!keyword(sc, "child")) break;
    it.tick();
    let opts = "";
    for (;;) {
      sc.ws();
      if (sc.s[sc.i] !== "[") break;
      opts += `${opts ? "," : ""}${sc.options() ?? ""}`;
    }
    if (keyword(sc, "foreach")) {
      const head = it.foreachHead(sc);
      sc.ws();
      const body = sc.s[sc.i] === "{" ? (sc.group("{") ?? "") : "";
      if (!head) {
        it.warnOnce("child foreach", "cannot read this child foreach; it was skipped");
        continue;
      }
      it.loop(head, (vars) => out.push({ opts: substVars(opts, vars), body: substVars(body, vars) }));
      continue;
    }
    sc.ws();
    const body = sc.s[sc.i] === "{" ? (sc.group("{") ?? "") : "";
    out.push({ opts, body });
  }
  return out;
}

/** Lays out and draws the children of `p`. */
function children(it: Interp, p: TNode, specs: ChildSpec[], pg: GS, placed: Placed[]): void {
  const n = specs.length;
  if (!n) return;
  if (p.level + 1 > MAX_LEVELS) {
    it.warnOnce("tree depth", `the tree nests more than ${MAX_LEVELS} levels deep; the deeper levels were left out`);
    return;
  }
  specs.forEach((spec, idx) => {
    it.tick();
    const i = idx + 1;
    const level = p.level + 1;
    const cg = childScope(it, pg, spec.opts, level);
    const tk = cg.tkeys ?? {};
    if (tk.missing === "1") return;
    // Where the child goes.
    const L = finite(num(tk["level distance"] ?? ""), TEN_MM);
    const S = finite(num(tk["sibling distance"] ?? ""), TEN_MM);
    const mode = tk.growMode ?? "linear";
    const sa = finite(num(tk["sibling angle"] ?? ""), 20);
    let offset: Pt;
    let angle: number;
    if (mode === "cyclic") {
      angle = p.angle + sa * (i - (n + 1) / 2);
      offset = scale(dir(angle), L);
    } else if (mode === "cw" || mode === "ccw") {
      const from = finite(num(tk.from ?? "0"), 0);
      angle = mode === "ccw" ? from + (i - 1) * sa : from - (i - 1) * sa;
      offset = scale(dir(angle), L);
    } else {
      angle = finite(num(tk.grow ?? ""), -90);
      const k = ((n + 1) / 2 - i) * S * (tk.growRev === "1" ? -1 : 1);
      offset = add(scale(dir(angle), L), scale(dir(angle - 90), k));
    }
    const point = add(p.origin, applyLinear(cg.T, offset));
    // The child's own path: options, its node, its children, edge from parent.
    const sc = new Scanner(spec.body);
    let pn: PendingNode | undefined;
    let sub: ChildSpec[] = [];
    const edgeOpts: string[] = [];
    const edgeNodes: string[] = [];
    let inEdge = false;
    while (!sc.done) {
      it.tick();
      const c = sc.s[sc.i];
      if (c === "[") {
        const o = sc.options() ?? "";
        if (inEdge) edgeOpts.push(o);
        else applyOptions(cg, o, "path", it);
        continue;
      }
      if (keyword(sc, "edge from parent")) {
        if (keyword(sc, "path")) {
          sc.ws();
          if (sc.s[sc.i] === "=") sc.i++;
          const v = sc.group("{");
          if (v !== undefined) setKeys(cg, { efp: v });
          continue;
        }
        inEdge = true;
        continue;
      }
      const isNode = keyword(sc, "node");
      const isCoord = !isNode && keyword(sc, "coordinate");
      if (isNode || isCoord) {
        if (inEdge) {
          const from = sc.i;
          skipNodeSpec(sc, isCoord);
          edgeNodes.push(`${isCoord ? "coordinate" : "node"}${sc.s.slice(from, sc.i)}`);
        } else if (!pn) pn = readNodeSpec(it, nodeScope(cg), sc, isCoord);
        else {
          // A second node in one child: TikZ draws it at the same place; keep the first.
          skipNodeSpec(sc, isCoord);
          it.warnOnce("child two nodes", "a child holds more than one node; only the first was drawn");
        }
        continue;
      }
      if (sc.startsWith("child")) {
        sub = sub.concat(readChildren(it, sc, cg));
        continue;
      }
      // Anything else in a child: skip a token.
      const m = /^\\?[A-Za-z]+|^./.exec(sc.s.slice(sc.i));
      it.warnOnce(`child:${m?.[0] ?? ""}`, `cannot read "${sc.s.slice(sc.i, sc.i + 20).trim()}" in a child; it was skipped`);
      sc.i += m ? m[0].length : 1;
    }
    let node: TNode;
    if (pn) {
      const pl = placeNode(it, pn, { point }, cg, "t");
      if (pl) {
        placed.push(pl);
        node = { origin: pn.at ? pn.at.p : point, angle, name: pl.name, info: pl.info, g: cg, level };
        if (pn.name) it.nodes.set(pn.name, pl.info);
      } else node = { origin: point, angle, name: coordNode(it, point), g: cg, level };
    } else node = { origin: point, angle, name: coordNode(it, point), g: cg, level };
    edge(it, p, node, cg, edgeOpts, edgeNodes);
    children(it, node, sub, cg, placed);
  });
}

function finite(v: number | undefined, dflt: number): number {
  return v !== undefined && Number.isFinite(v) ? v : dflt;
}

/** The state of a child: every child, level, level n, then its own options. */
function childScope(it: Interp, pg: GS, opts: string, level: number): GS {
  const cg = cloneGS(pg);
  cg.labels = [];
  const tk: Record<string, string> = { ...(pg.tkeys ?? {}), level: String(level) };
  delete tk.missing;
  delete tk.clevel;
  cg.tkeys = tk;
  const every = cg.styles.get("every child");
  if (every?.body) applyOptions(cg, every.body, "path", it);
  if (cg.styles.has("level")) applyOptions(cg, `level=${level}`, "path", it);
  if (cg.styles.has(`level ${level}`)) applyOptions(cg, `level ${level}`, "path", it);
  if (opts) applyOptions(cg, opts, "path", it);
  return cg;
}

/** The state a child's node is read against: `every child node` joins the path's node options. */
function nodeScope(cg: GS): GS {
  const ecn = cg.styles.get("every child node");
  if (!ecn?.body) return cg;
  const ng = cloneGS(cg);
  ng.nodesOpts = [ecn.body, ...ng.nodesOpts];
  return ng;
}

/** The edge from parent `p` to child `c`. */
function edge(it: Interp, p: TNode, c: TNode, cg: GS, edgeOpts: string[], edgeNodes: string[]): void {
  const tk = cg.tkeys ?? {};
  const eg = cloneGS(cg);
  eg.doDraw = false;
  eg.doFill = false;
  eg.shade = undefined;
  eg.labels = [];
  eg.nodesOpts = [...cg.nodesOpts];
  const style = cg.styles.get("edge from parent");
  applyOptions(eg, style ? style.body : "draw", "path", it);
  for (const o of edgeOpts) applyOptions(eg, o, "path", it);
  if (tk.mindmap === "1" && !edgeOpts.length && !tk.efp && p.info && c.info) {
    conceptBar(it, p, c, eg);
    if (!edgeNodes.length) return;
  }
  const pa = tk["parent anchor"] ? `.${tk["parent anchor"]}` : "";
  const ca = tk["child anchor"] ? `.${tk["child anchor"]}` : "";
  let tpl = tk.efp;
  if (!tpl && tk.fork) {
    const L = finite(num(tk["level distance"] ?? ""), TEN_MM) / 2;
    const v = tk.fork === "down" ? `0pt,${-L}pt` : tk.fork === "up" ? `0pt,${L}pt` : tk.fork === "left" ? `${-L}pt,0pt` : `${L}pt,0pt`;
    const op = tk.fork === "down" || tk.fork === "up" ? "-|" : "|-";
    tpl = `(\\tikzparentnode\\tikzparentanchor) -- +(${v}) ${op} (\\tikzchildnode\\tikzchildanchor)`;
  }
  tpl ??= "(\\tikzparentnode\\tikzparentanchor) -- \\tikzedgenodes (\\tikzchildnode\\tikzchildanchor)";
  let text = tpl
    .replace(/\\tikzparentnode(?![A-Za-z@])\s*/g, p.name)
    .replace(/\\tikzchildnode(?![A-Za-z@])\s*/g, c.name)
    .replace(/\\tikzparentanchor(?![A-Za-z@])\s*/g, pa)
    .replace(/\\tikzchildanchor(?![A-Za-z@])\s*/g, ca)
    .replace(/\\tikzleveldistance(?![A-Za-z@])/g, `${finite(num(tk["level distance"] ?? ""), TEN_MM)}pt`)
    .replace(/\\tikzsiblingdistance(?![A-Za-z@])/g, `${finite(num(tk["sibling distance"] ?? ""), TEN_MM)}pt`);
  const nodes = edgeNodes.join(" ");
  if (text.includes("\\tikzedgenodes")) text = text.replace(/\\tikzedgenodes(?![A-Za-z@])/g, () => nodes);
  else if (nodes) {
    // Labels of a custom edge path go on its last segment.
    const k = text.lastIndexOf("(");
    text = k >= 0 ? `${text.slice(0, k)} ${nodes} ${text.slice(k)}` : `${text} ${nodes}`;
  }
  it.path("path", text, eg);
}

/** A mind map's connection: a bar narrowing in the middle, shaded from the parent's concept colour to the child's. */
function conceptBar(it: Interp, p: TNode, c: TNode, eg: GS): void {
  const a = p.info!;
  const b = c.info!;
  const v = sub(b.center, a.center);
  const d = Math.hypot(v[0], v[1]);
  if (!(d > a.hw + b.hw - 1)) return;
  const u = unit(v);
  const nrm: Pt = [-u[1], u[0]];
  const ra = Math.max(1, a.hw);
  const rb = Math.max(1, b.hw);
  const h = Math.min(ra, rb) * 0.45;
  const at = (n: NodeInfo, r: number, s: number, toward: number): Pt => {
    const sn = Math.min(0.95, h / r);
    const cs = Math.sqrt(1 - sn * sn);
    return add(n.center, add(scale(u, toward * r * cs), scale(nrm, s * r * sn)));
  };
  const a1 = at(a, ra, 1, 1);
  const a2 = at(a, ra, -1, 1);
  const b1 = at(b, rb, 1, -1);
  const b2 = at(b, rb, -1, -1);
  const mid = add(a.center, scale(u, (ra + d - rb) / 2));
  const pinch = (s: number): Pt => add(mid, scale(nrm, s * h * 0.55));
  // Control points halfway between each end and the pinch, so the sides curve in.
  const ctl = (from: Pt, s: number): Pt => scale(add(from, pinch(s)), 0.5);
  const colorOf = (n: TNode) => parseColor(n.g.tkeys?.["concept color"] ?? "black!25", it.colors, it.lookup, n.g.color) ?? "#bfbfbf";
  const ca = colorOf(p);
  const cb = colorOf(c);
  const segs = [
    { t: "M" as const, p: a1 },
    { t: "C" as const, c1: ctl(a1, 1), c2: ctl(b1, 1), p: b1 },
    { t: "L" as const, p: b2 },
    { t: "C" as const, c1: ctl(b2, -1), c2: ctl(a2, -1), p: a2 },
    { t: "Z" as const },
  ];
  const ang = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  const style = ca === cb ? { lineWidth: 0, fill: ca } : { lineWidth: 0, shade: { kind: "linear" as const, angle: ang, stops: [[0.15, ca], [0.85, cb]] as [number, string][] } };
  if (it.scene.path(segs, style, eg.clips, eg.layer)) it.drawn++;
}
