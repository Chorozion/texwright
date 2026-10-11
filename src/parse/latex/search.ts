/**
 * Small search structures shared by the scanners that must not rescan the
 * rest of their input once per call (Markdown rules, the LaTeX lexer, the
 * BibTeX reader).
 */

/** First index in the sorted array `xs` whose value is >= x (xs.length when none is). */
export function lowerBound(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Answers "first index >= from whose value is below limit" over a fixed array in O(log n), by descent over a tree of minimums. */
export class MinTree {
  private readonly size: number;
  private readonly tree: Int32Array;

  constructor(
    private readonly length: number,
    value: (i: number) => number,
  ) {
    let size = 1;
    while (size < length) size <<= 1;
    this.size = size;
    this.tree = new Int32Array(2 * size).fill(0x7fffffff);
    for (let i = 0; i < length; i++) this.tree[size + i] = value(i);
    for (let i = size - 1; i >= 1; i--) this.tree[i] = Math.min(this.tree[2 * i], this.tree[2 * i + 1]);
  }

  firstBelow(from: number, limit: number): number {
    if (from < 0 || from >= this.length) return -1;
    let i = from + this.size;
    if (this.tree[i] < limit) return from;
    for (;;) {
      while (i & 1) i >>= 1; // climb while a right child
      if (i === 0) return -1;
      i++; // the subtree just to the right
      if (this.tree[i] < limit) break;
    }
    while (i < this.size) i = this.tree[2 * i] < limit ? 2 * i : 2 * i + 1;
    return i - this.size;
  }
}
