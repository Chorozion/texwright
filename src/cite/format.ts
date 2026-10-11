/** Building blocks shared by the numeric and author-year styles. */

import { plainText, type Inline } from "../ast.js";
import { dateParts } from "./dates.js";
import type { BibEntry, DateParts, Name } from "./types.js";

export const NBSP = "\u00a0";
export type TextNode = Extract<Inline, { t: "Text" }>;
export type Style = "numeric" | "author-year";

export const text = (s: string): TextNode => ({ t: "Text", text: s });
export const emph = (content: Inline[]): Inline => ({ t: "Emph", content });
export const link = (url: string, content: Inline[]): Inline => ({ t: "Link", url, content });

// ------------------------------------------------------------------ rich text

type RichKind = "Emph" | "Strong" | "Superscript" | "Subscript" | "SmallCaps";

const OPEN_TAGS: [string, RichKind | null, string][] = [
  ["<i>", "Emph", "</i>"],
  ["<b>", "Strong", "</b>"],
  ["<sup>", "Superscript", "</sup>"],
  ["<sub>", "Subscript", "</sub>"],
  ['<span style="font-variant:small-caps;">', "SmallCaps", "</span>"],
  ['<span class="nocase">', null, "</span>"],
];

/** CSL rich text (<i>, <b>, <sup>, <sub>, small caps and nocase spans, $math$) to inlines. */
export function richText(s: string): Inline[] {
  interface Frame {
    kind: RichKind | null;
    close: string;
    content: Inline[];
  }
  const stack: Frame[] = [{ kind: null, close: "", content: [] }];
  let buf = "";
  const top = (): Frame => stack[stack.length - 1];
  const flush = (): void => {
    if (buf) top().content.push(text(buf));
    buf = "";
  };
  const pop = (): void => {
    const f = stack.pop() as Frame;
    if (f.kind) top().content.push({ t: f.kind, content: f.content });
    else top().content.push(...f.content);
  };
  for (let i = 0; i < s.length; ) {
    if (s[i] === "<") {
      const open = OPEN_TAGS.find(([tag]) => s.startsWith(tag, i));
      if (open) {
        flush();
        stack.push({ kind: open[1], close: open[2], content: [] });
        i += open[0].length;
        continue;
      }
      if (stack.length > 1 && s.startsWith(top().close, i)) {
        const len = top().close.length;
        flush();
        pop();
        i += len;
        continue;
      }
    } else if (s[i] === "$") {
      const end = mathEnd(s, i);
      if (end > 0) {
        flush();
        top().content.push({ t: "Math", tex: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += s[i++];
  }
  flush();
  while (stack.length > 1) pop();
  return stack[0].content;
}

/** Pandoc's rule: "$" opens math before a non-space; the closing "$" follows a non-space and precedes no digit. */
function mathEnd(s: string, start: number): number {
  if (!s[start + 1] || /\s|\$/.test(s[start + 1])) return -1;
  for (let j = start + 2; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "$" && !/\s/.test(s[j - 1]) && !/[0-9]/.test(s[j + 1] ?? "")) return j;
  }
  return -1;
}

/** Rich text without its markup, for sorting and comparisons. */
export function stripMarkup(s: string): string {
  return s.replace(/<\/?(?:i|b|sup|sub)>|<span (?:style="font-variant:small-caps;"|class="nocase")>|<\/span>/g, "");
}

/** Drop a single trailing period so punctuation added after it never doubles. */
export const stripPeriod = (s: string): string => s.replace(/([^.])\.$/, "$1");

// ------------------------------------------------------------------ names

export const isOthers = (n: Name): boolean => n.literal?.toLowerCase() === "others";

/** Family name with its non-dropping particle ("van Beethoven"), or the literal. */
export function familyName(n: Name): string {
  if (n.literal) return n.literal;
  return [n["non-dropping-particle"], n.family].filter(Boolean).join(" ") || n.given || "";
}

/** "Albert Bruce" -> "A. B.", "Jean-Paul" -> "J.-P.", "AB" -> "A. B." */
export function initials(given: string): string {
  const out: string[] = [];
  for (const word of given.split(/\s+/)) {
    if (/^\p{Lu}{2,3}$/u.test(word)) out.push(...Array.from(word, (c) => `${c}.`));
    else {
      const parts = word.split("-").map((p) => /\p{L}/u.exec(p)?.[0]);
      if (parts.some(Boolean)) out.push(parts.filter(Boolean).map((c) => `${c}.`).join("-"));
    }
  }
  return out.join(NBSP);
}

/** "A. B. van Doe Jr." or, inverted, "van Doe, A. B., Jr." */
export function displayName(n: Name, inverted: boolean): string {
  if (n.literal) return n.literal;
  const family = [n["non-dropping-particle"], n.family].filter(Boolean).join(" ");
  if (!family) return n.given ?? "";
  const given = [n.given ? initials(n.given) : "", n["dropping-particle"]].filter(Boolean).join(" ");
  return inverted ? [family, given, n.suffix].filter(Boolean).join(", ") : [given, family, n.suffix].filter(Boolean).join(" ");
}

/** A full name list with "and" before the last name; after `max` names, or at an "others" marker, "et al.". */
export function nameList(names: Name[], max: number, invertFirst: boolean): string {
  let shown = names.filter((n) => !isOthers(n));
  let etAl = shown.length < names.length;
  if (shown.length > max) {
    shown = shown.slice(0, max);
    etAl = true;
  }
  const parts = shown.map((n, k) => displayName(n, invertFirst && k === 0));
  const inverted = invertFirst && shown.length > 0 && !shown[0].literal;
  if (parts.length === 0) return "";
  if (etAl) return parts.length === 1 && !inverted ? `${parts[0]} et al.` : `${parts.join(", ")}, et al.`;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts.join(inverted ? ", and " : " and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The author part of a citation: "Doe", "Doe and Roe", "Doe et al.". */
export function shortNames(names: Name[]): string {
  const real = names.filter((n) => !isOthers(n));
  if (real.length === 0) return "";
  const first = familyName(real[0]);
  if (real.length >= 3 || real.length < names.length) return `${first} et al.`;
  if (real.length === 2) return `${first} and ${familyName(real[1])}`;
  return first;
}

/** Types whose editors edit the container, not the work itself. */
const isPart = (type: string): boolean => type === "chapter" || type === "paper-conference" || type.startsWith("entry-");

/** Who heads a reference: the authors, or else the editors of a work that is not part of a larger one. */
export function creators(e: BibEntry): { names: Name[]; editors: boolean } | undefined {
  if (e.author?.length) return { names: e.author, editors: false };
  if (e.editor?.length && !isPart(e.type)) return { names: e.editor, editors: true };
  return undefined;
}

/** "Ed."/"Eds." (numeric) or "ed."/"eds." (author-year). */
export function editorLabel(names: Name[], capital: boolean): string {
  const label = names.length > 1 ? "eds." : "ed.";
  return capital ? label[0].toUpperCase() + label.slice(1) : label;
}

// ------------------------------------------------------------------ titles

/** Standalone works get italic titles; parts of something larger get quotes. */
export function italicTitle(type: string, style: Style): boolean {
  return type === "book" || type === "periodical" || type === "pamphlet" || (style === "author-year" && type === "thesis");
}

/** Short title for citations without an author: italic or in quotes. */
export function titleForCitation(e: BibEntry, style: Style): Inline[] | undefined {
  const short = e["title-short"];
  const title = typeof short === "string" && short ? short : e.title;
  if (!title) return undefined;
  const t = richText(stripPeriod(title));
  return italicTitle(e.type, style) ? [emph(t)] : [text("“"), ...t, text("”")];
}

// ------------------------------------------------------------------ dates, pages, editions

export function yearOf(e: BibEntry): string | undefined {
  const parts = dateParts(e.issued);
  if (parts) return String(parts[0]);
  return e.issued?.literal || undefined;
}

export function yearNumber(e: BibEntry): number | undefined {
  return dateParts(e.issued)?.[0];
}

const MONTHS_SHORT = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Mar. 2020", "Mar. 15, 2020" (long: "March 15, 2020"), "2020", or the literal. */
export function formatDate(d: DateParts | undefined, long: boolean): string | undefined {
  const parts = dateParts(d);
  if (!parts) return d?.literal || undefined;
  const [year, month, day] = parts;
  if (!month || month < 1 || month > 12) return String(year);
  const name = (long ? MONTHS_LONG : MONTHS_SHORT)[month - 1];
  return day ? `${name} ${day}, ${year}` : `${name} ${year}`;
}

/** Hyphens between page numbers become en dashes. */
export const pageRange = (p: string): string => p.replace(/([\p{L}\p{N}])\s*(?:-{1,3}|[–—])\s*(?=[\p{L}\p{N}])/gu, "$1–");

/** "p. 5" or "pp. 10–20". */
export function pagesLabel(p: string): string {
  const range = pageRange(p);
  return `${/[–,&]/.test(range) ? "pp." : "p."}${NBSP}${range}`;
}

/** "2" -> "2nd ed.", "Second" -> "Second ed."; editions that already say "ed." stay as they are. */
export function editionLabel(ed: string): string {
  if (/^\d+$/.test(ed)) {
    const n = Number(ed);
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
    return `${n}${suffix} ed.`;
  }
  return /\bed(\.|ition)?$/i.test(ed) ? ed : `${ed} ed.`;
}

/** Citation locators: "4" -> "p. 4", "10-12" -> "pp. 10–12", "p. 4" -> "p.\u00a04". */
export function locatorLabel(loc: string): string {
  const t = loc.trim();
  if (/^\d+$/.test(t)) return `p.${NBSP}${t}`;
  if (/^\d+\s*(?:-{1,2}|–)\s*\d+$/.test(t)) return `pp.${NBSP}${pageRange(t)}`;
  return pageRange(t).replace(/^(\p{L}+\.?)\s+/u, `$1${NBSP}`);
}

export const doiUrl = (doi: string): string => `https://doi.org/${doi.replace(/[\s"<>#?]/g, (c) => encodeURIComponent(c))}`;

// ------------------------------------------------------------------ punctuation-aware joining

/** One part of a reference. `before` is the delimiter put between it and the previous part (default ", "). */
export interface Piece {
  content: Inline[];
  before?: string;
  /** Wrap in curly quotes; a following comma or period moves inside the closing quote. */
  quoted?: boolean;
}

export const piece = (s: string | undefined, before?: string): Piece | undefined => (s ? { content: [text(s)], before } : undefined);

/**
 * Join pieces with their delimiters and finish with `end`. A period is never
 * doubled, a comma or period after "?" or "!" is dropped, and commas and
 * periods go inside closing quotes.
 */
export function chain(pieces: (Piece | undefined)[], end: string): Inline[] {
  const out: Inline[] = [];
  let openQuote = false;
  for (const p of pieces) {
    if (!p || p.content.length === 0) continue;
    if (out.length > 0) delimit(out, p.before ?? ", ", openQuote);
    if (p.quoted) out.push(text("“"));
    out.push(...p.content);
    openQuote = p.quoted === true;
  }
  if (out.length > 0) delimit(out, end, openQuote);
  return mergeText(out);
}

function delimit(out: Inline[], delim: string, closeQuote: boolean): void {
  let mark = /^[.,;:]/.test(delim) ? delim[0] : "";
  const rest = delim.slice(mark.length);
  const last = plainText(out).trimEnd().slice(-1);
  if ((mark === "." && last === ".") || ((mark === "." || mark === ",") && (last === "?" || last === "!"))) mark = "";
  if (!closeQuote) out.push(text(mark + rest));
  else if (mark === "." || mark === ",") out.push(text(`${mark}”${rest}`));
  else out.push(text(`”${mark}${rest}`));
}

/** Merge neighbouring Text nodes, recursively. */
export function mergeText(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.t === "Text" && prev?.t === "Text") out[out.length - 1] = text(prev.text + n.text);
    else if (n.t === "Text" && n.text === "") continue;
    else if ("content" in n && Array.isArray(n.content)) out.push({ ...n, content: mergeText(n.content) } as Inline);
    else out.push(n);
  }
  return out;
}
