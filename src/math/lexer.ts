/**
 * Tokenizer for LaTeX math: control sequences, characters, spaces and macro
 * parameters, each with its offset in the formula source so errors point at
 * the right line and column.
 */

export type TokKind = "cs" | "char" | "space" | "param" | "eof";

export interface Token {
  k: TokKind;
  /** cs: the name with its backslash ("\\frac", "\\,"); char: the character; param: "1".."9" or "#". */
  v: string;
  /** Offset in the formula source (for tokens from a macro body: the offset of the macro call). */
  pos: number;
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x40;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
}

export class Lexer {
  private i = 0;
  constructor(
    readonly src: string,
    /** When set, every token reports this offset (tokens of a macro body). */
    private readonly fixedPos?: number,
    /** Treat "@" as a letter in control-sequence names (macro bodies may use \foo@bar). */
    private readonly atLetter = false,
  ) {}

  get offset(): number {
    return this.i;
  }

  next(): Token {
    const s = this.src;
    for (;;) {
      if (this.i >= s.length) return { k: "eof", v: "", pos: this.fixedPos ?? s.length };
      const start = this.i;
      const c = s.charCodeAt(start);
      const pos = this.fixedPos ?? start;
      if (c === 0x25) {
        // % comment to end of line (and the line break with it)
        const nl = s.indexOf("\n", start);
        this.i = nl < 0 ? s.length : nl + 1;
        continue;
      }
      if (isSpace(c)) {
        let j = start + 1;
        while (j < s.length && isSpace(s.charCodeAt(j))) j++;
        this.i = j;
        return { k: "space", v: " ", pos };
      }
      if (c === 0x5c) {
        // backslash
        let j = start + 1;
        if (j >= s.length) {
          this.i = j;
          return { k: "cs", v: "\\", pos };
        }
        const d = s.charCodeAt(j);
        if ((d >= 0x41 && d <= 0x5a) || (d >= 0x61 && d <= 0x7a) || (this.atLetter && d === 0x40)) {
          while (j < s.length) {
            const e = s.charCodeAt(j);
            if ((e >= 0x41 && e <= 0x5a) || (e >= 0x61 && e <= 0x7a) || (this.atLetter && isLetter(e))) j++;
            else break;
          }
          const name = s.slice(start, j);
          // Spaces after a control word are skipped.
          while (j < s.length && isSpace(s.charCodeAt(j))) j++;
          this.i = j;
          return { k: "cs", v: name, pos };
        }
        // control symbol: one character (a full code point)
        const cp = s.codePointAt(j)!;
        const len = cp > 0xffff ? 2 : 1;
        this.i = j + len;
        const ch = String.fromCodePoint(cp);
        return { k: "cs", v: isSpace(cp) ? "\\ " : `\\${ch}`, pos };
      }
      if (c === 0x23) {
        // # parameter
        const d = s.charCodeAt(start + 1);
        if (d >= 0x31 && d <= 0x39) {
          this.i = start + 2;
          return { k: "param", v: String.fromCharCode(d), pos };
        }
        if (d === 0x23) {
          this.i = start + 2;
          return { k: "param", v: "#", pos };
        }
        this.i = start + 1;
        return { k: "char", v: "#", pos };
      }
      const cp = s.codePointAt(start)!;
      this.i = start + (cp > 0xffff ? 2 : 1);
      return { k: "char", v: String.fromCodePoint(cp), pos };
    }
  }
}

/** All tokens of a string (used for macro bodies). */
export function tokenize(src: string, fixedPos?: number): Token[] {
  const lx = new Lexer(src, fixedPos);
  const out: Token[] = [];
  for (let t = lx.next(); t.k !== "eof"; t = lx.next()) out.push(t);
  return out;
}

/** Turn tokens back into source text (for macro bodies kept as strings). */
export function untokenize(toks: readonly Token[]): string {
  let out = "";
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.k === "cs") {
      out += t.v;
      const next = toks[k + 1];
      // A control word followed by a letter needs a separating space.
      if (next && /^\\[A-Za-z@]+$/.test(t.v) && (next.k === "char" ? /^[A-Za-z@]/.test(next.v) : false)) out += " ";
    } else if (t.k === "param") out += t.v === "#" ? "##" : `#${t.v}`;
    else if (t.k === "space") out += " ";
    else out += t.v;
  }
  return out;
}
