/**
 * Mermaid mindmaps: an indented outline drawn as a balanced mind map.
 *
 * The first node is the root; every other line hangs under the nearest line
 * above it with less indentation (spaces or tabs). Shapes follow Mermaid's
 * delimiters: id[square], id(rounded), id((circle)), id))bang((, id)cloud(,
 * id{{hexagon}}, and plain text, drawn as an underlined word. `::icon(...)`
 * lines are accepted and not drawn; `:::name` classes understand a few
 * conventional names (urgent, large).
 *
 * Layout is our own. The root sits in the middle; its branches are split
 * between the right and the left so the two sides weigh about the same, and
 * read clockwise. Each branch is a tidy tree growing outward: children are
 * stacked by their contours (per depth, with the x range each depth covers),
 * so a short subtree tucks in beside a deep one, and a parent is centred on
 * its children. Connectors are tapered curves in the branch's colour that
 * run into the underline of plain nodes, so a branch reads as one stroke.
 */

import { labelSvg, n, type Pt, shapeSize, shapeSvg, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import type { Theme } from "./theme.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment, unquote } from "./types.js";

export type MindmapShape = "default" | "square" | "rounded" | "circle" | "bang" | "cloud" | "hexagon";

export interface MindmapNode {
  id: string;
  label: string;
  shape: MindmapShape;
  depth: number;
  children: MindmapNode[];
  classes: string[];
  icon?: string;
  /** 0-based source line. */
  line: number;
}

// ---------------------------------------------------------------- colour

function parseHex(c: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return undefined;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `a` mixed with `b`: t = 0 gives a, 1 gives b. Colours that are not hex give whichever is nearer. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return t < 0.5 ? a : b;
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Relative luminance 0..1 of a hex colour (0.5 when unknown). */
export function luminance(c: string): number {
  const x = parseHex(c);
  if (!x) return 0.5;
  const [r, g, b] = x.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The page colour diagrams sit on: the theme's background, or white when it is transparent. */
export function pageColor(t: Theme): string {
  return t.background === "transparent" ? "#ffffff" : t.background;
}

// ---------------------------------------------------------------- parsing

const OPENERS: [string, MindmapShape, string][] = [
  ["((", "circle", "))"],
  ["))", "bang", "(("],
  ["{{", "hexagon", "}}"],
  ["(", "rounded", ")"],
  [")", "cloud", "("],
  ["[", "square", "]"],
];

/** Columns of leading whitespace, a tab reaching the next multiple of 4. */
function indentWidth(ws: string): number {
  let w = 0;
  for (const c of ws) w = c === "\t" ? (Math.floor(w / 4) + 1) * 4 : w + 1;
  return w;
}

/** Reads one node's text: shape, id and label. */
function parseNodeText(text: string, ln: number, col: number, err: (e: DiagramError) => void): { id: string; label: string; shape: MindmapShape } {
  const head = /^[^[(){}"]*/.exec(text)![0];
  const rest = text.slice(head.length);
  const id = head.trim();
  // No delimiter, a quoted label, or words before it (as in "History (1990s)"): plain text.
  if (!rest || rest[0] === '"' || /\s/.test(head.trimStart())) {
    const label = unquote(text);
    return { id: label, label, shape: "default" };
  }
  const op = OPENERS.find(([o]) => rest.startsWith(o));
  if (!op) {
    const label = unquote(text);
    return { id: label, label, shape: "default" };
  }
  const [open, shape, close] = op;
  let inner = rest.slice(open.length);
  if (inner.trimEnd().endsWith(close)) inner = inner.trimEnd().slice(0, -close.length);
  else {
    err({
      line: ln,
      col: col + head.length,
      message: `The ${shape} node is not closed with "${close}"`,
      hint: `Write ${id || "id"}${open}text${close}`,
      fix: { old: rest, new: rest.trimEnd() + close },
    });
  }
  const label = unquote(inner);
  return { id: id || label, label, shape };
}

/** The mindmap's tree, or undefined when there is no node. Problems go to `errors`. */
export function parseMindmap(src: string, errors: DiagramError[]): MindmapNode | undefined {
  const err = (e: DiagramError) => errors.push(e);
  const lines = src.split(/\r?\n/);
  let headerSeen = false;
  let root: MindmapNode | undefined;
  let rootIndent = 0;
  let rootWs = "";
  let last: MindmapNode | undefined;
  /** Open ancestors with their indentation; children's indentation per parent, from the first child. */
  const stack: { node: MindmapNode; indent: number }[] = [];
  const childIndent = new Map<MindmapNode, { width: number; ws: string; line: number }>();

  for (let ln = 0; ln < lines.length; ln++) {
    const start = ln;
    let raw = stripComment(lines[ln]);
    // A quoted label may run over several lines (Markdown strings do); join them, keeping the breaks.
    const quotes = (x: string) => x.match(/"/g)?.length ?? 0;
    while (quotes(raw) % 2 === 1 && ln + 1 < lines.length) raw += "\n" + stripComment(lines[++ln]).trim();
    if (!raw.trim()) continue;
    const ws = /^[ \t]*/.exec(raw)![0];
    const col = ws.length;
    let text = raw.trim();
    if (!headerSeen) {
      headerSeen = true;
      const h = /^mindmap\b\s*(.*)$/.exec(text);
      if (h) {
        if (!h[1].trim()) continue;
        // "mindmap Root" on one line: the rest is the root.
        text = h[1].trim();
      }
    }
    if (/^(accTitle|accDescr)\b/.test(text)) continue;

    // Decorations of the node above.
    const deco = /^(::icon\s*\(([^)]*)\)?|:::\s*(.*))$/.exec(text);
    if (deco) {
      if (!last) {
        err({ line: start, col, message: "An icon or class line comes before any node", hint: "Put ::icon(...) or :::class on the line after the node it belongs to" });
        continue;
      }
      if (deco[3] !== undefined) last.classes.push(...deco[3].split(/\s+/).filter(Boolean));
      else {
        if (!deco[1].trimEnd().endsWith(")")) err({ line: start, col, message: "The icon is not closed with \")\"", hint: "Write ::icon(fa fa-book)", fix: { old: text, new: text + ")" } });
        last.icon = deco[2].trim();
      }
      continue;
    }

    // A class list at the end of the node: A[Text] :::urgent
    const classes: string[] = [];
    const tail = /\s:::\s*([\w-]+(?:\s+[\w-]+)*)\s*$/.exec(text);
    if (tail && (text.slice(0, tail.index).match(/"/g)?.length ?? 0) % 2 === 0) {
      classes.push(...tail[1].split(/\s+/));
      text = text.slice(0, tail.index).trimEnd();
    }

    const indent = indentWidth(ws);
    const p = parseNodeText(text, start, col, err);
    const node: MindmapNode = { ...p, depth: 0, children: [], classes, line: start };
    if (!root) {
      root = node;
      rootIndent = indent;
      rootWs = ws;
      stack.push({ node, indent });
      last = node;
      continue;
    }
    let parent: MindmapNode;
    if (indent <= rootIndent) {
      const want = rootWs + "  ";
      err({
        line: start,
        col,
        message: "A mindmap has one root; this line is not indented under it",
        hint: `Indent it more than the root "${root.label.slice(0, 30)}"`,
        fix: { old: raw.split("\n")[0].trimEnd(), new: want + raw.split("\n")[0].trim() },
      });
      // Read it as a child of the root.
      parent = root;
      stack.length = 1;
      const known = childIndent.get(root);
      stack.push({ node, indent: known ? known.width : rootIndent + 2 });
      if (!known) childIndent.set(root, { width: rootIndent + 2, ws: want, line: start });
    } else {
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      parent = stack[stack.length - 1].node;
      const known = childIndent.get(parent);
      // A misindented line keeps its own indentation for what follows, so its deeper lines stay its children.
      const at = indent;
      if (!known) childIndent.set(parent, { width: indent, ws, line: start });
      else if (known.width !== indent) {
        const first = raw.split("\n")[0];
        err({
          line: start,
          col,
          message: `Inconsistent indentation: ${indent} columns here, ${known.width} for the sibling on line ${known.line + 1}`,
          hint: "Indent the children of one node by the same amount",
          fix: { old: first.trimEnd(), new: known.ws + first.trim() },
        });
      }
      stack.push({ node, indent: at });
    }
    node.depth = parent.depth + 1;
    parent.children.push(node);
    last = node;
  }
  if (!root) err({ line: 0, col: 0, message: "The mindmap has no nodes", hint: "Write the root on the line after mindmap, and indent its branches under it" });
  return root;
}

// ---------------------------------------------------------------- layout

interface Box {
  node: MindmapNode;
  label: Label;
  /** The drawn shape's full size. */
  w: number;
  h: number;
  /** Growth-relative position of this node's inner edge and centre, relative to its parent's inner edge and centre. */
  rx: number;
  ry: number;
  children: Box[];
  /** Absolute centre and side (+1 right, -1 left) once placed. */
  cx: number;
  cy: number;
  side: number;
  color: string;
}

/** One depth of a subtree's outline: its x range (growth direction) and y extent. */
interface Level {
  x0: number;
  x1: number;
  top: number;
  bot: number;
}

const GAP = (depth: number) => (depth <= 1 ? 34 : 26);
const VGAP = (depth: number) => (depth <= 1 ? 14 : 7);

/** Places `subs` (contours relative to each child's own anchor) one below the other; returns offsets and the merged outline. */
function stack(subs: Level[][], gap: number): { offsets: number[]; merged: Level[] } {
  const offsets: number[] = [];
  let merged: Level[] = [];
  for (const sub of subs) {
    if (!offsets.length) {
      offsets.push(0);
      merged = sub.map((l) => ({ ...l }));
      continue;
    }
    let off = -Infinity;
    for (const a of merged) {
      for (const b of sub) {
        if (a.x1 + 6 <= b.x0 || b.x1 + 6 <= a.x0) continue;
        off = Math.max(off, a.bot + gap - b.top);
      }
    }
    // Nothing overlaps in x (cannot happen for siblings, whose own boxes share x): stack plainly.
    if (off === -Infinity) off = merged[0].bot + gap - sub[0].top;
    offsets.push(off);
    sub.forEach((l, k) => {
      const s = { x0: l.x0, x1: l.x1, top: l.top + off, bot: l.bot + off };
      if (k < merged.length) {
        const m = merged[k];
        merged[k] = { x0: Math.min(m.x0, s.x0), x1: Math.max(m.x1, s.x1), top: Math.min(m.top, s.top), bot: Math.max(m.bot, s.bot) };
      } else merged.push(s);
    });
  }
  return { offsets, merged };
}

/** Lays out a subtree growing in +x from its inner edge at 0, centred at y = 0; returns its outline. */
function layoutSubtree(b: Box): Level[] {
  const own: Level = { x0: 0, x1: b.w, top: -b.h / 2, bot: b.h / 2 };
  if (!b.children.length) return [own];
  const gx = b.w + GAP(b.node.depth);
  const subs = b.children.map(layoutSubtree);
  const { offsets, merged } = stack(subs, VGAP(b.node.depth + 1));
  const shift = -(offsets[0] + offsets[offsets.length - 1]) / 2;
  b.children.forEach((c, i) => {
    c.rx = gx;
    c.ry = offsets[i] + shift;
  });
  return [own, ...merged.map((l) => ({ x0: l.x0 + gx, x1: l.x1 + gx, top: l.top + shift, bot: l.bot + shift }))];
}

/** Absolute positions from the relative ones; `gx` is the inner edge in growth coordinates. */
function place(b: Box, gx: number, cy: number, side: number, color: string): void {
  b.side = side;
  b.cy = cy;
  b.cx = side * (gx + b.w / 2);
  b.color = color;
  for (const c of b.children) place(c, gx + c.rx, cy + c.ry, side, color);
}

// ---------------------------------------------------------------- shapes

/** Points evenly spaced along a superellipse (|x/a|^4 + |y/b|^4 = 1), clockwise from the left. */
function superellipse(a: number, b: number, count: number): Pt[] {
  const S = 160;
  const pts: Pt[] = [];
  for (let i = 0; i <= S; i++) {
    const th = Math.PI + (2 * Math.PI * i) / S;
    const c = Math.cos(th);
    const s = Math.sin(th);
    pts.push([a * Math.sign(c) * Math.sqrt(Math.abs(c)), b * Math.sign(s) * Math.sqrt(Math.abs(s))]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const want = (total * k) / count;
    while (j + 1 < cum.length && cum[j + 1] < want) j++;
    const f = cum[j + 1] > cum[j] ? (want - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f]);
  }
  return out;
}

/** Base axes of a cloud or bang around a padded text box of bw x bh, and the bump count. */
function puffGeometry(kind: "cloud" | "bang", bw: number, bh: number): { a: number; b: number; count: number; chord: number } {
  const grow = kind === "bang" ? 10 : 4;
  const a = (bw / 2) * 1.16 + grow;
  const b = (bh / 2) * 1.2 + grow;
  const per = 2 * Math.PI * Math.sqrt((a * a + b * b) / 2) * 1.08;
  const count = Math.max(kind === "bang" ? 10 : 8, Math.round(per / (kind === "bang" ? 22 : 28)));
  return { a, b, count, chord: per / count };
}

/** Outline of a cloud (outward bumps) or bang (inward scallops between spikes). */
function puffPath(kind: "cloud" | "bang", cx: number, cy: number, bw: number, bh: number): string {
  const g = puffGeometry(kind, bw, bh);
  const pts = superellipse(g.a, g.b, g.count);
  let d = `M${n(cx + pts[0][0])} ${n(cy + pts[0][1])}`;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const r = Math.hypot(q[0] - p[0], q[1] - p[1]) * (kind === "cloud" ? 0.62 : 0.8);
    d += `A${n(r)} ${n(r)} 0 0 ${kind === "cloud" ? 1 : 0} ${n(cx + q[0])} ${n(cy + q[1])}`;
  }
  return d + "Z";
}

// ---------------------------------------------------------------- connectors

/** A tapered curve from p to q, leaving and arriving horizontally; widths w0 at p and w1 at q. */
function taper(p: Pt, q: Pt, w0: number, w1: number): string {
  const dx = q[0] - p[0];
  const c: [Pt, Pt, Pt, Pt] = [p, [p[0] + dx * 0.5, p[1]], [q[0] - dx * 0.55, q[1]], q];
  const N = 22;
  const top: Pt[] = [];
  const bot: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const x = u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0];
    const y = u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1];
    let tx = 3 * u * u * (c[1][0] - c[0][0]) + 6 * u * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]);
    let ty = 3 * u * u * (c[1][1] - c[0][1]) + 6 * u * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1]);
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const s = t * t * (3 - 2 * t);
    const half = (w0 + (w1 - w0) * s) / 2;
    top.push([x - ty * half, y + tx * half]);
    bot.push([x + ty * half, y - tx * half]);
  }
  const all = [...top, ...bot.reverse()];
  return `M${all.map((pt) => `${n(pt[0])} ${n(pt[1])}`).join("L")}Z`;
}

// ---------------------------------------------------------------- drawing

export function renderMindmap(src: string, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const root = parseMindmap(src, ctx.errors);
  if (!root) return { svg: "", width: 0, height: 0 };
  const page = pageColor(t);
  const fs = t.fontSize;

  const measure = (nd: MindmapNode): Box => {
    const large = nd.classes.some((c) => /^(large|big|huge)$/i.test(c));
    const size = (nd.depth === 0 ? fs + 3 : nd.depth === 1 ? fs : fs - 1) + (large ? 3 : 0);
    const md = /^\s*`/.test(nd.label);
    const bold = nd.depth === 0 || nd.classes.some((c) => /^(urgent|critical|important|bold)$/i.test(c));
    // Bold labels are measured bold (the tags make every piece bold); Markdown strings keep their own emphasis.
    const raw = bold && !md ? `<b>${nd.label}</b>` : nd.label;
    // Circles grow with the square of their text, so their text is wrapped narrower.
    const maxW = nd.shape === "circle" ? (nd.depth === 0 ? 120 : 100) : nd.depth === 0 ? 190 : 170;
    const label = layoutLabel(raw, size, maxW, 1.25);
    let shape = nd.shape;
    if (nd.depth === 0 && shape === "default") shape = "rounded";
    const lw = Math.max(label.width, 6);
    const lh = Math.max(label.height, size);
    let w: number;
    let h: number;
    switch (shape) {
      case "default":
        [w, h] = [lw + 4, lh + 7];
        break;
      case "circle":
        [w, h] = shapeSize("circle", lw, lh, 0, nd.depth === 0 ? 18 : 12);
        break;
      case "hexagon":
        [w, h] = shapeSize("hexagon", lw, lh, 12, 7);
        break;
      case "cloud":
      case "bang": {
        const g = puffGeometry(shape, lw + 16, lh + 8);
        const out = shape === "cloud" ? g.chord * 0.27 : 0;
        [w, h] = [2 * (g.a + out), 2 * (g.b + out)];
        break;
      }
      default:
        [w, h] = nd.depth === 0 ? [lw + 40, lh + 20] : [lw + 22, lh + 12];
    }
    return { node: { ...nd, shape }, label, w, h, rx: 0, ry: 0, children: nd.children.map(measure), cx: 0, cy: 0, side: 1, color: "" };
  };
  const top = measure(root);
  top.cx = 0;
  top.cy = 0;
  top.color = t.text;

  // Branches: subtree outlines, then a right/left split that balances their heights.
  const outlines = top.children.map(layoutSubtree);
  const extent = outlines.map((o) => Math.max(...o.map((l) => l.bot)) - Math.min(...o.map((l) => l.top)));
  const total = extent.reduce((s, e) => s + e, 0);
  let k = top.children.length;
  if (top.children.length > 1) {
    let best = Infinity;
    let acc = 0;
    for (let i = 1; i < top.children.length; i++) {
      acc += extent[i - 1];
      const d = Math.abs(acc - (total - acc));
      if (d < best - 0.5) {
        best = d;
        k = i;
      }
    }
    // Ties go to the right, which is read first.
    if (top.children.length === 2) k = 1;
  }
  const sides: { idx: number[]; side: number }[] = [
    { idx: [...Array(k).keys()], side: 1 },
    // Clockwise: the left side is read from the bottom up.
    { idx: [...Array(top.children.length - k).keys()].map((i) => top.children.length - 1 - i), side: -1 },
  ];
  for (const { idx, side } of sides) {
    if (!idx.length) continue;
    const { offsets, merged } = stack(
      idx.map((i) => outlines[i]),
      VGAP(1) + 4,
    );
    const span = Math.max(...merged.map((l) => l.bot)) - Math.min(...merged.map((l) => l.top));
    const mid = (Math.max(...merged.map((l) => l.bot)) + Math.min(...merged.map((l) => l.top))) / 2;
    // Taller sides spread their branches further, so the connectors fan out instead of crowding.
    const gx0 = top.w / 2 + Math.min(80, Math.max(40, 26 + span * 0.08));
    idx.forEach((i, j) => {
      const c = top.children[i];
      const color = t.palette[i % t.palette.length];
      place(c, gx0, offsets[j] - mid, side, color);
    });
  }

  // Bounds.
  let x0 = -top.w / 2;
  let x1 = top.w / 2;
  let y0 = -top.h / 2;
  let y1 = top.h / 2;
  const visit = (b: Box, f: (b: Box) => void) => {
    f(b);
    for (const c of b.children) visit(c, f);
  };
  visit(top, (b) => {
    x0 = Math.min(x0, b.cx - b.w / 2);
    x1 = Math.max(x1, b.cx + b.w / 2);
    y0 = Math.min(y0, b.cy - b.h / 2);
    y1 = Math.max(y1, b.cy + b.h / 2);
  });
  const M = 8;
  const ox = M - x0;
  const oy = M - y0;
  const X = (x: number) => x + ox;
  const Y = (y: number) => y + oy;

  const urgent = (b: Box) => b.node.classes.some((c) => /^(urgent|critical|important)$/i.test(c));
  const strokeOf = (b: Box) => (urgent(b) ? "#c8463f" : b.color);
  /** Thickness of the line arriving at a node at this depth (its underline continues it). */
  const endWidth = (depth: number) => (depth === 1 ? 2.4 : depth === 2 ? 1.5 : 1.1);
  const startWidth = (depth: number) => (depth === 1 ? 6 : endWidth(depth - 1));
  /** Where lines leave and arrive: the underline for plain nodes, the middle of the side otherwise. */
  const anchorY = (b: Box) => (b.node.shape === "default" ? b.cy + b.h / 2 : b.cy);
  const outer = (b: Box): Pt => [b.cx + b.side * (b.w / 2), anchorY(b)];
  const inner = (b: Box): Pt => {
    const s = b.node.shape;
    // Round shapes are met a little inside their box, where their outline is.
    const inset = s === "circle" ? b.w * 0.06 : s === "cloud" || s === "bang" ? b.w * 0.08 : 0;
    return [b.cx - b.side * (b.w / 2 - inset), anchorY(b)];
  };

  const lines: string[] = [];
  const nodes: string[] = [];
  const drawLinks = (b: Box) => {
    for (const c of b.children) {
      const from: Pt = b === top ? [b.cx + c.side * b.w * 0.18, b.cy] : outer(b);
      const to = inner(c);
      const color = c.color;
      lines.push(`<path d="${taper([X(from[0]), Y(from[1])], [X(to[0]), Y(to[1])], startWidth(c.node.depth), endWidth(c.node.depth))}" fill="${color}"/>`);
      drawLinks(c);
    }
  };
  drawLinks(top);

  const drawNode = (b: Box) => {
    const nd = b.node;
    const cx = X(b.cx);
    const cy = Y(b.cy);
    const isRoot = nd.depth === 0;
    const stroke = isRoot ? t.text : strokeOf(b);
    const fill = isRoot ? t.text : mix(b.color, page, nd.depth === 1 ? 0.84 : 0.91);
    const ink = isRoot ? (luminance(t.text) < 0.4 ? page : "#1f2937") : t.text;
    const sw = isRoot ? 0 : nd.depth === 1 ? 1.4 : 1.1;
    const style = { fill, stroke: isRoot ? "none" : stroke, strokeWidth: sw, radius: 4, shadow: t.shadow };
    switch (nd.shape) {
      case "default": {
        const y = cy + b.h / 2;
        nodes.push(`<path d="M${n(cx - b.w / 2)} ${n(y)}H${n(cx + b.w / 2)}" stroke="${stroke}" stroke-width="${n(endWidth(Math.max(1, nd.depth)))}" stroke-linecap="round" fill="none"/>`);
        nodes.push(labelSvg(b.label, cx, cy - 1.5, ink));
        return;
      }
      case "square":
        nodes.push(shapeSvg("rect", cx, cy, b.w, b.h, { ...style, radius: 2 }));
        break;
      case "rounded":
        nodes.push(shapeSvg("rect", cx, cy, b.w, b.h, { ...style, radius: Math.min(b.h / 2, isRoot ? 18 : 9) }));
        break;
      case "circle":
        nodes.push(shapeSvg("circle", cx, cy, b.w, b.h, style));
        break;
      case "hexagon":
        nodes.push(shapeSvg("hexagon", cx, cy, b.w, b.h, style));
        break;
      case "cloud":
      case "bang": {
        const lw = Math.max(b.label.width, 6) + 16;
        const lh = Math.max(b.label.height, b.label.size) + 8;
        const sh = t.shadow;
        if (sh) nodes.push(`<path d="${puffPath(nd.shape, cx + sh.dx, cy + sh.dy, lw, lh)}" fill="${sh.color}" fill-opacity="${n(sh.opacity)}"/>`);
        nodes.push(`<path d="${puffPath(nd.shape, cx, cy, lw, lh)}" fill="${fill}" stroke="${style.stroke}" stroke-width="${n(sw)}" stroke-linejoin="round"/>`);
        break;
      }
    }
    nodes.push(labelSvg(b.label, cx, cy, ink, {}));
  };
  visit(top, (b) => {
    if (b !== top) drawNode(b);
  });
  drawNode(top);

  const width = x1 - x0 + 2 * M;
  const height = y1 - y0 + 2 * M;
  const body = `<g>${lines.join("")}</g><g>${nodes.join("")}</g>`;
  return { svg: svgDocument(width, height, body, t, ctx.title), width, height };
}
