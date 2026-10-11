/**
 * YAML front matter: finding it at the top of a Markdown file and mapping its
 * keys onto `Meta`. Unknown keys are kept in `meta.extra`.
 */
import { parseYaml } from "../../util/yaml.js";
import type { Block, Inline, Meta } from "../../ast.js";
import { closestFix } from "../../fixes.js";
import type { FixSpec } from "../../diagnostics.js";

export interface FrontMatter {
  yaml: string;
  /** Lines taken by the front matter, fences included. */
  lineCount: number;
}

/** Front matter between a first line `---` and a closing `---` or `...`. */
export function findFrontMatter(text: string): FrontMatter | null {
  const lines = text.split("\n");
  if (lines[0].trimEnd() !== "---" || lines.length < 2 || lines[1].trim() === "") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === "---" || line === "...") return { yaml: lines.slice(1, i).join("\n"), lineCount: i + 1 };
  }
  return null;
}

/** A `---` first line followed by `key:` but never closed: almost certainly broken front matter. */
export function looksLikeUnclosedFrontMatter(text: string): boolean {
  const lines = text.split("\n", 2);
  return lines[0].trimEnd() === "---" && /^[A-Za-z_][\w-]*\s*:/.test(lines[1] ?? "") && findFrontMatter(text) === null;
}

/** Lines that belong to a YAML block: keys, indented continuations, list items and comments. */
const YAML_LINE = /^(?:[A-Za-z_][\w-]*\s*:|[ \t]+\S|-\s|#)/;

/**
 * The fix for front matter that starts with --- and never ends: a --- after its last YAML line,
 * where a blank line or the body begins. Safe when the lines up to there read as YAML and what
 * follows does not look like more of it.
 */
export function unclosedFrontMatterFix(text: string): FixSpec | undefined {
  const lines = text.split("\n");
  let k = 1;
  while (k < lines.length && YAML_LINE.test(lines[k]!) && !/^#\s/.test(lines[k]!)) k++;
  if (k < 2) return undefined;
  let next = k;
  while (next < lines.length && !lines[next]!.trim()) next++;
  const valid = !parseYaml(lines.slice(1, k).join("\n")).error;
  const more = next < lines.length && /^(?:[A-Za-z_][\w-]*\s*:|[ \t]+\S)/.test(lines[next]!);
  const last = lines[k - 1]!.replace(/\r$/, "");
  return { old: last, new: `${last}\n---`, safe: valid && !more, line: k, col: 1 };
}

/**
 * Exact fixes for the YAML mistakes writers make most: a value with a colon in it left unquoted
 * (`title: Results: a study`), and tabs used to indent. `index` is the 0-based line of the error.
 */
function yamlFix(lines: string[], index: number, message: string, firstLine: number): FixSpec | undefined {
  const text = lines[index] ?? "";
  if (message.startsWith("Unexpected ':'")) {
    const m = /^(\s*(?:-\s+)?[^\s:#'"][^:#]*?:[ \t]+)(.*?)\s*$/.exec(text);
    const value = m?.[2] ?? "";
    if (!m || !value.includes(":") || /^['"[{|>&*!]/.test(value)) return undefined;
    // Double quotes, escaping what they need; single quotes when the value has double quotes.
    const quoted = value.includes('"') && !value.includes("'") ? `'${value}'` : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    // A " #" starts a comment, which quoting would pull into the value: then only the writer knows.
    return { old: value, new: quoted, safe: !/\s#/.test(value), line: firstLine + index, col: m[1]!.length + 1 };
  }
  if (message.startsWith("Tabs can't be used")) {
    // Every tab-indented line from here on, with each leading tab as two spaces.
    let end = index;
    while (end + 1 < lines.length && /^\t/.test(lines[end + 1]!)) end++;
    const block = lines.slice(index, end + 1);
    const spaced = block.map((l) => l.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length)));
    // Safe when no line indents with spaces, so the two kinds of indentation cannot disagree.
    const mixed = lines.some((l) => /^ +\S/.test(l) || /^\t* +\t/.test(l));
    return { old: block.join("\n"), new: spaced.join("\n"), safe: !mixed, line: firstLine + index, col: 1 };
  }
  return undefined;
}

/** Callbacks into the Markdown parser; lines are 1-based document lines. */
export interface MetaHelpers {
  inline(text: string, line: number): Inline[];
  blocks(text: string, line: number): Block[];
  report(code: "YAML001" | "OPT001" | "OPT002", message: string, line: number, col: number, extra?: { hint?: string; fix?: FixSpec }): void;
}

/** Parse front matter YAML (whose first line is document line `firstLine`) into Meta. */
export function frontMatterMeta(fm: FrontMatter, firstLine: number, h: MetaHelpers): Meta {
  const yamlLines = fm.yaml.split("\n");
  if (yamlLines.every((l) => l.trim() === "" || l.trim().startsWith("#"))) return {};
  // texwright's own YAML reader refuses anchors, aliases and tags outright, so a
  // value can never be larger than the YAML that spells it out: no alias bombs.
  const parsed = parseYaml(fm.yaml);
  if (parsed.error) {
    const line = Math.min(Math.max(parsed.error.line, 1), yamlLines.length);
    const fix = yamlFix(yamlLines, line - 1, parsed.error.message, firstLine);
    h.report("YAML001", `Front matter is not valid YAML: ${parsed.error.message}`, firstLine + line - 1, parsed.error.col, fix ? { fix } : undefined);
    return {};
  }
  const data: unknown = parsed.value;
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    h.report("YAML001", "Front matter must be a mapping of keys to values", firstLine, 1);
    return {};
  }

  /** Document line of a top-level key; values in block scalars (`key: |`) start on the next line. */
  const keyLine = (key: string): { line: number; valueLine: number } => {
    const i = yamlLines.findIndex((l) => l.startsWith(key) && /^\s*:/.test(l.slice(key.length)));
    const line = firstLine + Math.max(0, i);
    return { line, valueLine: i >= 0 && /:\s*[|>][-+0-9]*\s*$/.test(yamlLines[i]) ? line + 1 : line };
  };

  const meta: Meta = {};
  const extra: Record<string, unknown> = {};
  let authors: AuthorEntry[] = [];
  let authorLine = 0;
  let shared: string | undefined;
  let typos = 0;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) {
      // defineProperty, so a "__proto__" key stays data instead of replacing the prototype.
      Object.defineProperty(extra, key, { value, enumerable: true, writable: true, configurable: true });
      // A near miss of a key texwright reads is almost certainly a typo; keys of other tools pass quietly.
      if (typos < 20 && !LAYOUT_KEYS.has(key) && !OTHER_TOOLS.has(key)) {
        const near = closestFix(key, [...KNOWN_KEYS, ...LAYOUT_KEYS]);
        if (near) {
          typos++;
          h.report("OPT002", `Unknown front-matter key "${key}"`, keyLine(key).line, 1, {
            hint: `Did you mean "${near.replacement}"? Unknown keys are ignored`,
            fix: { old: key, new: near.replacement, safe: near.safe },
          });
        }
      }
      continue;
    }
    // Only known keys need their line: looking it up for thousands of unknown keys would be quadratic.
    const { line, valueLine } = keyLine(key);
    const invalid = (expected: string): void => h.report("OPT001", `Front matter "${key}" ${expected}`, line, 1);
    switch (key) {
      case "title":
      case "subtitle":
      case "date":
        meta[key] = h.inline(scalarText(value), valueLine);
        break;
      case "author":
      case "authors":
        authors = authorEntries(value);
        authorLine = valueLine;
        break;
      case "affiliation":
      case "institute":
        shared = affiliationText(value) || undefined;
        break;
      case "abstract":
        meta.abstract = h.blocks(scalarText(value), valueLine);
        break;
      case "keywords":
        meta.keywords = stringList(value, true);
        break;
      case "lang":
        meta.lang = scalarText(value);
        break;
      case "bibliography":
        meta.bibliography = stringList(value, false);
        break;
      case "citation-style":
      case "citationStyle": {
        const style = citationStyle(value);
        if (style) meta.citationStyle = style;
        else {
          const near = typeof value === "string" ? closestFix(value.trim(), ["numeric", "author-year"]) : undefined;
          h.report("OPT001", `Front matter "${key}" must be "numeric" or "author-year"`, line, 1, near && { hint: `Did you mean "${near.replacement}"?`, fix: { old: String(value).trim(), new: near.replacement, safe: near.safe } });
        }
        break;
      }
      case "macros": {
        const macros = macroTable(value);
        if (macros) meta.macros = macros;
        else invalid("must map macro names to their definitions, e.g. R: \\mathbb{R}");
        // YAML ends a plain value at " #", so `norm: \lVert #1 \rVert` silently loses everything from #1 on.
        for (let k = line - firstLine + 1; k < yamlLines.length && /^\s/.test(yamlLines[k] ?? ""); k++) {
          const m = /^(\s+)([\\\w]+)\s*:\s*([^'"|>\s][^#]*?)\s#/.exec(yamlLines[k]!);
          if (m) {
            h.report("OPT001", `Macro "${m[2]}" was cut off: YAML treats " #" as the start of a comment, so "#1" and the rest were dropped`, firstLine + k, m[1]!.length + 1);
          }
        }
        break;
      }
      case "toc":
      case "number-sections":
      case "numberSections":
      case "numbersections": {
        const flag = boolean(value);
        if (flag === undefined) invalid("must be true or false");
        else if (key === "toc") meta.toc = flag;
        else meta.numberSections = flag;
        break;
      }
      case "toc-depth":
      case "tocDepth": {
        const depth = Number(value);
        if (Number.isInteger(depth) && depth >= 1 && depth <= 6) meta.tocDepth = depth;
        else invalid("must be a whole number from 1 to 6");
        break;
      }
      case "number-within":
      case "numberWithin": {
        const within = numberWithin(value);
        if (within === undefined) invalid('must be 0, 1 or "section"');
        else meta.numberWithin = within;
        break;
      }
      default:
        break;
    }
  }
  if (authors.length) {
    meta.author = authors.map((a) => h.inline(a.name, authorLine));
    const affiliations = authors.map((a) => a.affiliation ?? shared);
    if (affiliations.some(Boolean)) meta.affiliation = affiliations.map((a) => (a ? h.inline(a, authorLine) : null));
  }
  if (Object.keys(extra).length) meta.extra = extra;
  return meta;
}

const KNOWN_KEYS = new Set([
  "title", "subtitle", "date", "author", "authors", "affiliation", "institute", "abstract", "keywords", "lang", "bibliography", "citation-style", "citationStyle",
  "macros", "toc", "number-sections", "numberSections", "numbersections", "toc-depth", "tocDepth", "number-within", "numberWithin",
]);

/** Keys the page layout reads (layoutopts.ts). */
const LAYOUT_KEYS = new Set([
  "theme", "papersize", "paper", "geometry", "margin", "landscape", "classoption", "page-numbers", "pageNumbers", "header", "footer", "max-pages", "maxPages", "fontsize", "font-size",
  "microtype",
]);

/** Keys of pandoc, Quarto, R Markdown and static-site tools: ignored without comment. */
const OTHER_TOOLS = new Set([
  "documentclass", "header-includes", "include-before", "include-after", "linestretch", "mainfont", "sansfont", "monofont", "mathfont", "fontfamily",
  "fontfamilyoptions", "colorlinks", "linkcolor", "urlcolor", "citecolor", "toccolor", "filecolor", "link-citations", "link-bibliography", "csl",
  "reference-section-title", "secnumdepth", "indent", "output", "format", "layout", "tags", "categories", "description", "draft", "slug", "permalink",
  "subject", "thanks", "nocite", "lof", "lot", "pagestyle", "toc-title", "title-meta", "author-meta", "date-meta", "abstract-title", "editor",
  "engine", "pdf-engine", "references", "suppress-bibliography", "notes-after-punctuation", "hyperrefoptions", "aspectratio", "subtitle-meta",
  "titlepage", "version", "status", "license", "copyright", "id", "uuid", "category", "summary", "excerpt", "image", "cover", "weight", "type",
]);


function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(scalarText).join(", ");
  if (value && typeof value === "object" && "name" in value) return scalarText((value as { name: unknown }).name);
  return value === null || value === undefined ? "" : String(value);
}

interface AuthorEntry {
  name: string;
  affiliation?: string;
}

/**
 * Authors as names or as pandoc/Quarto-style objects:
 *   author: [Ada Lovelace, Alan Turing]
 *   author: [{name: Ada Lovelace, affiliation: Analytical Engines}]
 *   author: [{name: Ada Lovelace, affiliations: [{name: A}, {name: B}]}]
 */
function authorEntries(value: unknown): AuthorEntry[] {
  const list = Array.isArray(value) ? value : [value];
  const out: AuthorEntry[] = [];
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const name = scalarText(o.name ?? o.text ?? "").trim();
      if (!name) continue;
      const affiliation = affiliationText(o.affiliation ?? o.affiliations ?? o.institute ?? o.institution);
      out.push(affiliation ? { name, affiliation } : { name });
    } else {
      const name = scalarText(item).trim();
      if (name) out.push({ name });
    }
  }
  return out;
}

/** An affiliation given as text, a list, or objects with a name; several are joined with commas. */
function affiliationText(value: unknown): string {
  if (value === undefined || value === null) return "";
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => (v && typeof v === "object" && !Array.isArray(v) ? scalarText((v as Record<string, unknown>).name ?? "") : scalarText(v)))
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}

function stringList(value: unknown, splitCommas: boolean): string[] {
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean);
  const text = scalarText(value);
  return (splitCommas ? text.split(",") : [text]).map((s) => s.trim()).filter(Boolean);
}

function citationStyle(value: unknown): Meta["citationStyle"] | undefined {
  const s = scalarText(value).trim().toLowerCase();
  if (s === "numeric" || s === "numbers") return "numeric";
  if (s === "author-year" || s === "authoryear" || s === "author-date") return "author-year";
  return undefined;
}

function macroTable(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(value as Record<string, unknown>)) {
    if (typeof body !== "string" && typeof body !== "number") return undefined;
    out[name.startsWith("\\") ? name : `\\${name}`] = String(body);
  }
  return out;
}

function boolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const s = scalarText(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(s)) return true;
  if (["false", "no", "off"].includes(s)) return false;
  return undefined;
}

function numberWithin(value: unknown): 0 | 1 | undefined {
  if (value === true || value === 1 || value === "1" || value === "section") return 1;
  if (value === false || value === 0 || value === "0" || value === "none") return 0;
  return undefined;
}
