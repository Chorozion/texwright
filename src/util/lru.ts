/**
 * A bounded LRU map and the registry of every cache built on it, so that
 * all of them can be emptied, switched off (TEXWRIGHT_NO_CACHE=1) and
 * inspected together. The caches themselves are in src/typeset/cache.ts
 * (layout), src/pdf/serialize.ts and src/pdf/fonts.ts (compressed streams,
 * font subsets), and the picture renderers (TikZ, PSTricks, Mermaid).
 */

import { createHash } from "node:crypto";

let off = process.env.TEXWRIGHT_NO_CACHE === "1";
/** True when TEXWRIGHT_NO_CACHE=1 or setCachesEnabled(false) turned the caches off. */
export const cachesDisabled = (): boolean => off;
const disabled = cachesDisabled;

/** Turns every cache on or off (off empties them). */
export function setCachesEnabled(on: boolean): void {
  off = !on;
  if (off) clearCaches();
}

/** A map that forgets its least recently used entries past a count and a total cost. */
export class Lru<V> {
  private readonly map = new Map<string, { value: V; cost: number; gen: number }>();
  private total = 0;
  hits = 0;
  misses = 0;

  constructor(
    readonly name: string,
    readonly maxEntries: number,
    readonly maxCost: number,
  ) {
    caches.push(this as Lru<unknown>);
  }

  get(key: string): V | undefined {
    if (disabled()) return undefined;
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Most recently used last.
    e.gen = generation;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, cost = 1): void {
    if (disabled() || cost > this.maxCost / 4) return;
    const old = this.map.get(key);
    if (old) {
      this.total -= old.cost;
      this.map.delete(key);
    }
    this.map.set(key, { value, cost, gen: generation });
    this.total += cost;
    while (this.map.size > this.maxEntries || this.total > this.maxCost) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.total -= this.map.get(first.value)!.cost;
      this.map.delete(first.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  /** Drops the entries last used before generation `before` (they are the oldest, so it stops at the first newer one). */
  sweep(before: number): void {
    for (const [key, e] of this.map) {
      if (e.gen >= before) break;
      this.total -= e.cost;
      this.map.delete(key);
    }
  }

  get size(): number {
    return this.map.size;
  }

  get cost(): number {
    return this.total;
  }
}

const caches: Lru<unknown>[] = [];
let generation = 0;

/**
 * Ends a render of a session that renders one document again and again
 * (watch): entries not used by this render or the `keep` - 1 before it are
 * dropped, so memory stays near what the document needs instead of filling
 * the caches with versions of paragraphs that were edited away.
 */
export function sweepCaches(keep = 2): void {
  const before = generation - Math.max(1, keep) + 1;
  for (const c of caches) c.sweep(before);
  generation++;
}

/** Empties every cache. */
export function clearCaches(): void {
  for (const c of caches) {
    c.clear();
    c.hits = 0;
    c.misses = 0;
  }
}

/** Entries, size estimate, hits and misses of each cache, for benchmarks and tests. */
export function cacheStats(): Record<string, { entries: number; cost: number; hits: number; misses: number }> {
  const out: Record<string, { entries: number; cost: number; hits: number; misses: number }> = {};
  for (const c of caches) out[c.name] = { entries: c.size, cost: c.cost, hits: c.hits, misses: c.misses };
  return out;
}

// ------------------------------------------------------------------ keys

/** A key for text of any length: short text as is, long text by its SHA-256 and length. */
export function keyOf(s: string): string {
  return s.length <= 1024 ? s : `#${createHash("sha256").update(s).digest("base64")}:${s.length}`;
}

const ids = new WeakMap<object, number>();
let nextId = 1;

/** A number that names an object (a font, an image) for as long as it lives. */
export function idOf(o: object): number {
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
}
