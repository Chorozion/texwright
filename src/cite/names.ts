/**
 * BibTeX name lists ("Doe, Jane and van Beethoven, Ludwig and others") to
 * CSL names, following BibTeX's rules for the First, von, Last and Jr parts.
 */

import { latexToText } from "./latex.js";
import type { Name } from "./types.js";

export function parseBibtexNames(raw: string): Name[] {
  const names: Name[] = [];
  for (const part of splitAnd(raw)) {
    const name = parseName(part);
    if (name) names.push(name);
  }
  return names;
}

/** Split on " and " (any case) outside braces. */
function splitAnd(raw: string): string[] {
  const parts: string[] = [];
  const sep = /\s+and\s+/iy;
  let depth = 0;
  let start = 0;
  // A separator found nowhere in a run of whitespace is found nowhere later in it: \s+ already took the rest.
  let failedUntil = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && i >= failedUntil && /\s/.test(c)) {
      sep.lastIndex = i;
      const m = sep.exec(raw);
      if (m) {
        parts.push(raw.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      } else {
        failedUntil = i + 1;
        while (failedUntil < raw.length && /\s/.test(raw[failedUntil])) failedUntil++;
      }
    }
  }
  parts.push(raw.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Split at characters matching `isSep` outside braces. */
function splitTop(s: string, isSep: (c: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && isSep(c)) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const words = (s: string): string[] => splitTop(s, (c) => /\s/.test(c) || c === "~").filter((w) => w !== "");

/** BibTeX decides a word's case by its first letter; a brace group not starting with a command is caseless. */
function isLowerWord(word: string): boolean {
  if (word.startsWith("{") && word[1] !== "\\") return false;
  const letter = /\p{L}/u.exec(latexToText(word))?.[0];
  return letter !== undefined && letter !== letter.toUpperCase();
}

function isOneGroup(s: string): boolean {
  if (!s.startsWith("{") || !s.endsWith("}")) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i === s.length - 1;
  }
  return false;
}

function parseName(raw: string): Name | undefined {
  if (/^others$/i.test(raw)) return { literal: "others" };
  if (isOneGroup(raw)) return { literal: latexToText(raw) };
  const parts = splitTop(raw, (c) => c === ",").map((p) => p.trim());
  let first: string[];
  let von: string[];
  let last: string[];
  let jr: string[] = [];
  if (parts.length === 1) {
    // First von Last: von runs from the first to the last lowercase word before the final word.
    const w = words(parts[0]);
    const lower = w.map(isLowerWord);
    const f = lower.findIndex((l, k) => l && k < w.length - 1);
    if (f < 0) {
      first = w.slice(0, -1);
      von = [];
      last = w.slice(-1);
    } else {
      let l = f;
      for (let k = f; k < w.length - 1; k++) if (lower[k]) l = k;
      first = w.slice(0, f);
      von = w.slice(f, l + 1);
      last = w.slice(l + 1);
    }
  } else {
    // von Last, [Jr,] First: von is the longest prefix ending in a lowercase word, never the final word.
    const w = words(parts[0]);
    let l = -1;
    for (let k = 0; k < w.length - 1; k++) if (isLowerWord(w[k])) l = k;
    von = w.slice(0, l + 1);
    last = w.slice(l + 1);
    if (parts.length === 2) first = words(parts[1]);
    else {
      jr = words(parts[1]);
      first = words(parts.slice(2).join(", "));
    }
  }
  const name: Name = {};
  const family = latexToText(last.join(" "));
  const given = latexToText(first.join(" "));
  const particle = latexToText(von.join(" "));
  const suffix = latexToText(jr.join(" "));
  if (family) name.family = family;
  if (given) name.given = given;
  if (particle) name["non-dropping-particle"] = particle;
  if (suffix) name.suffix = suffix;
  return name.family || name.given ? name : undefined;
}
