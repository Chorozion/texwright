/**
 * Recursive-descent parser over the token stream.
 *
 * Content is parsed into a Sink: a list of finished blocks plus the
 * paragraph being built. Groups parse into the sink they appear in; command
 * arguments and environment bodies get a sink of their own. Every construct
 * that needs a closer pushes an Open record, and `checkStop` decides at each
 * token whether the innermost one ends there, reporting LTX003 for closers
 * that are missing or out of order and recovering without throwing.
 */

import type { Block, Inline, Meta, Pos } from "../../ast.js";
import { plainText, slugify, walkBlocks } from "../../ast.js";
import type { Code, FixSpec } from "../../diagnostics.js";
import { editDistance, insertionEdit, lineColAt } from "../../fixes.js";
import { shiftPos, type ParseContext } from "../context.js";
import { ALG_LINES, EXAM_ITEMS, LEVEL, Sink, isChar, isCmd, maxParam, substitute, substituteSize, type Decl, type EnvDef, type Heading, type MacroDef, type Note, type Open, type Target, type TheoremDef } from "./base.js";
import { MATH_SYMBOLS } from "../../math/symbols.js";
import { conditional, counterCommand, runCommand, suggestCommand } from "./commands.js";
import "./packages.js";
import { verbatimBlock } from "./envs.js";
import { lex, type Frame, type Report, type Token } from "./lexer.js";
import { blocksToInlines, firstLabel, isBlank, ligatures, normalizeInlines, trimInlines, trimMath } from "./text.js";

const MAX_DEPTH = 50;
const MAX_EXPANSIONS = 20000;
/**
 * Text that macro and environment expansions may produce in one document,
 * across all its raw LaTeX fragments (counted per Diagnostics object, which a
 * document's fragments share). Expansions are capped in number and depth,
 * but one that copies a long argument twice, nested a dozen times, writes
 * gigabytes within those caps.
 */
const MAX_EXPANDED_CHARS = 4_000_000;
const expandedChars = new WeakMap<object, { chars: number }>();

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** An included path as diagnostics should show it: next to the root file. */
function displayPath(root: string | undefined, path: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(path)) return path;
  const m = root ? /^(.*)[\\/][^\\/]*$/.exec(root) : null;
  return m ? `${m[1]}/${path}` : path;
}

/** Commands whose argument is, by habit, one line: a missing } goes at the end of that line. */
const ONE_LINE_ARGS = new Set([
  ...Object.keys(LEVEL),
  "caption", "title", "author", "date", "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "cite", "citep", "citet",
  "citeauthor", "citeyear", "nocite", "url", "includegraphics", "input", "include", "bibliography", "bibliographystyle", "usepackage", "documentclass",
]);

const STYLABLE = (x: Inline): boolean =>
  !(x.t === "Image" || x.t === "Math" || x.t === "Note" || x.t === "LineBreak" || x.t === "SoftBreak" || x.t === "RawInline" || (x.t === "Span" && !x.content.length));

function wrapDecl(d: Decl, x: Inline): Inline {
  switch (d) {
    case "emph":
      return { t: "Emph", content: [x] };
    case "strong":
      return { t: "Strong", content: [x] };
    case "smallcaps":
      return { t: "SmallCaps", content: [x] };
    case "code":
      return x.t === "Text" ? { t: "Code", text: x.text } : x;
    default:
      if (d.startsWith("color:")) return { t: "Span", attr: { classes: ["color"], attrs: { color: d.slice(6) } }, content: [x] };
      // A size switch (\Large): a span the writers scale.
      return { t: "Span", attr: { classes: [`size-${d}`] }, content: [x] };
  }
}

export class Parser {
  toks: Token[];
  i = 0;
  readonly meta: Meta = {};
  open: Open[] = [];
  targets: (Target | null)[] = [];
  decls: Decl[] = [];
  readonly macros = new Map<string, MacroDef>();
  readonly envs = new Map<string, EnvDef>();
  readonly theorems = new Map<string, TheoremDef>();
  /** \usepackage[numbers]{natbib} was seen. */
  natbibNumbers = false;
  readonly sections: { node: Heading; cmd: string; appendix: boolean }[] = [];
  appendix = false;
  /** Index of an \end that closes the innermost environment though it names another (reported once). */
  misnamedEnd = -1;
  /** Inside the preamble: unknown commands and environments are not reported. */
  preamble = false;
  /** Inside \author{}: \and separates authors. */
  authorMode = false;
  /** Notes made by \footnotemark, waiting for their \footnotetext. */
  pendingMarks: Note[] = [];
  /** Index of the command token the running handler was called for. */
  cmdStart = 0;
  private warned = new Set<string>();
  private expansions = 0;

  constructor(
    readonly ctx: ParseContext,
    text: string,
  ) {
    const root: Frame = { ctx, key: ctx.file ? normPath(ctx.file.split(/[\\/]/).pop()!) : "" };
    this.toks = lex(text, root, this.reporter(root));
    for (const [name, body] of Object.entries(ctx.macros ?? {})) {
      this.macros.set(name.replace(/^\\/, ""), { nargs: maxParam(body), body });
    }
  }

  // ------------------------------------------------------------ entry points

  parseDocument(): Block[] {
    let blocks: Block[] = [];
    const begin = this.toks.findIndex((t, k) => isCmd(t, "begin") && this.envNameAt(k)?.name === "document");
    if (begin >= 0) {
      this.preamble = true;
      this.open.push({ kind: "preamble", tok: this.toks[0] });
      this.parseInto(new Sink(false));
      this.open.pop();
      this.preamble = false;
      const t = this.toks[this.i];
      const env = isCmd(t, "begin") ? this.envNameAt(this.i) : undefined;
      if (t && env) {
        this.i = env.next;
        blocks = this.finishBlocks(this.parseScoped({ kind: "env", name: "document", tok: t }, false, true));
        this.i = this.toks.length;
      }
    } else {
      const sink = new Sink(false);
      this.parseInto(sink);
      blocks = this.finishBlocks(sink);
    }
    this.finalize(blocks);
    return blocks;
  }

  parseInlineDocument(): Inline[] {
    const sink = new Sink(true);
    this.parseInto(sink);
    return this.finishInlines(sink);
  }

  // ------------------------------------------------------------ the loop

  parseInto(sink: Sink): void {
    while (!this.checkStop()) {
      const tok = this.toks[this.i];
      if (!sink.inline && !sink.paraPos && tok.type !== "space" && tok.type !== "par") sink.paraPos = this.pos(tok);
      this.parseItem(sink);
    }
  }

  parseItem(sink: Sink): void {
    const tok = this.toks[this.i];
    switch (tok.type) {
      case "text":
        this.i++;
        this.emitText(sink, ligatures(tok.value));
        return;
      case "space":
        this.i++;
        this.space(sink);
        return;
      case "par":
        this.i++;
        this.par(sink);
        return;
      case "char":
        this.i++;
        this.emitText(sink, tok.value === "~" ? "\u00a0" : tok.value);
        return;
      case "open":
        this.parseGroup(sink);
        return;
      case "close":
        this.i++;
        return;
      case "math":
        this.parseDollar(sink);
        return;
      case "verb":
        this.i++;
        this.emit(sink, { t: "Code", text: tok.value, pos: this.pos(tok) });
        return;
      case "verbatim":
        this.i++;
        verbatimBlock(this, sink, tok);
        return;
      case "cmd":
        this.parseCommand(sink);
        return;
    }
  }

  parseCommand(sink: Sink): void {
    const tok = this.toks[this.i];
    if (this.macros.has(tok.value)) {
      this.expandMacro();
      return;
    }
    this.cmdStart = this.i;
    this.i++;
    if (!runCommand(this, sink, tok)) this.unknownCommand(tok, sink);
  }

  unknownCommand(tok: Token, sink: Sink): void {
    const name = tok.value;
    if (conditional(this, name) || counterCommand(this, sink, name)) return;
    // fontawesome's \faPhone, \faEnvelope, \faLinkedin...: icons, left out quietly.
    if (/^fa[A-Z]/.test(name)) {
      if (isChar(this.toks[this.i], "*")) this.i++;
      return;
    }
    if (MATH_SYMBOLS.has(`\\${name}`)) {
      // \alpha or \leq in running text: LaTeX stops with "Missing $ inserted", then typesets it as math.
      this.warnOnce("LTX006", tok, `\\${name} is a math command outside math; typeset as $\\${name}$`, `Write $\\${name}$`);
      this.emit(sink, { t: "Math", tex: `\\${name}`, pos: this.pos(tok) });
      // TeX would swallow the space after the command; the writer meant one.
      // (The lexer may already have taken the spaces into the command token.)
      if (/\s$/.test(tok.src.text.slice(tok.start, tok.end)) || /\s/.test(tok.src.text.charAt(tok.end))) this.space(sink);
      return;
    }
    // The suggestion costs a fuzzy match over every known name: only for a warning that will be shown.
    if (!this.preamble && !this.warned.has(`LTX001\u0000${tok.src.frame.ctx.file ?? ""}\u0000${name}`)) {
      const near = suggestCommand(name, this.macros.keys());
      const hint = near ? `Did you mean \\${near.replacement}? Otherwise define it with \\newcommand` : "Define it with \\newcommand, or use a supported command";
      const fix = near && { old: `\\${name}`, new: `\\${near.replacement}`, safe: near.safe };
      this.warnOnce("LTX001", tok, `Unsupported command \\${name}; its arguments were kept as text`, hint, name, fix);
    }
    // A star or optional argument right after the command belongs to it.
    if (isChar(this.toks[this.i], "*")) this.i++;
    if (isChar(this.toks[this.i], "[")) this.readOptRaw();
  }

  parseGroup(sink: Sink): void {
    const tok = this.toks[this.i++];
    const o: Open = { kind: "brace", tok, short: this.open[this.open.length - 1]?.short ?? false };
    const saved = this.decls.slice();
    this.open.push(o);
    this.parseInto(sink);
    this.closeOpen(o);
    this.decls = saved;
  }

  /** Parse until `o` closes, into a new sink. Declarations carry in only when `inherit`. */
  parseScoped(o: Open, inline: boolean, inherit: boolean): Sink {
    const saved = this.decls;
    this.decls = inherit ? saved.slice() : [];
    this.open.push(o);
    const sink = new Sink(inline);
    this.parseInto(sink);
    this.closeOpen(o);
    this.decls = saved;
    return sink;
  }

  /** Should the innermost loop stop here? Reports and skips stray closers on the way. */
  checkStop(): boolean {
    for (;;) {
      const tok = this.toks[this.i];
      if (!tok) return true;
      const top = this.open[this.open.length - 1];
      if (tok.type === "close") {
        if (top && top.kind !== "env" && top.kind !== "preamble") return true;
        if (top && this.open.some((o) => o.kind === "brace")) {
          this.reportUnclosed(top);
          return true;
        }
        this.diag("LTX003", "Unmatched '}'", tok, "Remove it or add the matching '{'");
        this.i++;
        continue;
      }
      if (tok.type === "cmd" && tok.value === "end") {
        const env = this.envNameAt(this.i);
        if (env && this.envs.has(env.name)) {
          this.expandEndEnv(env.name, env.next);
          continue;
        }
        if (top && (top.kind === "item" || top.kind === "cell")) return true;
        if (top?.kind === "env" && top.name === env?.name) return true;
        if (env && this.open.some((o) => o.kind === "env" && o.name === env.name)) {
          if (top) this.reportUnclosed(top);
          return true;
        }
        const name = env?.name ?? "";
        if (env && top?.kind === "env" && top.name !== "document" && !this.endsLater(top.name!)) {
          // \begin{itemize} ... \end{enumerate}, and no \end{itemize} anywhere after: the \end is misnamed.
          top.reported = true;
          this.misnamedEnd = this.i;
          const old = this.raw(this.i, env.next);
          const fix = tok.depth === 0 && old.startsWith("\\end") ? { old, new: `\\end{${top.name}}`, safe: true } : undefined;
          this.diag("LTX003", `\\begin{${top.name}} ended by \\end{${name}}`, tok, `Close it with \\end{${top.name}}`, fix);
          return true;
        }
        this.diag("LTX003", `\\end{${name}} without a matching \\begin{${name}}`, tok, `Remove it or add \\begin{${name}} before it`, env ? this.strayEndFix(tok, env) : undefined);
        this.i = env ? env.next : this.i + 1;
        continue;
      }
      if (this.preamble && isCmd(tok, "begin") && this.envNameAt(this.i)?.name === "document") {
        if (top && top.kind !== "preamble") this.reportUnclosed(top);
        return true;
      }
      if (!top) return false;
      if (top.kind === "bracket" && isChar(tok, "]")) return true;
      if (top.kind === "item" && (isCmd(tok, "item") || isCmd(tok, "bibitem"))) return true;
      if (top.kind === "item" && top.name === "algorithmic" && tok.type === "cmd" && ALG_LINES.has(tok.value)) return true;
      if (top.kind === "item" && top.name === "exam" && tok.type === "cmd" && EXAM_ITEMS.has(tok.value)) return true;
      if (top.kind === "cell" && (isChar(tok, "&") || isCmd(tok, "\\") || isCmd(tok, "tabularnewline"))) return true;
      if (top.short && (tok.type === "par" || isCmd(tok, "par") || (tok.type === "cmd" && Object.hasOwn(LEVEL, tok.value)))) {
        this.reportUnclosed(top);
        return true;
      }
      return false;
    }
  }

  reportUnclosed(o: Open): void {
    if (o.reported) return;
    o.reported = true;
    // The closer belongs where parsing noticed it missing (the current token), after the content before it.
    const k = this.i;
    if (o.kind === "brace") {
      const fix = this.braceFix(o.tok, k, o.name);
      this.diag("LTX003", o.name ? `Unclosed '{' in the argument of \\${o.name}` : "Unclosed '{'", o.tok, "Add the matching '}'", fix);
    } else if (o.kind === "bracket") {
      this.diag("LTX003", "Unclosed '[' (optional argument)", o.tok, "Add the matching ']'", this.insertBefore(o.tok, k, "]", false));
    } else if (o.kind === "env") {
      // Before the next \section, or the closer of an enclosing environment, or the end: one place.
      const at = o.name === "document" ? k : this.envEnd(o.tok, k);
      const stop = this.toks[at];
      const clear = !stop || isCmd(stop, "end") || (stop.type === "cmd" && Object.hasOwn(LEVEL, stop.value));
      this.diag("LTX003", `\\begin{${o.name}} is never closed`, o.tok, `Add \\end{${o.name}}`, this.insertBefore(o.tok, at, `\n\\end{${o.name}}`, clear));
    }
  }

  /** Pop `o` and consume its closer, reporting LTX003 when the closer is not there. */
  closeOpen(o: Open): void {
    this.open.pop();
    const t = this.toks[this.i];
    if (o.kind === "brace") {
      if (t?.type === "close") {
        this.i++;
        return;
      }
    } else if (o.kind === "bracket") {
      if (isChar(t, "]")) {
        this.i++;
        return;
      }
    } else if (o.kind === "env") {
      const e = isCmd(t, "end") ? this.envNameAt(this.i) : undefined;
      if (e && (e.name === o.name || this.misnamedEnd === this.i)) {
        this.i = e.next;
        return;
      }
    } else return;
    this.reportUnclosed(o);
  }

  // ------------------------------------------------------------ output

  emit(sink: Sink, x: Inline): void {
    let y = x;
    if (this.decls.length && STYLABLE(x)) {
      for (let k = this.decls.length - 1; k >= 0; k--) y = wrapDecl(this.decls[k], y);
    }
    sink.para.push(y);
    sink.spaced = false;
  }

  emitText(sink: Sink, text: string): void {
    if (text) this.emit(sink, { t: "Text", text });
  }

  space(sink: Sink): void {
    if (sink.spaced || sink.para[sink.para.length - 1]?.t === "LineBreak") return;
    this.emit(sink, { t: "Text", text: " " });
    sink.spaced = true;
  }

  par(sink: Sink): void {
    if (sink.inline) this.space(sink);
    else this.flush(sink);
  }

  flush(sink: Sink): void {
    if (sink.inline) return;
    const content = trimInlines(sink.para);
    if (content.length) sink.blocks.push(sink.paraPos ? { t: "Para", content, pos: sink.paraPos } : { t: "Para", content });
    sink.para = [];
    sink.paraPos = undefined;
    sink.spaced = true;
  }

  block(sink: Sink, b: Block): void {
    if (sink.inline) {
      const xs = blocksToInlines([b]);
      if (xs.length) {
        sink.para.push(...xs);
        sink.spaced = false;
      }
      return;
    }
    this.flush(sink);
    sink.blocks.push(b);
  }

  finishBlocks(sink: Sink): Block[] {
    this.flush(sink);
    return sink.blocks;
  }

  finishInlines(sink: Sink): Inline[] {
    return normalizeInlines(sink.para);
  }

  /** True when nothing but whitespace has been written to the current paragraph. */
  paraEmpty(sink: Sink): boolean {
    return isBlank(sink.para);
  }

  // ------------------------------------------------------------ tokens and arguments

  pos(tok: Token): Pos {
    return shiftPos(tok.src.frame.ctx, tok.line, tok.col);
  }

  diag(code: Code, message: string, tok: Token, hint?: string, fix?: FixSpec): void {
    this.ctx.diagnostics.add(code, message, this.pos(tok), hint || fix ? { hint, fix } : undefined);
  }

  /** The source position of offset `at` in the text `tok` was read from. */
  posIn(tok: Token, at: number): Pos {
    const lc = lineColAt(tok.src.text, at);
    return shiftPos(tok.src.frame.ctx, lc.line, lc.col);
  }

  /**
   * A fix inserting `text` where something `open` began should have ended: before token `k` (the end
   * of the file when `k` is past the last token), after the content that precedes it. Nothing for
   * text a macro produced, or when `k` is in another file than `open`.
   */
  insertBefore(open: Token, k: number, text: string, safe: boolean): FixSpec | undefined {
    const stop = this.toks[k];
    if (open.depth > 0 || (stop && (stop.src !== open.src || stop.depth > 0))) return undefined;
    const src = open.src.text;
    let at = stop ? stop.start : src.length;
    while (at > open.end && /\s/.test(src[at - 1])) at--;
    if (at < open.end) return undefined;
    const edit = insertionEdit(src, at, text);
    if (!edit) return undefined;
    const p = this.posIn(open, edit.start);
    return { old: edit.old, new: edit.new, safe, line: p.line, col: p.col };
  }

  /**
   * Whether a missing } before token `k` has one sensible place: the group's text sits on one line and
   * is either a single word or the argument of a command whose argument is a line of its own.
   */
  private braceEndIsClear(open: Token, k: number, name?: string): boolean {
    const stop = this.toks[k];
    if (open.depth > 0 || (stop && stop.src !== open.src)) return false;
    const body = open.src.text.slice(open.end, stop ? stop.start : open.src.text.length).trim();
    if (!body || body.includes("\n")) return false;
    return !/\s/.test(body) || (!!name && ONE_LINE_ARGS.has(name));
  }

  /**
   * The fix for a { never closed, noticed at token `k`. The argument of a heading, \caption, \label
   * and the like ends with its line, so the } goes there (safe when that line's text is balanced);
   * otherwise it goes before `k`.
   */
  braceFix(open: Token, k: number, name?: string): FixSpec | undefined {
    if (name && ONE_LINE_ARGS.has(name) && open.depth === 0) {
      const src = open.src.text;
      let eol = src.indexOf("\n", open.end);
      if (eol < 0) eol = src.length;
      const stop = this.toks[k];
      let at = stop && stop.src === open.src ? Math.min(eol, stop.start) : eol;
      while (at > open.end && /\s/.test(src[at - 1])) at--;
      const body = src.slice(open.end, at);
      let depth = 0;
      for (const c of body) if ((depth += c === "{" ? 1 : c === "}" ? -1 : 0) < 0) break;
      const edit = body.trim() ? insertionEdit(src, at, "}") : undefined;
      if (edit) {
        const p = this.posIn(open, edit.start);
        return { old: edit.old, new: edit.new, safe: depth === 0 && !body.includes("%"), line: p.line, col: p.col };
      }
    }
    return this.insertBefore(open, k, "}", this.braceEndIsClear(open, k, name));
  }

  /** Whether an \end{name} comes anywhere after the current token. */
  private endsLater(name: string): boolean {
    for (let j = this.i + 1; j < this.toks.length; j++) if (isCmd(this.toks[j], "end") && this.envNameAt(j)?.name === name) return true;
    return false;
  }

  /**
   * Deleting a stray \end{name} (its whole line when it stands alone). Safe unless some \begin names a
   * near miss of it, when the \begin is more likely the typo.
   */
  private strayEndFix(tok: Token, env: { name: string; next: number }): FixSpec | undefined {
    const close = this.toks[env.next - 1];
    if (tok.depth > 0 || !close || close.src !== tok.src) return undefined;
    const src = tok.src.text;
    let start = tok.start;
    let end = close.end;
    const lineStart = src.lastIndexOf("\n", start - 1) + 1;
    const nl = src.indexOf("\n", end);
    const lineEnd = nl < 0 ? src.length : nl;
    if (!src.slice(lineStart, start).trim() && !src.slice(end, lineEnd).trim() && nl >= 0) {
      start = lineStart;
      end = nl + 1;
    }
    let near = false;
    for (const m of src.matchAll(/\\begin\s*\{([^{}]*)\}/g)) {
      const d = editDistance(m[1]!.trim(), env.name, 2);
      if (d > 0 && d <= 2) near = true;
    }
    const p = this.posIn(tok, start);
    return { old: src.slice(start, end), new: "", safe: !near, line: p.line, col: p.col };
  }

  /** The token index of `tok`, searching back from the current position. */
  private indexOf(tok: Token): number {
    for (let k = Math.min(this.i, this.toks.length - 1); k >= 0; k--) if (this.toks[k] === tok) return k;
    return -1;
  }

  /** Where an environment begun at `open` most likely ends when it is never closed: before the next sectioning command, else before token `k`. */
  private envEnd(open: Token, k: number): number {
    const from = this.indexOf(open);
    if (from < 0) return k;
    for (let j = from + 1; j < k && j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.type === "cmd" && Object.hasOwn(LEVEL, t.value) && t.src === open.src && t.depth === 0) return j;
    }
    return k;
  }

  /** Report once per name and file. */
  warnOnce(code: Code, tok: Token, message: string, hint?: string, name = tok.value, fix?: { old: string; new: string; safe: boolean }): void {
    const key = `${code}\u0000${tok.src.frame.ctx.file ?? ""}\u0000${name}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.diag(code, message, tok, hint, fix);
  }

  reporter(frame: Frame): Report {
    return (code, message, line, col) => this.ctx.diagnostics.add(code, message, shiftPos(frame.ctx, line, col));
  }

  /** Source text of tokens [from, to), exactly as written when they come from one source. */
  raw(from: number, to: number): string {
    if (from >= to) return "";
    const a = this.toks[from];
    const b = this.toks[to - 1];
    let same = true;
    for (let k = from + 1; k < to && same; k++) same = this.toks[k].src === a.src;
    if (same) return a.src.text.slice(a.start, b.end);
    return this.toks
      .slice(from, to)
      .map((t) => t.src.text.slice(t.start, t.end))
      .join("");
  }

  skipSpace(): void {
    while (this.toks[this.i]?.type === "space") this.i++;
  }

  skipWhite(): void {
    for (let t = this.toks[this.i]; t && (t.type === "space" || t.type === "par"); t = this.toks[++this.i]);
  }

  consumeStar(): boolean {
    if (!isChar(this.toks[this.i], "*")) return false;
    this.i++;
    return true;
  }

  nextPar(from: number): number {
    let j = from;
    while (j < this.toks.length && this.toks[j].type !== "par") j++;
    return j;
  }

  /**
   * Tokens from which a search of the rest of the token list is known to come
   * up empty, by kind of search. Without them every unclosed "{", "[", "$$"
   * or \begin rescans the rest of the document. They stay true because
   * parsing only moves forward and the token list only changes at the
   * current position (macro expansion, \input, splitting a text token), so
   * the tokens after one that is still ahead of the parser never change.
   */
  private readonly misses = new Map<string, WeakSet<Token>>();

  missed(kind: string): WeakSet<Token> {
    let set = this.misses.get(kind);
    if (!set) this.misses.set(kind, (set = new WeakSet()));
    return set;
  }

  /** Index of the first token from `from` matching `found`, or -1. Misses are remembered under `kind`. */
  findToken(kind: string, from: number, found: (k: number) => boolean): number {
    const missed = this.missed(kind);
    const seen: Token[] = [];
    for (let j = from; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (missed.has(t)) break;
      if (found(j)) return j;
      seen.push(t);
    }
    for (const t of seen) missed.add(t);
    return -1;
  }

  /** Index of the "}" matching the "{" at k, or -1. */
  groupEnd(k: number): number {
    if (this.toks[k]?.type !== "open") {
      let depth = 0;
      for (let j = k; j < this.toks.length; j++) {
        const t = this.toks[j];
        if (t.type === "open") depth++;
        else if (t.type === "close" && --depth === 0) return j;
      }
      return -1;
    }
    // An open brace known to stay open keeps every brace before it open too.
    const unclosed = this.missed("group");
    const opens: Token[] = [];
    for (let j = k; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.type === "open") {
        if (unclosed.has(t)) break;
        opens.push(t);
      } else if (t.type === "close") {
        opens.pop();
        if (!opens.length) return j;
      }
    }
    for (const t of opens) unclosed.add(t);
    return -1;
  }

  /** Index of the "]" closing the "[" at k (braces protect; a blank line gives up), or -1. */
  bracketEnd(k: number): number {
    // Tokens met outside braces in a search that gave up give up when a search starts there.
    const missed = this.missed("bracket");
    const seen: Token[] = [];
    let depth = 0;
    let end = -1;
    for (let j = k + 1; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (depth === 0) {
        if (missed.has(t)) break;
        seen.push(t);
      }
      if (t.type === "open") depth++;
      else if (t.type === "close") {
        if (depth === 0) break;
        depth--;
      } else if (t.type === "par") break;
      else if (depth === 0 && isChar(t, "]")) {
        end = j;
        break;
      }
    }
    if (end < 0) for (const t of seen) missed.add(t);
    return end;
  }

  /** The {name} after the \begin or \end at k, and the index after it. */
  envNameAt(k: number): { name: string; next: number } | undefined {
    if (this.toks[k + 1]?.type !== "open") return undefined;
    for (let j = k + 2; j < this.toks.length && j < k + 12; j++) {
      const t = this.toks[j];
      if (t.type === "close") return { name: this.raw(k + 2, j).trim(), next: j + 1 };
      if (t.type !== "text" && t.type !== "char" && t.type !== "space") return undefined;
    }
    return undefined;
  }

  /** Split a text token so that its first character stands alone (an undelimited argument). */
  splitFirst(k: number): void {
    this.splitAt(k, String.fromCodePoint(this.toks[k].value.codePointAt(0)!).length);
  }

  /** Split the text token at k after `n` UTF-16 units. */
  splitAt(k: number, n: number): void {
    const t = this.toks[k];
    if (n <= 0 || n >= t.value.length) return;
    const head: Token = { ...t, value: t.value.slice(0, n), end: t.start + n };
    const rest: Token = { ...t, value: t.value.slice(n), start: t.start + n, col: t.depth > 0 ? t.col : t.col + n };
    this.toks.splice(k, 1, head, rest);
  }

  private missing(t: Token | undefined): boolean {
    return !t || t.type === "close" || t.type === "par" || isCmd(t, "end");
  }

  private missingArg(cmd: Token): void {
    this.diag("LTX005", `Missing argument for \\${cmd.value}`, cmd, `Give the argument in braces: \\${cmd.value}{...}`);
  }

  /** A mandatory argument as raw source. */
  readArgRaw(cmd: Token): { text: string; tok: Token } | undefined {
    this.skipSpace();
    const t = this.toks[this.i];
    if (this.missing(t)) {
      this.missingArg(cmd);
      return undefined;
    }
    if (t.type === "open") {
      const e = this.groupEnd(this.i);
      if (e < 0) {
        const j = this.nextPar(this.i + 1);
        this.diag("LTX003", `Unclosed '{' in the argument of \\${cmd.value}`, t, "Add the matching '}'", this.braceFix(t, j, cmd.value));
        const text = this.raw(this.i + 1, j);
        this.i = j;
        return { text, tok: t };
      }
      const text = this.raw(this.i + 1, e);
      this.i = e + 1;
      return { text, tok: t };
    }
    if (t.type === "text") this.splitFirst(this.i);
    const u = this.toks[this.i++];
    return { text: u.type === "cmd" ? "\\" + u.value : u.type === "verb" ? u.value : u.src.text.slice(u.start, u.end), tok: u };
  }

  /** An optional [argument] as raw source; leaves the position alone when there is none. */
  readOptRaw(): { text: string; tok: Token } | undefined {
    const save = this.i;
    this.skipSpace();
    const t = this.toks[this.i];
    const e = isChar(t, "[") ? this.bracketEnd(this.i) : -1;
    if (e < 0) {
      this.i = save;
      return undefined;
    }
    const text = this.raw(this.i + 1, e);
    this.i = e + 1;
    return { text, tok: t };
  }

  /** A mandatory argument parsed as inline content. */
  parseArgInlines(cmd: Token): Inline[] {
    this.skipSpace();
    const t = this.toks[this.i];
    if (t?.type === "open") {
      this.i++;
      return this.finishInlines(this.parseScoped({ kind: "brace", tok: t, name: cmd.value, short: true }, true, false));
    }
    if (this.missing(t)) {
      this.missingArg(cmd);
      return [];
    }
    if (t.type === "text") this.splitFirst(this.i);
    const sink = new Sink(true);
    const saved = this.decls;
    this.decls = [];
    this.parseItem(sink);
    this.decls = saved;
    return this.finishInlines(sink);
  }

  /** An optional [argument] parsed as inline content, or undefined when absent. */
  parseOptInlines(): Inline[] | undefined {
    const save = this.i;
    this.skipSpace();
    const t = this.toks[this.i];
    if (!isChar(t, "[") || this.bracketEnd(this.i) < 0) {
      this.i = save;
      return undefined;
    }
    this.i++;
    return this.finishInlines(this.parseScoped({ kind: "bracket", tok: t, short: true }, true, false));
  }

  /** A mandatory argument parsed as blocks (footnotes, \thanks). Labels inside do not escape. */
  parseArgBlocks(cmd: Token): Block[] {
    this.skipSpace();
    const t = this.toks[this.i];
    if (t?.type !== "open") {
      const content = trimInlines(this.parseArgInlines(cmd));
      return content.length ? [{ t: "Para", content }] : [];
    }
    this.i++;
    this.targets.push(null);
    const blocks = this.finishBlocks(this.parseScoped({ kind: "brace", tok: t, name: cmd.value }, false, false));
    this.targets.pop();
    return blocks;
  }

  /** Parse a string (an option value, a keyword) as inline content reported at `at`. */
  parseString(text: string, at: Token): Inline[] {
    const frame = at.src.frame;
    const toks = lex(text, frame, this.reporter(frame), { line: at.line, col: at.col, depth: at.depth });
    const saved = { toks: this.toks, i: this.i, open: this.open, decls: this.decls };
    this.toks = toks;
    this.i = 0;
    this.open = [];
    this.decls = [];
    const sink = new Sink(true);
    this.parseInto(sink);
    this.toks = saved.toks;
    this.i = saved.i;
    this.open = saved.open;
    this.decls = saved.decls;
    return this.finishInlines(sink);
  }

  // ------------------------------------------------------------ macros and includes

  /** Count an expansion; false (with one LTX005) when recursion runs away. */
  budget(call: Token, name: string): boolean {
    if (call.depth < MAX_DEPTH && ++this.expansions <= MAX_EXPANSIONS) return true;
    this.warnOnce("LTX005", call, `\\${name} expands too deeply; is it defined in terms of itself?`, "Check its \\newcommand or \\def for recursion", `${name}\u0000depth`);
    return false;
  }

  /** Replace tokens [start, this.i) with the tokens of `text`, positioned at `call`. */
  splice(start: number, text: string, call: Token): void {
    const frame = call.src.frame;
    const toks = lex(text, frame, this.reporter(frame), { line: call.line, col: call.col, depth: call.depth + 1 });
    this.replace(start, toks);
  }

  private replace(start: number, toks: Token[]): void {
    if (toks.length < 10000) this.toks.splice(start, this.i - start, ...toks);
    else this.toks = this.toks.slice(0, start).concat(toks, this.toks.slice(this.i));
    this.i = start;
  }

  /**
   * Count `size` more characters of expansion text for the document. When
   * that passes MAX_EXPANDED_CHARS, report it once, drop the call at
   * [start, this.i) and return false.
   */
  private roomFor(size: number, start: number, call: Token): boolean {
    let used = expandedChars.get(this.ctx.diagnostics);
    if (!used) expandedChars.set(this.ctx.diagnostics, (used = { chars: 0 }));
    used.chars += size;
    if (used.chars <= MAX_EXPANDED_CHARS) return true;
    const message = "Macro expansion produced more than 4,000,000 characters; this and later expansions were left out";
    this.warnOnce("LTX005", call, message, "Look for macros that repeat their arguments or call each other in long chains", "\u0000expansion size");
    this.replace(start, []);
    return false;
  }

  expandMacro(): void {
    const start = this.i;
    const call = this.toks[this.i++];
    const def = this.macros.get(call.value)!;
    if (!this.budget(call, call.value)) return;
    const args: string[] = [];
    if (def.dflt !== undefined) args.push(this.readOptRaw()?.text ?? def.dflt);
    while (args.length < def.nargs) args.push(this.readArgRaw(call)?.text ?? "");
    if (this.roomFor(substituteSize(def.body, args), start, call)) this.splice(start, substitute(def.body, args), call);
  }

  expandBeginEnv(name: string, start: number, call: Token): void {
    const def = this.envs.get(name)!;
    if (!this.budget(call, name)) return;
    const args: string[] = [];
    if (def.dflt !== undefined) args.push(this.readOptRaw()?.text ?? def.dflt);
    while (args.length < def.nargs) args.push(this.readArgRaw(call)?.text ?? "");
    if (this.roomFor(substituteSize(def.begin, args), start, call)) this.splice(start, substitute(def.begin, args), call);
  }

  expandEndEnv(name: string, next: number): void {
    const start = this.i;
    const call = this.toks[start];
    this.i = next;
    const end = this.envs.get(name)!.end;
    if (this.budget(call, name) && this.roomFor(end.length, start, call)) this.splice(start, end, call);
  }

  /** Record a definition; MATH002 when it replaces one made earlier. */
  defineMacro(name: string, def: MacroDef, mode: "new" | "renew" | "provide", tok: Token): void {
    const key = name.replace(/^\\/, "");
    if (this.macros.has(key) && mode !== "renew") {
      if (mode === "provide") return;
      this.diag("MATH002", `\\${key} is redefined`, tok, "Give one of the definitions another name; the last one wins");
    }
    this.macros.set(key, def);
    if (key.includes("@")) return;
    // Macro table entries have no optional argument: bake the default in and shift #2.. down to #1..
    const body = def.dflt === undefined ? def.body : def.body.replace(/#1/g, def.dflt).replace(/#([2-9])/g, (_, d: string) => `#${Number(d) - 1}`);
    (this.meta.macros ??= {})["\\" + key] = body;
    if (this.ctx.macros) this.ctx.macros["\\" + key] = body;
  }

  /** \input or \include: splice the file's tokens in place of the command. */
  includeFile(cmd: Token, start: number): void {
    this.skipSpace();
    let path: string | undefined;
    if (this.toks[this.i]?.type === "open") path = this.readArgRaw(cmd)?.text;
    else {
      const from = this.i;
      while (this.toks[this.i]?.type === "text") this.i++;
      path = this.raw(from, this.i);
    }
    path = path?.trim();
    if (!path) {
      this.missingArg(cmd);
      return;
    }
    if (!/\.[A-Za-z0-9]+$/.test(path.split("/").pop()!)) path += ".tex";
    const key = normPath(path);
    const chain: string[] = [];
    let cycle = false;
    for (let f: Frame | undefined = cmd.src.frame; f; f = f.parent) {
      chain.unshift(f.key || "(input)");
      if (f.key === key) cycle = true;
    }
    if (cycle) {
      this.diag("IO003", `Include cycle: ${[...chain, key].join(" -> ")}`, cmd, `Remove the \\${cmd.value} that brings ${key} back in`);
      return;
    }
    const text = this.ctx.readFile(path);
    if (text === undefined) {
      this.diag("IO002", `Included file not found: ${path}`, cmd, `\\${cmd.value} paths are resolved relative to ${this.ctx.baseDir}`);
      return;
    }
    const file = displayPath(this.ctx.file, path);
    const frame: Frame = { ctx: { ...this.ctx, file, lineOffset: 0, colOffset: 0 }, key, parent: cmd.src.frame };
    this.ctx.diagnostics.registerSource(file, text);
    this.replace(start, lex(text, frame, this.reporter(frame)));
  }

  // ------------------------------------------------------------ math

  parseDollar(sink: Sink): void {
    const t = this.toks[this.i];
    if (this.isDouble(this.i)) {
      const from = this.i + 2;
      let j = this.findToken("dollars", from, (k) => this.toks[k].type === "math" && this.isDouble(k));
      if (j >= 0) {
        this.i = j + 2;
      } else {
        this.diag("LTX003", "Unclosed '$$': display math has no closing '$$'", t, "Close it with '$$'");
        j = this.nextPar(from);
        this.i = j;
      }
      this.displayMath(sink, t, this.raw(from, j));
      return;
    }
    this.i++;
    this.inlineMath(sink, t, (u) => u.type === "math", "$");
  }

  private isDouble(k: number): boolean {
    const a = this.toks[k];
    const b = this.toks[k + 1];
    return a?.type === "math" && b?.type === "math" && a.src === b.src && a.end === b.start;
  }

  /** Inline math from the current position to the first token matching `isEnd` in this paragraph. */
  inlineMath(sink: Sink, open: Token, isEnd: (t: Token) => boolean, closer: string): void {
    const from = this.i;
    let j = from;
    while (j < this.toks.length && !isEnd(this.toks[j]) && this.toks[j].type !== "par") j++;
    const closed = j < this.toks.length && isEnd(this.toks[j]);
    if (!closed) this.diag("LTX003", `Unclosed math: no '${closer}' before the end of the paragraph`, open, `Close the math with '${closer}'`, this.insertBefore(open, j, closer, false));
    this.emit(sink, { t: "Math", tex: trimMath(this.raw(from, j)), pos: this.pos(open) });
    this.i = closed ? j + 1 : j;
  }

  /** \[ ... \] */
  bracketMath(sink: Sink, open: Token): void {
    const from = this.i;
    let j = this.findToken("display", from, (k) => isCmd(this.toks[k], "]"));
    if (j >= 0) this.i = j + 1;
    else {
      this.diag("LTX003", "Unclosed '\\[': display math has no closing '\\]'", open, "Close it with '\\]'");
      j = this.nextPar(from);
      this.i = j;
    }
    this.displayMath(sink, open, this.raw(from, j));
  }

  displayMath(sink: Sink, open: Token, source: string): void {
    const tex = trimMath(source);
    const label = firstLabel(tex);
    const node: Block = { t: "MathBlock", tex, numbered: label !== undefined, pos: this.pos(open) };
    if (label) {
      node.label = label;
      node.id = slugify(label);
    }
    this.block(sink, node);
  }

  // ------------------------------------------------------------ finishing

  finalize(blocks: Block[]): void {
    const chapters = this.sections.some((s) => s.cmd === "chapter" || s.cmd === "addchap");
    for (const s of this.sections) {
      let level = LEVEL[s.cmd];
      if (chapters && !["part", "chapter", "addchap"].includes(s.cmd)) level = Math.min(6, level + 1);
      s.node.level = level as Heading["level"];
      if (s.appendix && level === 1) s.node.attr = { ...s.node.attr, classes: [...(s.node.attr?.classes ?? []), "appendix"] };
    }
    const all = [...blocks, ...(this.meta.abstract ?? [])];
    const used = new Set<string>();
    walkBlocks(all, (b) => {
      if ("id" in b && b.id) used.add(b.id);
      if ("attr" in b && b.attr?.id) used.add(b.attr.id);
    });
    // Ids only get used, never freed, so each base resumes after the suffix it last took
    // (counting up from 1 for every heading is quadratic in headings with the same text).
    const next = new Map<string, number>();
    walkBlocks(all, (b) => {
      if (b.t !== "Heading" || b.id) return;
      const base = slugify(plainText(b.content));
      let id = base;
      if (used.has(id)) {
        let k = next.get(base) ?? 1;
        while (used.has(`${base}-${k}`)) k++;
        id = `${base}-${k}`;
        next.set(base, k + 1);
      }
      used.add(id);
      b.id = id;
    });
  }
}
