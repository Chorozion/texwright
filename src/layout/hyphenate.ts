/**
 * Liang's hyphenation algorithm ("Word Hy-phen-a-tion by Com-put-er", 1983;
 * The TeXbook, Appendix H).
 *
 * A pattern such as "hy3ph" or ".ab4" is a string of letters with digits
 * between them ("." marks a word edge). Every pattern that matches inside
 * ".word." contributes its digits to the gaps it covers; each gap keeps the
 * largest value, and odd values allow a hyphen there. Patterns live in a
 * trie keyed by letters, so a word of n letters costs O(n^2) trie steps.
 *
 * Patterns load from hyphenation/<lang>.json ({patterns: string[],
 * exceptions: string[]}) when that file exists; texwright ships en-us (TeX's
 * own US English patterns). Exception lists passed in are always honoured,
 * and soft hyphens in the text work regardless (see text.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface HyphenatorOptions {
  patterns?: readonly string[];
  /** Words with their allowed hyphens marked, e.g. "ta-ble" (TeX's \hyphenation). */
  exceptions?: readonly string[];
  /** TeX's \lefthyphenmin (default 2) and \righthyphenmin (default 3). */
  leftMin?: number;
  rightMin?: number;
}

export interface HyphenationData {
  patterns: string[];
  exceptions: string[];
}

interface TrieNode {
  next: Map<string, TrieNode>;
  /** Digits of the pattern ending here: values[k] is the digit before letter k. */
  values?: number[];
}

/** Splits a pattern into its letters and the digit in each gap (length letters + 1). */
export function parsePattern(pattern: string): { letters: string[]; values: number[] } {
  const letters: string[] = [];
  const values: number[] = [0];
  for (const ch of pattern) {
    if (ch >= "0" && ch <= "9") values[values.length - 1] = ch.charCodeAt(0) - 48;
    else {
      letters.push(lower(ch));
      values.push(0);
    }
  }
  return { letters, values };
}

/** Lower-cases one character without changing its length (TeX's \lccode, roughly). */
function lower(ch: string): string {
  const l = ch.toLowerCase();
  return [...l].length === 1 ? l : ch;
}

export class Hyphenator {
  readonly leftMin: number;
  readonly rightMin: number;
  private readonly root: TrieNode = { next: new Map() };
  private readonly exceptions = new Map<string, number[]>();
  private patternCount = 0;
  private maxPattern = 0;

  constructor(opts: HyphenatorOptions = {}) {
    this.leftMin = Math.max(1, opts.leftMin ?? 2);
    this.rightMin = Math.max(1, opts.rightMin ?? 3);
    for (const p of opts.patterns ?? []) this.addPattern(p);
    for (const e of opts.exceptions ?? []) this.addException(e);
  }

  /** Number of patterns loaded. */
  get size(): number {
    return this.patternCount;
  }

  addPattern(pattern: string): void {
    const { letters, values } = parsePattern(pattern.trim());
    if (!letters.length) return;
    let node = this.root;
    for (const l of letters) {
      let n = node.next.get(l);
      if (!n) {
        n = { next: new Map() };
        node.next.set(l, n);
      }
      node = n;
    }
    if (!node.values) this.patternCount++;
    node.values = values;
    if (letters.length > this.maxPattern) this.maxPattern = letters.length;
  }

  /** An exception word with hyphens where breaks are allowed ("hy-phen-ation"); no hyphen means "never". */
  addException(word: string): void {
    const points: number[] = [];
    let letters = "";
    let count = 0;
    for (const ch of word.trim()) {
      if (ch === "-") points.push(count);
      else {
        letters += lower(ch);
        count++;
      }
    }
    if (count) this.exceptions.set(letters, points);
  }

  /**
   * Allowed break positions in a word: each is the number of characters
   * before the break, at least leftMin from the start and rightMin from the end.
   */
  points(word: string): number[] {
    const chars = [...word].map(lower);
    const n = chars.length;
    if (n < this.leftMin + this.rightMin) return [];
    const key = chars.join("");
    const ex = this.exceptions.get(key);
    let raw: number[];
    if (ex) raw = ex;
    else {
      const dotted = [".", ...chars, "."];
      const v = new Uint8Array(dotted.length + 1);
      for (let i = 0; i < dotted.length; i++) {
        let node: TrieNode | undefined = this.root;
        for (let j = i; j < dotted.length && j - i < this.maxPattern; j++) {
          node = node.next.get(dotted[j]);
          if (!node) break;
          const vals = node.values;
          if (vals) for (let k = 0; k < vals.length; k++) if (vals[k] > v[i + k]) v[i + k] = vals[k];
        }
      }
      raw = [];
      // The gap after p letters of the word sits before dotted[p + 1].
      for (let p = 1; p < n; p++) if (v[p + 1] & 1) raw.push(p);
    }
    return raw.filter((p) => p >= this.leftMin && n - p >= this.rightMin);
  }

  /** The word with hyphens inserted at every allowed point (for display and tests). */
  hyphenate(word: string, hyphen = "-"): string {
    const chars = [...word];
    const pts = new Set(this.points(word));
    let out = "";
    for (let i = 0; i < chars.length; i++) {
      if (pts.has(i)) out += hyphen;
      out += chars[i];
    }
    return out;
  }
}

// ------------------------------------------------------------------ loading

const MAX_FILE = 16 << 20;
const MAX_ENTRIES = 500000;
const MAX_ENTRY = 128;

const here = dirname(fileURLToPath(import.meta.url));
let dirCache: string | undefined;

/** The package's hyphenation/ folder (found next to package.json above this module). */
export function hyphenationDir(): string {
  if (!dirCache) {
    let dir = here;
    for (let k = 0; k < 6; k++) {
      if (existsSync(join(dir, "package.json"))) {
        dirCache = join(dir, "hyphenation");
        return dirCache;
      }
      dir = dirname(dir);
    }
    dirCache = resolve(here, "..", "..", "hyphenation");
  }
  return dirCache;
}

const fileCache = new Map<string, HyphenationData | null>();

/** Validated contents of a pattern file; undefined when it does not exist. Throws on a malformed file. */
export function readHyphenationFile(path: string): HyphenationData | undefined {
  const cached = fileCache.get(path);
  if (cached !== undefined) return cached ?? undefined;
  if (!existsSync(path)) {
    fileCache.set(path, null);
    return undefined;
  }
  const bytes = readFileSync(path);
  if (bytes.length > MAX_FILE) throw new Error(`hyphenation file too large: ${path}`);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new Error(`hyphenation file is not JSON: ${path}: ${(e as Error).message}`);
  }
  const data = validate(json, path);
  fileCache.set(path, data);
  return data;
}

function validate(json: unknown, path: string): HyphenationData {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`hyphenation file must hold an object: ${path}`);
  const o = json as Record<string, unknown>;
  const list = (name: string): string[] => {
    const v = o[name];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_ENTRIES) throw new Error(`hyphenation file: '${name}' must be an array of at most ${MAX_ENTRIES} strings: ${path}`);
    for (const s of v) {
      if (typeof s !== "string" || s.length > MAX_ENTRY) throw new Error(`hyphenation file: '${name}' holds a non-string or over-long entry: ${path}`);
    }
    return v as string[];
  };
  return { patterns: list("patterns"), exceptions: list("exceptions") };
}

export interface LoadHyphenatorOptions {
  /** Folder holding <lang>.json; defaults to the package's hyphenation/ folder. */
  dir?: string;
  /** Extra exceptions, applied after the file's (so they win). */
  exceptions?: readonly string[];
  leftMin?: number;
  rightMin?: number;
}

/**
 * A hyphenator for a language: patterns and exceptions from <dir>/<lang>.json
 * when present, plus the exceptions passed in. Without a pattern file it only
 * knows the exceptions. The language tag is validated so it cannot name a
 * path outside the folder.
 */
export function loadHyphenator(lang: string, opts: LoadHyphenatorOptions = {}): Hyphenator {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(lang)) throw new Error(`invalid hyphenation language tag '${lang}'`);
  const data = readHyphenationFile(join(opts.dir ?? hyphenationDir(), `${lang}.json`));
  return new Hyphenator({
    patterns: data?.patterns ?? [],
    exceptions: [...(data?.exceptions ?? []), ...(opts.exceptions ?? [])],
    leftMin: opts.leftMin,
    rightMin: opts.rightMin,
  });
}
