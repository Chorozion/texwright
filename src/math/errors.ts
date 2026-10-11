/**
 * Parse errors with a source offset and a hint, reported as MATH001.
 */

import { closestFix } from "../fixes.js";

export class MathError extends Error {
  constructor(
    message: string,
    /** Offset in the formula source. */
    readonly pos: number,
    readonly hint?: string,
    /**
     * A replacement at `pos` that resolves the error (a misspelt command's nearest real one), or at
     * offset `at` when given (a missing } or \right inserted where the group ends).
     */
    readonly fix?: { old: string; new: string; safe: boolean; at?: number },
  ) {
    super(message);
  }
}

/** Commands that come from LaTeX packages this typesetter does not include. */
const PACKAGE_COMMANDS: Record<string, string> = {
  "\\tikz": "TikZ",
  "\\includegraphics": "graphicx",
  "\\sout": "ulem",
};

/** Edit distance with adjacent transpositions counted as one edit, capped (returns cap+1 once exceeded). */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[b.length]!;
}

/** A fix for an undefined command: the one known command clearly nearest to it, if there is one. */
export function commandFix(name: string, known: Iterable<string>): { old: string; new: string; safe: boolean } | undefined {
  const commands = [...known].filter((k) => k.startsWith("\\") && k.length >= 3);
  const best = closestFix(name, commands, name.length <= 4 ? 1 : 2);
  return best && { old: name, new: best.replacement, safe: best.safe };
}

/** The closest known command names to an unknown one. */
export function suggest(name: string, known: Iterable<string>): string[] {
  const cap = name.length <= 4 ? 1 : 2;
  const scored: [string, number][] = [];
  const lower = name.toLowerCase();
  for (const k of known) {
    if (!k.startsWith("\\") || k.length < 3) continue;
    const d = k.toLowerCase() === lower ? 0 : distance(name, k, cap);
    if (d <= cap) scored.push([k, d]);
  }
  scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return scored.slice(0, 3).map(([k]) => k);
}

export function undefinedHint(name: string, known: Iterable<string>): string {
  const pkg = PACKAGE_COMMANDS[name];
  if (pkg) return `${name} comes from the ${pkg} package, which texwright's math does not include; define it in front-matter "macros" or with \\newcommand`;
  const close = suggest(name, known);
  const fix = `Define it in front-matter "macros" (e.g. ${name}: "...") or with \\newcommand, or check the spelling`;
  return close.length ? `Did you mean ${close.join(" or ")}? Otherwise ${fix[0]!.toLowerCase()}${fix.slice(1)}` : fix;
}
