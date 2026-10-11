/**
 * JSON Schema of the document model (mirrors src/ast.ts) and its validator.
 *
 * Used to validate JSON input, to print `texwright schema` for agents that
 * want to emit documents directly, and by the MCP server. Keep it in step
 * with ast.ts; test/pipeline.test.ts checks that parsed documents validate.
 */

import type { Document } from "./ast.js";
import { type JsonSchema, type ValidationIssue, validate } from "./util/validate.js";

export type { JsonSchema, ValidationIssue } from "./util/validate.js";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const str = (description?: string): JsonSchema => (description ? { type: "string", description } : { type: "string" });
const bool = (description?: string): JsonSchema => (description ? { type: "boolean", description } : { type: "boolean" });
const strings: JsonSchema = { type: "array", items: { type: "string" } };
const inlines = (description?: string): JsonSchema => ({ type: "array", items: { $ref: "#/$defs/Inline" }, ...(description ? { description } : {}) });
const blocks = (description?: string): JsonSchema => ({ type: "array", items: { $ref: "#/$defs/Block" }, ...(description ? { description } : {}) });

const POS: JsonSchema = {
  type: "object",
  description: "Source position, for diagnostics",
  properties: {
    file: str(),
    line: { type: "integer", minimum: 1, description: "1-based line" },
    col: { type: "integer", minimum: 1, description: "1-based column" },
    endLine: { type: "integer" },
    endCol: { type: "integer" },
  },
  required: ["line", "col"],
  additionalProperties: false,
};

const ATTR: JsonSchema = {
  type: "object",
  description: "Identifier, classes and key-value attributes, as written {#id .class key=value}",
  properties: {
    id: str(),
    classes: strings,
    attrs: { type: "object", additionalProperties: { type: "string" } },
  },
  additionalProperties: false,
};

const ALIGN: JsonSchema = { type: ["string", "null"], enum: ["left", "center", "right", null] };

/** A node of the tree: `t` names its type; `pos` is allowed on every node. */
function node(t: string, description: string, properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return {
    type: "object",
    description,
    properties: { t: { type: "string", const: t }, ...properties, pos: POS },
    required: ["t", ...required],
    additionalProperties: false,
  };
}

const wrap = (t: string, description: string): JsonSchema => node(t, description, { content: inlines() }, ["content"]);

/** Fields of numbered, referenceable blocks. */
const NUMBERED: Record<string, JsonSchema> = {
  label: str('Cross-reference key, e.g. "fig:plot"'),
  id: str("HTML anchor; derived from the label when absent"),
  number: str("Filled in by texwright"),
};

const CITE_ITEM: JsonSchema = {
  type: "object",
  properties: {
    key: { type: "string", minLength: 1, description: "Bibliography entry key" },
    prefix: str(),
    locator: str('Page or section locator, e.g. "p. 4" or "ch. 2"'),
    suffix: str(),
  },
  required: ["key"],
  additionalProperties: false,
};

const TABLE_CELL: JsonSchema = {
  type: "object",
  properties: {
    content: inlines(),
    colspan: { type: "integer", minimum: 1 },
    rowspan: { type: "integer", minimum: 1 },
    align: ALIGN,
  },
  required: ["content"],
  additionalProperties: false,
};
const ROWS: JsonSchema = { type: "array", items: { type: "array", items: TABLE_CELL } };

const INLINE: JsonSchema = {
  description: "An inline node; `t` names its type",
  oneOf: [
    node("Text", "Plain text", { text: str() }, ["text"]),
    node("SoftBreak", "A line break in the source; rendered as a space"),
    node("LineBreak", "A hard line break"),
    wrap("Emph", "Emphasis (italics)"),
    wrap("Strong", "Strong emphasis (bold)"),
    wrap("Underline", "Underlined text"),
    wrap("Strike", "Struck-through text"),
    wrap("SmallCaps", "Small capitals"),
    wrap("Superscript", "Superscript"),
    wrap("Subscript", "Subscript"),
    node("Code", "Inline code", { text: str() }, ["text"]),
    node("Math", "Inline math", { tex: str("TeX source without delimiters") }, ["tex"]),
    node("Link", "A hyperlink", { url: str(), title: str(), content: inlines() }, ["url", "content"]),
    node(
      "Image",
      "An inline image",
      {
        src: str("Path relative to the document, or a URL"),
        alt: inlines("Alternative text; becomes the caption of a figure"),
        title: str(),
        width: str('CSS length or percentage, e.g. "60%"'),
        height: str(),
        attr: ATTR,
      },
      ["src", "alt"],
    ),
    node(
      "Ref",
      "A cross-reference to a label; the text is filled in after numbering",
      {
        label: str('Label of the target, e.g. "fig:plot"'),
        style: { type: "string", enum: ["number", "auto", "eq", "page"], description: '"auto" prints "Figure 3", "number" prints "3", "eq" prints "(3)", "page" prints the page' },
      },
      ["label", "style"],
    ),
    node(
      "Cite",
      "A citation",
      {
        items: { type: "array", items: CITE_ITEM, minItems: 1 },
        mode: {
          type: "string",
          enum: ["paren", "text", "author", "year", "nocite"],
          description: '"paren" renders [1] or (Doe 2020); "text" renders Doe [1] or Doe (2020); "author" and "year" render one part; "nocite" only adds to the bibliography',
        },
      },
      ["items", "mode"],
    ),
    node("Note", "A footnote; its body is block content", { blocks: blocks() }, ["blocks"]),
    node("Span", "Inline content with attributes", { attr: ATTR, content: inlines() }, ["attr", "content"]),
    node("RawInline", "Raw HTML or LaTeX passed through", { format: { type: "string", enum: ["html", "latex"] }, text: str() }, ["format", "text"]),
  ],
};

const BLOCK: JsonSchema = {
  description: "A block node; `t` names its type",
  oneOf: [
    node(
      "Heading",
      "A section heading",
      {
        level: { type: "integer", minimum: 1, maximum: 6 },
        content: inlines(),
        numbered: bool("false for \\section* and headings with the .unnumbered class"),
        ...NUMBERED,
        attr: ATTR,
      },
      ["level", "content", "numbered"],
    ),
    node("Para", "A paragraph", { content: inlines() }, ["content"]),
    node("Plain", "A run of inlines without paragraph spacing (list items, cells)", { content: inlines() }, ["content"]),
    node("CodeBlock", "A code block", { text: str(), lang: str("Language for highlighting, e.g. \"python\""), attr: ATTR }, ["text"]),
    node(
      "MathBlock",
      "Display math",
      {
        tex: str("Body of the environment exactly as written, \\label commands included"),
        env: str('LaTeX environment: "equation", "align", "gather", "multline"... or omitted for plain display math'),
        numbered: bool(),
        ...NUMBERED,
        lineLabels: { type: "array", items: { type: ["string", "null"] }, description: "Per-row labels of multi-row environments" },
        lineNumbers: { type: "array", items: { type: ["string", "null"] }, description: "Per-row numbers, filled in by texwright" },
      },
      ["tex", "numbered"],
    ),
    node("BlockQuote", "A block quotation", { blocks: blocks() }, ["blocks"]),
    node(
      "List",
      "A bulleted or numbered list",
      {
        ordered: bool(),
        start: { type: "integer" },
        style: { type: "string", enum: ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"] },
        delim: { type: "string", enum: [".", ")", "()"], description: 'How numbers are set off: "1." (default), "1)" or "(1)"' },
        tight: bool("Items without paragraph spacing"),
        items: { type: "array", items: blocks() },
        task: { type: "array", items: { type: ["boolean", "null"] }, description: "Task list checkboxes per item: true done, false open, null none" },
      },
      ["ordered", "tight", "items"],
    ),
    node(
      "DefList",
      "A definition list",
      {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { term: inlines(), defs: { type: "array", items: blocks() } },
            required: ["term", "defs"],
            additionalProperties: false,
          },
        },
      },
      ["items"],
    ),
    node(
      "Table",
      "A table",
      {
        caption: inlines(),
        ...NUMBERED,
        align: { type: "array", items: ALIGN, description: "Column alignments" },
        widths: { type: "array", items: { type: ["number", "null"] }, description: "Relative column widths that sum to 1, when the source gave them" },
        head: ROWS,
        body: ROWS,
        foot: ROWS,
        plainHead: { type: "boolean", description: "Header rows set like the body, not bold" },
        rules: { type: "array", items: { type: "integer" }, description: "Body rows with a rule above them (indexes into body)" },
        attr: ATTR,
      },
      ["align", "head", "body"],
    ),
    node(
      "Figure",
      "A figure",
      {
        content: blocks(),
        caption: inlines(),
        ...NUMBERED,
        numbered: bool("false for figures without a caption, or with the .unnumbered class"),
        attr: ATTR,
      },
      ["content", "numbered"],
    ),
    node("Div", "A container: fenced divs, callouts (class note, tip, warning...), the abstract", { attr: ATTR, blocks: blocks() }, ["attr", "blocks"]),
    node("RawBlock", "Raw HTML or LaTeX passed through", { format: { type: "string", enum: ["html", "latex"] }, text: str() }, ["format", "text"]),
    node("HorizontalRule", "A horizontal rule"),
    node("PageBreak", "A page break"),
    node("TOC", "Where the table of contents goes"),
    node("Bibliography", "Where the bibliography goes", {
      items: {
        type: "array",
        description: "A reference list written out by hand (LaTeX thebibliography): cited by key, numbered in this order",
        items: { type: "object", properties: { key: str(), content: inlines() }, required: ["key", "content"], additionalProperties: false },
      },
    }),
    node(
      "Theorem",
      "A theorem-like environment (theorem, lemma, definition, proof...)",
      {
        kind: str('Environment name as written: "theorem", "lemma", "thm", "proof"'),
        name: str('Display name: "Theorem", "Lemma"; defaults to the capitalized kind'),
        counter: str("Counter shared by several kinds; defaults to the kind"),
        withinSection: bool('Number within the top-level section ("2.3")'),
        title: inlines("Optional note in parentheses"),
        blocks: blocks(),
        numbered: bool(),
        ...NUMBERED,
      },
      ["kind", "blocks", "numbered"],
    ),
  ],
};

const META: JsonSchema = {
  type: "object",
  description: "Document metadata",
  properties: {
    title: inlines(),
    subtitle: inlines(),
    author: { type: "array", items: inlines(), description: "One inline run per author" },
    affiliation: { type: "array", items: { oneOf: [inlines(), { type: "null" }] }, description: "Each author's affiliation, by position in author (null for none)" },
    date: inlines(),
    abstract: blocks(),
    keywords: strings,
    lang: str('Language tag, e.g. "en-GB"'),
    bibliography: { ...strings, description: "Bibliography files (BibTeX .bib or CSL-JSON), relative to the document" },
    citationStyle: { type: "string", enum: ["numeric", "author-year"] },
    macros: { type: "object", additionalProperties: { type: "string" }, description: 'Math macros, e.g. {"\\\\R": "\\\\mathbb{R}"}' },
    toc: bool("Print a table of contents"),
    tocDepth: { type: "integer", minimum: 1, maximum: 6 },
    numberSections: bool(),
    numberWithin: { type: "integer", enum: [0, 1], description: "Section depth prefixed to equation and figure numbers: 0 gives 3, 1 gives 2.3" },
    extra: { type: "object", additionalProperties: true, description: "Anything else from front matter, kept for templates and agents" },
  },
  additionalProperties: false,
};

const DOCUMENT_SCHEMA: JsonSchema = {
  $schema: DRAFT,
  title: "texwright document",
  description: "A texwright document tree. Every input format parses into this; it can also be written directly.",
  type: "object",
  properties: {
    texwright: { type: "integer", const: 1, description: "Format version" },
    meta: META,
    blocks: blocks(),
  },
  required: ["texwright", "meta", "blocks"],
  additionalProperties: false,
  $defs: { Inline: INLINE, Block: BLOCK },
};

const FIX: JsonSchema = {
  type: "object",
  description: "An edit that resolves the problem: replace `old`, found at or after line:col, with `new`",
  properties: {
    file: str(),
    line: { type: "integer" },
    col: { type: "integer" },
    old: str("Text to replace"),
    new: str("Replacement"),
    safe: bool("An unambiguous typo correction; `check --fix` applies only these"),
  },
  required: ["line", "col", "old", "new", "safe"],
  additionalProperties: false,
};

const DIAGNOSTIC: JsonSchema = {
  type: "object",
  properties: {
    code: str("Stable code, e.g. MATH001"),
    severity: { type: "string", enum: ["error", "warning", "info"] },
    message: str(),
    file: str(),
    line: { type: "integer" },
    col: { type: "integer" },
    endLine: { type: "integer" },
    endCol: { type: "integer" },
    hint: str("How to fix it"),
    excerpt: str("The source line"),
    fix: { $ref: "#/$defs/Fix" },
  },
  required: ["code", "severity", "message"],
  additionalProperties: false,
};

const DIAGNOSTICS_SCHEMA: JsonSchema = {
  $schema: DRAFT,
  title: "texwright diagnostics report",
  description: "What `--diagnostics json` prints",
  type: "object",
  properties: {
    ok: bool("No errors (and, with --strict, no warnings)"),
    output: str("The file written"),
    errors: { type: "number" },
    warnings: { type: "number" },
    diagnostics: { type: "array", items: { $ref: "#/$defs/Diagnostic" } },
    stats: { type: "object", additionalProperties: true, description: "Pages, passes, timing" },
    fixed: { type: "array", items: { $ref: "#/$defs/Fix" }, description: "check --fix: the fixes written" },
    unplaced: { type: "array", items: { $ref: "#/$defs/Fix" }, description: "check --fix: safe fixes whose text was not found where expected" },
  },
  required: ["errors", "warnings", "diagnostics"],
  additionalProperties: false,
  $defs: { Diagnostic: DIAGNOSTIC, Fix: FIX },
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** JSON Schema of the document tree (a fresh copy). */
export function documentJsonSchema(): JsonSchema {
  return clone(DOCUMENT_SCHEMA);
}

/** JSON Schema of the CLI's JSON diagnostics report (a fresh copy). */
export function diagnosticJsonSchema(): JsonSchema {
  return clone(DIAGNOSTICS_SCHEMA);
}

export type DocumentValidation = { ok: true; document: Document; issues: [] } | { ok: false; issues: ValidationIssue[] };

/** Check a parsed JSON value against the document schema; issues carry JSON paths like `blocks[0].content[0].t`. */
export function validateDocument(value: unknown, maxIssues = 25): DocumentValidation {
  const issues = validate(value, DOCUMENT_SCHEMA, { maxIssues });
  return issues.length ? { ok: false, issues } : { ok: true, document: value as Document, issues: [] };
}
