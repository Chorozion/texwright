/**
 * TikZ in Markdown: a ```tikz code block (a whole tikzpicture, or just its
 * body) becomes a figure drawn by src/tikz, the way ```mermaid blocks do.
 * With a caption or a label, ```{.tikz #fig:setup caption="The setup"}, it
 * is a numbered figure. Problems are TIKZ001 at their line in the document;
 * when nothing could be drawn the block stays as code, with an error.
 */

import { type Block, type Document, type Inline, walkBlocks } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import { memoryContext } from "../parse/context.js";
import { parseMarkdown } from "../parse/markdown.js";
import { lineCol, renderTikz } from "../tikz/index.js";

const isTikz = (b: Block): b is Extract<Block, { t: "CodeBlock" }> => b.t === "CodeBlock" && ((b.lang ?? "").toLowerCase() === "tikz" || !!b.attr?.classes?.some((c) => c.toLowerCase() === "tikz"));

function captionInlines(text: string): Inline[] {
  const doc = parseMarkdown(text, memoryContext());
  const first = doc.blocks[0];
  return first && (first.t === "Para" || first.t === "Plain") ? first.content : [{ t: "Text", text }];
}

export function renderDocumentTikz(doc: Document, diagnostics: Diagnostics, file?: string, readFile?: (path: string) => string | undefined): void {
  const macros = doc.meta.macros ?? {};
  walkBlocks(doc.blocks, (b) => {
    if (!isTikz(b)) return;
    const r = renderTikz(b.text, { macros, ...(readFile ? { readFile } : {}) });
    const pos = b.pos;
    const where = (offset: number) => {
      // The code's first line is the line after the opening fence.
      const lc = lineCol(b.text, offset);
      return pos ? { ...pos, line: pos.line + lc.line, col: lc.col } : file ? { file } : undefined;
    };
    if (!r.svg) {
      diagnostics.add("TIKZ001", "TikZ: nothing in this picture could be drawn", where(0), { severity: "error", hint: r.messages[0]?.message ?? "Check that the block holds TikZ commands such as \\draw (0,0) -- (1,1);" });
      return;
    }
    for (const m of r.messages) diagnostics.add("TIKZ001", `TikZ: ${m.message}`, where(m.offset), m.hint ? { hint: m.hint } : undefined);
    const attrs = b.attr?.attrs ?? {};
    const caption = attrs.caption ?? attrs.title;
    const label = b.attr?.id;
    const image: Inline = {
      t: "Image",
      src: `data:image/svg+xml;base64,${Buffer.from(r.svg, "utf8").toString("base64")}`,
      alt: [{ t: "Text", text: caption ?? "TikZ picture" }],
      ...(attrs.width ? { width: attrs.width } : {}),
      attr: { classes: ["tw-diagram", "tikz"] },
      ...(pos ? { pos } : {}),
    };
    const fig: Block = {
      t: "Figure",
      content: [{ t: "Plain", content: [image] }],
      ...(caption ? { caption: captionInlines(caption) } : {}),
      ...(label ? { label, id: label } : {}),
      numbered: !!(caption || label) && !b.attr?.classes?.includes("unnumbered"),
      ...(pos ? { pos } : {}),
    };
    const target = b as unknown as Record<string, unknown>;
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, fig);
  });
}
