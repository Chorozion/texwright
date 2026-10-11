/**
 * LaTeX subset parser: a whole .tex file, or raw LaTeX found inside Markdown.
 *
 * Nothing here throws on bad input. Problems become diagnostics (LTX001-LTX005,
 * IO002, IO003, MATH002) and parsing carries on. See DESIGN.md, "LaTeX subset".
 */

import type { Block, Document, Inline, Meta } from "../ast.js";
import type { ParseContext } from "./context.js";
import { Parser } from "./latex/parser.js";

/** Parse a whole .tex file. With \begin{document}, the preamble only supplies metadata and macros. */
export function parseLatex(text: string, ctx: ParseContext): Document {
  if (ctx.file && !ctx.lineOffset && !ctx.colOffset) ctx.diagnostics.registerSource(ctx.file, text);
  const p = new Parser(ctx, text);
  const blocks = p.parseDocument();
  return { texwright: 1, meta: p.meta, blocks };
}

/** Parse a raw LaTeX block found inside Markdown. Definitions go to ctx.macros, metadata to ctx.meta, when given. */
export function latexToBlocks(text: string, ctx: ParseContext): Block[] {
  const p = new Parser(ctx, text);
  const blocks = p.parseDocument();
  mergeMeta(ctx.meta, p.meta);
  return blocks;
}

/** Parse a raw LaTeX inline found inside Markdown. */
export function latexToInlines(text: string, ctx: ParseContext): Inline[] {
  const p = new Parser(ctx, text);
  const inlines = p.parseInlineDocument();
  mergeMeta(ctx.meta, p.meta);
  return inlines;
}

/** Fold a fragment's metadata into the document's: existing fields win; lists are appended. */
function mergeMeta(into: Meta | undefined, from: Meta): void {
  if (!into) return;
  for (const [key, value] of Object.entries(from) as [keyof Meta, Meta[keyof Meta]][]) {
    if (value === undefined || key === "macros") continue;
    if (key === "bibliography" || key === "keywords") {
      const merged = [...((into[key] as string[] | undefined) ?? []), ...(value as string[])];
      (into as Record<string, unknown>)[key] = [...new Set(merged)];
    } else if (into[key] === undefined) {
      (into as Record<string, unknown>)[key] = value;
    }
  }
}
