/**
 * LaTeX field values (as found in .bib files) to Unicode text.
 *
 * Accents and special letters become precomposed characters, escaped
 * specials lose their backslash, dashes and ties become their Unicode
 * forms, protective braces disappear and math stays as $...$. In rich mode
 * italic, bold, small caps, superscript and subscript commands become CSL
 * rich-text tags instead of being dropped.
 */

const NBSP = "\u00a0";

/** Combining marks for accent commands. */
const ACCENTS: Record<string, string> = {
  "'": "\u0301",
  "`": "\u0300",
  "^": "\u0302",
  '"': "\u0308",
  "~": "\u0303",
  "=": "\u0304",
  ".": "\u0307",
  u: "\u0306",
  v: "\u030c",
  H: "\u030b",
  c: "\u0327",
  k: "\u0328",
  r: "\u030a",
  d: "\u0323",
  b: "\u0331",
  t: "\u0361",
};

/** What an accent command prints when its argument is empty, as in \~{}. */
const BARE_ACCENTS: Record<string, string> = { "'": "´", "`": "`", "^": "^", '"': "¨", "~": "~", "=": "¯", ".": "˙" };

const SYMBOLS: Record<string, string> = {
  i: "ı",
  j: "ȷ",
  ss: "ß",
  SS: "SS",
  o: "ø",
  O: "Ø",
  aa: "å",
  AA: "Å",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  l: "ł",
  L: "Ł",
  dh: "ð",
  DH: "Ð",
  th: "þ",
  TH: "Þ",
  ng: "ŋ",
  NG: "Ŋ",
  dj: "đ",
  DJ: "Đ",
  textendash: "–",
  textemdash: "—",
  ldots: "…",
  dots: "…",
  textellipsis: "…",
  textquoteleft: "‘",
  textquoteright: "’",
  textquotedblleft: "“",
  textquotedblright: "”",
  guillemotleft: "«",
  guillemotright: "»",
  guillemetleft: "«",
  guillemetright: "»",
  textbackslash: "\\",
  textasciitilde: "~",
  textasciicircum: "^",
  textunderscore: "_",
  textbar: "|",
  copyright: "©",
  textcopyright: "©",
  textregistered: "®",
  texttrademark: "™",
  S: "§",
  P: "¶",
  pounds: "£",
  textsterling: "£",
  euro: "€",
  texteuro: "€",
  textdegree: "°",
  textbullet: "•",
  dag: "†",
  ddag: "‡",
  textperiodcentered: "·",
  slash: "/",
  LaTeX: "LaTeX",
  LaTeXe: "LaTeX2ε",
  TeX: "TeX",
  BibTeX: "BibTeX",
  space: " ",
  quad: " ",
  qquad: " ",
  nobreakspace: NBSP,
};

type Wrap = readonly [string, string] | null;
const ITALIC: Wrap = ["<i>", "</i>"];
const BOLD: Wrap = ["<b>", "</b>"];
const SMALL_CAPS: Wrap = ['<span style="font-variant:small-caps;">', "</span>"];

/** One-argument formatting commands. null keeps the argument without markup. */
const FORMAT_COMMANDS: Record<string, Wrap> = {
  emph: ITALIC,
  textit: ITALIC,
  textsl: ITALIC,
  textbf: BOLD,
  textsc: SMALL_CAPS,
  textsuperscript: ["<sup>", "</sup>"],
  textsubscript: ["<sub>", "</sub>"],
  textrm: null,
  textsf: null,
  texttt: null,
  textup: null,
  textmd: null,
  textnormal: null,
  mbox: null,
  hbox: null,
  text: null,
  NoCaseChange: null,
};

/** Declarations that apply to the rest of the enclosing group, as in {\em word}. */
const SWITCHES: Record<string, Wrap> = {
  em: ITALIC,
  it: ITALIC,
  itshape: ITALIC,
  sl: ITALIC,
  slshape: ITALIC,
  bf: BOLD,
  bfseries: BOLD,
  sc: SMALL_CAPS,
  scshape: SMALL_CAPS,
  rm: null,
  sf: null,
  tt: null,
  normalfont: null,
  upshape: null,
  mdseries: null,
  rmfamily: null,
  sffamily: null,
  ttfamily: null,
  relax: null,
  protect: null,
  small: null,
  footnotesize: null,
  scriptsize: null,
  large: null,
  Large: null,
  normalsize: null,
};

const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);

/**
 * Groups, font switches and command arguments nest by recursion; past this
 * depth the rest of a group is read as plain text instead, so ten thousand
 * nested braces (or \em\em\em...) cannot overflow the stack.
 */
const MAX_NESTING = 200;

class Converter {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly src: string,
    private readonly rich: boolean,
  ) {}

  run(): string {
    return this.sequence(false)
      .replace(/[ \t\r\n\f\v]+/g, " ")
      .trim();
  }

  /** Convert up to the closing brace of the current group (consumed) or the end. */
  private sequence(inGroup: boolean): string {
    if (this.depth >= MAX_NESTING) return this.flat(inGroup);
    this.depth++;
    const out = this.nested(inGroup);
    this.depth--;
    return out;
  }

  /** What sequence() returns, read without recursion: braces dropped, command names skipped, escaped characters kept. */
  private flat(inGroup: boolean): string {
    const s = this.src;
    let out = "";
    let open = 0;
    while (this.i < s.length) {
      const c = s[this.i++];
      if (c === "{") open++;
      else if (c === "}") {
        if (open > 0) open--;
        else if (inGroup) return out;
      } else if (c === "\\") {
        if (isLetter(s[this.i])) while (isLetter(s[this.i])) this.i++;
        else if (this.i < s.length) out += s[this.i++];
      } else out += c;
    }
    return out;
  }

  private nested(inGroup: boolean): string {
    const s = this.src;
    let out = "";
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "}") {
        this.i++;
        if (inGroup) return out;
        continue; // stray closing brace
      }
      if (c === "{") {
        this.i++;
        out += this.sequence(true);
        continue;
      }
      if (c === "\\") {
        const sw = this.switchAt();
        if (sw !== undefined) {
          const rest = this.sequence(inGroup);
          return out + this.wrap(sw, rest);
        }
        out += this.command();
        continue;
      }
      if (c === "$") {
        out += this.math();
        continue;
      }
      this.i++;
      if (c === "~") out += NBSP;
      else if (c === "-") {
        if (s.startsWith("--", this.i)) {
          this.i += 2;
          out += "—";
        } else if (s[this.i] === "-") {
          this.i++;
          out += "–";
        } else out += "-";
      } else if (c === "`") {
        if (s[this.i] === "`") {
          this.i++;
          out += "“";
        } else out += "‘";
      } else if (c === "'") {
        if (s[this.i] === "'") {
          this.i++;
          out += "”";
        } else out += "’";
      } else out += c;
    }
    return out;
  }

  private wrap(w: Wrap, inner: string): string {
    return this.rich && w && inner ? w[0] + inner + w[1] : inner;
  }

  /** If a font switch such as \em starts here, consume it and return its wrap. */
  private switchAt(): Wrap | undefined {
    const m = /^\\([A-Za-z]+)\s*/.exec(this.src.slice(this.i, this.i + 40));
    if (!m || !(m[1] in SWITCHES)) return undefined;
    this.i += m[0].length;
    return SWITCHES[m[1]];
  }

  /** At a backslash: convert one command and its arguments. */
  private command(): string {
    const s = this.src;
    this.i++;
    if (this.i >= s.length) return "";
    const c = s[this.i];
    if (!isLetter(c)) {
      this.i++;
      if (c in ACCENTS) return this.accent(c);
      if ("&%$_#{}".includes(c)) return c;
      if (c === "\\") return " ";
      if (c === ",") return "\u202f";
      if (c === " " || c === "\n" || c === "\t" || c === "\r") return " ";
      if (c === "-" || c === "/" || c === "@") return "";
      return c;
    }
    let name = "";
    while (isLetter(s[this.i])) name += s[this.i++];
    while (/\s/.test(s[this.i] ?? "")) this.i++;
    if (name in ACCENTS) return this.accent(name);
    if (name in SYMBOLS) return SYMBOLS[name];
    if (name in FORMAT_COMMANDS) return this.wrap(FORMAT_COMMANDS[name], this.argument());
    if (name === "url") return unescapeUrl(this.rawArgument());
    if (name === "href") {
      this.rawArgument();
      return this.argument();
    }
    // The classic sort-key trick from BibTeX's documentation: \noopsort{a}Name prints only Name.
    if (name === "noopsort") {
      this.argument();
      return "";
    }
    // Unknown command: keep the text of the braced arguments that follow it.
    let out = "";
    while (s[this.i] === "{") out += this.argument();
    return out;
  }

  private accent(cmd: string): string {
    const arg = this.argument();
    if (!arg) return BARE_ACCENTS[cmd] ?? "";
    const chars = Array.from(arg);
    const base = chars[0] === "ı" ? "i" : chars[0] === "ȷ" ? "j" : chars[0];
    return (base + ACCENTS[cmd] + chars.slice(1).join("")).normalize("NFC");
  }

  /** A braced group, a command, or a single character; converted. */
  private argument(): string {
    const s = this.src;
    while (s[this.i] === " ") this.i++;
    const c = s[this.i];
    if (c === undefined) return "";
    if (c === "{") {
      this.i++;
      return this.sequence(true);
    }
    if (c === "\\") {
      // \emph\emph\emph... nests through arguments rather than groups.
      if (this.depth >= MAX_NESTING) {
        this.i++;
        if (isLetter(s[this.i])) while (isLetter(s[this.i])) this.i++;
        else if (this.i < s.length) return s[this.i++];
        return "";
      }
      this.depth++;
      const out = this.command();
      this.depth--;
      return out;
    }
    this.i++;
    return c;
  }

  /** A braced group returned verbatim (for URLs). */
  private rawArgument(): string {
    const s = this.src;
    while (s[this.i] === " ") this.i++;
    if (s[this.i] !== "{") return "";
    const start = ++this.i;
    let depth = 1;
    for (; this.i < s.length; this.i++) {
      if (s[this.i] === "\\") this.i++;
      else if (s[this.i] === "{") depth++;
      else if (s[this.i] === "}" && --depth === 0) break;
    }
    return s.slice(start, this.i++);
  }

  /** $...$ or $$...$$ copied verbatim; a lone $ stays a dollar sign. */
  private math(): string {
    const s = this.src;
    const delim = s.startsWith("$$", this.i) ? "$$" : "$";
    let j = this.i + delim.length;
    while (j < s.length) {
      if (s[j] === "\\") j += 2;
      else if (s.startsWith(delim, j)) break;
      else j++;
    }
    if (j >= s.length) {
      this.i++;
      return "$";
    }
    const out = s.slice(this.i, j + delim.length);
    this.i = j + delim.length;
    return out;
  }
}

/** LaTeX to plain Unicode text. With rich = true, formatting becomes CSL rich-text tags. */
export function latexToText(src: string, rich = false): string {
  return new Converter(src, rich).run();
}

/** URLs and DOIs: no dash or tie conversion, only escapes, braces and \url{} removed. */
export function latexToUrl(src: string): string {
  const m = /^\s*\\url\s*\{([\s\S]*)\}\s*$/.exec(src);
  return unescapeUrl(m ? m[1] : src);
}

function unescapeUrl(s: string): string {
  return s
    .replace(/\\([_%&#~$])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, "");
}
