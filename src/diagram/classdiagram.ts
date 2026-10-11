/**
 * Mermaid class diagrams (`classDiagram`): parsed here, laid out by
 * layered.ts, drawn as UML class boxes with three compartments.
 *
 * Covered: `class Name`, member blocks in braces and `Name : member` lines,
 * visibility (+ - # ~), static ($, underlined) and abstract (*, italic)
 * members, methods with return types, generics written with tildes
 * (`Box~T~` is drawn Box<T>), annotations such as <<interface>> inside a
 * block or as a statement, display labels (`class A["Shown"]`), every
 * relation Mermaid has (inheritance, composition, aggregation, association,
 * dependency, realization, plain and dashed links, lollipops, both ends and
 * two-way forms) with cardinalities and labels, namespaces (nested too),
 * `direction`, notes (`note for X "text"` and free notes), and classDef,
 * cssClass, ::: and style for colours.
 *
 * Relations that mark a parent or a whole (the triangle and the diamonds)
 * keep that end on top whichever way round they are written, so a hierarchy
 * always reads downward.
 */

import { layoutGraph, type RankDir } from "./layered.js";
import { Bounds, clusterSvg, commonCluster, drawEdge, edgeLabelSvg, endTextSvg, frame, inBox, rectOf, markerLength, paper, parseStyle, loopRoom, plainLabel, selfLoopSvg, tightClusters } from "./graphdraw.js";
import { type EndKind, labelSvg, type Pt, n, shadowSvg, shapeSize, shapeSvg, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import { safeColor } from "./theme.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment, unquote } from "./types.js";

interface Member {
  text: string;
  isStatic: boolean;
  isAbstract: boolean;
}

interface CClass {
  id: string;
  label: string;
  generic?: string;
  annotations: string[];
  attrs: Member[];
  methods: Member[];
  classes: string[];
  style: Record<string, string>;
  ns?: string;
}

interface CRel {
  index: number;
  a: string;
  b: string;
  /** Marker at a, and at b. */
  atA: EndKind;
  atB: EndKind;
  dashed: boolean;
  cardA?: string;
  cardB?: string;
  label?: string;
}

interface CNote {
  id: string;
  text: string;
  for?: string;
}

interface CNamespace {
  id: string;
  parent?: string;
}

export interface ClassDiagram {
  direction: RankDir;
  classes: Map<string, CClass>;
  relations: CRel[];
  notes: CNote[];
  namespaces: Map<string, CNamespace>;
  classDefs: Map<string, Record<string, string>>;
}

const NAME = "(?:`[^`]+`|" + String.raw`[\p{L}\p{N}_$](?:[\p{L}\p{N}_$]|[.\-](?=[\p{L}\p{N}_$]))*)`;
const GENERIC = String.raw`(?:~[^\s"{\[:]*~)?`;
const LEFT: Record<string, EndKind> = { "<|": "triangle", "*": "diamond-filled", o: "diamond", "<": "open", "()": "circle" };
const RIGHT: Record<string, EndKind> = { "|>": "triangle", "*": "diamond-filled", o: "diamond", ">": "open", "()": "circle" };
const REL_RE = new RegExp(
  String.raw`^(${NAME})(${GENERIC})\s*(?:"([^"]*)"\s*)?(<\||\*|o|<|\(\))?(--|\.\.)(\|>|\*|o|>|\(\))?\s*(?:"([^"]*)"\s*)?(${NAME})(${GENERIC})\s*(?::\s*(.*))?$`,
  "u",
);
const MEMBER_RE = new RegExp(String.raw`^(${NAME})(${GENERIC})\s*:\s*(.*)$`, "u");
const CLASS_RE = new RegExp(String.raw`^class\s+(${NAME})(~[^{\[:]*~)?\s*(?:\[\s*("[^"]*"|[^\]]*)\s*\])?\s*(?::::\s*([\w-]+))?\s*(\{(.*))?$`, "u");
const BARE_RE = new RegExp(String.raw`^(${NAME})(${GENERIC})\s*(?::::\s*([\w-]+))?$`, "u");

/** Common misspellings of relation arrows, and what was meant. */
const ARROW_FIXES: Record<string, string> = {
  "->": "-->",
  "<-": "<--",
  "-|>": "--|>",
  "<|-": "<|--",
  ".>": "..>",
  "<.": "<..",
  ".|>": "..|>",
  "<|.": "<|..",
  "=>": "-->",
  "<=": "<--",
  "--*>": "--*",
  "-*": "--*",
  "*-": "*--",
  "-o": "--o",
  "o-": "o--",
  "...>": "..>",
  "--->": "-->",
};

/** Mermaid's tilde generics as angle brackets: List~List~int~~ -> List<List<int>>. */
export function generics(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "~") {
      out += c;
      continue;
    }
    const prev = s[i - 1] ?? "";
    const next = s[i + 1] ?? "";
    if (/[\p{L}\p{N}_>\]]/u.test(prev) && /[\p{L}\p{N}_(\[]/u.test(next)) {
      out += "<";
      depth++;
    } else if (depth > 0) {
      out += ">";
      depth--;
    } else out += c;
  }
  return out;
}

const clean = (id: string): string => (id.startsWith("`") && id.endsWith("`") ? id.slice(1, -1) : id);

function parseMember(raw: string): Member {
  let s = raw.trim();
  let isStatic = false;
  let isAbstract = false;
  if (s.endsWith("$")) {
    isStatic = true;
    s = s.slice(0, -1).trimEnd();
  } else if (s.endsWith("*")) {
    isAbstract = true;
    s = s.slice(0, -1).trimEnd();
  }
  const close = s.lastIndexOf(")");
  if (s.includes("(") && close > 0) {
    let head = s.slice(0, close + 1);
    let ret = s.slice(close + 1).trim();
    // A classifier may come right after the parenthesis, before the return type.
    const cls = /^([$*])\s*/.exec(ret);
    if (cls) {
      if (cls[1] === "$") isStatic = true;
      else isAbstract = true;
      ret = ret.slice(cls[0].length);
    }
    ret = ret.replace(/^:\s*/, "");
    head = head.replace(/\s+\(/, "(");
    s = ret ? `${head}: ${ret}` : head;
  }
  return { text: generics(s), isStatic, isAbstract };
}

export function parseClassDiagram(src: string, errors: DiagramError[]): ClassDiagram {
  const cd: ClassDiagram = { direction: "TB", classes: new Map(), relations: [], notes: [], namespaces: new Map(), classDefs: new Map() };
  const nsStack: string[] = [];
  let open: CClass | undefined;
  let openLine = 0;
  let headerSeen = false;
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) });

  const touch = (rawId: string, generic?: string): CClass => {
    const id = clean(rawId);
    let c = cd.classes.get(id);
    if (!c) {
      c = { id, label: id, annotations: [], attrs: [], methods: [], classes: [], style: {}, ns: nsStack[nsStack.length - 1] };
      cd.classes.set(id, c);
    }
    const g = generic?.replace(/^~|~$/g, "");
    if (g && !c.generic) c.generic = generics(g);
    return c;
  };
  const addMember = (c: CClass, raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const ann = /^<<\s*(.+?)\s*>>$/.exec(t);
    if (ann) {
      c.annotations.push(ann[1]);
      return;
    }
    const m = parseMember(t);
    (t.includes("(") ? c.methods : c.attrs).push(m);
  };

  const lines = src.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = stripComment(lines[ln]);
    const text = raw.trim();
    if (!text) continue;
    const col = raw.length - raw.trimStart().length;

    if (open) {
      if (text === "}") {
        open = undefined;
        continue;
      }
      if (text.endsWith("}")) {
        addMember(open, text.slice(0, -1));
        open = undefined;
        continue;
      }
      addMember(open, text);
      continue;
    }
    if (!headerSeen) {
      headerSeen = true;
      if (/^classDiagram(-v2)?\b/.test(text)) continue;
    }
    if (text === "}") {
      if (!nsStack.pop()) err(ln, col, '"}" without a class or namespace to close', "Remove it, or open the block it closes");
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^namespace\s+([\w.\-$]+|"[^"]*")\s*(\{)?\s*$/.exec(text))) {
      const id = unquote(m[1]);
      if (!m[2]) {
        // The brace may stand on the next line.
        const next = lines[ln + 1] !== undefined ? stripComment(lines[ln + 1]).trim() : "";
        if (next === "{") ln++;
        else {
          err(ln, col + text.length, `namespace ${id} needs "{" to open its block`, `Write: namespace ${id} {`, { old: "", new: " {" });
          continue;
        }
      }
      cd.namespaces.set(id, { id, parent: nsStack[nsStack.length - 1] });
      nsStack.push(id);
      continue;
    }
    if ((m = /^direction\s+(\w+)\s*$/.exec(text))) {
      const d = m[1].toUpperCase();
      if (d === "TB" || d === "TD" || d === "BT" || d === "LR" || d === "RL") cd.direction = d === "TD" ? "TB" : d;
      else err(ln, col + text.indexOf(m[1]), `Unknown direction "${m[1]}"`, "Use TB, BT, LR or RL");
      continue;
    }
    if (/^(click|link|callback|accTitle|accDescr|title)\b/.test(text)) continue;
    if ((m = /^classDef\s+([\w,\- ]+?)\s+(.+)$/.exec(text))) {
      for (const name of m[1].split(",")) cd.classDefs.set(name.trim(), { ...(cd.classDefs.get(name.trim()) ?? {}), ...parseStyle(m[2]) });
      continue;
    }
    if ((m = /^cssClass\s+"([^"]+)"\s+([\w-]+)\s*$/.exec(text))) {
      for (const id of m[1].split(",")) if (id.trim()) touch(id.trim()).classes.push(m[2]);
      continue;
    }
    if ((m = /^style\s+(\S+)\s+(.+)$/.exec(text))) {
      Object.assign(touch(m[1]).style, parseStyle(m[2]));
      continue;
    }
    if ((m = /^note\s+for\s+(\S+)\s+("(?:[^"\\]|\\.)*")\s*$/.exec(text))) {
      touch(m[1]);
      cd.notes.push({ id: `\u0000note${cd.notes.length}`, text: unquote(m[2]), for: clean(m[1]) });
      continue;
    }
    if ((m = /^note\s+("(?:[^"\\]|\\.)*")\s*$/.exec(text))) {
      cd.notes.push({ id: `\u0000note${cd.notes.length}`, text: unquote(m[1]) });
      continue;
    }
    if (/^note\b/.test(text)) {
      err(ln, col, "A note needs its text in quotes", 'Write: note for ClassName "text", or note "text"');
      continue;
    }
    if (/^class\b/.test(text) && !/^class\s*:/.test(text)) {
      m = CLASS_RE.exec(text);
      if (!m) {
        err(ln, col, `Could not read the class declaration "${text.slice(0, 40)}"`, 'Write: class Name, class Name~T~, class Name["Label"] or class Name {');
        continue;
      }
      const c = touch(m[1], m[2]);
      if (!c.ns && nsStack.length) c.ns = nsStack[nsStack.length - 1];
      if (m[3] !== undefined && unquote(m[3])) c.label = unquote(m[3]);
      if (m[4]) c.classes.push(m[4]);
      if (m[5]) {
        const body = m[6] ?? "";
        const end = body.lastIndexOf("}");
        if (end >= 0) {
          for (const part of body.slice(0, end).split(";")) addMember(c, part);
        } else {
          addMember(c, body);
          open = c;
          openLine = ln;
        }
      }
      continue;
    }
    if ((m = new RegExp(String.raw`^<<\s*(.+?)\s*>>\s*(${NAME})\s*$`, "u").exec(text))) {
      touch(m[2]).annotations.push(m[1]);
      continue;
    }
    if ((m = REL_RE.exec(text))) {
      const a = touch(m[1], m[2]).id;
      const b = touch(m[8], m[9]).id;
      const label = m[10]?.trim();
      cd.relations.push({
        index: cd.relations.length,
        a,
        b,
        atA: m[4] ? LEFT[m[4]] : "none",
        atB: m[6] ? RIGHT[m[6]] : "none",
        dashed: m[5] === "..",
        ...(m[3] !== undefined && m[3].trim() ? { cardA: m[3].trim() } : {}),
        ...(m[7] !== undefined && m[7].trim() ? { cardB: m[7].trim() } : {}),
        ...(label ? { label: unquote(label) } : {}),
      });
      continue;
    }
    if ((m = MEMBER_RE.exec(text))) {
      addMember(touch(m[1], m[2]), m[3]);
      continue;
    }
    if ((m = BARE_RE.exec(text))) {
      const c = touch(m[1], m[2]);
      if (m[3]) c.classes.push(m[3]);
      continue;
    }
    // Something arrow-like between two names: say which arrows exist, and fix the usual slips.
    const arrow = /^(\S+?)\s*(?:"[^"]*"\s*)?([<>|*o().=\-]{2,5})\s*(?:"[^"]*"\s*)?(\S+)/.exec(text);
    if (arrow && /[-.=]/.test(arrow[2])) {
      const at = text.indexOf(arrow[2], arrow[1].length);
      const fix = ARROW_FIXES[arrow[2]];
      err(ln, col + at, `"${arrow[2]}" is not a class relation`, "Relations are <|-- *-- o-- --> -- ..> ..|> .. (and the same the other way round)", fix ? { old: arrow[2], new: fix } : undefined);
      continue;
    }
    err(ln, col, `Could not read "${text.slice(0, 40)}"`, "Expected a class, a member (Name : +field), a relation (A <|-- B) or a note");
  }
  if (open) err(openLine, 0, `The member block of class ${open.id} is never closed`, 'Add "}" after its last member');
  if (nsStack.length) err(lines.length - 1, 0, `namespace ${nsStack[nsStack.length - 1]} is never closed`, 'Add "}" after its last class');
  return cd;
}

// ---------------------------------------------------------------- drawing

const PAD_X = 12;
const HEAD_PAD = 7;
const COMP_PAD = 5;
const EMPTY = 8;

interface Box {
  width: number;
  height: number;
  ann: Label[];
  name: Label;
  attrs: Label[];
  methods: Label[];
  /** Heights of the header and the two compartments (0 when the class has no members). */
  head: number;
  attrH: number;
  methH: number;
}

function measureClass(c: CClass, fs: number): Box {
  const ms = fs - 1.5;
  const ann = c.annotations.map((a) => plainLabel(`«${a}»`, fs - 2.5, { italic: true }));
  const name = plainLabel(generics(c.label) + (c.generic ? `<${c.generic}>` : ""), fs, { bold: true, italic: c.annotations.some((a) => /^abstract$/i.test(a)) });
  const mem = (x: Member) => plainLabel(x.text, ms, { italic: x.isAbstract });
  const attrs = c.attrs.map(mem);
  const methods = c.methods.map(mem);
  const head = 2 * HEAD_PAD + name.height + ann.reduce((s, l) => s + l.height, 0);
  const any = attrs.length + methods.length > 0;
  const rows = (ls: Label[]) => (ls.length ? 2 * COMP_PAD + ls.reduce((s, l) => s + l.height, 0) : EMPTY);
  const attrH = any ? rows(attrs) : 0;
  const methH = any ? rows(methods) : 0;
  const width = Math.max(90, ...[name, ...ann, ...attrs, ...methods].map((l) => l.width + 2 * PAD_X));
  return { width: Math.ceil(width), height: head + attrH + methH, ann, name, attrs, methods, head, attrH, methH };
}

export function renderClassDiagram(src: string, ctx: DiagramContext): Rendered {
  return drawClassDiagram(parseClassDiagram(src, ctx.errors), ctx);
}

/** Does this end mark the parent or the whole, the end that belongs on top? */
const ruling = (k: EndKind) => k === "triangle" || k === "diamond" || k === "diamond-filled";

export function drawClassDiagram(cd: ClassDiagram, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const fs = t.fontSize;
  const bg = paper(t);
  const boxes = new Map<string, Box>();
  for (const c of cd.classes.values()) boxes.set(c.id, measureClass(c, fs));
  const noteLabels = new Map<string, Label>();
  const noteSize = new Map<string, [number, number]>();
  for (const nt of cd.notes) {
    const lab = layoutLabel(nt.text, fs - 1.5, 220);
    noteLabels.set(nt.id, lab);
    noteSize.set(nt.id, shapeSize("note", Math.max(lab.width, 20), Math.max(lab.height, fs), 12, 8));
  }
  const edgeLabels = new Map<number, Label>();
  for (const r of cd.relations) if (r.label) edgeLabels.set(r.index, layoutLabel(r.label, fs - 1.5, 180));
  const cardSize = fs - 2;
  const hasCards = cd.relations.some((r) => r.cardA || r.cardB);

  // Namespaces that hold something, with their ancestors.
  const usedNs = new Set<string>();
  for (const c of cd.classes.values()) for (let k = c.ns; k && !usedNs.has(k); k = cd.namespaces.get(k)?.parent) usedNs.add(k);
  const nsTitles = new Map<string, Label>();
  for (const id of usedNs) nsTitles.set(id, plainLabel(id, fs - 1, { bold: true }));

  // Layout: a relation runs from the end that rules (parent, whole) down to the other.
  const flipped = new Set<number>();
  const ledges: { id: number; from: string; to: string; weight?: number; label?: { width: number; height: number } }[] = cd.relations.map((r) => {
    const flip = !ruling(r.atA) && ruling(r.atB);
    if (flip) flipped.add(r.index);
    const lab = edgeLabels.get(r.index);
    return { id: r.index, from: flip ? r.b : r.a, to: flip ? r.a : r.b, label: lab ? { width: lab.width + 10, height: lab.height + 4 } : undefined };
  });
  const noteEdgeBase = cd.relations.length;
  cd.notes.forEach((nt, k) => {
    if (nt.for && cd.classes.has(nt.for)) ledges.push({ id: noteEdgeBase + k, from: nt.id, to: nt.for, weight: 0.5 });
  });
  const horizontal = cd.direction === "LR" || cd.direction === "RL";
  // Self loops need room beside their box: out of the right side, or the bottom in sideways layouts.
  const room = new Map<string, number>();
  {
    const count = new Map<string, number>();
    const along = new Map<string, number>();
    for (const r of cd.relations) {
      if (r.a !== r.b) continue;
      count.set(r.a, (count.get(r.a) ?? 0) + 1);
      const lab = edgeLabels.get(r.index);
      if (lab) along.set(r.a, Math.max(along.get(r.a) ?? 0, horizontal ? lab.height + 4 : lab.width + 10));
    }
    for (const [id, k] of count) room.set(id, loopRoom(k, along.get(id) ?? 0));
  }
  const lnodes = [
    ...[...cd.classes.values()].map((c) => ({ id: c.id, width: boxes.get(c.id)!.width + (horizontal ? 0 : (room.get(c.id) ?? 0)), height: boxes.get(c.id)!.height + (horizontal ? (room.get(c.id) ?? 0) : 0), cluster: c.ns })),
    ...cd.notes.map((nt) => ({ id: nt.id, width: noteSize.get(nt.id)![0], height: noteSize.get(nt.id)![1], cluster: nt.for ? cd.classes.get(nt.for)?.ns : undefined })),
  ];
  const lclusters = [...usedNs].map((id) => ({ id, parent: cd.namespaces.get(id)?.parent, padding: 16, titleWidth: nsTitles.get(id)!.width, titleHeight: nsTitles.get(id)!.height + 8 }));
  const layout = layoutGraph(lnodes, ledges, lclusters, {
    rankdir: cd.direction,
    // Across the ranks of a sideways layout, room for namespace titles between stacked namespaces.
    nodesep: 40 + (horizontal && lclusters.length ? 24 : 0),
    ranksep: hasCards ? 64 : 46,
    edgesep: 16,
  });
  // Where each box is drawn: its layout slot less the loop room.
  const place = new Map<string, { x: number; y: number; width: number; height: number }>();
  const offset = new Map<string, [number, number]>();
  for (const nd of lnodes) {
    const p = layout.nodes.get(nd.id)!;
    const extra = room.get(nd.id) ?? 0;
    const d: [number, number] = horizontal ? [0, -extra / 2] : [-extra / 2, 0];
    if (extra) offset.set(nd.id, d);
    place.set(nd.id, { x: p.x + d[0], y: p.y + d[1], width: p.width - (horizontal ? 0 : extra), height: p.height - (horizontal ? extra : 0) });
  }
  const ends = (pts: Pt[], a: string, b: string): Pt[] => {
    const da = offset.get(a);
    const db = offset.get(b);
    if (!da && !db) return pts;
    const out = pts.map((p) => [p[0], p[1]] as Pt);
    if (da) out[0] = [out[0][0] + da[0], out[0][1] + da[1]];
    if (db) out[out.length - 1] = [out[out.length - 1][0] + db[0], out[out.length - 1][1] + db[1]];
    return out;
  };
  const labelBoxes = cd.relations.flatMap((r) => {
    const pe = layout.edges.get(r.index);
    const lab = edgeLabels.get(r.index);
    if (!pe?.label || !lab) return [];
    const cluster = commonCluster(cd.classes.get(r.a)?.ns, cd.classes.get(r.b)?.ns, (c) => cd.namespaces.get(c)?.parent);
    return cluster ? [{ x: pe.label[0], y: pe.label[1], width: lab.width + 10, height: lab.height + 4, cluster }] : [];
  });
  const clusterBoxes = tightClusters(lclusters, [...lnodes.map((nd) => ({ ...layout.nodes.get(nd.id)!, cluster: nd.cluster })), ...labelBoxes]);

  const bounds = new Bounds();
  for (const b of clusterBoxes.values()) bounds.add(b.x, b.y, b.x + b.width, b.y + b.height);
  const out: string[] = [];
  const depth = (id: string) => {
    let d = 0;
    for (let k = cd.namespaces.get(id)?.parent; k; k = cd.namespaces.get(k)?.parent) d++;
    return d;
  };
  for (const [id, b] of [...clusterBoxes.entries()].sort((x, y) => depth(x[0]) - depth(y[0]))) out.push(clusterSvg(b, nsTitles.get(id), depth(id), t));

  const styleOf = (c: CClass) => {
    const st: Record<string, string> = { ...(cd.classDefs.get("default") ?? {}) };
    for (const k of c.classes) Object.assign(st, cd.classDefs.get(k) ?? {});
    return Object.assign(st, c.style);
  };

  // Relations.
  const edgesOut: string[] = [];
  const textOut: string[] = [];
  const loops = new Map<string, number>();
  const centre = (id: string): [number, number] => {
    const p = place.get(id)!;
    return [p.x, p.y];
  };
  for (const r of cd.relations) {
    const lw = t.lineWidth;
    const dash = r.dashed ? `${n(lw * 3.2)} ${n(lw * 2.4)}` : undefined;
    const spec = { start: r.atA, end: r.atB, color: t.line, lw, dash, bg };
    const lab = edgeLabels.get(r.index);
    if (r.a === r.b) {
      const p = place.get(r.a)!;
      const k = loops.get(r.a) ?? 0;
      loops.set(r.a, k + 1);
      edgesOut.push(selfLoopSvg(p.x, p.y, p.width, p.height, k, spec, lab, t, t.mutedText, bounds, horizontal ? "bottom" : "right"));
      continue;
    }
    const pe = layout.edges.get(r.index);
    if (!pe) continue;
    const pts = ends(flipped.has(r.index) ? [...pe.points].reverse() : pe.points, r.a, r.b);
    for (const p of pts) bounds.add(p[0], p[1], p[0], p[1]);
    const pa = place.get(r.a)!;
    const pb = place.get(r.b)!;
    const d = drawEdge({ ...spec, points: pts, vertical: layout.vertical, boxes: { from: rectOf(pa), to: rectOf(pb), stub: 18 } });
    edgesOut.push(d.svg);
    if (lab && pe.label) textOut.push(edgeLabelSvg(lab, pe.label[0], pe.label[1], t, t.mutedText, bounds));
    if (r.cardA) textOut.push(endTextSvg(plainLabel(r.cardA, cardSize), d.startTip, d.startDir, centre(r.a), markerLength(r.atA), t.text, bounds));
    if (r.cardB) textOut.push(endTextSvg(plainLabel(r.cardB, cardSize), d.endTip, d.endDir, centre(r.b), markerLength(r.atB), t.text, bounds));
  }
  // Note connectors: thin dashed lines, no markers.
  cd.notes.forEach((nt, k) => {
    const pe = layout.edges.get(noteEdgeBase + k);
    if (!pe || !nt.for) return;
    const pa = place.get(nt.id)!;
    const pb = place.get(nt.for)!;
    const d = drawEdge({ points: ends(pe.points, nt.id, nt.for), vertical: layout.vertical, from: inBox(pa.x, pa.y, pa.width, pa.height), to: inBox(pb.x, pb.y, pb.width, pb.height), start: "none", end: "none", color: t.noteStroke, lw: 1, dash: "3 3", bg });
    edgesOut.push(d.svg);
  });
  out.push(...edgesOut);

  // Notes.
  for (const nt of cd.notes) {
    const p = place.get(nt.id);
    if (!p) continue;
    bounds.box(p.x, p.y, p.width, p.height);
    out.push(shapeSvg("note", p.x, p.y, p.width, p.height, { fill: t.noteFill, stroke: t.noteStroke, strokeWidth: 1, radius: 0, shadow: t.shadow }));
    out.push(labelSvg(noteLabels.get(nt.id)!, p.x, p.y, t.text));
  }

  // Class boxes.
  for (const c of cd.classes.values()) {
    const p = place.get(c.id);
    if (!p) continue;
    const bx = boxes.get(c.id)!;
    const st = styleOf(c);
    const head = safeColor(st.fill) ?? t.nodeFill;
    const stroke = safeColor(st.stroke) ?? t.nodeStroke;
    const ink = safeColor(st.color) ?? t.text;
    const sw = parseFloat(st["stroke-width"] ?? "") || 1.2;
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    const w = p.width;
    const h = p.height;
    const r = t.radius;
    bounds.box(p.x, p.y, w, h);
    out.push(shadowSvg("rect", p.x, p.y, w, h, r, t.shadow));
    out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${bg}"/>`);
    // The header band, rounded only at the top when compartments follow.
    if (bx.attrH + bx.methH > 0) {
      const hb = bx.head;
      out.push(`<path d="M${n(x)} ${n(y + hb)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(x + w - r)}Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)}V${n(y + hb)}Z" fill="${head}"/>`);
      out.push(`<path d="M${n(x)} ${n(y + hb)}H${n(x + w)}" stroke="${stroke}" stroke-width="0.9" fill="none"/>`);
      out.push(`<path d="M${n(x)} ${n(y + hb + bx.attrH)}H${n(x + w)}" stroke="${t.clusterStroke}" stroke-width="0.9" fill="none"/>`);
    } else out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${head}"/>`);
    out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="none" stroke="${stroke}" stroke-width="${n(sw)}"/>`);
    // Header: annotations, then the name.
    let cy = y + HEAD_PAD;
    for (const a of bx.ann) {
      out.push(labelSvg(a, p.x, cy + a.height / 2, t.mutedText));
      cy += a.height;
    }
    out.push(labelSvg(bx.name, p.x, cy + bx.name.height / 2, ink));
    // Members, left aligned; static ones underlined.
    const rows = (ls: Label[], ms: Member[], top: number) => {
      let yy = top + COMP_PAD;
      ls.forEach((l, i) => {
        const mid = yy + l.height / 2;
        out.push(labelSvg(l, x + PAD_X, mid, ink, { align: "start" }));
        if (ms[i].isStatic) {
          const base = yy + l.ascent + 1.6;
          out.push(`<path d="M${n(x + PAD_X)} ${n(base)}H${n(x + PAD_X + l.width)}" stroke="${ink}" stroke-width="0.8" fill="none"/>`);
        }
        yy += l.height;
      });
    };
    if (bx.attrH + bx.methH > 0) {
      rows(bx.attrs, c.attrs, y + bx.head);
      rows(bx.methods, c.methods, y + bx.head + bx.attrH);
    }
  }
  out.push(...textOut);

  const f = frame(out.join(""), bounds, 8);
  return { svg: svgDocument(f.width, f.height, f.body, t, ctx.title), width: f.width, height: f.height };
}
