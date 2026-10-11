/**
 * LaTeX tokenizer.
 *
 * Every token keeps its source string and offsets, so the parser can take
 * math and verbatim text back out of the source byte for byte, plus the line
 * and column used in diagnostics. Comments produce no token. Verbatim-like
 * environments and \verb are read raw here, before any other lexing can
 * misread their contents.
 */

import type { ParseContext } from "../context.js";
import { MinTree, lowerBound } from "./search.js";

export type TokType =
  | "cmd" // \name or \x; value is the name ("\\" for a double backslash)
  | "text" // run of ordinary characters
  | "char" // one of & ~ # ^ _ [ ] *
  | "open" // {
  | "close" // }
  | "math" // $
  | "space" // spaces and at most one newline
  | "par" // a blank line
  | "verb" // \verb|x|, \lstinline, \mintinline, or the raw {url} after \url / \href
  | "verbatim"; // a whole verbatim / lstlisting / minted / comment environment

/** A file being read. Macro expansions keep the frame of their call site. */
export interface Frame {
  /** File name and line/col offsets that positions use. */
  ctx: ParseContext;
  /** Normalized path for include-cycle detection. */
  key: string;
  parent?: Frame;
}

export interface Source {
  text: string;
  frame: Frame;
}

export interface Token {
  type: TokType;
  value: string;
  src: Source;
  /** Offsets in src.text; a control word's range includes the blanks TeX skips after it. */
  start: number;
  end: number;
  line: number;
  col: number;
  /** Macro expansion depth; 0 for text read from a file. */
  depth: number;
  /** For "verbatim": the environment name and the raw arguments after \begin{env}. */
  env?: string;
  args?: string;
}

export type LexCode = "LTX003" | "LTX005";
export type Report = (code: LexCode, message: string, line: number, col: number) => void;

/** Where tokens of a macro expansion are reported: the call site. */
export interface At {
  line: number;
  col: number;
  depth: number;
}

const CHARS = new Set(["&", "~", "#", "^", "_", "[", "]", "*"]);
const BREAKS = new Set(["\\", "{", "}", "$", "%", " ", "\t", "\n", ...CHARS]);
const VERB_CMDS = new Set(["verb", "lstinline", "mintinline"]);
const RAW_ARG_CMDS = new Set(["url", "href", "nolinkurl"]);
const VERBATIM_ENV = /[ \t]*\{(verbatim\*?|Verbatim\*?|BVerbatim|lstlisting|minted|comment)\}/y;

/** Bracket tables for one text; see `bracketPairs`. */
interface Pairs {
  /** 1 where the character is the second half of a backslash escape. */
  skip: Uint8Array;
  /** For each "{", the index just past its matching "}", else -1. */
  brace: Int32Array;
  /** Brace depth before each offset (escaped braces excluded). */
  depth: Int32Array;
  /** Offsets of unescaped "]", with the brace depth at each. */
  closerAt: Int32Array;
  closers: MinTree;
}

function bracketPairs(text: string): Pairs {
  const n = text.length;
  const skip = new Uint8Array(n + 1);
  const brace = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n + 1);
  const closerAt: number[] = [];
  const closerDepth: number[] = [];
  const open: number[] = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    depth[i] = d;
    if (skip[i]) continue;
    const c = text.charCodeAt(i);
    if (c === 92) skip[i + 1] = 1;
    else if (c === 123) {
      open.push(i);
      d++;
    } else if (c === 125) {
      const o = open.pop();
      if (o !== undefined) brace[o] = i + 1;
      d--;
    } else if (c === 93) {
      closerAt.push(i);
      closerDepth.push(d);
    }
  }
  depth[n] = d;
  return { skip, brace, depth, closerAt: Int32Array.from(closerAt), closers: new MinTree(closerDepth.length, (k) => closerDepth[k]) };
}

export function lex(input: string, frame: Frame, report: Report, at?: At): Token[] {
  const text = input.replace(/\r\n?/g, "\n");
  const src: Source = { text, frame };
  const toks: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;
  let atLetter = false;

  const isLetter = (ch: string | undefined): boolean =>
    ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (atLetter && ch === "@"));
  const isBlank = (ch: string | undefined): boolean => ch === " " || ch === "\t";
  const advance = (to: number): void => {
    for (; i < to; i++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }
  };
  const push = (type: TokType, value: string, start: number, sl: number, sc: number, extra?: Partial<Token>): void => {
    toks.push({
      type,
      value,
      src,
      start,
      end: i,
      line: at ? at.line : sl,
      col: at ? at.col : sc,
      depth: at ? at.depth : 0,
      ...extra,
    });
  };
  const warn = (code: LexCode, message: string, sl: number, sc: number): void =>
    report(code, message, at ? at.line : sl, at ? at.col : sc);
  /** Index just past the "}" matching the "{" at `p`, or -1. */
  const scanBrace = (p: number): number => {
    let depth = 0;
    for (let k = p; k < n; k++) {
      const ch = text[k];
      if (ch === "\\") k++;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return k + 1;
    }
    return -1;
  };
  // Answers from tables over the whole text, built on first use: a \url{ or \lstinline[ that never
  // closes would otherwise rescan the rest of the input each time. Escapes pair up from the start of the text;
  // a scan that starts at an unescaped bracket pairs them the same way, so the tables apply there.
  let pairs: Pairs | undefined;
  const matchBrace = (p: number): number => {
    pairs ??= bracketPairs(text);
    return text[p] !== "{" || pairs.skip[p] ? scanBrace(p) : pairs.brace[p];
  };
  /** Index just past the "]" closing the unescaped "[" at `p` (braces protect), or -1. */
  const matchBracket = (p: number): number => {
    pairs ??= bracketPairs(text);
    // The first "]" after p where the brace depth is no deeper than just after p.
    const k = pairs.closers.firstBelow(lowerBound(pairs.closerAt, p + 1), pairs.depth[p + 1] + 1);
    return k < 0 ? -1 : pairs.closerAt[k] + 1;
  };

  const lexVerb = (name: string, start: number, sl: number, sc: number, from: number): void => {
    let p = from;
    if (name === "verb" && text[p] === "*") p++;
    if (name !== "verb") {
      while (isBlank(text[p])) p++;
      if (text[p] === "[") p = Math.max(p + 1, matchBracket(p));
    }
    if (name === "mintinline") {
      while (isBlank(text[p])) p++;
      if (text[p] === "{") p = Math.max(p + 1, matchBrace(p));
    }
    const delim = text[p];
    if (delim === undefined || delim === "\n" || isBlank(delim) || (name === "verb" && isLetter(delim))) {
      warn("LTX005", `\\${name} needs a delimiter around its text, as in \\${name}|code|`, sl, sc);
      advance(p);
      push("verb", "", start, sl, sc);
      return;
    }
    const close = delim === "{" ? "}" : delim;
    const eol = text.indexOf("\n", p + 1);
    // Look for the closer on this line only: searching the rest of the text for each \verb is quadratic.
    const onLine = text.slice(p + 1, eol < 0 ? n : eol).indexOf(close);
    const e = onLine < 0 ? -1 : p + 1 + onLine;
    if (e < 0) {
      warn("LTX005", `\\${name} text is not closed with '${close}' on the same line`, sl, sc);
      const stop = eol < 0 ? n : eol;
      const value = text.slice(p + 1, stop);
      advance(stop);
      push("verb", value, start, sl, sc);
      return;
    }
    const value = text.slice(p + 1, e);
    advance(e + 1);
    push("verb", value, start, sl, sc);
  };

  const lexVerbatimEnv = (env: string, start: number, sl: number, sc: number, from: number): void => {
    let p = from;
    const argsStart = p;
    if (!/^(verbatim\*?|comment)$/.test(env)) {
      let q = p;
      while (isBlank(text[q])) q++;
      if (text[q] === "[") {
        const e = matchBracket(q);
        if (e > 0) p = e;
      }
      if (env === "minted") {
        q = p;
        while (isBlank(text[q])) q++;
        if (text[q] === "{") {
          const e = matchBrace(q);
          if (e > 0) p = e;
        }
      }
    }
    const args = text.slice(argsStart, p).trim();
    let q = p;
    while (isBlank(text[q])) q++;
    if (text[q] === "\n") p = q + 1;
    const endTag = `\\end{${env}}`;
    const e = text.indexOf(endTag, p);
    let body: string;
    if (e < 0) {
      warn("LTX003", `\\begin{${env}} is never closed`, sl, sc);
      body = text.slice(p);
      advance(n);
    } else {
      body = text.slice(p, e).replace(/\n[ \t]*$/, "");
      advance(e + endTag.length);
    }
    push("verbatim", body, start, sl, sc, { env, args });
  };

  while (i < n) {
    const start = i;
    const sl = line;
    const sc = i - lineStart + 1;
    const c = text[i];

    if (c === "%") {
      // TeX drops the comment, the newline and the next line's indentation.
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      else {
        j++;
        while (isBlank(text[j])) j++;
      }
      advance(j);
      atLineStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      let j = i;
      let newlines = atLineStart ? 1 : 0;
      while (j < n && (isBlank(text[j]) || text[j] === "\n")) {
        if (text[j] === "\n") newlines++;
        j++;
      }
      advance(j);
      push(newlines >= 2 ? "par" : "space", " ", start, sl, sc);
      atLineStart = false;
      continue;
    }
    atLineStart = false;

    if (c === "\\") {
      const d = text[i + 1];
      if (d === undefined) {
        advance(n);
        push("text", "\\", start, sl, sc);
        continue;
      }
      if (isLetter(d)) {
        let k = i + 1;
        while (k < n && isLetter(text[k])) k++;
        const name = text.slice(i + 1, k);
        if (name === "makeatletter") atLetter = true;
        else if (name === "makeatother") atLetter = false;
        if (VERB_CMDS.has(name)) {
          lexVerb(name, start, sl, sc, k);
          continue;
        }
        if (name === "begin") {
          VERBATIM_ENV.lastIndex = k;
          const m = VERBATIM_ENV.exec(text);
          if (m) {
            lexVerbatimEnv(m[1], start, sl, sc, k + m[0].length);
            continue;
          }
        }
        // Blanks after a control word are skipped, and so is one newline unless a blank line follows.
        while (isBlank(text[k])) k++;
        if (text[k] === "\n") {
          let m = k + 1;
          while (isBlank(text[m])) m++;
          if (text[m] !== "\n") k = m;
        }
        advance(k);
        push("cmd", name, start, sl, sc);
        if (RAW_ARG_CMDS.has(name) && text[i] === "{") {
          const e = matchBrace(i);
          if (e > 0) {
            const s2 = i;
            const l2 = line;
            const c2 = i - lineStart + 1;
            const value = text.slice(i + 1, e - 1);
            advance(e);
            push("verb", value, s2, l2, c2);
          }
        }
        continue;
      }
      // Control symbol. A control space (or backslash-newline) skips the blanks after it.
      let k = i + 2;
      const name = d === "\n" ? " " : d;
      if (name === " ") while (isBlank(text[k])) k++;
      advance(k);
      push("cmd", name, start, sl, sc);
      continue;
    }
    if (c === "{" || c === "}" || c === "$") {
      advance(i + 1);
      push(c === "{" ? "open" : c === "}" ? "close" : "math", c, start, sl, sc);
      continue;
    }
    if (CHARS.has(c)) {
      advance(i + 1);
      push("char", c, start, sl, sc);
      continue;
    }
    let j = i + 1;
    while (j < n && !BREAKS.has(text[j])) j++;
    advance(j);
    push("text", text.slice(start, j), start, sl, sc);
  }
  return toks;
}
