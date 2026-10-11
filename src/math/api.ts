/**
 * The math typesetter's interface (implemented in src/math/). It replaces
 * KaTeX: LaTeX math source in, a TeX-style box out (for PDF), MathML out
 * (for HTML), and diagnostics for anything it cannot parse.
 */

import type { Pos } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import type { HBox } from "../layout/types.js";

export type MathStyle = "display" | "text" | "script" | "scriptscript";

export interface MathOptions {
  display: boolean;
  /** Body font size in points (the size of \normalsize text). */
  fontSize: number;
  /** User macros: name with backslash -> body with #1..#9. */
  macros: Record<string, string>;
  diagnostics: Diagnostics;
  /** Source position of the formula, for diagnostics; errors inside multi-line math report the right line. */
  pos?: Pos;
  /** Equation tags for display environments: one per row for align/gather (null = unnumbered row), or one for the whole formula. */
  tags?: (string | null)[] | string;
  /** Width available for display math (tags are placed at the right margin). */
  lineWidth?: number;
}

export interface MathResult {
  /** The typeset formula. For display math, a full-width line (or stacked lines) with tags in place. */
  box: HBox;
  ok: boolean;
}

/** The functions src/math/index.ts must export. */
export interface MathEngine {
  typesetMath(tex: string, options: MathOptions): MathResult;
  /** MathML Core markup for HTML output (display="block" when display). */
  mathml(tex: string, options: Pick<MathOptions, "display" | "macros" | "diagnostics" | "pos" | "tags">): string;
}
