/** Environment handlers: lists, quotes, floats, theorems, math, verbatim, drawings and the fallback. */

import type { Block, Inline } from "../../ast.js";
import { slugify } from "../../ast.js";
import { closestFix } from "../../fixes.js";
import { ALG_LINES, CONDITIONALS, LETTER, Sink, docInfo, drawingError, isCmd, keyVals, type Open, type Target, type TheoremDef } from "./base.js";
import type { Token } from "./lexer.js";
import type { Parser } from "./parser.js";
import { resolveColor } from "./commands.js";
import { tabular } from "./tables.js";
import { TIKZ_ENVS, tikzFromLatex } from "../../tikz/latex.js";
import { pstricksFromLatex } from "../../pstricks/latex.js";
import { blocksToInlines, cssLength, firstLabel, normalizeInlines, plainString, today, trimInlines, trimMath } from "./text.js";

type Figure = Extract<Block, { t: "Figure" }>;
type CodeBlock = Extract<Block, { t: "CodeBlock" }>;
type ListBlock = Extract<Block, { t: "List" }>;
type EnvHandler = (p: Parser, sink: Sink, tok: Token, name: string, start: number) => void;

const ENVS = new Map<string, EnvHandler>();
/** Register a handler for each of the space-separated environment names. */
export function env(names: string, h: EnvHandler): void {
  for (const n of names.split(" ")) ENVS.set(n, h);
}

const MATH_ENVS = new Set(["equation", "align", "gather", "multline", "alignat", "flalign", "eqnarray", "math", "displaymath"]);
/** Display environments with rows (\\) or & columns. */
const ALIGNING = new Set(["align", "gather", "multline", "alignat", "flalign", "eqnarray", "aligned", "gathered", "split"]);
const DRAWINGS = new Set(["tikzpicture", "axis", "semilogxaxis", "semilogyaxis", "loglogaxis", "polaraxis", "pspicture", "circuitikz", "forest", "pgfpicture"]);
// The common names, and the ones classes such as llncs and amsart predefine.
const THEOREMS = new Set([
  "theorem", "lemma", "corollary", "proposition", "definition", "example", "remark", "conjecture", "claim", "problem", "exercise",
  "property", "question", "assumption", "hypothesis", "notation", "observation", "fact", "axiom", "criterion", "case", "note",
]);

/** \begin{name}: dispatch on the environment name. `start` is the index of the \begin token. */
export function beginEnv(p: Parser, sink: Sink, tok: Token, start: number): void {
  const found = p.envNameAt(start);
  if (!found?.name) {
    p.diag("LTX005", "\\begin needs an environment name in braces", tok, "Write \\begin{name}");
    return;
  }
  p.i = found.next;
  const name = found.name;
  const base = name.replace(/\*$/, "");
  if (p.envs.has(name)) p.expandBeginEnv(name, start, tok);
  else if (MATH_ENVS.has(base)) mathEnv(p, sink, tok, name);
  else if (ENVS.has(name)) ENVS.get(name)!(p, sink, tok, name, start);
  else if (p.theorems.has(name)) theoremEnv(p, sink, tok, name, p.theorems.get(name)!, name);
  else if (THEOREMS.has(base)) {
    const display = base[0].toUpperCase() + base.slice(1);
    theoremEnv(p, sink, tok, name, name === base ? { name: display, counter: base, numbered: true } : { name: display, numbered: false }, base);
  } else if (DRAWINGS.has(base)) {
    const end = rawEnvEnd(p, tok, name);
    // TikZ and pgfplots are drawn by src/tikz; LTX004 remains for what it cannot draw at all.
    const img = TIKZ_ENVS.has(base) ? tikzFromLatex(p, tok, p.raw(start, end)) : base === "pspicture" ? pstricksFromLatex(p, tok, p.raw(start, end)) : undefined;
    if (img) {
      p.emit(sink, img);
      p.i = end;
      return;
    }
    drawingError(p, tok, `\\begin{${name}}`);
    p.block(sink, { t: "RawBlock", format: "latex", text: p.raw(start, end), pos: p.pos(tok) });
    p.i = end;
  } else {
    // A near miss of a known environment ("alignn") is a typo, not a custom environment: an error
    // with the fix, at \begin and again at \end so that check --fix repairs both.
    const known = [...MATH_ENVS, ...ENVS.keys(), ...THEOREMS, ...DRAWINGS, ...p.theorems.keys(), ...p.envs.keys()];
    const near = !p.preamble ? closestFix(base, known, 2) : undefined;
    const typo = near?.safe ? near.replacement + (name.endsWith("*") ? "*" : "") : undefined;
    if (typo) {
      p.ctx.diagnostics.add("LTX002", `Unknown environment ${name}: did you mean ${typo}?`, p.pos(tok), {
        severity: "error",
        hint: `\\begin{${name}} looks like a typo for \\begin{${typo}}`,
        fix: { old: name, new: typo, safe: true },
      });
    } else if (!p.preamble) {
      p.warnOnce("LTX002", tok, `Unsupported environment ${name}; its body was kept`, `Use a supported environment, or remove \\begin{${name}} and \\end{${name}}`, name);
    }
    p.block(sink, { t: "Div", attr: { classes: [name] }, blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
    if (typo) {
      // The \end that closed it, just behind the parser now.
      for (let k = p.i - 1; k >= Math.max(0, p.i - 6); k--) {
        const t = p.toks[k];
        if (t?.type === "cmd" && t.value === "end") {
          p.ctx.diagnostics.add("LTX002", `Unknown environment ${name}: did you mean ${typo}?`, p.pos(t), { severity: "error", fix: { old: name, new: typo, safe: true } });
          break;
        }
      }
    }
  }
}

export function envBlocks(p: Parser, tok: Token, name: string): Block[] {
  return p.finishBlocks(p.parseScoped({ kind: "env", name, tok }, false, true));
}

/** Index after the \end{name} matching the current position (nesting counted), or the next blank line. */
function rawEnvEnd(p: Parser, tok: Token, name: string): number {
  // `missed` holds tokens from which a search (starting at depth 0) finds no closing \end{name}. A search
  // that reaches one fails too, at whatever depth: it would need even more \end{name} after it.
  const missed = p.missed(`raw env ${name}`);
  const seen: Token[] = [];
  const depths: number[] = [];
  const isEnd: boolean[] = [];
  let depth = 0;
  // Least depth of an \end{name} after the tokens seen, once the search stops.
  let least = Infinity;
  for (let j = p.i; j < p.toks.length; j++) {
    const t = p.toks[j];
    if (missed.has(t)) {
      least = depth + 1;
      break;
    }
    const match = (isCmd(t, "begin") || isCmd(t, "end")) && p.envNameAt(j)?.name === name;
    seen.push(t);
    depths.push(depth);
    isEnd.push(match && t.value === "end");
    if (match) {
      if (t.value === "begin") depth++;
      else if (depth-- === 0) return p.envNameAt(j)!.next;
    }
  }
  // A search starting at a seen token fails when every \end{name} after it is deeper than where it starts.
  for (let k = seen.length - 1; k >= 0; k--) {
    if (isEnd[k]) least = Math.min(least, depths[k]);
    if (least > depths[k]) missed.add(seen[k]);
  }
  p.diag("LTX003", `\\begin{${name}} is never closed`, tok, `Add \\end{${name}}`);
  return p.nextPar(p.i);
}

// ------------------------------------------------------------ math

function mathEnv(p: Parser, sink: Sink, tok: Token, given: string): void {
  let name = given;
  // alignat's {n} column count stays at the start of tex: the math engine needs it, and the numbering step skips it.
  const from = p.i;
  let j = p.findToken(`end ${name}`, from, (k) => isCmd(p.toks[k], "end") && p.envNameAt(k)?.name === name);
  // Math environments do not nest: a \begin{name} before the \end{name} found means this one was
  // never closed (or closed by the wrong name), and that \end belongs to the next one.
  for (let k = from; k < j; k++) {
    if (isCmd(p.toks[k], "begin") && p.envNameAt(k)?.name === name) {
      j = -1;
      break;
    }
  }
  let next = j < 0 ? -1 : p.envNameAt(j)!.next;
  if (next < 0) {
    // Math cannot run past a blank line: the body ends there, or at an \end that names another environment.
    const par = p.nextPar(from);
    let k = from;
    while (k < par && !isCmd(p.toks[k], "end")) k++;
    const other = k < par ? p.envNameAt(k) : undefined;
    if (other && !p.open.some((o) => o.kind === "env" && o.name === other.name)) {
      // \begin{equation} ... \end{align}: one of the two names is wrong. Rows and & columns say it is the \begin.
      const body = p.raw(from, k);
      const fixBegin = !ALIGNING.has(name.replace(/\*$/, "")) && ALIGNING.has(other.name.replace(/\*$/, "")) && /&|\\\\/.test(body);
      const endText = p.raw(k, other.next);
      const beginText = `\\begin{${name}}`;
      const fix = fixBegin
        ? tok.depth === 0 && tok.src.text.startsWith(beginText, tok.start)
          ? { old: beginText, new: `\\begin{${other.name}}`, safe: true }
          : undefined
        : endText.startsWith("\\end") && p.toks[k].depth === 0
          ? { old: endText, new: `\\end{${name}}`, safe: true }
          : undefined;
      p.diag("LTX003", `\\begin{${name}} ended by \\end{${other.name}}`, fixBegin ? tok : p.toks[k], fixBegin ? `Begin it with \\begin{${other.name}}` : `Close it with \\end{${name}}`, fix);
      if (fixBegin && MATH_ENVS.has(other.name.replace(/\*$/, ""))) name = other.name;
      j = k;
      next = other.next;
    } else {
      p.diag("LTX003", `\\begin{${name}} is never closed`, tok, `Add \\end{${name}}`, p.insertBefore(tok, k, `\n\\end{${name}}`, true));
      j = k;
      next = k;
    }
  }
  const source = p.raw(from, j);
  p.i = next;
  if (name === "math") {
    p.emit(sink, { t: "Math", tex: trimMath(source), pos: p.pos(tok) });
    return;
  }
  if (name === "displaymath") {
    p.displayMath(sink, tok, source);
    return;
  }
  const tex = trimMath(source);
  const label = firstLabel(tex);
  const node: Block = { t: "MathBlock", tex, env: name, numbered: !name.endsWith("*"), pos: p.pos(tok) };
  if (label) {
    node.label = label;
    node.id = slugify(label);
  }
  p.block(sink, node);
}

// ------------------------------------------------------------ verbatim and listings

export function verbatimBlock(p: Parser, sink: Sink, tok: Token): void {
  const args = tok.args ?? "";
  switch (tok.env) {
    case "comment":
      return;
    case "lstlisting":
      p.block(sink, codeBlock(p, tok, tok.value, keyVals(args)));
      return;
    case "minted": {
      const lang = /\{([^{}]*)\}\s*$/.exec(args);
      const kv = keyVals(args.replace(/\{[^{}]*\}\s*$/, ""));
      if (lang) kv.set("language", lang[1]);
      p.block(sink, codeBlock(p, tok, tok.value, kv));
      return;
    }
    default:
      p.block(sink, { t: "CodeBlock", text: tok.value, pos: p.pos(tok) });
  }
}

/** A listing: language, caption and label come from key=value options. */
export function codeBlock(p: Parser, tok: Token, text: string, kv: Map<string, string>): CodeBlock {
  const node: CodeBlock = { t: "CodeBlock", text, pos: p.pos(tok) };
  const lang = kv.get("language")?.replace(/^\[[^\]]*\]/, "").trim().toLowerCase();
  if (lang) node.lang = lang;
  const caption = kv.get("caption") ?? kv.get("title");
  const label = kv.get("label")?.trim();
  if (caption || label) {
    node.attr = {};
    if (label) node.attr.id = label;
    if (caption) node.attr.attrs = { caption: plainString(p.parseString(caption, tok)) };
  }
  return node;
}

// ------------------------------------------------------------ pass-through environments

/** Environments whose body simply continues the surrounding text; values are argument signatures. */
const PASS_ENVS: Record<string, string> = {
  document: "",
  titlepage: "",
  landscape: "",
  samepage: "",
  sloppypar: "",
  multicols: "m",
  "multicols*": "m",
  spacing: "m",
  singlespace: "",
  onehalfspace: "",
  doublespace: "",
  otherlanguage: "m",
  "otherlanguage*": "m",
  adjustbox: "m",
  appendices: "",
  // threeparttable, changepage, KOMA-Script, beamer columns, elsarticle, lineno, biblatex: layout only
  threeparttable: "o",
  threeparttablex: "o",
  measuredfigure: "",
  adjustwidth: "mm",
  "adjustwidth*": "mm",
  addmargin: "om",
  "addmargin*": "om",
  columns: "o",
  column: "om",
  frontmatter: "",
  linenomath: "",
  "linenomath*": "",
  refsection: "o",
  refsegment: "",
  fullwidth: "",
  justify: "",
  raggedright: "",
  RaggedRight: "",
  tiny: "",
  scriptsize: "",
  footnotesize: "",
  small: "",
  normalsize: "",
  large: "",
  Large: "",
  LARGE: "",
  huge: "",
  Huge: "",
};
env(Object.keys(PASS_ENVS).join(" "), (p, sink, tok, name) => {
  for (const c of PASS_ENVS[name]) {
    if (c === "m") p.readArgRaw(tok);
    else p.readOptRaw();
  }
  if (name === "appendices") p.appendix = true;
  const o: Open = { kind: "env", name, tok };
  const saved = p.decls.slice();
  p.open.push(o);
  p.parseInto(sink);
  p.closeOpen(o);
  p.decls = saved;
});

/** The letter class: the sender's address and the date at the top right, then the recipient, then the body. */
env("letter", (p, sink, tok, name) => {
  const to = trimInlines(p.parseArgInlines(tok));
  const from: Block[] = [];
  const address = LETTER.get(p)?.address;
  if (address?.length) from.push({ t: "Plain", content: address });
  from.push({ t: "Plain", content: [] }, { t: "Plain", content: p.meta.date ?? [{ t: "Text", text: today() }] });
  delete p.meta.date;
  const pos = p.pos(tok);
  const blocks: Block[] = [{ t: "Div", attr: { classes: ["letter-from"] }, blocks: from, pos }];
  if (to.length) blocks.push({ t: "Div", attr: { classes: ["letter-to"] }, blocks: [{ t: "Plain", content: to }], pos });
  blocks.push(...envBlocks(p, tok, name));
  p.block(sink, { t: "Div", attr: { classes: ["letter"] }, blocks, pos });
});

/** The exam class's lists: questions, parts and choices, with points after the label. */
const EXAM_LISTS: Record<string, { items: string[]; style?: "lower-alpha" | "upper-alpha" | "lower-roman"; delim?: "." | "()" ; ordered: boolean }> = {
  questions: { items: ["question", "titledquestion", "bonusquestion", "bonustitledquestion"], ordered: true },
  parts: { items: ["part", "bonuspart"], style: "lower-alpha", delim: "()", ordered: true },
  subparts: { items: ["subpart", "bonussubpart"], style: "lower-roman", delim: "()", ordered: true },
  subsubparts: { items: ["subsubpart", "bonussubsubpart"], style: "lower-alpha", delim: ".", ordered: true },
  choices: { items: ["choice", "CorrectChoice"], style: "upper-alpha", delim: ".", ordered: true },
  oneparchoices: { items: ["choice", "CorrectChoice"], style: "upper-alpha", delim: ".", ordered: true },
  checkboxes: { items: ["choice", "CorrectChoice"], ordered: false },
  oneparcheckboxes: { items: ["choice", "CorrectChoice"], ordered: false },
};

env(Object.keys(EXAM_LISTS).join(" "), (p, sink, tok, name) => {
  const spec = EXAM_LISTS[name]!;
  const answers = CONDITIONALS.get(p)?.get("ifprintanswers") === true;
  const o: Open = { kind: "env", name, tok };
  p.open.push(o);
  const items: Block[][] = [];
  for (;;) {
    p.skipWhite();
    const t = p.toks[p.i];
    if (t?.type === "cmd" && spec.items.includes(t.value)) {
      p.i++;
      const lead: Inline[] = [];
      if (t.value === "titledquestion" || t.value === "bonustitledquestion") lead.push({ t: "Strong", content: trimInlines(p.parseArgInlines(t)) }, { t: "Text", text: " " });
      const pts = p.readOptRaw()?.text.trim();
      const bonus = t.value.startsWith("bonus") ? "bonus " : "";
      if (pts) lead.push({ t: "Text", text: `(${pts} ${bonus}${pts === "1" ? "point" : "points"}) ` });
      const blocks = p.finishBlocks(p.parseScoped({ kind: "item", tok: t, name: "exam" }, false, true));
      const correct = t.value === "CorrectChoice" && answers;
      const first = blocks[0];
      if (first && (first.t === "Para" || first.t === "Plain")) {
        const content = normalizeInlines([...lead, ...first.content]);
        blocks[0] = { ...first, content: correct ? [{ t: "Strong", content }] : content };
      } else if (lead.length) blocks.unshift({ t: "Plain", content: lead });
      items.push(blocks);
      continue;
    }
    if (p.checkStop()) break;
    // Text before the first item joins the list's preamble: kept as its own paragraph.
    const at = p.i;
    const stray = p.finishBlocks(p.parseScoped({ kind: "item", tok: t!, name: "exam" }, false, true));
    if (p.i === at) p.i++;
    if (stray.length) {
      if (items.length) items[items.length - 1]!.push(...stray);
      else for (const b of stray) p.block(sink, b);
    }
  }
  p.closeOpen(o);
  const list: Extract<Block, { t: "List" }> = { t: "List", ordered: spec.ordered, tight: false, items, pos: p.pos(tok) };
  if (spec.style) list.style = spec.style;
  if (spec.delim && spec.delim !== ".") list.delim = spec.delim;
  p.block(sink, list);
});

/** The exam class's solutions: shown after "Solution." when \printanswers is on, left out otherwise. */
env("solution solutionorbox solutionorlines solutionordottedlines solutionorgrid TheSolution", (p, sink, tok, name) => {
  p.readOptRaw();
  const blocks = envBlocks(p, tok, name);
  if (CONDITIONALS.get(p)?.get("ifprintanswers") !== true) return;
  const head: Inline[] = [{ t: "Strong", content: [{ t: "Text", text: "Solution." }] }, { t: "Text", text: " " }];
  const first = blocks[0];
  if (first && (first.t === "Para" || first.t === "Plain")) blocks[0] = { ...first, content: normalizeInlines([...head, ...first.content]) };
  else blocks.unshift({ t: "Para", content: head });
  p.block(sink, { t: "Div", attr: { classes: ["solution"] }, blocks, pos: p.pos(tok) });
});

/** A tikz-cd diagram outside math: displayed, as the math engine draws it. */
env("tikzcd", (p, sink, tok, name, start) => {
  const end = rawEnvEnd(p, tok, name);
  p.block(sink, { t: "MathBlock", tex: p.raw(start, end), numbered: false, pos: p.pos(tok) });
  p.i = end;
});

/** \begin{tcolorbox}[title=..., colback=..., colframe=...]: a framed box, drawn as a callout with those colours. */
env("tcolorbox", (p, sink, tok, name) => {
  const opts = keyVals(p.readOptRaw()?.text ?? "");
  const blocks = envBlocks(p, tok, name);
  const attrs: Record<string, string> = {};
  const title = opts.get("title");
  attrs.title = title ? plainString(p.parseString(title.replace(/^\{([\s\S]*)\}$/, "$1"), tok)) : "";
  const back = opts.get("colback");
  const frame = opts.get("colframe");
  const bg = back ? resolveColor(p, back) : undefined;
  const fg = frame ? resolveColor(p, frame) : undefined;
  if (bg) attrs.background = bg;
  if (fg) attrs.frame = fg;
  p.block(sink, { t: "Div", attr: { classes: ["box"], attrs }, blocks, pos: p.pos(tok) });
});

env("abstract", (p, _sink, tok, name) => {
  p.meta.abstract = [...(p.meta.abstract ?? []), ...envBlocks(p, tok, name)];
});

env("quote quotation verse", (p, sink, tok, name) => {
  p.block(sink, { t: "BlockQuote", blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});

env("center flushleft flushright", (p, sink, tok, name) => {
  p.block(sink, { t: "Div", attr: { classes: [name] }, blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});

env("minipage", (p, sink, tok, name) => {
  p.readOptRaw();
  p.readOptRaw();
  p.readOptRaw();
  const width = p.readArgRaw(tok);
  const attr = width ? { classes: ["minipage"], attrs: { width: cssLength(width.text) } } : { classes: ["minipage"] };
  p.block(sink, { t: "Div", attr, blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});

/** \begin{thebibliography}{99} \bibitem{key} text ... : a hand-written reference list, numbered in order. */
env("thebibliography", (p, sink, tok, name) => {
  p.readArgRaw(tok);
  const o: Open = { kind: "env", name, tok };
  p.open.push(o);
  const items: { key: string; content: Inline[] }[] = [];
  for (;;) {
    p.skipWhite();
    const t = p.toks[p.i];
    if (isCmd(t, "bibitem")) {
      p.i++;
      p.readOptRaw();
      const key = p.readArgRaw(t)?.text.trim();
      const content = trimInlines(blocksToInlines(itemBlocks(p, t)));
      if (key) items.push({ key, content });
      continue;
    }
    if (p.checkStop()) break;
    // Text before the first \bibitem is dropped, as LaTeX's list would set it before any label.
    itemBlocks(p, p.toks[p.i]);
  }
  p.closeOpen(o);
  p.block(sink, { t: "Bibliography", items, pos: p.pos(tok) });
});

env("tabular tabular* tabularx tabulary longtable", (p, sink, tok, name) => tabular(p, sink, tok, name));

// ------------------------------------------------------------ lists

function enumStyle(raw: string): Pick<ListBlock, "style" | "start" | "delim"> {
  const out: Pick<ListBlock, "style" | "start" | "delim"> = {};
  // The label's punctuation: label=(\alph*) or [(a)] is "(a)", label=\roman*) is "i)".
  const label = /label\s*=\s*([^,]*)/.exec(raw)?.[1] ?? (raw.includes("=") ? "" : raw);
  if (/^\s*\(.*\)\s*$/.test(label)) out.delim = "()";
  else if (/\)\s*$/.test(label)) out.delim = ")";
  if (/\\alph\b/.test(raw)) out.style = "lower-alpha";
  else if (/\\Alph\b/.test(raw)) out.style = "upper-alpha";
  else if (/\\roman\b/.test(raw)) out.style = "lower-roman";
  else if (/\\Roman\b/.test(raw)) out.style = "upper-roman";
  else if (/\\arabic\b/.test(raw)) out.style = "decimal";
  else if (!raw.includes("=")) {
    // enumerate-package style: [(a)], [i.], [A]
    const m = /[aAiI1]/.exec(raw);
    if (m) out.style = ({ a: "lower-alpha", A: "upper-alpha", i: "lower-roman", I: "upper-roman", "1": "decimal" } as const)[m[0] as "a"];
  }
  const start = /\bstart\s*=\s*(\d+)/.exec(raw);
  if (start) out.start = Number(start[1]);
  return out;
}

export function itemBlocks(p: Parser, tok: Token): Block[] {
  p.targets.push(null);
  const blocks = p.finishBlocks(p.parseScoped({ kind: "item", tok }, false, true));
  p.targets.pop();
  return blocks;
}

function toPlain(b: Block): Block {
  if (b.t !== "Para") return b;
  return b.pos ? { t: "Plain", content: b.content, pos: b.pos } : { t: "Plain", content: b.content };
}

/** An itemize/enumerate \item[label]: the label starts the item's text. */
function withLabel(label: Inline[], blocks: Block[]): Block[] {
  const first = blocks[0];
  if (first && (first.t === "Para" || first.t === "Plain")) {
    return [{ ...first, content: normalizeInlines([...label, { t: "Text", text: " " }, ...first.content]) }, ...blocks.slice(1)];
  }
  return [{ t: "Plain", content: label }, ...blocks];
}

/** Where the last enumerate stopped, for enumitem's [resume]. */
const LAST_ENUM = new WeakMap<object, number>();

env("itemize enumerate description compactitem compactenum labeling", (p, sink, tok, name) => {
  const opts = p.readOptRaw();
  // KOMA-Script's labeling takes the widest label: a description list.
  if (name === "labeling") p.readArgRaw(tok);
  const o: Open = { kind: "env", name, tok };
  const saved = p.decls;
  p.decls = saved.slice();
  p.open.push(o);
  const items: { label?: Inline[]; blocks: Block[] }[] = [];
  for (;;) {
    p.skipWhite();
    const t = p.toks[p.i];
    if (isCmd(t, "item")) {
      p.i++;
      // beamer's overlay specification, \item<2->: left out.
      const next = p.toks[p.i];
      const spec = next?.type === "text" ? /^<[^<>\s]*>/.exec(next.value) : null;
      if (spec) {
        if (spec[0].length < next!.value.length) p.splitAt(p.i, spec[0].length);
        p.i++;
      }
      const label = p.parseOptInlines();
      const blocks = itemBlocks(p, t);
      items.push(label ? { label: trimInlines(label), blocks } : { blocks });
      continue;
    }
    if (p.checkStop()) break;
    // Text before the first \item.
    const blocks = itemBlocks(p, p.toks[p.i]);
    if (items.length) items[items.length - 1].blocks.push(...blocks);
    else items.push({ blocks });
  }
  p.closeOpen(o);
  p.decls = saved;

  const tight = items.every((it) => it.blocks.filter((b) => b.t === "Para").length <= 1);
  const fix = (bs: Block[]): Block[] => (tight ? bs.map(toPlain) : bs);
  const pos = p.pos(tok);
  if (name === "description" || name === "labeling") {
    p.block(sink, { t: "DefList", items: items.map((it) => ({ term: it.label ?? [], defs: [fix(it.blocks)] })), pos });
    return;
  }
  const ordered = name === "enumerate" || name === "compactenum";
  const list: ListBlock = { t: "List", ordered, tight, items: items.map((it) => fix(it.label ? withLabel(it.label, it.blocks) : it.blocks)), pos };
  if (ordered && opts) Object.assign(list, enumStyle(opts.text));
  if (ordered && opts && /(^|,)\s*resume\*?\s*(,|$)/.test(opts.text) && list.start === undefined) list.start = (LAST_ENUM.get(p) ?? 0) + 1;
  if (ordered) LAST_ENUM.set(p, (list.start ?? 1) + items.length - 1);
  p.block(sink, list);
});

// ------------------------------------------------------------ floats

export function makeFigure(p: Parser, content: Block[], target: Target, tok: Token): Figure {
  const fig: Figure = { t: "Figure", content, numbered: !!target.caption && !target.unnumbered, pos: p.pos(tok) };
  if (target.caption) fig.caption = target.caption;
  if (target.label) {
    fig.label = target.label;
    fig.id = slugify(target.label);
  }
  return fig;
}

const LAYOUT = new Set(["center", "flushleft", "flushright"]);

/** A paragraph of nothing but space and \hfill, as between subfigures: spacing, not content. */
function isSpacing(b: Block): boolean {
  return (b.t === "Para" || b.t === "Plain") && b.content.every((i) => (i.t === "Text" && !i.text.trim()) || (i.t === "Span" && !!i.attr.classes?.includes("hfill")));
}

/** Drop center/flushleft/flushright wrappers, which only position a float's content. */
function unwrapLayout(blocks: Block[]): Block[] {
  return blocks.flatMap((b) => (b.t === "Div" && !b.attr.id && b.attr.classes?.length === 1 && LAYOUT.has(b.attr.classes[0]) ? unwrapLayout(b.blocks) : [b]));
}

env("figure figure* wrapfigure sidewaysfigure subfigure", (p, sink, tok, name) => {
  let width: { text: string } | undefined;
  if (name === "wrapfigure") {
    p.readOptRaw();
    p.readArgRaw(tok);
    p.readOptRaw();
    width = p.readArgRaw(tok);
  } else if (name === "subfigure") {
    p.readOptRaw();
    width = p.readArgRaw(tok);
  } else p.readOptRaw();
  const target: Target = { kind: "figure" };
  p.targets.push(target);
  const blocks = envBlocks(p, tok, name);
  p.targets.pop();
  const fig = makeFigure(p, unwrapLayout(blocks).filter((b) => !isSpacing(b)).map(toPlain), target, tok);
  if (width) fig.attr = { attrs: { width: cssLength(width.text) } };
  p.block(sink, fig);
});

env("algorithm algorithm* procedure procedure* function function*", (p, sink, tok, name) => {
  p.readOptRaw();
  const target: Target = { kind: "figure" };
  p.targets.push(target);
  // algorithm2e writes its lines straight into the environment: count it open so \; ends a line.
  const alg = docInfo(p).alg;
  const level = alg.level;
  alg.open++;
  alg.level = 0;
  let blocks: Block[];
  try {
    blocks = groupAlgLines(envBlocks(p, tok, name), alg.numbered || docInfo(p).packageOptions.has("algorithm2e:linesnumbered"));
  } finally {
    alg.open--;
    alg.level = level;
  }
  p.targets.pop();
  const fig = makeFigure(p, unwrapLayout(blocks), target, tok);
  fig.attr = { classes: ["algorithm"] };
  p.block(sink, fig);
});

/**
 * algorithm2e's lines come out as alg-line Divs, as algorithmic's do; gather each
 * run of them (and stray paragraphs between them) into one algorithmic Div.
 */
function groupAlgLines(blocks: Block[], numbered: boolean): Block[] {
  if (!blocks.some(isAlgLine)) return blocks;
  const out: Block[] = [];
  let run: Block[] | undefined;
  for (const b of blocks) {
    const line = isAlgLine(b) ? b : (b.t === "Para" || b.t === "Plain") && run ? algLine(b.content, 0, true) : undefined;
    if (line) {
      if (!run) {
        run = [];
        out.push({ t: "Div", attr: { classes: ["algorithmic"], attrs: numbered ? { numbered: "1" } : {} }, blocks: run });
      }
      run.push(line);
    } else {
      run = undefined;
      out.push(b);
    }
  }
  return out;
}

function isAlgLine(b: Block): boolean {
  return b.t === "Div" && !!b.attr.classes?.includes("alg-line");
}

/** One line of pseudocode at a depth. */
export function algLine(content: Inline[], level: number, nonum = false): Block {
  return { t: "Div", attr: { classes: nonum ? ["alg-line", "alg-nonum"] : ["alg-line"], attrs: { level: String(level) } }, blocks: [{ t: "Plain", content }] };
}

/** What each pseudocode line command prints: [keyword before, argument count, keyword after, indent change before, after]. */
const ALG: Record<string, [string, number, string, number, number]> = {
  State: ["", 0, "", 0, 0],
  Statex: ["", 0, "", 0, 0],
  Require: ["Require:", 0, "", 0, 0],
  Ensure: ["Ensure:", 0, "", 0, 0],
  If: ["if", 1, "then", 0, 1],
  ElsIf: ["else if", 1, "then", -1, 1],
  Else: ["else", 0, "", -1, 1],
  EndIf: ["end if", 0, "", -1, 0],
  For: ["for", 1, "do", 0, 1],
  ForAll: ["for all", 1, "do", 0, 1],
  EndFor: ["end for", 0, "", -1, 0],
  While: ["while", 1, "do", 0, 1],
  EndWhile: ["end while", 0, "", -1, 0],
  Repeat: ["repeat", 0, "", 0, 1],
  Until: ["until", 1, "", -1, 0],
  Loop: ["loop", 0, "", 0, 1],
  EndLoop: ["end loop", 0, "", -1, 0],
  Function: ["function", 2, "", 0, 1],
  EndFunction: ["end function", 0, "", -1, 0],
  Procedure: ["procedure", 2, "", 0, 1],
  EndProcedure: ["end procedure", 0, "", -1, 0],
  RETURN: ["return", 0, "", 0, 0],
  PRINT: ["print", 0, "", 0, 0],
};
const ALG_OLD: Record<string, string> = { STATE: "State", REQUIRE: "Require", ENSURE: "Ensure", IF: "If", ELSIF: "ElsIf", ELSE: "Else", ENDIF: "EndIf", FOR: "For", FORALL: "ForAll", ENDFOR: "EndFor", WHILE: "While", ENDWHILE: "EndWhile", REPEAT: "Repeat", UNTIL: "Until", LOOP: "Loop", ENDLOOP: "EndLoop" };

/** \begin{algorithmic}[1] ... : one Div per line, with its depth and whether it is numbered. */
env("algorithmic", (p, sink, tok, name) => {
  const every = p.readOptRaw()?.text.trim();
  const o: Open = { kind: "env", name, tok };
  p.open.push(o);
  const lines: Block[] = [];
  let level = 0;
  for (;;) {
    p.skipWhite();
    const t = p.toks[p.i];
    if (t?.type === "cmd" && ALG_LINES.has(t.value)) {
      p.i++;
      const key = ALG_OLD[t.value] ?? t.value;
      const [before, nargs, after, pre, post] = ALG[key]!;
      level = Math.max(0, level + pre);
      const content: Inline[] = [];
      const word = (w: string) => content.push({ t: "Strong", content: [{ t: "Text", text: w }] }, { t: "Text", text: " " });
      if (before) word(before);
      if (nargs === 2) {
        content.push({ t: "SmallCaps", content: trimInlines(p.parseArgInlines(t)) }, { t: "Text", text: "(" }, ...trimInlines(p.parseArgInlines(t)), { t: "Text", text: ") " });
      } else if (nargs === 1) {
        content.push(...trimInlines(p.parseArgInlines(t)), { t: "Text", text: " " });
      }
      if (after) word(after);
      content.push(...blocksToInlines(p.finishBlocks(p.parseScoped({ kind: "item", tok: t, name: "algorithmic" }, false, true))));
      const nonum = key === "Statex" || key === "Require" || key === "Ensure";
      lines.push({ t: "Div", attr: { classes: nonum ? ["alg-line", "alg-nonum"] : ["alg-line"], attrs: { level: String(level) } }, blocks: [{ t: "Plain", content: trimInlines(normalizeInlines(content)) }] });
      level = Math.max(0, level + post);
      continue;
    }
    if (p.checkStop()) break;
    // Text before the first line command.
    const stray = blocksToInlines(p.finishBlocks(p.parseScoped({ kind: "item", tok: t!, name: "algorithmic" }, false, true)));
    if (stray.length) lines.push({ t: "Div", attr: { classes: ["alg-line", "alg-nonum"], attrs: { level: String(level) } }, blocks: [{ t: "Plain", content: stray }] });
  }
  p.closeOpen(o);
  const attrs: Record<string, string> = every && /^\d+$/.test(every) && every !== "0" ? { numbered: every } : {};
  p.block(sink, { t: "Div", attr: { classes: ["algorithmic"], attrs }, blocks: lines, pos: p.pos(tok) });
});

env("table table* wraptable sidewaystable", (p, sink, tok, name) => {
  if (name === "wraptable") {
    p.readOptRaw();
    p.readArgRaw(tok);
    p.readOptRaw();
    p.readArgRaw(tok);
  } else p.readOptRaw();
  const target: Target = { kind: "table" };
  p.targets.push(target);
  const blocks = unwrapLayout(envBlocks(p, tok, name));
  p.targets.pop();
  const table = blocks.find((b): b is Extract<Block, { t: "Table" }> => b.t === "Table");
  if (!table) {
    const fig = makeFigure(p, blocks.map(toPlain), target, tok);
    fig.attr = { classes: ["table"] };
    p.block(sink, fig);
    return;
  }
  if (target.caption) table.caption = target.caption;
  if (target.label) {
    table.label = target.label;
    table.id = slugify(target.label);
  }
  table.pos = p.pos(tok);
  for (const b of blocks) p.block(sink, b);
});

// ------------------------------------------------------------ theorems

function theoremEnv(p: Parser, sink: Sink, tok: Token, name: string, def: TheoremDef, kind: string): void {
  const title = trimInlines(p.parseOptInlines() ?? []);
  const target: Target = { kind: "theorem" };
  p.targets.push(target);
  const blocks = envBlocks(p, tok, name);
  p.targets.pop();
  const node: Block = { t: "Theorem", kind, name: def.name, numbered: def.numbered, blocks, pos: p.pos(tok) };
  if (def.counter) node.counter = def.counter;
  if (def.withinSection) node.withinSection = true;
  if (title.length) node.title = title;
  if (target.label) {
    node.label = target.label;
    node.id = slugify(target.label);
  }
  p.block(sink, node);
}

env("proof", (p, sink, tok, name) => theoremEnv(p, sink, tok, name, { name: "Proof", numbered: false }, "proof"));
