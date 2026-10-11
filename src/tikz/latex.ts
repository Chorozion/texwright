/**
 * The bridge from the LaTeX reader to the TikZ interpreter: a tikzpicture
 * (or pgfplots axis, or \tikz command) becomes an Image whose source is the
 * drawn SVG, with class tw-diagram, exactly like a Mermaid diagram, so HTML
 * inlines it and the PDF draws it as vectors. Problems are TIKZ001 warnings
 * at their place in the picture. When nothing at all could be drawn the
 * caller keeps today's LTX004 error and the raw source.
 */

import type { Inline } from "../ast.js";
import { shiftPos } from "../parse/context.js";
import type { Token } from "../parse/latex/lexer.js";
import type { Parser } from "../parse/latex/parser.js";
import { resolveColor } from "../parse/latex/commands.js";
import { lineCol, preambleCommands, renderTikz } from "./index.js";
import { stripComments } from "./scan.js";

/** Environments the interpreter draws. */
export const TIKZ_ENVS = new Set(["tikzpicture", "axis", "semilogxaxis", "semilogyaxis", "loglogaxis", "circuitikz", "forest"]);

/** Picture-configuring commands of each source, found once (a document may hold thousands of pictures). */
const preambleCache = new WeakMap<object, { at: number; text: string }[]>();

function preambleFor(tok: Token): string {
  let cmds = preambleCache.get(tok.src);
  if (!cmds) preambleCache.set(tok.src, (cmds = preambleCommands(stripComments(tok.src.text))));
  if (!cmds.length) return "";
  return cmds
    .filter((c) => c.at < tok.start)
    .map((c) => c.text)
    .join("\n");
}

/** Draws `raw` (the picture's source, starting at `tok`) and returns the image, or undefined when nothing could be drawn. */
export function tikzFromLatex(p: Parser, tok: Token, raw: string): Extract<Inline, { t: "Image" }> | undefined {
  const r = renderTikz(raw, {
    macros: p.meta.macros ?? {},
    color: (name) => resolveColor(p, name),
    readFile: (path) => p.ctx.readFile(path),
    preamble: tok.depth === 0 ? preambleFor(tok) : "",
  });
  const ctx = tok.src.frame.ctx;
  const where = (offset: number) => {
    if (tok.depth > 0) return p.pos(tok);
    const lc = lineCol(raw, offset);
    return shiftPos(ctx, tok.line + lc.line - 1, lc.line === 1 ? tok.col + lc.col - 1 : lc.col);
  };
  if (!r.svg) return undefined;
  for (const m of r.messages) p.ctx.diagnostics.add("TIKZ001", `TikZ: ${m.message}`, where(m.offset), m.hint ? { hint: m.hint } : undefined);
  return {
    t: "Image",
    src: `data:image/svg+xml;base64,${Buffer.from(r.svg, "utf8").toString("base64")}`,
    alt: [{ t: "Text", text: "TikZ picture" }],
    attr: { classes: ["tw-diagram", "tikz"] },
    pos: p.pos(tok),
  };
}
