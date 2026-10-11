/**
 * Mermaid flowcharts (`flowchart` and `graph`): parsed here, laid out by
 * layered.ts, drawn with the shared shapes and the theme.
 *
 * The syntax covered is what people and models actually write: directions,
 * every node shape including the `@{ shape: ... }` form, solid, thick,
 * dotted and invisible links with arrow, circle and cross ends, longer links,
 * labels as `-- text -->` or `-->|text|`, chains (`a --> b --> c`) and `&`
 * groups, nested subgraphs (and links to them), classDef, class, :::,
 * style and linkStyle. A statement that cannot be read is reported with its
 * line and column and skipped; the rest of the diagram is still drawn.
 */

import { type LayoutResult, layoutGraph, type RankDir } from "./layered.js";
import {
  type Cubic,
  type EndKind,
  bez,
  endInset,
  endSvg,
  esc,
  exitT,
  insideShape,
  labelSvg,
  n,
  pathData,
  type Pt,
  reverse,
  type ShapeKind,
  shapeSize,
  shapeSvg,
  smoothPath,
  splitCubic,
  svgDocument,
} from "./svg.js";
import { layoutLabel } from "./text.js";
import { safeColor } from "./theme.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment, unquote } from "./types.js";

type LineStyle = "solid" | "thick" | "dotted" | "invisible";

interface FNode {
  id: string;
  label: string;
  shape: ShapeKind;
  classes: string[];
  style: Record<string, string>;
  cluster?: string;
}

interface FEdge {
  index: number;
  from: string;
  to: string;
  label?: string;
  line: LineStyle;
  start: EndKind;
  end: EndKind;
  minlen: number;
  style: Record<string, string>;
}

interface FCluster {
  id: string;
  title: string;
  parent?: string;
}

export interface Flowchart {
  direction: RankDir;
  nodes: Map<string, FNode>;
  edges: FEdge[];
  clusters: Map<string, FCluster>;
  classDefs: Map<string, Record<string, string>>;
  linkStyles: Map<number | "default", Record<string, string>>;
}

const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.$]|-(?=[\p{L}\p{N}_]))*/u;

const SHAPES: [string, string[], ShapeKind[]][] = [
  ["(((", [")))"], ["doublecircle"]],
  ["((", ["))"], ["circle"]],
  ["([", ["])"], ["stadium"]],
  ["[[", ["]]"], ["subroutine"]],
  ["[(", [")]"], ["cylinder"]],
  ["{{", ["}}"], ["hexagon"]],
  ["[/", ["/]", "\\]"], ["parallelogram", "trapezoid"]],
  ["[\\", ["\\]", "/]"], ["parallelogram-alt", "trapezoid-alt"]],
  ["[", ["]"], ["rect"]],
  ["(", [")"], ["round"]],
  ["{", ["}"], ["diamond"]],
  [">", ["]"], ["asymmetric"]],
];

/** Names of the `@{ shape: ... }` form, mapped to the shapes we draw. */
const NAMED_SHAPES: Record<string, ShapeKind> = {
  rect: "rect", rectangle: "rect", proc: "rect", process: "rect",
  rounded: "round", event: "round",
  stadium: "stadium", pill: "stadium", terminal: "stadium",
  subproc: "subroutine", subprocess: "subroutine", "framed-rectangle": "subroutine", fr: "subroutine",
  cyl: "cylinder", cylinder: "cylinder", db: "cylinder", database: "cylinder",
  circle: "circle", circ: "circle", "sm-circ": "point", "small-circle": "point", start: "point",
  "dbl-circ": "doublecircle", "double-circle": "doublecircle", "fr-circ": "doublecircle", stop: "doublecircle",
  diam: "diamond", diamond: "diamond", decision: "diamond", question: "diamond",
  hex: "hexagon", hexagon: "hexagon", prepare: "hexagon",
  "lean-r": "parallelogram", "in-out": "parallelogram", "lean-right": "parallelogram",
  "lean-l": "parallelogram-alt", "out-in": "parallelogram-alt", "lean-left": "parallelogram-alt",
  "trap-b": "trapezoid", priority: "trapezoid", trapezoid: "trapezoid",
  "trap-t": "trapezoid-alt", manual: "trapezoid-alt", "inv-trapezoid": "trapezoid-alt",
  doc: "document", document: "document",
  "flag": "asymmetric", "odd": "asymmetric",
  "fork": "fork", "join": "fork",
};

const HEADS: Record<string, EndKind> = { ">": "arrow", "<": "arrow", x: "cross", o: "circle" };

/** Splits a line into statements at `;` outside quotes and brackets. */
function statements(line: string): { text: string; col: number }[] {
  const out: { text: string; col: number }[] = [];
  let depth = 0;
  let q = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (q) continue;
    else if ("[({".includes(c)) depth++;
    else if ("])}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0 && (i + 1 >= line.length || /\s/.test(line[i + 1]))) {
      out.push({ text: line.slice(start, i), col: start });
      start = i + 1;
    }
  }
  out.push({ text: line.slice(start), col: start });
  return out.filter((s) => s.text.trim());
}

function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/,(?![^(]*\))/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/\s*!important$/, "");
  }
  return out;
}

export function parseFlowchart(src: string, errors: DiagramError[]): Flowchart {
  const fc: Flowchart = { direction: "TB", nodes: new Map(), edges: [], clusters: new Map(), classDefs: new Map(), linkStyles: new Map() };
  const stack: FCluster[] = [];
  /** Nodes mentioned in each open subgraph. As in Mermaid, a subgraph claims them when it closes (inner before outer), and a node stays with the first subgraph that claims it. */
  const mentions: string[][] = [];
  const claimed = new Set<string>();
  let headerSeen = false;
  let anon = 0;
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, hint, fix });

  const touch = (id: string): FNode => {
    let nd = fc.nodes.get(id);
    if (!nd) {
      nd = { id, label: id, shape: "rect", classes: [], style: {} };
      fc.nodes.set(id, nd);
    }
    // Mentions inside a subgraph are claimed when it closes (see "end").
    if (stack.length && !fc.clusters.has(id)) mentions[mentions.length - 1].push(id);
    return nd;
  };

  const lines = src.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    let raw = stripComment(lines[ln]);
    // A quoted label may run over several lines (Mermaid's Markdown strings do); join them, keeping the breaks.
    const quotes = (x: string) => x.match(/"/g)?.length ?? 0;
    while (quotes(raw) % 2 === 1 && ln + 1 < lines.length) raw += "\n" + stripComment(lines[++ln]).trim();
    if (!raw.trim()) continue;
    for (const st of statements(raw)) {
      const lead = st.text.length - st.text.trimStart().length;
      const text = st.text.trim();
      const col0 = st.col + lead;
      if (!headerSeen) {
        const h = /^(flowchart|graph|flowchart-elk)\b\s*(TB|TD|BT|LR|RL|>|<|\^|v)?\s*(.*)$/i.exec(text);
        if (h) {
          headerSeen = true;
          const d = (h[2] ?? "TB").toUpperCase();
          fc.direction = d === "TD" || d === "V" ? "TB" : d === ">" ? "LR" : d === "<" ? "RL" : d === "^" ? "BT" : (d as RankDir);
          if (h[3].trim()) chain(h[3], ln, col0 + text.length - h[3].length);
          continue;
        }
        headerSeen = true;
      }
      const kw = /^(subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|title)\b\s*(.*)$/.exec(text);
      if (kw) {
        const rest = kw[2];
        switch (kw[1]) {
          case "subgraph": {
            let id: string;
            let title: string;
            const m = /^([\p{L}\p{N}_\-.$]+)\s*\[(.*)\]\s*$/u.exec(rest);
            if (m) {
              id = m[1];
              title = unquote(m[2]);
            } else if (/^".*"$/.test(rest.trim())) {
              title = unquote(rest);
              id = `\u0000sg${anon++}`;
            } else if (rest.trim()) {
              id = rest.trim();
              title = id;
            } else {
              id = `\u0000sg${anon++}`;
              title = "";
            }
            const cl: FCluster = fc.clusters.get(id) ?? { id, title };
            cl.title = title;
            cl.parent = stack[stack.length - 1]?.id;
            fc.clusters.set(id, cl);
            // A subgraph that shares a node's name is the subgraph, not the node.
            fc.nodes.delete(id);
            stack.push(cl);
            mentions.push([]);
            break;
          }
          case "end":
            if (rest.trim()) {
              // "end" followed by something is an ordinary statement about a node called end... which Mermaid forbids.
              err(ln, col0, `"end" closes a subgraph and cannot be used as a node name`, 'Rename the node, for example to "End" or "finish"');
            } else {
              const cl = stack.pop();
              const ids = mentions.pop() ?? [];
              if (!cl) err(ln, col0, '"end" without a subgraph to close', "Remove it, or add the subgraph it closes");
              else
                for (const id of ids) {
                  if (claimed.has(id)) continue;
                  claimed.add(id);
                  const nd = fc.nodes.get(id);
                  if (nd) nd.cluster = cl.id;
                  // The outer subgraph sees this node too, but it is already claimed.
                  mentions[mentions.length - 1]?.push(id);
                }
            }
            break;
          case "direction":
            if (!stack.length) {
              const d = rest.trim().toUpperCase();
              if (d === "TB" || d === "TD" || d === "BT" || d === "LR" || d === "RL") fc.direction = d === "TD" ? "TB" : d;
            }
            break;
          case "classDef": {
            const m = /^([\w,\- ]+?)\s+(.+)$/.exec(rest);
            if (!m) {
              err(ln, col0, "classDef needs a class name and styles", "For example: classDef warn fill:#fdd,stroke:#c33");
              break;
            }
            for (const name of m[1].split(",")) fc.classDefs.set(name.trim(), { ...(fc.classDefs.get(name.trim()) ?? {}), ...parseStyle(m[2]) });
            break;
          }
          case "class": {
            const m = /^([^\s]+)\s+([\w,\-]+)\s*$/.exec(rest);
            if (!m) {
              err(ln, col0, "class needs node names and a class name", "For example: class A,B warn");
              break;
            }
            for (const id of m[1].split(",")) {
              const nd = fc.nodes.get(id.trim()) ?? touch(id.trim());
              nd.classes.push(...m[2].split(",").map((x) => x.trim()));
            }
            break;
          }
          case "style": {
            const m = /^([^\s]+)\s+(.+)$/.exec(rest);
            if (!m) break;
            const nd = fc.nodes.get(m[1]) ?? touch(m[1]);
            Object.assign(nd.style, parseStyle(m[2]));
            break;
          }
          case "linkStyle": {
            const m = /^(default|[\d,\s]+?)\s+(.+)$/.exec(rest);
            if (!m) break;
            const st2 = parseStyle(m[2].replace(/\s*interpolate\s+\w+/, ""));
            if (m[1] === "default") fc.linkStyles.set("default", st2);
            else for (const k of m[1].split(",")) if (k.trim()) fc.linkStyles.set(Number(k), st2);
            break;
          }
          default:
            // click, accTitle, accDescr, title: nothing to draw.
            break;
        }
        continue;
      }
      chain(text, ln, col0);
    }
  }
  if (stack.length) err(lines.length - 1, 0, `subgraph "${stack[stack.length - 1].title || stack[stack.length - 1].id}" is never closed`, 'Add "end" after its last line');
  return fc;

  /** A chain of node groups joined by links: a & b --> c -- text --> d. */
  function chain(text: string, ln: number, col0: number): void {
    let i = 0;
    const ws = () => {
      while (i < text.length && /\s/.test(text[i])) i++;
    };
    const group = (): string[] | undefined => {
      const ids: string[] = [];
      for (;;) {
        ws();
        const id = node();
        if (id === undefined) return undefined;
        ids.push(id);
        ws();
        if (text[i] === "&") {
          i++;
          continue;
        }
        return ids;
      }
    };
    const node = (): string | undefined => {
      const rest = text.slice(i);
      const m = ID.exec(rest);
      if (!m) {
        if (!rest.trim()) err(ln, col0 + i, "The link has no node after it", "End the link at a node: A --> B");
        else err(ln, col0 + i, `Expected a node name, found "${rest.slice(0, 12)}"`, "Node names are letters, digits and _; put any other text in a label: A[My text]");
        return undefined;
      }
      const id = m[0];
      i += id.length;
      const nd = fc.clusters.has(id) ? undefined : touch(id);
      // @{ shape: ..., label: "..." }
      if (text.startsWith("@{", i)) {
        const close = text.indexOf("}", i);
        if (close < 0) {
          err(ln, col0 + i, "Unclosed @{ ... }", "Close it with }");
          i = text.length;
          return id;
        }
        const body = text.slice(i + 2, close);
        i = close + 1;
        if (nd) {
          for (const m2 of body.matchAll(/(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/g)) {
            const k = m2[1].toLowerCase();
            const v = unquote(m2[2]);
            if (k === "shape") {
              const s = NAMED_SHAPES[v.trim().toLowerCase()];
              if (s) nd.shape = s;
            } else if (k === "label") nd.label = v;
          }
        }
      }
      for (const [open, closes, kinds] of SHAPES) {
        if (!text.startsWith(open, i)) continue;
        let j = i + open.length;
        let label: string;
        let kind: ShapeKind | undefined;
        if (text[j] === '"') {
          const endq = text.indexOf('"', j + 1);
          if (endq < 0) {
            err(ln, col0 + j, "Unclosed quote in a node label", 'Close the label with "');
            i = text.length;
            return id;
          }
          label = text.slice(j + 1, endq);
          j = endq + 1;
          while (j < text.length && text[j] === " ") j++;
          const k = closes.findIndex((c) => text.startsWith(c, j));
          if (k < 0) {
            err(ln, col0 + j, `Expected "${closes[0]}" to close the node shape`, undefined, { old: "", new: closes[0] });
            i = text.length;
            return id;
          }
          kind = kinds[k];
          j += closes[k].length;
        } else {
          let best = -1;
          let bestK = 0;
          closes.forEach((c, k) => {
            const at = text.indexOf(c, j);
            if (at >= 0 && (best < 0 || at < best)) {
              best = at;
              bestK = k;
            }
          });
          if (best < 0) {
            err(ln, col0 + i, `The node shape opened with "${open}" is not closed`, `Close it with "${closes[0]}"`);
            i = text.length;
            return id;
          }
          label = text.slice(j, best);
          kind = kinds[bestK];
          j = best + closes[bestK].length;
        }
        if (nd) {
          nd.label = label;
          nd.shape = kind!;
        }
        i = j;
        break;
      }
      if (text.startsWith(":::", i)) {
        const m3 = /^:::([\w\-]+)/.exec(text.slice(i));
        if (m3) {
          if (nd) nd.classes.push(m3[1]);
          i += m3[0].length;
        }
      }
      return id;
    };
    const link = (): Omit<FEdge, "index" | "from" | "to" | "style"> | undefined => {
      ws();
      const rest = text.slice(i);
      const full = /^([<xo]?)(-{2,}|={2,}|-\.+-|~{3,})([>xo]?)(?![\p{L}\p{N}_])/u.exec(rest) ?? /^([<xo]?)(-{2,}|={2,}|-\.+-|~{3,})([>]?)/.exec(rest);
      const kindOf = (body: string): LineStyle => (body.startsWith("~") ? "invisible" : body.startsWith("=") ? "thick" : body.includes(".") ? "dotted" : "solid");
      const lengthOf = (body: string, headed: boolean): number => {
        if (body.startsWith("~")) return 1;
        if (body.includes(".")) return Math.max(1, body.length - 2);
        return Math.max(1, body.length - (headed ? 1 : 2));
      };
      let res: Omit<FEdge, "index" | "from" | "to" | "style"> | undefined;
      const complete = full && (full[3] || full[2].length >= 3 || full[2].includes(".") || full[2].startsWith("~"));
      if (full && complete) {
        i += full[0].length;
        res = { line: kindOf(full[2]), start: full[1] ? HEADS[full[1]] : "none", end: full[3] ? HEADS[full[3]] : "none", minlen: lengthOf(full[2], !!full[3]) };
      } else {
        // Text in the middle: -- text -->, == text ==>, -. text .->
        const open = /^([<xo]?)(--|==|-\.)/.exec(rest);
        if (!open) return undefined;
        const closeRe = open[2] === "--" ? /(-{2,})([>xo]?)/g : open[2] === "==" ? /(={2,})([>xo]?)/g : /(\.+-)([>xo]?)/g;
        closeRe.lastIndex = open[0].length;
        let m: RegExpExecArray | null;
        let found: RegExpExecArray | undefined;
        while ((m = closeRe.exec(rest))) {
          const ok = open[2] === "-." || m[2] || m[1].length >= 3;
          const after = rest[m.index + m[0].length];
          if (ok && (after === undefined || /[\s\p{L}\p{N}_"(\[{]/u.test(after))) {
            found = m;
            break;
          }
        }
        if (!found) {
          err(ln, col0 + i, `A link with text is not closed`, open[2] === "--" ? 'Close it like this: A -- text --> B, or write A -->|text| B' : open[2] === "==" ? "Close it like this: A == text ==> B" : "Close it like this: A -. text .-> B");
          return undefined;
        }
        const label = rest.slice(open[0].length, found.index).trim();
        i += found.index + found[0].length;
        const body = open[2] === "-." ? "-" + found[1] : found[1];
        res = { line: kindOf(open[2] === "-." ? "-." : open[2]), start: open[1] ? HEADS[open[1]] : "none", end: found[2] ? HEADS[found[2]] : "none", minlen: lengthOf(body, !!found[2]), label: unquote(label) };
      }
      ws();
      if (text[i] === "|") {
        const close = text.indexOf("|", i + 1);
        if (close < 0) {
          err(ln, col0 + i, "Unclosed |label| on a link", "Close it with |");
          i = text.length;
        } else {
          res.label = unquote(text.slice(i + 1, close));
          i = close + 1;
        }
      }
      return res;
    };

    let left = group();
    if (!left) return;
    for (;;) {
      ws();
      if (i >= text.length) return;
      const at = i;
      const l = link();
      if (!l) {
        err(ln, col0 + at, `Expected a link such as --> after "${text.slice(0, at).trim().slice(-20)}", found "${text.slice(at, at + 12)}"`, "Links are --> --- -.-> ==> and --o --x; write A --> B");
        return;
      }
      const right = group();
      if (!right) return;
      for (const a of left) for (const b of right) fc.edges.push({ index: fc.edges.length, from: a, to: b, style: {}, ...l });
      left = right;
    }
  }
}

// ---------------------------------------------------------------- drawing

const PAD_X = 14;
const PAD_Y = 9;
const WRAP = 240;

export function renderFlowchart(src: string, ctx: DiagramContext): Rendered {
  const fc = parseFlowchart(src, ctx.errors);
  return drawFlowchart(fc, ctx);
}

export function drawFlowchart(fc: Flowchart, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const fs = t.fontSize;
  const labels = new Map<string, ReturnType<typeof layoutLabel>>();
  const sizes = new Map<string, [number, number]>();
  for (const nd of fc.nodes.values()) {
    const lab = layoutLabel(nd.label, fs, WRAP);
    labels.set(nd.id, lab);
    sizes.set(nd.id, shapeSize(nd.shape, Math.max(lab.width, 8), Math.max(lab.height, fs), PAD_X, PAD_Y));
  }
  const edgeLabels = new Map<number, ReturnType<typeof layoutLabel>>();
  for (const e of fc.edges) if (e.label?.trim()) edgeLabels.set(e.index, layoutLabel(e.label, fs - 1.5, 200));

  // Links to a subgraph attach to one of its nodes for layout and stop at its box when drawn.
  const members = (c: string): string[] => {
    const out: string[] = [];
    for (const nd of fc.nodes.values()) {
      for (let k = nd.cluster; k; k = fc.clusters.get(k)?.parent) {
        if (k === c) {
          out.push(nd.id);
          break;
        }
      }
    }
    return out;
  };
  const anchor = (id: string, last: boolean): string | undefined => {
    if (fc.nodes.has(id)) return id;
    if (!fc.clusters.has(id)) return undefined;
    const m = members(id);
    return last ? m[m.length - 1] : m[0];
  };

  const titles = new Map<string, ReturnType<typeof layoutLabel>>();
  for (const c of fc.clusters.values()) titles.set(c.id, layoutLabel(c.title, fs - 1, 320));
  const layout: LayoutResult = layoutGraph(
    [...fc.nodes.values()].map((nd) => ({ id: nd.id, width: sizes.get(nd.id)![0], height: sizes.get(nd.id)![1], cluster: nd.cluster })),
    fc.edges
      .map((e) => {
        const from = anchor(e.from, true);
        const to = anchor(e.to, false);
        const lab = edgeLabels.get(e.index);
        return from && to ? { id: e.index, from, to, minlen: e.minlen, weight: e.line === "invisible" ? 0.5 : 1, label: lab ? { width: lab.width + 10, height: lab.height + 4 } : undefined } : undefined;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    [...fc.clusters.values()].filter((c) => members(c.id).length).map((c) => {
      const tl = titles.get(c.id)!;
      return { id: c.id, parent: c.parent, padding: 14, titleWidth: tl.width, titleHeight: tl.lines.length ? tl.height + 6 : 0 };
    }),
    { rankdir: fc.direction, nodesep: 34, ranksep: 46, edgesep: 14 },
  );

  const M = 8;
  const out: string[] = [];
  const shift = (x: number) => x + M;

  // Subgraphs, outermost first.
  const depth = (c: string) => {
    let d = 0;
    for (let k = fc.clusters.get(c)?.parent; k; k = fc.clusters.get(k)?.parent) d++;
    return d;
  };
  const boxes = [...layout.clusters.entries()].sort((a, b) => depth(a[0]) - depth(b[0]));
  for (const [id, b] of boxes) {
    const tl = titles.get(id)!;
    const d = depth(id);
    // Nested subgraphs alternate tinted and plain, so the nesting reads at a glance.
    const plain = t.background === "transparent" ? "#ffffff" : t.background;
    const fill = d % 2 ? plain : t.clusterFill;
    out.push(`<rect x="${n(shift(b.x))}" y="${n(shift(b.y))}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(t.radius + 2)}" fill="${fill}" stroke="${t.clusterStroke}" stroke-width="1"/>`);
    if (tl.lines.length) out.push(labelSvg(tl, shift(b.x) + 10, shift(b.y) + 5 + tl.height / 2, t.clusterText, { align: "start", weight: "bold" }));
  }

  // Links.
  const nodeStyle = (nd: FNode) => {
    const st: Record<string, string> = { ...(fc.classDefs.get("default") ?? {}) };
    for (const c of nd.classes) Object.assign(st, fc.classDefs.get(c) ?? {});
    Object.assign(st, nd.style);
    return st;
  };
  const inside = (id: string): ((p: Pt) => boolean) | undefined => {
    const nd = fc.nodes.get(id);
    if (nd) {
      const pl = layout.nodes.get(id)!;
      return (p) => insideShape(nd.shape, shift(pl.x), shift(pl.y), pl.width, pl.height, p[0], p[1]);
    }
    const b = layout.clusters.get(id);
    if (b) return (p) => p[0] >= shift(b.x) && p[0] <= shift(b.x) + b.width && p[1] >= shift(b.y) && p[1] <= shift(b.y) + b.height;
    return undefined;
  };
  const edgeOut: string[] = [];
  const labelOut: string[] = [];
  for (const e of fc.edges) {
    const pe = layout.edges.get(e.index);
    if (!pe || e.line === "invisible") continue;
    const st = { ...(fc.linkStyles.get("default") ?? {}), ...(fc.linkStyles.get(e.index) ?? {}), ...e.style };
    const color = safeColor(st.stroke) ?? t.line;
    const lw = (parseFloat(st["stroke-width"] ?? "") || (e.line === "thick" ? t.lineWidth * 2 : t.lineWidth)) as number;
    const pts = pe.points.map((p): Pt => [shift(p[0]), shift(p[1])]);
    const cs: Cubic[] = smoothPath(pts, layout.vertical);
    // Cut at the outlines (or at a subgraph's box for links to subgraphs).
    const inFrom = inside(fc.nodes.has(e.from) ? e.from : e.from);
    const inTo = inside(e.to);
    if (inFrom) {
      while (cs.length > 1 && inFrom(cs[0][3])) cs.shift();
      const tt = exitT(cs[0], inFrom);
      cs[0] = splitCubic(cs[0], tt);
    }
    if (inTo) {
      while (cs.length > 1 && inTo(cs[cs.length - 1][0])) cs.pop();
      const last = reverse(cs[cs.length - 1]);
      const tt = exitT(last, inTo);
      cs[cs.length - 1] = reverse(splitCubic(last, tt));
    }
    // Leave room for the end markers so the line does not show through them.
    const trim = (c: Cubic, inset: number, atEnd: boolean): Cubic => {
      if (inset <= 0) return c;
      const cc = atEnd ? c : reverse(c);
      const tip = cc[3];
      let tt = 1;
      for (let s = 1; s <= 40; s++) {
        const p = bez(cc, 1 - s / 40);
        if (Math.hypot(p[0] - tip[0], p[1] - tip[1]) >= inset) {
          tt = 1 - s / 40;
          break;
        }
      }
      const cut = splitCubic(cc, tt, true);
      return atEnd ? cut : reverse(cut);
    };
    const tipEnd = cs[cs.length - 1][3];
    const tipStart = cs[0][0];
    const dirEnd = bez(cs[cs.length - 1], 0.9);
    const dirStart = bez(cs[0], 0.1);
    cs[cs.length - 1] = trim(cs[cs.length - 1], endInset(e.end, lw) - lw * 0.5, true);
    cs[0] = trim(cs[0], endInset(e.start, lw) - lw * 0.5, false);
    const dash = st["stroke-dasharray"] ? esc(st["stroke-dasharray"]) : e.line === "dotted" ? `${n(lw * 2.2)} ${n(lw * 2.2)}` : "";
    edgeOut.push(`<path d="${pathData(cs)}" fill="none" stroke="${color}" stroke-width="${n(lw)}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linecap="round"/>`);
    const bg = t.background === "transparent" ? "#ffffff" : t.background;
    if (e.end !== "none") edgeOut.push(endSvg(e.end, tipEnd, dirEnd, color, Math.max(1, lw * 0.9), bg));
    if (e.start !== "none") edgeOut.push(endSvg(e.start, tipStart, dirStart, color, Math.max(1, lw * 0.9), bg));
    const lab = edgeLabels.get(e.index);
    if (lab && pe.label) {
      const [lx, ly] = [shift(pe.label[0]), shift(pe.label[1])];
      const w = lab.width + 10;
      const h = lab.height + 4;
      labelOut.push(`<rect x="${n(lx - w / 2)}" y="${n(ly - h / 2)}" width="${n(w)}" height="${n(h)}" rx="3" fill="${t.edgeLabelBg}" fill-opacity="0.92"/>`);
      labelOut.push(labelSvg(lab, lx, ly, safeColor(st.color) ?? t.mutedText));
    }
  }
  // Self loops, on the right of their node.
  for (const s of layout.selfLoops) {
    const e = fc.edges[s.id];
    const pl = layout.nodes.get(e.from)!;
    const x = shift(pl.x) + pl.width / 2;
    const y = shift(pl.y);
    const r = Math.min(18, pl.height / 2);
    const c: Cubic = [[x - 2, y - r * 0.6], [x + 34, y - r * 1.6], [x + 34, y + r * 1.6], [x - 2, y + r * 0.6]];
    edgeOut.push(`<path d="${pathData([c])}" fill="none" stroke="${t.line}" stroke-width="${n(t.lineWidth)}"/>`);
    if (e.end !== "none") edgeOut.push(endSvg(e.end, c[3], bez(c, 0.85), t.line, t.lineWidth, "#ffffff"));
    const lab = edgeLabels.get(e.index);
    if (lab) labelOut.push(labelSvg(lab, x + 38, y, t.mutedText, { align: "start" }));
  }
  out.push(...edgeOut);

  // Nodes.
  for (const nd of fc.nodes.values()) {
    const pl = layout.nodes.get(nd.id);
    if (!pl) continue;
    const st = nodeStyle(nd);
    const accent = nd.shape === "diamond";
    const fill = safeColor(st.fill) ?? (accent ? t.accentFill : t.nodeFill);
    const stroke = safeColor(st.stroke) ?? (accent ? t.accentStroke : t.nodeStroke);
    const sw = parseFloat(st["stroke-width"] ?? "") || 1.3;
    out.push(shapeSvg(nd.shape, shift(pl.x), shift(pl.y), pl.width, pl.height, { fill, stroke, strokeWidth: sw, radius: t.radius, dash: st["stroke-dasharray"] ? esc(st["stroke-dasharray"]) : undefined, shadow: t.shadow }));
    const lab = labels.get(nd.id)!;
    const bold = /^(bold|[6-9]00)$/.test(st["font-weight"] ?? "") ? ({ weight: "bold" } as const) : {};
    out.push(labelSvg(lab, shift(pl.x), shift(pl.y) + (nd.shape === "cylinder" ? 4 : 0), safeColor(st.color) ?? t.text, bold));
  }
  out.push(...labelOut);

  const width = layout.width + 2 * M + (layout.selfLoops.length ? 40 : 0);
  const height = layout.height + 2 * M;
  return { svg: svgDocument(width, height, out.join(""), t, ctx.title), width, height };
}
