/**
 * texwright's math typesetter (replaces KaTeX).
 *
 *   typesetMath(tex, options) -> { box, ok }   TeX boxes for the PDF writer
 *   mathml(tex, options)      -> string        MathML Core for HTML
 *
 * Parse errors are reported as MATH001 at the exact line and column inside
 * the formula (options.pos is the position of the formula's first
 * character); macro redefinitions as MATH002. A formula that does not parse
 * still produces output: its source, in red typewriter type (PDF) or in an
 * <merror> (MathML).
 */

import type { Pos } from "../ast.js";
import type { Diagnostics, FixSpec } from "../diagnostics.js";
import type { HBox } from "../layout/types.js";
import type { MathEngine, MathOptions, MathResult } from "./api.js";
import type { Formula } from "./ast.js";
import { glyphNode, hpack } from "./boxes.js";
import { composeDisplay } from "./display.js";
import { MathError } from "./errors.js";
import { T, layoutList } from "./layout.js";
import { errorMathML, formulaToMathML } from "./mathml.js";
import { parseFormula } from "./parser.js";

export { MAX_EXPANDED, MAX_EXPANSIONS } from "./macros.js";
export { ENVIRONMENT_NAMES } from "./parser.js";

/** Line and column of an offset inside the formula, given the formula's own start position. */
export function positionIn(tex: string, offset: number, pos: Pos | undefined): Pos | undefined {
  if (!pos) return undefined;
  let line = pos.line;
  let lineStart = 0;
  const end = Math.min(Math.max(0, offset), tex.length);
  for (let i = 0; i < end; i++) {
    if (tex.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  const col = line === pos.line ? pos.col + end : end - lineStart + 1;
  const out: Pos = { line, col };
  if (pos.file) out.file = pos.file;
  return out;
}

function normalizeMacros(macros: Record<string, string>): Record<string, string> {
  // Names without a backslash (front matter "R: \mathbb{R}") are accepted too.
  for (const k of Object.keys(macros)) {
    if (!k.startsWith("\\") && /^[A-Za-z]+$/.test(k) && macros[`\\${k}`] === undefined) macros[`\\${k}`] = macros[k]!;
  }
  return macros;
}

interface Parsed {
  formula?: Formula;
  error?: MathError;
}

/**
 * Readers give a formula the position of its opening delimiter ($, \(, \begin{equation}), and an
 * environment's body may be trimmed, so offsets inside the formula would land a column or a line
 * early. With the source at hand, find where the formula's own text starts, searching forward
 * from that position, and count from there.
 */
function anchored(tex: string, pos: Pos | undefined, diagnostics: Diagnostics): { tex: string; pos: Pos | undefined; skip: number } {
  const lines = pos?.file ? diagnostics.sourceLines(pos.file) : undefined;
  if (!pos || !lines) return { tex, pos, skip: 0 };
  // The writers may wrap a display in an environment of their own, so the formula's first line
  // need not be in the source: the first of its lines that is, anchors it.
  let offset = 0;
  for (const raw of tex.split("\n").slice(0, 8)) {
    // Where the line's text could start in the source: its first character, or past a
    // \begin{equation} the writer put in front of it.
    const lead = raw.length - raw.trimStart().length;
    const wrapped = /^\s*\\begin\{[^}]*\}(\[[^\]]*\])?\s*/.exec(raw);
    for (const start of wrapped ? [wrapped[0].length, lead] : [lead]) {
      const sig = raw.slice(start).replace(/\\end\{[^}]*\}\s*$/, "").trim().slice(0, 40);
      if (sig.length < 2) continue;
      for (let l = pos.line; l <= Math.min(lines.length, pos.line + 30); l++) {
        const text = lines[l - 1] ?? "";
        const at = text.indexOf(sig, l === pos.line ? Math.max(0, pos.col - 1) : 0);
        if (at >= 0) return { tex: tex.slice(offset + start), pos: { ...pos, line: l, col: at + 1 }, skip: offset + start };
      }
    }
    offset += raw.length + 1;
  }
  return { tex, pos, skip: 0 };
}

function parse(tex: string, macros: Record<string, string>, display: boolean, diagnostics: Diagnostics, pos0: Pos | undefined): Parsed {
  // Positions are worked out only when there is something to report.
  let a: ReturnType<typeof anchored> | undefined;
  const where = (offset: number): Pos | undefined => {
    a ??= anchored(tex, pos0, diagnostics);
    return positionIn(a.tex, Math.max(0, offset - a.skip), a.pos);
  };
  // A fix at an offset of its own (an insertion) is placed there; text a writer wrapped around the
  // formula (\begin{equation} ...) is not in the source, so it is cut from the front of `old`.
  const placeFix = (f: NonNullable<MathError["fix"]>): FixSpec | undefined => {
    if (f.at === undefined) return f;
    a ??= anchored(tex, pos0, diagnostics);
    let { old, new: rep, at } = f;
    if (at < a.skip && rep.startsWith(old)) {
      const cut = a.skip - at;
      if (cut >= old.length) return undefined;
      old = old.slice(cut);
      rep = rep.slice(cut);
      at += cut;
    }
    const p = where(at);
    return p && { old, new: rep, safe: f.safe, line: p.line, col: p.col };
  };
  try {
    const formula = parseFormula(tex, normalizeMacros(macros), display, (code, message, offset, hint) => {
      diagnostics.add(code, message, where(offset), hint ? { hint } : undefined);
    });
    return { formula };
  } catch (e) {
    if (e instanceof MathError) {
      diagnostics.add("MATH001", e.message, where(e.pos), { hint: e.hint, fix: e.fix && placeFix(e.fix) });
      return { error: e };
    }
    if (e instanceof RangeError) {
      const err = new MathError("Formula is too deeply nested to typeset", 0, "Simplify the formula or check for runaway braces");
      diagnostics.add("MATH001", err.message, where(0), { hint: err.hint! });
      return { error: err };
    }
    throw e;
  }
}

/** The source of a formula that failed to parse, shown in red typewriter type. */
function errorBox(tex: string, size: number): HBox {
  const red: [number, number, number] = [0.8, 0, 0];
  const nodes = [];
  let src = tex.replace(/\s+/g, " ").trim();
  // Show at most a few hundred characters of a huge broken formula.
  if (src.length > 400) src = `${src.slice(0, 400)}…`;
  for (const ch of src) nodes.push(glyphNode("tt", ch.codePointAt(0)!, size, ch, red).node);
  return hpack(nodes);
}

export function typesetMath(tex: string, options: MathOptions): MathResult {
  const parsed = parse(tex, options.macros, options.display, options.diagnostics, options.pos);
  const ctx = { base: options.fontSize };
  if (!parsed.formula) {
    const box = errorBox(tex, options.fontSize);
    if (options.display && options.lineWidth !== undefined && box.width < options.lineWidth) {
      const l = (options.lineWidth - box.width) / 2;
      return { box: { t: "hbox", width: options.lineWidth, height: box.height, depth: box.depth, children: [{ t: "kern", width: l }, ...box.children] }, ok: false };
    }
    return { box, ok: false };
  }
  try {
    if (options.display) {
      const box = composeDisplay(parsed.formula, ctx, { lineWidth: options.lineWidth, tags: options.tags });
      return { box, ok: true };
    }
    const r = layoutList(parsed.formula.body, T, ctx, { penalties: true });
    return { box: r.box, ok: true };
  } catch (e) {
    if (e instanceof RangeError) {
      options.diagnostics.add("MATH001", "Formula is too deeply nested to typeset", positionIn(tex, 0, options.pos), { hint: "Simplify the formula or check for runaway braces" });
      return { box: errorBox(tex, options.fontSize), ok: false };
    }
    throw e;
  }
}

export function mathml(tex: string, options: Pick<MathOptions, "display" | "macros" | "diagnostics" | "pos" | "tags">): string {
  const parsed = parse(tex, options.macros, options.display, options.diagnostics, options.pos);
  if (!parsed.formula) return errorMathML(tex, options.display, parsed.error?.message ?? "error");
  try {
    return formulaToMathML(parsed.formula, tex, options.display, { tags: options.tags });
  } catch (e) {
    if (e instanceof RangeError) return errorMathML(tex, options.display, "Formula is too deeply nested");
    throw e;
  }
}

/** The engine as one object (src/math/api.ts). */
export const engine: MathEngine = { typesetMath, mathml };
