/**
 * Commands and environments from packages and document classes that
 * language models reach for in ordinary documents: placeholder text
 * (lipsum, blindtext), algorithm2e, moderncv, the title-page commands of
 * IEEEtran, revtex, elsarticle, amsart, llncs and authblk, beamer frames,
 * glossaries and acronyms, margin and to-do notes, framed boxes, xparse
 * definitions, ifthenelse, chemfig and a few more. Most are approximations
 * in the article layout; what cannot be drawn says so once (LTX007).
 *
 * Registered on import, after commands.ts and envs.ts.
 */

import type { Block, Inline } from "../../ast.js";
import { plainText } from "../../ast.js";
import { CONDITIONALS, LETTER, docInfo, isCmd, keyVals, type Open, type Sink, type Target } from "./base.js";
import { AFFIL_MARK, AND, KEYS_MARK, counters, on, resolveColor, setAffiliation } from "./commands.js";
import { algLine, env, envBlocks, itemBlocks } from "./envs.js";
import type { Token } from "./lexer.js";
import type { Parser } from "./parser.js";
import { SYMBOLS, blocksToInlines, cssLength, normalizeInlines, plainString, trimInlines } from "./text.js";

const text = (s: string): Inline => ({ t: "Text", text: s });
const strong = (s: string): Inline => ({ t: "Strong", content: [text(s)] });

/** Read arguments by signature (s star, o optional, m mandatory) as raw source. */
function readArgs(p: Parser, tok: Token, sig: string): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const c of sig) {
    if (c === "s") out.push(p.consumeStar() ? "*" : undefined);
    else if (c === "o") out.push(p.readOptRaw()?.text);
    else out.push(p.readArgRaw(tok)?.text ?? "");
  }
  return out;
}

/** A command that stands for other LaTeX: its arguments are read and the source it builds is parsed in its place. */
function rewrite(names: string, sig: string, build: (a: (string | undefined)[], p: Parser, tok: Token) => string): void {
  on(names, (p, _sink, tok) => {
    const start = p.cmdStart;
    const args = readArgs(p, tok, sig);
    if (p.budget(tok, tok.value)) p.splice(start, build(args, p, tok), tok);
  });
}

/** Report an approximation once per document and name. */
function approximated(p: Parser, tok: Token, message: string, hint: string, name = tok.value): void {
  p.warnOnce("LTX007", tok, message, hint, `approx\u0000${name}`);
}

// ------------------------------------------------------------ placeholder text

/** Filler paragraphs in the manner of lorem ipsum, for \lipsum and \blindtext. */
const LOREM = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus. Praesent commodo cursus magna, vel scelerisque nisl consectetur et. Donec sed odio dui, at tempus ligula. Nullam quis risus eget urna mollis ornare vel eu leo. Cras mattis consectetur purus sit amet fermentum. Vestibulum id ligula porta felis euismod semper.",
  "Curabitur blandit tempus porttitor. Maecenas faucibus mollis interdum, sed posuere consectetur est at lobortis. Aenean lacinia bibendum nulla sed consectetur. Etiam porta sem malesuada magna mollis euismod. Morbi leo risus, porta ac consectetur ac, vestibulum at eros. Fusce dapibus, tellus ac cursus commodo, tortor mauris condimentum nibh.",
  "Nulla vitae elit libero, a pharetra augue. Sed posuere consectetur est at lobortis. Vivamus sagittis lacus vel augue laoreet rutrum faucibus dolor auctor. Donec ullamcorper nulla non metus auctor fringilla. Duis mollis, est non commodo luctus, nisi erat porttitor ligula, eget lacinia odio sem nec elit. Aenean eu leo quam pellentesque ornare.",
  "Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae, ornare sit amet, wisi. Aenean fermentum, elit eget tincidunt condimentum, eros ipsum rutrum orci, sagittis tempus lacus enim ac dui. Donec non enim in turpis pulvinar facilisis.",
  "Ut felis praesent dapibus, neque id cursus faucibus, tortor neque egestas augue, eu vulputate magna eros eu erat. Aliquam erat volutpat. Nam dui mi, tincidunt quis, accumsan porttitor, facilisis luctus, metus. Phasellus ultrices nulla quis nibh. Quisque a lectus. Donec consectetuer ligula vulputate sem tristique cursus. Nam nulla quam, gravida non, commodo a, sodales sit amet, nisi.",
  "Mauris placerat eleifend leo. Quisque sit amet est et sapien ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae, ornare sit amet, wisi. Suspendisse potenti. Morbi in sem quis dui placerat ornare. Pellentesque odio nisi, euismod in, pharetra a, ultricies in, diam. Sed arcu. Cras consequat. Praesent dapibus, neque id cursus faucibus.",
  "Vivamus vestibulum ntulla nec ante. Praesent placerat risus quis eros. Fusce pellentesque suscipit nibh. Integer vitae libero ac risus egestas placerat. Vestibulum commodo felis quis tortor. Ut aliquam sollicitudin leo. Cras iaculis ultricies nulla. Donec quis dui at dolor tempor interdum. Vivamus molestie gravida turpis. Fusce lobortis lorem at ipsum semper sagittis.",
  "Nam convallis pellentesque nisl. Integer malesuada commodo nulla. Proin quam. Etiam ultrices. Suspendisse in justo eu magna luctus suscipit. Sed lectus. Integer euismod lacus luctus magna. Quisque cursus, metus vitae pharetra auctor, sem massa mattis sem, at interdum magna augue eget diam. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae.",
];

/** "2-4" or "3" as 1-based indices, at most `max` of them. */
function range(spec: string | undefined, dflt: [number, number], max = 150): number[] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(spec ?? "");
  const [a, b] = m ? [Number(m[1]), m[2] ? Number(m[2]) : Number(m[1])] : dflt;
  const out: number[] = [];
  for (let k = Math.max(1, a); k <= b && out.length < max; k++) out.push(k);
  return out;
}

function filler(p: Parser, sink: Sink, paras: number[], sentences?: string): void {
  paras.forEach((n, k) => {
    let par = LOREM[(n - 1) % LOREM.length]!;
    if (sentences) {
      const all = par.match(/[^.]+\./g) ?? [par];
      par = range(sentences, [1, all.length]).map((i) => all[(i - 1) % all.length]!.trim()).join(" ");
    }
    if (k) p.par(sink);
    p.emitText(sink, par);
  });
  p.par(sink);
}

/** \lipsum[2-3][1-2]: paragraphs, and sentences of them. Plain \lipsum gives seven. */
on("lipsum", (p, sink) => {
  p.consumeStar();
  const paras = p.readOptRaw()?.text;
  const sentences = p.readOptRaw()?.text;
  filler(p, sink, range(paras, [1, 7]), sentences);
});
/** blindtext: \blindtext[n] repeats a paragraph n times; \Blindtext gives more. */
on("blindtext Blindtext", (p, sink, tok) => {
  const n = Number(p.readOptRaw()?.text ?? 1) || 1;
  p.readOptRaw();
  filler(p, sink, Array.from({ length: Math.min(50, n * (tok.value === "Blindtext" ? 5 : 1)) }, (_, k) => k + 1));
});
rewrite("blinddocument Blinddocument", "", () =>
  "\\section{Lorem ipsum}\\lipsum[1-2]\\subsection{Dolor sit amet}\\lipsum[3]\\begin{itemize}\\item Lorem ipsum.\\item Dolor sit amet.\\end{itemize}\\subsection{Consectetur}\\lipsum[4-5]\\section{Adipiscing elit}\\lipsum[6]",
);

// ------------------------------------------------------------ cross-references

/** cleveref's ranges: \crefrange{a}{b} reads "Lemma 1 to 3". */
on("crefrange Crefrange cpagerefrange Cpagerefrange", (p, sink, tok) => {
  p.consumeStar();
  const a = p.readArgRaw(tok)?.text.trim();
  const b = p.readArgRaw(tok)?.text.trim();
  if (!a || !b) return;
  const page = tok.value.includes("page");
  p.emit(sink, { t: "Ref", label: a, style: page ? "page" : "auto", pos: p.pos(tok) });
  p.emitText(sink, page ? "–" : " to ");
  p.emit(sink, { t: "Ref", label: b, style: page ? "page" : "number", pos: p.pos(tok) });
});
/** subcaption's \subref{fig:a}: the reference by its number. */
on("subref", (p, sink, tok) => {
  p.consumeStar();
  const a = p.readArgRaw(tok)?.text.trim();
  if (a) p.emit(sink, { t: "Ref", label: a, style: "number", pos: p.pos(tok) });
});

// ------------------------------------------------------------ tables: threeparttable notes

on("tnote", (p, sink, tok) => {
  const c = trimInlines(p.parseArgInlines(tok));
  if (c.length) p.emit(sink, { t: "Superscript", content: c });
});

/** threeparttable's notes under a table: each \item[a] text as "a text" with a raised label. */
env("tablenotes", (p, sink, tok, name) => {
  p.readOptRaw();
  const o: Open = { kind: "env", name, tok };
  p.open.push(o);
  const notes: Block[] = [];
  for (;;) {
    p.skipWhite();
    const t = p.toks[p.i];
    if (isCmd(t, "item")) {
      p.i++;
      const label = p.parseOptInlines();
      const content = blocksToInlines(itemBlocks(p, t!));
      const lead: Inline[] = label?.length ? [{ t: "Superscript", content: trimInlines(label) }, text(" ")] : [];
      notes.push({ t: "Plain", content: trimInlines(normalizeInlines([...lead, ...content])) });
      continue;
    }
    if (p.checkStop()) break;
    const at = p.i;
    const stray = itemBlocks(p, t!);
    if (p.i === at) p.i++;
    notes.push(...stray);
  }
  p.closeOpen(o);
  if (notes.length) p.block(sink, { t: "Div", attr: { classes: ["tablenotes"] }, blocks: notes, pos: p.pos(tok) });
});

// ------------------------------------------------------------ algorithm2e

/** Whether algorithm2e prints "end" after blocks: the lined styles do. */
function lined(p: Parser): boolean {
  const info = docInfo(p);
  return info.alg.lined || info.packageOptions.has("algorithm2e:lined") || info.packageOptions.has("algorithm2e:algoruled");
}

/** End the line being written, as \; does. */
function flushLine(p: Parser, sink: Sink, nonum = false): void {
  const content = trimInlines(sink.para);
  sink.para = [];
  sink.spaced = true;
  sink.paraPos = undefined;
  if (content.length) p.block(sink, algLine(content, docInfo(p).alg.level, nonum));
}

/** A block's body, one level deeper; text left without \; becomes a line of its own. */
function algBody(p: Parser, tok: Token): Block[] {
  const alg = docInfo(p).alg;
  alg.level++;
  try {
    const blocks = p.parseArgBlocks(tok);
    return blocks.map((b) => (b.t === "Para" || b.t === "Plain" ? algLine(b.content, alg.level) : b));
  } finally {
    alg.level--;
  }
}

/** Words with single spaces between them, empty parts left out. */
function words(...parts: Inline[][]): Inline[] {
  const out: Inline[] = [];
  for (const part of parts) {
    if (!part.length) continue;
    // Punctuation such as SetKwProg's ":" follows the head directly.
    const glue = part.length === 1 && part[0]!.t === "Strong" && /^[:;,.]$/.test(plainText(part));
    if (out.length && !glue) out.push(text(" "));
    out.push(...part);
  }
  return out;
}

const kw = (w: string): Inline[] => (w ? [strong(w)] : []);

/** Write a block: its head line, its body, and "end" in the lined styles. */
function algBlock(p: Parser, sink: Sink, head: Inline[], body: Block[], end: string | undefined): void {
  flushLine(p, sink);
  const level = docInfo(p).alg.level;
  p.block(sink, algLine(head, level));
  for (const b of body) p.block(sink, b);
  if (end && lined(p)) p.block(sink, algLine(kw(end), level));
}

/** for-like blocks: \For{condition}{body} and the keywords a \SetKwFor gives. */
function forLike(p: Parser, sink: Sink, tok: Token, start: string, middle: string, end: string, hasCond = true): void {
  const cond = hasCond ? trimInlines(p.parseArgInlines(tok)) : [];
  algBlock(p, sink, words(kw(start), cond, kw(middle)), algBody(p, tok), end);
}

/** A one-line form: \lIf{condition}{statement}. */
function lineForm(p: Parser, sink: Sink, tok: Token, start: string, middle: string, hasCond = true): void {
  flushLine(p, sink);
  const cond = hasCond ? trimInlines(p.parseArgInlines(tok)) : [];
  const stmt = trimInlines(p.parseArgInlines(tok));
  p.block(sink, algLine(words(kw(start), cond, kw(middle), stmt), docInfo(p).alg.level));
}

const ALG2E_FOR: Record<string, [string, string]> = { For: ["for", "do"], ForEach: ["foreach", "do"], ForAll: ["forall", "do"], While: ["while", "do"] };
for (const [name, [a, b]] of Object.entries(ALG2E_FOR)) {
  on(name, (p, sink, tok) => forLike(p, sink, tok, a, b, "end"));
  on(`l${name}`, (p, sink, tok) => lineForm(p, sink, tok, a, b));
}
on("If ElseIf uIf uElseIf", (p, sink, tok) => {
  const v = tok.value;
  forLike(p, sink, tok, v.endsWith("ElseIf") ? "else if" : "if", "then", v.startsWith("u") ? "" : "end");
});
on("Else uElse", (p, sink, tok) => {
  p.readOptRaw();
  forLike(p, sink, tok, "else", "", tok.value === "uElse" ? "" : "end", false);
});
on("lIf lElseIf", (p, sink, tok) => lineForm(p, sink, tok, tok.value === "lIf" ? "if" : "else if", "then"));
on("lElse", (p, sink, tok) => lineForm(p, sink, tok, "else", "", false));
/** \eIf{condition}{then part}{else part}. */
on("eIf", (p, sink, tok) => {
  const cond = trimInlines(p.parseArgInlines(tok));
  const yes = algBody(p, tok);
  const no = algBody(p, tok);
  algBlock(p, sink, words(kw("if"), cond, kw("then")), yes, undefined);
  algBlock(p, sink, kw("else"), no, "end");
});
/** \Repeat{until condition}{body}. */
on("Repeat", (p, sink, tok) => {
  const until = trimInlines(p.parseArgInlines(tok));
  algBlock(p, sink, kw("repeat"), algBody(p, tok), undefined);
  p.block(sink, algLine(words(kw("until"), until), docInfo(p).alg.level));
});
on("Switch", (p, sink, tok) => forLike(p, sink, tok, "switch", "do", "end"));
on("Case uCase", (p, sink, tok) => forLike(p, sink, tok, "case", "do", tok.value === "Case" ? "end" : ""));
on("Other uOther", (p, sink, tok) => forLike(p, sink, tok, "otherwise", "", tok.value === "Other" ? "end" : "", false));
on("Begin", (p, sink, tok) => {
  p.readOptRaw();
  forLike(p, sink, tok, "begin", "", "end", false);
});

/** Input, output, data and result lines: unnumbered, with the keyword in bold. */
function inputLine(p: Parser, sink: Sink, tok: Token, word: string): void {
  flushLine(p, sink);
  const content = trimInlines(p.parseArgInlines(tok));
  p.block(sink, algLine(words(kw(`${word}:`), content), docInfo(p).alg.level, true));
}
const ALG2E_INPUTS: Record<string, string> = { KwIn: "Input", KwOut: "Output", KwData: "Data", KwResult: "Result", KwInput: "Input", KwOutput: "Output" };
for (const [name, word] of Object.entries(ALG2E_INPUTS)) on(name, (p, sink, tok) => inputLine(p, sink, tok, word));

on("KwRet", (p, sink, tok) => {
  p.emit(sink, strong("return"));
  p.emitText(sink, " ");
  for (const x of trimInlines(p.parseArgInlines(tok))) p.emit(sink, x);
});
on("KwTo KwDownto KwFrom KwStep", (p, sink, tok) => {
  p.space(sink);
  p.emit(sink, strong(tok.value.slice(2).toLowerCase()));
  p.space(sink);
});
on("SetAlgoLined", (p) => {
  docInfo(p).alg.lined = true;
});
on("LinesNumbered LinesNumberedHidden", (p) => {
  docInfo(p).alg.numbered = true;
});
on("Indp Indm", (p, _sink, tok) => {
  const alg = docInfo(p).alg;
  alg.level = Math.max(0, alg.level + (tok.value === "Indp" ? 1 : -1));
});
on("BlankLine", (p, sink) => {
  if (docInfo(p).alg.open === 0) return;
  flushLine(p, sink);
  p.block(sink, algLine([text(" ")], docInfo(p).alg.level, true));
});

/** \; ends a line of an algorithm2e algorithm; elsewhere it is a thick space. */
on(";", (p, sink) => {
  if (docInfo(p).alg.open > 0) flushLine(p, sink);
  else p.emitText(sink, SYMBOLS[";"]!);
});

/** Comments: \tcc{...} as /* ... *\/, \tcp{...} as // ...; the starred forms sit at the end of the line before. */
function comment(p: Parser, sink: Sink, tok: Token, open: string, close: string): void {
  const side = p.consumeStar();
  p.readOptRaw();
  const content = trimInlines(p.parseArgInlines(tok));
  const note: Inline[] = [text(open), ...content, ...(close ? [text(close)] : [])];
  if (docInfo(p).alg.open === 0) {
    for (const x of note) p.emit(sink, x);
    return;
  }
  const last = sink.blocks[sink.blocks.length - 1];
  if (side && p.paraEmpty(sink) && last?.t === "Div" && last.attr.classes?.includes("alg-line") && last.blocks[0]?.t === "Plain") {
    last.blocks[0] = { t: "Plain", content: normalizeInlines([...last.blocks[0].content, text(" "), ...note]) };
    return;
  }
  if (side) {
    for (const x of [text(" "), ...note]) p.emit(sink, x);
    flushLine(p, sink);
    return;
  }
  flushLine(p, sink);
  p.block(sink, algLine(note, docInfo(p).alg.level));
}
on("tcc", (p, sink, tok) => comment(p, sink, tok, "/* ", " */"));
on("tcp", (p, sink, tok) => comment(p, sink, tok, "// ", ""));

/** Keyword definitions: each makes a macro that calls one of the handlers below with the words filled in. */
function defineKw(p: Parser, tok: Token, nargs: number, body: string): void {
  const name = p.readArgRaw(tok)?.text.trim();
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs, body }, "renew", tok);
}
const arg = (p: Parser, tok: Token): string => p.readArgRaw(tok)?.text ?? "";
on("SetKwInOut SetKwInput SetKwHangingKw", (p, _sink, tok) => {
  const start = p.i;
  p.readArgRaw(tok);
  const word = arg(p, tok);
  p.i = start;
  defineKw(p, tok, 1, `\\twalginput{${word}}{#1}`);
  p.readArgRaw(tok);
});
on("twalginput", (p, sink, tok) => inputLine(p, sink, tok, plainString(p.parseArgInlines(tok))));
on("SetKwFunction", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const word = arg(p, tok);
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 1, body: `\\textsc{${word}}(#1)` }, "renew", tok);
});
on("SetKw SetKwData SetKwArray", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const word = arg(p, tok);
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 0, body: tok.value === "SetKw" ? `\\textbf{${word}}` : `\\textnormal{${word}}` }, "renew", tok);
});
on("SetKwProg", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const [a, b, c] = [arg(p, tok), arg(p, tok), arg(p, tok)];
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 2, body: `\\twalgblock{${a}}{${b}}{${c}}{#1}{#2}` }, "renew", tok);
});
on("SetKwFor", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const [a, b, c] = [arg(p, tok), arg(p, tok), arg(p, tok)];
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 2, body: `\\twalgblock{${a}}{${b}}{${c}}{#1}{#2}` }, "renew", tok);
});
on("SetKwBlock", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const [a, c] = [arg(p, tok), arg(p, tok)];
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 1, body: `\\twalgblock{${a}}{}{${c}}{}{#1}` }, "renew", tok);
});
on("SetKwRepeat", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const [a, b] = [arg(p, tok), arg(p, tok)];
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 2, body: `\\twalgrepeat{${a}}{${b}}{#1}{#2}` }, "renew", tok);
});
on("SetKwIF", (p, _sink, tok) => {
  const [n1, n2, n3] = [arg(p, tok), arg(p, tok), arg(p, tok)].map((s) => s.trim().replace(/^\\/, ""));
  const [wIf, wThen, wElseIf, wElse, wEnd] = [arg(p, tok), arg(p, tok), arg(p, tok), arg(p, tok), arg(p, tok)];
  const def = (n: string, nargs: number, body: string) => n && p.defineMacro(`\\${n}`, { nargs, body }, "renew", tok);
  def(n1!, 2, `\\twalgblock{${wIf}}{${wThen}}{${wEnd}}{#1}{#2}`);
  def(`u${n1}`, 2, `\\twalgblock{${wIf}}{${wThen}}{}{#1}{#2}`);
  def(n2!, 2, `\\twalgblock{${wElseIf}}{${wThen}}{${wEnd}}{#1}{#2}`);
  def(n3!, 1, `\\twalgblock{${wElse}}{}{${wEnd}}{}{#1}`);
});
on("SetKwComment", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const [a, b] = [arg(p, tok), arg(p, tok)];
  if (name) p.defineMacro(`\\${name.replace(/^\\/, "")}`, { nargs: 1, body: `\\twalgcomment{${a} }{ ${b}}{#1}` }, "renew", tok);
});
on("twalgblock", (p, sink, tok) => {
  const [a, b, c] = [arg(p, tok), arg(p, tok), arg(p, tok)];
  const cond = trimInlines(p.parseArgInlines(tok));
  algBlock(p, sink, words(kw(a.trim()), cond, kw(b.trim())), algBody(p, tok), c.trim() || undefined);
});
on("twalgrepeat", (p, sink, tok) => {
  const [a, b] = [arg(p, tok), arg(p, tok)];
  const until = trimInlines(p.parseArgInlines(tok));
  algBlock(p, sink, kw(a.trim()), algBody(p, tok), undefined);
  p.block(sink, algLine(words(kw(b.trim()), until), docInfo(p).alg.level));
});
on("twalgcomment", (p, sink, tok) => {
  const [a, b] = [arg(p, tok), arg(p, tok)];
  comment(p, sink, tok, a, b);
});

// ------------------------------------------------------------ moderncv

const CONTACTS = new WeakMap<object, { lines: Inline[][]; quote?: Inline[] }>();
function contacts(p: Parser): { lines: Inline[][]; quote?: Inline[] } {
  let c = CONTACTS.get(p);
  if (!c) CONTACTS.set(p, (c = { lines: [] }));
  return c;
}
const isCv = (p: Parser): boolean => docInfo(p).cls === "moderncv";

/** \name{First}{Last}: the name on the CV, as its title. */
on("name", (p, sink, tok) => {
  if (!isCv(p)) return p.unknownCommand(tok, sink);
  const first = trimInlines(p.parseArgInlines(tok));
  const last = trimInlines(p.parseArgInlines(tok));
  p.meta.title = trimInlines([...first, text(" "), ...last]);
});
on("firstname familyname", (p, sink, tok) => {
  if (!isCv(p)) return p.unknownCommand(tok, sink);
  const part = trimInlines(p.parseArgInlines(tok));
  p.meta.title = tok.value === "firstname" ? part : trimInlines([...(p.meta.title ?? []), text(" "), ...part]);
});
/** Contact details: kept for \makecvtitle. */
on("phone mobile fax homepage social extrainfo", (p, sink, tok) => {
  if (!isCv(p)) return p.unknownCommand(tok, sink);
  p.readOptRaw();
  p.readOptRaw();
  const c = trimInlines(p.parseArgInlines(tok));
  if (c.length) contacts(p).lines.push(c);
});
on("quote", (p, sink, tok) => {
  if (!isCv(p)) return p.unknownCommand(tok, sink);
  contacts(p).quote = trimInlines(p.parseArgInlines(tok));
});
/** \makecvtitle: the name and job title come from meta; the contacts go on one centred line below. */
on("makecvtitle", (p, sink, tok) => {
  docInfo(p).titleMade = true;
  const c = contacts(p);
  const line: Inline[] = [];
  c.lines.forEach((x, k) => line.push(...(k ? [text(" · ")] : []), ...x));
  const blocks: Block[] = [];
  if (line.length) blocks.push({ t: "Plain", content: line });
  if (c.quote?.length) blocks.push({ t: "Plain", content: [{ t: "Emph", content: c.quote }] });
  if (blocks.length) p.block(sink, { t: "Div", attr: { classes: ["center"] }, blocks, pos: p.pos(tok) });
});

/** One field, or nothing when it is empty. */
const field = (s: string | undefined, wrap = (x: string) => x): string => (s && s.trim() ? wrap(s.trim()) : "");
rewrite("cventry", "ommmmmm", ([, dates, title, employer, city, grade, desc]) => {
  const head = [field(title, (x) => `\\textbf{${x}}`), field(employer, (x) => `\\textit{${x}}`), field(city), field(grade)].filter(Boolean).join(", ");
  return `\\par\\noindent ${head}\\hfill ${field(dates)}\\par ${field(desc, (x) => `${x}\\par`)}`;
});
rewrite("cvitem cvline", "omm", ([, label, body]) => `\\par\\noindent${field(label, (x) => `\\textbf{${x}}\\quad `)}${field(body)}\\par `);
rewrite("cvdoubleitem", "mmmm", ([a, b, c, d]) => `\\par\\noindent${field(a, (x) => `\\textbf{${x}}\\quad `)}${field(b)}\\hfill ${field(c, (x) => `\\textbf{${x}}\\quad `)}${field(d)}\\par `);
rewrite("cvlistitem", "om", ([, a]) => `\\par\\noindent\\textbullet\\enspace ${field(a)}\\par `);
rewrite("cvlistdoubleitem", "omm", ([, a, b]) => `\\par\\noindent\\textbullet\\enspace ${field(a)}\\hfill\\textbullet\\enspace ${field(b)}\\par `);
rewrite("cvitemwithcomment", "ommm", ([, a, b, c]) => `\\par\\noindent${field(a, (x) => `\\textbf{${x}}\\quad `)}${field(b)}\\hfill ${field(c, (x) => `\\textit{${x}}`)}\\par `);

// ------------------------------------------------------------ title pages: affiliations and contact lines

/** Affiliations given by key, gathered for each author whose keys name them. */
function resolveKeyed(p: Parser): void {
  const info = docInfo(p);
  info.authorKeys.forEach((keys, k) => {
    const found = keys.map((key) => info.affiliations.get(key)).filter((x): x is Inline[] => !!x);
    if (!found.length) return;
    const joined: Inline[] = [];
    found.forEach((x, i) => joined.push(...(i ? [{ t: "LineBreak" } as Inline] : []), ...x));
    setAffiliation(p, k, joined);
  });
}

/**
 * An affiliation: by key, or (revtex, amsart) for the authors since the last
 * one; a second one for the same authors is added on a new line.
 */
function addAffiliation(p: Parser, key: string | undefined, content: Inline[]): void {
  if (!content.length) return;
  const info = docInfo(p);
  if (key !== undefined && key.trim()) {
    for (const k of key.split(",")) info.affiliations.set(k.trim(), content);
    resolveKeyed(p);
    return;
  }
  const n = p.meta.author?.length ?? 0;
  if (!n) return;
  if (info.affiliated >= n) {
    const prev = p.meta.affiliation?.[n - 1];
    setAffiliation(p, n - 1, prev ? [...prev, { t: "LineBreak" }, ...content] : content);
    return;
  }
  for (let k = info.affiliated; k < n; k++) setAffiliation(p, k, content);
  info.affiliated = n;
}

/** elsarticle's \affiliation{organization={...}, city={...}}: the values, joined. */
function affiliationText(p: Parser, raw: string, tok: Token): Inline[] {
  if (/^\s*(organization|addressline|city|postcode|state|country)\s*=/.test(raw)) {
    const parts = [...keyVals(raw).values()].map((v) => v.trim()).filter(Boolean);
    return trimInlines(p.parseString(parts.join(", "), tok));
  }
  return trimInlines(p.parseString(raw, tok));
}

on("affiliation affil altaffiliation", (p, _sink, tok) => {
  const key = p.readOptRaw()?.text;
  const raw = p.readArgRaw(tok);
  if (raw) addAffiliation(p, key, affiliationText(p, raw.text, raw.tok));
});

/** \address: the letter class's sender, moderncv's postal address, or (amsart, elsarticle) an affiliation. */
on("address", (p, _sink, tok) => {
  const cls = docInfo(p).cls ?? "";
  if (cls === "moderncv") {
    const parts: Inline[] = [];
    for (let k = 0; k < 3; k++) {
      p.skipSpace();
      if (p.toks[p.i]?.type !== "open") break;
      const c = trimInlines(p.parseArgInlines(tok));
      if (c.length) parts.push(...(parts.length ? [text(", ")] : []), ...c);
    }
    if (parts.length) contacts(p).lines.unshift(parts);
    return;
  }
  const key = p.readOptRaw()?.text;
  if (key !== undefined || /^(ams|els|revtex|aps|IEEE|svjour|elsart)/.test(cls)) {
    const raw = p.readArgRaw(tok);
    if (raw) addAffiliation(p, key, affiliationText(p, raw.text, raw.tok));
    return;
  }
  const content = trimInlines(p.parseArgInlines(tok));
  const letter = LETTER.get(p) ?? {};
  letter.address = content;
  LETTER.set(p, letter);
});

/** IEEEtran's \IEEEauthorblockA{...} inside \author: that author's affiliation. */
on("IEEEauthorblockA", (p, sink, tok) => {
  const content = trimInlines(p.parseArgInlines(tok));
  if (p.authorMode) p.emit(sink, { t: "Span", attr: { classes: [AFFIL_MARK] }, content });
  else for (const x of content) p.emit(sink, x);
});

/** llncs's \inst{1,2} after an author's name: affiliation keys. */
on("inst", (p, sink, tok) => {
  const keys = p.readArgRaw(tok)?.text.trim() ?? "";
  if (p.authorMode) p.emit(sink, { t: "Span", attr: { classes: [KEYS_MARK], attrs: { keys } }, content: [] });
  else p.emit(sink, { t: "Superscript", content: [text(keys)] });
});

/** llncs's and beamer's \institute{A \and B}: affiliations numbered 1, 2... in order. */
on("institute", (p, _sink, tok) => {
  p.readOptRaw();
  const saved = p.authorMode;
  p.authorMode = true;
  const content = p.parseArgInlines(tok);
  p.authorMode = saved;
  const list: Inline[][] = [[]];
  for (const x of content) {
    if (x === AND) list.push([]);
    else list[list.length - 1]!.push(x);
  }
  const insts = list.map(trimInlines).filter((x) => x.length);
  if (!insts.length) return;
  const info = docInfo(p);
  const n = p.meta.author?.length ?? 0;
  if (info.authorKeys.some((k) => k.length)) {
    insts.forEach((x, k) => info.affiliations.set(String(k + 1), x));
    resolveKeyed(p);
  } else if (insts.length === n) insts.forEach((x, k) => setAffiliation(p, k, x));
  else {
    const joined: Inline[] = [];
    insts.forEach((x, k) => joined.push(...(k ? [{ t: "LineBreak" } as Inline] : []), ...x));
    for (let k = 0; k < n; k++) setAffiliation(p, k, joined);
  }
});

/** \email: a moderncv contact; on a revtex or amsart title page, a line under the affiliation; elsewhere a mailto link. */
on("email", (p, sink, tok) => {
  p.readOptRaw();
  const raw = p.readArgRaw(tok)?.text.trim();
  if (!raw) return;
  const link: Inline = { t: "Link", url: `mailto:${raw}`, content: [text(raw)], pos: p.pos(tok) };
  if (isCv(p)) {
    contacts(p).lines.push([link]);
    return;
  }
  const n = p.meta.author?.length ?? 0;
  if (!p.authorMode && n && !docInfo(p).titleMade && p.paraEmpty(sink)) {
    const prev = p.meta.affiliation?.[n - 1];
    setAffiliation(p, n - 1, prev ? [...prev, { t: "LineBreak" }, link] : [link]);
    return;
  }
  p.emit(sink, link);
});

/**
 * \thanks: a footnote on the title or a name. Given on its own before \maketitle (amsart),
 * it goes with the last author's name rather than into the text.
 */
on("thanks", (p, sink, tok) => {
  p.readOptRaw();
  const note: Inline = { t: "Note", blocks: p.parseArgBlocks(tok), pos: p.pos(tok) };
  const authors = p.meta.author;
  const inTitle = p.open.some((o) => o.kind === "brace" && (o.name === "title" || o.name === "author"));
  if (!inTitle && authors?.length && !docInfo(p).titleMade) authors[authors.length - 1]!.push(note);
  else p.emit(sink, note);
});

on("maketitle", (p) => {
  docInfo(p).titleMade = true;
});

/** IEEEtran's keywords environment and elsarticle's keyword one: the keywords, for the title page. */
env("IEEEkeywords keyword keywords", (p, _sink, tok, name) => {
  const words = plainString(blocksToInlines(envBlocks(p, tok, name)))
    .split(/\s*[,;·]\s*/)
    .map((w) => w.trim())
    .filter(Boolean);
  p.meta.keywords = [...(p.meta.keywords ?? []), ...words];
});
/** elsarticle's classification codes after the keywords (\MSC[2010] 65M08): left out to the end of the line. */
on("MSC PACS JEL", (p) => {
  p.readOptRaw();
  const line = p.toks[p.cmdStart]!.line;
  while (p.i < p.toks.length) {
    const t = p.toks[p.i]!;
    if (t.type === "par" || t.line !== line || (t.type === "cmd" && (t.value === "end" || t.value === "sep"))) break;
    p.i++;
  }
});
/** elsarticle separates keywords with \sep. */
on("sep", (p, sink) => p.emitText(sink, ", "));

/** revtex's acknowledgments environment: an unnumbered section. */
env("acknowledgments acknowledgements acknowledgment acknowledgement", (p, sink, tok, name) => {
  const node: Extract<Block, { t: "Heading" }> = { t: "Heading", level: 1, numbered: false, content: [text("Acknowledgments")], pos: p.pos(tok) };
  p.sections.push({ node, cmd: "section", appendix: false });
  p.block(sink, node);
  for (const b of envBlocks(p, tok, name)) p.block(sink, b);
});

// ------------------------------------------------------------ book matter, KOMA-Script, memoir

on("frontmatter backmatter mainmatter", (p, _sink, tok) => {
  docInfo(p).unnumberedMatter = tok.value !== "mainmatter";
});
/** KOMA-Script's \minisec{...}: a small bold heading that is not a section. */
on("minisec", (p, sink, tok) => {
  const content = trimInlines(p.parseArgInlines(tok));
  p.block(sink, { t: "Para", content: [{ t: "Span", attr: { classes: ["noindent"] }, content: [] }, { t: "Strong", content }], pos: p.pos(tok) });
});
const DEPTHS: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
/** memoir's \setsecnumdepth{subsection} and \settocdepth{section}. */
rewrite("setsecnumdepth settocdepth", "m", ([name], _p, tok) => {
  const n = DEPTHS[(name ?? "").trim()] ?? Number(name);
  if (!Number.isFinite(n)) return "";
  return `\\setcounter{${tok.value === "setsecnumdepth" ? "secnumdepth" : "tocdepth"}}{${n}}`;
});
/** \epigraph{quotation}{source}: a quotation with its source set right. */
on("epigraph", (p, sink, tok) => {
  const quote = p.parseArgBlocks(tok);
  const source = trimInlines(p.parseArgInlines(tok));
  const blocks: Block[] = [...quote];
  if (source.length) blocks.push({ t: "Div", attr: { classes: ["flushright"] }, blocks: [{ t: "Plain", content: [text("— "), ...source] }] });
  p.block(sink, { t: "BlockQuote", blocks, pos: p.pos(tok) });
});

// ------------------------------------------------------------ notes in the margin, to-do notes

/** \marginpar, \marginnote and \sidenote: there is no margin column, so they become footnotes. */
on("marginpar", (p, sink, tok) => {
  p.readOptRaw();
  p.emit(sink, { t: "Note", blocks: p.parseArgBlocks(tok), pos: p.pos(tok) });
});
on("marginnote", (p, sink, tok) => {
  p.readOptRaw();
  const blocks = p.parseArgBlocks(tok);
  p.readOptRaw();
  p.emit(sink, { t: "Note", blocks, pos: p.pos(tok) });
});
on("sidenote footnotelater", (p, sink, tok) => {
  p.readOptRaw();
  p.readOptRaw();
  p.emit(sink, { t: "Note", blocks: p.parseArgBlocks(tok), pos: p.pos(tok) });
});

/** todonotes: \todo[inline]{...} as a box in the text, a margin \todo as a coloured remark where it stands. */
on("todo", (p, sink, tok) => {
  const opts = keyVals(p.readOptRaw()?.text ?? "");
  const bg = opts.get("color") ?? opts.get("backgroundcolor");
  const color = (bg && resolveColor(p, bg)) || "#fff1c6";
  if (opts.has("inline")) {
    const blocks = p.parseArgBlocks(tok);
    p.block(sink, { t: "Div", attr: { classes: ["box"], attrs: { title: "To do", background: color, frame: "#e0a000" } }, blocks, pos: p.pos(tok) });
    return;
  }
  const content = trimInlines(p.parseArgInlines(tok));
  p.emit(sink, { t: "Span", attr: { classes: ["color"], attrs: { color: "#b35900" } }, content: normalizeInlines([text("[To do: "), ...content, text("]")]) });
});
on("missingfigure", (p, sink, tok) => {
  p.readOptRaw();
  const blocks = p.parseArgBlocks(tok);
  p.block(sink, { t: "Div", attr: { classes: ["box"], attrs: { title: "Missing figure", background: "#f2f2f2", frame: "#c00000" } }, blocks, pos: p.pos(tok) });
});

// ------------------------------------------------------------ framed boxes

/** mdframed, framed, shaded, leftbar and their kin: drawn as a framed box. */
env("mdframed framed oframed shaded shaded* snugshade snugshade* leftbar titled-frame", (p, sink, tok, name) => {
  const attrs: Record<string, string> = { title: "" };
  if (name === "mdframed") {
    const opts = keyVals(p.readOptRaw()?.text ?? "");
    const bg = opts.get("backgroundcolor");
    const fg = opts.get("linecolor") ?? opts.get("outerlinecolor");
    const title = opts.get("frametitle");
    if (bg && resolveColor(p, bg)) attrs.background = resolveColor(p, bg)!;
    if (fg && resolveColor(p, fg)) attrs.frame = resolveColor(p, fg)!;
    if (title) attrs.title = plainString(p.parseString(title, tok));
  } else if (name === "titled-frame") {
    attrs.title = plainString(p.parseArgInlines(tok));
  } else if (name.startsWith("shaded") || name.startsWith("snugshade")) {
    attrs.background = resolveColor(p, "shadecolor") ?? "#e6e6e6";
    attrs.frame = attrs.background;
  } else attrs.frame = name === "leftbar" ? "#808080" : "#000000";
  p.block(sink, { t: "Div", attr: { classes: ["box"], attrs }, blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});
/** \newmdenv[options]{name}: an environment that opens mdframed with those options. */
on("newmdenv", (p, _sink, tok) => {
  const opts = p.readOptRaw()?.text ?? "";
  const name = p.readArgRaw(tok)?.text.trim();
  if (name) p.envs.set(name, { nargs: 0, begin: `\\begin{mdframed}[${opts}]`, end: "\\end{mdframed}" });
});
/** tcolorbox's \tcblower: a rule between the upper and lower parts. */
on("tcblower", (p, sink, tok) => p.block(sink, { t: "Div", attr: { classes: ["hrule"] }, blocks: [], pos: p.pos(tok) }));

/** csquotes' displayquote: a block quotation. */
env("displayquote", (p, sink, tok, name) => {
  p.readOptRaw();
  p.readOptRaw();
  p.block(sink, { t: "BlockQuote", blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});

/** ragged2e's environments, under the names of the standard ones. */
const RAGGED: Record<string, string> = { Center: "center", FlushLeft: "flushleft", FlushRight: "flushright" };
env(Object.keys(RAGGED).join(" "), (p, sink, tok, name) => {
  p.block(sink, { t: "Div", attr: { classes: [RAGGED[name]!] }, blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});

/** minted's listing float: the code inside takes the caption and label. */
env("listing listing*", (p, sink, tok, name) => {
  p.readOptRaw();
  const target: Target = { kind: "figure" };
  p.targets.push(target);
  const blocks = envBlocks(p, tok, name);
  p.targets.pop();
  const code = blocks.find((b): b is Extract<Block, { t: "CodeBlock" }> => b.t === "CodeBlock");
  if (code && (target.caption || target.label)) {
    code.attr = { ...code.attr };
    if (target.label) code.attr.id = target.label;
    if (target.caption) code.attr.attrs = { ...code.attr.attrs, caption: plainString(target.caption) };
  }
  for (const b of blocks) p.block(sink, b);
});

/** The url package's \path{...}: a path in typewriter type. */
on("path", (p, sink, tok) => {
  const a = p.readArgRaw(tok);
  if (a) p.emit(sink, { t: "Code", text: a.text });
});

// ------------------------------------------------------------ beamer

/** One notice per document: slides are typeset as a document. */
function beamerNotice(p: Parser, tok: Token): void {
  approximated(p, tok, "beamer slides are typeset as one document: each frame title becomes a heading and overlays show at once", "Use \\documentclass{article} for a paper, or keep the slides for a TeX engine", "beamer");
}

/** A beamer overlay specification such as <2-> right after a command: left out. */
function skipOverlay(p: Parser): void {
  const t = p.toks[p.i];
  const spec = t?.type === "text" ? /^<[^<>\s]*>/.exec(t.value) : null;
  if (!spec) return;
  if (spec[0].length < t!.value.length) p.splitAt(p.i, spec[0].length);
  p.i++;
}

env("frame", (p, sink, tok, name) => {
  beamerNotice(p, tok);
  skipOverlay(p);
  p.readOptRaw();
  skipOverlay(p);
  const heading: Inline[] = [];
  p.skipSpace();
  if (p.toks[p.i]?.type === "open") heading.push(...trimInlines(p.parseArgInlines(tok)));
  p.skipSpace();
  const sub = p.toks[p.i]?.type === "open" ? trimInlines(p.parseArgInlines(tok)) : [];
  if (heading.length) p.block(sink, { t: "Heading", level: 2, numbered: false, content: heading, pos: p.pos(tok) });
  if (sub.length) p.block(sink, { t: "Para", content: [{ t: "Emph", content: sub }] });
  for (const b of envBlocks(p, tok, name)) p.block(sink, b);
});
on("frame", (p, sink, tok) => {
  beamerNotice(p, tok);
  for (const b of p.parseArgBlocks(tok)) p.block(sink, b);
});
on("frametitle", (p, sink, tok) => {
  skipOverlay(p);
  p.readOptRaw();
  const content = trimInlines(p.parseArgInlines(tok));
  if (content.length) p.block(sink, { t: "Heading", level: 2, numbered: false, content, pos: p.pos(tok) });
});
on("framesubtitle", (p, sink, tok) => {
  const content = trimInlines(p.parseArgInlines(tok));
  if (content.length) p.block(sink, { t: "Para", content: [{ t: "Emph", content }], pos: p.pos(tok) });
});
const BLOCKS: Record<string, string> = { block: "#2f4b9a", alertblock: "#c00000", exampleblock: "#2e7d32" };
env(Object.keys(BLOCKS).join(" "), (p, sink, tok, name) => {
  skipOverlay(p);
  p.skipSpace();
  const title = p.toks[p.i]?.type === "open" ? plainString(p.parseArgInlines(tok)) : "";
  p.block(sink, { t: "Div", attr: { classes: ["box"], attrs: { title, frame: BLOCKS[name]! } }, blocks: envBlocks(p, tok, name), pos: p.pos(tok) });
});
/** \alert{...}: beamer's emphasis, in red. */
on("alert", (p, sink, tok) => {
  skipOverlay(p);
  const content = p.parseArgInlines(tok);
  p.emit(sink, { t: "Span", attr: { classes: ["color"], attrs: { color: "#c00000" } }, content });
});
/** Overlays: every part is shown. */
on("only uncover visible onslide", (p, sink, tok) => {
  skipOverlay(p);
  p.skipSpace();
  if (tok.value === "onslide" && p.toks[p.i]?.type !== "open") return;
  for (const x of p.parseArgInlines(tok)) p.emit(sink, x);
});
on("invisible", (p, _sink, tok) => {
  skipOverlay(p);
  p.readArgRaw(tok);
});

// ------------------------------------------------------------ glossaries and acronyms

interface Entry {
  short: Inline[];
  long?: Inline[];
  plural?: Inline[];
  /** An acronym: spelled out on first use. A glossary entry's long form is its description. */
  acronym: boolean;
  used: boolean;
}

const GLOSSARY = new WeakMap<object, Map<string, Entry>>();

/** Entries by key; on first use, definitions later in the source (an acronym list at the end) are read ahead. */
function glossary(p: Parser, tok: Token): Map<string, Entry> {
  let g = GLOSSARY.get(p);
  if (g) return g;
  GLOSSARY.set(p, (g = new Map()));
  const src = tok.src.text.replace(/(^|[^\\])%.*$/gm, "$1");
  for (const m of src.matchAll(/\\(?:acro|acrodef|newacro)\s*\{([^{}]*)\}\s*(?:\[([^\]]*)\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    g.set(m[1]!.trim(), { short: p.parseString(m[2] ?? m[1]!, tok), long: p.parseString(m[3]!, tok), acronym: true, used: false });
  }
  for (const m of src.matchAll(/\\newacronym\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    g.set(m[1]!.trim(), { short: p.parseString(m[2]!, tok), long: p.parseString(m[3]!, tok), acronym: true, used: false });
  }
  return g;
}

on("newacronym", (p, _sink, tok) => {
  p.readOptRaw();
  const [key, short, long] = [arg(p, tok), arg(p, tok), arg(p, tok)];
  glossary(p, tok).set(key.trim(), { short: p.parseString(short, tok), long: p.parseString(long, tok), acronym: true, used: false });
});
on("newglossaryentry", (p, _sink, tok) => {
  const key = arg(p, tok).trim();
  const kv = keyVals(arg(p, tok));
  const name = kv.get("name") ?? key;
  const e: Entry = { short: p.parseString(name, tok), acronym: false, used: false };
  const desc = kv.get("description");
  if (desc) e.long = p.parseString(desc, tok);
  const plural = kv.get("plural");
  if (plural) e.plural = p.parseString(plural, tok);
  glossary(p, tok).set(key, e);
});
on("acro acrodef newacro", (p, sink, tok) => {
  const key = arg(p, tok).trim();
  const short = p.readOptRaw()?.text;
  const long = arg(p, tok);
  const e: Entry = { short: p.parseString(short ?? key, tok), long: p.parseString(long, tok), acronym: true, used: false };
  glossary(p, tok).set(key, e);
  // Inside the acronym environment, \acro also prints the entry.
  if (tok.value === "acro" && p.open.some((o) => o.kind === "env" && o.name === "acronym")) {
    p.block(sink, { t: "DefList", items: [{ term: [{ t: "Strong", content: e.short }], defs: [[{ t: "Plain", content: e.long ?? [] }]] }], pos: p.pos(tok) });
  }
});
/** The acronym package's list: its \acro lines are printed. */
env("acronym", (p, sink, tok, name) => {
  p.readOptRaw();
  const items = envBlocks(p, tok, name).flatMap((b) => (b.t === "DefList" ? b.items : []));
  if (items.length) p.block(sink, { t: "DefList", items, pos: p.pos(tok) });
});

const plural = (x: Inline[]): Inline[] => [...x, text("s")];
const capital = (x: Inline[]): Inline[] => {
  const [first, ...rest] = x;
  return first?.t === "Text" ? [text(first.text.charAt(0).toUpperCase() + first.text.slice(1)), ...rest] : x;
};
const upper = (x: Inline[]): Inline[] => x.map((i) => (i.t === "Text" ? text(i.text.toUpperCase()) : i));

/**
 * \gls, \ac and friends. Form f: full on first use then short (\gls, \ac),
 * s short, l long, F full always. Plural and capitalised variants follow the name.
 */
const GLS: Record<string, string> = {
  gls: "f", Gls: "f^", GLS: "fU", glspl: "fp", Glspl: "fp^", GLSpl: "fpU", glstext: "s", glsentryname: "s", glsname: "s", glsdesc: "d", glsentrydesc: "d",
  glsfirst: "F", acrshort: "s", Acrshort: "s^", acrlong: "l", Acrlong: "l^", acrfull: "F", Acrfull: "F^", acrshortpl: "sp", acrlongpl: "lp", acrfullpl: "Fp",
  ac: "f", Ac: "f^", acp: "fp", Acp: "fp^", acs: "s", acsp: "sp", acl: "l", Acl: "l^", aclp: "lp", Aclp: "lp^", acf: "F", Acf: "F^", acfp: "Fp", Acfp: "Fp^",
  acrfullfmt: "F",
};
for (const [name, form] of Object.entries(GLS)) {
  on(name, (p, sink, tok) => {
    p.consumeStar();
    p.readOptRaw();
    const key = arg(p, tok).trim();
    p.readOptRaw();
    const e = glossary(p, tok).get(key);
    let out: Inline[];
    if (!e) out = [text(key)];
    else {
      const pl = form.includes("p");
      const short = pl ? (e.plural ?? plural(e.short)) : e.short;
      const long = e.long && e.acronym ? (pl ? plural(e.long) : e.long) : short;
      const full = e.acronym && e.long ? [...long, text(" ("), ...short, text(")")] : short;
      const kind = form[0];
      if (kind === "d") out = e.long ?? [];
      else if (kind === "s") out = short;
      else if (kind === "l") out = long;
      else if (kind === "F") out = full;
      else out = !e.used ? full : short;
      e.used = true;
    }
    if (form.includes("^")) out = capital(out);
    if (form.includes("U")) out = upper(out);
    for (const x of out) p.emit(sink, x);
  });
}

/** \printglossaries, \printglossary, \printacronyms: the entries, as a description list. */
on("printglossaries printglossary printacronyms printnoidxglossaries printnoidxglossary", (p, sink, tok) => {
  p.readOptRaw();
  const g = glossary(p, tok);
  const items = [...g.entries()]
    .filter(([, e]) => e.long)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => ({ term: [{ t: "Strong", content: e.short } as Inline], defs: [[{ t: "Plain", content: e.long! } as Block]] }));
  if (!items.length) return;
  const node: Extract<Block, { t: "Heading" }> = { t: "Heading", level: 1, numbered: false, content: [text(tok.value.includes("acronym") ? "Acronyms" : "Glossary")], pos: p.pos(tok) };
  p.sections.push({ node, cmd: "section", appendix: false });
  p.block(sink, node);
  p.block(sink, { t: "DefList", items, pos: p.pos(tok) });
});

// ------------------------------------------------------------ definitions and conditionals

/**
 * xparse: \NewDocumentCommand{\name}{O{x} m m}{body}. Mandatory arguments and one
 * leading optional argument map onto \newcommand; a later optional argument or
 * a star is taken as absent.
 */
on("NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const spec = p.readArgRaw(tok)?.text ?? "";
  const body = p.readArgRaw(tok)?.text;
  if (!name || body === undefined || !/^\\[A-Za-z@]+$/.test(name)) return;
  const kinds: { kind: string; dflt?: string }[] = [];
  for (const m of spec.matchAll(/\+?\s*(O\s*\{((?:[^{}]|\{[^{}]*\})*)\}|[mosv]|t\S|[rRdD]..(?:\{[^{}]*\})?|[eE]\{[^{}]*\})/g)) {
    const k = m[1]![0]!;
    kinds.push(k === "O" ? { kind: "o", dflt: m[2] ?? "" } : { kind: k });
  }
  let nargs = 0;
  let dflt: string | undefined;
  const map: string[] = [];
  kinds.forEach((k, i) => {
    if (k.kind === "m" || k.kind === "v" || k.kind === "r" || k.kind === "R") map.push(`#${++nargs}`);
    else if (k.kind === "o" && i === 0) {
      dflt = k.dflt ?? "-NoValue-";
      map.push(`#${++nargs}`);
    } else if (k.kind === "s" || k.kind === "t") map.push("\\BooleanFalse");
    else map.push(k.dflt ?? "-NoValue-");
  });
  const mapped = body.replace(/#([1-9])/g, (m, d: string) => map[Number(d) - 1] ?? m);
  const mode = tok.value === "RenewDocumentCommand" || tok.value === "DeclareDocumentCommand" ? "renew" : tok.value === "ProvideDocumentCommand" ? "provide" : "new";
  p.defineMacro(name, dflt !== undefined ? { nargs, dflt, body: mapped } : { nargs, body: mapped }, mode, tok);
});
const noValue = (s: string | undefined): boolean => !s || !s.trim() || s.trim() === "-NoValue-";
rewrite("IfNoValueTF IfValueTF", "mmm", ([x, a, b], _p, tok) => (noValue(x) === (tok.value === "IfNoValueTF") ? a! : b!));
rewrite("IfNoValueT IfValueF", "mm", ([x, a], _p, tok) => (noValue(x) === (tok.value === "IfNoValueT") ? a! : ""));
rewrite("IfNoValueF IfValueT", "mm", ([x, a], _p, tok) => (noValue(x) === (tok.value === "IfNoValueF") ? "" : a!));
rewrite("IfBooleanTF", "mmm", ([x, a, b]) => ((x ?? "").trim() === "\\BooleanTrue" ? a! : b!));
rewrite("IfBooleanT", "mm", ([x, a]) => ((x ?? "").trim() === "\\BooleanTrue" ? a! : ""));
rewrite("IfBooleanF", "mm", ([x, a]) => ((x ?? "").trim() === "\\BooleanTrue" ? "" : a!));

/** Expand macros without arguments in a condition's text, a few levels deep. */
function expandSimple(p: Parser, s: string): string {
  let out = s;
  for (let k = 0; k < 8; k++) {
    const next = out.replace(/\\([A-Za-z@]+)\s*/g, (m, n: string) => {
      const d = p.macros.get(n);
      return d && d.nargs === 0 && d.dflt === undefined ? d.body : m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** A number in a condition: a literal, \value{c}, \arabic{c} or \thec. */
function numberIn(p: Parser, s: string): number | undefined {
  const t = expandSimple(p, s).trim();
  const v = /^\\(?:value|arabic)\s*\{([^{}]*)\}$/.exec(t) ?? /^\\the([A-Za-z]+)$/.exec(t);
  if (v) return counters(p).get(v[1]!.trim()) ?? 0;
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : undefined;
}

const BOOLEANS = new WeakMap<object, Map<string, boolean>>();
function booleans(p: Parser): Map<string, boolean> {
  let m = BOOLEANS.get(p);
  if (!m) BOOLEANS.set(p, (m = new Map()));
  return m;
}
on("newboolean provideboolean", (p, _sink, tok) => {
  const n = arg(p, tok).trim();
  if (!booleans(p).has(n)) booleans(p).set(n, false);
});
on("setboolean", (p, _sink, tok) => {
  const n = arg(p, tok).trim();
  booleans(p).set(n, /^\s*true\s*$/i.test(arg(p, tok)));
});

/** ifthenelse's test: \equal, \isodd, \boolean, number comparisons, joined with \AND, \OR and \NOT. Unknown tests count as true. */
function test(p: Parser, cond: string): boolean {
  const ors = cond.split(/\\OR\b/);
  if (ors.length > 1) return ors.some((c) => test(p, c));
  const ands = cond.split(/\\AND\b/);
  if (ands.length > 1) return ands.every((c) => test(p, c));
  let c = cond.trim();
  let negate = false;
  while (/^\\NOT\b/.test(c)) {
    negate = !negate;
    c = c.replace(/^\\NOT\s*/, "");
  }
  c = c.replace(/^\\\(([\s\S]*)\\\)$/, "$1").trim();
  let result = true;
  const eq = /^\\equal\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}$/.exec(c);
  const odd = /^\\isodd\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}$/.exec(c);
  const bool = /^\\boolean\s*\{([^{}]*)\}$/.exec(c);
  const cmp = /^(.+?)\s*([<>=])\s*(.+)$/.exec(c);
  if (eq) result = expandSimple(p, eq[1]!).trim() === expandSimple(p, eq[2]!).trim();
  else if (odd) result = (numberIn(p, odd[1]!) ?? 0) % 2 !== 0;
  else if (bool) result = booleans(p).get(bool[1]!.trim()) ?? false;
  else if (cmp) {
    const a = numberIn(p, cmp[1]!);
    const b = numberIn(p, cmp[3]!);
    if (a !== undefined && b !== undefined) result = cmp[2] === "<" ? a < b : cmp[2] === ">" ? a > b : a === b;
  }
  return negate ? !result : result;
}
rewrite("ifthenelse", "mmm", ([cond, yes, no], p) => (test(p, cond ?? "") ? yes! : no!));
/** etoolbox: \ifdef{\cmd}{yes}{no}, \ifundef, \ifstrequal, \ifblank, \ifbool. */
rewrite("ifdef ifundef", "mmm", ([cmd, yes, no], p, tok) => {
  const name = (cmd ?? "").trim().replace(/^\\/, "");
  const defined = p.macros.has(name);
  return defined === (tok.value !== "ifundef") ? yes! : no!;
});
rewrite("ifstrequal", "mmmm", ([a, b, yes, no], p) => (expandSimple(p, a ?? "").trim() === expandSimple(p, b ?? "").trim() ? yes! : no!));
rewrite("ifblank", "mmm", ([a, yes, no]) => (!(a ?? "").trim() ? yes! : no!));
rewrite("ifbool", "mmm", ([a, yes, no], p) => (booleans(p).get((a ?? "").trim()) ? yes! : no!));

/** xspace: a space unless punctuation follows. */
on("xspace", (p, sink) => {
  const t = p.toks[p.i];
  if (!t || t.type === "close" || t.type === "par") return;
  if (t.type === "text" && /^[.,;:!?)\]'/\-]/.test(t.value)) return;
  if (t.type === "char" && /^[~\\]/.test(t.value)) return;
  p.space(sink);
});

/** \the\value{c}, \the\c@... and \the of a counter: its value; other registers print nothing. */
on("the", (p, sink, tok) => {
  const t = p.toks[p.i];
  if (t?.type !== "cmd") return;
  p.i++;
  if (t.value === "value") {
    const a = p.readArgRaw(tok);
    if (a) p.emitText(sink, String(counters(p).get(a.text.trim()) ?? 0));
    return;
  }
  const name = t.value.replace(/^c@/, "");
  if (counters(p).has(name)) p.emitText(sink, String(counters(p).get(name)));
});

/** \MakeUppercase{...} and friends: the text changes case; math and commands are left alone. */
on("MakeUppercase MakeLowercase uppercase lowercase MakeTextUppercase MakeTextLowercase", (p, sink, tok) => {
  const up = /upper/i.test(tok.value);
  const change = (xs: Inline[]): Inline[] =>
    xs.map((x) => {
      if (x.t === "Text") return text(up ? x.text.toUpperCase() : x.text.toLowerCase());
      if ("content" in x && Array.isArray(x.content) && x.t !== "Link") return { ...x, content: change(x.content) } as Inline;
      return x;
    });
  for (const x of change(p.parseArgInlines(tok))) p.emit(sink, x);
});

/** datetime's \currenttime. */
on("currenttime", (p, sink) => {
  const d = new Date();
  p.emitText(sink, `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
});

/** hologo's \hologo{XeLaTeX}: the name as text. */
on("hologo", (p, sink, tok) => p.emitText(sink, arg(p, tok).trim()));

// ------------------------------------------------------------ symbols from amssymb, pifont and friends

/** amssymb's \checkmark works in text too: set as math, without the LTX006 note. */
on("checkmark cmark", (p, sink, tok) => p.emit(sink, { t: "Math", tex: "\\checkmark", pos: p.pos(tok) }));
on("xmark", (p, sink, tok) => p.emit(sink, { t: "Math", tex: "\\times", pos: p.pos(tok) }));
/** pifont's \ding{n}: the common dingbats, drawn with the math fonts' nearest symbols. */
const DINGS: Record<number, string> = {
  51: "\\checkmark", 52: "\\checkmark", 53: "\\times", 54: "\\times", 55: "\\times", 56: "\\times", 43: "\\Rightarrow", 72: "\\bigstar",
  73: "\\star", 108: "\\bullet", 110: "\\blacksquare", 111: "\\square", 113: "\\square", 117: "\\blacklozenge", 168: "\\clubsuit",
  169: "\\diamondsuit", 170: "\\heartsuit", 171: "\\spadesuit", 220: "\\rightarrow", 221: "\\rightarrow", 222: "\\Rightarrow", 224: "\\Rightarrow", 228: "\\Rightarrow",
};
on("ding", (p, sink, tok) => {
  const n = Number(arg(p, tok).trim());
  if (n >= 172 && n <= 211) {
    p.emitText(sink, String.fromCodePoint([0x2460, 0x2776, 0x2780, 0x278a][Math.floor((n - 172) / 10)]! + ((n - 172) % 10)));
    return;
  }
  const tex = DINGS[n];
  if (tex) p.emit(sink, { t: "Math", tex, pos: p.pos(tok) });
  else p.emit(sink, { t: "Math", tex: "\\bullet", pos: p.pos(tok) });
});

// ------------------------------------------------------------ chemfig

/**
 * \chemfig{H_3C-CH_2-OH}: a chain without rings or branches is set as its
 * formula, as mhchem would; a structure with rings or branches cannot be
 * drawn, so its formula source is shown and the approximation reported.
 */
on("chemfig", (p, sink, tok) => {
  p.consumeStar();
  p.readOptRaw();
  const src = (p.readArgRaw(tok)?.text ?? "").trim();
  if (!src) return;
  const chain = !/[*()<>@]/.test(src);
  if (chain) {
    const ce = src
      .replace(/\[[^\]]*\]/g, "")
      .replace(/[_^]\{([^{}]*)\}/g, "$1")
      .replace(/_(\w)/g, "$1")
      .replace(/~/g, "#")
      .replace(/\s+/g, "");
    p.emit(sink, { t: "Math", tex: `\\ce{${ce}}`, pos: p.pos(tok) });
    return;
  }
  approximated(p, tok, "chemfig structures with rings or branches are not drawn; the formula source is shown", "Draw the structure as an SVG or PNG and include it with \\includegraphics");
  p.emit(sink, { t: "Code", text: src });
});
on("arrow", (p, sink, tok) => {
  p.skipSpace();
  if (p.toks[p.i]?.type === "open") p.readArgRaw(tok);
  p.readOptRaw();
  p.readOptRaw();
  p.space(sink);
  p.emit(sink, { t: "Math", tex: "\\longrightarrow", pos: p.pos(tok) });
  p.space(sink);
});




// ------------------------------------------------------------ odds and ends

/** makecell's \makecell{a \\ b} and \thead: the lines of a cell, run together (table cells hold one line). */
on("makecell thead makegapedcells", (p, sink, tok) => {
  p.readOptRaw();
  const content = p.parseArgInlines(tok).map((x) => (x.t === "LineBreak" ? text(" ") : x));
  const out = trimInlines(content);
  if (tok.value === "thead") p.emit(sink, { t: "Strong", content: out });
  else for (const x of out) p.emit(sink, x);
});

/** amsthm's and llncs's \qed in running text: the end-of-proof box at the right margin. */
on("qed", (p, sink, tok) => {
  // The proof environment already ends with the box.
  if (p.open.some((o) => o.kind === "env" && o.name === "proof")) return;
  p.space(sink);
  p.emit(sink, { t: "Span", attr: { classes: ["hfill"] }, content: [] });
  p.emit(sink, { t: "Math", tex: "\\square", pos: p.pos(tok) });
});

/** biblatex's \citetitle{key}: the work is cited as a citation, its title not being known at this point. */
on("citetitle Citetitle citeurl citenum", (p, sink, tok) => {
  p.consumeStar();
  p.readOptRaw();
  p.readOptRaw();
  const keys = arg(p, tok).split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length) p.emit(sink, { t: "Cite", items: keys.map((key) => ({ key })), mode: "paren", pos: p.pos(tok) });
});

/** The exam class's \fillin[answer][width]: a blank line, or the underlined answer when answers are printed. */
on("fillin", (p, sink) => {
  const answer = p.readOptRaw();
  const width = p.readOptRaw()?.text.trim() || "1in";
  const shown = answer && CONDITIONALS.get(p)?.get("ifprintanswers") === true;
  if (shown) {
    p.emit(sink, { t: "Underline", content: trimInlines(p.parseString(answer!.text, answer!.tok)) });
    return;
  }
  p.emit(sink, { t: "Span", attr: { classes: ["rule"], attrs: { width: cssLength(width), height: "0.4pt" } }, content: [] });
});

/** Whether a \centering was seen since the flag was last cleared, per parser (for the titlepage environment). */
const CENTERED = new WeakMap<object, boolean>();
on("centering", (p) => {
  CENTERED.set(p, true);
});

/** The titlepage environment: its own page, centred when it says \centering. */
env("titlepage", (p, sink, tok, name) => {
  const saved = CENTERED.get(p) ?? false;
  CENTERED.set(p, false);
  const blocks = envBlocks(p, tok, name);
  const centred = CENTERED.get(p) === true;
  CENTERED.set(p, saved);
  if (centred) p.block(sink, { t: "Div", attr: { classes: ["center"] }, blocks, pos: p.pos(tok) });
  else for (const b of blocks) p.block(sink, b);
  p.block(sink, { t: "PageBreak", pos: p.pos(tok) });
});
