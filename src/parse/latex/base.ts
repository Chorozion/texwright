/** Types and small helpers shared by the parser and its command and environment handlers. */

import type { Block, Inline, Pos } from "../../ast.js";
import type { Token } from "./lexer.js";
import type { Parser } from "./parser.js";

export type Heading = Extract<Block, { t: "Heading" }>;
export type Note = Extract<Inline, { t: "Note" }>;

export type OpenKind = "brace" | "env" | "bracket" | "item" | "cell" | "preamble";

/** Something that was opened and must be closed: a group, an environment, a list item... */
export interface Open {
  kind: OpenKind;
  tok: Token;
  /** Environment name, or the command whose argument a brace opens. */
  name?: string;
  /** Short arguments end at a blank line, as in TeX. */
  short?: boolean;
  reported?: boolean;
}

/** A node that a \label or \caption inside it attaches to. */
export interface Target {
  kind: "figure" | "table" | "theorem" | "heading";
  label?: string;
  caption?: Inline[];
  unnumbered?: boolean;
}

/** LaTeX's size switches, smallest to largest. */
export const SIZES = ["tiny", "scriptsize", "footnotesize", "small", "large", "Large", "LARGE", "huge", "Huge"] as const;
export type SizeName = (typeof SIZES)[number];

/** A colour switch (\color{red}): "color:#rrggbb". */
export type ColorDecl = `color:#${string}`;

export type Decl = "emph" | "strong" | "code" | "smallcaps" | SizeName | ColorDecl;

export interface MacroDef {
  nargs: number;
  /** Default of the optional first argument, when it has one. */
  dflt?: string;
  body: string;
}

export interface EnvDef {
  nargs: number;
  dflt?: string;
  begin: string;
  end: string;
}

export interface TheoremDef {
  name: string;
  counter?: string;
  numbered: boolean;
  /** \newtheorem{x}{X}[section]: numbered within the section. */
  withinSection?: boolean;
}

export const LEVEL: Record<string, number> = {
  part: 1,
  chapter: 1,
  addchap: 1,
  section: 1,
  addsec: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

/** Commands that start a line of pseudocode: algorithmicx (\State, \If) and the older algorithmic (\STATE, \IF). */
export const ALG_LINES = new Set(
  (
    "State Statex Require Ensure If ElsIf Else EndIf For ForAll EndFor While EndWhile Repeat Until Loop EndLoop Function EndFunction Procedure EndProcedure " +
    "STATE REQUIRE ENSURE IF ELSIF ELSE ENDIF FOR FORALL ENDFOR WHILE ENDWHILE REPEAT UNTIL LOOP ENDLOOP RETURN PRINT"
  ).split(" "),
);

/** The letter class's \address and \signature, per parser, for the letter environment to place. */
export const LETTER = new WeakMap<object, { address?: Inline[]; signature?: Inline[] }>();

/** Item commands of the exam class's lists; an item scope named "exam" ends at any of them. */
export const EXAM_ITEMS = new Set([
  "question", "titledquestion", "bonusquestion", "bonustitledquestion", "part", "bonuspart", "subpart", "bonussubpart", "subsubpart", "bonussubsubpart", "choice", "CorrectChoice",
]);

/** Conditionals per parser: \newif flags and the exam class's \printanswers. */
export const CONDITIONALS = new WeakMap<object, Map<string, boolean>>();

export class Sink {
  blocks: Block[] = [];
  para: Inline[] = [];
  paraPos?: Pos;
  /** The paragraph ends in a space (or has not started), so another space is dropped. */
  spaced: boolean;
  constructor(readonly inline: boolean) {
    this.spaced = !inline;
  }
}

export function isCmd(t: Token | undefined, name: string): boolean {
  return t !== undefined && t.type === "cmd" && t.value === name;
}

export function isChar(t: Token | undefined, c: string): boolean {
  return t !== undefined && t.type === "char" && t.value === c;
}

const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));

/** True when s.slice(0, end) ends in a control word: a backslash and letters (or @). Looks back over those letters only. */
function endsInControlWord(s: string, end: number): boolean {
  let i = end;
  while (i > 0 && (isLetter(s[i - 1]) || s[i - 1] === "@")) i--;
  return i < end && i > 0 && s[i - 1] === "\\";
}

/** Replace #1..#9 with arguments and ## with #, keeping control words from running into the text. */
export function substitute(body: string, args: string[]): string {
  return body.replace(/#(#|[1-9])/g, (_m, d: string, offset: number) => {
    if (d === "#") return "#";
    let arg = args[Number(d) - 1] ?? "";
    if (isLetter(arg[0]) && endsInControlWord(body, offset)) arg = " " + arg;
    if (endsInControlWord(arg, arg.length) && isLetter(body[offset + 2])) arg += " ";
    return arg;
  });
}

/** An upper bound on the length of substitute(body, args), found without building it. */
export function substituteSize(body: string, args: string[]): number {
  let size = body.length;
  for (const m of body.matchAll(/#([1-9])/g)) size += (args[Number(m[1]) - 1]?.length ?? 0) + 2;
  return size;
}

/** Highest #n in a macro body. */
export function maxParam(body: string): number {
  let n = 0;
  for (const m of body.matchAll(/#([1-9])/g)) n = Math.max(n, Number(m[1]));
  return n;
}

/** Key=value options such as "[width=0.5\textwidth, caption={A, B}]", split at top-level commas. */
export function keyVals(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const s = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      cur += c + (s[k + 1] ?? "");
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!key) continue;
    let value = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (/^\{.*\}$/s.test(value)) value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

/** LTX004: a drawing none of texwright's interpreters could draw anything of. */
export function drawingError(p: Parser, tok: Token, what: string): void {
  p.diag("LTX004", `${what} could not be drawn: nothing in it is something texwright's TikZ, pgfplots, circuitikz or PSTricks interpreters draw`, tok, "Render this figure to SVG or PNG and include it with \\includegraphics");
}

/** What the document declared about itself and where some class-specific state stands, per parser. */
export interface DocInfo {
  /** The \documentclass name. */
  cls?: string;
  classOptions: Set<string>;
  /** Package names from \usepackage. */
  packages: Set<string>;
  /** "package:option" for every option given to a package. */
  packageOptions: Set<string>;
  /** Between \frontmatter (or \backmatter) and \mainmatter: chapters and sections are unnumbered. */
  unnumberedMatter: boolean;
  /** Affiliation keys of each author, by position in meta.author. */
  authorKeys: string[][];
  /** Affiliations given by key (authblk's \affil[1], elsarticle's \affiliation[inst1], llncs's \institute). */
  affiliations: Map<string, Inline[]>;
  /** Authors before this index already have their sequential affiliation (revtex, amsart). */
  affiliated: number;
  /** \maketitle has been seen. */
  titleMade: boolean;
  /** algorithm2e: open algorithm environments, the current block depth, and the layout options. */
  alg: { open: number; level: number; lined: boolean; numbered: boolean };
}

const DOC_INFO = new WeakMap<object, DocInfo>();

export function docInfo(p: object): DocInfo {
  let d = DOC_INFO.get(p);
  if (!d) {
    d = {
      classOptions: new Set(),
      packages: new Set(),
      packageOptions: new Set(),
      unnumberedMatter: false,
      authorKeys: [],
      affiliations: new Map(),
      affiliated: 0,
      titleMade: false,
      alg: { open: 0, level: 0, lined: false, numbered: false },
    };
    DOC_INFO.set(p, d);
  }
  return d;
}
