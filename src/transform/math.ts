/**
 * Math helpers shared by the writers: macro collection, row and label
 * scanning, and the source and tags handed to the math engine.
 *
 * The numbering pass decides every equation number; the engine is given the
 * tags with the formula and keeps no counter of its own, so the number
 * printed and the number a reference resolves to always agree.
 */

import type { Pos } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";

/** Multi-row environments that number each row in LaTeX. */
export const ROW_NUMBERED = new Set(["align", "gather", "alignat", "flalign", "eqnarray"]);
/** Environments that take one number for the whole block. */
export const SINGLE_NUMBERED = new Set(["equation", "multline"]);

export interface MathRow {
  tex: string;
  label?: string;
  /** \nonumber or \notag on the row. */
  suppressed: boolean;
}

/** Find the end of a balanced {...} group starting at `open` (which must be '{'). Returns index after '}'. */
function groupEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Remove every \label{...} and return the labels found, in order. */
export function extractLabels(tex: string): { tex: string; labels: string[] } {
  const labels: string[] = [];
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const at = tex.indexOf("\\label", i);
    if (at < 0) break;
    let j = at + 6;
    while (j < tex.length && /\s/.test(tex[j]!)) j++;
    if (tex[j] !== "{" || /[A-Za-z]/.test(tex[at + 6] ?? "")) {
      out += tex.slice(i, at + 6);
      i = at + 6;
      continue;
    }
    const end = groupEnd(tex, j);
    if (end < 0) break;
    labels.push(tex.slice(j + 1, end - 1).trim());
    out += tex.slice(i, at);
    i = end;
  }
  out += tex.slice(i);
  return { tex: out, labels };
}

/** Split an environment body into rows at top-level \\ (not inside braces or nested environments). */
export function splitRows(tex: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let envDepth = 0;
  let start = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") {
      if (tex.startsWith("\\begin{", i)) envDepth++;
      else if (tex.startsWith("\\end{", i)) envDepth--;
      else if (tex[i + 1] === "\\" && depth === 0 && envDepth === 0) {
        rows.push(tex.slice(start, i));
        i++;
        // Skip an optional spacing argument: \\[2pt]
        let j = i + 1;
        while (j < tex.length && /[ \t]/.test(tex[j]!)) j++;
        if (tex[j] === "[") {
          const close = tex.indexOf("]", j);
          if (close > 0) i = close;
        }
        start = i + 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  rows.push(tex.slice(start));
  // A trailing \\ leaves an empty last row in LaTeX without adding a line.
  if (rows.length > 1 && rows[rows.length - 1]!.trim() === "") rows.pop();
  return rows;
}

export function parseRows(tex: string): MathRow[] {
  return splitRows(tex).map((raw) => {
    const { tex: noLabels, labels } = extractLabels(raw);
    const suppressed = /\\(?:nonumber|notag)(?![A-Za-z])/.test(noLabels);
    const cleaned = noLabels.replace(/\\(?:nonumber|notag)(?![A-Za-z])/g, "");
    const row: MathRow = { tex: cleaned, suppressed };
    if (labels[0]) row.label = labels[0];
    return row;
  });
}

// ------------------------------------------------------------------ macros

const DEF_COMMANDS = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)\s*/g;

/**
 * Pull \newcommand-style definitions out of a math source into the shared
 * macro table, so a definition in one formula works in every later one.
 */
export function liftMacros(tex: string, macros: Record<string, string>, diagnostics?: Diagnostics, pos?: Pos): string {
  if (!tex.includes("command") && !tex.includes("DeclareMathOperator") && !tex.includes("\\def") && !tex.includes("DeclarePairedDelimiter")) return tex;
  // mathtools: \DeclarePairedDelimiter\abs{\lvert}{\rvert}; the math engine's \twpaired reads the star and size.
  tex = tex.replace(
    /\\DeclarePairedDelimiter\s*(?:\{\s*(\\[A-Za-z]+)\s*\}|(\\[A-Za-z]+))\s*(\{[^{}]*\}|\\[A-Za-z]+|[^\s{}])\s*(\{[^{}]*\}|\\[A-Za-z]+|[^\s{}])/g,
    (_, braced: string | undefined, bare: string | undefined, l: string, r: string) => {
      const strip = (d: string) => (d.startsWith("{") ? d.slice(1, -1).trim() : d);
      macros[(braced ?? bare)!] = `\\twpaired{${strip(l)}}{${strip(r)}}`;
      return "";
    },
  );
  let out = "";
  let last = 0;
  // A local regex: the scan position only ever moves forward, so malformed
  // input can't send it back to a definition it has already seen.
  const defs = new RegExp(DEF_COMMANDS.source, "g");
  for (let m = defs.exec(tex); m; m = defs.exec(tex)) {
    const kind = m[1]!;
    const star = m[2] === "*";
    let i = m.index + m[0].length;
    // Name: {\foo} or \foo
    let name: string | undefined;
    if (tex[i] === "{") {
      const end = groupEnd(tex, i);
      if (end < 0) continue;
      name = tex.slice(i + 1, end - 1).trim();
      i = end;
    } else {
      const nm = /^\\[A-Za-z]+/.exec(tex.slice(i));
      if (!nm) continue;
      name = nm[0];
      i += nm[0].length;
    }
    // The engine infers the number of arguments from #1..#9 in the body, so
    // the declared count only matters for skipping it.
    let defaultArg: string | undefined;
    const skipWs = () => {
      while (i < tex.length && /\s/.test(tex[i]!)) i++;
    };
    skipWs();
    if (kind !== "DeclareMathOperator" && tex[i] === "[") {
      const close = tex.indexOf("]", i);
      if (close < 0) continue; // malformed: leave it for the engine to report
      i = close + 1;
      skipWs();
      if (tex[i] === "[") {
        const close2 = tex.indexOf("]", i);
        if (close2 < 0) continue;
        defaultArg = tex.slice(i + 1, close2);
        i = close2 + 1;
        skipWs();
      }
    }
    if (tex[i] !== "{") continue;
    const end = groupEnd(tex, i);
    if (end <= i) continue;
    let body = tex.slice(i + 1, end - 1);
    if (kind === "DeclareMathOperator") body = `\\operatorname${star ? "*" : ""}{${body}}`;
    if (defaultArg !== undefined) {
      // Macro table entries have no optional arguments; bake the default in.
      body = body.replace(/#1/g, defaultArg).replace(/#(\d)/g, (_, d: string) => `#${Number(d) - 1}`);
    }
    if (kind === "providecommand" && macros[name] !== undefined) {
      // keep the existing definition
    } else {
      if (kind === "newcommand" && macros[name] !== undefined && macros[name] !== body && diagnostics) {
        diagnostics.add("MATH002", `Math macro ${name} redefined`, pos);
      }
      macros[name] = body;
    }
    out += tex.slice(last, m.index);
    last = end;
    defs.lastIndex = end;
  }
  out += tex.slice(last);
  // \def\name{body}
  return out.replace(/\\def\s*(\\[A-Za-z]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_, name: string, body: string) => {
    macros[name] = body;
    return "";
  });
}

// ------------------------------------------------------------------ limits

/** Most TeX characters a formula may expand to through macros. */
export const MAX_EXPANDED_MATH = 200_000;

/**
 * Upper estimate of how long a formula becomes once its macros are expanded.
 * A count of expansions alone does not bound their size, so a big macro used
 * many times could otherwise turn a few kilobytes into gigabytes. Returns
 * early once over `limit`.
 */
export function expandedSize(tex: string, macros: Record<string, string>, limit = MAX_EXPANDED_MATH): number {
  const names = Object.keys(macros);
  if (!names.length) return tex.length;
  const memo = new Map<string, number>();
  const sizeOf = (text: string, depth: number): number => {
    let total = text.length;
    if (depth > 20) return limit + 1;
    for (const m of text.matchAll(/\\([A-Za-z]+|.)/g)) {
      const name = `\\${m[1]}`;
      const body = macros[name];
      if (body === undefined) continue;
      let size = memo.get(name);
      if (size === undefined) {
        memo.set(name, limit + 1); // a macro that refers to itself is over budget
        // Each #n can repeat an argument; count body uses of parameters as copies of a short argument.
        size = sizeOf(body, depth + 1) + (body.match(/#\d/g)?.length ?? 0) * 64;
        memo.set(name, size);
      }
      total += size;
      if (total > limit) return limit + 1;
    }
    return total;
  };
  return sizeOf(tex, 0);
}

// ------------------------------------------------------------------ display blocks

/**
 * The TeX and the tags the math engine gets for a display block: the
 * environment as written (the engine reads \label and \nonumber itself) and
 * the numbers the numbering pass assigned, one per row or one for the block.
 */
export function displaySource(
  b: { env?: string; number?: string; lineNumbers?: (string | null)[] },
  body: string,
): { tex: string; tags?: (string | null)[] | string } {
  const tex = b.env ? `\\begin{${b.env}}${body}\\end{${b.env}}` : body;
  const tags = b.lineNumbers ? b.lineNumbers.map((n) => n || null) : b.number || undefined;
  return { tex, tags };
}
