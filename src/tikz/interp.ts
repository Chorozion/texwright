/**
 * The TikZ interpreter: runs the statements of a picture (\draw, \node,
 * \foreach, scopes, styles, ...) against a graphic state and records what
 * they draw in a Scene. Paths are built in TeX points (y up) after the
 * picture's transformations; nodes are laid out with their text typeset by
 * the math engine, registered by name, and drawn on top of their path.
 *
 * Nothing here throws to the caller: problems become messages with an
 * offset into the picture's source, and work is capped (statements, loop
 * iterations, plot samples, time) so hostile input stays fast.
 */

import { type ArrowSpec, type Tip, parseTip, placeTip, tipShape } from "./arrows.js";
import { type RGB, colorFromModel, parseColor } from "./color.js";
import { ExprError, evaluate, fmt, length, num } from "./expr.js";
import {
  type Pt,
  type Seg,
  add,
  angleOf,
  apply,
  applyLinear,
  arcCubics,
  bez,
  bezTangent,
  dir,
  dist,
  invert,
  lerp,
  lineIntersection,
  rotation,
  scale,
  smoothThrough,
  sub,
  unit,
} from "./geom.js";
import { DIRECTIONS, type OptionHost, applyOptions, dashPattern, expandList } from "./options.js";
import { Scanner, matchClose, parseOptions, splitTop, stripComments, unbrace } from "./scan.js";
import { type Box, type PaintStyle, Scene, boxOK, emptyBox, growBox, segsBox } from "./scene.js";
import { CM, type GS, type LabelSpec, cloneGS, initialState, nodeGS } from "./state.js";
import { tdplotCommand } from "./tdplot.js";
import type { Bipole, CircuitHooks } from "./circuit.js";
import { type TextBlock, blankText, layoutText, textSvg } from "./text.js";

export interface Message {
  severity: "warning" | "error";
  message: string;
  /** Offset into the picture's source. */
  offset: number;
  hint?: string;
}

export interface InterpOptions {
  /** Math macros of the document (\name -> body), for node text and coordinates. */
  macros?: Record<string, string>;
  /** Colours the document defined. */
  color?: (name: string) => string | undefined;
  /** Reads a data file for \addplot table (relative to the document). */
  readFile?: (path: string) => string | undefined;
  /** Node font size in pt (10, TikZ's default). */
  fontSize?: number;
  /** Time budget in ms. */
  budgetMs?: number;
}

export class Stop extends Error {}

interface Macro {
  nargs: number;
  body: string;
}

export interface NodeInfo {
  name: string;
  center: Pt;
  shape: string;
  /** Half extents of the shape, outer sep included. */
  hw: number;
  hh: number;
  rot: number;
  /** Distance from the centre down to the text's baseline. */
  baseDy: number;
  sides?: number;
  /** Named anchors of circuitikz shapes, as offsets from the centre. */
  anchors?: Map<string, Pt>;
}

interface Coord {
  p: Pt;
  node?: NodeInfo;
}

/** Where a node on a path goes: a segment (with pos) or a point. */
interface SegGeom {
  kind: "line" | "curve" | "hv" | "point";
  pts: Pt[];
}

export interface PendingNode {
  text: string;
  g: GS;
  name?: string;
  at?: Coord;
  off: number;
  /** Placed on the segment that follows (`-- node {x} (b)`). */
  onNext: boolean;
}

const COMPASS: Record<string, Pt> = {
  north: [0, 1],
  south: [0, -1],
  east: [1, 0],
  west: [-1, 0],
  "north east": [1, 1],
  "north west": [-1, 1],
  "south east": [1, -1],
  "south west": [-1, -1],
};

const PLACE_ANCHOR: Record<string, string> = {
  above: "south",
  below: "north",
  left: "east",
  right: "west",
  "above left": "south east",
  "above right": "south west",
  "below left": "north east",
  "below right": "north west",
};

const PLACE_REF: Record<string, string> = {
  above: "north",
  below: "south",
  left: "west",
  right: "east",
  "above left": "north west",
  "above right": "north east",
  "below left": "south west",
  "below right": "south east",
};

const LIMITS = {
  /** Statements and path operations over the whole picture. */
  ops: 100_000,
  /** \foreach iterations over the whole picture. */
  iterations: 20_000,
  /** Nodes. */
  nodes: 5_000,
  /** Size of text after macro expansion. */
  text: 2_000_000,
  /** Nesting of scopes, loops and styles. */
  depth: 40,
};

export class Interp implements OptionHost {
  readonly scene: Scene;
  readonly messages: Message[] = [];
  readonly nodes = new Map<string, NodeInfo>();
  readonly colors = new Map<string, RGB>();
  readonly lookup?: (name: string) => string | undefined;
  readonly macros = new Map<string, Macro>();
  readonly mathMacros: Record<string, string>;
  private warned = new Set<string>();
  private ops = 0;
  private iterations = 0;
  private depth = 0;
  private readonly deadline: number;
  /** Offset of the statement being run, for messages. */
  off = 0;
  /** What drew something: counted to tell an empty picture from a broken one. */
  drawn = 0;
  readonly opts: InterpOptions;
  /** pgfplots, attached by index.ts to avoid a cycle. */
  axisHandler?: (it: Interp, env: string, opts: string, body: string, g: GS, off: number) => void;
  /** circuitikz (circuit.ts), attached by index.ts like axisHandler. */
  circuit?: CircuitHooks;
  /** \pgfplotsset options, applied to every axis. */
  pgfplotsDefaults: string[] = [];
  /** Tables read with \pgfplotstableread, by macro name. */
  tables = new Map<string, string>();
  /** A \clip just made: the scope running the statement adds it to its state. */
  pendingClip?: string;
  /** Option keys handled outside options.ts (trees, mind maps, graphs, circuitikz), attached by index.ts. */
  extra?: OptionHost["extra"];
  /** Trees: draws the `child` operations that follow a node (or the current point), attached by index.ts. */
  treeHandler?: (it: Interp, root: { pn?: PendingNode; where?: { point: Pt } }, sc: Scanner, g: GS) => void;
  /** \graph of the graphs library, attached by index.ts. */
  graphHandler?: (it: Interp, stmt: string, g: GS) => void;

  constructor(opts: InterpOptions, prefix: string) {
    this.opts = opts;
    this.scene = new Scene(prefix);
    this.lookup = opts.color;
    this.mathMacros = { ...(opts.macros ?? {}) };
    this.deadline = Date.now() + (opts.budgetMs ?? 800);
    for (const [name, body] of Object.entries(opts.macros ?? {})) {
      const n = name.replace(/^\\/, "");
      const nargs = Math.max(0, ...[...body.matchAll(/#(\d)/g)].map((m) => Number(m[1])));
      this.macros.set(n, { nargs, body });
    }
  }

  // ------------------------------------------------------------ messages

  warn(message: string, offset = this.off, hint?: string): void {
    if (this.messages.length > 200) return;
    this.messages.push({ severity: "warning", message, offset, ...(hint ? { hint } : {}) });
  }

  warnOnce(key: string, message: string, hint?: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message, this.off, hint);
  }

  unknown(key: string): void {
    this.warnOnce(`opt:${key}`, `TikZ option "${key}" is not supported and was ignored`);
  }

  tick(n = 1): void {
    this.ops += n;
    if (this.ops > LIMITS.ops) throw new Stop("the picture has too many drawing operations");
    if (this.scene.full) throw new Stop("the picture is too large to draw in full");
    if ((this.ops & 255) === 0 && Date.now() > this.deadline) throw new Stop("the picture took too long to draw");
  }

  // ------------------------------------------------------------ macros

  /** Replaces user macros (\def, \newcommand, \foreach variables) in `text`. */
  expand(text: string): string {
    if (!this.macros.size || !text.includes("\\")) return text;
    let s = text;
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      let out = "";
      let i = 0;
      while (i < s.length) {
        const k = s.indexOf("\\", i);
        if (k < 0) {
          out += s.slice(i);
          break;
        }
        out += s.slice(i, k);
        const m = /^\\([A-Za-z@]+)/.exec(s.slice(k, k + 80));
        if (!m) {
          out += s.slice(k, k + 2);
          i = k + 2;
          continue;
        }
        const def = this.macros.get(m[1]);
        if (!def) {
          out += m[0];
          i = k + m[0].length;
          continue;
        }
        let j = k + m[0].length;
        let body = def.body;
        for (let a = 1; a <= def.nargs; a++) {
          while (j < s.length && /\s/.test(s[j])) j++;
          let arg: string;
          if (s[j] === "{") {
            const e = matchClose(s, j);
            arg = e < 0 ? s.slice(j + 1) : s.slice(j + 1, e);
            j = e < 0 ? s.length : e + 1;
          } else {
            arg = s[j] ?? "";
            j++;
          }
          body = body.split(`#${a}`).join(arg);
        }
        // A control word eats the spaces after it; keep one when a letter would join the replacement.
        if (def.nargs === 0 && /^ +/.test(s.slice(j)) && /[A-Za-z]$/.test(body) === false) {
          // keep spacing as written
        }
        out += body;
        i = j;
        changed = true;
        if (out.length > LIMITS.text) throw new Stop("macro expansion grows too large");
      }
      s = out;
      if (!changed) break;
    }
    return s;
  }

  // ------------------------------------------------------------ statements

  /** Runs the statements in `text`; offsets in it map to `base` (exactly when `exact`). */
  run(text: string, base: number, exact: boolean, g: GS): void {
    if (++this.depth > LIMITS.depth) {
      this.depth--;
      this.warnOnce("depth", "scopes or loops nest too deeply; the inner ones were skipped");
      return;
    }
    try {
      this.runInner(text, base, exact, g);
    } finally {
      this.depth--;
    }
  }

  private runInner(text: string, base: number, exact: boolean, g: GS): void {
    const sc = new Scanner(text);
    const at = (i: number) => (exact ? base + i : base);
    while (!sc.done) {
      this.tick();
      const start = sc.i;
      this.off = at(start);
      const c = sc.s[sc.i];
      if (c === ";") {
        sc.i++;
        continue;
      }
      if (c === "{") {
        const inner = sc.group("{") ?? "";
        this.run(inner, at(start + 1), exact, cloneGS(g));
        continue;
      }
      if (c === "}") {
        sc.i++;
        continue;
      }
      if (c !== "\\") {
        // Stray text between statements: skip to the next command.
        const k = sc.s.indexOf("\\", sc.i);
        const word = sc.s.slice(sc.i, k < 0 ? sc.s.length : k).trim();
        if (word && !/^[\s;]*$/.test(word)) this.warnOnce(`stray:${word.slice(0, 20)}`, `Text "${word.slice(0, 30)}" outside a TikZ command was ignored`);
        sc.i = k < 0 ? sc.s.length : k;
        continue;
      }
      const name = sc.peekCommand() ?? "";
      sc.i += name.length + 1;
      this.command(name, sc, g, at, start);
    }
  }

  private command(name: string, sc: Scanner, g: GS, at: (i: number) => number, start: number): void {
    switch (name) {
      case "draw":
      case "fill":
      case "filldraw":
      case "path":
      case "shade":
      case "shadedraw":
      case "clip":
      case "useasboundingbox":
      case "pattern": {
        const stmt = sc.statement();
        this.path(name, this.expand(stmt), g);
        if (this.pendingClip) {
          g.clips = [...g.clips, this.pendingClip];
          this.pendingClip = undefined;
        }
        return;
      }
      case "node":
      case "coordinate": {
        const stmt = sc.statement();
        this.path("path", `${name} ${this.expand(stmt)}`, g);
        return;
      }
      case "matrix": {
        const stmt = sc.statement();
        this.matrix(this.expand(stmt), g);
        return;
      }
      case "pic": {
        const stmt = sc.statement();
        this.pic(this.expand(stmt), g);
        return;
      }
      case "foreach":
        this.foreach(sc, g, at);
        return;
      case "begin": {
        const env = sc.group("{")?.trim() ?? "";
        const bodyStart = sc.i;
        const end = findEnd(sc.s, sc.i, env);
        const body = sc.s.slice(bodyStart, end.bodyEnd);
        sc.i = end.next;
        this.environment(env, body, g, at(bodyStart));
        return;
      }
      case "end":
        sc.group("{");
        return;
      case "tikzset": {
        const v = sc.group("{");
        if (v !== undefined) applyOptions(g, this.expand(v), "scope", this);
        return;
      }
      case "tikzstyle": {
        const nm = sc.group("{")?.trim();
        sc.ws();
        let append = false;
        if (sc.s.startsWith("+=", sc.i)) {
          append = true;
          sc.i += 2;
        } else if (sc.s[sc.i] === "=") sc.i++;
        const body = sc.options() ?? "";
        if (nm) applyOptions(g, `${nm}/.${append ? "append style" : "style"}={${body}}`, "scope", this);
        return;
      }
      case "pgfplotsset": {
        const v = sc.group("{");
        if (v !== undefined) this.pgfplotsDefaults.push(this.expand(v));
        return;
      }
      case "pgfplotstableread": {
        const data = sc.group("{");
        const target = sc.group("{")?.trim().replace(/^\\/, "");
        if (data !== undefined && target) this.tables.set(target, this.tableSource(data));
        return;
      }
      case "def":
      case "gdef":
      case "edef":
      case "xdef": {
        const m = /^\s*\\([A-Za-z@]+)((?:#\d)*)/.exec(sc.s.slice(sc.i, sc.i + 80));
        if (!m) return;
        sc.i += m[0].length;
        const body = sc.group("{") ?? "";
        this.macros.set(m[1], { nargs: (m[2].match(/#/g) ?? []).length, body: name === "edef" || name === "xdef" ? this.expand(body) : body });
        return;
      }
      case "newcommand":
      case "renewcommand":
      case "providecommand": {
        sc.ws();
        if (sc.s[sc.i] === "*") sc.i++;
        let nm = sc.group("{");
        if (nm === undefined) {
          const m = /^\s*\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i, sc.i + 80));
          if (m) {
            nm = `\\${m[1]}`;
            sc.i += m[0].length;
          }
        }
        const n = Number(sc.options() ?? "0") || 0;
        sc.options();
        const body = sc.group("{") ?? "";
        if (nm) this.macros.set(nm.trim().replace(/^\\/, ""), { nargs: n, body });
        return;
      }
      case "pgfmathsetmacro":
      case "pgfmathtruncatemacro":
      case "pgfmathsetlengthmacro": {
        const nm = sc.group("{")?.trim().replace(/^\\/, "");
        const ex = sc.group("{") ?? "0";
        if (!nm) return;
        try {
          const r = evaluate(this.expand(ex));
          const v = name === "pgfmathtruncatemacro" ? Math.trunc(r.v) : r.v;
          this.macros.set(nm, { nargs: 0, body: name === "pgfmathsetlengthmacro" ? `${fmt(v)}pt` : fmt(v) });
        } catch (e) {
          this.warn(`cannot evaluate ${ex.trim()}: ${(e as Error).message}`);
        }
        return;
      }
      case "pgfmathparse": {
        const ex = sc.group("{") ?? "0";
        try {
          this.macros.set("pgfmathresult", { nargs: 0, body: fmt(evaluate(this.expand(ex)).v) });
        } catch (e) {
          this.warn(`cannot evaluate ${ex.trim()}: ${(e as Error).message}`);
        }
        return;
      }
      case "definecolor":
      case "colorlet": {
        const nm = sc.group("{")?.trim();
        if (name === "colorlet") {
          const ex = sc.group("{") ?? "";
          const hex = nm ? parseColor(ex, this.colors, this.lookup, g.color) : undefined;
          if (nm && hex) this.colors.set(nm, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB);
          return;
        }
        const model = sc.group("{") ?? "";
        const spec = sc.group("{") ?? "";
        const c = colorFromModel(model, spec);
        if (nm && c) this.colors.set(nm, c);
        return;
      }
      case "color": {
        const v = sc.group("{");
        const c = v ? parseColor(v, this.colors, this.lookup, g.color) : undefined;
        if (c) g.color = c;
        return;
      }
      case "usetikzlibrary":
      case "forestset":
      case "usepgfplotslibrary":
      case "usepackage":
      case "pgfdeclarelayer":
      case "pgfsetlayers":
      case "pgfkeys":
      case "pgfplotscreateplotcyclelist":
      case "pgfdeclareplotmark":
        sc.options();
        sc.group("{");
        if (name === "pgfplotscreateplotcyclelist") sc.group("{");
        return;
      case "centering":
      case "small":
      case "footnotesize":
      case "scriptsize":
      case "tiny":
      case "large":
      case "Large":
      case "normalsize":
      case "relax":
      case "noindent":
      case "par":
      case "makeatletter":
      case "makeatother":
      case "let":
        if (name === "let") {
          const m = /^\s*\\([A-Za-z@]+)\s*=?\s*\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i, sc.i + 80));
          if (m) {
            sc.i += m[0].length;
            const d = this.macros.get(m[2]);
            if (d) this.macros.set(m[1], d);
          }
        }
        return;
      case "addplot":
      case "addplot3":
      case "legend":
      case "addlegendentry":
        this.warnOnce("addplot-outside", `\\${name} belongs inside \\begin{axis} ... \\end{axis}; it was skipped`);
        sc.statement();
        return;
      case "graph": {
        const stmt = sc.statement();
        if (this.graphHandler) this.graphHandler(this, this.expand(stmt), g);
        else this.warnOnce("graph", "\\graph (the graphs library) is not supported; it was skipped", "Draw the graph with \\node and \\draw");
        return;
      }
      case "tikz":
        return;
      case "tdplotsetmaincoords":
      case "tdplotsetrotatedcoords":
      case "tdplotsetrotatedcoordsorigin":
      case "tdplotsetthetaplanecoords":
      case "tdplotsetcoord":
      case "tdplotdrawarc":
        tdplotCommand(this, name, sc, g);
        return;
      case "ctikzset": {
        const v = sc.group("{");
        if (v !== undefined) this.circuit?.ctikzset(this, this.expand(v), g);
        return;
      }
      default: {
        this.warnOnce(`cmd:${name}`, `TikZ command \\${name} is not supported and was skipped`);
        // Skip its arguments, or the statement when it looks like a path command.
        const rest = sc.s.slice(sc.i, sc.i + 400);
        if (/^\s*(\[|\(|\{)/.test(rest) && /;/.test(rest)) sc.statement();
        void start;
      }
    }
  }

  private environment(env: string, body: string, g: GS, off: number): void {
    switch (env) {
      case "scope":
      case "tikzpicture":
      case "circuitikz":
      case "pgfinterruptboundingbox": {
        const sc = new Scanner(body);
        const o = sc.options();
        const inner = cloneGS(g);
        if (o) {
          this.off = off;
          applyOptions(inner, this.expand(o), "scope", this);
        }
        const every = inner.styles.get("every scope");
        if (every?.body) applyOptions(inner, every.body, "scope", this);
        this.run(body.slice(sc.i), off + sc.i, true, inner);
        return;
      }
      case "pgfonlayer": {
        const sc = new Scanner(body);
        const layer = sc.group("{")?.trim() ?? "main";
        const inner = cloneGS(g);
        inner.layer = layer === "background" || layer === "back" || layer === "bg" ? -1 : layer === "foreground" || layer === "front" || layer === "fg" ? 1 : 0;
        this.run(body.slice(sc.i), off + sc.i, true, inner);
        return;
      }
      case "axis":
      case "semilogxaxis":
      case "semilogyaxis":
      case "loglogaxis":
      case "polaraxis":
      case "groupplot": {
        const sc = new Scanner(body);
        const o = sc.options() ?? "";
        if (!this.axisHandler) {
          this.warnOnce("axis", "pgfplots is not available");
          return;
        }
        if (env === "polaraxis" || env === "groupplot") this.warnOnce(`env:${env}`, `${env} is drawn as an ordinary axis`);
        this.axisHandler(this, env, this.expand(o), body.slice(sc.i), g, off + sc.i);
        return;
      }
      default:
        this.warnOnce(`env:${env}`, `Environment ${env} inside a TikZ picture is not supported; its contents were drawn as a scope`);
        this.run(body, off, true, cloneGS(g));
    }
  }

  /** \pgfplotstableread data: an inline table, or a file name. */
  tableSource(data: string): string {
    const t = data.trim();
    if (!t.includes("\n") && /^[\w./-]+$/.test(t)) return this.opts.readFile?.(t) ?? "";
    return data;
  }

  // ------------------------------------------------------------ \foreach

  private foreach(sc: Scanner, g: GS, at: (i: number) => number): void {
    const head = this.foreachHead(sc);
    if (!head) {
      this.warn("cannot read this \\foreach; it was skipped", at(sc.i));
      sc.statement();
      return;
    }
    sc.ws();
    let body: string;
    let bodyOff: number;
    if (sc.s[sc.i] === "{") {
      bodyOff = at(sc.i + 1);
      body = sc.group("{") ?? "";
    } else {
      bodyOff = at(sc.i);
      // The body is one statement, or another \foreach.
      if (sc.s.startsWith("\\foreach", sc.i)) {
        const s0 = sc.i;
        sc.i += 8;
        this.foreachHead(sc);
        sc.ws();
        if (sc.s[sc.i] === "{") sc.group("{");
        else sc.statement();
        body = sc.s.slice(s0, sc.i);
      } else body = `${sc.statement()};`;
    }
    this.loop(head, (vars) => {
      const saved = new Map<string, Macro | undefined>();
      for (const [k, v] of vars) {
        saved.set(k, this.macros.get(k));
        this.macros.set(k, { nargs: 0, body: v });
      }
      this.run(this.expand(body), bodyOff, false, cloneGS(g));
      for (const [k, v] of saved) {
        if (v) this.macros.set(k, v);
        else this.macros.delete(k);
      }
    });
  }

  /** `\x/\y [count=\i, evaluate=...] in {list}` after \foreach. */
  foreachHead(sc: Scanner): { vars: string[]; items: string[]; count?: string; evaluate: [string, string, string][]; remember?: [string, string, string] } | undefined {
    sc.ws();
    const m = /^((?:\\[A-Za-z@]+\s*\/?\s*)+)/.exec(sc.s.slice(sc.i, sc.i + 200));
    if (!m) return undefined;
    sc.i += m[0].length;
    const vars = m[1].split("/").map((v) => v.trim().replace(/^\\/, ""));
    let count: string | undefined;
    const evals: [string, string, string][] = [];
    let remember: [string, string, string] | undefined;
    for (;;) {
      const o = sc.options();
      if (o === undefined) break;
      for (const { key, value } of parseOptions(o)) {
        if (key === "count" && value) count = value.split(/\s+from\s+/)[0].trim().replace(/^\\/, "");
        else if (key === "evaluate" && value) {
          const e = /^\\([A-Za-z@]+)(?:\s+as\s+\\([A-Za-z@]+))?(?:\s+using\s+(.*))?$/s.exec(value.trim());
          if (e) evals.push([e[1], e[2] ?? e[1], e[3] ?? `\\${e[1]}`]);
        } else if (key === "remember" && value) {
          const r = /^\\([A-Za-z@]+)\s+as\s+\\([A-Za-z@]+)(?:\s*\(initially\s+([^)]*)\))?/.exec(value.trim());
          if (r) remember = [r[1], r[2], r[3] ?? ""];
        } else if (key === "parse") {
          // values are evaluated anyway when they are used
        } else this.unknown(`foreach ${key}`);
      }
    }
    if (!sc.word("in")) return undefined;
    sc.ws();
    let list: string;
    if (sc.s[sc.i] === "{") list = sc.group("{") ?? "";
    else {
      const mm = /^\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i, sc.i + 80));
      if (!mm) return undefined;
      sc.i += mm[0].length;
      list = this.macros.get(mm[1])?.body ?? "";
    }
    const items = expandList(this.expand(list), LIMITS.iterations);
    return { vars, items, ...(count ? { count } : {}), evaluate: evals, ...(remember ? { remember } : {}) };
  }

  /** Calls `body` with each item's variable bindings. */
  loop(head: NonNullable<ReturnType<Interp["foreachHead"]>>, body: (vars: Map<string, string>) => void): void {
    let prevRemember = head.remember?.[2] ?? "";
    head.items.forEach((item, idx) => {
      if (++this.iterations > LIMITS.iterations) throw new Stop("\\foreach runs too many times");
      this.tick();
      const vars = new Map<string, string>();
      const parts = head.vars.length > 1 ? splitTop(item, "/") : [item];
      head.vars.forEach((v, k) => vars.set(v, unbrace((parts[k] ?? parts[parts.length - 1] ?? "").trim())));
      if (head.count) vars.set(head.count, String(idx + 1));
      for (const [src, as, using] of head.evaluate) {
        let ex = using;
        for (const [k, v] of vars) ex = ex.split(`\\${k}`).join(`(${v})`);
        try {
          vars.set(as, fmt(evaluate(this.expand(ex)).v));
        } catch {
          vars.set(as, vars.get(src) ?? "0");
        }
      }
      if (head.remember) vars.set(head.remember[1], prevRemember);
      body(vars);
      if (head.remember) prevRemember = vars.get(head.remember[0]) ?? "";
    });
  }

  // ------------------------------------------------------------ coordinates

  coordOffset(text: string, g: GS): Pt | undefined {
    const c = this.coord(text, g);
    if (!c) return undefined;
    // An offset: the transformation's translation left out.
    return [c.p[0] - g.T[4], c.p[1] - g.T[5]];
  }

  /** The point a coordinate (the inside of its parentheses) names, in the picture's points. */
  coord(raw: string, g: GS): Coord | undefined {
    let s = raw.trim();
    let shift: Pt = [0, 0];
    // ([xshift=1cm]a.east)
    if (s.startsWith("[")) {
      const e = matchClose(s, 0);
      if (e > 0) {
        const tmp = cloneGS(g);
        tmp.T = [1, 0, 0, 1, 0, 0];
        applyOptions(tmp, s.slice(1, e), "path", this);
        shift = [tmp.T[4], tmp.T[5]];
        s = s.slice(e + 1).trim();
      }
    }
    const r = this.coordInner(s, g);
    if (!r) return undefined;
    if (shift[0] || shift[1]) return { p: add(r.p, shift) };
    return r;
  }

  private coordInner(s: string, g: GS): Coord | undefined {
    if (!s) return { p: apply(g.T, [0, 0]) };
    if (s.startsWith("$") && s.endsWith("$") && s.length > 1) return this.calc(s.slice(1, -1), g);
    // (a |- b) and (a -| b).
    const perp = splitTop(s, "|-");
    if (perp.length === 2) {
      const a = this.coord(stripParens(perp[0]), g);
      const b = this.coord(stripParens(perp[1]), g);
      return a && b ? { p: [a.p[0], b.p[1]] } : undefined;
    }
    const perp2 = splitTop(s, "-|");
    if (perp2.length === 2) {
      const a = this.coord(stripParens(perp2[0]), g);
      const b = this.coord(stripParens(perp2[1]), g);
      return a && b ? { p: [b.p[0], a.p[1]] } : undefined;
    }
    const inter = /^intersection\s+(?:of\s+)?(.*?)--(.*?)\s+and\s+(.*?)--(.*)$/s.exec(s);
    if (inter) {
      const pts = inter.slice(1, 5).map((x) => this.coord(stripParens(x), g));
      if (pts.some((p) => !p)) return undefined;
      const p = lineIntersection(pts[0]!.p, pts[1]!.p, pts[2]!.p, pts[3]!.p);
      return p ? { p } : undefined;
    }
    const cs = /^([a-z ]+?)\s+cs\s*:\s*(.*)$/s.exec(s);
    if (cs) return this.coordSystem(cs[1], cs[2], g);
    const comma = splitTop(s, ",");
    if (comma.length >= 2) {
      const vals = comma.map((x) => this.dimOf(x));
      if (vals.some((v) => !v)) return undefined;
      if (g.axis && comma.length === 2 && !vals[0]!.dim && !vals[1]!.dim) return { p: apply(g.T, g.axis.map(vals[0]!.v, vals[1]!.v)) };
      if (g.axis && comma.length === 2 && g.axis.xsym && !vals[0]) return undefined;
      let p: Pt = [0, 0];
      const vecs = [g.xv, g.yv, g.zv];
      vals.slice(0, 3).forEach((v, k) => {
        if (v!.dim) p = add(p, k === 0 ? [v!.v, 0] : k === 1 ? [0, v!.v] : scale(unit(g.zv), v!.v));
        else p = add(p, scale(vecs[k], v!.v));
      });
      return { p: apply(g.T, p) };
    }
    const colon = splitTop(s, ":");
    if (colon.length === 2) {
      const a = this.dimOf(colon[0]);
      if (!a) return undefined;
      const radii = colon[1].split(/\s+and\s+/);
      const rx = this.dimOf(radii[0]);
      const ry = radii[1] !== undefined ? this.dimOf(radii[1]) : rx;
      if (!rx || !ry) return undefined;
      const c = Math.cos((a.v * Math.PI) / 180);
      const sn = Math.sin((a.v * Math.PI) / 180);
      const px: Pt = rx.dim ? [rx.v * c, 0] : scale(g.xv, rx.v * c);
      const py: Pt = ry.dim ? [0, ry.v * sn] : scale(g.yv, ry.v * sn);
      return { p: apply(g.T, add(px, py)) };
    }
    return this.nodeCoord(s);
  }

  private dimOf(x: string): { v: number; dim: boolean } | undefined {
    try {
      return evaluate(this.expand(x));
    } catch (e) {
      if (e instanceof ExprError) this.warnOnce(`expr:${x.trim().slice(0, 40)}`, `Cannot read "${x.trim().slice(0, 60)}" as a number: ${e.message}`);
      return undefined;
    }
  }

  private coordSystem(kind: string, body: string, g: GS): Coord | undefined {
    const k = kind.trim();
    if (k === "axis" || k === "rel axis") {
      const vals = splitTop(body, ",").map((x) => x.trim());
      if (!g.axis) return this.coordInner(vals.join(","), g);
      if (k === "rel axis") {
        const v = vals.map((x) => num(x) ?? 0);
        return { p: apply(g.T, g.axis.rel(v[0] ?? 0, v[1] ?? 0)) };
      }
      const xs = g.axis.xsym?.get(vals[0]);
      const ys = g.axis.ysym?.get(vals[1]);
      const x = xs ?? num(this.expand(vals[0] ?? "0"));
      const y = ys ?? num(this.expand(vals[1] ?? "0"));
      if (x === undefined || y === undefined) return undefined;
      return { p: apply(g.T, g.axis.map(x, y)) };
    }
    const kv = new Map(parseOptions(body).map((o) => [o.key, o.value ?? ""]));
    if (k === "canvas" || k === "xyz") {
      const parts = ["x", "y", "z"].map((a) => this.dimOf(kv.get(a) ?? "0") ?? { v: 0, dim: false });
      return this.coordInner(parts.map((p) => (p.dim ? `${p.v}pt` : String(p.v))).join(","), g);
    }
    if (k === "canvas polar" || k === "polar" || k === "xyz polar") return this.coordInner(`${kv.get("angle") ?? "0"}:${kv.get("radius") ?? "0"}`, g);
    if (k === "node") {
      const n = kv.get("name") ?? "";
      const a = kv.get("anchor") ?? kv.get("angle");
      return this.nodeCoord(a ? `${n}.${a}` : n);
    }
    this.warnOnce(`cs:${k}`, `Coordinate system "${k} cs" is not supported`);
    return undefined;
  }

  /** (name) or (name.anchor). */
  nodeCoord(s: string): Coord | undefined {
    const name = s.trim();
    const n = this.nodes.get(name);
    if (n) return { p: n.center, node: n };
    const dot = name.lastIndexOf(".");
    if (dot > 0) {
      const base = name.slice(0, dot).trim();
      const anchor = name.slice(dot + 1).trim();
      const node = this.nodes.get(base) ?? (base === "current bounding box" ? this.currentBox() : undefined);
      if (node) return { p: anchorPoint(node, anchor) };
    }
    if (name === "current bounding box") {
      const b = this.currentBox();
      if (b) return { p: b.center, node: b };
    }
    this.warnOnce(`node:${name}`, `Coordinate (${name}) names no node or coordinate defined before it`, "Define the node first, or check the spelling of its name");
    return undefined;
  }

  private currentBox(): NodeInfo | undefined {
    const b = this.scene.box();
    if (!boxOK(b)) return undefined;
    return { name: "current bounding box", center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], shape: "rectangle", hw: (b[2] - b[0]) / 2, hh: (b[3] - b[1]) / 2, rot: 0, baseDy: 0 };
  }

  /** The calc library: ($(a)!0.5!(b)$), ($(a)+(1,2)$), ($2*(a)-(b)$), ($(a)!1cm!90:(b)$), ($(a)!(p)!(b)$). */
  private calc(s: string, g: GS): Coord | undefined {
    const sc = new Scanner(s);
    let acc: Pt = [0, 0];
    let first = true;
    while (!sc.done) {
      let sign = 1;
      if (sc.peek() === "+") sc.i++;
      else if (sc.peek() === "-") {
        sc.i++;
        sign = -1;
      } else if (!first) return undefined;
      first = false;
      sc.ws();
      let factor = 1;
      // A factor: {expr}* or number*.
      if (sc.s[sc.i] === "{") {
        const f = sc.group("{") ?? "1";
        factor = num(this.expand(f)) ?? 1;
        sc.ws();
        if (sc.s[sc.i] === "*") sc.i++;
      } else {
        const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*\*/.exec(sc.s.slice(sc.i, sc.i + 40));
        if (m) {
          factor = Number(m[1]);
          sc.i += m[0].length;
        }
      }
      sc.ws();
      const inner = sc.group("(");
      if (inner === undefined) return undefined;
      let p = this.coord(inner, g)?.p;
      if (!p) return undefined;
      // Modifiers: !0.5!(b), !1cm!(b), !0.5!30:(b), !(c)!(b).
      for (;;) {
        sc.ws();
        if (sc.s[sc.i] !== "!") break;
        sc.i++;
        sc.ws();
        let projection: Pt | undefined;
        let frac: { v: number; dim: boolean } | undefined;
        let angle = 0;
        if (sc.s[sc.i] === "(") {
          const c = sc.group("(") ?? "";
          projection = this.coord(c, g)?.p;
        } else {
          const k = sc.s.indexOf("!", sc.i);
          if (k < 0) return undefined;
          let mod = sc.s.slice(sc.i, k).trim();
          sc.i = k;
          const ang = /^(.*?):\s*$/.exec(mod) ?? /^(.*?)!?([^!:]*):$/.exec(mod);
          void ang;
          const parts = splitTop(mod, ":");
          if (parts.length === 2) {
            mod = parts[0];
            angle = num(this.expand(parts[1] || "0")) ?? 0;
          }
          frac = this.dimOf(mod);
        }
        sc.ws();
        if (sc.s[sc.i] !== "!") return undefined;
        sc.i++;
        sc.ws();
        // An angle may also stand between the second ! and the coordinate: !0.5!90:(b).
        const angM = /^([-+]?[\d.]+)\s*:/.exec(sc.s.slice(sc.i, sc.i + 20));
        if (angM) {
          angle = Number(angM[1]);
          sc.i += angM[0].length;
        }
        const other = sc.group("(");
        if (other === undefined) return undefined;
        const b0 = this.coord(other, g)?.p;
        if (!b0) return undefined;
        const b = angle ? add(p, applyLinear(rotation(angle), sub(b0, p))) : b0;
        if (projection) {
          const d = sub(b, p);
          const l2 = d[0] * d[0] + d[1] * d[1] || 1;
          const t = ((projection[0] - p[0]) * d[0] + (projection[1] - p[1]) * d[1]) / l2;
          p = lerp(p, b, t);
        } else if (frac) {
          const t = frac.dim ? frac.v / (dist(p, b) || 1) : frac.v;
          p = lerp(p, b, t);
        }
      }
      acc = add(acc, scale(p, sign * factor));
    }
    return { p: acc };
  }

  // ------------------------------------------------------------ paths

  /** The paint of a path drawn with state `g`. */
  paint(g: GS, draw: boolean, fill: boolean): PaintStyle {
    const st: PaintStyle = { lineWidth: g.lw, cap: g.cap, join: g.join, evenOdd: g.evenOdd };
    if (draw && g.drawColor !== null) st.stroke = g.drawColor ?? g.color;
    if (fill && g.fillColor !== null) {
      if (g.shade) st.shade = g.shade;
      else st.fill = g.fillColor ?? g.color;
    } else if (g.shade && fill) st.shade = g.shade;
    const d = dashPattern(g);
    if (d) st.dash = d;
    if (g.dashOffset) st.dashOffset = g.dashOffset;
    const so = g.drawOpacity ?? g.opacity;
    const fo = g.fillOpacity ?? g.opacity;
    if (so !== undefined) st.strokeOpacity = so;
    if (fo !== undefined) st.fillOpacity = fo;
    return st;
  }

  /** \draw, \fill, \path and friends. */
  path(cmd: string, text: string, g0: GS): void {
    const g = cloneGS(g0);
    if (cmd === "draw" || cmd === "filldraw" || cmd === "shadedraw") g.doDraw = true;
    if (cmd === "fill" || cmd === "filldraw") g.doFill = true;
    if (cmd === "shade" || cmd === "shadedraw") {
      g.doFill = true;
      if (!g.shade) g.shade = { kind: "linear", angle: -90, stops: [[0, "#808080"], [1, "#ffffff"]] };
    }
    if (cmd === "clip") g.doClip = true;
    if (cmd === "useasboundingbox") g.useAsBox = true;
    if (cmd === "pattern") g.doFill = true;
    const every = g.styles.get("every path");
    if (every?.body) applyOptions(g, every.body, "path", this);
    const pb = new PathBuilder(this, g);
    try {
      pb.parse(text);
    } catch (e) {
      // Out of budget: draw what the path has so far, then stop.
      if (e instanceof Stop) {
        this.ops = 0;
        pb.finish();
      }
      throw e;
    }
    pb.finish();
  }

  // ------------------------------------------------------------ nodes

  /** Lays out, places, registers and draws a node. Returns it, or undefined when it could not be placed. */
  node(pn: PendingNode, where: { point: Pt; tangent?: Pt } | undefined, pathGS: GS): NodeInfo | undefined {
    if (this.nodes.size > LIMITS.nodes) throw new Stop("the picture has too many nodes");
    this.tick();
    const g = pn.g;
    let text = pn.text;
    // Matrix-of-nodes cells and node text may start with |[options]|.
    const cellOpts = /^\s*\|\s*\[([^]*?)\]\s*\|/.exec(text);
    if (cellOpts) {
      applyOptions(g, cellOpts[1], "node", this);
      text = text.slice(cellOpts[0].length);
    }
    // circuitikz shapes (op amp, npn, ground, ...) are drawn by circuit.ts.
    const circ = this.circuit?.node(this, { ...pn, text }, where, pathGS);
    if (circ) return circ;
    const isCoordinate = g.shape === "coordinate";
    let block: TextBlock | undefined;
    if (!isCoordinate && !blankText(text)) {
      block = layoutText(text, { ...g.font, align: g.align ?? "center", ...(g.textWidth !== undefined ? { width: g.textWidth } : {}) }, this.mathMacros);
      if (!block.ok || block.errors.length) this.warnOnce(`text:${text.slice(0, 40)}`, `Node text "${text.trim().slice(0, 50)}" could not be typeset completely${block.errors[0] ? `: ${block.errors[0]}` : ""}`);
    } else if (!isCoordinate && g.textWidth !== undefined) block = { width: g.textWidth, height: 0, depth: 0, glyphs: [], rules: [], ok: true, errors: [], parts: [] };
    const s = g.nscale * (g.transformShape ? Math.sqrt(Math.abs(g.T[0] * g.T[3] - g.T[1] * g.T[2])) : 1);
    const w = block?.width ?? 0;
    const h = block?.height ?? 0;
    const d = block?.depth ?? 0;
    const outer = g.outer ?? (g.doDraw ? g.lw / 2 : 0);
    let hw = 0;
    let hh = 0;
    const th = h + d;
    const shape = g.shape === "state" ? "circle" : g.shape;
    if (!isCoordinate) {
      switch (shape) {
        case "circle":
        case "regular polygon":
        case "star":
        case "circle split":
        case "forbidden sign":
        case "correct forbidden sign": {
          const r = Math.max(Math.hypot(w / 2, th / 2) + Math.max(g.ix, g.iy), g.minW / 2, g.minH / 2);
          hw = hh = r;
          break;
        }
        case "ellipse": {
          hw = Math.max((w / 2 + g.ix) * Math.SQRT2, g.minW / 2);
          hh = Math.max((th / 2 + g.iy) * Math.SQRT2, g.minH / 2);
          break;
        }
        case "diamond": {
          // The diamond holds the text box: p/A + q/B = 1 with A = aspect * B.
          const p = w / 2 + g.ix;
          const q = th / 2 + g.iy;
          const b = p / g.aspect + q;
          hw = Math.max(g.aspect * b, g.minW / 2);
          hh = Math.max(b, g.minH / 2);
          break;
        }
        case "rounded rectangle": {
          hh = Math.max(th / 2 + g.iy, g.minH / 2);
          hw = Math.max(w / 2 + g.ix + hh * 0.6, g.minW / 2);
          break;
        }
        case "trapezium": {
          hh = Math.max(th / 2 + g.iy, g.minH / 2);
          hw = Math.max(w / 2 + g.ix + hh, g.minW / 2);
          break;
        }
        case "isosceles triangle": {
          hh = Math.max(th / 2 + g.iy, g.minH / 2) * 1.6;
          hw = Math.max(w / 2 + g.ix, g.minW / 2) * 1.6;
          break;
        }
        default: {
          if (!KNOWN_SHAPES.has(shape)) this.warnOnce(`shape:${shape}`, `Node shape "${shape}" is drawn as a rectangle`);
          hw = Math.max(w / 2 + g.ix, g.minW / 2);
          hh = Math.max(th / 2 + g.iy, g.minH / 2);
          if (shape === "cylinder") hw += hh * 0.25;
        }
      }
    }
    // fit=(a) (b): the box around those nodes.
    let fitCenter: Pt | undefined;
    if (g.fit) {
      const b = emptyBox();
      for (const m of g.fit.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
        const c = this.coord(m[1], g);
        if (!c) continue;
        if (c.node) {
          growBox(b, [c.node.center[0] - c.node.hw, c.node.center[1] - c.node.hh]);
          growBox(b, [c.node.center[0] + c.node.hw, c.node.center[1] + c.node.hh]);
        } else growBox(b, c.p);
      }
      if (boxOK(b)) {
        fitCenter = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        hw = Math.max(hw, (b[2] - b[0]) / 2 + g.ix);
        hh = Math.max(hh, (b[3] - b[1]) / 2 + g.iy);
        if (shape === "circle") hw = hh = Math.hypot(hw, hh);
      }
    }
    hw = hw * s + outer;
    hh = hh * s + outer;
    const baseDy = ((h - d) / 2) * s;
    const info: NodeInfo = { name: pn.name ?? "", center: [0, 0], shape: isCoordinate ? "coordinate" : shape, hw, hh, rot: g.nrot, baseDy, sides: shape === "star" ? g.points : g.sides };
    // Where it goes.
    let point: Pt;
    let anchor = g.anchor;
    if (fitCenter && !pn.at && !g.place) point = fitCenter;
    else if (pn.at) point = pn.at.p;
    else point = where?.point ?? apply(g.T, [0, 0]);
    if (g.place) {
      const pl = g.place;
      if (pl.of) {
        const ref = this.coord(pl.of, g);
        if (ref) {
          const vec = COMPASS[PLACE_REF[pl.dir]] ?? [0, 0];
          const dy = pl.dy ?? g.nodeDist[0];
          const dx = pl.dx ?? g.nodeDist[1];
          if (pl.old) {
            point = add(ref.p, [vec[0] * dx, vec[1] * dy]);
            anchor = anchor ?? "center";
          } else {
            const base = ref.node ? anchorPoint(ref.node, PLACE_REF[pl.dir]) : ref.p;
            point = add(base, [vec[0] * dx, vec[1] * dy]);
            anchor = anchor ?? PLACE_ANCHOR[pl.dir];
          }
        }
      } else {
        anchor = anchor ?? PLACE_ANCHOR[pl.dir];
        const vec = COMPASS[PLACE_REF[pl.dir]] ?? [0, 0];
        if (pl.dy !== undefined || pl.dx !== undefined) point = add(point, [vec[0] * (pl.dx ?? pl.dy ?? 0), vec[1] * (pl.dy ?? 0)]);
      }
    }
    // auto: beside the line, on its left (or right with swap).
    if (!anchor && where?.tangent && (g.auto || g.labels.some(() => false))) {
      const t = unit(where.tangent);
      const left = (g.auto !== "right") !== g.swap;
      // The side the label goes to; its anchor faces back towards the line.
      const side: Pt = left ? [-t[1], t[0]] : [t[1], -t[0]];
      anchor = compassFor([-side[0], -side[1]]);
    }
    let rot = g.nrot;
    if (g.sloped && where?.tangent) {
      let a = angleOf(where.tangent);
      if (a > 90.01 || a < -90.01) a += 180;
      rot += a;
      if (anchor) anchor = rotateAnchorName(anchor, -a);
    }
    info.rot = rot;
    info.center = [0, 0];
    const off: Pt = anchor && anchor !== "center" ? anchorPoint(info, anchor) : [0, 0];
    info.center = add(sub(point, off), g.nshift);
    if (pn.name) this.nodes.set(pn.name, info);
    if (g.alias) this.nodes.set(g.alias, info);
    this.drawNode(info, g, block, s);
    // Labels and pins.
    for (const l of g.labels) this.label(info, l, g);
    if (g.initial) this.initialArrow(info, g);
    void pathGS;
    return info;
  }

  private drawNode(info: NodeInfo, g: GS, block: TextBlock | undefined, s: number): void {
    const doShape = (g.doDraw || g.doFill || !!g.shade) && info.shape !== "coordinate";
    if (doShape) {
      const outer = g.outer ?? (g.doDraw ? g.lw / 2 : 0);
      const segs = nodeOutline(info, outer, g.rounded);
      const st = this.paint(g, g.doDraw, g.doFill || !!g.shade);
      if (g.double && st.stroke) {
        this.scene.path(segs, { ...st, lineWidth: g.lw * 2 + g.doubleDist }, g.clips, g.layer);
        this.scene.path(segs, { ...st, fill: undefined, shade: undefined, stroke: g.double, lineWidth: g.doubleDist }, g.clips, g.layer);
      } else this.scene.path(segs, st, g.clips, g.layer);
      if (g.accepting) {
        const inner = nodeOutline({ ...info, hw: info.hw - outer - 2.5, hh: info.hh - outer - 2.5 }, 0, g.rounded);
        this.scene.path(inner, { ...st, fill: undefined, shade: undefined }, g.clips, g.layer);
      }
      if (info.shape === "rectangle split" && block?.parts.length) {
        const R = rotation(info.rot);
        const x = info.hw - outer;
        const segs: Seg[] = [];
        for (const py of block.parts) {
          const y = -info.baseDy - py * s;
          segs.push({ t: "M", p: add(info.center, applyLinear(R, [-x, y])) }, { t: "L", p: add(info.center, applyLinear(R, [x, y])) });
        }
        this.scene.path(segs, { ...st, fill: undefined, shade: undefined }, g.clips, g.layer);
      }
      if (info.shape === "circle split") {
        const r = info.hw - outer;
        const a = add(info.center, applyLinear(rotation(info.rot), [-r, 0]));
        const b = add(info.center, applyLinear(rotation(info.rot), [r, 0]));
        this.scene.path([{ t: "M", p: a }, { t: "L", p: b }], { ...st, fill: undefined, shade: undefined }, g.clips, g.layer);
      }
      this.drawn++;
    }
    if (block && (block.glyphs.length || block.rules.length)) {
      const origin = add(info.center, applyLinear(rotation(info.rot), [(-block.width / 2) * s, -info.baseDy]));
      const fill = g.textColor ?? g.color;
      const op = g.textOpacity ?? g.opacity;
      const svg = textSvg(block, origin[0], -origin[1], fill, this.scene.glyphs, { rotate: info.rot, scale: s, ...(op !== undefined ? { opacity: op } : {}) });
      const b = emptyBox();
      const corners: Pt[] = [
        [-block.width / 2, -info.baseDy / s + block.height],
        [block.width / 2, -info.baseDy / s + block.height],
        [-block.width / 2, -info.baseDy / s - block.depth],
        [block.width / 2, -info.baseDy / s - block.depth],
      ];
      for (const c of corners) growBox(b, add(info.center, applyLinear(rotation(info.rot), scale(c, s))));
      this.scene.add(svg, b, g.clips, g.layer);
      this.drawn++;
    } else if (info.shape !== "coordinate" && !doShape) {
      // An empty, undrawn node still takes up its space.
      const b: Box = [info.center[0] - info.hw, info.center[1] - info.hh, info.center[0] + info.hw, info.center[1] + info.hh];
      this.scene.add("<g/>", b, g.clips, g.layer);
    }
  }

  label(main: NodeInfo, l: LabelSpec, g: GS): void {
    if (l.angle === "quote") return;
    // A label is a node of its own: it keeps the colours, not the main node's shape or size.
    const lg = nodeGS(g);
    lg.anchor = undefined;
    lg.place = undefined;
    lg.shape = "rectangle";
    lg.minW = lg.minH = 1;
    lg.textWidth = undefined;
    lg.ix = lg.iy = 3.333;
    const every = lg.styles.get(l.pin ? "every pin" : "every label");
    if (every?.body) applyOptions(lg, every.body, "node", this);
    if (l.opts) applyOptions(lg, l.opts, "node", this);
    const ang = labelAngle(l.angle);
    const from = ang.anchor ? anchorPoint(main, ang.anchor) : borderPoint(main, add(main.center, dir(ang.deg)));
    const distance = l.pin ? lg.pinDist : lg.labelDist;
    const at = add(from, scale(dir(ang.deg), distance));
    const pn: PendingNode = { text: l.text, g: lg, off: this.off, onNext: false };
    lg.anchor = compassFor(dir(ang.deg + 180), true);
    const ln = this.node(pn, { point: at }, g);
    if (l.pin && ln) {
      const pg = cloneGS(g);
      pg.doDraw = true;
      pg.arrows = undefined;
      pg.color = "#808080";
      pg.lw = 0.4;
      const e = pg.styles.get("every pin edge");
      if (e?.body) applyOptions(pg, e.body, "path", this);
      const end = borderPoint(ln, from);
      this.scene.path([{ t: "M", p: from }, { t: "L", p: end }], this.paint(pg, true, false), pg.clips, pg.layer);
    }
  }

  private initialArrow(n: NodeInfo, g: GS): void {
    const where = g.initial ?? "left";
    const deg = where === "right" ? 0 : where === "above" ? 90 : where === "below" ? -90 : 180;
    const tip = anchorPoint(n, String(deg));
    const start = add(tip, scale(dir(deg), 3 * 4.305 + 6));
    const pg = cloneGS(g);
    pg.doDraw = true;
    pg.doFill = false;
    pg.shade = undefined;
    pg.double = undefined;
    pg.dash = undefined;
    pg.arrows = { start: [], end: [g.defTip] };
    const segs: Seg[] = [
      { t: "M", p: start },
      { t: "L", p: tip },
    ];
    this.strokeWithArrows(segs, pg);
    if (g.initialText) {
      const tg = nodeGS(g);
      tg.anchor = compassFor(dir(deg + 180), true);
      tg.shape = "rectangle";
      tg.doDraw = false;
      this.node({ text: g.initialText, g: tg, off: this.off, onNext: false }, { point: start }, g);
    }
  }

  /** Strokes (and fills) a path with its arrow tips and shortening. */
  strokeWithArrows(segs0: Seg[], g: GS, fill = false): void {
    let segs = segs0;
    const st = this.paint(g, g.doDraw, fill);
    const tips: { segs: Seg[]; filled: boolean; lw: number }[] = [];
    const open = segs.length > 0 && segs[segs.length - 1].t !== "Z";
    if ((g.arrows || g.shortenS || g.shortenE) && open && st.stroke) {
      const r = applyTips(segs, resolveTips(g.arrows, g.defTip), g.lw, g.shortenS, g.shortenE);
      segs = r.segs;
      tips.push(...r.tips);
    }
    if (g.double && st.stroke) {
      this.scene.path(segs, { ...st, lineWidth: g.lw * 2 + g.doubleDist }, g.clips, g.layer);
      this.scene.path(segs, { ...st, fill: undefined, shade: undefined, stroke: g.double, lineWidth: g.doubleDist }, g.clips, g.layer);
    } else if (this.scene.path(segs, st, g.clips, g.layer)) this.drawn++;
    for (const t of tips) {
      const color = st.stroke ?? g.color;
      this.scene.path(
        t.segs,
        t.filled
          ? { fill: color, stroke: color, lineWidth: t.lw, join: "miter", ...(st.strokeOpacity !== undefined ? { fillOpacity: st.strokeOpacity, strokeOpacity: st.strokeOpacity } : {}) }
          : { stroke: color, fill: t.lw < 0 ? "#ffffff" : undefined, lineWidth: Math.abs(t.lw), cap: "round", join: "round", ...(st.strokeOpacity !== undefined ? { strokeOpacity: st.strokeOpacity } : {}) },
        g.clips,
        g.layer,
      );
    }
  }

  // ------------------------------------------------------------ \matrix

  private matrix(stmt: string, g0: GS): void {
    const sc = new Scanner(stmt);
    const g = nodeGS(g0);
    let name: string | undefined;
    let at: Coord | undefined;
    let optsText = "";
    for (;;) {
      if (sc.peek() === "[") optsText += `,${sc.options() ?? ""}`;
      else if (sc.peek() === "(") name = (sc.group("(") ?? "").trim();
      else if (sc.word("at")) {
        const c = sc.group("(");
        at = c !== undefined ? this.coord(c, g0) : undefined;
      } else break;
    }
    const body = sc.group("{");
    if (body === undefined) {
      this.warn("\\matrix needs its cells in braces");
      return;
    }
    const every = g.styles.get("every node");
    const opts = parseOptions(optsText);
    const has = (k: string) => opts.some((o) => o.key === k);
    const get = (k: string) => opts.find((o) => o.key === k)?.value;
    const ofNodes = has("matrix of nodes") || has("matrix of math nodes");
    const math = has("matrix of math nodes");
    const rowSep = length(get("row sep") ?? "0pt", 1) ?? 0;
    const colSep = length(get("column sep") ?? "0pt", 1) ?? 0;
    const matrixG = cloneGS(g0);
    applyOptions(matrixG, optsText.replace(/(^|,)\s*(matrix of (math )?nodes|row sep=[^,]*|column sep=[^,]*|nodes=\{[^}]*\}|nodes=[^,]*)/g, "$1"), "node", this);
    const cellG = nodeGS(matrixG);
    if (every?.body) applyOptions(cellG, every.body, "node", this);
    const nodesOpt = get("nodes");
    if (nodesOpt) applyOptions(cellG, nodesOpt, "node", this);
    const rows = splitRows(body).filter((r, i, a) => i < a.length - 1 || r.trim() !== "");
    // Lay out every cell first to size rows and columns.
    type Cell = { text: string; opts: string; name?: string; w: number; h: number };
    const cells: Cell[][] = [];
    for (const row of rows.slice(0, 200)) {
      const out: Cell[] = [];
      for (const cellRaw of splitTop(row, "&").slice(0, 100)) {
        let text = cellRaw.trim();
        let copts = "";
        let cname: string | undefined;
        if (!ofNodes) {
          // Plain matrix: cells hold \node[...] (name) {text};
          const m = /^\\node\s*((?:\[[^]*?\])?)\s*(?:\(([^)]*)\))?\s*((?:\[[^]*?\])?)\s*\{([^]*)\}\s*;?\s*$/.exec(text);
          if (m) {
            copts = `${m[1].slice(1, -1)},${m[3].slice(1, -1)}`;
            cname = m[2]?.trim();
            text = m[4];
          } else if (text) {
            this.warnOnce("matrix-cell", "Matrix cells that are not a single \\node are drawn as plain text");
          }
        } else {
          const m = /^\|\s*\[([^]*?)\]\s*\|/.exec(text);
          if (m) {
            copts = m[1];
            text = text.slice(m[0].length).trim();
          }
          if (math && text) text = `$${text}$`;
        }
        out.push({ text, opts: copts, ...(cname ? { name: cname } : {}), w: 0, h: 0 });
      }
      cells.push(out);
    }
    const ncols = Math.max(0, ...cells.map((r) => r.length));
    const measure: { info: NodeInfo; g: GS; text: string; name?: string }[][] = [];
    const colW = new Array(ncols).fill(0);
    const rowH: number[] = [];
    cells.forEach((row) => {
      const mrow: { info: NodeInfo; g: GS; text: string; name?: string }[] = [];
      let rh = 0;
      row.forEach((cell, ci) => {
        const cg = cloneGS(cellG);
        if (cell.opts) applyOptions(cg, cell.opts, "node", this);
        // Measure by laying out off-picture (not registered or drawn).
        const block = cell.text && !blankText(cell.text) ? layoutText(cell.text, { ...cg.font, align: cg.align ?? "center", ...(cg.textWidth !== undefined ? { width: cg.textWidth } : {}) }, this.mathMacros) : undefined;
        const w = Math.max((block?.width ?? 0) + 2 * cg.ix, cg.minW) * cg.nscale;
        const hgt = Math.max((block ? block.height + block.depth : 0) + 2 * cg.iy, cg.minH) * cg.nscale;
        colW[ci] = Math.max(colW[ci], w);
        rh = Math.max(rh, hgt);
        mrow.push({ info: { name: "", center: [0, 0], shape: "rectangle", hw: w / 2, hh: hgt / 2, rot: 0, baseDy: 0 }, g: cg, text: cell.text, ...(cell.name ? { name: cell.name } : {}) });
      });
      rowH.push(rh);
      measure.push(mrow);
    });
    const totalW = colW.reduce((a, b) => a + b, 0) + colSep * Math.max(0, ncols - 1);
    const totalH = rowH.reduce((a, b) => a + b, 0) + rowSep * Math.max(0, rowH.length - 1);
    const center = at?.p ?? apply(g0.T, [0, 0]);
    // The matrix's own anchor (anchor=..., or placement).
    let origin: Pt = [center[0] - totalW / 2, center[1] + totalH / 2];
    const mInfo: NodeInfo = { name: name ?? "", center, shape: "rectangle", hw: totalW / 2 + matrixG.ix, hh: totalH / 2 + matrixG.iy, rot: 0, baseDy: 0 };
    if (matrixG.place?.of) {
      const ref = this.coord(matrixG.place.of, g0);
      if (ref) {
        const vec = COMPASS[PLACE_REF[matrixG.place.dir]] ?? [0, 0];
        const base = ref.node ? anchorPoint(ref.node, PLACE_REF[matrixG.place.dir]) : ref.p;
        const pt = add(base, [vec[0] * (matrixG.place.dx ?? g0.nodeDist[1]), vec[1] * (matrixG.place.dy ?? g0.nodeDist[0])]);
        mInfo.center = [0, 0];
        const off = anchorPoint(mInfo, PLACE_ANCHOR[matrixG.place.dir]);
        mInfo.center = sub(pt, off);
        origin = [mInfo.center[0] - totalW / 2, mInfo.center[1] + totalH / 2];
      }
    } else if (matrixG.anchor && matrixG.anchor !== "center") {
      mInfo.center = [0, 0];
      const off = anchorPoint(mInfo, matrixG.anchor);
      mInfo.center = sub(center, off);
      origin = [mInfo.center[0] - totalW / 2, mInfo.center[1] + totalH / 2];
    }
    if (name) this.nodes.set(name, mInfo);
    if (matrixG.doDraw || matrixG.doFill) this.scene.path(nodeOutline(mInfo, 0, matrixG.rounded), this.paint(matrixG, matrixG.doDraw, matrixG.doFill), matrixG.clips, matrixG.layer);
    let y = origin[1];
    measure.forEach((row, ri) => {
      let x = origin[0];
      const cy = y - rowH[ri] / 2;
      row.forEach((cell, ci) => {
        const cx = x + colW[ci] / 2;
        const nm = cell.name ?? (name ? `${name}-${ri + 1}-${ci + 1}` : undefined);
        if (cell.text || cell.g.doDraw || cell.g.doFill) {
          const cg = cell.g;
          cg.anchor = "center";
          cg.place = undefined;
          const info = this.node({ text: cell.text, g: cg, ...(nm ? { name: nm } : {}), off: this.off, onNext: false }, { point: [cx, cy] }, g0);
          if (info && name && cell.name) this.nodes.set(`${name}-${ri + 1}-${ci + 1}`, info);
        } else if (nm) this.nodes.set(nm, { name: nm, center: [cx, cy], shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
        x += colW[ci] + colSep;
      });
      y -= rowH[ri] + rowSep;
    });
  }

  // ------------------------------------------------------------ \pic (angles library)

  pic(stmt: string, g0: GS): void {
    const sc = new Scanner(stmt);
    const g = cloneGS(g0);
    let label: string | undefined;
    let labelOpts = "";
    let radius = 5 * (72.27 / 25.4);
    let ecc = 0.6;
    let draw = false;
    let fill: string | undefined;
    for (;;) {
      if (sc.peek() === "[") {
        for (const { key, value } of parseOptions(sc.options() ?? "")) {
          if (key.startsWith('"')) {
            const m = /^"([^"]*)"(.*)$/.exec(key + (value !== undefined ? `=${value}` : ""));
            if (m) {
              label = m[1];
              labelOpts = m[2].replace(/^\s*,?/, "");
            }
          } else if (key === "angle radius") radius = length(value ?? "5mm", CM) ?? radius;
          else if (key === "angle eccentricity") ecc = num(value ?? "0.6") ?? ecc;
          else if (key === "pic text") label = value;
          else if (key === "pic text options") labelOpts = value ?? "";
          else if (key === "draw") {
            draw = true;
            applyOptions(g, value ? `draw=${value}` : "draw", "path", this);
          } else if (key === "fill") {
            fill = value ?? "";
            applyOptions(g, value ? `fill=${value}` : "fill", "path", this);
          } else applyOptions(g, value !== undefined ? `${key}={${value}}` : key, "path", this);
        }
      } else if (sc.peek() === "(") sc.group("(");
      else if (sc.word("at")) sc.group("(");
      else break;
    }
    const body = sc.group("{") ?? "";
    const m = /^\s*(angle|right angle)\s*=\s*(.*?)\s*--\s*(.*?)\s*--\s*(.*?)\s*$/.exec(body);
    if (!m) {
      this.warnOnce(`pic:${body.slice(0, 20)}`, `\\pic {${body.trim().slice(0, 40)}} is not supported; only the angles library's angle and right angle are`);
      return;
    }
    const A = this.coord(m[2], g0)?.p;
    const B = this.coord(m[3], g0)?.p;
    const C = this.coord(m[4], g0)?.p;
    if (!A || !B || !C) return;
    const a0 = angleOf(sub(A, B));
    let a1 = angleOf(sub(C, B));
    while (a1 < a0) a1 += 360;
    g.doDraw = draw || g.doDraw;
    if (m[1] === "right angle") {
      const u = unit(sub(A, B));
      const v = unit(sub(C, B));
      const r = radius * 0.6;
      const p1 = add(B, scale(u, r));
      const p2 = add(add(B, scale(u, r)), scale(v, r));
      const p3 = add(B, scale(v, r));
      if (fill !== undefined) this.scene.path([{ t: "M", p: B }, { t: "L", p: p1 }, { t: "L", p: p2 }, { t: "L", p: p3 }, { t: "Z" }], this.paint(g, false, true), g.clips, g.layer);
      if (g.doDraw) this.strokeWithArrows([{ t: "M", p: p1 }, { t: "L", p: p2 }, { t: "L", p: p3 }], g);
    } else {
      const arc = arcCubics(B, [radius, 0], [0, radius], a0, a1);
      const segs: Seg[] = [{ t: "M", p: arc.start }, ...arc.segs.map((s) => ({ t: "C" as const, ...s }))];
      if (fill !== undefined) this.scene.path([{ t: "M", p: B }, { t: "L", p: arc.start }, ...arc.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" }], this.paint(g, false, true), g.clips, g.layer);
      if (g.doDraw) this.strokeWithArrows(segs, g);
    }
    if (label) {
      const mid = (a0 + a1) / 2;
      const p = add(B, scale(dir(mid), radius * ecc));
      const lg = nodeGS(g0);
      if (labelOpts) applyOptions(lg, labelOpts, "node", this);
      lg.anchor = lg.anchor ?? "center";
      this.node({ text: label, g: lg, off: this.off, onNext: false }, { point: p }, g0);
    }
    this.drawn++;
  }
}

const KNOWN_SHAPES = new Set(["rectangle", "circle", "ellipse", "diamond", "coordinate", "rounded rectangle", "regular polygon", "star", "trapezium", "cylinder", "circle split", "state", "isosceles triangle", "forbidden sign", "correct forbidden sign", "rectangle split", "chamfered rectangle"]);

function stripParens(s: string): string {
  const t = s.trim();
  if (t.startsWith("(") && matchClose(t, 0) === t.length - 1) return t.slice(1, -1);
  return t;
}

/** Splits matrix rows at \\ outside braces. */
function splitRows(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === "\\" && body[k + 1] === "\\" && depth === 0) {
      out.push(cur);
      cur = "";
      k++;
      const opt = /^\s*\[[^\]]*\]/.exec(body.slice(k + 1));
      if (opt) k += opt[0].length;
      continue;
    }
    if (c === "\\") {
      cur += c + (body[k + 1] ?? "");
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    cur += c;
  }
  out.push(cur);
  return out;
}

/** The index of the \end{env} matching a \begin{env} whose body starts at `from`. */
export function findEnd(s: string, from: number, env: string): { bodyEnd: number; next: number } {
  const re = /\\(begin|end)\s*\{([^}]*)\}/g;
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[2].trim() !== env) continue;
    if (m[1] === "begin") depth++;
    else if (depth-- === 0) return { bodyEnd: m.index, next: m.index + m[0].length };
  }
  return { bodyEnd: s.length, next: s.length };
}

// ---------------------------------------------------------------- node geometry

function labelAngle(a: string): { deg: number; anchor?: string } {
  const t = a.trim();
  const named: Record<string, number> = { above: 90, below: -90, left: 180, right: 0, "above left": 135, "above right": 45, "below left": -135, "below right": -45, north: 90, south: -90, east: 0, west: 180, "north east": 45, "north west": 135, "south east": -45, "south west": -135 };
  if (Object.hasOwn(named, t)) {
    const deg = named[t];
    const anchor = t.includes(" ") || DIRECTIONS.has(t) ? (PLACE_REF[t] ?? t) : t;
    return { deg, anchor };
  }
  return { deg: num(t) ?? 90 };
}

/** The compass anchor facing direction v (used to put a node beside a line). */
function compassFor(v: Pt, eight = true): string {
  const a = ((angleOf(v) % 360) + 360) % 360;
  if (!eight) return a < 45 || a >= 315 ? "east" : a < 135 ? "north" : a < 225 ? "west" : "south";
  const names = ["east", "north east", "north", "north west", "west", "south west", "south", "south east"];
  // TikZ's auto placement uses a compass anchor except near the axes, where it uses the side.
  const idx = Math.round(a / 45) % 8;
  return names[idx];
}

function rotateAnchorName(a: string, deg: number): string {
  const v = COMPASS[a];
  if (!v) return a;
  return compassFor(applyLinear(rotation(deg), v));
}

/** A point of a node: a compass anchor, an angle, base, mid or center. */
export function anchorPoint(n: NodeInfo, anchor: string): Pt {
  const a = anchor.trim();
  const named = n.anchors?.get(a);
  if (named) return add(n.center, named);
  let local: Pt;
  if (a === "center" || a === "" || a === "text") local = [0, 0];
  else if (Object.hasOwn(COMPASS, a)) {
    const v = COMPASS[a];
    switch (n.shape) {
      case "coordinate":
        local = [0, 0];
        break;
      case "circle":
      case "ellipse":
      case "regular polygon":
      case "star":
      case "circle split":
      case "state": {
        const u = unit(v);
        local = [u[0] * n.hw, u[1] * n.hh];
        break;
      }
      case "diamond":
        local = v[0] && v[1] ? [(v[0] * n.hw) / 2, (v[1] * n.hh) / 2] : [v[0] * n.hw, v[1] * n.hh];
        break;
      default:
        local = [v[0] * n.hw, v[1] * n.hh];
    }
  } else if (a === "base" || a === "mid" || a === "base west" || a === "base east" || a === "mid west" || a === "mid east") {
    const y = -n.baseDy + (a.startsWith("mid") ? 2.15 : 0);
    local = [a.endsWith("west") ? -n.hw : a.endsWith("east") ? n.hw : 0, y];
  } else {
    const deg = num(a);
    if (deg === undefined) return n.center;
    return borderPoint(n, add(n.center, applyLinear(rotation(n.rot), dir(deg))));
  }
  return add(n.center, applyLinear(rotation(n.rot), local));
}

/** Where the line from the node's centre towards `toward` leaves its outline. */
export function borderPoint(n: NodeInfo, toward: Pt): Pt {
  if (n.shape === "coordinate" || (n.hw <= 0 && n.hh <= 0)) return n.center;
  const d0 = sub(toward, n.center);
  if (Math.hypot(d0[0], d0[1]) < 1e-9) return n.center;
  const d = applyLinear(rotation(-n.rot), d0);
  let t: number;
  switch (n.shape) {
    case "circle":
    case "regular polygon":
    case "star":
    case "circle split":
    case "ellipse":
    case "state":
      t = 1 / Math.sqrt((d[0] / (n.hw || 1e-9)) ** 2 + (d[1] / (n.hh || 1e-9)) ** 2);
      break;
    case "diamond":
      t = 1 / (Math.abs(d[0]) / (n.hw || 1e-9) + Math.abs(d[1]) / (n.hh || 1e-9));
      break;
    default:
      t = Math.min(Math.abs(d[0]) > 1e-12 ? n.hw / Math.abs(d[0]) : Infinity, Math.abs(d[1]) > 1e-12 ? n.hh / Math.abs(d[1]) : Infinity);
  }
  return add(n.center, applyLinear(rotation(n.rot), scale(d, t)));
}

/** The node's outline (outer sep removed), as path segments in the picture. */
export function nodeOutline(n: NodeInfo, outer: number, rounded: number): Seg[] {
  const hw = Math.max(0, n.hw - outer);
  const hh = Math.max(0, n.hh - outer);
  const R = rotation(n.rot);
  const tr = (p: Pt): Pt => add(n.center, applyLinear(R, p));
  const poly = (pts: Pt[], r = 0): Seg[] => {
    if (r > 0) return roundPolygon(pts.map(tr), r);
    return [{ t: "M", p: tr(pts[0]) }, ...pts.slice(1).map((p) => ({ t: "L" as const, p: tr(p) })), { t: "Z" }];
  };
  switch (n.shape) {
    case "circle":
    case "ellipse":
    case "state":
    case "circle split": {
      const a = arcCubics(n.center, applyLinear(R, [hw, 0]), applyLinear(R, [0, hh]), 0, 360);
      return [{ t: "M", p: a.start }, ...a.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" }];
    }
    case "diamond":
      return poly([[hw, 0], [0, hh], [-hw, 0], [0, -hh]], rounded);
    case "regular polygon": {
      const k = n.sides ?? 5;
      const pts: Pt[] = [];
      for (let i = 0; i < k; i++) pts.push(scale(dir(90 + (360 * i) / k), hw));
      return poly(pts, rounded);
    }
    case "star": {
      const k = n.sides ?? 5;
      const pts: Pt[] = [];
      for (let i = 0; i < 2 * k; i++) pts.push(scale(dir(90 + (180 * i) / k), i % 2 ? hw * 0.4 : hw));
      return poly(pts);
    }
    case "rounded rectangle": {
      const r = hh;
      const segs: Seg[] = [];
      const right = arcCubics(tr([hw - r, 0]), applyLinear(R, [r, 0]), applyLinear(R, [0, r]), -90, 90);
      const left = arcCubics(tr([-hw + r, 0]), applyLinear(R, [r, 0]), applyLinear(R, [0, r]), 90, 270);
      segs.push({ t: "M", p: right.start }, ...right.segs.map((s) => ({ t: "C" as const, ...s })), { t: "L", p: left.start }, ...left.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" });
      return segs;
    }
    case "trapezium":
      return poly([[-hw, -hh], [hw, -hh], [hw - hh * 0.8, hh], [-hw + hh * 0.8, hh]], rounded);
    case "isosceles triangle":
      return poly([[-hw, -hh], [hw, 0], [-hw, hh]], rounded);
    case "cylinder": {
      const rx = Math.min(hh * 0.25, hw / 3);
      const segs: Seg[] = [];
      const right = arcCubics(tr([hw - rx, 0]), applyLinear(R, [rx, 0]), applyLinear(R, [0, hh]), -90, 90);
      const left = arcCubics(tr([-hw + rx, 0]), applyLinear(R, [rx, 0]), applyLinear(R, [0, hh]), 90, 270);
      const inner = arcCubics(tr([hw - rx, 0]), applyLinear(R, [rx, 0]), applyLinear(R, [0, hh]), 90, 270);
      segs.push({ t: "M", p: right.start }, ...right.segs.map((s) => ({ t: "C" as const, ...s })), { t: "L", p: left.start }, ...left.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" });
      segs.push({ t: "M", p: inner.start }, ...inner.segs.map((s) => ({ t: "C" as const, ...s })));
      return segs;
    }
    case "chamfered rectangle": {
      const c = Math.min(4, hw / 2, hh / 2);
      return poly([[-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c]]);
    }
    default:
      return poly([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], rounded);
  }
}

/** A closed polygon with its corners rounded to radius r. */
export function roundPolygon(pts: Pt[], r: number): Seg[] {
  const n = pts.length;
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const p = pts[i];
    const next = pts[(i + 1) % n];
    const r1 = Math.min(r, dist(prev, p) / 2);
    const r2 = Math.min(r, dist(p, next) / 2);
    const a = add(p, scale(unit(sub(prev, p)), r1));
    const b = add(p, scale(unit(sub(next, p)), r2));
    if (i === 0) segs.push({ t: "M", p: a });
    else segs.push({ t: "L", p: a });
    segs.push({ t: "C", c1: lerp(a, p, 0.5523), c2: lerp(b, p, 0.5523), p: b });
  }
  segs.push({ t: "Z" });
  return segs;
}

/** Rounds the corners between straight segments of a path where a radius was in force. */
export function roundCorners(segs: Seg[]): Seg[] {
  if (!segs.some((s) => (s.t === "L" || s.t === "Z") && s.r)) return segs;
  // Work subpath by subpath on M/L runs.
  const out: Seg[] = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i].t !== "M") {
      out.push(segs[i]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < segs.length && segs[j].t !== "M") j++;
    const sub_ = segs.slice(i, j);
    const allLines = sub_.slice(1).every((s) => s.t === "L" || s.t === "Z");
    if (!allLines || sub_.length < 3) {
      out.push(...sub_);
      i = j;
      continue;
    }
    const closed = sub_[sub_.length - 1].t === "Z";
    const pts: Pt[] = sub_.filter((s): s is Extract<Seg, { p: Pt }> => s.t !== "Z").map((s) => s.p);
    const radii: number[] = sub_.map((s) => (s.t === "L" || s.t === "Z" ? (s.r ?? 0) : 0));
    // Corner k (at pts[k]) uses the radius of the segment leaving it (TikZ applies the setting in force there).
    const rAt = (k: number) => radii[Math.min(k + 1, radii.length - 1)] || radii[k] || 0;
    if (closed && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
    const n = pts.length;
    const corner = (k: number): [Pt, Pt, Pt] | undefined => {
      const r = rAt(k);
      if (!r) return undefined;
      const prev = pts[(k - 1 + n) % n];
      const p = pts[k];
      const next = pts[(k + 1) % n];
      const r1 = Math.min(r, dist(prev, p) / 2);
      const r2 = Math.min(r, dist(p, next) / 2);
      return [add(p, scale(unit(sub(prev, p)), r1)), p, add(p, scale(unit(sub(next, p)), r2))];
    };
    const first = closed ? corner(0) : undefined;
    out.push({ t: "M", p: first ? first[2] : pts[0] });
    for (let k = 1; k < n; k++) {
      const c = closed || k < n - 1 ? corner(k) : undefined;
      if (c) {
        out.push({ t: "L", p: c[0] });
        out.push({ t: "C", c1: lerp(c[0], c[1], 0.5523), c2: lerp(c[2], c[1], 0.5523), p: c[2] });
      } else out.push({ t: "L", p: pts[k] });
    }
    if (closed) {
      if (first) {
        out.push({ t: "L", p: first[0] });
        out.push({ t: "C", c1: lerp(first[0], first[1], 0.5523), c2: lerp(first[2], first[1], 0.5523), p: first[2] });
      }
      out.push({ t: "Z" });
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- arrow tips on paths

/** Shortens the ends of the last subpath for its tips and returns the tips' outlines. */
export function applyTips(segs0: Seg[], spec: ArrowSpec | undefined, lw: number, shortenS: number, shortenE: number): { segs: Seg[]; tips: { segs: Seg[]; filled: boolean; lw: number }[] } {
  const segs = segs0.map((s) => ({ ...s })) as Seg[];
  const tips: { segs: Seg[]; filled: boolean; lw: number }[] = [];
  let lastM = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].t === "M") {
      lastM = i;
      break;
    }
  }
  if (lastM < 0 || lastM === segs.length - 1) return { segs, tips };
  // End.
  const endTips = spec?.end ?? [];
  const startTips = spec?.start ?? [];
  const doEnd = (tipsList: Tip[], shorten: number, atStart: boolean) => {
    const idx = atStart ? lastM + 1 : segs.length - 1;
    const s = segs[idx];
    if (s.t === "Z" || s.t === "M") return;
    const prevPt = (segs[idx - 1] as Extract<Seg, { p: Pt }>).p;
    let tipPt: Pt;
    let from: Pt;
    if (atStart) {
      tipPt = prevPt;
      from = s.t === "C" ? (dist(s.c1, prevPt) > 1e-6 ? s.c1 : dist(s.c2, prevPt) > 1e-6 ? s.c2 : s.p) : s.p;
    } else {
      tipPt = s.p;
      from = s.t === "C" ? (dist(s.c2, s.p) > 1e-6 ? s.c2 : dist(s.c1, s.p) > 1e-6 ? s.c1 : prevPt) : prevPt;
    }
    const u = unit(sub(tipPt, from));
    let back = shorten;
    tipPt = add(tipPt, scale(u, -shorten));
    let off = 0;
    let lineBack = shorten;
    tipsList.forEach((tip, k) => {
      const shp = tipShape(tip, lw);
      const at = tip.reversed ? add(tipPt, scale(u, -(off + shp.extent))) : add(tipPt, scale(u, -off));
      const dirv: Pt = tip.reversed ? scale(u, -1) : u;
      tips.push({ segs: placeTip(shp.segs, at, dirv), filled: shp.filled, lw: tip.open && shp.filled ? -shp.lineWidth : shp.lineWidth });
      if (tip.open && shp.filled) tips[tips.length - 1].filled = false;
      if (k === tipsList.length - 1) lineBack = shorten + off + (tip.reversed ? shp.extent : shp.back);
      off += shp.extent + (tip.kind === "to" ? lw : 0.5 * lw);
    });
    back = Math.max(back, lineBack);
    const len = s.t === "C" ? dist(prevPt, s.p) + 1e-9 : dist(prevPt, s.p);
    back = Math.min(back, len * 0.98);
    const shift = scale(u, -back);
    if (atStart) {
      const prev = segs[idx - 1] as Extract<Seg, { p: Pt }>;
      segs[idx - 1] = { ...prev, p: add(prev.p, shift) } as Seg;
      if (s.t === "C") segs[idx] = { ...s, c1: add(s.c1, shift) };
    } else {
      if (s.t === "C") segs[idx] = { ...s, p: add(s.p, shift), c2: add(s.c2, shift) };
      else segs[idx] = { ...s, p: add(s.p, shift) };
    }
  };
  if (endTips.length || shortenE) doEnd(endTips, shortenE, false);
  if (startTips.length || shortenS) doEnd(startTips, shortenS, true);
  return { segs, tips };
}

// ---------------------------------------------------------------- the path builder

class PathBuilder {
  segs: Seg[] = [];
  /** The logical current point (a node's centre when the path is at a node). */
  cur: Pt;
  curNode?: NodeInfo;
  /** Where the pen actually is (after clipping to a node's border). */
  pen?: Pt;
  subStart?: Pt;
  relBase: Pt;
  last: SegGeom = { kind: "point", pts: [] };
  nodes: { pn: PendingNode; where: { point: Pt; tangent?: Pt } | undefined }[] = [];
  edges: { segs: Seg[]; g: GS }[] = [];
  marks: Pt[] = [];
  /** Ranges of segs that came from plots with marks, with their state. */
  markSets: { pts: Pt[]; g: GS }[] = [];
  decorated: { segs: Seg[] }[] = [];
  /** Drawn after the path itself: circuitikz components over their wires. */
  post: (() => void)[] = [];

  constructor(
    readonly it: Interp,
    readonly g: GS,
  ) {
    this.cur = apply(g.T, [0, 0]);
    this.relBase = this.cur;
  }

  private warn(msg: string): void {
    this.it.warnOnce(`path:${msg}`, msg);
  }

  /** Reads a coordinate: (..), +(..), ++(..). */
  readCoord(sc: Scanner): Coord | undefined {
    sc.ws();
    let rel = 0;
    if (sc.s.startsWith("++", sc.i)) {
      rel = 2;
      sc.i += 2;
    } else if (sc.s[sc.i] === "+") {
      rel = 1;
      sc.i += 1;
    }
    sc.ws();
    const inner = sc.group("(");
    if (inner === undefined) return undefined;
    if (rel) {
      const c = this.it.coord(inner, this.g);
      if (!c) return undefined;
      // A relative coordinate is an offset: the translation is left out.
      const delta: Pt = [c.p[0] - this.g.T[4], c.p[1] - this.g.T[5]];
      const p = add(this.relBase, delta);
      if (rel === 2) this.relBase = p;
      return { p };
    }
    const c = this.it.coord(inner, this.g);
    if (c) this.relBase = c.p;
    return c;
  }

  /** Moves to a point (starting a subpath). */
  moveTo(c: Coord): void {
    this.segs.push({ t: "M", p: c.p });
    this.cur = c.p;
    this.curNode = c.node;
    this.pen = c.p;
    this.subStart = c.p;
    this.last = { kind: "point", pts: [c.p] };
  }

  /** The start of a drawn segment from the current point heading towards `toward`. */
  private startFrom(toward: Pt): Pt {
    const start = this.curNode ? borderPoint(this.curNode, toward) : (this.pen ?? this.cur);
    const prev = this.segs[this.segs.length - 1];
    if (!prev) this.segs.push({ t: "M", p: start });
    else if (prev.t === "M") prev.p = start;
    else if (this.curNode || !this.pen || dist(this.pen, start) > 1e-9) this.segs.push({ t: "M", p: start });
    if (this.segs.length === 1 || this.segs[this.segs.length - 1].t === "M") this.subStart = this.subStart ?? start;
    return start;
  }

  lineTo(c: Coord): void {
    const toward = c.node ? c.node.center : c.p;
    const start = this.startFrom(toward);
    const end = c.node ? borderPoint(c.node, this.curNode ? this.curNode.center : start) : c.p;
    this.segs.push({ t: "L", p: end, ...(this.g.rounded ? { r: this.g.rounded } : {}) });
    this.last = { kind: "line", pts: [start, end] };
    this.cur = c.p;
    this.curNode = c.node;
    this.pen = end;
  }

  curveTo(c1: Pt, c2: Pt, c: Coord): void {
    const start = this.startFrom(c1);
    const end = c.node ? borderPoint(c.node, c2) : c.p;
    this.segs.push({ t: "C", c1, c2, p: end });
    this.last = { kind: "curve", pts: [start, c1, c2, end] };
    this.cur = c.p;
    this.curNode = c.node;
    this.pen = end;
  }

  hv(c: Coord, vertFirst: boolean): void {
    const target = c.node ? c.node.center : c.p;
    const from = this.curNode ? this.curNode.center : (this.pen ?? this.cur);
    const corner: Pt = vertFirst ? [from[0], target[1]] : [target[0], from[1]];
    const start = this.startFrom(corner);
    const end = c.node ? borderPoint(c.node, corner) : c.p;
    const r = this.g.rounded ? { r: this.g.rounded } : {};
    this.segs.push({ t: "L", p: corner, ...r }, { t: "L", p: end, ...r });
    this.last = { kind: "hv", pts: [start, corner, end] };
    this.cur = c.p;
    this.curNode = c.node;
    this.pen = end;
  }

  /** The curve of a `to` (or edge) from the current point to c, with out/in/bend/looseness. */
  toCurve(c: Coord, g: GS): { segs: Seg[]; geom: SegGeom } {
    const fromNode = this.curNode;
    const a0 = fromNode ? fromNode.center : (this.pen ?? this.cur);
    const toNode = c.node ?? (c.p === this.cur && fromNode ? fromNode : undefined);
    const b0 = toNode ? toNode.center : c.p;
    const chord = sub(b0, a0);
    const theta = angleOf(chord);
    let outA = g.out;
    let inA = g.in;
    if (g.bend !== undefined && outA === undefined && inA === undefined) {
      outA = theta + g.bend;
      inA = theta + 180 - g.bend;
    }
    if (outA === undefined && inA === undefined && !g.loop) {
      const start = fromNode ? borderPoint(fromNode, b0) : a0;
      const end = toNode ? borderPoint(toNode, a0) : b0;
      return { segs: [{ t: "M", p: start }, { t: "L", p: end }], geom: { kind: "line", pts: [start, end] } };
    }
    const oa = outA ?? theta;
    const ia = inA ?? theta + 180;
    const start = fromNode ? borderPoint(fromNode, add(a0, dir(oa))) : a0;
    const end = toNode ? borderPoint(toNode, add(b0, dir(ia))) : b0;
    let d = dist(start, end) * 0.3915 * g.looseness;
    if (g.minDist !== undefined) d = Math.max(d, g.minDist);
    const c1 = add(start, scale(dir(oa), d));
    const c2 = add(end, scale(dir(ia), d));
    return { segs: [{ t: "M", p: start }, { t: "C", c1, c2, p: end }], geom: { kind: "curve", pts: [start, c1, c2, end] } };
  }

  /** Where `pos` falls on a segment, with the direction there. */
  static along(geom: SegGeom, pos: number): { point: Pt; tangent: Pt } {
    const p = geom.pts;
    switch (geom.kind) {
      case "line":
        return { point: lerp(p[0], p[1], pos), tangent: sub(p[1], p[0]) };
      case "curve":
        return { point: bez(p[0], p[1], p[2], p[3], pos), tangent: bezTangent(p[0], p[1], p[2], p[3], pos) };
      case "hv":
        return pos <= 0.5 ? { point: lerp(p[0], p[1], pos * 2), tangent: sub(p[1], p[0]) } : { point: lerp(p[1], p[2], pos * 2 - 1), tangent: sub(p[2], p[1]) };
      default:
        return { point: p[0] ?? [0, 0], tangent: [1, 0] };
    }
  }

  parse(text: string): void {
    let sc = new Scanner(text);
    let pendingOp: "" | "--" = "";
    while (!sc.done) {
      this.it.tick();
      const c = sc.peek();
      if (c === "[") {
        const o = sc.options() ?? "";
        applyOptions(this.g, o, "path", this.it);
        continue;
      }
      if (c === "(" || c === "+") {
        const co = this.readCoord(sc);
        if (!co) {
          // An unreadable coordinate breaks the path here.
          this.segs.push(...[]);
          pendingOp = "";
          continue;
        }
        this.moveTo(co);
        continue;
      }
      if (c === "{") {
        // A group inside a path: its options are local in TikZ; here they apply to the rest.
        const inner = sc.group("{") ?? "";
        sc = new Scanner(inner + " " + sc.s.slice(sc.i));
        continue;
      }
      if (sc.startsWith("--")) {
        sc.i += 2;
        this.segmentAfter(sc, "line");
        continue;
      }
      if (sc.startsWith("|-")) {
        sc.i += 2;
        this.segmentAfter(sc, "vh");
        continue;
      }
      if (sc.startsWith("-|")) {
        sc.i += 2;
        this.segmentAfter(sc, "hv");
        continue;
      }
      if (sc.startsWith("..")) {
        sc.i += 2;
        this.controls(sc);
        continue;
      }
      const w = sc.ident();
      switch (w) {
        case "node":
          sc.i += 4;
          this.parseNode(sc, false);
          continue;
        case "coordinate":
          sc.i += 10;
          this.parseNode(sc, false, true);
          continue;
        case "circle":
        case "ellipse":
          sc.i += w.length;
          this.circle(sc, w === "ellipse");
          continue;
        case "arc":
          sc.i += 3;
          this.arc(sc);
          continue;
        case "rectangle":
          sc.i += 9;
          this.rectangle(sc);
          continue;
        case "grid":
          sc.i += 4;
          this.grid(sc);
          continue;
        case "to":
          sc.i += 2;
          this.to(sc, false);
          continue;
        case "edge":
          sc.i += 4;
          this.to(sc, true);
          continue;
        case "plot":
          sc.i += 4;
          this.plot(sc, false);
          continue;
        case "cycle":
          sc.i += 5;
          this.cycle();
          continue;
        case "sin":
        case "cos":
          sc.i += 3;
          this.sine(sc, w);
          continue;
        case "parabola":
          sc.i += 8;
          this.parabola(sc);
          continue;
        case "foreach": {
          sc.i += 7;
          const expanded = this.pathForeach(sc);
          sc = new Scanner(expanded + " " + sc.s.slice(sc.i));
          continue;
        }
        case "let": {
          sc.i += 3;
          const rest = this.letOp(sc);
          sc = new Scanner(rest);
          continue;
        }
        case "pic": {
          sc.i += 3;
          // pic [options] (name) at (p) {kind}: drawn as \pic.
          const from = sc.i;
          for (;;) {
            sc.ws();
            if (sc.s[sc.i] === "[") sc.options();
            else if (sc.s[sc.i] === "(") sc.group("(");
            else if (sc.word("at")) sc.group("(");
            else break;
          }
          sc.group("{");
          this.it.pic(sc.s.slice(from, sc.i), this.g);
          continue;
        }
        case "child":
          if (this.it.treeHandler) {
            this.it.treeHandler(this.it, { where: { point: this.pen ?? this.cur } }, sc, this.g);
            continue;
          }
          sc.i += 5;
          this.it.warnOnce("child", "Trees (child) are not supported; the children were skipped", "Place the nodes with positioning (below=of ...) and connect them with \\draw");
          sc.options();
          sc.group("{");
          continue;
        case "svg":
        case "decorate":
          sc.i += w.length;
          sc.options();
          sc.group("{");
          this.warn(`path operation ${w} is not supported and was skipped`);
          continue;
        default: {
          // Something else: skip one token.
          const rest = sc.s.slice(sc.i, sc.i + 30).trim();
          this.warn(`cannot read "${rest.slice(0, 20)}" in a path; it was skipped`);
          const m = /^\\?[A-Za-z]+|^./.exec(sc.s.slice(sc.i));
          sc.i += m ? m[0].length : 1;
        }
      }
    }
    void pendingOp;
  }

  private segmentAfter(sc: Scanner, kind: "line" | "vh" | "hv"): void {
    const pending: PendingNode[] = [];
    for (;;) {
      sc.ws();
      if (sc.s[sc.i] === "[") {
        applyOptions(this.g, sc.options() ?? "", "path", this.it);
        continue;
      }
      if (sc.startsWith("node") && !/[A-Za-z]/.test(sc.s[sc.i + 4] ?? "")) {
        sc.i += 4;
        const pn = this.readNode(sc, false);
        if (pn) {
          pn.onNext = true;
          pending.push(pn);
        }
        continue;
      }
      if (sc.startsWith("coordinate") && !/[A-Za-z]/.test(sc.s[sc.i + 10] ?? "")) {
        sc.i += 10;
        const pn = this.readNode(sc, true);
        if (pn) {
          pn.onNext = true;
          pending.push(pn);
        }
        continue;
      }
      break;
    }
    if (sc.word("cycle")) {
      if (kind === "line") this.cycle();
      else if (this.subStart) this.hv({ p: this.subStart }, kind === "vh");
      this.placePending(pending);
      return;
    }
    if (sc.startsWith("plot")) {
      sc.i += 4;
      this.plot(sc, true);
      return;
    }
    const target = this.readCoord(sc);
    if (!target) {
      this.warn("a path operation is missing its target coordinate");
      return;
    }
    if (kind === "line") this.lineTo(target);
    else this.hv(target, kind === "vh");
    this.placePending(pending);
  }

  private placePending(pending: PendingNode[]): void {
    for (const pn of pending) {
      const pos = pn.g.pos ?? 0.5;
      const w = PathBuilder.along(this.last, pos);
      this.nodes.push({ pn, where: w });
      this.registerEarly(pn, w);
    }
  }

  /** Nodes are drawn after the path, but their names exist at once (an edge later in the path may use them). */
  private registerEarly(pn: PendingNode, where: { point: Pt; tangent?: Pt } | undefined): void {
    if (!pn.name || this.it.nodes.has(pn.name)) return;
    const p = pn.at?.p ?? where?.point ?? this.cur;
    // A circuitikz shape's anchors (opamp.out) can be used later in the same path.
    const circ = this.it.circuit?.layout(this.it, pn, where, this.g);
    this.it.nodes.set(pn.name, circ ?? { name: pn.name, center: p, shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
  }

  private cycle(): void {
    if (!this.subStart) return;
    const start = this.subStart;
    const p = this.pen ?? this.cur;
    if (dist(p, start) > 1e-9) this.segs.push({ t: "L", p: start, ...(this.g.rounded ? { r: this.g.rounded } : {}) });
    // Z returns to the last move: after a gap (a circuitikz component) the line to the start already closes the path.
    let k = this.segs.length - 1;
    while (k > 0 && this.segs[k].t !== "M") k--;
    const m = this.segs[k];
    if (m?.t !== "M" || dist(m.p, start) < 1e-9) this.segs.push({ t: "Z", ...(this.g.rounded ? { r: this.g.rounded } : {}) });
    this.last = { kind: "line", pts: [p, start] };
    this.cur = start;
    this.pen = start;
    this.curNode = undefined;
  }

  private controls(sc: Scanner): void {
    if (!sc.word("controls")) {
      // `.. (p)` without controls: a straight connection.
      const t = this.readCoord(sc);
      if (t) this.lineTo(t);
      return;
    }
    sc.ws();
    const rel1 = sc.s.startsWith("+", sc.i);
    const c1raw = this.readRaw(sc);
    let c2raw: { text: string; rel: number } | undefined;
    if (sc.word("and")) c2raw = this.readRaw(sc);
    if (!sc.startsWith("..")) {
      this.warn(".. controls needs a closing ..");
      return;
    }
    sc.i += 2;
    if (sc.word("cycle")) {
      if (!this.subStart || !c1raw) return;
      const start = this.pen ?? this.cur;
      const c1 = this.resolveRaw(c1raw, start);
      const c2 = c2raw ? this.resolveRaw(c2raw, this.subStart) : c1;
      if (!c1 || !c2) return;
      this.curveTo(c1, c2, { p: this.subStart });
      this.segs.push({ t: "Z" });
      return;
    }
    // The end point is read first: a relative second control point is relative to it.
    const save = this.relBase;
    const target = this.readCoord(sc);
    if (!target || !c1raw) {
      this.warn(".. controls is missing a point");
      return;
    }
    const start = this.curNode ? this.curNode.center : (this.pen ?? this.cur);
    const c1 = this.resolveRaw(c1raw, rel1 ? start : save);
    const c2 = c2raw ? this.resolveRaw(c2raw, target.p) : c1;
    if (!c1 || !c2) return;
    this.curveTo(c1, c2, target);
  }

  private readRaw(sc: Scanner): { text: string; rel: number } | undefined {
    sc.ws();
    let rel = 0;
    if (sc.s.startsWith("++", sc.i)) {
      rel = 2;
      sc.i += 2;
    } else if (sc.s[sc.i] === "+") {
      rel = 1;
      sc.i++;
    }
    const t = sc.group("(");
    return t === undefined ? undefined : { text: t, rel };
  }

  private resolveRaw(r: { text: string; rel: number }, base: Pt): Pt | undefined {
    const c = this.it.coord(r.text, this.g);
    if (!c) return undefined;
    if (!r.rel) return c.p;
    return add(base, [c.p[0] - this.g.T[4], c.p[1] - this.g.T[5]]);
  }

  /** node[opts] (name) at (p) {text}, as it appears in a path. */
  readNode(sc: Scanner, coordinate: boolean): PendingNode | undefined {
    const g = nodeGS(this.g);
    let name: string | undefined;
    let at: Coord | undefined;
    const optsList: string[] = [];
    const off = this.it.off;
    for (;;) {
      sc.ws();
      const c = sc.s[sc.i];
      if (c === "[") optsList.push(sc.options() ?? "");
      else if (c === "(") name = (sc.group("(") ?? "").trim();
      else if (sc.word("at")) {
        const inner = sc.group("(");
        at = inner !== undefined ? this.it.coord(inner, this.g) : undefined;
      } else break;
    }
    let text = "";
    if (!coordinate) {
      sc.ws();
      if (sc.s[sc.i] === "{") text = sc.group("{") ?? "";
      else {
        this.warn("a node needs its text in braces, as in node {text}");
        return undefined;
      }
    }
    // every node style, nodes={...} of the path, then the node's own options.
    if (coordinate) g.shape = "coordinate";
    const every = g.styles.get("every node");
    if (every?.body) applyOptions(g, every.body, "node", this.it);
    for (const o of this.g.nodesOpts) applyOptions(g, o, "node", this.it);
    for (const o of optsList) applyOptions(g, o, "node", this.it);
    if (coordinate) g.shape = "coordinate";
    if (g.shape !== "rectangle") {
      const shapeStyle = g.styles.get(`every ${g.shape} node`);
      if (shapeStyle?.body) applyOptions(g, shapeStyle.body, "node", this.it);
    }
    return { text, g, ...(name ? { name } : {}), ...(at ? { at } : {}), off, onNext: false };
  }

  private parseNode(sc: Scanner, _pending: boolean, coordinate = false): void {
    const pn = this.readNode(sc, coordinate);
    if (!pn) return;
    let where: { point: Pt; tangent?: Pt } | undefined;
    if (pn.at) where = undefined;
    else if (pn.g.pos !== undefined && this.last.kind !== "point") where = PathBuilder.along(this.last, pn.g.pos);
    else where = { point: this.pen ?? this.cur };
    if (!pn.at && pn.g.pos === undefined && this.curNode && !pn.g.place) where = { point: this.cur };
    this.nodes.push({ pn, where });
    this.registerEarly(pn, where);
    // Trees: the node is the root, drawn with its children (options may come between).
    const look = new Scanner(sc.s);
    look.i = sc.i;
    while (look.peek() === "[") look.options();
    if (/^child(?![A-Za-z])/.test(look.s.slice(look.i, look.i + 6)) && this.it.treeHandler) {
      this.nodes.pop();
      this.it.treeHandler(this.it, { pn, ...(where ? { where } : {}) }, sc, this.g);
    }
    for (;;) {
      if (!sc.startsWith("child")) break;
      sc.i += 5;
      this.it.warnOnce("child", "Trees (child) are not supported; the children were skipped", "Place the nodes with positioning (below=of ...) and connect them with \\draw");
      sc.options();
      sc.group("{");
    }
    // After a \node, the path continues at the node.
    if (pn.at && !this.segs.length) {
      this.cur = pn.at.p;
      this.relBase = pn.at.p;
    }
  }

  private circle(sc: Scanner, ellipse: boolean): void {
    const g = cloneGS(this.g);
    const o = sc.options();
    if (o) applyOptions(g, o, "path", this.it);
    let rx: [number, boolean] | undefined = g.xradius ?? g.radius;
    let ry: [number, boolean] | undefined = g.yradius ?? g.radius;
    sc.ws();
    if (sc.s[sc.i] === "(") {
      const inner = sc.group("(") ?? "";
      const parts = inner.split(/\s+and\s+/);
      try {
        const a = evaluate(this.it.expand(parts[0]));
        rx = [a.v, a.dim];
        const b = parts[1] !== undefined ? evaluate(this.it.expand(parts[1])) : a;
        ry = [b.v, b.dim];
      } catch (e) {
        this.warn(`cannot read the radius (${inner}): ${(e as Error).message}`);
        return;
      }
    }
    if (!rx || !ry) {
      if (!ellipse) {
        rx = ry = [1, false];
      } else {
        this.warn("an ellipse needs its radii, as in ellipse (2 and 1)");
        return;
      }
    }
    const center = this.curNode ? this.curNode.center : this.cur;
    const ex = rx[1] ? applyLinear(g.T, [rx[0], 0]) : applyLinear(g.T, scale(g.xv, rx[0]));
    const ey = ry[1] ? applyLinear(g.T, [0, ry[0]]) : applyLinear(g.T, scale(g.yv, ry[0]));
    const a = arcCubics(center, ex, ey, 0, 360);
    this.segs.push({ t: "M", p: a.start }, ...a.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" });
    this.pen = center;
    this.cur = center;
    this.last = { kind: "point", pts: [center] };
    // The path continues from the centre, without drawing to it.
    this.segs.push({ t: "M", p: center });
    this.curNode = undefined;
  }

  private arc(sc: Scanner): void {
    const g = cloneGS(this.g);
    const o = sc.options();
    if (o) applyOptions(g, o, "path", this.it);
    let s0 = g.startAngle;
    let s1 = g.endAngle;
    let rx = g.xradius ?? g.radius;
    let ry = g.yradius ?? g.radius;
    sc.ws();
    if (sc.s[sc.i] === "(") {
      const inner = sc.group("(") ?? "";
      const parts = splitTop(inner, ":");
      if (parts.length !== 3) {
        this.warn(`cannot read arc (${inner}); write arc (start:end:radius)`);
        return;
      }
      s0 = num(this.it.expand(parts[0]));
      s1 = num(this.it.expand(parts[1]));
      const radii = parts[2].split(/\s+and\s+/);
      try {
        const a = evaluate(this.it.expand(radii[0]));
        rx = [a.v, a.dim];
        const b = radii[1] !== undefined ? evaluate(this.it.expand(radii[1])) : a;
        ry = [b.v, b.dim];
      } catch {
        this.warn(`cannot read the radius in arc (${inner})`);
        return;
      }
    }
    if (s0 === undefined) s0 = s1 !== undefined && g.deltaAngle !== undefined ? s1 - g.deltaAngle : 0;
    if (s1 === undefined) s1 = s0 + (g.deltaAngle ?? 90);
    if (!rx) rx = [1, false];
    if (!ry) ry = rx;
    const ex = rx[1] ? applyLinear(g.T, [rx[0], 0]) : applyLinear(g.T, scale(g.xv, rx[0]));
    const ey = ry[1] ? applyLinear(g.T, [0, ry[0]]) : applyLinear(g.T, scale(g.yv, ry[0]));
    const startPt = this.pen ?? this.cur;
    const r0 = (s0 * Math.PI) / 180;
    const center: Pt = [startPt[0] - ex[0] * Math.cos(r0) - ey[0] * Math.sin(r0), startPt[1] - ex[1] * Math.cos(r0) - ey[1] * Math.sin(r0)];
    const a = arcCubics(center, ex, ey, s0, s1);
    if (!this.segs.length) this.segs.push({ t: "M", p: startPt });
    for (const s of a.segs) this.segs.push({ t: "C", ...s });
    const end = a.segs.length ? a.segs[a.segs.length - 1].p : startPt;
    const lastSeg = a.segs[a.segs.length - 1];
    if (lastSeg) this.last = { kind: "curve", pts: [a.segs.length > 1 ? a.segs[a.segs.length - 2].p : startPt, lastSeg.c1, lastSeg.c2, lastSeg.p] };
    this.cur = end;
    this.pen = end;
    this.relBase = end;
    this.curNode = undefined;
  }

  private rectangle(sc: Scanner): void {
    const pending: PendingNode[] = [];
    for (;;) {
      sc.ws();
      if (sc.startsWith("node") && !/[A-Za-z]/.test(sc.s[sc.i + 4] ?? "")) {
        sc.i += 4;
        const pn = this.readNode(sc, false);
        if (pn) pending.push(pn);
        continue;
      }
      break;
    }
    const target = this.readCoord(sc);
    if (!target) {
      this.warn("rectangle needs its opposite corner, as in rectangle (2,1)");
      return;
    }
    const a = this.curNode ? this.curNode.center : (this.pen ?? this.cur);
    const b = target.p;
    const inv = invert(this.g.T);
    const qa = apply(inv, a);
    const qb = apply(inv, b);
    const c2 = apply(this.g.T, [qb[0], qa[1]]);
    const c4 = apply(this.g.T, [qa[0], qb[1]]);
    const r = this.g.rounded ? { r: this.g.rounded } : {};
    const prev = this.segs[this.segs.length - 1];
    if (prev && prev.t === "M") prev.p = a;
    else this.segs.push({ t: "M", p: a });
    this.segs.push({ t: "L", p: c2, ...r }, { t: "L", p: b, ...r }, { t: "L", p: c4, ...r }, { t: "L", p: a, ...r }, { t: "Z", ...r });
    this.segs.push({ t: "M", p: b });
    this.last = { kind: "line", pts: [a, b] };
    this.subStart = b;
    this.cur = b;
    this.pen = b;
    this.curNode = undefined;
    for (const pn of pending) this.nodes.push({ pn, where: { point: lerp(a, b, pn.g.pos ?? 0.5) } });
  }

  private grid(sc: Scanner): void {
    const g = cloneGS(this.g);
    const o = sc.options();
    if (o) applyOptions(g, o, "path", this.it);
    const target = this.readCoord(sc);
    if (!target) return;
    const inv = invert(g.T);
    const a = apply(inv, this.pen ?? this.cur);
    const b = apply(inv, target.p);
    const [sx, sy] = g.step;
    const x0 = Math.min(a[0], b[0]);
    const x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]);
    const y1 = Math.max(a[1], b[1]);
    const out: Seg[] = [];
    const eps = 1e-6;
    if ((x1 - x0) / sx >= 2000 || (y1 - y0) / sy >= 2000) this.warn("the grid step is too small for the grid; those lines were left out");
    if (sx > 0.01 && (x1 - x0) / sx < 2000) {
      for (let x = Math.ceil(x0 / sx - eps) * sx; x <= x1 + eps; x += sx) out.push({ t: "M", p: apply(g.T, [x, y0]) }, { t: "L", p: apply(g.T, [x, y1]) });
    }
    if (sy > 0.01 && (y1 - y0) / sy < 2000) {
      for (let y = Math.ceil(y0 / sy - eps) * sy; y <= y1 + eps; y += sy) out.push({ t: "M", p: apply(g.T, [x0, y]) }, { t: "L", p: apply(g.T, [x1, y]) });
    }
    this.it.tick(out.length);
    this.segs.push(...out);
    this.segs.push({ t: "M", p: target.p });
    this.cur = target.p;
    this.pen = target.p;
    this.curNode = undefined;
    this.last = { kind: "point", pts: [target.p] };
  }

  /** `to` and `edge`. */
  private to(sc: Scanner, edge: boolean): void {
    const g = edge ? cloneGS(this.g) : cloneGS(this.g);
    if (edge) {
      g.doDraw = true;
      g.doFill = false;
      g.shade = undefined;
      g.out = g.in = g.bend = undefined;
      g.labels = [];
      const every = g.styles.get("every edge");
      if (every?.body) applyOptions(g, every.body, "path", this.it);
    }
    const pending: PendingNode[] = [];
    g.labels = [];
    let bip: Bipole | undefined;
    for (;;) {
      sc.ws();
      if (sc.s[sc.i] === "[") {
        let o = sc.options() ?? "";
        // circuitikz: to[R=$R_1$, i=$i$, *-o] is a bipole (circuit.ts); the TikZ keys stay.
        if (this.it.circuit && !edge) {
          const r = this.it.circuit.toOptions(this.it, o, g);
          o = r.rest;
          bip = r.bipole ?? bip;
        }
        applyOptions(g, o, "path", this.it);
        continue;
      }
      if (sc.startsWith("node") && !/[A-Za-z]/.test(sc.s[sc.i + 4] ?? "")) {
        sc.i += 4;
        const pn = this.readNodeWith(sc, g);
        if (pn) pending.push(pn);
        continue;
      }
      break;
    }
    if (g.loop && g.out === undefined) {
      g.out = 105;
      g.in = 75;
    }
    // Quoted labels from the options.
    for (const l of g.labels.filter((x) => x.angle === "quote")) {
      const lg = nodeGS(g);
      const every = lg.styles.get("every node");
      if (every?.body) applyOptions(lg, every.body, "node", this.it);
      if (!lg.auto) lg.auto = "left";
      applyOptions(lg, l.opts, "node", this.it);
      pending.push({ text: l.text, g: lg, off: this.it.off, onNext: true });
    }
    let target: Coord | undefined;
    sc.ws();
    if (sc.word("cycle")) target = this.subStart ? { p: this.subStart } : undefined;
    else if (sc.startsWith("()")) {
      sc.i += 2;
      target = { p: this.cur, ...(this.curNode ? { node: this.curNode } : {}) };
    } else target = this.readCoord(sc);
    if (!target) {
      this.warn(`${edge ? "edge" : "to"} needs a target coordinate`);
      return;
    }
    const savedRel = this.relBase;
    if (bip) {
      this.bipole(bip, target, g, pending);
      return;
    }
    const { segs, geom } = this.toCurve(target, g);
    if (edge) {
      this.edges.push({ segs, g });
      for (const pn of pending) {
        const pos = pn.g.pos ?? 0.5;
        const w = PathBuilder.along(geom, pos);
        this.nodes.push({ pn, where: w });
      }
      // An edge leaves the current point where it was.
      this.relBase = savedRel;
      return;
    }
    // Join the `to` curve onto the path.
    const startP = (segs[0] as Extract<Seg, { p: Pt }>).p;
    const prev = this.segs[this.segs.length - 1];
    if (!prev) this.segs.push({ t: "M", p: startP });
    else if (prev.t === "M") prev.p = startP;
    else if (this.curNode || dist(this.pen ?? this.cur, startP) > 1e-9) this.segs.push({ t: "M", p: startP });
    if (this.segs.length === 1) this.subStart = startP;
    const s1 = segs[1];
    if (s1.t === "L") this.segs.push({ ...s1, ...(this.g.rounded ? { r: this.g.rounded } : {}) });
    else this.segs.push(s1);
    this.last = geom;
    this.cur = target.p;
    this.curNode = target.node;
    this.pen = (s1 as Extract<Seg, { p: Pt }>).p;
    for (const pn of pending) {
      const pos = pn.g.pos ?? 0.5;
      const w = PathBuilder.along(geom, pos);
      this.nodes.push({ pn, where: w });
      this.registerEarly(pn, w);
    }
  }

  /** A circuitikz bipole: its wires join the path, the component is drawn over them after the path. */
  private bipole(bip: Bipole, target: Coord, g: GS, pending: PendingNode[]): void {
    const a = this.curNode ? borderPoint(this.curNode, target.p) : (this.pen ?? this.cur);
    const b = target.node ? borderPoint(target.node, a) : target.p;
    const r = this.it.circuit!.bipole(this.it, bip, a, b, g);
    const prev = this.segs[this.segs.length - 1];
    let segs = r.segs;
    // Continue the path without a move when it already ends where the bipole starts (corners then join).
    if (prev && prev.t !== "M" && !this.curNode && dist(this.pen ?? this.cur, a) < 1e-9 && segs[0]?.t === "M") segs = segs.slice(1);
    else if (prev?.t === "M") this.segs.pop();
    if (!this.segs.length) this.subStart = a;
    this.segs.push(...segs);
    this.post.push(r.draw);
    this.last = { kind: "line", pts: [a, b] };
    this.cur = target.p;
    this.curNode = target.node;
    this.pen = b;
    for (const pn of pending) {
      const w = PathBuilder.along(this.last, pn.g.pos ?? 0.5);
      this.nodes.push({ pn, where: w });
      this.registerEarly(pn, w);
    }
  }

  private readNodeWith(sc: Scanner, g: GS): PendingNode | undefined {
    const saved = this.g.nodesOpts;
    const pn = this.readNode(sc, false);
    if (!pn) return undefined;
    // Labels of edges inherit `auto`, `swap` and colours from the edge.
    if (g.auto && !pn.g.auto) pn.g.auto = g.auto;
    void saved;
    pn.onNext = true;
    return pn;
  }

  private plot(sc: Scanner, connect: boolean): void {
    const g = cloneGS(this.g);
    const o = sc.options();
    if (o) applyOptions(g, o, "path", this.it);
    sc.ws();
    let pts: Pt[] = [];
    if (sc.word("coordinates")) {
      const body = sc.group("{") ?? "";
      for (const m of body.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
        const c = this.it.coord(m[1], g);
        if (c) pts.push(c.p);
        if (pts.length > 10000) break;
      }
    } else if (sc.word("function")) {
      sc.group("{");
      this.it.warnOnce("plot-function", "plot function{...} needs gnuplot and was skipped", "Write plot (\\x, {expression}) instead");
      return;
    } else if (sc.word("file")) {
      sc.group("{");
      this.it.warnOnce("plot-file", "plot file{...} is not supported and was skipped");
      return;
    } else if (sc.s[sc.i] === "(") {
      const expr = sc.group("(") ?? "";
      const v = g.variable;
      const xs: number[] = g.samplesAt ?? [];
      if (!xs.length) {
        const [a, b] = g.domain;
        const n = Math.max(2, Math.min(2000, g.samples));
        for (let i = 0; i < n; i++) xs.push(a + ((b - a) * i) / (n - 1));
      }
      const parts = splitTop(expr, ",");
      this.it.tick(xs.length);
      for (const x of xs) {
        const vars = { [v]: x };
        try {
          const comps = parts.map((p) => {
            const t = unbrace(this.it.expand(p.split(`\\${v}`).join(`(${x})`)));
            return evaluate(t, vars);
          });
          if (comps.length === 2) {
            const px: Pt = comps[0].dim ? [comps[0].v, 0] : scale(g.xv, comps[0].v);
            const py: Pt = comps[1].dim ? [0, comps[1].v] : scale(g.yv, comps[1].v);
            pts.push(apply(g.T, add(px, py)));
          } else if (comps.length === 1 && splitTop(expr, ":").length === 2) {
            const c = this.it.coord(expr.split(`\\${v}`).join(`(${x})`), g);
            if (c) pts.push(c.p);
          }
        } catch {
          // Points where the expression is undefined are left out.
        }
      }
      if (!pts.length) this.warn(`plot (${expr.trim().slice(0, 40)}) gave no points`);
    } else {
      this.warn("cannot read this plot; write plot coordinates {...} or plot (\\x, {f(\\x)})");
      return;
    }
    if (!pts.length) return;
    if (g.onlyMarks) {
      this.markSets.push({ pts, g });
      if (pts.length) this.cur = pts[pts.length - 1];
      return;
    }
    if (g.smooth && pts.length > 2) {
      if (connect) this.lineTo({ p: pts[0] });
      else this.moveTo({ p: pts[0] });
      for (const s of smoothThrough(pts, g.smoothCycle, g.tension)) this.segs.push({ t: "C", ...s });
      if (g.smoothCycle) this.segs.push({ t: "Z" });
    } else {
      if (connect) this.lineTo({ p: pts[0] });
      else this.moveTo({ p: pts[0] });
      for (const p of pts.slice(1)) this.segs.push({ t: "L", p });
    }
    const end = pts[pts.length - 1];
    this.cur = end;
    this.pen = end;
    this.relBase = end;
    this.last = { kind: "line", pts: [pts[Math.max(0, pts.length - 2)], end] };
    if (g.mark) this.markSets.push({ pts, g });
  }

  private sine(sc: Scanner, kind: string): void {
    const t = this.readCoord(sc);
    if (!t) return;
    const a = this.pen ?? this.cur;
    const d = sub(t.p, a);
    const P = (u: number, v: number): Pt => [a[0] + d[0] * u, a[1] + d[1] * v];
    if (kind === "sin") this.segs.push({ t: "C", c1: P(0.3343, 0.5251), c2: P(0.6401, 1), p: t.p });
    else this.segs.push({ t: "C", c1: P(0.3599, 0), c2: P(0.6657, 0.4749), p: t.p });
    this.cur = this.pen = t.p;
    this.curNode = undefined;
  }

  private parabola(sc: Scanner): void {
    let bend: Pt | undefined;
    if (sc.word("bend")) bend = this.readCoord(sc)?.p;
    const t = this.readCoord(sc);
    if (!t) return;
    const a = this.pen ?? this.cur;
    const quad = (p0: Pt, p1: Pt, p2: Pt): Seg => ({ t: "C", c1: lerp(p0, p1, 2 / 3), c2: lerp(p2, p1, 2 / 3), p: p2 });
    if (!bend) bend = a;
    if (dist(bend, a) > 1e-9) this.segs.push(quad(a, [(a[0] + bend[0]) / 2, bend[1]], bend));
    if (dist(bend, t.p) > 1e-9) this.segs.push(quad(bend, [(bend[0] + t.p[0]) / 2, bend[1]], t.p));
    this.cur = this.pen = t.p;
    this.curNode = undefined;
  }

  /** foreach inside a path: the expansion of its body for every item. */
  private pathForeach(sc: Scanner): string {
    const head = this.it.foreachHead(sc);
    if (!head) {
      this.warn("cannot read a foreach inside a path");
      return "";
    }
    const body = sc.group("{") ?? "";
    let out = "";
    this.it.loop(head, (vars) => {
      let b = body;
      for (const [k, v] of vars) b = b.replace(new RegExp(`\\\\${k}(?![A-Za-z@])`, "g"), () => v);
      out += ` ${this.it.expand(b)}`;
      if (out.length > 1_000_000) throw new Stop("foreach inside a path grows too large");
    });
    return out;
  }

  /** let \p1 = (a), \n1 = {expr} in ...: defines the names for the rest of the path. */
  private letOp(sc: Scanner): string {
    const defs: [string, string][] = [];
    for (;;) {
      sc.ws();
      const m = /^\\([pnxy])(\d+|\{[^}]*\})\s*=\s*/.exec(sc.s.slice(sc.i, sc.i + 40));
      if (!m) break;
      sc.i += m[0].length;
      const id = m[2].replace(/[{}]/g, "");
      if (m[1] === "p") {
        sc.ws();
        let text = "";
        if (sc.s[sc.i] === "(") text = sc.group("(") ?? "";
        const c = this.it.coord(text, this.g);
        const p = c?.p ?? [0, 0];
        const inv = invert(this.g.T);
        const q = apply(inv, p);
        defs.push([`p${id}`, `${fmt(q[0])}pt,${fmt(q[1])}pt`], [`x${id}`, `${fmt(q[0])}pt`], [`y${id}`, `${fmt(q[1])}pt`]);
      } else {
        const e = sc.group("{") ?? "0";
        try {
          const r = evaluate(this.it.expand(e));
          defs.push([`n${id}`, r.dim ? `${fmt(r.v)}pt` : fmt(r.v)]);
        } catch {
          defs.push([`n${id}`, "0"]);
        }
      }
      sc.ws();
      if (sc.s[sc.i] === ",") sc.i++;
    }
    sc.word("in");
    let rest = sc.s.slice(sc.i);
    for (const [k, v] of defs) {
      const re = k.length > 2 ? new RegExp(`\\\\${k[0]}\\{${k.slice(1)}\\}`, "g") : new RegExp(`\\\\${k[0]}${k.slice(1)}(?![0-9])`, "g");
      rest = rest.replace(re, () => v).replace(new RegExp(`\\\\${k[0]}${k.slice(1)}(?![0-9])`, "g"), () => v);
    }
    return rest;
  }

  /** Draws what the path collected: the path itself, decorations, marks, edges, then its nodes. */
  finish(): void {
    const it = this.it;
    const g = this.g;
    let segs = roundCorners(this.segs.filter((s, i, a) => !(s.t === "M" && (i === a.length - 1 || a[i + 1].t === "M"))));
    const hasDrawing = segs.some((s) => s.t !== "M");
    if (g.doClip && hasDrawing) {
      const id = it.scene.clipPath(segs);
      // A \clip limits everything after it in the scope: the caller's state carries the clip.
      this.clipInto(id);
    }
    if (g.useAsBox && hasDrawing) {
      it.scene.fixedBox = segsBox(segs);
    }
    if (hasDrawing && (g.doDraw || g.doFill || g.shade)) {
      if ((g.decorate || g.postDecorate) && g.decoration?.kind) {
        const dec = decorate(segs, g.decoration, g.lw);
        if (dec.marks.length) {
          for (const m of dec.marks) {
            const tip = parseTip(m.tip === ">" ? "stealth" : m.tip) ?? g.defTip;
            const t = m.reversed ? { ...tip, reversed: !tip.reversed } : tip;
            const shp = tipShape(t.kind === "to" ? { ...t, kind: "stealth" } : t, g.lw);
            const u = m.reversed ? scale(m.dir, -1) : m.dir;
            const at = add(m.at, scale(u, shp.extent / 2));
            const color = g.drawColor ?? g.color;
            it.scene.path(placeTip(shp.segs, at, u), { fill: color, stroke: color, lineWidth: g.lw * 0.6 }, g.clips, g.layer);
          }
        }
        if (g.decorate) segs = dec.segs;
      }
      if (g.doDraw) it.strokeWithArrows(segs, g, g.doFill || !!g.shade);
      else if (it.scene.path(segs, it.paint(g, false, true), g.clips, g.layer)) it.drawn++;
    } else if (hasDrawing && !g.doClip && !g.useAsBox) {
      // \path without draw or fill still sets the bounding box.
      it.scene.add("<g/>", segsBox(segs), g.clips, g.layer);
    }
    for (const ms of this.markSets) drawMarks(it, ms.pts, ms.g);
    for (const f of this.post) f();
    for (const e of this.edges) {
      it.strokeWithArrows(e.segs, e.g);
    }
    for (const { pn, where } of this.nodes) {
      if (pn.name && it.nodes.get(pn.name)?.shape === "coordinate" && it.nodes.get(pn.name)?.hw === 0) it.nodes.delete(pn.name);
      it.node(pn, where, g);
    }
  }

  private clipInto(id: string): void {
    // The clip applies to the rest of the enclosing scope: record it on the scope's state.
    this.it.pendingClip = id;
  }
}

/** Reads `[options] (name) at (p) {text}` after the word node (or coordinate) against the path state `g`, as a path would. */
export function readNodeSpec(it: Interp, g: GS, sc: Scanner, coordinate = false): PendingNode | undefined {
  return new PathBuilder(it, g).readNode(sc, coordinate);
}

/** Plot marks at points. */
export function drawMarks(it: Interp, pts: Pt[], g0: GS): void {
  const g = cloneGS(g0);
  g.dash = undefined;
  g.dashPattern = undefined;
  g.arrows = undefined;
  for (const o of g.markOpts) applyOptions(g, o, "path", it);
  const kind = (g.mark ?? "*").trim();
  const r = g.markSize;
  const color = g.drawColor ?? g.color;
  const fillColor = g.fillColor ?? color;
  const lw = Math.min(g.lw, 0.8);
  const shape = (p: Pt): { segs: Seg[]; fill: boolean } => {
    const c = (dx: number, dy: number): Pt => [p[0] + dx, p[1] + dy];
    const circ = (rr: number): Seg[] => {
      const a = arcCubics(p, [rr, 0], [0, rr], 0, 360);
      return [{ t: "M", p: a.start }, ...a.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" }];
    };
    switch (kind) {
      case "*":
      case "ball":
        return { segs: circ(r), fill: true };
      case "o":
        return { segs: circ(r), fill: false };
      case "square*":
      case "square":
        return { segs: [{ t: "M", p: c(-r, -r) }, { t: "L", p: c(r, -r) }, { t: "L", p: c(r, r) }, { t: "L", p: c(-r, r) }, { t: "Z" }], fill: kind.endsWith("*") };
      case "triangle*":
      case "triangle":
        return { segs: [{ t: "M", p: c(0, r * 1.2) }, { t: "L", p: c(r * 1.04, -r * 0.6) }, { t: "L", p: c(-r * 1.04, -r * 0.6) }, { t: "Z" }], fill: kind.endsWith("*") };
      case "diamond*":
      case "diamond":
        return { segs: [{ t: "M", p: c(0, r * 1.2) }, { t: "L", p: c(r * 0.8, 0) }, { t: "L", p: c(0, -r * 1.2) }, { t: "L", p: c(-r * 0.8, 0) }, { t: "Z" }], fill: kind.endsWith("*") };
      case "pentagon*":
      case "pentagon": {
        const pts: Pt[] = [];
        for (let i = 0; i < 5; i++) pts.push(add(p, scale(dir(90 + 72 * i), r)));
        return { segs: [{ t: "M", p: pts[0] }, ...pts.slice(1).map((q) => ({ t: "L" as const, p: q })), { t: "Z" }], fill: kind.endsWith("*") };
      }
      case "x":
        return { segs: [{ t: "M", p: c(-r, -r) }, { t: "L", p: c(r, r) }, { t: "M", p: c(-r, r) }, { t: "L", p: c(r, -r) }], fill: false };
      case "+":
        return { segs: [{ t: "M", p: c(-r, 0) }, { t: "L", p: c(r, 0) }, { t: "M", p: c(0, -r) }, { t: "L", p: c(0, r) }], fill: false };
      case "-":
        return { segs: [{ t: "M", p: c(-r, 0) }, { t: "L", p: c(r, 0) }], fill: false };
      case "|":
        return { segs: [{ t: "M", p: c(0, -r) }, { t: "L", p: c(0, r) }], fill: false };
      case "asterisk":
      case "star": {
        const segs: Seg[] = [];
        for (let i = 0; i < (kind === "star" ? 5 : 3); i++) {
          const a = kind === "star" ? 90 + 72 * i : 90 + 60 * i;
          segs.push({ t: "M", p: kind === "star" ? p : add(p, scale(dir(a), -r)) }, { t: "L", p: add(p, scale(dir(a), r)) });
        }
        return { segs, fill: false };
      }
      case "otimes*":
      case "otimes":
      case "oplus*":
      case "oplus": {
        const k = r * 0.7071;
        const cross: Seg[] = kind.startsWith("otimes")
          ? [{ t: "M", p: c(-k, -k) }, { t: "L", p: c(k, k) }, { t: "M", p: c(-k, k) }, { t: "L", p: c(k, -k) }]
          : [{ t: "M", p: c(-r, 0) }, { t: "L", p: c(r, 0) }, { t: "M", p: c(0, -r) }, { t: "L", p: c(0, r) }];
        return { segs: [...circ(r), ...cross], fill: kind.endsWith("*") };
      }
      default:
        it.warnOnce(`mark:${kind}`, `Plot mark "${kind}" is drawn as a dot`);
        return { segs: circ(r), fill: true };
    }
  };
  it.tick(pts.length);
  const open: Seg[] = [];
  const filled: Seg[] = [];
  for (const p of pts) {
    const s = shape(p);
    (s.fill ? filled : open).push(...s.segs);
  }
  const op = g.opacity;
  if (filled.length) it.scene.path(filled, { fill: fillColor, stroke: color, lineWidth: lw, ...(op !== undefined ? { fillOpacity: op, strokeOpacity: op } : {}) }, g.clips, g.layer);
  if (open.length) it.scene.path(open, { stroke: color, fill: kind === "o" || kind.endsWith("square") || kind === "triangle" || kind === "diamond" ? "#ffffff" : undefined, lineWidth: lw, ...(op !== undefined ? { strokeOpacity: op } : {}) }, g.clips, g.layer);
  if (pts.length) it.drawn++;
}

/** Decorations: brace, zigzag, snake, coil (as a zigzag), and markings (arrows along the path). */
function decorate(segs: Seg[], dec: NonNullable<GS["decoration"]>, lw: number): { segs: Seg[]; marks: { at: Pt; dir: Pt; tip: string; reversed: boolean }[] } {
  void lw;
  // Flatten to a polyline with arc length.
  const pts: Pt[] = [];
  let cur: Pt = [0, 0];
  for (const s of segs) {
    if (s.t === "M") {
      cur = s.p;
      if (!pts.length) pts.push(s.p);
    } else if (s.t === "L") {
      pts.push(s.p);
      cur = s.p;
    } else if (s.t === "C") {
      for (let k = 1; k <= 16; k++) pts.push(bez(cur, s.c1, s.c2, s.p, k / 16));
      cur = s.p;
    }
  }
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + dist(pts[i - 1], pts[i]));
  const total = lens[lens.length - 1];
  const at = (d: number): { p: Pt; t: Pt } => {
    const x = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < lens.length - 1 && lens[i] < x) i++;
    const seg = lens[i] - lens[i - 1] || 1;
    const f = (x - lens[i - 1]) / seg;
    return { p: lerp(pts[i - 1], pts[i], f), t: unit(sub(pts[i], pts[i - 1])) };
  };
  const marks = dec.marks.map((m) => {
    const d = m.abs ? (m.at < 0 ? total + m.at : m.at) : m.at * total;
    const a = at(d);
    return { at: a.p, dir: a.t, tip: m.tip, reversed: m.reversed };
  });
  if (total < 1e-6 || dec.kind === "markings") return { segs, marks };
  const side = dec.mirror ? -1 : 1;
  const normal = (t: Pt): Pt => [-t[1] * side, t[0] * side];
  const out: Seg[] = [];
  if (dec.kind === "brace") {
    // A curly brace from start to end, bulging to the left of the direction.
    const a = pts[0];
    const b = pts[pts.length - 1];
    const t = unit(sub(b, a));
    const nrm = normal(t);
    const amp = dec.amplitude;
    const L = dist(a, b);
    const raise = scale(nrm, dec.raise);
    const P = (x: number, y: number): Pt => add(add(add(a, scale(t, x)), scale(nrm, y)), raise);
    const q = Math.min(amp, L / 4);
    out.push(
      { t: "M", p: P(0, 0) },
      { t: "C", c1: P(0, amp * 0.5), c2: P(q * 0.5, amp * 0.5), p: P(q, amp * 0.5) },
      { t: "L", p: P(L / 2 - q, amp * 0.5) },
      { t: "C", c1: P(L / 2 - q * 0.5, amp * 0.5), c2: P(L / 2, amp * 0.5), p: P(L / 2, amp) },
      { t: "C", c1: P(L / 2, amp * 0.5), c2: P(L / 2 + q * 0.5, amp * 0.5), p: P(L / 2 + q, amp * 0.5) },
      { t: "L", p: P(L - q, amp * 0.5) },
      { t: "C", c1: P(L - q * 0.5, amp * 0.5), c2: P(L, amp * 0.5), p: P(L, 0) },
    );
    return { segs: out, marks };
  }
  // Periodic decorations.
  const segLen = Math.max(dec.segmentLength, 1);
  const n = Math.max(1, Math.min(2000, Math.round(total / segLen)));
  const step = total / n;
  out.push({ t: "M", p: pts[0] });
  if (dec.kind === "snake" || dec.kind === "waves" || dec.kind === "bumps") {
    const k = 8;
    for (let i = 0; i < n * k; i++) {
      const d = ((i + 1) * step) / k;
      const a = at(d);
      const phase = ((i + 1) / k) * 2 * Math.PI;
      const y = dec.kind === "bumps" ? Math.abs(Math.sin(phase / 2)) * dec.amplitude : Math.sin(phase) * dec.amplitude;
      out.push({ t: "L", p: add(a.p, scale(normal(a.t), i === n * k - 1 ? 0 : y)) });
    }
  } else {
    // zigzag, saw, coil, random steps: a zigzag.
    for (let i = 0; i < n; i++) {
      const a = at((i + 0.25) * step);
      const b = at((i + 0.75) * step);
      out.push({ t: "L", p: add(a.p, scale(normal(a.t), dec.amplitude)) });
      out.push({ t: "L", p: add(b.p, scale(normal(b.t), -dec.amplitude)) });
    }
    out.push({ t: "L", p: pts[pts.length - 1] });
  }
  return { segs: out, marks };
}

export { CM, initialState, stripComments, length };

/** `>` in an arrow spec means the tip set with >=... where the path is drawn. */
export function resolveTips(spec: ArrowSpec | undefined, def: Tip): ArrowSpec | undefined {
  if (!spec) return undefined;
  const r = (t: Tip): Tip => (t.kind === "default" ? { ...def, ...(t.reversed ? { reversed: !def.reversed } : {}) } : t);
  return { start: spec.start.map(r), end: spec.end.map(r) };
}
