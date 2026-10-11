/** What every diagram type shares: errors with positions, the theme, the result. */

import type { Theme } from "./theme.js";

export interface DiagramError {
  /** 0-based line within the diagram source, and 0-based column. */
  line: number;
  col: number;
  message: string;
  hint?: string;
  /** A replacement at (line, col): `old` there becomes `new`. */
  fix?: { old: string; new: string };
}

export interface DiagramContext {
  theme: Theme;
  errors: DiagramError[];
  /** From front matter `title:` or the diagram's own title statement. */
  title?: string;
}

export interface Rendered {
  svg: string;
  width: number;
  height: number;
}

/** The lines of a diagram's source with comments removed, each with its line number. */
export function sourceLines(src: string): { text: string; line: number }[] {
  return src.split(/\r?\n/).map((raw, line) => ({ text: stripComment(raw), line }));
}

/** Drops a %% comment, unless the %% is inside quotes. */
export function stripComment(s: string): string {
  let q = "";
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"') q = c;
    else if (c === "%" && s[i + 1] === "%") return s.slice(0, i);
  }
  return s;
}

/** A quoted string's content, or the text trimmed. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1);
  return t;
}
