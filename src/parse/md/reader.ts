/**
 * The Markdown reader: front matter, then the block phase, the inline phase
 * and assembly for the body, then the passes over the finished tree
 * (labels, heading ids). See src/parse/markdown.ts for the dialect.
 */
import type { Block, Document, Inline, Meta } from "../../ast.js";
import { shiftPos, type ParseContext } from "../context.js";
import { Assembler, DocState } from "./assemble.js";
import { BlockParser } from "./blocks.js";
import { assignHeadingIds, attachLabels } from "./finish.js";
import { findFrontMatter, frontMatterMeta, looksLikeUnclosedFrontMatter, unclosedFrontMatterFix } from "./frontmatter.js";
import { trimInlines } from "./runs.js";

export class MarkdownReader {
  readonly meta: Meta = {};
  private readonly doc: DocState;

  constructor(readonly ctx: ParseContext) {
    this.doc = new DocState(ctx, this.meta);
  }

  read(text: string): Document {
    const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    let body = source;
    const fm = findFrontMatter(source);
    if (fm) {
      Object.assign(
        this.meta,
        frontMatterMeta(fm, 2, {
          inline: (s, line) => this.inline(s, line - 1),
          blocks: (s, line) => this.blocks(s, line - 1),
          report: (code, message, line, col, extra) =>
            this.ctx.diagnostics.add(code, message, shiftPos(this.ctx, line, col), extra),
        }),
      );
      // Blank out the front matter so body line numbers stay those of the file.
      body = "\n".repeat(fm.lineCount) + source.split("\n").slice(fm.lineCount).join("\n");
    } else if (looksLikeUnclosedFrontMatter(source)) {
      this.ctx.diagnostics.add("MD001", "Front matter starting with --- is never closed", shiftPos(this.ctx, 1, 1), {
        hint: "End the YAML block with a line containing only ---.",
        fix: unclosedFrontMatterFix(source),
      });
    }
    const spans = this.doc.labelSpans;
    this.doc.hold();
    const blocks = attachLabels(this.blocks(body, 0), spans);
    this.doc.flush();
    if (this.meta.abstract) this.meta.abstract = attachLabels(this.meta.abstract, spans);
    assignHeadingIds(blocks);
    return { texwright: 1, meta: this.meta, blocks };
  }

  /** Parse `text` as Markdown blocks; `lineBase` is the document line of its first line, minus one. */
  blocks(text: string, lineBase: number): Block[] {
    const parser = new BlockParser(text);
    const root = parser.parse();
    const asm = new Assembler(this.doc, parser, lineBase, (t, line) => this.reread(t, line));
    asm.reportIssues();
    const blocks = asm.children(root, false);
    asm.reportUnusedNotes();
    return blocks;
  }

  /** Inline text read again on its own while the document is built (stray captions, theorem titles). */
  private reread(text: string, lineBase: number): Inline[] {
    this.doc.rereading++;
    try {
      return this.inline(text, lineBase);
    } finally {
      this.doc.rereading--;
    }
  }

  /** Parse `text` as one run of inline Markdown (front matter values). */
  inline(text: string, lineBase: number): Inline[] {
    const parser = new BlockParser(text);
    const asm = new Assembler(this.doc, parser, lineBase, (t, line) => this.reread(t, line));
    const segs = parser.text.split("\n").map((t, line) => ({ text: t, line, col: 0 }));
    const { run } = asm.inline(segs);
    return trimInlines(run.map((p) => (p.t === "$display" ? ({ t: "Math", tex: p.tex, pos: p.pos } as Inline) : p)));
  }
}
