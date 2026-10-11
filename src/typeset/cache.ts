/**
 * Caches for incremental re-rendering: the expensive leaves of a layout
 * (shaped text, broken paragraphs, typeset formulas, drawn SVG figures,
 * TikZ, PSTricks and Mermaid pictures, highlighted code) are kept across
 * renders in the same process, so a second render of an edited document
 * only redoes what the edit touched. Page building and numbering always
 * run again.
 *
 * Every entry is keyed by everything its value depends on (the content, the
 * theme, the width, the state the typesetter was in, the macros); anything
 * that cannot be keyed that way is not cached. The boxes of a value are
 * copied when it is stored and again on every reuse, so later layout steps
 * that adjust boxes in place never touch a cached copy; the leaves (glyph
 * runs, glue, kerns, marks), which layout builds anew rather than changes,
 * are shared.
 * Diagnostics raised while a value was computed are recorded with it and
 * raised again, moved to where the source now is, whenever it is reused.
 * Each cache is an LRU bounded by entries and by an estimate of its size.
 *
 * TEXWRIGHT_NO_CACHE=1 turns every cache off (for comparisons and debugging).
 * The LRU itself is in src/util/lru.ts; the PDF writer keeps compressed
 * streams and font subsets in two more (src/pdf/serialize.ts, fonts.ts).
 */

import type { Diagnostics } from "../diagnostics.js";
import { Lru, cachesDisabled as disabled, idOf, keyOf } from "../util/lru.js";

export { Lru, cacheStats, clearCaches, idOf, keyOf, setCachesEnabled } from "../util/lru.js";

/**
 * A string that is equal for structurally equal plain data. Class instances
 * (fonts) and functions count by identity: the same font object, not an
 * equal one, so a font file read again is a different font.
 */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, _k: string, v: unknown) {
    if (typeof v === "function") return `@f${idOf(v)}`;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return `@o${idOf(v)}`;
    }
    if (typeof v === "number" && !Number.isFinite(v)) return `@n${v}`;
    return v;
  }) ?? "undefined";
}

const fingerprints = new WeakMap<object, string>();
const shortIds = new Map<string, number>();
let nextShort = 1;

/** A short id for an object's fingerprint (a theme), worked out once per object. Equal objects get equal ids. */
export function shapeId(o: object): string {
  let fp = fingerprints.get(o);
  if (fp === undefined) {
    fp = keyOf(fingerprint(o));
    fingerprints.set(o, fp);
  }
  let id = shortIds.get(fp);
  if (id === undefined) {
    if (shortIds.size >= 256) shortIds.clear();
    id = nextShort++;
    shortIds.set(fp, id);
  }
  return String(id);
}

// ------------------------------------------------------------------ cloning

/**
 * A deep copy of plain objects and arrays; class instances (fonts) are
 * shared. Box trees have no cycles; an object referenced twice is copied
 * twice. `count` receives an estimate of the size: objects copied, plus
 * string length / 32.
 */
export function cloneTree<T>(value: T, count?: { n: number }): T {
  let n = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      // Long strings (an SVG) weigh as much as a few objects per 32 characters.
      n += v.length >> 5;
      return v;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth > 2000) {
      // Too deep to copy, so too deep to cache: Lru.set() refuses an infinite size.
      n = Number.POSITIVE_INFINITY;
      return v;
    }
    n++;
    if (Array.isArray(v)) {
      const len = v.length;
      let k = 0;
      while (k < len && (v[k] === null || typeof v[k] !== "object")) k++;
      // Numbers (glyph ids, advances, path coordinates) and short strings: one copy.
      if (k === len) {
        if (count) for (const x of v) if (typeof x === "string") n += x.length >> 5;
        return v.slice();
      }
      const out: unknown[] = v.slice(0, k);
      for (; k < len; k++) out.push(walk(v[k], depth + 1));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out: Record<string, unknown> = {};
    for (const key in v) out[key] = walk((v as Record<string, unknown>)[key], depth + 1);
    return out;
  };
  const out = walk(value, 0) as T;
  if (count) count.n += n;
  return out;
}

/** Nodes that layout never changes once made: shared between a cached copy and its users. */
const LEAVES = new Set(["glyphs", "glue", "kern", "penalty", "rule", "image", "anchor", "link-start", "link-end", "outline", "struct"]);

/**
 * A copy of the boxes in a value (HBox, VBox, drawings, and the plain
 * containers around them) that shares the leaf nodes (glyphs, glue, kerns,
 * penalties, rules, marks). Layout adjusts boxes it was given (shift, glue
 * setting, size) but builds new leaves rather than changing them, so this
 * is what a cache must copy, at a fraction of the cost of cloneTree. `count`
 * receives an estimate of the size, as for cloneTree.
 */
export function cloneBoxes<T>(value: T, count?: { n: number }): T {
  let n = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      n += v.length >> 5;
      return v;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth > 2000) {
      // Too deep to copy, so too deep to cache: Lru.set() refuses an infinite size.
      n = Number.POSITIVE_INFINITY;
      return v;
    }
    n++;
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = walk(v[i], depth + 1);
      return out;
    }
    const t = (v as { t?: unknown }).t;
    if (typeof t === "string" && LEAVES.has(t)) {
      // A shared leaf still weighs: a glyph run by its glyphs.
      const gids = (v as { gids?: unknown }).gids;
      if (Array.isArray(gids)) n += gids.length >> 3;
      return v;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out: Record<string, unknown> = {};
    for (const key in v) out[key] = walk((v as Record<string, unknown>)[key], depth + 1);
    return out;
  };
  const out = walk(value, 0) as T;
  if (count) count.n += n;
  return out;
}

// ------------------------------------------------------------------ side effects

/** Something a computation did besides returning its value, replayed on a cache hit. */
export type CacheEvent = { t: "diag"; args: unknown[] } | { t: "missing"; cp: number };

const MAX_EVENTS = 200;

/**
 * Records what computations do to the diagnostics while they run. One per
 * Diagnostics object: its `add` is wrapped once, and reports go to every
 * computation currently being recorded (they nest).
 */
export class Recorder {
  private readonly frames: CacheEvent[][] = [];

  emit(ev: CacheEvent): void {
    for (const f of this.frames) if (f.length < MAX_EVENTS) f.push(ev);
  }

  /** Runs `fn`, returning its value and what it reported. `complete` is false when it reported too much to replay. */
  capture<T>(fn: () => T): { value: T; events: CacheEvent[]; complete: boolean } {
    const frame: CacheEvent[] = [];
    this.frames.push(frame);
    try {
      const value = fn();
      return { value, events: frame, complete: frame.length < MAX_EVENTS };
    } finally {
      this.frames.pop();
    }
  }
}

const recorders = new WeakMap<Diagnostics, Recorder>();

/** The recorder of a Diagnostics object, wrapping its `add` the first time. */
export function recorderFor(d: Diagnostics): Recorder {
  let r = recorders.get(d);
  if (r) return r;
  const rec = new Recorder();
  const add = d.add.bind(d);
  d.add = ((...args: Parameters<Diagnostics["add"]>) => {
    rec.emit({ t: "diag", args });
    return add(...args);
  }) as Diagnostics["add"];
  recorders.set(d, rec);
  return rec;
}

/**
 * Raises recorded diagnostics again. Positions move by `lines` (the source
 * moved since the value was cached) when they are in `file`.
 */
export function replayDiagnostics(d: Diagnostics, events: readonly CacheEvent[], lines: number, file: string | undefined, onMissing?: (cp: number) => void): void {
  for (const ev of events) {
    if (ev.t === "missing") {
      onMissing?.(ev.cp);
      continue;
    }
    const [code, message, where, extra] = ev.args as Parameters<Diagnostics["add"]>;
    let at = where;
    let more = extra;
    if (lines && where && "line" in where && typeof where.line === "number" && (where as { file?: string }).file === file) {
      const w = { ...where } as { line: number; endLine?: number };
      w.line += lines;
      if (typeof w.endLine === "number") w.endLine += lines;
      at = w as typeof where;
      // A fix that names its own place moves with the report.
      const fix = extra?.fix as { line?: number } | undefined;
      if (extra?.fix && fix && typeof fix.line === "number" && fix.line > 0) more = { ...extra, fix: { ...extra.fix, line: fix.line + lines } };
    }
    d.add(code, message, at, more);
  }
}

// ------------------------------------------------------------------ pictures

/**
 * A picture renderer (TikZ, PSTricks, Mermaid) behind a cache; results are
 * plain data, copied whole (cloneTree). The options'
 * callbacks (colours, data files) are part of the key: every call one made
 * is recorded with its answer, and an entry is used only when the same
 * calls give the same answers now. Macros the renderer changes, or answers
 * that are not plain data, make a result uncachable.
 */
export function memoRender<O extends object, R>(cache: Lru<{ calls: [string, string, string][]; result: R }>, source: string, options: O, render: (source: string, options: O) => R): R {
  if (disabled()) return render(source, options);
  const data: Record<string, unknown> = {};
  const fns: Record<string, (arg: string) => unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (typeof v === "function") fns[k] = v as (arg: string) => unknown;
    else data[k] = v;
  }
  const before = fingerprint(data);
  const key = keyOf(`${source}\u0000${before}`);
  const hit = cache.get(key);
  if (hit && hit.calls.every(([fn, arg, answer]) => fns[fn] !== undefined && answerKey(fns[fn]!(arg)) === answer)) return cloneTree(hit.result);
  const calls: [string, string, string][] = [];
  let cachable = true;
  const wrapped: Record<string, unknown> = { ...(options as Record<string, unknown>) };
  for (const [k, fn] of Object.entries(fns)) {
    wrapped[k] = (arg: unknown) => {
      const answer = fn(arg as string);
      if (typeof arg !== "string" || calls.length > 500) cachable = false;
      else calls.push([k, arg, answerKey(answer)]);
      return answer;
    };
  }
  const result = render(source, wrapped as O);
  if (cachable && fingerprint(data) === before) {
    const count = { n: 0 };
    cache.set(key, { calls, result: cloneTree(result, count) }, count.n + (source.length >> 5) + 1);
  }
  return result;
}

function answerKey(v: unknown): string {
  return typeof v === "string" ? keyOf(`s${v}`) : v === undefined ? "u" : keyOf(`j${fingerprint(v)}`);
}
