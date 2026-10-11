/**
 * Raw LaTeX inside Markdown: hand each RawBlock/RawInline with format
 * "latex" to the LaTeX parser, so the two can be mixed in one file.
 * Anything the LaTeX parser cannot render stays raw and is reported there.
 */

import type { Block, Document, Inline } from "../ast.js";
import { latexToBlocks, latexToInlines } from "../parse/latex.js";
import type { ParseContext } from "../parse/context.js";

export function convertRawLatex(doc: Document, ctx: ParseContext): void {
  const macros = (doc.meta.macros ??= {});
  const sub = (pos?: { line: number; col: number; file?: string }): ParseContext => ({
    ...ctx,
    file: pos?.file ?? ctx.file,
    lineOffset: pos ? pos.line - 1 : 0,
    colOffset: pos ? pos.col - 1 : 0,
    macros,
    meta: doc.meta,
  });

  const fixInlines = (inlines: Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const i of inlines) {
      if (i.t === "RawInline" && i.format === "latex") {
        out.push(...latexToInlines(i.text, sub(i.pos)));
        continue;
      }
      if (i.t === "Note") i.blocks = fixBlocks(i.blocks);
      if ("content" in i && Array.isArray(i.content)) (i as { content: Inline[] }).content = fixInlines(i.content);
      out.push(i);
    }
    return out;
  };

  const fixBlocks = (blocks: Block[]): Block[] => {
    const out: Block[] = [];
    for (const b of blocks) {
      if (b.t === "RawBlock" && b.format === "latex") {
        // The LaTeX parser's output is final: anything it leaves raw (TikZ, an
        // unmatched \end) must not be fed back to it, or it would loop forever.
        out.push(...latexToBlocks(b.text, sub(b.pos)));
        continue;
      }
      switch (b.t) {
        case "Heading":
        case "Para":
        case "Plain":
          b.content = fixInlines(b.content);
          break;
        case "Figure":
          if (b.caption) b.caption = fixInlines(b.caption);
          b.content = fixBlocks(b.content);
          break;
        case "Table":
          if (b.caption) b.caption = fixInlines(b.caption);
          for (const row of [...b.head, ...b.body, ...(b.foot ?? [])]) for (const c of row) c.content = fixInlines(c.content);
          break;
        case "Theorem":
          if (b.title) b.title = fixInlines(b.title);
          b.blocks = fixBlocks(b.blocks);
          break;
        case "BlockQuote":
        case "Div":
          b.blocks = fixBlocks(b.blocks);
          break;
        case "List":
          b.items = b.items.map(fixBlocks);
          break;
        case "DefList":
          for (const it of b.items) {
            it.term = fixInlines(it.term);
            it.defs = it.defs.map(fixBlocks);
          }
          break;
        default:
          break;
      }
      out.push(b);
    }
    return out;
  };

  // Fragments share one macro table (ctx.macros), which is the document's own.
  doc.blocks = fixBlocks(doc.blocks);
  if (doc.meta.abstract) doc.meta.abstract = fixBlocks(doc.meta.abstract);
  for (const key of ["title", "subtitle", "date"] as const) {
    const run = doc.meta[key];
    if (run) doc.meta[key] = fixInlines(run);
  }
  if (doc.meta.author) doc.meta.author = doc.meta.author.map(fixInlines);
  doc.meta.macros = macros;
}
