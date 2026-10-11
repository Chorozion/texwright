/**
 * LaTeX math parser: tokens (after macro expansion) into the math list of
 * ast.ts. Errors are thrown as MathError with the source offset of the
 * offending token; the caller turns them into MATH001 diagnostics.
 *
 * Every construct is parsed in one left-to-right pass. Nesting (groups,
 * arguments, \left...\right, environments) is limited to MAX_DEPTH levels so
 * hostile input cannot exhaust the stack, and nothing ever rescans input, so
 * the parser runs in time linear in the expanded token count.
 */

import type { Color } from "../layout/types.js";
import type {
  ArrayKind,
  ArrayNode,
  ArrayRow,
  ColSpec,
  Dim,
  Formula,
  FracNode,
  MathFont,
  MathList,
  MathNode,
  OpNode,
  StyleName,
  SupSubNode,
  TagSpec,
  TextFont,
  TextItem,
} from "./ast.js";
import { MathError, commandFix, undefinedHint } from "./errors.js";
import { insertionEdit } from "../fixes.js";
import { packageCommand, packageCommandNames, tikzcd } from "./packages.js";
import { type Token, tokenize, untokenize } from "./lexer.js";
import { BUILTIN_MACROS, Expander, makeDef } from "./macros.js";
import {
  ACCENTS,
  ARROWS,
  type Cls,
  DELIM_NAMES,
  MATH_SYMBOLS,
  NAMED_OPS,
  type SymDef,
  TEXT_ACCENTS,
  TEXT_SYMBOLS,
  UNICODE_SYMBOLS,
} from "./symbols.js";

export const MAX_DEPTH = 120;

export type Warn = (code: "MATH002" | "MATH003" | "MATH004", message: string, offset: number, hint?: string) => void;

/** Shorthands already noted, per document (its macro table), so each is noted once. */
const noted = new WeakMap<Record<string, string>, Set<string>>();

// ---------------------------------------------------------------- tables

const MATH_FONTS: Record<string, MathFont | null> = {
  "\\mathrm": "rm",
  "\\mathit": "it",
  "\\mathbf": "bf",
  "\\mathsf": "sf",
  "\\mathtt": "tt",
  "\\mathcal": "cal",
  "\\mathbb": "bb",
  "\\mathfrak": "frak",
  "\\mathscr": "scr",
  "\\boldsymbol": "bsym",
  "\\bm": "bsym",
  "\\pmb": "bsym",
  "\\mathbfit": "bsym",
  "\\mathnormal": null,
};

const OLD_FONTS: Record<string, MathFont | null> = {
  "\\rm": "rm",
  "\\it": "it",
  "\\bf": "bf",
  "\\sf": "sf",
  "\\tt": "tt",
  "\\cal": "cal",
  "\\mit": null,
};

const CLASS_CMDS: Record<string, Cls> = {
  "\\mathord": "ord",
  "\\mathbin": "bin",
  "\\mathrel": "rel",
  "\\mathopen": "open",
  "\\mathclose": "close",
  "\\mathpunct": "punct",
  "\\mathinner": "inner",
};

const STYLES: Record<string, StyleName> = {
  "\\displaystyle": "display",
  "\\textstyle": "text",
  "\\scriptstyle": "script",
  "\\scriptscriptstyle": "scriptscript",
};

const SIZE_CMDS = new Set([
  "\\tiny",
  "\\scriptsize",
  "\\footnotesize",
  "\\small",
  "\\normalsize",
  "\\large",
  "\\Large",
  "\\LARGE",
  "\\huge",
  "\\Huge",
]);

const IGNORED = new Set(["\\relax", "\\nolinebreak", "\\m@th", "\\protect", "\\strut", "\\mathstrut@", "\\displaybreak", "\\allowdisplaybreaks", "\\limits@"]);

type SpaceSpec = { dim: Dim; stretch?: Dim; shrink?: Dim; kern: boolean };
const mu = (v: number): Dim => ({ v, u: "mu" });
const em = (v: number): Dim => ({ v, u: "em" });

const SPACES: Record<string, SpaceSpec> = {
  "\\,": { dim: mu(3), kern: false },
  "\\thinspace": { dim: mu(3), kern: false },
  "\\:": { dim: mu(4), stretch: mu(2), shrink: mu(4), kern: false },
  "\\>": { dim: mu(4), stretch: mu(2), shrink: mu(4), kern: false },
  "\\medspace": { dim: mu(4), stretch: mu(2), shrink: mu(4), kern: false },
  "\\;": { dim: mu(5), stretch: mu(5), kern: false },
  "\\thickspace": { dim: mu(5), stretch: mu(5), kern: false },
  "\\!": { dim: mu(-3), kern: false },
  "\\negthinspace": { dim: mu(-3), kern: false },
  "\\negmedspace": { dim: mu(-4), kern: false },
  "\\negthickspace": { dim: mu(-5), kern: false },
  "\\quad": { dim: em(1), kern: false },
  "\\qquad": { dim: em(2), kern: false },
  "\\enspace": { dim: em(0.5), kern: true },
  "\\enskip": { dim: em(0.5), kern: false },
  "\\ ": { dim: em(0.333333), stretch: em(0.166666), shrink: em(0.111111), kern: false },
  "\\space": { dim: em(0.333333), stretch: em(0.166666), shrink: em(0.111111), kern: false },
  "\\nobreakspace": { dim: em(0.333333), stretch: em(0.166666), shrink: em(0.111111), kern: false },
};

const BIG_SIZES: Record<string, [1 | 2 | 3 | 4, Cls]> = {};
for (const [base, size] of [
  ["big", 1],
  ["Big", 2],
  ["bigg", 3],
  ["Bigg", 4],
] as const) {
  BIG_SIZES[`\\${base}`] = [size, "ord"];
  BIG_SIZES[`\\${base}l`] = [size, "open"];
  BIG_SIZES[`\\${base}r`] = [size, "close"];
  BIG_SIZES[`\\${base}m`] = [size, "rel"];
}

/** Environments and how their bodies are read. */
interface EnvSpec {
  kind: ArrayKind | "equation";
  style: StyleName;
  left?: string;
  right?: string;
  display?: boolean;
  /** Reads {n} (alignat) or {spec} (array). */
  arg?: "pairs" | "cols";
  /** Accepts [t|c|b]. */
  vpos?: boolean;
  stretch?: number;
  maxCols?: number;
  /** mathtools' starred matrices take [l|c|r] for the column alignment. */
  colAlign?: boolean;
}

const ENVS: Record<string, EnvSpec> = {
  matrix: { kind: "matrix", style: "text" },
  "matrix*": { kind: "matrix", style: "text", colAlign: true },
  "pmatrix*": { kind: "matrix", style: "text", left: "(", right: ")", colAlign: true },
  "bmatrix*": { kind: "matrix", style: "text", left: "[", right: "]", colAlign: true },
  "Bmatrix*": { kind: "matrix", style: "text", left: "\\{", right: "\\}", colAlign: true },
  "vmatrix*": { kind: "matrix", style: "text", left: "|", right: "|", colAlign: true },
  "Vmatrix*": { kind: "matrix", style: "text", left: "\\|", right: "\\|", colAlign: true },
  pmatrix: { kind: "matrix", style: "text", left: "(", right: ")" },
  bmatrix: { kind: "matrix", style: "text", left: "[", right: "]" },
  Bmatrix: { kind: "matrix", style: "text", left: "\\{", right: "\\}" },
  vmatrix: { kind: "matrix", style: "text", left: "|", right: "|" },
  Vmatrix: { kind: "matrix", style: "text", left: "\\|", right: "\\|" },
  smallmatrix: { kind: "smallmatrix", style: "script" },
  psmallmatrix: { kind: "smallmatrix", style: "script", left: "(", right: ")" },
  bsmallmatrix: { kind: "smallmatrix", style: "script", left: "[", right: "]" },
  array: { kind: "array", style: "text", arg: "cols", vpos: true },
  darray: { kind: "array", style: "display", arg: "cols", vpos: true },
  subarray: { kind: "subarray", style: "script", arg: "cols" },
  cases: { kind: "cases", style: "text", left: "\\{", stretch: 1.2, maxCols: 2 },
  dcases: { kind: "cases", style: "display", left: "\\{", stretch: 1.2, maxCols: 2 },
  rcases: { kind: "cases", style: "text", right: "\\}", stretch: 1.2, maxCols: 2 },
  drcases: { kind: "cases", style: "display", right: "\\}", stretch: 1.2, maxCols: 2 },
  // mathtools: the second column is text.
  "cases*": { kind: "cases", style: "text", left: "\\{", stretch: 1.2, maxCols: 2 },
  "dcases*": { kind: "cases", style: "display", left: "\\{", stretch: 1.2, maxCols: 2 },
  "rcases*": { kind: "cases", style: "text", right: "\\}", stretch: 1.2, maxCols: 2 },
  "drcases*": { kind: "cases", style: "display", right: "\\}", stretch: 1.2, maxCols: 2 },
  aligned: { kind: "aligned", style: "display", vpos: true },
  alignedat: { kind: "aligned", style: "display", arg: "pairs", vpos: true },
  split: { kind: "aligned", style: "display", maxCols: 2 },
  gathered: { kind: "gathered", style: "display", vpos: true, maxCols: 1 },
  align: { kind: "aligned", style: "display", display: true },
  "align*": { kind: "aligned", style: "display", display: true },
  alignat: { kind: "aligned", style: "display", display: true, arg: "pairs" },
  "alignat*": { kind: "aligned", style: "display", display: true, arg: "pairs" },
  flalign: { kind: "aligned", style: "display", display: true },
  "flalign*": { kind: "aligned", style: "display", display: true },
  gather: { kind: "gathered", style: "display", display: true, maxCols: 1 },
  "gather*": { kind: "gathered", style: "display", display: true, maxCols: 1 },
  multline: { kind: "multline", style: "display", display: true, maxCols: 1 },
  "multline*": { kind: "multline", style: "display", display: true, maxCols: 1 },
  eqnarray: { kind: "eqnarray", style: "display", display: true, maxCols: 3 },
  "eqnarray*": { kind: "eqnarray", style: "display", display: true, maxCols: 3 },
  equation: { kind: "equation", style: "display" },
  "equation*": { kind: "equation", style: "display" },
  displaymath: { kind: "equation", style: "display" },
  math: { kind: "equation", style: "text" },
};

export const ENVIRONMENT_NAMES: readonly string[] = Object.keys(ENVS);

// ---------------------------------------------------------------- colors

const NAMED_COLORS: Record<string, Color> = {
  black: [0, 0, 0],
  white: [1, 1, 1],
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  cyan: [0, 1, 1],
  magenta: [1, 0, 1],
  yellow: [1, 1, 0],
  gray: [0.5, 0.5, 0.5],
  grey: [0.5, 0.5, 0.5],
  darkgray: [0.25, 0.25, 0.25],
  darkgrey: [0.25, 0.25, 0.25],
  lightgray: [0.75, 0.75, 0.75],
  lightgrey: [0.75, 0.75, 0.75],
  brown: [0.75, 0.5, 0.25],
  lime: [0.75, 1, 0],
  olive: [0.5, 0.5, 0],
  orange: [1, 0.5, 0],
  pink: [1, 0.75, 0.75],
  purple: [0.75, 0, 0.25],
  teal: [0, 0.5, 0.5],
  violet: [0.5, 0, 0.5],
  navy: [0, 0, 0.5],
  maroon: [0.5, 0, 0],
  silver: [0.75, 0.75, 0.75],
  gold: [1, 0.843, 0],
  indigo: [0.294, 0, 0.51],
  darkred: [0.545, 0, 0],
  darkgreen: [0, 0.392, 0],
  darkblue: [0, 0, 0.545],
  royalblue: [0.255, 0.412, 0.882],
  forestgreen: [0.133, 0.545, 0.133],
  brickred: [0.714, 0.196, 0.11],
  goldenrod: [0.855, 0.647, 0.125],
  skyblue: [0.529, 0.808, 0.922],
  salmon: [0.98, 0.502, 0.447],
  tan: [0.824, 0.706, 0.549],
  turquoise: [0.251, 0.878, 0.816],
  plum: [0.867, 0.627, 0.867],
  orchid: [0.855, 0.439, 0.839],
  crimson: [0.863, 0.078, 0.235],
  coral: [1, 0.498, 0.314],
  khaki: [0.941, 0.902, 0.549],
  aqua: [0, 1, 1],
  fuchsia: [1, 0, 1],
};

function hexColor(h: string): Color | null {
  if (/^[0-9a-fA-F]{6}$/.test(h)) return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  if (/^[0-9a-fA-F]{3}$/.test(h)) return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255];
  return null;
}

/** A color from xcolor-style syntax: names, name!pct!name mixes, #hex, and [model]{spec}. */
export function parseColor(spec: string, model?: string): Color | null {
  const s = spec.trim();
  if (model) {
    const parts = s.split(/\s*,\s*|\s+/).filter(Boolean).map(Number);
    switch (model.trim().toLowerCase() === "rgb" && model.trim() === "RGB" ? "RGB" : model.trim()) {
      case "rgb":
        return parts.length === 3 && parts.every((x) => x >= 0 && x <= 1) ? [parts[0]!, parts[1]!, parts[2]!] : null;
      case "RGB":
        return parts.length === 3 && parts.every((x) => x >= 0 && x <= 255) ? [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255] : null;
      case "HTML":
        return hexColor(s);
      case "gray":
        return parts.length === 1 && parts[0]! >= 0 && parts[0]! <= 1 ? [parts[0]!, parts[0]!, parts[0]!] : null;
      case "cmyk": {
        if (parts.length !== 4) return null;
        const [c, m, y, k] = parts as [number, number, number, number];
        return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
      }
      default:
        return null;
    }
  }
  if (s.startsWith("#")) return hexColor(s.slice(1));
  const mix = s.split("!");
  const base = (name: string): Color | null => {
    const n = name.trim();
    return NAMED_COLORS[n] ?? NAMED_COLORS[n.toLowerCase()] ?? (/^[0-9a-fA-F]{6}$/.test(n) ? hexColor(n) : null);
  };
  let c = base(mix[0]!);
  if (!c) return null;
  for (let k = 1; k < mix.length; k += 2) {
    const pct = Number(mix[k]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    const other = mix[k + 1] !== undefined ? base(mix[k + 1]!) : ([1, 1, 1] as Color);
    if (!other) return null;
    const t = pct / 100;
    c = [c[0] * t + other[0] * (1 - t), c[1] * t + other[1] * (1 - t), c[2] * t + other[2] * (1 - t)];
  }
  return c;
}

// ---------------------------------------------------------------- dimensions

const UNIT_PT: Record<string, number> = {
  pt: 1,
  bp: 1,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  in: 72,
  pc: 12,
  dd: 1.0700086,
  cc: 12.840103,
  sp: 1 / 65536,
  px: 0.75,
};

/** Read a dimension from the start of a token list: [sign] number unit. Returns the dim and the tokens used. */
function readDim(toks: readonly Token[], start: number): { dim: Dim; next: number; fil?: 1 | 2 | 3 } | null {
  let i = start;
  const at = (k: number) => toks[k];
  while (at(i)?.k === "space") i++;
  let sign = 1;
  while (at(i) && at(i)!.k === "char" && (at(i)!.v === "-" || at(i)!.v === "+")) {
    if (at(i)!.v === "-") sign = -sign;
    i++;
    while (at(i)?.k === "space") i++;
  }
  let num = "";
  while (at(i) && at(i)!.k === "char" && /[0-9.,]/.test(at(i)!.v)) num += at(i++)!.v === "," ? "." : at(i - 1)!.v;
  if (num === "" || num === ".") {
    // "\hspace{-\fill}" style or a bare unit: not supported
    if (num === "") num = "1";
    else return null;
    if (!(at(i) && at(i)!.k === "char")) return null;
  }
  const value = sign * Number(num);
  if (!Number.isFinite(value)) return null;
  while (at(i)?.k === "space") i++;
  let unit = "";
  let j = i;
  while (at(j) && at(j)!.k === "char" && /[a-zA-Z]/.test(at(j)!.v) && unit.length < 5) unit += at(j++)!.v;
  // "true" prefix (truept) is accepted and ignored.
  let u = unit;
  if (u.startsWith("true")) u = u.slice(4);
  for (const len of [5, 4, 3, 2]) {
    const cand = u.slice(0, len);
    if (cand === "filll" || cand === "fill" || cand === "fil") {
      const used = (unit.length - u.length) + cand.length;
      return { dim: { v: value, u: "pt" }, next: i + used, fil: cand.length === 3 ? 1 : cand.length === 4 ? 2 : 3 };
    }
    if (len === 2 && (cand === "em" || cand === "ex" || cand === "mu")) {
      return { dim: { v: value, u: cand }, next: i + (unit.length - u.length) + 2 };
    }
    if (len === 2 && UNIT_PT[cand] !== undefined) {
      return { dim: { v: value * UNIT_PT[cand]!, u: "pt" }, next: i + (unit.length - u.length) + 2 };
    }
  }
  return null;
}

function isChar(t: Token, v: string): boolean {
  return t.k === "char" && t.v === v;
}

// ---------------------------------------------------------------- parser

interface Stops {
  brace?: boolean;
  bracket?: boolean;
  amp?: boolean;
  row?: boolean;
  right?: boolean;
  end?: boolean;
  eof?: boolean;
  /** Stop at a closing $ or \) (math inside text). */
  dollar?: boolean;
  paren?: boolean;
}

interface State {
  font?: MathFont;
  color?: Color;
  /** Inside \operatorname: - and * are text characters. */
  opname?: boolean;
}

interface TagTarget {
  tag?: TagSpec;
  notag?: boolean;
}

const TEXT_DEFAULT: TextFont = { family: "rm", bold: false, italic: false };

export class Parser {
  private readonly ex: Expander;
  private depth = 0;
  private state: State = {};
  private tagTarget: TagTarget;
  private readonly formula: Formula = { body: [] };
  /** Open { groups and \left delimiters, innermost last, with the depth of the list each one parses. */
  private readonly opens: { kind: "brace" | "left"; tok: Token; depth: number }[] = [];
  /** Lists being parsed (parseList calls running), and where each one starts in the source. */
  private readonly listStarts: number[] = [];

  constructor(
    readonly src: string,
    macros: Record<string, string>,
    private readonly display: boolean,
    private readonly warn: Warn,
  ) {
    this.ex = new Expander(src, macros, (t) => {
      const pkg = packageCommand(t.v);
      if (!pkg || this.isBuiltin(t.v)) return undefined;
      if (pkg.guess) {
        let seen = noted.get(macros);
        if (!seen) noted.set(macros, (seen = new Set()));
        if (!seen.has(t.v)) {
          seen.add(t.v);
          this.warn("MATH003", `${t.v} is not defined; read as ${pkg.guess}`, t.pos, `Define ${t.v} in front-matter "macros" or with \\newcommand to choose its meaning`);
        }
      }
      return pkg;
    });
    this.tagTarget = this.formula;
  }

  // ------------------------------------------------------------ entry

  parse(): Formula {
    const rows: { body: MathList; tag?: TagSpec; notag?: boolean; pos: number }[] = [];
    let rowStart = 0;
    for (;;) {
      const target: TagTarget = {};
      this.tagTarget = target;
      const { list, stop } = this.parseList({ eof: true, row: true });
      rows.push({ body: list, tag: target.tag, notag: target.notag, pos: rowStart });
      if (stop.k === "eof") break;
      // a top-level \\ : skip an optional [dim] / *
      this.rowBreakArgs();
      rowStart = this.ex.peekRaw().pos;
    }
    // A trailing \\ leaves an empty last row without adding a line.
    while (rows.length > 1 && rows[rows.length - 1]!.body.length === 0 && !rows[rows.length - 1]!.tag) rows.pop();
    if (rows.length === 1 || !this.display) {
      const f = this.formula;
      f.body = rows.length === 1 ? rows[0]!.body : rows.flatMap((r) => r.body);
      const tagged = rows.find((r) => r.tag);
      if (tagged) f.tag = tagged.tag;
      if (rows.some((r) => r.notag)) f.notag = true;
      return f;
    }
    this.formula.body = [];
    this.formula.rows = rows;
    return this.formula;
  }

  // ------------------------------------------------------------ helpers

  private err(message: string, pos: number, hint?: string, fix?: MathError["fix"]): never {
    throw new MathError(message, pos, hint, fix);
  }

  /** Whether token `t` is the source text at its position (not something a macro produced). */
  private isRaw(t: Token): boolean {
    return t.k === "eof" || (t.k === "char" ? this.src[t.pos] === t.v : this.src.startsWith(t.v, t.pos));
  }

  /**
   * A fix inserting `text` at the end of a group that `open` began, just before offset `at` (blanks
   * before it stay after the insertion). Safe for a missing } only when what the group holds is a
   * single unbroken term ({2, {\alpha_1}): with spaces or operators inside, where it should end is a guess.
   */
  private closeBefore(open: Token, at: number, text: string): MathError["fix"] {
    if (!this.isRaw(open) || at > this.src.length) return undefined;
    let end = at;
    while (end > open.pos + 1 && /\s/.test(this.src[end - 1]!)) end--;
    if (end <= open.pos) return undefined;
    const edit = insertionEdit(this.src, end, text === "}" ? "}" : ` ${text}`);
    if (!edit) return undefined;
    const safe = text !== "}" || /^[^\s{}+\-=<>,;&|]+$/.test(this.src.slice(open.pos + 1, end));
    return { old: edit.old, new: edit.new, safe, at: edit.start };
  }

  /**
   * Token `t` ends the list being parsed without being its closer. When that list is an open { group
   * or \left, the mistake is the missing } or \right, which belongs just before `t`: report that.
   */
  private unclosed(t: Token): void {
    const o = this.opens[this.opens.length - 1];
    if (!o || o.depth !== this.listStarts.length || !this.isRaw(t)) return;
    const at = t.k === "eof" ? this.src.length : t.pos;
    const where = t.k === "eof" ? "the end of the formula" : t.v;
    // Only a group the source never closes: in \frac{a \\ b}{c} the \\ itself is the mistake.
    if (o.kind === "brace" && this.closesLater(o.tok.pos)) return;
    if (o.kind === "left" && this.src.includes("\\right", at)) return;
    if (o.kind === "brace" && !isChar(t, "}")) {
      this.err("Unclosed group: { has no matching }", o.tok.pos, `Check for an unbalanced { or a missing argument: the } goes before ${where}`, this.closeBefore(o.tok, at, "}"));
    }
    if (o.kind === "left" && !(t.k === "cs" && t.v === "\\right")) {
      this.err("\\left has no matching \\right", o.tok.pos, `Add \\right) (or \\right. for an invisible delimiter) before ${where}`, this.closeBefore(o.tok, at, "\\right."));
    }
  }

  /** Whether the { at `open` has a matching } somewhere in the source. */
  private closesLater(open: number): boolean {
    let depth = 0;
    for (let i = open; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === "\\") i++;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return true;
    }
    return false;
  }

  /** A \right with no \left in the list being parsed: the fix puts \left. at the start of that list. */
  private strayRight(t: Token): never {
    this.unclosed(t);
    let start = this.listStarts[this.listStarts.length - 1] ?? 0;
    while (start < t.pos && /\s/.test(this.src[start]!)) start++;
    const edit = this.isRaw(t) && start <= t.pos ? insertionEdit(this.src, start, "\\left. ") : undefined;
    this.err("\\right without a matching \\left", t.pos, "Pair every \\right with a \\left (use \\left. for an invisible one)", edit && { old: edit.old, new: edit.new, safe: true, at: edit.start });
  }

  /** A fix inserting `text` at the end of the formula, for an environment never ended. */
  private atEnd(text: string): MathError["fix"] {
    let end = this.src.length;
    while (end > 0 && /\s/.test(this.src[end - 1]!)) end--;
    const edit = insertionEdit(this.src, end, ` ${text}`);
    return edit && { old: edit.old, new: edit.new, safe: true, at: edit.start };
  }

  private enter(t: Token): void {
    if (++this.depth > MAX_DEPTH) this.err(`Formula is nested more than ${MAX_DEPTH} levels deep`, t.pos, "Simplify the formula or check for runaway braces");
  }

  private leave(): void {
    this.depth--;
  }

  private nextNonSpace(): Token {
    for (;;) {
      const t = this.ex.next();
      if (t.k !== "space") return t;
    }
  }

  private peekNonSpace(): Token {
    const t = this.nextNonSpace();
    this.ex.pushBack(t);
    return t;
  }

  /** Read an argument group's raw text ({...} or a single token), e.g. an environment or color name. */
  private rawArgString(owner: Token): string {
    const toks = this.ex.readRawArg(owner);
    let s = "";
    for (const t of toks) s += t.k === "space" ? " " : t.k === "param" ? `#${t.v}` : t.v;
    return s;
  }

  private stamp<T extends MathNode>(n: T): T {
    if (this.state.color && !n.color) n.color = this.state.color;
    return n;
  }

  // ------------------------------------------------------------ lists

  /**
   * Parse a math list until one of the stop tokens. Returns the list and the
   * token that stopped it (consumed).
   */
  parseList(stops: Stops): { list: MathList; stop: Token } {
    let list: MathList = [];
    let infix: { tok: Token; num: MathList; frac: Omit<FracNode, "num" | "den" | "pos" | "type"> } | null = null;
    const savedState = this.state;
    this.state = { ...savedState };
    this.listStarts.push(this.ex.peekRaw().pos);
    try {
      for (;;) {
        const t = this.ex.next();
        if (t.k === "eof") {
          if (stops.eof) return this.finishList(list, infix, t);
          return { list: this.finishList(list, infix, t).list, stop: t };
        }
        if (t.k === "space") continue;
        if (t.k === "char") {
          switch (t.v) {
            case "}":
              if (stops.brace) return this.finishList(list, infix, t);
              this.unclosed(t);
              this.err("Unexpected } (no matching {)", t.pos, "Check for an unbalanced { or a missing argument");
              break;
            case "]":
              if (stops.bracket) return this.finishList(list, infix, t);
              break;
            case "&":
              if (stops.amp) return this.finishList(list, infix, t);
              this.unclosed(t);
              this.err("Misplaced & (column separators belong inside an environment such as aligned or matrix)", t.pos, "Use an aligning environment (align, aligned) for & columns");
              break;
            case "^":
            case "_":
              this.attachScript(list, t);
              continue;
            case "'":
              this.attachPrimes(list, t);
              continue;
            case "$":
              if (stops.dollar) return this.finishList(list, infix, t);
              this.unclosed(t);
              this.err("Unexpected $ inside math", t.pos, "Remove the inner $ signs; the math delimiters are already given");
              break;
          }
        } else if (t.k === "cs") {
          switch (t.v) {
            case "\\\\":
              if (stops.row) return this.finishList(list, infix, t);
              this.unclosed(t);
              this.err("Misplaced \\\\ (line breaks belong inside an environment such as aligned, gathered or matrix)", t.pos, "Put the rows in \\begin{aligned}...\\end{aligned} or a matrix environment");
              break;
            case "\\right":
              if (stops.right) return this.finishList(list, infix, t);
              this.strayRight(t);
              break;
            case "\\end":
              if (stops.end) return this.finishList(list, infix, t);
              this.unclosed(t);
              this.err("\\end without a matching \\begin", t.pos, "Check the \\begin{...}/\\end{...} pairs");
              break;
            case "\\)":
              if (stops.paren) return this.finishList(list, infix, t);
              this.unclosed(t);
              this.err("Unexpected \\) inside math", t.pos, "Remove the inner math delimiters");
              break;
            case "\\middle": {
              if (!stops.right) this.err("\\middle outside \\left...\\right", t.pos, "Use \\middle only between \\left and \\right");
              const d = this.readDelim(t);
              list.push(this.stamp({ type: "middle", delim: d, pos: t.pos }));
              continue;
            }
            case "\\limits":
            case "\\nolimits":
            case "\\displaylimits":
              this.setLimits(list, t);
              continue;
            case "\\over":
            case "\\atop":
            case "\\choose":
            case "\\brace":
            case "\\brack":
            case "\\above":
            case "\\overwithdelims":
            case "\\atopwithdelims":
            case "\\abovewithdelims": {
              if (infix) this.err(`Ambiguous: ${infix.tok.v} and ${t.v} in the same group`, t.pos, "Use \\frac{...}{...}, or add braces around each fraction");
              infix = { tok: t, num: list, frac: this.infixSpec(t) };
              list = [];
              continue;
            }
          }
          if (this.state.font !== undefined || !(t.v in OLD_FONTS)) {
            // fall through to atoms
          }
          if (t.v in OLD_FONTS) {
            const f = OLD_FONTS[t.v]!;
            this.state = { ...this.state, font: f ?? undefined };
            continue;
          }
          if (t.v === "\\color") {
            this.state = { ...this.state, color: this.readColor(t) };
            continue;
          }
        }
        const n = this.parseAtom(t, list);
        if (n === null) continue;
        if (Array.isArray(n)) list.push(...n);
        else list.push(n);
      }
    } finally {
      this.state = savedState;
      this.listStarts.pop();
    }
  }

  private finishList(
    list: MathList,
    infix: { tok: Token; num: MathList; frac: Omit<FracNode, "num" | "den" | "pos" | "type"> } | null,
    stop: Token,
  ): { list: MathList; stop: Token } {
    if (!infix) return { list, stop };
    const frac: FracNode = { type: "frac", num: infix.num, den: list, pos: infix.tok.pos, ...infix.frac };
    return { list: [frac], stop };
  }

  private infixSpec(t: Token): Omit<FracNode, "num" | "den" | "pos" | "type"> {
    const base = { left: null as SymDef | null, right: null as SymDef | null, thickness: null as Dim | null, cmd: t.v };
    switch (t.v) {
      case "\\atop":
        return { ...base, thickness: { v: 0, u: "pt" } };
      case "\\choose":
        return { ...base, thickness: { v: 0, u: "pt" }, left: this.delimSym("(")!, right: this.delimSym(")")! };
      case "\\brace":
        return { ...base, thickness: { v: 0, u: "pt" }, left: this.delimSym("\\{")!, right: this.delimSym("\\}")! };
      case "\\brack":
        return { ...base, thickness: { v: 0, u: "pt" }, left: this.delimSym("[")!, right: this.delimSym("]")! };
      case "\\above":
        return { ...base, thickness: this.readInlineDim(t) };
      case "\\overwithdelims":
        return { ...base, left: this.readDelim(t), right: this.readDelim(t) };
      case "\\atopwithdelims":
        return { ...base, thickness: { v: 0, u: "pt" }, left: this.readDelim(t), right: this.readDelim(t) };
      case "\\abovewithdelims": {
        const left = this.readDelim(t);
        const right = this.readDelim(t);
        return { ...base, left, right, thickness: this.readInlineDim(t) };
      }
      default:
        return base;
    }
  }

  private setLimits(list: MathList, t: Token): void {
    const last = list[list.length - 1];
    const op = last?.type === "op" ? last : last?.type === "supsub" && last.base?.type === "op" ? last.base : null;
    if (!op) this.err(`${t.v} must follow a math operator`, t.pos, "Use \\limits after \\sum, \\int or another operator (or \\mathop{...})");
    op.limits = t.v === "\\limits" ? "limits" : t.v === "\\nolimits" ? "nolimits" : "display";
  }

  // ------------------------------------------------------------ scripts

  private scriptTarget(list: MathList, pos: number): SupSubNode {
    const last = list[list.length - 1];
    if (last && last.type === "supsub") return last;
    if (last && last.type !== "space" && last.type !== "style" && last.type !== "penalty") {
      const n: SupSubNode = { type: "supsub", base: last, sup: null, sub: null, pos: last.pos };
      list[list.length - 1] = n;
      return n;
    }
    const n: SupSubNode = { type: "supsub", base: null, sup: null, sub: null, pos };
    list.push(n);
    return n;
  }

  private attachScript(list: MathList, t: Token): void {
    const target = this.scriptTarget(list, t.pos);
    const sup = t.v === "^";
    if (sup ? target.sup : target.sub) {
      this.err(sup ? "Double superscript" : "Double subscript", t.pos, sup ? "Group with braces: x^{a^b} instead of x^a^b" : "Group with braces: x_{a_b} instead of x_a_b");
    }
    const arg = this.parseScriptArg(t);
    if (sup) target.sup = arg;
    else target.sub = arg;
  }

  private attachPrimes(list: MathList, t: Token): void {
    const target = this.scriptTarget(list, t.pos);
    if (target.sup) this.err("Double superscript", t.pos, "Write primes before the superscript: x'^2, or group: {x^2}'");
    const prime = MATH_SYMBOLS.get("\\prime")!;
    const sup: MathList = [this.stamp({ type: "sym", sym: prime, cls: "ord", pos: t.pos })];
    for (;;) {
      const u = this.ex.next();
      if (isChar(u, "'")) {
        sup.push(this.stamp({ type: "sym", sym: prime, cls: "ord", pos: u.pos }));
        continue;
      }
      if (isChar(u, "^")) {
        sup.push(...this.parseScriptArg(u));
        break;
      }
      this.ex.pushBack(u);
      break;
    }
    target.sup = sup;
  }

  private parseScriptArg(owner: Token): MathList {
    const t = this.nextNonSpace();
    const what = owner.v === "^" ? "superscript" : owner.v === "_" ? "subscript" : `argument of ${owner.v}`;
    if (t.k === "eof" || isChar(t, "}") || isChar(t, "&") || isChar(t, "^") || isChar(t, "_") || (t.k === "cs" && (t.v === "\\\\" || t.v === "\\right" || t.v === "\\end"))) {
      this.err(`Missing ${what} after ${owner.v}`, t.k === "eof" ? owner.pos : t.pos, `Give ${owner.v} an argument, e.g. x${owner.v}{2}`);
    }
    if (isChar(t, "{")) return this.parseGroupBody(t);
    const n = this.parseAtom(t, []);
    if (n === null) return [];
    return Array.isArray(n) ? n : [n];
  }

  // ------------------------------------------------------------ groups and arguments

  /** The list inside { ... } (the { already consumed). */
  parseGroupBody(open: Token, extra: Partial<State> = {}): MathList {
    this.enter(open);
    const saved = this.state;
    this.state = { ...saved, ...extra };
    this.opens.push({ kind: "brace", tok: open, depth: this.listStarts.length + 1 });
    try {
      const { list, stop } = this.parseList({ brace: true });
      if (stop.k === "eof") this.err("Unclosed group: { has no matching }", open.pos, "Check for an unbalanced { or a missing argument; the } goes where the group ends", this.closeBefore(open, this.src.length, "}"));
      return list;
    } finally {
      this.opens.pop();
      this.state = saved;
      this.leave();
    }
  }

  /** A math argument: {list} or a single token/atom. */
  parseArg(owner: Token, extra: Partial<State> = {}): MathList {
    const t = this.nextNonSpace();
    if (t.k === "eof" || isChar(t, "}") || isChar(t, "&") || (t.k === "cs" && (t.v === "\\\\" || t.v === "\\right" || t.v === "\\end"))) {
      this.err(`Missing argument for ${owner.v}`, t.k === "eof" ? owner.pos : t.pos, "Check for an unbalanced { or a missing argument");
    }
    if (isChar(t, "{")) return this.parseGroupBody(t, extra);
    this.enter(owner);
    const saved = this.state;
    this.state = { ...saved, ...extra };
    try {
      const n = this.parseAtom(t, []);
      if (n === null) return [];
      return Array.isArray(n) ? n : [n];
    } finally {
      this.state = saved;
      this.leave();
    }
  }

  /** [ ... ] parsed as math, or null when absent. */
  private parseOptional(owner: Token): MathList | null {
    const t = this.peekNonSpace();
    if (!isChar(t, "[")) return null;
    this.nextNonSpace();
    this.enter(owner);
    try {
      const { list, stop } = this.parseList({ bracket: true });
      if (stop.k === "eof") this.err(`Unclosed optional argument of ${owner.v}: [ has no matching ]`, t.pos, "Close the optional argument with ]");
      return list;
    } finally {
      this.leave();
    }
  }

  /** [ ... ] as raw text, or undefined. */
  private rawOptional(): string | undefined {
    const toks = this.ex.readRawOptional();
    if (!toks) return undefined;
    return toks.map((t) => (t.k === "space" ? " " : t.v)).join("");
  }

  private readDimArg(owner: Token): Dim {
    const toks = this.ex.readRawArg(owner);
    const r = readDim(toks, 0);
    if (!r || toks.slice(r.next).some((t) => t.k !== "space")) {
      this.err(`Invalid dimension for ${owner.v}`, owner.pos, "Write a number and a unit, e.g. 1em, 2pt, 3mu or 0.5cm");
    }
    return r.dim;
  }

  /** A dimension written inline after a command (\kern2pt, \mskip 3mu plus 1mu). */
  private readInlineDim(owner: Token, glue = false): Dim & { stretch?: Dim; shrink?: Dim; fil?: 1 | 2 | 3 } {
    // Collect the tokens a dimension could use, then hand back what it did not.
    const toks: Token[] = [];
    const take = (): Token => {
      const t = this.ex.next();
      toks.push(t);
      return t;
    };
    const parseOne = (): { dim: Dim; fil?: 1 | 2 | 3 } | null => {
      const start = toks.length;
      let t = take();
      while (t.k === "space") t = take();
      while (isChar(t, "-") || isChar(t, "+") || t.k === "space") t = take();
      while (t.k === "char" && /[0-9.,]/.test(t.v)) t = take();
      while (t.k === "space") t = take();
      for (let k = 0; k < 5 && t.k === "char" && /[a-zA-Z]/.test(t.v); k++) t = take();
      const r = readDim(toks, start);
      if (!r) return null;
      // give back the unused tail
      const unused = toks.splice(r.next);
      for (let k = unused.length - 1; k >= 0; k--) this.ex.pushBack(unused[k]!);
      return r;
    };
    const first = parseOne();
    if (!first) this.err(`Invalid dimension after ${owner.v}`, owner.pos, "Write a number and a unit, e.g. \\kern2pt or \\mkern3mu");
    const out: Dim & { stretch?: Dim; shrink?: Dim; fil?: 1 | 2 | 3 } = { ...first.dim };
    if (!glue) return out;
    for (const kw of ["plus", "minus"] as const) {
      // keyword check without consuming on mismatch
      const save: Token[] = [];
      let ok = true;
      let t = this.ex.next();
      while (t.k === "space") {
        save.push(t);
        t = this.ex.next();
      }
      save.push(t);
      for (let k = 0; k < kw.length; k++) {
        if (!(t.k === "char" && t.v.toLowerCase() === kw[k])) {
          ok = false;
          break;
        }
        if (k < kw.length - 1) {
          t = this.ex.next();
          save.push(t);
        }
      }
      if (!ok) {
        for (let k = save.length - 1; k >= 0; k--) this.ex.pushBack(save[k]!);
        continue;
      }
      toks.length = 0;
      const d = parseOne();
      if (!d) this.err(`Invalid ${kw} dimension after ${owner.v}`, owner.pos, "Write e.g. \\mskip 3mu plus 2mu minus 1mu");
      if (kw === "plus") {
        out.stretch = d.dim;
        if (d.fil) out.fil = d.fil;
      } else out.shrink = d.dim;
    }
    return out;
  }

  private readColor(owner: Token): Color {
    const model = this.rawOptional();
    const spec = this.rawArgString(owner);
    const c = parseColor(spec, model);
    if (!c) this.err(`Unknown color '${spec}'${model ? ` in model ${model}` : ""}`, owner.pos, "Use a named color (red, blue, teal, ...), #rrggbb, or [rgb]{r,g,b}");
    return c;
  }

  // ------------------------------------------------------------ delimiters

  private delimSym(name: string): SymDef | null {
    if (name === ".") return null;
    return MATH_SYMBOLS.get(DELIM_NAMES.get(name) ?? name) ?? null;
  }

  private readDelim(owner: Token): SymDef | null {
    const t = this.nextNonSpace();
    const key = t.k === "cs" || t.k === "char" ? t.v : "";
    const name = DELIM_NAMES.get(key);
    if (name === undefined) {
      const got = t.k === "eof" ? "the end of the formula" : t.v;
      this.err(`Missing delimiter after ${owner.v} (got ${got})`, t.k === "eof" ? owner.pos : t.pos, `Use a delimiter such as ( [ \\{ | \\langle, or ${owner.v}. for an invisible one`);
    }
    return this.delimSym(name);
  }

  // ------------------------------------------------------------ atoms

  private symNode(sym: SymDef, pos: number, cls?: Cls): MathNode {
    if (sym.cls === "op") {
      const op: OpNode = { type: "op", limits: sym.limits ?? "nolimits", sym, pos };
      if (this.state.font) op.font = this.state.font;
      return this.stamp(op);
    }
    const n: MathNode = { type: "sym", sym, cls: cls ?? sym.cls, pos };
    if (this.state.font) n.font = this.state.font;
    return this.stamp(n);
  }

  /**
   * One atom (or construct) starting with token t. Returns null for tokens
   * that add nothing (\label, \nonumber, definitions), or a list to splice.
   */
  parseAtom(t: Token, list: MathList): MathNode | MathNode[] | null {
    if (t.k === "char") return this.charAtom(t);
    if (t.k === "param") this.err("Macro parameter character # outside a macro definition", t.pos, "Write \\# for a literal #");
    if (t.k !== "cs") return null;
    const name = t.v;

    // operator names in \operatorname: - and * are text
    const sym = MATH_SYMBOLS.get(name);
    if (sym) return this.symNode(sym, t.pos);
    if (name === "\\dots" || name === "\\dotsb" || name === "\\dotsc" || name === "\\dotsm" || name === "\\dotsi" || name === "\\dotso") return this.dots(t);
    const sp = SPACES[name];
    if (sp) return this.stamp({ type: "space", dim: sp.dim, stretch: sp.stretch, shrink: sp.shrink, kern: sp.kern, pos: t.pos });
    const named = NAMED_OPS.get(name);
    if (named) return this.stamp({ type: "op", limits: named[1], name: named[0], pos: t.pos });
    if (name in MATH_FONTS) return this.fontArg(t, MATH_FONTS[name]!);
    if (name in CLASS_CMDS) {
      const body = this.parseArg(t);
      return this.stamp({ type: "group", body, cls: CLASS_CMDS[name], pos: t.pos });
    }
    if (name in STYLES) return { type: "style", style: STYLES[name]!, pos: t.pos };
    if (SIZE_CMDS.has(name) || IGNORED.has(name)) return null;
    const acc = ACCENTS.get(name);
    if (acc) return this.stamp({ type: "accent", accent: acc, name, body: this.parseArg(t), pos: t.pos });
    const arrow = ARROWS.get(name);
    if (arrow) {
      if (name.startsWith("\\x")) {
        const below = this.parseOptional(t);
        const above = this.parseArg(t);
        return this.stamp({ type: "xarrow", arrow, name, above: above.length ? above : null, below: below && below.length ? below : null, pos: t.pos });
      }
      return this.stamp({ type: "arrowacc", arrow, over: name.startsWith("\\over"), body: this.parseArg(t), pos: t.pos });
    }
    const big = BIG_SIZES[name];
    if (big) return this.stamp({ type: "big", delim: this.readDelim(t), size: big[0], cls: big[1], pos: t.pos });

    switch (name) {
      case "\\frac":
      case "\\dfrac":
      case "\\tfrac":
      case "\\cfrac": {
        const align = name === "\\cfrac" ? this.rawOptional() : undefined;
        const num = this.parseArg(t);
        const den = this.parseArg(t);
        const f: FracNode = { type: "frac", num, den, thickness: null, left: null, right: null, cmd: name, pos: t.pos };
        if (name === "\\dfrac" || name === "\\cfrac") f.style = "display";
        if (name === "\\tfrac") f.style = "text";
        if (name === "\\cfrac") f.cfrac = align === "l" ? "l" : align === "r" ? "r" : "c";
        return this.stamp(f);
      }
      case "\\binom":
      case "\\dbinom":
      case "\\tbinom": {
        const num = this.parseArg(t);
        const den = this.parseArg(t);
        const f: FracNode = { type: "frac", num, den, thickness: { v: 0, u: "pt" }, left: this.delimSym("("), right: this.delimSym(")"), cmd: name, pos: t.pos };
        if (name === "\\dbinom") f.style = "display";
        if (name === "\\tbinom") f.style = "text";
        return this.stamp(f);
      }
      case "\\genfrac": {
        const l = this.rawArgString(t).trim();
        const r = this.rawArgString(t).trim();
        const thick = this.rawArgString(t).trim();
        const st = this.rawArgString(t).trim();
        const num = this.parseArg(t);
        const den = this.parseArg(t);
        const f: FracNode = { type: "frac", num, den, thickness: null, left: l ? this.genfracDelim(l, t) : null, right: r ? this.genfracDelim(r, t) : null, cmd: name, pos: t.pos };
        if (thick) {
          const d = readDim(this.tokensOf(thick, t.pos), 0);
          if (!d) this.err("Invalid bar thickness in \\genfrac", t.pos, "Use a dimension such as 0pt or 0.4pt, or leave it empty");
          f.thickness = d.dim;
        }
        if (st) {
          const map: Record<string, StyleName> = { "0": "display", "1": "text", "2": "script", "3": "scriptscript" };
          if (!map[st]) this.err("Invalid style in \\genfrac (use 0, 1, 2 or 3)", t.pos, "0 = display, 1 = text, 2 = script, 3 = scriptscript");
          f.style = map[st];
        }
        return this.stamp(f);
      }
      case "\\sqrt": {
        const index = this.parseOptional(t);
        const body = this.parseArg(t);
        return this.stamp({ type: "sqrt", body, index, pos: t.pos });
      }
      case "\\root": {
        // \root n \of x
        const { list: index } = this.parseListUntilOf(t);
        const body = this.parseArg(t);
        return this.stamp({ type: "sqrt", body, index, pos: t.pos });
      }
      case "\\overline":
      case "\\underline":
      case "\\underbar":
        return this.stamp({ type: name === "\\overline" ? "overline" : "underline", body: this.parseArg(t), pos: t.pos });
      case "\\overbrace":
      case "\\underbrace":
        return this.stamp({ type: "brace", over: name === "\\overbrace", body: this.parseArg(t), pos: t.pos });
      case "\\left":
        return this.leftRight(t);
      case "\\operatorname":
      case "\\operatorname*":
      case "\\operatornamewithlimits": {
        let star = name !== "\\operatorname";
        if (!star && isChar(this.ex.peekRaw(), "*")) {
          this.ex.nextRaw();
          star = true;
        }
        const body = this.parseArg(t, { font: "rm", opname: true });
        return this.stamp({ type: "op", limits: star ? "display" : "nolimits", body, pos: t.pos });
      }
      case "\\mathop": {
        const body = this.parseArg(t);
        if (body.length === 1 && body[0]!.type === "sym") {
          const s = body[0];
          return this.stamp({ type: "op", limits: "display", sym: s.sym, font: s.font, pos: t.pos });
        }
        if (body.length === 1 && body[0]!.type === "op") return body[0]!;
        return this.stamp({ type: "op", limits: "display", body, pos: t.pos });
      }
      case "\\varlimsup":
      case "\\varliminf":
      case "\\varinjlim":
      case "\\varprojlim": {
        const lim: MathNode = { type: "op", limits: "nolimits", name: "lim", pos: t.pos };
        const inner: MathNode =
          name === "\\varlimsup"
            ? { type: "overline", body: [lim], pos: t.pos }
            : name === "\\varliminf"
              ? { type: "underline", body: [lim], pos: t.pos }
              : { type: "arrowacc", arrow: ARROWS.get(name === "\\varinjlim" ? "\\underrightarrow" : "\\underleftarrow")!, over: false, body: [lim], pos: t.pos };
        return this.stamp({ type: "op", limits: "display", body: [inner], pos: t.pos });
      }
      case "\\text":
      case "\\textrm":
      case "\\textnormal":
      case "\\textup":
      case "\\textmd":
      case "\\textbf":
      case "\\textit":
      case "\\textsl":
      case "\\emph":
      case "\\texttt":
      case "\\textsf":
      case "\\mbox":
      case "\\hbox": {
        const font = this.textFontFor(name, TEXT_DEFAULT);
        const body = this.parseTextArg(t, font);
        return this.stamp({ type: "text", body, fixedSize: name === "\\mbox" || name === "\\hbox", pos: t.pos });
      }
      case "\\fbox":
      case "\\framebox": {
        if (name === "\\framebox") {
          this.rawOptional();
          this.rawOptional();
        }
        const body = this.parseTextArg(t, TEXT_DEFAULT);
        return this.stamp({ type: "boxed", body: [{ type: "text", body, pos: t.pos }], pos: t.pos });
      }
      case "\\cancel":
      case "\\bcancel":
      case "\\xcancel":
        return this.stamp({ type: "cancel", body: this.parseArg(t), strike: name === "\\cancel" ? "/" : name === "\\bcancel" ? "\\" : "x", pos: t.pos });
      case "\\cancelto": {
        // The value the term goes to sits at the top right, where the arrow of the cancel package ends.
        const to = this.parseArg(t);
        const body = this.parseArg(t);
        const struck = this.stamp({ type: "cancel" as const, body, strike: "/" as const, pos: t.pos });
        return { type: "supsub", base: struck, sup: to, sub: null, pos: t.pos };
      }
      case "\\boxed":
        return this.stamp({ type: "boxed", body: [{ type: "style", style: "display", pos: t.pos }, ...this.parseArg(t)], pos: t.pos });
      case "\\colorbox": {
        const fill = this.readColor(t);
        const body = this.parseTextArg(t, TEXT_DEFAULT);
        return this.stamp({ type: "boxed", body: [{ type: "text", body, pos: t.pos }], fill, frameless: true, pos: t.pos });
      }
      case "\\fcolorbox": {
        const frame = this.readColor(t);
        const fill = this.readColor(t);
        const body = this.parseTextArg(t, TEXT_DEFAULT);
        return { type: "boxed", body: [{ type: "text", body, pos: t.pos }], fill, color: frame, pos: t.pos };
      }
      case "\\textcolor": {
        const c = this.readColor(t);
        const body = this.parseArg(t, { color: c });
        return { type: "group", body, color: c, pos: t.pos };
      }
      case "\\phantom":
        return this.stamp({ type: "phantom", body: this.parseArg(t), h: true, v: true, pos: t.pos });
      case "\\hphantom":
        return this.stamp({ type: "phantom", body: this.parseArg(t), h: true, v: false, pos: t.pos });
      case "\\vphantom":
        return this.stamp({ type: "phantom", body: this.parseArg(t), h: false, v: true, pos: t.pos });
      case "\\smash": {
        const opt = this.rawOptional()?.trim();
        const body = this.parseArg(t);
        return this.stamp({ type: "smash", body, top: opt !== "b", bottom: opt !== "t", pos: t.pos });
      }
      case "\\mathllap":
      case "\\mathrlap":
      case "\\mathclap":
        return this.stamp({ type: "lap", body: this.parseArg(t), align: name[5] as "l" | "r" | "c", pos: t.pos });
      case "\\llap":
      case "\\rlap":
      case "\\clap": {
        const body = this.parseTextArg(t, TEXT_DEFAULT);
        return this.stamp({ type: "lap", body: [{ type: "text", body, pos: t.pos }], align: name[1] as "l" | "r" | "c", pos: t.pos });
      }
      case "\\not": {
        this.enter(t);
        try {
          const nt = this.nextNonSpace();
          if (nt.k === "eof" || isChar(nt, "}") || isChar(nt, "&") || (nt.k === "cs" && (nt.v === "\\\\" || nt.v === "\\right" || nt.v === "\\end"))) {
            this.ex.pushBack(nt);
            return this.stamp({ type: "not", body: null, pos: t.pos });
          }
          const n = this.parseAtom(nt, list);
          const body = n === null ? null : Array.isArray(n) ? ({ type: "group", body: n, pos: nt.pos } as MathNode) : n;
          return this.stamp({ type: "not", body, pos: t.pos });
        } finally {
          this.leave();
        }
      }
      case "\\stackrel":
      case "\\overset":
      case "\\underset": {
        const top = this.parseArg(t);
        const base = this.parseArg(t);
        const cls: Cls = name === "\\stackrel" ? "rel" : this.classOfList(base);
        return this.stamp({ type: "stack", base, over: name === "\\underset" ? null : top, under: name === "\\underset" ? top : null, cls, pos: t.pos });
      }
      case "\\substack": {
        const open = this.nextNonSpace();
        if (!isChar(open, "{")) this.err("\\substack needs a {...} argument", t.pos, "Write \\substack{i<n \\\\ j<m}");
        return this.stamp(this.arrayBody(t, "substack", { kind: "subarray", style: "script" }, [{ align: "c", lines: 0 }], "}"));
      }
      case "\\begin":
        return this.environment(t);
      case "\\tag":
      case "\\tag*": {
        let star = name === "\\tag*";
        if (!star && isChar(this.ex.peekRaw(), "*")) {
          this.ex.nextRaw();
          star = true;
        }
        if (!this.display) this.err("\\tag works only in display math", t.pos, "Use \\tag in $$...$$ or an equation environment, or remove it");
        const body = this.parseTextArg(t, TEXT_DEFAULT);
        if (this.tagTarget.tag) this.err("Multiple \\tag in one equation", t.pos, "Keep one \\tag per equation (or per row of align)");
        this.tagTarget.tag = { body, star };
        return null;
      }
      case "\\notag":
      case "\\nonumber":
        this.tagTarget.notag = true;
        return null;
      case "\\qedhere":
        // amsthm: the end-of-proof box goes at the right of this line, like a tag; the proof then prints none.
        if (this.display && !this.tagTarget.tag) {
          this.ex.pushTokens(tokenize("{$\\square$}", t.pos));
          this.tagTarget.tag = { body: this.parseTextArg(t, TEXT_DEFAULT), star: true };
          return null;
        }
        this.ex.pushTokens(tokenize("\\quad\\square", t.pos));
        return null;
      case "\\label":
        this.ex.readRawArg(t);
        return null;
      case "\\newcommand":
      case "\\renewcommand":
      case "\\providecommand":
        this.newcommand(t);
        return null;
      case "\\def":
      case "\\gdef":
      case "\\edef":
      case "\\xdef":
        this.def(t);
        return null;
      case "\\let":
        this.let(t);
        return null;
      case "\\DeclareMathOperator":
        this.declareOperator(t);
        return null;
      case "\\hspace":
      case "\\hspace*": {
        if (isChar(this.ex.peekRaw(), "*")) this.ex.nextRaw();
        return this.stamp({ type: "space", dim: this.readDimArg(t), kern: false, pos: t.pos });
      }
      case "\\kern":
      case "\\mkern":
        return this.stamp({ type: "space", dim: this.readInlineDim(t), kern: true, pos: t.pos });
      case "\\hskip":
      case "\\mskip": {
        const d = this.readInlineDim(t, true);
        const n: MathNode = { type: "space", dim: { v: d.v, u: d.u }, kern: false, pos: t.pos };
        if (d.stretch) n.stretch = d.stretch;
        if (d.shrink) n.shrink = d.shrink;
        if (d.fil) n.fil = d.fil;
        return this.stamp(n);
      }
      case "\\hfill":
      case "\\hfil":
        return { type: "space", dim: { v: 0, u: "pt" }, stretch: { v: 1, u: "pt" }, fil: name === "\\hfill" ? 2 : 1, kern: false, pos: t.pos };
      case "\\rule": {
        const raise = this.rawOptional();
        const width = this.readDimArg(t);
        const height = this.readDimArg(t);
        let r: Dim | null = null;
        if (raise !== undefined) {
          const d = readDim(this.tokensOf(raise, t.pos), 0);
          if (!d) this.err("Invalid raise amount for \\rule", t.pos, "Write e.g. \\rule[-2pt]{1em}{0.4pt}");
          r = d.dim;
        }
        return this.stamp({ type: "rule", width, height, raise: r, pos: t.pos });
      }
      case "\\raisebox": {
        const dim = this.readDimArg(t);
        const body = this.parseTextArg(t, TEXT_DEFAULT);
        return this.stamp({ type: "raise", dim, body: [{ type: "text", body, pos: t.pos }], pos: t.pos });
      }
      case "\\nobreak":
        return { type: "penalty", value: 10000, pos: t.pos };
      case "\\allowbreak":
        return { type: "penalty", value: 0, pos: t.pos };
      case "\\penalty": {
        const d = this.readInlineNumber(t);
        return { type: "penalty", value: d, pos: t.pos };
      }
      case "\\intertext":
      case "\\shortintertext":
        this.err(`${name} is allowed only at the start of a row of align`, t.pos, "Use \\text{...} inside the formula instead");
        break;
      case "\\hline":
      case "\\hdashline":
        this.err(`Misplaced ${name}`, t.pos, "\\hline may only start a row of an array");
        break;
      case "\\(":
      case "\\[":
      case "\\]":
        this.err(`Unexpected ${name} inside math`, t.pos, "Remove the inner math delimiters; the formula is already math");
        break;
      case "\\shoveleft":
      case "\\shoveright":
        // multline line placement is not adjusted; the content is kept
        return this.parseArg(t);
      case "\\vcenter": {
        const body = this.parseArg(t);
        return this.stamp({ type: "group", body, pos: t.pos });
      }
    }
    if (name === "\\") this.err("Lone \\ at the end of the formula", t.pos, "Remove the trailing backslash or complete the command");
    const known = this.knownCommands();
    this.err(`Undefined control sequence ${name}`, t.pos, undefinedHint(name, known), commandFix(name, known));
  }

  /** tikz-cd: the body is read raw and set as an array of objects and straight arrows. */
  private tikzcd(t: Token): MathNode[] {
    this.ex.readRawOptional();
    const body: Token[] = [];
    let depth = 0;
    for (;;) {
      const u = this.ex.nextRaw();
      if (u.k === "eof") this.err("\\begin{tikzcd} has no matching \\end{tikzcd}", t.pos, "Add \\end{tikzcd}");
      if (u.k === "cs" && (u.v === "\\begin" || u.v === "\\end")) {
        const arg = this.ex.readRawArg(u);
        const env = untokenize(arg).trim();
        if (env === "tikzcd") {
          if (u.v === "\\begin") depth++;
          else if (depth-- === 0) break;
        }
        body.push(u, { k: "char", v: "{", pos: u.pos }, ...arg, { k: "char", v: "}", pos: u.pos });
        continue;
      }
      body.push(u);
    }
    let seen = noted.get(this.ex.macros);
    if (!seen) noted.set(this.ex.macros, (seen = new Set()));
    if (!seen.has("tikzcd")) {
      seen.add("tikzcd");
      this.warn("MATH004", "tikz-cd diagram drawn as a grid with straight arrows", t.pos, "Bent, crossing or long arrows are approximated; for an exact drawing render the diagram to SVG and include it as a figure");
    }
    this.ex.pushTokens(tokenize(tikzcd(untokenize(body)), t.pos));
    return [];
  }

  private knownCommands(): string[] {
    return [
      ...MATH_SYMBOLS.keys(),
      ...NAMED_OPS.keys(),
      ...ACCENTS.keys(),
      ...ARROWS.keys(),
      ...Object.keys(SPACES),
      ...Object.keys(MATH_FONTS),
      ...Object.keys(CLASS_CMDS),
      ...Object.keys(STYLES),
      ...Object.keys(BIG_SIZES),
      ...Object.keys(BUILTIN_MACROS),
      ...Object.keys(this.ex.macros),
      ...PARSER_COMMANDS,
      ...packageCommandNames(),
    ];
  }

  private readInlineNumber(owner: Token): number {
    let s = "";
    let t = this.nextNonSpace();
    while (t.k === "char" && /[-+0-9]/.test(t.v)) {
      s += t.v;
      t = this.ex.next();
    }
    this.ex.pushBack(t);
    const n = Number(s);
    if (!s || !Number.isFinite(n)) this.err(`Invalid number after ${owner.v}`, owner.pos, "Write e.g. \\penalty10000");
    return Math.max(-10000, Math.min(10000, n));
  }

  private tokensOf(s: string, pos: number): Token[] {
    const out: Token[] = [];
    for (const ch of s) out.push({ k: /\s/.test(ch) ? "space" : "char", v: ch, pos });
    return out;
  }

  private genfracDelim(s: string, t: Token): SymDef | null {
    const key = s.startsWith("\\") ? s : s;
    const name = DELIM_NAMES.get(key);
    if (name === undefined) this.err(`Invalid delimiter '${s}' in \\genfrac`, t.pos, "Use ( [ \\{ | or leave the argument empty");
    return this.delimSym(name);
  }

  private parseListUntilOf(owner: Token): { list: MathList; stop: Token } {
    const list: MathList = [];
    for (;;) {
      const t = this.ex.next();
      if (t.k === "eof") this.err("\\root without \\of", owner.pos, "Write \\root n \\of x, or \\sqrt[n]{x}");
      if (t.k === "space") continue;
      if (t.k === "cs" && t.v === "\\of") return { list, stop: t };
      const n = this.parseAtom(t, list);
      if (n) list.push(...(Array.isArray(n) ? n : [n]));
    }
  }

  private classOfList(list: MathList): Cls {
    if (list.length === 1) {
      const n = list[0]!;
      if (n.type === "sym") return n.cls === "bin" || n.cls === "rel" ? n.cls : "ord";
      if (n.type === "op") return "op";
      if (n.type === "group" && n.cls) return n.cls === "bin" || n.cls === "rel" ? n.cls : "ord";
      if (n.type === "not") return "rel";
    }
    return "ord";
  }

  private charAtom(t: Token): MathNode | null {
    const ch = t.v;
    if (ch === "{") {
      const body = this.parseGroupBody(t);
      return this.stamp({ type: "group", body, pos: t.pos });
    }
    if (ch === "~") return this.stamp({ type: "space", dim: { v: 0.333333, u: "em" }, kern: false, pos: t.pos });
    if (ch === "#") this.err("Macro parameter character # outside a macro definition", t.pos, "Write \\# for a literal #");
    if (ch === "$") this.err("Unexpected $ inside math", t.pos, "Remove the inner $ signs; the math delimiters are already given");
    if (this.state.opname) {
      if (ch === "-") return this.symNode({ cls: "ord", fam: "main", cp: 0x2d, text: "-", mml: "mi" }, t.pos);
      if (ch === "*") return this.symNode({ cls: "ord", fam: "main", cp: 0x2a, text: "*", mml: "mi" }, t.pos);
    }
    const sym = MATH_SYMBOLS.get(ch) ?? UNICODE_SYMBOLS.get(ch.codePointAt(0)!);
    if (sym) return this.symNode(sym, t.pos);
    // Any other character: an ordinary symbol drawn from whatever face has it.
    const cp = ch.codePointAt(0)!;
    const letter = /\p{L}/u.test(ch);
    return this.symNode({ cls: "ord", fam: letter ? "mathI" : "main", cp, text: ch, mml: letter ? "mi" : /\p{N}/u.test(ch) ? "mn" : "mo" }, t.pos);
  }

  private dots(t: Token): MathNode {
    let kind = t.v;
    if (kind === "\\dots") {
      const nx = this.peekNonSpace();
      let s: SymDef | undefined;
      if (nx.k === "char") s = MATH_SYMBOLS.get(nx.v);
      else if (nx.k === "cs") s = MATH_SYMBOLS.get(nx.v);
      if (s && (s.cls === "bin" || s.cls === "rel")) kind = "\\dotsb";
      else if (nx.k === "cs" && (nx.v === "\\int" || nx.v === "\\iint" || nx.v === "\\oint")) kind = "\\dotsi";
      else if (nx.k === "cs" && (nx.v === "\\not" || nx.v === "\\neq" || nx.v === "\\implies" || nx.v === "\\iff")) kind = "\\dotsb";
      else kind = "\\dotsc";
    }
    const name = kind === "\\dotsb" || kind === "\\dotsm" || kind === "\\dotsi" ? "\\cdots" : "\\ldots";
    return this.symNode(MATH_SYMBOLS.get(name)!, t.pos);
  }

  private fontArg(t: Token, font: MathFont | null): MathNode {
    const body = this.parseArg(t, { font: font ?? undefined });
    const g: MathNode = { type: "group", body, pos: t.pos };
    if (font === "bsym" && body.length === 1) {
      // \boldsymbol keeps the class of a single symbol: \boldsymbol{+} is still a binary operator.
      const only = body[0]!;
      if (only.type === "sym" || only.type === "op") return only;
    }
    return this.stamp(g);
  }

  private leftRight(t: Token): MathNode {
    this.enter(t);
    try {
      const left = this.readDelim(t);
      this.opens.push({ kind: "left", tok: t, depth: this.listStarts.length + 1 });
      let parsed: { list: MathList; stop: Token };
      try {
        parsed = this.parseList({ right: true });
      } finally {
        this.opens.pop();
      }
      const { list, stop } = parsed;
      if (stop.k !== "cs" || stop.v !== "\\right") {
        this.err("\\left has no matching \\right", t.pos, "Add \\right) (or \\right. for an invisible delimiter) before the end of the group", this.closeBefore(t, this.src.length, "\\right."));
      }
      const right = this.readDelim(stop);
      return this.stamp({ type: "leftright", left, right, body: list, pos: t.pos });
    } finally {
      this.leave();
    }
  }

  // ------------------------------------------------------------ text mode

  private textFontFor(cmd: string, base: TextFont): TextFont {
    switch (cmd) {
      case "\\textbf":
      case "\\bfseries":
      case "\\bf":
        return { ...base, bold: true };
      case "\\textmd":
      case "\\mdseries":
        return { ...base, bold: false };
      case "\\textit":
      case "\\textsl":
      case "\\itshape":
      case "\\slshape":
      case "\\it":
      case "\\sl":
        return { ...base, italic: true };
      case "\\emph":
      case "\\em":
        return { ...base, italic: !base.italic };
      case "\\textup":
      case "\\upshape":
        return { ...base, italic: false };
      case "\\texttt":
      case "\\ttfamily":
      case "\\tt":
        return { ...base, family: "tt" };
      case "\\textsf":
      case "\\sffamily":
      case "\\sf":
        return { ...base, family: "sf" };
      case "\\textrm":
      case "\\rmfamily":
      case "\\rm":
        return { ...base, family: "rm" };
      case "\\textnormal":
      case "\\normalfont":
        return { ...TEXT_DEFAULT };
      default:
        return base;
    }
  }

  /** A text-mode argument: {...} or a single token. */
  parseTextArg(owner: Token, font: TextFont): TextItem[] {
    const t = this.nextNonSpace();
    if (t.k === "eof" || isChar(t, "}")) this.err(`Missing argument for ${owner.v}`, t.k === "eof" ? owner.pos : t.pos, "Check for an unbalanced { or a missing argument");
    if (!isChar(t, "{")) {
      // a single-token argument
      const items: TextItem[] = [];
      this.enter(t);
      try {
        this.textToken(t, items, { font, color: this.state.color });
      } finally {
        this.leave();
      }
      return items;
    }
    this.enter(t);
    try {
      return this.parseTextBody(t, font);
    } finally {
      this.leave();
    }
  }

  /** Text up to the } matching an already consumed {. */
  private parseTextBody(open: Token, font: TextFont): TextItem[] {
    const items: TextItem[] = [];
    const st = { font, color: this.state.color };
    for (;;) {
      const t = this.ex.next();
      if (t.k === "eof") this.err("Unclosed group: { has no matching }", open.pos, "Add the } where the text ends", this.closeBefore(open, this.src.length, "}"));
      if (isChar(t, "}")) return items;
      this.textToken(t, items, st);
    }
  }

  private pushChars(items: TextItem[], s: string, st: { font: TextFont; color?: Color }): void {
    const last = items[items.length - 1];
    if (last && last.k === "chars" && last.font === st.font && last.color === st.color) last.s += s;
    else {
      const it: TextItem = { k: "chars", s, font: st.font };
      if (st.color) it.color = st.color;
      items.push(it);
    }
  }

  private textToken(t: Token, items: TextItem[], st: { font: TextFont; color?: Color }): void {
    if (t.k === "space") {
      const last = items[items.length - 1];
      if (!(last && last.k === "space" && !last.dim)) items.push({ k: "space" });
      return;
    }
    if (t.k === "param") this.err("Macro parameter character # in text", t.pos, "Write \\# for a literal #");
    if (t.k === "char") {
      switch (t.v) {
        case "{": {
          this.enter(t);
          try {
            items.push(...this.parseTextBody(t, st.font).map((it) => (st.color && !it.color ? { ...it, color: st.color } : it)));
          } finally {
            this.leave();
          }
          return;
        }
        case "$": {
          this.enter(t);
          try {
            const { list, stop } = this.withState({ color: st.color, font: undefined }, () => this.parseList({ dollar: true }));
            if (stop.k === "eof") this.err("Unclosed $ inside text", t.pos, "Close the inline math with $");
            items.push({ k: "math", body: list, color: st.color });
          } finally {
            this.leave();
          }
          return;
        }
        case "~":
          items.push({ k: "space", dim: { v: 0.333333, u: "em" } });
          return;
        case "&":
          this.err("Misplaced & in text", t.pos, "Write \\& for a literal ampersand");
          break;
        case "^":
        case "_":
          this.err(`${t.v} is only allowed in math`, t.pos, `Put it in math: \\text{... $x${t.v}2$ ...}, or write \\text${t.v === "^" ? "asciicircum" : "underscore"}`);
          break;
        case "-": {
          // -- and --- ligatures
          let n = 1;
          for (;;) {
            const u = this.ex.next();
            if (isChar(u, "-") && n < 3) {
              n++;
              continue;
            }
            this.ex.pushBack(u);
            break;
          }
          this.pushChars(items, n === 1 ? "-" : n === 2 ? "–" : "—", st);
          return;
        }
        case "`":
        case "'": {
          const u = this.ex.next();
          if (isChar(u, t.v)) {
            this.pushChars(items, t.v === "`" ? "“" : "”", st);
            return;
          }
          this.ex.pushBack(u);
          this.pushChars(items, t.v === "`" ? "‘" : "’", st);
          return;
        }
        default:
          this.pushChars(items, t.v, st);
          return;
      }
    }
    if (t.k !== "cs") return;
    const name = t.v;
    const sym = TEXT_SYMBOLS.get(name);
    if (sym) {
      this.pushChars(items, sym, st);
      return;
    }
    const acc = TEXT_ACCENTS.get(name);
    if (acc) {
      const arg = this.parseTextArg(t, st.font);
      const first = arg[0];
      const base = first && first.k === "chars" ? first.s : "";
      const ch = base ? String.fromCodePoint(base.codePointAt(0)!) : "";
      const it: TextItem = { k: "accent", cp: acc[0], mark: acc[1], below: acc[2], base: ch, font: st.font };
      if (st.color) it.color = st.color;
      items.push(it);
      if (base.length > ch.length) this.pushChars(items, base.slice(ch.length), st);
      items.push(...arg.slice(1));
      return;
    }
    const sp = SPACES[name];
    if (sp) {
      if (name === "\\ " || name === "\\space" || name === "\\nobreakspace") items.push({ k: "space", dim: { v: 0.333333, u: "em" } });
      else items.push({ k: "space", dim: sp.dim.u === "mu" ? { v: sp.dim.v / 18, u: "em" } : sp.dim });
      return;
    }
    switch (name) {
      case "\\text":
      case "\\textrm":
      case "\\textnormal":
      case "\\textup":
      case "\\textmd":
      case "\\textbf":
      case "\\textit":
      case "\\textsl":
      case "\\emph":
      case "\\texttt":
      case "\\textsf":
      case "\\mbox":
      case "\\hbox": {
        const sub = this.parseTextArg(t, this.textFontFor(name, st.font));
        items.push(...sub.map((it) => (st.color && !it.color ? { ...it, color: st.color } : it)));
        return;
      }
      case "\\bfseries":
      case "\\mdseries":
      case "\\itshape":
      case "\\slshape":
      case "\\upshape":
      case "\\ttfamily":
      case "\\sffamily":
      case "\\rmfamily":
      case "\\normalfont":
      case "\\em":
      case "\\bf":
      case "\\it":
      case "\\sl":
      case "\\rm":
      case "\\sf":
      case "\\tt":
        st.font = this.textFontFor(name, st.font);
        return;
      case "\\color":
        st.color = this.readColor(t);
        return;
      case "\\textcolor": {
        const c = this.readColor(t);
        const sub = this.parseTextArg(t, st.font);
        items.push(...sub.map((it) => (!it.color ? { ...it, color: c } : it)));
        return;
      }
      case "\\(": {
        this.enter(t);
        try {
          const { list, stop } = this.withState({ color: st.color, font: undefined }, () => this.parseList({ paren: true }));
          if (stop.k === "eof") this.err("Unclosed \\( inside text", t.pos, "Close the inline math with \\)");
          items.push({ k: "math", body: list, color: st.color });
        } finally {
          this.leave();
        }
        return;
      }
      case "\\ensuremath": {
        const body = this.withState({ color: st.color, font: undefined }, () => this.parseArg(t));
        items.push({ k: "math", body, color: st.color });
        return;
      }
      case "\\hspace":
      case "\\hspace*": {
        if (isChar(this.ex.peekRaw(), "*")) this.ex.nextRaw();
        items.push({ k: "space", dim: this.readDimArg(t) });
        return;
      }
      case "\\kern": {
        const d = this.readInlineDim(t);
        items.push({ k: "space", dim: { v: d.v, u: d.u } });
        return;
      }
      case "\\\\":
      case "\\newline":
        // a line break inside \text: TeX would end the paragraph; keep a space.
        items.push({ k: "space" });
        return;
      case "\\label":
        this.ex.readRawArg(t);
        return;
      case "\\relax":
      case "\\/":
      case "\\noindent":
      case "\\nobreak":
      case "\\allowbreak":
        return;
    }
    if (SIZE_CMDS.has(name)) return;
    if (name === "\\\\") return;
    const textKnown = [...TEXT_SYMBOLS.keys(), ...TEXT_ACCENTS.keys(), ...Object.keys(SPACES), ...TEXT_COMMANDS];
    this.err(`Undefined control sequence ${name} in text`, t.pos, undefinedHint(name, textKnown), commandFix(name, textKnown));
  }

  private withState<T>(extra: Partial<State>, fn: () => T): T {
    const saved = this.state;
    this.state = { ...saved, ...extra };
    try {
      return fn();
    } finally {
      this.state = saved;
    }
  }

  // ------------------------------------------------------------ definitions

  private readMacroName(owner: Token): Token {
    const t = this.ex.peekNonSpaceRaw();
    if (isChar(t, "{")) {
      this.ex.nextRaw();
      const toks = this.ex.readRawGroupBody(t).filter((u) => u.k !== "space");
      if (toks.length !== 1 || toks[0]!.k !== "cs") this.err(`${owner.v} needs a command name such as \\foo`, owner.pos, `Write ${owner.v}{\\name}{...}`);
      return toks[0]!;
    }
    this.ex.nextRaw();
    if (t.k !== "cs") this.err(`${owner.v} needs a command name such as \\foo`, owner.pos, `Write ${owner.v}{\\name}{...}`);
    return t;
  }

  private isBuiltin(name: string): boolean {
    return (
      MATH_SYMBOLS.has(name) ||
      NAMED_OPS.has(name) ||
      ACCENTS.has(name) ||
      ARROWS.has(name) ||
      name in SPACES ||
      name in MATH_FONTS ||
      name in CLASS_CMDS ||
      name in STYLES ||
      name in BIG_SIZES ||
      PARSER_COMMANDS.includes(name)
    );
  }

  private checkRedefine(name: Token, src: string, kind: string): void {
    const existing = this.ex.macros[name.v];
    if (kind === "\\renewcommand") return;
    if (existing !== undefined && existing !== src) {
      this.warn("MATH002", `Math macro ${name.v} redefined`, name.pos, "Use \\renewcommand to redefine on purpose, or rename the macro");
    } else if (existing === undefined && kind !== "\\def" && this.isBuiltin(name.v)) {
      this.warn("MATH002", `Math macro ${name.v} redefines a built-in command`, name.pos, "Pick another name, or use \\renewcommand to replace it on purpose");
    }
  }

  private newcommand(t: Token): void {
    if (isChar(this.ex.peekRaw(), "*")) this.ex.nextRaw();
    const name = this.readMacroName(t);
    let nargs = 0;
    const n = this.ex.readRawOptional();
    if (n) {
      const s = n.map((u) => u.v).join("").trim();
      if (!/^[0-9]$/.test(s)) this.err(`Invalid argument count [${s}] for ${name.v}`, t.pos, "Use a digit 0-9, e.g. \\newcommand{\\f}[2]{...}");
      nargs = Number(s);
    }
    const opt = n ? this.ex.readRawOptional() : undefined;
    const body = this.ex.readRawArg(t);
    const def = makeDef(body, nargs, opt);
    if (t.v === "\\providecommand" && (this.ex.macros[name.v] !== undefined || this.isBuiltin(name.v))) return;
    this.checkRedefine(name, def.src, t.v);
    this.ex.define(name.v, def);
  }

  private def(t: Token): void {
    const name = this.ex.nextRaw();
    if (name.k !== "cs") this.err(`${t.v} needs a command name such as \\foo`, t.pos, `Write ${t.v}\\name{...}`);
    let nargs = 0;
    for (;;) {
      const u = this.ex.peekNonSpaceRaw();
      if (isChar(u, "{")) break;
      this.ex.nextRaw();
      if (u.k === "param" && u.v === String(nargs + 1)) {
        nargs++;
        continue;
      }
      if (u.k === "eof") this.err(`${t.v}${name.v} has no body`, t.pos, `Write ${t.v}${name.v}{...}`);
      this.err(`Delimited macro parameters are not supported in ${t.v}${name.v}`, u.pos, `Use \\newcommand{${name.v}}[n]{...} instead`);
    }
    const body = this.ex.readRawArg(t);
    const def = makeDef(body, nargs);
    this.checkRedefine(name, def.src, "\\def");
    this.ex.define(name.v, def);
  }

  private let(t: Token): void {
    const name = this.ex.nextRaw();
    if (name.k !== "cs") this.err("\\let needs a command name", t.pos, "Write \\let\\new\\old");
    let target = this.ex.nextRaw();
    while (target.k === "space") target = this.ex.nextRaw();
    if (isChar(target, "=")) {
      target = this.ex.nextRaw();
      while (target.k === "space") target = this.ex.nextRaw();
    }
    if (target.k === "eof") this.err("\\let needs a target", t.pos, "Write \\let\\new\\old");
    const existing = target.k === "cs" ? this.ex.lookup(target.v) : undefined;
    const def = existing ? { ...existing } : makeDef([target], 0);
    this.ex.define(name.v, def);
  }

  private declareOperator(t: Token): void {
    let star = false;
    if (isChar(this.ex.peekRaw(), "*")) {
      this.ex.nextRaw();
      star = true;
    }
    const name = this.readMacroName(t);
    const body = this.ex.readRawArg(t);
    const toks: Token[] = [{ k: "cs", v: star ? "\\operatorname*" : "\\operatorname", pos: t.pos }, { k: "char", v: "{", pos: t.pos }, ...body, { k: "char", v: "}", pos: t.pos }];
    const def = makeDef(toks, 0);
    this.checkRedefine(name, def.src, t.v);
    this.ex.define(name.v, def);
  }

  // ------------------------------------------------------------ environments

  private envName(t: Token): string {
    const toks = this.ex.readRawArg(t);
    return toks.map((u) => (u.k === "space" ? "" : u.v)).join("");
  }

  private environment(t: Token): MathNode | MathNode[] {
    const name = this.envName(t);
    if (name === "tikzcd") return this.tikzcd(t);
    const spec = ENVS[name];
    if (!spec) {
      this.err(`No such environment: ${name}`, t.pos, `Supported environments: ${ENVIRONMENT_NAMES.filter((n) => !n.endsWith("*")).join(", ")}`);
    }
    if (spec.kind === "cases" && name.endsWith("*")) this.textColumns();
    this.enter(t);
    try {
      if (spec.kind === "equation") {
        const saved = this.state;
        const { list, stop } = this.parseList({ end: true });
        this.state = saved;
        if (stop.k === "eof") this.err(`\\begin{${name}} has no matching \\end{${name}}`, t.pos, `Add \\end{${name}}`, this.atEnd(`\\end{${name}}`));
        this.checkEnd(stop, name);
        return spec.style === "display" ? list : [{ type: "style", style: "text", pos: t.pos }, ...list];
      }
      let vpos: "c" | "t" | "b" = "c";
      if (spec.vpos) {
        const o = this.rawOptional()?.trim();
        if (o === "t" || o === "b") vpos = o;
      }
      let align: "l" | "c" | "r" = "c";
      if (spec.colAlign) {
        const o = this.rawOptional()?.trim();
        if (o === "l" || o === "r" || o === "c") align = o;
        else if (o !== undefined) this.err(`Invalid column alignment [${o}] for ${name}`, t.pos, "Use [l], [c] or [r]");
      }
      let cols: ColSpec[] | undefined;
      let trailing = 0;
      let pairs: number | undefined;
      if (spec.arg === "cols") {
        const parsed = this.colSpec(t);
        cols = parsed.cols;
        trailing = parsed.trailing;
      } else if (spec.arg === "pairs") {
        const s = this.rawArgString(t).trim();
        if (!/^[0-9]+$/.test(s) || Number(s) < 1) this.err(`\\begin{${name}} needs a number of column pairs`, t.pos, `Write \\begin{${name}}{2}`);
        pairs = Number(s);
      }
      if (spec.vpos && vpos === "c") {
        const o = this.rawOptional()?.trim();
        if (o === "t" || o === "b") vpos = o;
      }
      const node = this.arrayBody(t, name, spec, cols, "end", pairs);
      node.vpos = vpos;
      if (align !== "c") {
        const n = Math.max(1, ...node.rows.map((r) => r.cells.length));
        node.cols = Array.from({ length: n }, () => ({ align, lines: 0 }));
      }
      if (trailing) node.trailingLines = trailing;
      if (spec.left || spec.right) {
        return this.stamp({ type: "leftright", left: spec.left ? this.delimSym(spec.left) : null, right: spec.right ? this.delimSym(spec.right) : null, body: [node], pos: t.pos });
      }
      return node;
    } finally {
      this.leave();
    }
  }

  /**
   * mathtools' cases*: wrap every cell after the first of each row in \text{...}
   * by rewriting the raw tokens up to the environment's \end.
   */
  private textColumns(): void {
    const out: Token[] = [];
    let depth = 0;
    let envs = 0;
    let inText = false;
    // Spaces at the edges of a text cell are dropped, as LaTeX drops them around a cell.
    let leading = false;
    const close = (pos: number) => {
      if (inText) {
        while (out.length && out[out.length - 1]!.k === "space") out.pop();
        out.push({ k: "char", v: "}", pos });
      }
      inText = false;
    };
    for (;;) {
      const u = this.ex.nextRaw();
      if (u.k === "eof") {
        close(u.pos);
        out.push(u);
        break;
      }
      if (isChar(u, "{")) depth++;
      else if (isChar(u, "}")) depth--;
      else if (u.k === "cs" && u.v === "\\begin") envs++;
      else if (u.k === "cs" && u.v === "\\end") {
        if (envs === 0 && depth === 0) {
          close(u.pos);
          out.push(u);
          break;
        }
        envs--;
      }
      if (leading && u.k === "space") continue;
      leading = false;
      const top = depth === 0 && envs === 0;
      if (top && u.k === "cs" && u.v === "\\\\") {
        close(u.pos);
        out.push(u);
        continue;
      }
      out.push(u);
      if (top && isChar(u, "&") && !inText) {
        out.push({ k: "cs", v: "\\text", pos: u.pos }, { k: "char", v: "{", pos: u.pos });
        inText = true;
        leading = true;
      }
    }
    this.ex.pushTokens(out);
  }

  private checkEnd(stop: Token, name: string): void {
    const got = this.envName(stop);
    if (got === name) return;
    // The \end names the wrong environment: name the one that is open.
    const m = this.isRaw(stop) ? /^\\end\s*\{([^{}]*)\}/.exec(this.src.slice(stop.pos)) : null;
    const fix = m && m[1]!.trim() === got ? { old: m[0], new: `\\end{${name}}`, safe: true, at: stop.pos } : undefined;
    this.err(`\\begin{${name}} ended by \\end{${got}}`, stop.pos, `Close it with \\end{${name}}`, fix);
  }

  private colSpec(owner: Token): { cols: ColSpec[]; trailing: number } {
    const toks = this.ex.readRawArg(owner).filter((u) => u.k !== "space");
    const cols: ColSpec[] = [];
    let lines = 0;
    let pre: MathList | undefined;
    const expandStar = (list: Token[]): Token[] => {
      // *{n}{spec}
      const out: Token[] = [];
      for (let i = 0; i < list.length; i++) {
        const u = list[i]!;
        if (isChar(u, "*")) {
          const [count, i1] = groupAt(list, i + 1);
          const [body, i2] = groupAt(list, i1);
          const n = Number(count.map((x) => x.v).join(""));
          if (!Number.isFinite(n) || n < 0 || n > 1000) this.err("Invalid *{n}{...} in array column spec", owner.pos, "Write e.g. *{3}{c}");
          const inner = expandStar(body);
          for (let k = 0; k < n; k++) {
            out.push(...inner);
            if (out.length > 4000) this.err("Array column spec is too long", owner.pos, "Use at most 1000 columns");
          }
          i = i2 - 1;
          continue;
        }
        out.push(u);
      }
      return out;
    };
    const groupAt = (list: Token[], i: number): [Token[], number] => {
      const u = list[i];
      if (!u) this.err("Incomplete array column spec", owner.pos, "Check the braces in the column spec");
      if (!isChar(u, "{")) return [[u], i + 1];
      let depth = 0;
      for (let j = i; j < list.length; j++) {
        if (isChar(list[j]!, "{")) depth++;
        else if (isChar(list[j]!, "}") && --depth === 0) return [list.slice(i + 1, j), j + 1];
      }
      this.err("Unbalanced braces in array column spec", owner.pos, "Check the braces in the column spec");
    };
    const all = expandStar(toks);
    for (let i = 0; i < all.length; i++) {
      const u = all[i]!;
      if (u.k === "char" && (u.v === "l" || u.v === "c" || u.v === "r")) {
        const col: ColSpec = { align: u.v, lines };
        if (pre) col.pre = pre;
        cols.push(col);
        lines = 0;
        pre = undefined;
      } else if (u.k === "char" && u.v === "|") lines++;
      else if (u.k === "char" && (u.v === "@" || u.v === "!")) {
        const [body, next] = groupAt(all, i + 1);
        const list = this.subParse(body, owner);
        if (cols.length && !pre && lines === 0) cols[cols.length - 1]!.post = list;
        else pre = list;
        i = next - 1;
      } else if (u.k === "char" && (u.v === "p" || u.v === "m" || u.v === "b")) {
        const [, next] = groupAt(all, i + 1);
        cols.push({ align: "l", lines });
        lines = 0;
        i = next - 1;
      } else if (u.k === "char" && (u.v === ">" || u.v === "<")) {
        const [, next] = groupAt(all, i + 1);
        i = next - 1;
      } else {
        this.err(`Invalid column type '${u.v}' in array spec`, owner.pos, "Use l, c, r and | (and @{...})");
      }
      if (cols.length > 1000) this.err("Too many columns in array spec", owner.pos, "Use at most 1000 columns");
    }
    if (!cols.length) this.err("Array column spec has no columns", owner.pos, "Write e.g. \\begin{array}{cc}");
    return { cols, trailing: lines };
  }

  /** Parse a token list (from a column spec) as math. */
  private subParse(toks: Token[], owner: Token): MathList {
    this.ex.pushTokens([...toks, { k: "char", v: "}", pos: owner.pos }]);
    return this.parseGroupBody({ k: "char", v: "{", pos: owner.pos });
  }

  private rowBreakArgs(): Dim | undefined {
    if (isChar(this.ex.peekRaw(), "*")) this.ex.nextRaw();
    const save = this.ex.peekNonSpaceRaw();
    if (!isChar(save, "[")) return undefined;
    const toks = this.ex.readRawOptional()!;
    const r = readDim(toks, 0);
    if (r && toks.slice(r.next).every((u) => u.k === "space")) return r.dim;
    // Not a dimension: it was content that starts with [.
    this.ex.pushTokens([save, ...toks, { k: "char", v: "]", pos: save.pos }]);
    return undefined;
  }

  arrayBody(t: Token, env: string, spec: Pick<EnvSpec, "kind" | "style" | "display" | "stretch" | "maxCols">, cols: ColSpec[] | undefined, close: "end" | "}", pairs?: number): ArrayNode {
    const kind = spec.kind as ArrayKind;
    const node: ArrayNode = {
      type: "array",
      env,
      kind,
      rows: [],
      hlinesBelow: 0,
      style: spec.style,
      vpos: "c",
      arrayStretch: spec.stretch ?? 1,
      outerSep: kind === "array",
      pos: t.pos,
    };
    if (cols) node.cols = cols;
    if (pairs) node.pairs = pairs;
    if (spec.display) node.display = true;
    const maxCols = cols ? cols.length : pairs ? pairs * 2 : spec.maxCols;
    const savedTarget = this.tagTarget;
    const savedState = this.state;
    try {
      for (;;) {
        const row: ArrayRow = { cells: [], hlines: 0, pos: this.ex.peekRaw().pos };
        if (spec.display) this.tagTarget = row;
        // leading \hline / \intertext
        for (;;) {
          const u = this.peekNonSpace();
          if (u.k === "cs" && (u.v === "\\hline" || u.v === "\\hdashline")) {
            this.nextNonSpace();
            row.hlines++;
            continue;
          }
          if (u.k === "cs" && (u.v === "\\intertext" || u.v === "\\shortintertext") && spec.display) {
            this.nextNonSpace();
            row.intertext = this.parseTextArg(u, TEXT_DEFAULT);
            continue;
          }
          break;
        }
        let stop: Token;
        for (;;) {
          this.state = { ...savedState };
          const r = close === "}" ? this.parseList({ amp: true, row: true, brace: true }) : this.parseList({ amp: true, row: true, end: true });
          stop = r.stop;
          row.cells.push(r.list);
          if (maxCols !== undefined && row.cells.length > maxCols) {
            this.err(
              `Too many columns in ${env}: it has ${maxCols} column${maxCols === 1 ? "" : "s"}`,
              stop.pos,
              cols ? "Add a column to the array specification or remove an &" : `Remove the extra & (${env} allows ${maxCols})`,
            );
          }
          if (isChar(stop, "&")) continue;
          break;
        }
        node.rows.push(row);
        if (stop.k === "cs" && stop.v === "\\\\") {
          const gap = this.rowBreakArgs();
          if (gap) row.gap = gap;
          continue;
        }
        if (stop.k === "eof") {
          if (close === "}") this.err("Unclosed group: { has no matching }", t.pos, "Check for an unbalanced { or a missing argument");
          this.err(`\\begin{${env}} has no matching \\end{${env}}`, t.pos, `Add \\end{${env}}`, this.atEnd(`\\end{${env}}`));
        }
        if (close === "end") {
          if (!(stop.k === "cs" && stop.v === "\\end")) this.err(`\\begin{${env}} has no matching \\end{${env}}`, t.pos, `Add \\end{${env}}`);
          this.checkEnd(stop, env);
        }
        break;
      }
    } finally {
      this.tagTarget = savedTarget;
      this.state = savedState;
    }
    // A trailing \\ leaves an empty last row; rules after it go below the table.
    const last = node.rows[node.rows.length - 1];
    if (node.rows.length > 1 && last && last.cells.length === 1 && last.cells[0]!.length === 0 && !last.tag && !last.intertext) {
      node.hlinesBelow = last.hlines;
      if (last.notag) node.rows[node.rows.length - 2]!.notag ||= false;
      node.rows.pop();
    }
    return node;
  }
}

/** Commands the parser implements itself (for spelling suggestions and redefinition checks). */
const PARSER_COMMANDS: string[] = [
  "\\frac",
  "\\dfrac",
  "\\tfrac",
  "\\cfrac",
  "\\binom",
  "\\dbinom",
  "\\tbinom",
  "\\genfrac",
  "\\sqrt",
  "\\root",
  "\\overline",
  "\\underline",
  "\\underbar",
  "\\overbrace",
  "\\underbrace",
  "\\left",
  "\\right",
  "\\middle",
  "\\operatorname",
  "\\mathop",
  "\\varlimsup",
  "\\varliminf",
  "\\varinjlim",
  "\\varprojlim",
  "\\text",
  "\\textrm",
  "\\textnormal",
  "\\textup",
  "\\textmd",
  "\\textbf",
  "\\textit",
  "\\textsl",
  "\\emph",
  "\\texttt",
  "\\textsf",
  "\\mbox",
  "\\hbox",
  "\\fbox",
  "\\framebox",
  "\\boxed",
  "\\cancel",
  "\\bcancel",
  "\\xcancel",
  "\\cancelto",
  "\\colorbox",
  "\\fcolorbox",
  "\\textcolor",
  "\\color",
  "\\phantom",
  "\\hphantom",
  "\\vphantom",
  "\\smash",
  "\\mathllap",
  "\\mathrlap",
  "\\mathclap",
  "\\llap",
  "\\rlap",
  "\\clap",
  "\\not",
  "\\stackrel",
  "\\overset",
  "\\underset",
  "\\substack",
  "\\begin",
  "\\end",
  "\\tag",
  "\\notag",
  "\\qedhere",
  "\\nonumber",
  "\\label",
  "\\newcommand",
  "\\renewcommand",
  "\\providecommand",
  "\\def",
  "\\gdef",
  "\\let",
  "\\DeclareMathOperator",
  "\\hspace",
  "\\kern",
  "\\mkern",
  "\\hskip",
  "\\mskip",
  "\\hfill",
  "\\hfil",
  "\\rule",
  "\\raisebox",
  "\\nobreak",
  "\\allowbreak",
  "\\penalty",
  "\\limits",
  "\\nolimits",
  "\\displaylimits",
  "\\over",
  "\\atop",
  "\\choose",
  "\\brace",
  "\\brack",
  "\\above",
  "\\dots",
  "\\dotsb",
  "\\dotsc",
  "\\dotsm",
  "\\dotsi",
  "\\dotso",
  "\\rm",
  "\\bf",
  "\\it",
  "\\sf",
  "\\tt",
  "\\cal",
  "\\vcenter",
  "\\shoveleft",
  "\\shoveright",
  "\\intertext",
  "\\hline",
];

const TEXT_COMMANDS = ["\\text", "\\textbf", "\\textit", "\\texttt", "\\textsf", "\\textrm", "\\emph", "\\bfseries", "\\itshape", "\\color", "\\textcolor", "\\hspace", "\\kern", "\\ensuremath"];

/** Parse a formula. Throws MathError on the first error. */
export function parseFormula(tex: string, macros: Record<string, string>, display: boolean, warn: Warn): Formula {
  return new Parser(tex, macros, display, warn).parse();
}
