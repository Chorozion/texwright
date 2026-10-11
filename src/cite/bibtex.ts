/**
 * BibTeX / biblatex reader.
 *
 * Real .bib files are messy, so the reader recovers instead of giving up: a
 * syntax error is reported as CITE003 with its line and column, and reading
 * resumes at the next "@". Field values are converted from LaTeX to Unicode
 * and the entries are mapped to CSL-JSON field names.
 */

import type { Pos } from "../ast.js";
import type { Diagnostics, Severity } from "../diagnostics.js";
import { MinTree, lowerBound } from "../parse/latex/search.js";
import { MONTH_KEYS, parseDateString, parseMonth } from "./dates.js";
import { latexToText, latexToUrl } from "./latex.js";
import { parseBibtexNames } from "./names.js";
import { setEntrySource } from "./source.js";
import type { BibEntry, DateParts } from "./types.js";

interface RawEntry {
  type: string;
  key: string;
  offset: number;
  /** Lowercase field name to raw LaTeX value. */
  fields: Map<string, string>;
}

class BibSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const FIELD_NAME = /[^\s"#%'(),={}]/;

/**
 * Characters that @string references may add to a file's values in all.
 * Each reference copies the macro's text, so a chain of @string{b = a # a}
 * doubles at every step and a few hundred bytes spell out gigabytes.
 */
const MAX_MACRO_TEXT = 1_000_000;

/** Delimiter pairs for the whole file, so an unclosed `{`, `"` or `(` does not rescan the rest of it once per entry. */
interface Pairs {
  /** 1 where the character is the second half of a backslash escape. */
  skip: Uint8Array;
  /** For each `{` and `(`, the index of its matching `}` or `)`, else -1. */
  match: Int32Array;
  /** Unescaped `"` offsets, with the innermost `{` still open at each (or -1). */
  quotes: Int32Array;
  quoteTops: MinTree;
}

function delimiterPairs(s: string): Pairs {
  const n = s.length;
  const skip = new Uint8Array(n + 1);
  const match = new Int32Array(n).fill(-1);
  const curly: number[] = [];
  const round: number[] = [];
  const quotes: number[] = [];
  const tops: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      skip[i + 1] = 1;
      i++;
    } else if (c === 123) curly.push(i);
    else if (c === 125) {
      const o = curly.pop();
      if (o !== undefined) match[o] = i;
    } else if (c === 40) round.push(i);
    else if (c === 41) {
      const o = round.pop();
      if (o !== undefined) match[o] = i;
    } else if (c === 34) {
      quotes.push(i);
      tops.push(curly.length ? curly[curly.length - 1] : -1);
    }
  }
  return { skip, match, quotes: Int32Array.from(quotes), quoteTops: new MinTree(tops.length, (k) => tops[k]) };
}

class BibtexReader {
  private i = 0;
  private readonly macros = new Map<string, string>(MONTH_KEYS.map((m, k) => [m, String(k + 1)]));
  private readonly entries: RawEntry[] = [];
  private readonly firstOffset = new Map<string, number>();
  private pairs?: Pairs;
  /** Characters @string references have added so far. */
  private macroText = 0;

  constructor(
    private readonly text: string,
    private readonly at: (offset: number) => Pos,
    private readonly diagnostics: Diagnostics,
  ) {}

  read(): RawEntry[] {
    for (let at = this.nextAt(0); at >= 0; at = this.nextAt(this.i)) {
      this.i = at;
      try {
        this.command();
      } catch (err) {
        if (!(err instanceof BibSyntaxError)) throw err;
        this.report(err.message, err.offset, "error", err.hint);
        this.i = at + 1;
      }
    }
    return this.entries;
  }

  report(message: string, offset: number, severity: Severity, hint?: string): void {
    this.diagnostics.add("CITE003", message, this.at(offset), { severity, hint });
  }

  /** The next "@" that can start an entry. Free text is skipped, including % lines and e-mail addresses. */
  private nextAt(from: number): number {
    const s = this.text;
    for (let j = from; j < s.length; j++) {
      if (s[j] === "%") {
        j = s.indexOf("\n", j);
        if (j < 0) return -1;
      } else if (s[j] === "@" && (j === 0 || !/[\w.+-]/.test(s[j - 1]))) return j;
    }
    return -1;
  }

  private command(): void {
    const s = this.text;
    const start = this.i++;
    this.skipSpace();
    const type = this.readWhile(/[A-Za-z0-9_-]/);
    if (!type) throw new BibSyntaxError('Expected an entry type after "@"', this.i, "Entries look like @article{key, title = {...}}");
    this.skipSpace();
    const open = s[this.i];
    if (open !== "{" && open !== "(") throw new BibSyntaxError(`Expected "{" or "(" after @${type}`, this.i);
    const close = open === "{" ? "}" : ")";
    this.i++;
    const kind = type.toLowerCase();
    if (kind === "comment") {
      // An unbalanced @comment is treated like free text so the entries after it still parse.
      const end = this.balancedEnd(open, close);
      if (end >= 0) this.i = end;
    } else if (kind === "preamble") {
      const end = this.balancedEnd(open, close);
      if (end < 0) throw new BibSyntaxError(`@preamble is not closed; expected "${close}"`, start);
      this.i = end;
    } else if (kind === "string") this.stringDefinition(close);
    else this.entry(type, close, start);
  }

  /** Offset just past the delimiter closing the block that starts at this.i, or -1. */
  private balancedEnd(open: string, close: string): number {
    const s = this.text;
    // The opener sits just before this.i; unless it is escaped, the file's pairs answer this.
    this.pairs ??= delimiterPairs(s);
    if (s[this.i - 1] === open && !this.pairs.skip[this.i - 1]) {
      const m = this.pairs.match[this.i - 1];
      return m < 0 ? -1 : m + 1;
    }
    let depth = 1;
    for (let j = this.i; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === open) depth++;
      else if (s[j] === close && --depth === 0) return j + 1;
    }
    return -1;
  }

  private stringDefinition(close: string): void {
    const s = this.text;
    this.skipSpace();
    const name = this.readWhile(FIELD_NAME);
    if (!name) throw new BibSyntaxError("Expected a macro name in @string", this.i);
    this.skipSpace();
    if (s[this.i] !== "=") throw new BibSyntaxError(`Expected "=" after @string name "${name}"`, this.i);
    this.i++;
    const value = this.value(`@string ${name}`);
    this.skipSpace();
    if (s[this.i] === ",") {
      this.i++;
      this.skipSpace();
    }
    if (s[this.i] !== close) throw new BibSyntaxError(`Expected "${close}" to close @string ${name}`, this.i);
    this.i++;
    this.macros.set(name.toLowerCase(), value);
  }

  private entry(type: string, close: string, start: number): void {
    const s = this.text;
    this.skipSpace();
    const key = this.readWhile((c) => !/[\s,{}]/.test(c) && c !== close);
    if (!key) throw new BibSyntaxError(`@${type} entry has no citation key`, this.i, "Write it as @type{key, field = {value}, ...}");
    this.skipSpace();
    if (s[this.i] !== "," && s[this.i] !== close) throw new BibSyntaxError(`Expected "," after the key "${key}"`, this.i);
    const fields = new Map<string, string>();
    for (;;) {
      this.skipSpaceAndComments();
      const c = s[this.i];
      if (c === undefined) throw new BibSyntaxError(`Entry "${key}" is not closed; expected "${close}"`, start);
      if (c === close) {
        this.i++;
        break;
      }
      if (c === ",") {
        this.i++;
        continue;
      }
      const nameOffset = this.i;
      const name = this.readWhile(FIELD_NAME).toLowerCase();
      if (!name) throw new BibSyntaxError(`Unexpected "${c}" in entry "${key}"; expected a field name`, this.i);
      this.skipSpace();
      if (s[this.i] !== "=") throw new BibSyntaxError(`Expected "=" after field "${name}" in entry "${key}"`, this.i);
      this.i++;
      const value = this.value(`field "${name}" of entry "${key}"`);
      if (fields.has(name)) this.report(`Field "${name}" appears twice in entry "${key}"; the first value is kept`, nameOffset, "warning");
      else fields.set(name, value);
      this.skipSpaceAndComments();
      const next = s[this.i];
      if (next === undefined) throw new BibSyntaxError(`Entry "${key}" is not closed; expected "${close}"`, start);
      if (next !== "," && next !== close) {
        throw new BibSyntaxError(
          `Expected "," or "${close}" after field "${name}" in entry "${key}"`,
          this.i,
          /[A-Za-z]/.test(next) ? `Add a comma after the value of "${name}".` : undefined,
        );
      }
    }
    const first = this.firstOffset.get(key);
    if (first !== undefined) {
      const line = this.at(first).line;
      this.report(`Duplicate entry key "${key}"; the entry on line ${line} is kept`, start, "warning", "Rename or remove one of the entries.");
      return;
    }
    this.firstOffset.set(key, start);
    this.entries.push({ type, key, offset: start, fields });
  }

  /** A field value: braced, quoted, number or macro parts joined with #. Returned as raw LaTeX. */
  private value(where: string): string {
    const s = this.text;
    let out = "";
    for (;;) {
      this.skipSpace();
      const c = s[this.i];
      const at = this.i;
      if (c === "{") out += this.delimited(where);
      else if (c === '"') out += this.delimited(where);
      else if (c !== undefined && /[0-9]/.test(c)) out += this.readWhile(/[0-9]/);
      else if (c !== undefined && FIELD_NAME.test(c)) {
        const name = this.readWhile(FIELD_NAME);
        let macro = this.macros.get(name.toLowerCase());
        if (macro === undefined) {
          this.report(`Undefined @string macro "${name}" in ${where}`, at, "warning", `Define it with @string{${name} = {...}} or put the value in braces.`);
        } else if ((this.macroText += macro.length) > MAX_MACRO_TEXT) {
          if (this.macroText - macro.length <= MAX_MACRO_TEXT) {
            this.report(`@string macros expand to more than ${MAX_MACRO_TEXT.toLocaleString("en-US")} characters; "${name}" in ${where} and later uses were left empty`, at, "error", "Look for @string definitions that repeat other @string macros.");
          }
          macro = "";
        }
        out += macro ?? "";
      } else {
        throw new BibSyntaxError(`Expected a value for ${where}`, at, 'Write values as {text}, "text", a number, or an @string name.');
      }
      this.skipSpace();
      if (s[this.i] !== "#") return out;
      this.i++;
    }
  }

  /** {...} with nested braces, or "..." where quotes inside braces (and \") do not end the value. */
  private delimited(where: string): string {
    const s = this.text;
    const start = this.i;
    const quoted = s[start] === '"';
    this.pairs ??= delimiterPairs(s);
    if (!this.pairs.skip[start]) {
      // From the file's pairs: a brace's match, or the first quote that no brace opened after `start` encloses.
      let close: number;
      if (quoted) {
        const k = this.pairs.quoteTops.firstBelow(lowerBound(this.pairs.quotes, start + 1), start);
        close = k < 0 ? -1 : this.pairs.quotes[k];
      } else close = this.pairs.match[start];
      if (close >= 0) {
        this.i = close + 1;
        return s.slice(start + 1, close);
      }
      throw this.unclosed(where, start, quoted);
    }
    let depth = quoted ? 0 : 1;
    for (let j = start + 1; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") j++;
      else if (c === "{") depth++;
      else if (c === "}") {
        if (!quoted && --depth === 0) {
          this.i = j + 1;
          return s.slice(start + 1, j);
        }
        if (quoted) depth = Math.max(0, depth - 1);
      } else if (quoted && c === '"' && depth === 0) {
        this.i = j + 1;
        return s.slice(start + 1, j);
      }
    }
    throw this.unclosed(where, start, quoted);
  }

  private unclosed(where: string, start: number, quoted: boolean): BibSyntaxError {
    return new BibSyntaxError(
      quoted ? `Unclosed quote in ${where}` : `Unclosed "{" in ${where}`,
      start,
      quoted ? 'End the value with a matching ".' : "Every { in a value needs a matching }.",
    );
  }

  private readWhile(test: RegExp | ((c: string) => boolean)): string {
    const s = this.text;
    const ok = typeof test === "function" ? test : (c: string) => test.test(c);
    const start = this.i;
    while (this.i < s.length && ok(s[this.i])) this.i++;
    return s.slice(start, this.i);
  }

  private skipSpace(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i++;
  }

  /** Between fields, % starts a comment that runs to the end of the line. */
  private skipSpaceAndComments(): void {
    for (;;) {
      this.skipSpace();
      if (this.text[this.i] !== "%") return;
      const nl = this.text.indexOf("\n", this.i);
      this.i = nl < 0 ? this.text.length : nl;
    }
  }
}

export function parseBibtex(text: string, ctx: { file?: string; diagnostics: Diagnostics }): BibEntry[] {
  if (ctx.file) ctx.diagnostics.registerSource(ctx.file, text);
  // A byte-order mark becomes a space so offsets, lines and columns stay put.
  const source = text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text;
  const at = lineIndex(source, ctx.file);
  const raw = new BibtexReader(source, at, ctx.diagnostics).read();
  const byKey = new Map<string, RawEntry>();
  for (const r of raw) if (!byKey.has(r.key.toLowerCase())) byKey.set(r.key.toLowerCase(), r);
  return raw.map((r) => {
    const entry = toCsl(r, byKey);
    setEntrySource(entry, at(r.offset));
    return entry;
  });
}

/** Offset to 1-based line and column, by binary search over the line starts. */
function lineIndex(text: string, file: string | undefined): (offset: number) => Pos {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const pos: Pos = { line: lo + 1, col: offset - starts[lo] + 1 };
    if (file) pos.file = file;
    return pos;
  };
}

// ------------------------------------------------------------------ mapping to CSL

const TYPES: Record<string, string> = {
  article: "article-journal",
  book: "book",
  booklet: "pamphlet",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  manual: "report",
  mastersthesis: "thesis",
  phdthesis: "thesis",
  techreport: "report",
  unpublished: "manuscript",
  misc: "document",
  online: "webpage",
  electronic: "webpage",
  www: "webpage",
  dataset: "dataset",
  software: "software",
  // biblatex
  thesis: "thesis",
  report: "report",
  proceedings: "book",
  collection: "book",
  mvbook: "book",
  mvcollection: "book",
  mvproceedings: "book",
  reference: "book",
  inreference: "entry-encyclopedia",
  periodical: "periodical",
  patent: "patent",
  standard: "standard",
};

const DEFAULT_GENRE: Record<string, string> = {
  manual: "Manual",
  mastersthesis: "Master’s thesis",
  phdthesis: "PhD thesis",
};

/** Values of biblatex's type field that name a standard genre. */
const GENRE_NAMES: Record<string, string> = {
  phdthesis: "PhD thesis",
  mastersthesis: "Master’s thesis",
  mathesis: "Master’s thesis",
  techreport: "Tech. Rep.",
};

/** Fields a crossref child never takes from its parent (title goes to booktitle instead). */
const NOT_INHERITED = new Set(["title", "subtitle", "shorttitle", "crossref", "doi", "url", "urldate", "eprint", "ids"]);

function toCsl(raw: RawEntry, byKey: Map<string, RawEntry>): BibEntry {
  const fields = new Map(raw.fields);
  const parent = byKey.get(fields.get("crossref")?.trim().toLowerCase() ?? "");
  if (parent && parent !== raw) {
    for (const [name, field] of parent.fields) {
      if (name === "title" && !fields.has("booktitle")) fields.set("booktitle", field);
      else if (!NOT_INHERITED.has(name) && !fields.has(name)) fields.set(name, field);
    }
  }
  const get = (name: string): string | undefined => fields.get(name);
  const text = (name: string): string | undefined => {
    const v = get(name);
    return v === undefined ? undefined : latexToText(v) || undefined;
  };
  const rich = (name: string): string | undefined => {
    const v = get(name);
    return v === undefined ? undefined : latexToText(v, true) || undefined;
  };
  const url = (name: string): string | undefined => {
    const v = get(name);
    return v === undefined ? undefined : latexToUrl(v) || undefined;
  };

  const kind = raw.type.toLowerCase();
  const e: BibEntry = { id: raw.key, type: TYPES[kind] ?? "document" };
  const set = (k: string, v: unknown): void => {
    if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) e[k] = v;
  };

  const title = rich("title");
  const subtitle = rich("subtitle");
  set("title", title && subtitle ? `${title}${/[?!:.]$/.test(title) ? " " : ": "}${subtitle}` : title ?? subtitle);
  set("title-short", rich("shorttitle"));
  const author = get("author");
  if (author !== undefined) set("author", parseBibtexNames(author));
  const editor = get("editor");
  if (editor !== undefined) set("editor", parseBibtexNames(editor));
  set("issued", issued(get("date"), text("year"), text("month"), text("day")));
  set("container-title", rich("journaltitle") ?? rich("journal") ?? rich("booktitle"));
  set("collection-title", rich("series"));
  set("event-title", rich("eventtitle"));
  set("volume", text("volume"));
  if (e.type === "article-journal" || e.type === "periodical") set("issue", text("number") ?? text("issue"));
  else {
    set("number", text("number"));
    set("issue", text("issue"));
  }
  set("page", text("pages"));
  set("publisher", text("publisher") ?? text("institution") ?? text("school") ?? text("organization"));
  set("publisher-place", text("address") ?? text("location"));
  set("edition", text("edition"));
  set("DOI", url("doi")?.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, ""));
  set("URL", url("url"));
  const urldate = text("urldate");
  if (urldate) set("accessed", parseDateString(urldate));
  set("ISBN", text("isbn"));
  set("ISSN", text("issn"));
  set("note", text("note"));
  const howpublished = get("howpublished");
  if (howpublished !== undefined) {
    // howpublished = {\url{...}} is the classic way to give a URL in @misc.
    const link = /\\url\s*\{([^}]*)\}/.exec(howpublished);
    if (link) set("URL", e.URL ?? latexToUrl(link[1]));
    if (!e.note) set("note", latexToText(link ? howpublished.replace(link[0], "") : howpublished));
  }
  const typeField = get("type");
  set("genre", typeField !== undefined ? GENRE_NAMES[typeField.trim().toLowerCase()] ?? latexToText(typeField) : DEFAULT_GENRE[kind]);
  const eprint = text("eprint");
  if (eprint && /arxiv/i.test(get("archiveprefix") ?? get("eprinttype") ?? "")) {
    set("number", e.number ?? `arXiv:${eprint}`);
    set("URL", e.URL ?? `https://arxiv.org/abs/${eprint}`);
  }
  return e;
}

function issued(date: string | undefined, year: string | undefined, month: string | undefined, day: string | undefined): DateParts | undefined {
  if (date) return parseDateString(latexToText(date));
  if (!year) return undefined;
  if (!/^-?\d{1,4}$/.test(year)) return { literal: year };
  const parts = [Number(year)];
  const m = month ? parseMonth(month) : {};
  if (m.month) {
    parts.push(m.month);
    const d = day ? Number(day) : m.day;
    if (d && d >= 1 && d <= 31) parts.push(d);
  }
  return { "date-parts": [parts] };
}
