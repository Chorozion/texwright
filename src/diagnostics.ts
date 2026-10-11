/**
 * Structured diagnostics.
 *
 * Every problem texwright finds is a Diagnostic with a stable code, a
 * severity, a source position and, where possible, a hint that says how to
 * fix it. Some carry a machine-applicable fix (see src/fixes.ts). Agents read
 * them as JSON (`--diagnostics json`) or one line each (`--diagnostics
 * compact`); people read the pretty form. Codes never change meaning between
 * releases; see CODES.
 */

import type { Pos } from "./ast.js";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  col?: number;
  endLine?: number;
  endCol?: number;
  hint?: string;
  /** The offending source line, when known. */
  excerpt?: string;
  /** An edit that resolves the problem: replace `old` (found at or after line:col) with `new`. */
  fix?: Fix;
}

/**
 * A replacement in the source, in the shape an agent's edit tool takes. `safe` fixes are
 * unambiguous typo corrections that `texwright check --fix` applies on its own.
 */
export interface Fix {
  file?: string;
  line: number;
  col: number;
  old: string;
  new: string;
  safe: boolean;
}

/** A fix as reporters give it: at the report's position unless `line` (and `col`) say otherwise. */
export interface FixSpec {
  old: string;
  new: string;
  safe: boolean;
  line?: number;
  col?: number;
}

/** Stable catalogue. Severity here is the default; callers may raise it. */
export const CODES = {
  // input and options
  IO001: { severity: "error", summary: "Input file not found or unreadable" },
  IO002: { severity: "error", summary: "Included file not found (\\input, \\include)" },
  IO003: { severity: "error", summary: "Include cycle" },
  OPT001: { severity: "warning", summary: "Invalid option or metadata value; the default is used" },
  PREV001: { severity: "warning", summary: "Something in a page preview could not be drawn exactly" },
  OPT002: { severity: "warning", summary: "Unknown front-matter key that looks like a typo" },
  // parsing
  YAML001: { severity: "error", summary: "Front matter is not valid YAML" },
  MD001: { severity: "warning", summary: "Markdown construct could not be interpreted as intended" },
  MD002: { severity: "warning", summary: "A $ that opens math never closes, so the formula is shown as text" },
  JSON001: { severity: "error", summary: "JSON document does not match the texwright schema" },
  LTX001: { severity: "warning", summary: "Unsupported LaTeX command; its arguments were kept as text" },
  LTX002: { severity: "warning", summary: "Unsupported LaTeX environment; its body was kept" },
  LTX003: { severity: "error", summary: "Unbalanced braces or environments" },
  LTX004: { severity: "error", summary: "LaTeX feature that needs a TeX engine (TikZ, pgfplots, ...)" },
  LTX005: { severity: "warning", summary: "Malformed LaTeX command arguments" },
  LTX006: { severity: "info", summary: "Math command outside math, typeset as math" },
  LTX007: { severity: "info", summary: "LaTeX construct approximated (beamer frames, chemfig structures, ...)" },
  // math
  MATH001: { severity: "error", summary: "Math does not parse" },
  MATH002: { severity: "warning", summary: "Math macro redefined" },
  MATH003: { severity: "info", summary: "Undefined shorthand read the conventional way" },
  MATH004: { severity: "info", summary: "Diagram drawn approximately (tikz-cd as a grid of straight arrows)" },
  // references and numbering
  REF001: { severity: "error", summary: "Reference to an undefined label" },
  REF002: { severity: "error", summary: "Label defined more than once" },
  REF003: { severity: "warning", summary: "Reference prefix does not match the label's kind" },
  REF004: { severity: "info", summary: "Page reference resolved only in PDF output" },
  // citations
  CITE001: { severity: "error", summary: "Citation key not found in any bibliography" },
  CITE002: { severity: "error", summary: "Citations used but no bibliography given" },
  CITE003: { severity: "error", summary: "Bibliography file could not be parsed" },
  CITE004: { severity: "warning", summary: "Bibliography entry missing fields used by the style" },
  // assets and output
  IMG001: { severity: "error", summary: "Image file not found or unreadable" },
  IMG002: { severity: "warning", summary: "Remote resource blocked (network is off)" },
  IMG003: { severity: "warning", summary: "Image format the PDF engine cannot embed" },
  SVG001: { severity: "warning", summary: "SVG feature drawn approximately or left out" },
  DIAG001: { severity: "error", summary: "Diagram (Mermaid) source could not be read" },
  DIAG002: { severity: "warning", summary: "A code block meant as a diagram is shown as code (misspelt or missing language)" },
  TIKZ001: { severity: "warning", summary: "TikZ or pgfplots feature drawn approximately or left out" },
  PST001: { severity: "warning", summary: "PSTricks feature drawn approximately or left out" },
  FONT001: { severity: "warning", summary: "Character missing from every available font" },
  FONT002: { severity: "warning", summary: "A font the document asks for (mainfont, sansfont, monofont) could not be used; the theme's face is kept" },
  LAY001: { severity: "warning", summary: "Line sticks out into the margin (overfull box)" },
  TBL001: { severity: "warning", summary: "Table row has more cells than the table has columns; the extra cells are left out" },
  LAY002: { severity: "info", summary: "Layout tightened to fit max-pages" },
  LAY003: { severity: "warning", summary: "Document is longer than its max-pages, even at the tightest layout" },
  LAY004: { severity: "warning", summary: "Figure or table placed more than two pages after its first reference" },
  LAY005: { severity: "info", summary: "Paragraph line left alone at the top or bottom of a page (widow or orphan)" },
  LAY006: { severity: "warning", summary: "Table, image or display wider than the text column" },
  A11Y001: { severity: "warning", summary: "Image with no alt text and no caption" },
  A11Y002: { severity: "warning", summary: "Text colour contrast below 4.5:1 against its background" },
  HTML001: { severity: "warning", summary: "Raw HTML was sanitized" },
  PDF001: { severity: "error", summary: "PDF could not be written" },
  PDF002: { severity: "warning", summary: "Page numbers did not settle after the maximum number of passes" },
  PDF003: { severity: "warning", summary: "Link or bookmark left out of the PDF" },
  // limits
  TIME001: { severity: "error", summary: "Processing took longer than the time limit and was stopped" },
  PATH001: { severity: "error", summary: "Path outside the allowed workspace" },
  INT001: { severity: "error", summary: "Internal error in texwright (please report it with the input)" },
} as const satisfies Record<string, { severity: Severity; summary: string }>;

export type Code = keyof typeof CODES;

function rankOf(s: Severity): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

/** Reports kept per code; past this, they are counted and summarized so a reader is not flooded. */
export const MAX_PER_CODE = 100;

export class Diagnostics {
  readonly items: Diagnostic[] = [];
  /** Source text by file name, used to fill excerpts. */
  private sources = new Map<string, string[]>();
  /** Keys of reports already recorded, for constant-time duplicate checks. */
  private seen = new Set<string>();
  private perCode = new Map<string, number>();
  /** Reports past MAX_PER_CODE, by code: how many, and the most severe severity among them. */
  private overflow = new Map<string, { count: number; severity: Severity }>();

  /** The registered source of a file, as lines. */
  sourceLines(file: string): readonly string[] | undefined {
    return this.sources.get(file);
  }

  registerSource(file: string, text: string): void {
    this.sources.set(file, text.split(/\r?\n/));
  }

  add(
    code: Code,
    message: string,
    where?: Pos | { file?: string },
    extra?: { hint?: string; severity?: Severity; fix?: FixSpec },
  ): Diagnostic {
    const d: Diagnostic = { code, severity: extra?.severity ?? CODES[code].severity, message };
    if (where) {
      if ("file" in where && where.file) d.file = where.file;
      if ("line" in where) {
        d.line = where.line;
        d.col = where.col;
        if (where.endLine) d.endLine = where.endLine;
        if (where.endCol) d.endCol = where.endCol;
        const lines = d.file ? this.sources.get(d.file) : undefined;
        if (lines && where.line >= 1 && where.line <= lines.length) d.excerpt = lines[where.line - 1];
      }
    }
    if (extra?.hint) d.hint = extra.hint;
    if (extra?.fix && (d.line !== undefined || (extra.fix.line ?? 0) > 0)) {
      // A fix may point elsewhere than the report (an insertion at the end of a formula or environment).
      const at = (extra.fix.line ?? 0) > 0 ? { line: extra.fix.line!, col: extra.fix.col ?? 1 } : { line: d.line!, col: d.col ?? 1 };
      d.fix = { line: at.line, col: at.col, old: extra.fix.old, new: extra.fix.new, safe: extra.fix.safe };
      if (d.file) d.fix.file = d.file;
    }
    // Collapse exact duplicates (same code, place and message).
    const key = `${d.code}\u0000${d.file ?? ""}\u0000${d.line ?? ""}\u0000${d.col ?? ""}\u0000${d.message}`;
    if (this.seen.has(key)) return d;
    this.seen.add(key);
    const n = (this.perCode.get(code) ?? 0) + 1;
    this.perCode.set(code, n);
    if (n > MAX_PER_CODE) {
      const o = this.overflow.get(code) ?? { count: 0, severity: d.severity };
      o.count++;
      if (rankOf(d.severity) < rankOf(o.severity)) o.severity = d.severity;
      this.overflow.set(code, o);
      return d;
    }
    this.items.push(d);
    return d;
  }

  /** One summary line per code that went past MAX_PER_CODE. */
  private summaries(): Diagnostic[] {
    return [...this.overflow].map(([code, o]) => ({
      code,
      severity: o.severity,
      message: `${o.count} more ${code} report${o.count === 1 ? "" : "s"} not shown (only the first ${MAX_PER_CODE} are listed)`,
      hint: "Fix the ones listed and check again",
    }));
  }

  get errors(): Diagnostic[] {
    return [...this.items, ...this.summaries()].filter((d) => d.severity === "error");
  }

  get warnings(): Diagnostic[] {
    return [...this.items, ...this.summaries()].filter((d) => d.severity === "warning");
  }

  hasErrors(strict = false): boolean {
    const bad = (s: Severity) => s === "error" || (strict && s === "warning");
    return this.items.some((d) => bad(d.severity)) || [...this.overflow.values()].some((o) => bad(o.severity));
  }

  sorted(): Diagnostic[] {
    const ordered = [...this.items].sort(
      (a, b) =>
        // Comparing equal names directly spares starting up ICU in the usual one-file case.
        (a.file === b.file ? 0 : (a.file ?? "").localeCompare(b.file ?? "")) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.col ?? 0) - (b.col ?? 0) ||
        rankOf(a.severity) - rankOf(b.severity),
    );
    return [...ordered, ...this.summaries()];
  }

  toJSON(): { errors: number; warnings: number; diagnostics: Diagnostic[] } {
    return { errors: this.errors.length, warnings: this.warnings.length, diagnostics: this.sorted() };
  }

  /** Human-readable, compiler-style lines. */
  format(color = false): string {
    const paint = (s: string, c: number) => (color ? `\u001b[${c}m${s}\u001b[0m` : s);
    const out: string[] = [];
    for (const d of this.sorted()) {
      const where = d.file ? `${d.file}${d.line ? `:${d.line}:${d.col ?? 1}` : ""}: ` : "";
      const sev = d.severity === "error" ? paint("error", 31) : d.severity === "warning" ? paint("warning", 33) : paint("info", 36);
      out.push(`${where}${sev} ${d.code}: ${d.message}`);
      if (d.excerpt !== undefined) {
        out.push(`  ${d.excerpt}`);
        if (d.col) out.push(`  ${" ".repeat(Math.max(0, d.col - 1))}${paint("^", 32)}`);
      }
      if (d.hint) out.push(`  ${paint("hint:", 36)} ${d.hint}`);
      if (d.fix) out.push(`  ${paint("fix:", 32)} replace "${d.fix.old}" with "${d.fix.new}"${d.fix.safe ? " (safe; --fix applies it)" : ""}`);
    }
    return out.join("\n");
  }
}

/**
 * One line per diagnostic, for agents that pay per token:
 *   paper.md:3:5 E REF001 Reference to undefined label "sec:intr" | Did you mean "sec:intro"? | fix "sec:intr" -> "sec:intro" safe
 * Severity is E, W or I. The source excerpt is left out; the line number says where to look.
 */
export function formatCompact(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const where = `${d.file ?? "-"}${d.line ? `:${d.line}:${d.col ?? 1}` : ""}`;
      const parts = [`${where} ${d.severity === "error" ? "E" : d.severity === "warning" ? "W" : "I"} ${d.code} ${d.message}`];
      if (d.hint) parts.push(d.hint);
      if (d.fix) parts.push(`fix "${d.fix.old}" -> "${d.fix.new}"${d.fix.safe ? " safe" : ""}`);
      return parts.join(" | ");
    })
    .join("\n");
}

/** Convert a 0-based offset in `text` to a 1-based line/column. */
export function offsetToPos(text: string, offset: number, file?: string): Pos {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  const pos: Pos = { line, col: offset - last };
  if (file) pos.file = file;
  return pos;
}
