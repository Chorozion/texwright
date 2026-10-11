/**
 * Mermaid sequence diagrams (`sequenceDiagram`): parsed, laid out and drawn
 * here.
 *
 * The syntax covered is what people and models actually write: participant
 * and actor declarations with aliases and `@{ type: ... }` shapes, implicit
 * participants, create and destroy, every message arrow (solid and dotted,
 * with arrow, open, cross or no head, and the two-way <<->>), activations
 * written out or as + and - on arrows, self messages, notes beside or over
 * one or two participants, the blocks loop, alt/else, opt, par/and,
 * critical/option and break (nested as deep as needed), rect highlights,
 * participant boxes, autonumber and title.
 *
 * Layout follows Mermaid's model: participants sit in a row, each message is
 * a row of its own, and the gap between two neighbours grows until every
 * label, note and self loop between them fits. A statement that cannot be
 * read is reported with its line and column and skipped; the rest is drawn.
 */

import { type EndKind, endInset, endSvg, esc, labelSvg, n, shadowSvg, shapeSvg, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import { safeColor } from "./theme.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment, unquote } from "./types.js";

export type ParticipantKind = "participant" | "actor" | "database" | "collections" | "queue" | "boundary" | "control" | "entity";

export interface SeqParticipant {
  id: string;
  label: string;
  kind: ParticipantKind;
  /** Index into `boxes` when declared inside a box. */
  box?: number;
  /** Declared with `create`: drawn where its first message reaches it. */
  created: boolean;
  /** Ended with `destroy`: its lifeline stops at its last message. */
  destroyed: boolean;
}

export interface SeqBox {
  label: string;
  color?: string;
  members: number[];
}

export type BlockKind = "loop" | "alt" | "opt" | "par" | "critical" | "break" | "rect";

export type SeqEvent =
  | { t: "msg"; from: number; to: number; text: string; dotted: boolean; start: EndKind; end: EndKind; activate: boolean; deactivate: boolean; num?: number; line: number }
  | { t: "note"; pos: "left" | "right" | "over"; a: number; b: number; text: string; line: number }
  | { t: "activate"; p: number; on: boolean; line: number }
  | { t: "open"; kind: BlockKind; label: string; color?: string; line: number }
  | { t: "sep"; kind: "else" | "and" | "option"; label: string; line: number }
  | { t: "close"; line: number }
  | { t: "create"; p: number; line: number }
  | { t: "destroy"; p: number; line: number };

export interface SequenceDiagram {
  title?: string;
  participants: SeqParticipant[];
  boxes: SeqBox[];
  events: SeqEvent[];
}

// ---------------------------------------------------------------- parsing

interface Arrow {
  dotted: boolean;
  start: EndKind;
  end: EndKind;
}

/** Arrow tokens, longest first so that -->> is not read as -- and >>. */
const ARROWS: [string, Arrow][] = [
  ["<<-->>", { dotted: true, start: "arrow", end: "arrow" }],
  ["<<->>", { dotted: false, start: "arrow", end: "arrow" }],
  ["-->>", { dotted: true, start: "none", end: "arrow" }],
  ["->>", { dotted: false, start: "none", end: "arrow" }],
  ["--x", { dotted: true, start: "none", end: "cross" }],
  ["-x", { dotted: false, start: "none", end: "cross" }],
  ["--)", { dotted: true, start: "none", end: "open" }],
  ["-)", { dotted: false, start: "none", end: "open" }],
  ["-->", { dotted: true, start: "none", end: "none" }],
  ["->", { dotted: false, start: "none", end: "none" }],
];

const KEYWORDS = [
  "participant", "actor", "create", "destroy", "activate", "deactivate", "Note", "loop", "alt", "else", "opt",
  "par", "and", "critical", "option", "break", "rect", "end", "box", "autonumber", "title",
];

const BLOCKS: Record<string, BlockKind> = { loop: "loop", alt: "alt", opt: "opt", par: "par", par_over: "par", critical: "critical", break: "break", rect: "rect" };
/** Which separator belongs to which block. */
const SEPARATORS: Record<string, BlockKind> = { else: "alt", and: "par", option: "critical" };
const SEP_FOR: Partial<Record<BlockKind, string>> = { alt: "else", par: "and", critical: "option" };

const CSS_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke " +
    "yellow yellowgreen transparent"
  ).split(" "),
);

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** The candidate closest to `word`, if it is a plausible misspelling of it. */
function closest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  const w = word.toLowerCase();
  for (const c of candidates) {
    const d = editDistance(w, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const limit = word.length <= 3 ? 1 : word.length <= 6 ? 2 : 3;
  return best !== undefined && bestD > 0 && bestD <= limit ? best : undefined;
}

/** The first arrow in a statement whose target part holds no other arrow, so `a-x-b->>c` is not split at -x. */
function findArrow(text: string): { at: number; tok: string; arrow: Arrow } | undefined {
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c !== "-" && c !== "<") continue;
    for (const [tok, arrow] of ARROWS) {
      if (!text.startsWith(tok, i)) continue;
      const after = text.slice(i + tok.length);
      const colon = after.indexOf(":");
      const target = colon >= 0 ? after.slice(0, colon) : after;
      if (ARROWS.some(([t]) => target.includes(t) && t.length > 2)) break;
      if (!text.slice(0, i).trim()) break;
      return { at: i, tok, arrow };
    }
  }
  return undefined;
}

type RawEvent =
  | { t: "decl"; id: string; label: string; kind: ParticipantKind; box?: number; create: boolean; line: number; col: number }
  | { t: "msg"; from: string; to: string; fromCol: number; toCol: number; text: string; arrow: Arrow; activate: boolean; deactivate: boolean; num?: number; line: number }
  | { t: "note"; pos: "left" | "right" | "over"; names: { name: string; col: number }[]; text: string; line: number }
  | { t: "activate"; name: string; col: number; on: boolean; line: number }
  | { t: "destroy"; name: string; col: number; line: number }
  | { t: "open"; kind: BlockKind; label: string; color?: string; line: number }
  | { t: "sep"; kind: "else" | "and" | "option"; label: string; line: number }
  | { t: "close"; line: number };

const KINDS: Record<string, ParticipantKind> = {
  participant: "participant", actor: "actor", database: "database", collections: "collections", queue: "queue", boundary: "boundary", control: "control", entity: "entity",
};

/** Reads a sequence diagram. Problems go to `errors`; whatever could be read is returned. */
export function parseSequence(src: string, errors: DiagramError[]): SequenceDiagram {
  const sd: SequenceDiagram = { participants: [], boxes: [], events: [] };
  const firstError = errors.length;
  const raw: RawEvent[] = [];
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, hint, ...(fix ? { fix } : {}) });
  const blocks: { kind: BlockKind; line: number }[] = [];
  let box: number | undefined;
  let boxLine = 0;
  let autonumber: { next: number; step: number } | undefined;
  let header = false;

  const lines = src.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = stripComment(lines[ln]).replace(/\r$/, "");
    let text = line.trim();
    if (!text) continue;
    let col0 = line.length - line.trimStart().length;
    if (!header) {
      header = true;
      const h = /^sequenceDiagram\b\s*/.exec(text);
      if (h) {
        text = text.slice(h[0].length);
        col0 += h[0].length;
        if (!text) continue;
      }
    }
    if (text.endsWith(";")) text = text.slice(0, -1).trimEnd();
    if (!text) continue;

    const wordM = /^([A-Za-z_]+)\b\s*/.exec(text);
    const word = wordM ? wordM[1] : "";
    const lw = word.toLowerCase();
    const rest = wordM ? text.slice(wordM[0].length) : text;
    const restCol = col0 + (wordM ? wordM[0].length : 0);
    // A word followed straight by an arrow is a participant name, even if it is also a keyword.
    const isMessageStart = /^[A-Za-z_]+\s*(<<)?-/.test(text);

    if (wordM && !isMessageStart) {
      if (lw === "participant" || lw === "actor" || (lw === "create" && /^(participant|actor)\b/i.test(rest))) {
        let kindWord = lw;
        let body = rest;
        let bodyCol = restCol;
        if (lw === "create") {
          const m = /^(participant|actor)\s*/i.exec(rest)!;
          kindWord = m[1].toLowerCase();
          body = rest.slice(m[0].length);
          bodyCol = restCol + m[0].length;
        }
        if (!body.trim()) {
          err(ln, col0, `${kindWord} needs a name`, `For example: ${kindWord} A as Alice`);
          continue;
        }
        const m = /^(.+?)(?:\s*@\{([^}]*)\})?(?:\s+as\s+(.+))?$/.exec(body)!;
        const id = unquote(m[1]);
        let kind: ParticipantKind = KINDS[kindWord];
        if (m[2]) {
          const tm = /type["']?\s*:\s*["']?([A-Za-z]+)/.exec(m[2]);
          if (tm && Object.hasOwn(KINDS, tm[1].toLowerCase())) kind = KINDS[tm[1].toLowerCase()];
        }
        const label = m[3] !== undefined ? unquote(m[3]) : id;
        raw.push({ t: "decl", id, label, kind, box, create: lw === "create", line: ln, col: bodyCol });
        continue;
      }
      switch (lw) {
        case "create":
          err(ln, col0, "create must be followed by participant or actor", "For example: create participant Carl");
          continue;
        case "destroy":
        case "activate":
        case "deactivate": {
          const name = rest.trim();
          if (!name) {
            err(ln, col0, `${word} needs a participant name`, `For example: ${lw} Alice`);
            continue;
          }
          if (lw === "destroy") raw.push({ t: "destroy", name, col: restCol, line: ln });
          else raw.push({ t: "activate", name, col: restCol, on: lw === "activate", line: ln });
          continue;
        }
        case "note": {
          const m = /^(right\s+of|left\s+of|over)\s+([^:]*?)\s*(?::\s*(.*))?$/i.exec(rest);
          if (!m) {
            const w2 = /^\S+/.exec(rest)?.[0] ?? "";
            const near = w2 ? closest(w2, ["right", "left", "over"]) : undefined;
            err(ln, restCol, "A note needs a position: right of, left of or over", "For example: Note right of Alice: text", near ? { old: w2, new: near } : undefined);
            continue;
          }
          if (m[3] === undefined) err(ln, col0 + text.length, "A note needs its text after a colon", "For example: Note over Alice: text", { old: "", new: ": " });
          const pos = m[1].toLowerCase().startsWith("right") ? "right" : m[1].toLowerCase().startsWith("left") ? "left" : "over";
          const namesCol = restCol + rest.indexOf(m[2], m[1].length);
          const names: { name: string; col: number }[] = [];
          let off = 0;
          for (const part of m[2].split(",")) {
            const lead = part.length - part.trimStart().length;
            if (part.trim()) names.push({ name: unquote(part), col: namesCol + off + lead });
            off += part.length + 1;
          }
          if (!names.length) {
            err(ln, restCol, "A note needs a participant", "For example: Note right of Alice: text");
            continue;
          }
          if (pos !== "over" && names.length > 1) err(ln, namesCol, `"${m[1]}" takes one participant`, "Use Note over A,B: text for a note across two");
          raw.push({ t: "note", pos, names: pos === "over" ? names.slice(0, 2) : names.slice(0, 1), text: m[3] ?? "", line: ln });
          continue;
        }
        case "loop":
        case "alt":
        case "opt":
        case "par":
        case "par_over":
        case "critical":
        case "break":
        case "rect": {
          const kind = BLOCKS[lw];
          blocks.push({ kind, line: ln });
          if (kind === "rect") {
            const color = safeColor(rest.trim());
            if (rest.trim() && !color) err(ln, restCol, `"${rest.trim()}" is not a colour rect can use`, "For example: rect rgb(230, 240, 255) or rect rgba(0, 0, 255, 0.1)");
            raw.push({ t: "open", kind, label: "", color, line: ln });
          } else raw.push({ t: "open", kind, label: rest.trim(), line: ln });
          continue;
        }
        case "else":
        case "and":
        case "option": {
          const sepKind = lw as "else" | "and" | "option";
          const top = blocks[blocks.length - 1];
          if (!top) {
            err(ln, col0, `"${word}" outside a block`, `${word} separates the parts of ${SEPARATORS[lw] === "alt" ? "an alt" : `a ${SEPARATORS[lw]}`} block; open one first`);
            continue;
          }
          if (top.kind !== SEPARATORS[lw]) {
            const right = SEP_FOR[top.kind];
            err(ln, col0, `"${word}" does not belong in a ${top.kind} block`, right ? `A ${top.kind} block is divided with "${right}"` : `A ${top.kind} block has no parts`, right ? { old: word, new: right } : undefined);
          }
          raw.push({ t: "sep", kind: sepKind, label: rest.trim(), line: ln });
          continue;
        }
        case "end":
          if (rest.trim()) {
            err(ln, restCol, `Unexpected text after "end"`, "end stands on its own line");
          }
          if (blocks.length) {
            blocks.pop();
            raw.push({ t: "close", line: ln });
          } else if (box !== undefined) box = undefined;
          else err(ln, col0, '"end" without a block to close', "Remove it, or add the loop, alt, opt, par, critical, break, rect or box it closes");
          continue;
        case "box": {
          if (box !== undefined) err(ln, col0, "A box cannot be inside another box", 'Close the first box with "end"');
          let r = rest.trim();
          let color: string | undefined;
          const cm = /^((?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8}\b|[A-Za-z]+)\s*/.exec(r);
          if (cm && (cm[1].startsWith("#") || cm[1].includes("(") || CSS_COLORS.has(cm[1].toLowerCase()))) {
            color = safeColor(cm[1]);
            r = r.slice(cm[0].length);
          }
          sd.boxes.push({ label: unquote(r), color: color === "transparent" ? undefined : color, members: [] });
          box = sd.boxes.length - 1;
          boxLine = ln;
          continue;
        }
        case "autonumber": {
          const a = rest.trim();
          if (/^off$/i.test(a)) autonumber = undefined;
          else {
            const m = /^(\d+)?\s*(\d+)?$/.exec(a);
            if (!m) {
              err(ln, restCol, `autonumber takes a start and a step, found "${a}"`, "For example: autonumber, autonumber 10 5, or autonumber off");
              autonumber = { next: 1, step: 1 };
            } else autonumber = { next: m[1] ? Number(m[1]) : 1, step: m[2] ? Number(m[2]) : 1 };
          }
          continue;
        }
        case "title":
          sd.title = rest.replace(/^:\s*/, "").trim();
          continue;
        case "acctitle":
        case "accdescr":
        case "link":
        case "links":
        case "properties":
        case "details":
          // Accessibility text and participant menus: nothing to draw.
          continue;
        default:
          break;
      }
    }

    // A message.
    const found = findArrow(text);
    if (!found) {
      const near = word ? closest(word, KEYWORDS) : undefined;
      if (near) err(ln, col0, `Unknown statement "${word}"`, `Did you mean "${near}"?`, { old: word, new: near });
      else if (/[=~]>|->{3,}/.test(text)) err(ln, col0, `Cannot read the arrow in "${text.slice(0, 40)}"`, "Arrows are -> --> ->> -->> -x --x -) --) and <<->>; write A->>B: text");
      else err(ln, col0, `Cannot read "${text.slice(0, 40)}"`, "Messages are written A->>B: text; other lines start with participant, actor, Note, loop, alt, opt, par, rect, activate or end");
      continue;
    }
    const from = text.slice(0, found.at).trim();
    const after = text.slice(found.at + found.tok.length);
    const afterCol = col0 + found.at + found.tok.length;
    const m = /^(\s*)([+-]?)(\s*)([^:]*?)\s*(?::(.*))?$/s.exec(after)!;
    let to = m[4];
    let msgText = m[5] ?? "";
    const toCol = afterCol + m[1].length + m[2].length + m[3].length;
    if (!to) {
      err(ln, afterCol, "The message has no participant after the arrow", "Write it like this: Alice->>Bob: Hello");
      continue;
    }
    if (m[5] === undefined && /\s/.test(to)) {
      // "A->>B hello": most likely a forgotten colon.
      const sp = to.search(/\s/);
      err(ln, toCol + sp, "Expected a colon before the message text", "Write it like this: Alice->>Bob: Hello", { old: " ", new: ": " });
      msgText = to.slice(sp + 1).trim();
      to = to.slice(0, sp);
    }
    if (/^[<>\-]/.test(to)) {
      err(ln, toCol, `Cannot read the arrow in "${text.slice(0, 40)}"`, "Arrows are -> --> ->> -->> -x --x -) --) and <<->>");
      continue;
    }
    const num = autonumber ? autonumber.next : undefined;
    if (autonumber) autonumber.next += autonumber.step;
    raw.push({ t: "msg", from: unquote(from), to: unquote(to), fromCol: col0, toCol, text: msgText.trim(), arrow: found.arrow, activate: m[2] === "+", deactivate: m[2] === "-", num, line: ln });
  }
  for (const b of blocks) err(b.line, 0, `${b.kind} block is never closed`, `Add "end" after its last line`, undefined);
  if (box !== undefined) err(boxLine, 0, "box is never closed", 'Add "end" after its last participant');

  // Names to participants. A name is known when it is declared or used in a message; notes and
  // activations naming anything else are errors (most often a typo), not new participants.
  const known = new Set<string>();
  for (const e of raw) {
    if (e.t === "decl") known.add(e.id);
    else if (e.t === "msg") {
      known.add(e.from);
      known.add(e.to);
    }
  }
  const index = new Map<string, number>();
  const labels = new Map<string, number>();
  const ensure = (name: string): number => {
    let i = index.get(name);
    if (i === undefined) {
      // A name that is some participant's alias text means that participant.
      const byLabel = labels.get(name);
      if (byLabel !== undefined && !known.has(name)) return byLabel;
      i = sd.participants.length;
      sd.participants.push({ id: name, label: name, kind: "participant", created: false, destroyed: false });
      index.set(name, i);
    }
    return i;
  };
  const lookup = (name: string, line: number, col: number): number | undefined => {
    if (index.has(name) || known.has(name)) return ensure(name);
    const byLabel = labels.get(name);
    if (byLabel !== undefined) return byLabel;
    const near = closest(name, [...known]);
    errors.push({
      line,
      col,
      message: `Unknown participant "${name}"`,
      hint: near ? `Did you mean "${near}"?` : known.size ? `Participants: ${[...known].slice(0, 8).join(", ")}` : "Declare it first: participant " + name,
      ...(near ? { fix: { old: name, new: near } } : {}),
    });
    return undefined;
  };
  // Re-declared mid-diagram: Mermaid renames it; a mention before the declaration keeps its place.
  for (const e of raw) {
    switch (e.t) {
      case "decl": {
        const i = ensure(e.id);
        const p = sd.participants[i];
        p.label = e.label;
        p.kind = e.kind;
        if (e.label !== e.id) labels.set(e.label, i);
        if (e.box !== undefined && p.box === undefined) {
          p.box = e.box;
          sd.boxes[e.box].members.push(i);
        }
        if (e.create) {
          p.created = true;
          sd.events.push({ t: "create", p: i, line: e.line });
        }
        break;
      }
      case "msg": {
        const from = ensure(e.from);
        const to = ensure(e.to);
        sd.events.push({ t: "msg", from, to, text: e.text, dotted: e.arrow.dotted, start: e.arrow.start, end: e.arrow.end, activate: e.activate, deactivate: e.deactivate, num: e.num, line: e.line });
        break;
      }
      case "note": {
        const ps = e.names.map((x) => lookup(x.name, e.line, x.col));
        if (ps.some((p) => p === undefined)) break;
        sd.events.push({ t: "note", pos: e.pos, a: ps[0]!, b: ps[ps.length - 1]!, text: e.text, line: e.line });
        break;
      }
      case "activate": {
        const p = lookup(e.name, e.line, e.col);
        if (p !== undefined) sd.events.push({ t: "activate", p, on: e.on, line: e.line });
        break;
      }
      case "destroy": {
        const p = lookup(e.name, e.line, e.col);
        if (p !== undefined) {
          sd.participants[p].destroyed = true;
          sd.events.push({ t: "destroy", p, line: e.line });
        }
        break;
      }
      default:
        sd.events.push(e);
    }
  }
  // Names are checked after reading every line; report in source order all the same.
  const mine = errors.splice(firstError).sort((a, b) => a.line - b.line || a.col - b.col);
  errors.push(...mine);
  return sd;
}

// ---------------------------------------------------------------- layout

const GAP = 40; // between participant boxes
const LABEL_PAD = 16; // either side of a message label
const BAR_W = 10;
const BAR_STEP = 6;
const LOOP_W = 34;
const LOOP_H = 20;
const NOTE_GAP = 12; // between a lifeline and a note beside it
const NOTE_EXT = 16; // how far a note over two participants reaches past them
const FRAME_PAD = 12;
const FRAME_STEP = 9;
const TAG_H = 20;
const BOX_PAD = 12;
const M = 8;

interface Frame {
  kind: BlockKind;
  label?: Label;
  color?: string;
  top: number;
  bottom: number;
  sections: { y: number; label?: Label }[];
  lo: number;
  hi: number;
  depth: number;
  minLeft: number;
  maxRight: number;
  left: number;
  right: number;
  tagW: number;
  tag?: Label;
}

export function renderSequence(src: string, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const sd = parseSequence(src, ctx.errors);
  if (sd.title && !ctx.title) ctx.title = sd.title;
  const title = sd.title ?? ctx.title;
  const P = sd.participants.length;
  const f = t.fontSize;
  const msgSize = f - 1;
  const lw = t.lineWidth;
  const bg = t.background === "transparent" ? "#ffffff" : t.background;

  // ---- participant sizes
  const pLabels = sd.participants.map((p) => layoutLabel(p.label, f, 16 * f));
  const pw: number[] = [];
  const ph: number[] = [];
  sd.participants.forEach((p, i) => {
    const l = pLabels[i];
    if (p.kind === "actor") {
      pw.push(Math.max(l.width + 10, 44));
      ph.push(38 + 4 + l.height);
    } else {
      pw.push(Math.max(l.width + 28, 76));
      ph.push(Math.max(l.height + 22, 38) + (p.kind === "database" ? 12 : 0));
    }
  });
  const band = Math.max(0, ...ph);

  // ---- labels of events, and the horizontal constraints they make
  const evLabels = new Map<number, Label>();
  /** Required centre distance for pairs i<j, keyed i*P+j. */
  const need = new Map<number, number>();
  const require = (i: number, j: number, d: number) => {
    if (i < 0 || j >= P || i >= j) return;
    const k = i * P + j;
    if ((need.get(k) ?? 0) < d) need.set(k, d);
  };
  for (let i = 0; i + 1 < P; i++) {
    let d = (pw[i] + pw[i + 1]) / 2 + GAP;
    const bi = sd.participants[i].box;
    const bj = sd.participants[i + 1].box;
    if (bi !== bj) d += (bi !== undefined ? BOX_PAD : 0) + (bj !== undefined ? BOX_PAD : 0) + (bi !== undefined && bj !== undefined ? 6 : 0);
    require(i, i + 1, d);
  }
  const boxLabels = sd.boxes.map((b) => layoutLabel(b.label, f - 1, 24 * f));
  sd.boxes.forEach((b, k) => {
    if (b.members.length < 1) return;
    const lo = Math.min(...b.members);
    const hi = Math.max(...b.members);
    if (lo < hi) require(lo, hi, boxLabels[k].width + 20 - 2 * BOX_PAD - (pw[lo] + pw[hi]) / 2);
  });
  sd.events.forEach((e, k) => {
    if (e.t === "msg") {
      const lab = layoutLabel(e.text, msgSize, 22 * f);
      evLabels.set(k, lab);
      const numPad = e.num !== undefined ? 10 : 0;
      if (e.from === e.to) require(e.from, e.from + 1, Math.max(LOOP_W + 8, lab.width + 12) + 16 + numPad);
      else require(Math.min(e.from, e.to), Math.max(e.from, e.to), lab.width + 2 * LABEL_PAD + numPad + (sd.participants[e.to].created ? pw[e.to] / 2 : 0));
    } else if (e.t === "note") {
      const two = e.pos === "over" && e.a !== e.b;
      const lab = layoutLabel(e.text, msgSize, (two ? 22 : 16) * f);
      evLabels.set(k, lab);
      const w = lab.width + 20;
      if (e.pos === "right") require(e.a, e.a + 1, w + 2 * NOTE_GAP + 4);
      else if (e.pos === "left") require(e.a - 1, e.a, w + 2 * NOTE_GAP + 4);
      else if (!two) {
        require(e.a - 1, e.a, w / 2 + 14);
        require(e.a, e.a + 1, w / 2 + 14);
      } else require(Math.min(e.a, e.b), Math.max(e.a, e.b), w - 2 * NOTE_EXT);
    } else if (e.t === "open" && e.label) {
      evLabels.set(k, layoutLabel(`[${e.label}]`, f - 2, 24 * f));
    } else if (e.t === "sep" && e.label) {
      evLabels.set(k, layoutLabel(`[${e.label}]`, f - 2, 24 * f));
    }
  });

  // ---- solve the gaps: shortest spans first, spreading any shortfall evenly over the gaps a span covers
  const gaps = new Array<number>(Math.max(0, P - 1)).fill(0);
  const cons = [...need.entries()].map(([k, d]) => ({ i: Math.floor(k / P), j: k % P, d })).sort((a, b) => a.j - a.i - (b.j - b.i));
  for (const c of cons) {
    let have = 0;
    for (let g = c.i; g < c.j; g++) have += gaps[g];
    if (have < c.d) {
      const add = (c.d - have) / (c.j - c.i);
      for (let g = c.i; g < c.j; g++) gaps[g] += add;
    }
  }
  const x: number[] = [];
  for (let i = 0; i < P; i++) x.push(i === 0 ? 0 : x[i - 1] + gaps[i - 1]);

  // ---- bounds of everything drawn
  let minX = Infinity;
  let maxX = -Infinity;
  const extend = (lo: number, hi: number) => {
    if (lo < minX) minX = lo;
    if (hi > maxX) maxX = hi;
  };
  for (let i = 0; i < P; i++) extend(x[i] - pw[i] / 2, x[i] + pw[i] / 2);

  // ---- vertical pass
  const titleLab = title ? layoutLabel(`<b>${esc(title)}</b>`, f + 1, Infinity) : undefined;
  const hasBoxes = sd.boxes.some((b) => b.members.length);
  const boxLabelH = hasBoxes ? Math.max(0, ...boxLabels.map((l) => l.height)) : 0;
  let y = 0;
  const titleY = titleLab ? titleLab.height / 2 : 0;
  if (titleLab) y += titleLab.height + 12;
  const boxTop = y;
  if (hasBoxes) y += boxLabelH + 12;
  const bandTop = y;
  const lifeTop = bandTop + band;
  let cursor = lifeTop + 4;

  const out = {
    rects: [] as string[],
    frames: [] as string[],
    bars: [] as string[],
    msgs: [] as string[],
    labels: [] as string[],
    notes: [] as string[],
    tops: [] as string[],
  };

  const active: number[][] = Array.from({ length: P }, () => []);
  const lifeStart = sd.participants.map((p) => (p.created ? NaN : lifeTop));
  const lifeEnd: number[] = new Array(P).fill(NaN);
  const pendingCreate = new Set<number>();
  const pendingDestroy = new Set<number>();
  const createdAt = new Map<number, number>();
  const frames: Frame[] = [];
  const allFrames: Frame[] = [];
  let lastMsgY: number | undefined;
  let afterMsg = false;

  const touch = (lo: number, hi: number) => {
    for (const fr of frames) {
      if (lo < fr.lo) fr.lo = lo;
      if (hi > fr.hi) fr.hi = hi;
    }
  };
  const barCenter = (p: number, depth: number) => x[p] + depth * BAR_STEP;
  /** Where a message meets participant p's lifeline or its innermost bar, from side `side` (-1 left, +1 right). */
  const edge = (p: number, side: number) => {
    const s = active[p];
    if (!s.length) return x[p];
    return barCenter(p, s.length - 1) + (side * BAR_W) / 2;
  };
  const startBar = (p: number, at: number) => active[p].push(at);
  const endBar = (p: number, at: number) => {
    const s = active[p];
    if (!s.length) return false;
    const depth = s.length - 1;
    const y0 = s.pop()!;
    const y1 = Math.max(at, y0 + 14);
    const cx = barCenter(p, depth);
    out.bars.push(`<rect x="${n(cx - BAR_W / 2)}" y="${n(y0)}" width="${BAR_W}" height="${n(y1 - y0)}" fill="${t.clusterFill}" stroke="${t.nodeStroke}" stroke-width="1"/>`);
    touch(cx - BAR_W / 2 - 4, cx + BAR_W / 2 + 4);
    if (y1 + 6 > cursor) cursor = y1 + 6;
    return true;
  };
  const numberSvg = (num: number, cx: number, cy: number): string => {
    const s = String(num);
    const r = Math.max(8, 3.2 + s.length * 3.1);
    const lab = layoutLabel(`<b>${s}</b>`, f - 4);
    return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${t.nodeStroke}"/>` + labelSvg(lab, cx, cy + 0.3, "#ffffff");
  };
  const lineSvg = (x1: number, x2: number, yy: number, dotted: boolean): string =>
    `<path d="M${n(x1)} ${n(yy)}H${n(x2)}" fill="none" stroke="${t.line}" stroke-width="${n(lw)}"${dotted ? ` stroke-dasharray="${n(lw * 3)} ${n(lw * 2.4)}"` : ""}/>`;
  const labelBg = (lab: Label, cx: number, cy: number, align: "middle" | "start") => {
    const x0 = align === "middle" ? cx - lab.width / 2 : cx;
    return `<rect x="${n(x0 - 3)}" y="${n(cy - lab.height / 2)}" width="${n(lab.width + 6)}" height="${n(lab.height)}" rx="2" fill="${t.edgeLabelBg}" fill-opacity="0.9"/>`;
  };
  const crossesLifeline = (lo: number, hi: number, except: number[]) => x.some((xx, i) => !except.includes(i) && xx > lo && xx < hi);

  sd.events.forEach((e, k) => {
    switch (e.t) {
      case "create":
        pendingCreate.add(e.p);
        break;
      case "destroy":
        pendingDestroy.add(e.p);
        break;
      case "activate": {
        if (e.on) startBar(e.p, afterMsg && lastMsgY !== undefined ? lastMsgY : cursor + 2);
        else if (!endBar(e.p, lastMsgY !== undefined && lastMsgY > (active[e.p][active[e.p].length - 1] ?? Infinity) ? lastMsgY : cursor)) {
          ctx.errors.push({ line: e.line, col: 0, message: `deactivate ${sd.participants[e.p].id}, which is not active`, hint: "Remove it, or activate the participant first" });
        }
        break;
      }
      case "msg": {
        let lab = evLabels.get(k)!;
        // A label wrapped for the narrowest gap is unwrapped again when its message turned out to span more room.
        const span = Math.abs(x[e.to] - x[e.from]) - 2 * LABEL_PAD - (e.num !== undefined ? 10 : 0);
        if (lab.lines.length > 1 && span > 22 * f) lab = layoutLabel(e.text, msgSize, span);
        const top = cursor;
        let yy = top + 12 + (lab.height ? lab.height + 5 : 6);
        const createTo = pendingCreate.has(e.to) && e.from !== e.to ? e.to : undefined;
        if (createTo !== undefined) yy = Math.max(yy, top + ph[createTo] / 2 + 8);
        if (e.from === e.to) {
          const p = e.from;
          const x0 = edge(p, 1);
          if (e.activate) startBar(p, yy + LOOP_H - 4);
          const xe = edge(p, 1);
          const y2 = yy + LOOP_H;
          const r = 7;
          const xr = x0 + LOOP_W;
          const inset = Math.max(0, endInset(e.end, lw) - lw * 0.5);
          out.msgs.push(
            `<path d="M${n(x0)} ${n(yy)}H${n(xr - r)}Q${n(xr)} ${n(yy)} ${n(xr)} ${n(yy + r)}V${n(y2 - r)}Q${n(xr)} ${n(y2)} ${n(xr - r)} ${n(y2)}H${n(xe + inset)}" fill="none" stroke="${t.line}" stroke-width="${n(lw)}"${e.dotted ? ` stroke-dasharray="${n(lw * 3)} ${n(lw * 2.4)}"` : ""}/>`,
          );
          if (e.end !== "none") out.msgs.push(endSvg(e.end, [xe, y2], [xe + 10, y2], t.line, Math.max(1, lw * 0.9), bg));
          if (e.start !== "none") out.msgs.push(endSvg(e.start, [x0, yy], [x0 + 10, yy], t.line, Math.max(1, lw * 0.9), bg));
          const lx = x0 + 6 + (e.num !== undefined ? 8 : 0);
          if (lab.height) out.labels.push(labelSvg(lab, lx, yy - 5 - lab.height / 2, t.text, { align: "start" }));
          if (e.num !== undefined) out.labels.push(numberSvg(e.num, x0, yy));
          touch(x[p] - 8, Math.max(xr + 4, lx + lab.width + 4));
          extend(x[p], Math.max(xr + 4, lx + lab.width + 4));
          if (e.deactivate) endBar(p, y2);
          lastMsgY = y2;
          cursor = Math.max(cursor, y2 + 12);
        } else {
          const dir = x[e.to] > x[e.from] ? 1 : -1;
          if (e.activate) startBar(e.to, yy);
          const x1 = edge(e.from, dir);
          let x2 = edge(e.to, -dir);
          if (createTo !== undefined) {
            const half = sd.participants[createTo].kind === "actor" ? 16 : pw[createTo] / 2;
            x2 = x[createTo] - dir * half;
          }
          const ins = (k2: EndKind) => Math.max(0, endInset(k2, lw) - lw * 0.5);
          out.msgs.push(lineSvg(x1 + dir * ins(e.start), x2 - dir * ins(e.end), yy, e.dotted));
          if (e.end !== "none") out.msgs.push(endSvg(e.end, [x2, yy], [x2 - dir * 10, yy], t.line, Math.max(1, lw * 0.9), bg));
          if (e.start !== "none") out.msgs.push(endSvg(e.start, [x1, yy], [x1 + dir * 10, yy], t.line, Math.max(1, lw * 0.9), bg));
          if (lab.height) {
            const cx = (x1 + x2) / 2 + (e.num !== undefined ? (dir * 8) / 2 : 0);
            const cy = yy - 5 - lab.height / 2;
            if (crossesLifeline(cx - lab.width / 2, cx + lab.width / 2, [e.from, e.to])) out.labels.push(labelBg(lab, cx, cy, "middle"));
            out.labels.push(labelSvg(lab, cx, cy, t.text));
            extend(cx - lab.width / 2, cx + lab.width / 2);
          }
          if (e.num !== undefined) out.labels.push(numberSvg(e.num, x1, yy));
          touch(Math.min(x[e.from], x[e.to]) - 4, Math.max(x[e.from], x[e.to]) + 4);
          if (createTo !== undefined) {
            pendingCreate.delete(createTo);
            createdAt.set(createTo, yy);
            lifeStart[createTo] = yy + ph[createTo] / 2;
            touch(x[createTo] - pw[createTo] / 2, x[createTo] + pw[createTo] / 2);
            cursor = Math.max(cursor, yy + ph[createTo] / 2 + 6);
          }
          if (e.deactivate) endBar(e.from, yy);
          lastMsgY = yy;
          cursor = Math.max(cursor, yy + 11);
        }
        for (const p of [e.from, e.to]) {
          if (pendingDestroy.has(p)) {
            pendingDestroy.delete(p);
            while (active[p].length) endBar(p, lastMsgY);
            // The lifeline ends in a cross just below the message, clear of the arrowhead.
            const c = 6;
            const cy = lastMsgY + 13;
            lifeEnd[p] = cy;
            out.msgs.push(`<path d="M${n(x[p] - c)} ${n(cy - c)}L${n(x[p] + c)} ${n(cy + c)}M${n(x[p] - c)} ${n(cy + c)}L${n(x[p] + c)} ${n(cy - c)}" stroke="${t.nodeStroke}" stroke-width="2" stroke-linecap="round"/>`);
            cursor = Math.max(cursor, cy + c + 4);
          }
        }
        afterMsg = true;
        break;
      }
      case "note": {
        let lab = evLabels.get(k)!;
        const room = Math.abs(x[e.a] - x[e.b]) + 2 * NOTE_EXT - 20;
        if (e.pos === "over" && lab.lines.length > 1 && room > 22 * f) lab = layoutLabel(e.text, msgSize, room);
        const top = cursor + 8;
        const h = Math.max(lab.height + 14, 28);
        const w = lab.width + 20;
        let left: number;
        let right: number;
        if (e.pos === "right") {
          left = Math.max(x[e.a] + NOTE_GAP, edge(e.a, 1) + 6);
          right = left + w;
        } else if (e.pos === "left") {
          right = Math.min(x[e.a] - NOTE_GAP, edge(e.a, -1) - 6);
          left = right - w;
        } else {
          const lo = Math.min(x[e.a], x[e.b]);
          const hi = Math.max(x[e.a], x[e.b]);
          const ext = e.a === e.b ? 0 : NOTE_EXT;
          left = lo - ext;
          right = hi + ext;
          if (right - left < w) {
            const c = (lo + hi) / 2;
            left = c - w / 2;
            right = c + w / 2;
          }
        }
        const cx = (left + right) / 2;
        out.notes.push(shapeSvg("note", cx, top + h / 2, right - left, h, { fill: t.noteFill, stroke: t.noteStroke, strokeWidth: 1, radius: 0, shadow: t.shadow }));
        out.notes.push(labelSvg(lab, cx, top + h / 2, t.text));
        touch(left, right);
        extend(left, right);
        cursor = top + h + 4;
        afterMsg = false;
        break;
      }
      case "open": {
        const top = cursor + (e.kind === "rect" ? 6 : 8);
        const lab = evLabels.get(k);
        const tag = e.kind === "rect" ? undefined : layoutLabel(`<b>${e.kind}</b>`, f - 3);
        const tagW = tag ? tag.width + 18 : 0;
        const fr: Frame = {
          kind: e.kind,
          label: lab,
          color: e.color,
          top,
          bottom: top,
          sections: [],
          lo: Infinity,
          hi: -Infinity,
          depth: 0,
          minLeft: Infinity,
          maxRight: -Infinity,
          left: 0,
          right: 0,
          tagW,
          tag,
        };
        frames.push(fr);
        allFrames.push(fr);
        cursor = e.kind === "rect" ? top + 2 : top + Math.max(TAG_H, (lab?.height ?? 0) + 6);
        afterMsg = false;
        break;
      }
      case "sep": {
        const fr = frames[frames.length - 1];
        if (!fr) break;
        const lab = evLabels.get(k);
        const sy = cursor + 8;
        fr.sections.push({ y: sy, label: lab });
        cursor = sy + (lab ? lab.height + 6 : 4);
        afterMsg = false;
        break;
      }
      case "close": {
        const fr = frames.pop();
        if (fr) closeFrame(fr);
        afterMsg = false;
        break;
      }
    }
  });
  function closeFrame(fr: Frame) {
    cursor += fr.kind === "rect" ? 6 : 10;
    fr.bottom = cursor;
    if (fr.lo === Infinity) {
      fr.lo = P ? x[0] : 0;
      fr.hi = P ? x[P - 1] : 100;
    }
    const pad = FRAME_PAD + fr.depth * FRAME_STEP;
    fr.left = Math.min(fr.lo - pad, fr.minLeft);
    fr.right = Math.max(fr.hi + pad, fr.maxRight);
    const head = Math.max(fr.label?.width ?? 0, ...fr.sections.map((s) => s.label?.width ?? 0));
    fr.right = Math.max(fr.right, fr.left + fr.tagW + (head ? head + 18 : 6));
    const parent = frames[frames.length - 1];
    if (parent) {
      parent.depth = Math.max(parent.depth, fr.depth + 1);
      parent.minLeft = Math.min(parent.minLeft, fr.left - FRAME_STEP);
      parent.maxRight = Math.max(parent.maxRight, fr.right + FRAME_STEP);
      if (fr.lo < parent.lo) parent.lo = fr.lo;
      if (fr.hi > parent.hi) parent.hi = fr.hi;
    }
    extend(fr.left, fr.right);
  }
  // Blocks left open (already reported) close at the end.
  while (frames.length) closeFrame(frames.pop()!);
  // Activations left open end at the last message, or just below it.
  for (let p = 0; p < P; p++) while (active[p].length) endBar(p, Math.max(lastMsgY ?? cursor, active[p][active[p].length - 1] + 14));

  // ---- frames, drawn now that their extents are known
  for (const fr of allFrames) {
    const w = fr.right - fr.left;
    const h = fr.bottom - fr.top;
    if (fr.kind === "rect") {
      out.rects.push(`<rect x="${n(fr.left)}" y="${n(fr.top)}" width="${n(w)}" height="${n(h)}" rx="4" fill="${fr.color ?? t.clusterFill}"/>`);
      continue;
    }
    const L = fr.left;
    const T = fr.top;
    const parts: string[] = [];
    parts.push(`<rect x="${n(L)}" y="${n(T)}" width="${n(w)}" height="${n(h)}" rx="3" fill="none" stroke="${t.clusterStroke}" stroke-width="1"/>`);
    const tw = fr.tagW;
    parts.push(`<path d="M${n(L)} ${n(T)}H${n(L + tw)}V${n(T + TAG_H - 6)}L${n(L + tw - 6)} ${n(T + TAG_H)}H${n(L)}Z" fill="${t.clusterFill}" stroke="${t.clusterStroke}" stroke-width="1" stroke-linejoin="round"/>`);
    if (fr.tag) parts.push(labelSvg(fr.tag, L + (tw - 3) / 2, T + TAG_H / 2, t.clusterText));
    const cx = L + tw + 8;
    if (fr.label) {
      const head = Math.max(TAG_H, fr.label.height + 6);
      const cy = T + head / 2;
      if (crossesLifeline(cx, cx + fr.label.width, [])) parts.push(labelBg(fr.label, cx, cy, "start"));
      parts.push(labelSvg(fr.label, cx, cy, t.mutedText, { align: "start" }));
    }
    for (const s of fr.sections) {
      parts.push(`<path d="M${n(L)} ${n(s.y)}H${n(L + w)}" stroke="${t.clusterStroke}" stroke-width="1" stroke-dasharray="5 4"/>`);
      if (s.label) {
        const cy = s.y + 3 + s.label.height / 2;
        if (crossesLifeline(cx, cx + s.label.width, [])) parts.push(labelBg(s.label, cx, cy, "start"));
        parts.push(labelSvg(s.label, cx, cy, t.mutedText, { align: "start" }));
      }
    }
    out.frames.push(parts.join(""));
  }

  // ---- participants, lifelines, boxes
  cursor += 14;
  const bottomTop = cursor;
  const bottom = bottomTop + band;
  const drawParticipant = (i: number, cy: number, top: number): string => {
    const p = sd.participants[i];
    const l = pLabels[i];
    const cx = x[i];
    if (p.kind === "actor") {
      const s = t.nodeStroke;
      const sw = 1.5;
      const hy = top + 8;
      return (
        `<g fill="none" stroke="${s}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">` +
        `<circle cx="${n(cx)}" cy="${n(hy)}" r="7" fill="${t.nodeFill}"/>` +
        `<path d="M${n(cx)} ${n(hy + 7)}V${n(top + 28)}M${n(cx - 11)} ${n(top + 19)}H${n(cx + 11)}M${n(cx - 9)} ${n(top + 38)}L${n(cx)} ${n(top + 28)}L${n(cx + 9)} ${n(top + 38)}"/></g>` +
        labelSvg(l, cx, top + 42 + l.height / 2, t.text)
      );
    }
    const w = pw[i];
    const h = ph[i];
    const style = { fill: t.nodeFill, stroke: t.nodeStroke, strokeWidth: 1.3, radius: t.radius };
    let s = "";
    if (p.kind === "database") s += shapeSvg("cylinder", cx, cy, w, h, { ...style, shadow: t.shadow });
    else if (p.kind === "queue") s += shapeSvg("stadium", cx, cy, w, h, { ...style, shadow: t.shadow });
    else if (p.kind === "collections") {
      s += shadowSvg("rect", cx + 4, cy - 4, w, h, t.radius, t.shadow) + shapeSvg("rect", cx + 4, cy - 4, w, h, style) + shapeSvg("rect", cx, cy, w, h, style);
    } else s += shapeSvg("rect", cx, cy, w, h, { ...style, shadow: t.shadow });
    return s + labelSvg(l, cx, cy + (p.kind === "database" ? 5 : 0), t.text);
  };
  const lifelines: string[] = [];
  for (let i = 0; i < P; i++) {
    const p = sd.participants[i];
    // Everything in the top row stands on the line where lifelines begin; the bottom row hangs from its top.
    if (createdAt.has(i)) {
      const cy = createdAt.get(i)!;
      out.tops.push(drawParticipant(i, cy, cy - ph[i] / 2));
    } else {
      if (p.created) lifeStart[i] = lifeTop;
      out.tops.push(drawParticipant(i, lifeTop - ph[i] / 2, lifeTop - ph[i]));
    }
    const end = Number.isNaN(lifeEnd[i]) ? bottomTop : lifeEnd[i];
    lifelines.push(`<path d="M${n(x[i])} ${n(lifeStart[i])}V${n(end)}" stroke="${t.clusterStroke}" stroke-width="1" stroke-dasharray="4 3"/>`);
    if (!p.destroyed) out.tops.push(drawParticipant(i, bottomTop + ph[i] / 2, bottomTop));
  }
  const groups: string[] = [];
  let height = P ? bottom : cursor;
  sd.boxes.forEach((b, k) => {
    if (!b.members.length) return;
    const lo = Math.min(...b.members.map((i) => x[i] - pw[i] / 2)) - BOX_PAD;
    const hi = Math.max(...b.members.map((i) => x[i] + pw[i] / 2)) + BOX_PAD;
    const top = boxTop;
    const bot = bottom + 10;
    height = Math.max(height, bot);
    const fill = b.color ?? t.clusterFill;
    // Named colours (Aqua, Pink ...) are loud at full strength; they are softened. rgb() and hex values are used as given.
    const soft = b.color && /^[a-z]+$/i.test(b.color) ? ' fill-opacity="0.15"' : "";
    groups.push(`<rect x="${n(lo)}" y="${n(top)}" width="${n(hi - lo)}" height="${n(bot - top)}" rx="${n(t.radius + 2)}" fill="${fill}"${soft} stroke="${t.clusterStroke}" stroke-width="1"/>`);
    if (b.label) groups.push(labelSvg(boxLabels[k], (lo + hi) / 2, top + 6 + boxLabels[k].height / 2, t.clusterText, { weight: "bold" }));
    extend(lo, hi);
  });
  const titleSvg: string[] = [];
  if (titleLab) {
    const cx = P ? (x[0] - pw[0] / 2 + x[P - 1] + pw[P - 1] / 2) / 2 : titleLab.width / 2;
    titleSvg.push(labelSvg(titleLab, cx, titleY, t.text));
    extend(cx - titleLab.width / 2, cx + titleLab.width / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }

  const body = [...groups, ...out.rects, ...lifelines, ...out.frames, ...out.bars, ...out.msgs, ...out.notes, ...out.tops, ...out.labels, ...titleSvg].join("");
  const width = maxX - minX + 2 * M;
  const totalH = height + 2 * M;
  const svg = svgDocument(width, totalH, `<g transform="translate(${n(M - minX)} ${M})">${body}</g>`, t, ctx.title);
  return { svg, width: Math.ceil(width), height: Math.ceil(totalH) };
}
