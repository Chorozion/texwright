/** Text-mode command handlers. Each runs after its command token has been consumed. */

import type { Block, CiteItem, Inline, TableCell } from "../../ast.js";
import { crefGroup, plainText, slugify } from "../../ast.js";
import { closestFix } from "../../fixes.js";
import { CONDITIONALS, LETTER, LEVEL, SIZES, docInfo, drawingError, isChar, keyVals, type Decl, type Heading, type Note, type Sink, type Target, type TheoremDef } from "./base.js";
import { beginEnv, codeBlock, makeFigure } from "./envs.js";
import { tikzFromLatex } from "../../tikz/latex.js";
import { pstricksFromLatex } from "../../pstricks/latex.js";
import type { Token } from "./lexer.js";
import type { Parser } from "./parser.js";
import { ACCENTS, SYMBOLS, accent, cssLength, plainString, today, trimInlines, trimMath, unescapeUrl } from "./text.js";

export type Handler = (p: Parser, sink: Sink, tok: Token) => void;

const H = new Map<string, Handler>();
/** Register a handler for each of the space-separated command names. */
export function on(names: string, h: Handler): void {
  for (const n of names.split(" ")) H.set(n, h);
}

/** Run the handler for `tok`; false when the command is unknown. */
export function runCommand(p: Parser, sink: Sink, tok: Token): boolean {
  const name = tok.value;
  const h = H.get(name);
  if (h) h(p, sink, tok);
  else if (Object.hasOwn(ACCENTS, name)) accentCmd(p, sink, tok);
  else if (Object.hasOwn(SYMBOLS, name)) p.emitText(sink, SYMBOLS[name]);
  else if (Object.hasOwn(IGNORE, name)) skipArgs(p, tok, IGNORE[name]);
  else if (Object.hasOwn(PASS, name)) skipArgs(p, tok, PASS[name]);
  else return false;
  return true;
}

/** True when the reader handles `name` itself (not counting the document's macros). */
export function isKnownCommand(name: string): boolean {
  return H.has(name) || Object.hasOwn(ACCENTS, name) || Object.hasOwn(SYMBOLS, name) || Object.hasOwn(IGNORE, name) || Object.hasOwn(PASS, name);
}

/** Every command the reader knows, for suggestions. */
export function commandNames(): string[] {
  return [...H.keys(), ...Object.keys(ACCENTS), ...Object.keys(SYMBOLS), ...Object.keys(IGNORE), ...Object.keys(PASS)];
}

let known: string[] | undefined;
const suggested = new Map<string, ReturnType<typeof closestFix>>();

/**
 * The known command closest to an unknown one, if there is a clear winner.
 * Answers for the built-in names are remembered (a document may hold the
 * same unknown command thousands of times, each in its own fragment).
 */
export function suggestCommand(name: string, macros: Iterable<string>): ReturnType<typeof closestFix> {
  const own = [...macros];
  if (own.length) return closestFix(name, [...(known ??= commandNames()), ...own]);
  if (suggested.has(name)) return suggested.get(name);
  const near = closestFix(name, (known ??= commandNames()));
  if (suggested.size > 5000) suggested.clear();
  suggested.set(name, near);
  return near;
}

/** Consume arguments by signature: s = optional star, o = optional [arg], m = mandatory {arg}. */
function skipArgs(p: Parser, tok: Token, sig: string): void {
  for (const c of sig) {
    if (c === "s") p.consumeStar();
    else if (c === "o") p.readOptRaw();
    else p.readArgRaw(tok);
  }
}

/** Commands accepted and dropped, with the arguments they take. */
const IGNORE: Record<string, string> = {
  RequirePackage: "omo",
  maketitle: "",
  centering: "",
  raggedright: "",
  raggedleft: "",
  indent: "",
  vfill: "",
  smallskip: "",
  medskip: "",
  bigskip: "",
  linebreak: "o",
  nolinebreak: "o",
  nopagebreak: "o",
  addtolength: "mm",
  settowidth: "mm",
  pagestyle: "m",
  thispagestyle: "m",
  pagenumbering: "m",
  includeonly: "m",
  theoremstyle: "m",
  vspace: "sm",
  hyphenation: "m",
  graphicspath: "m",
  hypersetup: "m",
  protect: "",
  relax: "",
  frenchspacing: "",
  sloppy: "",
  fussy: "",
  onecolumn: "",
  twocolumn: "o",
  listoffigures: "",
  listoftables: "",
  phantomsection: "",
  FloatBarrier: "",
  allowbreak: "",
  leavevmode: "",
  selectlanguage: "m",
  captionsetup: "om",
  lstset: "m",
  lstdefinestyle: "mm",
  setminted: "om",
  usetikzlibrary: "m",
  usepgfplotslibrary: "m",
  tikzset: "m",
  forestset: "m",
  useforestlibrary: "om",
  usegdlibrary: "m",
  pgfplotsset: "m",
  tdplotsetmaincoords: "mm",
  addcontentsline: "mmm",
  markboth: "mm",
  markright: "m",
  newlength: "m",
  titlecontents: "mommmo",
  titlelabel: "m",
  DeclareGraphicsExtensions: "m",
  urlstyle: "m",
  linespread: "m",
  setstretch: "m",
  doublespacing: "",
  onehalfspacing: "",
  singlespacing: "",
  ignorespaces: "",
  strut: "",
  hline: "",
  toprule: "o",
  midrule: "o",
  bottomrule: "o",
  cline: "m",
  addlinespace: "o",
  endhead: "",
  endfirsthead: "",
  endfoot: "",
  endlastfoot: "",
  qedhere: "",
  makeatletter: "",
  makeatother: "",
  setlist: "om",
  newcolumntype: "mom",
  index: "m",
  glossary: "m",
  nomenclature: "om",
  rowcolor: "om",
  cellcolor: "om",
  arrayrulecolor: "om",
  enlargethispage: "sm",
  balance: "",
  pagecolor: "om",
  phantom: "m",
  hphantom: "m",
  vphantom: "m",
  sisetup: "m",
  // exam class layout and styling
  pointsinmargin: "",
  pointsinrightmargin: "",
  nopointsinmargin: "",
  bracketedpoints: "",
  boxedpoints: "",
  addpoints: "",
  noaddpoints: "",
  unframedsolutions: "",
  framedsolutions: "",
  shadedsolutions: "",
  SolutionEmphasis: "m",
  CorrectChoiceEmphasis: "m",
  pointname: "m",
  pointformat: "m",
  qformat: "m",
  firstpageheader: "mmm",
  runningheader: "mmm",
  firstpagefooter: "mmm",
  runningfooter: "mmm",
  header: "mmm",
  footer: "mmm",
  runningheadrule: "",
  firstpageheadrule: "",
  runningfootrule: "",
  firstpagefootrule: "",
  extraheadheight: "om",
  extrafootheight: "om",
  fillwithlines: "m",
  fillwithdottedlines: "m",
  makeemptybox: "m",
  droppoints: "",
  droptotalpoints: "",
  hqword: "m",
  hpword: "m",
  hsword: "m",
  htword: "m",
  vqword: "m",
  vpword: "m",
  vsword: "m",
  vtword: "m",
  AtBeginDocument: "m",
  // layout, fonts and styling from packages and classes models load: accepted and dropped
  columnbreak: "",
  justifying: "",
  RaggedRight: "",
  RaggedLeft: "",
  Centering: "",
  raggedbottom: "",
  flushbottom: "",
  raggedcolumns: "",
  bigbreak: "",
  medbreak: "",
  smallbreak: "",
  goodbreak: "",
  filbreak: "",
  nobreak: "",
  null: "",
  vfil: "",
  addvspace: "m",
  allowdisplaybreaks: "o",
  newgeometry: "m",
  restoregeometry: "",
  nopagecolor: "",
  fancyhf: "o",
  fancyhead: "om",
  fancyfoot: "om",
  lhead: "om",
  chead: "om",
  rhead: "om",
  lfoot: "om",
  cfoot: "om",
  rfoot: "om",
  fancypagestyle: "mm",
  setmathfont: "om",
  newfontfamily: "mom",
  setCJKmainfont: "om",
  defaultfontfeatures: "m",
  DeclareUnicodeCharacter: "mm",
  DeclareCaptionFormat: "mm",
  DeclareCaptionLabelFormat: "mm",
  DeclareCaptionLabelSeparator: "mm",
  DeclareFloatingEnvironment: "om",
  newfloat: "mmmo",
  floatstyle: "m",
  restylefloat: "m",
  floatname: "mm",
  pdfbookmark: "omm",
  bookmark: "om",
  AtEndDocument: "m",
  setul: "mm",
  setulcolor: "m",
  setstcolor: "m",
  sethlcolor: "m",
  soulregister: "mm",
  tcbuselibrary: "m",
  tcbset: "m",
  mdfdefinestyle: "mm",
  mdfsetup: "m",
  listoftodos: "o",
  lstlistoflistings: "",
  listoflistings: "",
  listofalgorithms: "",
  makeglossaries: "",
  makenoidxglossaries: "",
  loadglsentries: "om",
  setglossarystyle: "m",
  glsresetall: "",
  glsreset: "m",
  acresetall: "",
  acused: "m",
  makenomenclature: "",
  printnomenclature: "o",
  linenumbers: "o",
  nolinenumbers: "",
  modulolinenumbers: "so",
  // algorithm2e styling
  SetAlgoNoLine: "",
  SetAlgoVlined: "",
  SetAlgoNoEnd: "",
  DontPrintSemicolon: "",
  PrintSemicolon: "",
  LinesNotNumbered: "",
  SetAlCapFnt: "m",
  SetAlCapNameFnt: "m",
  SetAlFnt: "m",
  SetKwSty: "m",
  SetFuncSty: "m",
  SetFuncArgSty: "m",
  SetProgSty: "m",
  SetCommentSty: "m",
  SetArgSty: "m",
  SetDataSty: "m",
  SetNlSty: "mmm",
  SetAlgoCaptionSeparator: "m",
  SetAlgorithmName: "mmm",
  SetAlgoProcName: "mm",
  SetAlgoFuncName: "mm",
  IncMargin: "m",
  DecMargin: "m",
  SetInd: "mm",
  ResetInOut: "m",
  SetNoFillComment: "",
  SetFillComment: "",
  SetSideCommentLeft: "",
  SetSideCommentRight: "",
  SetAlgoSkip: "m",
  SetAlgoInsideSkip: "m",
  SetAlgoNlRelativeSize: "m",
  SetEndCharOfAlgoLine: "m",
  SetAlgoShortEnd: "",
  SetAlgoLongEnd: "",
  nl: "",
  lnl: "m",
  // document classes: moderncv, IEEEtran, revtex, elsarticle, amsart, llncs, KOMA-Script, memoir, beamer
  moderncvstyle: "om",
  moderncvcolor: "m",
  moderncvtheme: "om",
  moderncvicons: "m",
  photo: "oom",
  nopagenumbers: "",
  recomputelengths: "",
  IEEEoverridecommandlockouts: "",
  IEEEpeerreviewmaketitle: "",
  IEEEpubid: "m",
  IEEEpubidadjcol: "",
  IEEEtriggeratref: "m",
  IEEEmembership: "m",
  IEEEcompsocitemizethanks: "m",
  IEEEdisplaynontitleabstractindextext: "",
  pacs: "m",
  preprint: "m",
  journal: "m",
  corref: "m",
  fnref: "m",
  cortext: "om",
  fntext: "om",
  ead: "om",
  subjclass: "om",
  dedicatory: "m",
  curraddr: "m",
  urladdr: "m",
  translator: "m",
  titlerunning: "m",
  authorrunning: "m",
  orcidID: "m",
  orcid: "m",
  tocauthor: "m",
  toctitle: "m",
  KOMAoptions: "m",
  setkomafont: "mm",
  addtokomafont: "mm",
  subject: "m",
  publishers: "m",
  dedication: "m",
  extratitle: "m",
  titlehead: "m",
  uppertitleback: "m",
  lowertitleback: "m",
  ihead: "om",
  ohead: "om",
  ifoot: "om",
  ofoot: "om",
  automark: "om",
  pagemark: "",
  chapterstyle: "m",
  maxsecnumdepth: "m",
  setlrmarginsandblock: "mmm",
  setulmarginsandblock: "mmm",
  checkandfixthelayout: "o",
  pretitle: "m",
  posttitle: "m",
  preauthor: "m",
  postauthor: "m",
  predate: "m",
  postdate: "m",
  usetheme: "om",
  usecolortheme: "om",
  usefonttheme: "om",
  useinnertheme: "om",
  useoutertheme: "om",
  setbeamertemplate: "mom",
  setbeamercolor: "mm",
  setbeamerfont: "mm",
  setbeamersize: "m",
  beamertemplatenavigationsymbolsempty: "",
  titlepage: "",
  logo: "m",
  titlegraphic: "m",
  AtBeginSection: "om",
  AtBeginSubsection: "om",
  pause: "o",
  note: "om",
  setchemfig: "m",
  setatomsep: "m",
  setbondoffset: "m",
  schemestart: "",
  schemestop: "",
};

/** Commands that keep their content: the leading arguments listed are dropped and the content group is parsed as usual. */
const PASS: Record<string, string> = {
  textrm: "",
  textsf: "",
  textup: "",
  textmd: "",
  textnormal: "",
  mbox: "",
  hbox: "",
  text: "",
  fbox: "",
  colorbox: "om",
  fcolorbox: "omm",
  framebox: "oo",
  makebox: "oo",
  parbox: "ooom",
  raisebox: "moo",
  resizebox: "smm",
  scalebox: "mo",
  rotatebox: "om",
  foreignlanguage: "om",
  hyperlink: "m",
  hypertarget: "m",
  hyperref: "o",
  smash: "o",
  multicolumn: "mm",
  multirow: "omom",
  shortstack: "o",
  centerline: "",
  reflectbox: "",
  textls: "o",
  SetProtrusion: "omm",
  SetExpansion: "omm",
  SetTracking: "omm",
  SetExtraKerning: "omm",
  SetExtraSpacing: "omm",
  DisableLigatures: "om",
  UseMicrotypeSet: "om",
  DeclareMicrotypeSet: "som",
  DeclareMicrotypeAlias: "mm",
  microtypecontext: "m",
  tcbox: "o",
  hl: "",
  IEEEauthorblockN: "",
  IEEEPARstart: "",
  chemname: "o",
};

// ------------------------------------------------------------ text styles

const WRAP: Record<string, (c: Inline[]) => Inline> = {
  emph: (c) => ({ t: "Emph", content: c }),
  textit: (c) => ({ t: "Emph", content: c }),
  textsl: (c) => ({ t: "Emph", content: c }),
  textbf: (c) => ({ t: "Strong", content: c }),
  underline: (c) => ({ t: "Underline", content: c }),
  uline: (c) => ({ t: "Underline", content: c }),
  sout: (c) => ({ t: "Strike", content: c }),
  ul: (c) => ({ t: "Underline", content: c }),
  uuline: (c) => ({ t: "Underline", content: c }),
  uwave: (c) => ({ t: "Underline", content: c }),
  dashuline: (c) => ({ t: "Underline", content: c }),
  dotuline: (c) => ({ t: "Underline", content: c }),
  underbar: (c) => ({ t: "Underline", content: c }),
  st: (c) => ({ t: "Strike", content: c }),
  xout: (c) => ({ t: "Strike", content: c }),
  textsc: (c) => ({ t: "SmallCaps", content: c }),
  textsuperscript: (c) => ({ t: "Superscript", content: c }),
  textsubscript: (c) => ({ t: "Subscript", content: c }),
  texttt: (c) => ({ t: "Code", text: plainText(c) }),
};
for (const [name, wrap] of Object.entries(WRAP)) {
  on(name, (p, sink, tok) => {
    const content = p.parseArgInlines(tok);
    if (content.length) p.emit(sink, wrap(content));
  });
}

const DECLS: Record<string, Decl> = {
  em: "emph",
  itshape: "emph",
  it: "emph",
  slshape: "emph",
  sl: "emph",
  bfseries: "strong",
  bf: "strong",
  ttfamily: "code",
  tt: "code",
  scshape: "smallcaps",
  sc: "smallcaps",
};
for (const [name, d] of Object.entries(DECLS)) {
  on(name, (p) => {
    if (!p.decls.includes(d)) p.decls.push(d);
  });
}

// Size switches replace one another; \normalsize ends them.
for (const size of SIZES) {
  on(size, (p) => {
    p.decls = [...p.decls.filter((d) => !(SIZES as readonly string[]).includes(d)), size];
  });
}
on("normalsize", (p) => {
  p.decls = p.decls.filter((d) => !(SIZES as readonly string[]).includes(d));
});

const UNDECLS: Record<string, Decl[]> = {
  upshape: ["emph"],
  mdseries: ["strong"],
  rmfamily: ["code"],
  sffamily: ["code"],
  rm: ["code"],
  sf: ["code"],
  normalfont: ["emph", "strong", "code", "smallcaps"],
};
for (const [name, ds] of Object.entries(UNDECLS)) {
  on(name, (p) => {
    p.decls = p.decls.filter((d) => !ds.includes(d));
  });
}

/** csquotes: \enquote{x} in double quotes, \enquote*{x} in single ones. */
on("enquote", (p, sink, tok) => {
  const single = p.consumeStar();
  const content = p.parseArgInlines(tok);
  p.emitText(sink, single ? "\u2018" : "\u201c");
  for (const x of content) p.emit(sink, x);
  p.emitText(sink, single ? "\u2019" : "\u201d");
});

function accentCmd(p: Parser, sink: Sink, tok: Token): void {
  p.skipSpace();
  const t = p.toks[p.i];
  let arg = "";
  if (t?.type === "open") arg = p.readArgRaw(tok)?.text ?? "";
  else if (t?.type === "text") {
    p.splitFirst(p.i);
    arg = p.toks[p.i++].value;
  } else if (t?.type === "cmd") {
    p.i++;
    arg = "\\" + t.value;
  }
  p.emitText(sink, accent(tok.value, arg));
}

// ------------------------------------------------------------ spacing and breaks

on("\\", (p, sink) => {
  p.consumeStar();
  p.readOptRaw();
  p.emit(sink, { t: "LineBreak" });
});
on("newline", (p, sink) => p.emit(sink, { t: "LineBreak" }));
on("par", (p, sink) => p.par(sink));
H.set(" ", (p, sink) => {
  p.emit(sink, { t: "Text", text: " " });
  sink.spaced = true;
});
on("hspace", (p, sink, tok) => {
  p.consumeStar();
  p.readArgRaw(tok);
  p.space(sink);
});
/** \hfill: space that stretches to push what follows to the right margin ("Title \hfill 2021--2024"). */
on("hfill hfil hss", (p, sink) => {
  p.space(sink);
  p.emit(sink, { t: "Span", attr: { classes: ["hfill"] }, content: [] });
});
on("newpage clearpage cleardoublepage pagebreak", (p, sink, tok) => {
  if (tok.value === "pagebreak") p.readOptRaw();
  p.block(sink, { t: "PageBreak", pos: p.pos(tok) });
});
on("today", (p, sink) => p.emitText(sink, today()));

// ------------------------------------------------------------ math

on("(", (p, sink, tok) => p.inlineMath(sink, tok, (t) => t.type === "cmd" && t.value === ")", "\\)"));
on("[", (p, sink, tok) => p.bracketMath(sink, tok));
on(") ]", (p, _sink, tok) => {
  p.diag("LTX003", `\\${tok.value} without an opening \\${tok.value === ")" ? "(" : "["}`, tok, "Remove it or open the math before it");
});
on("ensuremath", (p, sink, tok) => {
  const a = p.readArgRaw(tok);
  if (a) p.emit(sink, { t: "Math", tex: trimMath(a.text), pos: p.pos(tok) });
});

/** siunitx and mhchem in running text: typeset as math, which handles them. Signatures as for skipArgs. */
const UNIT_COMMANDS: Record<string, string> = {
  SI: "omom",
  si: "om",
  unit: "om",
  num: "om",
  tablenum: "om",
  qty: "omm",
  ang: "om",
  numrange: "omm",
  SIrange: "ommm",
  qtyrange: "ommm",
  numlist: "om",
  SIlist: "omm",
  qtylist: "omm",
  ce: "m",
  pu: "m",
  degree: "",
  celsius: "",
  degreeCelsius: "",
  ohm: "",
};
for (const [name, sig] of Object.entries(UNIT_COMMANDS)) {
  on(name, (p, sink, tok) => {
    let tex = `\\${name}`;
    for (const c of sig) {
      if (c === "o") {
        const o = p.readOptRaw();
        if (o) tex += `[${o.text}]`;
      } else {
        const a = p.readArgRaw(tok);
        if (!a) return;
        tex += `{${a.text}}`;
      }
    }
    p.emit(sink, { t: "Math", tex, pos: p.pos(tok) });
  });
}

// ------------------------------------------------------------ structure and metadata

on(Object.keys(LEVEL).join(" "), (p, sink, tok) => {
  const star = p.consumeStar();
  p.readOptRaw();
  const target: Target = { kind: "heading" };
  p.targets.push(target);
  let content = trimInlines(p.parseArgInlines(tok));
  p.targets.pop();
  // \part has its own counter in Roman numerals, apart from the chapters or sections it holds.
  const part = tok.value === "part" && !star;
  if (part) {
    const n = (counters(p).get("part") ?? 0) + 1;
    counters(p).set("part", n);
    content = [{ t: "Text", text: `Part ${formatCount(n, "Roman")}: ` }, ...content];
  }
  const node: Heading = {
    t: "Heading",
    level: LEVEL[tok.value] as Heading["level"],
    content,
    // As in LaTeX's article class, \paragraph and below are unnumbered unless secnumdepth says otherwise.
    numbered: !star && !part && tok.value !== "addchap" && tok.value !== "addsec" && LEVEL[tok.value]! <= (counters(p).get("secnumdepth") ?? 3) && !UNNUMBERED.get(p)?.has(tok.value) && !docInfo(p).unnumberedMatter,
    pos: p.pos(tok),
  };
  if (target.label) {
    node.label = target.label;
    node.id = slugify(target.label);
  }
  p.sections.push({ node, cmd: tok.value, appendix: p.appendix });
  p.block(sink, node);
});

on("appendix", (p) => {
  p.appendix = true;
});
on("tableofcontents", (p, sink, tok) => {
  p.readOptRaw(); // beamer's [currentsection] and similar
  p.block(sink, { t: "TOC", pos: p.pos(tok) });
});

on("title", (p, _sink, tok) => {
  p.readOptRaw();
  const content = trimInlines(p.parseArgInlines(tok));
  // IEEEtran's template writes "Title\\ \thanks{...}": the mark belongs on the title's last line, not one of its own.
  for (let k = content.length - 1; k >= 0; k--) {
    const x = content[k]!;
    if (x.t === "LineBreak") {
      if (content.slice(k + 1).every((y) => y.t === "Note" || y.t === "SoftBreak" || (y.t === "Text" && !y.text.trim()))) content.splice(k, 1);
      break;
    }
    if (x.t !== "Note" && x.t !== "SoftBreak" && !(x.t === "Text" && !x.text.trim())) break;
  }
  // moderncv's \title is the job title, set under the name.
  if (docInfo(p).cls === "moderncv") p.meta.subtitle = content;
  else p.meta.title = content;
});
on("subtitle", (p, _sink, tok) => {
  p.meta.subtitle = trimInlines(p.parseArgInlines(tok));
});
on("date", (p, _sink, tok) => {
  p.meta.date = trimInlines(p.parseArgInlines(tok));
});

/** Marks an \and inside \author; never leaves this module. */
export const AND: Inline = { t: "RawInline", format: "latex", text: "\\and" };

/**
 * \author{A \and B}. The optional argument holds affiliation keys (authblk's
 * \author[1,2]{...}, elsarticle's \author[inst1]{...}); inside the name, llncs's
 * \inst{1} adds keys and IEEEtran's \IEEEauthorblockA gives the affiliation itself.
 */
on("author", (p, _sink, tok) => {
  // beamer's optional argument is a short form of the names, not affiliation keys.
  const opt = p.readOptRaw()?.text;
  const keys = docInfo(p).cls === "beamer" ? undefined : opt;
  const saved = p.authorMode;
  p.authorMode = true;
  const content = p.parseArgInlines(tok);
  p.authorMode = saved;
  const authors: Inline[][] = [[]];
  for (const x of content) {
    if (x === AND) authors.push([]);
    else authors[authors.length - 1].push(x);
  }
  for (const a of authors) {
    const name: Inline[] = [];
    const affil: Inline[] = [];
    const own = keys ? keys.split(",").map((k) => k.trim()).filter(Boolean) : [];
    for (const x of a) {
      if (x.t === "Span" && x.attr.classes?.includes(AFFIL_MARK)) affil.push(...(affil.length ? [{ t: "LineBreak" } as Inline] : []), ...trimInlines(x.content));
      else if (x.t === "Span" && x.attr.classes?.includes(KEYS_MARK)) own.push(...(x.attr.attrs?.keys ?? "").split(",").map((k) => k.trim()).filter(Boolean));
      else name.push(x);
    }
    const c = trimInlines(name);
    if (!c.length) continue;
    (p.meta.author ??= []).push(c);
    const info = docInfo(p);
    info.authorKeys.push(own);
    if (affil.length) setAffiliation(p, p.meta.author.length - 1, affil);
  }
});

/** Span classes that carry an affiliation or affiliation keys from inside \author to its handler. */
export const AFFIL_MARK = "tw-affiliation";
export const KEYS_MARK = "tw-affiliation-keys";

/** Inline content with the spaces next to each line break removed, as for a title-page block. */
export function trimLines(xs: Inline[]): Inline[] {
  const lines: Inline[][] = [[]];
  for (const x of xs) {
    if (x.t === "LineBreak") lines.push([]);
    else lines[lines.length - 1]!.push(x);
  }
  const out: Inline[] = [];
  for (const l of lines.map(trimInlines).filter((l) => l.length)) out.push(...(out.length ? [{ t: "LineBreak" } as Inline] : []), ...l);
  return out;
}

/** Give author `k` an affiliation, keeping the list as long as the author list. */
export function setAffiliation(p: Parser, k: number, content: Inline[] | null): void {
  const n = p.meta.author?.length ?? 0;
  const list = (p.meta.affiliation ??= []);
  while (list.length < n) list.push(null);
  list[k] = content ? trimLines(content) : null;
}
on("and", (p, sink) => {
  if (!p.authorMode) {
    p.emitText(sink, " and ");
    return;
  }
  sink.para.push(AND);
  sink.spaced = true;
});

on("keywords", (p, _sink, tok) => {
  const a = p.readArgRaw(tok);
  if (!a) return;
  const words = a.text
    .split(/,|;|\\sep\b|\\and\b/)
    .map((w) => plainString(p.parseString(w, a.tok)))
    .filter(Boolean);
  p.meta.keywords = [...(p.meta.keywords ?? []), ...words];
});
on("abstract", (p, _sink, tok) => {
  p.meta.abstract = [...(p.meta.abstract ?? []), ...p.parseArgBlocks(tok)];
});

/** Layout requests go to meta.extra under pandoc's front matter names, where src/layoutopts.ts reads them. */
function layoutExtra(p: Parser): Record<string, unknown> {
  return (p.meta.extra ??= {});
}

/**
 * fontspec's \setmainfont{Inter}[Path=fonts/, BoldFont=Inter-Bold.ttf] (or the older
 * \setmainfont[...]{Inter}), and \setsansfont and \setmonofont: stored under pandoc's
 * mainfont, sansfont and monofont keys, which the page layout reads (src/typeset/brandfonts.ts).
 */
on("setmainfont setsansfont setmonofont", (p, _sink, tok) => {
  const before = p.readOptRaw();
  const name = p.readArgRaw(tok)?.text.trim();
  const after = p.readOptRaw();
  if (!name) return;
  const key = tok.value === "setmainfont" ? "mainfont" : tok.value === "setsansfont" ? "sansfont" : "monofont";
  const extra = layoutExtra(p);
  extra[key] = name;
  const options = [before?.text, after?.text].filter((o): o is string => !!o && !!o.trim()).join(",");
  if (options) extra[`${key}options`] = options;
});

/** \setlength{\parindent}{0pt} and \setlength{\parskip}{6pt}: paragraph shape, for the page layout. Other lengths are ignored. */
on("setlength", (p, _sink, tok) => {
  const name = p.readArgRaw(tok)?.text.trim();
  const value = p.readArgRaw(tok)?.text.trim();
  if (!value) return;
  // "6pt plus 2pt minus 1pt": the natural size is enough.
  const natural = value.split(/\s+(?:plus|minus)\s+/)[0]!.trim();
  if (name === "\\parindent") layoutExtra(p).parindent = natural;
  else if (name === "\\parskip") layoutExtra(p).parskip = natural;
});

// \documentclass[12pt,a4paper,landscape]{article}: the body size, the paper and the orientation.
on("documentclass", (p, _sink, tok) => {
  const opts = p.readOptRaw();
  const cls = p.readArgRaw(tok)?.text.trim();
  if (cls) docInfo(p).cls = cls;
  // A CV sets its lines flush left; KOMA-Script's parskip option spaces paragraphs instead of indenting them.
  if (cls === "moderncv") layoutExtra(p).parindent = "0pt";
  if (opts && /(^|,)\s*parskip\s*(=\s*(half|full|true)\S*)?\s*(,|$)/.test(opts.text)) Object.assign(layoutExtra(p), { parindent: "0pt", parskip: "6pt" });
  if (opts) for (const o of opts.text.split(",")) docInfo(p).classOptions.add(o.trim());
  if (!opts) return;
  const x = layoutExtra(p);
  for (const o of opts.text.split(",").map((s) => s.trim())) {
    if (/^\d+(\.\d+)?pt$/.test(o)) x.fontsize = o;
    else if (/^(a4|a5|b5|letter|legal)paper$/.test(o)) x.papersize = o.replace(/paper$/, "");
    else if (o === "landscape") x.landscape = true;
    else if (o === "answers") flags(p).set("ifprintanswers", true);
  }
});

// \geometry{margin=1in}, also given as \usepackage[margin=1in]{geometry} below.
on("geometry", (p, _sink, tok) => {
  const arg = p.readArgRaw(tok);
  if (arg) layoutExtra(p).geometry = arg.text;
});

on("usepackage", (p, _sink, tok) => {
  const opts = p.readOptRaw();
  const pkgs = p.readArgRaw(tok);
  p.readOptRaw();
  for (const n of pkgs?.text.split(",") ?? []) docInfo(p).packages.add(n.trim());
  // The parskip package: space between paragraphs and no indent, unless the document says otherwise.
  if (pkgs?.text.split(",").some((n) => n.trim() === "parskip")) {
    const x = layoutExtra(p);
    x.parindent ??= "0pt";
    x.parskip ??= "6pt";
  }
  if (!opts || !pkgs) return;
  const names = pkgs.text.split(",").map((s) => s.trim());
  for (const o of opts.text.split(",")) for (const n of names) docInfo(p).packageOptions.add(`${n}:${o.trim()}`);
  if (names.includes("geometry")) layoutExtra(p).geometry = opts.text;
  // \usepackage[protrusion=true,expansion=false]{microtype}: microtype itself is on by default for justified text.
  if (names.includes("microtype")) layoutExtra(p).microtype = opts.text;
  // natbib's numbers option wins over an author-year \bibliographystyle such as plainnat.
  if (names.includes("natbib") && opts.text.split(",").some((o) => o.trim() === "numbers")) {
    p.meta.citationStyle = "numeric";
    p.natbibNumbers = true;
  }
  if (!names.includes("biblatex")) return;
  const kv = keyVals(opts.text);
  const style = kv.get("style") ?? kv.get("citestyle");
  if (style) p.meta.citationStyle = /^(authoryear|authortitle|apa|chicago|mla|ext-authoryear)/.test(style) ? "author-year" : "numeric";
});

// \microtypesetup{protrusion=false,expansion=false}: added to the package options.
on("microtypesetup", (p, _sink, tok) => {
  const arg = p.readArgRaw(tok)?.text.trim();
  if (!arg) return;
  const x = layoutExtra(p);
  x.microtype = typeof x.microtype === "string" && x.microtype ? `${x.microtype},${arg}` : arg;
});

on("numberwithin", (p, _sink, tok) => {
  p.readOptRaw();
  const what = p.readArgRaw(tok);
  const within = p.readArgRaw(tok);
  if (what?.text.trim() === "equation" && /^(section|chapter)$/.test(within?.text.trim() ?? "")) p.meta.numberWithin = 1;
});

// ------------------------------------------------------------ bibliography

const AUTHOR_YEAR = new Set([
  "plainnat",
  "abbrvnat",
  "apalike",
  "apa",
  "apacite",
  "chicago",
  "chicagoa",
  "authoryear",
  "harvard",
  "agsm",
  "dcu",
  "kluwer",
  "newapa",
  "jss",
  "spbasic",
  "aer",
  "aea",
]);

function addBib(p: Parser, name: string, ext?: string): void {
  let file = name.trim();
  if (!file) return;
  if (ext && !/\.[A-Za-z0-9]+$/.test(file)) file += ext;
  const list = (p.meta.bibliography ??= []);
  if (!list.includes(file)) list.push(file);
}

on("bibliography", (p, sink, tok) => {
  const a = p.readArgRaw(tok);
  if (!a) return;
  for (const f of a.text.split(",")) addBib(p, f, ".bib");
  p.block(sink, { t: "Bibliography", pos: p.pos(tok) });
});
on("addbibresource", (p, _sink, tok) => {
  p.readOptRaw();
  const a = p.readArgRaw(tok);
  if (a) addBib(p, a.text);
});
on("printbibliography", (p, sink, tok) => {
  p.readOptRaw();
  p.block(sink, { t: "Bibliography", pos: p.pos(tok) });
});
on("bibliographystyle", (p, _sink, tok) => {
  const a = p.readArgRaw(tok);
  if (a) p.meta.citationStyle = AUTHOR_YEAR.has(a.text.trim()) && !p.natbibNumbers ? "author-year" : "numeric";
});

// ------------------------------------------------------------ references, citations, notes, links

on("label", (p, sink, tok) => {
  const a = p.readArgRaw(tok);
  if (!a) return;
  const label = a.text.trim();
  if (!label) {
    p.diag("LTX005", "Empty \\label", tok, "Give the label a name, as in \\label{sec:intro}");
    return;
  }
  const top = p.targets[p.targets.length - 1];
  if (top && !top.label) {
    top.label = label;
    return;
  }
  if (top === undefined) {
    const last = sink.blocks[sink.blocks.length - 1];
    if (last?.t === "Heading" && !last.label && p.paraEmpty(sink)) {
      last.label = label;
      last.id = slugify(label);
      return;
    }
  }
  p.emit(sink, { t: "Span", attr: { id: label }, content: [], pos: p.pos(tok) });
});

type RefStyle = Extract<Inline, { t: "Ref" }>["style"];
const REFS: Record<string, RefStyle> = {
  ref: "number",
  labelcref: "number",
  eqref: "eq",
  pageref: "page",
  cpageref: "page",
  Cpageref: "page",
  autoref: "auto",
  cref: "auto",
  Cref: "auto",
  nameref: "auto",
  vref: "auto",
  Vref: "auto",
};
for (const [name, style] of Object.entries(REFS)) {
  on(name, (p, sink, tok) => {
    p.consumeStar();
    const a = p.readArgRaw(tok);
    if (!a) return;
    const labels = a.text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (name === "cref" || name === "Cref") {
      p.emit(sink, crefGroup(labels, name === "Cref", p.pos(tok)));
      return;
    }
    labels.forEach((label, k) => {
      if (k) p.emitText(sink, ", ");
      // The lastpage package's label: the number of pages.
      if (style === "page" && /^lastpage$/i.test(label)) p.emit(sink, { t: "Span", attr: { classes: ["numpages"] }, content: [] });
      else p.emit(sink, { t: "Ref", label, style, pos: p.pos(tok) });
    });
  });
}

type CiteMode = Extract<Inline, { t: "Cite" }>["mode"];
const CITES: Record<string, CiteMode> = {
  cite: "paren",
  citep: "paren",
  Citep: "paren",
  parencite: "paren",
  Parencite: "paren",
  autocite: "paren",
  Autocite: "paren",
  citealp: "paren",
  Citealp: "paren",
  smartcite: "paren",
  supercite: "paren",
  fullcite: "paren",
  citet: "text",
  Citet: "text",
  textcite: "text",
  Textcite: "text",
  citealt: "text",
  Citealt: "text",
  citeauthor: "author",
  Citeauthor: "author",
  citeyear: "year",
  citeyearpar: "year",
  citedate: "year",
  nocite: "nocite",
};

const LOCATOR =
  /^(?:[\u00a7\u00b6]+|(?:p|pp|pg|pgs|page|pages|ch|chs|chap|chaps|chapter|chapters|sec|secs|sect|section|sections|fig|figs|figure|figures|tab|tbl|table|tables|eq|eqs|eqn|equation|equations|vol|vols|volume|volumes|no|nos|nr|number|numbers|n|nn|note|notes|para|paras|paragraph|paragraphs|l|ll|line|lines|art|arts|article|articles|bk|bks|book|books|pt|pts|part|parts|v|vv|verse|verses|col|cols|column|columns|fol|fols|folio|folios|op|opus|thm|theorem|theorems|app|appendix|s\.\s?v)\b)/i;
const NUMBERS = /^(?:\d+|[ivxlcdm]+)[a-z]?(?:\s*[-\u2013\u2014,]\s*(?:\d+|[ivxlcdm]+)[a-z]?)*$/i;

function isLocator(s: string): boolean {
  return LOCATOR.test(s) || NUMBERS.test(s);
}

function cite(p: Parser, tok: Token, mode: CiteMode): Inline | undefined {
  p.consumeStar();
  const opts: { text: string; tok: Token }[] = [];
  for (let k = 0; k < 2; k++) {
    const o = p.readOptRaw();
    if (!o) break;
    opts.push(o);
  }
  const a = p.readArgRaw(tok);
  if (!a) return undefined;
  const keys = a.text
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) {
    p.diag("LTX005", `\\${tok.value} has no citation keys`, tok, `Write the keys in braces: \\${tok.value}{doe2020}`);
    return undefined;
  }
  const items: CiteItem[] = keys.map((key) => ({ key }));
  const text = (o: { text: string; tok: Token }): string => plainString(p.parseString(o.text, o.tok));
  const post = opts.length ? text(opts[opts.length - 1]) : "";
  const pre = opts.length === 2 ? text(opts[0]) : "";
  if (pre) items[0].prefix = pre;
  if (post) {
    const last = items[items.length - 1];
    if (isLocator(post)) last.locator = post;
    else last.suffix = post;
  }
  return { t: "Cite", items, mode, pos: p.pos(tok) };
}

for (const [name, mode] of Object.entries(CITES)) {
  on(name, (p, sink, tok) => {
    const c = cite(p, tok, mode);
    if (c) p.emit(sink, c);
  });
}
on("footcite footcitetext", (p, sink, tok) => {
  const c = cite(p, tok, "paren");
  if (c) p.emit(sink, { t: "Note", blocks: [{ t: "Plain", content: [c] }], pos: p.pos(tok) });
});

on("footnote thanks", (p, sink, tok) => {
  p.readOptRaw();
  p.emit(sink, { t: "Note", blocks: p.parseArgBlocks(tok), pos: p.pos(tok) });
});
on("footnotemark", (p, sink, tok) => {
  p.readOptRaw();
  const note: Note = { t: "Note", blocks: [], pos: p.pos(tok) };
  p.pendingMarks.push(note);
  p.emit(sink, note);
});
on("footnotetext", (p, sink, tok) => {
  p.readOptRaw();
  const blocks = p.parseArgBlocks(tok);
  const note = p.pendingMarks.shift();
  if (note) note.blocks = blocks;
  else p.emit(sink, { t: "Note", blocks, pos: p.pos(tok) });
});

function rawUrl(p: Parser, tok: Token): string | undefined {
  const t = p.toks[p.i];
  if (t?.type === "verb") {
    p.i++;
    return unescapeUrl(t.value);
  }
  const a = p.readArgRaw(tok);
  return a ? unescapeUrl(a.text) : undefined;
}

/**
 * The address a link goes to. \url and \href are web addresses, so a bare domain
 * ("linkedin.com/in/x", "www.example.org") gets https:// and a bare address gets mailto:,
 * as a reader would expect; the text shown stays as written.
 */
function linkTarget(url: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith("#") || url.startsWith("/") || url.startsWith(".")) return url;
  if (/^[^\s@/]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(url)) return `mailto:${url}`;
  const host = /^(www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})(?:[/?#:].*)?$/.exec(url);
  // A file next to the document ("report.pdf") is not a domain: only www. or a common top-level domain counts.
  if (host && (host[1] || WEB_TLDS.has(host[2]!.toLowerCase()))) return `https://${url}`;
  return url;
}
const WEB_TLDS = new Set("com org net edu gov mil int io dev ai co app me info biz xyz tech page site blog uk us ca au de fr nl es it se no dk fi ch at be pl cz ru cn jp kr in br mx nz ie eu".split(" "));

on("url", (p, sink, tok) => {
  const url = rawUrl(p, tok);
  if (url) p.emit(sink, { t: "Link", url: linkTarget(url), content: [{ t: "Text", text: url }], pos: p.pos(tok) });
});
on("href", (p, sink, tok) => {
  const url = rawUrl(p, tok);
  if (url === undefined) return;
  const content = p.parseArgInlines(tok);
  p.emit(sink, { t: "Link", url: linkTarget(url), content: content.length ? content : [{ t: "Text", text: url }], pos: p.pos(tok) });
});
on("nolinkurl", (p, sink, tok) => {
  const url = rawUrl(p, tok);
  if (url) p.emitText(sink, url);
});

// ------------------------------------------------------------ floats and graphics

on("includegraphics includesvg", (p, sink, tok) => {
  p.consumeStar();
  let opts = p.readOptRaw();
  if (p.readOptRaw()) opts = undefined; // the old [llx,lly][urx,ury] bounding-box form
  const a = p.readArgRaw(tok);
  if (!a) return;
  const svg = tok.value === "includesvg";
  let src = a.text.replace(/[{}]/g, "").trim();
  // The svg package's \includesvg{plot} means plot.svg.
  if (svg && !/\.[A-Za-z0-9]+$/.test(src)) src += ".svg";
  const img: Extract<Inline, { t: "Image" }> = { t: "Image", src, alt: [], pos: p.pos(tok) };
  const attrs: Record<string, string> = {};
  for (const [k, v] of keyVals(opts?.text ?? "")) {
    if (k === "width" || k === "height") img[k] = cssLength(v);
    else if (k !== "keepaspectratio" && !(svg && /^(inkscape|pretex|apptex|svgpath)/.test(k))) attrs[k] = v;
  }
  if (Object.keys(attrs).length) img.attr = { attrs };
  p.emit(sink, img);
});

function floatTarget(p: Parser): Target | undefined {
  const t = p.targets[p.targets.length - 1];
  return t && (t.kind === "figure" || t.kind === "table") ? t : undefined;
}

on("caption captionof", (p, sink, tok) => {
  const star = p.consumeStar();
  if (tok.value === "captionof") p.readArgRaw(tok);
  p.readOptRaw();
  const target = floatTarget(p);
  const content = trimInlines(p.parseArgInlines(tok));
  if (!target) {
    for (const x of content) p.emit(sink, x);
    return;
  }
  target.caption = content;
  if (star) target.unnumbered = true;
});

on("subfloat", (p, sink, tok) => {
  const target: Target = { kind: "figure" };
  p.targets.push(target);
  const caption = trimInlines(p.parseOptInlines() ?? []);
  if (caption.length) target.caption = caption;
  const content = trimInlines(p.parseArgInlines(tok));
  p.targets.pop();
  p.block(sink, makeFigure(p, [{ t: "Plain", content }], target, tok));
});

on("lstinputlisting", (p, sink, tok) => {
  const opts = p.readOptRaw();
  const a = p.readArgRaw(tok);
  if (!a) return;
  const path = a.text.trim();
  const text = p.ctx.readFile(path);
  if (text === undefined) {
    p.diag("IO002", `Listing file not found: ${path}`, tok, `Paths are resolved relative to ${p.ctx.baseDir}`);
    return;
  }
  p.block(sink, codeBlock(p, tok, text.replace(/\r\n?/g, "\n").replace(/\n$/, ""), keyVals(opts?.text ?? "")));
});

// ------------------------------------------------------------ definitions

function macroName(p: Parser, tok: Token): string | undefined {
  const a = p.readArgRaw(tok);
  if (!a) return undefined;
  const name = a.text.trim();
  if (/^\\(?:[A-Za-z@]+|.)$/.test(name)) return name;
  p.diag("LTX005", `\\${tok.value} expects a command name such as \\foo, not "${name}"`, tok, "Write the name with its backslash");
  return undefined;
}

function argCount(p: Parser, tok: Token, o: { text: string } | undefined): number {
  if (!o) return 0;
  const n = Number(o.text.trim());
  if (Number.isInteger(n) && n >= 0 && n <= 9) return n;
  p.diag("LTX005", `\\${tok.value}: the number of arguments must be 0 to 9, not "${o.text.trim()}"`, tok);
  return 0;
}

on("newcommand renewcommand providecommand DeclareRobustCommand", (p, _sink, tok) => {
  p.consumeStar();
  const name = macroName(p, tok);
  if (!name) return;
  const n = p.readOptRaw();
  const nargs = argCount(p, tok, n);
  const d = n ? p.readOptRaw() : undefined;
  const body = p.readArgRaw(tok);
  if (!body) return;
  const mode = tok.value === "renewcommand" ? "renew" : tok.value === "providecommand" ? "provide" : "new";
  p.defineMacro(name, d ? { nargs, dflt: d.text, body: body.text } : { nargs, body: body.text }, mode, tok);
});

on("def gdef edef xdef", (p, _sink, tok) => {
  const t = p.toks[p.i];
  if (t?.type !== "cmd") {
    p.diag("LTX005", `\\${tok.value} expects a command name`, tok);
    return;
  }
  p.i++;
  let nargs = 0;
  while (isChar(p.toks[p.i], "#") && p.toks[p.i + 1]?.type === "text") {
    p.splitFirst(p.i + 1);
    const n = Number(p.toks[p.i + 1].value);
    if (n >= 1 && n <= 9) nargs = Math.max(nargs, n);
    p.i += 2;
  }
  if (p.toks[p.i]?.type !== "open") {
    p.diag("LTX005", `\\${tok.value}\\${t.value}: only plain #1..#9 parameters are supported`, tok, "Use \\newcommand with braced arguments");
    while (p.i < p.toks.length && p.toks[p.i].type !== "open" && p.toks[p.i].type !== "par") p.i++;
  }
  const body = p.readArgRaw(tok);
  if (body) p.defineMacro("\\" + t.value, { nargs, body: body.text }, "new", tok);
});

on("let", (p, _sink, tok) => {
  const t = p.toks[p.i];
  if (t?.type !== "cmd") {
    p.diag("LTX005", "\\let expects a command name", tok);
    return;
  }
  p.i++;
  p.skipSpace();
  const eq = p.toks[p.i];
  if (eq?.type === "text" && eq.value.startsWith("=")) {
    p.splitFirst(p.i);
    p.i++;
    p.skipSpace();
  }
  const target = p.toks[p.i];
  if (target?.type !== "cmd") return;
  p.i++;
  p.defineMacro("\\" + t.value, p.macros.get(target.value) ?? { nargs: 0, body: "\\" + target.value }, "new", tok);
});

on("DeclareMathOperator", (p, _sink, tok) => {
  const star = p.consumeStar();
  const name = macroName(p, tok);
  const a = name ? p.readArgRaw(tok) : undefined;
  if (name && a) p.defineMacro(name, { nargs: 0, body: `\\operatorname${star ? "*" : ""}{${a.text}}` }, "new", tok);
});

on("DeclarePairedDelimiter", (p, _sink, tok) => {
  const name = macroName(p, tok);
  const l = name ? p.readArgRaw(tok) : undefined;
  const r = l ? p.readArgRaw(tok) : undefined;
  if (name && l && r) p.defineMacro(name, { nargs: 0, body: `\\twpaired{${l.text.trim()}}{${r.text.trim()}}` }, "new", tok);
});

/**
 * \DeclarePairedDelimiterX\inner[2]{\langle}{\rangle}{#1, #2}: delimiters around a
 * body with arguments. The parameters are kept as ##1 so the macro itself takes
 * none; the math engine's \twpairedx reads the star, the size and the arguments.
 */
on("DeclarePairedDelimiterX", (p, _sink, tok) => {
  const name = macroName(p, tok);
  const n = name ? Number(p.readOptRaw()?.text.trim() ?? "0") : 0;
  const l = name ? p.readArgRaw(tok) : undefined;
  const r = l ? p.readArgRaw(tok) : undefined;
  const body = r ? p.readArgRaw(tok) : undefined;
  if (!name || !l || !r || !body) return;
  const nargs = Number.isInteger(n) && n >= 0 && n <= 9 ? n : 0;
  p.defineMacro(name, { nargs: 0, body: `\\twpairedx{${nargs}}{${l.text.trim()}}{${r.text.trim()}}{${body.text.replace(/#(\d)/g, "##$1")}}` }, "new", tok);
});

/** siunitx's \DeclareSIUnit{\kNm}{\kilo\newton\metre}: a unit macro the unit commands expand. */
on("DeclareSIUnit", (p, _sink, tok) => {
  p.readOptRaw();
  const name = macroName(p, tok);
  const body = name ? p.readArgRaw(tok) : undefined;
  if (name && body) p.defineMacro(name, { nargs: 0, body: body.text.trim() }, "renew", tok);
});

/** fontawesome icons (\faPhone, \faIcon{envelope}): decoration, left out without a warning. */
on("faIcon faIconFA", (p, _sink, tok) => {
  p.readOptRaw();
  p.readArgRaw(tok);
});

// Pseudocode words used inside a line.
on("Return Call Comment COMMENT AND OR NOT TRUE FALSE TO", (p, sink, tok) => {
  const v = tok.value;
  if (v === "Call") {
    p.emit(sink, { t: "SmallCaps", content: trimInlines(p.parseArgInlines(tok)) });
    p.emit(sink, { t: "Text", text: "(" });
    for (const x of trimInlines(p.parseArgInlines(tok))) p.emit(sink, x);
    p.emit(sink, { t: "Text", text: ")" });
    return;
  }
  if (v === "Comment" || v === "COMMENT") {
    p.emit(sink, { t: "Math", tex: "\\qquad\\triangleright", pos: p.pos(tok) });
    p.emit(sink, { t: "Text", text: " " });
    for (const x of trimInlines(p.parseArgInlines(tok))) p.emit(sink, x);
    return;
  }
  p.emit(sink, { t: "Strong", content: [{ t: "Text", text: v.toLowerCase() }] });
  p.space(sink);
});

// ------------------------------------------------------------ conditionals

function flags(p: Parser): Map<string, boolean> {
  let m = CONDITIONALS.get(p);
  if (!m) CONDITIONALS.set(p, (m = new Map()));
  return m;
}

/** Whether a command opens a conditional, for counting nested \if ... \fi. */
function opensConditional(p: Parser, name: string): boolean {
  return name.startsWith("if") && name !== "iff" && !COMMAND_IFS.has(name) && (name.length > 2 || flags(p).has(name));
}

/** Commands named \if... that take their branches as arguments and need no \fi. */
const COMMAND_IFS = new Set(["ifthenelse", "ifdef", "ifundef", "ifdefempty", "ifstrequal", "ifblank", "ifnumcomp", "ifnumequal", "ifbool", "ifboolexpr"]);

/** Skip a false branch: to the matching \else (when `toElse`) or \fi. */
function skipBranch(p: Parser, toElse: boolean): void {
  let depth = 0;
  while (p.i < p.toks.length) {
    const t = p.toks[p.i++]!;
    if (t.type !== "cmd") continue;
    if (t.value === "fi") {
      if (depth === 0) return;
      depth--;
    } else if (t.value === "else" && depth === 0 && toElse) return;
    else if (opensConditional(p, t.value)) depth++;
  }
}

/**
 * \iftrue, \iffalse, \newif\ifdraft with \drafttrue and \ifdraft, and the exam class's
 * \ifprintanswers. A false branch is skipped up to its \else or \fi; reaching \else
 * at the end of a true branch skips to the \fi. True when `name` was one of these.
 */
export function conditional(p: Parser, name: string): boolean {
  const f = flags(p);
  if (name === "fi") return true;
  if (name === "else") {
    skipBranch(p, false);
    return true;
  }
  if (name === "ifdefined" || name === "ifcsname") {
    // \ifdefined\foo ... \fi and \ifcsname foo\endcsname: true when the command exists.
    let cmd: string | undefined;
    if (name === "ifdefined") {
      const t = p.toks[p.i];
      if (t?.type === "cmd") {
        p.i++;
        cmd = t.value;
      }
    } else {
      const from = p.i;
      while (p.i < p.toks.length && !(p.toks[p.i]!.type === "cmd" && p.toks[p.i]!.value === "endcsname")) p.i++;
      cmd = p.raw(from, p.i).trim();
      if (p.i < p.toks.length) p.i++;
    }
    if (!(cmd !== undefined && (p.macros.has(cmd) || isKnownCommand(cmd)))) skipBranch(p, true);
    return true;
  }
  if (name === "iftrue" || name === "iffalse" || name === "ifprintanswers" || f.has(name)) {
    const value = name === "iftrue" || (name === "ifprintanswers" ? f.get("ifprintanswers") === true : f.get(name) === true);
    if (!value) skipBranch(p, true);
    return true;
  }
  const set = /^(\w+)(true|false)$/.exec(name);
  if (set && f.has(`if${set[1]}`)) {
    f.set(`if${set[1]}`, set[2] === "true");
    return true;
  }
  return false;
}

on("newif", (p, _sink, tok) => {
  const t = p.toks[p.i];
  if (t?.type === "cmd" && t.value.startsWith("if")) {
    p.i++;
    flags(p).set(t.value, false);
  } else p.diag("LTX005", "\\newif expects a name such as \\ifdraft", tok);
});

on("printanswers noprintanswers", (p, _sink, tok) => {
  flags(p).set("ifprintanswers", tok.value === "printanswers");
});

// ------------------------------------------------------------ colours (xcolor)

/** xcolor's base colours and a few dvipsnames favourites, as 0..255 RGB. */
const NAMED_COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255], magenta: [255, 0, 255], yellow: [255, 255, 0],
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], darkgray: [64, 64, 64], lightgray: [191, 191, 191],
  brown: [191, 128, 64], lime: [191, 255, 0], olive: [128, 128, 0], orange: [255, 128, 0], pink: [255, 191, 191],
  purple: [191, 0, 64], teal: [0, 128, 128], violet: [128, 0, 128],
  NavyBlue: [0, 110, 184], RoyalBlue: [0, 113, 188], MidnightBlue: [0, 103, 149], ForestGreen: [0, 155, 85], OliveGreen: [60, 128, 49],
  BrickRed: [182, 50, 28], Maroon: [175, 50, 53], RedOrange: [242, 96, 53], Bittersweet: [194, 48, 39], Gray: [148, 150, 152],
};

const PALETTES = new WeakMap<object, Map<string, [number, number, number]>>();

function palette(p: Parser): Map<string, [number, number, number]> {
  let m = PALETTES.get(p);
  if (!m) PALETTES.set(p, (m = new Map()));
  return m;
}

/** A colour from \definecolor's model and spec: HTML, rgb, RGB, gray, cmyk. */
function colorFromModel(model: string, spec: string): [number, number, number] | undefined {
  const n = spec.split(",").map((x) => Number(x.trim()));
  switch (model.trim()) {
    case "HTML": {
      const h = /^#?([0-9a-fA-F]{6})$/.exec(spec.trim());
      return h ? [0, 2, 4].map((i) => parseInt(h[1]!.slice(i, i + 2), 16)) as [number, number, number] : undefined;
    }
    case "rgb":
      return n.length === 3 && n.every((v) => v >= 0 && v <= 1) ? (n.map((v) => Math.round(v * 255)) as [number, number, number]) : undefined;
    case "RGB":
      return n.length === 3 && n.every((v) => v >= 0 && v <= 255) ? (n.map(Math.round) as [number, number, number]) : undefined;
    case "gray":
      return n.length === 1 && n[0]! >= 0 && n[0]! <= 1 ? [n[0]! * 255, n[0]! * 255, n[0]! * 255].map(Math.round) as [number, number, number] : undefined;
    case "cmyk": {
      if (n.length !== 4) return undefined;
      const [c, m, y, k] = n as [number, number, number, number];
      return [c, m, y].map((v) => Math.round(255 * (1 - Math.min(1, v + k)))) as [number, number, number];
    }
  }
  return undefined;
}

/** An xcolor expression: red, accent, blue!60!black, red!20 (mixed with white). */
export function resolveColor(p: Parser, expr: string): string | undefined {
  const parts = expr.trim().split("!");
  const named = (s: string) => palette(p).get(s.trim()) ?? NAMED_COLORS[s.trim()];
  let c = named(parts[0]!);
  if (!c) return undefined;
  for (let i = 1; i < parts.length; i += 2) {
    const pct = Number(parts[i]);
    const other = parts[i + 1] !== undefined ? named(parts[i + 1]!) : [255, 255, 255];
    if (!Number.isFinite(pct) || !other) return undefined;
    const w = Math.max(0, Math.min(100, pct)) / 100;
    c = c.map((v, k) => Math.round(v * w + other[k]! * (1 - w))) as [number, number, number];
  }
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

on("definecolor colorlet", (p, _sink, tok) => {
  if (tok.value === "colorlet") {
    const name = p.readArgRaw(tok)?.text.trim();
    const expr = name ? p.readArgRaw(tok)?.text : undefined;
    const hex = expr ? resolveColor(p, expr) : undefined;
    if (name && hex) palette(p).set(name, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]);
    return;
  }
  const name = p.readArgRaw(tok)?.text.trim();
  const model = name ? p.readArgRaw(tok)?.text : undefined;
  const spec = model !== undefined ? p.readArgRaw(tok)?.text : undefined;
  const c = model !== undefined && spec !== undefined ? colorFromModel(model, spec) : undefined;
  if (name && c) palette(p).set(name, c);
});

/** \textcolor{red}{text}, and \textcolor[HTML]{1F77B4}{text}. */
on("textcolor", (p, sink, tok) => {
  const model = p.readOptRaw()?.text;
  const spec = p.readArgRaw(tok)?.text ?? "";
  const hex = model ? (colorFromModel(model, spec) ? `#${colorFromModel(model, spec)!.map((v) => v.toString(16).padStart(2, "0")).join("")}` : undefined) : resolveColor(p, spec);
  const content = p.parseArgInlines(tok);
  if (!hex) {
    for (const x of content) p.emit(sink, x);
    return;
  }
  // White text sits on a \rowcolor or \colorbox background, which is not drawn: keep it readable.
  if (isWhite(hex)) for (const x of content) p.emit(sink, x);
  else p.emit(sink, { t: "Span", attr: { classes: ["color"], attrs: { color: hex } }, content });
});

/** \color{red}: a switch, like \bfseries, until the group ends. */
on("color", (p, _sink, tok) => {
  const model = p.readOptRaw()?.text;
  const spec = p.readArgRaw(tok)?.text ?? "";
  const rgb = model ? colorFromModel(model, spec) : undefined;
  const hex = model ? (rgb ? `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` : undefined) : resolveColor(p, spec);
  p.decls = p.decls.filter((d) => !d.startsWith("color:"));
  if (hex && hex !== "#000000" && !isWhite(hex)) p.decls.push(`color:${hex}` as Decl);
});

/** Nearly white: text that is only readable on a coloured background. */
function isWhite(hex: string): boolean {
  return [1, 3, 5].every((i) => parseInt(hex.slice(i, i + 2), 16) >= 0xf0);
}

on("noindent", (p, sink) => {
  // A paragraph that starts with \noindent is set without its indent.
  if (p.paraEmpty(sink) && !sink.inline) p.emit(sink, { t: "Span", attr: { classes: ["noindent"] }, content: [] });
});

// ------------------------------------------------------------ counters

const COUNTERS = new WeakMap<object, Map<string, number>>();

export function counters(p: Parser): Map<string, number> {
  let m = COUNTERS.get(p);
  if (!m) COUNTERS.set(p, (m = new Map()));
  return m;
}

/** A counter value written as a number or \value{name}. */
function countValue(p: Parser, text: string): number {
  const t = text.trim();
  const v = /^\\value\s*\{([^{}]*)\}$/.exec(t);
  if (v) return counters(p).get(v[1]!.trim()) ?? 0;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

export function formatCount(n: number, style: string): string {
  switch (style) {
    case "roman":
    case "Roman": {
      const table: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
      let out = "";
      let x = Math.max(0, Math.min(3999, n));
      for (const [v, s] of table) while (x >= v) {
        out += s;
        x -= v;
      }
      return style === "roman" ? out.toLowerCase() : out;
    }
    case "alph":
    case "Alph": {
      const c = n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : String(n);
      return style === "Alph" ? c.toUpperCase() : c;
    }
    default:
      return String(n);
  }
}

on("newcounter", (p, _sink, tok) => {
  const a = p.readArgRaw(tok);
  p.readOptRaw();
  if (a) counters(p).set(a.text.trim(), 0);
});

on("stepcounter refstepcounter", (p, _sink, tok) => {
  const a = p.readArgRaw(tok);
  if (!a) return;
  const name = a.text.trim();
  counters(p).set(name, (counters(p).get(name) ?? 0) + 1);
});

on("setcounter addtocounter", (p, _sink, tok) => {
  const a = p.readArgRaw(tok);
  const b = a ? p.readArgRaw(tok) : undefined;
  if (!a || !b) return;
  const name = a.text.trim();
  const n = countValue(p, b.text);
  const value = tok.value === "setcounter" ? n : (counters(p).get(name) ?? 0) + n;
  counters(p).set(name, value);
  // \setcounter{secnumdepth}{0} turns section numbers off; tocdepth limits the contents.
  if (name === "secnumdepth" && tok.value === "setcounter") p.meta.numberSections = value > 0;
  if (name === "tocdepth" && tok.value === "setcounter" && value >= 1 && value <= 6) p.meta.tocDepth = value;
});

on("arabic roman Roman alph Alph value", (p, sink, tok) => {
  const a = p.readArgRaw(tok);
  if (a) p.emitText(sink, formatCount(counters(p).get(a.text.trim()) ?? 0, tok.value));
});

/** \theproblem for a counter made with \newcounter{problem}. True when `name` was one. */
export function counterCommand(p: Parser, sink: Sink, name: string): boolean {
  if (!name.startsWith("the")) return false;
  const c = counters(p);
  const key = name.slice(3);
  if (!c.has(key)) return false;
  p.emitText(sink, String(c.get(key)));
  return true;
}

// ------------------------------------------------------------ rules, PDF strings, titlesec

/** \rule[raise]{width}{height}: a filled box, usually a signature line. */
on("rule", (p, sink, tok) => {
  const raise = p.readOptRaw()?.text.trim();
  const w = p.readArgRaw(tok);
  const h = w ? p.readArgRaw(tok) : undefined;
  if (!w || !h) return;
  const attrs: Record<string, string> = { width: cssLength(w.text), height: cssLength(h.text) };
  if (raise) attrs.raise = cssLength(raise);
  p.emit(sink, { t: "Span", attr: { classes: ["rule"], attrs }, content: [] });
});

/** \hrule between paragraphs: a rule across the text width. */
on("hrule", (p, sink, tok) => {
  p.block(sink, { t: "Div", attr: { classes: ["hrule"] }, blocks: [], pos: p.pos(tok) });
});

/** hyperref's \texorpdfstring{TeX}{PDF string}: the TeX version is what is printed. */
on("texorpdfstring", (p, sink, tok) => {
  for (const x of p.parseArgInlines(tok)) p.emit(sink, x);
  p.readArgRaw(tok);
});

/**
 * titlesec: \titleformat{\section}[shape]{format}{label}{sep}{before}[after] and \titlespacing.
 * Styling is not followed, but an empty label means that level shows no number.
 */
on("titleformat", (p, _sink, tok) => {
  if (p.consumeStar()) {
    p.readArgRaw(tok);
    p.readArgRaw(tok);
    return;
  }
  const cmd = p.readArgRaw(tok)?.text.trim().replace(/^\\/, "");
  p.readOptRaw();
  p.readArgRaw(tok);
  const label = p.readArgRaw(tok)?.text.trim();
  p.readArgRaw(tok);
  p.readArgRaw(tok);
  p.readOptRaw();
  if (cmd && label !== undefined) {
    let hidden = UNNUMBERED.get(p);
    if (!hidden) UNNUMBERED.set(p, (hidden = new Set()));
    if (label === "") hidden.add(cmd);
    else hidden.delete(cmd);
  }
});

/** Sectioning commands whose numbers titlesec hid, per parser. */
const UNNUMBERED = new WeakMap<object, Set<string>>();

on("titlespacing", (p, _sink, tok) => {
  p.consumeStar();
  for (let k = 0; k < 4; k++) p.readArgRaw(tok);
  p.readOptRaw();
});

// ------------------------------------------------------------ the exam class

/** Questions, with each question's points (its parts included), read ahead from the source. */
function examQuestions(tok: Token): number[] {
  return examTally(tok).points;
}

/** Questions with their points (bonus points apart), read ahead from the source. */
function examTally(tok: Token): { points: number[]; bonus: number } {
  const text = tok.src.text.replace(/(^|[^\\])%.*$/gm, "$1");
  const out: number[] = [];
  let bonus = 0;
  for (const m of text.matchAll(/\\(bonus)?(titledquestion|question|part|subpart|subsubpart)(?![A-Za-z])\s*(?:\{[^{}]*\}\s*)?(?:\[\s*(\d+(?:\.\d+)?)\s*\])?/g)) {
    const pts = m[3] ? Number(m[3]) : 0;
    const isQuestion = m[2] === "question" || m[2] === "titledquestion";
    if (isQuestion) out.push(m[1] ? 0 : pts);
    else if (out.length && !m[1]) out[out.length - 1]! += pts;
    if (m[1]) bonus += pts;
  }
  return { points: out, bonus };
}

on("numbonuspoints", (p, sink, tok) => p.emitText(sink, String(examTally(tok).bonus)));

on("numpages", (p, sink) => p.emit(sink, { t: "Span", attr: { classes: ["numpages"] }, content: [] }));

on("numquestions numpoints", (p, sink, tok) => {
  const qs = examQuestions(tok);
  p.emitText(sink, String(tok.value === "numquestions" ? qs.length : qs.reduce((a, b) => a + b, 0)));
});

on("gradetable", (p, sink, tok) => {
  const orientation = p.readOptRaw()?.text.trim() ?? "v";
  p.readOptRaw();
  const qs = examQuestions(tok);
  const cell = (text: string): TableCell => ({ content: text ? [{ t: "Text", text }] : [] });
  const total = String(qs.reduce((a, b) => a + b, 0));
  let table: Extract<Block, { t: "Table" }>;
  if (orientation === "h") {
    const n = qs.length + 2;
    table = {
      t: "Table",
      align: Array(n).fill("center"),
      head: [[cell("Question"), ...qs.map((_, k) => cell(String(k + 1))), cell("Total")]],
      body: [
        [cell("Points"), ...qs.map((q) => cell(String(q))), cell(total)],
        [cell("Score"), ...qs.map(() => cell("")), cell("")],
      ],
      pos: p.pos(tok),
    };
  } else {
    table = {
      t: "Table",
      align: ["center", "center", "center"],
      head: [[cell("Question"), cell("Points"), cell("Score")]],
      body: [...qs.map((q, k) => [cell(String(k + 1)), cell(String(q)), cell("")]), [cell("Total"), cell(total), cell("")]],
      pos: p.pos(tok),
    };
  }
  p.block(sink, table);
});

/** \hrulefill and \dotfill: a rule or dots stretching to fill the line. */
on("hrulefill dotfill", (p, sink, tok) => {
  p.emit(sink, { t: "Span", attr: { classes: [tok.value] }, content: [] });
});

// ------------------------------------------------------------ the letter class

on("signature", (p, _sink, tok) => {
  const content = trimInlines(p.parseArgInlines(tok));
  const letter = LETTER.get(p) ?? {};
  if (tok.value === "address") letter.address = content;
  else letter.signature = content;
  LETTER.set(p, letter);
});

on("opening", (p, sink, tok) => {
  p.block(sink, { t: "Para", content: trimInlines(p.parseArgInlines(tok)), pos: p.pos(tok) });
});

on("closing", (p, sink, tok) => {
  const blank: Block = { t: "Plain", content: [] };
  const signature = LETTER.get(p)?.signature;
  const blocks: Block[] = [{ t: "Plain", content: trimInlines(p.parseArgInlines(tok)) }, blank, blank, blank];
  if (signature) blocks.push({ t: "Plain", content: signature });
  p.block(sink, { t: "Div", attr: { classes: ["letter-closing"] }, blocks, pos: p.pos(tok) });
});

on("encl cc", (p, sink, tok) => {
  const content = trimInlines(p.parseArgInlines(tok));
  p.block(sink, { t: "Para", content: [{ t: "Text", text: `${tok.value}: ` }, ...content], pos: p.pos(tok) });
});

on("ps", (p, sink) => p.space(sink));

// BibTeX-made thebibliography entries separate their parts with \newblock.
on("newblock", (p, sink) => p.space(sink));

on("newtheorem", (p, _sink, tok) => {
  const star = p.consumeStar();
  const env = p.readArgRaw(tok);
  if (!env) return;
  const shared = p.readOptRaw();
  const display = p.readArgRaw(tok);
  if (!display) return;
  const within = p.readOptRaw();
  const name = env.text.trim();
  const counter = shared?.text.trim() || name;
  const def: TheoremDef = { name: plainString(p.parseString(display.text, display.tok)), numbered: !star };
  if (star) {
    p.theorems.set(name, def);
    return;
  }
  // A shared counter is numbered the way the theorem that owns it is.
  const withinSection = within ? /^(section|chapter|part)$/.test(within.text.trim()) : !!p.theorems.get(counter)?.withinSection;
  p.theorems.set(name, withinSection ? { ...def, counter, withinSection } : { ...def, counter });
});

/**
 * tcolorbox's \newtcolorbox{keybox}[1][]{colback=..., title={#1}}: an environment
 * that opens a tcolorbox with those options, its argument filled in.
 */
on("newtcolorbox renewtcolorbox", (p, _sink, tok) => {
  p.readOptRaw(); // init options
  const name = p.readArgRaw(tok);
  if (!name) return;
  const n = p.readOptRaw();
  const nargs = argCount(p, tok, n);
  const d = n ? p.readOptRaw() : undefined;
  const options = p.readArgRaw(tok);
  if (!options) return;
  const begin = `\\begin{tcolorbox}[${options.text}]`;
  p.envs.set(name.text.trim(), d ? { nargs, dflt: d.text, begin, end: "\\end{tcolorbox}" } : { nargs, begin, end: "\\end{tcolorbox}" });
});

on("newenvironment renewenvironment", (p, _sink, tok) => {
  p.consumeStar();
  const name = p.readArgRaw(tok);
  if (!name) return;
  const n = p.readOptRaw();
  const nargs = argCount(p, tok, n);
  const d = n ? p.readOptRaw() : undefined;
  const begin = p.readArgRaw(tok);
  const end = begin ? p.readArgRaw(tok) : undefined;
  if (!begin || !end) return;
  p.envs.set(name.text.trim(), d ? { nargs, dflt: d.text, begin: begin.text, end: end.text } : { nargs, begin: begin.text, end: end.text });
});

// ------------------------------------------------------------ files, environments, unsupported drawing

on("input include subfile", (p, _sink, tok) => p.includeFile(tok, p.cmdStart));
on("endinput", (p) => {
  const frame = p.toks[p.cmdStart].src.frame;
  let k = p.i;
  while (k < p.toks.length && p.toks[k].src.frame === frame) k++;
  p.toks.splice(p.i, k - p.i);
});

on("begin", (p, sink, tok) => beginEnv(p, sink, tok, p.cmdStart));

on("item", (p, sink) => {
  const label = p.parseOptInlines();
  if (!label) return;
  for (const x of label) p.emit(sink, x);
  p.space(sink);
});

// 	ikzstyle{name}=[options] (or +=): read by the pictures (src/tikz); nothing to typeset.
on("tikzstyle", (p, _sink, tok) => {
  p.readArgRaw(tok);
  p.skipSpace();
  const t = p.toks[p.i];
  const m = t?.type === "text" ? /^\s*\+?=\s*/.exec(t.value) : null;
  if (m) {
    p.splitAt(p.i, m[0].length);
    p.i++;
  }
  p.readOptRaw();
});

on("tikz", (p, sink, tok) => {
  const start = p.cmdStart;
  p.readOptRaw();
  p.skipSpace();
  if (p.toks[p.i]?.type === "open") {
    const e = p.groupEnd(p.i);
    p.i = e < 0 ? p.nextPar(p.i) : e + 1;
  } else {
    while (p.i < p.toks.length && p.toks[p.i].type !== "par") {
      const t = p.toks[p.i];
      // A braced group (a \graph body, a node's text) may hold semicolons of its own.
      if (t.type === "open") {
        const e = p.groupEnd(p.i);
        if (e > p.i) {
          p.i = e + 1;
          continue;
        }
      }
      const semi = t.type === "text" ? t.value.indexOf(";") : -1;
      if (semi >= 0) {
        p.splitAt(p.i, semi + 1);
        p.i++;
        break;
      }
      p.i++;
    }
  }
  const img = tikzFromLatex(p, tok, p.raw(start, p.i).trim());
  if (img) {
    p.emit(sink, img);
    return;
  }
  drawingError(p, tok, "\\tikz");
  p.emit(sink, { t: "RawInline", format: "latex", text: p.raw(start, p.i).trim() });
});
// PSTricks settings outside a pspicture: src/pstricks reads them from the source when it draws the next picture.
on("psset newpsstyle addtopsstyle newrgbcolor newgray newcmykcolor newhsbcolor newpsobject savedata readdata SpecialCoor NormalCoor", (p, _sink, tok) => {
  const counts: Record<string, number> = { psset: 1, newpsstyle: 2, addtopsstyle: 2, newrgbcolor: 2, newgray: 2, newcmykcolor: 2, newhsbcolor: 2, newpsobject: 3, savedata: 1, readdata: 2 };
  if (tok.value === "readdata") p.readOptRaw();
  for (let k = 0; k < (counts[tok.value] ?? 0); k++) p.readArgRaw(tok);
  if (tok.value === "savedata") p.readOptRaw();
});
// PSTricks objects outside a pspicture (a tree, a framed box, a \rput): drawn as a picture of their own.
on("pstree psframebox pscirclebox psovalbox psshadowbox psdblframebox psdiabox pstribox rput uput", (p, sink, tok) => {
  const start = p.cmdStart;
  const v = tok.value;
  p.consumeStar();
  if (v === "uput") {
    p.skipSpace();
    if (p.toks[p.i]?.type === "open") p.readArgRaw(tok);
  }
  p.readOptRaw();
  if (v === "rput" || v === "uput") {
    // {rotation} and (x,y) before the argument.
    p.skipSpace();
    if (p.toks[p.i]?.type === "open") {
      const e = p.groupEnd(p.i);
      const after = e >= 0 ? p.toks[e + 1] : undefined;
      if (after?.type === "text" && after.value.startsWith("(")) p.i = e + 1;
    }
    skipParens(p);
  }
  for (let k = 0; k < (v === "pstree" ? 2 : 1); k++) p.readArgRaw(tok);
  const img = pstricksFromLatex(p, tok, p.raw(start, p.i).trim());
  if (img) {
    p.emit(sink, img);
    return;
  }
  drawingError(p, tok, `\\${v}`);
  p.emit(sink, { t: "RawInline", format: "latex", text: p.raw(start, p.i).trim() });
});

// Plain TeX's \pspicture ... \endpspicture.
on("pspicture", (p, sink, tok) => {
  const start = p.cmdStart;
  const j = p.findToken("endpspicture", p.i, (k) => p.toks[k].type === "cmd" && p.toks[k].value === "endpspicture");
  const end = j < 0 ? p.nextPar(p.i) : j + 1;
  const img = pstricksFromLatex(p, tok, p.raw(start, end));
  p.i = end;
  if (img) {
    p.emit(sink, img);
    return;
  }
  drawingError(p, tok, "\\pspicture");
});

/** Skips a (x,y) group in text tokens, splitting the token after the closing parenthesis. */
function skipParens(p: Parser): void {
  p.skipSpace();
  const t = p.toks[p.i];
  if (t?.type !== "text" || !t.value.startsWith("(")) return;
  for (let j = p.i; j < p.toks.length && j < p.i + 40; j++) {
    const u = p.toks[j];
    if (u.type === "par") return;
    const close = u.type === "text" ? u.value.indexOf(")") : -1;
    if (close >= 0) {
      p.splitAt(j, close + 1);
      p.i = j + 1;
      return;
    }
  }
}
