/**
 * The PSTricks interpreter: reads a pspicture body command by command and
 * draws into the same Scene the TikZ interpreter uses, so the result is the
 * same kind of SVG (glyph outlines for text, typeset by texwright's math
 * engine). This file holds the reader, the graphics state, coordinates,
 * painting (fill styles, hatching, gradients, shadows, double lines,
 * arrows), the basic objects of pstricks.tex, boxes and \rput/\uput, and
 * \multido, \pscustom, \psclip and macros. Plots, nodes, trees and the
 * pst-eucl, pst-3dplot and pst-coil commands live in their own files and
 * register themselves in the command table.
 */

import { applyTips, roundPolygon } from "../tikz/interp.js";
import { type Mat, type Pt, type Seg, ID, add, apply, applyLinear, arcCubics, bez, bezTangent, dir, invert, mul, rotation, scale, smoothThrough, sub, unit } from "../tikz/geom.js";
import { placeTip, tipShape } from "../tikz/arrows.js";
import { Scene, type PaintStyle, emptyBox, growBox, segsBox } from "../tikz/scene.js";
import { Scanner, matchClose, splitTop } from "../tikz/scan.js";
import { type TextBlock, type TextStyle, layoutText, textSvg } from "../tikz/text.js";
import type { NodeInfo } from "../tikz/interp.js";
import { COMMANDS, type Call, cmd } from "./registry.js";
import { RpnError, compileRpn, texNumber } from "./rpn.js";
import { type ColorEnv, type PState, CM, cloneState, color, dimen, numVal, parseArrows, psset } from "./state.js";
import type { RGB } from "../tikz/color.js";

export interface Message {
  severity: "warning" | "error";
  message: string;
  /** Offset into the picture's source. */
  offset: number;
  hint?: string;
}

export interface PstOptions {
  /** Math macros of the document (\name -> body). */
  macros?: Record<string, string>;
  /** Colours the document defined. */
  color?: (name: string) => string | undefined;
  /** Reads a data file next to the document (\fileplot, \readdata). */
  readFile?: (path: string) => string | undefined;
  /** Text size in pt (10). */
  fontSize?: number;
  /** Time budget in ms. */
  budgetMs?: number;
}

export class Stop extends Error {}

const LIMITS = {
  ops: 100_000,
  iterations: 20_000,
  /** Text produced by macro and loop expansion. */
  text: 2_000_000,
  depth: 40,
  nodes: 5_000,
};

/** A typeset box: a text, a framed box, a node, a tree, or (with no size) graphics. */
export interface PBox {
  w: number;
  /** Above the baseline. */
  h: number;
  /** Below the baseline. */
  d: number;
  /** The outline nodes connect to, relative to the box's centre (w/2, (h-d)/2). */
  shape: string;
  hw: number;
  hh: number;
  /** Draws the box; `M` maps box coordinates (pt, origin at the left end of the baseline, y up) to the picture. */
  draw(M: Mat): void;
}

interface Macro {
  nargs: number;
  body: string;
  /** Default of an optional first argument (\newcommand{\x}[2][d]{...}). */
  opt?: string;
}

/** Commands that make a box with a size (everything else in \rput's argument that draws is graphics). */
export const BOX_COMMANDS = new Set([
  "psframebox", "pscirclebox", "psovalbox", "psdiabox", "pstribox", "psshadowbox", "psdblframebox", "pscharpath",
  "rnode", "Rnode", "circlenode", "ovalnode", "dianode", "trinode",
  "pstree", "parbox", "shortstack", "fbox", "framebox", "mbox", "makebox", "hbox", "scalebox", "psscalebox", "rotatebox", "colorbox", "fcolorbox", "textcolor", "psshadowbox",
]);

export class PstInterp {
  readonly scene: Scene;
  readonly messages: Message[] = [];
  readonly nodes = new Map<string, NodeInfo>();
  readonly colors: ColorEnv;
  readonly styles = new Map<string, string>();
  readonly macros = new Map<string, Macro>();
  /** Data sets read with \readdata or \savedata, by macro name. */
  readonly data = new Map<string, string>();
  /** \newpsobject{name}{object}{options}. */
  readonly objects = new Map<string, { object: string; opts: string }>();
  /** Macros that switch the text colour (\red, and \newrgbcolor names). */
  readonly colorMacros = new Set(["red", "green", "blue", "cyan", "magenta", "yellow", "black", "white", "gray", "darkgray", "lightgray"]);
  readonly mathMacros: Record<string, string>;
  readonly opts: PstOptions;
  private warned = new Set<string>();
  private ops = 0;
  iterations = 0;
  private depth = 0;
  private expanded = 0;
  private readonly deadline: number;
  off = 0;
  drawn = 0;
  /** A \pscustom being built: objects add their segments here instead of drawing. */
  custom?: { segs: Seg[]; st: PState; stack: PState[] };
  /** A \psclip being read: drawn shapes also go into the clip path. */
  capture?: Seg[];
  /** The last node connection, for \naput and friends. */
  lastConn?: { pts: Pt[]; kind: "poly" | "curve"; npos: number; st: PState };
  /** The picture's box, in pt (for \psgrid without coordinates). */
  frame?: [Pt, Pt];
  /** SpecialCoor is on (polar coordinates and the like): always on, as pstricks-add has it. */

  constructor(opts: PstOptions, prefix: string) {
    this.opts = opts;
    this.scene = new Scene(prefix);
    this.colors = { local: new Map<string, RGB>(), ...(opts.color ? { lookup: opts.color } : {}) };
    this.mathMacros = { ...(opts.macros ?? {}) };
    this.deadline = Date.now() + (opts.budgetMs ?? 800);
    for (const [name, body] of Object.entries(opts.macros ?? {})) {
      const n = name.replace(/^\\/, "");
      const nargs = Math.max(0, ...[...body.matchAll(/#(\d)/g)].map((m) => Number(m[1])));
      this.macros.set(n, { nargs, body });
    }
  }

  // ------------------------------------------------------------ messages and limits

  warn(message: string, offset = this.off, hint?: string): void {
    if (this.messages.length > 200) return;
    this.messages.push({ severity: "warning", message, offset, ...(hint ? { hint } : {}) });
  }

  warnOnce(key: string, message: string, hint?: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message, this.off, hint);
  }

  /** The host \psset reports to. */
  readonly host = {
    unknown: (key: string) => this.warnOnce(`opt:${key}`, `PSTricks parameter "${key}" is not supported and was ignored`),
    colors: undefined as unknown as ColorEnv,
    styles: this.styles,
  };

  set(st: PState, opts: string | undefined): void {
    if (!opts) return;
    this.host.colors = this.colors;
    psset(st, this.expandText(opts), this.host);
  }

  tick(n = 1): void {
    this.ops += n;
    if (this.ops > LIMITS.ops) throw new Stop("the picture has too many drawing operations");
    if (this.scene.full) throw new Stop("the picture is too large to draw in full");
    if ((this.ops & 255) === 0 && Date.now() > this.deadline) throw new Stop("the picture took too long to draw");
  }

  /** Counts loop iterations against the picture's cap. */
  iterate(n = 1): void {
    this.iterations += n;
    if (this.iterations > LIMITS.iterations) throw new Stop("the picture has too many loop iterations");
    this.tick();
  }

  grow(n: number): void {
    this.expanded += n;
    if (this.expanded > LIMITS.text) throw new Stop("macro and loop expansion made the picture too large");
  }

  timeLeft(): boolean {
    return Date.now() <= this.deadline;
  }

  // ------------------------------------------------------------ reading

  /** Runs picture code. `base` is the offset of `text` in the source; offsets are exact unless the text came from a macro. */
  run(text: string, base: number, st: PState, exact = true): void {
    if (++this.depth > LIMITS.depth) {
      this.depth--;
      throw new Stop("the picture nests too deeply");
    }
    try {
      const sc = new Scanner(text);
      while (!sc.done) {
        this.tick();
        const at = sc.i;
        if (exact) this.off = base + at;
        const c = sc.s[sc.i];
        if (c === "{") {
          const start = sc.i + 1;
          const body = sc.group("{") ?? "";
          this.run(body, base + start, cloneState(st), exact);
          continue;
        }
        if (c === "}") {
          sc.i++;
          continue;
        }
        if (c === "\\") {
          const m = /^\\([A-Za-z@]+)(\*?)|^\\(.)/.exec(sc.s.slice(sc.i, sc.i + 60));
          if (!m) {
            sc.i++;
            continue;
          }
          sc.i += m[0].length;
          if (m[3] !== undefined) continue;
          this.command(m[1], m[2] === "*", sc, st, base, exact);
          continue;
        }
        // Text in the picture's flow: PSTricks puts it at the origin. Spaces, ~ and stray punctuation are ignored.
        let j = sc.i;
        while (j < sc.s.length && sc.s[j] !== "\\" && sc.s[j] !== "{" && sc.s[j] !== "}") j++;
        const txt = sc.s.slice(sc.i, j);
        sc.i = j;
        if (/[A-Za-z0-9$]/.test(txt.replace(/~/g, ""))) this.warnOnce("flow-text", `Text "${txt.trim().slice(0, 30)}" outside \\rput was left out`, "Place text with \\rput(x,y){...}");
      }
    } finally {
      this.depth--;
    }
  }

  /** Runs one command whose name was just read. */
  command(name: string, star: boolean, sc: Scanner, st: PState, base: number, exact: boolean): void {
    const h = COMMANDS.get(name);
    const call: Call = { it: this, sc, st, star, name, base, exact };
    if (this.custom && CUSTOM.has(name)) {
      CUSTOM.get(name)!(call);
      return;
    }
    if (h) {
      h(call);
      return;
    }
    const obj = this.objects.get(name);
    if (obj) {
      // \newpsobject: the object with its options first, then the command's own.
      const own = sc.options();
      const at = sc.i;
      const text = `\\${obj.object}${star ? "*" : ""}[${obj.opts}${own ? `,${own}` : ""}]`;
      const rest = sc.s.slice(at);
      // Run the object on the rest of the text, then continue after what it read.
      const sub = new Scanner(text + rest);
      sub.i = 0;
      const m = /^\\([A-Za-z@]+)(\*?)/.exec(text)!;
      sub.i = m[0].length;
      this.command(m[1], star, sub, st, base, false);
      sc.i = at + Math.max(0, sub.i - text.length);
      return;
    }
    const mac = this.macros.get(name);
    if (mac) {
      const args: string[] = [];
      let first = 0;
      if (mac.opt !== undefined) {
        const o = sc.options();
        args.push(o ?? mac.opt);
        first = 1;
      }
      for (let k = first; k < mac.nargs; k++) {
        sc.ws();
        const g = sc.peek() === "{" ? sc.group("{") : sc.s[sc.i++];
        args.push(g ?? "");
      }
      const body = mac.body.replace(/#(\d)/g, (_m, d: string) => args[Number(d) - 1] ?? "");
      this.grow(body.length);
      this.run(body, this.off, st, false);
      return;
    }
    if (this.colorMacros.has(name)) {
      const c = color(name, this.colors);
      if (c) st.textColor = c;
      return;
    }
    if (IGNORED.has(name)) {
      skipArgs(sc, IGNORED.get(name)!);
      return;
    }
    this.warnOnce(`cmd:${name}`, `PSTricks command \\${name} is not supported and was left out`);
    // Skip its options, arrows, coordinates and one argument, so the next command is read cleanly.
    sc.options();
    while (sc.peek() === "(") sc.group("(");
    if (sc.peek() === "{") sc.group("{");
  }

  // ------------------------------------------------------------ macros and text

  /** Expands argument-less macros (and \space) in a coordinate or number. */
  expandText(s: string): string {
    if (!s.includes("\\")) return s;
    let out = s;
    for (let pass = 0; pass < 8 && out.includes("\\"); pass++) {
      let changed = false;
      out = out.replace(/\\([A-Za-z@]+)(?![A-Za-z@])\s*/g, (m0, n: string) => {
        if (n === "space") {
          changed = true;
          return " ";
        }
        const mac = this.macros.get(n);
        if (mac && mac.nargs === 0) {
          changed = true;
          return mac.body;
        }
        const d = this.data.get(n);
        if (d !== undefined && pass === 0) return m0;
        return m0;
      });
      if (!changed) break;
      if (out.length > 100_000) break;
    }
    return out;
  }

  /** Text for the math engine: PSTricks colour switches become \color, picture macros are known. */
  texText(s: string): string {
    return s.replace(/\\([A-Za-z]+)(?![A-Za-z])\s*/g, (m0, n: string) => {
      if (this.colorMacros.has(n) && !Object.hasOwn(this.mathMacros, `\\${n}`)) {
        const c = color(n, this.colors);
        return c ? `\\color[HTML]{${c.slice(1).toUpperCase()}}` : "";
      }
      return m0;
    });
  }

  layout(text: string, st: PState, style: Partial<TextStyle> = {}): TextBlock {
    this.tick(5);
    return layoutText(this.texText(text), { size: st.fontSize, bold: false, italic: false, family: "serif", align: "center", ...style }, this.mathMacros);
  }

  // ------------------------------------------------------------ arguments

  /** {arrows} before the coordinates, when the braces hold an arrow spec. */
  arrowsArg(sc: Scanner, st: PState): string | undefined {
    if (sc.peek() !== "{") return undefined;
    const e = matchClose(sc.s, sc.i);
    if (e < 0) return undefined;
    const inner = sc.s.slice(sc.i + 1, e).trim();
    if (!parseArrows(inner, st)) return undefined;
    sc.i = e + 1;
    return inner;
  }

  /** The (...) groups that follow. */
  coordList(sc: Scanner, max = 100_000): string[] {
    const out: string[] = [];
    while (out.length < max && sc.peek() === "(") {
      out.push(sc.group("(") ?? "");
      if (out.length % 64 === 0) this.tick();
    }
    return out;
  }

  /** A required {argument}; a single token when there are no braces. */
  arg(sc: Scanner): string | undefined {
    sc.ws();
    if (sc.s[sc.i] === "{") return sc.group("{");
    if (sc.i >= sc.s.length) return undefined;
    const m = /^\\[A-Za-z@]+|^[^\s\\{}()[\]]/.exec(sc.s.slice(sc.i, sc.i + 40));
    if (!m) return undefined;
    sc.i += m[0].length;
    return m[0];
  }

  // ------------------------------------------------------------ coordinates

  /** A number (expressions and macros allowed), or undefined. */
  number(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const t = this.expandText(raw).trim();
    const n = numVal(t);
    if (n !== undefined && Number.isFinite(n)) return n;
    const v = texNumber(t);
    return v !== undefined && Number.isFinite(v) ? v : undefined;
  }

  /** A length: bare numbers in units of `unit` pt. */
  len(raw: string | undefined, unitPt: number, st: PState): number | undefined {
    if (raw === undefined) return undefined;
    const t = this.expandText(raw).trim();
    const d = dimen(t, unitPt, st);
    if (d !== undefined && Number.isFinite(d)) return d;
    const n = texNumber(t);
    return n !== undefined ? n * unitPt : undefined;
  }

  /** Local point (pt, before the transformation) of unit coordinates. */
  local(x: number, y: number, st: PState): Pt {
    return [x * st.xunit, y * st.yunit];
  }

  /** The picture point of a coordinate (x,y), (r;a), (node), (!x y), (a|b), ([opts]node). Undefined (with a warning) when unreadable. */
  coord(raw0: string, st: PState): Pt | undefined {
    const raw = this.expandText(raw0).trim();
    if (!raw) return apply(st.T, [0, 0]);
    if (raw.startsWith("!")) {
      try {
        const v = compileRpn(raw.slice(1))({});
        if (v.length >= 2 && Number.isFinite(v[v.length - 2]) && Number.isFinite(v[v.length - 1])) return apply(st.T, this.local(v[v.length - 2], v[v.length - 1], st));
      } catch (e) {
        if (!(e instanceof RpnError)) throw e;
      }
      this.warnOnce(`coord:${raw}`, `Cannot read the coordinate (${raw})`);
      return undefined;
    }
    const bar = splitTop(raw, "|");
    if (bar.length === 2) {
      const a = this.coord(bar[0], st);
      const b = this.coord(bar[1], st);
      return a && b ? [a[0], b[1]] : undefined;
    }
    const semi = splitTop(raw, ";");
    if (semi.length === 2) {
      const r = semi[0].trim();
      const rp = this.len(r, 1, st);
      let a = this.number(semi[1]);
      if (a === undefined) {
        // (r;(x,y)) or (r;node): the angle of a direction.
        const t = semi[1].trim().replace(/^\((.*)\)$/, "$1");
        const p = this.coord(t, st);
        if (p) {
          const o = apply(st.T, [0, 0]);
          a = (Math.atan2(p[1] - o[1], p[0] - o[0]) * 180) / Math.PI;
        }
      }
      if (rp === undefined || a === undefined) {
        this.warnOnce(`coord:${raw}`, `Cannot read the polar coordinate (${raw})`);
        return undefined;
      }
      // A bare radius is in units (x and y scaled separately); a length is absolute.
      const isDim = /[a-z]{2}\s*$/.test(r) && !/^\d*\.?\d*$/.test(r);
      const rad = (a * Math.PI) / 180;
      const p: Pt = isDim ? [rp * Math.cos(rad), rp * Math.sin(rad)] : [rp * Math.cos(rad) * st.xunit, rp * Math.sin(rad) * st.yunit];
      return apply(st.T, p);
    }
    const comma = splitTop(raw, ",");
    if (comma.length === 2) {
      const x = this.len(comma[0], st.xunit, st);
      const y = this.len(comma[1], st.yunit, st);
      if (x === undefined || y === undefined) {
        this.warnOnce(`coord:${raw}`, `Cannot read the coordinate (${raw})`);
        return undefined;
      }
      return apply(st.T, [x, y]);
    }
    if (comma.length === 3) {
      this.warnOnce(`coord3:${raw}`, `The 3D coordinate (${raw}) needs a pst-3dplot command; it was flattened`);
      const x = this.number(comma[0]) ?? 0;
      const y = this.number(comma[1]) ?? 0;
      return apply(st.T, this.local(x, y, st));
    }
    // A node, possibly with [offsets].
    const rel = /^\[([^\]]*)\]\s*(.*)$/s.exec(raw);
    const name = (rel ? rel[2] : raw).trim();
    const n = this.nodes.get(name);
    if (!n) {
      this.warnOnce(`node:${name}`, `Unknown node or coordinate (${raw})`, "Define the node first (\\pnode, \\rnode, \\cnode), or write (x,y)");
      return undefined;
    }
    if (!rel) return n.center;
    const o = new Map<string, string>();
    for (const part of splitTop(rel[1], ",")) {
      const [k, v] = part.split("=");
      if (k) o.set(k.trim(), (v ?? "").trim());
    }
    let p = n.center;
    const angle = this.number(o.get("angle")) ?? 0;
    const ns = o.has("nodesep") ? this.len(o.get("nodesep"), st.xunit, st) : undefined;
    if (ns !== undefined) p = add(p, scale(dir(angle), ns));
    const xs = this.len(o.get("Xnodesep"), st.xunit, st);
    const ys = this.len(o.get("Ynodesep"), st.yunit, st);
    if (xs !== undefined) p = add(p, [xs, 0]);
    if (ys !== undefined) p = add(p, [0, ys]);
    const off = this.len(o.get("offset"), st.xunit, st);
    if (off !== undefined) p = add(p, scale(dir(angle + 90), off));
    return p;
  }

  /** All coordinates of a list, dropping unreadable ones. */
  coords(list: string[], st: PState): Pt[] {
    const out: Pt[] = [];
    for (const c of list) {
      const p = this.coord(c, st);
      if (p) out.push(p);
    }
    return out;
  }

  // ------------------------------------------------------------ painting

  stroke(st: PState): PaintStyle | undefined {
    if (st.linestyle === "none" || st.lw <= 0) return undefined;
    const ps: PaintStyle = { stroke: st.lc, lineWidth: st.lw };
    if (st.linestyle === "dashed") ps.dash = [st.dash[0], st.dash[1]];
    else if (st.linestyle === "dotted") {
      ps.dash = [0, st.dotsep + st.lw];
      ps.cap = "round";
    }
    const op = st.strokeopacity ?? st.opacity;
    if (op !== undefined && op < 1) ps.strokeOpacity = op;
    return ps;
  }

  /** Records a clip outline being read by \psclip. */
  private captureSegs(segs: Seg[]): void {
    if (this.capture && this.capture.length < 20_000) this.capture.push(...segs);
  }

  /**
   * Draws a path with the state's fill style, line style, shadow, border,
   * double line and arrows. Inside \pscustom the path is added to the custom
   * path instead.
   */
  drawPath(segs0: Seg[], st: PState, o: { closed?: boolean; star?: boolean; arrows?: string; noArrows?: boolean; join?: boolean } = {}): void {
    if (!segs0.length) return;
    if (segs0.some((s) => s.t !== "Z" && !(Number.isFinite(s.p[0]) && Number.isFinite(s.p[1])))) {
      this.warnOnce("nan", "Some points could not be computed (not finite) and were left out");
      segs0 = cleanSegs(segs0);
      if (!segs0.length) return;
    }
    this.tick();
    if (this.custom) {
      appendCustom(this.custom.segs, segs0, o.join !== false && this.custom.st.liftpen === 0 && !o.closed);
      return;
    }
    this.captureSegs(segs0);
    if (st.linearc > 0) segs0 = roundLines(segs0, st.linearc);
    let segs = segs0;
    const closed = !!o.closed;
    const fillOp = st.fillopacity ?? st.opacity;
    const fillStyle = (): PaintStyle | undefined => {
      if (o.star) return { fill: st.lc, lineWidth: 0 };
      const fs = st.fillstyle.replace(/\*$/, "");
      const base: PaintStyle = { lineWidth: 0 };
      if (fillOp !== undefined && fillOp < 1) base.fillOpacity = fillOp;
      if (fs === "solid" || st.fillstyle.endsWith("*")) return { ...base, fill: st.fc };
      if (fs === "gradient") {
        const mid = Math.max(0.01, Math.min(1, st.gradmidpoint));
        const stops: [number, string][] = mid >= 0.99 ? [[0, st.gradbegin], [1, st.gradend]] : [[0, st.gradbegin], [mid, st.gradend], [1, st.gradbegin]];
        return { ...base, shade: { kind: "linear", angle: -90 + st.gradangle, stops } };
      }
      return undefined;
    };
    const hatch = /^(hlines|vlines|crosshatch)\*?$/.test(st.fillstyle) && !o.star;
    const fill = fillStyle();
    const line = o.star ? undefined : this.stroke(st);
    // Arrows (open paths only).
    let tips: { segs: Seg[]; filled: boolean; lw: number }[] = [];
    let cap: PaintStyle["cap"];
    const open = segs[segs.length - 1].t !== "Z";
    if (!o.noArrows && open && !closed && line) {
      const spec = parseArrows(o.arrows ?? st.arrows, st);
      if (spec) {
        if (spec.spec || spec.shortenS || spec.shortenE) {
          const r = applyTips(segs, spec.spec, st.lw, spec.shortenS, spec.shortenE);
          segs = r.segs;
          tips = r.tips;
        }
        cap = spec.cap;
      }
    }
    const clips = st.clips;
    if (st.shadow) {
      const v = scale(dir(st.shadowangle), st.shadowsize);
      const sh = translateSegs(segs0, v);
      if (closed || fill || hatch) {
        this.scene.path(sh, { fill: st.shadowcolor, lineWidth: 0 }, clips);
        // The shadow lies behind the object: an unfilled object hides it as if filled with white.
        if (!fill) this.scene.path(segs0, { fill: "#ffffff", lineWidth: 0 }, clips);
      } else if (line) this.scene.path(sh, { stroke: st.shadowcolor, lineWidth: st.lw }, clips);
    }
    let any = false;
    if (fill) any = this.scene.path(segs0, fill, clips) || any;
    if (hatch) {
      this.hatch(segs0, st);
      any = true;
    }
    if (line) {
      const ls: PaintStyle = { ...line, ...(cap ? { cap } : {}) };
      if (st.border > 0) this.scene.path(segs, { ...ls, stroke: st.bordercolor, lineWidth: st.lw + 2 * st.border, dash: undefined }, clips);
      if (st.doubleline) {
        const sep = st.doublesep ?? 1.25 * st.lw;
        this.scene.path(segs, { ...ls, lineWidth: 2 * st.lw + sep }, clips);
        this.scene.path(segs, { ...ls, stroke: st.doublecolor, lineWidth: sep }, clips);
        any = true;
      } else any = this.scene.path(segs, ls, clips) || any;
      tips.push(...this.insideArrows(segs0, st));
      for (const t of tips) {
        const c = st.lc;
        this.scene.path(
          t.segs,
          t.filled ? { fill: c, stroke: c, lineWidth: t.lw, join: "miter" } : { stroke: c, fill: t.lw < 0 ? "#ffffff" : undefined, lineWidth: Math.abs(t.lw), cap: "round", join: "round" },
          clips,
        );
      }
    }
    if (any) this.drawn++;
  }

  /** pstricks-add's ArrowInside=->: a tip part way along every segment (ArrowInsidePos, 0.5 by default). */
  private insideArrows(segs: Seg[], st: PState): { segs: Seg[]; filled: boolean; lw: number }[] {
    const spec = st.kv.get("ArrowInside");
    if (!spec) return [];
    const a = parseArrows(spec.includes("-") ? spec : `-${spec}`, st);
    const tip = a?.spec?.end[0] ?? a?.spec?.start[0];
    if (!tip) return [];
    const pos = Math.max(0, Math.min(1, this.number(st.kv.get("ArrowInsidePos")) ?? 0.5));
    const shape = tipShape(tip, st.lw);
    const out: { segs: Seg[]; filled: boolean; lw: number }[] = [];
    let prev: Pt | undefined;
    let start: Pt | undefined;
    for (const s of segs) {
      if (out.length > 2000) break;
      if (s.t === "M") {
        prev = start = s.p;
        continue;
      }
      if (!prev) continue;
      let at: Pt;
      let d: Pt;
      if (s.t === "C") {
        at = bez(prev, s.c1, s.c2, s.p, pos);
        d = bezTangent(prev, s.c1, s.c2, s.p, pos);
      } else {
        const end = s.t === "Z" ? (start ?? prev) : s.p;
        at = [prev[0] + (end[0] - prev[0]) * pos, prev[1] + (end[1] - prev[1]) * pos];
        d = sub(end, prev);
      }
      if (Math.hypot(d[0], d[1]) > 1e-6) {
        const u = unit(d);
        // The tip's middle sits on the point.
        const tipAt = add(at, scale(u, shape.extent / 2));
        out.push({ segs: placeTip(shape.segs, tipAt, tip.reversed ? scale(u, -1) : u), filled: shape.filled && !tip.open, lw: tip.open && shape.filled ? -shape.lineWidth : shape.lineWidth });
      }
      prev = s.t === "Z" ? start : s.p;
    }
    return out;
  }

  /** Hatch lines over the path's area, clipped to it. */
  private hatch(segs: Seg[], st: PState): void {
    const b = segsBox(segs);
    if (!(b[0] <= b[2])) return;
    const clip = this.scene.clipPath(segs);
    const angles = st.fillstyle.startsWith("hlines") ? [st.hatchangle] : st.fillstyle.startsWith("vlines") ? [st.hatchangle + 90] : [st.hatchangle, st.hatchangle + 90];
    const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const r = Math.hypot(b[2] - b[0], b[3] - b[1]) / 2 + 1;
    const sep = Math.max(0.5, st.hatchsep + st.hatchwidth);
    const lines: Seg[] = [];
    for (const a of angles) {
      const u = dir(a);
      const nrm: Pt = [-u[1], u[0]];
      const n = Math.min(2000, Math.ceil(r / sep));
      for (let k = -n; k <= n; k++) {
        const m = add(c, scale(nrm, k * sep));
        lines.push({ t: "M", p: add(m, scale(u, -r)) }, { t: "L", p: add(m, scale(u, r)) });
      }
    }
    this.tick(Math.ceil(lines.length / 50));
    this.scene.path(lines, { stroke: st.hatchcolor, lineWidth: st.hatchwidth }, [...st.clips, clip]);
  }

  /** A dot of the current dotstyle at `p` (picture point). */
  dot(p: Pt, st: PState, style = st.dotstyle): void {
    if (this.custom) return;
    this.tick();
    const d = (st.dotsize[0] + st.dotsize[1] * st.lw) * st.dotscale[0];
    const r = d / 2;
    const ry = (r * st.dotscale[1]) / (st.dotscale[0] || 1);
    const R = rotation(st.dotangle);
    const at = (x: number, y: number): Pt => add(p, applyLinear(R, [x, y]));
    const circle = (rr: number): Seg[] => {
      const a = arcCubics(p, applyLinear(R, [rr, 0]), applyLinear(R, [0, (rr * ry) / r]), 0, 360);
      return [{ t: "M", p: a.start }, ...a.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" }];
    };
    const poly = (pts: Pt[]): Seg[] => [{ t: "M", p: at(...pts[0]) }, ...pts.slice(1).map((q) => ({ t: "L" as const, p: at(...q) })), { t: "Z" }];
    const regular = (k: number, rr: number, a0: number): Pt[] => Array.from({ length: k }, (_v, i) => [rr * Math.cos(((a0 + (360 * i) / k) * Math.PI) / 180), rr * Math.sin(((a0 + (360 * i) / k) * Math.PI) / 180)] as Pt);
    const lw = Math.max(0.3, st.lw * 0.75);
    const filled = (segs: Seg[]) => this.scene.path(segs, { fill: st.lc, lineWidth: 0 }, st.clips);
    const open = (segs: Seg[], bold = false) => this.scene.path(segs, { fill: st.fc, stroke: st.lc, lineWidth: bold ? lw * 2 : lw }, st.clips);
    const lines = (segs: Seg[], bold = false) => this.scene.path(segs, { stroke: st.lc, lineWidth: bold ? lw * 2 : lw }, st.clips);
    const plus = (rr: number): Seg[] => [{ t: "M", p: at(-rr, 0) }, { t: "L", p: at(rr, 0) }, { t: "M", p: at(0, -rr) }, { t: "L", p: at(0, rr) }];
    const cross = (rr: number): Seg[] => {
      const k = rr * Math.SQRT1_2;
      return [{ t: "M", p: at(-k, -k) }, { t: "L", p: at(k, k) }, { t: "M", p: at(-k, k) }, { t: "L", p: at(k, -k) }];
    };
    switch (style) {
      case "o":
        open(circle(r - lw / 2));
        break;
      case "Bo":
        open(circle(r - lw), true);
        break;
      case "+":
      case "B+":
        lines(plus(r * 1.4), style === "B+");
        break;
      case "x":
      case "Bx":
        lines(cross(r * 1.4), style === "Bx");
        break;
      case "asterisk":
      case "Basterisk":
        lines([...plus(r * 1.3), ...cross(r * 1.3)], style === "Basterisk");
        break;
      case "|":
        lines([{ t: "M", p: at(0, -r * 1.4) }, { t: "L", p: at(0, r * 1.4) }]);
        break;
      case "square":
      case "Bsquare":
        open(poly([[-r, -r], [r, -r], [r, r], [-r, r]]), style === "Bsquare");
        break;
      case "square*":
        filled(poly([[-r, -r], [r, -r], [r, r], [-r, r]]));
        break;
      case "diamond":
      case "Bdiamond":
        open(poly([[r * 1.3, 0], [0, r * 1.3], [-r * 1.3, 0], [0, -r * 1.3]]), style === "Bdiamond");
        break;
      case "diamond*":
        filled(poly([[r * 1.3, 0], [0, r * 1.3], [-r * 1.3, 0], [0, -r * 1.3]]));
        break;
      case "triangle":
      case "Btriangle":
        open(poly(regular(3, r * 1.3, 90)), style === "Btriangle");
        break;
      case "triangle*":
        filled(poly(regular(3, r * 1.3, 90)));
        break;
      case "pentagon":
      case "Bpentagon":
        open(poly(regular(5, r * 1.2, 90)), style === "Bpentagon");
        break;
      case "pentagon*":
        filled(poly(regular(5, r * 1.2, 90)));
        break;
      case "oplus":
        open(circle(r));
        lines(plus(r));
        break;
      case "otimes":
        open(circle(r));
        lines(cross(r));
        break;
      case "none":
        return;
      default:
        filled(circle(r));
    }
    this.drawn++;
  }

  /** Text block drawn with its first baseline's left end mapped by M. */
  drawText(block: TextBlock, M: Mat, st: PState, opacity?: number): void {
    if (!block.glyphs.length && !block.rules.length) return;
    if (this.custom) return;
    const o = apply(M, [0, 0]);
    const ax = applyLinear(M, [1, 0]);
    const k = Math.hypot(ax[0], ax[1]) || 1;
    const rot = (Math.atan2(ax[1], ax[0]) * 180) / Math.PI;
    const svg = textSvg(block, o[0], -o[1], st.textColor, this.scene.glyphs, { rotate: rot, scale: k, ...(opacity !== undefined ? { opacity } : {}) });
    const b = emptyBox();
    for (const c of [[0, block.height], [block.width, block.height], [0, -block.depth], [block.width, -block.depth]] as Pt[]) growBox(b, apply(M, c));
    this.scene.add(svg, b, st.clips);
    this.drawn++;
  }

  // ------------------------------------------------------------ boxes

  /** The box of \rput's (or a node's) argument. */
  makeBox(stuff0: string, st: PState, base: number, exact: boolean): PBox {
    if (++this.boxDepth > LIMITS.depth) {
      this.boxDepth = 0;
      throw new Stop("boxes nest too deeply");
    }
    try {
      return this.makeBox1(stuff0, st, base, exact);
    } finally {
      this.boxDepth = Math.max(0, this.boxDepth - 1);
    }
  }

  private boxDepth = 0;

  private makeBox1(stuff0: string, st: PState, base: number, exact: boolean): PBox {
    this.tick();
    const stuff = stuff0.trim();
    const parts = splitBoxes(stuff);
    if (parts.length === 1 && parts[0].kind === "cmd") return this.commandBox(parts[0].text, st, base, exact);
    if (parts.length === 1 && parts[0].kind === "graphics") return this.graphicsBox(parts[0].text, st, base, exact);
    if (parts.every((p) => p.kind === "text")) return this.textBox(stuff, st);
    // A row of boxes and text: set side by side on one baseline.
    const boxes = parts.filter((p) => p.text.trim()).map((p) => (p.kind === "cmd" ? this.commandBox(p.text, st, base, exact) : p.kind === "graphics" ? this.graphicsBox(p.text, st, base, exact) : this.textBox(p.text, st)));
    let w = 0;
    let h = 0;
    let d = 0;
    const xs: number[] = [];
    for (const b of boxes) {
      xs.push(w);
      w += b.w;
      h = Math.max(h, b.h);
      d = Math.max(d, b.d);
    }
    return {
      w,
      h,
      d,
      shape: "rectangle",
      hw: w / 2,
      hh: (h + d) / 2,
      draw: (M) => boxes.forEach((b, i) => b.draw(mul(M, [1, 0, 0, 1, xs[i], 0]))),
    };
  }

  textBox(text: string, st: PState, width?: number): PBox {
    let t = text.trim();
    // A colour switch at the start colours the whole text: {\red $x$}, \color{blue} label.
    let ink = st.textColor;
    for (let k = 0; k < 4; k++) {
      if (t.startsWith("{") && matchClose(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
      const m = /^\\color\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}|^\\([A-Za-z]+)(?![A-Za-z])/.exec(t);
      if (!m) break;
      const name = m[1] ?? m[2];
      if (m[2] !== undefined && !this.colorMacros.has(name)) break;
      const c = color(name, this.colors);
      if (!c) break;
      ink = c;
      t = t.slice(m[0].length).trim();
    }
    if (!t || /^(~|\\[,;:!]|\\(?:quad|qquad|strut|relax|hfill)\s*)*$/.test(t)) return { w: 0, h: 0, d: 0, shape: "rectangle", hw: 0, hh: 0, draw: () => {} };
    const block = this.layout(t, st, width !== undefined ? { width, align: "left" } : {});
    if (!block.ok && block.errors.length) this.warnOnce(`text:${t.slice(0, 40)}`, `Text "${t.slice(0, 40)}" could not be typeset exactly: ${block.errors[0]}`);
    return {
      w: block.width,
      h: block.height,
      d: block.depth,
      shape: "rectangle",
      hw: block.width / 2,
      hh: (block.height + block.depth) / 2,
      draw: (M) => {
        const s2 = cloneState(st);
        s2.textColor = ink;
        this.drawText(block, M, s2);
      },
    };
  }

  /** Graphics in \rput: no size; drawn with the box map as the transformation. */
  graphicsBox(code: string, st: PState, base: number, exact: boolean): PBox {
    return {
      w: 0,
      h: 0,
      d: 0,
      shape: "coordinate",
      hw: 0,
      hh: 0,
      draw: (M) => {
        const s2 = cloneState(st);
        s2.T = M;
        this.run(code, base, s2, exact);
      },
    };
  }

  /** A single box command: \psframebox{...}, \rnode{a}{...}, \pstree..., \parbox... */
  commandBox(text: string, st: PState, base: number, exact: boolean): PBox {
    const sc = new Scanner(text);
    const m = /^\\([A-Za-z]+)(\*?)/.exec(text)!;
    sc.i = m[0].length;
    const name = m[1];
    const star = m[2] === "*";
    const h = BOXES.get(name);
    if (h) {
      const b = h(this, sc, st, star, base, exact);
      if (b) return b;
    }
    return this.textBox(text, st);
  }

  /** A framed box around `inner`: frame, circle, oval, diamond, triangle, shadow and double frames. */
  frameBox(kind: string, inner: PBox, st: PState, star: boolean): PBox {
    const sep = st.framesep;
    const lw = st.linestyle === "none" ? 0 : st.lw;
    const a = inner.w / 2 + sep;
    const b = (inner.h + inner.d) / 2 + sep;
    const icy = (inner.h - inner.d) / 2;
    let hw: number;
    let hh: number;
    let shape = "rectangle";
    switch (kind) {
      case "pscirclebox":
        hw = hh = Math.hypot(inner.w / 2, (inner.h + inner.d) / 2) + sep;
        shape = "circle";
        break;
      case "psovalbox":
        hw = inner.w / 2 * Math.SQRT2 + sep;
        hh = (inner.h + inner.d) / 2 * Math.SQRT2 + sep;
        shape = "ellipse";
        break;
      case "psdiabox":
        hw = 2 * a;
        hh = 2 * b;
        shape = "diamond";
        break;
      case "pstribox":
        hw = 2 * a + b;
        hh = 2 * b;
        shape = "triangle";
        break;
      case "psdblframebox":
        hw = a + 1.5 * lw + (st.doublesep ?? 1.25 * lw);
        hh = b + 1.5 * lw + (st.doublesep ?? 1.25 * lw);
        break;
      default:
        hw = a + lw / 2;
        hh = b + lw / 2;
    }
    const W = 2 * (hw + lw / 2);
    const box: PBox = {
      w: W,
      h: icy + hh + lw / 2,
      d: hh + lw / 2 - icy,
      shape: shape === "triangle" ? "rectangle" : shape,
      hw: hw + lw / 2,
      hh: hh + lw / 2,
      draw: (M) => {
        const c: Pt = [W / 2, icy];
        const toPic = (p: Pt): Pt => apply(M, add(c, p));
        let outline: Seg[];
        if (shape === "circle" || shape === "ellipse") {
          const ar = arcCubics(apply(M, c), applyLinear(M, [hw, 0]), applyLinear(M, [0, hh]), 0, 360);
          outline = [{ t: "M", p: ar.start }, ...ar.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" }];
        } else if (shape === "diamond") outline = polySegs([[hw, 0], [0, hh], [-hw, 0], [0, -hh]].map((p) => toPic(p as Pt)), true);
        else if (shape === "triangle") outline = polySegs([[-hw, -b], [hw, -b], [0, -b + 2 * hh + b]].map((p) => toPic(p as Pt)), true);
        else {
          const r = st.framearc > 0 ? (st.framearc * Math.min(hw, hh)) : 0;
          outline = rectSegs([-hw, -hh], [hw, hh], r, toPic);
        }
        const s2 = cloneState(st);
        if (star) {
          s2.fillstyle = "solid";
          s2.linestyle = "none";
        }
        if (kind === "psshadowbox") s2.shadow = true;
        this.drawPath(outline, s2, { closed: true });
        if (kind === "psdblframebox" && !star) {
          const g = (st.doublesep ?? 1.25 * lw) + lw;
          this.drawPath(rectSegs([-hw + g, -hh + g], [hw - g, hh - g], 0, toPic), { ...s2, fillstyle: "none", shadow: false }, { closed: true });
        }
        inner.draw(mul(M, [1, 0, 0, 1, W / 2 - inner.w / 2, 0]));
      },
    };
    return box;
  }

  /** Registers a node (capped). */
  addNode(name: string, info: NodeInfo): void {
    if (!name) return;
    if (this.nodes.size >= LIMITS.nodes && !this.nodes.has(name)) {
      this.warnOnce("nodes", "Too many nodes; the rest were not registered");
      return;
    }
    this.nodes.set(name, info);
  }

  /** A box drawn so that its point `ref` (box coordinates) lands at picture point P, turned by `rot` degrees. */
  place(box: PBox, P: Pt, ref: Pt, rot: number, st: PState): Mat {
    const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
    const M = mul(mul([1, 0, 0, 1, P[0], P[1]], L), mul(rotation(rot), [1, 0, 0, 1, -ref[0], -ref[1]]));
    box.draw(M);
    return M;
  }
}

/** Reference point of a box from \rput's [refpoint]: l r t b B and pairs; centre by default. */
export function refPoint(box: PBox, spec: string | undefined): Pt {
  const s = (spec ?? "").trim();
  let x = box.w / 2;
  let y = (box.h - box.d) / 2;
  if (/l/.test(s)) x = 0;
  else if (/r/.test(s)) x = box.w;
  if (/t/.test(s)) y = box.h;
  else if (/b/.test(s)) y = -box.d;
  else if (/B/.test(s)) y = 0;
  return [x, y];
}

/** \uput's angle as a direction in degrees. */
export function uputAngle(spec: string | undefined, it: PstInterp): number {
  const s = (spec ?? "").trim();
  const named: Record<string, number> = { r: 0, u: 90, l: 180, d: 270, ur: 45, ul: 135, dl: 225, ld: 225, dr: 315, rd: 315, ru: 45, lu: 135, ru2: 45 };
  if (Object.hasOwn(named, s)) return named[s];
  return it.number(s) ?? 0;
}

/** The point of a box that sits towards angle+180: what \uput puts at labelsep along the angle. */
export function uputRef(box: PBox, angle: number): Pt {
  const a = ((angle % 360) + 360) % 360;
  const sector = Math.round(a / 45) % 8;
  const cy = (box.h - box.d) / 2;
  const L = 0;
  const R = box.w;
  const T = box.h;
  const B = -box.d;
  const C = box.w / 2;
  const refs: Pt[] = [[L, cy], [L, B], [C, B], [R, B], [R, cy], [R, T], [C, T], [L, T]];
  return refs[sector];
}

/** \rput's rotation argument: a number, or U L D R N W S E (and * for absolute). */
export function rotationArg(raw: string | undefined, it: PstInterp): number {
  if (raw === undefined) return 0;
  const s = raw.trim().replace(/^\*/, "");
  const named: Record<string, number> = { U: 0, L: 90, D: 180, R: -90, N: 0, W: 90, S: 180, E: -90 };
  if (Object.hasOwn(named, s)) return named[s];
  return it.number(s) ?? 0;
}

// ---------------------------------------------------------------- geometry helpers

export function polySegs(pts: Pt[], closed: boolean): Seg[] {
  if (!pts.length) return [];
  const segs: Seg[] = [{ t: "M", p: pts[0] }, ...pts.slice(1).map((p) => ({ t: "L" as const, p }))];
  if (closed) segs.push({ t: "Z" });
  return segs;
}

/** A rectangle from local corner a to b (mapped by f), with corners rounded by r. */
export function rectSegs(a: Pt, b: Pt, r: number, f: (p: Pt) => Pt): Seg[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  if (rr <= 0.01) return polySegs([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => f(p as Pt)), true);
  const k = 0.5523 * rr;
  const P = (x: number, y: number) => f([x, y]);
  return [
    { t: "M", p: P(x0 + rr, y0) },
    { t: "L", p: P(x1 - rr, y0) },
    { t: "C", c1: P(x1 - rr + k, y0), c2: P(x1, y0 + rr - k), p: P(x1, y0 + rr) },
    { t: "L", p: P(x1, y1 - rr) },
    { t: "C", c1: P(x1, y1 - rr + k), c2: P(x1 - rr + k, y1), p: P(x1 - rr, y1) },
    { t: "L", p: P(x0 + rr, y1) },
    { t: "C", c1: P(x0 + rr - k, y1), c2: P(x0, y1 - rr + k), p: P(x0, y1 - rr) },
    { t: "L", p: P(x0, y0 + rr) },
    { t: "C", c1: P(x0, y0 + rr - k), c2: P(x0 + rr - k, y0), p: P(x0 + rr, y0) },
    { t: "Z" },
  ];
}

function translateSegs(segs: Seg[], v: Pt): Seg[] {
  return segs.map((s) => {
    if (s.t === "Z") return s;
    if (s.t === "C") return { t: "C", c1: add(s.c1, v), c2: add(s.c2, v), p: add(s.p, v) };
    return { ...s, p: add(s.p, v) };
  });
}

/** Drops segments with points that are not finite, starting a new subpath after a gap. */
function cleanSegs(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  let broken = true;
  const ok = (p: Pt) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  for (const s of segs) {
    if (s.t === "Z") {
      if (!broken) out.push(s);
      continue;
    }
    const good = ok(s.p) && (s.t !== "C" || (ok(s.c1) && ok(s.c2)));
    if (!good) {
      broken = true;
      continue;
    }
    if (broken || s.t === "M") {
      out.push({ t: "M", p: s.p });
      broken = false;
    } else out.push(s);
  }
  return out.length > 1 ? out : [];
}

/** Adds an object's path to a \pscustom path: an open object continues from the current point (liftpen=0). */
function appendCustom(path: Seg[], segs: Seg[], join: boolean): void {
  if (path.length > 50_000) return;
  if (join && path.length && path[path.length - 1].t !== "Z" && segs[0].t === "M") {
    path.push({ t: "L", p: segs[0].p }, ...segs.slice(1));
  } else path.push(...segs);
}

/** linearc: rounds the corners of polylines. */
function roundLines(segs: Seg[], r: number): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i].t !== "M") {
      out.push(segs[i++]);
      continue;
    }
    let j = i + 1;
    while (j < segs.length && segs[j].t === "L") j++;
    const closed = segs[j]?.t === "Z";
    const pts = segs.slice(i, j).map((s) => (s as { p: Pt }).p);
    if (pts.length < 3) {
      out.push(...segs.slice(i, j));
      i = j;
      continue;
    }
    if (closed) {
      // A closed polygon has every corner rounded, the first one too.
      if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
      out.push(...roundPolygon(pts, r));
      i = j + 1;
      continue;
    }
    out.push({ t: "M", p: pts[0] });
    for (let k = 1; k < pts.length - 1; k++) {
      const p = pts[k];
      const a = pts[k - 1];
      const b = pts[k + 1];
      const r1 = Math.min(r, Math.hypot(p[0] - a[0], p[1] - a[1]) / 2);
      const r2 = Math.min(r, Math.hypot(b[0] - p[0], b[1] - p[1]) / 2);
      const p1 = add(p, scale(unit(sub(a, p)), r1));
      const p2 = add(p, scale(unit(sub(b, p)), r2));
      out.push({ t: "L", p: p1 }, { t: "C", c1: [(p1[0] + p[0] * 1.2) / 2.2, (p1[1] + p[1] * 1.2) / 2.2], c2: [(p2[0] + p[0] * 1.2) / 2.2, (p2[1] + p[1] * 1.2) / 2.2], p: p2 });
    }
    out.push({ t: "L", p: pts[pts.length - 1] });
    if (closed) out.push({ t: "Z" });
    i = closed ? j + 1 : j;
  }
  return out;
}

/** Splits \rput's argument into box commands, graphics and text. */
function splitBoxes(s: string): { kind: "cmd" | "graphics" | "text"; text: string }[] {
  const out: { kind: "cmd" | "graphics" | "text"; text: string }[] = [];
  let text = "";
  let i = 0;
  let graphics = "";
  const flush = () => {
    if (text.trim()) out.push({ kind: "text", text });
    text = "";
  };
  while (i < s.length) {
    const m = /^\\([A-Za-z@]+)(\*?)/.exec(s.slice(i, i + 40));
    if (m && m[1] !== "color" && (BOX_COMMANDS.has(m[1]) || COMMANDS.has(m[1]))) {
      // The command and its arguments: options, arrows, coordinates and braces that follow.
      let j = i + m[0].length;
      for (;;) {
        let k = j;
        while (k < s.length && /\s/.test(s[k])) k++;
        const c = s[k];
        if (c === "[" || c === "(" || c === "{") {
          const e = matchClose(s, k);
          if (e < 0) {
            j = s.length;
            break;
          }
          // Text after a box command is not its argument once the box has its arguments.
          j = e + 1;
          if (c === "{" && BOX_COMMANDS.has(m[1]) && boxArgsDone(m[1], s.slice(i, j))) break;
          continue;
        }
        break;
      }
      const piece = s.slice(i, j);
      if (BOX_COMMANDS.has(m[1])) {
        flush();
        if (graphics) {
          out.push({ kind: "graphics", text: graphics });
          graphics = "";
        }
        out.push({ kind: "cmd", text: piece });
      } else {
        if (text.trim()) flush();
        graphics += piece;
      }
      i = j;
      continue;
    }
    if (m && graphics && /^(psset|SpecialCoor|NormalCoor|definecolor|newrgbcolor)$/.test(m[1])) {
      let j = i + m[0].length;
      while (s[j] === "{" || s[j] === "[") {
        const e = matchClose(s, j);
        if (e < 0) break;
        j = e + 1;
      }
      graphics += s.slice(i, j);
      i = j;
      continue;
    }
    if (graphics && /\s/.test(s[i])) {
      graphics += s[i++];
      continue;
    }
    if (graphics) {
      out.push({ kind: "graphics", text: graphics });
      graphics = "";
    }
    if (s[i] === "\\") {
      const w = /^\\(?:[A-Za-z@]+\*?|.)/.exec(s.slice(i, i + 40))!;
      text += w[0];
      i += w[0].length;
      continue;
    }
    if (s[i] === "{") {
      const e = matchClose(s, i);
      const end = e < 0 ? s.length : e + 1;
      text += s.slice(i, end);
      i = end;
      continue;
    }
    if (s[i] === "$") {
      // Math stays whole.
      let k = i + 1;
      while (k < s.length && s[k] !== "$") k += s[k] === "\\" ? 2 : 1;
      text += s.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    text += s[i++];
  }
  if (graphics) out.push({ kind: "graphics", text: graphics });
  flush();
  return out;
}

/** Number of brace arguments box commands take. */
const BOX_BRACES: Record<string, number> = {
  rnode: 2, Rnode: 2, circlenode: 2, ovalnode: 2, dianode: 2, trinode: 2, dotnode: 1, pstree: 2, parbox: 2, fcolorbox: 3, colorbox: 2, textcolor: 2, scalebox: 2, psscalebox: 2, rotatebox: 2, makebox: 1, framebox: 1,
};

function boxArgsDone(name: string, text: string): boolean {
  const need = BOX_BRACES[name] ?? 1;
  let n = 0;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "\\") {
      k++;
      continue;
    }
    if (text[k] === "{") {
      const e = matchClose(text, k);
      if (e < 0) return true;
      n++;
      k = e;
    } else if (text[k] === "[" || text[k] === "(") {
      const e = matchClose(text, k);
      if (e < 0) return true;
      k = e;
    }
  }
  return n >= need;
}

/** Commands accepted and ignored, with what they take (o = [opt], m = {arg}, c = (coord)). */
const IGNORED = new Map<string, string>([
  ["SpecialCoor", ""], ["NormalCoor", ""], ["centering", ""], ["noindent", ""], ["par", ""], ["relax", ""], ["psclipdebug", ""], ["makeatletter", ""], ["makeatother", ""],
  ["small", ""], ["footnotesize", ""], ["scriptsize", ""], ["tiny", ""], ["normalsize", ""], ["large", ""], ["Large", ""], ["LARGE", ""], ["huge", ""], ["Huge", ""],
  ["bfseries", ""], ["itshape", ""], ["sffamily", ""], ["rmfamily", ""], ["ttfamily", ""], ["normalfont", ""], ["selectfont", ""],
  ["vspace", "m"], ["hspace", "m"], ["label", "m"], ["caption", "om"], ["psverbboxtrue", ""], ["psverbboxfalse", ""], ["pstVerb", "m"], ["pstverb", "m"], ["addtopsstyle", "mm"],
  ["degrees", "o"], ["radians", ""], ["psdebug", ""], ["showgrid", ""], ["psmatrix", ""], ["endpsmatrix", ""], ["usepackage", "om"], ["pstheader", "m"], ["psScalebox", "m"], ["quad", ""], ["qquad", ""], ["hfill", ""], ["vfill", ""], ["ignorespaces", ""],
  ["psDefBoxNodes", "mm"], ["newpath", ""], ["closepath", ""], ["pslbrace", ""], ["psrbrace", ""], ["leavevmode", ""], ["strut", ""], ["psclipdebugtrue", ""],
]);

function skipArgs(sc: Scanner, spec: string): void {
  for (const k of spec) {
    if (k === "o") sc.options();
    else if (k === "m") {
      sc.ws();
      if (sc.s[sc.i] === "{") sc.group("{");
    } else if (k === "c") sc.group("(");
  }
}

// ---------------------------------------------------------------- box commands

type BoxHandler = (it: PstInterp, sc: Scanner, st: PState, star: boolean, base: number, exact: boolean) => PBox | undefined;
export const BOXES = new Map<string, BoxHandler>();
export function box(names: string, h: BoxHandler): void {
  for (const n of names.split(/\s+/)) if (n) BOXES.set(n, h);
}

box("psframebox pscirclebox psovalbox psdiabox pstribox psshadowbox psdblframebox", (it, sc, st, star, base, exact) => {
  const name = /^\\([A-Za-z]+)/.exec(sc.s)![1];
  const opts = sc.options();
  const s2 = cloneState(st);
  it.set(s2, opts);
  sc.ws();
  const start = sc.i + 1;
  const body = it.arg(sc) ?? "";
  const inner = it.makeBox(body, st, base + start, exact);
  return it.frameBox(name, inner, s2, star);
});

box("fbox framebox", (it, sc, st, _star, base, exact) => {
  sc.options();
  sc.options();
  const body = it.arg(sc) ?? "";
  const s2 = cloneState(st);
  s2.lw = 0.4;
  s2.framesep = 3;
  s2.fillstyle = "none";
  s2.linestyle = "solid";
  s2.lc = "#000000";
  return it.frameBox("psframebox", it.makeBox(body, st, base, exact), s2, false);
});

box("mbox hbox makebox textcolor colorbox", (it, sc, st, _star, base, exact) => {
  const name = /^\\([A-Za-z]+)/.exec(sc.s)![1];
  if (name === "makebox") {
    sc.options();
    sc.options();
  }
  if (name === "textcolor" || name === "colorbox") {
    const c = color(it.arg(sc) ?? "", it.colors);
    const body = it.arg(sc) ?? "";
    const s2 = cloneState(st);
    if (name === "textcolor") {
      if (c) s2.textColor = c;
      return it.makeBox(body, s2, base, exact);
    }
    s2.fillstyle = "solid";
    s2.fc = c ?? "#ffffff";
    s2.linestyle = "none";
    return it.frameBox("psframebox", it.makeBox(body, st, base, exact), s2, false);
  }
  return it.makeBox(it.arg(sc) ?? "", st, base, exact);
});

box("parbox", (it, sc, st) => {
  sc.options();
  sc.options();
  sc.options();
  const w = it.len(it.arg(sc), CM, st) ?? 100;
  return it.textBox(it.arg(sc) ?? "", st, Math.max(10, Math.min(w, 2000)));
});

box("shortstack", (it, sc, st) => {
  sc.options();
  return it.textBox(it.arg(sc) ?? "", st);
});

box("scalebox psscalebox", (it, sc, st, _star, base, exact) => {
  const sv = (it.arg(sc) ?? "1").trim().split(/\s+/);
  const sx = it.number(sv[0]) ?? 1;
  const sy = sv[1] !== undefined ? (it.number(sv[1]) ?? sx) : sx;
  sc.options();
  const inner = it.makeBox(it.arg(sc) ?? "", st, base, exact);
  return scaledBox(inner, sx, sy);
});

box("rotatebox", (it, sc, st, _star, base, exact) => {
  sc.options();
  const a = it.number(it.arg(sc)) ?? 0;
  const inner = it.makeBox(it.arg(sc) ?? "", st, base, exact);
  const r = (a * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const W = inner.w * c + (inner.h + inner.d) * s;
  const H = inner.w * s + (inner.h + inner.d) * c;
  return {
    w: W,
    h: H / 2 + (inner.h - inner.d) / 2,
    d: H / 2 - (inner.h - inner.d) / 2,
    shape: "rectangle",
    hw: W / 2,
    hh: H / 2,
    draw: (M) => {
      // Turn about the box's centre.
      const cx = W / 2;
      const cy = (inner.h - inner.d) / 2;
      inner.draw(mul(M, mul([1, 0, 0, 1, cx, cy], mul(rotation(a), [1, 0, 0, 1, -inner.w / 2, -cy]))));
    },
  };
});

export function scaledBox(inner: PBox, sx: number, sy: number): PBox {
  return {
    w: inner.w * Math.abs(sx),
    h: inner.h * Math.abs(sy),
    d: inner.d * Math.abs(sy),
    shape: inner.shape,
    hw: inner.hw * Math.abs(sx),
    hh: inner.hh * Math.abs(sy),
    draw: (M) => inner.draw(mul(M, [sx, 0, 0, sy, 0, 0])),
  };
}

// ---------------------------------------------------------------- \pscustom

const CUSTOM = new Map<string, (c: Call) => void>();
function custom(names: string, h: (c: Call) => void): void {
  for (const n of names.split(/\s+/)) CUSTOM.set(n, h);
}

function lastPoint(segs: Seg[]): Pt | undefined {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.t !== "Z") return s.p;
    // After closepath the current point is the subpath's start.
    for (let k = i - 1; k >= 0; k--) if (segs[k].t === "M") return (segs[k] as { p: Pt }).p;
  }
  return undefined;
}

custom("moveto", ({ it, sc, st }) => {
  const p = it.coord(sc.group("(") ?? "", st);
  if (p) it.custom!.segs.push({ t: "M", p });
});
custom("lineto", ({ it, sc, st }) => {
  for (const c of it.coordList(sc)) {
    const p = it.coord(c, st);
    if (p) it.custom!.segs.push(it.custom!.segs.length ? { t: "L", p } : { t: "M", p });
  }
});
custom("rlineto", ({ it, sc, st }) => {
  for (const c of it.coordList(sc)) {
    const d = it.coord(c, { ...st, T: [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0] });
    const cur = lastPoint(it.custom!.segs) ?? apply(st.T, [0, 0]);
    if (d) it.custom!.segs.push({ t: "L", p: add(cur, d) });
  }
});
custom("curveto rcurveto", ({ it, sc, st, name }) => {
  const cs = it.coordList(sc, 3);
  const lin = name === "rcurveto" ? ({ ...st, T: [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0] } as PState) : st;
  const pts = it.coords(cs, lin);
  if (pts.length !== 3) return;
  const cur = lastPoint(it.custom!.segs) ?? apply(st.T, [0, 0]);
  const off = name === "rcurveto" ? cur : ([0, 0] as Pt);
  if (!it.custom!.segs.length) it.custom!.segs.push({ t: "M", p: cur });
  it.custom!.segs.push({ t: "C", c1: add(off, pts[0]), c2: add(off, pts[1]), p: add(off, pts[2]) });
});
custom("closepath", ({ it }) => {
  if (it.custom!.segs.length) it.custom!.segs.push({ t: "Z" });
});
custom("newpath", ({ it }) => {
  it.custom!.segs.length = 0;
});
custom("stroke fill", ({ it, sc, st, name }) => {
  const opts = sc.options();
  const s2 = cloneState(st);
  if (name === "fill" && !opts) s2.fillstyle = it.custom!.st.fillstyle === "none" ? "solid" : it.custom!.st.fillstyle;
  it.set(s2, opts);
  const segs = [...it.custom!.segs];
  const saved = it.custom;
  it.custom = undefined;
  if (name === "stroke") {
    s2.fillstyle = "none";
    it.drawPath(segs, s2, { noArrows: true });
  } else {
    s2.linestyle = "none";
    if (s2.fillstyle === "none") s2.fillstyle = "solid";
    it.drawPath(segs, s2, { closed: true });
  }
  it.custom = saved;
});
custom("gsave msave", ({ it, st }) => {
  it.custom!.stack.push(cloneState(st));
});
custom("grestore mrestore", ({ it, st }) => {
  const s = it.custom!.stack.pop();
  if (s) Object.assign(st, s);
});
custom("translate", ({ it, sc, st }) => {
  const p = it.coord(sc.group("(") ?? "", st);
  if (p) st.T = [st.T[0], st.T[1], st.T[2], st.T[3], p[0], p[1]];
});
custom("rotate", ({ it, sc, st }) => {
  const a = it.number(it.arg(sc)) ?? 0;
  st.T = mul(st.T, rotation(a));
});
custom("scale", ({ it, sc, st }) => {
  const v = (it.arg(sc) ?? "1").trim().split(/\s+/);
  const sx = it.number(v[0]) ?? 1;
  st.T = mul(st.T, [sx, 0, 0, it.number(v[1] ?? v[0]) ?? sx, 0, 0]);
});
custom("movepath", ({ it, sc, st }) => {
  const d = it.coord(sc.group("(") ?? "", { ...st, T: [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0] });
  if (d) it.custom!.segs = translateSegs(it.custom!.segs, d);
});
custom("swapaxes openshadow closedshadow code coor rcoor setcolor arrows file", ({ it, sc, name }) => {
  sc.options();
  if (name === "coor" || name === "rcoor") it.coordList(sc);
  else if (name !== "swapaxes" && name !== "openshadow" && name !== "closedshadow") it.arg(sc);
  if (name === "code") it.warnOnce("pscustom-code", "\\code{...} PostScript inside \\pscustom was left out");
});

cmd("pscustom", ({ it, sc, st, star, base }) => {
  const opts = sc.options();
  const s2 = cloneState(st);
  it.set(s2, opts);
  if (star) {
    s2.fillstyle = "solid";
    s2.fc = s2.lc;
  }
  sc.ws();
  const start = sc.i + 1;
  const body = it.arg(sc) ?? "";
  if (it.custom) {
    it.run(body, base + start, s2);
    return;
  }
  const inner = cloneState(s2);
  inner.arrows = "-";
  it.custom = { segs: [], st: s2, stack: [] };
  try {
    it.run(body, base + start, inner);
  } finally {
    const segs = it.custom.segs;
    it.custom = undefined;
    if (segs.length) it.drawPath(segs, s2, { closed: segs[segs.length - 1].t === "Z" });
  }
});

// ---------------------------------------------------------------- \psclip

cmd("psclip", ({ it, sc, st, base }) => {
  const start = sc.i + 1;
  const body = it.arg(sc) ?? "";
  const saved = it.capture;
  it.capture = [];
  let segs: Seg[] = [];
  try {
    it.run(body, base + start, cloneState(st));
  } finally {
    segs = it.capture;
    it.capture = saved;
  }
  if (segs.length) st.clips = [...st.clips, it.scene.clipPath(segs)];
});
cmd("endpsclip", ({ st }) => {
  st.clips = st.clips.slice(0, -1);
});

// ---------------------------------------------------------------- settings, colours, styles, macros

cmd("psset", ({ it, sc, st }) => {
  it.set(st, it.arg(sc));
});

cmd("newpsstyle", ({ it, sc }) => {
  const name = (it.arg(sc) ?? "").trim();
  const body = it.arg(sc) ?? "";
  if (name) it.styles.set(name, body);
});

cmd("addtopsstyle", ({ it, sc }) => {
  const name = (it.arg(sc) ?? "").trim();
  const body = it.arg(sc) ?? "";
  if (name) it.styles.set(name, `${it.styles.get(name) ?? ""},${body}`);
});

cmd("newpsobject", ({ it, sc }) => {
  const name = (it.arg(sc) ?? "").trim().replace(/^\\/, "");
  const object = (it.arg(sc) ?? "").trim().replace(/^\\/, "");
  const opts = it.arg(sc) ?? "";
  if (name && object) it.objects.set(name, { object, opts });
});

function defineColor(it: PstInterp, name: string, rgb: RGB | undefined): void {
  if (!name || !rgb || rgb.some((v) => !Number.isFinite(v))) return;
  it.colors.local.set(name, rgb.map((v) => Math.max(0, Math.min(255, v))) as RGB);
  it.colorMacros.add(name);
}

cmd("newrgbcolor newgray newcmykcolor newhsbcolor", ({ it, sc, name }) => {
  const n = (it.arg(sc) ?? "").trim().replace(/^\\/, "");
  const v = (it.arg(sc) ?? "").trim().split(/[\s,]+/).map(Number);
  if (name === "newrgbcolor" && v.length === 3) defineColor(it, n, v.map((x) => x * 255) as RGB);
  else if (name === "newgray" && v.length >= 1) defineColor(it, n, [v[0] * 255, v[0] * 255, v[0] * 255]);
  else if (name === "newcmykcolor" && v.length === 4) defineColor(it, n, [v[0], v[1], v[2]].map((x) => 255 * (1 - Math.min(1, x + v[3]))) as RGB);
  else if (name === "newhsbcolor" && v.length === 3) defineColor(it, n, hsb(v[0], v[1], v[2]));
});

function hsb(h: number, s: number, b: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = b * (1 - s);
  const q = b * (1 - f * s);
  const t = b * (1 - (1 - f) * s);
  const c = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][((i % 6) + 6) % 6];
  return c.map((x) => x * 255) as RGB;
}

cmd("definecolor colorlet", ({ it, sc, name }) => {
  sc.options();
  const n = (it.arg(sc) ?? "").trim();
  if (name === "colorlet") {
    const c = color(it.arg(sc) ?? "", it.colors);
    if (c) defineColor(it, n, [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as RGB);
    return;
  }
  const model = (it.arg(sc) ?? "").trim();
  const spec = (it.arg(sc) ?? "").trim();
  const v = spec.split(/[\s,]+/).filter(Boolean).map(Number);
  let rgb: RGB | undefined;
  if (model === "rgb" && v.length === 3) rgb = v.map((x) => x * 255) as RGB;
  else if (model === "RGB" && v.length === 3) rgb = v as RGB;
  else if (model === "gray" && v.length === 1) rgb = [v[0] * 255, v[0] * 255, v[0] * 255];
  else if (model === "cmyk" && v.length === 4) rgb = [v[0], v[1], v[2]].map((x) => 255 * (1 - Math.min(1, x + v[3]))) as RGB;
  else if (model === "HTML" && /^[0-9a-fA-F]{6}$/.test(spec)) rgb = [0, 2, 4].map((i) => parseInt(spec.slice(i, i + 2), 16)) as RGB;
  else if (model === "hsb" && v.length === 3) rgb = hsb(v[0], v[1], v[2]);
  defineColor(it, n, rgb);
});

cmd("color", ({ it, sc, st }) => {
  sc.options();
  const c = color(it.arg(sc) ?? "", it.colors);
  if (c) st.textColor = c;
});

cmd("def gdef edef xdef", ({ it, sc }) => {
  sc.ws();
  const m = /^\\([A-Za-z@]+)((?:#\d)*)/.exec(sc.s.slice(sc.i, sc.i + 80));
  if (!m) return;
  sc.i += m[0].length;
  const body = it.arg(sc) ?? "";
  it.macros.set(m[1], { nargs: m[2].length / 2, body });
  it.mathMacros[`\\${m[1]}`] = body;
});

cmd("newcommand renewcommand providecommand DeclareRobustCommand", ({ it, sc, name }) => {
  sc.ws();
  let nm: string | undefined;
  if (sc.s[sc.i] === "{") nm = sc.group("{");
  else {
    const m = /^\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i, sc.i + 80));
    if (m) {
      sc.i += m[0].length;
      nm = m[0];
    }
  }
  const nargs = Number(sc.options() ?? "0") || 0;
  const opt = sc.peek() === "[" ? sc.options() : undefined;
  const body = it.arg(sc) ?? "";
  const key = (nm ?? "").trim().replace(/^\\/, "");
  if (!key) return;
  if (name === "providecommand" && it.macros.has(key)) return;
  it.macros.set(key, { nargs: Math.min(9, nargs), body, ...(opt !== undefined ? { opt } : {}) });
  it.mathMacros[`\\${key}`] = body;
});

cmd("let", ({ it, sc }) => {
  const m = /^\s*\\([A-Za-z@]+)\s*=?\s*\\([A-Za-z@]+)/.exec(sc.s.slice(sc.i, sc.i + 80));
  if (!m) return;
  sc.i += m[0].length;
  const src = it.macros.get(m[2]);
  if (src) it.macros.set(m[1], src);
});

cmd("begin end", ({ it, sc, st, base, name }) => {
  const env = (it.arg(sc) ?? "").trim();
  if (name === "end") return;
  // Environments inside a picture: a nested pspicture or scope-like groups run in place.
  if (env === "pspicture" || env === "pspicture*") {
    while (sc.peek() === "[") sc.options();
    it.coordList(sc, 2);
    return;
  }
  if (env === "psclip") return;
  if (env === "center" || env === "scope" || env === "psgroup") return;
  it.warnOnce(`env:${env}`, `Environment ${env} inside a pspicture was read as plain picture code`);
  void st;
  void base;
});

// ---------------------------------------------------------------- \multido and friends

/** Values of a \multido variable spec `\i=0+1`. */
function multidoVars(spec: string, it: PstInterp): { name: string; at: (k: number) => string }[] {
  const out: { name: string; at: (k: number) => string }[] = [];
  for (const part of splitTop(spec, ",")) {
    const m = /^\s*\\([A-Za-z@]+)\s*=\s*([^+]*?)\s*\+\s*(.*)$/s.exec(part);
    if (!m) continue;
    const name = m[1];
    const kind = name[0].toLowerCase();
    const s0 = it.expandText(m[2]).trim();
    const inc0 = it.expandText(m[3]).trim();
    if (kind === "d") {
      const mm = /^([-+]?\d*\.?\d*)\s*([a-z]{2})?$/.exec(s0);
      const ii = /^([-+]?\d*\.?\d*)\s*([a-z]{2})?$/.exec(inc0);
      const a = Number(mm?.[1] ?? 0) || 0;
      const b = Number(ii?.[1] ?? 0) || 0;
      const u = mm?.[2] ?? ii?.[2] ?? "pt";
      out.push({ name, at: (k) => `${fmtNum(a + k * b, 5)}${u}` });
      continue;
    }
    const a = Number(s0);
    const b = Number(inc0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (kind === "i") out.push({ name, at: (k) => String(Math.round(a + k * b)) });
    else if (kind === "n") {
      // \n keeps the decimals the start or increment were written with.
      const dec = Math.max((s0.split(".")[1] ?? "").length, (inc0.split(".")[1] ?? "").length);
      out.push({ name, at: (k) => (a + k * b).toFixed(dec) });
    } else out.push({ name, at: (k) => fmtNum(a + k * b, 5) });
  }
  return out;
}

export function fmtNum(v: number, dec = 4): string {
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Substitutes loop variables in a body. */
export function substitute(body: string, vals: Map<string, string>): string {
  if (!vals.size) return body;
  return body.replace(/\\([A-Za-z@]+)(?![A-Za-z@])/g, (m0, n: string) => vals.get(n) ?? m0);
}

cmd("multido mmultido Multido fmultido", ({ it, sc, st }) => {
  const spec = it.arg(sc) ?? "";
  const nRaw = it.arg(sc) ?? "0";
  const body = it.arg(sc) ?? "";
  const n0 = it.number(nRaw);
  if (n0 === undefined) {
    it.warn(`\\multido needs a number of repetitions, not "${nRaw.trim()}"`);
    return;
  }
  const vars = multidoVars(spec, it);
  const n = Math.min(Math.abs(Math.trunc(n0)), 10_000);
  if (Math.abs(n0) > 10_000) it.warnOnce("multido-cap", "\\multido was cut to 10000 repetitions");
  const off = it.off;
  for (let k = 0; k < n; k++) {
    it.iterate();
    const vals = new Map(vars.map((v) => [v.name, v.at(k)]));
    const text = substitute(body, vals);
    it.grow(text.length);
    it.run(text, off, st, false);
  }
});

cmd("rput", (c) => rput(c, false));
cmd("uput", (c) => rput(c, true));

/** \cput[options]{rot}(x,y){stuff}: a circled box centred at the point. */
cmd("cput", ({ it, sc, st, star, base, exact }) => {
  const s2 = cloneState(st);
  it.set(s2, sc.options());
  let rotRaw: string | undefined;
  if (sc.peek() === "{") rotRaw = sc.group("{");
  const cs = it.coordList(sc, 1);
  sc.ws();
  const start = sc.i + 1;
  const stuff = it.arg(sc) ?? "";
  const P = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  if (!P) return;
  const bx = it.frameBox("pscirclebox", it.makeBox(stuff, st, base + start, exact), s2, star);
  it.place(bx, P, refPoint(bx, undefined), rotationArg(rotRaw, it), st);
});

/** \rput[ref]{rot}(x,y){stuff} and \uput{sep}[angle]{rot}(x,y){stuff}. */
function rput({ it, sc, st, star, base, exact }: Call, isUput: boolean): void {
  let sepRaw: string | undefined;
  if (isUput && sc.peek() === "{") sepRaw = sc.group("{");
  const ref = sc.options();
  let rotRaw: string | undefined;
  if (sc.peek() === "{") rotRaw = sc.group("{");
  const cs = it.coordList(sc, 1);
  sc.ws();
  const start = sc.i + 1;
  const stuff = it.arg(sc) ?? "";
  const P = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  if (!P) return;
  let bx = it.makeBox(stuff, st, base + start, exact);
  if (star) bx = it.frameBox("psframebox", bx, { ...cloneState(st), fillstyle: "solid", fc: "#ffffff", linestyle: "none", framesep: 1 }, true);
  const rot = rotationArg(rotRaw, it);
  if (!isUput) {
    it.place(bx, P, refPoint(bx, ref), rot, st);
    return;
  }
  const ang = uputAngle(ref, it);
  const sep = sepRaw !== undefined ? (it.len(sepRaw, st.xunit, st) ?? st.labelsep) : st.labelsep;
  // The direction is in the picture's frame; the box keeps its own rotation.
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  const v = applyLinear(L, dir(ang));
  const vl = Math.hypot(v[0], v[1]) || 1;
  const Q = add(P, scale(v, sep / vl));
  const s2 = { ...st, T: ID } as PState;
  const turned = (Math.atan2(st.T[1], st.T[0]) * 180) / Math.PI;
  const angBox = ang - rot;
  it.place(bx, Q, uputRef(bx, angBox), rot + turned, s2);
}

cmd("multirput multips", ({ it, sc, st, base, exact, name }) => {
  const ref = name === "multirput" ? sc.options() : undefined;
  if (name === "multips") sc.options();
  let rotRaw: string | undefined;
  if (sc.peek() === "{") rotRaw = sc.group("{");
  const cs = it.coordList(sc, 2);
  const nRaw = it.arg(sc) ?? "0";
  sc.ws();
  const start = sc.i + 1;
  const stuff = it.arg(sc) ?? "";
  const n = Math.min(Math.max(0, Math.trunc(it.number(nRaw) ?? 0)), 5_000);
  const p0 = cs.length === 2 ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  const dRaw = cs.length === 2 ? cs[1] : cs[0];
  const d = dRaw !== undefined ? it.coord(dRaw, { ...st, T: L }) : undefined;
  if (!p0 || !d) return;
  const rot = rotationArg(rotRaw, it);
  for (let k = 0; k < n; k++) {
    it.iterate();
    const P = add(p0, scale(d, k));
    if (name === "multips") {
      const s2 = cloneState(st);
      s2.T = mul(mul([1, 0, 0, 1, P[0], P[1]], L), rotation(rot));
      it.run(stuff, base + start, s2, exact);
    } else {
      const bx = it.makeBox(stuff, st, base + start, exact);
      it.place(bx, P, refPoint(bx, ref), rot, st);
    }
  }
});

cmd("psrotate", ({ it, sc, st, base }) => {
  sc.options();
  const c = it.coord(sc.group("(") ?? "", st) ?? apply(st.T, [0, 0]);
  const a = it.number(it.arg(sc)) ?? 0;
  sc.ws();
  const start = sc.i + 1;
  const body = it.arg(sc) ?? "";
  const s2 = cloneState(st);
  s2.T = mul(mul([1, 0, 0, 1, c[0], c[1]], rotation(a)), mul([1, 0, 0, 1, -c[0], -c[1]], st.T));
  it.run(body, base + start, s2);
});

cmd("psscalebox scalebox rotatebox psframebox pscirclebox psovalbox psdiabox pstribox psshadowbox psdblframebox", ({ it, sc, st, star, base, exact, name }) => {
  // A box in the picture's flow sits with its left baseline at the origin.
  const startAt = sc.i;
  const textStart = startAt - name.length - 1 - (star ? 1 : 0);
  let end = startAt;
  const tmp = new Scanner(sc.s);
  tmp.i = startAt;
  for (;;) {
    const c = tmp.peek();
    if (c === "[" || c === "{") {
      tmp.group(c);
      end = tmp.i;
      if (c === "{" && boxArgsDone(name, sc.s.slice(textStart, end))) break;
      continue;
    }
    break;
  }
  sc.i = end;
  const bx = it.commandBox(`\\${name}${star ? "*" : ""}${sc.s.slice(startAt, end)}`, st, base + startAt, exact);
  it.place(bx, apply(st.T, [0, 0]), [0, 0], 0, st);
});

// ---------------------------------------------------------------- basic objects

/** Reads [options]{arrows} and returns the object's state. */
export function objectState(c: Call): { st: PState; arrows?: string } {
  const opts = c.sc.options();
  const st = cloneState(c.st);
  c.it.set(st, opts);
  const arrows = c.it.arrowsArg(c.sc, st);
  if (arrows !== undefined) st.arrows = arrows;
  if (c.star) {
    // Starred objects are filled with the line colour and not stroked.
    st.fillstyle = "solid";
    st.fc = st.lc;
    st.linestyle = "none";
    st.shadow = false;
  }
  return { st, ...(arrows !== undefined ? { arrows } : {}) };
}

/** The current point an object starts from when it has one coordinate too few. */
function startPoint(it: PstInterp, st: PState): Pt {
  if (it.custom?.segs.length) return lastPoint(it.custom.segs) ?? apply(st.T, [0, 0]);
  return apply(st.T, [0, 0]);
}

cmd("psline qline", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, c.name === "qline" ? 2 : 100_000);
  let pts = it.coords(cs, st);
  if (cs.length === 1 && pts.length === 1) pts = [startPoint(it, st), pts[0]];
  if (pts.length < 2) return;
  it.drawPath(polySegs(pts, false), st);
  if (st.showpoints) for (const p of pts) it.dot(p, st);
});

cmd("pspolygon", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  let pts = it.coords(it.coordList(sc), st);
  if (pts.length === 2) pts = [startPoint(it, st), ...pts];
  if (pts.length < 2) return;
  it.drawPath(polySegs(pts, true), st, { closed: true });
  if (st.showpoints) for (const p of pts) it.dot(p, st);
});

cmd("psframe", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 2);
  let pts = it.coords(cs, st);
  if (cs.length === 1 && pts.length === 1) pts = [apply(st.T, [0, 0]), pts[0]];
  if (pts.length !== 2) return;
  const inv = invert(st.T);
  const a = apply(inv, pts[0]);
  const b = apply(inv, pts[1]);
  const r = st.framearc > 0 ? (st.framearc * Math.min(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) / 2 : 0;
  it.drawPath(rectSegs(a, b, r, (p) => apply(st.T, p)), st, { closed: true });
});

cmd("psdiamond pstriangle", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 2);
  if (cs.length !== 2) return;
  const ctr = it.coord(cs[0], st);
  const wh = it.coord(cs[1], { ...st, T: ID });
  if (!ctr || !wh) return;
  const [w, h] = wh;
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  const f = (p: Pt) => add(ctr, applyLinear(L, p));
  const pts: Pt[] = name === "psdiamond" ? [[w, 0], [0, h], [-w, 0], [0, -h]] : [[-w / 2, 0], [w / 2, 0], [0, h]];
  it.drawPath(polySegs(pts.map(f), true), st, { closed: true });
});

/** Segments of a full ellipse with axis vectors ex, ey around c. */
export function ellipseSegs(c: Pt, ex: Pt, ey: Pt): Seg[] {
  const a = arcCubics(c, ex, ey, 0, 360);
  return [{ t: "M", p: a.start }, ...a.segs.map((s) => ({ t: "C" as const, ...s })), { t: "Z" }];
}

cmd("pscircle", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 1);
  const ctr = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const r = it.len(it.arg(sc), st.runit, st);
  if (!ctr || r === undefined) return;
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  it.drawPath(ellipseSegs(ctr, applyLinear(L, [r, 0]), applyLinear(L, [0, r])), st, { closed: true });
});

cmd("qdisk", ({ it, sc, st }) => {
  const ctr = it.coord(sc.group("(") ?? "", st);
  const r = it.len(it.arg(sc), st.runit, st);
  if (!ctr || r === undefined) return;
  const s2 = cloneState(st);
  s2.fillstyle = "solid";
  s2.fc = st.lc;
  s2.linestyle = "none";
  s2.shadow = false;
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  it.drawPath(ellipseSegs(ctr, applyLinear(L, [r, 0]), applyLinear(L, [0, r])), s2, { closed: true });
});

cmd("psellipse", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 2);
  if (!cs.length) return;
  const ctr = cs.length === 2 ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const rr = it.coord(cs[cs.length - 1], { ...st, T: ID });
  if (!ctr || !rr) return;
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  it.drawPath(ellipseSegs(ctr, applyLinear(L, [Math.abs(rr[0]), 0]), applyLinear(L, [0, Math.abs(rr[1])])), st, { closed: true });
});

/** Arc segments (cubics) from a0 to a1 degrees, counterclockwise when a1 > a0. */
export function arcSegs(ctr: Pt, ex: Pt, ey: Pt, a0: number, a1: number, move = true): Seg[] {
  const a = arcCubics(ctr, ex, ey, a0, a1);
  return [...(move ? [{ t: "M" as const, p: a.start }] : [{ t: "L" as const, p: a.start }]), ...a.segs.map((s) => ({ t: "C" as const, ...s }))];
}

cmd("psarc psarcn pswedge psellipticarc psellipticarcn psellipticwedge", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const elliptic = name.startsWith("psellipt");
  const cs = it.coordList(sc, elliptic ? 2 : 1);
  let ctr: Pt | undefined;
  let ex: Pt;
  let ey: Pt;
  const L: Mat = [st.T[0], st.T[1], st.T[2], st.T[3], 0, 0];
  if (elliptic) {
    ctr = cs.length === 2 ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
    const rr = cs.length ? it.coord(cs[cs.length - 1], { ...st, T: ID }) : undefined;
    if (!rr) return;
    ex = applyLinear(L, [Math.abs(rr[0]), 0]);
    ey = applyLinear(L, [0, Math.abs(rr[1])]);
  } else {
    ctr = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
    const r = it.len(it.arg(sc), st.runit, st);
    if (r === undefined) return;
    ex = applyLinear(L, [r, 0]);
    ey = applyLinear(L, [0, r]);
  }
  let a0 = it.number(it.arg(sc));
  let a1 = it.number(it.arg(sc));
  if (!ctr || a0 === undefined || a1 === undefined) return;
  const clockwise = name.endsWith("n");
  if (!clockwise) {
    while (a1 <= a0) a1 += 360;
    if (a1 - a0 > 360) a1 -= 360;
  } else {
    while (a1 >= a0) a1 -= 360;
    if (a0 - a1 > 360) a1 += 360;
  }
  if (Math.abs(a1 - a0) > 3600) {
    a0 = 0;
    a1 = 360;
  }
  const arc = arcSegs(ctr, ex, ey, a0, a1);
  if (name === "pswedge" || name === "psellipticwedge") {
    it.drawPath([{ t: "M", p: ctr }, { t: "L", p: (arc[0] as { p: Pt }).p }, ...arc.slice(1), { t: "Z" }], st, { closed: true });
  } else it.drawPath(arc, st);
});

cmd("psdot psdots", (c) => {
  const { it, sc } = c;
  const opts = sc.options();
  const st = cloneState(c.st);
  it.set(st, opts);
  if (c.star) st.dotstyle = "*";
  const pts = it.coords(it.coordList(sc, c.name === "psdot" ? 1 : 100_000), st);
  if (it.custom) return;
  for (const p of pts) it.dot(p, st);
});

cmd("psbezier", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  let pts = it.coords(it.coordList(sc), st);
  if (pts.length === 3) pts = [startPoint(it, st), ...pts];
  if (pts.length < 4) return;
  const segs: Seg[] = [{ t: "M", p: pts[0] }];
  for (let k = 1; k + 2 < pts.length; k += 3) segs.push({ t: "C", c1: pts[k], c2: pts[k + 1], p: pts[k + 2] });
  it.drawPath(segs, st);
  if (st.showpoints) {
    const s2 = cloneState(st);
    s2.linestyle = "dotted";
    s2.arrows = "-";
    it.drawPath(polySegs(pts, false), s2, { noArrows: true });
    for (const p of pts) it.dot(p, st);
  }
});

/** The interpolating curve of \pscurve through `pts`. */
export function curveSegs(pts: Pt[], closed: boolean): Seg[] {
  if (pts.length < 2) return [];
  if (pts.length === 2 && !closed) return polySegs(pts, false);
  const cs = smoothThrough(pts, closed, 0.6);
  const segs: Seg[] = [{ t: "M", p: pts[0] }, ...cs.map((s) => ({ t: "C" as const, ...s }))];
  if (closed) segs.push({ t: "Z" });
  return segs;
}

cmd("pscurve psecurve psccurve", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  let pts = it.coords(it.coordList(sc), st);
  if (pts.length < 2) return;
  if (name === "psccurve") {
    it.drawPath(curveSegs(pts, true), st, { closed: true });
  } else if (name === "psecurve") {
    if (pts.length < 4) pts = pts.length === 3 ? pts : pts;
    const all = curveSegs(pts, false);
    // The first and last points only shape the ends.
    const inner = all.slice(2, all.length - 1);
    if (pts.length >= 4 && inner.length) it.drawPath([{ t: "M", p: pts[1] }, ...inner], st);
    else it.drawPath(all, st);
  } else it.drawPath(curveSegs(pts, false), st);
  if (st.showpoints) for (const p of pts) it.dot(p, st);
});

cmd("parabola", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const pts = it.coords(it.coordList(sc, 2), st);
  if (pts.length !== 2) return;
  const [p0, v] = pts;
  const p2: Pt = [2 * v[0] - p0[0], p0[1]];
  const q: Pt = [v[0], 2 * v[1] - p0[1]];
  const c1 = add(p0, scale(sub(q, p0), 2 / 3));
  const c2 = add(p2, scale(sub(q, p2), 2 / 3));
  it.drawPath([{ t: "M", p: p0 }, { t: "C", c1, c2, p: p2 }], st);
});

/** A box of `body` drawn in the picture and registered as a node; used by \rnode and the node boxes. */
export function nodeBoxOf(it: PstInterp, name: string, inner: PBox, vref?: number): PBox {
  return {
    ...inner,
    draw: (M) => {
      inner.draw(M);
      const c: Pt = [inner.w / 2, vref !== undefined ? vref : (inner.h - inner.d) / 2];
      const center = apply(M, c);
      const ax = applyLinear(M, [1, 0]);
      const k = Math.hypot(ax[0], ax[1]) || 1;
      const rot = (Math.atan2(ax[1], ax[0]) * 180) / Math.PI;
      it.addNode(name, { name, center, shape: inner.shape, hw: inner.hw * k, hh: inner.hh * k, rot, baseDy: 0 });
    },
  };
}
