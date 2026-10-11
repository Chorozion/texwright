/**
 * Diagrams in documents: a ```mermaid code block becomes a figure drawn by
 * texwright's own diagram engine (src/diagram). With a caption or a label,
 * ```{.mermaid #fig:flow caption="The pipeline"}, it is a numbered figure
 * that @fig:flow can refer to; without, an unnumbered one.
 *
 * A diagram that cannot be read is reported as DIAG001 at its line in the
 * document, with the hint and fix the parser gave; when nothing could be
 * drawn the source stays as a code block so the reader still sees it.
 *
 * The theme comes from the diagram itself, else from the front-matter key
 * `diagram-theme` (or `mermaid-theme`): default, neutral, forest or dark.
 */

import { type Block, type Document, type Inline, walkBlocks } from "../ast.js";
import { renderDiagram } from "../diagram/index.js";
import { closestFix } from "../fixes.js";
import type { Diagnostics } from "../diagnostics.js";
import { memoryContext } from "../parse/context.js";
import { parseMarkdown } from "../parse/markdown.js";

const isDiagram = (b: Block): b is Extract<Block, { t: "CodeBlock" }> =>
  b.t === "CodeBlock" && ((b.lang ?? "").toLowerCase() === "mermaid" || !!b.attr?.classes?.some((c) => c.toLowerCase() === "mermaid"));

/** The first word of every Mermaid diagram type. */
const MERMAID_HEAD = /^\s*(flowchart|graph\s+(TD|TB|BT|LR|RL)|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie\b|timeline|xychart(-beta)?|mindmap|journey|quadrantChart)\b/;

/**
 * DIAG002: a fenced block that was meant to be drawn but is shown as code, because its
 * language is misspelt (```meraid, ```tkiz) or missing while the text is plainly Mermaid.
 * Without this the diagram silently becomes source text in the output.
 */
function misnamedFence(b: Extract<Block, { t: "CodeBlock" }>, diagnostics: Diagnostics): void {
  const lang = (b.lang ?? "").trim();
  const lower = lang.toLowerCase();
  if (lower === "tikz" || lower === "mermaid") return;
  const near = lang ? closestFix(lower, ["mermaid", "tikz"], 2) : undefined;
  const looksMermaid = MERMAID_HEAD.test(b.text.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) ?? "");
  if (near) {
    diagnostics.add("DIAG002", `Code block language "${lang}" looks like ${near.replacement}; the block was shown as code, not drawn`, b.pos, {
      hint: `Write \`\`\`${near.replacement}`,
      fix: { old: lang, new: near.replacement, safe: near.safe || looksMermaid },
    });
  } else if (looksMermaid && !lang) {
    diagnostics.add("DIAG002", "This code block holds a Mermaid diagram but has no language, so it was shown as code, not drawn", b.pos, { hint: "Write ```mermaid on the opening fence" });
  }
}

/** Caption text as inlines (Markdown and $math$ allowed). */
function captionInlines(text: string): Inline[] {
  const doc = parseMarkdown(text, memoryContext());
  const first = doc.blocks[0];
  return first && (first.t === "Para" || first.t === "Plain") ? first.content : [{ t: "Text", text }];
}

export function renderDocumentDiagrams(doc: Document, diagnostics: Diagnostics, file?: string): void {
  const extra = doc.meta.extra ?? {};
  const theme = [extra["diagram-theme"], extra["mermaid-theme"], extra.diagramTheme].find((v): v is string => typeof v === "string");
  walkBlocks(doc.blocks, (b) => {
    if (b.t === "CodeBlock" && !isDiagram(b)) {
      misnamedFence(b, diagnostics);
      return;
    }
    if (!isDiagram(b)) return;
    const r = renderDiagram(b.text, { theme });
    const pos = b.pos;
    for (const e of r.errors) {
      // The diagram's first line is the line after the opening fence.
      const where = pos ? { ...pos, line: pos.line + 1 + e.line, col: e.col + 1 } : file ? { file } : undefined;
      diagnostics.add("DIAG001", `Diagram: ${e.message}`, where, {
        ...(e.hint ? { hint: e.hint } : {}),
        ...(e.fix ? { fix: { ...e.fix, safe: false } } : {}),
      });
    }
    if (!r.svg) return;
    const attrs = b.attr?.attrs ?? {};
    const caption = attrs.caption ?? attrs.title;
    const label = b.attr?.id;
    const image: Inline = {
      t: "Image",
      src: `data:image/svg+xml;base64,${Buffer.from(r.svg, "utf8").toString("base64")}`,
      alt: [{ t: "Text", text: caption ?? r.title ?? `${r.kind} diagram` }],
      ...(attrs.width ? { width: attrs.width } : {}),
      attr: { classes: ["tw-diagram"] },
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
    // Replace the code block in place: walkBlocks hands out the objects its arrays hold.
    const target = b as unknown as Record<string, unknown>;
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, fig);
  });
}
