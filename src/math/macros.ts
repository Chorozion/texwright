/**
 * Macro expansion: user macros from options.macros, definitions made inside
 * the formula (\newcommand, \renewcommand, \providecommand, \def,
 * \DeclareMathOperator) and the built-in macros that LaTeX defines in terms
 * of other commands.
 *
 * Expansion is bounded two ways, like the KaTeX-based pipeline it replaces:
 * at most 1,000 expansions of user macros per formula, and at most 200,000
 * characters of expanded text in total. Either limit raises MATH001, so a
 * macro that calls itself or doubles its argument at every level stops
 * quickly instead of hanging.
 */

import { MathError } from "./errors.js";
import { insertionEdit } from "../fixes.js";

/**
 * The fix for a { at `open` that the formula never closes: a } at its end, safe only when the group
 * holds a single unbroken term (with spaces or operators inside, where it ends is a guess).
 */
function closeAtEnd(src: string, open: number): MathError["fix"] {
  if (src[open] !== "{") return undefined;
  let end = src.length;
  while (end > open + 1 && /\s/.test(src[end - 1]!)) end--;
  const edit = insertionEdit(src, end, "}");
  return edit && { old: edit.old, new: edit.new, safe: /^[^\s{}+\-=<>,;&|]+$/.test(src.slice(open + 1, end)), at: edit.start };
}
import { Lexer, type Token, tokenize, untokenize } from "./lexer.js";
import { type Args, type PackageCommand, expandPackage } from "./packages.js";

export const MAX_EXPANSIONS = 1000;
export const MAX_EXPANDED = 200_000;

export interface MacroDef {
  nargs: number;
  /** Default for an optional first argument (\newcommand{\x}[2][d]{...}). */
  opt?: string;
  body: Token[];
  /** The body as text, as stored in options.macros. */
  src: string;
}

/** Commands LaTeX defines as macros. Bodies may use #1..#9. */
export const BUILTIN_MACROS: Readonly<Record<string, string>> = {
  "\\neq": "\\not=",
  "\\ne": "\\not=",
  "\\notin": "\\not\\in",
  "\\implies": "\\;\\Longrightarrow\\;",
  "\\impliedby": "\\;\\Longleftarrow\\;",
  "\\iff": "\\;\\Longleftrightarrow\\;",
  "\\bmod": "\\mathbin{\\mathrm{mod}}",
  "\\pmod": "\\mkern18mu(\\mathrm{mod}\\mkern6mu#1)",
  "\\mod": "\\mkern18mu\\mathrm{mod}\\mkern6mu#1",
  "\\pod": "\\mkern18mu(#1)",
  "\\mathstrut": "\\vphantom{(}",
  "\\hdots": "\\ldots",
  "\\Bbb": "\\mathbb",
  "\\bold": "\\mathbf",
  "\\newline": "\\\\",
  "\\cr": "\\\\",
  "\\And": "\\mathbin{\\&}",
  "\\ensuremath": "#1",
  "\\coloneqq": "\\mathrel{:\\mkern-1.2mu=}",
  "\\Coloneqq": "\\mathrel{::\\mkern-1.2mu=}",
  "\\eqqcolon": "\\mathrel{=\\mkern-1.2mu:}",
  "\\coloneq": "\\mathrel{:\\mkern-1.2mu-}",
  "\\eqcolon": "\\mathrel{-\\mkern-1.2mu:}",
  "\\dblcolon": "\\mathrel{:\\mkern-0.9mu:}",
  "\\vcentcolon": "\\mathrel{:}",
  "\\llbracket": "\\mathopen{[\\mkern-3.2mu[}",
  "\\rrbracket": "\\mathclose{]\\mkern-3.2mu]}",
  "\\lparen": "(",
  "\\rparen": ")",
  "\\iddots": "\\mathinner{\\raisebox{0.6em}{.}\\mkern1mu\\raisebox{0.35em}{.}\\mkern1mu\\raisebox{0.1em}{.}}",
  "\\dddot": "\\overset{\\ldotp\\ldotp\\ldotp}{#1}",
  "\\ddddot": "\\overset{\\ldotp\\ldotp\\ldotp\\ldotp}{#1}",
  "\\iiiint": "\\int\\!\\!\\!\\int\\!\\!\\!\\int\\!\\!\\!\\int",
  "\\idotsint": "\\int\\cdots\\int",
  "\\mathellipsis": "\\ldots",
  "\\textellipsis": "\\ldots",
};

const bodyCache = new Map<string, Token[]>();

function bodyTokens(src: string): Token[] {
  let toks = bodyCache.get(src);
  if (!toks) {
    toks = tokenize(src);
    if (bodyCache.size > 2000) bodyCache.clear();
    bodyCache.set(src, toks);
  }
  return toks;
}

function maxParam(toks: readonly Token[]): number {
  let n = 0;
  for (const t of toks) if (t.k === "param" && t.v !== "#") n = Math.max(n, Number(t.v));
  return n;
}

/** Rich definitions (argument counts, optional defaults) for macros defined inside formulas, per macros table. */
const richDefs = new WeakMap<Record<string, string>, Map<string, MacroDef>>();

export function defsFor(macros: Record<string, string>): Map<string, MacroDef> {
  let m = richDefs.get(macros);
  if (!m) {
    m = new Map();
    richDefs.set(macros, m);
  }
  return m;
}

const builtinDefs = new Map<string, MacroDef>();
for (const [name, src] of Object.entries(BUILTIN_MACROS)) {
  const body = tokenize(src);
  builtinDefs.set(name, { nargs: maxParam(body), body, src });
}

export function isBuiltinMacro(name: string): boolean {
  return builtinDefs.has(name);
}

export class Expander {
  private readonly stack: Token[] = [];
  private readonly lexer: Lexer;
  /** Expansions of user macros so far. */
  expansions = 0;
  /** Characters of expanded text so far. */
  expanded = 0;
  private readonly rich: Map<string, MacroDef>;

  constructor(
    readonly src: string,
    readonly macros: Record<string, string>,
    /** Package commands for names that are neither macros nor known to the parser. */
    private readonly fallback?: (t: Token) => PackageCommand | undefined,
  ) {
    this.lexer = new Lexer(src);
    this.rich = defsFor(macros);
  }

  /** Next token without expansion. */
  nextRaw(): Token {
    return this.stack.length ? this.stack.pop()! : this.lexer.next();
  }

  peekRaw(): Token {
    const t = this.nextRaw();
    this.stack.push(t);
    return t;
  }

  pushBack(t: Token): void {
    this.stack.push(t);
  }

  pushTokens(toks: readonly Token[]): void {
    for (let i = toks.length - 1; i >= 0; i--) this.stack.push(toks[i]!);
  }

  /** The user or built-in macro a control sequence names, if any. */
  lookup(name: string): MacroDef | undefined {
    const body = this.macros[name];
    if (body !== undefined) {
      const r = this.rich.get(name);
      if (r && r.src === body) return r;
      const toks = bodyTokens(body);
      return { nargs: maxParam(toks), body: toks, src: body };
    }
    return builtinDefs.get(name);
  }

  isMacro(name: string): boolean {
    return this.macros[name] !== undefined || builtinDefs.has(name);
  }

  /** Next token, expanding macros at the head of the input. */
  next(): Token {
    for (;;) {
      const t = this.nextRaw();
      if (t.k !== "cs") return t;
      const def = this.lookup(t.v);
      if (def) {
        this.expand(t, def, this.macros[t.v] !== undefined);
        continue;
      }
      const pkg = this.fallback?.(t);
      if (!pkg) return t;
      this.expandPackage(t, pkg);
    }
  }

  private expandPackage(call: Token, cmd: PackageCommand): void {
    const args: Args = {
      arg: () => untokenize(this.readRawArg(call)),
      opt: () => {
        const o = this.readRawOptional();
        return o && untokenize(o);
      },
      star: () => {
        const t = this.peekNonSpaceRaw();
        if (t.k === "char" && t.v === "*") {
          this.nextRaw();
          return true;
        }
        return false;
      },
      peek: () => {
        const t = this.peekNonSpaceRaw();
        return t.k === "eof" ? "" : t.v;
      },
      macro: (name) => this.macros[name],
      until: (open, close) => {
        const first = this.nextRaw();
        const out: Token[] = [];
        let depth = 0;
        for (;;) {
          const t = this.nextRaw();
          if (t.k === "eof") throw new MathError(`Unclosed ${open} after ${call.v}: ${open} has no matching ${close}`, first.pos, `Close it with ${close}`);
          if (t.k === "char") {
            if (t.v === close && depth === 0) break;
            if (t.v === "{" || (t.v === open && open !== close)) depth++;
            else if (t.v === "}" || t.v === close) depth--;
          }
          out.push(t);
        }
        return untokenize(out);
      },
    };
    const tex = expandPackage(cmd, args);
    this.count(call, true, tex.length + 1);
    this.pushTokens(tokenize(tex, call.pos));
  }

  peek(): Token {
    const t = this.next();
    this.stack.push(t);
    return t;
  }

  /** Skip spaces (raw), returning the next non-space token without consuming it. */
  peekNonSpaceRaw(): Token {
    for (;;) {
      const t = this.nextRaw();
      if (t.k !== "space") {
        this.stack.push(t);
        return t;
      }
    }
  }

  /** One undelimited argument, unexpanded: a token or a balanced group without its braces. */
  readRawArg(owner: Token): Token[] {
    const t = this.peekNonSpaceRaw();
    if (t.k === "eof" || (t.k === "char" && t.v === "}")) {
      throw new MathError(`Missing argument for ${owner.v}`, owner.pos, "Check for an unbalanced { or a missing argument");
    }
    this.nextRaw();
    if (t.k === "char" && t.v === "{") return this.readRawGroupBody(t);
    return [t];
  }

  /** Tokens up to the } matching an already consumed {. */
  readRawGroupBody(open: Token): Token[] {
    const out: Token[] = [];
    let depth = 0;
    for (;;) {
      const t = this.nextRaw();
      if (t.k === "eof") throw new MathError("Unclosed group: { has no matching }", open.pos, "Check for an unbalanced { or a missing argument; the } goes where the group ends", closeAtEnd(this.src, open.pos));
      if (t.k === "char") {
        if (t.v === "{") depth++;
        else if (t.v === "}") {
          if (depth === 0) return out;
          depth--;
        }
      }
      out.push(t);
    }
  }

  /** An optional [..] argument (raw), or undefined when the next token is not [. */
  readRawOptional(): Token[] | undefined {
    const t = this.peekNonSpaceRaw();
    if (!(t.k === "char" && t.v === "[")) return undefined;
    this.nextRaw();
    const out: Token[] = [];
    let depth = 0;
    for (;;) {
      const u = this.nextRaw();
      if (u.k === "eof") throw new MathError("Unclosed optional argument: [ has no matching ]", t.pos, "Close the optional argument with ]");
      if (u.k === "char") {
        if (u.v === "{") depth++;
        else if (u.v === "}") depth--;
        else if (u.v === "]" && depth === 0) return out;
      }
      out.push(u);
    }
  }

  private count(name: Token, user: boolean, size: number): void {
    if (user && ++this.expansions > MAX_EXPANSIONS) {
      throw new MathError(`Too many macro expansions (more than ${MAX_EXPANSIONS}); ${name.v} may call itself`, name.pos, "A macro is used too many times or defined in terms of itself");
    }
    this.expanded += size;
    if (this.expanded > MAX_EXPANDED) {
      throw new MathError(
        `Formula expands to more than ${MAX_EXPANDED.toLocaleString("en-US")} characters through its macros`,
        name.pos,
        "A macro is used too many times or defined in terms of itself",
      );
    }
  }

  private expand(call: Token, def: MacroDef, user: boolean): void {
    const args: Token[][] = [];
    let first = 0;
    if (def.opt !== undefined) {
      const opt = this.readRawOptional();
      args.push(opt ?? bodyTokens(def.opt));
      first = 1;
    }
    for (let k = first; k < def.nargs; k++) args.push(this.readRawArg(call));
    // Build the expansion; tokens from the body report the call's position.
    const out: Token[] = [];
    let size = 0;
    const body = def.body;
    for (let i = 0; i < body.length; i++) {
      const t = body[i]!;
      if (t.k === "param") {
        if (t.v === "#") {
          // ## in a body becomes a parameter marker one level down.
          const nx = body[i + 1];
          if (nx && nx.k === "char" && nx.v >= "1" && nx.v <= "9") {
            out.push({ k: "param", v: nx.v, pos: call.pos });
            i++;
          } else out.push({ k: "char", v: "#", pos: call.pos });
          size++;
          continue;
        }
        const arg = args[Number(t.v) - 1];
        if (arg) {
          for (const a of arg) {
            out.push(a);
            size += a.v.length;
          }
        }
        continue;
      }
      out.push({ k: t.k, v: t.v, pos: call.pos });
      size += t.v.length;
    }
    this.count(call, user, size + 1);
    this.pushTokens(out);
  }

  /** Define (or redefine) a macro in the shared table. */
  define(name: string, def: MacroDef): void {
    this.macros[name] = def.src;
    this.rich.set(name, def);
  }
}

/** Parse "\newcommand"-style definitions' bodies into MacroDefs. */
export function makeDef(body: Token[], nargs: number, opt?: Token[]): MacroDef {
  const def: MacroDef = { nargs: Math.max(nargs, maxParam(body)), body, src: untokenize(body) };
  if (opt) def.opt = untokenize(opt);
  return def;
}
