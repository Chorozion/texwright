/**
 * Machine-applicable fixes for diagnostics.
 *
 * A diagnostic may carry a fix: the text to look for (`old`) from its line
 * and column, and what to put there (`new`). That is the shape an agent's
 * edit tool already takes, so a fix can be applied without reasoning about
 * the document. A fix is `safe` when exactly one candidate is clearly
 * closest and only a small typo away; `texwright check --fix` applies only
 * safe fixes, and an agent can apply the others after a look.
 */

import type { Fix } from "./diagnostics.js";

/**
 * Edit distance counting insertions, deletions, substitutions and swaps of two adjacent characters
 * (the optimal string alignment distance): "alpah" is one typo from "alpha", as a person counts it.
 * Gives up, returning cap + 1, once every alignment is over `cap`.
 */
export function editDistance(a: string, b: string, cap = Infinity): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The candidate clearly closest to `bad`: strictly nearer than every other, and within
 * `maxDistance` edits (default: 2, or a third of the word for long words). It is safe to apply
 * unseen when it differs only in letter case, or is at most two same-case edits away from a word
 * of four or more characters.
 */
export function closestFix(bad: string, candidates: Iterable<string>, maxDistance?: number): { replacement: string; safe: boolean } | undefined {
  const limit = maxDistance ?? Math.max(2, Math.floor(bad.length / 3));
  const lower = bad.toLowerCase();
  // Ranked by distance ignoring case, then by distance with case, so "\alpah" prefers "\alpha" to "\Alpha".
  type Score = [number, number];
  const better = (x: Score, y: Score) => x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  let best: string | undefined;
  let bestS: Score = [Infinity, Infinity];
  let secondS: Score = [Infinity, Infinity];
  for (const c of candidates) {
    if (c === bad) continue;
    const d = c.toLowerCase() === lower ? 0 : editDistance(lower, c.toLowerCase(), limit);
    if (d > limit) continue;
    const s: Score = [d, editDistance(bad, c, limit + 2)];
    if (better(s, bestS)) {
      secondS = bestS;
      bestS = s;
      best = c;
    } else if (!better(secondS, s)) secondS = s;
  }
  if (best === undefined || !better(bestS, secondS)) return undefined;
  // A change of letter case on top of another edit ("\Call" to "\cal") names a different command
  // more often than it fixes a typo, so only same-case near misses count as safe.
  const safe = bestS[0] === 0 || (bestS[0] <= 2 && bestS[1] === bestS[0] && bad.length >= 4);
  return { replacement: best, safe };
}

/** Characters that continue a label, key or path, so a match must not run into them. */
const WORDISH = /[A-Za-z0-9_:.\-/]/;
const LETTER = /[A-Za-z]/;

/** Whether the text at `at` continues a word: "." and ":" do only when a letter or digit follows (not "@sec:intr."). */
function continuesWord(text: string, at: number): boolean {
  const c = text[at] ?? "";
  if (c === "." || c === ":") return /[A-Za-z0-9_]/.test(text[at + 1] ?? "");
  return WORDISH.test(c);
}

/**
 * Offset of `old` in `text`: exactly at (line, col) when it is there (insertions and other edits
 * anchored on the text around a point), else the first whole-word match at or after it; -1 when absent.
 */
function locate(text: string, starts: number[], fix: Fix): number {
  if (fix.line < 1 || fix.line > starts.length || !fix.old) return -1;
  const from = starts[fix.line - 1]! + Math.max(0, fix.col - 1);
  if (text.startsWith(fix.old, from)) return from;
  // The diagnostic points at the construct (an "@", a "\ref{", a "[@"); the text is close by.
  const end = Math.min(text.length, from + 2000);
  for (let at = text.indexOf(fix.old, from); at !== -1 && at < end; at = text.indexOf(fix.old, at + 1)) {
    const before = at > 0 ? text[at - 1]! : "";
    const after = text[at + fix.old.length] ?? "";
    if (fix.old.startsWith("\\")) {
      // A TeX control word ends at the first non-letter.
      if (!LETTER.test(after)) return at;
    } else if (!continuesWord(text, at + fix.old.length) && !(WORDISH.test(before) && before !== "/" && before !== ":")) {
      return at;
    }
  }
  return -1;
}

/**
 * Apply fixes to one file's text. Each fix replaces the first whole-word occurrence of `old`
 * at or after its position; fixes that cannot be found or that overlap an earlier one are skipped.
 */
export function applyFixes(text: string, fixes: readonly Fix[]): { text: string; applied: Fix[]; skipped: Fix[] } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  // Fixes spanning lines are written with \n; in a file with Windows line ends they use \r\n.
  const crlf = text.includes("\r\n");
  const located = fixes.map((given) => {
    const f = crlf && given.old.includes("\n") ? { ...given, old: given.old.replace(/\r?\n/g, "\r\n"), new: given.new.replace(/\r?\n/g, "\r\n") } : given;
    return { f, given, at: locate(text, starts, f) };
  });
  const skipped = located.filter((x) => x.at < 0).map((x) => x.given);
  const found = located.filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  const applied: Fix[] = [];
  let out = "";
  let last = 0;
  for (const { f, given, at } of found) {
    if (at < last) {
      skipped.push(given);
      continue;
    }
    out += text.slice(last, at) + f.new;
    last = at + f.old.length;
    applied.push(given);
  }
  out += text.slice(last);
  return { text: out, applied, skipped };
}

/**
 * An edit that inserts `insert` at offset `at` of `text`, in the shape fixes take: `old` is the text
 * just before the point on the same line (up to 40 characters), or just after it when nothing but
 * blanks precedes it, and `new` is `old` with the insertion. `start` is the offset where `old` begins.
 */
export function insertionEdit(text: string, at: number, insert: string): { start: number; old: string; new: string } | undefined {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  let s = Math.max(lineStart, at - 40);
  // Never start inside a surrogate pair.
  if (s > lineStart && /[\udc00-\udfff]/.test(text[s] ?? "")) s++;
  const lead = text.slice(s, at).length - text.slice(s, at).trimStart().length;
  const before = text.slice(s + lead, at);
  if (before) return { start: s + lead, old: before, new: before + insert };
  let lineEnd = text.indexOf("\n", at);
  if (lineEnd < 0) lineEnd = text.length;
  const after = text.slice(at, Math.min(lineEnd, at + 40)).replace(/\r$/, "");
  if (after.trim()) return { start: at, old: after, new: insert + after };
  return undefined;
}

/** 1-based line and column of offset `at` in `text`. */
export function lineColAt(text: string, at: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, col: at - last };
}
