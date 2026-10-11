/**
 * Mermaid entity-relationship diagrams (`erDiagram`): parsed here, laid out
 * by layered.ts, drawn as entity tables joined by crow's-foot lines.
 *
 * Covered: relationships with every cardinality marker (|o || }o }| on the
 * left, o| || o{ |{ on the right, either form accepted on either side) and
 * Mermaid's word forms ("one or more", "zero or many", "only one", ... with
 * "to" or "optionally to"), identifying (--) and non-identifying (..)
 * lines, quoted or bare labels, attribute blocks with type, name, keys (PK,
 * FK, UK, several separated by commas) and a quoted comment, display names
 * (`p[Person]`, `CUSTOMER["Customer account"]`), quoted entity names,
 * `direction`, and classDef, class, ::: and style for colours.
 *
 * An entity with attributes is a table: a header with its name, then a row
 * per attribute with the columns aligned across the rows.
 */

import { layoutGraph, type RankDir } from "./layered.js";
import { Bounds, drawEdge, edgeLabelSvg, frame, loopRoom, rectOf, paper, parseStyle, plainLabel, selfLoopSvg } from "./graphdraw.js";
import { type EndKind, labelSvg, n, type Pt, shadowSvg, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import { safeColor } from "./theme.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment, unquote } from "./types.js";

interface Attr {
  type: string;
  name: string;
  keys: string[];
  comment?: string;
}

interface Entity {
  id: string;
  label: string;
  attrs: Attr[];
  classes: string[];
  style: Record<string, string>;
}

interface Rel {
  index: number;
  a: string;
  b: string;
  atA: EndKind;
  atB: EndKind;
  identifying: boolean;
  label?: string;
}

export interface ErDiagram {
  direction: RankDir;
  entities: Map<string, Entity>;
  relations: Rel[];
  classDefs: Map<string, Record<string, string>>;
}

const SYMBOLS: Record<string, EndKind> = {
  "|o": "zero-one",
  "o|": "zero-one",
  "||": "one",
  "}o": "zero-many",
  "o{": "zero-many",
  "}|": "one-many",
  "|{": "one-many",
};
const WORDS: [RegExp, EndKind][] = [
  [/^(?:one or zero|zero or one)$/i, "zero-one"],
  [/^(?:one or more|one or many|many\(1\)|1\+)$/i, "one-many"],
  [/^(?:zero or more|zero or many|many\(0\)|0\+)$/i, "zero-many"],
  [/^(?:only one|exactly one|1)$/i, "one"],
];
/** Markers people write that Mermaid does not have, and the ones they meant. */
const SYMBOL_FIXES: Record<string, string> = { "|<": "|{", "o<": "o{", ">|": "}|", ">o": "}o", "|>": "|{", "<|": "}|", "<o": "}o", "o>": "o{", "{|": "}|", "{o": "}o", "|}": "|{", "o}": "o{", "1": "||" };

const ENT = String.raw`("[^"]+"|[\p{L}_][\p{L}\p{N}_\-]*)(?:\[\s*("[^"]*"|[^\]]*)\s*\])?(?::::([\w-]+))?`;
const REL_RE = new RegExp(String.raw`^${ENT}\s+(\S{2})(--|\.\.|\.-|-\.)(\S{2})\s+${ENT}\s*(?::\s*(.*))?$`, "u");
const WORD_REL_RE = new RegExp(String.raw`^${ENT}\s+([a-z0-9()+ ]+?)\s+(optionally\s+to|to)\s+([a-z0-9()+ ]+?)\s+${ENT}\s*(?::\s*(.*))?$`, "iu");
const BLOCK_RE = new RegExp(String.raw`^${ENT}\s*(\{)?\s*(.*)$`, "u");
const TYPE = String.raw`[\p{L}_](?:[\p{L}\p{N}_\-\[\]<>~.]|\([^)]*\))*`;
const ATTR_RE = new RegExp(String.raw`^(${TYPE})\s+(\*?[\p{L}_][\p{L}\p{N}_\-\[\]()]*)\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?\s*(?:"([^"]*)")?\s*,?\s*$`, "u");

export function parseErDiagram(src: string, errors: DiagramError[]): ErDiagram {
  const er: ErDiagram = { direction: "TB", entities: new Map(), relations: [], classDefs: new Map() };
  let open: Entity | undefined;
  let openLine = 0;
  let headerSeen = false;
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) });

  const touch = (rawId: string, alias?: string, cls?: string): Entity => {
    const id = unquote(rawId);
    let e = er.entities.get(id);
    if (!e) {
      e = { id, label: id, attrs: [], classes: [], style: {} };
      er.entities.set(id, e);
    }
    if (alias !== undefined && unquote(alias)) e.label = unquote(alias);
    if (cls) e.classes.push(cls);
    return e;
  };
  const attrLine = (e: Entity, text: string, ln: number, col: number) => {
    const m = ATTR_RE.exec(text);
    if (!m) {
      const word = text.split(/\s+/);
      err(ln, col, `Could not read the attribute "${text.slice(0, 40)}"`, word.length < 2 ? "An attribute is a type and a name, for example: string name PK" : 'Write: type name, then PK, FK or UK if it is a key, then a "comment"');
      return;
    }
    e.attrs.push({ type: m[1], name: m[2], keys: m[3] ? m[3].split(/\s*,\s*/) : [], ...(m[4] !== undefined ? { comment: m[4] } : {}) });
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
        const body = text.slice(0, -1).trim();
        if (body) attrLine(open, body, ln, col);
        open = undefined;
        continue;
      }
      attrLine(open, text, ln, col);
      continue;
    }
    if (!headerSeen) {
      headerSeen = true;
      if (/^erDiagram\b/.test(text)) continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^direction\s+(\w+)\s*$/.exec(text))) {
      const d = m[1].toUpperCase();
      if (d === "TB" || d === "TD" || d === "BT" || d === "LR" || d === "RL") er.direction = d === "TD" ? "TB" : d;
      else err(ln, col + text.indexOf(m[1]), `Unknown direction "${m[1]}"`, "Use TB, BT, LR or RL");
      continue;
    }
    if (/^(accTitle|accDescr|title|click)\b/.test(text)) continue;
    if ((m = /^classDef\s+([\w,\- ]+?)\s+(.+)$/.exec(text))) {
      for (const name of m[1].split(",")) er.classDefs.set(name.trim(), { ...(er.classDefs.get(name.trim()) ?? {}), ...parseStyle(m[2]) });
      continue;
    }
    if ((m = /^class\s+([^\s]+)\s+([\w-]+)\s*$/.exec(text))) {
      for (const id of m[1].split(",")) if (id.trim()) touch(id.trim()).classes.push(m[2]);
      continue;
    }
    if ((m = /^style\s+(\S+)\s+(.+)$/.exec(text))) {
      Object.assign(touch(m[1]).style, parseStyle(m[2]));
      continue;
    }
    if ((m = REL_RE.exec(text))) {
      const [, a, aAlias, aCls, left, line, right, b, bAlias, bCls, label] = m;
      const atA = SYMBOLS[left];
      const atB = SYMBOLS[right];
      if (!atA || !atB) {
        const bad = atA ? right : left;
        const at = atA ? text.indexOf(right, text.indexOf(line) + line.length) : text.indexOf(left + line);
        const fix = SYMBOL_FIXES[bad];
        err(ln, col + at, `"${bad}" is not a cardinality`, "Cardinalities are |o || }o }| on the left and o| || o{ |{ on the right: zero or one, exactly one, zero or more, one or more", fix ? { old: bad, new: fix } : undefined);
        continue;
      }
      pushRel(a, aAlias, aCls, atA, line === "--", b, bAlias, bCls, label).atB = atB;
      continue;
    }
    if ((m = WORD_REL_RE.exec(text))) {
      const [, a, aAlias, aCls, lw, how, rw, b, bAlias, bCls, label] = m;
      const kind = (w: string) => WORDS.find(([re]) => re.test(w.trim()))?.[1];
      const ka = kind(lw);
      const kb = kind(rw);
      if (!ka || !kb) {
        const bad = ka ? rw : lw;
        err(ln, col + text.indexOf(bad), `"${bad.trim()}" is not a cardinality`, 'In words: "only one", "zero or one", "one or more", "zero or more"');
        continue;
      }
      const rel = pushRel(a, aAlias, aCls, ka, !/^optionally/i.test(how), b, bAlias, bCls, label);
      rel.atB = kb;
      continue;
    }
    if (/--|\.\./.test(text) && !/\{\s*$/.test(text)) {
      err(ln, col, `Could not read the relationship "${text.slice(0, 50)}"`, "Write: ENTITY1 ||--o{ ENTITY2 : label");
      continue;
    }
    if ((m = BLOCK_RE.exec(text))) {
      const e = touch(m[1], m[2], m[3]);
      if (m[4]) {
        const rest = m[5].trim();
        if (rest.endsWith("}")) {
          for (const part of rest.slice(0, -1).split(/\s*[;\n]\s*/)) if (part.trim()) attrLine(e, part.trim(), ln, col + text.indexOf(part));
        } else {
          if (rest) attrLine(e, rest, ln, col + text.indexOf(rest));
          open = e;
          openLine = ln;
        }
        continue;
      }
      if (!m[5].trim()) continue;
    }
    err(ln, col, `Could not read "${text.slice(0, 40)}"`, "Expected an entity (NAME or NAME { ... }) or a relationship (A ||--o{ B : label)");
  }
  if (open) err(openLine, 0, `The attribute block of ${open.id} is never closed`, 'Add "}" after its last attribute');
  return er;

  function pushRel(a: string, aAlias: string | undefined, aCls: string | undefined, atA: EndKind, identifying: boolean, b: string, bAlias: string | undefined, bCls: string | undefined, label: string | undefined): Rel {
    const ea = touch(a, aAlias, aCls);
    const eb = touch(b, bAlias, bCls);
    const lab = label !== undefined ? unquote(label.trim()) : "";
    const rel: Rel = { index: er.relations.length, a: ea.id, b: eb.id, atA, atB: "none", identifying, ...(lab ? { label: lab } : {}) };
    // The caller sets the marker at b.
    er.relations.push(rel);
    return rel;
  }
}

// ---------------------------------------------------------------- drawing

const CELL_X = 9;
const ROW_PAD = 4;
const HEAD_PAD = 8;

interface Table {
  width: number;
  height: number;
  head: number;
  name: Label;
  rows: { type: Label; name: Label; keys: Label; comment: Label; h: number }[];
  cols: number[];
}

function measureEntity(e: Entity, fs: number): Table {
  const name = plainLabel(e.label, fs, { bold: true });
  const rs = fs - 2;
  const rows = e.attrs.map((a) => {
    const type = plainLabel(a.type, rs);
    const nm = plainLabel(a.name, rs);
    const keys = plainLabel(a.keys.join(", "), rs - 1, { bold: true });
    const comment = plainLabel(a.comment ?? "", rs - 0.5, { italic: true });
    return { type, name: nm, keys, comment, h: Math.max(type.height, nm.height) + 2 * ROW_PAD };
  });
  const colW = (f: (r: Table["rows"][number]) => Label) => {
    const w = Math.max(0, ...rows.map((r) => f(r).width));
    return w > 0 ? w + 2 * CELL_X : 0;
  };
  const cols = [colW((r) => r.type), colW((r) => r.name), colW((r) => r.keys), colW((r) => r.comment)];
  const head = name.height + 2 * HEAD_PAD;
  const tableW = cols.reduce((s, w) => s + w, 0);
  const width = Math.max(rows.length ? 0 : 100, name.width + 2 * 16, tableW);
  // Spare width goes to the last column present, so the right edge stays tidy.
  if (rows.length && width > tableW) {
    const last = cols.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
    cols[last] += width - tableW;
  }
  const height = rows.length ? head + rows.reduce((s, r) => s + r.h, 0) : name.height + 2 * 12;
  return { width: Math.ceil(width), height, head: rows.length ? head : height, name, rows, cols };
}

export function renderEr(src: string, ctx: DiagramContext): Rendered {
  return drawErDiagram(parseErDiagram(src, ctx.errors), ctx);
}

export function drawErDiagram(er: ErDiagram, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const fs = t.fontSize;
  const bg = paper(t);
  const horizontal = er.direction === "LR" || er.direction === "RL";
  const tables = new Map<string, Table>();
  for (const e of er.entities.values()) tables.set(e.id, measureEntity(e, fs));
  const edgeLabels = new Map<number, Label>();
  for (const r of er.relations) if (r.label) edgeLabels.set(r.index, layoutLabel(r.label, fs - 1.5, 180));

  const room = new Map<string, number>();
  {
    const count = new Map<string, number>();
    const along = new Map<string, number>();
    for (const r of er.relations) {
      if (r.a !== r.b) continue;
      count.set(r.a, (count.get(r.a) ?? 0) + 1);
      const lab = edgeLabels.get(r.index);
      if (lab) along.set(r.a, Math.max(along.get(r.a) ?? 0, horizontal ? lab.height + 4 : lab.width + 10));
    }
    for (const [id, k] of count) room.set(id, loopRoom(k, along.get(id) ?? 0) + 14);
  }
  const lnodes = [...er.entities.values()].map((e) => {
    const tb = tables.get(e.id)!;
    const extra = room.get(e.id) ?? 0;
    return { id: e.id, width: tb.width + (horizontal ? 0 : extra), height: tb.height + (horizontal ? extra : 0) };
  });
  const layout = layoutGraph(
    lnodes,
    er.relations.map((r) => {
      const lab = edgeLabels.get(r.index);
      return { id: r.index, from: r.a, to: r.b, label: lab ? { width: lab.width + 10, height: lab.height + 4 } : undefined };
    }),
    [],
    { rankdir: er.direction, nodesep: 44, ranksep: 58, edgesep: 18 },
  );
  const place = new Map<string, { x: number; y: number; width: number; height: number; d: Pt }>();
  for (const e of er.entities.values()) {
    const p = layout.nodes.get(e.id)!;
    const extra = room.get(e.id) ?? 0;
    const d: Pt = horizontal ? [0, -extra / 2] : [-extra / 2, 0];
    const tb = tables.get(e.id)!;
    place.set(e.id, { x: p.x + d[0], y: p.y + d[1], width: tb.width, height: tb.height, d });
  }

  const bounds = new Bounds();
  const out: string[] = [];
  const edgesOut: string[] = [];
  const labelsOut: string[] = [];
  const loops = new Map<string, number>();
  for (const r of er.relations) {
    const lw = t.lineWidth * 0.9;
    const spec = { start: r.atA, end: r.atB, color: t.line, lw, dash: r.identifying ? undefined : `${n(lw * 3.4)} ${n(lw * 2.6)}`, bg };
    const lab = edgeLabels.get(r.index);
    if (r.a === r.b) {
      const p = place.get(r.a)!;
      const k = loops.get(r.a) ?? 0;
      loops.set(r.a, k + 1);
      edgesOut.push(selfLoopSvg(p.x, p.y, p.width, p.height, k + 1, spec, lab, t, t.mutedText, bounds, horizontal ? "bottom" : "right"));
      continue;
    }
    const pe = layout.edges.get(r.index);
    if (!pe) continue;
    const pa = place.get(r.a)!;
    const pb = place.get(r.b)!;
    const pts: Pt[] = pe.points.map((p) => [p[0], p[1]]);
    pts[0] = [pts[0][0] + pa.d[0], pts[0][1] + pa.d[1]];
    pts[pts.length - 1] = [pts[pts.length - 1][0] + pb.d[0], pts[pts.length - 1][1] + pb.d[1]];
    for (const p of pts) bounds.add(p[0], p[1], p[0], p[1]);
    const d = drawEdge({ ...spec, points: pts, vertical: layout.vertical, boxes: { from: rectOf(pa), to: rectOf(pb), stub: 22 } });
    edgesOut.push(d.svg);
    if (lab && pe.label) labelsOut.push(edgeLabelSvg(lab, pe.label[0], pe.label[1], t, t.mutedText, bounds));
  }
  out.push(...edgesOut);

  const styleOf = (e: Entity) => {
    const st: Record<string, string> = { ...(er.classDefs.get("default") ?? {}) };
    for (const k of e.classes) Object.assign(st, er.classDefs.get(k) ?? {});
    return Object.assign(st, e.style);
  };
  for (const e of er.entities.values()) {
    const p = place.get(e.id)!;
    const tb = tables.get(e.id)!;
    const st = styleOf(e);
    const headFill = safeColor(st.fill) ?? (tb.rows.length ? t.clusterFill : t.nodeFill);
    const stroke = safeColor(st.stroke) ?? t.nodeStroke;
    const ink = safeColor(st.color) ?? t.text;
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    const w = p.width;
    const h = p.height;
    const r = t.radius;
    bounds.box(p.x, p.y, w, h);
    out.push(shadowSvg("rect", p.x, p.y, w, h, r, t.shadow));
    if (tb.rows.length) {
      out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${bg}"/>`);
      out.push(`<path d="M${n(x)} ${n(y + tb.head)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(x + w - r)}Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)}V${n(y + tb.head)}Z" fill="${headFill}"/>`);
      out.push(`<path d="M${n(x)} ${n(y + tb.head)}H${n(x + w)}" stroke="${stroke}" stroke-width="0.9" fill="none"/>`);
      out.push(labelSvg(tb.name, p.x, y + tb.head / 2, ink));
      let yy = y + tb.head;
      tb.rows.forEach((row, i) => {
        if (i) out.push(`<path d="M${n(x + 1)} ${n(yy)}H${n(x + w - 1)}" stroke="${t.clusterStroke}" stroke-width="0.6" fill="none"/>`);
        const mid = yy + row.h / 2;
        let cx = x;
        const cells: [Label, string][] = [
          [row.type, t.mutedText],
          [row.name, ink],
          [row.keys, t.accentStroke],
          [row.comment, t.mutedText],
        ];
        cells.forEach(([lab, color], k) => {
          if (tb.cols[k] > 0 && lab.lines.length) out.push(labelSvg(lab, cx + CELL_X, mid, color, { align: "start" }));
          cx += tb.cols[k];
        });
        yy += row.h;
      });
      out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="none" stroke="${stroke}" stroke-width="1.2"/>`);
    } else {
      out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${headFill}" stroke="${stroke}" stroke-width="1.2"/>`);
      out.push(labelSvg(tb.name, p.x, p.y, ink));
    }
  }
  out.push(...labelsOut);
  if (!er.entities.size) bounds.add(0, 0, 0, 0);

  const f = frame(out.join(""), bounds, 8);
  return { svg: svgDocument(f.width, f.height, f.body, t, ctx.title), width: f.width, height: f.height };
}
