/**
 * Markdown reader: CommonMark plus GFM tables, strikethrough, autolinks and
 * task lists, plus the pandoc-style extensions described in DESIGN.md
 * ("Markdown dialect"). Problems become diagnostics; parsing never throws on
 * bad input.
 *
 * The work is split across src/parse/md/, following the parsing strategy
 * in the appendix of the CommonMark spec: blocks.ts (phase 1, lines into a
 * tree of blocks), inlineparser.ts and its helpers (phase 2, the inline
 * content of each leaf), assemble.ts (the tree into texwright blocks,
 * applying the texwright conventions), inlinefinish.ts (bare links,
 * typography), finish.ts (labels and heading ids), frontmatter.ts (YAML
 * metadata) and reader.ts, which runs them in order.
 */
import type { Document } from "../ast.js";
import type { ParseContext } from "./context.js";
import { MarkdownReader } from "./md/reader.js";

/** Parse texwright Markdown into a Document. Problems are added to `ctx.diagnostics`. */
export function parseMarkdown(text: string, ctx: ParseContext): Document {
  return new MarkdownReader(ctx).read(text);
}
