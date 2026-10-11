/**
 * Mermaid state diagrams (`stateDiagram` and `stateDiagram-v2`): parsed
 * here, laid out by layered.ts, drawn as rounded states with transitions.
 *
 * Covered: states with display names (`state "Long name" as S`) and
 * descriptions (`S : text`, several lines allowed), transitions with labels,
 * start and end ([*], one start and one end node per scope, as Mermaid
 * does), composite states (nested, each with its own [*]), concurrent
 * regions separated by `--` (drawn side by side with a dashed divider),
 * choice, fork and join pseudo-states, notes (`note right of S : text`, the
 * multi-line `note left of S ... end note`, and free notes), `direction`,
 * and classDef, class, ::: and style for colours.
 *
 * Transitions to or from a composite state attach to its border. A note sits
 * beside its state: the layout reserves the room, so nothing lands on it.
 */

import { layoutGraph, type RankDir } from "./layered.js";
import { Bounds, clusterSvg, commonCluster, drawEdge, edgeLabelSvg, frame, type Inside, inBox, loopRoom, paper, parseStyle, type Rect, selfLoopSvg, tightClusters } from "./graphdraw.js";
import { insideShape, labelSvg, n, type Pt, shadowSvg, shapeSvg, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import { safeColor } from "./theme.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment } from "./types.js";

type SKind = "state" | "start" | "end" | "choice" | "fork" | "join" | "note";

interface SNote {
  side: "left" | "right";
  text: string;
}

interface SNode {
  id: string;
  label: string;
  descs: string[];
  kind: SKind;
  cluster?: string;
  classes: string[];
  style: Record<string, string>;
  notes: SNote[];
}

interface SCluster {
  id: string;
  parent?: string;
  /** A composite state, or one concurrent region of one. */
  kind: "composite" | "region";
  title: string;
  /** Regions of a composite, in order (empty when it has none). */
  regions: string[];
  classes: string[];
  style: Record<string, string>;
}

interface STrans {
  index: number;
  from: string;
  to: string;
  label?: string;
}

export interface StateDiagram {
  direction: RankDir;
  nodes: Map<string, SNode>;
  clusters: Map<string, SCluster>;
  transitions: STrans[];
  classDefs: Map<string, Record<string, string>>;
}

const ID = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?=[\p{L}\p{N}_]))*`;
const END = String.raw`(\[\*\]|${ID})(?::::([\w-]+))?`;
const TRANS_RE = new RegExp(String.raw`^${END}\s*-->\s*${END}\s*(?::\s*(.*))?$`, "u");
const DESC_RE = new RegExp(String.raw`^(${ID})\s*:\s*(.*)$`, "u");
const BARE_RE = new RegExp(String.raw`^(${ID})(?::::([\w-]+))?$`, "u");
const STATE_AS_RE = new RegExp(String.raw`^state\s+"([^"]*)"\s+as\s+(${ID})\s*(?:<<(\w+)>>)?\s*(\{)?\s*$`, "u");
const STATE_AS2_RE = new RegExp(String.raw`^state\s+(${ID})\s+as\s+"([^"]*)"\s*(\{)?\s*$`, "u");
const STATE_RE = new RegExp(String.raw`^state\s+(${ID})\s*(?:<<(\w+)>>|\[\[(\w+)\]\])?\s*(?::\s*(.*?))?\s*(\{)?\s*$`, "u");
const NOTE_RE = new RegExp(String.raw`^note\s+(left|right)\s+of\s+(${ID})\s*(?::\s*(.*))?$`, "iu");

export function parseStateDiagram(src: string, errors: DiagramError[]): StateDiagram {
  const sd: StateDiagram = { direction: "TB", nodes: new Map(), clusters: new Map(), transitions: [], classDefs: new Map() };
  /** Open composites, each with the cluster new states go into (the composite, or its current region). */
  const stack: { composite: string; scope: string; line: number }[] = [];
  let headerSeen = false;
  let freeNotes = 0;
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) });
  const scope = () => stack[stack.length - 1]?.scope;

  const touch = (id: string): SNode | undefined => {
    if (sd.clusters.has(id)) return undefined;
    let nd = sd.nodes.get(id);
    if (!nd) {
      nd = { id, label: id, descs: [], kind: "state", cluster: scope(), classes: [], style: {}, notes: [] };
      sd.nodes.set(id, nd);
    }
    return nd;
  };
  /** [*] as a source is the scope's start; as a target, its end. */
  const pseudo = (which: "start" | "end"): string => {
    const sc = scope() ?? "";
    const id = `\u0000${which}:${sc}`;
    if (!sd.nodes.has(id)) sd.nodes.set(id, { id, label: "", descs: [], kind: which, cluster: scope(), classes: [], style: {}, notes: [] });
    return id;
  };
  const openComposite = (id: string, title: string | undefined, line: number) => {
    let cl = sd.clusters.get(id);
    const old = sd.nodes.get(id);
    if (!cl) {
      cl = { id, kind: "composite", title: title ?? old?.label ?? id, parent: old?.cluster ?? scope(), regions: [], classes: old?.classes ?? [], style: old?.style ?? {} };
      sd.clusters.set(id, cl);
    } else if (title) cl.title = title;
    if (old) {
      // The state becomes the composite; its description lines, if any, are dropped from the drawing.
      sd.nodes.delete(id);
    }
    stack.push({ composite: id, scope: cl.regions.length ? cl.regions[cl.regions.length - 1] : id, line });
  };

  const lines = src.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = stripComment(lines[ln]);
    const text = raw.trim();
    if (!text) continue;
    const col = raw.length - raw.trimStart().length;
    if (!headerSeen) {
      headerSeen = true;
      if (/^stateDiagram(-v2)?\b/.test(text)) continue;
    }
    let m: RegExpExecArray | null;
    if (text === "}") {
      if (!stack.pop()) err(ln, col, '"}" without a composite state to close', "Remove it, or open the state it closes: state Name {");
      continue;
    }
    if (text === "--") {
      const top = stack[stack.length - 1];
      if (!top) {
        err(ln, col, '"--" separates concurrent regions and only works inside a composite state', "Put it inside state Name { ... }");
        continue;
      }
      const cl = sd.clusters.get(top.composite)!;
      if (!cl.regions.length) {
        // Everything so far becomes the first region.
        const first = `${cl.id}\u0000r0`;
        sd.clusters.set(first, { id: first, kind: "region", title: "", parent: cl.id, regions: [], classes: [], style: {} });
        cl.regions.push(first);
        for (const nd of sd.nodes.values()) if (nd.cluster === cl.id) nd.cluster = first;
        for (const c of sd.clusters.values()) if (c.parent === cl.id && c.id !== first) c.parent = first;
      }
      const next = `${cl.id}\u0000r${cl.regions.length}`;
      sd.clusters.set(next, { id: next, kind: "region", title: "", parent: cl.id, regions: [], classes: [], style: {} });
      cl.regions.push(next);
      top.scope = next;
      continue;
    }
    if ((m = /^direction\s+(\w+)\s*$/.exec(text))) {
      const d = m[1].toUpperCase();
      if (!["TB", "TD", "BT", "LR", "RL"].includes(d)) err(ln, col + text.indexOf(m[1]), `Unknown direction "${m[1]}"`, "Use TB, BT, LR or RL");
      // Composite states follow the diagram's direction; a direction inside one is accepted and not used.
      else if (!stack.length) sd.direction = d === "TD" ? "TB" : (d as RankDir);
      continue;
    }
    if (/^(hide\s+empty\s+description|scale\b|accTitle\b|accDescr\b|title\b|click\b)/.test(text)) continue;
    if ((m = /^classDef\s+([\w,\- ]+?)\s+(.+)$/.exec(text))) {
      for (const name of m[1].split(",")) sd.classDefs.set(name.trim(), { ...(sd.classDefs.get(name.trim()) ?? {}), ...parseStyle(m[2]) });
      continue;
    }
    if ((m = /^class\s+([^\s]+)\s+([\w-]+)\s*$/.exec(text))) {
      for (const id of m[1].split(",")) {
        const k = id.trim();
        if (!k) continue;
        const cl = sd.clusters.get(k);
        if (cl) cl.classes.push(m[2]);
        else touch(k)?.classes.push(m[2]);
      }
      continue;
    }
    if ((m = /^style\s+(\S+)\s+(.+)$/.exec(text))) {
      const cl = sd.clusters.get(m[1]);
      Object.assign(cl ? cl.style : (touch(m[1])?.style ?? {}), parseStyle(m[2]));
      continue;
    }
    if ((m = NOTE_RE.exec(text))) {
      const side = m[1].toLowerCase() as "left" | "right";
      let body = m[3];
      if (body === undefined) {
        const parts: string[] = [];
        let closed = false;
        for (ln++; ln < lines.length; ln++) {
          const l = stripComment(lines[ln]).trim();
          if (/^end\s*note$/i.test(l)) {
            closed = true;
            break;
          }
          parts.push(l);
        }
        if (!closed) err(ln - 1, 0, "The note is never closed", 'Add "end note" after its last line');
        body = parts.join("\n");
      }
      const target = touch(m[2]) ?? undefined;
      if (target) target.notes.push({ side, text: body.trim() });
      else {
        // A note on a composite state becomes a free note inside its parent.
        const id = `\u0000note${freeNotes++}`;
        sd.nodes.set(id, { id, label: body.trim(), descs: [], kind: "note", cluster: sd.clusters.get(m[2])?.parent, classes: [], style: {}, notes: [] });
      }
      continue;
    }
    if ((m = /^note\s+"([^"]*)"\s+as\s+(\S+)\s*$/.exec(text))) {
      sd.nodes.set(m[2], { id: m[2], label: m[1], descs: [], kind: "note", cluster: scope(), classes: [], style: {}, notes: [] });
      continue;
    }
    if (/^note\b/.test(text)) {
      err(ln, col, "Could not read the note", "Write: note right of State : text, or note left of State, its lines, then end note");
      continue;
    }
    if (/^state\b/.test(text)) {
      if ((m = STATE_AS_RE.exec(text))) {
        if (m[4]) openComposite(m[2], m[1], ln);
        else {
          const nd = touch(m[2]);
          if (nd) {
            nd.label = m[1];
            if (m[3]) setKind(nd, m[3], ln, col + text.indexOf("<<"));
          } else sd.clusters.get(m[2])!.title = m[1];
        }
        continue;
      }
      if ((m = STATE_AS2_RE.exec(text))) {
        if (m[3]) openComposite(m[1], m[2], ln);
        else {
          const nd = touch(m[1]);
          if (nd) nd.label = m[2];
        }
        continue;
      }
      if ((m = STATE_RE.exec(text))) {
        if (m[5]) {
          openComposite(m[1], undefined, ln);
          continue;
        }
        const nd = touch(m[1]);
        if (!nd) continue;
        // An explicit declaration inside a composite claims a state first seen outside.
        if (stack.length && nd.cluster === undefined) nd.cluster = scope();
        const kind = m[2] ?? m[3];
        if (kind) setKind(nd, kind, ln, col + text.indexOf(kind) - 2);
        if (m[4]) nd.descs.push(m[4]);
        continue;
      }
      err(ln, col, `Could not read the state declaration "${text.slice(0, 40)}"`, 'Write: state Name, state "Long name" as Name, state Name <<choice>> or state Name {');
      continue;
    }
    if ((m = TRANS_RE.exec(text))) {
      const end = (id: string, cls: string | undefined, which: "start" | "end"): string => {
        if (id === "[*]") return pseudo(which);
        const nd = touch(id);
        if (nd && cls) nd.classes.push(cls);
        return id;
      };
      const from = end(m[1], m[2], "start");
      const to = end(m[3], m[4], "end");
      const label = m[5]?.trim();
      sd.transitions.push({ index: sd.transitions.length, from, to, ...(label ? { label } : {}) });
      continue;
    }
    if ((m = DESC_RE.exec(text))) {
      const nd = touch(m[1]);
      if (nd) nd.descs.push(m[2].trim());
      else sd.clusters.get(m[1])!.title = m[2].trim() || m[1];
      continue;
    }
    if ((m = BARE_RE.exec(text))) {
      const nd = touch(m[1]);
      if (nd && m[2]) nd.classes.push(m[2]);
      continue;
    }
    const arrow = /^(\S+)\s*(-+>|=+>|->>|-\.+->|<-+)\s*(\S+)/.exec(text);
    if (arrow) {
      err(ln, col + text.indexOf(arrow[2], arrow[1].length), `"${arrow[2]}" is not a transition`, "Transitions are written A --> B, with [*] for start and end", { old: arrow[2], new: "-->" });
      continue;
    }
    err(ln, col, `Could not read "${text.slice(0, 40)}"`, "Expected a state, a transition (A --> B : label), a description (A : text), a composite (state A { ... }) or a note");
  }
  for (const top of stack.reverse()) err(top.line, 0, `The composite state ${top.composite} is never closed`, 'Add "}" after its last line');

  // A composite with nothing inside is drawn as a plain state.
  for (const cl of [...sd.clusters.values()]) {
    if (cl.kind !== "composite") continue;
    const holds = (c: string): boolean => [...sd.nodes.values()].some((nd) => nd.cluster === c) || [...sd.clusters.values()].some((k) => k.parent === c && holds(k.id));
    if (!holds(cl.id)) {
      sd.clusters.delete(cl.id);
      for (const r of cl.regions) sd.clusters.delete(r);
      sd.nodes.set(cl.id, { id: cl.id, label: cl.title, descs: [], kind: "state", cluster: cl.parent, classes: cl.classes, style: cl.style, notes: [] });
    }
  }
  return sd;

  function setKind(nd: SNode, kind: string, line: number, col: number): void {
    const k = kind.toLowerCase();
    if (k === "choice" || k === "fork" || k === "join") nd.kind = k;
    else err(line, col, `Unknown state type <<${kind}>>`, "Use <<choice>>, <<fork>> or <<join>>");
  }
}

// ---------------------------------------------------------------- drawing

const PAD_X = 14;
const PAD_Y = 9;
const WRAP = 200;
const NOTE_GAP = 12;

interface Measured {
  /** Size of the state itself. */
  w: number;
  h: number;
  name?: Label;
  descs?: Label;
  nameH: number;
  notes: { side: "left" | "right"; label: Label; w: number; h: number }[];
}

export function renderState(src: string, ctx: DiagramContext): Rendered {
  return drawStateDiagram(parseStateDiagram(src, ctx.errors), ctx);
}

export function drawStateDiagram(sd: StateDiagram, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const fs = t.fontSize;
  const bg = paper(t);
  const horizontal = sd.direction === "LR" || sd.direction === "RL";
  const R = t.radius + 3;

  const meas = new Map<string, Measured>();
  for (const nd of sd.nodes.values()) {
    const notes = nd.notes.map((x) => {
      const label = layoutLabel(x.text, fs - 1.5, 220);
      return { side: x.side, label, w: Math.max(label.width, 16) + 24, h: Math.max(label.height, fs) + 16 };
    });
    let m: Measured;
    switch (nd.kind) {
      case "start":
        m = { w: 15, h: 15, nameH: 0, notes };
        break;
      case "end":
        m = { w: 19, h: 19, nameH: 0, notes };
        break;
      case "choice":
        m = { w: 26, h: 26, nameH: 0, notes };
        break;
      case "fork":
      case "join":
        m = horizontal ? { w: 7, h: 72, nameH: 0, notes } : { w: 72, h: 7, nameH: 0, notes };
        break;
      case "note": {
        const name = layoutLabel(nd.label, fs - 1.5, 220);
        m = { w: Math.max(name.width, 16) + 24, h: Math.max(name.height, fs) + 16, name, nameH: 0, notes };
        break;
      }
      default: {
        if (nd.descs.length) {
          const name = layoutLabel(nd.label, fs, WRAP);
          const descs = layoutLabel(nd.descs.join("<br>"), fs - 1.5, WRAP);
          const nameH = name.height + 2 * 7;
          m = { w: Math.max(name.width, descs.width, 30) + 2 * PAD_X, h: nameH + descs.height + 2 * 7, name: { ...name, lines: name.lines.map((l) => l.map((p) => ({ ...p, bold: true }))) }, descs, nameH, notes };
        } else {
          const name = layoutLabel(nd.label, fs, WRAP);
          m = { w: Math.max(name.width, 30) + 2 * PAD_X, h: Math.max(name.height, fs) + 2 * PAD_Y, name, nameH: 0, notes };
        }
      }
    }
    meas.set(nd.id, m);
  }
  const edgeLabels = new Map<number, Label>();
  for (const tr of sd.transitions) if (tr.label) edgeLabels.set(tr.index, layoutLabel(tr.label, fs - 1.5, 200));

  // Room beside each state for its self loops and notes. Across the layout (TB) notes go left and right
  // and loops right; in sideways layouts "left" means above and "right" below, as edges use the sides.
  const loopCount = new Map<string, number>();
  const loopAlong = new Map<string, number>();
  for (const tr of sd.transitions) {
    if (tr.from !== tr.to || !sd.nodes.has(tr.from)) continue;
    loopCount.set(tr.from, (loopCount.get(tr.from) ?? 0) + 1);
    const lab = edgeLabels.get(tr.index);
    if (lab) loopAlong.set(tr.from, Math.max(loopAlong.get(tr.from) ?? 0, horizontal ? lab.height + 4 : lab.width + 10));
  }
  interface Slot {
    before: number;
    loop: number;
    after: number;
    across: number;
  }
  const slots = new Map<string, Slot>();
  for (const nd of sd.nodes.values()) {
    const m = meas.get(nd.id)!;
    const loop = loopRoom(loopCount.get(nd.id) ?? 0, loopAlong.get(nd.id) ?? 0);
    const side = (s: "left" | "right") => m.notes.filter((x) => x.side === s);
    const along = (xs: Measured["notes"]) => (xs.length ? NOTE_GAP + Math.max(...xs.map((x) => (horizontal ? x.h : x.w))) : 0);
    const stack = (xs: Measured["notes"]) => xs.reduce((s, x) => s + (horizontal ? x.w : x.h), 0) + Math.max(0, xs.length - 1) * 8;
    slots.set(nd.id, { before: along(side("left")), loop, after: along(side("right")), across: Math.max(stack(side("left")), stack(side("right"))) });
  }

  // Clusters: composites with titles, and their regions.
  const titles = new Map<string, Label>();
  for (const cl of sd.clusters.values()) if (cl.kind === "composite") titles.set(cl.id, layoutLabel(cl.title, fs - 0.5, 320));
  const lclusters = [...sd.clusters.values()].map((cl) => {
    const tl = titles.get(cl.id);
    return cl.kind === "composite"
      ? { id: cl.id, parent: cl.parent, padding: 14, titleWidth: tl!.width, titleHeight: tl!.lines.length ? tl!.height + 8 : 0 }
      : { id: cl.id, parent: cl.parent, padding: 8, titleWidth: 0, titleHeight: 0 };
  });

  // Transitions to a composite attach to its start (or first state), from it to its end (or last state).
  const membersOf = (c: string): string[] => {
    const out: string[] = [];
    for (const nd of sd.nodes.values()) {
      for (let k = nd.cluster; k; k = sd.clusters.get(k)?.parent) {
        if (k === c) {
          out.push(nd.id);
          break;
        }
      }
    }
    return out;
  };
  const anchor = (id: string, outgoing: boolean): string | undefined => {
    if (sd.nodes.has(id)) return id;
    const cl = sd.clusters.get(id);
    if (!cl) return undefined;
    const scopes = [id, ...cl.regions];
    for (const s of scopes) {
      const p = `\u0000${outgoing ? "end" : "start"}:${s}`;
      if (sd.nodes.has(p)) return p;
    }
    const ms = membersOf(id);
    return outgoing ? ms[ms.length - 1] : ms[0];
  };

  const lnodes = [...sd.nodes.values()].map((nd) => {
    const m = meas.get(nd.id)!;
    const s = slots.get(nd.id)!;
    const along = s.before + s.loop + s.after;
    return horizontal
      ? { id: nd.id, width: Math.max(m.w, s.across), height: m.h + along, cluster: nd.cluster }
      : { id: nd.id, width: m.w + along, height: Math.max(m.h, s.across), cluster: nd.cluster };
  });
  const ledges: { id: number; from: string; to: string; label?: { width: number; height: number } }[] = sd.transitions
    .map((tr) => {
      const from = anchor(tr.from, true);
      const to = anchor(tr.to, false);
      const lab = edgeLabels.get(tr.index);
      return from && to ? { id: tr.index, from, to, label: lab ? { width: lab.width + 10, height: lab.height + 4 } : undefined } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  // Concurrent regions start together: a transition into a composite with regions also pulls, unseen,
  // on every region's start, and one out of it on every region's end.
  {
    let hidden = 1_000_000;
    const regionEnds = (cl: SCluster, outgoing: boolean): string[] =>
      cl.regions
        .map((r) => {
          const p = ` ${outgoing ? "end" : "start"}:${r}`;
          if (sd.nodes.has(p)) return p;
          const ms = membersOf(r);
          return outgoing ? ms[ms.length - 1] : ms[0];
        })
        .filter((x): x is string => !!x);
    for (const tr of sd.transitions) {
      const from = anchor(tr.from, true);
      const to = anchor(tr.to, false);
      if (!from || !to) continue;
      const into = sd.clusters.get(tr.to);
      if (into && into.regions.length > 1) for (const r of regionEnds(into, false)) if (r !== to) ledges.push({ id: hidden++, from, to: r, label: undefined });
      const outOf = sd.clusters.get(tr.from);
      if (outOf && outOf.regions.length > 1) for (const r of regionEnds(outOf, true)) if (r !== from) ledges.push({ id: hidden++, from: r, to, label: undefined });
    }
  }
  const layout = layoutGraph(lnodes, ledges, lclusters, { rankdir: sd.direction, nodesep: 36 + (horizontal && lclusters.length ? 24 : 0), ranksep: 40, edgesep: 14 });

  // Where each state is drawn inside its slot.
  const place = new Map<string, Rect & { dx: number; dy: number }>();
  for (const nd of sd.nodes.values()) {
    const p = layout.nodes.get(nd.id)!;
    const m = meas.get(nd.id)!;
    const s = slots.get(nd.id)!;
    const along = s.before + s.loop + s.after;
    // Offset of the state's centre from the slot's centre, along the axis the room was added on.
    const shift = s.before + (horizontal ? m.h : m.w) / 2 - (along + (horizontal ? m.h : m.w)) / 2;
    const dx = horizontal ? 0 : shift;
    const dy = horizontal ? shift : 0;
    place.set(nd.id, { x: p.x + dx, y: p.y + dy, width: m.w, height: m.h, dx, dy });
  }
  // Labels of transitions inside a composite belong to it too, so its box covers them.
  const labelBoxes = sd.transitions.flatMap((tr) => {
    const pe = layout.edges.get(tr.index);
    const lab = edgeLabels.get(tr.index);
    if (!pe?.label || !lab) return [];
    const a = anchor(tr.from, true);
    const z = anchor(tr.to, false);
    const cluster = commonCluster(a ? sd.nodes.get(a)?.cluster : undefined, z ? sd.nodes.get(z)?.cluster : undefined, (c) => sd.clusters.get(c)?.parent);
    return cluster ? [{ x: pe.label[0], y: pe.label[1], width: lab.width + 10, height: lab.height + 4, cluster }] : [];
  });
  const clusterBoxes = tightClusters(lclusters, [...[...sd.nodes.values()].map((nd) => ({ ...layout.nodes.get(nd.id)!, cluster: nd.cluster })), ...labelBoxes]);

  const bounds = new Bounds();
  for (const b of clusterBoxes.values()) bounds.add(b.x, b.y, b.x + b.width, b.y + b.height);
  const out: string[] = [];
  const styleFor = (classes: string[], own: Record<string, string>) => {
    const st: Record<string, string> = { ...(sd.classDefs.get("default") ?? {}) };
    for (const k of classes) Object.assign(st, sd.classDefs.get(k) ?? {});
    return Object.assign(st, own);
  };

  // Composite states, outermost first; regions get a dashed divider between them.
  const depth = (id: string) => {
    let d = 0;
    for (let k = sd.clusters.get(id)?.parent; k; k = sd.clusters.get(k)?.parent) if (sd.clusters.get(k)?.kind === "composite") d++;
    return d;
  };
  const composites = [...sd.clusters.values()].filter((c) => c.kind === "composite" && clusterBoxes.has(c.id)).sort((a, b) => depth(a.id) - depth(b.id));
  for (const cl of composites) {
    const b = clusterBoxes.get(cl.id)!;
    const st = styleFor(cl.classes, cl.style);
    out.push(clusterSvg(b, titles.get(cl.id), depth(cl.id), t, { radius: R, fill: safeColor(st.fill), stroke: safeColor(st.stroke) }));
    const regs = cl.regions.map((r) => clusterBoxes.get(r)).filter((r): r is Rect => !!r);
    if (regs.length < 2) continue;
    const tl = titles.get(cl.id)!;
    const top = b.y + (tl.lines.length ? tl.height + 8 : 0) + 4;
    const sideBySide = (a: Rect, c: Rect) => a.x + a.width <= c.x + 1 || c.x + c.width <= a.x + 1;
    const across = regs.every((a, i) => regs.every((c, j) => i === j || sideBySide(a, c)));
    const sorted = [...regs].sort((a, c) => (across ? a.x - c.x : a.y - c.y));
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const c = sorted[i + 1];
      const d = across
        ? `M${n((a.x + a.width + c.x) / 2)} ${n(top)}V${n(b.y + b.height - 6)}`
        : `M${n(b.x + 6)} ${n((a.y + a.height + c.y) / 2)}H${n(b.x + b.width - 6)}`;
      out.push(`<path d="${d}" stroke="${t.clusterStroke}" stroke-width="1.1" stroke-dasharray="5 4" fill="none"/>`);
    }
  }

  // Transitions.
  const inside = (id: string): Inside | undefined => {
    const nd = sd.nodes.get(id);
    if (nd) {
      const p = place.get(id)!;
      if (nd.kind === "start" || nd.kind === "end") return (q) => insideShape("circle", p.x, p.y, p.width, p.height, q[0], q[1]);
      if (nd.kind === "choice") return (q) => insideShape("diamond", p.x, p.y, p.width, p.height, q[0], q[1]);
      return inBox(p.x, p.y, p.width, p.height);
    }
    const b = clusterBoxes.get(id);
    return b ? inBox(b.x + b.width / 2, b.y + b.height / 2, b.width, b.height) : undefined;
  };
  const edgesOut: string[] = [];
  const labelsOut: string[] = [];
  const loops = new Map<string, number>();
  for (const tr of sd.transitions) {
    const lab = edgeLabels.get(tr.index);
    const spec = { start: "none" as const, end: "arrow" as const, color: t.line, lw: t.lineWidth, bg };
    if (tr.from === tr.to) {
      const p = place.get(tr.from);
      if (!p) continue;
      const k = loops.get(tr.from) ?? 0;
      loops.set(tr.from, k + 1);
      edgesOut.push(selfLoopSvg(p.x, p.y, p.width, p.height, k, spec, lab, t, t.mutedText, bounds, horizontal ? "bottom" : "right"));
      continue;
    }
    const pe = layout.edges.get(tr.index);
    if (!pe) continue;
    const pts: Pt[] = pe.points.map((p) => [p[0], p[1]]);
    const a = place.get(anchor(tr.from, true)!);
    const z = place.get(anchor(tr.to, false)!);
    if (a) pts[0] = [pts[0][0] + a.dx, pts[0][1] + a.dy];
    if (z) pts[pts.length - 1] = [pts[pts.length - 1][0] + z.dx, pts[pts.length - 1][1] + z.dy];
    for (const p of pts) bounds.add(p[0], p[1], p[0], p[1]);
    const d = drawEdge({ ...spec, points: pts, vertical: layout.vertical, from: inside(tr.from), to: inside(tr.to) });
    edgesOut.push(d.svg);
    if (lab && pe.label) labelsOut.push(edgeLabelSvg(lab, pe.label[0], pe.label[1], t, t.mutedText, bounds));
  }
  out.push(...edgesOut);

  // States.
  for (const nd of sd.nodes.values()) {
    const p = place.get(nd.id)!;
    const m = meas.get(nd.id)!;
    bounds.box(p.x, p.y, p.width, p.height);
    const st = styleFor(nd.classes, nd.style);
    const fill = safeColor(st.fill);
    const stroke = safeColor(st.stroke);
    const ink = safeColor(st.color) ?? t.text;
    switch (nd.kind) {
      case "start":
        out.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.width / 2)}" fill="${fill ?? t.line}"/>`);
        break;
      case "end":
        out.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.width / 2 - 0.6)}" fill="${bg}" stroke="${stroke ?? t.line}" stroke-width="1.3"/>`);
        out.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.width / 2 - 4.5)}" fill="${fill ?? t.line}"/>`);
        break;
      case "choice":
        out.push(shapeSvg("diamond", p.x, p.y, p.width, p.height, { fill: fill ?? t.accentFill, stroke: stroke ?? t.accentStroke, strokeWidth: 1.2, radius: 0, shadow: t.shadow }));
        break;
      case "fork":
      case "join":
        out.push(shapeSvg("fork", p.x, p.y, p.width, p.height, { fill: fill ?? t.line, stroke: fill ?? t.line, strokeWidth: 0, radius: 2 }));
        break;
      case "note":
        out.push(shapeSvg("note", p.x, p.y, p.width, p.height, { fill: t.noteFill, stroke: t.noteStroke, strokeWidth: 1, radius: 0, shadow: t.shadow }));
        out.push(labelSvg(m.name!, p.x, p.y, t.text));
        break;
      default: {
        const sw = parseFloat(st["stroke-width"] ?? "") || 1.3;
        out.push(shadowSvg("rect", p.x, p.y, p.width, p.height, R, t.shadow));
        out.push(`<rect x="${n(p.x - p.width / 2)}" y="${n(p.y - p.height / 2)}" width="${n(p.width)}" height="${n(p.height)}" rx="${n(R)}" fill="${fill ?? t.nodeFill}" stroke="${stroke ?? t.nodeStroke}" stroke-width="${n(sw)}"${st["stroke-dasharray"] ? ` stroke-dasharray="${st["stroke-dasharray"].replace(/[^\d.\s,]/g, "")}"` : ""}/>`);
        if (m.descs) {
          const top = p.y - p.height / 2;
          out.push(labelSvg(m.name!, p.x, top + m.nameH / 2, ink));
          out.push(`<path d="M${n(p.x - p.width / 2)} ${n(top + m.nameH)}H${n(p.x + p.width / 2)}" stroke="${stroke ?? t.nodeStroke}" stroke-width="0.8" stroke-opacity="0.6" fill="none"/>`);
          out.push(labelSvg(m.descs, p.x, top + m.nameH + (p.height - m.nameH) / 2, t.mutedText));
        } else out.push(labelSvg(m.name!, p.x, p.y, ink));
      }
    }
    // Notes beside the state.
    for (const side of ["left", "right"] as const) {
      const xs = m.notes.filter((x) => x.side === side);
      if (!xs.length) continue;
      const s = slots.get(nd.id)!;
      const total = xs.reduce((a, x) => a + (horizontal ? x.w : x.h), 0) + (xs.length - 1) * 8;
      let run = -total / 2;
      for (const x of xs) {
        const len = horizontal ? x.w : x.h;
        const mid = run + len / 2;
        run += len + 8;
        let cx: number;
        let cy: number;
        if (horizontal) {
          cx = p.x + mid;
          cy = side === "left" ? p.y - p.height / 2 - NOTE_GAP - x.h / 2 : p.y + p.height / 2 + s.loop + NOTE_GAP + x.h / 2;
        } else {
          cy = p.y + mid;
          cx = side === "left" ? p.x - p.width / 2 - NOTE_GAP - x.w / 2 : p.x + p.width / 2 + s.loop + NOTE_GAP + x.w / 2;
        }
        bounds.box(cx, cy, x.w, x.h);
        out.push(shapeSvg("note", cx, cy, x.w, x.h, { fill: t.noteFill, stroke: t.noteStroke, strokeWidth: 1, radius: 0, shadow: t.shadow }));
        out.push(labelSvg(x.label, cx, cy, t.text));
      }
    }
  }
  out.push(...labelsOut);
  if (!sd.nodes.size) bounds.add(0, 0, 0, 0);

  const f = frame(out.join(""), bounds, 8);
  return { svg: svgDocument(f.width, f.height, f.body, t, ctx.title), width: f.width, height: f.height };
}
