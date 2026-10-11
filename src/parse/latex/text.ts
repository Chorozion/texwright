/** Character tables and inline-list helpers for the LaTeX parser. */

import type { Block, Inline } from "../../ast.js";
import { plainText } from "../../ast.js";

/** Commands that stand for a fixed string in text mode. */
export const SYMBOLS: Record<string, string> = {
  "%": "%",
  "&": "&",
  "#": "#",
  _: "_",
  $: "$",
  "{": "{",
  "}": "}",
  ",": "\u202f", // a kern in TeX, so no line break at \, (narrow no-break space)
  ";": " ",
  ":": " ",
  ">": " ",
  "!": "",
  "@": "",
  "/": "",
  "-": "",
  thinspace: "\u202f",
  enspace: "\u2002",
  quad: "\u2003",
  qquad: "\u2003\u2003",
  nobreakspace: "\u00a0",
  textbackslash: "\\",
  textasciitilde: "~",
  textasciicircum: "^",
  textbar: "|",
  textless: "<",
  textgreater: ">",
  textunderscore: "_",
  slash: "/",
  ldots: "\u2026",
  dots: "\u2026",
  textellipsis: "\u2026",
  LaTeX: "LaTeX",
  TeX: "TeX",
  LaTeXe: "LaTeX2\u03b5",
  BibTeX: "BibTeX",
  S: "\u00a7",
  P: "\u00b6",
  copyright: "\u00a9",
  textcopyright: "\u00a9",
  dag: "\u2020",
  textdagger: "\u2020",
  ddag: "\u2021",
  textdaggerdbl: "\u2021",
  pounds: "\u00a3",
  textsterling: "\u00a3",
  euro: "\u20ac",
  texteuro: "\u20ac",
  textregistered: "\u00ae",
  texttrademark: "\u2122",
  textdegree: "\u00b0",
  textbullet: "\u2022",
  textperiodcentered: "\u00b7",
  textquoteleft: "\u2018",
  textquoteright: "\u2019",
  textquotedblleft: "\u201c",
  textquotedblright: "\u201d",
  textendash: "\u2013",
  textemdash: "\u2014",
  textexclamdown: "\u00a1",
  textquestiondown: "\u00bf",
  guillemotleft: "\u00ab",
  guillemotright: "\u00bb",
  textvisiblespace: "\u2423",
  ss: "\u00df",
  o: "\u00f8",
  O: "\u00d8",
  aa: "\u00e5",
  AA: "\u00c5",
  ae: "\u00e6",
  AE: "\u00c6",
  oe: "\u0153",
  OE: "\u0152",
  l: "\u0142",
  L: "\u0141",
  i: "\u0131",
  j: "\u0237",
  // textcomp and friends
  textsection: "\u00a7",
  textparagraph: "\u00b6",
  textquotedbl: "\"",
  textquotesingle: "'",
  textasciigrave: "`",
  textdollar: "$",
  textbraceleft: "{",
  textbraceright: "}",
  textasteriskcentered: "*",
  textonehalf: "\u00bd",
  textonequarter: "\u00bc",
  textthreequarters: "\u00be",
  texttimes: "\u00d7",
  textdiv: "\u00f7",
  textpm: "\u00b1",
  textminus: "\u2212",
  textmu: "\u00b5",
  textcelsius: "\u00b0C",
  textohm: "\u03a9",
  textnumero: "\u2116",
  textcent: "\u00a2",
  textyen: "\u00a5",
  textflorin: "\u0192",
  textperthousand: "\u2030",
  textordfeminine: "\u00aa",
  textordmasculine: "\u00ba",
  textleftarrow: "\u2190",
  textrightarrow: "\u2192",
  textuparrow: "\u2191",
  textdownarrow: "\u2193",
  textlangle: "\u27e8",
  textrangle: "\u27e9",
  textbardbl: "\u2016",
  textopenbullet: "\u25e6",
  textbigcircle: "\u25ef",
  guillemetleft: "\u00ab",
  guillemetright: "\u00bb",
  guilsinglleft: "\u2039",
  guilsinglright: "\u203a",
  quotedblbase: "\u201e",
  quotesinglbase: "\u201a",
  dh: "\u00f0",
  DH: "\u00d0",
  th: "\u00fe",
  TH: "\u00de",
  ng: "\u014b",
  NG: "\u014a",
  dj: "\u0111",
  DJ: "\u0110",
  // logos
  XeLaTeX: "XeLaTeX",
  XeTeX: "XeTeX",
  LuaLaTeX: "LuaLaTeX",
  LuaTeX: "LuaTeX",
  pdfLaTeX: "pdfLaTeX",
  pdfTeX: "pdfTeX",
  eTeX: "\u03b5-TeX",
  AmS: "AMS",
  AmSTeX: "AMS-TeX",
  ConTeXt: "ConTeXt",
  MiKTeX: "MiKTeX",
  KOMAScript: "KOMA-Script",
};

/** Accent commands: the combining mark, and the spacing form used for an empty argument. */
export const ACCENTS: Record<string, [string, string]> = {
  "'": ["\u0301", "\u00b4"],
  "`": ["\u0300", "`"],
  "^": ["\u0302", "^"],
  '"': ["\u0308", "\u00a8"],
  "~": ["\u0303", "~"],
  "=": ["\u0304", "\u00af"],
  ".": ["\u0307", "\u02d9"],
  u: ["\u0306", "\u02d8"],
  v: ["\u030c", "\u02c7"],
  H: ["\u030b", "\u02dd"],
  c: ["\u0327", "\u00b8"],
  k: ["\u0328", "\u02db"],
  r: ["\u030a", "\u02da"],
  d: ["\u0323", "."],
  b: ["\u0331", "_"],
  t: ["\u0361", ""],
};

/** Apply an accent to the text of its argument (`\i` and `\j` lose their dotlessness under it). */
export function accent(name: string, arg: string): string {
  const [mark, spacing] = ACCENTS[name];
  const base = arg
    .trim()
    .replace(/\\([ij])(?![A-Za-z])\s*/g, "$1")
    .replace(/\\([A-Za-z]+)\s*/g, (m, w: string) => SYMBOLS[w] ?? m);
  if (!base) return spacing;
  const first = String.fromCodePoint(base.codePointAt(0)!);
  return (first + mark + base.slice(first.length)).normalize("NFC");
}

/** TeX's text-font ligatures for dashes and quotes. */
export function ligatures(s: string): string {
  if (!/[-`'!?]/.test(s)) return s;
  return s
    .replace(/---/g, "\u2014")
    .replace(/--/g, "\u2013")
    .replace(/``/g, "\u201c")
    .replace(/''/g, "\u201d")
    .replace(/!`/g, "\u00a1")
    .replace(/\?`/g, "\u00bf")
    .replace(/`/g, "\u2018")
    .replace(/'/g, "\u2019");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** What \today prints, e.g. "October 6, 2026". */
export function today(d = new Date()): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Unescape the characters people backslash inside \url and \href targets. */
export function unescapeUrl(s: string): string {
  return s.replace(/\\([%#&_$~{}])/g, "$1").trim();
}

/** Trim math source without breaking a trailing control space or a trailing comment. */
export function trimMath(s: string): string {
  let out = s.replace(/^\s+/, "");
  let e = out.length;
  while (e > 0 && /\s/.test(out[e - 1])) e--;
  let slashes = 0;
  while (e - slashes > 0 && out[e - slashes - 1] === "\\") slashes++;
  if (slashes % 2 === 1 && e < out.length) e++;
  out = out.slice(0, e);
  const lastLine = out.slice(out.lastIndexOf("\n") + 1);
  if (/(^|[^\\])(\\\\)*%/.test(lastLine)) out += "\n";
  return out;
}

/** The first \label{...} in math source, ignoring comments. */
export function firstLabel(tex: string): string | undefined {
  const code = tex.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, "$1$2");
  const m = /\\label\s*\{([^{}]*)\}/.exec(code);
  return m ? m[1].trim() : undefined;
}

/** Turn a LaTeX length into CSS: 0.6\textwidth -> "60%"; absolute units stay as written. */
export function cssLength(v: string): string {
  const m = /^\s*([0-9]*\.?[0-9]*)\s*\\(textwidth|linewidth|columnwidth|hsize|textheight)\s*$/.exec(v);
  if (!m) return v.trim();
  const f = m[1] ? Number(m[1]) : 1;
  const pct = Math.round((Number.isNaN(f) ? 1 : f) * 100000) / 1000;
  return `${pct}${m[2] === "textheight" ? "vh" : "%"}`;
}

// ------------------------------------------------------------- inline lists

type Wrapper = Extract<Inline, { t: "Emph" | "Strong" | "Underline" | "Strike" | "SmallCaps" | "Superscript" | "Subscript" }>;
const WRAPPERS = new Set(["Emph", "Strong", "Underline", "Strike", "SmallCaps", "Superscript", "Subscript"]);

function isWrapper(x: Inline): x is Wrapper {
  return WRAPPERS.has(x.t);
}

/** Merge adjacent text, adjacent code and adjacent wrappers of the same kind. */
export function normalizeInlines(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (x.t === "Text") {
      if (!x.text) continue;
      if (last?.t === "Text") {
        out[out.length - 1] = { t: "Text", text: last.text + x.text };
        continue;
      }
    } else if (x.t === "Code" && last?.t === "Code" && !x.pos) {
      out[out.length - 1] = { ...last, text: last.text + x.text };
      continue;
    } else if (isWrapper(x)) {
      const content = normalizeInlines(x.content);
      if (!content.length) continue;
      if (last && last.t === x.t && isWrapper(last)) {
        out[out.length - 1] = { t: x.t, content: normalizeInlines([...last.content, ...content]) } as Inline;
        continue;
      }
      out.push({ ...x, content } as Inline);
      continue;
    }
    out.push(x);
  }
  return out;
}

function trimEdge(list: Inline[], atStart: boolean): Inline[] {
  // Drop from the edge by moving [from, to) rather than splicing: a paragraph that starts with
  // thousands of \\ would otherwise be shifted once per line break.
  const out = list.slice();
  let from = 0;
  let to = out.length;
  while (from < to) {
    const k = atStart ? from : to - 1;
    const x = out[k];
    let keep = false;
    if (x.t === "Text") {
      const text = atStart ? x.text.replace(/^[ \t\n]+/, "") : x.text.replace(/[ \t\n]+$/, "");
      if (text) {
        out[k] = { t: "Text", text };
        keep = true;
      }
    } else if (isWrapper(x)) {
      const content = trimEdge(x.content, atStart);
      if (content.length) {
        out[k] = { ...x, content } as Inline;
        keep = true;
      }
    } else if (x.t !== "SoftBreak" && x.t !== "LineBreak") keep = true;
    if (keep) break;
    if (atStart) from++;
    else to--;
  }
  return from === 0 && to === out.length ? out : out.slice(from, to);
}

/** Normalize, then drop leading and trailing whitespace and line breaks. */
export function trimInlines(list: Inline[]): Inline[] {
  return trimEdge(trimEdge(normalizeInlines(list), true), false);
}

/** True when the list holds nothing but whitespace. */
export function isBlank(list: Inline[]): boolean {
  return list.every((x) => (x.t === "Text" && !x.text.trim()) || x.t === "SoftBreak" || (isWrapper(x) && isBlank(x.content)));
}

/** Plain text with no-break spaces turned into spaces and runs of whitespace collapsed. */
export function plainString(list: Inline[]): string {
  return plainText(list).replace(/[\s\u00a0]+/g, " ").trim();
}

/** Flatten blocks into one inline run (block content met in an inline context). */
export function blocksToInlines(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  for (const b of blocks) {
    let part: Inline[];
    switch (b.t) {
      case "Para":
      case "Plain":
      case "Heading":
        part = b.content;
        break;
      case "MathBlock":
        part = [b.pos ? { t: "Math", tex: b.tex, pos: b.pos } : { t: "Math", tex: b.tex }];
        break;
      case "CodeBlock":
        part = [{ t: "Code", text: b.text }];
        break;
      case "RawBlock":
        part = [{ t: "RawInline", format: b.format, text: b.text }];
        break;
      case "BlockQuote":
      case "Div":
      case "Theorem":
        part = blocksToInlines(b.blocks);
        break;
      case "Figure":
        part = [...blocksToInlines(b.content), ...(b.caption ? [{ t: "Text", text: " " } as Inline, ...b.caption] : [])];
        break;
      case "List":
        part = blocksToInlines(b.items.flat());
        break;
      case "DefList":
        part = b.items.flatMap((it) => [...it.term, { t: "Text", text: " " } as Inline, ...blocksToInlines(it.defs.flat())]);
        break;
      case "Table":
        part = [...b.head, ...b.body].flatMap((row) => row.flatMap((c) => [...c.content, { t: "Text", text: " " } as Inline]));
        break;
      default:
        part = [];
    }
    if (!part.length) continue;
    if (out.length) out.push({ t: "Text", text: " " });
    out.push(...part);
  }
  return out;
}
