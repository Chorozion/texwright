/**
 * The texwright document model.
 *
 * Every input format (Markdown, the LaTeX subset, JSON) parses into this tree,
 * every transform (numbering, references, citations) rewrites it, and every
 * writer (HTML, PDF, JSON) reads it. Nodes are plain JSON so agents can emit
 * and inspect documents directly; `texwright schema` prints the JSON Schema.
 *
 * Conventions:
 * - Discriminant is `t`.
 * - `pos` is optional on every node and points at the source for diagnostics.
 * - Labels (`label`) are author-facing keys such as "fig:plot" or "eq:energy";
 *   `id` is the HTML anchor written for them (derived from the label when absent).
 */

export interface Pos {
  file?: string;
  line: number; // 1-based
  col: number; // 1-based
  endLine?: number;
  endCol?: number;
}

export interface Attr {
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
}

// ------------------------------------------------------------------ inlines

export type Inline =
  | { t: "Text"; text: string; pos?: Pos }
  | { t: "SoftBreak"; pos?: Pos }
  | { t: "LineBreak"; pos?: Pos }
  | { t: "Emph"; content: Inline[]; pos?: Pos }
  | { t: "Strong"; content: Inline[]; pos?: Pos }
  | { t: "Underline"; content: Inline[]; pos?: Pos }
  | { t: "Strike"; content: Inline[]; pos?: Pos }
  | { t: "SmallCaps"; content: Inline[]; pos?: Pos }
  | { t: "Superscript"; content: Inline[]; pos?: Pos }
  | { t: "Subscript"; content: Inline[]; pos?: Pos }
  | { t: "Code"; text: string; pos?: Pos }
  /** Inline math. `tex` is the TeX source without delimiters. */
  | { t: "Math"; tex: string; pos?: Pos }
  | { t: "Link"; url: string; title?: string; content: Inline[]; pos?: Pos }
  | {
      t: "Image";
      src: string;
      alt: Inline[];
      title?: string;
      /** CSS length or percentage, e.g. "60%", "8cm", "300px". */
      width?: string;
      height?: string;
      attr?: Attr;
      pos?: Pos;
    }
  /**
   * A cross-reference to a label. Writers fill in the text after numbering.
   * - "number": the bare number ("3")            from \ref{x}
   * - "auto":   number with its kind ("Figure 3") from @fig:x or \autoref / \cref
   * - "eq":     parenthesized equation number      from \eqref{x}
   * - "page":   page number in PDF output          from \pageref{x}
   */
  | { t: "Ref"; label: string; style: "number" | "auto" | "eq" | "page"; pos?: Pos }
  /**
   * A citation. mode "paren" renders "[1]" or "(Doe 2020)"; "text" renders
   * "Doe [1]" or "Doe (2020)"; "author" and "year" render one part; "nocite"
   * adds entries to the bibliography without printing anything.
   */
  | { t: "Cite"; items: CiteItem[]; mode: "paren" | "text" | "author" | "year" | "nocite"; pos?: Pos }
  /** A footnote. Its body is block content. */
  | { t: "Note"; blocks: Block[]; pos?: Pos }
  | { t: "Span"; attr: Attr; content: Inline[]; pos?: Pos }
  | { t: "RawInline"; format: "html" | "latex"; text: string; pos?: Pos };

export interface CiteItem {
  key: string;
  prefix?: string;
  /** Page or section locator, e.g. "p. 4" or "ch. 2". */
  locator?: string;
  suffix?: string;
}

// ------------------------------------------------------------------ blocks

export type Align = "left" | "center" | "right" | null;

export interface TableCell {
  content: Inline[];
  colspan?: number;
  rowspan?: number;
  align?: Align;
}

export type Block =
  | {
      t: "Heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      content: Inline[];
      /** false for \section* and headings with the .unnumbered class. */
      numbered: boolean;
      label?: string;
      id?: string;
      /** Filled by the numbering transform, e.g. "2.3". */
      number?: string;
      attr?: Attr;
      pos?: Pos;
    }
  | { t: "Para"; content: Inline[]; pos?: Pos }
  /** A paragraph-like run of inlines that should not get paragraph spacing (list items, cells). */
  | { t: "Plain"; content: Inline[]; pos?: Pos }
  | { t: "CodeBlock"; text: string; lang?: string; attr?: Attr; pos?: Pos }
  /**
   * Display math. `env` is the LaTeX environment the source used
   * ("equation", "align", "gather", "multline" or undefined for $$ / \[ \]).
   * `numbered` defaults from the environment (starred and $$ are unnumbered).
   * For multi-line environments, `lineLabels` holds per-row labels when rows
   * are labelled individually; `number` / `lineNumbers` are filled by numbering.
   */
  | {
      t: "MathBlock";
      /** Body of the environment exactly as written, \label commands included. */
      tex: string;
      env?: string;
      numbered: boolean;
      /** First \label found (or {#eq:x} after $$...$$). The math transform owns the rest. */
      label?: string;
      id?: string;
      number?: string;
      /** For multi-row environments (align, gather): per-row labels and numbers, filled by the math transform. */
      lineLabels?: (string | null)[];
      lineNumbers?: (string | null)[];
      pos?: Pos;
    }
  | { t: "BlockQuote"; blocks: Block[]; pos?: Pos }
  | {
      t: "List";
      ordered: boolean;
      start?: number;
      style?: "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman";
      /** How a number is set off: "1." (the default), "1)" or "(1)". */
      delim?: "." | ")" | "()";
      tight: boolean;
      items: Block[][];
      task?: (boolean | null)[];
      pos?: Pos;
    }
  | { t: "DefList"; items: { term: Inline[]; defs: Block[][] }[]; pos?: Pos }
  | {
      t: "Table";
      caption?: Inline[];
      label?: string;
      id?: string;
      number?: string;
      align: Align[];
      /** Relative column widths that sum to 1, when the source gave them. */
      widths?: (number | null)[];
      head: TableCell[][];
      body: TableCell[][];
      foot?: TableCell[][];
      /** The header rows are set like the body (LaTeX tables: the source chose any bold itself). */
      plainHead?: boolean;
      /** Body rows with a rule above them (indexes into `body`), as \hline between groups. */
      rules?: number[];
      attr?: Attr;
      pos?: Pos;
    }
  | {
      t: "Figure";
      content: Block[];
      caption?: Inline[];
      label?: string;
      id?: string;
      number?: string;
      /** false for figures without a caption, or with the .unnumbered class. */
      numbered: boolean;
      attr?: Attr;
      pos?: Pos;
    }
  /** Generic container: fenced divs, admonitions (class note/tip/warning...), abstract, theorem-like environments. */
  | { t: "Div"; attr: Attr; blocks: Block[]; pos?: Pos }
  | { t: "RawBlock"; format: "html" | "latex"; text: string; pos?: Pos }
  | { t: "HorizontalRule"; pos?: Pos }
  | { t: "PageBreak"; pos?: Pos }
  /** Where the table of contents goes. Writers also honour meta.toc. */
  | { t: "TOC"; pos?: Pos }
  /** Where the bibliography goes. Writers append one at the end if citations exist and this is absent. */
  /** Where the bibliography goes. With `items`, a reference list written out by hand (LaTeX's thebibliography). */
  | { t: "Bibliography"; items?: { key: string; content: Inline[] }[]; pos?: Pos }
  /**
   * Theorem-like environments (theorem, lemma, definition, proof...).
   * `kind` is the environment name; numbering shares counters per kind.
   */
  | {
      t: "Theorem";
      /** Environment name as written: "theorem", "lemma", "thm", "proof". */
      kind: string;
      /** Display name: "Theorem", "Lemma". Defaults to the capitalized kind. */
      name?: string;
      /** Counter shared by several kinds (\newtheorem{lemma}[theorem]{Lemma} sets "theorem"). Defaults to kind. */
      counter?: string;
      /** Number within the top-level section ("2.3"), as \newtheorem{theorem}{Theorem}[section] does. */
      withinSection?: boolean;
      /** Optional note in parentheses: \begin{theorem}[Fermat] or title="...". */
      title?: Inline[];
      blocks: Block[];
      numbered: boolean;
      label?: string;
      id?: string;
      number?: string;
      pos?: Pos;
    };

// ------------------------------------------------------------------ document

export interface Meta {
  title?: Inline[];
  subtitle?: Inline[];
  author?: Inline[][];
  /** Each author's affiliation, by position in `author` (null for none). */
  affiliation?: (Inline[] | null)[];
  date?: Inline[];
  abstract?: Block[];
  keywords?: string[];
  lang?: string;
  /** Bibliography files (BibTeX .bib or CSL-JSON .json), resolved relative to the input. */
  bibliography?: string[];
  /** "numeric" (default) or "author-year". */
  citationStyle?: "numeric" | "author-year";
  /** Math macros, e.g. { "\\R": "\\mathbb{R}" }, from front matter or \newcommand. */
  macros?: Record<string, string>;
  toc?: boolean;
  tocDepth?: number;
  numberSections?: boolean;
  /** Section depth that equation/figure numbers are prefixed with: 0 = plain "3", 1 = "2.3". */
  numberWithin?: 0 | 1;
  /** Anything else from front matter, kept for templates and agents. */
  extra?: Record<string, unknown>;
}

export interface Document {
  /** Format marker so stored JSON can be versioned. */
  texwright: 1;
  meta: Meta;
  blocks: Block[];
}

export type CiteNode = Extract<Inline, { t: "Cite" }>;

/** Whether a proof places its own end mark with \qedhere, so none is added at its end. */
export function hasQedHere(blocks: Block[]): boolean {
  // Formula sources are plain strings in the tree; in JSON a backslash is doubled.
  return JSON.stringify(blocks).includes("\\\\qedhere");
}
export type RefNode = Extract<Inline, { t: "Ref" }>;

export type BlockType = Block["t"];
export type InlineType = Inline["t"];

export function emptyDocument(): Document {
  return { texwright: 1, meta: {}, blocks: [] };
}

/** Plain text of an inline run, for ids, PDF bookmarks and sorting. */
export function plainText(inlines: Inline[] | undefined): string {
  if (!inlines) return "";
  let out = "";
  for (const n of inlines) {
    switch (n.t) {
      case "Text":
        out += n.text;
        break;
      case "SoftBreak":
      case "LineBreak":
        out += " ";
        break;
      case "Code":
        out += n.text;
        break;
      case "Math":
        out += n.tex;
        break;
      case "Emph":
      case "Strong":
      case "Underline":
      case "Strike":
      case "SmallCaps":
      case "Superscript":
      case "Subscript":
      case "Span":
      case "Link":
        out += plainText(n.content);
        break;
      case "Image":
        out += plainText(n.alt);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Visit every block in document order, including nested ones. */
export function walkBlocks(blocks: Block[], fn: (b: Block, parent: Block | null) => void, parent: Block | null = null): void {
  for (const b of blocks) {
    fn(b, parent);
    for (const child of childBlocks(b)) walkBlocks(child, fn, b);
    for (const inl of blockInlines(b)) walkInlines(inl, (i) => {
      if (i.t === "Note") walkBlocks(i.blocks, fn, b);
    });
  }
}

/** Visit every inline in a run, including nested ones (not inside notes). */
export function walkInlines(inlines: Inline[], fn: (i: Inline) => void): void {
  for (const i of inlines) {
    fn(i);
    if ("content" in i && Array.isArray(i.content)) walkInlines(i.content, fn);
    if (i.t === "Image") walkInlines(i.alt, fn);
  }
}

/** Nested block lists of a block. */
export function childBlocks(b: Block): Block[][] {
  switch (b.t) {
    case "BlockQuote":
    case "Div":
    case "Theorem":
      return [b.blocks];
    case "Figure":
      return [b.content];
    case "List":
      return b.items;
    case "DefList":
      return b.items.flatMap((it) => it.defs);
    default:
      return [];
  }
}

/** Inline runs held directly by a block. */
export function blockInlines(b: Block): Inline[][] {
  switch (b.t) {
    case "Heading":
    case "Para":
    case "Plain":
      return [b.content];
    case "Table":
      return [b.caption ?? [], ...[...b.head, ...b.body, ...(b.foot ?? [])].flatMap((row) => row.map((c) => c.content))];
    case "Figure":
      return [b.caption ?? []];
    case "DefList":
      return b.items.map((it) => it.term);
    case "Theorem":
      return [b.title ?? []];
    default:
      return [];
  }
}

/** Turn arbitrary text into an HTML id: "fig:Energy plot" -> "fig-energy-plot". */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "section";
}

/** "3.", "c)", "(iii)": an ordered list's label for item n. */
export function listLabel(n: number, style: Extract<Block, { t: "List" }>["style"], delim: "." | ")" | "()" = "."): string {
  let core: string;
  switch (style) {
    case "lower-alpha":
      core = String.fromCharCode(96 + ((n - 1) % 26) + 1);
      break;
    case "upper-alpha":
      core = String.fromCharCode(64 + ((n - 1) % 26) + 1);
      break;
    case "lower-roman":
      core = roman(n).toLowerCase();
      break;
    case "upper-roman":
      core = roman(n);
      break;
    default:
      core = String(n);
  }
  return delim === "()" ? `(${core})` : `${core}${delim}`;
}

function roman(n: number): string {
  const table: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  let x = Math.max(1, Math.min(3999, n));
  for (const [v, s] of table) while (x >= v) {
    out += s;
    x -= v;
  }
  return out;
}

/**
 * \cref{a,b,c} and \Cref: the references in a span marked "tw-cref", each a bare number; numbering
 * then writes them out the way cleveref does ("eqs. (1) to (3)", "fig. 1 and eq. (4)").
 */
export function crefGroup(labels: string[], capital: boolean, pos?: Pos): Inline {
  return {
    t: "Span",
    attr: { classes: capital ? ["tw-cref", "tw-cref-cap"] : ["tw-cref"] },
    content: labels.map((label): Inline => ({ t: "Ref", label, style: "number", ...(pos ? { pos } : {}) })),
    ...(pos ? { pos } : {}),
  };
}
